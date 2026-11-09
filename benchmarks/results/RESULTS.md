# PostgreSQL graph-query measurements

Recorded 2026-11-09T20:56:45.849Z on Apple M1 Pro with Node.js v24.20.0, PostgreSQL 14.13, Kysely 0.29.8, and pg 8.23.1. Pool size 10 over Unix socket.

Both strategies returned identical ordered graphs. The table reports median latency and Node.js CPU time.

| Roots / depth | Objects | Single latency | Flat latency | Single Node CPU | Flat Node CPU |
|---|---:|---:|---:|---:|---:|
| 100 / 1 | 600 | 1.5 ms | 2.9 ms | 3.5 ms | 5.6 ms |
| 100 / 4 | 13,000 | 19.4 ms | 26.0 ms | 13.3 ms | 34.9 ms |
| 500 / 4 | 65,000 | 90.9 ms | 98.0 ms | 35.9 ms | 126.1 ms |
| 2,000 / 4 | 260,000 | 357.3 ms | 344.0 ms | 132.2 ms | 498.7 ms |

## Query counts

| Scenario | Single | Flat |
|---|---:|---:|
| shallow-100 | 1 | 3 |
| deep-100 | 1 | 16 |
| deep-500 | 1 | 59 |
| deep-2000 | 1 | 233 |

## Detailed measurements

| Scenario | Method | Median | p95 | Node CPU | Logical DB result MiB | Output MiB |
|---|---|---:|---:|---:|---:|---:|
| shallow-100 | single | 1.5 ms | 1.6 ms | 3.5 ms | 0.10 | 0.10 |
| shallow-100 | flat | 2.9 ms | 3.2 ms | 5.6 ms | 0.11 | 0.10 |
| deep-100 | single | 19.4 ms | 20.2 ms | 13.3 ms | 0.96 | 0.96 |
| deep-100 | flat | 26.0 ms | 26.9 ms | 34.9 ms | 1.33 | 0.96 |
| deep-500 | single | 90.9 ms | 137.0 ms | 35.9 ms | 4.90 | 4.90 |
| deep-500 | flat | 98.0 ms | 104.6 ms | 126.1 ms | 6.75 | 4.90 |
| deep-2000 | single | 357.3 ms | 382.6 ms | 132.2 ms | 19.85 | 19.85 |
| deep-2000 | flat | 344.0 ms | 447.8 ms | 498.7 ms | 27.33 | 19.85 |

p95 uses the nearest rank over 15 samples per method and scenario. At this sample count it is the maximum.

Logical database result sizes estimate serialized JSON bytes. Node CPU excludes PostgreSQL CPU.

See the [methodology](../README.md) and [raw samples](latest.json).

Earlier comparisons are available in the [strategy experiment data](strategy-experiments.json).
