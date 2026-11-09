import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { sql } from 'kysely';

import {
  createGraph,
  defineGraph,
  type GraphDiagnostic,
  GraphError,
  type RelationQuery,
} from '../src/index.js';
import { type DB, fixture, relations } from './fixture.js';
let f: Awaited<ReturnType<typeof fixture>>;
before(async () => {
  f = await fixture();
});
after(async () => {
  await f?.db.destroy();
});
test('all relation kinds and computed root columns load in batches', async () => {
  f.queries.length = 0;
  const result = await createGraph(f.db, relations)
    .query({
      table: 'users',
      select: ['id'],
      with: {
        profile: true,
        posts: {
          query: (qb) => qb.orderBy('id'),
          with: { author: true, comments: true, tags: true },
        },
      },
    })
    .select(sql<string>`'retained'`.as('computed'))
    .orderBy('users.id')
    .execute();

  assert.equal(f.queries.length, 6);
  assert.ok(
    f.queries.every((query) => !/\b(?:row_to_json|jsonb?_(?:agg|build_object))\s*\(/i.test(query)),
  );
  assert.equal(result[0]!.computed, 'retained');
  assert.equal(result[0]!.profile?.bio, 'Hello');
  assert.equal(result[1]!.profile, null);
  assert.deepEqual(result[2]!.posts, []);
  assert.equal(result[0]!.posts[0]!.author?.name, 'Ada');
  assert.equal(result[0]!.posts[0]!.comments.length, 1);
  assert.deepEqual(result[0]!.posts[0]!.tags.map((t) => t.id).sort(), [1, 2, 3]);
  assert.deepEqual(Object.keys(result[0]!.posts[0]!.tags[0]!).sort(), ['id', 'label']);
});

test('computed arguments bind independently in root and nested selections', async () => {
  const definitions = defineGraph<DB>()(({ computed }) => ({
    posts: {
      commentsCount: computed('posts', (eb, { approved }: { approved: boolean }) =>
        eb
          .selectFrom('comments')
          .whereRef('comments.postId', '=', 'posts.id')
          .where('comments.approved', '=', approved)
          .select(({ cast, fn }) => cast<number>(fn.countAll(), 'integer').as('count'))
          .$asScalar(),
      ),
      recent: computed('posts', (eb, { since = 3 }: { since?: number }) =>
        eb('posts.createdAt', '>=', since),
      ),
    },
  }));
  const diagnostics: GraphDiagnostic[] = [];
  const graph = createGraph(f.db, [relations, definitions], {
    onDiagnostic: (event) => {
      diagnostics.push(event);
    },
  });
  f.queries.length = 0;
  const root = graph
    .query({
      table: 'posts',
      select: ['id'],
      with: { commentsCount: { args: { approved: true } }, recent: true },
    })
    .where('posts.id', 'in', [10, 11, 12])
    .orderBy('posts.id');
  assert.deepEqual(await root.execute(), [
    { id: 10, commentsCount: 1, recent: true },
    { id: 11, commentsCount: 0, recent: true },
    { id: 12, commentsCount: 0, recent: true },
  ]);
  assert.equal(f.queries.length, 1);

  f.queries.length = 0;
  const nested = graph
    .query({
      table: 'users',
      select: [],
      with: {
        posts: {
          select: [],
          query: (qb) => qb.orderBy('posts.id').limit(2),
          with: {
            commentsCount: { args: { approved: false } },
            recent: { args: { since: 4 } },
          },
        },
      },
    })
    .where('users.id', '=', 1);
  assert.deepEqual(await nested.executeTakeFirstOrThrow(), {
    posts: [
      { commentsCount: 0, recent: false },
      { commentsCount: 1, recent: false },
    ],
  });
  assert.equal(f.queries.length, 2);
  assert.deepEqual(
    diagnostics.flatMap((event) => (event.type === 'query' ? [event.relationPaths] : [])),
    [[], [], [['users', 'posts']]],
  );

  assert.throws(
    () => graph.query({ table: 'posts', with: JSON.parse('{"commentsCount":{"args":[]}}') }),
    /Computed field posts.commentsCount requires true or an \{ args \} object/,
  );
  assert.throws(
    () => createGraph(f.db, [definitions, definitions]),
    /Duplicate field posts.commentsCount/,
  );
});

test('nested computed fields support long field names', async () => {
  const longName = 'computed_timestamp_'.repeat(5);
  const definitions = defineGraph<DB>()(({ computed }) => ({
    posts: {
      [longName]: computed('posts', (eb) => eb.ref('posts.id')),
    },
  }));
  const row = await createGraph(f.db, [relations, definitions])
    .query({
      table: 'users',
      select: [],
      with: {
        posts: {
          select: [],
          query: (qb) => qb.limit(1),
          with: { [longName]: true },
        },
      },
    })
    .where('users.id', '=', 1)
    .executeTakeFirstOrThrow();
  assert.deepEqual(row, { posts: [{ [longName]: 10 }] });
});

test('a null foreign key yields a null to-one relation', async () => {
  const post = await createGraph(f.db, relations)
    .query({ table: 'posts', select: ['id'], with: { author: true } })
    .where('id', '=', 30)
    .executeTakeFirstOrThrow();

  assert.deepEqual(post, { id: 30, author: null });
});

test('nested filtering and correlated EXISTS keep root rows', async () => {
  const graph = createGraph(f.db, relations);
  const result = await graph
    .query({
      table: 'users',
      with: {
        posts: {
          query: (qb) =>
            qb
              .where('published', '=', true)
              .where(({ exists, selectFrom }) =>
                exists(
                  selectFrom('comments')
                    .select('comments.id')
                    .whereRef('comments.postId', '=', 'posts.id')
                    .where('comments.approved', '=', true),
                ),
              )
              .orderBy('createdAt', 'desc'),
          with: { comments: { query: (qb) => qb.where('approved', '=', true) } },
        },
      },
    })
    .where('users.id', 'in', [1, 2, 3])
    .orderBy('users.id')
    .execute();
  assert.deepEqual(
    result.map((u) => u.posts.map((p) => p.id)),
    [[10], [20], []],
  );
});

test('per-parent limits rank after filters with stable tie-breakers', async () => {
  const graph = createGraph(f.db, relations);
  f.queries.length = 0;
  const result = await graph
    .query({
      table: 'users',
      with: {
        posts: {
          query: (qb) => qb.where('published', '=', true).orderBy('createdAt', 'desc').limit(1),
          with: { comments: true },
        },
      },
    })
    .where('users.id', 'in', [1, 2, 3])
    .orderBy('users.id')
    .execute();
  assert.deepEqual(
    result.map((u) => u.posts.map((p) => p.id)),
    [[10], [20], []],
  );
  assert.equal(f.queries.length, 3);
  assert.match(f.queries[1]!, /limit/);
});

test('many-to-many query/through filters, deduplication and limits', async () => {
  const graph = createGraph(f.db, relations);
  const result = await graph
    .query({
      table: 'posts',
      with: {
        tags: {
          through: (qb) => qb.where('visible', '=', true),
          query: (qb) => qb.where('label', '!=', 'web').orderBy('id', 'asc').limit(2),
        },
      },
    })
    .where('posts.id', 'in', [10, 20, 30])
    .orderBy('posts.id')
    .execute();
  assert.deepEqual(
    result.map((p) => p.tags.map((t) => t.id)),
    [[1, 2], [2], []],
  );
  const limit = await graph
    .query({
      table: 'posts',
      with: { tags: { query: (qb) => qb.orderBy('id', 'desc').limit(1) } },
    })
    .where('posts.id', 'in', [10, 20])
    .orderBy('posts.id')
    .execute();
  assert.deepEqual(
    limit.map((p) => p.tags.map((t) => t.id)),
    [[3], [3]],
  );
  assert.ok(
    limit.every((p) =>
      p.tags.every((t) => !Object.keys(t).some((k) => k.startsWith('krlinternal'))),
    ),
  );
});

test('dedup happens before ranking so duplicate links do not consume slots', async () => {
  const result = await createGraph(f.db, relations)
    .query({
      table: 'posts',
      with: { tags: { query: (qb) => qb.limit(2) } },
    })
    .where('posts.id', '=', 10)
    .executeTakeFirstOrThrow();
  assert.deepEqual(
    result.tags.map((t) => t.id),
    [1, 2],
  );
});

test('batched loading preserves independent duplicate-parent graphs', async () => {
  const graph = createGraph(f.db, relations);
  f.queries.length = 0;
  const result = await graph
    .query({
      table: 'users',
      with: { posts: { with: { tags: true } } },
    })
    .innerJoin('posts as copies', 'copies.authorId', 'users.id')
    .where('users.id', '=', 1)
    .where('copies.id', 'in', [10, 11])
    .orderBy('copies.id')
    .execute();
  assert.equal(f.queries.length, 3);
  assert.notEqual(result[0]!.posts, result[1]!.posts);
  assert.notEqual(result[0]!.posts[0], result[1]!.posts[0]);
  assert.notEqual(result[0]!.posts[0]!.tags[0], result[1]!.posts[0]!.tags[0]);
});

test('composite keys and custom primary keys keep distinct parents', async () => {
  const graph = createGraph(f.db, relations);
  f.queries.length = 0;
  const result = await graph
    .query({
      table: 'tenants',
      with: {
        items: {
          query: (qb) => qb.orderBy('score', 'desc').limit(1),
          with: { parent: true },
        },
        tags: true,
      },
    })
    .orderBy('title')
    .execute();
  assert.deepEqual(
    result.map((p) => p.items.map((i) => i.itemCode)),
    [[1], [3]],
  );
  assert.deepEqual(
    result.map((p) => p.tags.map((t) => t.id)),
    [[1], [2]],
  );
  assert.equal(result[0]!.items[0]!.parent?.title, 'one');
  assert.equal(f.queries.length, 4);
});

test('callback OR conditions cannot escape parent-key restrictions', async () => {
  const result = await createGraph(f.db, relations)
    .query({
      table: 'users',
      with: {
        posts: {
          query: (qb) =>
            qb.where(({ or, eb }) => or([eb('title', '=', 'Orphan'), eb('published', '=', true)])),
        },
      },
    })
    .where('users.id', 'in', [1, 2])
    .orderBy('users.id')
    .execute();
  assert.deepEqual(
    result.map((p) => p.posts.map((t) => t.id).sort()),
    [
      [10, 11],
      [20, 21],
    ],
  );
});

test('merged schemas preserve sibling and nested relations and their definition predicates', async () => {
  const users = defineGraph<DB>()(({ hasMany }) => ({
    users: {
      publishedPosts: hasMany('posts', {
        foreignKey: 'authorId',
        query: (qb) => qb.where(sql<boolean>`published = ${true} or title = ${'Preview'}`),
      }),
    },
  }));
  const profiles = defineGraph<DB>()(({ hasOne }) => ({
    users: {
      profile: hasOne('profiles', {
        foreignKey: 'userId',
        query: (qb) => qb.where('bio', '!=', 'Hello'),
      }),
    },
  }));
  const posts = defineGraph<DB>()(({ belongsTo }) => ({
    posts: {
      inactiveAuthor: belongsTo('users', {
        foreignKey: 'authorId',
        query: (qb) => qb.where('active', '=', false),
      }),
    },
  }));
  const rows = await createGraph(f.db, [users, profiles, posts], { maxParameters: 100 })
    .query({
      table: 'users',
      select: ['id'],
      with: {
        profile: true,
        publishedPosts: {
          select: ['id'],
          query: (qb) =>
            qb
              .clearWhere()
              .where(sql<boolean>`id = ${11} or id = ${12}`)
              .orderBy('createdAt', 'desc')
              .limit(1),
          with: { inactiveAuthor: true },
        },
      },
    })
    .where('users.id', 'in', [1, 2])
    .orderBy('users.id')
    .execute();

  assert.deepEqual(rows, [
    { id: 1, profile: null, publishedPosts: [{ id: 11, inactiveAuthor: null }] },
    { id: 2, profile: null, publishedPosts: [] },
  ]);
});

test('merging schemas rejects duplicate relations on the same source table', () => {
  const duplicate = defineGraph<DB>()(({ hasMany }) => ({
    users: { posts: hasMany('posts', { foreignKey: 'authorId' }) },
  }));
  assert.throws(() => createGraph(f.db, [relations, duplicate]), {
    name: 'GraphError',
    message: 'Duplicate field users.posts',
  });
});

test('unknown relations and unsafe callbacks fail before executing', () => {
  const graph = createGraph(f.db, relations);
  f.queries.length = 0;
  assert.throws(
    () => graph.query({ table: 'users', with: JSON.parse('{"unknown":true}') }),
    /Unknown graph field/,
  );
  assert.throws(
    () => graph.query({ table: 'posts', with: { author: { query: (qb) => qb.limit(1) } } }),
    /filter or order; limit changed/,
  );
  assert.throws(
    () => graph.query({ table: 'posts', with: { tags: { through: (qb) => qb.limit(1) } } }),
    /filter or order; limit changed/,
  );
  assert.throws(
    () => graph.query({ table: 'users', with: { posts: { query: (qb) => qb.selectAll() } } }),
    /selections changed/,
  );
  assert.throws(
    () => graph.query({ table: 'users', with: { posts: { query: (qb) => qb.limit(-1) } } }),
    /non-negative/,
  );
  assert.throws(() => createGraph(f.db, relations, { maxParameters: 0 }), GraphError);
  const definitions = defineGraph<DB>()(({ hasMany }) => ({
    users: {
      posts: hasMany('posts', { foreignKey: 'authorId', query: (qb) => qb.orderBy('id') }),
    },
  }));
  assert.throws(
    () => createGraph(f.db, definitions).query({ table: 'users', with: { posts: true } }),
    /users\.posts\.query definition callback may only filter; orderBy changed/,
  );
  assert.equal(f.queries.length, 0);
});

test('hasOne reports cardinality violations before returning a root', async () => {
  const definitions = defineGraph<DB>()(({ hasOne }) => ({
    users: { post: hasOne('posts', { foreignKey: 'authorId' }) },
  }));
  await assert.rejects(
    createGraph(f.db, definitions)
      .query({ table: 'users', with: { post: true } })
      .where('id', '=', 1)
      .executeTakeFirstOrThrow(),
    { message: /more than one row/, code: '21000' },
  );
});

test('junction column names do not make unqualified callback columns ambiguous', async () => {
  const schema = defineGraph<DB>()(({ manyToMany }) => ({
    tags: {
      tags: manyToMany('tags', {
        through: 'tags',
        sourceKey: 'id',
        targetKey: 'id',
      }),
    },
  }));
  const result = await createGraph(f.db, schema)
    .query({
      table: 'tags',
      with: { tags: { query: (qb) => qb.where('id', '=', 1).orderBy('id').limit(1) } },
    })
    .where('tags.id', '=', 1)
    .executeTakeFirstOrThrow();
  assert.deepEqual(result.tags, [{ id: 1, label: 'typescript' }]);
});

test('definition filters isolate polymorphic targets and junctions with overlapping IDs', async () => {
  type PolymorphicTables = {
    attachments: { id: number; parent_id: number; parent_model: string; filename: string };
    attachmentLinks: { parent_id: number; parent_model: string; tag_id: number };
  };
  const db = f.db.withTables<PolymorphicTables>();
  await db.schema
    .createTable('attachments')
    .addColumn('id', 'integer', (c) => c.primaryKey())
    .addColumn('parent_id', 'integer', (c) => c.notNull())
    .addColumn('parent_model', 'text', (c) => c.notNull())
    .addColumn('filename', 'text', (c) => c.notNull())
    .execute();
  await db.schema
    .createTable('attachmentLinks')
    .addColumn('parent_id', 'integer', (c) => c.notNull())
    .addColumn('parent_model', 'text', (c) => c.notNull())
    .addColumn('tag_id', 'integer', (c) => c.notNull())
    .execute();
  try {
    await db
      .insertInto('attachments')
      .values([
        { id: 1, parent_id: 10, parent_model: 'User', filename: 'avatar.png' },
        { id: 2, parent_id: 10, parent_model: 'Post', filename: 'cover.png' },
      ])
      .execute();
    await db
      .insertInto('attachmentLinks')
      .values([
        { parent_id: 10, parent_model: 'User', tag_id: 1 },
        { parent_id: 10, parent_model: 'User', tag_id: 3 },
        { parent_id: 10, parent_model: 'Post', tag_id: 2 },
        { parent_id: 10, parent_model: 'Post', tag_id: 3 },
      ])
      .execute();
    const schema = defineGraph<DB & PolymorphicTables>()(({ hasMany, manyToMany }) => ({
      users: {
        attachments: hasMany('attachments', {
          foreignKey: 'parent_id',
          query: (qb) => qb.where('parent_model', '=', 'User'),
        }),
        tags: manyToMany('tags', {
          through: 'attachmentLinks',
          sourceKey: 'parent_id',
          targetKey: 'tag_id',
          throughQuery: (qb) => qb.where('parent_model', '=', 'User'),
        }),
      },
      posts: {
        attachments: hasMany('attachments', {
          foreignKey: 'parent_id',
          query: (qb) => qb.where('parent_model', '=', 'Post'),
        }),
        tags: manyToMany('tags', {
          through: 'attachmentLinks',
          sourceKey: 'parent_id',
          targetKey: 'tag_id',
          query: (qb) => qb.where('label', '=', 'sql'),
          throughQuery: (qb) => qb.where('parent_model', '=', 'Post'),
        }),
      },
    }));
    await db.insertInto('users').values({ id: 10, name: 'Overlap', active: true }).execute();
    const graph = createGraph(db, schema);
    const [user, post] = await Promise.all([
      graph
        .query({
          table: 'users',
          with: {
            attachments: { query: (qb) => qb.orderBy('id', 'desc').limit(1) },
            tags: {
              through: (qb) => qb.clearWhere().where('tag_id', 'in', [1, 2]),
              query: (qb) => qb.orderBy('id', 'desc').limit(1),
            },
          },
        })
        .where('users.id', '=', 10)
        .executeTakeFirstOrThrow(),
      graph
        .query({
          table: 'posts',
          with: { attachments: true, tags: true },
        })
        .where('posts.id', '=', 10)
        .executeTakeFirstOrThrow(),
    ]);
    assert.deepEqual(
      user.attachments.map((a) => a.filename),
      ['avatar.png'],
    );
    assert.deepEqual(
      post.attachments.map((a) => a.filename),
      ['cover.png'],
    );
    assert.deepEqual(
      user.tags.map((t) => t.id),
      [1],
    );
    assert.deepEqual(
      post.tags.map((t) => t.id),
      [2],
    );
  } finally {
    await db.deleteFrom('users').where('id', '=', 10).execute();
    await db.schema.dropTable('attachmentLinks').execute();
    await db.schema.dropTable('attachments').execute();
  }
});

test('reused to-one graphs stay independent after mutation', async () => {
  const graph = createGraph(f.db, relations);
  const result = await graph
    .query({
      table: 'posts',
      with: {
        author: {
          with: {
            profile: true,
            posts: {
              query: (qb) => qb.orderBy('id'),
              with: { tags: { query: (qb) => qb.orderBy('id') } },
            },
          },
        },
      },
    })
    .where('posts.id', 'in', [10, 11])
    .orderBy('posts.id')
    .execute();
  const first = result[0]!.author!;
  const second = result[1]!.author!;
  assert.notEqual(first, second);
  assert.notEqual(first.posts, second.posts);
  assert.notEqual(first.profile, second.profile);
  first.posts[0]!.tags[0]!.label = 'changed';
  first.profile!.bio = 'changed';
  first.posts.push({ ...first.posts[0]!, id: 999 });
  assert.equal(second.posts[0]!.tags[0]!.label, 'typescript');
  assert.equal(second.profile!.bio, 'Hello');
  assert.equal(second.posts.length, 3);
});

test('many-to-many targets and repeated root keys never share mutable nested results', async () => {
  const graph = createGraph(f.db, relations);
  const result = await graph
    .query({
      table: 'users',
      with: {
        posts: {
          query: (qb) => qb.orderBy('id'),
          with: { tags: { query: (qb) => qb.orderBy('id') } },
        },
      },
    })
    .innerJoin('posts as copies', 'copies.authorId', 'users.id')
    .where('users.id', '=', 1)
    .where('copies.id', 'in', [10, 11])
    .orderBy('copies.id')
    .execute();
  const first = result[0]!.posts;
  const second = result[1]!.posts;
  first[0]!.tags[1]!.label = 'changed';
  first[0]!.tags.pop();
  assert.equal(second[0]!.tags[1]!.label, 'sql');
  assert.equal(second[0]!.tags.length, 3);
  assert.equal(first[1]!.tags[0]!.label, 'sql');
  const next = await graph
    .query({
      table: 'users',
      with: { posts: { with: { tags: true } } },
    })
    .where('users.id', '=', 1)
    .executeTakeFirstOrThrow();
  assert.notEqual(next.posts[0], first[0]);
});

test('prototype-named flat relations remain own properties', async () => {
  const definitions = defineGraph<DB>()(({ hasMany, belongsTo }) => ({
    users: { posts: hasMany('posts', { foreignKey: 'authorId' }) },
    posts: { ['__proto__']: belongsTo('users', { foreignKey: 'authorId' }) },
  }));
  const graph = createGraph(f.db, [definitions]);
  const single = createGraph(f.db, definitions, { strategy: 'single' });
  assert.throws(() => single.query({ table: 'posts', with: { ['__proto__']: true } }), /__proto__/);

  const root = await graph
    .query({ table: 'posts', select: [], with: { ['__proto__']: { select: ['id'] } } })
    .where('id', '=', 10)
    .executeTakeFirstOrThrow();
  assert.equal(Object.getPrototypeOf(root), Object.prototype);
  assert.deepEqual(root, { ['__proto__']: { id: 1 } });

  const result = await graph
    .query({
      table: 'users',
      with: { posts: { select: [], with: { ['__proto__']: { select: ['id'] } } } },
    })
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();

  const post = result.posts[0]!;
  assert.equal(Object.getPrototypeOf(post), Object.prototype);
  assert.equal(Object.hasOwn(post, '__proto__'), true);
  assert.deepEqual(post.__proto__, { id: 1 });
});

test('selected columns retain hidden attachment/nesting keys and infer exact nested shapes', async () => {
  const result = await createGraph(f.db, relations)
    .query({
      table: 'users',
      with: {
        profile: { select: ['bio'] },
        posts: {
          select: ['title'],
          query: (qb) => qb.orderBy('id'),
          with: {
            author: { select: ['name'] },
            comments: { select: ['approved'] },
            tags: { select: ['label'], query: (qb) => qb.orderBy('id') },
          },
        },
      },
    })
    .where('users.id', '=', 1)
    .executeTakeFirstOrThrow();
  assert.deepEqual(result.profile, { bio: 'Hello' });
  assert.deepEqual(result.posts[0], {
    title: 'A',
    author: { name: 'Ada' },
    comments: [{ approved: true }],
    tags: [{ label: 'typescript' }, { label: 'sql' }, { label: 'web' }],
  });
  assert.deepEqual(Object.keys(result.posts[1]!).sort(), ['author', 'comments', 'tags', 'title']);
  const nullAuthor = await createGraph(f.db, relations)
    .query({
      table: 'posts',
      with: { author: { select: ['name'] } },
    })
    .where('posts.id', '=', 30)
    .executeTakeFirstOrThrow();
  assert.equal(nullAuthor.author, null);
});

test('selected queries omit wide columns in SQL and can filter/order on unselected columns', async () => {
  f.queries.length = 0;
  const result = await createGraph(f.db, relations)
    .query({
      table: 'users',
      with: {
        posts: {
          select: ['title'],
          query: (qb) => qb.where('published', '=', true).orderBy('createdAt', 'desc').limit(1),
        },
      },
    })
    .where('users.id', '=', 1)
    .executeTakeFirstOrThrow();
  assert.deepEqual(result.posts, [{ title: 'A' }]);
  const query = f.queries[1]!;
  assert.match(query, /"posts"\."title"/);
  assert.doesNotMatch(query, /json_agg/);
  assert.doesNotMatch(query, /"posts"\.\*/);
  assert.doesNotMatch(query, /"posts"\."published" as/);
});

test('empty selections support relationship-only graphs and empty objects', async () => {
  const result = await createGraph(f.db, relations)
    .query({
      table: 'users',
      with: {
        profile: { select: [] },
        posts: {
          select: [],
          query: (qb) => qb.orderBy('id'),
          with: {
            tags: { select: [], query: (qb) => qb.limit(1) },
            author: { select: [] },
          },
        },
      },
    })
    .where('users.id', '=', 1)
    .executeTakeFirstOrThrow();
  assert.deepEqual(result.profile, {});
  assert.deepEqual(result.posts, [
    { tags: [{}], author: {} },
    { tags: [{}], author: {} },
    { tags: [], author: {} },
  ]);
  const single = await createGraph(f.db, relations)
    .query({
      table: 'users',
      with: { posts: { select: [] } },
    })
    .where('users.id', '=', 2)
    .executeTakeFirstOrThrow();
  assert.deepEqual(single.posts, [{}, {}]);
});

test('composite mappings and many-to-many limits work with hidden selected keys', async () => {
  const result = await createGraph(f.db, relations)
    .query({
      table: 'tenants',
      with: {
        items: {
          select: ['score'],
          query: (qb) => qb.orderBy('score', 'desc').limit(1),
          with: { parent: { select: ['title'] } },
        },
        tags: { select: ['label'], query: (qb) => qb.limit(1) },
      },
    })
    .orderBy('title')
    .execute();
  assert.deepEqual(
    result.map((p) => p.items),
    [[{ score: 5, parent: { title: 'one' } }], [{ score: 8, parent: { title: 'two' } }]],
  );
  assert.deepEqual(
    result.map((p) => p.tags),
    [[{ label: 'typescript' }], [{ label: 'sql' }]],
  );
});

test('invalid runtime selections fail before querying', () => {
  f.queries.length = 0;
  const graph = createGraph(f.db, relations);
  for (const select of ['id', [1], ['id as other'], null]) {
    assert.throws(
      () =>
        graph.query({ table: 'users', with: JSON.parse(JSON.stringify({ posts: { select } })) }),
      /select must be an array|Unsupported identifier/,
    );
  }
  assert.equal(f.queries.length, 0);
});

test('flat execution batches a filtered paginated graph', async () => {
  const r = createGraph(f.db, relations);
  f.queries.length = 0;
  const builder = r
    .query({
      table: 'users',
      select: ['id', 'name'],
      with: {
        profile: { select: ['bio'] },
        posts: {
          select: ['title'],
          query: (qb) => qb.where('published', '=', true).orderBy('id').limit(1),
          with: {
            comments: { select: ['approved'] },
            tags: {
              select: ['label'],
              through: (qb) => qb.where('visible', '=', true),
              query: (qb) => qb.orderBy('id'),
            },
          },
        },
      },
    })
    .where('active', '=', true)
    .orderBy('id', 'desc')
    .limit(1);
  assert.equal(f.queries.length, 0);
  const result = await builder.execute();
  assert.deepEqual(result, [
    {
      id: 2,
      name: 'Lin',
      profile: null,
      posts: [
        { title: 'D', comments: [{ approved: true }], tags: [{ label: 'sql' }, { label: 'web' }] },
      ],
    },
  ]);
  assert.equal(f.queries.length, 5);
});
test('self-relations and repeated table names keep distinct SQL scopes', async () => {
  const definitions = defineGraph<DB>()(({ belongsTo, hasMany }) => ({
    users: { self: belongsTo('users', { foreignKey: 'id' }) },
    posts: {
      author: belongsTo('users', { foreignKey: 'authorId' }),
      siblings: hasMany('posts', { sourceKey: 'authorId', foreignKey: 'authorId' }),
    },
  }));
  const r = createGraph(f.db, definitions);
  const self = await r
    .query({
      table: 'users',
      select: ['id'],
      with: { self: { select: ['name'], with: { self: { select: ['id'] } } } },
    })
    .where('id', '=', 2)
    .executeTakeFirstOrThrow();
  assert.deepEqual(self, { id: 2, self: { name: 'Lin', self: { id: 2 } } });
  const posts = await r
    .query({
      table: 'posts',
      select: ['id'],
      with: {
        siblings: {
          select: ['id'],
          query: (qb) => qb.orderBy('id'),
          with: { author: { select: ['name'] } },
        },
      },
    })
    .where('id', '=', 20)
    .executeTakeFirstOrThrow();
  assert.deepEqual(posts, {
    id: 20,
    siblings: [
      { id: 20, author: { name: 'Lin' } },
      { id: 21, author: { name: 'Lin' } },
    ],
  });
});
test('native query supports correlated EXISTS and does not filter roots by child predicates', async () => {
  f.queries.length = 0;
  const rows = await createGraph(f.db, relations)
    .query({
      table: 'users',
      select: ['id'],
      with: {
        posts: {
          select: ['id'],
          query: (qb) =>
            qb
              .where('published', '=', true)
              .where(({ exists, selectFrom }) =>
                exists(
                  selectFrom('comments')
                    .select('id')
                    .whereRef('comments.postId', '=', 'posts.id')
                    .where('approved', '=', true),
                ),
              )
              .orderBy('id'),
        },
      },
    })
    .orderBy('users.id')
    .execute();
  assert.deepEqual(rows, [
    { id: 1, posts: [{ id: 10 }] },
    { id: 2, posts: [{ id: 20 }] },
    { id: 3, posts: [] },
  ]);
  assert.equal(f.queries.length, 2);
});
test('query take-first variants and empty root selections keep Kysely behavior', async () => {
  const r = createGraph(f.db, relations);
  assert.equal(
    await r
      .query({ table: 'users', with: { posts: true } })
      .where('id', '=', 999)
      .executeTakeFirst(),
    undefined,
  );
  await assert.rejects(
    r.query({ table: 'users', with: {} }).where('id', '=', 999).executeTakeFirstOrThrow(),
    /no result/,
  );
  assert.deepEqual(
    await r.query({ table: 'users', select: [], with: {} }).where('id', '=', 1).execute(),
    [{}],
  );
  assert.deepEqual(
    await r
      .query({
        table: 'users',
        select: [],
        with: { posts: { select: [], query: (qb) => qb.limit(0) } },
      })
      .where('id', '=', 1)
      .execute(),
    [{ posts: [] }],
  );
});
test('flat batches handle composite mappings, junctions and hidden fields', async () => {
  f.queries.length = 0;
  const rows = await createGraph(f.db, relations)
    .query({
      table: 'tenants',
      select: ['title'],
      with: {
        items: {
          select: ['score'],
          query: (qb) => qb.orderBy('score', 'desc').limit(1),
          with: { parent: { select: ['title'] } },
        },
        tags: { select: ['label'], query: (qb) => qb.limit(1) },
      },
    })
    .orderBy('title')
    .execute();
  assert.deepEqual(rows, [
    {
      title: 'one',
      items: [{ score: 5, parent: { title: 'one' } }],
      tags: [{ label: 'typescript' }],
    },
    { title: 'two', items: [{ score: 8, parent: { title: 'two' } }], tags: [{ label: 'sql' }] },
  ]);
  assert.equal(f.queries.length, 4);
  assert.ok(
    f.queries.every((query) => !/\b(?:row_to_json|jsonb?_(?:agg|build_object))\s*\(/i.test(query)),
  );
  assert.ok(f.queries.some((query) => query.includes('"items"."score" as "score"')));
});

test('batched diagnostics report statement rows and independent execution IDs', async () => {
  const events: GraphDiagnostic[] = [];
  const r = createGraph(f.db, relations, {
    onDiagnostic: (event) => {
      events.push(event);
    },
  });
  const builder = r
    .query({ table: 'users', with: { posts: { with: { tags: true } } } })
    .where('id', '=', 1);
  assert.equal(events.length, 0);
  await Promise.all([builder.execute(), builder.executeTakeFirst()]);
  const summaries = events.filter((e) => e.type === 'execution');
  assert.equal(summaries.length, 2);
  assert.equal(new Set(summaries.map((e) => e.executionId)).size, 2);
  for (const summary of summaries) {
    assert.equal(summary.queryCount, 3);
    assert.equal(summary.rowsFetched, 8);
    assert.ok(summary.durationMs >= 0);
  }
  const queries = events.filter((e) => e.type === 'query');
  assert.equal(queries.length, 6);
  for (const summary of summaries) {
    assert.deepEqual(
      queries
        .filter((event) => event.executionId === summary.executionId)
        .map((event) => event.relationPaths),
      [[], [['users', 'posts']], [['users', 'posts', 'tags']]],
    );
  }
});
test('diagnostics preserve query errors and isolate observer failures', async () => {
  const events: GraphDiagnostic[] = [];
  const r = createGraph(f.db, relations, {
    onDiagnostic: (event) => {
      events.push(event);
    },
  });
  let original: unknown;
  await assert.rejects(
    r
      .query({ table: 'users', with: { posts: true } })
      .where(sql<boolean>`krl_missing_function()`)
      .execute(),
    (error) => {
      original = error;
      return error instanceof Error;
    },
  );
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.status, 'error');
    if (event.status === 'error') assert.equal(event.error, original);
  }
  const silent = createGraph(f.db, relations, {
    onDiagnostic: async () => {
      throw new Error('observer failure');
    },
  });
  assert.equal(
    (await silent.query({ table: 'users', with: {} }).where('id', '=', 1).execute()).length,
    1,
  );
  await Promise.resolve();
});
test('oversized statements fail before querying and emit an error summary', async () => {
  const events: GraphDiagnostic[] = [];
  const graph = createGraph(f.db, relations, {
    maxParameters: 1,
    onDiagnostic: (event) => {
      events.push(event);
    },
  });

  f.queries.length = 0;
  await assert.rejects(
    graph
      .query({ table: 'users', with: { posts: { select: ['title'] } } })
      .where('id', '=', 1)
      .where('active', '=', true)
      .execute(),
    /maxParameters/,
  );
  assert.equal(f.queries.length, 0);
  assert.equal(events.length, 1);
  const [summary] = events;
  assert.ok(summary?.type === 'execution' && summary.status === 'error');
  assert.equal(summary.queryCount, 0);

  assert.throws(
    () => createGraph(f.db, relations, { chunkSize: 0 }),
    /chunkSize must be a positive safe integer/,
  );
});

