# Configuration and transactions

```ts
const graph = createGraph(db, definitions, {
  chunkSize: 500,
  concurrency: 4,
  maxParameters: 30000,
  onDiagnostic: (event) => console.log(event),
});
```

| Option          | Default  | Meaning                                                                                     |
| --------------- | -------- | ------------------------------------------------------------------------------------------- |
| `chunkSize`     | `500`    | Maximum distinct parent keys per relation statement.                                        |
| `concurrency`   | `4`      | Maximum in-flight statements shared across direct executions on one graph instance.         |
| `maxParameters` | `30000`  | Maximum bound parameters per statement.                                                     |
| `strategy`      | `'flat'` | Fetch relation rows with native driver decoding. Use `'single'` for a composable statement. |
| `onDiagnostic`  | omitted  | Optional observer for statement and execution events.                                       |

`chunkSize`, `concurrency`, and `maxParameters` must be positive safe integers.
Relation batches shrink when composite keys, callback parameters, or computed
expressions would exceed the parameter budget. If one key cannot fit, or a root
or single-statement query exceeds the budget, the execution raises a `GraphError`.

## Transaction-bound queries

```ts
await db.transaction().execute(async (trx) => {
  const graph = createGraph(trx, definitions);
  return graph
    .query({
      table: 'users',
      select: ['id', 'name'],
      with: { posts: { select: ['title'] } },
    })
    .where('users.active', '=', true)
    .execute();
});
```

The builder retains the supplied Kysely executor, so transaction queries see
uncommitted writes and honor rollback. Transaction-bound graphs run statements
sequentially. For a consistent snapshot across batches, use a repeatable-read
transaction. Single-statement execution also reads the whole graph under one
statement snapshot.

Reuse the Kysely instance and pool across requests. Manage the connection pool
in the application.

[Documentation index](README.md)
