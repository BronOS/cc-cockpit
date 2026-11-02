import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostContexts } from '../../src/host/ctx'
import { createStorage } from '../../src/host/ctx/storage'
import { MAX_KEY_LENGTH, MAX_TOTAL_LENGTH, MAX_VALUE_LENGTH } from '../../src/shared/plugin-storage'
import { hostSpec } from '../fakes/host-spec'

describe('ctx.storage', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ccc-storage-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const open = (name = 'a/storage.json') => createStorage({ file: join(root, name), log: () => {}, debounceMs: 5 })

  it('stores JSON values, reads copies, lists and deletes keys', async () => {
    const { storage } = open()
    expect(await storage.get('missing')).toBeUndefined()
    await storage.set('n', 1)
    await storage.set('obj', { a: [1, 2, { b: null }] })
    expect(await storage.keys()).toEqual(['n', 'obj'])
    const got = (await storage.get('obj')) as { a: unknown[] }
    // Mutating what get returned must not change the store.
    got.a.push('x')
    expect(await storage.get('obj')).toEqual({ a: [1, 2, { b: null }] })
    await storage.delete('n')
    await storage.delete('never-set')
    expect(await storage.keys()).toEqual(['obj'])
  })

  it('persists across instances (after flush) with an atomic file and creates its directory on write', async () => {
    const file = join(root, 'proj', 'plugin', 'storage.json')
    const a = createStorage({ file, log: () => {} })
    // Nothing on disk until a write: reading creates no file or directory.
    await a.storage.get('k')
    expect(existsSync(join(root, 'proj'))).toBe(false)
    await a.storage.set('k', { v: 1 })
    a.flush()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ schemaVersion: 1, values: { k: { v: 1 } } })
    const b = createStorage({ file, log: () => {} })
    expect(await b.storage.get('k')).toEqual({ v: 1 })
    expect(readdirSync(join(root, 'proj', 'plugin'))).toEqual(['storage.json'])
  })

  it('writes after the debounce window without an explicit flush', async () => {
    vi.useFakeTimers()
    try {
      const file = join(root, 'd.json')
      const { storage } = createStorage({ file, log: () => {}, debounceMs: 50 })
      await storage.set('k', 1)
      expect(existsSync(file)).toBe(false)
      await vi.advanceTimersByTimeAsync(60)
      expect(JSON.parse(readFileSync(file, 'utf8')).values).toEqual({ k: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('isolates plugins and projects by file', async () => {
    const a1 = open('p1/a/storage.json')
    const a2 = open('p2/a/storage.json')
    const b1 = open('p1/b/storage.json')
    await a1.storage.set('k', 'p1-a')
    await a2.storage.set('k', 'p2-a')
    await b1.storage.set('k', 'p1-b')
    for (const h of [a1, a2, b1]) h.flush()
    const again = (name: string) => createStorage({ file: join(root, name), log: () => {} }).storage
    expect(await again('p1/a/storage.json').get('k')).toBe('p1-a')
    expect(await again('p2/a/storage.json').get('k')).toBe('p2-a')
    expect(await again('p1/b/storage.json').get('k')).toBe('p1-b')
  })

  it('treats hostile keys as plain keys: never a path, never a prototype', async () => {
    const file = join(root, 'safe', 'storage.json')
    const { storage, flush } = createStorage({ file, log: () => {} })
    for (const key of ['../../escape', '/etc/passwd', 'a/b', '__proto__', 'constructor', 'toString', 'a\0b']) {
      await storage.set(key, key)
    }
    flush()
    // Nothing but the one file exists next to the root.
    expect(readdirSync(root)).toEqual(['safe'])
    expect(readdirSync(join(root, 'safe'))).toEqual(['storage.json'])
    expect(await storage.get('__proto__')).toBe('__proto__')
    expect(await storage.get('constructor')).toBe('constructor')
    expect(({} as Record<string, unknown>).__proto__).toBe(Object.prototype)
    // And it survives a reload (JSON.parse creates an own __proto__ key; it must still be a key).
    const again = createStorage({ file, log: () => {} }).storage
    expect(await again.get('__proto__')).toBe('__proto__')
    expect((await again.keys()).sort()).toEqual(['../../escape', '/etc/passwd', '__proto__', 'a\0b', 'a/b', 'constructor', 'toString'].sort())
    await again.delete('__proto__')
    expect(await again.get('__proto__')).toBeUndefined()
    // A key that merely exists on Object.prototype is not a stored key.
    expect(await storage.get('hasOwnProperty')).toBeUndefined()
  })

  it('rejects bad keys and values as promise rejections', async () => {
    const { storage } = open()
    await expect(storage.get('')).rejects.toThrow('non-empty string')
    await expect(storage.set(5 as unknown as string, 1)).rejects.toThrow('non-empty string')
    await expect(storage.get('k'.repeat(MAX_KEY_LENGTH + 1))).rejects.toThrow('longer than')
    await expect(storage.set('k', undefined as unknown as null)).rejects.toThrow('must be JSON')
    await expect(storage.set('k', 'x'.repeat(MAX_VALUE_LENGTH))).rejects.toThrow('larger than')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await expect(storage.set('k', cyclic as never)).rejects.toThrow()
  })

  it('caps the total size, counting an overwrite as a replacement', async () => {
    const { storage } = open()
    const chunk = 'x'.repeat(MAX_VALUE_LENGTH - 100)
    const fits = Math.floor(MAX_TOTAL_LENGTH / (MAX_VALUE_LENGTH - 100))
    for (let i = 0; i < fits; i++) await storage.set(`k${i}`, chunk)
    await expect(storage.set('one-more', chunk)).rejects.toThrow('exceed')
    // Overwriting an existing key with the same size is fine; deleting frees room.
    await storage.set('k0', chunk)
    await storage.delete('k1')
    await storage.set('one-more', chunk)
  })

  it('uses defaults for a corrupt file and keeps a copy', async () => {
    const file = join(root, 'bad', 'storage.json')
    mkdirSync(join(root, 'bad'))
    writeFileSync(file, '{not json')
    const log = vi.fn()
    const { storage } = createStorage({ file, log })
    expect(await storage.keys()).toEqual([])
    expect(log).toHaveBeenCalled()
    expect(readdirSync(join(root, 'bad')).some((f) => f.includes('.corrupt-'))).toBe(true)
  })

  it('rejects writes when the file is read-only (a newer schemaVersion), instead of losing them', async () => {
    const file = join(root, 'newer.json')
    const text = JSON.stringify({ schemaVersion: 99, values: { k: 1 } })
    writeFileSync(file, text)
    const { storage, flush } = createStorage({ file, log: () => {} })
    expect(await storage.keys()).toEqual([])
    await expect(storage.set('k', 2)).rejects.toThrow('read-only')
    await expect(storage.delete('k')).rejects.toThrow('read-only')
    expect(await storage.get('k')).toBeUndefined()
    flush()
    expect(readFileSync(file, 'utf8')).toBe(text)
  })

  it('ignores a `values` that is not an object', async () => {
    const file = join(root, 'odd.json')
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, values: [1, 2] }))
    const { storage } = createStorage({ file, log: () => {} })
    expect(await storage.keys()).toEqual([])
    await storage.set('k', 1)
    expect(await storage.keys()).toEqual(['k'])
  })
})

