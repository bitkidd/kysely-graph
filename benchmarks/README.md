# PostgreSQL graph benchmark

Run from a source checkout using PostgreSQL and pg.Pool:

```sh
DATABASE_URL=postgres://user:password@localhost:5432/database BENCH_APPLICATION=1 pnpm run bench
python benchmarks/report.py --application
```

Each run creates and removes an isolated `krl_bench_<pid>_<timestamp>` schema.
The role needs schema creation privileges. Application/test tables are not reset.
A killed process can leave its isolated schema behind.

## Compared methods

- `single` uses `strategy: 'single'`.
- `flat` uses the default strategy with raw driver decoding, up to 500 distinct
  parent keys per batch, and four concurrent statements.

Both strategies return the same fields, root order, array order, and nested graph.
Full deep equality is checked outside timing. Measurements include the root query
and use the package's ordinary query builders.

## Application workloads

The [application report](results/APPLICATION.md) compares both strategies for a
paginated user directory, a post feed with per-post comment limits, and a
popular-post detail view with nested replies and filtered reactions. The
synthetic fixture has 2,000 users by default, including users without profiles
and eight posts with heavier comment activity. Queries project the fields the
views need. The eight input pages or post IDs vary across waves.

Each strategy uses one graph instance with four shared statement slots and the
same warm ten-connection pool.
Each case runs 12 warmup waves and 48 measured waves of one, four, or eight
simultaneous requests. Node runs with natural garbage collection. The report
shows median and p95 request latency, Node CPU per request, wave throughput,
and peak connections. The [raw waves](results/application.json) include response
sizes and query counts measured separately from timing.

Set `BENCH_ROOTS` (minimum 200 users), `BENCH_SAMPLES`, or `BENCH_WARMUPS` to
change the application run. The workloads model bursts against a warm local
database using synthetic fixtures.

## Synthetic stress workloads

```sh
DATABASE_URL=postgres://user:password@localhost:5432/database pnpm run bench
python benchmarks/report.py --no-chart
```

The [stress report](results/RESULTS.md) compares both strategies on graphs with
up to 2,000 users and 260,000 object occurrences.

Historical code snapshots and measurements are stored under `baseline/`,
`batched/`, and `results/`. The [strategy experiments](results/strategy-experiments.json)
include the per-row JSON and hybrid variants. The [archived SQL plans](results/plans.json)
cover the earlier handwritten baselines.

The [flat assembly comparison](results/flat-optimization.json) interleaves the
original and optimized loaders with the single strategy. The [row encoding
comparison](results/flat-row-json-experiment.json) runs the optimized assembler
with raw driver decoding and with one PostgreSQL JSON payload per child row.

## Flat tuning grid

Run the same workloads with 250, 500, 1,000, and 2,000 keys per batch and two,
four, and eight concurrent statements. The grid measures the library defaults
at 500 keys and four statements as its reference.

```sh
DATABASE_URL=postgres://user:password@localhost:5432/database BENCH_FLAT_GRID=1 pnpm run bench
python benchmarks/report.py --flat-grid
```

The [tuning report](results/FLAT-TUNING.md) compares latency, Node.js CPU, and
statement counts for each configuration. The regular benchmark results are
stored separately.

## Requests sharing a pool

Run the same workloads in waves of one, two, four, and eight simultaneous
requests. All requests reuse one graph instance with the flat defaults of 500
keys per batch and four shared query slots. The pool holds ten connections.

```sh
DATABASE_URL=postgres://user:password@localhost:5432/database BENCH_SHARED_POOL=1 pnpm run bench
python benchmarks/report.py --shared-pool
```

The [shared-pool report](results/FLAT-SHARED-POOL.md) records request latency,
throughput within a wave, and peak connections in use. Node.js CPU is measured
for each whole wave and divided by the number of requests. These runs model
bursts of requests on a warm local database.

## Stress workload and measurement

Each user has one profile and four posts. Deep graphs add four comments per post,
two replies per comment, two reactions per reply and three tags per post. Tags are
shared among 32 targets. All mappings are indexed and tables are analyzed. The
root/post payload is padded by 128 characters, comment bodies by 96 and replies
by 64. Every relation is populated with uniform fan-out.

Scenarios use 100 roots at depth one, then 100, 500 and 2,000 roots at depth four.
The largest graph has 260,000 object occurrences. Configure `BENCH_ROOTS`,
`BENCH_SAMPLES` (default 15) and `BENCH_WARMUPS` (default 3) to adjust the run.

The database is warm, with all ten pool connections opened ahead of time and JIT
disabled uniformly. The report records the PostgreSQL version and transport.
The strategies alternate order between measured rounds. Timing includes query construction, PostgreSQL work,
transfer and pg decoding. It excludes seeding, equality checks,
explicit pre-sample GC and final HTTP JSON serialization.

Counters must match in each sample. Logical result bytes are estimated by
JSON-stringifying database result rows outside measured runs, not by capturing
PostgreSQL protocol traffic. Node CPU excludes PostgreSQL CPU.

With 15 samples, nearest-rank p95 is the maximum sample and is descriptive only.
These stress runs use a uniform fixture on a warm local database.

## Reports and CPU profiles

`python benchmarks/report.py` uses matplotlib to regenerate the current report,
comparison charts and packaged documentation chart. Running Node measurements
and writing the tables with `--no-chart` need no extra Python packages. Source results are in benchmarks/results/; the npm
package includes the performance guide and its chart.

```sh
DATABASE_URL=... pnpm run bench:profile
```

The profiler samples four graph executions after warmup and writes
`results/profiles/single-query.cpuprofile` and a JSON summary of approximate
sampled self time. The archive also contains earlier profiles.
