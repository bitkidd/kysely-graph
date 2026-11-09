import type { Pool } from 'pg';

export async function seed(pool: Pool, roots: number) {
  // Every run uses a fresh isolated schema; no application/test tables are touched.
  const statements = [
    'create table users(id integer primary key,name text not null,padding text not null)',
    'create table profiles(id integer primary key,user_id integer not null unique,bio text not null)',
    'create table posts(id integer primary key,user_id integer not null,title text not null,padding text not null)',
    'create table comments(id integer primary key,post_id integer not null,body text not null)',
    'create table replies(id integer primary key,comment_id integer not null,body text not null)',
    'create table reactions(id integer primary key,reply_id integer not null,kind text not null)',
    'create table tags(id integer primary key,label text not null)',
    'create table post_tags(post_id integer not null,tag_id integer not null,primary key(post_id,tag_id))',
    `insert into users select i,'User '||i,repeat('u',128) from generate_series(1,${roots}) i`,
    `insert into profiles select i,i,repeat('b',64) from generate_series(1,${roots}) i`,
    `insert into posts select i,((i-1)/4)+1,'Post '||i,repeat('p',128) from generate_series(1,${roots * 4}) i`,
    `insert into comments select i,((i-1)/4)+1,repeat('c',96) from generate_series(1,${roots * 16}) i`,
    `insert into replies select i,((i-1)/2)+1,repeat('r',64) from generate_series(1,${roots * 32}) i`,
    `insert into reactions select i,((i-1)/2)+1,'like' from generate_series(1,${roots * 64}) i`,
    `insert into tags select i,'tag-'||i from generate_series(1,32) i`,
    'insert into post_tags select p.id,((p.id+j)%32)+1 from posts p cross join generate_series(0,2) j',
    'create index on posts(user_id,id)',
    'create index on comments(post_id,id)',
    'create index on replies(comment_id,id)',
    'create index on reactions(reply_id,id)',
  ];
  for (const statement of statements) await pool.query(statement);
  for (const table of [
    'users',
    'profiles',
    'posts',
    'comments',
    'replies',
    'reactions',
    'tags',
    'post_tags',
  ])
    await pool.query(`analyze ${table}`);
}
