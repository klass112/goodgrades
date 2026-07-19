import type { Context, Next } from 'hono'
import type { Logger } from './logger.js'
import { runWithRequestContext } from './request-context.js'

/** Hono context variables this middleware exposes to route handlers and onError. */
export type AppVariables = {
  logger: Logger
  requestId: string
}

export interface RequestLoggingOptions {
  logger: Logger
  /** Injectable clock (ms since epoch) so duration-in-ms assertions are deterministic in tests. */
  now?: () => number
}

/**
 * Correlates each request with an id — reusing an inbound `x-request-id` from
 * a proxy/load balancer if present, otherwise minting one — exposes a
 * request-scoped child logger via `c.set('logger', ...)`, and logs exactly
 * one completion line per request.
 *
 * No try/catch around `next()` is needed for the error case: Hono's compose()
 * catches a downstream throw at the frame that invoked the throwing handler
 * and runs `app.onError` there, assigning `c.res` *before* our `next()` call
 * resolves. So by the time we log below, `c.res.status` already reflects a
 * 500 from onError too, and onError (which runs first) has already logged
 * and reported that error — this line is the completion record, not a
 * duplicate of it. A `finally` is used only to log even if `next()` itself
 * rejects (e.g. a bug inside onError), which compose() does not normally do.
 */
export function requestLogging(options: RequestLoggingOptions) {
  const now = options.now ?? Date.now

  return async (c: Context<{ Variables: AppVariables }>, next: Next) => {
    const requestId = c.req.header('x-request-id') ?? crypto.randomUUID()
    // Set before next() runs so it lands on the response whether the route
    // handler or app.onError ends up building it (see context.js's
    // #preparedHeaders, merged into both paths).
    c.header('x-request-id', requestId)

    const requestLogger = options.logger.child({ requestId })
    c.set('logger', requestLogger)
    c.set('requestId', requestId)

    const start = now()
    try {
      await runWithRequestContext({ requestId }, () => next())
    } finally {
      requestLogger.info('request completed', {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: now() - start,
      })
    }
  }
}
