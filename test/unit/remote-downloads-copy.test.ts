// placeDownload on a filesystem with no hard links (exFAT, FAT32, SMB, FUSE): `link` fails with EPERM
// and the file is copied into a destination created with O_EXCL instead. The link itself is made to
// fail here, since a temp dir on the test machine has hard links.
import { constants as fsConstants } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  linkCode: 'EPERM' as string | undefined,
  /** The copy's write fails with this after writing two bytes (dies partway). */
  writeCode: undefined as string | undefined,
  /** Opening the temp for reading fails with this. */
  sourceCode: undefined as string | undefined,
  /** Another process's file put at this name right after the failed link (once). */
  raceName: undefined as string | undefined,
  /** Called after each chunk the copy writes (a cancel arriving mid-copy). */
  onWrite: undefined as (() => void) | undefined,
  /** Called as the copy's destination starts to close, before the close completes. */
  onClose: undefined as (() => void) | undefined,
  /** Called after a real link succeeded, before it returns (a cancel arriving while it ran). */
  onLink: undefined as ((final: string) => Promise<void> | void) | undefined,
  /** Called after the copy's destination was created, before the open returns. */
  onCreate: undefined as (() => void) | undefined,
  /** Called after the temp was opened for reading, before the open returns. */
  onSourceOpen: undefined as (() => void) | undefined,
}))

vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>()
  return {
    ...real,
    link: async (a: string, b: string) => {
      if (!state.linkCode) {
        await real.link(a, b)
        await state.onLink?.(b)
        return
      }
      if (state.raceName === basename(b)) {
        state.raceName = undefined
        await real.writeFile(b, 'theirs')
      }
      throw Object.assign(new Error('no links'), { code: state.linkCode })
    },
    open: async (p: string, flags?: string | number, mode?: number) => {
      // The copy opens its source O_RDONLY | O_NOFOLLOW (no O_CREAT): the read side.
      const reading = flags === 'r' || (typeof flags === 'number' && (flags & fsConstants.O_CREAT) === 0)
      if (state.sourceCode && reading) throw Object.assign(new Error('source failed'), { code: state.sourceCode })
      const handle = await real.open(p, flags, mode)
      const creating = typeof flags === 'number' && (flags & fsConstants.O_EXCL) !== 0
      if (creating) state.onCreate?.()
      if (reading) state.onSourceOpen?.()
      if (!creating || (!state.writeCode && !state.onWrite && !state.onClose)) return handle
      const code = state.writeCode
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'write' && code) {
            return async () => {
              await target.write(Buffer.from('tr'))
              throw Object.assign(new Error('disk full'), { code })
            }
          }
          if (key === 'close' && state.onClose) {
            return async () => {
              const closing = target.close()
              state.onClose?.()
              await closing
            }
          }
          if (key === 'write') {
            return async (buf: Buffer, offset: number, length: number) => {
              const r = await target.write(buf, offset, length)
              state.onWrite?.()
              return r
            }
          }
          const value = Reflect.get(target, key) as unknown
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
        },
      })
    },
  }
})

