/**
 * Password hashing.
 *
 * PBKDF2-HMAC-SHA256 via WebCrypto, not scrypt or argon2. The reason is runtime
 * portability: the API host is still an open decision (0002-hosting), and
 * Cloudflare Workers is the leading candidate. Workers has WebCrypto but not
 * `node:crypto`'s scrypt and no native modules, so scrypt would quietly rule out
 * a host we may well pick. PBKDF2 at OWASP's recommended iteration count is the
 * strongest thing that runs everywhere we might deploy.
 *
 * This is a real tradeoff, not a free one: PBKDF2 is cheaper to attack on GPUs
 * than a memory-hard KDF. It is mitigated by the stored format below carrying
 * its own algorithm and cost, and by `needsRehash`, so moving to argon2id later
 * is a login-time upgrade rather than a migration or a forced password reset.
 */

/** OWASP's 2023 floor for PBKDF2-HMAC-SHA256. Raise it, never lower it. */
export const DEFAULT_ITERATIONS = 600_000

const KEY_BYTES = 32
const SALT_BYTES = 16
const ALGORITHM = 'pbkdf2-sha256'

export interface HashOptions {
  /** Lowered in tests, where the cost buys nothing and 600k iterations per case does not pay for itself. */
  iterations?: number
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'))
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )

  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    KEY_BYTES * 8,
  )

  return new Uint8Array(bits)
}

/** Returns a self-describing string: `pbkdf2-sha256$<iterations>$<salt>$<hash>`. */
export async function hashPassword(password: string, options: HashOptions = {}): Promise<string> {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const hash = await derive(password, salt, iterations)

  return `${ALGORITHM}$${iterations}$${toBase64(salt)}$${toBase64(hash)}`
}

/**
 * Constant-time comparison. A length-varying or early-exit compare here leaks
 * how much of a guessed hash was right, one byte at a time.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number)
  return diff === 0
}

export interface ParsedHash {
  algorithm: string
  iterations: number
  salt: Uint8Array
  hash: Uint8Array
}

export function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$')
  if (parts.length !== 4) return null

  const [algorithm, iterationsRaw, saltRaw, hashRaw] = parts as [string, string, string, string]
  if (algorithm !== ALGORITHM) return null

  const iterations = Number(iterationsRaw)
  if (!Number.isInteger(iterations) || iterations <= 0) return null

  try {
    return { algorithm, iterations, salt: fromBase64(saltRaw), hash: fromBase64(hashRaw) }
  } catch {
    return null
  }
}

/**
 * Verifies a password. Returns false rather than throwing on a malformed stored
 * hash: a corrupt row should fail one login, not 500 the whole endpoint.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored)
  if (!parsed) return false

  const candidate = await derive(password, parsed.salt, parsed.iterations)
  return timingSafeEqual(candidate, parsed.hash)
}

/**
 * True when a stored hash was made with weaker parameters than we now use.
 * Call after a successful login — that is the only moment the plaintext is in
 * hand — and re-hash if it returns true.
 */
export function needsRehash(stored: string, options: HashOptions = {}): boolean {
  const parsed = parseHash(stored)
  if (!parsed) return true
  return parsed.iterations < (options.iterations ?? DEFAULT_ITERATIONS)
}
