/**
 * Opaque bearer tokens for sessions and password resets.
 *
 * Not JWTs, deliberately. A JWT cannot be revoked without keeping the very
 * server-side table a JWT is meant to avoid, and "log out everywhere" and
 * "invalidate sessions on password reset" are both hard requirements here. A
 * random opaque token backed by a row gives us revocation for free; the cost is
 * one indexed lookup per request, which is not a cost worth optimising away yet.
 */

const TOKEN_BYTES = 32

/** 256 bits from a CSPRNG, base64url so it is safe in a cookie or a URL. */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))
  return Buffer.from(bytes).toString('base64url')
}

/**
 * What we actually store. Tokens are hashed at rest for the same reason
 * passwords are: a leaked database dump, a log line, or a backup should not
 * hand over live sessions. SHA-256 with no salt and no stretching is correct
 * here and would be wrong for a password -- the input is already 256 bits of
 * uniform randomness, so there is no dictionary to attack and nothing for a
 * work factor to buy.
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Buffer.from(new Uint8Array(digest)).toString('base64url')
}
