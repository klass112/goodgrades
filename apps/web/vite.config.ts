/// <reference types="vitest" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const commit = process.env.GIT_COMMIT ?? 'dev'
const builtAt = process.env.BUILD_TIME ?? 'unknown'

// GitHub Pages serves project sites from /<repo>/, so the base path has to match.
// BASE_PATH is set by .github/workflows/deploy.yml; '/' keeps local dev normal.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  define: {
    __GIT_COMMIT__: JSON.stringify(commit),
    __BUILD_TIME__: JSON.stringify(builtAt),
  },
  build: {
    // Published alongside the bundle so Sentry can fetch them over HTTP and turn
    // minified frames into real file/line numbers. We have no Sentry auth token
    // in this environment, so upload-at-build-time is not available and public
    // fetch is the only symbolication route we have. The repo is already public
    // (docs/decisions/0002-hosting.md), so this leaks nothing that isn't on
    // GitHub already. Revisit if the site ever ships non-public logic.
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
