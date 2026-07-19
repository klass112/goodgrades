/**
 * A deliberate, on-demand failure used to prove the error-reporting path works
 * end to end in the *deployed* environment — not just in a unit test.
 *
 * KLA-7's success condition is "trigger a deliberate error in production and see
 * it in Sentry with a usable stack trace", and an alerting pipeline nobody has
 * ever fired is a pipeline you are only guessing works. Keeping this in the
 * shipped bundle means we can re-verify after any deploy, SDK upgrade, or Sentry
 * migration instead of trusting that it still works.
 *
 * Safety: it requires an explicit `?boom=` query param, it only breaks the
 * client tab of whoever triggered it, and today the site is a build-metadata
 * skeleton with no data or session to corrupt. Once real product features land
 * this should move behind an env flag — tracked in docs/decisions/0003-observability.md.
 */

export const BOOM_PARAM = 'boom'

export class DeliberateTestError extends Error {
  readonly marker: string

  constructor(marker: string) {
    super(`Deliberate test error [${marker}] — KLA-7 observability verification`)
    this.name = 'DeliberateTestError'
    this.marker = marker
  }
}

/**
 * Nested on purpose: a one-frame stack proves nothing about whether stack traces
 * are readable. This gives Sentry several frames to symbolicate.
 */
function formatReportRow(marker: string): string {
  throw new DeliberateTestError(marker)
}

function buildReport(marker: string): string[] {
  return [formatReportRow(marker)]
}

export function triggerDeliberateError(marker: string): never {
  buildReport(marker)
  // Unreachable: buildReport always throws. Present so the return type is honest.
  throw new DeliberateTestError(marker)
}

/**
 * Reads the deliberate-error marker out of a query string.
 * `?boom` with no value still counts — returns a default marker.
 */
export function readBoomMarker(search: string): string | null {
  const value = new URLSearchParams(search).get(BOOM_PARAM)
  if (value === null) return null
  return value === '' ? 'unnamed' : value
}
