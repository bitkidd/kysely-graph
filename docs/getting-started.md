# Getting started

`@bitkidd/kysely-graph` builds typed Kysely queries that fetch root rows,
nested relations, and [computed fields](api.md#computed-fields) in one
PostgreSQL statement.

## Requirements and installation

- Node.js 24.x. The checkout pins major version 24 in `.nvmrc` and `.node-version`.
- Kysely 0.29.x and an existing typed database schema.
- PostgreSQL is the validated production dialect. PGlite is used for local tests.

Once the package is published, install it from npm.

```sh
pnpm add @bitkidd/kysely-graph kysely pg
```

To test a source checkout, install the pnpm version pinned in `package.json`.
Run `nvm use`, `pnpm install --frozen-lockfile`, and `pnpm pack`. Install the
resulting tarball alongside Kysely and pg.

```sh
pnpm add /path/to/bitkidd-kysely-graph-0.1.0.tgz kysely pg
```

Install `@types/pg` as a development dependency when using pg in TypeScript.

## Configure Kysely and declare relations

This example assumes the matching PostgreSQL tables and columns already exist.
The interface describes selectable row values; adapt it to your schema, using
Kysely's `Generated` and `ColumnType` where appropriate.

```ts
import { createGraph, defineGraph } from '@bitkidd/kysely-graph';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

interface Database {
  users: { id: number; name: string; active: boolean };
  profiles: { id: number; userId: number; bio: string };
  posts: {
    id: number;
    authorId: number | null;
    title: string;
    published: boolean;
    createdAt: Date;
  };
  comments: { id: number; postId: number; approved: boolean };
  tags: { id: number; label: string };
  postTags: { postId: number; tagId: number; visible: boolean };
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

const schema = defineGraph<Database>()(({ belongsTo, hasMany, hasOne, manyToMany }) => ({
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

const graph = createGraph(db, schema);
```

The extra `()` in `defineGraph<Database>()(...)` lets you specify the database
type while TypeScript infers literal relation names and key tuples.

The examples use quoted camelCase database columns. Match the table and column
names in your Kysely database type and relation mappings to your schema.

## Load a graph

```ts
const query = graph
  .query({
    table: 'users',
    select: ['id', 'name'],
    with: {
      profile: { select: ['bio'] },
      posts: {
        select: ['id', 'title'],
        query: (qb) => qb.where('published', '=', true).orderBy('createdAt', 'desc').limit(5),
        with: {
          tags: {
            select: ['label'],
            through: (qb) => qb.where('visible', '=', true),
          },
        },
      },
    },
  })
  .where('users.active', '=', true)
  .orderBy('users.id')
  .limit(20);

console.log(query.compile()); // No query is executed.
const result = await query.execute(); // Exactly one statement.
```

`result` contains root `id`/`name`, `profile: { bio: string } | null`, and
`posts: Array<{ id: number; title: string; tags: Array<{ label: string }> }>`.
Unselected internal keys do not appear in child objects. Each child predicate
changes only its own collection, not the set of roots. Root `.limit()` and
`.offset()` paginate users without multiplying rows through child joins.

Nested timestamps and other non-JSON scalars follow PostgreSQL JSON serialization;
see [JSON values](selecting-columns.md#json-values). For a single root, use
`.executeTakeFirst()` or `.executeTakeFirstOrThrow()`.

## Pool lifecycle

Reuse the graph factory and Kysely instance across requests. If Kysely is the pool's sole owner, call `await db.destroy()` at
application shutdown. If the pool is shared by several consumers, manage
`pool.end()` once after all consumers finish; do not destroy Kysely per request.
See [configuration](configuration.md) for transaction-bound queries and pool lifecycle.

[Documentation index](README.md)
