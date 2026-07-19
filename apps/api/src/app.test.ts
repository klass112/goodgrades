import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { readBuildInfo } from './build-info.js'
import { type LogLevel, createLogger } from './observability/logger.js'

const buildInfo = { commit: 'abc1234', builtAt: '2026-07-19T00:00:00Z', env: 'test' }

/** A logger whose lines are captured in-memory, so tests can assert on what was logged. */
function capturingLogger() {
  const lines: { line: string; level: LogLevel }[] = []
  const logger = createLogger({
    sink: (line, level) => lines.push({ line, level }),
  })
  return { logger, lines, parsed: () => lines.map((l) => JSON.parse(l.line)) }
}

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

describe('request id correlation', () => {
  it('generates a request id and echoes it on the response when none is supplied', async () => {
    const res = await createApp({ buildInfo }).request('/health')

    const requestId = res.headers.get('x-request-id')
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('reuses an inbound x-request-id header instead of generating a new one', async () => {
    const res = await createApp({ buildInfo }).request('/health', {
      headers: { 'x-request-id': 'inbound-abc-123' },
    })

    expect(res.headers.get('x-request-id')).toBe('inbound-abc-123')
  })

  it('logs one completion line per request, carrying the same requestId as the response header', async () => {
    const { logger, parsed } = capturingLogger()

    const res = await createApp({ buildInfo, logger }).request('/health', {
      headers: { 'x-request-id': 'req-correlate-1' },
    })

    const completed = parsed().find((entry) => entry.msg === 'request completed')
    expect(completed).toMatchObject({
      requestId: 'req-correlate-1',
      method: 'GET',
      path: '/health',
      status: 200,
    })
    expect(typeof completed?.durationMs).toBe('number')
    expect(res.headers.get('x-request-id')).toBe('req-correlate-1')
  })
})

describe('GET /debug/boom', () => {
  it('returns a 500 with the sanitized JSON error shape, without leaking the stack', async () => {
    const res = await createApp({ buildInfo, debugRoutesEnabled: true }).request('/debug/boom', {
      headers: { 'x-request-id': 'req-boom-1' },
    })

    expect(res.status).toBe(500)
    const body = await res.json()
    // toEqual is exact-shape: this alone proves no extra key (e.g. `stack`) leaked.
    expect(body).toEqual({ error: 'internal_error', requestId: 'req-boom-1' })
    expect(JSON.stringify(body)).not.toContain('at ')
  })

  it('logs an error line for the unhandled error', async () => {
    const { logger, parsed } = capturingLogger()

    await createApp({ buildInfo, logger, debugRoutesEnabled: true }).request('/debug/boom')

    const errorLine = parsed().find((entry) => entry.level === 'error')
    expect(errorLine).toBeDefined()
    expect(errorLine?.err?.name).toBe('Error')
    expect(typeof errorLine?.err?.stack).toBe('string')
  })

  it('reports the error to Sentry via the injected captureError, tagged with the requestId', async () => {
    const captureError = vi.fn()

    const res = await createApp({ buildInfo, captureError, debugRoutesEnabled: true }).request(
      '/debug/boom',
      { headers: { 'x-request-id': 'req-boom-2' } },
    )

    expect(captureError).toHaveBeenCalledTimes(1)
    expect(captureError).toHaveBeenCalledWith(expect.any(Error), { requestId: 'req-boom-2' })
    expect(res.status).toBe(500)
  })

  it('is absent by default when APP_ENV is production', async () => {
    const res = await createApp({ buildInfo: { ...buildInfo, env: 'production' } }).request(
      '/debug/boom',
    )

    expect(res.status).toBe(404)
  })

  it('can be disabled explicitly regardless of APP_ENV', async () => {
    const res = await createApp({ buildInfo, debugRoutesEnabled: false }).request('/debug/boom')

    expect(res.status).toBe(404)
  })

  it('stays reachable in a production build when DEBUG_ROUTES=1 is set', async () => {
    const original = process.env.DEBUG_ROUTES
    process.env.DEBUG_ROUTES = '1'

    try {
      const res = await createApp({ buildInfo: { ...buildInfo, env: 'production' } }).request(
        '/debug/boom',
      )
      expect(res.status).toBe(500)
    } finally {
      if (original === undefined) {
        // Not `= undefined`: process.env coerces assignments to strings, so that
        // would leave the literal string "undefined" behind instead of clearing it.
        // biome-ignore lint/performance/noDelete: correctness, not style — see above.
        delete process.env.DEBUG_ROUTES
      } else {
        process.env.DEBUG_ROUTES = original
      }
    }
  })
})
