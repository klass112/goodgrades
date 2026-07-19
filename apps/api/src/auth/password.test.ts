import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ITERATIONS,
  hashPassword,
  needsRehash,
  parseHash,
  verifyPassword,
} from './password.js'

// Real hashing at minimum cost. The iteration count is a policy choice, asserted
// separately below; grinding 600k rounds per case would prove nothing extra.
const fast = { iterations: 1 }

describe('hashPassword', () => {
  it('produces a self-describing hash', async () => {
    const stored = await hashPassword('a-good-password', fast)
    expect(parseHash(stored)).toMatchObject({ algorithm: 'pbkdf2-sha256', iterations: 1 })
  })

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('a-good-password', fast)
    const b = await hashPassword('a-good-password', fast)

    // Without a per-hash salt, identical passwords collide and a single rainbow
    // table cracks every user who picked the same one.
    expect(a).not.toBe(b)
  })

  it('defaults to the OWASP iteration count', async () => {
    expect(DEFAULT_ITERATIONS).toBeGreaterThanOrEqual(600_000)
  })
})

describe('verifyPassword', () => {
  it('accepts the right password', async () => {
    const stored = await hashPassword('a-good-password', fast)
    expect(await verifyPassword('a-good-password', stored)).toBe(true)
  })

  it('rejects the wrong password', async () => {
    const stored = await hashPassword('a-good-password', fast)
    expect(await verifyPassword('a-bad-password', stored)).toBe(false)
  })

  it('rejects a near-miss', async () => {
    const stored = await hashPassword('a-good-password', fast)
    expect(await verifyPassword('a-good-passworD', stored)).toBe(false)
  })

  it('returns false rather than throwing on a corrupt hash', async () => {
    // One bad row should cost one failed login, not a 500 on the endpoint.
    for (const corrupt of ['', 'garbage', 'pbkdf2-sha256$notanumber$x$y', 'md5$1$x$y']) {
      expect(await verifyPassword('a-good-password', corrupt)).toBe(false)
    }
  })

  it('verifies against the iteration count recorded in the hash, not the current default', async () => {
    // This is what makes raising DEFAULT_ITERATIONS a safe change: existing
    // users keep logging in with their old parameters.
    const stored = await hashPassword('a-good-password', { iterations: 3 })
    expect(await verifyPassword('a-good-password', stored)).toBe(true)
  })
})

describe('needsRehash', () => {
  it('flags a hash weaker than current policy', async () => {
    const stored = await hashPassword('a-good-password', { iterations: 10 })
    expect(needsRehash(stored, { iterations: 100 })).toBe(true)
  })

  it('leaves a hash at current policy alone', async () => {
    const stored = await hashPassword('a-good-password', { iterations: 100 })
    expect(needsRehash(stored, { iterations: 100 })).toBe(false)
  })

  it('flags anything unparseable, so a bad row gets replaced on next login', () => {
    expect(needsRehash('garbage')).toBe(true)
  })
})
