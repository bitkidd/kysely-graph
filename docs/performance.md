# Performance and benchmarking

Recorded 2026-11-08T14:48:09.517Z on Apple M1 Pro with Node.js v24.20.0, PostgreSQL 14.13, Kysely 0.29.8, and pg 8.23.1. Pool size 10 over Unix socket.

Each method returned the same graph in one statement, including root rows.

| Roots / depth | Objects | Correlated SQL | Preaggregated SQL | Generated query |
| ------------- | ------: | -------------: | ----------------: | --------------: |
| 100 / 1       |     600 |         1.9 ms |            2.1 ms |          1.5 ms |
| 100 / 4       |  13,000 |        21.8 ms |           21.4 ms |         18.9 ms |
| 500 / 4       |  65,000 |       105.5 ms |          125.6 ms |         88.9 ms |
| 2,000 / 4     | 260,000 |       424.6 ms |          513.0 ms |        357.9 ms |

![Generated PostgreSQL query comparison](assets/latency.svg)

The largest graph contains 260,000 object occurrences. Fan-out, row width, indexes, pool contention, and network latency affect execution time.

Each method ran with 3 warmups and 15 measured rounds over warm caches and pre-opened connections, with PostgreSQL JIT disabled. Timings include query construction, database work, transfer, and driver decoding. Final HTTP JSON serialization is outside the measurement.

## Reproduce from a source checkout

```sh
nvm use
pnpm install --frozen-lockfile
DATABASE_URL=postgres://user:password@localhost:5432/database pnpm run bench
python benchmarks/report.py
```

The database role needs schema creation privileges. Each run creates and removes its own schema. Set `BENCH_ROOTS`, `BENCH_SAMPLES`, and `BENCH_WARMUPS` to change the workload. The report renderer requires matplotlib.

The source checkout stores raw samples in `benchmarks/results/latest.json`, handwritten SQL plans in `benchmarks/results/plans.json`, and historical runs alongside them.

[Documentation index](README.md)