import { NO_QUARANTINE_TEXT, placeDownload, startSave, type DownloadOutcome, type RemoteDownloadItem } from '../../src/main/remote/remote-downloads'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cc-place-'))
  state.linkCode = 'EPERM'
  state.writeCode = undefined
  state.sourceCode = undefined
  state.raceName = undefined
  state.onWrite = undefined
  state.onClose = undefined
  state.onLink = undefined
  state.onCreate = undefined
  state.onSourceOpen = undefined
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('placeDownload without hard links', () => {
  it('copies the file and removes the temp', async () => {
    const temp = join(dir, '.cc-download-aa')
    await writeFile(temp, 'hello')
    const final = await placeDownload(temp, dir, 'a.txt', { platform: 'linux' })
    expect(final).toBe(join(dir, 'a.txt'))
    expect(await readFile(final, 'utf8')).toBe('hello')
    expect(await readdir(dir)).toEqual(['a.txt'])
  })

  it('never overwrites an entry or follows a dangling link: the next numbered name', async () => {
    const temp = join(dir, '.cc-download-bb')
    await writeFile(temp, 'new')
    await writeFile(join(dir, 'a.txt'), 'old')
    await symlink(join(dir, 'nowhere'), join(dir, 'a (1).txt'))
    const final = await placeDownload(temp, dir, 'a.txt', { platform: 'linux' })
    expect(final).toBe(join(dir, 'a (2).txt'))
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('old')
    const names = await readdir(dir)
    expect(names).not.toContain('nowhere')
    expect(names).not.toContain('.cc-download-bb')
  })

  it('removes a truncated copy and the temp when the copy fails partway', async () => {
    const temp = join(dir, '.cc-download-cc')
    await writeFile(temp, 'hello')
    state.writeCode = 'ENOSPC'
    await expect(placeDownload(temp, dir, 'a.txt', { platform: 'linux' })).rejects.toThrow('disk full')
    expect(await readdir(dir)).toEqual([])
  })

  it('never removes a file another process put at the name after the failed link', async () => {
    const temp = join(dir, '.cc-download-ee')
    await writeFile(temp, 'hello')
    // The name is taken between our link and our copy, and then the copy cannot read the temp: their
    // file stays, and only the numbered destination this call created is removed.
    state.raceName = 'a.txt'
    state.sourceCode = 'EMFILE'
    await expect(placeDownload(temp, dir, 'a.txt', { platform: 'linux' })).rejects.toThrow('source failed')
    expect(await readdir(dir)).toEqual(['a.txt'])
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('theirs')
  })

  it('copies a file larger than one chunk whole', async () => {
    const temp = join(dir, '.cc-download-ff')
    const data = Buffer.alloc(2.5 * 1024 * 1024, 7)
    await writeFile(temp, data)
    const final = await placeDownload(temp, dir, 'big.bin', { platform: 'linux' })
    expect((await readFile(final)).equals(data)).toBe(true)
  })

  it('on macOS refuses to copy (the quarantine mark would be lost) and leaves nothing', async () => {
    const temp = join(dir, '.cc-download-mm')
    await writeFile(temp, 'hello')
    await expect(placeDownload(temp, dir, 'a.txt', { platform: 'darwin' })).rejects.toThrow(NO_QUARANTINE_TEXT)
    expect(await readdir(dir)).toEqual([])
  })

  it('on macOS a hard link still places the file (it keeps the inode and its xattrs)', async () => {
    state.linkCode = undefined
    const temp = join(dir, '.cc-download-ml')
    await writeFile(temp, 'hello')
    const final = await placeDownload(temp, dir, 'a.txt', { platform: 'darwin' })
    expect(await readFile(final, 'utf8')).toBe('hello')
    expect(await readdir(dir)).toEqual(['a.txt'])
  })

  it('does not copy on a link error that is not a missing-links one', async () => {
    const temp = join(dir, '.cc-download-dd')
    await writeFile(temp, 'hello')
    state.linkCode = 'EACCES'
    await expect(placeDownload(temp, dir, 'a.txt', { platform: 'linux' })).rejects.toThrow('no links')
    expect(await readdir(dir)).toEqual([])
  })
})

/** A download item that completes when told to, after the test wrote its bytes at the save path. */
function fakeItem(): { item: RemoteDownloadItem; path(): string; complete(): void } {
  let savePath = ''
  let onDone: ((state: 'completed' | 'cancelled' | 'interrupted') => void) | undefined
  const item: RemoteDownloadItem = {
    url: () => 'http://server/d/x',
    urlChain: () => ['http://server/d/x'],
    filename: () => 'big.bin',
    totalBytes: () => 0,
    receivedBytes: () => 0,
    setSavePath: (p) => (savePath = p),
    cancel: () => undefined,
    onUpdated: () => undefined,
    onDone: (l) => (onDone = l),
  }
  return { item, path: () => savePath, complete: () => onDone?.('completed') }
}

