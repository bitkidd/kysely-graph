# PostgreSQL graph benchmark

Run from a source checkout using PostgreSQL and pg.Pool:

```sh
DATABASE_URL=postgres://user:password@localhost:5432/database pnpm run bench
python benchmarks/report.py
```

Each run creates and removes an isolated `krl_bench_<pid>_<timestamp>` schema.
The role needs schema creation privileges. Application/test tables are not reset.
A killed process can leave its isolated schema behind.

## Compared methods

- `sql-correlated`: handwritten indexed correlated `json_agg` subqueries.
- `sql-preaggregated`: handwritten materialized selected-key CTEs with aggregation
  before joining, avoiding multiplication of sibling collections.
- `relations-query`: current `createGraph().query()` compiler, including roots
  and all nested JSON values in one statement.

Every strategy returns the same fields, root order, array order and nested graph.
Full deep equality is checked outside timing. Root query time is included in all
methods. The generated compiler uses ordinary package code, not benchmark-specific
SQL paths. Handwritten baseline SQL and EXPLAIN plans are stored in results/plans.json.

Historical code snapshots and measurements are stored under `baseline/`,
`batched/`, and `results/`. The current report and chart compare the three methods listed above.

## Workload and measurement

Each user has one profile and four posts. Deep graphs add four comments per post,
two replies per comment, two reactions per reply and three tags per post. Tags are
shared among 32 targets. All mappings are indexed and tables are analyzed. The
root/post payload is padded by 128 characters, comment bodies by 96 and replies
by 64. Every relation is populated with uniform fan-out.

Scenarios use 100 roots at depth one, then 100, 500 and 2,000 roots at depth four.
The largest graph has 260,000 object occurrences. Configure `BENCH_ROOTS`,
`BENCH_SAMPLES` (default 15) and `BENCH_WARMUPS` (default 3) to adjust the run.

The database is warm, with all ten pool connections opened ahead of time and JIT
disabled uniformly. The report records the PostgreSQL version and transport. Methods rotate/reverse order
between measured rounds. Timing includes query construction, PostgreSQL work,
transfer and pg decoding. It excludes seeding, equality checks,
explicit pre-sample GC and final HTTP JSON serialization.

Counters must match in each sample. Logical result bytes are estimated by
JSON-stringifying database result rows outside measured runs, not by capturing
PostgreSQL protocol traffic. Node CPU excludes PostgreSQL CPU. EXPLAIN
ANALYZE/BUFFERS runs separately and its server timing is not end-to-end latency.

With 15 samples, nearest-rank p95 is the maximum sample and is descriptive only.
Cold caches, remote RTT, competing requests, skewed/empty relationships,
per-parent limits and arbitrary production graph shapes need separate runs.
The benchmark is a local comparison, not a universal speed guarantee.

## Reports and CPU profiles

`python benchmarks/report.py` uses matplotlib to regenerate the current report,
comparison charts and packaged documentation chart. Running Node measurements
needs no Python dependency. Source results are in benchmarks/results/; the npm
package includes the performance guide and its chart.

```sh
DATABASE_URL=... pnpm run bench:profile
```

The profiler samples four graph executions after warmup and writes
`results/profiles/single-query.cpuprofile` and a JSON summary of approximate
sampled self time. The archive also contains earlier profiles.
