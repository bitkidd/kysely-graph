import type { Kysely } from 'kysely';

import { createGraph, defineGraph } from '../src/index.js';

export interface DB {
  users: { id: number; name: string; padding: string };
  profiles: { id: number; user_id: number; bio: string };
  posts: { id: number; user_id: number; title: string; padding: string };
  comments: { id: number; post_id: number; body: string };
  replies: { id: number; comment_id: number; body: string };
  reactions: { id: number; reply_id: number; kind: string };
  tags: { id: number; label: string };
  post_tags: { post_id: number; tag_id: number };
}
export const relations = defineGraph<DB>()(({ hasMany, hasOne, manyToMany }) => ({
  users: {
    profile: hasOne('profiles', { foreignKey: 'user_id' }),
    posts: hasMany('posts', { foreignKey: 'user_id' }),
  },
  posts: {
    comments: hasMany('comments', { foreignKey: 'post_id' }),
    tags: manyToMany('tags', { through: 'post_tags', sourceKey: 'post_id', targetKey: 'tag_id' }),
  },
  comments: { replies: hasMany('replies', { foreignKey: 'comment_id' }) },
  replies: { reactions: hasMany('reactions', { foreignKey: 'reply_id' }) },
}));
/** The current public API fetches roots and the complete graph in one query. */
export function graphMethod(db: Kysely<DB>) {
  const r = createGraph(db, relations);
  return async (count: number, depth: 1 | 4): Promise<unknown[]> => {
    if (depth === 1)
      return r
        .query({
          table: 'users',
          with: { profile: true, posts: { query: (qb) => qb.orderBy('id') } },
        })
        .where('users.id', '<=', count)
        .orderBy('users.id')
        .execute();
    return r
      .query({
        table: 'users',
        with: {
          profile: true,
          posts: {
            query: (qb) => qb.orderBy('id'),
            with: {
              tags: { query: (qb) => qb.orderBy('id') },
              comments: {
                query: (qb) => qb.orderBy('id'),
                with: {
                  replies: {
                    query: (qb) => qb.orderBy('id'),
                    with: { reactions: { query: (qb) => qb.orderBy('id') } },
                  },
                },
              },
            },
          },
        },
      })
      .where('users.id', '<=', count)
      .orderBy('users.id')
      .execute();
  };
}
/** Indexed correlated subqueries, equivalent to common ORM nested JSON SQL. */
export function correlatedSQL(depth: 1 | 4): string {
  const reactions = `coalesce((select json_agg(row_to_json(a) order by a.id) from reactions a where a.reply_id=r.id),'[]'::json)`;
  const replies = `coalesce((select json_agg(row_to_json(x) order by x.id) from (select r.*, ${reactions} as reactions from replies r where r.comment_id=c.id) x),'[]'::json)`;
  const comments = `coalesce((select json_agg(row_to_json(x) order by x.id) from (select c.*, ${replies} as replies from comments c where c.post_id=p.id) x),'[]'::json)`;
  const tags = `coalesce((select json_agg(row_to_json(t) order by t.id) from tags t join post_tags pt on pt.tag_id=t.id where pt.post_id=p.id),'[]'::json)`;
  const posts = `coalesce((select json_agg(row_to_json(x) order by x.id) from (select p.* ${depth === 4 ? `, ${comments} as comments, ${tags} as tags` : ''} from posts p where p.user_id=u.id) x),'[]'::json)`;
  return `select u.*, row_to_json(pr) as profile, ${posts} as posts from users u left join profiles pr on pr.user_id=u.id where u.id <= $1 order by u.id`;
}

/** Set-based preaggregation avoids repeated correlated execution and row explosion. */
export function aggregatedSQL(depth: 1 | 4): string {
  const ctes = [
    'selected_users as materialized (select * from users where id <= $1)',
    'selected_posts as materialized (select p.* from posts p join selected_users u on u.id=p.user_id)',
  ];
  if (depth === 4)
    ctes.push(
      'selected_comments as materialized (select c.* from comments c join selected_posts p on p.id=c.post_id)',
      'selected_replies as materialized (select r.* from replies r join selected_comments c on c.id=r.comment_id)',
      `reaction_groups as (select a.reply_id, json_agg(row_to_json(a) order by a.id) as reactions from reactions a join selected_replies r on r.id=a.reply_id group by a.reply_id)`,
      `reply_groups as (select x.comment_id,json_agg(row_to_json(x) order by x.id) as replies from (select r.*,coalesce(a.reactions,'[]'::json) as reactions from selected_replies r left join reaction_groups a on a.reply_id=r.id) x group by x.comment_id)`,
      `comment_groups as (select x.post_id,json_agg(row_to_json(x) order by x.id) as comments from (select c.*,coalesce(r.replies,'[]'::json) as replies from selected_comments c left join reply_groups r on r.comment_id=c.id) x group by x.post_id)`,
      `tag_groups as (select pt.post_id,json_agg(row_to_json(t) order by t.id) as tags from post_tags pt join selected_posts p on p.id=pt.post_id join tags t on t.id=pt.tag_id group by pt.post_id)`,
    );
  ctes.push(
    `post_groups as (select x.user_id,json_agg(row_to_json(x) order by x.id) as posts from (select p.* ${depth === 4 ? `,coalesce(c.comments,'[]'::json) as comments,coalesce(t.tags,'[]'::json) as tags` : ''} from selected_posts p ${depth === 4 ? 'left join comment_groups c on c.post_id=p.id left join tag_groups t on t.post_id=p.id' : ''}) x group by x.user_id)`,
  );
  return `with ${ctes.join(',\n')} select u.*, row_to_json(pr) as profile, coalesce(p.posts,'[]'::json) as posts from selected_users u left join profiles pr on pr.user_id=u.id left join post_groups p on p.user_id=u.id order by u.id`;
}
