// The key file secret store (design-web.md §9.5), in plain Node in a temp dir: how the key is made
// and refused, the value format, the GCM tag, a replaced key, and the other store's values.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  KEY_FILE_BYTES,
  keyFileSecretStore,
  REPLACED_KEY_TEXT,
  type KeyFileFs,
  type KeyFileStoreOptions
} from '../../src/main/secrets/key-file-store'
import {
  FAKE_PREFIX,
  fakeSecretStore,
  KEYFILE_PREFIX,
  safeStorageSecretStore,
  STORED_BY_KEY_FILE,
  STORED_BY_KEYCHAIN,
  storedSecretValues
} from '../../src/main/secrets/secret-store'

const SECRET = 'tok-very-secret-123'

let dir: string
let keyPath: string
let logs: string[]

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), 'ccc-keyfile-'))
  keyPath = join(dir, 'secret.key')
  logs = []
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function store(extra: Partial<KeyFileStoreOptions> = {}) {
  return keyFileSecretStore({
    path: keyPath,
    storedValues: () => storedSecretValues(dir),
    log: (m) => logs.push(m),
    ...extra
  })
}

/** Writes values into secrets.json as PluginSecrets would. */
function writeSecrets(values: Record<string, string>): void {
  fs.writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ schemaVersion: 1, plugins: { 'example.plugin': values } }))
}

/** The state of the path as a test compares it before and after: kind, mode and bytes. */
function snapshot(path: string): { kind: string; mode: number; bytes?: string; link?: string } {
  const st = fs.lstatSync(path)
  const kind = st.isSymbolicLink() ? 'link' : st.isFIFO() ? 'fifo' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'
  return {
    kind,
    mode: st.mode & 0o777,
    ...(kind === 'file' ? { bytes: fs.readFileSync(path).toString('hex') } : {}),
    ...(kind === 'link' ? { link: fs.readlinkSync(path) } : {})
  }
}

/** The store is unavailable with `reason`, for every call, and leaves the path as it was. */
async function expectRefused(reason: RegExp, before = snapshot(keyPath)): Promise<void> {
  const s = store()
  expect(await s.unavailableReason()).toMatch(reason)
  await expect(s.encrypt(SECRET)).rejects.toThrow(/^cannot store secrets: /)
  await expect(s.encrypt(SECRET)).rejects.toThrow(reason)
  await expect(s.decrypt(`${KEYFILE_PREFIX}AAAA`)).rejects.toThrow(/^cannot read secrets: /)
  expect(s.replacedCount()).toBe(0)
  expect(snapshot(keyPath)).toEqual(before)
  expect(logs.some((m) => reason.test(m))).toBe(true)
}

/** A valid key file, made by hand (mode 0600). */
function writeKey(bytes = KEY_FILE_BYTES, mode = 0o600): void {
  fs.writeFileSync(keyPath, Buffer.alloc(bytes, 7), { mode })
  fs.chmodSync(keyPath, mode)
}

