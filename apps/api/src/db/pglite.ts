import { PGlite } from '@electric-sql/pglite'
import type { Database, QueryResult, Queryable } from './client.js'

/**
 * PGlite adapter — real Postgres compiled to WASM, running in-process.
 *
 * This is the test and local-dev database. It is *not* the production one:
 * PGlite is single-connection and single-process. It earns its place because it
 * is genuinely Postgres — the same planner, the same dialect, and crucially the
 * same row-level security implementation — so the isolation tests exercise the
 * real mechanism rather than a mock of it. Tests need no Docker and no service
 * container, which is why CI can prove tenant isolation on a plain runner.
 */
export function pgliteDatabase(dataDir?: string): Database {
  const pg = new PGlite(dataDir)

  const wrap = (client: { query: PGlite['query'] }): Queryable => ({
    async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      const result = await client.query<T>(sql, params as unknown[] | undefined)
      return { rows: result.rows }
    },
  })

  return {
    query: (sql, params) => wrap(pg).query(sql, params),
    transaction: (fn) =>
      pg.transaction(async (tx) => fn(wrap(tx as unknown as { query: PGlite['query'] }))),
    exec: async (sql) => {
      await pg.exec(sql)
    },
    close: () => pg.close(),
  } as Database
}
