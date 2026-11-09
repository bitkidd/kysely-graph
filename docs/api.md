# API reference and boundaries

Import from `@bitkidd/kysely-graph` to define relations and computed fields and build PostgreSQL JSON queries.

| Export                                  | Purpose                                         |
| --------------------------------------- | ----------------------------------------------- |
| `defineGraph<DB>()((helpers) => graph)` | Define relations and computed fields per table. |
| `createGraph(db, definitions, config?)` | Bind one or more graph definitions to Kysely.   |
| `GraphError`                            | Query construction and parameter-budget errors. |

The relation helpers are `hasMany`, `hasOne`, `belongsTo`, and `manyToMany`.
See [relation definitions](relations.md) for helper options,
composite mappings, definition filters, and schema merging.

## Computed fields

`defineGraph` adds `computed(table, callback)` alongside the relation helpers.
The callback receives a Kysely expression builder scoped to the declared table.
Return one expression and use `.$asScalar()` for a single-column subquery. The
schema key becomes the selected field name.

```ts
import { createGraph, defineGraph } from '@bitkidd/kysely-graph';

const schema = defineGraph<Database>()(({ hasMany, computed }) => ({
  users: {
    posts: hasMany('posts', { foreignKey: 'authorId' }),
  },
  posts: {
    commentCount: computed('posts', (eb, { approved }: { approved: boolean }) =>
      eb
        .selectFrom('comments')
        .whereRef('comments.postId', '=', 'posts.id')
        .where('comments.approved', '=', approved)
        .select(({ cast, fn }) => cast<number>(fn.countAll(), 'integer').as('count'))
        .$asScalar(),
    ),
  },
}));

const graph = createGraph(db, schema);
const countApproved = { args: { approved: true } };

const posts = await graph
  .query({ table: 'posts', select: ['id'], with: { commentCount: countApproved } })
  .execute();

const users = await graph
  .query({
    table: 'users',
    select: ['id'],
    with: {
      posts: { select: ['id'], with: { commentCount: countApproved } },
    },
  })
  .execute();
```

Request argument-free fields with `true`. If every argument property is
optional, `true` passes an empty object so the callback can use destructuring
defaults. TypeScript checks required keys and value types. The runtime checks
the request shape, and the callback can validate values from untyped inputs.
Each occurrence uses its own arguments for all rows at that point in the graph.
Values used in Kysely predicates are SQL parameters.

Each computed field adds a selection to the graph statement. Its expression
controls the rows it counts independently of any relation filters or limits.
Root values follow driver decoding and nested values follow
[PostgreSQL JSON decoding](selecting-columns.md#json-values). The integer cast in
the example gives the count a numeric representation in both locations.

Relation and computed names share a namespace per table across combined schemas.
Use names distinct from database columns, and keep root aliases within
PostgreSQL's 63-byte limit.

## query

```ts
const query = graph.query({
  table: 'users',
  select: ['id', 'name'],
  with: { posts: { select: ['title'] } },
});
const rows = await query.where('users.active', '=', true).orderBy('id').limit(20).execute();
```

Returns a typed Kysely `SelectQueryBuilder`. `table` and `with` are required;
`with: {}` requests only roots. Root `select` is optional and defaults to all
root columns. Native chaining and normal execute/take-first/compile methods are
supported. Query construction and compilation do not access the database.

| Child request option | Applies to   | Behavior                                                                  |
| -------------------- | ------------ | ------------------------------------------------------------------------- |
| `select`             | All          | Target column-name array; omitted means all columns.                      |
| `query`              | All          | Target Kysely callback for filtering, ordering, and to-many limits.       |
| `with`               | All          | Nested relation and computed field requests.                              |
| `through`            | Many-to-many | Junction filter/order callback; filtering precedes duplicate elimination. |

`hasMany`/`manyToMany` return arrays; `hasOne`/`belongsTo` return objects or `null`.
The database raises SQLSTATE `21000` for a to-one subquery matching multiple rows.
Relations are JSON values; see [serialization and types](selecting-columns.md).

## Types

- `Graph<DB, Schema>` and `GraphConfig` describe the query factory and its configuration.
- `GraphSchema` and `WithGraph` describe schema definitions and field requests.
- `RelationQuery` and `RelationOptions` describe relation callbacks and options.
- `GraphRow` describes the inferred result shape.
- `JsonValue<T>` maps nested JSON types, including Date to string.
- `GraphDiagnostic`, `QueryDiagnostic`, and `ExecutionDiagnostic` describe observer events.

Literal/readonly selections infer exact fields. Dynamic selection arrays infer
optional possible fields. Root SQL columns retain scalar driver types; nested
columns follow JSON representation. Custom scalar decoders must agree with JSON
application types; a TypeScript interface does not describe every physical SQL type.

## Errors

| Condition                                        | Behavior                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Native query finds no roots                      | `execute()` returns `[]`; take-first returns `undefined` or throws Kysely's missing-result error. |
| Null key components                              | To-many relations return `[]`; to-one relations return `null`.                                    |
| Unknown field/option or invalid callback changes | `GraphError`.                                                                                     |
| Statement exceeds `maxParameters`                | `GraphError`; no automatic batching.                                                              |
| Multiple targets for to-one                      | PostgreSQL cardinality violation, SQLSTATE `21000`.                                               |
| Driver/SQL execution error                       | Original error is preserved.                                                                      |
| Observer handler error                           | The query result or original error is preserved.                                                  |

## Current boundaries

- Queries use PostgreSQL JSON functions and correlated subqueries. PGlite provides local PostgreSQL-compatible tests.
- Table and mapping names are unaliased, unqualified ASCII identifiers
  matching `[A-Za-z_][A-Za-z0-9_]*`. Use Kysely’s `withSchema()` to scope the tables. Callback subqueries may use Kysely aliases.
- `krlinternal` is reserved for generated aliases/columns. Native root relation
  names must fit PostgreSQL's 63-byte alias limit and cannot be `__proto__`.
  Nested JSON keys can exceed 63 bytes.
- Child callbacks accept filters and ordering. To-many target callbacks also
  accept `.limit()`. Set child projections with `select` and apply root pagination
  with the outer builder.
- Selection-option aliases/expressions, automatic polymorphic dispatch and
  custom JSON scalar revival are not implemented.
- Graph subqueries use declared relation names as output aliases. Kysely plugins
  apply their configured identifier and result transformations.
- Standard execute methods have diagnostics. Native streaming and embedding in an
  independently executed outer query use that executor's logging instead.

[Documentation index](README.md)
