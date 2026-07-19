import { defineConfig } from 'vitest/config'

// Deliberately NOT at the repo root: vitest walks up from a package looking for
// `vitest.config.*`, so a root-level config gets silently inherited by
// apps/* that have none, overriding their include patterns and breaking their
// suites. Keeping it in scripts/ makes it reachable only via an explicit
// --config, which is how the root `test` script invokes it.
export default defineConfig({
  test: {
    include: ['**/*.test.mjs'],
    environment: 'node',
  },
})
