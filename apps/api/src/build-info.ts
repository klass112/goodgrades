/**
 * Build metadata, injected by the deploy pipeline via env vars.
 * Falls back to 'dev' locally so the health endpoint always answers.
 */
export interface BuildInfo {
  commit: string
  builtAt: string
  env: string
}

export function readBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  return {
    commit: env.GIT_COMMIT ?? 'dev',
    builtAt: env.BUILD_TIME ?? 'unknown',
    env: env.APP_ENV ?? 'development',
  }
}
