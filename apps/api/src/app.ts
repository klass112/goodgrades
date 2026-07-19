import { Hono } from 'hono'
import { createAuthRoutes } from './auth/routes.js'
import type { AuthService } from './auth/service.js'
import { type BuildInfo, readBuildInfo } from './build-info.js'
import type { Database } from './db/client.js'

export interface AppOptions {
  buildInfo?: BuildInfo
  /**
   * Auth routes mount only when a database is supplied. The health endpoints
   * deliberately do not need one: a deploy smoke test must be able to prove the
   * right commit is live even when the database is unreachable, and folding
   * `/health` into the database's availability would turn every DB blip into a
   * failed deploy.
   */
  db?: Database
  auth?: AuthService
  /** Off in tests, which speak http — a Secure cookie would never be sent back. */
  secureCookies?: boolean
}

/**
 * The API is built as a factory so tests can inject build metadata and so the
 * same app can be mounted on any runtime adapter (Node today, Cloud Functions
 * or Workers later) without touching route code. See docs/decisions/0001-stack.md.
 */
export function createApp(options: AppOptions = {}) {
  const buildInfo = options.buildInfo ?? readBuildInfo()

  const app = new Hono()

  app.get('/', (c) =>
    c.json({
      service: 'goodgrades-api',
      docs: '/health',
    }),
  )

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      service: 'goodgrades-api',
      ...buildInfo,
    }),
  )

  if (options.db && options.auth) {
    app.route(
      '/',
      createAuthRoutes({
        db: options.db,
        auth: options.auth,
        secureCookies: options.secureCookies,
      }),
    )
  }

  app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404))

  return app
}
