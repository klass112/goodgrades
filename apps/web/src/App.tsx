export interface AppProps {
  commit: string
  builtAt: string
}

export function App({ commit, builtAt }: AppProps) {
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
    </main>
  )
}
