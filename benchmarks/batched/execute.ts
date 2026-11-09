import {
  type Kysely,
  type OperationNode,
  type RawBuilder,
  type SelectQueryBuilder,
  sql,
} from 'kysely';

import { LoaderError } from './errors.js';
import type { Edge, Row } from './planner.js';

// Runtime erasure is confined to SQL execution; exported API types retain DB/table information.
// Kysely's dynamic table overloads cannot express a runtime relation graph.
type Query = SelectQueryBuilder<any, any, any>;
export type RuntimeDB = Kysely<any>;
const letters = (index: number): string =>
  index < 26
    ? String.fromCharCode(97 + index)
    : letters(Math.floor(index / 26) - 1) + letters(index % 26);
const operation = (node: OperationNode) => ({ toOperationNode: () => node });
const ref = (table: string, column: string) => sql.ref(`${table}.${column}`);
export interface Fetched {
  row: Row;
  parent: unknown[] | null;
}

function applyCallback(base: Query, callback: unknown, context: string): Query {
  if (!callback) return base;
  const query = (callback as (qb: Query) => Query)(base);
  if (!query || typeof query.toOperationNode !== 'function')
    throw new LoaderError(`${context} callback must return a Kysely select builder`);
  const before = base.toOperationNode();
  const after = query.toOperationNode();
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const field of fields) {
    if (field === 'where' || field === 'orderBy') continue;
    if (Reflect.get(before, field) !== Reflect.get(after, field)) {
      if (field === 'selections')
        throw new LoaderError(
          `${context} callback may only filter/order; selections changed. Use the relation select option to choose columns`,
        );
      throw new LoaderError(
        `${context} callback may only filter/order; ${field} changed. Use perParentLimit instead of limit/offset`,
      );
    }
  }
  // Re-add the complete callback predicate as a single grouped operand so OR
  // cannot escape the mandatory parent-key predicate appended below.
  return after.where
    ? query.clearWhere().where(sql<boolean>`(${operation(after.where.where)})`)
    : query;
}
function predicate(table: string, columns: string[], parents: unknown[][]): RawBuilder<boolean> {
  if (columns.length === 1)
    return sql<boolean>`${ref(table, columns[0]!)} in (${sql.join(parents.map((p) => sql`${p[0]}`))})`;
  return sql<boolean>`(${sql.join(
    parents.map(
      (p) =>
        sql`(${sql.join(
          columns.map((c, i) => sql`${ref(table, c)} = ${p[i]}`),
          sql` and `,
        )})`,
    ),
    sql` or `,
  )})`;
}
export function prepare(
  db: RuntimeDB,
  edge: Edge,
): { query: Query; partition: RawBuilder<unknown>[]; aliases: string[]; filterColumns: string[] } {
  let query = applyCallback(
    db.selectFrom(edge.target).selectAll(edge.target),
    edge.options.query,
    `${edge.source}.${edge.name}.query`,
  );
  if (edge.options.select !== undefined) {
    const columns = new Set(edge.options.select);
    // Retain attachment keys and every key needed as a source by a nested edge.
    // Window ordering and join predicates can reference unselected FROM columns.
    if (!edge.junction) for (const column of edge.targetColumns) columns.add(column);
    for (const child of edge.children)
      for (const column of child.sourceColumns) columns.add(column);
    query = query.clearSelect();
    if (columns.size)
      query = query.select([...columns].map((column) => ref(edge.target, column).as(column)));
  }
  const aliases: string[] = [];
  if (edge.junction) {
    const j = edge.junction;
    let through = applyCallback(
      db.selectFrom(j.table).selectAll(j.table),
      edge.options.through,
      `${edge.source}.${edge.name}.through`,
    );
    // Deduplicate junction pairs before ranking, otherwise duplicate links consume slots.
    const columns = [...new Set([...j.source, ...j.target])];
    const junctionColumn = (column: string) =>
      `krlinternalcolumn${letters(columns.indexOf(column))}`;
    through = through
      .clearOrderBy()
      .clearSelect()
      .select(columns.map((c) => ref(j.table, c).as(junctionColumn(c))))
      .distinct();
    query = query.innerJoin(through.as('krlinternaljunction'), (join) => {
      let result = join;
      for (let i = 0; i < j.target.length; i++)
        result = result.onRef(
          `krlinternaljunction.${junctionColumn(j.target[i]!)}`,
          '=',
          `${edge.target}.${edge.targetColumns[i]!}`,
        );
      return result;
    });
    const partition = j.source.map((c) => ref('krlinternaljunction', junctionColumn(c)));
    for (let i = 0; i < j.source.length; i++) {
      const alias = `krlinternalparent${letters(i)}`;
      aliases.push(alias);
      query = query.select(partition[i]!.as(alias));
    }
    return { query, partition, aliases, filterColumns: j.source.map(junctionColumn) };
  }
  return {
    query,
    partition: edge.targetColumns.map((c) => ref(edge.target, c)),
    aliases,
    filterColumns: edge.targetColumns,
  };
}
export async function fetchChunk(
  db: RuntimeDB,
  edge: Edge,
  prepared: ReturnType<typeof prepare>,
  parents: unknown[][],
): Promise<Fetched[]> {
  let query = prepared.query.where(
    predicate(edge.junction ? 'krlinternaljunction' : edge.target, prepared.filterColumns, parents),
  );
  if (edge.options.perParentLimit !== undefined) {
    const order = query.toOperationNode().orderBy?.items ?? [];
    const ordering = [
      ...order.map((item) => sql`${operation(item)}`),
      ...edge.targetPrimaryKey.map((c) => sql`${ref(edge.target, c)} asc`),
    ];
    query = query.select(
      sql`row_number() over (partition by ${sql.join(prepared.partition)} order by ${sql.join(ordering)})`.as(
        'krlinternalrank',
      ),
    );
    // The callback's ordering is in the window; outer ordering preserves it on attachment.
    query = db
      .selectFrom(query.clearOrderBy().as('krlinternallimited'))
      .selectAll()
      .where('krlinternalrank', '<=', edge.options.perParentLimit)
      .orderBy('krlinternalrank', 'asc');
  }
  const rows: Row[] = await query.execute();
  return rows.map((row) => {
    const parent = edge.junction ? prepared.aliases.map((a) => row[a]) : null;
    const clean = { ...row };
    for (const alias of prepared.aliases) delete clean[alias];
    if (edge.options.perParentLimit !== undefined) delete clean.krlinternalrank;
    return { row: clean, parent };
  });
}
