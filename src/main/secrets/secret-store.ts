// Encryption of secrets (design §6 "Plugin sign-ins and secrets"). Plugin secrets (`ctx.secrets`,
// secret settings fields) are written to the data dir only as what this module returns: base64 of
// Electron `safeStorage` ciphertext, whose key lives in the OS keychain (macOS Keychain,
// libsecret / KWallet on Linux). The only module that touches `safeStorage` (CLAUDE.md).
//
// Rules:
//  - Never plaintext. When the OS cannot encrypt, `encrypt` REFUSES with the reason; the caller
//    stores nothing. There is no "store it plainly for now" fallback, on any platform.
//  - On Linux, `safeStorage` reports itself available with the `basic_text` backend (no keyring
//    found, or `--password-store=basic`): that "encryption" uses a key hard-coded in Chromium, so
//    anyone who can read the secrets file can decrypt it. That counts as unavailable here.
//  - On Linux the backend name and the availability flag are not enough: with `--password-store`
//    forcing libsecret (or KWallet) and no working keyring, Electron 45 reports encryption available
//    and the forced backend, then encrypts with the same hard-coded key (checked by hand on a private
//    bus without a Secret Service). Only the ciphertext's version tag shows it: Chromium tags data
//    under its hard-coded POSIX key `v10`, and under a key from the keyring `v11`. So the store
//    encrypts a probe and accepts only `v11` (and checks the tag of every value it returns too):
//    anything else is refused, never guessed at. Linux only: on macOS and Windows `v10` is the
//    keychain / DPAPI key.
//  - Electron 45 deprecates the synchronous `encryptString` / `decryptString` /
//    `isEncryptionAvailable`; the async ones are used (they also keep a keychain prompt from
//    blocking main). The async encryptor initializes lazily after `ready`, so availability is
//    asked at each call, never once at construction (start() runs before `ready`).
//  - Errors never carry the plaintext or the ciphertext: they end up in logs and in the UI.
//  - Tests never touch the real keychain: `CC_COCKPIT_FAKE_SECRETS=1` selects `fakeSecretStore`,
//    but ONLY in a test run (`CC_COCKPIT_TEST=1` too, which the e2e harness sets alongside it). A
//    stray FAKE_SECRETS in a user's shell must not quietly swap the keychain for a reversible
//    encoding; it is ignored with a warning. The fake's output is marked (`FAKE_PREFIX`), and each
//    store refuses the other's values, so a fake value can never be mistaken for a real secret.
//  - The mode decides the real store (design-web.md §9.5): server mode always the key file
//    (key-file-store.ts), the desktop always the keychain, never chosen by what is available. Each
//    refuses the other's values with a text that names the other store, and start logs how many
//    stored values belong to the other one (`otherStoreCount`): one data dir can be run both ways.
//
// No `electron` import (index.ts passes `safeStorage` in): unit tests load this file in plain Node.
import { readFileSync } from 'node:fs'
import { isPlainObject } from '../../shared/guards'
import { dataPaths } from '../paths'

/** Encrypts and decrypts secrets; values are opaque strings safe to write to JSON. */
export interface SecretStore {
  /** `os` for the OS keychain, `keyfile` for server mode's key file, `fake` for the test-only store. */
  readonly kind: 'os' | 'keyfile' | 'fake'
  /** Why secrets cannot be stored right now, or null when they can. */
  unavailableReason(): Promise<string | null>
  /** The stored form of `plain`. Rejects (SecretStoreError) when encryption is unavailable. */
  encrypt(plain: string): Promise<string>
  /** The plaintext of a value `encrypt` returned. Rejects (SecretStoreError) when it cannot. */
  decrypt(stored: string): Promise<string>
}

/** A refusal or failure of the secret store. The message never contains a secret. */
export class SecretStoreError extends Error {
  override name = 'SecretStoreError'
}

/** The slice of Electron's `safeStorage` this module uses (the real object fits it). */
export interface SafeStorageApi {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plainText: string): Promise<Buffer>
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
  /** Linux only (it may not exist, or throw, elsewhere). */
  getSelectedStorageBackend?(): string
}

/**
 * Marks every value the fake store writes. The real store refuses to decrypt one: a test value
 * that leaked into a real data dir reads as an error, never as a secret.
 */
export const FAKE_PREFIX = 'FAKE-SECRET-STORE-NOT-ENCRYPTED:'

/** Marks every value the key file store writes (key-file-store.ts): `KEYFILE-V1:` + base64(iv, tag, ciphertext). */
export const KEYFILE_PREFIX = 'KEYFILE-V1:'

/** What the keychain answers for a key file value (design-web.md §9.5). */
export const STORED_BY_KEY_FILE = "stored by server mode's key file: enter it again here"
/** What the key file answers for a keychain value. */
export const STORED_BY_KEYCHAIN = "stored by the desktop's keychain: enter it again here"

