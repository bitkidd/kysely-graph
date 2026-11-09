import {
  isNoResultErrorConstructor,
  type Kysely,
  NoResultError,
  sql,
  type Transaction,
} from 'kysely';

import { createBatchLoader, limitQueries, prepareFlatRoot } from './batch.js';
import { createObserver } from './diagnostics.js';
import { GraphError } from './errors.js';
import { plan, type Selection } from './planner.js';
import { compileGraph, type PreparedGraph, type RuntimeDB, type RuntimeQuery } from './query.js';
import type { Field, GraphSchema } from './schema.js';
import type { Graph, GraphConfig } from './types.js';

type Definitions = GraphSchema | readonly GraphSchema[];
// Intersecting schema types also combines their field names on shared tables.
type IntersectSchemas<S extends GraphSchema> = (
  S extends unknown ? (schema: S) => void : never
) extends (schema: infer M extends GraphSchema) => void
  ? M
  : never;
type MergedSchema<S extends Definitions> = S extends readonly GraphSchema[]
  ? [S[number]] extends [never]
    ? {}
    : IntersectSchemas<S[number]>
  : S;

const observedMethods = new Set([
  'execute',
  'executeTakeFirst',
  'executeTakeFirstOrThrow',
  'explain',
]);

const flatMethods = new Set([
  'where',
  'whereRef',
  'select',
  'innerJoin',
  'orderBy',
  'limit',
  'offset',
  'clearWhere',
  'clearOrderBy',
  'clearLimit',
  'clearOffset',
  'execute',
  'executeTakeFirst',
  'executeTakeFirstOrThrow',
  'then',
]);

function mergeDefinitions(definitions: readonly GraphSchema[]): GraphSchema {
  const merged: Record<string, Record<string, Field>> = Object.create(null);
  for (const schema of definitions) {
    for (const [table, fields] of Object.entries(schema)) {
      const tableFields: Record<string, Field> = (merged[table] ??= Object.create(null));
      for (const [name, field] of Object.entries(fields)) {
        if (Object.hasOwn(tableFields, name)) {
          throw new GraphError(`Duplicate field ${table}.${name}`);
        }
        tableFields[name] = field;
      }
    }
  }
  return merged;
}

export function createGraph<DB, const S extends Definitions>(
  db: Kysely<DB> | Transaction<DB>,
  definitions: S,
  config?: GraphConfig<'flat'>,
): Graph<DB, MergedSchema<S>, true>;
export function createGraph<DB, const S extends Definitions>(
  db: Kysely<DB> | Transaction<DB>,
  definitions: S,
  config: GraphConfig<'single'> & { strategy: 'single' },
): Graph<DB, MergedSchema<S>, false>;
export function createGraph<DB, const S extends Definitions>(
  db: Kysely<DB> | Transaction<DB>,
  definitions: S,
  config: GraphConfig | undefined,
): Graph<DB, MergedSchema<S>, boolean>;
export function createGraph<DB, const S extends Definitions>(
  db: Kysely<DB> | Transaction<DB>,
  definitions: S,
  config: GraphConfig = {},
): Graph<DB, MergedSchema<S>, boolean> {
  const maxParameters = config.maxParameters ?? 30_000;
  const chunkSize = config.chunkSize ?? 500;
  const concurrency = config.concurrency ?? 4;
  const strategy = config.strategy ?? 'flat';
  for (const [name, value] of Object.entries({ maxParameters, chunkSize, concurrency })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new GraphError(`${name} must be a positive safe integer`);
    }
  }
  if (strategy !== 'flat' && strategy !== 'single') {
    throw new GraphError('strategy must be flat or single');
  }
  if (config.onDiagnostic !== undefined && typeof config.onDiagnostic !== 'function') {
    throw new GraphError('onDiagnostic must be a function');
  }
  for (const name of Object.keys(config)) {
    if (!['maxParameters', 'chunkSize', 'concurrency', 'strategy', 'onDiagnostic'].includes(name)) {
      throw new GraphError(`Unknown configuration ${name}`);
    }
  }

  const schema = Array.isArray(definitions)
    ? mergeDefinitions(definitions)
    : (definitions as GraphSchema);
  const runtime = db as RuntimeDB;
  const observe = createObserver(config.onDiagnostic);
  const slots = db.isTransaction ? 1 : concurrency;
  const run = limitQueries(slots);
  const flat = strategy === 'flat';
  const load = createBatchLoader(runtime, chunkSize, maxParameters, slots, run);

  function compile(query: RuntimeQuery) {
    const compiled = query.compile();
    if (compiled.parameters.length > maxParameters) {
      throw new GraphError('maxParameters cannot fit the single graph statement');
    }
    return compiled;
  }

  function wrap(
    query: RuntimeQuery,
    table: string,
    fields: Selection[],
    prepared: PreparedGraph,
    flatRelations?: ReturnType<typeof prepareFlatRoot>['relations'],
  ): RuntimeQuery {
    return new Proxy(query, {
      get(target, key) {
        if (flatRelations && typeof key === 'string' && !flatMethods.has(key)) return;
        const method: unknown = Reflect.get(target, key, target);
        if (typeof method !== 'function') return method;
        if (key === 'compile') return () => compile(target);

        if (typeof key === 'string' && observedMethods.has(key)) {
          return (...args: unknown[]) =>
            observe({ table, fields }, async (progress) => {
              if (flatRelations) {
                const first = key !== 'execute';
                const options = (typeof args[0] === 'function' ? undefined : args[0]) as Parameters<
                  RuntimeQuery['execute']
                >[0];
                const query =
                  first && !target.toOperationNode().limit ? target.limit(sql.lit(1)) : target;
                const rows = await load(
                  table,
                  { compiled: query.compile(), relations: flatRelations },
                  prepared,
                  progress,
                  options,
                  first,
                );
                if (!first) return rows;
                if (rows.length || key === 'executeTakeFirst') return rows[0];
                const makeError =
                  typeof args[0] === 'function'
                    ? args[0]
                    : (args[0] as { errorConstructor?: unknown } | undefined)?.errorConstructor;
                const constructor = (makeError ?? NoResultError) as Parameters<
                  typeof isNoResultErrorConstructor
                >[0];
                const node = target.toOperationNode();
                throw isNoResultErrorConstructor(constructor)
                  ? new constructor(node)
                  : constructor(node);
              }
              compile(target);
              return run(() => progress.inline(() => Reflect.apply(method, target, args)));
            });
        }

        // Kysely's chaining methods return a new builder.
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(method, target, args);
          if (
            result &&
            typeof result === 'object' &&
            'execute' in result &&
            'toOperationNode' in result
          ) {
            return wrap(result as RuntimeQuery, table, fields, prepared, flatRelations);
          }
          return result;
        };
      },
    });
  }

  function query({
    table,
    with: requested,
    select,
  }: {
    table: string;
    with: Record<string, unknown>;
    select?: readonly string[];
  }) {
    const fields = plan(schema, table, requested);
    if (
      select !== undefined &&
      (!Array.isArray(select) ||
        select.some(
          (column) => typeof column !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column),
        ))
    ) {
      throw new GraphError('select must be an array of unqualified root column names');
    }

    const prepared = compileGraph(runtime, table, fields, select, flat);
    if (flat) {
      const root = prepareFlatRoot(prepared.query, table, fields);
      return wrap(root.query, table, fields, prepared, root.relations);
    }
    return wrap(prepared.query, table, fields, prepared);
  }

  return { query } as unknown as Graph<DB, MergedSchema<S>, boolean>;
}
