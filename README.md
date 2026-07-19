# GoodGrades

Answer-sheet scanning and grading for teachers. Scan a printed answer sheet with a
phone, get graded results back.

This repo is the skeleton: the deploy path works before the features exist.

## Status

| Surface | State |
|---|---|
| `apps/web` | Deployed to GitHub Pages on every push to `main` |
| `apps/api` | Builds, tested, runs locally — **hosting not yet chosen** ([0002](docs/decisions/0002-hosting.md)) |
| Mobile app | Not started |

## Layout

```
apps/api     Hono API (Node). createApp() is runtime-agnostic; server.ts is the Node adapter.
apps/web     Vite + React static site.
packages/    Shared code. Empty until something is actually shared.
scripts/     Build-time helpers.
docs/decisions/  Architecture decision records.
```

## Requirements

- Node 22+
- pnpm 9 (`corepack enable`)

## Getting started

```bash
pnpm install

pnpm --filter @goodgrades/api dev    # http://localhost:8080
pnpm --filter @goodgrades/web dev    # http://localhost:5173
```

## Checks

These are exactly what CI runs — if they pass locally, CI passes.

```bash
pnpm lint        # biome check
pnpm format      # biome check --write
pnpm typecheck   # tsc across all packages
pnpm test        # vitest across all packages
```

## Health endpoints

Both surfaces expose the commit they were built from, so you can tell what is
actually deployed:

- web: `GET /health.json` — generated at build time by `scripts/gen-health.mjs`
- api: `GET /health` — reads `GIT_COMMIT` / `BUILD_TIME` / `APP_ENV` from the env

```json
{ "status": "ok", "service": "goodgrades-web", "commit": "<sha>", "builtAt": "...", "env": "production" }
```

The deploy workflow polls the live `health.json` and fails unless it reports the
SHA being deployed, so a green deploy means that commit is live.

## CI/CD

- `.github/workflows/ci.yml` — lint, typecheck, test on every push and PR.
- `.github/workflows/deploy.yml` — on push to `main`: build web, publish to Pages,
  smoke-test the live URL.

## Decisions

- [0001 — Stack](docs/decisions/0001-stack.md)
- [0002 — Hosting](docs/decisions/0002-hosting.md)
- [0003 — Tenancy and the account model](docs/decisions/0003-tenancy.md)

## Tenant isolation

Read `docs/decisions/0003-tenancy.md` before writing a query that touches tenant
data. The short version: isolation is enforced by Postgres row-level security,
not by `WHERE org_id = ?` in handlers.

Every read or write of tenant data goes through `withTenant(db, orgId, ...)`
(`apps/api/src/tenancy/with-tenant.ts`). Inside it, queries run as a role the RLS
policies apply to, so a missing filter returns *nothing* rather than another
tenant's rows. `apps/api/src/auth/routes.ts` has a worked example to copy.

The exception is `withoutTenantIsolation`, used only by signup, login, and
password reset — the operations that must run before a tenant is known. If it
appears anywhere outside `apps/api/src/auth/`, that is a bug.
