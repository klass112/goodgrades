#!/usr/bin/env node
/**
 * `pnpm status` — the one command that answers the three questions you have at
 * 2am: is it up, is it erroring, is it slow.
 *
 * We have no QA and no ops team, so the bar here is that a single command with
 * no prior setup gives a useful answer. It degrades gracefully: without a
 * SENTRY_AUTH_TOKEN it still reports uptime and latency and prints the Sentry
 * link to open. See docs/operations.md.
 *
 * Env:
 *   HEALTH_URL          override the target (default: the deployed web app)
 *   SENTRY_AUTH_TOKEN   optional; enables the "is it erroring" section inline
 *   SENTRY_HOST / SENTRY_ORG / SENTRY_PROJECT  override Sentry lookup targets
 */
import { evaluate } from './uptime-check.mjs'

const HEALTH_URL = process.env.HEALTH_URL ?? 'https://klass112.github.io/goodgrades/health.json'
const SENTRY_HOST = process.env.SENTRY_HOST ?? 'https://sentry.ex.maxiondev.com'
const SENTRY_ORG = process.env.SENTRY_ORG ?? 'maxiongame'
const SENTRY_PROJECT = process.env.SENTRY_PROJECT ?? 'goodgrades-web'
const SAMPLES = 3
const SLOW_THRESHOLD_MS = Number(process.env.SLOW_THRESHOLD_MS ?? 2000)

// Colour only when we are attached to a terminal, so piping to a file or CI log
// yields clean text. NO_COLOR is honoured per https://no-color.org.
const useColour = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code) => (s) => (useColour ? `\u001b[${code}m${s}\u001b[0m` : s)
const bold = paint(1)
const green = paint(32)
const red = paint(31)
const yellow = paint(33)

async function sample(url) {
  const startedAt = Date.now()
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'cache-control': 'no-cache' },
    })
    const body = await response.text()
    return { ok: response.ok, status: response.status, body, durationMs: Date.now() - startedAt }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: '',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function checkUptime() {
  console.log(bold('\n▸ Is it up?'))
  const results = []
  for (let i = 0; i < SAMPLES; i += 1) results.push(await sample(HEALTH_URL))

  const evaluated = results.map((r) =>
    evaluate({ ...r, expectCommit: null, slowThresholdMs: SLOW_THRESHOLD_MS }),
  )
  const healthy = evaluated.filter((e) => e.healthy).length
  const payload = evaluated.find((e) => e.payload)?.payload

  if (healthy === SAMPLES) {
    console.log(`  ${green('UP')}  ${HEALTH_URL}`)
  } else if (healthy > 0) {
    console.log(`  ${yellow('FLAPPING')}  ${healthy}/${SAMPLES} checks passed — ${HEALTH_URL}`)
  } else {
    console.log(`  ${red('DOWN')}  ${HEALTH_URL}`)
    for (const problem of evaluated[0].problems) console.log(`         ${problem}`)
    if (results[0].error) console.log(`         ${results[0].error}`)
  }

  if (payload) {
    console.log(`  commit ${payload.commit}  built ${payload.builtAt}  env ${payload.env}`)
  }

  console.log(bold('\n▸ Is it slow?'))
  const times = results.map((r) => r.durationMs).sort((a, b) => a - b)
  const median = times[Math.floor(times.length / 2)]
  const worst = times[times.length - 1]
  const verdict = worst > SLOW_THRESHOLD_MS ? red('SLOW') : green('OK')
  console.log(
    `  ${verdict}  median ${median}ms, worst ${worst}ms (threshold ${SLOW_THRESHOLD_MS}ms)`,
  )
  console.log(`  samples: ${times.join('ms, ')}ms`)

  return healthy === SAMPLES
}

async function checkErrors() {
  console.log(bold('\n▸ Is it erroring?'))
  const issuesUrl = `${SENTRY_HOST}/organizations/${SENTRY_ORG}/issues/?project=&query=is%3Aunresolved&statsPeriod=24h`
  const token = process.env.SENTRY_AUTH_TOKEN

  if (!token) {
    console.log(`  ${yellow('SENTRY_AUTH_TOKEN not set')} — open the dashboard directly:`)
    console.log(`  ${issuesUrl}`)
    return null
  }

  try {
    const response = await fetch(
      `${SENTRY_HOST}/api/0/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/issues/?query=is:unresolved&statsPeriod=24h`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
    )
    if (!response.ok) {
      console.log(`  ${yellow(`Sentry API returned HTTP ${response.status}`)} — ${issuesUrl}`)
      return null
    }
    const issues = await response.json()
    if (issues.length === 0) {
      console.log(`  ${green('NO UNRESOLVED ISSUES')} in the last 24h`)
      return true
    }
    console.log(`  ${red(`${issues.length} unresolved issue(s)`)} in the last 24h:`)
    for (const issue of issues.slice(0, 10)) {
      console.log(`    [${issue.count}x] ${issue.title}`)
      console.log(`           ${issue.permalink}`)
    }
    return false
  } catch (error) {
    console.log(`  ${yellow('could not reach Sentry')}: ${error.message}`)
    console.log(`  ${issuesUrl}`)
    return null
  }
}

const up = await checkUptime()
await checkErrors()
console.log('')
process.exit(up ? 0 : 1)
