import type { Kysely, Transaction } from 'kysely';

import { createObserver } from './diagnostics.js';
import { GraphError } from './errors.js';
import { plan, type Selection } from './planner.js';
import { compileGraph, type RuntimeDB, type RuntimeQuery } from './query.js';
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
  config: GraphConfig = {},
): Graph<DB, MergedSchema<S>> {
  const maxParameters = config.maxParameters ?? 30_000;
  if (!Number.isSafeInteger(maxParameters) || maxParameters < 1) {
    throw new GraphError('maxParameters must be a positive safe integer');
  }
  if (config.onDiagnostic !== undefined && typeof config.onDiagnostic !== 'function') {
    throw new GraphError('onDiagnostic must be a function');
  }
  for (const name of Object.keys(config)) {
    if (name !== 'maxParameters' && name !== 'onDiagnostic') {
      throw new GraphError(`Unknown configuration ${name}`);
    }
  }

  const schema = Array.isArray(definitions)
    ? mergeDefinitions(definitions)
    : (definitions as GraphSchema);
  const runtime = db as RuntimeDB;
  const observe = createObserver(config.onDiagnostic);

  function compile(query: RuntimeQuery) {
    const compiled = query.compile();
    if (compiled.parameters.length > maxParameters) {
      throw new GraphError('maxParameters cannot fit the single graph statement');
    }
    return compiled;
  }

  function wrap(query: RuntimeQuery, table: string, fields: Selection[]): RuntimeQuery {
    return new Proxy(query, {
      get(target, key) {
        const method: unknown = Reflect.get(target, key, target);
        if (typeof method !== 'function') return method;
        if (key === 'compile') return () => compile(target);

        if (typeof key === 'string' && observedMethods.has(key)) {
          return (...args: unknown[]) =>
            observe({ table, fields }, async (progress) => {
              compile(target);
              progress.startQuery();
              const result: unknown = await Reflect.apply(method, target, args);
              progress.recordRows(
                Array.isArray(result) ? result.length : Number(result !== undefined),
              );
              return result;
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
            return wrap(result as RuntimeQuery, table, fields);
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

    return wrap(compileGraph(runtime, table, fields, select), table, fields);
  }

  return { query } as Graph<DB, MergedSchema<S>>;
}
