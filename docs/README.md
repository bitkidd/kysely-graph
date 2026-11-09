# @bitkidd/kysely-graph documentation

Declare relations and computed fields once, then build a typed graph query.
The default loads relations in flat PostgreSQL batches and assembles them in
memory. Use the single strategy to compose the graph as a SQL statement.

Requires Node.js 24.x, Kysely 0.29.x and PostgreSQL. PGlite is used for local tests.
See the installation guide for registry and local tarball commands.

| Guide                                     | Covers                                                                |
| ----------------------------------------- | --------------------------------------------------------------------- |
| [Getting started](getting-started.md)     | Complete pg.Pool/database setup and first query.                      |
| [Relations](relations.md)                 | Typed helpers, schema merging, composite keys and definition filters. |
| [Querying graphs](loading.md)             | Root builders, child predicates and per-parent limits.                |
| [Selecting columns](selecting-columns.md) | Root/child inference and PostgreSQL JSON value semantics.             |
| [Diagnostics](diagnostics.md)             | Graph-query events, summaries, counts and errors.                     |
| [Configuration](configuration.md)         | Parameter budgets, pool lifecycle and transaction-bound execution.    |
| [API](api.md)                             | Exports, options, errors and supported boundaries.                    |
| [Performance](performance.md)             | Current SQL comparisons and benchmark methodology.                    |
| [Development](development.md)             | Node 24, Oxc tools, validation and packaging.                         |

The helpers from the `defineGraph` callback declare the schema used by
`.query({ table, select, with })`. Child filters affect children. Explicit
root predicates determine which rows are returned. Empty to-many relations
are arrays; empty to-one relations are `null`. There is no identity map or write API.
