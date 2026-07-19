/**
 * Build metadata, injected by the deploy pipeline via env vars.
 * Falls back to 'dev' locally so the health endpoint always answers.
 */
export interface BuildInfo {
  commit: string
  builtAt: string
  env: string
}

/**
 * The subset of an environment we read. Deliberately not `NodeJS.ProcessEnv`:
 * on Workers the build vars arrive as a plain bindings object on the fetch
 * handler's `env`, not on `process.env`.
 */
export type BuildEnv = Record<string, string | undefined>

export function readBuildInfo(env: BuildEnv = process.env): BuildInfo {
  return {
    commit: env.GIT_COMMIT ?? 'dev',
    builtAt: env.BUILD_TIME ?? 'unknown',
    env: env.APP_ENV ?? 'development',
  }
}
