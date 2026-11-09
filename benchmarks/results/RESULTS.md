# PostgreSQL graph-query measurements

Recorded 2026-11-08T14:48:09.517Z on Apple M1 Pro with Node.js v24.20.0, PostgreSQL 14.13, Kysely 0.29.8, and pg 8.23.1. Pool size 10 over Unix socket.

Each method returned the same graph in one statement, including root rows.

| Roots / depth | Objects | Correlated SQL | Preaggregated SQL | Generated query |
|---|---:|---:|---:|---:|
| 100 / 1 | 600 | 1.9 ms | 2.1 ms | 1.5 ms |
| 100 / 4 | 13,000 | 21.8 ms | 21.4 ms | 18.9 ms |
| 500 / 4 | 65,000 | 105.5 ms | 125.6 ms | 88.9 ms |
| 2,000 / 4 | 260,000 | 424.6 ms | 513.0 ms | 357.9 ms |

## Query counts

| Scenario | Correlated SQL | Preaggregated SQL | Generated query |
|---|---:|---:|---:|
| shallow-100 | 1 | 1 | 1 |
| deep-100 | 1 | 1 | 1 |
| deep-500 | 1 | 1 | 1 |
| deep-2000 | 1 | 1 | 1 |

## Detailed measurements

| Scenario | Method | Median | p95 | Node CPU | Logical DB result MiB | Output MiB |
|---|---|---:|---:|---:|---:|---:|
| shallow-100 | sql-correlated | 1.9 ms | 2.0 ms | 2.6 ms | 0.10 | 0.10 |
| shallow-100 | sql-preaggregated | 2.1 ms | 2.3 ms | 2.8 ms | 0.10 | 0.10 |
| shallow-100 | relations-query | 1.5 ms | 1.6 ms | 3.1 ms | 0.10 | 0.10 |
| deep-100 | sql-correlated | 21.8 ms | 23.3 ms | 7.5 ms | 0.96 | 0.96 |
| deep-100 | sql-preaggregated | 21.4 ms | 23.0 ms | 6.3 ms | 0.96 | 0.96 |
| deep-100 | relations-query | 18.9 ms | 19.6 ms | 8.0 ms | 0.96 | 0.96 |
| deep-500 | sql-correlated | 105.5 ms | 109.0 ms | 27.1 ms | 4.90 | 4.90 |
| deep-500 | sql-preaggregated | 125.6 ms | 128.9 ms | 22.3 ms | 4.90 | 4.90 |
| deep-500 | relations-query | 88.9 ms | 91.8 ms | 27.4 ms | 4.90 | 4.90 |
| deep-2000 | sql-correlated | 424.6 ms | 434.5 ms | 109.0 ms | 19.85 | 19.85 |
| deep-2000 | sql-preaggregated | 513.0 ms | 540.5 ms | 92.0 ms | 19.85 | 19.85 |
| deep-2000 | relations-query | 357.9 ms | 363.0 ms | 124.0 ms | 19.85 | 19.85 |

p95 uses the nearest rank over 15 samples per method and scenario. At this sample count it is the maximum.

Logical database result sizes estimate serialized JSON bytes. Node CPU excludes PostgreSQL CPU.

See the [methodology](../README.md), [raw samples](latest.json), [SQL plans](plans.json), and [chart](latency.png).
