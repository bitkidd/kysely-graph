# Application-shaped graph workloads

Recorded 2026-11-09T21:29:54.650Z on Apple M1 Pro with Node.js v24.20.0, PostgreSQL 14.13, Kysely 0.29.8, and pg 8.23.1. Pool size 10 over Unix socket.

The benchmark uses synthetic data seeded with 2,000 users and returns the same ordered, projected results with both strategies.

| Workload | Response shape | JSON size | SQL statements (flat / single) |
|---|---|---:|---:|
| User directory | 25 users with an optional profile, paginated by user ID. | 2.38–2.44 KiB | 2 / 1 |
| Post feed | 20 posts, each with its author, tags, and up to two newest comments. | 8.01–8.07 KiB | 4 / 1 |
| Post detail | One popular post with its author, tags, 20 newest comments, up to two replies each, and likes. | 7.95–7.98 KiB | 6 / 1 |

The default `flat` strategy uses raw pg decoding and 500 keys per batch. Each strategy shares 4 SQL statement slots across requests on its graph instance. Each `single` request uses one slot for its one statement.

Each case ran 12 warmup waves and 48 measured waves on warm, pre-opened connections with PostgreSQL JIT disabled and natural Node.js garbage collection. Each wave starts all requests together, rotating through eight input pages or post IDs. Timings include query construction, database work, transfer, decoding, and graph assembly. Request latency includes queueing. The p95 uses the nearest rank over all request times for a case. Node CPU is the median process CPU per wave divided by its request count. PostgreSQL CPU and final JSON serialization are outside the Node CPU measurement.

| Workload | Overlapping requests | Flat median / p95 | Single median / p95 | Flat Node CPU / request | Single Node CPU / request |
|---|---:|---:|---:|---:|---:|
| User directory | 1 | 0.44 / 0.57 ms | 0.18 / 0.23 ms | 0.22 ms | 0.09 ms |
| User directory | 4 | 0.64 / 1.04 ms | 0.31 / 0.39 ms | 0.18 ms | 0.08 ms |
| User directory | 8 | 1.16 / 1.91 ms | 0.49 / 0.81 ms | 0.21 ms | 0.08 ms |
| Post feed | 1 | 0.81 / 0.99 ms | 0.65 / 0.83 ms | 0.60 ms | 0.23 ms |
| Post feed | 4 | 1.55 / 2.03 ms | 0.91 / 1.23 ms | 0.43 ms | 0.17 ms |
| Post feed | 8 | 2.89 / 4.33 ms | 1.42 / 2.10 ms | 0.51 ms | 0.17 ms |
| Post detail | 1 | 1.13 / 1.38 ms | 0.66 / 0.83 ms | 0.66 ms | 0.23 ms |
| Post detail | 4 | 1.88 / 2.21 ms | 0.95 / 1.23 ms | 0.50 ms | 0.19 ms |
| Post detail | 8 | 3.60 / 4.42 ms | 1.49 / 1.74 ms | 0.56 ms | 0.19 ms |

## Pool use and throughput

Throughput measures requests per median wave duration within each burst.

| Workload | Strategy | Overlapping requests | Requests / second | Peak connections |
|---|---|---:|---:|---:|
| User directory | flat | 1 | 2,256 | 1 |
| User directory | single | 1 | 5,536 | 1 |
| User directory | flat | 4 | 5,020 | 4 |
| User directory | single | 4 | 9,982 | 4 |
| User directory | flat | 8 | 5,378 | 4 |
| User directory | single | 8 | 10,574 | 4 |
| Post feed | flat | 1 | 1,232 | 3 |
| Post feed | single | 1 | 1,534 | 1 |
| Post feed | flat | 4 | 2,153 | 4 |
| Post feed | single | 4 | 3,508 | 4 |
| Post feed | flat | 8 | 2,234 | 4 |
| Post feed | single | 8 | 3,893 | 4 |
| Post detail | flat | 1 | 887 | 3 |
| Post detail | single | 1 | 1,510 | 1 |
| Post detail | flat | 4 | 1,938 | 4 |
| Post detail | single | 4 | 3,342 | 4 |
| Post detail | flat | 8 | 2,020 | 4 |
| Post detail | single | 8 | 3,602 | 4 |

See the [methodology](../README.md) and [raw waves](application.json).
