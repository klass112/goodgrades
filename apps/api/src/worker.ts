import { createApp } from './app.js'
import { type BuildEnv, readBuildInfo } from './build-info.js'

/**
 * Cloudflare Workers entry point. See docs/decisions/0002-hosting.md.
 *
 * The Node server (`server.ts`) and this share `createApp`, so route code is
 * runtime-agnostic — the only difference is where build metadata comes from.
 * On Node it is `process.env`; on Workers the deploy injects it as `vars`,
 * which arrive on the handler's `env` argument.
 */
export interface WorkerEnv extends BuildEnv {
  GIT_COMMIT?: string
  BUILD_TIME?: string
  APP_ENV?: string
}

/**
 * Workers reuses an isolate across requests, so build the app once per isolate
 * rather than per request. Keyed on the `env` object rather than a bare module
 * global so a second env (tests, or a preview binding) gets its own app instead
 * of silently inheriting the first one's build metadata.
 */
const apps = new WeakMap<WorkerEnv, ReturnType<typeof createApp>>()

export function appForEnv(env: WorkerEnv): ReturnType<typeof createApp> {
  let app = apps.get(env)
  if (!app) {
    app = createApp({ buildInfo: readBuildInfo(env) })
    apps.set(env, app)
  }
  return app
}

export default {
  fetch(request: Request, env: WorkerEnv, ctx: unknown): Response | Promise<Response> {
    return appForEnv(env).fetch(request, env, ctx as never)
  },
}
