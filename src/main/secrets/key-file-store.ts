// The key file secret store: server mode's `SecretStore` (design-web.md §9.5 "Secrets without a
// keyring"). A server rarely has a Secret Service, and safeStorage then falls back to Chromium's
// built-in key, which secret-store.ts refuses; so server mode always encrypts with a key of its
// own in `<data>/secret.key`, and the desktop always uses the keychain (selectSecretStore).
//
// Rules:
//  - The key is 32 random bytes, made on the first start with `O_CREAT | O_EXCL` and mode 0600 at
//    open (umask can only narrow it; never a chmod after, which would leave a window with the file
//    wider). It is never made again over an existing file, whatever is wrong with it: replacing it
//    would lose every secret silently. A file that fails a check is left as it is, and the store is
//    unavailable with the reason, as a missing keychain is on the desktop.
//  - It is opened with `O_NOFOLLOW | O_NONBLOCK` and checked by `fstat` on that descriptor, so the
//    file checked is the file read (no check-then-use gap). O_NOFOLLOW refuses a symlink at the
//    path; O_NONBLOCK keeps a FIFO planted at the path from blocking the open (and so main's start)
//    for ever: the open returns and fstat refuses it. Refused when it is not a regular file, not
//    the user's, has any group or other bit, or is not 32 bytes.
//  - Values are AES-256-GCM with a random 96-bit IV per value: `KEYFILE-V1:` + base64(iv, tag,
//    ciphertext). The GCM tag authenticates: one changed byte, or another key, fails the decrypt
//    instead of returning garbage.
//  - A new key made while `KEYFILE-V1:` values exist (a restored backup, a deleted key file): start
//    logs it with the count, and those values answer "the key file was replaced: enter it again".
//    `replacedCount()` recounts the values the current key cannot authenticate, at each call, for
//    `ccc web status`: a value entered again drops out of the count, and the count survives a
//    restart (the key file then exists and no longer says it was just made).
//  - Each store refuses the other's values with a text that says which (secret-store.ts): no mixed
//    reads, no selection by what the data dir happens to hold.
//  - Same protection as `~/.claude/.credentials.json`: whoever reads the data dir as the user, or
//    root, reads the secrets; disk encryption is the server's job (§9.5).
//  - Errors never carry the plaintext, the ciphertext or the key.
//
// Node `crypto` and `fs` only, no `electron`: unit tests run it in plain Node in a temp dir.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { FAKE_PREFIX, KEYFILE_PREFIX, SecretStoreError, STORED_BY_KEYCHAIN, type SecretStore } from './secret-store'
import { ownerOnlyMode } from '../paths'
import { warnLog } from '../warn-log'

/** The key's length: AES-256. */
export const KEY_FILE_BYTES = 32
/** GCM's recommended IV length (96 bits). */
const IV_BYTES = 12
/** GCM's full tag. */
const TAG_BYTES = 16

/** What a value made under an earlier key answers (§9.5). */
export const REPLACED_KEY_TEXT = 'the key file was replaced: enter it again'

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** The slice of `fstat`'s result the checks read. */
export interface KeyFileStat {
  isFile(): boolean
  uid: number
  mode: number
  size: number
}

/** The fs calls the store makes; injectable so a test can fake an owner or a failure. */
export interface KeyFileFs {
  openSync(path: string, flags: number, mode?: number): number
  fstatSync(fd: number): KeyFileStat
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number
  writeSync(fd: number, buffer: Buffer, offset: number, length: number): number
  fsyncSync(fd: number): void
  closeSync(fd: number): void
  unlinkSync(path: string): void
}

export interface KeyFileStoreOptions {
  /** `<data>/secret.key` (paths.ts). */
  path: string
  /**
   * Every stored value in the data dir now (`storedSecretValues`, secret-store.ts). Read when the
   * key is made (the count to log) and by `replacedCount()`.
   */
  storedValues: () => string[]
  /** The owner the file must have; default the process's uid (no owner check where there is none). */
  uid?: number
  fs?: Partial<KeyFileFs>
  random?: (size: number) => Buffer
  log?: (message: string) => void
}

/** The key file store, with the count `ccc web status` shows. */
export interface KeyFileSecretStore extends SecretStore {
  readonly kind: 'keyfile'
  /** How many stored `KEYFILE-V1:` values the current key cannot read (made under a replaced key); 0 when unavailable. */
  replacedCount(): number
  /** Whether a stored value is a key file value this key cannot authenticate (the same test `replacedCount` counts). */
  isReplaced(stored: string): boolean
}

type Loaded = { key: Buffer; made: boolean } | { reason: string }

