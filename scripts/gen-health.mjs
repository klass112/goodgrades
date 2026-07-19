#!/usr/bin/env node
/**
 * Emits apps/web/public/health.json before the Vite build.
 *
 * The static site is the only thing we can deploy on the current free tier, so
 * this file is how we prove a given commit actually reached production: CI sets
 * GIT_COMMIT, and the smoke test asserts the deployed health.json matches the
 * SHA it just pushed. See docs/decisions/0002-hosting.md.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const outPath = join(repoRoot, 'apps/web/public/health.json')

const payload = {
  status: 'ok',
  service: 'goodgrades-web',
  commit: process.env.GIT_COMMIT ?? 'dev',
  builtAt: process.env.BUILD_TIME ?? new Date().toISOString(),
  env: process.env.APP_ENV ?? 'development',
}

await mkdir(dirname(outPath), { recursive: true })
await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`)
console.log(`wrote ${outPath} (commit=${payload.commit})`)
