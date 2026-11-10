// The web access password (design-web.md §4.2 "Password"): an scrypt hash, computed off the main
// thread, a few at a time.
//
// Off the main thread: Node's callback `crypto.scrypt` runs on the libuv thread pool, so main's
// event loop (every window's IPC, the ptys, the gateway) keeps going while a hash is computed. The
// synchronous `scryptSync` would stall the whole app for each attempt, so it is never used here.
// A few at a time: each hash takes SCRYPT_MAXMEM-sized memory and a pool thread (the pool has 4 by
// default and is shared with file I/O and DNS), so `PasswordHasher` caps how many run at once and
// queues the rest. The attempt limiter (auth.ts) already bounds how many sign-ins reach it; this cap
// is what keeps a burst of them from taking every pool thread and the memory with it.
//
// Encoded as `scrypt$<N>$<r>$<p>$<salt>$<hash>` (base64url), so a stored hash keeps working when the
// defaults change. A stored hash is still untrusted text (a hand-edited file): parameters outside
// sane bounds read as damaged, never as an order to allocate gigabytes.
//
// Compares are constant time (`timingSafeEqual` over equal-length keys); a damaged or missing hash
// still costs one full hash, so the time taken does not say whether a password is set.
// No regexes (the project rule for parsing stored text): `split` and number checks.
import { randomBytes, scrypt as nodeScryptCallback, timingSafeEqual } from 'node:crypto'

export interface ScryptOptions {
  N: number
  r: number
  p: number
  maxmem: number
}

/** The async scrypt (main: Node's thread-pool one); tests pass a fake to count and gate calls. */
export type ScryptFn = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) => Promise<Buffer>

/**
 * N = 2^15, r = 8, p = 3: one of OWASP's equal-cost forms of its scrypt minimum (N = 2^17, r = 8, p = 1),
 * about 100-300 ms and 32 MiB per hash. The p lanes run one after another in Node, so p buys time at
 * the memory of p = 1: SCRYPT_MAXMEM and the parse bounds below need no change. p = 1 at 2^15 was a
 * quarter of OWASP's cost; stored hashes carry their own parameters, so old ones keep working.
 */
export const SCRYPT_DEFAULTS = Object.freeze({ N: 2 ** 15, r: 8, p: 3 })
const KEY_LENGTH = 32
const SALT_LENGTH = 16
/** Room for N=2^16 (128 * N * r = 64 MiB); Node's default 32 MiB is exactly the defaults' need and refuses them. */
export const SCRYPT_MAXMEM = 128 * 2 ** 16 * 8 + 1024 * 1024
/** Hashes computed at once; the rest wait their turn. */
export const DEFAULT_MAX_CONCURRENT = 2

/** Shortest password the desktop accepts. Guessing is slowed to about one a second (auth.ts), not stopped. */
export const MIN_PASSWORD_LENGTH = 8
/** A cap so a sign-in body cannot make scrypt hash megabytes; far above any real password. */
export const MAX_PASSWORD_LENGTH = 256

/** Node's `crypto.scrypt`, callback form: runs on the libuv thread pool, never on main's thread. */
export const nodeScrypt: ScryptFn = (password, salt, keylen, options) =>
  new Promise((resolve, reject) => {
    nodeScryptCallback(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)))
  })

/**
 * The password as hashed: NFC, so the same password typed on a phone keyboard (which may compose
 * accents differently) and on the desktop is the same bytes.
 */
export function normalizePassword(password: string): string {
  return password.normalize('NFC')
}

/** Why a password cannot be set, or undefined when it can. Counted in code points, as people count. */
export function passwordProblem(password: unknown): string | undefined {
  if (typeof password !== 'string') return 'the password must be text'
  const length = [...normalizePassword(password)].length
  if (length < MIN_PASSWORD_LENGTH) return `the password needs at least ${MIN_PASSWORD_LENGTH} characters`
  if (length > MAX_PASSWORD_LENGTH) return `the password may have at most ${MAX_PASSWORD_LENGTH} characters`
  return undefined
}

interface Parsed {
  N: number
  r: number
  p: number
  salt: Buffer
  hash: Buffer
}

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0
}

function intOf(text: string | undefined): number {
  if (text === undefined || text === '' || text.length > 8) return NaN
  for (const ch of text) if (ch < '0' || ch > '9') return NaN
  return Number(text)
}

/** A stored hash's parts, or undefined when it is damaged or asks for unreasonable work. */
export function parsePasswordHash(encoded: string): Parsed | undefined {
  const parts = encoded.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return undefined
  const N = intOf(parts[1])
  const r = intOf(parts[2])
  const p = intOf(parts[3])
  // Bounds: at least 2^10 (anything less is no hash), at most what SCRYPT_MAXMEM allows.
  if (!isPowerOfTwo(N) || N < 2 ** 10 || N > 2 ** 16 || r < 1 || r > 8 || p < 1 || p > 4) return undefined
  const salt = Buffer.from(parts[4] ?? '', 'base64url')
  const hash = Buffer.from(parts[5] ?? '', 'base64url')
  if (salt.length < 8 || hash.length !== KEY_LENGTH) return undefined
  return { N, r, p, salt, hash }
}

export interface PasswordHasherOptions {
  scrypt?: ScryptFn
  maxConcurrent?: number
  /** Cost of new hashes (tests use a small N). Stored hashes carry their own. */
  params?: { N: number; r: number; p: number }
}

/** Hashes and checks passwords with scrypt, at most `maxConcurrent` at a time (see the header). */
export class PasswordHasher {
  private readonly scrypt: ScryptFn
  private readonly maxConcurrent: number
  private readonly params: { N: number; r: number; p: number }
  private running = 0
  private readonly waiting: Array<() => void> = []

  constructor(options: PasswordHasherOptions = {}) {
    this.scrypt = options.scrypt ?? nodeScrypt
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)
    this.params = options.params ?? SCRYPT_DEFAULTS
  }

  /** The stored form of a new password (a fresh salt each time). */
  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH)
    const { N, r, p } = this.params
    const key = await this.derive(normalizePassword(password), salt, N, r, p)
    return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`
  }

  /**
   * Whether `password` matches `encoded`. A damaged or missing hash (undefined) still costs one hash
   * with the defaults, then answers false: the time taken does not say whether a password is set.
   */
  async verify(password: string, encoded: string | undefined): Promise<boolean> {
    const parsed = encoded === undefined ? undefined : parsePasswordHash(encoded)
    const { N, r, p } = parsed ?? this.params
    const salt = parsed?.salt ?? Buffer.alloc(SALT_LENGTH)
    const key = await this.derive(normalizePassword(password), salt, N, r, p)
    const expected = parsed?.hash ?? Buffer.alloc(KEY_LENGTH)
    // Same length always (KEY_LENGTH both sides): timingSafeEqual never throws here.
    const same = key.length === expected.length && timingSafeEqual(key, expected)
    return same && parsed !== undefined
  }

  /** How many hashes are computing now (tests). */
  get active(): number {
    return this.running
  }

  private async derive(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
    await this.slot()
    try {
      return await this.scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: SCRYPT_MAXMEM })
    } finally {
      this.release()
    }
  }

  private slot(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++
      return Promise.resolve()
    }
    // The slot is handed over in release(): `running` stays counted for the next in line.
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.running--
  }
}
