import type { LoaderConfig, LoaderDiagnostic } from './types.js';

export interface LoadMetrics {
  id: number;
  started: number;
  queryCount: number;
  rowsFetched: number;
}

/** Observability must not replace a query result or mask its original error. */
export function notify(observer: LoaderConfig['onDiagnostic'], event: LoaderDiagnostic): void {
  if (!observer) return;
  try {
    const pending = observer(Object.freeze(event));
    if (pending) void Promise.resolve(pending).catch(() => {});
  } catch {
    // Handler failures are deliberately isolated from loading.
  }
}
