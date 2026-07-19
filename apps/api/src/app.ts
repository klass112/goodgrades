import { Hono } from 'hono'
import { type BuildInfo, readBuildInfo } from './build-info.js'

export interface AppOptions {
  buildInfo?: BuildInfo
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

  app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404))

  return app
}
