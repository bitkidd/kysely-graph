import { type CompiledQuery, RawNode, sql, ValueNode } from 'kysely';

import type { QueryProgress } from './diagnostics.js';
import { GraphError } from './errors.js';
import { type Edge, isToMany, type Selection } from './planner.js';
import {
  type PreparedGraph,
  ref,
  type RuntimeDB,
  type RuntimeQuery,
  selectColumns,
} from './query.js';

type Row = Record<string, unknown>;
type Key = readonly string[];
type ExecuteOptions = Parameters<RuntimeQuery['execute']>[0];
type RunQuery = <T>(query: () => Promise<T>) => Promise<T>;

type IndexedEdge = { edge: Edge; index: number };

export interface BatchRoot {
  compiled: CompiledQuery;
  relations: IndexedEdge[];
}

const parentTable = 'krlinternalparents';
const parentIndex = 'krlinternalparent';
const rankColumn = 'krlinternalrank';
const keyColumn = (index: number, column: number) => `krlinternalkey${index}p${column}`;
const inputColumn = (column: number) => keyColumn(0, column);
const computedColumn = (index: number) => `krlinternalcomputed${index}`;
const edges = (fields: Selection[]) =>
  fields.flatMap((edge, index) => (edge.kind === 'computed' ? [] : [{ edge, index }]));

function selectKeys(query: RuntimeQuery, table: string, relations: IndexedEdge[]): RuntimeQuery {
  for (const { edge, index } of relations) {
    for (const [columnIndex, column] of edge.sourceColumns.entries()) {
      query = query.select(
        sql`cast(${ref(table, column)} as text)`.as(keyColumn(index, columnIndex)),
      );
    }
  }
  return query;
}

export function prepareFlatRoot(query: RuntimeQuery, table: string, fields: Selection[]) {
  const relations = edges(fields);
  return { query: selectKeys(query, table, relations), relations };
}

