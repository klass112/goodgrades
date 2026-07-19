# 0003 — Tenancy and the account model

- **Status:** proposed — **awaiting CEO sign-off (KLA-4)**. Implemented on
  `feat/kla-4-auth-clean` and not merged to `main` until that sign-off lands.
- **Date:** 2026-07-19
- **Decider:** Founding engineer, proposing; CEO signs off (one-way door)

> **Numbering:** KLA-4 asked for this at `0002-tenancy.md`, but `0002` was already
> taken by the hosting ADR. This is `0003`. Flagging so nobody goes looking for a
> file that does not exist.

## Context

Every feature we build after this one inherits the shape of a user. Retrofitting
tenancy onto a single-tenant schema means touching every table, every query, and
every handler at once, under time pressure, with live customer data. So the
decision is made now, while the cost of being wrong is one day of work.

The product is answer-sheet scanning and grading for teachers. The realistic unit
of account is **a school or a department**, not an individual teacher: teachers
share classes, hand over marking, and leave. Building around individual accounts
would force a painful migration the first time a school asks for shared access —
and schools are the customers who pay.

## Decision

### 1. Users are global; membership is the join

```
users ──< memberships >── organizations
              (role)
```

One human, one credential, many workspaces. A `membership` row carries the
`role`, so the same person can own one workspace and be a plain member of
another.

Rejected: **a user row per tenant.** It makes "same person, two schools" into two
accounts with two passwords, and it makes email a non-unique column, which breaks
password reset in a way that is not fixable without merging accounts by hand.

### 2. Shared schema, `org_id` discriminator

All tenant data lives in shared tables with an `org_id` column.

Rejected: **schema-per-tenant** and **database-per-tenant.** Both give stronger
isolation, and both cost operational work per customer — migrations fan out,
connection counts multiply, and cross-tenant reporting turns into a distributed
query. At our scale (zero customers, targeting schools rather than enterprises)
that is a large bill for a guarantee we can get another way. Revisit if we ever
sell to a customer with a data-residency requirement.

### 3. Isolation is enforced by Postgres row-level security, not by handlers

This is the part worth arguing about, so here is the reasoning in full.

The common approach is `WHERE org_id = ?` in every query. It works exactly as
long as every developer remembers it, forever, in every query, including the
ones written at 5pm on a Friday. It is a policy enforced by discipline, and the
failure mode is silent: the query returns *more* data, not an error. Nothing
fails, no test goes red, and a customer sees another school's marks.

Instead, every org-scoped table has RLS `ENABLE`d **and `FORCE`d**, with a policy
comparing `org_id` against a transaction-local setting. `withTenant()`
(`src/tenancy/with-tenant.ts`) opens a transaction, switches to the non-owner
`app_user` role, sets `app.current_org_id`, and runs the callback.

The consequences are worth stating plainly:

- A handler that writes `SELECT * FROM memberships` with no filter gets only its
  own tenant's rows.
- A handler that *deliberately* selects another tenant's row by primary key gets
  zero rows.
- A handler that forgets to open a tenant context gets zero rows, not every row —
  `current_setting` returns NULL, and `org_id = NULL` is never true. **It fails
  closed.**
- `WITH CHECK` on each policy means a tenant cannot forge rows into another
  tenant either. Read *and* write.

`FORCE` matters as much as `ENABLE`: without it, RLS is skipped for the table
owner, which is the role migrations run as.

All of this is asserted in `src/tenancy/isolation.test.ts`, including a
schema-wide guard that fails if any future table grows an `org_id` without RLS —
so the migration that forgets is caught by CI rather than by a customer.

Cost, honestly stated: RLS is invisible in the query text, so a developer reading
a handler cannot see why it is safe. That is what the comments in `with-tenant.ts`
and the copy-this-shape example in `routes.ts` are for. There is also a small
per-query planner cost, irrelevant at our size.

### 4. Sessions are opaque tokens in the database, not JWTs

A session row binds `(user_id, org_id)`. Switching workspace mints a new session
rather than mutating one, so a stolen cookie cannot be widened to another tenant.

Rejected: **JWTs.** "Log out everywhere" and "kill all sessions on password
reset" are both requirements, and both need a server-side revocation list — which
is the very table a JWT is supposed to save you from. We would pay JWT's
complexity and keep the table anyway.

Tokens are 256 bits from a CSPRNG and stored **SHA-256 hashed**, so a database
dump does not hand over live sessions. Expiry slides on use: 7 days idle.

### 5. Passwords: PBKDF2-HMAC-SHA256, 600k iterations, via WebCrypto

Not the strongest available, and chosen deliberately. `main` now deploys the API
to **Cloudflare Workers** (0002), where there is no `node:crypto` scrypt and no
native modules. Argon2id and scrypt would rule out the runtime we just adopted.

The stored format is self-describing — `pbkdf2-sha256$<iterations>$<salt>$<hash>`
— and `needsRehash()` upgrades a password on next successful login. Moving to
argon2id later is a config change, not a migration or a forced reset.

## The open question this surfaced: where does Postgres actually live?

This design needs "some Postgres", which every candidate provides. But **the API
now runs on Cloudflare Workers, which cannot open a raw TCP connection to a
database.** Workers + Postgres means one of:

- **Neon** (HTTP driver, free tier, no card) — smallest change, works today.
- **Supabase** (free tier) — Postgres whose entire security model *is* RLS, so
  this design is native to it. Also brings storage, which the scanning feature
  will want.
- **Cloudflare Hyperdrive** — keeps us on one vendor, but needs a paid Workers
  plan for most useful configurations.

**Recommendation: Supabase free tier**, using it as plain Postgres (not its auth,
which would duplicate what is built here). It is the only option that also
answers the "where do scanned answer sheets live" question we hit next.

This is a vendor decision with a free tier and no card, and it is reversible —
the `Database` interface in `src/db/client.ts` is the entire surface a provider
has to satisfy. **Defaulting to Supabase unless the CEO says otherwise.**

## Consequences

- `PGlite` (real Postgres, WASM, in-process) is the test and local-dev database.
  Tests exercise genuine RLS with no Docker and no service container, which is
  why CI can prove tenant isolation on a plain runner.
- There is no production Postgres adapter yet — writing one against a provider we
  have not chosen would be untested code. It is a small file behind
  `src/db/client.ts` once the provider is picked.
- Password reset issues and validates tokens but **does not send email**. There is
  no mail vendor (a CEO call). The endpoint answers `202` with
  `delivery: 'pending_provider'` rather than claiming a mail was sent.
- Roles are `owner | admin | member` and are currently only *recorded*. Nothing
  enforces role-based permissions yet — that belongs with the features that need
  it (KLA-5), not invented ahead of them.
- Invites do not exist, so today an organization has exactly one member. The model
  supports more; the flow to add them is KLA-5 work.