describe('key file store: the key', () => {
  it('is made on first start with O_CREAT | O_EXCL | O_NOFOLLOW and mode 0600 at open, never chmod', async () => {
    const opens: Array<{ flags: number; mode?: number }> = []
    const real = fs as unknown as KeyFileFs
    const s = store({
      fs: {
        openSync: (p, flags, mode) => {
          opens.push({ flags, ...(mode === undefined ? {} : { mode }) })
          return real.openSync(p, flags, mode)
        }
      }
    })
    const { O_CREAT, O_EXCL, O_NOFOLLOW, O_WRONLY } = fs.constants
    const create = opens.find((o) => (o.flags & O_CREAT) !== 0)
    expect(create).toEqual({ flags: O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode: 0o600 })
    const st = fs.statSync(keyPath)
    expect(st.mode & 0o777).toBe(0o600)
    expect(st.size).toBe(KEY_FILE_BYTES)
    expect(await s.unavailableReason()).toBeNull()
    expect(logs).toEqual([`secrets: made a new key file ${keyPath}`])
  })

  it('is read again on the next start, never made again over the existing file', async () => {
    const first = store()
    const stored = await first.encrypt(SECRET)
    const before = snapshot(keyPath)
    logs = []
    const second = store()
    expect(await second.decrypt(stored)).toBe(SECRET)
    expect(snapshot(keyPath)).toEqual(before)
    expect(logs).toEqual([])
  })

  it('opens with O_NOFOLLOW | O_NONBLOCK and checks by fstat on that descriptor', () => {
    writeKey()
    const opens: number[] = []
    const fstats: number[] = []
    const real = fs as unknown as KeyFileFs
    store({
      fs: {
        openSync: (p, flags, mode) => {
          const fd = real.openSync(p, flags, mode)
          opens.push(fd)
          expect(flags).toBe(fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
          return fd
        },
        fstatSync: (fd) => (fstats.push(fd), real.fstatSync(fd))
      }
    })
    expect(fstats).toEqual(opens)
  })

  it('refuses a symlink at the path (even to a good key) and leaves it', async () => {
    const target = join(dir, 'elsewhere.key')
    fs.writeFileSync(target, Buffer.alloc(KEY_FILE_BYTES, 1), { mode: 0o600 })
    fs.symlinkSync(target, keyPath)
    await expectRefused(/is a symbolic link/)
    expect(fs.readFileSync(target)).toEqual(Buffer.alloc(KEY_FILE_BYTES, 1))
  })

  it('refuses a dangling symlink without making a file through it', async () => {
    const target = join(dir, 'missing.key')
    fs.symlinkSync(target, keyPath)
    await expectRefused(/is a symbolic link/)
    expect(fs.existsSync(target)).toBe(false)
  })

  it('refuses a FIFO: the open returns (O_NONBLOCK) and fstat refuses it', async () => {
    execFileSync('mkfifo', ['-m', '600', keyPath])
    await expectRefused(/is not a regular file/)
  }, 10_000)

  it('refuses a directory', async () => {
    fs.mkdirSync(keyPath, { mode: 0o700 })
    await expectRefused(/is not a regular file/)
  })

  it('refuses a mode open to group or others, and never chmods it', async () => {
    for (const mode of [0o640, 0o604, 0o660, 0o601]) {
      writeKey(KEY_FILE_BYTES, mode)
      logs = []
      await expectRefused(new RegExp(`open to group or others \\(mode ${mode.toString(8)}\\)`))
      fs.rmSync(keyPath)
    }
  })

  it('refuses a file of another owner (an injected fstat)', async () => {
    writeKey()
    const real = fs as unknown as KeyFileFs
    const s = store({
      fs: {
        fstatSync: (fd) => {
          const st = real.fstatSync(fd)
          return { isFile: () => st.isFile(), uid: st.uid + 1, mode: st.mode, size: st.size }
        }
      }
    })
    expect(await s.unavailableReason()).toMatch(/is not owned by this user/)
    await expect(s.encrypt(SECRET)).rejects.toThrow(/not owned by this user/)
    expect(snapshot(keyPath).bytes).toBe(Buffer.alloc(KEY_FILE_BYTES, 7).toString('hex'))
    // The uid is checked against the given owner too.
    expect(await store({ uid: (process.getuid?.() ?? 0) + 1 }).unavailableReason()).toMatch(/not owned by this user/)
  })

  it('refuses a wrong length (short, long, empty)', async () => {
    for (const bytes of [KEY_FILE_BYTES - 1, KEY_FILE_BYTES + 1, 0]) {
      writeKey(bytes)
      logs = []
      await expectRefused(/is not 32 bytes/)
      fs.rmSync(keyPath)
    }
  })

  it('a failed write removes its own partial key file and leaves the store unavailable', async () => {
    const s = store({
      fs: {
        writeSync: () => {
          const err = new Error('no space') as Error & { code: string }
          err.code = 'ENOSPC'
          throw err
        }
      }
    })
    expect(await s.unavailableReason()).toMatch(/cannot be written \(ENOSPC\)/)
    expect(fs.existsSync(keyPath)).toBe(false)
  })
})

describe('key file store: values', () => {
  it('round trip: KEYFILE-V1: + base64(iv 12, tag 16, ciphertext), a fresh IV each time', async () => {
    const s = store()
    for (const plain of [SECRET, '', 'üñí©ødé ✓', 'x'.repeat(70_000)]) {
      const stored = await s.encrypt(plain)
      expect(stored.startsWith(KEYFILE_PREFIX)).toBe(true)
      expect(stored).not.toContain(plain || '\u0000')
      const raw = Buffer.from(stored.slice(KEYFILE_PREFIX.length), 'base64')
      expect(raw.length).toBe(12 + 16 + Buffer.byteLength(plain))
      expect(await s.decrypt(stored)).toBe(plain)
    }
    const a = await s.encrypt(SECRET)
    const b = await s.encrypt(SECRET)
    expect(a).not.toBe(b)
    expect(Buffer.from(a.slice(KEYFILE_PREFIX.length), 'base64').subarray(0, 12)).not.toEqual(
      Buffer.from(b.slice(KEYFILE_PREFIX.length), 'base64').subarray(0, 12)
    )
  })

  it('one changed byte (IV, tag or ciphertext) fails the tag; errors never carry a value', async () => {
    const s = store()
    const stored = await s.encrypt(SECRET)
    const raw = Buffer.from(stored.slice(KEYFILE_PREFIX.length), 'base64')
    for (let i = 0; i < raw.length; i++) {
      const bad = Buffer.from(raw)
      bad[i] = bad[i]! ^ 0x01
      const err = (await s.decrypt(KEYFILE_PREFIX + bad.toString('base64')).catch((e: unknown) => e)) as Error
      expect(err.message).toBe(REPLACED_KEY_TEXT)
      expect(err.message).not.toContain(SECRET)
    }
    // Too short to hold an IV and a tag, or not base64: damaged.
    await expect(s.decrypt(KEYFILE_PREFIX + raw.subarray(0, 27).toString('base64'))).rejects.toThrow('damaged')
    await expect(s.decrypt(`${KEYFILE_PREFIX}not base64!`)).rejects.toThrow('damaged')
    await expect(s.decrypt('')).rejects.toThrow('no stored secret')
  })

  it('a new key made while key file values exist: logged with the count, those values answer "replaced"', async () => {
    const old = store()
    writeSecrets({ a: await old.encrypt('one'), b: await old.encrypt('two'), c: 'b3M=' })
    fs.rmSync(keyPath)
    logs = []
    const fresh = store()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(`made a new key file ${keyPath} while 2 stored value(s) of an earlier key exist`)
    expect(logs[0]).toContain(REPLACED_KEY_TEXT)
    const values = JSON.parse(fs.readFileSync(join(dir, 'secrets.json'), 'utf8')).plugins['example.plugin']
    await expect(fresh.decrypt(values.a)).rejects.toThrow(REPLACED_KEY_TEXT)
    expect(REPLACED_KEY_TEXT).toBe('the key file was replaced: enter it again')
    expect(fresh.replacedCount()).toBe(2)
    // Entered again under the new key: the count follows, live.
    writeSecrets({ a: await fresh.encrypt('one'), b: values.b, c: 'b3M=' })
    expect(fresh.replacedCount()).toBe(1)
    // The next start (the key file now exists) still says so, and keeps the count.
    logs = []
    const next = store()
    expect(next.replacedCount()).toBe(1)
    expect(logs).toEqual([`secrets: 1 stored value(s) were made under an earlier key file; they answer "${REPLACED_KEY_TEXT}"`])
  })

  it('counts web-access.json values too (the access link token, the password)', async () => {
    const old = store()
    fs.writeFileSync(
      join(dir, 'web-access.json'),
      JSON.stringify({
        schemaVersion: 1,
        devices: [],
        accessToken: { hash: 'a'.repeat(64), stored: await old.encrypt('token'), createdAt: 1 },
        password: { stored: await old.encrypt('hash'), createdAt: 1 }
      })
    )
    fs.rmSync(keyPath)
    logs = []
    expect(store().replacedCount()).toBe(2)
    expect(logs[0]).toContain('while 2 stored value(s)')
  })
})

describe('key file store: the other stores', () => {
  it('refuses a keychain value with the other-mode text, and a fake value as the keychain does', async () => {
    const s = store()
    await expect(s.decrypt('c2VjcmV0dmFsdWU=')).rejects.toThrow(STORED_BY_KEYCHAIN)
    expect(STORED_BY_KEYCHAIN).toBe("stored by the desktop's keychain: enter it again here")
    await expect(s.decrypt(await fakeSecretStore().encrypt(SECRET))).rejects.toThrow('test-only fake store')
    expect((await fakeSecretStore().encrypt(SECRET)).startsWith(FAKE_PREFIX)).toBe(true)
  })

  it('the keychain refuses a key file value, and the fake does too', async () => {
    const stored = await store().encrypt(SECRET)
    const keychain = safeStorageSecretStore(
      {
        isAsyncEncryptionAvailable: async () => true,
        encryptStringAsync: async (p) => Buffer.from(`v11${p}`),
        decryptStringAsync: async (b) => ({ result: b.toString('utf8').slice(3), shouldReEncrypt: false }),
        getSelectedStorageBackend: () => 'gnome_libsecret'
      },
      'linux'
    )
    await expect(keychain.decrypt(stored)).rejects.toThrow(STORED_BY_KEY_FILE)
    await expect(fakeSecretStore().decrypt(stored)).rejects.toThrow('not stored by the fake store')
  })

  it('an unavailable store still names the other store for a keychain value', async () => {
    writeKey(5)
    await expect(store().decrypt('c2VjcmV0dmFsdWU=')).rejects.toThrow(STORED_BY_KEYCHAIN)
  })
})