/** Env var that selects the fake store (honored only together with CC_COCKPIT_TEST=1). */
export const FAKE_SECRETS_ENV = 'CC_COCKPIT_FAKE_SECRETS'

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** The version tag Chromium puts on Linux ciphertext made with a key from the keyring (Secret Service or KWallet). */
export const LINUX_KEYRING_TAG = 'v11'

/** Encrypted on Linux to learn which key safeStorage really uses; never stored. */
const PROBE = 'cc-cockpit keyring check'

const LINUX_FIX =
  'Start a Secret Service keyring (gnome-keyring, or the Secret Service of KeePassXC) and unlock it, ' +
  'or start the app with --password-store=gnome-libsecret (or kwallet6)'

/** Whether `buf` is Linux ciphertext under a keyring key (its version tag). */
function keyringTagged(buf: Buffer): boolean {
  return buf.subarray(0, LINUX_KEYRING_TAG.length).toString('latin1') === LINUX_KEYRING_TAG
}

/**
 * The OS keychain through Electron's `safeStorage`. `platform` decides whether the Linux backend
 * is consulted (`basic_text` is refused, `unknown` means "before ready") and the ciphertext's tag
 * checked (only `v11`, a keyring key, is accepted).
 */
export function safeStorageSecretStore(api: SafeStorageApi, platform: string = process.platform): SecretStore {
  const BUILT_IN_KEY = `no OS keyring was found, and the fallback would store secrets with a built-in key (not encrypted). ${LINUX_FIX}`
  const unavailableReason = async (): Promise<string | null> => {
    let available: boolean
    try {
      available = await api.isAsyncEncryptionAvailable()
    } catch {
      available = false
    }
    if (!available) {
      return platform === 'linux' ? `no OS keyring is available. ${LINUX_FIX}` : 'the OS keychain is not available'
    }
    if (platform === 'linux') {
      let backend = 'unknown'
      try {
        backend = api.getSelectedStorageBackend?.() ?? 'unknown'
      } catch {
        /* reported as unknown below */
      }
      if (backend === 'basic_text') return BUILT_IN_KEY
      if (backend === 'unknown') return 'the OS keyring is not ready yet'
      // The named backend may still have failed to start (no keyring behind a forced switch): ask
      // the encryptor which key it really uses.
      let probe: Buffer
      try {
        probe = await api.encryptStringAsync(PROBE)
      } catch {
        return 'the OS keyring refused to encrypt. ' + LINUX_FIX
      }
      if (!keyringTagged(probe)) return BUILT_IN_KEY
    }
    return null
  }

  return Object.freeze({
    kind: 'os' as const,
    unavailableReason,
    encrypt: async (plain: string): Promise<string> => {
      if (typeof plain !== 'string') throw new SecretStoreError('a secret must be a string')
      const reason = await unavailableReason()
      if (reason !== null) throw new SecretStoreError(`cannot store secrets: ${reason}`)
      let buf: Buffer
      try {
        buf = await api.encryptStringAsync(plain)
      } catch {
        // Electron's message is not ours to forward: it could in principle echo its input.
        throw new SecretStoreError('cannot store secrets: the OS keychain refused to encrypt')
      }
      // The probe above passed, but the keyring can go away in between: this value is checked too.
      if (platform === 'linux' && !keyringTagged(buf)) throw new SecretStoreError(`cannot store secrets: ${BUILT_IN_KEY}`)
      return buf.toString('base64')
    },
    decrypt: async (stored: string): Promise<string> => {
      if (typeof stored !== 'string' || stored === '') throw new SecretStoreError('no stored secret')
      if (stored.startsWith(FAKE_PREFIX)) {
        throw new SecretStoreError('this secret was stored by the test-only fake store and cannot be read')
      }
      // Checked before the base64 test, which a key file value (with its `:`) would fail as "damaged".
      if (stored.startsWith(KEYFILE_PREFIX)) throw new SecretStoreError(STORED_BY_KEY_FILE)
      if (!BASE64.test(stored)) throw new SecretStoreError('the stored secret is damaged')
      const reason = await unavailableReason()
      if (reason !== null) throw new SecretStoreError(`cannot read secrets: ${reason}`)
      try {
        // shouldReEncrypt (a rotated key) is not acted on: the result is still the right value,
        // and re-encrypting would mean writing the secrets file from a read.
        return (await api.decryptStringAsync(Buffer.from(stored, 'base64'))).result
      } catch {
        throw new SecretStoreError('cannot read secrets: the OS keychain refused to decrypt (was the keychain reset?)')
      }
    }
  })
}

/**
 * TEST ONLY. A reversible encoding, not encryption: `FAKE_PREFIX` + base64 of the bytes XOR 0x5a.
 * The XOR only keeps the plaintext from appearing verbatim in a file a test reads; it protects
 * nothing. Selected by `selectSecretStore` only in a test run.
 */
