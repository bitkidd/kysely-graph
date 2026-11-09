# Querying graphs

## Build a single query

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

`query()` returns a typed Kysely `SelectQueryBuilder` with nested JSON selections.
Normal root `.where()`, `.orderBy()`, `.limit()`, `.offset()` and selection methods
keep Kysely semantics and table scope. `.execute()` includes both roots and their
relations in one SQL statement. No preliminary root SELECT is needed.

Use `.executeTakeFirst()` for a row or `undefined`, and
`.executeTakeFirstOrThrow()` for Kysely's normal missing-result error.
`.compile()` returns parameterized SQL without executing it. The builder is
immutable: a chained method returns another builder and the original can be reused.
Use Kysely’s `db.selectFrom()` to embed the graph as a subquery. The declared
relation names are its output column names. When embedding a graph, keep those
names distinct from the selected root columns. If a root column shares a relation
name, exclude that column with the root `select` list or rename the relation.

```ts
const rows = await db.selectFrom(query.as('userGraph')).selectAll().execute();
```

Root pagination operates on root rows; JSON child collections do not multiply
root rows. A child filter changes only that collection. If you need to filter
roots based on a relation, express the root predicate explicitly with Kysely.

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
To-one relations use scalar subqueries: PostgreSQL raises cardinality violation
`21000` if more than one target matches. The original database error propagates.

[Documentation index](README.md)
