# 0001 — Stack

- **Status:** accepted
- **Date:** 2026-07-19
- **Decider:** Founding engineer (decision authority granted in KLA-3)

## Context

GoodGrades is a mobile app that scans printed answer sheets and grades them via
image processing (Roboflow), sold as a freemium subscription to teachers in
Thailand. The product surface is therefore:

1. a **mobile app** (iOS + Android) — the actual product,
2. a **backend API** — accounts, subscription entitlements, scan history, and the
   server-side call to Roboflow (an inference API key must never ship inside a
   mobile binary),
3. a small **web presence** — landing page now, admin/console later.

We need all three to share types and a single CI pipeline, and we need to be able
to move hosting later: the CEO has floated Firebase but that has not been decided,
and this ticket explicitly forbids recurring cost without approval.

## Decision

TypeScript everywhere, in one pnpm workspace monorepo.

| Concern | Choice |
|---|---|
| Language | TypeScript 5.6, `strict` + `noUncheckedIndexedAccess` |
| Runtime | Node 22 LTS |
| Package manager | pnpm 9 workspaces |
| API framework | Hono |
| Web | Vite + React 18 |
| Lint + format | Biome |
| Tests | Vitest |
| CI | GitHub Actions |

Layout:

```
apps/api     Hono API — createApp() factory, /health
apps/web     Vite + React static site (deployed today)
packages/    shared types/domain logic (added when there is a second consumer)
docs/decisions/
scripts/
```

## Why these

**TypeScript on both ends.** One language across API, web, and (later) a React
Native mobile client means one toolchain, one lint config, and shared types for
the API contract. With a team of one, toolchain count is the real cost driver.

**Hono over Express/Fastify.** Hono is built on the standard `fetch` Request and
Response, so the exact same `createApp()` runs on Node, Cloudflare Workers, Bun,
Deno, and inside a Firebase Cloud Function. Since the hosting decision is
explicitly still open (see `0002-hosting.md`), picking a framework that does not
bind us to a runtime keeps that a two-way door. It also tests without a live
socket — `app.request('/health')` returns a Response — which keeps CI fast.

**Vite + React.** Boring, fast, and the React knowledge carries directly to React
Native for the mobile app. Static output deploys anywhere.

**Biome over ESLint + Prettier.** One binary, one config file, no plugin
resolution, ~5ms on this repo. ESLint's ecosystem advantage is real but it is an
advantage we do not need yet.

**Vitest.** Shares the Vite transform pipeline, so no separate Babel/ts-jest
config. Same runner for both apps.

## Rejected

- **Next.js.** A full-stack React framework is a natural default, but our primary
  client is a mobile app, not a website. Next would give us SSR we do not need and
  would couple the API to a React deployment target. Reconsider if the web console
  becomes a major surface.
- **Express.** The default answer, and fine, but it is Node-only and its
  middleware types are weak. Hono costs nothing extra and preserves runtime
  choice.
- **NestJS.** Good structure at team scale, too much ceremony for one engineer and
  an empty repo. The DI and module layers would be scaffolding around ~40 lines of
  real logic.
- **Firebase SDK as the application framework** (writing everything as Cloud
  Functions directly). This is still very plausible as a *hosting* target and the
  CEO has raised it — but writing routes against the Functions API directly would
  weld us to Firebase before we have costed it. Hono runs *inside* a Cloud
  Function, so we can adopt Firebase later without rewriting route code.
- **Python for the API.** Tempting because image processing is Python-shaped, but
  Roboflow is a hosted HTTP API — we call it, we do not run models ourselves. That
  removes the main reason to split languages.
- **npm/yarn.** pnpm's workspace handling and disk usage are strictly better and
  it is what CI caches cleanly.
- **Turborepo/Nx.** Build orchestration for a two-package repo is premature.
  `pnpm -r` is enough. Revisit when CI time becomes a complaint.

## Consequences

- Anything runtime-specific in the API must stay behind an adapter. `src/server.ts`
  is the Node adapter; `src/app.ts` must remain runtime-agnostic.
- `packages/` is intentionally empty until a second consumer exists.
- Mobile (React Native / Expo) is assumed but **not** decided here — it gets its
  own record when we start it.
