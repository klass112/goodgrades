#!/usr/bin/env node
/**
 * Polls the deployed health endpoint and answers three questions: is it up, is
 * it serving the build we think it is, and is it slow.
 *
 * On failure it reports an event to Sentry using the same DSN the browser app
 * uses. That is deliberate: one inbox and one alert rule cover both "the app
 * threw" and "the app is gone", instead of a second monitoring vendor with its
 * own login that nobody checks. See docs/decisions/0003-observability.md.
 *
 * Usage:
 *   node scripts/uptime-check.mjs [--url <health-url>] [--expect-commit <sha>]
 *
 * Env:
 *   HEALTH_URL        default target
 *   SENTRY_DSN        when set, failures are reported to Sentry
 *   SLOW_THRESHOLD_MS latency above which the check reports "slow" (default 2000)
 *   APP_ENV           environment tag on reported events (default production)
 *
 * Exits 0 when healthy, 1 when not. Intended for CI cron and for humans.
 */

const DEFAULT_URL = 'https://klass112.github.io/goodgrades/health.json'
const TIMEOUT_MS = 15_000

function parseArgs(argv) {
  const args = { url: process.env.HEALTH_URL ?? DEFAULT_URL, expectCommit: null }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') args.url = argv[++i]
    else if (argv[i] === '--expect-commit') args.expectCommit = argv[++i]
  }
  return args
}

/**
 * Parses the `https://<key>@<host>/<projectId>` DSN into the ingest URL and key.
 * Returns null for an unset or malformed DSN so a missing DSN degrades to
 * "check still runs, just does not report" rather than crashing the check.
 */
export function parseDsn(dsn) {
  if (!dsn) return null
  try {
    const url = new URL(dsn)
    const projectId = url.pathname.replace(/^\//, '')
    if (!url.username || !projectId) return null
    return {
      key: url.username,
      storeUrl: `${url.protocol}//${url.host}/api/${projectId}/store/`,
    }
  } catch {
    return null
  }
}

export function evaluate({ ok, status, body, durationMs, expectCommit, slowThresholdMs }) {
  const problems = []
  if (!ok) problems.push(`HTTP ${status}`)

  let payload = null
  if (ok) {
    try {
      payload = JSON.parse(body)
    } catch {
      problems.push('response was not valid JSON')
    }
  }

  if (payload && payload.status !== 'ok') {
    problems.push(`health status was "${payload.status}", expected "ok"`)
  }
  // Catches the deploy that reports green but is actually serving a stale build.
  if (payload && expectCommit && payload.commit !== expectCommit) {
    problems.push(`serving commit ${payload.commit}, expected ${expectCommit}`)
  }

  const slow = durationMs > slowThresholdMs
  if (slow) problems.push(`slow: ${durationMs}ms > ${slowThresholdMs}ms threshold`)

  return { healthy: problems.length === 0, problems, payload, slow }
}

async function reportToSentry({ dsn, url, problems, durationMs, payload }) {
  const parsed = parseDsn(dsn)
  if (!parsed) return false

  const event = {
    event_id: crypto.randomUUID().replace(/-/g, ''),
    timestamp: new Date().toISOString(),
    platform: 'node',
    level: 'error',
    logger: 'uptime',
    environment: process.env.APP_ENV ?? 'production',
    // Grouping on the message keeps every outage in one issue rather than
    // opening a fresh one every 15 minutes for the duration of the outage.
    exception: {
      values: [
        {
          type: 'UptimeCheckFailed',
          value: `Health check failed for ${url}: ${problems.join('; ')}`,
        },
      ],
    },
    tags: { service: 'goodgrades-web', check: 'uptime' },
    extra: { url, problems, durationMs, healthPayload: payload },
  }

  const response = await fetch(parsed.storeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sentry-Auth': [
        'Sentry sentry_version=7',
        `sentry_key=${parsed.key}`,
        'sentry_client=goodgrades-uptime/1.0',
      ].join(', '),
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!response.ok) {
    console.error(`warning: could not report to Sentry (HTTP ${response.status})`)
    return false
  }
  return true
}

async function main() {
  const { url, expectCommit } = parseArgs(process.argv.slice(2))
  const slowThresholdMs = Number(process.env.SLOW_THRESHOLD_MS ?? 2000)

  const startedAt = Date.now()
  let ok = false
  let status = 0
  let body = ''

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'cache-control': 'no-cache' },
    })
    status = response.status
    ok = response.ok
    body = await response.text()
  } catch (error) {
    body = ''
    console.error(`request failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const durationMs = Date.now() - startedAt
  const result = evaluate({ ok, status, body, durationMs, expectCommit, slowThresholdMs })

  console.log(
    JSON.stringify({
      url,
      healthy: result.healthy,
      httpStatus: status,
      durationMs,
      slow: result.slow,
      commit: result.payload?.commit ?? null,
      problems: result.problems,
    }),
  )

  if (result.healthy) {
    console.log(`OK: ${url} is up (${durationMs}ms, commit ${result.payload?.commit})`)
    return 0
  }

  console.error(`FAILED: ${url} — ${result.problems.join('; ')}`)
  const reported = await reportToSentry({
    dsn: process.env.SENTRY_DSN,
    url,
    problems: result.problems,
    durationMs,
    payload: result.payload,
  })
  console.error(reported ? 'reported to Sentry' : 'not reported (no usable SENTRY_DSN)')
  return 1
}

// Only run when executed directly, so the pure helpers above stay unit-testable.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main())
}
