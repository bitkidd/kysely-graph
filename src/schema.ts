import type { Expression, ExpressionBuilder, Selectable } from 'kysely';

import type { RelationQuery, Table } from './types.js';

export type Keys = string | readonly [string, ...string[]];
type StoredQuery = (qb: never) => unknown;
interface DefinitionOptions {
  readonly query?: StoredQuery;
}
export interface HasOptions extends DefinitionOptions {
  readonly foreignKey: Keys;
  readonly sourceKey?: Keys;
  readonly targetKey?: Keys;
}
export interface BelongsOptions extends DefinitionOptions {
  readonly foreignKey: Keys;
  readonly targetKey?: Keys;
}
export interface ManyOptions extends DefinitionOptions {
  readonly through: string;
  readonly throughQuery?: StoredQuery;
  readonly sourceKey: Keys;
  readonly targetKey: Keys;
  readonly sourcePrimaryKey?: Keys;
  readonly targetPrimaryKey?: Keys;
}
export interface Relation<K extends string = string, T extends string = string, O = unknown> {
  readonly kind: K;
  readonly target: T;
  readonly options: O;
}
export type AnyRelation =
  | Relation<'hasOne' | 'hasMany', string, HasOptions>
  | Relation<'belongsTo', string, BelongsOptions>
  | Relation<'manyToMany', string, ManyOptions>;
// A bare select builder exposes a row type. $asScalar() exposes the selected value.
type ComputedExpression<V> = Expression<V> & { readonly isSelectQueryBuilder?: never };
export interface Computed<T extends string, A extends object, V> {
  readonly kind: 'computed';
  readonly table: T;
  readonly expression: (eb: never, args: A) => ComputedExpression<V>;
}
export type AnyComputed = Computed<string, never, unknown>;
export type Field = AnyRelation | AnyComputed;
export type GraphSchema = Readonly<Record<string, Readonly<Record<string, Field>>>>;

type DefinitionQuery<DB, T extends Table<DB>> = (qb: RelationQuery<DB, T>) => RelationQuery<DB, T>;
type DefinitionHelper<DB, K extends string, Options> = <
  const T extends Table<DB>,
  const O extends Options,
>(
  target: T,
  options: O & { readonly query?: DefinitionQuery<DB, NoInfer<T>> },
) => Relation<K, T, O>;
type SchemaHelpers<DB> = {
  hasMany: DefinitionHelper<DB, 'hasMany', HasOptions>;
  hasOne: DefinitionHelper<DB, 'hasOne', HasOptions>;
  belongsTo: DefinitionHelper<DB, 'belongsTo', BelongsOptions>;
  manyToMany<const T extends Table<DB>, const J extends Table<DB>, const O extends ManyOptions>(
    target: T,
    options: O & {
      readonly through: J;
      readonly query?: DefinitionQuery<DB, NoInfer<T>>;
      readonly throughQuery?: DefinitionQuery<DB, NoInfer<J>>;
    },
  ): Relation<'manyToMany', T, O & { readonly through: J }>;
  computed<const T extends Table<DB>, V, A extends object = never>(
    table: T,
    expression: (eb: ExpressionBuilder<DB, NoInfer<T>>, args: A) => ComputedExpression<V>,
  ): Computed<T, A, V>;
};

type Tuple<K> = K extends string ? readonly [K] : K;
type Option<O, K extends PropertyKey, D = 'id'> = K extends keyof O ? O[K] : D;
type Compatible<A, B> = [NonNullable<A>] extends [never]
  ? false
  : [NonNullable<B>] extends [never]
    ? false
    : [NonNullable<A>] extends [NonNullable<B>]
      ? true
      : [NonNullable<B>] extends [NonNullable<A>]
        ? true
        : false;
type Pair<DB, A extends keyof DB, AK, B extends keyof DB, BK> = AK extends readonly [
  infer AH,
  ...infer AT,
]
  ? BK extends readonly [infer BH, ...infer BT]
    ? AH extends keyof Selectable<DB[A]>
      ? BH extends keyof Selectable<DB[B]>
        ? Compatible<Selectable<DB[A]>[AH], Selectable<DB[B]>[BH]> extends true
          ? Pair<DB, A, AT, B, BT>
          : false
        : false
      : false
    : false
  : AK extends readonly []
    ? BK extends readonly []
      ? true
      : false
    : false;
type KeyPair<DB, A extends keyof DB, AK, B extends keyof DB, BK> = Pair<
  DB,
  A,
  Tuple<AK>,
  B,
  Tuple<BK>
>;
type ValidRelation<DB, A extends keyof DB, R extends AnyRelation> = R['target'] extends keyof DB
  ? R extends Relation<'hasOne' | 'hasMany', string, infer O extends HasOptions>
    ? KeyPair<DB, A, Option<O, 'sourceKey'>, R['target'], O['foreignKey']> extends true
      ? KeyPair<DB, R['target'], Option<O, 'targetKey'>, R['target'], Option<O, 'targetKey'>>
      : false
    : R extends Relation<'belongsTo', string, infer O extends BelongsOptions>
      ? KeyPair<DB, A, O['foreignKey'], R['target'], Option<O, 'targetKey'>>
      : R extends Relation<'manyToMany', string, infer O extends ManyOptions>
        ? O['through'] extends keyof DB
          ? KeyPair<DB, A, Option<O, 'sourcePrimaryKey'>, O['through'], O['sourceKey']> extends true
            ? KeyPair<DB, O['through'], O['targetKey'], R['target'], Option<O, 'targetPrimaryKey'>>
            : false
          : false
        : false
  : false;
type ValidateQueries<DB, R extends AnyRelation> = {
  readonly options: {
    readonly query?: DefinitionQuery<DB, Extract<R['target'], Table<DB>>>;
  } & (R extends Relation<'manyToMany', string, infer O extends ManyOptions>
    ? { readonly throughQuery?: DefinitionQuery<DB, Extract<O['through'], Table<DB>>> }
    : { readonly throughQuery?: never });
};
type ValidateField<DB, T extends keyof DB, N, F> = F extends AnyRelation
  ? ValidRelation<DB, T, F> extends true
    ? F & ValidateQueries<DB, F>
    : never
  : F extends AnyComputed
    ? F['table'] extends T
      ? N extends keyof Selectable<DB[T]>
        ? never
        : F
      : never
    : never;
type ValidateSchema<DB, S extends GraphSchema> = {
  [T in keyof S]: T extends keyof DB
    ? {
        [N in keyof S[T]]: ValidateField<DB, T, N, S[T][N]>;
      }
    : never;
};

/** Curried so DB is explicit while field names and key tuples stay inferred. */
export function defineGraph<DB>() {
  return <const S extends GraphSchema>(
    define: (helpers: SchemaHelpers<DB>) => S & ValidateSchema<DB, S>,
  ): S =>
    define({
      hasMany: (target, options) => ({ kind: 'hasMany', target, options }),
      hasOne: (target, options) => ({ kind: 'hasOne', target, options }),
      belongsTo: (target, options) => ({ kind: 'belongsTo', target, options }),
      manyToMany: (target, options) => ({ kind: 'manyToMany', target, options }),
      computed: (table, expression) => ({ kind: 'computed', table, expression }),
    });
}
