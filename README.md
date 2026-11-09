# @bitkidd/kysely-graph

Typed nested PostgreSQL queries for Kysely. Fetch related rows and computed
fields in **one SQL statement**, with Kysely's usual filtering, ordering,
pagination, and execution methods.

Requires **Node.js 24.x**, **Kysely 0.29.x**, and PostgreSQL. PGlite is used for local
tests.

## Install

Once published, install the package alongside Kysely and pg.

```sh
pnpm add @bitkidd/kysely-graph kysely pg
```

You can also [build and install a local tarball](docs/getting-started.md#requirements-and-installation).

## Usage

Use your existing typed `db` and `Database` interface.

```ts
import { createGraph, defineGraph } from '@bitkidd/kysely-graph';

const schema = defineGraph<Database>()(({ hasMany, computed }) => ({
  users: {
    posts: hasMany('posts', { foreignKey: 'authorId' }),
    postCount: computed('users', (eb, { published }: { published: boolean }) =>
      eb
        .selectFrom('posts')
        .whereRef('posts.authorId', '=', 'users.id')
        .where('posts.published', '=', published)
        .select(({ cast, fn }) => cast<number>(fn.countAll(), 'integer').as('count'))
        .$asScalar(),
    ),
  },
}));
const graph = createGraph(db, schema);

const query = graph
  .query({
    table: 'users',
    select: ['id', 'name'],
    with: {
      postCount: { args: { published: true } },
      posts: {
        select: ['id', 'title'],
        query: (qb) => qb.where('published', '=', true).orderBy('createdAt', 'desc').limit(5),
      },
    },
  })
  .where('active', '=', true)
  .orderBy('users.id')
  .limit(20);

const compiled = query.compile(); // SQL and parameters; no database I/O.
const users = await query.execute(); // One statement, including roots and children.
```

Each user gets up to five published posts and a count of all their published
posts. The outer limit applies to users. Computed fields also work inside nested
relations. See [computed fields](docs/api.md#computed-fields).

Pass `createGraph(db, [userRelations, postRelations])` to combine schemas
defined in separate files. See [combining schemas](docs/relations.md#combining-schemas).

Nested values follow PostgreSQL JSON serialization, including timestamp strings.
Root scalar columns retain normal driver decoding. See [JSON types](docs/selecting-columns.md#json-values).

## Documentation

- [Documentation index](docs/README.md)
- [Getting started](docs/getting-started.md)
- [Relation definitions](docs/relations.md)
- [Querying and filtering graphs](docs/loading.md)
- [Selecting columns and JSON types](docs/selecting-columns.md)
- [Diagnostics](docs/diagnostics.md)
- [Configuration and transactions](docs/configuration.md)
- [API reference](docs/api.md)
- [Performance](docs/performance.md)
- [Development](docs/development.md)

## Development

Install the pnpm version pinned in `package.json` before running the checks.

```sh
nvm use
pnpm install --frozen-lockfile
pnpm run format
pnpm run check
```

Checks run formatting, lint, TypeScript, PGlite tests, and a clean build.
GitHub Actions also runs the PostgreSQL suite. Run `pnpm pack` to build a local
tarball. See [npm releases](docs/development.md#npm-releases) for the tag workflow.
