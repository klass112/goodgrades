import { Hono } from 'hono'
import { type BuildInfo, readBuildInfo } from './build-info.js'
import { type Logger, createLogger } from './observability/logger.js'
import { type AppVariables, requestLogging } from './observability/middleware.js'
// Type-only: this file must not pull `@sentry/node` into the runtime import
// graph. worker.ts imports createApp for the deployed Cloudflare Workers
// entrypoint (see wrangler.toml), and @sentry/node is a Node SDK that is not
// safe to bundle into a Workers isolate. The real Sentry-backed captureError is
// wired in only by server.ts, the Node entrypoint; createApp's own default is a
// no-op so every other caller (Workers, tests) stays Sentry-free.
import type { ErrorContext } from './observability/sentry.js'

export interface AppOptions {
  buildInfo?: BuildInfo
  /** Injectable so tests can capture emitted log lines instead of hitting real stdout. */
  logger?: Logger
  /** Injectable so tests can assert error reporting without touching real Sentry. */
  captureError?: (err: unknown, context: ErrorContext) => void
  /** Injectable so tests can flip /debug/boom on or off without env-var juggling. */
  debugRoutesEnabled?: boolean
}

/** Default: every caller of createApp gets this until it opts in to real reporting. */
function noopCaptureError(): void {}

/**
 * /debug/boom exists to prove the error-handling path end to end, so it must
 * never be reachable in a real deploy by accident. Defaults to "on" anywhere
 * that isn't APP_ENV=production, with an explicit escape hatch (DEBUG_ROUTES=1)
 * for exercising it against a production-configured build.
 *
 * Reads `buildInfo.env` rather than `process.env.APP_ENV` directly: on Workers,
 * APP_ENV arrives via the fetch handler's `env` bindings, not process.env (see
 * BuildEnv in build-info.ts), and buildInfo already resolved that correctly for
 * whichever runtime called createApp.
 */
function resolveDebugRoutesEnabled(buildInfo: BuildInfo): boolean {
  return buildInfo.env !== 'production' || process.env.DEBUG_ROUTES === '1'
}

/**
 * The API is built as a factory so tests can inject build metadata and so the
 * same app can be mounted on any runtime adapter (Node today, Cloud Functions
 * or Workers later) without touching route code. See docs/decisions/0001-stack.md.
 */
export function createApp(options: AppOptions = {}) {
  const buildInfo = options.buildInfo ?? readBuildInfo()
  const logger =
    options.logger ??
    createLogger({
      context: { service: 'goodgrades-api', env: buildInfo.env, commit: buildInfo.commit },
    })
  const captureError = options.captureError ?? noopCaptureError
  const debugRoutesEnabled = options.debugRoutesEnabled ?? resolveDebugRoutesEnabled(buildInfo)

  const app = new Hono<{ Variables: AppVariables }>()

  app.use('*', requestLogging({ logger }))

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

  if (debugRoutesEnabled) {
    app.get('/debug/boom', () => {
      throw new Error('Deliberate test error — KLA-7 observability verification')
    })
  }

  app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404))

  /**
   * Logs and reports, then answers with the request id and nothing else. The
   * stack trace goes to our logs and to Sentry — never to the client, where it
   * would leak internals. The request id is the join key: a user can quote it
   * and we can find the exact log line and Sentry event.
   */
  app.onError((err, c) => {
    const requestId = c.get('requestId')
    c.get('logger')?.error('unhandled error', { err, path: c.req.path })
    captureError(err, { requestId })
    return c.json({ error: 'internal_error', requestId }, 500)
  })

  return app
}
