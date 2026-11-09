import type { Kysely, Transaction } from 'kysely';
import { LoaderError } from './errors.js';
import { attach } from './assemble.js';
import { limitQueries } from './concurrency.js';
import { collect, plan, type Edge, type Row } from './planner.js';
import { prepare, fetchChunk, type RuntimeDB } from './execute.js';
import type { RelationSchema } from './schema.js';
import type { Loader, LoaderConfig } from './types.js';

export function createLoader<DB, const S extends RelationSchema>(db: Kysely<DB> | Transaction<DB>, relations: S, config: LoaderConfig = {}): Loader<DB, S> {
  const chunkSize = config.chunkSize ?? 500;
  const maxParameters = config.maxParameters ?? 30_000;
  const configuredConcurrency = config.concurrency ?? 4;
  for (const [name, value] of Object.entries({ chunkSize, maxParameters, concurrency: configuredConcurrency })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new LoaderError(`${name} must be a positive safe integer`);
  }
  const concurrency = db.isTransaction ? 1 : configuredConcurrency;
  const runQuery = limitQueries(concurrency);
  const runtime = db as RuntimeDB;
  async function walk(rows: Row[], edges: Edge[]): Promise<void> {
    if (!rows.length) return;
    const loadEdge = async (edge: Edge): Promise<void> => {
      const parents = collect(rows, edge.sourceColumns, edge.source);
      const prepared = prepare(runtime, edge);
      const overhead = prepared.query.compile().parameters.length + (edge.options.perParentLimit === undefined ? 0 : 1);
      const size = Math.min(chunkSize, Math.floor((maxParameters - overhead) / edge.sourceColumns.length));
      if (parents.length && edge.options.perParentLimit !== 0 && size < 1) throw new LoaderError('maxParameters cannot fit the callback parameters and one parent key');
      const fetched = [];
      if (edge.options.perParentLimit !== 0) {
        for (let start = 0; start < parents.length; start += size) {
          fetched.push(...await runQuery(() => fetchChunk(runtime, edge, prepared, parents.slice(start, start + size))));
        }
      }
      await walk(fetched.map(f => f.row), edge.children);
      attach(rows, edge, fetched);
    };
    if (concurrency === 1) {
      // Preserve sequential traversal on transaction-bound connections and when
      // explicitly disabled. Chunks within an edge always remain sequential.
      for (const edge of edges) await loadEdge(edge);
    } else {
      // Hold slots only during SQL, never while awaiting descendants. Waiting on
      // every branch also prevents queries continuing after load() rejects.
      const results = await Promise.allSettled(edges.map(loadEdge));
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
      }
    }
  }
  const load = async (args: { table: string; data: object | readonly object[]; with: Record<string, unknown> }) => {
    const edges = plan(relations, args.table, args.with);
    const array = Array.isArray(args.data);
    const input: readonly object[] = array ? args.data as readonly object[] : [args.data];
    const rows = input.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new LoaderError('data must contain row objects');
      return { ...row } as Row;
    });
    await walk(rows, edges);
    return array ? rows : rows[0];
  };
  // The implementation operates on runtime records; the interface carries the
  // recursive schema-dependent result and input-shape relationship.
  return { load } as Loader<DB, S>;
}
