import type { Selection } from './planner.js';
import type { GraphConfig, GraphDiagnostic } from './types.js';

type Observer = NonNullable<GraphConfig['onDiagnostic']>;

interface Operation {
  table: string;
  fields: Selection[];
}

export interface QueryProgress {
  query<T>(table: string, path: readonly string[], execute: () => Promise<T>): Promise<T>;
  inline<T>(execute: () => Promise<T>): Promise<T>;
}

const unobserved: QueryProgress = {
  query: (_table, _path, execute) => execute(),
  inline: (execute) => execute(),
};

function relationPaths(table: string, fields: Selection[]): readonly (readonly string[])[] {
  const paths: (readonly string[])[] = [];
  function visit(parent: readonly string[], children: Selection[]) {
    for (const edge of children) {
      if (edge.kind === 'computed') continue;
      const path = Object.freeze([...parent, edge.name]);
      paths.push(path);
      visit(path, edge.children);
    }
  }
  visit([table], fields);
  return Object.freeze(paths);
}

function notify(observer: Observer, event: GraphDiagnostic): void {
  try {
    const pending = observer(Object.freeze(event));
    if (pending) void Promise.resolve(pending).catch(() => {});
  } catch {
    // Handler failures must not replace the query's result or error.
  }
}

export function createObserver(observer: GraphConfig['onDiagnostic']) {
  let sequence = 0;

  return async function observe<T>(
    { table, fields }: Operation,
    run: (progress: QueryProgress) => Promise<T>,
  ): Promise<T> {
    if (!observer) return run(unobserved);

    const executionId = ++sequence;
    const startedAt = performance.now();
    let queryCount = 0;
    let rowsFetched = 0;
    async function query<T>(
      queryTable: string,
      paths: readonly (readonly string[])[],
      execute: () => Promise<T>,
    ): Promise<T> {
      queryCount++;
      const queryStartedAt = performance.now();
      const finish = (
        count: number,
        outcome: { status: 'success' } | { status: 'error'; error: unknown },
      ) =>
        notify(observer!, {
          type: 'query',
          executionId,
          table: queryTable,
          relationPaths: paths,
          rowsFetched: count,
          durationMs: performance.now() - queryStartedAt,
          ...outcome,
        });
      try {
        const result = await execute();
        const count = Array.isArray(result) ? result.length : Number(result !== undefined);
        rowsFetched += count;
        finish(count, { status: 'success' });
        return result;
      } catch (error) {
        finish(0, { status: 'error', error });
        throw error;
      }
    }

    const progress: QueryProgress = {
      query: (queryTable, path, execute) =>
        query(queryTable, Object.freeze(path.length ? [Object.freeze(path)] : []), execute),
      inline: (execute) => query(table, relationPaths(table, fields), execute),
    };

    const finish = (outcome: { status: 'success' } | { status: 'error'; error: unknown }) => {
      notify(observer, {
        type: 'execution',
        executionId,
        table,
        rowsFetched,
        queryCount,
        durationMs: performance.now() - startedAt,
        ...outcome,
      });
    };

    try {
      const result = await run(progress);
      finish({ status: 'success' });
      return result;
    } catch (error) {
      finish({ status: 'error', error });
      throw error;
    }
  };
}