describe('a placement cancelled mid-copy', () => {
  const big = Buffer.alloc(3 * 1024 * 1024, 7)

  it('placeDownload stops between chunks and leaves neither the temp nor the copy', async () => {
    const temp = join(dir, '.cc-download-gg')
    await writeFile(temp, big)
    const ac = new AbortController()
    state.onWrite = () => ac.abort(new Error('its window was closed'))
    await expect(placeDownload(temp, dir, 'big.bin', { signal: ac.signal, platform: 'linux' })).rejects.toThrow('its window was closed')
    expect(await readdir(dir)).toEqual([])
  })

  it('a window closed during the copy saves nothing, and says why', async () => {
    const f = fakeItem()
    const outcomes: DownloadOutcome[] = []
    const save = startSave({ item: f.item, dir, name: 'big.bin', progress: () => undefined, done: (o) => outcomes.push(o), log: () => undefined, platform: 'linux' })
    await writeFile(f.path(), big)
    state.onWrite = () => save.cancel('its window was closed')
    f.complete()
    await vi.waitFor(() => expect(outcomes).toHaveLength(1))
    expect(outcomes[0]).toEqual({ failed: 'its window was closed' })
    expect(await readdir(dir)).toEqual([])
  })

  it('placeDownload cancelled while the copy closes removes the whole copy too', async () => {
    const temp = join(dir, '.cc-download-hh')
    await writeFile(temp, big)
    const ac = new AbortController()
    state.onClose = () => ac.abort(new Error('its window was closed'))
    await expect(placeDownload(temp, dir, 'big.bin', { signal: ac.signal, platform: 'linux' })).rejects.toThrow('its window was closed')
    expect(await readdir(dir)).toEqual([])
  })

  it('a window closed during the copy\'s close saves nothing, and says why', async () => {
    const f = fakeItem()
    const outcomes: DownloadOutcome[] = []
    const save = startSave({ item: f.item, dir, name: 'big.bin', progress: () => undefined, done: (o) => outcomes.push(o), log: () => undefined, platform: 'linux' })
    await writeFile(f.path(), big)
    state.onClose = () => save.cancel('its window was closed')
    f.complete()
    await vi.waitFor(() => expect(outcomes).toHaveLength(1))
    expect(outcomes[0]).toEqual({ failed: 'its window was closed' })
    expect(await readdir(dir)).toEqual([])
  })

  it('on macOS a save to a folder with no hard links fails with the reason and leaves nothing', async () => {
    const f = fakeItem()
    const outcomes: DownloadOutcome[] = []
    startSave({ item: f.item, dir, name: 'big.bin', progress: () => undefined, done: (o) => outcomes.push(o), log: () => undefined, platform: 'darwin' })
    await writeFile(f.path(), big)
    f.complete()
    await vi.waitFor(() => expect(outcomes).toHaveLength(1))
    expect(outcomes[0]).toEqual({ failed: NO_QUARANTINE_TEXT, placement: true })
    expect(await readdir(dir)).toEqual([])
  })

  it('a cancel after the placement finished keeps the saved file', async () => {
    const f = fakeItem()
    const outcomes: DownloadOutcome[] = []
    const save = startSave({ item: f.item, dir, name: 'big.bin', progress: () => undefined, done: (o) => outcomes.push(o), log: () => undefined, platform: 'linux' })
    await writeFile(f.path(), big)
    f.complete()
    await vi.waitFor(() => expect(outcomes).toHaveLength(1))
    save.cancel('its window was closed')
    expect(outcomes).toEqual([{ saved: join(dir, 'big.bin') }])
    expect(await readdir(dir)).toEqual(['big.bin'])
    expect((await readFile(join(dir, 'big.bin'))).equals(big)).toBe(true)
  })
})

describe('a placement cancelled while a filesystem call ran', () => {
  const abortWith = (ac: AbortController) => () => ac.abort(new Error('its window was closed'))

  it('a link that succeeded after the cancel is removed, and the temp too', async () => {
    state.linkCode = undefined
    const temp = join(dir, '.cc-download-la')
    await writeFile(temp, 'hello')
    const ac = new AbortController()
    state.onLink = abortWith(ac)
    await expect(placeDownload(temp, dir, 'a.txt', { signal: ac.signal, platform: 'linux' })).rejects.toThrow('its window was closed')
    expect(await readdir(dir)).toEqual([])
  })

  it('never removes a file another process put at the name after the cancelled link', async () => {
    state.linkCode = undefined
    const temp = join(dir, '.cc-download-lb')
    await writeFile(temp, 'hello')
    const ac = new AbortController()
    state.onLink = async (final) => {
      await rm(final)
      await writeFile(final, 'theirs')
      ac.abort(new Error('its window was closed'))
    }
    await expect(placeDownload(temp, dir, 'a.txt', { signal: ac.signal, platform: 'linux' })).rejects.toThrow('its window was closed')
    expect(await readdir(dir)).toEqual(['a.txt'])
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('theirs')
  })

  it('a window closed during the link saves nothing, and says why', async () => {
    state.linkCode = undefined
    const f = fakeItem()
    const outcomes: DownloadOutcome[] = []
    const save = startSave({ item: f.item, dir, name: 'a.txt', progress: () => undefined, done: (o) => outcomes.push(o), log: () => undefined, platform: 'linux' })
    await writeFile(f.path(), 'hello')
    state.onLink = () => save.cancel('its window was closed')
    f.complete()
    await vi.waitFor(() => expect(outcomes).toHaveLength(1))
    expect(outcomes[0]).toEqual({ failed: 'its window was closed' })
    expect(await readdir(dir)).toEqual([])
  })

  for (const at of ['create', 'source open'] as const) {
    it(`a copy cancelled during its ${at} is removed, and the temp too`, async () => {
      const temp = join(dir, `.cc-download-c${at.length}`)
      await writeFile(temp, 'hello')
      const ac = new AbortController()
      if (at === 'create') state.onCreate = abortWith(ac)
      else state.onSourceOpen = abortWith(ac)
      await expect(placeDownload(temp, dir, 'a.txt', { signal: ac.signal, platform: 'linux' })).rejects.toThrow('its window was closed')
      expect(await readdir(dir)).toEqual([])
    })
  }
})