export function fakeSecretStore(): SecretStore {
  const flip = (buf: Buffer): Buffer => Buffer.from(buf.map((b) => b ^ 0x5a))
  return Object.freeze({
    kind: 'fake' as const,
    unavailableReason: async () => null,
    encrypt: async (plain: string): Promise<string> => {
      if (typeof plain !== 'string') throw new SecretStoreError('a secret must be a string')
      return FAKE_PREFIX + flip(Buffer.from(plain, 'utf8')).toString('base64')
    },
    decrypt: async (stored: string): Promise<string> => {
      if (typeof stored !== 'string' || !stored.startsWith(FAKE_PREFIX)) {
        throw new SecretStoreError('this secret was not stored by the fake store')
      }
      return flip(Buffer.from(stored.slice(FAKE_PREFIX.length), 'base64')).toString('utf8')
    }
  })
}

/** The real stores `selectSecretStore` picks between by mode; each is made only when picked. */
export interface RealSecretStores {
  /** Server mode (design-web.md §9.1); decides the store, never the keychain's state. */
  server: boolean
  /** The desktop's OS keychain (`safeStorageSecretStore`). */
  keychain: () => SecretStore
  /** Server mode's key file (`keyFileSecretStore`). */
  keyFile: () => SecretStore
}

/**
 * The store main uses: the fake when the environment asks for it AND this is a test run
 * (`CC_COCKPIT_TEST=1`) AND the app is not packaged, in either mode; else the mode's store, the key
 * file in server mode and the OS keychain on the desktop (made only then). `isPackaged`
 * (app.isPackaged) is required, not defaulted: the env vars alone can be set on any launch, and a
 * shipped app must never store a user's secrets reversibly.
 */
export function selectSecretStore(
  env: Record<string, string | undefined>,
  isPackaged: boolean,
  stores: RealSecretStores,
  log: (message: string) => void = (m) => console.warn(m)
): SecretStore {
  const real = (): SecretStore => (stores.server ? stores.keyFile() : stores.keychain())
  const where = stores.server ? "server mode's key file" : 'the OS keychain'
  if (env[FAKE_SECRETS_ENV] === '1') {
    if (isPackaged) {
      log(`secrets: ignoring ${FAKE_SECRETS_ENV}=1 in a packaged app; secrets go to ${where}`)
      return real()
    }
    if (env.CC_COCKPIT_TEST === '1') {
      log('secrets: using the FAKE secret store (test run); secrets are NOT encrypted')
      return fakeSecretStore()
    }
    log(`secrets: ignoring ${FAKE_SECRETS_ENV}=1 outside a test run; secrets go to ${where}`)
  }
  return real()
}

/**
 * Every stored value in the data dir: `secrets.json` (plugin secrets and secret settings fields)
 * and `web-access.json` (the access link's token and the password). Read tolerantly: a missing or
 * damaged file has none. For the counts start logs and `ccc web status` shows, never for a read.
 */
export function storedSecretValues(dataDir: string, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): string[] {
  const paths = dataPaths(dataDir)
  const parse = (path: string): unknown => {
    try {
      return JSON.parse(read(path))
    } catch {
      return undefined
    }
  }
  const values: string[] = []
  const secrets = parse(paths.secretsJson)
  if (isPlainObject(secrets) && isPlainObject(secrets.plugins)) {
    for (const keys of Object.values(secrets.plugins)) {
      if (!isPlainObject(keys)) continue
      for (const value of Object.values(keys)) if (typeof value === 'string') values.push(value)
    }
  }
  const web = parse(paths.webAccessJson)
  if (isPlainObject(web)) {
    for (const record of [web.accessToken, web.password]) {
      if (isPlainObject(record) && typeof record.stored === 'string') values.push(record.stored)
    }
  }
  return values
}

/**
 * How many of `values` belong to the other real store: key file values under the keychain,
 * keychain values under the key file. The fake store's values are nobody's here (and the fake
 * counts nothing: a test run's data dir holds only its own).
 */
export function otherStoreCount(kind: SecretStore['kind'], values: readonly string[]): number {
  if (kind === 'fake') return 0
  const isKeyFile = (v: string): boolean => v.startsWith(KEYFILE_PREFIX)
  const isFake = (v: string): boolean => v.startsWith(FAKE_PREFIX)
  return values.filter((v) => v !== '' && !isFake(v) && (kind === 'os' ? isKeyFile(v) : !isKeyFile(v))).length
}

/** The start log line for `otherStoreCount`, or null when there is nothing to say. */
export function otherStoreLine(kind: SecretStore['kind'], count: number): string | null {
  if (count === 0 || kind === 'fake') return null
  return kind === 'os'
    ? `secrets: ${count} stored value(s) belong to server mode's key file and cannot be read on the desktop; enter them again here`
    : `secrets: ${count} stored value(s) belong to the desktop's keychain and cannot be read in server mode; enter them again here`
}
