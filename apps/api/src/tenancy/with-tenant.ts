import type { Database, Queryable } from '../db/client.js'

/**
 * The tenant boundary. This is the only supported way to read or write
 * org-scoped data, and it is the reason isolation is not a per-handler concern.
 *
 * Inside the callback, every statement runs:
 *   - as `app_user`, a role that is not the table owner and has no BYPASSRLS,
 *     so the FORCEd row-level security policies from 001_init.sql actually
 *     apply rather than being skipped; and
 *   - with `app.current_org_id` set to this tenant, which is what those
 *     policies compare against.
 *
 * The practical consequence, and the thing worth remembering: a handler that
 * writes `SELECT * FROM memberships` with no WHERE clause gets only its own
 * tenant's rows. A handler that deliberately asks for another org's row by
 * primary key gets nothing. There is no query you can write in here that
 * returns another tenant's data.
 *
 * Both settings are LOCAL, so they are scoped to the transaction and are
 * discarded on COMMIT or ROLLBACK. That is what makes this safe on a pooled
 * connection: the role and org cannot leak into whatever runs next.
 */
export async function withTenant<T>(
  db: Database,
  orgId: string,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // SET LOCAL ROLE takes no parameters, so orgId cannot go here -- but this
    // value is a constant, and the org id below is bound properly.
    await tx.query('SET LOCAL ROLE app_user')
    // set_config(..., is_local = true) is the parameterisable form of SET LOCAL.
    // Using it rather than string-interpolating into `SET LOCAL app.current_org_id`
    // keeps an attacker-supplied org id from becoming SQL.
    await tx.query('SELECT set_config($1, $2, true)', ['app.current_org_id', orgId])

    return fn(tx)
  })
}

/**
 * Escape hatch for the operations that legitimately have no tenant yet: signup,
 * login, and password reset all have to touch the database *in order to work
 * out* which tenant the caller belongs to.
 *
 * Named to be conspicuous in review and in grep. If this appears outside
 * src/auth/, that is a bug worth chasing down: it runs as the owning role and
 * RLS does not constrain it.
 */
export async function withoutTenantIsolation<T>(
  db: Database,
  reason: string,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  void reason // documentation at the call site; kept in the signature so it is mandatory
  return db.transaction(fn)
}
