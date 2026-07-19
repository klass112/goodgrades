import type { Database, Queryable } from '../db/client.js'
import { withoutTenantIsolation } from '../tenancy/with-tenant.js'
import { isPlausibleEmail, normalizeEmail, slugify } from './email.js'
import { type HashOptions, hashPassword, needsRehash, verifyPassword } from './password.js'
import { generateToken, hashToken } from './tokens.js'

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const RESET_TTL_MS = 60 * 60 * 1000
export const MIN_PASSWORD_LENGTH = 12

export type Role = 'owner' | 'admin' | 'member'

export interface User {
  id: string
  email: string
  name: string | null
}

export interface Organization {
  id: string
  name: string
  slug: string
}

export interface AuthenticatedSession {
  user: User
  organization: Organization
  role: Role
  sessionId: string
  expiresAt: Date
}

export type AuthErrorCode =
  | 'invalid_credentials'
  | 'email_taken'
  | 'weak_password'
  | 'invalid_email'
  | 'invalid_token'
  | 'not_a_member'

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

export interface AuthServiceOptions {
  hashOptions?: HashOptions
  /** Injected so session-expiry behaviour is testable without sleeping for a week. */
  now?: () => Date
}

/**
 * All authentication flows.
 *
 * Everything in here runs through `withoutTenantIsolation`, and that is not an
 * oversight — it is the definition of the boundary. Signup, login, and reset all
 * have to touch the database *in order to determine* which tenant the caller
 * belongs to, so by construction they cannot already be inside a tenant context.
 * This file is that exception, and it is the only one. Once a session resolves,
 * every subsequent read goes through `withTenant`.
 */
