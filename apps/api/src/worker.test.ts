import { describe, expect, it } from 'vitest'
import worker, { appForEnv, type WorkerEnv } from './worker.js'

const env: WorkerEnv = {
  GIT_COMMIT: 'abc1234',
  BUILD_TIME: '2026-07-19T00:00:00Z',
  APP_ENV: 'production',
}

describe('worker fetch handler', () => {
  it('serves /health with the build vars the deploy injected on env, not process.env', async () => {
    const res = await worker.fetch(new Request('https://api.example/health'), env, undefined)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      status: 'ok',
      service: 'goodgrades-api',
      commit: 'abc1234',
      builtAt: '2026-07-19T00:00:00Z',
      env: 'production',
    })
  })

  it('404s unknown routes with the same structured body as the Node runtime', async () => {
    const res = await worker.fetch(new Request('https://api.example/nope'), env, undefined)

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'not_found', path: '/nope' })
  })
})

describe('appForEnv', () => {
  it('reuses one app per env, since Workers reuses an isolate across requests', () => {
    expect(appForEnv(env)).toBe(appForEnv(env))
  })

  it('does not leak one env build metadata into another', async () => {
    const other: WorkerEnv = { GIT_COMMIT: 'deadbee', BUILD_TIME: 'later', APP_ENV: 'staging' }

    const res = await appForEnv(other).request('/health')

    await expect(res.json()).resolves.toMatchObject({ commit: 'deadbee', env: 'staging' })
  })
})
