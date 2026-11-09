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

An attempted SQL statement emits a `query` event. For batched execution, `table`
identifies the queried table and `relationPaths` is empty for the root or contains
the relation path for that batch. In single-statement execution, `relationPaths`
lists the relations in the statement. `rowsFetched` counts rows returned by the
statement. `durationMs` includes connection acquisition, SQL execution, and
driver decoding.

Use PostgreSQL EXPLAIN to inspect work within a statement and Kysely logging to
see the SQL and bound parameters.

## Execution summary

The final `execution` event includes `queryCount`, `rowsFetched`, `durationMs`,
`table` and `executionId`. Counts include all attempted statements and returned
rows, including relation batches. A failure before dispatch can have zero queries.

Both event types report `status` as `success` or `error`. Error events carry the
original thrown value in `error`. A batched execution can report a successful
root statement and an execution error if a later batch fails, assembly fails, or
`.executeTakeFirstOrThrow()` finds no roots. Synchronous builder
construction and explicit `.compile()` calls do not emit events.

## Delivery

Standard `.execute()`, `.executeTakeFirst()`, `.executeTakeFirstOrThrow()` and
`.explain()` calls emit diagnostics. An outer query or stream uses its own
executor and logging.

Events and relation paths are frozen. Observer calls do not block execution.
Handler exceptions and rejected promises leave the original result or error intact.

[Documentation index](README.md)
