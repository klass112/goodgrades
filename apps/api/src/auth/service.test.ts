import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../db/client.js'
import {
  type TestClock,
  createTestAuth,
  createTestDatabase,
  testClock,
} from '../test-support/harness.js'
import { AuthError, type AuthService, RESET_TTL_MS, SESSION_TTL_MS } from './service.js'

const PASSWORD = 'correct-horse-battery'

describe('auth service', () => {
  let db: Database
  let auth: AuthService
  let clock: TestClock

  beforeEach(async () => {
    db = await createTestDatabase()
    clock = testClock()
    auth = createTestAuth(db, clock)
  })

  afterEach(async () => {
    await db.close()
  })

  describe('signup', () => {
    it('creates a user, their workspace, and an owner membership in one go', async () => {
      const result = await auth.signup({
        email: 'Teacher@School.test',
        password: PASSWORD,
        organizationName: 'Springfield Elementary',
      })

      expect(result.user.email).toBe('teacher@school.test') // normalised on the way in
      expect(result.organization.name).toBe('Springfield Elementary')
      expect(result.organization.slug).toBe('springfield-elementary')
      expect(result.role).toBe('owner')
      expect(result.token).toBeTruthy()
    })

    it('gives a workspace a default name when none is offered', async () => {
      const result = await auth.signup({ email: 'solo@school.test', password: PASSWORD })
      expect(result.organization.name).toBe("solo's workspace")
    })

    it('rejects a duplicate email regardless of casing', async () => {
      await auth.signup({ email: 'dupe@school.test', password: PASSWORD })

      await expect(auth.signup({ email: 'DUPE@school.test', password: PASSWORD })).rejects.toThrow(
        new AuthError('email_taken', 'An account with that email already exists.'),
      )
    })

    it('rejects a short password', async () => {
      await expect(
        auth.signup({ email: 'weak@school.test', password: 'short' }),
      ).rejects.toMatchObject({ code: 'weak_password' })
    })

    it('rejects an implausible email', async () => {
      await expect(
        auth.signup({ email: 'not-an-email', password: PASSWORD }),
      ).rejects.toMatchObject({
        code: 'invalid_email',
      })
    })

    it('does not store the password in plaintext', async () => {
      await auth.signup({ email: 'hash@school.test', password: PASSWORD })

      const row = await db.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE email = $1',
        ['hash@school.test'],
      )

      expect(row.rows[0]?.password_hash).not.toContain(PASSWORD)
      expect(row.rows[0]?.password_hash).toMatch(/^pbkdf2-sha256\$/)
    })

    it('gives two workspaces with the same name distinct slugs', async () => {
      const a = await auth.signup({
        email: 'a@x.test',
        password: PASSWORD,
        organizationName: 'Acme',
      })
      const b = await auth.signup({
        email: 'b@x.test',
        password: PASSWORD,
        organizationName: 'Acme',
      })

      expect(a.organization.slug).toBe('acme')
      expect(b.organization.slug).toBe('acme-2')
    })
  })

  describe('login', () => {
    beforeEach(async () => {
      await auth.signup({
        email: 'teacher@school.test',
        password: PASSWORD,
        organizationName: 'Acme',
      })
    })

    it('accepts the right password and lands the user in their workspace', async () => {
      const result = await auth.login({ email: 'teacher@school.test', password: PASSWORD })

      expect(result.organization.name).toBe('Acme')
      expect(result.role).toBe('owner')
    })

    it('rejects the wrong password', async () => {
      await expect(
        auth.login({ email: 'teacher@school.test', password: 'wrong-password-here' }),
      ).rejects.toMatchObject({ code: 'invalid_credentials' })
    })

    it('gives an unknown address the same error as a wrong password', async () => {
      // Account enumeration: a different error, or a different status, tells an
      // attacker which addresses are registered.
      await expect(
        auth.login({ email: 'nobody@school.test', password: PASSWORD }),
      ).rejects.toMatchObject({ code: 'invalid_credentials' })
    })

    it('does not confirm the existence of an org the user is not in', async () => {
      const other = await auth.signup({ email: 'other@x.test', password: PASSWORD })

      await expect(
        auth.login({
          email: 'teacher@school.test',
          password: PASSWORD,
          organizationId: other.organization.id,
        }),
      ).rejects.toMatchObject({ code: 'not_a_member' })
    })
  })

  describe('sessions', () => {
    it('resolves a fresh session to its user, org, and role', async () => {
      const { token } = await auth.signup({ email: 'teacher@school.test', password: PASSWORD })

      const session = await auth.resolveSession(token)
      expect(session?.user.email).toBe('teacher@school.test')
      expect(session?.role).toBe('owner')
    })

    it('rejects a token that was never issued', async () => {
      expect(await auth.resolveSession('not-a-real-token')).toBeNull()
    })

    it('rejects an empty token without hitting the database', async () => {
      expect(await auth.resolveSession('')).toBeNull()
    })

    it('expires a session after the TTL', async () => {
      const { token } = await auth.signup({ email: 'teacher@school.test', password: PASSWORD })

      clock.advance(SESSION_TTL_MS + 1000)

      expect(await auth.resolveSession(token)).toBeNull()
    })

    it('slides expiry forward while the session is in use', async () => {
      const { token } = await auth.signup({ email: 'teacher@school.test', password: PASSWORD })

      // Use it just before it would lapse, twice over. A fixed-window session
      // would be dead by the second check; a sliding one is still alive.
      clock.advance(SESSION_TTL_MS - 1000)
      expect(await auth.resolveSession(token)).not.toBeNull()

      clock.advance(SESSION_TTL_MS - 1000)
      expect(await auth.resolveSession(token)).not.toBeNull()
    })

    it('stops resolving a session once the user loses their membership', async () => {
      const { token, organization, user } = await auth.signup({
        email: 'teacher@school.test',
        password: PASSWORD,
      })

      await db.query('DELETE FROM memberships WHERE org_id = $1 AND user_id = $2', [
        organization.id,
        user.id,
      ])

      // Membership is re-joined per request rather than baked into the session,
      // so removal takes effect immediately rather than at expiry.
      expect(await auth.resolveSession(token)).toBeNull()
    })

    it('revokes the session on logout', async () => {
      const { token } = await auth.signup({ email: 'teacher@school.test', password: PASSWORD })

      await auth.logout(token)

      expect(await auth.resolveSession(token)).toBeNull()
    })

    it('treats logging out twice as a no-op', async () => {
      const { token } = await auth.signup({ email: 'teacher@school.test', password: PASSWORD })

      await auth.logout(token)
      await expect(auth.logout(token)).resolves.toBeUndefined()
    })

    it('stores only a hash of the session token', async () => {
      const { token } = await auth.signup({ email: 'teacher@school.test', password: PASSWORD })

      const rows = await db.query<{ token_hash: string }>('SELECT token_hash FROM sessions')
      expect(rows.rows[0]?.token_hash).not.toBe(token)
    })
  })

  describe('password reset', () => {
    beforeEach(async () => {
      await auth.signup({ email: 'teacher@school.test', password: PASSWORD })
    })

    it('issues a token for a known address', async () => {
      const reset = await auth.createPasswordResetToken('teacher@school.test')
      expect(reset?.token).toBeTruthy()
    })

    it('returns null for an unknown address instead of throwing', async () => {
      // The route answers 202 either way; this is what lets it do that without lying.
      expect(await auth.createPasswordResetToken('nobody@school.test')).toBeNull()
    })

    it('sets a new password that then works for login', async () => {
      const reset = await auth.createPasswordResetToken('teacher@school.test')
      await auth.resetPassword(reset?.token as string, 'a-brand-new-password')

      await expect(
        auth.login({ email: 'teacher@school.test', password: 'a-brand-new-password' }),
      ).resolves.toMatchObject({ role: 'owner' })
    })

    it('invalidates the old password', async () => {
      const reset = await auth.createPasswordResetToken('teacher@school.test')
      await auth.resetPassword(reset?.token as string, 'a-brand-new-password')

      await expect(
        auth.login({ email: 'teacher@school.test', password: PASSWORD }),
      ).rejects.toMatchObject({ code: 'invalid_credentials' })
    })

    it('kills every existing session', async () => {
      // The reason someone resets is often that someone else is in their account.
      const login = await auth.login({ email: 'teacher@school.test', password: PASSWORD })
      const reset = await auth.createPasswordResetToken('teacher@school.test')

      await auth.resetPassword(reset?.token as string, 'a-brand-new-password')

      expect(await auth.resolveSession(login.token)).toBeNull()
    })

    it('refuses to reuse a token', async () => {
      const reset = await auth.createPasswordResetToken('teacher@school.test')
      await auth.resetPassword(reset?.token as string, 'a-brand-new-password')

      await expect(
        auth.resetPassword(reset?.token as string, 'another-new-password'),
      ).rejects.toMatchObject({ code: 'invalid_token' })
    })

    it('refuses an expired token', async () => {
      const reset = await auth.createPasswordResetToken('teacher@school.test')

      clock.advance(RESET_TTL_MS + 1000)

      await expect(
        auth.resetPassword(reset?.token as string, 'another-new-password'),
      ).rejects.toMatchObject({ code: 'invalid_token' })
    })

    it('refuses a token that was never issued', async () => {
      await expect(auth.resetPassword('made-up', 'another-new-password')).rejects.toMatchObject({
        code: 'invalid_token',
      })
    })

    it('still enforces the password policy on reset', async () => {
      const reset = await auth.createPasswordResetToken('teacher@school.test')

      await expect(auth.resetPassword(reset?.token as string, 'short')).rejects.toMatchObject({
        code: 'weak_password',
      })
    })
  })
})
