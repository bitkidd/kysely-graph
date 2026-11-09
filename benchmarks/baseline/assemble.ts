import { LoaderError } from './errors.js';
import { tuple, tupleKey, type Edge, type Row } from './planner.js';
import type { Fetched } from './execute.js';

// Each attachment owns its graph; duplicate parents do not share mutable children.
export function cloneGraph(row: Row, edges: Edge[]): Row {
  const result = { ...row };
  for (const edge of edges) {
    const value = row[edge.name];
    const copy = Array.isArray(value) ? value.map(v => cloneGraph(v as Row, edge.children))
      : value === null ? null : cloneGraph(value as Row, edge.children);
    Object.defineProperty(result, edge.name, { value: copy, enumerable: true, writable: true, configurable: true });
  }
  return result;
}
export function attach(parents: Row[], edge: Edge, fetched: Fetched[]): void {
  const grouped = new Map<string, Row[]>();
  for (const item of fetched) {
    const values = item.parent ?? tuple(item.row, edge.targetColumns, edge.target);
    if (!values) continue;
    const key = tupleKey(values);
    const group = grouped.get(key) ?? [];
    group.push(item.row);
    grouped.set(key, group);
  }
  const many = edge.kind === 'hasMany' || edge.kind === 'manyToMany';
  for (const parent of parents) {
    const values = tuple(parent, edge.sourceColumns, edge.source);
    const group = values ? grouped.get(tupleKey(values)) ?? [] : [];
    if (!many && group.length > 1) throw new LoaderError(`Expected at most one row for ${edge.source}.${edge.name}; received ${group.length}`);
    const value = many ? group.map(row => cloneGraph(row, edge.children)) : group[0] ? cloneGraph(group[0], edge.children) : null;
    Object.defineProperty(parent, edge.name, { value, enumerable: true, writable: true, configurable: true });
  }
}
