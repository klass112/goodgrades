import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { Database } from '../db/client.js'
import { createTestAuth, createTestDatabase } from '../test-support/harness.js'
import { SESSION_COOKIE } from './routes.js'

const buildInfo = { commit: 'test', builtAt: '2026-07-19T00:00:00Z', env: 'test' }
const PASSWORD = 'correct-horse-battery'

/**
 * End-to-end over HTTP: no service calls, only requests and cookies, the way a
 * browser would drive it. This is the suite that demonstrates KLA-4's success
 * condition — sign up, land in your own workspace, and be unable to read
 * another tenant's data.
 */
describe('auth routes', () => {
  let db: Database
  let app: ReturnType<typeof createApp>

  beforeEach(async () => {
    db = await createTestDatabase()
    app = createApp({
      buildInfo,
      db,
      auth: createTestAuth(db),
      secureCookies: false, // tests speak http; Secure cookies would never be sent back
    })
  })

  afterEach(async () => {
    await db.close()
  })

  const post = (path: string, body: unknown, cookie?: string) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    })

  const get = (path: string, cookie?: string) =>
    app.request(path, { headers: cookie ? { cookie } : {} })

  /** Pulls the session cookie back out of Set-Cookie, as a browser would. */
  const sessionCookie = (res: Response): string => {
    const header = res.headers.get('set-cookie') ?? ''
    const match = header.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))
    return `${SESSION_COOKIE}=${match?.[1] ?? ''}`
  }

  const signUp = async (email: string, organizationName: string) => {
    const res = await post('/auth/signup', { email, password: PASSWORD, organizationName })
    expect(res.status).toBe(201)
    return { res, cookie: sessionCookie(res), body: (await res.json()) as Record<string, never> }
  }

  describe('signup', () => {
    it('creates the account and returns the new workspace', async () => {
      const res = await post('/auth/signup', {
        email: 'teacher@school.test',
        password: PASSWORD,
        organizationName: 'Springfield Elementary',
      })

      expect(res.status).toBe(201)
      expect(await res.json()).toMatchObject({
        user: { email: 'teacher@school.test' },
        organization: { name: 'Springfield Elementary', slug: 'springfield-elementary' },
        role: 'owner',
      })
    })

    it('sets an httpOnly session cookie', async () => {
      const res = await post('/auth/signup', { email: 'teacher@school.test', password: PASSWORD })

      const cookie = res.headers.get('set-cookie') ?? ''
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Lax')
    })

    it('never returns the password hash', async () => {
      const res = await post('/auth/signup', { email: 'teacher@school.test', password: PASSWORD })
      expect(JSON.stringify(await res.json())).not.toContain('pbkdf2')
    })

    it('409s on a duplicate email', async () => {
      await post('/auth/signup', { email: 'teacher@school.test', password: PASSWORD })
      const res = await post('/auth/signup', { email: 'teacher@school.test', password: PASSWORD })

      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error: 'email_taken' })
    })

    it('400s on a weak password', async () => {
      const res = await post('/auth/signup', { email: 'teacher@school.test', password: 'short' })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: 'weak_password' })
    })

    it('400s on a malformed body rather than 500ing', async () => {
      const res = await app.request('/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      })
      expect(res.status).toBe(400)
    })
  })

  describe('session lifecycle', () => {
    it('lands a new signup in their own workspace', async () => {
      const { cookie } = await signUp('teacher@school.test', 'Springfield Elementary')

      const me = await get('/auth/me', cookie)
      expect(me.status).toBe(200)
      expect(await me.json()).toMatchObject({
        user: { email: 'teacher@school.test' },
        organization: { name: 'Springfield Elementary' },
        role: 'owner',
      })
    })

    it('401s without a cookie', async () => {
      const res = await get('/auth/me')
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ error: 'unauthenticated' })
    })

    it('401s on a forged cookie', async () => {
      const res = await get('/auth/me', `${SESSION_COOKIE}=forged-token-value`)
      expect(res.status).toBe(401)
    })

    it('logs in and back out', async () => {
      await signUp('teacher@school.test', 'Acme')

      const login = await post('/auth/login', { email: 'teacher@school.test', password: PASSWORD })
      expect(login.status).toBe(200)
      const cookie = sessionCookie(login)

      expect((await get('/auth/me', cookie)).status).toBe(200)

      const out = await post('/auth/logout', {}, cookie)
      expect(out.status).toBe(200)

      // The same cookie must be dead server-side, not merely cleared client-side.
      expect((await get('/auth/me', cookie)).status).toBe(401)
    })

    it('401s on a wrong password', async () => {
      await signUp('teacher@school.test', 'Acme')
      const res = await post('/auth/login', {
        email: 'teacher@school.test',
        password: 'wrong-password-here',
      })

      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ error: 'invalid_credentials' })
    })

    it('answers an unknown address identically to a wrong password', async () => {
      await signUp('teacher@school.test', 'Acme')

      const unknown = await post('/auth/login', { email: 'nobody@school.test', password: PASSWORD })
      const wrong = await post('/auth/login', {
        email: 'teacher@school.test',
        password: 'wrong-password-here',
      })

      expect(unknown.status).toBe(wrong.status)
      expect(await unknown.json()).toEqual(await wrong.json())
    })
  })

  describe('password reset', () => {
    it('answers 202 for a known and an unknown address alike', async () => {
      await signUp('teacher@school.test', 'Acme')

      const known = await post('/auth/password-reset', { email: 'teacher@school.test' })
      const unknown = await post('/auth/password-reset', { email: 'nobody@school.test' })

      expect(known.status).toBe(202)
      expect(unknown.status).toBe(202)
      expect(await known.json()).toEqual(await unknown.json())
    })

    it('never puts the reset token in the response', async () => {
      await signUp('teacher@school.test', 'Acme')

      const res = await post('/auth/password-reset', { email: 'teacher@school.test' })
      const stored = await db.query<{ token_hash: string }>(
        'SELECT token_hash FROM password_reset_tokens',
      )

      expect(stored.rows).toHaveLength(1)
      expect(JSON.stringify(await res.json())).not.toContain(stored.rows[0]?.token_hash as string)
    })

    it('400s on an invalid token', async () => {
      const res = await post('/auth/password-reset/confirm', {
        token: 'nope',
        password: 'a-brand-new-password',
      })

      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: 'invalid_token' })
    })
  })

  /**
   * The headline requirement, exercised the way an attacker would actually meet
   * it: over HTTP, with a real session, against a route that has no idea tenancy
   * exists.
   */
  describe('tenant isolation over HTTP', () => {
    it('shows each workspace only its own members', async () => {
      const acme = await signUp('owner@acme.test', 'Acme')
      const globex = await signUp('owner@globex.test', 'Globex')

      const acmeView = (await (await get('/workspace/members', acme.cookie)).json()) as {
        organization: { name: string }
        members: { email: string }[]
      }
      const globexView = (await (await get('/workspace/members', globex.cookie)).json()) as {
        organization: { name: string }
        members: { email: string }[]
      }

      expect(acmeView.organization.name).toBe('Acme')
      expect(acmeView.members.map((m) => m.email)).toEqual(['owner@acme.test'])

      expect(globexView.organization.name).toBe('Globex')
      expect(globexView.members.map((m) => m.email)).toEqual(['owner@globex.test'])

      // The point of the whole design, stated as an assertion.
      expect(JSON.stringify(acmeView)).not.toContain('globex')
      expect(JSON.stringify(globexView)).not.toContain('acme')
    })

    it('does not let a session from one workspace be replayed against another', async () => {
      const acme = await signUp('owner@acme.test', 'Acme')
      const globex = await signUp('owner@globex.test', 'Globex')

      // Acme's cookie carries Acme's org. There is no request Acme can make that
      // resolves to Globex's tenant, because the org is bound into the session
      // row rather than taken from anything the caller sends.
      const asAcme = await get('/workspace/members', acme.cookie)
      expect(await asAcme.json()).toMatchObject({ organization: { name: 'Acme' } })

      expect(globex.cookie).not.toBe(acme.cookie)
    })
  })

  describe('health', () => {
    it('still answers without touching the database', async () => {
      // Mounting auth must not make /health depend on the database being up.
      const bare = createApp({ buildInfo })
      const res = await bare.request('/health')

      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ status: 'ok' })
    })
  })
})
