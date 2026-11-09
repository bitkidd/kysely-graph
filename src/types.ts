import type { Selectable, SelectQueryBuilder } from 'kysely';

import type { AnyComputed, AnyRelation, Computed, GraphSchema } from './schema.js';

export type Table<DB> = Extract<keyof DB, string>;
type FieldsAt<S, T extends PropertyKey> = T extends keyof S ? S[T] : {};
type Target<DB, R extends AnyRelation> = Extract<R['target'], Table<DB>>;
export type RelationQuery<DB, T extends Table<DB>> = SelectQueryBuilder<DB, T, Selectable<DB[T]>>;
type ThroughTable<DB, R extends AnyRelation> = R extends { options: { through: infer T } }
  ? Extract<T, Table<DB>>
  : never;
export type RelationOptions<DB, S extends GraphSchema, R extends AnyRelation> = {
  /** Target columns exposed in results; omitted selects all. Keys needed for loading stay internal. */
  readonly select?: readonly Extract<keyof Selectable<DB[Target<DB, R>]>, string>[];
  readonly query?: (qb: RelationQuery<DB, Target<DB, R>>) => RelationQuery<DB, Target<DB, R>>;
  readonly with?: WithGraph<DB, S, Target<DB, R>>;
} & (R['kind'] extends 'manyToMany'
  ? {
      readonly through?: (
        qb: RelationQuery<DB, ThroughTable<DB, R>>,
      ) => RelationQuery<DB, ThroughTable<DB, R>>;
    }
  : { readonly through?: never });
type ComputedRequest<A extends object> = [A] extends [never]
  ? true
  : { readonly args: A } | ({} extends A ? true : never);
export type WithGraph<DB, S extends GraphSchema, T extends Table<DB>> = {
  readonly [N in keyof FieldsAt<S, T>]?: FieldsAt<S, T>[N] extends Computed<
    string,
    infer A,
    unknown
  >
    ? ComputedRequest<A>
    : FieldsAt<S, T>[N] extends AnyRelation
      ? true | RelationOptions<DB, S, FieldsAt<S, T>[N]>
      : never;
};
type ChildWith<V> = V extends { readonly with: infer W } ? W : {};
type Simplify<T> = { [P in keyof T]: T[P] };
export type SelectedRow<Row, V> = V extends {
  readonly select: infer C extends readonly (keyof Row)[];
}
  ? number extends C['length']
    ? Partial<Pick<Row, C[number]>>
    : Pick<Row, C[number]>
  : 'select' extends keyof V
    ? Partial<Row>
    : Row;
/** Nested PostgreSQL JSON values use JSON decoding, not pg scalar parsers. */
export type JsonValue<T> = T extends Date
  ? string
  : T extends bigint
    ? number
    : T extends Uint8Array
      ? string
      : T extends readonly (infer E)[]
        ? JsonValue<E>[]
        : T extends object
          ? { [K in keyof T]: JsonValue<T[K]> }
          : T;

type ChildResult<DB, S extends GraphSchema, R extends AnyRelation, V> = GraphRow<
  DB,
  S,
  Target<DB, R>,
  JsonValue<SelectedRow<Selectable<DB[Target<DB, R>]>, V>>,
  ChildWith<V>,
  true
>;
type RelationResult<DB, S extends GraphSchema, R extends AnyRelation, V> = R['kind'] extends
  | 'hasMany'
  | 'manyToMany'
  ? ChildResult<DB, S, R, V>[]
  : ChildResult<DB, S, R, V> | null;
export type GraphRow<
  DB,
  S extends GraphSchema,
  T extends Table<DB>,
  Row,
  W,
  Nested extends boolean = false,
> = Simplify<
  Omit<Row, keyof W> & {
    -readonly [N in keyof W]: N extends keyof FieldsAt<S, T>
      ? FieldsAt<S, T>[N] extends Computed<string, never, infer V>
        ? Nested extends true
          ? JsonValue<V>
          : V
        : FieldsAt<S, T>[N] extends AnyRelation
          ? RelationResult<DB, S, FieldsAt<S, T>[N], W[N]>
          : never
      : never;
  }
>;

// This recursive check also rejects unknown field names on non-literal values.
export type ExactWith<S, T extends PropertyKey, W> = {
  [N in keyof W]: N extends keyof FieldsAt<S, T>
    ? FieldsAt<S, T>[N] extends AnyComputed
      ? W[N] extends { readonly args: object }
        ? W[N] & { [K in Exclude<keyof W[N], 'args'>]: never }
        : W[N]
      : W[N] extends { readonly with: infer CW }
        ? FieldsAt<S, T>[N] extends AnyRelation
          ? W[N] & { readonly with: ExactWith<S, FieldsAt<S, T>[N]['target'], CW> }
          : never
        : W[N]
    : never;
};
export interface Graph<DB, S extends GraphSchema> {
  query<
    T extends Table<DB>,
    const W extends WithGraph<DB, S, T>,
    const C extends readonly Extract<keyof Selectable<DB[T]>, string>[] | undefined = undefined,
  >(args: {
    table: T;
    with: W & ExactWith<S, T, W>;
    select?: C;
  }): SelectQueryBuilder<
    DB,
    T,
    GraphRow<
      DB,
      S,
      T,
      C extends readonly (keyof Selectable<DB[T]>)[]
        ? number extends C['length']
          ? Partial<Pick<Selectable<DB[T]>, C[number]>>
          : Pick<Selectable<DB[T]>, C[number]>
        : Selectable<DB[T]>,
      W
    >
  >;
}
export interface GraphConfig {
  readonly onDiagnostic?: (event: GraphDiagnostic) => void | Promise<void>;
  /** Reject statements exceeding this parameter budget. Defaults to 30000. */
  readonly maxParameters?: number;
}

type DiagnosticResult =
  | { readonly status: 'success' }
  | { readonly status: 'error'; readonly error: unknown };
export type QueryDiagnostic = Readonly<
  {
    type: 'query';
    executionId: number;
    table: string;
    relationPaths: readonly (readonly string[])[];
    /** Root rows returned by the single statement, not nested JSON object count. */
    rowsFetched: number;
    durationMs: number;
  } & DiagnosticResult
>;
export type ExecutionDiagnostic = Readonly<
  {
    type: 'execution';
    executionId: number;
    table: string;
    queryCount: number;
    rowsFetched: number;
    durationMs: number;
  } & DiagnosticResult
>;
export type GraphDiagnostic = QueryDiagnostic | ExecutionDiagnostic;
