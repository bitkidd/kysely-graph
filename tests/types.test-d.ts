import { type Kysely, type Selectable, sql } from 'kysely';

import { createGraph, defineGraph } from '../src/index.js';
import { type DB, relations } from './fixture.js';
declare const db: Kysely<DB>;
const relationsQuery = createGraph(db, relations);
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

const computedSchema = defineGraph<DB>()(({ computed }) => ({
  posts: {
    commentsCount: computed('posts', (eb, { approved }: { approved: boolean }) =>
      eb
        .selectFrom('comments')
        .whereRef('comments.postId', '=', 'posts.id')
        .where('comments.approved', '=', approved)
        .select(({ cast, fn }) => cast<number>(fn.countAll(), 'integer').as('count'))
        .$asScalar(),
    ),
    computedDate: computed('posts', () => sql<Date>`now()`),
    optional: computed('posts', (eb, { value = 0 }: { value?: number }) => eb.val(value)),
  },
}));
const computedGraph = createGraph(db, [relations, computedSchema]);
const computedRoot = computedGraph.query({
  table: 'posts',
  select: ['id'],
  with: { commentsCount: { args: { approved: true } }, computedDate: true, optional: true },
});
const computedNested = computedGraph.query({
  table: 'users',
  with: {
    posts: {
      select: [],
      query: (qb) => qb.where('published', '=', true),
      with: {
        commentsCount: { args: { approved: false } },
        computedDate: true,
        optional: { args: { value: 2 } },
      },
    },
  },
});
type ComputedRoot = Assert<
  Equal<
    Awaited<ReturnType<typeof computedRoot.execute>>[number],
    { id: number; commentsCount: number; computedDate: Date; optional: number }
  >
>;
type ComputedNested = Assert<
  Equal<
    Awaited<ReturnType<typeof computedNested.execute>>[number]['posts'][number],
    { commentsCount: number; computedDate: string; optional: number }
  >
>;
// @ts-expect-error required arguments cannot use shorthand
computedGraph.query({ table: 'posts', with: { commentsCount: true } });
// @ts-expect-error missing required argument
computedGraph.query({ table: 'posts', with: { commentsCount: { args: {} } } });
// @ts-expect-error callback without arguments only accepts true
computedGraph.query({ table: 'posts', with: { computedDate: { args: {} } } });
computedGraph.query({
  table: 'posts',
  // @ts-expect-error relation options do not apply to computed fields
  with: { commentsCount: { args: { approved: true }, select: [] } },
});
computedGraph.query({
  table: 'users',
  // @ts-expect-error nested arguments are checked against the callback parameter
  with: { posts: { with: { commentsCount: { args: { approved: 'yes' } } } } },
});
defineGraph<DB>()(({ computed }) => ({
  posts: {
    // @ts-expect-error the computed definition must belong to its declaring table
    wrongTable: computed('users', (eb) => eb.ref('users.id')),
    // @ts-expect-error computed fields cannot replace database columns
    id: computed('posts', (eb) => eb.ref('posts.id')),
    // @ts-expect-error scalar subqueries need $asScalar() for the correct result type
    bareQuery: computed('posts', (eb) => eb.selectFrom('comments').select('comments.id')),
  },
}));

const result = relationsQuery
  .query({
    table: 'users',
    select: ['id'],
    with: {
      posts: {
        query: (qb) => qb.where('published', '=', true).limit(2),
        with: { author: true, tags: true },
      },
      profile: true,
    },
  })
  .select(sql<string>`'value'`.as('computed'))
  .execute();
