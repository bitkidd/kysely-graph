import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import { availableParallelism, cpus } from 'node:os';
import { performance } from 'node:perf_hooks';

import { Kysely, type KyselyPlugin, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import { applicationBenchmark, seedApplication } from './application.js';
import { type DB, graphMethod } from './model.js';
import { seed } from './seed.js';
import { sharedPoolBenchmark } from './shared-pool.js';

const url = process.env.DATABASE_URL;
if (!url)
  throw new Error(
    'Set DATABASE_URL to a PostgreSQL database where a temporary benchmark schema may be created',
  );
const application = process.env.BENCH_APPLICATION === '1';
const tuneFlat = process.env.BENCH_FLAT_GRID === '1';
const loadFlat = process.env.BENCH_SHARED_POOL === '1';
if ([application, tuneFlat, loadFlat].filter(Boolean).length > 1)
  throw new Error('Choose one benchmark mode');
const samples = Number(process.env.BENCH_SAMPLES ?? (application ? 48 : 15));
const warmups = Number(process.env.BENCH_WARMUPS ?? (application ? 12 : 3));
const largest = Number(process.env.BENCH_ROOTS ?? 2000);
for (const [key, value] of Object.entries({ samples, warmups, largest })) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${key} must be a positive integer`);
}
if (application && largest < 200) throw new Error('Application mode needs at least 200 users');
const schema = `krl_bench_${process.pid}_${Date.now()}`;
const admin = new Pool({ connectionString: url, max: 1 });
const pool = new Pool({
  connectionString: url,
  max: 10,
  options: `-c search_path=${schema} -c jit=off -c statement_timeout=120000`,
});
let queries = 0;
let profile = false;
let logicalBytes = 0;
let resultRows = 0;
const plugin: KyselyPlugin = {
  transformQuery: (args) => args.node,
  async transformResult(args) {
    if (profile) {
      logicalBytes += Buffer.byteLength(JSON.stringify(args.result.rows));
      resultRows += args.result.rows.length;
    }
    return args.result;
  },
};
const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
  plugins: [plugin],
  log: (event) => {
    if (event.level === 'query') queries++;
  },
});
const scenarios = [
  { name: 'shallow-100', roots: Math.min(100, largest), depth: 1 as const },
  { name: 'deep-100', roots: Math.min(100, largest), depth: 4 as const },
  { name: 'deep-500', roots: Math.min(500, largest), depth: 4 as const },
  { name: `deep-${largest}`, roots: largest, depth: 4 as const },
].filter(
  (s, i, all) => all.findIndex((other) => other.roots === s.roots && other.depth === s.depth) === i,
);
const flatDefault = { chunkSize: 500, concurrency: 4 };
const flatGrid = [flatDefault];
for (const chunkSize of [250, 500, 1000, 2000]) {
  for (const concurrency of [2, 4, 8]) {
    if (chunkSize !== flatDefault.chunkSize || concurrency !== flatDefault.concurrency) {
      flatGrid.push({ chunkSize, concurrency });
    }
  }
}
const methods = tuneFlat
  ? flatGrid.map((config) => ({
      name: `flat-${config.chunkSize}-c${config.concurrency}`,
      run: graphMethod(db, config === flatDefault ? undefined : config),
      config,
    }))
  : [
      { name: 'single', run: graphMethod(db, { strategy: 'single' }) },
      { name: 'flat', run: graphMethod(db) },
    ];
const results: Record<string, unknown>[] = [];
const quantile = (values: number[], q: number) =>
  values[Math.max(0, Math.ceil(values.length * q) - 1)]!;

async function installedVersion(name: string): Promise<string> {
  const manifest = findPackageJSON(name, import.meta.url);
  if (!manifest) throw new Error(`Cannot find the installed ${name} package`);
  const { version } = JSON.parse(await readFile(manifest, 'utf8')) as { version: string };
  return version;
}

let created = false;
try {
  await admin.query(`create schema "${schema}"`);
  created = true;
  console.log(`Seeding ${largest} roots in isolated schema ${schema} ...`);
  await seed(pool, largest);
  if (application) await seedApplication(pool, largest);
  // Open every pooled connection before measurement so connection setup is excluded.
  const connections = await Promise.all(Array.from({ length: 10 }, () => pool.connect()));
  for (const client of connections) {
    await client.query('select 1');
    client.release();
  }
  const { version, local_socket: localSocket } = (
    await pool.query<{ version: string; local_socket: boolean }>(
      'select version(), inet_client_addr() is null as local_socket',
    )
  ).rows[0]!;
  const transport = localSocket ? 'Unix socket' : 'TCP';
  const [kyselyVersion, pgVersion] = await Promise.all([
    installedVersion('kysely'),
    installedVersion('pg'),
  ]);
  const settings = (
    await pool.query(
      "select name,setting,unit from pg_settings where name in ('shared_buffers','work_mem','jit','max_parallel_workers_per_gather') order by name",
    )
  ).rows;
  const runSharedPool = loadFlat
    ? sharedPoolBenchmark(pool, graphMethod(db), () => queries, samples, warmups)
    : undefined;
  if (application) {
    results.push(
      ...(await applicationBenchmark(
        pool,
        db,
        largest,
        () => queries,
        samples,
        warmups,
        flatDefault.concurrency,
      )),
    );
  }
  for (const scenario of application ? [] : scenarios) {
    console.log(`\n${scenario.name}: depth ${scenario.depth}, ${scenario.roots} roots`);
    if (runSharedPool) {
      results.push(...(await runSharedPool(scenario)));
      continue;
    }
    let reference: unknown[] | undefined;
    let outputBytes = 0;
    const profiles: Record<
      string,
      { queries: number; logicalResultBytes: number; databaseResultRows: number }
    > = {};
    // Equality, serialization and transfer-volume instrumentation are outside timers.
    for (const method of methods) {
      profile = true;
      queries = 0;
      logicalBytes = 0;
      resultRows = 0;
      const result = await method.run(scenario.roots, scenario.depth);
      if (reference)
        assert.deepStrictEqual(
          result,
          reference,
          `${scenario.name}: ${method.name} result differs`,
        );
      else {
        reference = result;
        outputBytes = Buffer.byteLength(JSON.stringify(result));
      }
      profiles[method.name] = {
        queries,
        logicalResultBytes: logicalBytes,
        databaseResultRows: resultRows,
      };
      profile = false;
    }
    reference = undefined;
    for (let round = 0; round < warmups; round++)
      for (const method of methods) await method.run(scenario.roots, scenario.depth);
    const durations = new Map(methods.map((m) => [m.name, [] as number[]]));
    const cpu = new Map(methods.map((m) => [m.name, [] as number[]]));
    // Rotate which configuration runs first to reduce ordering bias.
    for (let round = 0; round < samples; round++) {
      const offset = round % methods.length;
      const order = [...methods.slice(offset), ...methods.slice(0, offset)];
      for (const method of order) {
        global.gc?.();
        queries = 0;
        const cpuStart = process.cpuUsage();
        const start = performance.now();
        const result = await method.run(scenario.roots, scenario.depth);
        const elapsed = performance.now() - start;
        const consumed = process.cpuUsage(cpuStart);
        assert.equal(result.length, scenario.roots);
        assert.equal(
          queries,
          profiles[method.name]!.queries,
          'Query count changed between samples',
        );
        durations.get(method.name)!.push(elapsed);
        cpu.get(method.name)!.push((consumed.user + consumed.system) / 1000);
      }
      if ((round + 1) % 5 === 0) console.log(`  completed ${round + 1}/${samples} sample rounds`);
    }
    for (const method of methods) {
      const times = durations.get(method.name)!.sort((a, b) => a - b);
      const cpuTimes = cpu.get(method.name)!.sort((a, b) => a - b);
      const result = {
        scenario: scenario.name,
        roots: scenario.roots,
        depth: scenario.depth,
        objects: scenario.roots * (scenario.depth === 1 ? 6 : 130),
        method: method.name,
        ...('config' in method ? method.config : {}),
        medianMs: quantile(times, 0.5),
        p95Ms: quantile(times, 0.95),
        minMs: times[0],
        maxMs: times.at(-1),
        medianNodeCpuMs: quantile(cpuTimes, 0.5),
        outputBytes,
        ...profiles[method.name],
        samplesMs: times,
        samplesNodeCpuMs: cpuTimes,
      };
      results.push(result);
      console.log(
        `  ${method.name.padEnd(8)} median ${result.medianMs.toFixed(1)} ms; p95 ${result.p95Ms.toFixed(1)} ms; Node CPU ${result.medianNodeCpuMs.toFixed(1)} ms; ${result.queries} queries`,
      );
    }
  }
  const output = {
    metadata: {
      createdAt: new Date().toISOString(),
      node: process.version,
      postgres: version,
      kysely: kyselyVersion,
      pg: pgVersion,
      transport,
      cpu: cpus()[0]?.model,
      availableCPUs: availableParallelism(),
      poolMax: 10,
      samples,
      warmups,
      forcedGC: !application && typeof global.gc === 'function',
      seedRoots: largest,
      ...(tuneFlat || loadFlat || application ? { flatDefault } : {}),
      settings,
      ...(application
        ? {
            scope: `Warm-cache bursts of projected, paginated application queries on synthetic data, ${transport}. Each strategy reuses one graph instance and the same pool. Wave CPU is averaged per request and excludes PostgreSQL CPU. Final JSON serialization is outside the measurement.`,
          }
        : {
            branches: {
              posts: 4,
              commentsPerPost: 4,
              repliesPerComment: 2,
              reactionsPerReply: 2,
              tagsPerPost: 3,
            },
            scope: loadFlat
              ? `Warm-cache bursts sharing one flat graph instance and pool, ${transport}. Request latency includes waiting for graph query slots. Wave CPU is averaged per request and excludes PostgreSQL CPU. Final JSON serialization is outside the measurement.`
              : `Warm-cache, one request at a time, ${transport}. Timings include root rows and exclude final JSON serialization. Logical result bytes measure the JSON size of database result rows. Node CPU excludes PostgreSQL CPU.`,
          }),
    },
    results,
  };
  await mkdir('benchmarks/results', { recursive: true });
  const outputPath = application
    ? 'benchmarks/results/application.json'
    : loadFlat
      ? 'benchmarks/results/flat-shared-pool.json'
      : tuneFlat
        ? 'benchmarks/results/flat-tuning.json'
        : 'benchmarks/results/latest.json';
  await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
  console.log(`\nSaved ${outputPath}`);
} finally {
  await pool.end();
  if (created) await admin.query(`drop schema "${schema}" cascade`);
  await admin.end();
}