test('transaction-bound native graphs see uncommitted rows and roll back normally', async () => {
  await assert.rejects(
    f.db.transaction().execute(async (trx) => {
      await trx.insertInto('comments').values({ id: 998, postId: 10, approved: true }).execute();
      const row = await createGraph(trx, relations)
        .query({ table: 'posts', with: { comments: true } })
        .where('id', '=', 10)
        .executeTakeFirstOrThrow();
      assert.equal(row.comments.length, 2);
      throw new Error('rollback native');
    }),
    /rollback native/,
  );
  assert.equal(
    (await f.db.selectFrom('comments').selectAll().where('id', '=', 998).execute()).length,
    0,
  );
});
test('wide nested JSON objects stay below PostgreSQL function argument limits', async () => {
  const longName = 'comments'.repeat(10);
  const names = [longName, ...Array.from({ length: 69 }, (_, index) => `comments${index}`)];
  const definitions = defineGraph<DB>()(({ hasMany }) => ({
    users: { posts: hasMany('posts', { foreignKey: 'authorId' }) },
    posts: Object.fromEntries(
      names.map((name) => [name, hasMany('comments', { foreignKey: 'postId' })]),
    ),
  }));
  const empty = (qb: RelationQuery<DB, 'comments'>) => qb.limit(0);
  const children = Object.fromEntries(names.map((name) => [name, { query: empty }]));
  const row = await createGraph(f.db, definitions, { strategy: 'single' })
    .query({
      table: 'users',
      select: [],
      with: { posts: { select: ['id'], query: (qb) => qb.limit(1), with: children } },
    })
    .where('users.id', '=', 1)
    .executeTakeFirstOrThrow();

  const post = row.posts[0]!;
  assert.equal(post.id, 10);
  assert.equal(Object.keys(post).length, 71);
  assert.ok(names.every((name) => Array.isArray(post[name])));
});

