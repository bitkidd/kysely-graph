# Flat batch size and concurrency

Recorded 2026-11-09T21:08:41.412Z on Apple M1 Pro with PostgreSQL 14.13, Node.js v24.20.0, and a pool of 10 over Unix socket.

Each configuration ran with 3 warmups and 15 measured rounds. The benchmark uses raw decoding and one graph execution at a time. Every configuration returned identical ordered results. Node.js CPU excludes PostgreSQL CPU.

Changes are relative to 500 keys and 4 concurrent statements.

At this sample count, nearest-rank p95 is the slowest measured run.

## 100 roots, depth 1

| Batch keys | Concurrency | Statements | Median latency | Latency change | Median Node CPU | CPU change | p95 latency |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 250 | 2 | 3 | 2.8 ms | -0.5% | 9.8 ms | -3.3% | 3.0 ms |
| 250 | 4 | 3 | 2.8 ms | -0.0% | 10.2 ms | +1.0% | 3.0 ms |
| 250 | 8 | 3 | 2.9 ms | +3.6% | 10.1 ms | +0.3% | 3.1 ms |
| 500 | 2 | 3 | 2.9 ms | +2.0% | 10.0 ms | -0.9% | 3.5 ms |
| 500 | 4 | 3 | 2.8 ms | +0.0% | 10.1 ms | +0.0% | 3.1 ms |
| 500 | 8 | 3 | 2.8 ms | +1.6% | 10.0 ms | -1.0% | 3.3 ms |
| 1,000 | 2 | 3 | 2.8 ms | +1.6% | 9.9 ms | -1.8% | 3.0 ms |
| 1,000 | 4 | 3 | 2.9 ms | +2.1% | 10.2 ms | +1.2% | 3.1 ms |
| 1,000 | 8 | 3 | 2.8 ms | +1.5% | 10.2 ms | +0.7% | 3.1 ms |
| 2,000 | 2 | 3 | 2.9 ms | +3.3% | 10.2 ms | +1.4% | 3.4 ms |
| 2,000 | 4 | 3 | 2.8 ms | +1.0% | 10.3 ms | +2.4% | 3.6 ms |
| 2,000 | 8 | 3 | 2.9 ms | +2.7% | 10.4 ms | +2.6% | 3.4 ms |

## 100 roots, depth 4

| Batch keys | Concurrency | Statements | Median latency | Latency change | Median Node CPU | CPU change | p95 latency |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 250 | 2 | 27 | 24.7 ms | +0.0% | 35.8 ms | -2.9% | 45.8 ms |
| 250 | 4 | 27 | 22.1 ms | -10.6% | 37.0 ms | +0.3% | 44.0 ms |
| 250 | 8 | 27 | 22.6 ms | -8.7% | 35.6 ms | -3.4% | 38.2 ms |
| 500 | 2 | 16 | 27.3 ms | +10.5% | 37.0 ms | +0.2% | 28.0 ms |
| 500 | 4 | 16 | 24.7 ms | +0.0% | 36.9 ms | +0.0% | 26.2 ms |
| 500 | 8 | 16 | 22.4 ms | -9.4% | 34.9 ms | -5.3% | 45.9 ms |
| 1,000 | 2 | 11 | 30.5 ms | +23.1% | 34.9 ms | -5.3% | 38.1 ms |
| 1,000 | 4 | 11 | 27.5 ms | +11.0% | 36.0 ms | -2.4% | 28.9 ms |
| 1,000 | 8 | 11 | 28.2 ms | +14.1% | 35.4 ms | -3.9% | 30.1 ms |
| 2,000 | 2 | 8 | 38.1 ms | +53.9% | 36.4 ms | -1.3% | 39.8 ms |
| 2,000 | 4 | 8 | 37.5 ms | +51.5% | 36.9 ms | -0.0% | 39.1 ms |
| 2,000 | 8 | 8 | 37.4 ms | +51.2% | 34.4 ms | -6.8% | 38.0 ms |

## 500 roots, depth 4

| Batch keys | Concurrency | Statements | Median latency | Latency change | Median Node CPU | CPU change | p95 latency |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 250 | 2 | 117 | 96.4 ms | +5.7% | 125.6 ms | -0.5% | 133.3 ms |
| 250 | 4 | 117 | 85.5 ms | -6.2% | 128.5 ms | +1.9% | 98.1 ms |
| 250 | 8 | 117 | 83.9 ms | -8.0% | 123.2 ms | -2.3% | 128.7 ms |
| 500 | 2 | 59 | 100.8 ms | +10.5% | 129.6 ms | +2.8% | 127.3 ms |
| 500 | 4 | 59 | 91.2 ms | +0.0% | 126.2 ms | +0.0% | 95.2 ms |
| 500 | 8 | 59 | 88.7 ms | -2.8% | 121.1 ms | -4.0% | 96.5 ms |
| 1,000 | 2 | 31 | 123.6 ms | +35.6% | 126.9 ms | +0.6% | 128.9 ms |
| 1,000 | 4 | 31 | 99.0 ms | +8.5% | 125.8 ms | -0.3% | 103.6 ms |
| 1,000 | 8 | 31 | 96.9 ms | +6.3% | 136.3 ms | +8.0% | 138.9 ms |
| 2,000 | 2 | 17 | 139.4 ms | +52.9% | 130.2 ms | +3.2% | 143.0 ms |
| 2,000 | 4 | 17 | 111.4 ms | +22.2% | 135.3 ms | +7.2% | 114.8 ms |
| 2,000 | 8 | 17 | 104.7 ms | +14.8% | 142.3 ms | +12.8% | 197.8 ms |

## 2,000 roots, depth 4

| Batch keys | Concurrency | Statements | Median latency | Latency change | Median Node CPU | CPU change | p95 latency |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 250 | 2 | 465 | 347.4 ms | +4.2% | 503.8 ms | +1.7% | 358.7 ms |
| 250 | 4 | 465 | 324.9 ms | -2.5% | 501.4 ms | +1.2% | 334.7 ms |
| 250 | 8 | 465 | 326.1 ms | -2.2% | 505.5 ms | +2.0% | 336.4 ms |
| 500 | 2 | 233 | 349.2 ms | +4.8% | 500.8 ms | +1.1% | 365.3 ms |
| 500 | 4 | 233 | 333.3 ms | +0.0% | 495.6 ms | +0.0% | 395.4 ms |
| 500 | 8 | 233 | 334.0 ms | +0.2% | 500.7 ms | +1.0% | 383.7 ms |
| 1,000 | 2 | 117 | 432.1 ms | +29.7% | 492.0 ms | -0.7% | 483.4 ms |
| 1,000 | 4 | 117 | 374.4 ms | +12.3% | 488.6 ms | -1.4% | 399.7 ms |
| 1,000 | 8 | 117 | 348.3 ms | +4.5% | 500.6 ms | +1.0% | 375.1 ms |
| 2,000 | 2 | 59 | 540.9 ms | +62.3% | 498.6 ms | +0.6% | 663.5 ms |
| 2,000 | 4 | 59 | 423.1 ms | +27.0% | 502.4 ms | +1.4% | 435.8 ms |
| 2,000 | 8 | 59 | 369.1 ms | +10.8% | 496.8 ms | +0.2% | 384.1 ms |

See the [methodology](../README.md) and [raw samples](flat-tuning.json).

The [confirmation run](flat-tuning-confirmation.json) repeated 500/4, 250/4, and 500/8.
