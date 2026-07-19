import { defineConfig } from 'vitest/config'

/**
 * Without this file, vitest walks up and picks up the repo-root config, whose
 * include is scoped to `scripts/**` — so `pnpm --filter @goodgrades/api test`
 * silently matched zero files and every API test was skipped. Explicit config
 * per app; the root one stays scoped to scripts.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // PGlite boots a WASM Postgres per suite, which is a second or two on a
    // cold CI runner — comfortably under the default 5s, but not by so much
    // that a loaded machine cannot blow through it.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
