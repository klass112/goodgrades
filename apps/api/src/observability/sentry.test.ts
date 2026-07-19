import { describe, expect, it } from 'vitest'
import { captureError, initSentry } from './sentry.js'

// Deliberately does not test the SENTRY_DSN-set path: that would call the
// real @sentry/node SDK and risk an actual network request to Sentry from
// the test suite. What matters for correctness here, and what every local
// and CI run today actually exercises (SENTRY_DSN is unset — see
// docs/decisions/0002-hosting.md), is that everything stays a safe no-op.
describe('initSentry', () => {
  it('returns false and stays disabled when SENTRY_DSN is unset', () => {
    const original = process.env.SENTRY_DSN
    // Not `= undefined`: process.env coerces assignments to strings, so that would
    // leave the literal (truthy!) string "undefined" as the DSN instead of clearing
    // it — initSentry() would then try to init Sentry with a garbage DSN.
    // biome-ignore lint/performance/noDelete: correctness, not style — see above.
    delete process.env.SENTRY_DSN

    try {
      expect(initSentry()).toBe(false)
    } finally {
      if (original !== undefined) process.env.SENTRY_DSN = original
    }
  })
})

describe('captureError', () => {
  it('is a safe no-op when Sentry was never initialised', () => {
    expect(() => captureError(new Error('boom'), { requestId: 'req-1' })).not.toThrow()
  })

  it('is a safe no-op with no context supplied', () => {
    expect(() => captureError(new Error('boom'))).not.toThrow()
  })
})
