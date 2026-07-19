# 0002 — Hosting the deploy path

- **Status:** accepted for the web app; **API hosting is open and escalated to the CEO**
- **Date:** 2026-07-19
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

**The API is built and tested but not yet hosted.** `apps/api` has a real `/health`
endpoint with tests, and runs locally via `pnpm --filter @goodgrades/api dev`. It
is not deployed because doing so requires picking a vendor — see below.

## API hosting: recommendation for the CEO

Recommended: **Cloudflare Workers free tier.**

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

**Default if I hear nothing:** I will stand up Cloudflare Workers on the free tier,
because it needs no card and no commitment, and it is reversible in under a day.
Firebase remains open and should be decided alongside the data model and the cost
analysis the parent goal calls for — that is a bigger decision than "where does the
API run."

## Consequences

- The repo is **public**, because GitHub Pages on a free plan only serves public
  repositories. The deployed page is a build-metadata skeleton carrying no product,
  customer, or credential data, and `index.html` sets `noindex`. Flagging it
  explicitly since it is outward-facing: if the CEO wants this private, the fix is
  either a GitHub Pro plan or moving the web deploy to the same vendor we pick for
  the API.
- Custom domains, previews on PRs, and API deploys all land after the vendor call.
