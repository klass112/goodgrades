import { describe, expect, it } from 'vitest'
import { evaluate, parseDsn } from './uptime-check.mjs'

const base = {
  ok: true,
  status: 200,
  body: JSON.stringify({ status: 'ok', commit: 'abc1234' }),
  durationMs: 100,
  expectCommit: null,
  slowThresholdMs: 2000,
}

describe('parseDsn', () => {
  it('derives the store endpoint and key from a DSN', () => {
    expect(parseDsn('https://deadbeef@sentry.example.com/16')).toEqual({
      key: 'deadbeef',
      storeUrl: 'https://sentry.example.com/api/16/store/',
    })
  })

  it('returns null for unusable DSNs so a missing config degrades instead of crashing', () => {
    expect(parseDsn(undefined)).toBeNull()
    expect(parseDsn('')).toBeNull()
    expect(parseDsn('not a url')).toBeNull()
    expect(parseDsn('https://sentry.example.com/16')).toBeNull() // no key
    expect(parseDsn('https://deadbeef@sentry.example.com/')).toBeNull() // no project id
  })
})

describe('evaluate', () => {
  it('passes a healthy fast response', () => {
    const result = evaluate(base)
    expect(result.healthy).toBe(true)
    expect(result.problems).toEqual([])
  })

  it('fails on a non-2xx response', () => {
    const result = evaluate({ ...base, ok: false, status: 503 })
    expect(result.healthy).toBe(false)
    expect(result.problems).toContain('HTTP 503')
  })

  it('fails when the body is not JSON — a Pages 404 page returns HTML with a 200', () => {
    const result = evaluate({ ...base, body: '<html>Not found</html>' })
    expect(result.healthy).toBe(false)
    expect(result.problems).toContain('response was not valid JSON')
  })

  it('fails when the payload reports a non-ok status', () => {
    const result = evaluate({ ...base, body: JSON.stringify({ status: 'degraded' }) })
    expect(result.healthy).toBe(false)
    expect(result.problems[0]).toMatch(/degraded/)
  })

  it('detects a stale deploy serving the wrong commit', () => {
    const result = evaluate({ ...base, expectCommit: 'newsha' })
    expect(result.healthy).toBe(false)
    expect(result.problems[0]).toMatch(/serving commit abc1234, expected newsha/)
  })

  it('flags slow responses so latency regressions surface before users complain', () => {
    const result = evaluate({ ...base, durationMs: 5000 })
    expect(result.healthy).toBe(false)
    expect(result.slow).toBe(true)
    expect(result.problems[0]).toMatch(/slow: 5000ms/)
  })

  it('does not flag a response exactly at the threshold', () => {
    expect(evaluate({ ...base, durationMs: 2000 }).slow).toBe(false)
  })
})