test('flat child columns and computed fields use the same decoding as direct selections', async () => {
  type Tables = {
    documents: { id: number; ownerId: number; at: Date; payload: Uint8Array; counter: bigint };
  };
  const db = f.db.withTables<Tables>();
  await db.schema
    .createTable('documents')
    .addColumn('id', 'integer', (c) => c.primaryKey())
    .addColumn('ownerId', 'integer')
    .addColumn('at', 'timestamptz')
    .addColumn('payload', 'bytea')
    .addColumn('counter', 'bigint')
    .execute();
  try {
    const date = new Date('2026-01-02T03:04:05Z');
    await db
      .insertInto('documents')
      .values({ id: 1, ownerId: 1, at: date, payload: new Uint8Array([0, 15, 255]), counter: 42n })
      .execute();
    const definitions = defineGraph<DB & Tables>()(({ hasMany, belongsTo, computed }) => ({
      users: { documents: hasMany('documents', { foreignKey: 'ownerId' }) },
      documents: {
        owner: belongsTo('users', { foreignKey: 'ownerId' }),
        recordedAt: computed('documents', (eb) => eb.ref('documents.at')),
      },
    }));
    const r = createGraph(db, definitions, { strategy: 'single' });
    const root = await r
      .query({ table: 'documents', select: ['at'], with: { owner: { select: ['name'] } } })
      .executeTakeFirstOrThrow();
    assert.ok(root.at instanceof Date);
    const user = await r
      .query({
        table: 'users',
        select: ['id'],
        with: { documents: { select: ['at', 'payload', 'counter'] } },
      })
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    assert.equal(typeof user.documents[0]!.at, 'string');
    assert.equal(new Date(user.documents[0]!.at).toISOString(), date.toISOString());
    assert.equal(user.documents[0]!.payload, '\\x000fff');
    assert.equal(user.documents[0]!.counter, 42);

    const native = await db
      .selectFrom('documents')
      .select(['at', 'payload', 'counter'])
      .executeTakeFirstOrThrow();
    const flat = await createGraph(db, definitions)
      .query({
        table: 'users',
        select: ['id'],
        with: {
          documents: {
            select: ['at', 'payload', 'counter'],
            with: { recordedAt: true, owner: { select: ['name'] } },
          },
        },
      })
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    assert.deepEqual(flat, {
      id: 1,
      documents: [{ ...native, recordedAt: native.at, owner: { name: 'Ada' } }],
    });
  } finally {
    await db.schema.dropTable('documents').execute();
  }
});
test('Kysely subqueries preserve declared relation names', async () => {
  const { db } = f;
  const longName = 'parent_tag_'.repeat(7);
  const definitions = defineGraph<DB>()(({ hasMany, belongsTo }) => ({
    tags: {
      other_tags: hasMany('tags', { foreignKey: 'id' }),
      otherTags: hasMany('tags', { foreignKey: 'id' }),
      [longName]: belongsTo('tags', { foreignKey: 'id' }),
    },
  }));
  const graph = createGraph(db, definitions, { strategy: 'single' });
  const builder = graph
    .query({
      table: 'tags',
      select: ['id'],
      with: {
        other_tags: { select: [], with: { [longName]: { select: ['label'] } } },
        otherTags: { select: ['label'] },
      },
    })
    .where('id', '=', 1);
  const expected = {
    id: 1,
    other_tags: [{ [longName]: { label: 'typescript' } }],
    otherTags: [{ label: 'typescript' }],
  };

  assert.deepEqual(await builder.executeTakeFirstOrThrow(), expected);

  const source = builder.as('graphRows');
  const outer = db.selectFrom(source).selectAll();
  assert.deepEqual(await outer.executeTakeFirstOrThrow(), expected);
  assert.deepEqual(
    await db
      .selectFrom(source)
      .select(['graphRows.other_tags as renamedRelation', 'graphRows.otherTags'])
      .executeTakeFirstOrThrow(),
    { renamedRelation: expected.other_tags, otherTags: expected.otherTags },
  );

  assert.deepEqual(
    await db
      .with('graphRows', () => builder)
      .selectFrom('graphRows')
      .selectAll()
      .executeTakeFirstOrThrow(),
    expected,
  );
});

