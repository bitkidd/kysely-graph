import { mkdir, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import { type DB, graphMethod } from './model.js';
import { seed } from './seed.js';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL');
const schema = `krl_profile_${process.pid}_${Date.now()}`;
const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  options: `-c search_path=${schema} -c jit=off`,
});
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
let created = false;
try {
  await admin.query(`create schema "${schema}"`);
  created = true;
  await seed(pool, 2000);
  const name = 'single-query';
  const run = graphMethod(db);
  await mkdir('benchmarks/results/profiles', { recursive: true });
  for (let i = 0; i < 2; i++) await run(2000, 4);
  global.gc?.();
  const session = new Session();
  session.connect();
  try {
    await session.post('Profiler.enable');
    await session.post('Profiler.start');
    for (let i = 0; i < 4; i++) await run(2000, 4);
    const { profile } = await session.post('Profiler.stop');
    await writeFile(`benchmarks/results/profiles/${name}.cpuprofile`, JSON.stringify(profile));
    const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
    const totals = new Map<string, number>();
    for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
      const frame = nodes.get(profile.samples![i]!)!.callFrame;
      const label = `${frame.functionName || '(anonymous)'} @ ${frame.url.split('/').slice(-2).join('/')}:${frame.lineNumber + 1}`;
      totals.set(label, (totals.get(label) ?? 0) + (profile.timeDeltas?.[i] ?? 0) / 1000);
    }
    const top = [...totals]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([frame, ms]) => ({ frame, sampledSelfMs: Math.round(ms) }));
    await writeFile(
      `benchmarks/results/profiles/${name}-summary.json`,
      JSON.stringify(top, null, 2) + '\n',
    );
    console.log(name, top.slice(0, 15));
  } finally {
    session.disconnect();
  }
} finally {
  await pool.end();
  if (created) await admin.query(`drop schema "${schema}" cascade`);
  await admin.end();
}
