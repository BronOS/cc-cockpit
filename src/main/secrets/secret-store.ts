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
//
// No `electron` import (index.ts passes `safeStorage` in): unit tests load this file in plain Node.

/** Encrypts and decrypts secrets; values are opaque strings safe to write to JSON. */
export interface SecretStore {
  /** `os` for the OS keychain, `fake` for the test-only store. */
  readonly kind: 'os' | 'fake'
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

/**
 * The store main uses: the fake when the environment asks for it AND this is a test run
 * (`CC_COCKPIT_TEST=1`) AND the app is not packaged, else the OS keychain (`makeReal`, called only
 * then). `isPackaged` (app.isPackaged) is required, not defaulted: the env vars alone can be set
 * on any launch, and a shipped app must never store a user's secrets reversibly.
 */
export function selectSecretStore(
  env: Record<string, string | undefined>,
  isPackaged: boolean,
  makeReal: () => SecretStore,
  log: (message: string) => void = (m) => console.warn(m)
): SecretStore {
  if (env[FAKE_SECRETS_ENV] === '1') {
    if (isPackaged) {
      log(`secrets: ignoring ${FAKE_SECRETS_ENV}=1 in a packaged app; secrets go to the OS keychain`)
      return makeReal()
    }
    if (env.CC_COCKPIT_TEST === '1') {
      log('secrets: using the FAKE secret store (test run); secrets are NOT encrypted')
      return fakeSecretStore()
    }
    log(`secrets: ignoring ${FAKE_SECRETS_ENV}=1 outside a test run; secrets go to the OS keychain`)
  }
  return makeReal()
}
