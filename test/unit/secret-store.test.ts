// The secret store (safeStorage adapter with a stub, the marked fake, the test-only selection).
// Moved out of the account-store tests when accounts left core; the store itself stays for plugin
// secrets (design §6). Nothing touches the real keychain.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FAKE_PREFIX,
  fakeSecretStore,
  KEYFILE_PREFIX,
  otherStoreCount,
  otherStoreLine,
  safeStorageSecretStore,
  selectSecretStore,
  STORED_BY_KEY_FILE,
  storedSecretValues,
  type SafeStorageApi,
  type SecretStore
} from '../../src/main/secrets/secret-store'

const SECRET = 'tok-very-secret-123'

/**
 * A stand-in for Electron's safeStorage: reversible, and `available` switchable. Ciphertext starts
 * with Chromium's version tag, `v11` (a keyring key) unless `tag` says otherwise; `tagAfter` swaps
 * the tag after that many encryptions (a keyring that goes away between the probe and the value).
 */
function stubSafeStorage(state: {
  available: boolean
  backend?: string
  failDecrypt?: boolean
  tag?: string
  tagAfter?: { count: number; tag: string }
}): SafeStorageApi {
  let encryptions = 0
  return {
    isAsyncEncryptionAvailable: async () => state.available,
    encryptStringAsync: async (plain) => {
      encryptions++
      const tag = state.tagAfter !== undefined && encryptions > state.tagAfter.count ? state.tagAfter.tag : (state.tag ?? 'v11')
      return Buffer.concat([Buffer.from(tag, 'latin1'), Buffer.from(`enc(${plain})`, 'utf8').map((b) => b ^ 0x33)])
    },
    decryptStringAsync: async (buf) => {
      if (state.failDecrypt) throw new Error(`could not decrypt ${buf.toString('base64')}`)
      const text = Buffer.from(buf.subarray(3).map((b) => b ^ 0x33)).toString('utf8')
      return { result: text.slice(4, -1), shouldReEncrypt: false }
    },
    getSelectedStorageBackend: () => state.backend ?? 'gnome_libsecret'
  }
}

