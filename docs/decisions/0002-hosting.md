# 0002 — Hosting the deploy path

- **Status:** accepted — web on GitHub Pages, **API on Cloudflare Workers**
- **Date:** 2026-07-19 (API hosting resolved on the stated default, KLA-9)
- **Decider:** Founding engineer (hosting-provider authority granted in KLA-3, limited to free tier)

## Context

KLA-3 requires that a push to `main` automatically deploys and that the deployed
URL responds — with no recurring cost and no credit card without CEO approval.

The constraint that actually decided this: the only cloud credential this
environment holds is a GitHub token (`repo`, `workflow`, `admin:org`). Every other
free-tier host — Cloudflare, Render, Fly, Vercel, Netlify, Firebase — requires
creating an account through an interactive signup and email verification, which
cannot be completed non-interactively and which I should not do on the company's
behalf without the CEO choosing the vendor anyway.

## Decision

**Deploy the static web app to GitHub Pages via GitHub Actions.** Free, no card,
no new vendor relationship, and it uses a credential we already hold.

To make the deploy *verifiable* rather than merely green, `scripts/gen-health.mjs`
writes `health.json` at build time containing the commit SHA that CI is building.
The deploy job then polls the live URL and fails unless `health.json` reports the
exact SHA that triggered it. A passing deploy is therefore proof that this commit
is what the public URL is serving — not just proof that a job exited 0.

**Deploy the API to Cloudflare Workers on the free tier.** KLA-9 escalated this to
the CEO with Cloudflare as the recommendation and the stated default; no objection
was raised, so the default stands. `apps/api/wrangler.toml` and
`.github/workflows/deploy-api.yml` implement it.

`src/worker.ts` is the Workers entry point. It shares `createApp` with the Node
server, so route code is runtime-agnostic and the only difference is where build
metadata comes from: `process.env` on Node, deploy-injected `vars` on Workers.
That is why `readBuildInfo` takes a plain `BuildEnv` record rather than
`NodeJS.ProcessEnv`.

**Remaining to go live: the Cloudflare account itself.** This environment holds a
GitHub token and nothing else, so the account creation and token minting are a CEO
action. See "Enabling the deploy" below. Until the secrets exist the deploy job
reports a clear skip rather than a red X — a credential we are knowingly waiting on
is not a broken build — and becomes a real deploy the moment they are added, with
no code change.

## API hosting: why Cloudflare

Chosen: **Cloudflare Workers free tier.**

- 100k requests/day free, no credit card required to start.
- Hono was chosen partly because it runs on Workers natively (`0001-stack.md`), so
  adopting it is a config change, not a rewrite.
- Deploys from GitHub Actions with an API token — same pipeline shape as Pages.

Alternatives considered:

- **Firebase (CEO's stated preference).** Spark tier is free and genuinely good for
  what we need — Auth, Firestore, and Cloud Functions in one place, and Auth alone
  is worth a lot of avoided work. The catch: Cloud Functions require the **Blaze**
  (pay-as-you-go) plan, which needs a credit card. Blaze has a free monthly
  allowance so the realistic bill at zero traffic is ~$0, but it is an
  uncapped-by-default billing relationship and therefore a CEO decision, not mine.
  This is worth taking seriously — the auth and data story is stronger than
  Cloudflare's, and cost analysis is already in scope for the parent goal.
- **Render / Railway free tiers.** Simplest mental model, but free instances sleep
  after inactivity, which means multi-second cold starts on a mobile scan request.
  Bad fit for the product's core interaction.
- **Supabase free tier.** Strong Postgres + Auth story; worth revisiting when we
  design the data model, but it does not host our API process.

Firebase remains open and should be decided alongside the data model and the cost
analysis the parent goal calls for — that is a bigger decision than "where does the
API run." Nothing here forecloses it: the Workers adapter is 39 lines and
`createApp` is untouched, so moving to Cloud Functions is a new entry point and a
new workflow, not a rewrite.

## Enabling the deploy

One-time CEO action, ~5 minutes, no credit card:

1. Create a free Cloudflare account (the Workers free plan does not ask for a card).
2. Workers &amp; Pages → API tokens → create a token with the **Edit Cloudflare Workers**
   template. Copy the token and the Account ID.
3. In the GitHub repo → Settings → Secrets and variables → Actions, add secrets
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. Re-run the **Deploy API** workflow. It prints the deployed URL
   (`https://goodgrades-api.<subdomain>.workers.dev`).
5. Add that URL as the repository **variable** `API_URL` so the smoke test can
   verify it. The smoke test fails the deploy if `/health` does not echo the exact
   commit SHA that triggered it — the same contract the web deploy holds itself to.

Steps 4 and 5 are ordered that way because the URL is not known until the first
deploy. The first run deploys and then fails the smoke test with an explicit
"set `API_URL`" message; the second run is green.

## Consequences

- The repo is **public**, because GitHub Pages on a free plan only serves public
  repositories. The deployed page is a build-metadata skeleton carrying no product,
  customer, or credential data, and `index.html` sets `noindex`. Flagging it
  explicitly since it is outward-facing: if the CEO wants this private, the fix is
  either a GitHub Pro plan or moving the web deploy to the same vendor we pick for
  the API.
- Custom domains, previews on PRs, and API deploys all land after the vendor call.
