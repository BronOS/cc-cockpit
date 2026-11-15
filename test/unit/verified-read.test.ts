// verified-read.ts: a file checked inside its folder (resolveInside) and then read through one
// verified descriptor. Each case swaps something between the check and the read, the window a
// read by name would leave open. Real files in a temp dir.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readInside, resolveInside } from '../../src/main/plugins/validate'
import { openVerified, readVerified } from '../../src/main/verified-read'

let root: string
let folder: string
let outside: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-verified-read-')))
  folder = join(root, 'folder')
  outside = join(root, 'outside')
  mkdirSync(join(folder, 'sub'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(folder, 'sub', 'page.html'), '<p>inside</p>')
  writeFileSync(join(outside, 'page.html'), 'SECRET')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** resolveInside's check of sub/page.html, which must pass. */
async function checked(): Promise<{ real: string; dev: number; ino: number }> {
  const target = await resolveInside(folder, 'sub/page.html')
  if (!target.ok) throw new Error(`check failed: ${target.problem}`)
  return target
}

describe('readVerified', () => {
  it('reads the checked file', async () => {
    const target = await checked()
    expect(await readVerified(target.real, 1024, target)).toEqual({ ok: true, data: Buffer.from('<p>inside</p>') })
  })

  it('refuses the file swapped for a symlink to a file outside after the check', async () => {
    const target = await checked()
    rmSync(target.real)
    symlinkSync(join(outside, 'page.html'), target.real)
    expect(await readVerified(target.real, 1024, target)).toEqual({ ok: false, problem: 'symlink' })
  })

  it('refuses a folder above it swapped for a symlink to a folder outside after the check', async () => {
    const target = await checked()
    renameSync(join(folder, 'sub'), join(root, 'old-sub'))
    symlinkSync(outside, join(folder, 'sub'))
    // The open itself succeeds (O_NOFOLLOW guards the last component only): the recheck catches it.
    expect(await readVerified(target.real, 1024, target)).toEqual({ ok: false, problem: 'changed' })
    // With no identity from the caller too: the name no longer resolves to itself.
    expect(await readVerified(target.real, 1024)).toEqual({ ok: false, problem: 'changed' })
  })

  it('refuses another file moved into its place after the check', async () => {
    const target = await checked()
    writeFileSync(join(folder, 'sub', 'other.html'), 'other')
    renameSync(join(folder, 'sub', 'other.html'), target.real)
    expect(await readVerified(target.real, 1024, target)).toEqual({ ok: false, problem: 'changed' })
  })

  it('refuses a FIFO swapped in without blocking on it', async () => {
    const target = await checked()
    rmSync(target.real)
    expect(spawnSync('mkfifo', [target.real]).status).toBe(0)
    expect(await readVerified(target.real, 1024)).toEqual({ ok: false, problem: 'not-file' })
  })

  it('refuses a file over the cap and a file that is gone', async () => {
    const target = await checked()
    expect(await readVerified(target.real, 4, target)).toEqual({ ok: false, problem: 'too-large' })
    rmSync(target.real)
    expect(await readVerified(target.real, 1024, target)).toEqual({ ok: false, problem: 'missing' })
  })
})

describe('openVerified', () => {
  it('hands over the checked descriptor and its fstat', async () => {
    const target = await checked()
    const opened = await openVerified(target.real, target)
    if (!opened.ok) throw new Error(opened.problem)
    try {
      expect(opened.stat.size).toBe(13)
      expect(opened.stat.ino).toBe(target.ino)
      expect((await opened.handle.readFile()).toString()).toBe('<p>inside</p>')
    } finally {
      await opened.handle.close()
    }
  })

  it('refuses a replaced file, a missing one, a symlink and a swapped folder above it', async () => {
    const target = await checked()
    writeFileSync(join(folder, 'sub', 'other.html'), 'other')
    renameSync(join(folder, 'sub', 'other.html'), target.real)
    expect(await openVerified(target.real, target)).toEqual({ ok: false, problem: 'changed' })
    rmSync(target.real)
    expect(await openVerified(target.real)).toEqual({ ok: false, problem: 'missing' })
    symlinkSync(join(outside, 'page.html'), target.real)
    expect(await openVerified(target.real)).toEqual({ ok: false, problem: 'symlink' })
    rmSync(target.real)
    writeFileSync(target.real, 'back')
    renameSync(join(folder, 'sub'), join(root, 'old-sub'))
    symlinkSync(join(root, 'old-sub'), join(folder, 'sub'))
    expect(await openVerified(target.real)).toEqual({ ok: false, problem: 'changed' })
  })

  it('refuses a FIFO without blocking, a device and a Unix socket', async () => {
    const fifo = join(folder, 'fifo')
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
    expect(await openVerified(fifo)).toEqual({ ok: false, problem: 'not-file' })
    expect(await openVerified('/dev/null')).toEqual({ ok: false, problem: 'not-file' })
    const sock = join(folder, 's.sock')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(sock, resolve))
    try {
      expect(await openVerified(sock)).toEqual({ ok: false, problem: 'not-file' })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it.runIf(process.platform === 'linux')('leaves no descriptor open on a refusal', async () => {
    const fds = (): number => readdirSync('/proc/self/fd').length
    const target = await checked()
    const before = fds()
    for (let i = 0; i < 20; i++) {
      expect((await openVerified('/dev/null')).ok).toBe(false)
      expect((await openVerified(target.real, { dev: target.dev, ino: target.ino + 1 })).ok).toBe(false)
    }
    expect(fds()).toBe(before)
  })
})

describe('readInside', () => {
  it('resolves and reads, or says why not', async () => {
    expect(await readInside(folder, 'sub/page.html', 1024)).toEqual({ ok: true, real: join(folder, 'sub', 'page.html'), data: Buffer.from('<p>inside</p>') })
    expect(await readInside(folder, 'sub/page.html', 4)).toEqual({ ok: false, problem: 'too-large' })
    expect(await readInside(folder, 'nope.html', 1024)).toEqual({ ok: false, problem: 'missing' })
    symlinkSync(join(outside, 'page.html'), join(folder, 'escape.html'))
    expect(await readInside(folder, 'escape.html', 1024)).toEqual({ ok: false, problem: 'outside' })
  })
})