describe('storage through a plugin context', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ccc-ctxstorage-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('uses the storage file main named, flushes on dispose, and refuses use after it', async () => {
    const spec = hostSpec({ id: 'a.one', dir: root, main: 'm.js', dataDir: join(root, 'data'), storageFile: join(root, 'data', 'storage.json') })
    const contexts = new HostContexts({ log: () => {} })
    const ctx = contexts.create(spec)
    await ctx.storage.set('k', 'v')
    // dataDir is created on demand, not before.
    expect(existsSync(join(root, 'data', 'storage.json'))).toBe(false)
    contexts.dispose('a.one')
    expect(JSON.parse(readFileSync(spec.storageFile, 'utf8')).values).toEqual({ k: 'v' })
    await expect(ctx.storage.get('k')).rejects.toThrow('deactivated')
    await expect(ctx.storage.set('k', 1)).rejects.toThrow('deactivated')
  })

  it('creates ctx.dataDir on first read, with the path main gave', () => {
    const dataDir = join(root, 'plugin-data', 'p1', 'a.one')
    const ctx = new HostContexts({ log: () => {} }).create(hostSpec({ id: 'a.one', dir: root, main: 'm.js', dataDir }))
    expect(existsSync(dataDir)).toBe(false)
    expect(ctx.dataDir).toBe(dataDir)
    expect(existsSync(dataDir)).toBe(true)
  })
})
