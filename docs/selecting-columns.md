# Selecting columns and JSON values

```ts
const rows = await relations
  .query({
    table: 'users',
    select: ['id', 'name'],
    with: {
      posts: {
        select: ['title'],
        query: (qb) => qb.where('published', '=', true).orderBy('createdAt', 'desc'),
        with: {
          author: { select: ['name'] },
          tags: { select: ['label'] },
        },
      },
    },
  })
  .where('users.active', '=', true)
  .execute();
// Array<{ id: number; name: string; posts: Array<{
//   title: string; author: { name: string } | null; tags: Array<{ label: string }>
// }> }>
```

Both root and relation `select` lists contain unqualified column names. Inline
lists and `as const` tuples infer exact properties. Variable-length arrays produce
optional selected properties because their runtime contents are not guaranteed.
Omitting a list selects the complete row. An empty list emits an empty object,
or only that row's requested nested relations.

Child columns needed to correlate further nested relations stay inside the SQL
subquery. JSON object construction exposes only selected fields and requested
relations. Root source keys need not be exposed by a native root selection because
SQL can still reference them.

Filters, ordering and stable tie-breakers may use unselected columns. Aliases,
wildcards and expressions inside the `select` option are not implemented. Native
Kysely root `.select()` methods remain available for ordinary root expressions.
Use relation `select` instead of modifying a child callback's selection.

## JSON values

Nested relations are decoded from PostgreSQL JSON, not from individual pg scalar
columns. Their types use the exported recursive `JsonValue<T>` transformation:

| Declared child type           | Nested JSON value                                         |
| ----------------------------- | --------------------------------------------------------- |
| `Date`                        | Timestamp/date string, with PostgreSQL's JSON formatting. |
| `Uint8Array` / Buffer         | PostgreSQL bytea text, normally `\\x...`.                 |
| `bigint`                      | JSON number.                                              |
| Arrays/objects                | Recursively JSON-shaped values.                           |
| String, number, boolean, null | Corresponding JSON scalar.                                |

Root scalar columns retain the driver’s normal decoding. Nested relation values
use PostgreSQL JSON decoding.

PostgreSQL JSON serializes int8/numeric as numbers regardless of pg's scalar type
parsers. Standard JSON parsing can lose precision for large integers/decimals.
Use text-valued database views/casts when exact JSON text is required, or configure
a JSON parser with matching application types. A TypeScript database interface
alone cannot reveal the physical SQL type behind a custom scalar parser; align
its child JSON types with the PostgreSQL representation. Custom SQL types and
custom driver decoders may also have different scalar versus JSON representations.

[Documentation index](README.md)
