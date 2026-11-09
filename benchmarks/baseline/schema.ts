import type { Selectable } from 'kysely';

export type Keys = string | readonly [string, ...string[]];
export interface HasOptions { readonly foreignKey: Keys; readonly sourceKey?: Keys; readonly targetKey?: Keys }
export interface BelongsOptions { readonly foreignKey: Keys; readonly targetKey?: Keys }
export interface ManyOptions {
  readonly through: string;
  readonly sourceKey: Keys;
  readonly targetKey: Keys;
  readonly sourcePrimaryKey?: Keys;
  readonly targetPrimaryKey?: Keys;
}
export interface Relation<K extends string = string, T extends string = string, O = unknown> {
  readonly kind: K; readonly target: T; readonly options: O;
}
export type AnyRelation =
  | Relation<'hasOne' | 'hasMany', string, HasOptions>
  | Relation<'belongsTo', string, BelongsOptions>
  | Relation<'manyToMany', string, ManyOptions>;
export type RelationSchema = Readonly<Record<string, Readonly<Record<string, AnyRelation>>>>;

export function hasMany<const T extends string, const O extends HasOptions>(target: T, options: O): Relation<'hasMany', T, O> {
  return { kind: 'hasMany', target, options };
}
export function hasOne<const T extends string, const O extends HasOptions>(target: T, options: O): Relation<'hasOne', T, O> {
  return { kind: 'hasOne', target, options };
}
export function belongsTo<const T extends string, const O extends BelongsOptions>(target: T, options: O): Relation<'belongsTo', T, O> {
  return { kind: 'belongsTo', target, options };
}
export function manyToMany<const T extends string, const O extends ManyOptions>(target: T, options: O): Relation<'manyToMany', T, O> {
  return { kind: 'manyToMany', target, options };
}

type Tuple<K> = K extends string ? readonly [K] : K;
type Option<O, K extends PropertyKey, D = 'id'> = K extends keyof O ? O[K] : D;
type Compatible<A, B> = [NonNullable<A>] extends [never] ? false
  : [NonNullable<B>] extends [never] ? false
  : [NonNullable<A>] extends [NonNullable<B>] ? true
  : [NonNullable<B>] extends [NonNullable<A>] ? true : false;
type Pair<DB, A extends keyof DB, AK, B extends keyof DB, BK> =
  AK extends readonly [infer AH, ...infer AT]
    ? BK extends readonly [infer BH, ...infer BT]
      ? AH extends keyof Selectable<DB[A]> ? BH extends keyof Selectable<DB[B]>
        ? Compatible<Selectable<DB[A]>[AH], Selectable<DB[B]>[BH]> extends true
          ? Pair<DB, A, AT, B, BT> : false
        : false : false : false
    : AK extends readonly [] ? BK extends readonly [] ? true : false : false;
type KeyPair<DB, A extends keyof DB, AK, B extends keyof DB, BK> = Pair<DB, A, Tuple<AK>, B, Tuple<BK>>;
type ValidRelation<DB, A extends keyof DB, R extends AnyRelation> =
  R['target'] extends keyof DB
    ? R extends Relation<'hasOne' | 'hasMany', string, infer O extends HasOptions>
      ? KeyPair<DB, A, Option<O, 'sourceKey'>, R['target'], O['foreignKey']> extends true
        ? KeyPair<DB, R['target'], Option<O, 'targetKey'>, R['target'], Option<O, 'targetKey'>> : false
      : R extends Relation<'belongsTo', string, infer O extends BelongsOptions>
        ? KeyPair<DB, A, O['foreignKey'], R['target'], Option<O, 'targetKey'>>
        : R extends Relation<'manyToMany', string, infer O extends ManyOptions>
          ? O['through'] extends keyof DB
            ? KeyPair<DB, A, Option<O, 'sourcePrimaryKey'>, O['through'], O['sourceKey']> extends true
              ? KeyPair<DB, O['through'], O['targetKey'], R['target'], Option<O, 'targetPrimaryKey'>> : false
            : false : false
    : false;
type ValidateSchema<DB, S extends RelationSchema> = {
  [T in keyof S]: T extends keyof DB ? {
    [N in keyof S[T]]: ValidRelation<DB, T, S[T][N]> extends true ? S[T][N] : never
  } : never
};

/** Curried so DB is explicit while relation names and key tuples stay inferred. */
export function defineRelations<DB>() {
  return <const S extends RelationSchema>(schema: S & ValidateSchema<DB, S>): S => schema;
}
