import { LoaderError } from './errors.js';
import type { Fetched } from './execute.js';
import { type Edge, type GroupKey, type Row, rowKey, tupleKey } from './planner.js';

function setRelation(row: Row, name: string, value: unknown): void {
  // Output rows are ordinary shallow clones with writable own properties.
  // __proto__ needs an own data property to avoid invoking Object's setter.
  if (name === '__proto__') {
    Object.defineProperty(row, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    row[name] = value;
  }
}

// Only reused attachments need a deep graph copy. Scalar/computed fields retain
// their existing shallow-copy semantics.
export function cloneGraph(row: Row, edges: Edge[]): Row {
  const result = { ...row };
  for (const edge of edges) {
    const value = row[edge.name];
    const copy = Array.isArray(value)
      ? value.map((v) => cloneGraph(v as Row, edge.children))
      : value === null
        ? null
        : cloneGraph(value as Row, edge.children);
    setRelation(result, edge.name, copy);
  }
  return result;
}
export function attach(parents: Row[], edge: Edge, fetched: Fetched[]): void {
  const grouped = new Map<GroupKey, { rows: Row[]; claimed: boolean }>();
  const projection =
    edge.options.select === undefined
      ? undefined
      : [...new Set([...edge.options.select, ...edge.children.map((child) => child.name)])];
  for (const item of fetched) {
    const key =
      item.parent === null
        ? rowKey(item.row, edge.targetColumns, edge.target)
        : tupleKey(item.parent);
    if (key === null) continue;
    let group = grouped.get(key);
    if (!group) {
      group = { rows: [], claimed: false };
      grouped.set(key, group);
    }
    // Nested loading and grouping have consumed internal keys. Project exactly
    // the requested fields now, before cloning any reused attachments.
    let exposed = item.row;
    if (projection !== undefined) {
      exposed = {};
      for (const column of projection) setRelation(exposed, column, item.row[column]);
    }
    group.rows.push(exposed);
  }
  const many = edge.kind === 'hasMany' || edge.kind === 'manyToMany';
  for (const parent of parents) {
    const key = rowKey(parent, edge.sourceColumns, edge.source);
    const group = key === null ? undefined : grouped.get(key);
    if (!group) {
      setRelation(parent, edge.name, many ? [] : null);
      continue;
    }
    if (!many && group.rows.length > 1)
      throw new LoaderError(
        `Expected at most one row for ${edge.source}.${edge.name}; received ${group.rows.length}`,
      );
    // Move the already-owned graph to its first parent. Only duplicate keys
    // require another graph, preserving independent mutable relation objects.
    const rows = group.claimed
      ? group.rows.map((row) => cloneGraph(row, edge.children))
      : group.rows;
    group.claimed = true;
    setRelation(parent, edge.name, many ? rows : rows[0]!);
  }
}
