import {
  expressionBuilder,
  isExpression,
  type Kysely,
  type RawBuilder,
  type SelectQueryBuilder,
  sql,
  ValueNode,
} from 'kysely';
import { jsonArrayFrom, jsonBuildObject, jsonObjectFrom } from 'kysely/helpers/postgres';

import { GraphError } from './errors.js';
import { type Edge, isToMany, type Selection } from './planner.js';

// The public builders keep their inferred database and result types.
export type RuntimeDB = Kysely<any>;
export type RuntimeQuery = SelectQueryBuilder<any, any, any>;

const valueColumn = 'krlinternalvalue';
export const ref = (table: string, column: string) => sql.ref(`${table}.${column}`);
const aliasLength = (name: string) => Buffer.byteLength(name, 'utf8');

function applyCallback(
  base: RuntimeQuery,
  callback: (qb: RuntimeQuery) => RuntimeQuery,
  context: string,
  scope: 'definition' | 'request',
  limitedRelation?: Edge,
) {
  let result = callback(base);
  if (!result || typeof result.toOperationNode !== 'function') {
    throw new GraphError(`${context} callback must return a Kysely select builder`);
  }

  const before = base.toOperationNode();
  const after = result.toOperationNode();
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (field === 'where' || (field === 'orderBy' && scope === 'request')) continue;
    if (field === 'limit' && limitedRelation) continue;
    if (Reflect.get(before, field) !== Reflect.get(after, field)) {
      const supported =
        scope === 'definition'
          ? 'filter'
          : limitedRelation
            ? 'filter, order, or limit'
            : 'filter or order';
      throw new GraphError(`${context} callback may only ${supported}; ${field} changed`);
    }
  }

  if (after.limit && limitedRelation) {
    const limit = after.limit.limit;
    if (ValueNode.is(limit)) {
      const value = limit.value;
      if (
        (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) ||
        (typeof value === 'bigint' && value < 0n)
      ) {
        throw new GraphError(`${context} limit must be a non-negative integer`);
      }
    }
    for (const column of limitedRelation.targetPrimaryKey) {
      result = result.orderBy(`${limitedRelation.target}.${column}`, 'asc');
    }
  }

  // Group each callback's predicate before adding other filters and correlation.
  const where = after.where?.where;
  const predicate = where && sql<boolean>`(${{ toOperationNode: () => where }})`;
  return { query: result, predicate };
}

function matchKeys(
  query: RuntimeQuery,
  leftTable: string,
  leftColumns: string[],
  rightTable: string,
  rightColumns: string[],
): RuntimeQuery {
  for (const [index, column] of leftColumns.entries()) {
    query = query.where(ref(leftTable, column), '=', ref(rightTable, rightColumns[index]!));
  }
  return query;
}

export function selectColumns(
  query: RuntimeQuery,
  table: string,
  columns?: readonly string[],
): RuntimeQuery {
  if (columns === undefined) return query.selectAll(table);
  return query.select(columns.map((column) => ref(table, column).as(column)));
}

/** PostgreSQL limits the number of arguments in a function call. */
function jsonObject(
  entries: readonly (readonly [string, RawBuilder<unknown>])[],
): RawBuilder<unknown> {
  if (entries.length <= 40) return jsonBuildObject(Object.fromEntries(entries));

  const chunks: RawBuilder<unknown>[] = [];
  for (let start = 0; start < entries.length; start += 40) {
    const chunk = jsonBuildObject(Object.fromEntries(entries.slice(start, start + 40)));
    chunks.push(sql`(${chunk})::jsonb`);
  }
  return sql`(${sql.join(chunks, sql` || `)})::json`;
}