type Result = Awaited<typeof result>[number];
type RootId = Assert<Equal<Result['id'], number>>;
type Computed = Assert<Equal<Result['computed'], string>>;
type Profile = Assert<Equal<Result['profile'], Selectable<DB['profiles']> | null>>;
type Author = Assert<Equal<Result['posts'][number]['author'], Selectable<DB['users']> | null>>;
type Tags = Assert<Equal<Result['posts'][number]['tags'], Selectable<DB['tags']>[]>>;
// @ts-expect-error unselected root columns are absent
result.then((rows) => rows[0]!.name);
// @ts-expect-error invalid root table
relationsQuery.query({ table: 'bogus', with: {} });
// @ts-expect-error unknown relation name
relationsQuery.query({ table: 'users', with: { bogus: true } });
const invalidWith = { bogus: true } as const;
// @ts-expect-error unknown relation in a non-literal variable
relationsQuery.query({ table: 'users', with: invalidWith });
// @ts-expect-error unknown nested relation
relationsQuery.query({ table: 'users', with: { posts: { with: { bogus: true } } } });
relationsQuery.query({
  table: 'users',
  // @ts-expect-error callback references target columns
  with: { posts: { query: (qb) => qb.where('bio', '=', 'x') } },
});
relationsQuery.query({
  table: 'users',
  // @ts-expect-error callback value types follow the DB
  with: { posts: { query: (qb) => qb.where('published', '=', 'yes') } },
});
relationsQuery.query({
  table: 'posts',
  // @ts-expect-error junction callbacks use the junction table
  with: { tags: { through: (qb) => qb.where('label', '=', 'x') } },
});
// @ts-expect-error child limits belong in to-many query callbacks
relationsQuery.query({ table: 'users', with: { posts: { perParentLimit: 1 } } });
// @ts-expect-error through is only on manyToMany
relationsQuery.query({ table: 'users', with: { posts: { through: (qb) => qb } } });
const filteredUsers = defineGraph<DB>()(({ hasMany }) => ({
  users: {
    publishedPosts: hasMany('posts', {
      foreignKey: 'authorId',
      query: (qb) => qb.where('published', '=', true),
    }),
  },
}));
const filteredPosts = defineGraph<DB>()(({ manyToMany }) => ({
  posts: {
    visibleTags: manyToMany('tags', {
      through: 'postTags',
      sourceKey: 'postId',
      targetKey: 'tagId',
      query: (qb) => qb.where('label', '!=', 'web'),
      throughQuery: (qb) => qb.where('visible', '=', true),
    }),
  },
}));
const fragments = [filteredUsers, relations, filteredPosts];
const mergedGraph = createGraph(db, fragments);
const filteredGraph = mergedGraph.query({
  table: 'users',
  with: { profile: true, publishedPosts: { with: { visibleTags: { select: ['label'] } } } },
});
type Filtered = Awaited<ReturnType<typeof filteredGraph.execute>>[number];
type MergedProfile = Assert<Equal<Filtered['profile'], Selectable<DB['profiles']> | null>>;
type FilteredTags = Assert<
  Equal<Filtered['publishedPosts'][number]['visibleTags'], { label: string }[]>
>;
// @ts-expect-error merged schemas still check nested relation names
mergedGraph.query({ table: 'users', with: { publishedPosts: { with: { unknown: true } } } });
const emptyGraph = createGraph(db, []);
emptyGraph.query({ table: 'users', with: {} });
// @ts-expect-error an empty list adds no relations
emptyGraph.query({ table: 'users', with: { posts: true } });
defineGraph<DB>()(({ hasMany, manyToMany }) => ({
  users: {
    posts: hasMany('posts', {
      foreignKey: 'authorId',
      query: (qb) =>
        qb
          // @ts-expect-error definition callbacks use the target table's columns
          .where('active', '=', true)
          // @ts-expect-error definition callbacks check column value types
          .where('published', '=', 'yes'),
    }),
  },
  posts: {
    tags: manyToMany('tags', {
      through: 'postTags',
      sourceKey: 'postId',
      targetKey: 'tagId',
      // @ts-expect-error throughQuery uses junction columns
      throughQuery: (qb) => qb.where('label', '=', 'x'),
    }),
  },
}));
defineGraph<DB>()(({ hasMany }) => ({
  // @ts-expect-error target tables checked at schema definition
  users: { posts: hasMany('bogus', { foreignKey: 'authorId' }) },
}));
defineGraph<DB>()(({ hasMany }) => ({
  // @ts-expect-error source table checked at schema definition
  bogus: { posts: hasMany('posts', { foreignKey: 'authorId' }) },
}));
defineGraph<DB>()(({ hasMany }) => ({
  // @ts-expect-error target column checked
  users: { posts: hasMany('posts', { foreignKey: 'missing' }) },
}));
defineGraph<DB>()(({ hasMany }) => ({
  // @ts-expect-error source column checked
  users: { posts: hasMany('posts', { sourceKey: 'missing', foreignKey: 'authorId' }) },
}));
defineGraph<DB>()(({ hasMany }) => ({
  // @ts-expect-error incompatible key types
  users: { posts: hasMany('posts', { sourceKey: 'name', foreignKey: 'authorId' }) },
}));
defineGraph<DB>()(({ belongsTo }) => ({
  // @ts-expect-error belongsTo foreign key is on source
  posts: { author: belongsTo('users', { foreignKey: 'missing' }) },
}));
defineGraph<DB>()(({ hasMany }) => ({
  tenants: {
    // @ts-expect-error composite arity mismatch
    items: hasMany('items', {
      sourceKey: ['tenant', 'code'],
      foreignKey: ['tenant'],
      targetKey: 'itemCode',
    }),
  },
}));
defineGraph<DB>()(({ manyToMany }) => ({
  // @ts-expect-error junction table checked
  posts: { tags: manyToMany('tags', { through: 'bad', sourceKey: 'postId', targetKey: 'tagId' }) },
}));
defineGraph<DB>()(({ manyToMany }) => ({
  posts: {
    // @ts-expect-error junction columns checked
    tags: manyToMany('tags', { through: 'postTags', sourceKey: 'bad', targetKey: 'tagId' }),
  },
}));
defineGraph<DB>()(({ hasMany }) => ({
  // @ts-expect-error target primary key overrides checked
  users: { posts: hasMany('posts', { foreignKey: 'authorId', targetKey: 'missing' }) },
}));
const projected = relationsQuery
  .query({
    table: 'users',
    with: {
      profile: { select: ['bio'] },
      posts: {
        select: ['title'],
        with: {
          author: { select: ['name'] },
          tags: { select: ['label'] },
          comments: { select: [] },
        },
      },
    },
  })
  .execute();
