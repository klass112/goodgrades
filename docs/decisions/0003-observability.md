# 0003 — Observability: error tracking, logging, uptime

- **Status:** accepted, with **one open question escalated to the CEO** (Sentry tenancy)
- **Date:** 2026-07-19
- **Decider:** Founding engineer (KLA-7)

## Context

We have no QA, no staging environment, and one engineer. The realistic failure
mode is not "we ship a bug" — it is "we ship a bug and find out weeks later from
a teacher who gave up and went back to marking by hand."

So the bar for this work was not "add a logging library." It was: **can we
demonstrate a failure travelling from production to a human, with enough detail
to fix it, without a user telling us first?**

## Decision

### Error tracking: Sentry

Sentry is the boring, well-understood choice — the SDK surface, the release
tagging, and the source-map story are all things the next five engineers will
already know.

Crucially, an instance is already reachable from this environment
(`sentry.ex.maxiondev.com`, org `maxiongame`), which makes it the *only* error
tracker we can adopt without either a credit card or an interactive vendor
signup — the same constraint that decided hosting in `0002-hosting.md`. Two
projects created: `goodgrades-web` and `goodgrades-api`.

**Rejected:**

- **Sentry SaaS free tier** — better isolation, but signup is interactive and
  email-verified, which I cannot complete non-interactively and should not do on
  the company's behalf without the CEO picking the vendor.
- **GlitchTip** (self-hosted, Sentry-compatible) — would need a host we do not
  have. Same blocker as the API.
- **Rolling our own error endpoint** — a week of work to build a worse Sentry.

### Source maps: published, not uploaded

Sentry symbolicates by fetching `.map` files over HTTP from the deployed site.

This is *not* the preferred approach — uploading maps at build time via
`@sentry/vite-plugin` is more reliable and keeps maps private. We do not do that
because it requires a Sentry auth token, and this environment holds no Sentry
credential (the MCP connection is not something CI can use).

The cost is that source maps are publicly readable. That is acceptable **only
because the repo is already public** (`0002-hosting.md`) — the maps expose
nothing that is not already on GitHub. **If the repo ever goes private, this must
change to token-based upload in the same commit**, or we silently start leaking
source that we had decided to close.

The deploy fails if no `.map` files are emitted, so this degrades loudly.

### Structured logging: hand-rolled, ~100 lines

JSON lines to stdout, with an `AsyncLocalStorage`-backed request ID that is also
echoed as the `x-request-id` response header (and reused from an inbound header,
so correlation survives a proxy).

**Rejected: pino/winston.** Pino is excellent on Node, but the API's actual
deploy target is Cloudflare Workers, where the ecosystem around Node logging
transports is a liability rather than an asset. The thing we needed — one JSON
line per request with a correlation ID — is genuinely small, and writing it kept
the API runtime-agnostic. Revisit if we outgrow it; this is a two-way door.

Sensitive keys are redacted at the logger boundary rather than at call sites,
because "remember to redact" is not a control that survives contact with a
deadline.

### Uptime: a GitHub Actions cron, reporting into Sentry

Every 15 minutes, a workflow polls `health.json` and checks status, JSON
validity, the reported commit, and latency. **Failures are reported into the same
Sentry project as application errors.**

That last part is the actual design decision. The alternative — UptimeRobot or
similar — means a second vendor, a second login, and a second inbox. With a
one-person team, the failure mode of a monitoring tool is not that it misses an
outage; it is that nobody looks at it. One inbox, one alert rule.

**Accepted limitations:** GitHub cron is best-effort and can be delayed, giving
~15 min resolution at best. And if GitHub stops scheduling the job entirely,
silence is indistinguishable from health — a dedicated uptime service would catch
that and this does not.

**Replace this when** we have paying users, or an SLA, or the CEO approves a
vendor. It is a deliberate "good enough for pre-revenue" choice, not a belief that
it is the right long-term answer.

### The deliberate error stays in the production bundle

`?boom=<marker>` throws a real render error. Keeping it shipped means the
pipeline can be re-verified after any deploy, SDK upgrade, or Sentry migration —
rather than trusting that something verified once still works.

Safe today: it requires an explicit query param, only affects the tab of whoever
triggered it, and the site currently holds no data or session to corrupt. **Once
real product features land, this should move behind an env flag** so it cannot be
triggered against a logged-in user's session.

## Open question for the CEO — Sentry tenancy

**We are using a Sentry instance that belongs to another organisation**
(`maxiongame` at `sentry.ex.maxiondev.com`), because it is what this environment
provides and it is free. Klass Corp's production error data — which will
eventually include user emails, request paths, and possibly student data in error
payloads — would live in someone else's Sentry tenant, under someone else's
access control and retention policy.

That is fine for a skeleton app with no users. It is **not** fine once we have
real teachers and real student data.

**Recommendation:** stay on it for now (zero cost, zero setup, unblocks KLA-7),
and move to a Klass Corp-owned Sentry — SaaS free tier is 5k errors/month and
needs no card — before the first real user account exists.

**Default if I hear nothing:** I will keep using the shared instance for
pre-release development and will raise this again as a blocker on whichever issue
first puts real user data in production. Migrating is a DSN change and a config
change — under a day — so this is a two-way door as long as we walk through it
before launch.

## Consequences

- Error tracking, logging, and uptime all funnel into one Sentry inbox.
- Every event is tagged with the commit SHA, so "which deploy broke this" is
  answerable.
- `pnpm status` answers up/erroring/slow in one command with no setup.
- The API's instrumentation is **unverified in production** — it is unit-tested
  but the API is not deployed (KLA-9). Server-side logging and error reporting
  should be re-verified against the real deploy the moment Cloudflare credentials
  land. Until then, treat it as "written and tested", not "known working".
- `@sentry/node` does not run on Cloudflare Workers. `app.ts` therefore imports
  only a *type* from the Sentry module (erased at compile time under
  `verbatimModuleSyntax`), and takes `captureError` as an injectable option.
  `server.ts` — the Node entrypoint — is the only place that wires the real
  Sentry-backed implementation. The consequence to be honest about: the deployed
  Workers entrypoint currently gets the **no-op** `captureError`, so API errors
  in production would be logged but would not raise a Sentry issue. The seam to
  fix it exists (`AppOptions.captureError`); wiring `@sentry/cloudflare` into
  `worker.ts` is the follow-up. This is called out rather than papered over
  because a monitoring gap you know about is a task, and one you don't is an
  outage.
