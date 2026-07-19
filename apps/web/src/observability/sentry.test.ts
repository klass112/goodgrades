import * as Sentry from '@sentry/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initSentry } from './sentry.js'

vi.mock('@sentry/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentry/react')>()
  return { ...actual, init: vi.fn(), setTag: vi.fn() }
})

afterEach(() => vi.clearAllMocks())

describe('initSentry', () => {
  it('stays disabled without a DSN, so local dev does not ship noise to Sentry', () => {
    const enabled = initSentry({ dsn: undefined, release: 'dev', environment: 'development' })

    expect(enabled).toBe(false)
    expect(Sentry.init).not.toHaveBeenCalled()
  })

  it('treats an empty DSN as disabled — an unset CI variable must not half-configure Sentry', () => {
    expect(initSentry({ dsn: '', release: 'dev', environment: 'development' })).toBe(false)
    expect(Sentry.init).not.toHaveBeenCalled()
  })

  it('tags events with release and environment so we can tell which deploy broke', () => {
    const enabled = initSentry({
      dsn: 'https://key@example.invalid/1',
      release: 'abc1234',
      environment: 'production',
    })

    expect(enabled).toBe(true)
    expect(Sentry.init).toHaveBeenCalledOnce()

    const initOptions = vi.mocked(Sentry.init).mock.calls[0]?.[0]
    expect(initOptions).toMatchObject({
      dsn: 'https://key@example.invalid/1',
      release: 'abc1234',
      environment: 'production',
    })
  })
})
