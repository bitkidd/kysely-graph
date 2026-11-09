# Querying graphs

## Build a graph query

```ts
const query = relations.query({
  table: 'users',
  select: ['id', 'name'],
  with: {
    profile: { select: ['bio'] },
    posts: {
      select: ['id', 'title'],
      query: (qb) => qb.where('published', '=', true).orderBy('createdAt', 'desc').limit(5),
      with: { comments: true, tags: { select: ['label'] } },
    },
  },
});

const result = await query
  .where('active', '=', true)
  .orderBy('users.id')
  .limit(20)
  .offset(0)
  .execute();
```

`query()` returns a typed `FlatQueryBuilder` by default. It fetches roots,
batches distinct parent keys for each relation, and assembles the graph in
memory. The driver decodes every selected column directly, including nested
columns and computed fields. An empty root result skips relation queries.

Use root predicates, selections, inner joins, ordering, and pagination on
the builder. Use `.executeTakeFirst()` for a row or `undefined` and
`.executeTakeFirstOrThrow()` for Kysely's missing-result error. Both load
relations for the first root. Chaining returns a new builder.

Sibling relations and batches can run concurrently. See
[configuration](configuration.md) for batch size, concurrency, and
transaction behavior.

## Single-statement queries

Pass `strategy: 'single'` to get a Kysely `SelectQueryBuilder`. It supports
`.compile()`, `.explain()`, streaming, and embedding in another query.
Nested values use PostgreSQL JSON decoding.

```ts
const single = createGraph(db, definitions, { strategy: 'single' });
const query = single.query({ table: 'users', with: { posts: true } });
const rows = await db.selectFrom(query.as('userGraph')).selectAll().execute();
```

When embedding a graph, keep relation names distinct from the selected root
columns. Set the root `select` list or rename a relation if the names overlap.

Root pagination applies before child collections are loaded. To filter roots
based on a relation, express the root predicate explicitly with Kysely.

## Child filters and correlated subqueries

```ts
const result = await relations
  .query({
    table: 'users',
    with: {
      posts: {
        query: (qb) =>
          qb
            .where('published', '=', true)
            .where(({ exists, selectFrom }) =>
              exists(
                selectFrom('comments')
                  .select('comments.id')
                  .whereRef('comments.postId', '=', 'posts.id')
                  .where('comments.approved', '=', true),
              ),
            ),
        with: {
          tags: {
            through: (qb) => qb.where('visible', '=', true),
            query: (qb) => qb.orderBy('label'),
          },
        },
      },
    },
  })
  .where('users.active', '=', true)
  .execute();
```

A `query` callback receives a Kysely builder scoped to the target table. Return
a builder derived from it using `.where()`, `.orderBy()`, and, for to-many
relations, `.limit()`. A `through` callback filters and orders the junction
table. Set child projections with the relation's `select` option.

Any [filters on the relation definition](relations.md#definition-filters) also
apply. Request filters narrow those results before the per-parent limit, if set.

Predicates are combined as grouped Kysely operation nodes. The compiler does not
parse SQL strings or invent a query language. Unique internal aliases isolate
self-relations and repeated target tables while callbacks retain their normal
logical table names.

## Ordering and per-parent limits

Call `.limit(n)` inside a `hasMany` or `manyToMany` target callback to limit
each parent's collection. The library appends the target primary key to your
ordering for stable ties. If you omit `.orderBy()`, the limit uses primary-key
order. A zero limit returns an empty array.

For many-to-many relations, an `EXISTS` predicate removes duplicate links
before the target limit applies.

## To-one relations and nulls

To-many relations return `[]` when empty. To-one relations return `null`. A null
mapping component does not match a target, following SQL equality semantics.
Multiple matches for a to-one relation raise an error with code `21000`. Batched
execution detects this while assembling the graph. Single-statement execution
propagates the PostgreSQL error.

[Documentation index](README.md)
