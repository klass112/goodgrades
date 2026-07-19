import { describe, expect, it } from 'vitest'
import { buildEnvelope, evaluate, parseDsn } from './uptime-check.mjs'

const base = {
  ok: true,
  status: 200,
  body: JSON.stringify({ status: 'ok', commit: 'abc1234' }),
  durationMs: 100,
  expectCommit: null,
  slowThresholdMs: 2000,
}

describe('parseDsn', () => {
  it('derives the envelope endpoint and key from a DSN', () => {
    const parsed = parseDsn('https://deadbeef@sentry.example.com/16')

    expect(parsed).toMatchObject({ key: 'deadbeef', projectId: '16' })
    // Must be /envelope/, not the legacy /store/: store is WAF-blocked here and
    // can return 200 while silently dropping the event.
    expect(parsed.envelopeUrl).toContain('https://sentry.example.com/api/16/envelope/')
    expect(parsed.envelopeUrl).toContain('sentry_key=deadbeef')
    expect(parsed.envelopeUrl).not.toContain('/store/')
  })

  it('returns null for unusable DSNs so a missing config degrades instead of crashing', () => {
    expect(parseDsn(undefined)).toBeNull()
    expect(parseDsn('')).toBeNull()
    expect(parseDsn('not a url')).toBeNull()
    expect(parseDsn('https://sentry.example.com/16')).toBeNull() // no key
    expect(parseDsn('https://deadbeef@sentry.example.com/')).toBeNull() // no project id
  })
})

describe('buildEnvelope', () => {
  const dsn = 'https://deadbeef@sentry.example.com/16'
  const event = { event_id: 'abc123', timestamp: '2026-07-19T00:00:00Z', level: 'error' }

  it('emits three newline-delimited JSON lines: header, item header, payload', () => {
    const lines = buildEnvelope(event, dsn).trimEnd().split('\n')

    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0])).toMatchObject({ event_id: 'abc123', dsn })
    expect(JSON.parse(lines[1])).toEqual({ type: 'event' })
    expect(JSON.parse(lines[2])).toMatchObject({ event_id: 'abc123', level: 'error' })
  })

  it('terminates with a newline — Sentry rejects an envelope without it', () => {
    expect(buildEnvelope(event, dsn).endsWith('\n')).toBe(true)
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
