// The secret store (safeStorage adapter with a stub, the marked fake, the test-only selection).
// Moved out of the account-store tests when accounts left core; the store itself stays for plugin
// secrets (design §6). Nothing touches the real keychain.
import { describe, expect, it } from 'vitest'
import {
  FAKE_PREFIX,
  fakeSecretStore,
  safeStorageSecretStore,
  selectSecretStore,
  type SafeStorageApi
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

  it('selects the fake only in an unpackaged test run (CC_COCKPIT_TEST=1 as well)', () => {
    const real = safeStorageSecretStore(stubSafeStorage({ available: true }), 'darwin')
    const logs: string[] = []
    const log = (m: string): void => {
      logs.push(m)
    }
    const both = { CC_COCKPIT_FAKE_SECRETS: '1', CC_COCKPIT_TEST: '1' }
    expect(selectSecretStore(both, false, () => real, log).kind).toBe('fake')
    expect(selectSecretStore({ CC_COCKPIT_FAKE_SECRETS: '1' }, false, () => real, log)).toBe(real)
    expect(selectSecretStore({}, false, () => real, log)).toBe(real)
    expect(logs.some((m) => m.includes('ignoring CC_COCKPIT_FAKE_SECRETS=1 outside a test run'))).toBe(true)
    // A packaged app never stores secrets reversibly, whatever its environment says.
    expect(selectSecretStore(both, true, () => real, log)).toBe(real)
    expect(logs.some((m) => m.includes('in a packaged app'))).toBe(true)
  })
})
