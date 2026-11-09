# Selecting columns and decoding values

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

The loader fetches any additional keys it needs to attach relations and removes
them from the result. Each returned row exposes the selected fields and
requested relations.

Filters, ordering and stable tie-breakers may use unselected columns. Aliases,
wildcards and expressions inside the `select` option are not implemented. Native
Kysely root `.select()` methods remain available for ordinary root expressions.
Use relation `select` instead of modifying a child callback's selection.

## JSON values

Flat loading uses the driver’s normal decoding for root and nested columns
and computed fields. The single strategy also uses driver decoding for roots,
and uses PostgreSQL JSON decoding for nested results. Its nested types use
the exported recursive `JsonValue<T>` transformation.

| Declared child type           | Nested JSON value                                         |
| ----------------------------- | --------------------------------------------------------- |
| `Date`                        | Timestamp/date string, with PostgreSQL's JSON formatting. |
| `Uint8Array` / Buffer         | PostgreSQL bytea text, normally `\\x...`.                 |
| `bigint`                      | JSON number.                                              |
| Arrays/objects                | Recursively JSON-shaped values.                           |
| String, number, boolean, null | Corresponding JSON scalar.                                |

PostgreSQL JSON serializes int8/numeric as numbers regardless of pg's scalar type
parsers. Standard JSON parsing can lose precision for large integers/decimals.
Use text-valued database views/casts when exact JSON text is required, or configure
a JSON parser with matching application types. A TypeScript database interface
alone cannot reveal the physical SQL type behind a custom scalar parser; align
its child JSON types with the PostgreSQL representation. Custom SQL types and
custom driver decoders may also have different scalar versus JSON representations.

[Documentation index](README.md)
