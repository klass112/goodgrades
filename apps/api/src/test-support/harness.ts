import { createAuthService } from '../auth/service.js'
import type { Database } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { pgliteDatabase } from '../db/pglite.js'

/**
 * A migrated, empty database per call. In-memory PGlite, so tests are isolated
 * from each other by construction and need no teardown beyond `close()`.
 */
export async function createTestDatabase(): Promise<Database> {
  const db = pgliteDatabase()
  await migrate(db)
  return db
}

/**
 * Real hashing, minimum cost. 600k PBKDF2 iterations is the right number in
 * production and pure waste in a test — it would add minutes across the suite
 * while proving nothing the algorithm does not already guarantee. Correctness of
 * the parameters themselves is covered directly in password.test.ts.
 */
export const TEST_HASH_OPTIONS = { iterations: 1 }

export interface TestClock {
  now: () => Date
  advance: (ms: number) => void
}

/** Lets session-expiry tests move time instead of waiting a week for it. */
export function testClock(start = new Date('2026-07-19T12:00:00.000Z')): TestClock {
  let current = start.getTime()
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms
    },
  }
}

export function createTestAuth(db: Database, clock?: TestClock) {
  return createAuthService(db, { hashOptions: TEST_HASH_OPTIONS, now: clock?.now })
}