describe('secret store', () => {
  it('safeStorage: refuses with a reason when encryption is unavailable, never storing plaintext', async () => {
    const s = safeStorageSecretStore(stubSafeStorage({ available: false }), 'darwin')
    expect(await s.unavailableReason()).toBe('the OS keychain is not available')
    await expect(s.encrypt(SECRET)).rejects.toThrow('cannot store secrets: the OS keychain is not available')
    await expect(s.encrypt(SECRET)).rejects.not.toThrow(SECRET)
  })

  it('safeStorage on Linux: the error names the cause and the fix', async () => {
    for (const state of [{ available: false }, { available: true, backend: 'basic_text' }]) {
      const s = safeStorageSecretStore(stubSafeStorage(state), 'linux')
      await expect(s.encrypt(SECRET)).rejects.toThrow(/Secret Service keyring.*--password-store=gnome-libsecret/)
    }
  })

  it('safeStorage on Linux: the basic_text backend (built-in key) counts as unavailable', async () => {
    const s = safeStorageSecretStore(stubSafeStorage({ available: true, backend: 'basic_text' }), 'linux')
    expect(await s.unavailableReason()).toContain('built-in key')
    await expect(s.encrypt(SECRET)).rejects.toThrow('cannot store secrets')
    const before = safeStorageSecretStore(stubSafeStorage({ available: true, backend: 'unknown' }), 'linux')
    await expect(before.encrypt(SECRET)).rejects.toThrow('not ready yet')
    const ok = safeStorageSecretStore(stubSafeStorage({ available: true, backend: 'kwallet6' }), 'linux')
    expect(await ok.unavailableReason()).toBeNull()
  })

  it('safeStorage on Linux: a forced backend that fell back to the built-in key (tag v10) is refused', async () => {
    // What Electron 45 does with --password-store=gnome-libsecret and no keyring behind it: available,
    // the forced backend reported, ciphertext under Chromium's hard-coded key.
    const fallback = safeStorageSecretStore(stubSafeStorage({ available: true, backend: 'gnome_libsecret', tag: 'v10' }), 'linux')
    expect(await fallback.unavailableReason()).toContain('built-in key')
    await expect(fallback.encrypt(SECRET)).rejects.toThrow(/cannot store secrets: .*built-in key.*--password-store=gnome-libsecret/)
    const good = safeStorageSecretStore(stubSafeStorage({ available: true, backend: 'gnome_libsecret' }), 'linux')
    expect(await good.decrypt(await good.encrypt(SECRET))).toBe(SECRET)
    await expect(fallback.decrypt(await good.encrypt(SECRET))).rejects.toThrow('cannot read secrets')
    // An unknown tag is refused too, never guessed at.
    const other = safeStorageSecretStore(stubSafeStorage({ available: true, backend: 'kwallet6', tag: 'v99' }), 'linux')
    await expect(other.encrypt(SECRET)).rejects.toThrow('built-in key')
    // The keyring goes away after the probe: the value itself is checked as well.
    const late = safeStorageSecretStore(stubSafeStorage({ available: true, backend: 'gnome_libsecret', tagAfter: { count: 1, tag: 'v10' } }), 'linux')
    await expect(late.encrypt(SECRET)).rejects.toThrow('built-in key')
    // macOS and Windows tag their keychain / DPAPI ciphertext v10: not refused there.
    const mac = safeStorageSecretStore(stubSafeStorage({ available: true, tag: 'v10' }), 'darwin')
    expect(await mac.decrypt(await mac.encrypt(SECRET))).toBe(SECRET)
  })

  it('safeStorage on Linux: an encryptor that throws on the probe is unavailable, with the fix', async () => {
    const api = stubSafeStorage({ available: true, backend: 'gnome_libsecret' })
    api.encryptStringAsync = async () => {
      throw new Error('dbus says no')
    }
    const s = safeStorageSecretStore(api, 'linux')
    expect(await s.unavailableReason()).toMatch(/refused to encrypt.*Secret Service keyring/)
    await expect(s.encrypt(SECRET)).rejects.not.toThrow('dbus says no')
  })

  it('safeStorage: round trip through base64; refuses fake values; errors never carry the value', async () => {
    const state = { available: true, failDecrypt: false }
    const s = safeStorageSecretStore(stubSafeStorage(state), 'darwin')
    const stored = await s.encrypt(SECRET)
    expect(stored).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(stored).not.toContain(SECRET)
    expect(await s.decrypt(stored)).toBe(SECRET)
    await expect(s.decrypt(await fakeSecretStore().encrypt(SECRET))).rejects.toThrow('test-only fake store')
    await expect(s.decrypt('not base64!')).rejects.toThrow('damaged')
    state.failDecrypt = true
    const err = (await s.decrypt(stored).catch((e: unknown) => e)) as Error
    expect(err.message).toContain('refused to decrypt')
    expect(err.message).not.toContain(stored)
  })

  it('the fake is clearly marked, reversible, and refuses values it did not write', async () => {
    const fake = fakeSecretStore()
    expect(fake.kind).toBe('fake')
    const stored = await fake.encrypt(SECRET)
    expect(stored.startsWith(FAKE_PREFIX)).toBe(true)
    expect(stored).not.toContain(SECRET)
    expect(await fake.decrypt(stored)).toBe(SECRET)
    await expect(fake.decrypt('c2VjcmV0')).rejects.toThrow('not stored by the fake store')
  })

  it('selects the fake only in an unpackaged test run (CC_COCKPIT_TEST=1 as well), in either mode', () => {
    const real = safeStorageSecretStore(stubSafeStorage({ available: true }), 'darwin')
    const logs: string[] = []
    const log = (m: string): void => {
      logs.push(m)
    }
    const desktop = { server: false, keychain: () => real, keyFile: (): SecretStore => fail('the key file on the desktop') }
    const both = { CC_COCKPIT_FAKE_SECRETS: '1', CC_COCKPIT_TEST: '1' }
    expect(selectSecretStore(both, false, desktop, log).kind).toBe('fake')
    expect(selectSecretStore({ CC_COCKPIT_FAKE_SECRETS: '1' }, false, desktop, log)).toBe(real)
    expect(selectSecretStore({}, false, desktop, log)).toBe(real)
    expect(logs.some((m) => m.includes('ignoring CC_COCKPIT_FAKE_SECRETS=1 outside a test run'))).toBe(true)
    // A packaged app never stores secrets reversibly, whatever its environment says.
    expect(selectSecretStore(both, true, desktop, log)).toBe(real)
    expect(logs.some((m) => m.includes('in a packaged app'))).toBe(true)
    // Server mode: the fake keeps its place in a test run too.
    const keyFile = fakeKeyFileStore()
    const server = { server: true, keychain: (): SecretStore => fail('the keychain in server mode'), keyFile: () => keyFile }
    expect(selectSecretStore(both, false, server, log).kind).toBe('fake')
    expect(selectSecretStore(both, true, server, log)).toBe(keyFile)
  })

  it('the mode decides: server mode always the key file, the desktop never, whatever the keychain says', () => {
    const made: string[] = []
    for (const available of [true, false]) {
      for (const backend of ['gnome_libsecret', 'basic_text']) {
        const keychain = safeStorageSecretStore(stubSafeStorage({ available, backend }), 'linux')
        const keyFile = fakeKeyFileStore()
        const stores = (server: boolean) => ({
          server,
          keychain: () => (made.push('keychain'), keychain),
          keyFile: () => (made.push('keyfile'), keyFile)
        })
        expect(selectSecretStore({}, false, stores(true))).toBe(keyFile)
        expect(selectSecretStore({}, true, stores(true))).toBe(keyFile)
        expect(selectSecretStore({}, false, stores(false))).toBe(keychain)
        expect(selectSecretStore({}, true, stores(false))).toBe(keychain)
      }
    }
    // Only the picked store is made: the keychain is never asked in server mode.
    expect(made).toEqual(Array.from({ length: 4 }, () => ['keyfile', 'keyfile', 'keychain', 'keychain']).flat())
  })

  it('the keychain refuses a key file value with the other-mode text, before calling safeStorage', async () => {
    const api = stubSafeStorage({ available: true })
    let calls = 0
    const inner = api.decryptStringAsync
    api.decryptStringAsync = async (buf) => (calls++, inner(buf))
    const s = safeStorageSecretStore(api, 'linux')
    await expect(s.decrypt(`${KEYFILE_PREFIX}AAAA`)).rejects.toThrow(STORED_BY_KEY_FILE)
    expect(STORED_BY_KEY_FILE).toBe("stored by server mode's key file: enter it again here")
    expect(calls).toBe(0)
  })

  it('counts the stored values of the other store, in secrets.json and web-access.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccc-stored-'))
    try {
      expect(storedSecretValues(dir)).toEqual([])
      writeFileSync(
        join(dir, 'secrets.json'),
        JSON.stringify({
          schemaVersion: 1,
          plugins: { a: { k1: `${KEYFILE_PREFIX}x`, k2: 'b3M=', bad: 3 }, b: { k: `${FAKE_PREFIX}y` }, c: 'damaged' }
        })
      )
      writeFileSync(
        join(dir, 'web-access.json'),
        JSON.stringify({ schemaVersion: 1, devices: [], accessToken: { hash: 'h', stored: 'dG9r', createdAt: 1 }, password: { stored: `${KEYFILE_PREFIX}p`, createdAt: 1 } })
      )
      const values = storedSecretValues(dir)
      expect(values.sort()).toEqual([`${FAKE_PREFIX}y`, `${KEYFILE_PREFIX}p`, `${KEYFILE_PREFIX}x`, 'b3M=', 'dG9r'].sort())
      expect(otherStoreCount('os', values)).toBe(2)
      expect(otherStoreCount('keyfile', values)).toBe(2)
      expect(otherStoreCount('fake', values)).toBe(0)
      expect(otherStoreLine('os', 2)).toContain("2 stored value(s) belong to server mode's key file")
      expect(otherStoreLine('keyfile', 2)).toContain("2 stored value(s) belong to the desktop's keychain")
      expect(otherStoreLine('os', 0)).toBeNull()
      expect(otherStoreLine('fake', 3)).toBeNull()
      // A damaged file has no values; it never throws at start.
      writeFileSync(join(dir, 'secrets.json'), '{not json')
      expect(storedSecretValues(dir)).toEqual(['dG9r', `${KEYFILE_PREFIX}p`])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** A SecretStore standing in for the key file in the selection tests (kind only). */
function fakeKeyFileStore(): SecretStore {
  return { ...fakeSecretStore(), kind: 'keyfile' }
}

function fail(what: string): never {
  throw new Error(`made ${what}`)
}