type Projected = Awaited<typeof projected>[number];
type ProjectedProfile = Assert<Equal<Projected['profile'], { bio: string } | null>>;
type ProjectedPost = Assert<
  Equal<
    Projected['posts'][number],
    {
      title: string;
      author: { name: string } | null;
      tags: { label: string }[];
      comments: {}[];
    }
  >
>;
// @ts-expect-error internal grouping/source keys are not exposed
projected.then((rows) => rows[0]!.posts[0]!.authorId);
// @ts-expect-error unselected target primary keys are not exposed
projected.then((rows) => rows[0]!.posts[0]!.id);
// @ts-expect-error selection fields belong to the target
relationsQuery.query({ table: 'users', with: { posts: { select: ['bio'] } } });
// @ts-expect-error expressions and aliases are not column selections
relationsQuery.query({ table: 'users', with: { posts: { select: ['id as identifier'] } } });
// @ts-expect-error selections must be arrays
relationsQuery.query({ table: 'users', with: { posts: { select: 'id' } } });
const chosenColumns: ('id' | 'title')[] = ['id'];
const dynamicSelection = relationsQuery
  .query({
    table: 'users',
    with: { posts: { select: chosenColumns } },
  })
  .executeTakeFirstOrThrow();
type DynamicSelection = Assert<
  Equal<Awaited<typeof dynamicSelection>['posts'][number], { id?: number; title?: string }>
>;
const readonlyColumns = ['id', 'title'] as const;
const readonlyProjection = relationsQuery
  .query({
    table: 'users',
    with: { posts: { select: readonlyColumns } },
  })
  .executeTakeFirstOrThrow();
type ReadonlyProjection = Assert<
  Equal<Awaited<typeof readonlyProjection>['posts'][number], { id: number; title: string }>
>;
createGraph(db, relations, {
  onDiagnostic: (event) => {
    const id: number = event.executionId;
    if (event.type === 'query') {
      const rows: number = event.rowsFetched;
      const paths: readonly (readonly string[])[] = event.relationPaths;
      // @ts-expect-error diagnostics are readonly
      event.rowsFetched = 1;
      // @ts-expect-error summary counts are only on execution events
      event.queryCount;
    } else {
      const count: number = event.queryCount;
      // @ts-expect-error query paths are only on query events
      event.relationPaths;
    }
    if (event.status === 'error') {
      const error: unknown = event.error;
    }
    // @ts-expect-error errors are only present on error events
    else event.error;
  },
});
const graph = createGraph(db, relations)
  .query({
    table: 'users',
    select: ['id'],
    with: {
      posts: { select: ['title'], with: { tags: { select: ['label'] } } },
    },
  })
  .where('active', '=', true)
  .orderBy('users.id')
  .limit(10);
type NativeGraph = Assert<
  Equal<
    Awaited<ReturnType<typeof graph.execute>>,
    Array<{ id: number; posts: Array<{ title: string; tags: Array<{ label: string }> }> }>
  >
>;
// @ts-expect-error root filters retain the Kysely table scope
graph.where('bogus', '=', 1);
// @ts-expect-error selected roots expose only selected properties
graph.execute().then((rows) => rows[0]!.name);
// @ts-expect-error root selections are checked against the root table
createGraph(db, relations).query({ table: 'users', select: ['title'], with: {} });
// @ts-expect-error removed batch configuration is not part of single-query execution
createGraph(db, relations, { chunkSize: 500 });
interface DateDB {
  parents: { id: number; at: Date };
  children: { id: number; parentId: number; at: Date; bytes: Uint8Array; counter: bigint };
}
declare const dates: Kysely<DateDB>;
const dateRelations = defineGraph<DateDB>()(({ hasMany }) => ({
  parents: { children: hasMany('children', { foreignKey: 'parentId' }) },
}));
const datesQuery = createGraph(dates, dateRelations).query({
  table: 'parents',
  with: { children: true },
});
type DateGraph = Awaited<ReturnType<typeof datesQuery.execute>>[number];
type RootDate = Assert<Equal<DateGraph['at'], Date>>;
type ChildDate = Assert<Equal<DateGraph['children'][number]['at'], string>>;
type ChildBytes = Assert<Equal<DateGraph['children'][number]['bytes'], string>>;
type ChildCounter = Assert<Equal<DateGraph['children'][number]['counter'], number>>;