/** The code of a node fs error, or undefined. */
function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** Reads exactly `size` bytes from the start of `fd`, or fewer when the file is shorter. */
function readAll(fs: KeyFileFs, fd: number, size: number): Buffer {
  const buf = Buffer.alloc(size)
  let got = 0
  while (got < size) {
    const n = fs.readSync(fd, buf, got, size - got, got)
    if (n === 0) break
    got += n
  }
  return buf.subarray(0, got)
}

/**
 * A first start killed between the O_EXCL open and the end of the write leaves a short file; it is
 * never replaced (a key file is never written over), so the reason says what to do about it.
 */
function wrongLength(path: string): string {
  return (
    `the key file ${path} is not ${KEY_FILE_BYTES} bytes (a first start cut short, or a damaged file; ` +
    `delete it and enter the secrets again: nothing was encrypted under a file of the wrong length)`
  )
}

/**
 * Opens and checks an existing key file: the key, or why it is refused. `undefined` when there is
 * no file at the path (the caller makes one).
 */
function readKeyFile(fs: KeyFileFs, path: string, uid: number | undefined): Loaded | undefined {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = nodeFs.constants
  let fd: number
  try {
    fd = fs.openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (err) {
    const code = codeOf(err)
    if (code === 'ENOENT') return undefined
    // O_NOFOLLOW on a symlink: ELOOP on Linux and macOS (EMLINK on FreeBSD).
    if (code === 'ELOOP' || code === 'EMLINK') return { reason: `the key file ${path} is a symbolic link` }
    return {
      reason: `the key file ${path} cannot be opened (${code ?? 'error'})`
    }
  }
  try {
    // The checks run on the descriptor just opened: the file checked is the file read.
    const st = fs.fstatSync(fd)
    if (!st.isFile()) return { reason: `the key file ${path} is not a regular file` }
    if (uid !== undefined && st.uid !== uid) return { reason: `the key file ${path} is not owned by this user` }
    if (!ownerOnlyMode(st.mode)) {
      const mode = (st.mode & 0o777).toString(8).padStart(3, '0')
      return {
        reason: `the key file ${path} is open to group or others (mode ${mode}); it must be 600`
      }
    }
    if (st.size !== KEY_FILE_BYTES) return { reason: wrongLength(path) }
    const key = readAll(fs, fd, KEY_FILE_BYTES)
    // Shorter than fstat said (truncated in between): refused the same way.
    if (key.length !== KEY_FILE_BYTES) return { reason: wrongLength(path) }
    return { key, made: false }
  } catch (err) {
    return {
      reason: `the key file ${path} cannot be read (${codeOf(err) ?? 'error'})`
    }
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* nothing to do */
    }
  }
}

/**
 * Makes the key file: `O_EXCL` so an existing file (or a symlink, which O_EXCL never follows) is
 * never written over, mode 0600 at open. The key, or why it could not be made.
 */
