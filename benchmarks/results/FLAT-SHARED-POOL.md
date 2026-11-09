# Flat requests sharing one pool

Recorded 2026-11-09T21:21:01.672Z on Apple M1 Pro with PostgreSQL 14.13, Node.js v24.20.0, and a pool of 10 over Unix socket.

One graph instance used the defaults of 500 keys per batch and 4 query slots shared across requests. Each load level ran 3 warmup waves and 15 measured waves. A wave starts all requests together. All loads returned identical ordered graphs.

Latency percentiles use individual request times across all waves. CPU per request is median wave Node.js CPU divided by the request count. Throughput uses median wave duration. CPU excludes PostgreSQL, and timings exclude final JSON serialization.

| Roots / depth | Requests per wave | Median latency | p95 latency | Node CPU / request | Requests / second | Peak connections |
|---|---:|---:|---:|---:|---:|---:|
| 100 / 1 | 1 | 2.8 ms | 2.9 ms | 6.0 ms | 362.1 | 2 |
| 100 / 1 | 2 | 3.2 ms | 3.5 ms | 3.4 ms | 570.0 | 4 |
| 100 / 1 | 4 | 4.9 ms | 5.9 ms | 2.6 ms | 682.6 | 4 |
| 100 / 1 | 8 | 7.9 ms | 9.9 ms | 2.1 ms | 795.2 | 4 |
| 100 / 4 | 1 | 25.4 ms | 26.4 ms | 33.0 ms | 39.3 | 4 |
| 100 / 4 | 2 | 38.2 ms | 41.6 ms | 29.3 ms | 51.0 | 4 |
| 100 / 4 | 4 | 67.3 ms | 72.2 ms | 27.8 ms | 56.5 | 4 |
| 100 / 4 | 8 | 123.5 ms | 133.7 ms | 25.9 ms | 60.9 | 4 |
| 500 / 4 | 1 | 101.7 ms | 105.0 ms | 133.8 ms | 9.8 | 4 |
| 500 / 4 | 2 | 156.7 ms | 253.4 ms | 111.7 ms | 12.6 | 4 |
| 500 / 4 | 4 | 305.0 ms | 479.4 ms | 114.3 ms | 12.8 | 4 |
| 500 / 4 | 8 | 603.4 ms | 633.5 ms | 113.8 ms | 13.0 | 4 |
| 2,000 / 4 | 1 | 336.3 ms | 357.7 ms | 533.9 ms | 3.0 | 4 |
| 2,000 / 4 | 2 | 604.5 ms | 656.8 ms | 480.4 ms | 3.3 | 4 |
| 2,000 / 4 | 4 | 1215.3 ms | 35042.2 ms | 477.6 ms | 3.3 | 4 |
| 2,000 / 4 | 8 | 2395.5 ms | 2785.8 ms | 444.4 ms | 3.3 | 4 |

See the [methodology](../README.md) and [raw waves](flat-shared-pool.json).

## Repeat of the largest workload

A four-request wave in the original run took much longer than the others. The repeat uses the same setup and measures the largest workload again. The original table includes every measured wave.

| Roots / depth | Requests per wave | Median latency | p95 latency | Node CPU / request | Requests / second | Peak connections |
|---|---:|---:|---:|---:|---:|---:|
| 2,000 / 4 | 1 | 348.0 ms | 364.1 ms | 547.4 ms | 2.9 | 4 |
| 2,000 / 4 | 2 | 606.1 ms | 699.2 ms | 439.0 ms | 3.3 | 4 |
| 2,000 / 4 | 4 | 1206.2 ms | 1395.3 ms | 469.9 ms | 3.3 | 4 |
| 2,000 / 4 | 8 | 2405.0 ms | 2538.5 ms | 433.8 ms | 3.3 | 4 |

See the [raw repeat waves](flat-shared-pool-repeat.json).
