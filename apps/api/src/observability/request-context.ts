import { AsyncLocalStorage } from 'node:async_hooks'

export interface RequestContext {
  requestId: string
}

/**
 * Lets code deep in a call stack (a DB helper, a service function) log with
 * the current request's id without a logger being threaded through every
 * function signature down to it. Backed by AsyncLocalStorage, which works
 * under Node and, via the `nodejs_compat` compatibility flag, Cloudflare
 * Workers too (see wrangler.toml) — the runtime this API is headed for.
 */
const storage = new AsyncLocalStorage<RequestContext>()

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn)
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore()
}
