# Operations

How to tell whether GoodGrades is working, and what to do when it is not.

We have no QA and no on-call rotation. Instrumentation is the safety net, so the
rule is: **you should learn about a failure from this page's tooling, not from a
user.** If you ever find out about a break some other way, that is a gap worth
filing.

---

## The 30-second check

```bash
pnpm status
```

Answers all three questions at once — is it up, is it erroring, is it slow — and
exits non-zero if the site is down, so it is safe to use in a script.

Example output:

```
▸ Is it up?
  UP  https://klass112.github.io/goodgrades/health.json
  commit 53d817af555ccbf8021f216284730930dd27938b  built 2026-07-19T16:48:50Z  env production

▸ Is it slow?
  OK  median 68ms, worst 346ms (threshold 2000ms)
  samples: 24ms, 68ms, 346ms

▸ Is it erroring?
  SENTRY_AUTH_TOKEN not set — open the dashboard directly:
  https://sentry.ex.maxiondev.com/organizations/maxiongame/issues/?...
```

Set `SENTRY_AUTH_TOKEN` (a Sentry user auth token with `project:read`) to get the
error section inline instead of a link. It is optional on purpose — the command
has to work for someone who just cloned the repo.

Useful overrides: `HEALTH_URL`, `SLOW_THRESHOLD_MS`, `SENTRY_ORG`, `SENTRY_PROJECT`.

---

## Is it up?

| What | Where |
|---|---|
| Web health endpoint | <https://klass112.github.io/goodgrades/health.json> |
| Automated check | **Uptime** workflow, every 15 min ([runs](https://github.com/klass112/goodgrades/actions/workflows/uptime.yml)) |
| One-off check | `pnpm uptime` |

`health.json` reports the commit SHA currently being served. That is the point:
it distinguishes "the deploy is green" from "the deploy actually reached users".
Both the deploy smoke test and the uptime check compare it against an expected
SHA.

The uptime check fails on any of: non-2xx, a non-JSON body (a Pages 404 returns
HTML with a 200 — this catches that), `status != "ok"`, a stale commit, or a
response slower than `SLOW_THRESHOLD_MS`.

**When the uptime check fails it reports an event into the same Sentry project as
app errors**, so there is one inbox and one alert rule rather than a second
monitoring tool nobody logs into. Look for `UptimeCheckFailed`.

### Caveat you should know about

GitHub's scheduled workflows are best-effort and can be delayed under load. This
is a *"we will know within the hour"* monitor, not a pager. That is an accepted
trade while we have no users — see `docs/decisions/0003-observability.md` for the
trigger to replace it.

---

## Is it erroring?

Error tracking is **Sentry**, self-hosted at `sentry.ex.maxiondev.com`.

| Project | Covers | Status |
|---|---|---|
| [`goodgrades-web`](https://sentry.ex.maxiondev.com/organizations/maxiongame/projects/goodgrades-web/) | Browser app + uptime checks | **Live** |
| [`goodgrades-api`](https://sentry.ex.maxiondev.com/organizations/maxiongame/projects/goodgrades-api/) | The API | Wired, but the API is not deployed yet (KLA-9) |

Every event carries:

- **release** — the commit SHA, so you can tell which deploy introduced a
  regression and whether a fix actually shipped.
- **environment** — `production` vs `development`.
- **service** tag — `goodgrades-web`.

### Reading a stack trace

Source maps are published next to the bundle, so Sentry resolves minified frames
back to real files and line numbers. If you ever see raw minified frames
(`index-abc123.js:1:4821`), the source maps did not publish — check the "Verify
source maps were emitted" step in the Deploy web workflow.

---

## Is it slow?

`pnpm status` reports median and worst latency over 3 samples against the health
endpoint.

Beyond that, the browser SDK samples 10% of sessions for performance traces —
visible under **Performance** in Sentry. The sample rate is deliberately low
because we are on a single self-hosted Sentry node with no quota headroom; raise
it when we actually have traffic worth measuring.

This is the weakest of the three signals today, and that is a known gap. A static
page has essentially no server-side latency to measure — real latency numbers
start mattering when the API is deployed and doing scan work.

---

## Verifying the pipeline still works

An alerting pipeline nobody has ever fired is a pipeline you are only guessing
works. Re-run this after any deploy change, SDK upgrade, or Sentry migration:

1. Open <https://klass112.github.io/goodgrades/?boom=manual>
   (or click "Trigger a test error" on the page).
2. The page shows the error-boundary fallback: *"Something broke"*.
3. Within ~30s a `DeliberateTestError` appears in the `goodgrades-web` Sentry
   project, tagged with the release SHA you just deployed.
4. Confirm the stack trace names `formatReportRow` / `buildReport` and points at
   `src/observability/debug-error.ts`. If it shows minified frames instead,
   source-map publishing has regressed.

Use a distinct marker (`?boom=whatever`) so you can tell your test error apart
from someone else's in the issue's tag breakdown.

Resolve the test issue in Sentry afterwards so the inbox stays meaningful.

---

## Structured logging

The API logs one JSON line per request to stdout, carrying a `requestId` that is
also returned on the response as the `x-request-id` header. An inbound
`x-request-id` is reused rather than replaced, so correlation survives a proxy.

Given a request ID from a user report or a Sentry event, that ID is the join key
across the request log line, any application logs emitted during the request, and
the Sentry event.

Sensitive keys (`authorization`, `cookie`, `password`, `token`, `secret`) are
redacted before anything is written.

`LOG_LEVEL` (`debug|info|warn|error`, default `info`) controls verbosity.

**Where to read these once the API is deployed:** Cloudflare Workers observability
is enabled in `wrangler.toml`, so logs land in the Cloudflare dashboard under
Workers → `goodgrades-api` → Logs, and `wrangler tail` streams them live.

---

## Alerting

The `goodgrades-web` Sentry project alerts on **a new issue being seen**, which is
the signal that matters when you have no users yet: a *new* kind of failure. Alert
delivery goes to the Sentry org's configured members.

Deliberately **not** configured yet: volume/spike thresholds. With near-zero
traffic they would only produce noise. Add them when there is a baseline to
threshold against.

---

## Known gaps

Being explicit so these are decisions rather than oversights:

- **The API is instrumented but not deployed.** Structured logging, request
  correlation, and the sanitized-500 path are tested and verified against a
  locally running server, but have never run in production. Blocked on
  Cloudflare credentials (KLA-9).
- **The API has no *Sentry* reporting on its real runtime.** `@sentry/node` is a
  Node SDK and is loaded only by `server.ts` (local dev). The deployed
  entrypoint is `worker.ts` on Cloudflare Workers, where `captureError` is
  currently the no-op default — so an API 500 in production would be logged to
  Cloudflare but would **not** raise a Sentry issue. Closing this needs
  `@sentry/cloudflare` wired into `worker.ts` through the existing injectable
  `captureError` option. Tracked as a follow-up; it is deliberately not faked.
- **Uptime resolution is ~15 min and best-effort**, not a pager.
- **Sentry is a shared, borrowed instance** (`maxiongame`) rather than a Klass
  Corp tenant. See `docs/decisions/0003-observability.md` — this needs a CEO call.
- **No alerting on the uptime workflow failing to run at all.** If GitHub stops
  scheduling it, silence looks like health. Fixing this needs an external
  heartbeat service.
