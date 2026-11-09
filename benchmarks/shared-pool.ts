import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import type { Pool } from 'pg';

import type { graphMethod } from './model.js';

const requestCounts = [1, 2, 4, 8];

function percentile(values: readonly number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

export function waveSampler(pool: Pool) {
  let checkedOut = 0;
  let peakCheckedOut = 0;
  pool.on('acquire', () => {
    checkedOut++;
    peakCheckedOut = Math.max(peakCheckedOut, checkedOut);
  });
  pool.on('release', () => checkedOut--);

  return async (requests: number, run: (index: number) => Promise<unknown[]>, roots: number) => {
    peakCheckedOut = 0;
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    const requestMs = await Promise.all(
      Array.from({ length: requests }, async (_, index) => {
        const requestStart = performance.now();
        const result = await run(index);
        const elapsed = performance.now() - requestStart;
        assert.equal(result.length, roots);
        return elapsed;
      }),
    );
    const elapsedMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    assert.equal(checkedOut, 0);
    return {
      requestMs,
      elapsedMs,
      nodeCpuMs: (cpu.user + cpu.system) / 1000,
      peakConnections: peakCheckedOut,
    };
  };
}

export type Wave = Awaited<ReturnType<ReturnType<typeof waveSampler>>>;

export function summarizeWaves(waves: Wave[], requests: number) {
  const latencies = waves.flatMap(({ requestMs }) => requestMs);
  const medianWaveMs = percentile(
    waves.map(({ elapsedMs }) => elapsedMs),
    0.5,
  );
  return {
    medianMs: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    medianNodeCpuMsPerRequest:
      percentile(
        waves.map(({ nodeCpuMs }) => nodeCpuMs),
        0.5,
      ) / requests,
    medianWaveMs,
    requestsPerSecond: (requests * 1000) / medianWaveMs,
    peakConnections: Math.max(...waves.map((wave) => wave.peakConnections)),
  };
}

export function sharedPoolBenchmark(
  pool: Pool,
  run: ReturnType<typeof graphMethod>,
  queryCount: () => number,
  samples: number,
  warmups: number,
) {
  const measure = waveSampler(pool);
  return async (scenario: { name: string; roots: number; depth: 1 | 4 }) => {
    const { name, roots, depth } = scenario;
    const startQueries = queryCount();
    let reference: unknown[] | undefined = await run(roots, depth);
    const queriesPerRequest = queryCount() - startQueries;
    for (const requests of requestCounts) {
      const queries = queryCount();
      await Promise.all(
        Array.from({ length: requests }, async () => {
          assert.deepStrictEqual(await run(roots, depth), reference);
        }),
      );
      assert.equal(queryCount() - queries, requests * queriesPerRequest);
    }
    reference = undefined;

    async function wave(requests: number) {
      const queries = queryCount();
      const result = await measure(requests, () => run(roots, depth), roots);
      assert.equal(queryCount() - queries, requests * queriesPerRequest);
      assert.ok(result.peakConnections <= 4, 'Requests exceeded the shared default query limit');
      return result;
    }

    for (let i = 0; i < warmups; i++) {
      for (const requests of requestCounts) await wave(requests);
    }
    const measurements = new Map(requestCounts.map((count) => [count, [] as Wave[]]));
    for (let round = 0; round < samples; round++) {
      const offset = round % requestCounts.length;
      for (const requests of [...requestCounts.slice(offset), ...requestCounts.slice(0, offset)]) {
        global.gc?.();
        measurements.get(requests)!.push(await wave(requests));
      }
      if ((round + 1) % 5 === 0) console.log(`  completed ${round + 1}/${samples} sample rounds`);
    }

    return requestCounts.map((requests) => {
      const waves = measurements.get(requests)!;
      const summary = summarizeWaves(waves, requests);
      const { medianMs, p95Ms, medianNodeCpuMsPerRequest, requestsPerSecond, peakConnections } =
        summary;
      console.log(
        `  ${requests} requests: median ${medianMs.toFixed(1)} ms, p95 ${p95Ms.toFixed(1)} ms, Node CPU ${medianNodeCpuMsPerRequest.toFixed(1)} ms/request, ${requestsPerSecond.toFixed(1)} requests/s, peak ${peakConnections} connections`,
      );
      return {
        scenario: name,
        roots,
        depth,
        requests,
        queriesPerRequest,
        ...summary,
        waves,
      };
    });
  };
}
