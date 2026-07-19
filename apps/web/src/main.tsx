import * as Sentry from '@sentry/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { readBoomMarker } from './observability/debug-error.js'
import { initSentry } from './observability/sentry.js'

// Before render, so a crash while mounting is still reported.
initSentry({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  release: __GIT_COMMIT__,
  environment: import.meta.env.VITE_APP_ENV ?? 'development',
})

const root = document.getElementById('root')
if (!root) throw new Error('#root missing from index.html')

createRoot(root).render(
  <StrictMode>
    <Sentry.ErrorBoundary
      fallback={
        <main>
          <h1>Something broke</h1>
          <p>The error has been reported. Try reloading.</p>
        </main>
      }
    >
      <App
        commit={__GIT_COMMIT__}
        builtAt={__BUILD_TIME__}
        boomMarker={readBoomMarker(window.location.search)}
      />
    </Sentry.ErrorBoundary>
  </StrictMode>,
)
