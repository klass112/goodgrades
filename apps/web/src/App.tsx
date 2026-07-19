import { BOOM_PARAM, triggerDeliberateError } from './observability/debug-error.js'

export interface AppProps {
  commit: string
  builtAt: string
  /**
   * Set from `?boom=<marker>`. When present the app throws during render, which
   * is what a real component crash looks like — so the error boundary and Sentry
   * see the same shape of failure they would in an actual regression.
   */
  boomMarker?: string | null
}

export function App({ commit, builtAt, boomMarker = null }: AppProps) {
  if (boomMarker) triggerDeliberateError(boomMarker)

  return (
    <main>
      <h1>GoodGrades</h1>
      <p>Answer-sheet scanning for teachers. Skeleton deploy — no product features yet.</p>
      <dl>
        <dt>commit</dt>
        <dd data-testid="commit">{commit}</dd>
        <dt>built</dt>
        <dd data-testid="built-at">{builtAt}</dd>
      </dl>
      <p>
        <a href="health.json">health.json</a>
      </p>
      <p>
        <a data-testid="boom-link" href={`?${BOOM_PARAM}=manual`} rel="nofollow">
          Trigger a test error
        </a>{' '}
        <small>(reports to Sentry — see docs/operations.md)</small>
      </p>
    </main>
  )
}
