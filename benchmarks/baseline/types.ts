import type { Selectable, SelectQueryBuilder } from 'kysely';
import type { AnyRelation, RelationSchema } from './schema.js';

type Table<DB> = Extract<keyof DB, string>;
type RelationsAt<S, T extends PropertyKey> = T extends keyof S ? S[T] : {};
type Target<DB, R extends AnyRelation> = Extract<R['target'], Table<DB>>;
export type RelationQuery<DB, T extends Table<DB>> = SelectQueryBuilder<DB, T, Selectable<DB[T]>>;
type ThroughTable<DB, R extends AnyRelation> = R extends { options: { through: infer T } } ? Extract<T, Table<DB>> : never;
export type RelationOptions<DB, S extends RelationSchema, R extends AnyRelation> = {
  readonly query?: (qb: RelationQuery<DB, Target<DB, R>>) => RelationQuery<DB, Target<DB, R>>;
  readonly with?: WithRelations<DB, S, Target<DB, R>>;
} & (R['kind'] extends 'hasMany' | 'manyToMany' ? { readonly perParentLimit?: number } : { readonly perParentLimit?: never })
  & (R['kind'] extends 'manyToMany' ? {
    readonly through?: (qb: RelationQuery<DB, ThroughTable<DB, R>>) => RelationQuery<DB, ThroughTable<DB, R>>;
  } : { readonly through?: never });
export type WithRelations<DB, S extends RelationSchema, T extends Table<DB>> = {
  readonly [N in keyof RelationsAt<S, T>]?: RelationsAt<S, T>[N] extends AnyRelation
    ? true | RelationOptions<DB, S, RelationsAt<S, T>[N]> : never
};
type ChildWith<V> = V extends { readonly with: infer W } ? W : {};
type Simplify<T> = { [P in keyof T]: T[P] };
type ChildResult<DB, S extends RelationSchema, R extends AnyRelation, V> =
  LoadedRow<DB, S, Target<DB, R>, Selectable<DB[Target<DB, R>]>, ChildWith<V>>;
type RelationResult<DB, S extends RelationSchema, R extends AnyRelation, V> =
  R['kind'] extends 'hasMany' | 'manyToMany' ? ChildResult<DB, S, R, V>[] : ChildResult<DB, S, R, V> | null;
export type LoadedRow<DB, S extends RelationSchema, T extends Table<DB>, Row, W> = Simplify<
  Omit<Row, keyof W> & { -readonly [N in keyof W]: N extends keyof RelationsAt<S, T>
    ? RelationsAt<S, T>[N] extends AnyRelation ? RelationResult<DB, S, RelationsAt<S, T>[N], W[N]> : never : never }
>;
export type Loaded<DB, S extends RelationSchema, T extends Table<DB>, Data, W> =
  Data extends readonly (infer Row)[] ? LoadedRow<DB, S, T, Row, W>[] : LoadedRow<DB, S, T, Data, W>;

// This recursive check also rejects unknown relation names on non-literal values.
type ExactWith<S, T extends PropertyKey, W> = {
  [N in keyof W]: N extends keyof RelationsAt<S, T>
    ? W[N] extends { readonly with: infer CW }
      ? RelationsAt<S, T>[N] extends AnyRelation
        ? W[N] & { readonly with: ExactWith<S, RelationsAt<S, T>[N]['target'], CW> } : never
      : W[N]
    : never
};
export interface Loader<DB, S extends RelationSchema> {
  load<T extends Table<DB>, Data extends object | readonly object[], const W extends WithRelations<DB, S, T>>(args: {
    table: T; data: Data; with: W & ExactWith<S, T, W>;
  }): Promise<Loaded<DB, S, T, Data, W>>;
}
export interface LoaderConfig {
  /** Maximum in-flight relation queries per loader, across branches and calls.
   * Defaults to 4; transaction-bound loaders always use 1. Set 1 to disable parallel loading. */
  readonly concurrency?: number;
  /** Maximum parent tuples per query. Composite keys also obey maxParameters. */
  readonly chunkSize?: number;
  /** Total query parameter budget, including callback parameters and limit. */
  readonly maxParameters?: number;
}
