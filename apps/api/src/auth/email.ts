/**
 * Email normalisation. Every write and every lookup goes through this, which is
 * what lets `users_email_key` be a plain unique index instead of a functional
 * one -- see the note in 001_init.sql.
 *
 * Lowercasing only. We deliberately do NOT strip dots or +tags: those rules are
 * Gmail's, not the SMTP standard's, and applying them universally silently
 * merges accounts on providers where the local part really is case- and
 * dot-significant.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Shape check, not a validity check. Deliverability is only ever proven by
 * sending mail, so this rejects the obviously-wrong and lets the rest through
 * rather than pretending a regex can decide.
 */
export function isPlausibleEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254
}

/** URL-safe workspace slug derived from the organization name. */
export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

  // Names can be entirely non-Latin (the market includes Thai), in which case
  // the transform above yields an empty string. Fall back rather than fail:
  // the slug is a URL convenience, never an identifier we look rows up by.
  return base || 'workspace'
}
