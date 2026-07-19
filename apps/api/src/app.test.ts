import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { readBuildInfo } from './build-info.js'

const buildInfo = { commit: 'abc1234', builtAt: '2026-07-19T00:00:00Z', env: 'test' }

describe('GET /health', () => {
  it('reports ok and echoes the build metadata the deploy injected', async () => {
    const res = await createApp({ buildInfo }).request('/health')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      status: 'ok',
      service: 'goodgrades-api',
      ...buildInfo,
    })
  })
})

describe('unknown routes', () => {
  it('404s with a structured body rather than HTML', async () => {
    const res = await createApp({ buildInfo }).request('/nope')

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'not_found', path: '/nope' })
  })
})

describe('readBuildInfo', () => {
  it('prefers injected env vars', () => {
    expect(
      readBuildInfo({ GIT_COMMIT: 'deadbee', BUILD_TIME: 'then', APP_ENV: 'production' }),
    ).toEqual({ commit: 'deadbee', builtAt: 'then', env: 'production' })
  })

  it('falls back to dev defaults so /health never throws on a bare runtime', () => {
    expect(readBuildInfo({})).toEqual({
      commit: 'dev',
      builtAt: 'unknown',
      env: 'development',
    })
  })
})
