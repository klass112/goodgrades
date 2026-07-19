import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AuthService } from '../auth/service.js'
import type { Database } from '../db/client.js'
import { createTestAuth, createTestDatabase } from '../test-support/harness.js'
import { withTenant } from './with-tenant.js'

/**
 * The isolation suite. This is the test the whole tenancy design exists to pass.
 *
 * Everything here goes through `withTenant`, the same path handlers use — no
 * mocks, no stubs. The database under test is real Postgres (PGlite), so the
 * row-level security being exercised is the same implementation that runs in
 * production.
 */
describe('tenant isolation', () => {
  let db: Database
  let auth: AuthService
  let acme: { orgId: string; userId: string }
  let globex: { orgId: string; userId: string }

  beforeEach(async () => {
    db = await createTestDatabase()
    auth = createTestAuth(db)

    const a = await auth.signup({
      email: 'owner@acme.test',
      password: 'correct-horse-battery',
      organizationName: 'Acme',
    })
    const g = await auth.signup({
      email: 'owner@globex.test',
      password: 'correct-horse-battery',
      organizationName: 'Globex',
    })

    acme = { orgId: a.organization.id, userId: a.user.id }
    globex = { orgId: g.organization.id, userId: g.user.id }
  })

  afterEach(async () => {
    await db.close()
  })

  it('shows each tenant only its own organization', async () => {
    const seenByAcme = await withTenant(
      db,
      acme.orgId,
      async (tx) =>
        (await tx.query<{ id: string; name: string }>('SELECT id, name FROM organizations')).rows,
    )

    expect(seenByAcme).toEqual([{ id: acme.orgId, name: 'Acme' }])
  })

  it('returns nothing when one tenant asks for another tenant by primary key', async () => {
    // The adversarial case: the handler is not merely forgetting a filter, it is
    // actively naming the other tenant's id. RLS still refuses.
    const stolen = await withTenant(
      db,
      acme.orgId,
      async (tx) =>
        (await tx.query('SELECT id, name FROM organizations WHERE id = $1', [globex.orgId])).rows,
    )

    expect(stolen).toEqual([])
  })

  it('hides other tenants members from an unfiltered query', async () => {
    // No WHERE clause at all -- exactly the mistake tenancy-in-handlers lets slip
    // through, and the reason this design pushes it into the database.
    const members = await withTenant(
      db,
      acme.orgId,
      async (tx) =>
        (
          await tx.query<{ email: string }>(
            'SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id',
          )
        ).rows,
    )

    expect(members).toEqual([{ email: 'owner@acme.test' }])
    expect(members.map((m) => m.email)).not.toContain('owner@globex.test')
  })

  it('hides other tenants users even when queried directly', async () => {
    const users = await withTenant(
      db,
      acme.orgId,
      async (tx) =>
        (await tx.query('SELECT id, email FROM users WHERE id = $1', [globex.userId])).rows,
    )

    expect(users).toEqual([])
  })

  it('hides other tenants sessions', async () => {
    const sessions = await withTenant(
      db,
      acme.orgId,
      async (tx) => (await tx.query('SELECT id FROM sessions')).rows,
    )

    // Acme's own signup session, and only that one -- Globex also has one.
    expect(sessions).toHaveLength(1)
  })

  it('refuses to write a row belonging to another tenant', async () => {
    // WITH CHECK is the write-side half of the policy. Without it a tenant could
    // not read another's data but could still forge rows into it.
    await expect(
      withTenant(db, acme.orgId, async (tx) =>
        tx.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [
          globex.orgId,
          acme.userId,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('cannot escalate by updating another tenants row', async () => {
    const updated = await withTenant(
      db,
      acme.orgId,
      async (tx) =>
        (
          await tx.query('UPDATE organizations SET name = $1 WHERE id = $2 RETURNING id', [
            'Pwned',
            globex.orgId,
          ])
        ).rows,
    )

    expect(updated).toEqual([])

    const stillNamed = await withTenant(
      db,
      globex.orgId,
      async (tx) =>
        (await tx.query<{ name: string }>('SELECT name FROM organizations')).rows[0]?.name,
    )
    expect(stillNamed).toBe('Globex')
  })

  it('fails closed when no tenant context is set', async () => {
    // If a future code path reaches the app_user role without going through
    // withTenant, `current_setting` is NULL, every policy compares against NULL,
    // and the answer is zero rows rather than every row.
    const rows = await db.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE app_user')
      return (await tx.query('SELECT id FROM organizations')).rows
    })

    expect(rows).toEqual([])
  })

  it('does not let a tenant context leak into the next transaction', async () => {
    await withTenant(db, acme.orgId, async (tx) => tx.query('SELECT 1'))

    const leaked = await db.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE app_user')
      return (await tx.query('SELECT id FROM organizations')).rows
    })

    expect(leaked).toEqual([])
  })

  /**
   * A guard for the code that does not exist yet.
   *
   * Every future table carrying an org_id has to opt into RLS, and nothing in
   * the type system or the review process forces that. This asserts it for the
   * whole schema, so the migration that forgets fails here rather than in
   * production. FORCE matters as much as ENABLE: without it the policies are
   * skipped for the table's owner.
   */
  it('has RLS enabled and forced on every org-scoped table', async () => {
    const unprotected = await db.query<{ tablename: string }>(`
      SELECT c.relname AS tablename
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
         AND EXISTS (
           SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped
         )
         AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
    `)

    expect(unprotected.rows).toEqual([])
  })
})
