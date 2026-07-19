/**
 * The database seam.
 *
 * Everything above this file talks Postgres SQL and nothing else — no driver
 * types leak upward. That matters because the API runtime is still an open
 * decision (docs/decisions/0002-hosting.md): Neon, Supabase, and Hyperdrive are
 * all "some Postgres" behind different transports, and this interface is the
 * whole of what they have to satisfy.
 */

export interface QueryResult<T> {
  rows: T[]
}

/** Anything you can run a statement against: a pool, a connection, or a transaction. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>
}

export interface Database extends Queryable {
  /**
   * Runs `fn` inside a single transaction on a single connection.
   *
   * Single-connection is not an implementation detail here — it is the
   * contract. Tenant scoping works by setting a transaction-local variable
   * (`SET LOCAL`), so if a statement escaped to a different pooled connection
   * it would run with no org set. Fails closed rather than open, but it would
   * still be a bug, and this signature is what prevents it.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>

  /**
   * Runs a multi-statement script with no parameters. Migrations only — the
   * extended query protocol that `query` uses accepts exactly one statement,
   * and a schema file is many.
   */
  exec(sql: string): Promise<void>

  close(): Promise<void>
}
