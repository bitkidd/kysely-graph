# Development and validation

Use Node.js 24.x as specified in `.nvmrc` and `.node-version`, and install the
pnpm version pinned in `package.json`. The `engineStrict` workspace setting checks
the Node.js requirement. [Install pnpm](https://pnpm.io/installation)

```sh
nvm use
pnpm install --frozen-lockfile
pnpm run format
pnpm run check
```

| Command            | Purpose                                                                              |
| ------------------ | ------------------------------------------------------------------------------------ |
| `format`           | Safe oxlint fixes, then oxfmt; single quotes and sorted declarations/import members. |
| `format:check`     | Verify maintained files match oxfmt.                                                 |
| `lint`, `lint:fix` | oxlint correctness/import-member rules, with warnings treated as failures.           |
| `typecheck`        | Source, benchmarks and positive/negative type assertions.                            |
| `test`             | PostgreSQL behavior using in-process PGlite.                                         |
| `test:postgres`    | Same tests using `DATABASE_URL`.                                                     |
| `build`            | Remove stale `dist/` and build ESM, declarations and source/declaration maps.        |
| `check`            | Formatting, lint, types, tests and clean build.                                      |
| `bench`            | Compare the generated query with handwritten SQL.                                    |
| `bench:profile`    | Profile the generated query.                                                         |
| `pnpm pack`        | Build an installable tarball containing the compiled package and docs.               |

Use `pnpm run <command>` except `pnpm pack`. Formatting is configured in
`.oxfmtrc.json`; named-member import sorting is enforced by `.oxlintrc.json`.
Generated build/benchmark artifacts and frozen historical sources in
`benchmarks/baseline/` and `benchmarks/batched/` are not rewritten by these tools.
Negative type tests keep expected-error directives directly above the failing
expressions/properties so formatting does not invalidate their coverage.

## PostgreSQL tests

```sh
pnpm test
DATABASE_URL=postgres://user:password@localhost:5432/disposable_database pnpm run test:postgres
```

The external fixture drops/recreates its public test tables: use a disposable
database. With `DATABASE_URL` unset, tests use PGlite and require no Docker.
Individual Node test cases run in-process with PGlite and the reporter.

Tests verify one-statement query counts, all relation kinds, nested predicates,
self-relations, repeated-table scopes, composite keys, null/empty cases, duplicate
junctions, stable limits, column selections, mutation independence, Kysely subqueries,
JSON scalar types, diagnostics, transactions and exact TypeScript inference.

## Layout

| Path                 | Responsibility                                                  |
| -------------------- | --------------------------------------------------------------- |
| `src/schema.ts`      | Public helper definitions and mapping validation.               |
| `src/types.ts`       | Query, JSON result and diagnostic types.                        |
| `src/planner.ts`     | Graph validation and key mapping.                               |
| `src/query.ts`       | Parameterized PostgreSQL JSON compiler and alias scopes.        |
| `src/graph.ts`       | Factory and Kysely execution wrapper.                           |
| `src/diagnostics.ts` | Query diagnostics and observer delivery.                        |
| `tests/`             | Runtime and type regression coverage.                           |
| `benchmarks/`        | SQL baselines, graph workload and historical snapshots/results. |
| `docs/`              | Package guides and API reference.                               |

## npm releases

The GitHub workflow runs `pnpm run check` and the PostgreSQL 17 suite on pull
requests, pushes to `main`, and version tags. A tag must match `v` followed by
the version in `package.json`. The publish job uses `pnpm publish` to upload
the tested tarball to npm. Stable versions use the `latest` dist-tag and prereleases use `next`.

Configure a GitHub Actions trusted publisher in the npm package settings with
the GitHub repository owner and name, the filename `npm.yml`, and permission
to publish. The workflow adds the repository URL to the tarball for npm
provenance. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)

npm requires the package to exist before you can configure a trusted publisher.
For the first release, set the GitHub secret `NPM_BOOTSTRAP_TOKEN` to a granular
npm token with permission to create and publish under `@bitkidd` and with 2FA
bypass enabled. Remove the secret after configuring trusted publishing.
[npm publishing requirements](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)

[Documentation index](README.md)
