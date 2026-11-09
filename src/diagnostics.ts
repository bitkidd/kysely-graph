import type { Selection } from './planner.js';
import type { GraphConfig, GraphDiagnostic } from './types.js';

type Observer = NonNullable<GraphConfig['onDiagnostic']>;

interface Operation {
  table: string;
  fields: Selection[];
}

interface QueryProgress {
  startQuery(): void;
  recordRows(count: number): void;
}

const unobserved: QueryProgress = {
  startQuery() {},
  recordRows() {},
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
    let queryStartedAt = startedAt;

    const progress: QueryProgress = {
      startQuery() {
        queryCount++;
        queryStartedAt = performance.now();
      },
      recordRows(count) {
        rowsFetched = count;
      },
    };

    const finish = (outcome: { status: 'success' } | { status: 'error'; error: unknown }) => {
      const shared = { executionId, table, rowsFetched };
      if (queryCount) {
        notify(observer, {
          type: 'query',
          ...shared,
          relationPaths: relationPaths(table, fields),
          durationMs: performance.now() - queryStartedAt,
          ...outcome,
        });
      }
      notify(observer, {
        type: 'execution',
        ...shared,
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
