import { LoaderError } from './errors.js';
import type { AnyRelation, Keys, RelationSchema } from './schema.js';

export type Row = Record<string, unknown>;
export interface EdgeOptions {
  query?: unknown; through?: unknown; perParentLimit?: number; with?: Record<string, unknown>;
}
export interface Edge {
  name: string; source: string; target: string; kind: AnyRelation['kind'];
  sourceColumns: string[]; targetColumns: string[]; targetPrimaryKey: string[];
  junction?: { table: string; source: string[]; target: string[] };
  options: EdgeOptions; children: Edge[];
}
const keys = (value: Keys): string[] => typeof value === 'string' ? [value] : [...value];
const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);
function identifier(value: string): string {
  // Aliases and schema-qualified table names need different Kysely reference rules.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new LoaderError(`Unsupported identifier ${JSON.stringify(value)}; use unaliased, unqualified table and column names`);
  }
  return value;
}
export function plan(schema: RelationSchema, table: string, requested: Record<string, unknown>, ancestors = new Set<object>()): Edge[] {
  identifier(table);
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) throw new LoaderError('with must be an object');
  if (ancestors.has(requested)) throw new LoaderError('Cyclic relation request');
  const path = new Set(ancestors).add(requested);
  return Object.entries(requested).map(([name, value]) => {
    const declared = own(schema, table) ? schema[table] : undefined;
    const relation = declared && own(declared, name) ? declared[name] : undefined;
    if (!relation) throw new LoaderError(`Unknown relation ${table}.${name}`);
    if (value !== true && (!value || typeof value !== 'object' || Array.isArray(value))) throw new LoaderError(`Invalid options for ${table}.${name}`);
    const options: EdgeOptions = value === true ? {} : value as EdgeOptions;
    for (const option of Object.keys(options)) {
      if (!['query', 'through', 'with', 'perParentLimit'].includes(option)) throw new LoaderError(`Unknown option ${table}.${name}.${option}`);
    }
    if (options.query !== undefined && typeof options.query !== 'function') throw new LoaderError(`query must be a function for ${table}.${name}`);
    if (options.through !== undefined && (relation.kind !== 'manyToMany' || typeof options.through !== 'function')) throw new LoaderError(`through is only valid as a manyToMany callback`);
    if (options.perParentLimit !== undefined && (!['hasMany', 'manyToMany'].includes(relation.kind) || !Number.isSafeInteger(options.perParentLimit) || options.perParentLimit < 0)) {
      throw new LoaderError(`perParentLimit must be a non-negative safe integer on a to-many relation`);
    }
    let sourceColumns: string[], targetColumns: string[], targetPrimaryKey: string[];
    let junction: Edge['junction'];
    if (relation.kind === 'belongsTo') {
      sourceColumns = keys(relation.options.foreignKey);
      targetColumns = keys(relation.options.targetKey ?? 'id');
      targetPrimaryKey = targetColumns;
    } else if (relation.kind === 'manyToMany') {
      sourceColumns = keys(relation.options.sourcePrimaryKey ?? 'id');
      targetColumns = keys(relation.options.targetPrimaryKey ?? 'id');
      targetPrimaryKey = targetColumns;
      junction = { table: identifier(relation.options.through), source: keys(relation.options.sourceKey), target: keys(relation.options.targetKey) };
    } else {
      sourceColumns = keys(relation.options.sourceKey ?? 'id');
      targetColumns = keys(relation.options.foreignKey);
      targetPrimaryKey = keys(relation.options.targetKey ?? 'id');
    }
    if (!sourceColumns.length || !targetColumns.length || (junction
      ? sourceColumns.length !== junction.source.length || targetColumns.length !== junction.target.length
      : sourceColumns.length !== targetColumns.length)) throw new LoaderError(`Key arity mismatch for ${table}.${name}`);
    for (const column of [...sourceColumns, ...targetColumns, ...targetPrimaryKey, ...(junction?.source ?? []), ...(junction?.target ?? [])]) identifier(column);
    return { name, source: table, target: identifier(relation.target), kind: relation.kind,
      sourceColumns, targetColumns, targetPrimaryKey, ...(junction ? { junction } : {}), options,
      children: plan(schema, relation.target, options.with ?? {}, path) };
  });
}

export function tuple(row: Row, columns: string[], context: string): unknown[] | null {
  const values = columns.map(column => {
    if (!own(row, column) || row[column] === undefined) throw new LoaderError(`Missing required key ${context}.${column}`);
    return row[column];
  });
  return values.some(v => v === null) ? null : values;
}
/** Type tags and lengths prevent delimiter, numeric/string, and tuple collisions. */
export function tupleKey(values: unknown[]): string {
  return JSON.stringify(values.map(v => {
    if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'bigint') return [typeof v, String(v)];
    if (typeof v === 'number' && Number.isFinite(v)) return ['number', String(v)];
    if (v instanceof Date && Number.isFinite(v.getTime())) return ['date', v.toISOString()];
    if (v instanceof Uint8Array) return ['bytes', Array.from(v, n => n.toString(16).padStart(2, '0')).join('')];
    throw new LoaderError('Unsupported relation key value; use strings, finite numbers, bigint, boolean, Date or bytes');
  }));
}
export function collect(rows: Row[], columns: string[], context: string): unknown[][] {
  const found = new Map<string, unknown[]>();
  for (const row of rows) {
    const values = tuple(row, columns, context);
    if (values) found.set(tupleKey(values), values);
  }
  return [...found.values()];
}