function makeKeyFile(fs: KeyFileFs, path: string, random: (size: number) => Buffer): Loaded | 'exists' {
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = nodeFs.constants
  let fd: number
  try {
    fd = fs.openSync(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  } catch (err) {
    const code = codeOf(err)
    if (code === 'EEXIST') return 'exists'
    return {
      reason: `the key file ${path} cannot be made (${code ?? 'error'})`
    }
  }
  let key: Buffer
  try {
    // Inside the try: an entropy failure must not leave the empty file just made.
    key = random(KEY_FILE_BYTES)
    let done = 0
    while (done < key.length) {
      const n = fs.writeSync(fd, key, done, key.length - done)
      // A write that returns 0 would spin forever.
      if (n <= 0)
        throw Object.assign(new Error('write made no progress'), {
          code: 'EIO'
        })
      done += n
    }
    fs.fsyncSync(fd)
    fs.closeSync(fd)
  } catch (err) {
    // A partial key file would be refused at every later start (wrong length) and never replaced;
    // this one is ours, made by the O_EXCL open above, so it goes.
    try {
      fs.closeSync(fd)
    } catch {
      /* the unlink below matters (a second close after a failed one in the try is harmless) */
    }
    try {
      fs.unlinkSync(path)
    } catch {
      /* left for the next start to refuse with its reason */
    }
    return {
      reason: `the key file ${path} cannot be written (${codeOf(err) ?? 'error'})`
    }
  }
  return { key, made: true }
}

/** Splits a `KEYFILE-V1:` value into its parts, or undefined when it is damaged. */
function partsOf(stored: string): { iv: Buffer; tag: Buffer; data: Buffer } | undefined {
  const body = stored.slice(KEYFILE_PREFIX.length)
  if (!BASE64.test(body)) return undefined
  const raw = Buffer.from(body, 'base64')
  if (raw.length < IV_BYTES + TAG_BYTES) return undefined
  return {
    iv: raw.subarray(0, IV_BYTES),
    tag: raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
    data: raw.subarray(IV_BYTES + TAG_BYTES)
  }
}

/** The plaintext, or undefined when the tag does not authenticate under `key`. */
function open(key: Buffer, parts: { iv: Buffer; tag: Buffer; data: Buffer }): string | undefined {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, parts.iv, {
      authTagLength: TAG_BYTES
    })
    decipher.setAuthTag(parts.tag)
    return Buffer.concat([decipher.update(parts.data), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

/** Whether a stored value is a key file value this key cannot authenticate (a replaced key). */
function unreadable(key: Buffer, stored: string): boolean {
  if (!stored.startsWith(KEYFILE_PREFIX)) return false
  const parts = partsOf(stored)
  return parts !== undefined && open(key, parts) === undefined
}

/**
 * Server mode's store. The key is loaded (or made) here, at start: a refused file is reported by
 * `unavailableReason` for the whole run, never retried by making a new one.
 */
export function keyFileSecretStore(options: KeyFileStoreOptions): KeyFileSecretStore {
  const fs: KeyFileFs = { ...(nodeFs as unknown as KeyFileFs), ...options.fs }
  const uid = options.uid ?? process.getuid?.()
  const random = options.random ?? randomBytes
  const log = options.log ?? warnLog
  const path = options.path

  const load = (): Loaded => {
    const existing = readKeyFile(fs, path, uid)
    if (existing !== undefined) return existing
    // Counted before the key is made: every key file value on disk now was made under another key.
    let earlier = 0
    try {
      earlier = options.storedValues().filter((v) => v.startsWith(KEYFILE_PREFIX)).length
    } catch {
      /* counted as none: the log line is the only use */
    }
    const made = makeKeyFile(fs, path, random)
    // Made by someone else between the two opens: read theirs, never write over it.
    if (made === 'exists')
      return (
        readKeyFile(fs, path, uid) ?? {
          reason: `the key file ${path} cannot be opened`
        }
      )
    if ('key' in made) {
      log(
        earlier > 0
          ? `secrets: made a new key file ${path} while ${earlier} stored value(s) of an earlier key exist ` +
              `(a restored backup, or a deleted key file); they answer "${REPLACED_KEY_TEXT}"`
          : `secrets: made a new key file ${path}`
      )
    }
    return made
  }
  const loaded = load()
  const key = 'key' in loaded ? loaded.key : undefined
  const reason = 'reason' in loaded ? loaded.reason : null
  if (reason !== null) log(`secrets: ${reason}; secrets cannot be stored or read until it is fixed`)

  const replacedCount = (): number => {
    if (key === undefined) return 0
    try {
      return options.storedValues().filter((v) => unreadable(key, v)).length
    } catch {
      return 0
    }
  }
  // An earlier start made this key over older values (or one was restored since): say so at each
  // start, not only the one that made the key, as long as such values are left.
  if (key !== undefined && !('made' in loaded && loaded.made)) {
    const count = replacedCount()
    if (count > 0)
      log(`secrets: ${count} stored value(s) were made under an earlier key file; they answer "${REPLACED_KEY_TEXT}"`)
  }

  return Object.freeze({
    kind: 'keyfile' as const,
    unavailableReason: async () => reason,
    replacedCount,
    isReplaced: (stored: string): boolean => key !== undefined && unreadable(key, stored),
    encrypt: async (plain: string): Promise<string> => {
      if (typeof plain !== 'string') throw new SecretStoreError('a secret must be a string')
      if (key === undefined) throw new SecretStoreError(`cannot store secrets: ${reason}`)
      const iv = random(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv, {
        authTagLength: TAG_BYTES
      })
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return KEYFILE_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
    },
    decrypt: async (stored: string): Promise<string> => {
      if (typeof stored !== 'string' || stored === '') throw new SecretStoreError('no stored secret')
      if (stored.startsWith(FAKE_PREFIX)) {
        throw new SecretStoreError('this secret was stored by the test-only fake store and cannot be read')
      }
      // Anything else that is not ours is the keychain's (base64 of safeStorage ciphertext).
      if (!stored.startsWith(KEYFILE_PREFIX)) throw new SecretStoreError(STORED_BY_KEYCHAIN)
      if (key === undefined) throw new SecretStoreError(`cannot read secrets: ${reason}`)
      const parts = partsOf(stored)
      if (parts === undefined) throw new SecretStoreError('the stored secret is damaged')
      const plain = open(key, parts)
      // A well-formed value the tag refuses: made under another key (or edited by hand; GCM cannot
      // tell the two apart, and the remedy is the same).
      if (plain === undefined) throw new SecretStoreError(REPLACED_KEY_TEXT)
      return plain
    }
  })
}