test('withSchema scopes root and filtered child tables', async () => {
  type Tables = {
    scopeParents: { id: number };
    scopeChildren: { id: number; parentId: number };
  };
  const schema = 'relation"scope';
  await f.db.schema.createSchema(schema).execute();
  try {
    const db = f.db.withTables<Tables>().withSchema(schema);
    await db.schema.createTable('scopeParents').addColumn('id', 'integer').execute();
    await db.schema
      .createTable('scopeChildren')
      .addColumn('id', 'integer')
      .addColumn('parentId', 'integer')
      .execute();
    await db.insertInto('scopeParents').values({ id: 1 }).execute();
    await db.insertInto('scopeChildren').values({ id: 10, parentId: 1 }).execute();

    const definitions = defineGraph<DB & Tables>()(({ hasMany }) => ({
      scopeParents: { children: hasMany('scopeChildren', { foreignKey: 'parentId' }) },
    }));
    const graph = createGraph(db, definitions);
    const expected = { id: 1, children: [{ id: 10, parentId: 1 }] };
    assert.deepEqual(
      await graph
        .query({
          table: 'scopeParents',
          with: { children: { query: (qb) => qb.where('parentId', '=', 1) } },
        })
        .executeTakeFirstOrThrow(),
      expected,
    );
  } finally {
    await f.db.schema.dropSchema(schema).cascade().execute();
  }
});