export function createAuthService(db: Database, options: AuthServiceOptions = {}) {
  const now = options.now ?? (() => new Date())
  const hashOptions = options.hashOptions ?? {}

  /**
   * Burned on a login attempt for an address that does not exist, so that
   * "no such user" costs the same wall-clock time as "wrong password".
   * Without it, response latency is an account-enumeration oracle.
   */
  const decoyHash = hashPassword('decoy-password-never-matches', hashOptions)

  async function uniqueSlug(tx: Queryable, name: string): Promise<string> {
    const base = slugify(name)
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`
      const clash = await tx.query('SELECT 1 FROM organizations WHERE slug = $1', [candidate])
      if (clash.rows.length === 0) return candidate
    }
    // 50 collisions on the same name is not a case worth a prettier slug for.
    return `${base}-${generateToken().slice(0, 8).toLowerCase()}`
  }

  async function issueSession(tx: Queryable, userId: string, orgId: string) {
    const token = generateToken()
    const expiresAt = new Date(now().getTime() + SESSION_TTL_MS)

    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO sessions (user_id, org_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, orgId, await hashToken(token), expiresAt.toISOString()],
    )

    return { token, sessionId: inserted.rows[0]?.id as string, expiresAt }
  }

  return {
    /**
     * Creates the user, their organization, and their owner membership in one
     * transaction, then logs them in. A signup that half-succeeds would leave a
     * user with no workspace to land in, which is unrecoverable without support.
     */
    async signup(input: {
      email: string
      password: string
      name?: string
      organizationName?: string
    }) {
      const email = normalizeEmail(input.email)

      if (!isPlausibleEmail(email)) {
        throw new AuthError('invalid_email', 'That does not look like an email address.')
      }
      if (input.password.length < MIN_PASSWORD_LENGTH) {
        throw new AuthError(
          'weak_password',
          `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        )
      }

      const orgName = input.organizationName?.trim() || `${email.split('@')[0]}'s workspace`

      return withoutTenantIsolation(
        db,
        'signup creates the tenant it would scope to',
        async (tx) => {
          const existing = await tx.query('SELECT 1 FROM users WHERE email = $1', [email])
          if (existing.rows.length > 0) {
            throw new AuthError('email_taken', 'An account with that email already exists.')
          }

          const user = await tx.query<User>(
            `INSERT INTO users (email, password_hash, name)
           VALUES ($1, $2, $3) RETURNING id, email, name`,
            [email, await hashPassword(input.password, hashOptions), input.name?.trim() || null],
          )
          const created = user.rows[0] as User

          const org = await tx.query<Organization>(
            `INSERT INTO organizations (name, slug)
           VALUES ($1, $2) RETURNING id, name, slug`,
            [orgName, await uniqueSlug(tx, orgName)],
          )
          const organization = org.rows[0] as Organization

          await tx.query(
            `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
            [organization.id, created.id],
          )

          const session = await issueSession(tx, created.id, organization.id)
          return { user: created, organization, role: 'owner' as Role, ...session }
        },
      )
    },

    /**
     * Logs in and lands the user in a workspace. `organizationId` picks one
     * explicitly; otherwise they land in their oldest membership, which for the
     * overwhelmingly common single-workspace case is the only one they have.
     */
    async login(input: { email: string; password: string; organizationId?: string }) {
      const email = normalizeEmail(input.email)

      return withoutTenantIsolation(
        db,
        'login resolves which tenant the caller belongs to',
        async (tx) => {
          const found = await tx.query<{
            id: string
            email: string
            name: string | null
            password_hash: string
          }>('SELECT id, email, name, password_hash FROM users WHERE email = $1', [email])
          const user = found.rows[0]

          // Same work, same error, same timing whether or not the account exists.
          const ok = await verifyPassword(input.password, user?.password_hash ?? (await decoyHash))
          if (!user || !ok) {
            throw new AuthError('invalid_credentials', 'Incorrect email or password.')
          }

          // The plaintext is in hand exactly here, so this is the only place we
          // can transparently upgrade a hash made with older parameters.
          if (needsRehash(user.password_hash, hashOptions)) {
            await tx.query(
              'UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2',
              [await hashPassword(input.password, hashOptions), user.id],
            )
          }

          const memberships = await tx.query<{
            org_id: string
            role: Role
            name: string
            slug: string
          }>(
            `SELECT m.org_id, m.role, o.name, o.slug
             FROM memberships m
             JOIN organizations o ON o.id = m.org_id
            WHERE m.user_id = $1
              AND ($2::uuid IS NULL OR m.org_id = $2::uuid)
            ORDER BY m.created_at ASC`,
            [user.id, input.organizationId ?? null],
          )

          const membership = memberships.rows[0]
          if (!membership) {
            // Either the account belongs to no workspace, or it asked for one it
            // is not in. Same answer for both: we do not confirm that an org id
            // someone guessed actually exists.
            throw new AuthError('not_a_member', 'No workspace available for this account.')
          }

          const session = await issueSession(tx, user.id, membership.org_id)
          return {
            user: { id: user.id, email: user.email, name: user.name },
            organization: { id: membership.org_id, name: membership.name, slug: membership.slug },
            role: membership.role,
            ...session,
          }
        },
      )
    },

    /**
     * Resolves a session token to its user, org, and role, or null.
     *
     * Expiry is evaluated in SQL against the session's own `expires_at`, so a
     * token past its date is indistinguishable from one that never existed.
     * Valid sessions slide forward on use: active users are not logged out
     * mid-task, idle ones still age out.
     */
    async resolveSession(token: string): Promise<AuthenticatedSession | null> {
      if (!token) return null

      return withoutTenantIsolation(
        db,
        'session lookup is what establishes the tenant',
        async (tx) => {
          const at = now().toISOString()
          const found = await tx.query<{
            session_id: string
            user_id: string
            email: string
            name: string | null
            org_id: string
            org_name: string
            org_slug: string
            role: Role
          }>(
            `SELECT s.id AS session_id, u.id AS user_id, u.email, u.name,
                  o.id AS org_id, o.name AS org_name, o.slug AS org_slug, m.role
             FROM sessions s
             JOIN users u ON u.id = s.user_id
             JOIN organizations o ON o.id = s.org_id
             JOIN memberships m ON m.user_id = s.user_id AND m.org_id = s.org_id
            WHERE s.token_hash = $1
              AND s.revoked_at IS NULL
              AND s.expires_at > $2`,
            [await hashToken(token), at],
          )

          const row = found.rows[0]
          if (!row) return null

          // Membership is re-joined on every request rather than trusted from the
          // session row, so revoking someone's membership takes effect on their
          // next request instead of whenever their session happens to expire.
          const expiresAt = new Date(now().getTime() + SESSION_TTL_MS)
          await tx.query('UPDATE sessions SET last_used_at = $1, expires_at = $2 WHERE id = $3', [
            at,
            expiresAt.toISOString(),
            row.session_id,
          ])

          return {
            user: { id: row.user_id, email: row.email, name: row.name },
            organization: { id: row.org_id, name: row.org_name, slug: row.org_slug },
            role: row.role,
            sessionId: row.session_id,
            expiresAt,
          }
        },
      )
    },

    /** Idempotent: logging out an unknown or already-revoked token is a no-op, not an error. */
    async logout(token: string): Promise<void> {
      if (!token) return
      await withoutTenantIsolation(
        db,
        'logout is identified by token, not by tenant',
        async (tx) => {
          await tx.query(
            'UPDATE sessions SET revoked_at = $1 WHERE token_hash = $2 AND revoked_at IS NULL',
            [now().toISOString(), await hashToken(token)],
          )
        },
      )
    },

    /**
     * Issues a reset token, or returns null if the address is unknown.
     *
     * The caller must not distinguish those two cases to the user — see the
     * route, which answers 202 either way. Returning the token rather than
     * emailing it is a deliberate seam: there is no mail vendor yet, and
     * picking one is a CEO call. Until then this is callable but not reachable
     * from an unauthenticated route.
     */
    async createPasswordResetToken(
      email: string,
    ): Promise<{ token: string; userId: string } | null> {
      const normalized = normalizeEmail(email)

      return withoutTenantIsolation(
        db,
        'password reset precedes any tenant context',
        async (tx) => {
          const found = await tx.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
            normalized,
          ])
          const user = found.rows[0]
          if (!user) return null

          const token = generateToken()
          await tx.query(
            `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
           VALUES ($1, $2, $3)`,
            [
              user.id,
              await hashToken(token),
              new Date(now().getTime() + RESET_TTL_MS).toISOString(),
            ],
          )

          return { token, userId: user.id }
        },
      )
    },

    /**
     * Consumes a reset token and sets a new password.
     *
     * Marking the token used and revoking every session happen in the same
     * transaction as the password change: if someone reset because their
     * account was compromised, leaving the attacker's session alive would defeat
     * the entire point of the reset.
     */
    async resetPassword(token: string, newPassword: string): Promise<void> {
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        throw new AuthError(
          'weak_password',
          `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        )
      }

      await withoutTenantIsolation(db, 'password reset precedes any tenant context', async (tx) => {
        const at = now().toISOString()
        const found = await tx.query<{ id: string; user_id: string }>(
          `SELECT id, user_id FROM password_reset_tokens
            WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2`,
          [await hashToken(token), at],
        )

        const reset = found.rows[0]
        if (!reset) {
          throw new AuthError('invalid_token', 'That reset link is invalid or has expired.')
        }

        await tx.query('UPDATE password_reset_tokens SET used_at = $1 WHERE id = $2', [
          at,
          reset.id,
        ])
        await tx.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [
          await hashPassword(newPassword, hashOptions),
          reset.user_id,
        ])
        await tx.query(
          'UPDATE sessions SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL',
          [at, reset.user_id],
        )
      })
    },
  }
}

export type AuthService = ReturnType<typeof createAuthService>
