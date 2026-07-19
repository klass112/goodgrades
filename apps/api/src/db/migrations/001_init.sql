-- 001_init — users, organizations, membership, sessions, password resets.
--
-- Tenant isolation is enforced here, in the database, not in handlers.
-- Every org-scoped table has RLS ENABLED + FORCED and a policy keyed on the
-- `app.current_org_id` setting, which src/tenancy/with-tenant.ts sets per
-- transaction. A handler that forgets a WHERE clause returns zero rows rather
-- than another tenant's data. See docs/decisions/0003-tenancy.md.

-- The role every request runs as. NOLOGIN: it is only ever reached via
-- SET LOCAL ROLE inside a transaction, never connected to directly. It is
-- deliberately not the table owner, and owns nothing, so it cannot ALTER its
-- way out of the policies below.
CREATE ROLE app_user NOLOGIN;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

-- Users are GLOBAL, not per-tenant: one human, one credential, many orgs.
-- Consequence: this table is not org-scoped and therefore not RLS-keyed on
-- org_id. Reads of it are constrained by the membership join in the policy
-- below, so you can only see users you share an organization with.
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text NOT NULL,
  name          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Emails are normalised to lowercase by the application before they ever reach
-- SQL (see auth/email.ts). The index is on the raw column rather than
-- lower(email) so that the constraint fails loudly if that ever stops being
-- true, instead of silently allowing Bob@x.com and bob@x.com to coexist.
CREATE UNIQUE INDEX users_email_key ON users (email);

CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX organizations_slug_key ON organizations (slug);

-- Membership is the join, and it is where roles live. A role is a property of
-- (user, org), never of a user: the same person can own one workspace and be a
-- read-only member of another.
CREATE TABLE memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX memberships_org_user_key ON memberships (org_id, user_id);
CREATE INDEX memberships_user_idx ON memberships (user_id);

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------

-- A session is bound to (user, org). Switching workspace issues a new session
-- rather than mutating this one, so a leaked cookie can never be widened to a
-- different tenant than the one it was minted for.
--
-- token_hash, not token: we store sha256(token) so that a database dump does
-- not hand over live sessions. The plaintext exists only in the cookie.
CREATE TABLE sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  org_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  token_hash     text NOT NULL,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz
);

CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Single-use, short-lived, and hashed for the same reason sessions are.
CREATE TABLE password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX password_reset_tokens_token_hash_key ON password_reset_tokens (token_hash);
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
--
-- FORCE is what makes this real: without it, RLS is skipped for the table owner,
-- which is exactly who migrations run as. With it, only a BYPASSRLS superuser
-- can see across tenants, and app_user is not one.
--
-- current_setting(..., true) returns NULL when unset. Every policy compares
-- against it with `=`, so an unset org id yields NULL — not true — and the
-- query returns nothing. Forgetting to open a tenant context fails closed.

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organizations_tenant_isolation ON organizations
  USING (id::text = current_setting('app.current_org_id', true))
  WITH CHECK (id::text = current_setting('app.current_org_id', true));

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_tenant_isolation ON memberships
  USING (org_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (org_id::text = current_setting('app.current_org_id', true));

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_tenant_isolation ON sessions
  USING (org_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (org_id::text = current_setting('app.current_org_id', true));

-- Users are visible only through a shared organization. This is the one policy
-- that is a join rather than a column compare, because `users` has no org_id --
-- that is the price of global identity, and it is charged exactly once, here.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_visible_within_org ON users
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = users.id
        AND m.org_id::text = current_setting('app.current_org_id', true)
    )
  );

-- password_reset_tokens is deliberately NOT granted to app_user at all. Reset
-- happens before any tenant context exists, so it is handled by the privileged
-- path in auth/service.ts. Enable RLS with no permissive policy so that if a
-- grant is ever added by accident, the table still reads as empty.
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- app_user gets DML on tenant tables and nothing else: no DDL, no TRUNCATE, and
-- no access to password_reset_tokens.

GRANT SELECT, INSERT, UPDATE, DELETE ON organizations TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO app_user;
GRANT SELECT, UPDATE ON users TO app_user;
