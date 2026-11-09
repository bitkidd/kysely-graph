import type {
  CallbackSelection,
  ComparisonOperatorExpression,
  ExpressionOrFactory,
  JoinCallbackExpression,
  JoinReferenceExpression,
  OperandValueExpressionOrList,
  OrderByExpression,
  OrderByModifiers,
  ReferenceExpression,
  Selectable,
  SelectCallback,
  SelectExpression,
  Selection,
  SelectQueryBuilder,
  SelectQueryBuilderWithInnerJoin,
  SqlBool,
  TableExpression,
  ValueExpression,
} from 'kysely';

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

type NestedValue<T, Native extends boolean> = Native extends true ? T : JsonValue<T>;
type ChildResult<
  DB,
  S extends GraphSchema,
  R extends AnyRelation,
  V,
  Native extends boolean,
> = GraphRow<
  DB,
  S,
  Target<DB, R>,
  NestedValue<SelectedRow<Selectable<DB[Target<DB, R>]>, V>, Native>,
  ChildWith<V>,
  true,
  Native
>;
type RelationResult<
  DB,
  S extends GraphSchema,
  R extends AnyRelation,
  V,
  Native extends boolean,
> = R['kind'] extends 'hasMany' | 'manyToMany'
  ? ChildResult<DB, S, R, V, Native>[]
  : ChildResult<DB, S, R, V, Native> | null;
export type GraphRow<
  DB,
  S extends GraphSchema,
  T extends Table<DB>,
  Row,
  W,
  Nested extends boolean = false,
  Native extends boolean = false,
> = Simplify<
  Omit<Row, keyof W> & {
    -readonly [N in keyof W]: N extends keyof FieldsAt<S, T>
      ? FieldsAt<S, T>[N] extends Computed<string, never, infer V>
        ? Nested extends true
          ? NestedValue<V, Native>
          : V
        : FieldsAt<S, T>[N] extends AnyRelation
          ? RelationResult<DB, S, FieldsAt<S, T>[N], W[N], Native>
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
type FlatFrom<B> =
  B extends SelectQueryBuilder<infer DB, infer T, infer O>
    ? FlatQueryBuilder<DB, Extract<T, Table<DB>>, O>
    : never;

/** Root query controls for a graph that is assembled across multiple SQL statements. */
export interface FlatQueryBuilder<DB, T extends Table<DB>, O> extends Pick<
  SelectQueryBuilder<DB, T, O>,
  'execute' | 'executeTakeFirst' | 'executeTakeFirstOrThrow'
> {
  select<SE extends SelectExpression<DB, T>>(
    selections: ReadonlyArray<SE>,
  ): FlatQueryBuilder<DB, T, O & Selection<DB, T, SE>>;
  select<const CB extends SelectCallback<DB, T>>(
    callback: CB,
  ): FlatQueryBuilder<DB, T, O & CallbackSelection<DB, T, CB>>;
  select<SE extends SelectExpression<DB, T>>(
    selection: SE,
  ): FlatQueryBuilder<DB, T, O & Selection<DB, T, SE>>;
  innerJoin<
    TE extends TableExpression<DB, T>,
    K1 extends JoinReferenceExpression<DB, T, TE>,
    K2 extends JoinReferenceExpression<DB, T, TE>,
  >(
    table: TE,
    left: K1,
    right: K2,
  ): FlatFrom<SelectQueryBuilderWithInnerJoin<DB, T, O, TE>>;
  innerJoin<TE extends TableExpression<DB, T>, const FN extends JoinCallbackExpression<DB, T, TE>>(
    table: TE,
    callback: FN,
  ): FlatFrom<SelectQueryBuilderWithInnerJoin<DB, T, O, TE>>;
  where<RE extends ReferenceExpression<DB, T>, VE extends OperandValueExpressionOrList<DB, T, RE>>(
    lhs: RE,
    op: ComparisonOperatorExpression,
    rhs: VE,
  ): FlatQueryBuilder<DB, T, O>;
  where<E extends ExpressionOrFactory<DB, T, SqlBool>>(expression: E): FlatQueryBuilder<DB, T, O>;
  whereRef<LRE extends ReferenceExpression<DB, T>, RRE extends ReferenceExpression<DB, T>>(
    lhs: LRE,
    op: ComparisonOperatorExpression,
    rhs: RRE,
  ): FlatQueryBuilder<DB, T, O>;
  orderBy<OE extends OrderByExpression<DB, T, {}>>(
    expr: OE,
    modifiers?: OrderByModifiers,
  ): FlatQueryBuilder<DB, T, O>;
  limit<VE extends ValueExpression<DB, T, number | bigint | null>>(
    limit: VE,
  ): FlatQueryBuilder<DB, T, O>;
  offset<VE extends ValueExpression<DB, T, number | bigint>>(
    offset: VE,
  ): FlatQueryBuilder<DB, T, O>;
  clearWhere(): FlatQueryBuilder<DB, T, O>;
  clearOrderBy(): FlatQueryBuilder<DB, T, O>;
  clearLimit(): FlatQueryBuilder<DB, T, O>;
  clearOffset(): FlatQueryBuilder<DB, T, O>;
}

type GraphQuery<DB, T extends Table<DB>, O, Native extends boolean> = true extends Native
  ? FlatQueryBuilder<DB, T, O>
  : SelectQueryBuilder<DB, T, O>;

export interface Graph<DB, S extends GraphSchema, Native extends boolean = true> {
  query<
    T extends Table<DB>,
    const W extends WithGraph<DB, S, T>,
    const C extends readonly Extract<keyof Selectable<DB[T]>, string>[] | undefined = undefined,
  >(args: {
    table: T;
    with: W & ExactWith<S, T, W>;
    select?: C;
  }): GraphQuery<
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
      W,
      false,
      Native
    >,
    Native
  >;
}
export type GraphStrategy = 'flat' | 'single';

export interface GraphConfig<Strategy extends GraphStrategy = GraphStrategy> {
  readonly onDiagnostic?: (event: GraphDiagnostic) => void | Promise<void>;
  /** Reject statements exceeding this parameter budget. Defaults to 30000. */
  readonly maxParameters?: number;
  /** Maximum number of distinct parent keys per relation query. Defaults to 500. */
  readonly chunkSize?: number;
  /** Maximum in-flight statements per graph instance. Defaults to 4, or 1 in a transaction. */
  readonly concurrency?: number;
  /** Defaults to flat, with driver-decoded relation rows. Use single for composable SQL. */
  readonly strategy?: Strategy;
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
    /** Rows returned by this statement. */
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
