# Diagnostics

```ts
const graph = createGraph(db, definitions, {
  onDiagnostic(event) {
    if (event.type === 'query') {
      console.log(event.executionId, event.table, event.relationPaths, event.rowsFetched);
    } else {
      console.log(event.executionId, event.queryCount, event.durationMs, event.status);
    }
  },
});

await graph.query({ table: 'users', with: { posts: true } }).execute();
```

`GraphDiagnostic` is the readonly union of `QueryDiagnostic` and
`ExecutionDiagnostic`. Each execution gets its own `executionId`, including
concurrent executions of the same builder.

## Query event

An attempted SQL execution emits a `query` event. `table` identifies the root
table, and `relationPaths` lists the requested relations from the root.
`rowsFetched` counts returned root rows. `durationMs` includes connection
acquisition, SQL execution and driver decoding.

Use PostgreSQL EXPLAIN to inspect work within a statement and Kysely logging to
see the SQL and bound parameters.

## Execution summary

The final `execution` event includes `queryCount`, `rowsFetched`, `durationMs`,
`table` and `executionId`. `queryCount` is one for an attempted SQL execution
and zero for a failure such as an exceeded parameter budget before dispatch.

Both event types report `status` as `success` or `error`. Error events carry the
original thrown value in `error`. For example, `executeTakeFirstOrThrow()` on no
result reports an error even when the SQL completed. Synchronous builder
construction and explicit `.compile()` calls do not emit events.

## Delivery

Standard `.execute()`, `.executeTakeFirst()`, `.executeTakeFirstOrThrow()` and
`.explain()` calls emit diagnostics. An outer query or stream uses its own
executor and logging.

Events and relation paths are frozen. Observer calls do not block execution.
Handler exceptions and rejected promises leave the original result or error intact.

[Documentation index](README.md)
