import * as Sentry from '@sentry/react'

export interface InitSentryOptions {
  /** Omitted or empty disables Sentry entirely — local dev stays quiet. */
  dsn?: string
  /** Commit SHA. Ties an event to the exact build, and lets Sentry pick the matching source maps. */
  release: string
  environment: string
}

/**
 * Wires browser error reporting.
 *
 * Deliberately conservative defaults: we are on a free/self-hosted Sentry with
 * no quota headroom to waste, so tracing is sampled rather than full, and we
 * drop the noisy browser-extension and network-blip errors that would otherwise
 * bury real regressions. See docs/decisions/0003-observability.md.
 *
 * Returns whether Sentry was actually enabled, so callers (and tests) can tell
 * "configured" apart from "silently did nothing".
 */
export function initSentry({ dsn, release, environment }: InitSentryOptions): boolean {
  if (!dsn) return false

  Sentry.init({
    dsn,
    release,
    environment,
    // Errors are the point of this integration; traces are a bonus. 10% keeps
    // the performance signal alive without flooding a single-node Sentry.
    tracesSampleRate: 0.1,
    integrations: [Sentry.browserTracingIntegration()],
    // Without this the SDK reports every unhandled rejection from third-party
    // scripts as ours. We have no QA, so a noisy inbox is a broken inbox.
    ignoreErrors: [
      // Chrome extensions and injected scripts.
      /^ResizeObserver loop/,
      'Non-Error promise rejection captured',
    ],
    denyUrls: [/extensions\//i, /^chrome:\/\//i, /^moz-extension:\/\//i],
  })

  Sentry.setTag('service', 'goodgrades-web')
  return true
}

/**
 * Report an error we caught and handled. Unhandled errors are captured
 * automatically; this is for the ones we swallow on purpose but still want to see.
 */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  Sentry.captureException(error, context ? { extra: context } : undefined)
}
