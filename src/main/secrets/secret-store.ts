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

/**
 * The OS keychain through Electron's `safeStorage`. `platform` decides whether the Linux backend
 * is consulted (`basic_text` is refused, `unknown` means "before ready").
 */
export function safeStorageSecretStore(api: SafeStorageApi, platform: string = process.platform): SecretStore {
  const unavailableReason = async (): Promise<string | null> => {
    let available: boolean
    try {
      available = await api.isAsyncEncryptionAvailable()
    } catch {
      available = false
    }
    if (!available) {
      return platform === 'linux'
        ? 'no OS keyring is available. Start a Secret Service keyring (gnome-keyring, or the Secret Service of KeePassXC) and unlock it, or start the app with --password-store=gnome-libsecret (or kwallet6)'
        : 'the OS keychain is not available'
    }
    if (platform === 'linux') {
      let backend = 'unknown'
      try {
        backend = api.getSelectedStorageBackend?.() ?? 'unknown'
      } catch {
        /* reported as unknown below */
      }
      if (backend === 'basic_text') {
        return (
          'no OS keyring was found, and the fallback would store secrets with a built-in key (not encrypted). ' +
          'Start a Secret Service keyring (gnome-keyring, or the Secret Service of KeePassXC) and unlock it, ' +
          'or start the app with --password-store=gnome-libsecret (or kwallet6)'
        )
      }
      if (backend === 'unknown') return 'the OS keyring is not ready yet'
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
