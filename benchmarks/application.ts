import assert from 'node:assert/strict';

import type { Kysely } from 'kysely';
import type { Pool } from 'pg';

import { createGraph, type RelationQuery } from '../src/index.js';
import { type DB, relations } from './model.js';
import { summarizeWaves, type Wave, waveSampler } from './shared-pool.js';

const requestCounts = [1, 4, 8];
const inputCount = Math.max(...requestCounts);
const pageSize = 25;
const feedSize = 20;

export async function seedApplication(pool: Pool, users: number) {
  await pool.query('delete from profiles where id % 5 = 0');
  // Concentrate comments on the eight newest posts, leaving other posts with few or no comments.
  await pool.query('update comments set post_id = $1 - (id % 8) where id <= 512', [users * 4]);
  await pool.query("update reactions set kind = 'bookmark' where id % 3 = 0");
  for (const table of ['profiles', 'comments', 'reactions']) await pool.query(`analyze ${table}`);
}

function workloads(db: Kysely<DB>, users: number, method: 'flat' | 'single') {
  const graph = createGraph(
    db,
    relations,
    method === 'single' ? { strategy: 'single' } : undefined,
  );
  const newestPost = users * 4;
  const postRelations = {
    author: { select: ['id', 'name'] },
    tags: { select: ['id', 'label'], query: (qb: RelationQuery<DB, 'tags'>) => qb.orderBy('id') },
  } as const;
  return [
    {
      name: 'User directory',
      description: '25 users with an optional profile, paginated by user ID.',
      roots: pageSize,
      run: (index: number) =>
        graph
          .query({
            table: 'users',
            select: ['id', 'name'],
            with: { profile: { select: ['bio'] } },
          })
          .where('id', '>', index * pageSize)
          .orderBy('id')
          .limit(pageSize)
          .execute(),
    },
    {
      name: 'Post feed',
      description: '20 posts, each with its author, tags, and up to two newest comments.',
      roots: feedSize,
      run: (index: number) =>
        graph
          .query({
            table: 'posts',
            select: ['id', 'title'],
            with: {
              ...postRelations,
              comments: {
                select: ['id', 'body'],
                query: (qb) => qb.orderBy('id', 'desc').limit(2),
              },
            },
          })
          .where('id', '<=', newestPost - index * feedSize)
          .orderBy('id', 'desc')
          .limit(feedSize)
          .execute(),
    },
    {
      name: 'Post detail',
      description:
        'One popular post with its author, tags, 20 newest comments, up to two replies each, and likes.',
      roots: 1,
      run: (index: number) =>
        graph
          .query({
            table: 'posts',
            select: ['id', 'title'],
            with: {
              ...postRelations,
              comments: {
                select: ['id', 'body'],
                query: (qb) => qb.orderBy('id', 'desc').limit(20),
                with: {
                  replies: {
                    select: ['id', 'body'],
                    query: (qb) => qb.orderBy('id', 'desc').limit(2),
                    with: {
                      reactions: {
                        select: ['id', 'kind'],
                        query: (qb) => qb.where('kind', '=', 'like').orderBy('id'),
                      },
                    },
                  },
                },
              },
            },
          })
          .where('id', '=', newestPost - index)
          .execute(),
    },
  ];
}

export async function applicationBenchmark(
  pool: Pool,
  db: Kysely<DB>,
  users: number,
  queryCount: () => number,
  samples: number,
  warmups: number,
  concurrency: number,
) {
  const measure = waveSampler(pool);
  const flatWorkloads = workloads(db, users, 'flat');
  const singleWorkloads = workloads(db, users, 'single');
  const results = [];
  for (const [index, flat] of flatWorkloads.entries()) {
    console.log(`\n${flat.name}`);
    const single = singleWorkloads[index]!;
    const outputBytes = [];
    const queryCounts = { flat: [] as number[], single: [] as number[] };
    for (let input = 0; input < inputCount; input++) {
      const startQueries = queryCount();
      const expected = await single.run(input);
      const flatStartQueries = queryCount();
      const actual = await flat.run(input);
      queryCounts.single.push(flatStartQueries - startQueries);
      queryCounts.flat.push(queryCount() - flatStartQueries);
      assert.equal(actual.length, flat.roots);
      assert.deepStrictEqual(actual, expected, `${flat.name}, input ${input}`);
      outputBytes.push(Buffer.byteLength(JSON.stringify(actual)));
    }

    const cases = requestCounts.flatMap((requests) =>
      (['flat', 'single'] as const).map((method) => ({ requests, method, waves: [] as Wave[] })),
    );
    for (let round = -warmups; round < samples; round++) {
      const offset = (round + warmups) % cases.length;
      for (const { requests, method, waves } of [
        ...cases.slice(offset),
        ...cases.slice(0, offset),
      ]) {
        const run = method === 'flat' ? flat.run : single.run;
        const inputs = Array.from(
          { length: requests },
          (_, slot) => (round + warmups + slot) % inputCount,
        );
        const expectedQueries = inputs.reduce((sum, input) => sum + queryCounts[method][input]!, 0);
        const startQueries = queryCount();
        const wave = await measure(requests, (slot) => run(inputs[slot]!), flat.roots);
        assert.equal(queryCount() - startQueries, expectedQueries);
        if (method === 'flat') assert.ok(wave.peakConnections <= concurrency);
        if (round >= 0) waves.push(wave);
      }
    }
    for (const { requests, method, waves } of cases) {
      const summary = summarizeWaves(waves, requests);
      results.push({
        scenario: flat.name,
        description: flat.description,
        roots: flat.roots,
        method,
        requests,
        outputBytes,
        queryCounts: queryCounts[method],
        ...summary,
        waves,
      });
      console.log(
        `  ${method} x${requests}: median ${summary.medianMs.toFixed(2)} ms, p95 ${summary.p95Ms.toFixed(2)} ms, Node CPU ${summary.medianNodeCpuMsPerRequest.toFixed(2)} ms/request`,
      );
    }
  }
  return results;
}
