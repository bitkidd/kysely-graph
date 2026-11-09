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

Tests verify batch sizes and statement counts, all relation kinds, nested predicates,
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
| `src/batch.ts`       | Relation batches, concurrency, and graph assembly.              |
| `src/graph.ts`       | Factory and Kysely execution wrapper.                           |
| `src/diagnostics.ts` | Query diagnostics and observer delivery.                        |
| `tests/`             | Runtime and type regression coverage.                           |
| `benchmarks/`        | SQL baselines, graph workload and historical snapshots/results. |
| `docs/`              | Package guides and API reference.                               |

## npm releases

The GitHub workflow runs `pnpm run check` and the PostgreSQL 17 suite on pull
requests, pushes to `main`, and version tags. A tag must match `v` followed by
the version in `package.json`. On a matching tag, the staging job uploads the
tested tarball with `pnpm stage publish` and prints its stage ID. Stable
versions are staged with the `latest` dist-tag and prereleases with `next`.
The version becomes installable after maintainer approval.
[pnpm stage](https://pnpm.io/cli/stage)

### Configure the trusted publisher

In the npm settings for `@bitkidd/kysely-graph`, add a GitHub Actions trusted
publisher with user `bitkidd`, repository `kysely-graph`, and workflow filename
`npm.yml`. Leave direct publishing and dist-tag management unchecked. The
workflow authenticates with GitHub's OIDC identity and includes the repository
URL in the tarball for provenance.
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)

### Review and approve each release

1. Push a version tag that matches the committed `package.json`.
2. Wait for the **Stage the tested tarball on npm** step to succeed.
3. Open **Staged Packages** on npmjs.com, select the version, review it, and
   approve it with 2FA. [npm staged publishing](https://docs.npmjs.com/staged-publishing/)

To review and approve from the terminal, use the stage ID from the workflow
log or from `pnpm stage list`.

```sh
pnpm stage list @bitkidd/kysely-graph
pnpm stage view <stage-id>
pnpm stage approve <stage-id>
```

[Documentation index](README.md)
