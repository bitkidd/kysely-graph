import type { Kysely, Transaction } from 'kysely';

import { attach } from './assemble.js';
import { limitQueries } from './concurrency.js';
import { type LoadMetrics, notify } from './diagnostics.js';
import { LoaderError } from './errors.js';
import { fetchChunk, type Fetched, prepare, type RuntimeDB } from './execute.js';
import { collect, type Edge, plan, type Row } from './planner.js';
import type { RelationSchema } from './schema.js';
import type { Loader, LoaderConfig } from './types.js';

export function createLoader<DB, const S extends RelationSchema>(
  db: Kysely<DB> | Transaction<DB>,
  relations: S,
  config: LoaderConfig = {},
): Loader<DB, S> {
  const chunkSize = config.chunkSize ?? 500;
  const maxParameters = config.maxParameters ?? 30_000;
  const configuredConcurrency = config.concurrency ?? 4;
  const observer = config.onDiagnostic;
  if (observer !== undefined && typeof observer !== 'function')
    throw new LoaderError('onDiagnostic must be a function');
  for (const [name, value] of Object.entries({
    chunkSize,
    maxParameters,
    concurrency: configuredConcurrency,
  })) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new LoaderError(`${name} must be a positive safe integer`);
  }
  const concurrency = db.isTransaction ? 1 : configuredConcurrency;
  const runQuery = limitQueries(concurrency);
  const runtime = db as RuntimeDB;
  let nextLoadId = 0;
  function observedQuery(
    edge: Edge,
    prepared: ReturnType<typeof prepare>,
    parents: unknown[][],
    chunkIndex: number,
    metrics: LoadMetrics,
    path: readonly string[],
  ): Promise<Fetched[]> {
    const queuedAt = performance.now();
    return runQuery(async () => {
      const started = performance.now();
      const queueMs = started - queuedAt;
      metrics.queryCount++;
      const common = {
        type: 'query' as const,
        loadId: metrics.id,
        path,
        sourceTable: edge.source,
        targetTable: edge.target,
        relation: edge.name,
        chunkIndex,
        parentCount: parents.length,
        queueMs,
      };
      try {
        const rows = await fetchChunk(runtime, edge, prepared, parents);
        metrics.rowsFetched += rows.length;
        notify(observer, {
          ...common,
          status: 'success',
          rowsFetched: rows.length,
          durationMs: performance.now() - started,
        });
        return rows;
      } catch (error) {
        notify(observer, {
          ...common,
          status: 'error',
          error,
          rowsFetched: 0,
          durationMs: performance.now() - started,
        });
        throw error;
      }
    });
  }
  async function walk(
    rows: Row[],
    edges: Edge[],
    metrics?: LoadMetrics,
    path?: readonly string[],
  ): Promise<void> {
    if (!rows.length) return;
    const loadEdge = async (edge: Edge): Promise<void> => {
      const edgePath = metrics ? Object.freeze([...(path ?? []), edge.name]) : undefined;
      const parents = collect(rows, edge.sourceColumns, edge.source);
      const prepared = prepare(runtime, edge);
      const overhead =
        prepared.query.compile().parameters.length +
        (edge.options.perParentLimit === undefined ? 0 : 1);
      const size = Math.min(
        chunkSize,
        Math.floor((maxParameters - overhead) / edge.sourceColumns.length),
      );
      if (parents.length && edge.options.perParentLimit !== 0 && size < 1)
        throw new LoaderError(
          'maxParameters cannot fit the callback parameters and one parent key',
        );
      const fetched = [];
      if (edge.options.perParentLimit !== 0) {
        for (let start = 0; start < parents.length; start += size) {
          const chunk = parents.slice(start, start + size);
          fetched.push(
            ...(await (metrics
              ? observedQuery(edge, prepared, chunk, start / size, metrics, edgePath!)
              : runQuery(() => fetchChunk(runtime, edge, prepared, chunk)))),
          );
        }
      }
      await walk(
        fetched.map((f) => f.row),
        edge.children,
        metrics,
        edgePath,
      );
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
  const load = async (args: {
    table: string;
    data: object | readonly object[];
    with: Record<string, unknown>;
  }) => {
    const inputCount = Array.isArray(args.data) ? args.data.length : 1;
    const metrics: LoadMetrics | undefined = observer
      ? { id: ++nextLoadId, started: performance.now(), queryCount: 0, rowsFetched: 0 }
      : undefined;
    const summary = () => ({
      type: 'load' as const,
      loadId: metrics!.id,
      table: args.table,
      inputCount,
      queryCount: metrics!.queryCount,
      rowsFetched: metrics!.rowsFetched,
      durationMs: performance.now() - metrics!.started,
    });
    try {
      const edges = plan(relations, args.table, args.with);
      const array = Array.isArray(args.data);
      const input: readonly object[] = array ? (args.data as readonly object[]) : [args.data];
      const rows = input.map((row) => {
        if (!row || typeof row !== 'object' || Array.isArray(row))
          throw new LoaderError('data must contain row objects');
        return { ...row } as Row;
      });
      await walk(rows, edges, metrics, metrics ? Object.freeze([args.table]) : undefined);
      if (metrics) notify(observer, { ...summary(), status: 'success' });
      return array ? rows : rows[0];
    } catch (error) {
      if (metrics) notify(observer, { ...summary(), status: 'error', error });
      throw error;
    }
  };
  // The implementation operates on runtime records; the interface carries the
  // recursive schema-dependent result and input-shape relationship.
  return { load } as Loader<DB, S>;
}
