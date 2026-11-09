import { PGlite } from '@electric-sql/pglite';
import {
  type CompiledQuery,
  type DatabaseConnection,
  DummyDriver,
  Kysely,
  PostgresDialect,
  type QueryResult,
  sql,
  type TransactionSettings,
} from 'kysely';
import { Pool } from 'pg';

import { defineGraph } from '../src/index.js';

export interface DB {
  users: { id: number; name: string; active: boolean };
  posts: {
    id: number;
    authorId: number | null;
    title: string;
    published: boolean;
    createdAt: number;
  };
  profiles: { id: number; userId: number; bio: string };
  comments: { id: number; postId: number; approved: boolean };
  tags: { id: number; label: string };
  postTags: { postId: number; tagId: number; visible: boolean };
  tenants: { tenant: string; code: string; title: string };
  items: { itemCode: number; tenant: string | null; parentCode: string | null; score: number };
  itemTags: { tenant: string; parentCode: string; tagId: number; visible: boolean };
}
export const relations = defineGraph<DB>()(({ belongsTo, hasMany, hasOne, manyToMany }) => ({
  users: {
    posts: hasMany('posts', { foreignKey: 'authorId' }),
    profile: hasOne('profiles', { foreignKey: 'userId' }),
  },
  posts: {
    author: belongsTo('users', { foreignKey: 'authorId' }),
    comments: hasMany('comments', { foreignKey: 'postId' }),
    tags: manyToMany('tags', { through: 'postTags', sourceKey: 'postId', targetKey: 'tagId' }),
  },
  tenants: {
    items: hasMany('items', {
      sourceKey: ['tenant', 'code'],
      foreignKey: ['tenant', 'parentCode'],
      targetKey: 'itemCode',
    }),
    tags: manyToMany('tags', {
      through: 'itemTags',
      sourcePrimaryKey: ['tenant', 'code'],
      sourceKey: ['tenant', 'parentCode'],
      targetKey: 'tagId',
    }),
  },
  items: {
    parent: belongsTo('tenants', {
      foreignKey: ['tenant', 'parentCode'],
      targetKey: ['tenant', 'code'],
    }),
  },
}));
class PGliteConnection implements DatabaseConnection {
  constructor(private readonly engine: PGlite) {}
  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.engine.query<R>(query.sql, [...query.parameters]);
    return { rows: result.rows, numAffectedRows: BigInt(result.affectedRows ?? 0) };
  }
  // oxlint-disable-next-line require-yield -- Required driver API; streaming is deliberately unsupported.
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('Test driver does not stream');
  }
}
class PGliteDriver extends DummyDriver {
  private readonly connection: PGliteConnection;
  constructor(private readonly engine: PGlite) {
    super();
    this.connection = new PGliteConnection(engine);
  }
  override async acquireConnection() {
    return this.connection;
  }
  override async beginTransaction(
    _connection?: DatabaseConnection,
    settings: TransactionSettings = {},
  ) {
    const isolation = settings.isolationLevel ? ` isolation level ${settings.isolationLevel}` : '';
    await this.engine.exec(`begin${isolation}`);
  }
  override async commitTransaction() {
    await this.engine.exec('commit');
  }
  override async rollbackTransaction() {
    await this.engine.exec('rollback');
  }
  override async destroy() {
    await this.engine.close();
  }
}
export async function fixture() {
  const queries: string[] = [];
  let dialect = new PostgresDialect({
    pool: new Pool({ connectionString: process.env.DATABASE_URL }),
  });
  if (!process.env.DATABASE_URL) {
    const engine = new PGlite();
    const postgres = dialect;
    dialect = Object.assign(Object.create(postgres) as PostgresDialect, {
      createDriver: () => new PGliteDriver(engine),
    });
  }
  const db = new Kysely<DB>({
    dialect,
    log: (e) => {
      if (e.level === 'query') queries.push(e.query.sql);
    },
  });
  // DATABASE_URL must point at a disposable database: fixtures reset public tables.
  for (const table of [
    'itemTags',
    'items',
    'tenants',
    'postTags',
    'comments',
    'profiles',
    'posts',
    'tags',
    'users',
  ]) {
    await db.schema.dropTable(table).ifExists().cascade().execute();
  }
  const ddl = [
    'create table users (id integer primary key, name text not null, active boolean not null)',
    'create table posts (id integer primary key, "authorId" integer, title text not null, published boolean not null, "createdAt" integer not null)',
    'create table profiles (id integer primary key, "userId" integer not null, bio text not null)',
    'create table comments (id integer primary key, "postId" integer not null, approved boolean not null)',
    'create table tags (id integer primary key, label text not null)',
    'create table "postTags" ("postId" integer not null, "tagId" integer not null, visible boolean not null)',
    'create table tenants (tenant text not null, code text not null, title text not null, primary key (tenant, code))',
    'create table items ("itemCode" integer primary key, tenant text, "parentCode" text, score integer not null)',
    'create table "itemTags" (tenant text not null, "parentCode" text not null, "tagId" integer not null, visible boolean not null)',
  ];
  for (const statement of ddl) await sql.raw(statement).execute(db);
  await db
    .insertInto('users')
    .values([
      { id: 1, name: 'Ada', active: true },
      { id: 2, name: 'Lin', active: true },
      { id: 3, name: 'No posts', active: false },
    ])
    .execute();
  await db
    .insertInto('posts')
    .values([
      { id: 10, authorId: 1, title: 'A', published: true, createdAt: 3 },
      { id: 11, authorId: 1, title: 'B', published: true, createdAt: 3 },
      { id: 12, authorId: 1, title: 'C', published: false, createdAt: 5 },
      { id: 20, authorId: 2, title: 'D', published: true, createdAt: 2 },
      { id: 21, authorId: 2, title: 'E', published: true, createdAt: 1 },
      { id: 30, authorId: null, title: 'Orphan', published: true, createdAt: 9 },
    ])
    .execute();
  await db.insertInto('profiles').values({ id: 1, userId: 1, bio: 'Hello' }).execute();
  await db
    .insertInto('comments')
    .values([
      { id: 100, postId: 10, approved: true },
      { id: 101, postId: 11, approved: false },
      { id: 102, postId: 20, approved: true },
    ])
    .execute();
  await db
    .insertInto('tags')
    .values([
      { id: 1, label: 'typescript' },
      { id: 2, label: 'sql' },
      { id: 3, label: 'web' },
    ])
    .execute();
  await db
    .insertInto('postTags')
    .values([
      { postId: 10, tagId: 1, visible: true },
      { postId: 10, tagId: 1, visible: true },
      { postId: 10, tagId: 2, visible: true },
      { postId: 10, tagId: 3, visible: false },
      { postId: 11, tagId: 2, visible: true },
      { postId: 20, tagId: 3, visible: true },
      { postId: 20, tagId: 2, visible: true },
    ])
    .execute();
  await db
    .insertInto('tenants')
    .values([
      { tenant: 'a|b', code: 'c', title: 'one' },
      { tenant: 'a', code: 'b|c', title: 'two' },
    ])
    .execute();
  await db
    .insertInto('items')
    .values([
      { itemCode: 1, tenant: 'a|b', parentCode: 'c', score: 5 },
      { itemCode: 2, tenant: 'a|b', parentCode: 'c', score: 5 },
      { itemCode: 3, tenant: 'a', parentCode: 'b|c', score: 8 },
      { itemCode: 4, tenant: null, parentCode: 'c', score: 0 },
    ])
    .execute();
  await db
    .insertInto('itemTags')
    .values([
      { tenant: 'a|b', parentCode: 'c', tagId: 1, visible: true },
      { tenant: 'a', parentCode: 'b|c', tagId: 2, visible: true },
    ])
    .execute();
  queries.length = 0;
  return { db, queries };
}
