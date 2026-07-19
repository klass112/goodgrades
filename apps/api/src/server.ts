import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { captureError, initSentry } from './observability/sentry.js'

// Runs once per process, before the first request, so `enabled` is settled
// before any route can call captureError. No-ops cleanly when SENTRY_DSN is
// unset, which is every environment today (see docs/decisions/0002-hosting.md).
initSentry()

const port = Number(process.env.PORT ?? 8080)

// captureError is passed explicitly rather than relying on createApp's
// default: @sentry/node is a Node SDK, and this is the only entrypoint that
// should ever load it (see the comment on the ErrorContext import in app.ts —
// the Cloudflare Workers entrypoint shares createApp and must stay Sentry-free).
serve({ fetch: createApp({ captureError }).fetch, port }, (info) => {
  console.log(`goodgrades-api listening on http://localhost:${info.port}`)
})