test('helper subqueries preserve expression ordering with unselected columns and limits', async () => {
  const row = await createGraph(f.db, relations)
    .query({
      table: 'users',
      select: ['id'],
      with: {
        posts: {
          select: ['title'],
          query: (qb) => qb.orderBy(sql<number>`length(title)`, 'desc').limit(1),
        },
      },
    })
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  assert.deepEqual(row.posts, [{ title: 'A' }]);
});

test('chunks composite keys to fit the per-statement parameter budget', async () => {
  f.queries.length = 0;
  const rows = await createGraph(f.db, relations, { maxParameters: 3 })
    .query({
      table: 'tenants',
      select: ['title'],
      with: {
        items: {
          select: ['score'],
          query: (qb) => qb.where('score', '>=', 0).orderBy('score'),
        },
      },
    })
    .orderBy('title')
    .execute();

  assert.equal(f.queries.length, 3);
  for (const query of f.queries.slice(1)) {
    assert.equal(query.match(/\$[0-9]+/g)?.length, 3);
  }
  assert.deepEqual(
    rows.map(({ items }) => items.map(({ score }) => score)),
    [[5, 5], [8]],
  );

  await assert.rejects(
    createGraph(f.db, relations, { maxParameters: 2 })
      .query({
        table: 'tenants',
        with: { items: { query: (qb) => qb.where('score', '>=', 0) } },
      })
      .execute(),
    /cannot fit the relation parameters and one parent key/,
  );
});

