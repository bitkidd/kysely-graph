# Relation definitions

```ts
import { createGraph, defineGraph } from '@bitkidd/kysely-graph';

// Database is your existing Kysely database interface.
const relations = defineGraph<Database>()(({ belongsTo, hasMany, hasOne, manyToMany }) => ({
  users: {
    posts: hasMany('posts', { foreignKey: 'authorId' }),
    profile: hasOne('profiles', { foreignKey: 'userId' }),
  },
  posts: {
    author: belongsTo('users', { foreignKey: 'authorId' }),
    comments: hasMany('comments', { foreignKey: 'postId' }),
    tags: manyToMany('tags', {
      through: 'postTags',
      sourceKey: 'postId',
      targetKey: 'tagId',
    }),
  },
}));
const graph = createGraph(db, relations);
```

The extra `()` after `defineGraph<Database>` lets TypeScript infer literal
relation names and column tuples while you supply the database type. Schema
validation checks source/target/junction table names, column names, tuple arity,
and compatible selectable key types. Pass the resulting schema to `createGraph`.

## Combining schemas

Define and export schemas from separate modules using the same database type.
Import them where you create the graph and pass them as an array.

```ts
import { createGraph } from '@bitkidd/kysely-graph';

import { postRelations } from './posts.relations.js';
import { userRelations } from './users.relations.js';

const graph = createGraph(db, [userRelations, postRelations]);
const users = await graph
  .query({ table: 'users', with: { posts: { with: { author: true } } } })
  .execute();
```

You can request relations and computed fields from different schemas in one
query, including across nested levels. If two schemas declare the same field
name on the same table, `createGraph` raises a `GraphError`.

## Mapping options

| Helper              | Required options                                                                                        | Optional key overrides                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `hasMany`, `hasOne` | `foreignKey`: columns on the target pointing to the source.                                             | `sourceKey`: source primary key, default `id`. `targetKey`: target primary key used for deterministic limit tie-breakers, default `id`. |
| `belongsTo`         | `foreignKey`: columns on the source pointing to the target.                                             | `targetKey`: target lookup key, default `id`.                                                                                           |
| `manyToMany`        | `through`: junction table; `sourceKey` and `targetKey`: junction columns pointing to source and target. | `sourcePrimaryKey` and `targetPrimaryKey`: lookup keys on the source/target, both default `id`.                                         |

All keys can be column names or non-empty readonly tuples. Relation names are
local to their source table and can differ from target table names. A target
table only needs its own schema entry if it declares nested relations.

## Custom and composite keys

Primary keys default to `id`. Use scalar column names or non-empty tuples:

```ts
interface CompositeDatabase {
  tenants: { tenant: string; code: string; title: string };
  items: { itemCode: number; tenant: string | null; parentCode: string | null };
  tags: { code: string; label: string };
  tenantTags: { tenant: string; parentCode: string; tagCode: string };
}

const compositeRelations = defineGraph<CompositeDatabase>()(
  ({ belongsTo, hasMany, manyToMany }) => ({
    tenants: {
      items: hasMany('items', {
        sourceKey: ['tenant', 'code'],
        foreignKey: ['tenant', 'parentCode'],
        targetKey: 'itemCode', // target PK for deterministic per-parent ordering
      }),
      tags: manyToMany('tags', {
        through: 'tenantTags',
        sourcePrimaryKey: ['tenant', 'code'],
        sourceKey: ['tenant', 'parentCode'], // junction columns pointing to source
        targetKey: 'tagCode', // junction columns pointing to target
        targetPrimaryKey: 'code',
      }),
    },
    items: {
      parent: belongsTo('tenants', {
        foreignKey: ['tenant', 'parentCode'],
        targetKey: ['tenant', 'code'],
      }),
    },
  }),
);
```

`hasOne` uses the same key options as `hasMany`. Composite mappings are positional;
all corresponding tuples must have equal arity. Any null component means no
relation. PostgreSQL compares the mapping columns using their SQL types. Primary
key overrides must identify unique target rows for deterministic ordering.

Duplicate junction rows attach a given target once per source. Filtering the
junction occurs before target deduplication and per-parent limiting, so duplicates do not consume
per-parent slots. Internal SQL columns do not appear in JSON results. Nested targets expose `JsonValue<Selectable<Database[Target]>>` by default, or only
the columns named by `select`, plus their requested nested relations.

## Definition filters

The helpers infer the Kysely builder type for each target or junction table.
Add `query` to filter the target of any relation, or `throughQuery` to filter a
many-to-many junction.

```ts
const definitions = defineGraph<Database>()(({ hasMany, manyToMany }) => ({
  users: {
    publishedPosts: hasMany('posts', {
      foreignKey: 'authorId',
      query: (qb) => qb.where('published', '=', true),
    }),
  },
  posts: {
    visibleTags: manyToMany('tags', {
      through: 'postTags',
      sourceKey: 'postId',
      targetKey: 'tagId',
      throughQuery: (qb) => qb.where('visible', '=', true),
    }),
  },
}));

const graph = createGraph(db, definitions);
const users = await graph.query({ table: 'users', with: { publishedPosts: true } }).execute();
```

Definition callbacks accept predicates such as `.where()` and `.whereRef()`.
They run whenever the relation is requested, including with `true` and at nested
levels. The compiler combines definition filters, request filters, and relation
key matches with `AND`. Use request callbacks for ordering and per-parent limits.

For a shared attachments table with `parent_id` and `parent_model`, define one
relation per source table. Use `foreignKey: 'parent_id'` with
`query: (qb) => qb.where('parent_model', '=', 'User')` on the user relation and
the corresponding discriminator on each other source. If the discriminator is
on a junction table, use `throughQuery` on the `manyToMany` definition.

[Documentation index](README.md)
