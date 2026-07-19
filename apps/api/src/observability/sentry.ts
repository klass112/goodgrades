import * as Sentry from '@sentry/node'
import { readBuildInfo } from '../build-info.js'

// Tracks whether Sentry.init() actually ran, so captureError can stay a
// no-op — no client, no network — whenever SENTRY_DSN is unset, which is
// every local and CI run today: no deploy pipeline sets it yet, and this
// module is only ever loaded by server.ts, the Node entrypoint (see
// docs/decisions/0002-hosting.md — production runs on Cloudflare Workers).
let enabled = false

/**
 * Initialises @sentry/node only when SENTRY_DSN is configured. Reuses
 * readBuildInfo() rather than re-reading APP_ENV/GIT_COMMIT directly so
 * release/environment always match whatever /health reports.
 */
export function initSentry(): boolean {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) {
    enabled = false
    return false
  }

  const buildInfo = readBuildInfo()
  Sentry.init({
    dsn,
    environment: buildInfo.env,
    release: buildInfo.commit,
  })
  enabled = true
  return true
}

export interface ErrorContext {
  requestId?: string
}

/** Safe no-op when Sentry was never initialised — callers don't need to check `enabled` themselves. */
export function captureError(err: unknown, context: ErrorContext = {}): void {
  if (!enabled) return

  Sentry.withScope((scope) => {
    if (context.requestId) {
      scope.setTag('requestId', context.requestId)
    }
    Sentry.captureException(err)
  })
}