export function compileGraph(
  db: RuntimeDB,
  table: string,
  fields: Selection[],
  selection?: readonly string[],
  flat = false,
) {
  const plugins = db.getExecutor().plugins;
  const untransformed = db.withoutPlugins();
  const targets = new Map<Edge, RuntimeQuery>();
  const junctions = new Map<Edge, RuntimeQuery>();
  const computed = new Map<Selection, RawBuilder<unknown>>();
  let nextAlias = 0;
  const internalAlias = () => `krlinternalrow${++nextAlias}`;

  function fieldValue(field: Selection, table: string): RawBuilder<unknown> {
    if (field.kind !== 'computed') return capture(field, table);

    const eb = expressionBuilder();
    const callback = field.definition.expression as (builder: typeof eb, args: object) => unknown;
    const expression = callback(eb, field.args);
    if (!isExpression(expression) || 'isSelectQueryBuilder' in expression) {
      throw new GraphError(
        `Computed field ${table}.${field.name} must return a Kysely expression. Use $asScalar() for subqueries`,
      );
    }
    const value = sql`(${expression})`;
    computed.set(field, value);
    return value;
  }

  function junctionQuery(edge: Edge, junction: NonNullable<Edge['junction']>) {
    const filtered = childQuery(
      junction.table,
      `${edge.source}.${edge.name}.through`,
      edge.options.through,
      junction.definitionQuery,
    );
    junctions.set(edge, filtered);
    return filtered;
  }

  function throughPredicate(edge: Edge, junction: NonNullable<Edge['junction']>, parent: string) {
    const junctionAlias = internalAlias();
    const filtered = junctionQuery(edge, junction);
    // EXISTS deduplicates links before the child query applies its limit.
    let links = db.selectFrom(filtered.as(junctionAlias)).select(sql`1`.as('krlinternalone'));
    links = matchKeys(links, junctionAlias, junction.source, parent, edge.sourceColumns);
    links = matchKeys(links, junctionAlias, junction.target, edge.target, edge.targetColumns);
    return sql<boolean>`exists (${links})`;
  }

  function selectJsonValue(query: RuntimeQuery, edge: Edge): RawBuilder<unknown> {
    const { target, options, children } = edge;
    const columns =
      options.select === undefined
        ? sql`row_to_json(${sql.id(target)})`
        : jsonObject(options.select.map((column) => [column, ref(target, column)] as const));
    const fields = jsonObject(children.map((child) => [child.name, fieldValue(child, target)]));
    const value = sql`((${columns})::jsonb || (${fields})::jsonb)::json`;
    const output = internalAlias();
    const selected = db.selectFrom(query.select(value.as(valueColumn)).as(output));
    const outputValue = ref(output, valueColumn);

    return isToMany(edge)
      ? sql`(${selected.select(sql`coalesce(json_agg(${outputValue}), '[]'::json)`.as(valueColumn))})`
      : sql`(${selected.select(outputValue.as(valueColumn))})`;
  }

  function targetQuery(edge: Edge) {
    const { target, options } = edge;
    const query = childQuery(
      target,
      `${edge.source}.${edge.name}.query`,
      options.query,
      edge.definitionQuery,
      isToMany(edge) ? edge : undefined,
    );
    targets.set(edge, query);
    return query;
  }

  function prepareFlat(edge: Edge) {
    targetQuery(edge);
    if (edge.junction) junctionQuery(edge, edge.junction);
    for (const child of edge.children) {
      if (child.kind === 'computed') fieldValue(child, edge.target);
      else prepareFlat(child);
    }
  }

  function relation(edge: Edge, parent: string): RawBuilder<unknown> {
    const { target, junction, options, children } = edge;
    let query = targetQuery(edge);
    query = junction
      ? query.where(throughPredicate(edge, junction, parent))
      : matchKeys(query, target, edge.targetColumns, parent, edge.sourceColumns);

    query = query.clearSelect();
    // Long JSON keys cannot use PostgreSQL's 63-byte column aliases.
    if (children.some((child) => aliasLength(child.name) > 63)) {
      return selectJsonValue(query, edge);
    }

    query = selectColumns(query, target, options.select);
    for (const child of children) {
      query = query.select(fieldValue(child, target).as(child.name));
    }
    return isToMany(edge) ? jsonArrayFrom(query) : jsonObjectFrom(query);
  }

  function capture(edge: Edge, table: string): RawBuilder<unknown> {
    // Snapshot the parent under a distinct alias, including for self-relations.
    const parent = internalAlias();
    const snapshot = sql`(select ${sql.id(table)}.*)`.as(parent);
    const query = db.selectFrom(snapshot).select(relation(edge, parent).as(valueColumn));
    return sql`(${query})`;
  }

  function childQuery(
    table: string,
    context: string,
    callback: unknown,
    definitionQuery: unknown,
    limitedRelation?: Edge,
  ): RuntimeQuery {
    if (typeof callback !== 'function' && typeof definitionQuery !== 'function') {
      return db.selectFrom(table).selectAll(table);
    }

    // Validate the callback before plugins clone or rewrite the operation nodes.
    const base = untransformed.selectFrom(table).selectAll(table);
    let query = base;
    if (typeof callback === 'function') {
      const request = applyCallback(
        base,
        callback as (qb: RuntimeQuery) => RuntimeQuery,
        context,
        'request',
        limitedRelation,
      );
      query = request.predicate
        ? request.query.clearWhere().where(request.predicate)
        : request.query;
    }
    if (typeof definitionQuery === 'function') {
      // A request can clear its own WHERE clause without removing the definition's filter.
      const { predicate } = applyCallback(
        base,
        definitionQuery as (qb: RuntimeQuery) => RuntimeQuery,
        `${context} definition`,
        'definition',
      );
      if (predicate) query = query.where(predicate);
    }
    for (const plugin of plugins) {
      query = query.withPlugin(plugin);
    }
    return query;
  }

  let query = selectColumns(db.selectFrom(table), table, selection);
  for (const field of fields) {
    if (flat && field.kind !== 'computed') {
      prepareFlat(field);
      continue;
    }
    if (aliasLength(field.name) > 63 || field.name === '__proto__') {
      const kind = field.kind === 'computed' ? 'computed field' : 'relation';
      throw new GraphError(
        `Root ${kind} names must fit PostgreSQL aliases (63 bytes) and cannot be __proto__`,
      );
    }
    query = query.select(fieldValue(field, table).as(field.name));
  }
  return { query, targets, junctions, computed };
}

export type PreparedGraph = ReturnType<typeof compileGraph>;
