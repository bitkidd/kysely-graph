# Performance and benchmarking

## Application workloads

Recorded 2026-11-09T21:29:54.650Z on Apple M1 Pro with Node.js v24.20.0, PostgreSQL 14.13, Kysely 0.29.8, and pg 8.23.1. Pool size 10 over Unix socket.

The benchmark uses synthetic data seeded with 2,000 users and returns the same ordered, projected results with both strategies.

| Workload       | Response shape                                                                                 |     JSON size | SQL statements (flat / single) |
| -------------- | ---------------------------------------------------------------------------------------------- | ------------: | -----------------------------: |
| User directory | 25 users with an optional profile, paginated by user ID.                                       | 2.38–2.44 KiB |                          2 / 1 |
| Post feed      | 20 posts, each with its author, tags, and up to two newest comments.                           | 8.01–8.07 KiB |                          4 / 1 |
| Post detail    | One popular post with its author, tags, 20 newest comments, up to two replies each, and likes. | 7.95–7.98 KiB |                          6 / 1 |

The default `flat` strategy uses raw pg decoding and 500 keys per batch. Each strategy shares 4 SQL statement slots across requests on its graph instance. Each `single` request uses one slot for its one statement.

Each case ran 12 warmup waves and 48 measured waves on warm, pre-opened connections with PostgreSQL JIT disabled and natural Node.js garbage collection. Each wave starts all requests together, rotating through eight input pages or post IDs. Timings include query construction, database work, transfer, decoding, and graph assembly. Request latency includes queueing. The p95 uses the nearest rank over all request times for a case. Node CPU is the median process CPU per wave divided by its request count. PostgreSQL CPU and final JSON serialization are outside the Node CPU measurement.

| Workload       | Overlapping requests | Flat median / p95 | Single median / p95 | Flat Node CPU / request | Single Node CPU / request |
| -------------- | -------------------: | ----------------: | ------------------: | ----------------------: | ------------------------: |
| User directory |                    1 |    0.44 / 0.57 ms |      0.18 / 0.23 ms |                 0.22 ms |                   0.09 ms |
| User directory |                    4 |    0.64 / 1.04 ms |      0.31 / 0.39 ms |                 0.18 ms |                   0.08 ms |
| User directory |                    8 |    1.16 / 1.91 ms |      0.49 / 0.81 ms |                 0.21 ms |                   0.08 ms |
| Post feed      |                    1 |    0.81 / 0.99 ms |      0.65 / 0.83 ms |                 0.60 ms |                   0.23 ms |
| Post feed      |                    4 |    1.55 / 2.03 ms |      0.91 / 1.23 ms |                 0.43 ms |                   0.17 ms |
| Post feed      |                    8 |    2.89 / 4.33 ms |      1.42 / 2.10 ms |                 0.51 ms |                   0.17 ms |
| Post detail    |                    1 |    1.13 / 1.38 ms |      0.66 / 0.83 ms |                 0.66 ms |                   0.23 ms |
| Post detail    |                    4 |    1.88 / 2.21 ms |      0.95 / 1.23 ms |                 0.50 ms |                   0.19 ms |
| Post detail    |                    8 |    3.60 / 4.42 ms |      1.49 / 1.74 ms |                 0.56 ms |                   0.19 ms |

## Synthetic stress workloads

Recorded 2026-11-09T20:56:45.849Z on Apple M1 Pro with Node.js v24.20.0, PostgreSQL 14.13, Kysely 0.29.8, and pg 8.23.1. Pool size 10 over Unix socket.

Both strategies returned identical ordered graphs. The table reports median latency and Node.js CPU time.

| Roots / depth | Objects | Single latency | Flat latency | Single Node CPU | Flat Node CPU |
| ------------- | ------: | -------------: | -----------: | --------------: | ------------: |
| 100 / 1       |     600 |         1.5 ms |       2.9 ms |          3.5 ms |        5.6 ms |
| 100 / 4       |  13,000 |        19.4 ms |      26.0 ms |         13.3 ms |       34.9 ms |
| 500 / 4       |  65,000 |        90.9 ms |      98.0 ms |         35.9 ms |      126.1 ms |
| 2,000 / 4     | 260,000 |       357.3 ms |     344.0 ms |        132.2 ms |      498.7 ms |

The largest graph contains 260,000 object occurrences. Fan-out, row width, indexes, pool contention, and network latency affect execution time.

Flat uses its defaults of 500 parent keys per batch and four concurrent statements. Node.js CPU time excludes PostgreSQL CPU.

Each method ran with 3 warmups and 15 measured rounds over warm caches and pre-opened connections, with PostgreSQL JIT disabled. Timings include query construction, database work, transfer, and driver decoding. Final HTTP JSON serialization is outside the measurement.

## Reproduce from a source checkout

```sh
nvm use
pnpm install --frozen-lockfile
export DATABASE_URL=postgres://user:password@localhost:5432/database
BENCH_APPLICATION=1 pnpm run bench
python benchmarks/report.py --application
pnpm run bench
python benchmarks/report.py --no-chart
```

The database role needs schema creation privileges. Each run creates and removes its own schema. Set `BENCH_ROOTS`, `BENCH_SAMPLES`, and `BENCH_WARMUPS` to change the workload. Omit `--no-chart` to regenerate the charts with matplotlib.

The source checkout stores application waves in `benchmarks/results/application.json`, stress samples in `benchmarks/results/latest.json`, and earlier strategy experiments alongside them.

[Documentation index](README.md)
