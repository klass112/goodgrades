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
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