/** Share slots across roots, branches, batches, and overlapping executions. */
export function limitQueries(concurrency: number): RunQuery {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (query) => {
    if (active === concurrency) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active++;
    }
    try {
      return await query();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

function keyInput(db: RuntimeDB, edge: Edge, keys: readonly Key[]) {
  // The empty scalar subqueries supply the original PostgreSQL types to VALUES.
  // Binding their text representations preserves exact keys such as int8 and
  // lets PostgreSQL apply its normal equality operators and collations.
  const types = edge.sourceColumns.map((column) =>
    db.selectFrom(edge.source).select(ref(edge.source, column).as(column)).limit(sql.lit(0)),
  );
  // Construct a single raw node instead of a builder per tuple and parameter.
  // The fragments contain only punctuation and generated ordinal numbers.
  const fragments = [''];
  const values: ValueNode[] = [];
  for (const [index, key] of keys.entries()) {
    fragments[fragments.length - 1] += `${index ? '), ' : ''}(${index}, `;
    for (const [column, value] of key.entries()) {
      values.push(ValueNode.create(value));
      fragments.push(column === key.length - 1 ? '' : ', ');
    }
  }
  const rows = { toOperationNode: () => RawNode.create(fragments, values) };
  const aliases = [
    sql.id(parentIndex),
    ...edge.sourceColumns.map((_, i) => sql.id(inputColumn(i))),
  ];
  return sql`(values ${rows}), (-1, ${sql.join(types)}))`.as(
    sql`${sql.id(parentTable)}(${sql.join(aliases)})`,
  );
}

function makeBatch(
  db: RuntimeDB,
  prepared: PreparedGraph,
  edge: Edge,
  nested: IndexedEdge[],
  keys: readonly Key[],
): RuntimeQuery {
  const input = keyInput(db, edge, keys);
  const index = ref(parentTable, parentIndex);
  let target = prepared.targets.get(edge)!.clearSelect();
  const node = target.toOperationNode();
  const junction = edge.junction;
  if (junction) {
    const link = 'krlinternallink';
    const columns = [...new Set([...junction.source, ...junction.target])];
    const linkColumn = (column: string) => `krlinternallink${columns.indexOf(column)}`;
    const through = prepared.junctions
      .get(edge)!
      .clearSelect()
      .clearOrderBy()
      .select(columns.map((column) => ref(junction.table, column).as(linkColumn(column))));
    let links = db.selectFrom(through.as(link)).select(sql.lit(1).as('krlinternalone'));
    for (const [i, column] of junction.source.entries()) {
      links = links.where(ref(link, linkColumn(column)), '=', ref(parentTable, inputColumn(i)));
    }
    for (const [i, column] of junction.target.entries()) {
      links = links.where(
        ref(link, linkColumn(column)),
        '=',
        ref(edge.target, edge.targetColumns[i]!),
      );
    }
    target = target.where(sql<boolean>`exists (${links})`);
  } else {
    for (const [i, column] of edge.targetColumns.entries()) {
      target = target.where(ref(edge.target, column), '=', ref(parentTable, inputColumn(i)));
    }
  }

  target = selectFlat(selectKeys(target, edge.target, nested), edge, prepared);
  if (!node.limit) {
    return target.crossJoin(input).where(index, '>=', sql.lit(0)).select(index.as(parentIndex));
  }

  const order = node.orderBy!.items.map((item) => sql`${{ toOperationNode: () => item }}`);
  const ranked = target.select(sql`row_number() over (order by ${sql.join(order)})`.as(rankColumn));
  const child = 'krlinternalchild';
  return db
    .selectFrom(input)
    .crossJoinLateral(ranked.as(child))
    .where(index, '>=', sql.lit(0))
    .selectAll(child)
    .select(index.as(parentIndex))
    .orderBy(index)
    .orderBy(ref(child, rankColumn));
}

function selectFlat(query: RuntimeQuery, edge: Edge, prepared: PreparedGraph): RuntimeQuery {
  query = selectColumns(query, edge.target, edge.options.select);
  for (const [index, field] of edge.children.entries()) {
    if (field.kind === 'computed') {
      query = query.select(prepared.computed.get(field)!.as(computedColumn(index)));
    }
  }
  return query;
}

function assign(row: Row, name: string, value: unknown) {
  if (name === '__proto__') {
    Object.defineProperty(row, name, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    row[name] = value;
  }
}

interface Entry {
  row: Row;
  keys: Row;
}

interface ParentGroup {
  key: Key;
  parent: Row;
  duplicates?: Row[];
  children: Row[];
}

function flatProjection(edge: Edge, nested: IndexedEdge[]) {
  const internal = new Set([parentIndex, rankColumn]);
  for (const { edge, index } of nested) {
    for (const column of edge.sourceColumns.keys()) internal.add(keyColumn(index, column));
  }
  const computed: [string, string][] = [];
  for (const [index, field] of edge.children.entries()) {
    if (field.kind !== 'computed') continue;
    const alias = computedColumn(index);
    internal.add(alias);
    computed.push([alias, field.name]);
  }
  if (!nested.length && !computed.length) {
    return ({ [parentIndex]: _parent, [rankColumn]: _rank, ...row }: Row): Row => row;
  }
  return (record: Row): Row => {
    const row: Row = {};
    for (const column of Object.keys(record)) {
      if (!internal.has(column)) {
        assign(row, column, record[column]);
      }
    }
    for (const [alias, name] of computed) assign(row, name, record[alias]);
    return row;
  };
}

// Copy the assembled relation containers without changing driver-decoded scalars.
function cloneFlat(value: Row | Row[] | null, children: Selection[]): typeof value {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((row) => cloneFlat(row, children) as Row);
  const copy = { ...value };
  for (const child of children) {
    if (child.kind !== 'computed') {
      assign(copy, child.name, cloneFlat(value[child.name] as Row | Row[] | null, child.children));
    }
  }
  return copy;
}

function cardinalityError(edge: Edge) {
  return Object.assign(
    new GraphError(`more than one row matched to-one relation ${edge.source}.${edge.name}`),
    { code: '21000' },
  );
}

export function createBatchLoader(
  db: RuntimeDB,
  chunkSize: number,
  maxParameters: number,
  concurrency: number,
  run: RunQuery,
) {
  return async (
    table: string,
    root: BatchRoot,
    prepared: PreparedGraph,
    progress: QueryProgress,
    options: ExecuteOptions,
    first: boolean,
  ): Promise<Row[]> => {
    let failure: { error: unknown } | undefined;
    async function execute(compiled: CompiledQuery, queryTable: string, path: readonly string[]) {
      if (compiled.parameters.length > maxParameters) {
        throw new GraphError('maxParameters cannot fit the graph statement');
      }
      return run(async () => {
        if (failure) throw failure.error;
        return progress.query(queryTable, path, async () => {
          try {
            return (await db.executeQuery<Row>(compiled, options)).rows;
          } catch (error) {
            // Mark the execution before the limiter hands the slot to a waiter.
            failure ??= { error };
            throw error;
          }
        });
      });
    }

    async function load(entries: Entry[], relations: IndexedEdge[], path: readonly string[]) {
      if (!entries.length) return;
      async function loadEdge({ edge, index }: IndexedEdge) {
        const many = isToMany(edge);
        const groups = new Map<string, ParentGroup>();
        const keyNames = edge.sourceColumns.map((_, i) => keyColumn(index, i));
        const firstKeyName = keyNames[0]!;
        const composite = keyNames.length > 1;
        for (const { row, keys } of entries) {
          const firstKey = keys[firstKeyName] as string | null;
          const key = composite ? keyNames.map((name) => keys[name] as string | null) : undefined;
          if (firstKey === null || key?.includes(null)) {
            assign(row, edge.name, many ? [] : null);
            continue;
          }
          const id = key ? JSON.stringify(key) : firstKey;
          const group = groups.get(id);
          if (group) (group.duplicates ??= []).push(row);
          else groups.set(id, { key: (key ?? [firstKey]) as Key, parent: row, children: [] });
        }

        const all = [...groups.values()];
        const nested = edges(edge.children);
        const descendants: Entry[] | undefined = nested.length ? [] : undefined;
        const project = flatProjection(edge, nested);
        const edgePath = [...path, edge.name];
        const limit = prepared.targets.get(edge)!.toOperationNode().limit?.limit;
        const empty = limit && ValueNode.is(limit) && (limit.value === 0 || limit.value === 0n);
        if (all.length && !empty) {
          const build = (keys: readonly Key[]) =>
            makeBatch(db, prepared, edge, nested, keys).compile();
          const sample = build([all[0]!.key]);
          const arity = edge.sourceColumns.length;
          const size = Math.min(
            chunkSize,
            1 + Math.floor((maxParameters - sample.parameters.length) / arity),
          );
          if (size < 1) {
            throw new GraphError(
              'maxParameters cannot fit the relation parameters and one parent key',
            );
          }
          let next = 0;
          await parallel(Math.min(concurrency, Math.ceil(all.length / size)), async () => {
            while (next < all.length && !failure) {
              const start = next;
              next += size;
              const batch = all.slice(start, next);
              const compiled =
                batch.length === 1 && start === 0 ? sample : build(batch.map(({ key }) => key));
              const rows = await execute(compiled, edge.target, edgePath);
              for (const keys of rows) {
                const group = batch[keys[parentIndex] as number]!;
                if (!many && group.children.length) {
                  throw cardinalityError(edge);
                }
                const row = project(keys);
                group.children.push(row);
                if (descendants) descendants.push({ row, keys });
              }
            }
          });
        }

        if (descendants?.length) await load(descendants, nested, edgePath);
        for (const { parent, duplicates, children } of all) {
          const value = many ? children : (children[0] ?? null);
          assign(parent, edge.name, value);
          if (duplicates) {
            for (const duplicate of duplicates) {
              assign(duplicate, edge.name, cloneFlat(value, edge.children));
            }
          }
        }
      }

      if (concurrency === 1) {
        for (const relation of relations) await loadEdge(relation);
      } else {
        await parallel(relations.length, (index) => loadEdge(relations[index]!));
      }
    }

    async function parallel(count: number, task: (index: number) => Promise<void>) {
      await Promise.all(
        Array.from({ length: count }, async (_, index) => {
          if (failure) return;
          try {
            await task(index);
          } catch (error) {
            failure ??= { error };
          }
        }),
      );
      if (failure) throw failure.error;
    }

    const result = await execute(root.compiled, table, []);
    const rows = first ? result.slice(0, 1) : result;
    if (!root.relations.length) return rows;
    const entries = rows.map((keys) => ({ row: { ...keys }, keys }));
    await load(entries, root.relations, [table]);
    for (const { row } of entries) {
      for (const { edge, index } of root.relations) {
        for (const column of edge.sourceColumns.keys()) delete row[keyColumn(index, column)];
      }
    }
    return entries.map(({ row }) => row);
  };
}
