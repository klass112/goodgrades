import { type Context, Hono, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Database } from '../db/client.js'
import { withTenant } from '../tenancy/with-tenant.js'
import { AuthError, type AuthService, type AuthenticatedSession } from './service.js'

export const SESSION_COOKIE = 'gg_session'

export interface AuthRouteVariables {
  session: AuthenticatedSession
}

interface AuthRouteOptions {
  db: Database
  auth: AuthService
  /** Cookies are only marked Secure off localhost, or dev over plain http never sees them. */
  secureCookies?: boolean
}

/** Maps a domain error to a status. Everything else is a 500 and should be. */
const STATUS_BY_CODE: Record<string, 400 | 401 | 409> = {
  invalid_credentials: 401,
  not_a_member: 401,
  invalid_token: 400,
  weak_password: 400,
  invalid_email: 400,
  email_taken: 409,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(body: unknown, key: string): string {
  if (!isRecord(body)) return ''
  const value = body[key]
  return typeof value === 'string' ? value : ''
}

export function createAuthRoutes({ db, auth, secureCookies = true }: AuthRouteOptions) {
  const routes = new Hono<{ Variables: AuthRouteVariables }>()

  const issue = (c: Context<{ Variables: AuthRouteVariables }>, token: string, expiresAt: Date) => {
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true, // the token must be unreachable from JavaScript, so XSS cannot exfiltrate it
      secure: secureCookies,
      sameSite: 'Lax', // blocks cross-site POSTs from carrying the cookie: CSRF defence for state-changing routes
      path: '/',
      expires: expiresAt,
    })
  }

  routes.onError((err, c) => {
    if (err instanceof AuthError) {
      return c.json({ error: err.code, message: err.message }, STATUS_BY_CODE[err.code] ?? 400)
    }
    throw err
  })

  routes.post('/auth/signup', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const result = await auth.signup({
      email: readString(body, 'email'),
      password: readString(body, 'password'),
      name: readString(body, 'name') || undefined,
      organizationName: readString(body, 'organizationName') || undefined,
    })

    issue(c, result.token, result.expiresAt)
    return c.json({ user: result.user, organization: result.organization, role: result.role }, 201)
  })

  routes.post('/auth/login', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const result = await auth.login({
      email: readString(body, 'email'),
      password: readString(body, 'password'),
      organizationId: readString(body, 'organizationId') || undefined,
    })

    issue(c, result.token, result.expiresAt)
    return c.json({ user: result.user, organization: result.organization, role: result.role })
  })

  routes.post('/auth/logout', async (c) => {
    await auth.logout(getCookie(c, SESSION_COOKIE) ?? '')
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  /**
   * Always 202, whether or not the address is registered. Anything else turns
   * this endpoint into a "does this person have an account here" oracle.
   *
   * The token is not returned and not yet emailed — there is no mail vendor
   * (a CEO call). Until there is, this records the request and nothing reaches
   * the user, which is why the response says `delivery: 'pending_provider'`
   * rather than claiming an email was sent.
   */
  routes.post('/auth/password-reset', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    await auth.createPasswordResetToken(readString(body, 'email'))
    return c.json({ ok: true, delivery: 'pending_provider' }, 202)
  })

  routes.post('/auth/password-reset/confirm', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    await auth.resetPassword(readString(body, 'token'), readString(body, 'password'))
    return c.json({ ok: true })
  })

  /** Everything below requires a live session. */
  routes.use('/auth/me', requireSession(auth))
  routes.use('/workspace/*', requireSession(auth))

  routes.get('/auth/me', (c) => {
    const session = c.get('session')
    return c.json({
      user: session.user,
      organization: session.organization,
      role: session.role,
    })
  })

  /**
   * A tenant-scoped read, and the shape every future data route should copy.
   *
   * Note what is missing: there is no `WHERE org_id = ...`. The handler does not
   * know the org id and does not need to — `withTenant` has already constrained
   * the connection, so this query cannot return another workspace's members
   * even though it looks like it selects all of them.
   */
  routes.get('/workspace/members', async (c) => {
    const session = c.get('session')

    const members = await withTenant(db, session.organization.id, async (tx) => {
      const result = await tx.query<{
        id: string
        email: string
        name: string | null
        role: string
      }>(
        `SELECT u.id, u.email, u.name, m.role
           FROM memberships m
           JOIN users u ON u.id = m.user_id
          ORDER BY m.created_at ASC`,
      )
      return result.rows
    })

    return c.json({ organization: session.organization, members })
  })

  return routes
}

/**
 * Rejects the request unless the session cookie resolves to a live session.
 *
 * Every route mounted behind this can treat `c.get('session')` as present, and
 * — more importantly — can treat `session.organization.id` as the only tenant it
 * is allowed to touch. That org comes from the session row, never from anything
 * the caller sent, so there is no header or body field to tamper with.
 */
export function requireSession(auth: AuthService): MiddlewareHandler<{
  Variables: AuthRouteVariables
}> {
  return async (c, next) => {
    const session = await auth.resolveSession(getCookie(c, SESSION_COOKIE) ?? '')

    if (!session) {
      return c.json({ error: 'unauthenticated' }, 401)
    }

    c.set('session', session)
    await next()
  }
}
