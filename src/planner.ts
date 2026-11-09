import { GraphError } from './errors.js';
import type { AnyComputed, AnyRelation, GraphSchema, Keys } from './schema.js';

export interface EdgeOptions {
  query?: unknown;
  through?: unknown;
  with?: Record<string, unknown>;
  select?: readonly string[];
}
export interface Edge {
  name: string;
  source: string;
  target: string;
  kind: AnyRelation['kind'];
  sourceColumns: string[];
  targetColumns: string[];
  targetPrimaryKey: string[];
  definitionQuery?: unknown;
  junction?: { table: string; source: string[]; target: string[]; definitionQuery?: unknown };
  options: EdgeOptions;
  children: Selection[];
}

export interface ComputedSelection {
  kind: 'computed';
  name: string;
  definition: AnyComputed;
  args: object;
}
export type Selection = Edge | ComputedSelection;

export function isToMany(edge: Edge): boolean {
  return edge.kind === 'hasMany' || edge.kind === 'manyToMany';
}

const keys = (value: Keys): string[] => (typeof value === 'string' ? [value] : [...value]);
const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);
function identifier(value: string): string {
  // Aliases and schema-qualified table names need different Kysely reference rules.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new GraphError(
      `Unsupported identifier ${JSON.stringify(value)}; use unaliased, unqualified table and column names`,
    );
  }
  return value;
}

function computedSelection(
  table: string,
  name: string,
  definition: AnyComputed,
  value: unknown,
): ComputedSelection {
  const field = `${table}.${name}`;
  if (definition.table !== table || typeof definition.expression !== 'function') {
    throw new GraphError(`Invalid computed definition for ${field}`);
  }
  if (value === true) return { kind: 'computed', name, definition, args: {} };
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('args' in value) ||
    !own(value, 'args') ||
    Object.keys(value).some((key) => key !== 'args') ||
    !value.args ||
    typeof value.args !== 'object' ||
    Array.isArray(value.args)
  ) {
    throw new GraphError(`Computed field ${field} requires true or an { args } object`);
  }
  return { kind: 'computed', name, definition, args: value.args };
}

export function plan(
  schema: GraphSchema,
  table: string,
  requested: Record<string, unknown>,
  ancestors = new Set<object>(),
): Selection[] {
  identifier(table);
  if (!requested || typeof requested !== 'object' || Array.isArray(requested))
    throw new GraphError('with must be an object');
  if (ancestors.has(requested)) throw new GraphError('Cyclic graph request');
  const path = new Set(ancestors).add(requested);
  const declared = own(schema, table) ? schema[table] : undefined;
  return Object.entries(requested).map(([name, value]) => {
    const field = declared && own(declared, name) ? declared[name] : undefined;
    if (!field) throw new GraphError(`Unknown graph field ${table}.${name}`);
    if (field.kind === 'computed') return computedSelection(table, name, field, value);
    const relation = field;
    if (value !== true && (!value || typeof value !== 'object' || Array.isArray(value)))
      throw new GraphError(`Invalid options for ${table}.${name}`);
    const options: EdgeOptions = value === true ? {} : (value as EdgeOptions);
    for (const option of Object.keys(options)) {
      if (!['query', 'through', 'with', 'select'].includes(option))
        throw new GraphError(`Unknown option ${table}.${name}.${option}`);
    }
    if (options.select !== undefined) {
      if (
        !Array.isArray(options.select) ||
        options.select.some((column) => typeof column !== 'string')
      ) {
        throw new GraphError(`select must be an array of target column names for ${table}.${name}`);
      }
      for (const column of options.select) identifier(column);
    }
    if (options.query !== undefined && typeof options.query !== 'function')
      throw new GraphError(`query must be a function for ${table}.${name}`);
    const definitionQuery = relation.options.query;
    if (definitionQuery !== undefined && typeof definitionQuery !== 'function')
      throw new GraphError(`Definition query must be a function for ${table}.${name}`);
    const throughQuery =
      'throughQuery' in relation.options ? relation.options.throughQuery : undefined;
    if (
      throughQuery !== undefined &&
      (relation.kind !== 'manyToMany' || typeof throughQuery !== 'function')
    )
      throw new GraphError(
        `Definition throughQuery must be a manyToMany callback for ${table}.${name}`,
      );
    if (
      options.through !== undefined &&
      (relation.kind !== 'manyToMany' || typeof options.through !== 'function')
    )
      throw new GraphError(`through is only valid as a manyToMany callback`);
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
      junction = {
        table: identifier(relation.options.through),
        source: keys(relation.options.sourceKey),
        target: keys(relation.options.targetKey),
        definitionQuery: throughQuery,
      };
    } else {
      sourceColumns = keys(relation.options.sourceKey ?? 'id');
      targetColumns = keys(relation.options.foreignKey);
      targetPrimaryKey = keys(relation.options.targetKey ?? 'id');
    }
    if (
      !sourceColumns.length ||
      !targetColumns.length ||
      (junction
        ? sourceColumns.length !== junction.source.length ||
          targetColumns.length !== junction.target.length
        : sourceColumns.length !== targetColumns.length)
    )
      throw new GraphError(`Key arity mismatch for ${table}.${name}`);
    for (const column of [
      ...sourceColumns,
      ...targetColumns,
      ...targetPrimaryKey,
      ...(junction?.source ?? []),
      ...(junction?.target ?? []),
    ])
      identifier(column);
    return {
      name,
      source: table,
      target: identifier(relation.target),
      kind: relation.kind,
      sourceColumns,
      targetColumns,
      targetPrimaryKey,
      definitionQuery,
      ...(junction ? { junction } : {}),
      options,
      children: plan(schema, relation.target, options.with ?? {}, path),
    };
  });
}
