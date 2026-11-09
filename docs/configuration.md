# Configuration and transactions

```ts
const graph = createGraph(db, definitions, {
  maxParameters: 30000,
  onDiagnostic: (event) => console.log(event),
});
```

| Option          | Default | Meaning                                                                                            |
| --------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `maxParameters` | `30000` | Reject a compiled graph statement exceeding the parameter budget. Must be a positive safe integer. |
| `onDiagnostic`  | omitted | Optional readonly graph-query and operation summary observer.                                      |

Each graph is one statement. PostgreSQL subqueries fetch sibling relations and
nested levels, and the connection pool handles independent executions.

Compilation and ordinary execute methods enforce the parameter budget. Root and
relation predicates and computed expressions contribute to that count. An oversized statement raises a
`GraphError`.

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
uncommitted writes and honor rollback. A single PostgreSQL statement reads its
graph under one statement snapshot. Use the isolation level appropriate to other
statements in the surrounding transaction.

Reuse the Kysely instance and pool across requests. Manage the connection pool
in the application.

[Documentation index](README.md)