test('shares a concurrency limit across chunks, sibling relations, and executions', async () => {
  let active = 0;
  let peak = 0;
  const db = f.db.withPlugin({
    transformQuery: ({ node }) => node,
    async transformResult({ result }) {
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      active--;
      return result;
    },
  });

  f.queries.length = 0;
  const query = createGraph(db, relations, { chunkSize: 1, concurrency: 2 })
    .query({ table: 'users', select: ['id'], with: { profile: true, posts: true } })
    .orderBy('users.id');
  const [first, second] = await Promise.all([query.execute(), query.execute()]);
  assert.deepEqual(first, second);
  assert.equal(f.queries.length, 14);
  assert.equal(peak, 2);
  assert.equal(active, 0);

  peak = 0;
  await db.transaction().execute(async (trx) => {
    await createGraph(trx, relations, { chunkSize: 1, concurrency: 2 })
      .query({ table: 'users', select: ['id'], with: { profile: true, posts: true } })
      .execute();
    assert.equal(peak, 1);
  });
});

test('single-statement execution remains available for the same builder API', async () => {
  f.queries.length = 0;
  const query = createGraph(f.db, relations, { strategy: 'single' })
    .query({
      table: 'users',
      select: ['id'],
      with: { posts: { select: ['title'], query: (qb) => qb.orderBy('id').limit(1) } },
    })
    .orderBy('id');
  assert.match(query.compile().sql, /json_agg/);
  assert.equal(f.queries.length, 0);
  const result = await query.execute();
  assert.deepEqual(
    result.map(({ posts }) => posts),
    [[{ title: 'A' }], [{ title: 'D' }], []],
  );
  assert.equal(f.queries.length, 1);
  assert.match(f.queries[0]!, /json_agg/);
});

test('stops queued batches after an error and releases the graph query slots', async () => {
  const events: GraphDiagnostic[] = [];
  const graph = createGraph(f.db, relations, {
    chunkSize: 1,
    concurrency: 2,
    onDiagnostic: (event) => {
      events.push(event);
    },
  });
  await assert.rejects(
    graph
      .query({
        table: 'users',
        with: {
          posts: { query: (qb) => qb.where(sql<boolean>`krl_missing_function()`) },
          profile: true,
        },
      })
      .execute(),
    /krl_missing_function/,
  );
  assert.ok(events.every((event) => event.table === 'users' || event.table === 'posts'));
  const summary = events.at(-1);
  assert.ok(summary?.type === 'execution' && summary.status === 'error');
  assert.equal(summary.queryCount, 3);

  const rows = await graph.query({ table: 'users', with: { profile: true } }).execute();
  assert.equal(rows.length, 3);
});
