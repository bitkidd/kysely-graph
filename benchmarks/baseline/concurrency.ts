/** Share query slots across branches, recursion, and calls on one loader. */
export function limitQueries(concurrency: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(query: () => Promise<T>): Promise<T> {
    if (active === concurrency) {
      await new Promise<void>(resolve => waiting.push(resolve));
    } else {
      active++;
    }
    try {
      return await query();
    } finally {
      const next = waiting.shift();
      // Hand the occupied slot directly to a waiter so a new arrival cannot
      // overtake it or temporarily exceed the limit.
      if (next) next();
      else active--;
    }
  };
}
