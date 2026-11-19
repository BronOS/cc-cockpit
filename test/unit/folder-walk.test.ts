// folder-walk.ts: what a folder's zip holds and what it leaves out, by reason (design-download.md §1.4),
// and the counting pass's caps and 10 s bound. Real trees in a temp dir; a slow fake fs for the bound.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOWNLOAD_ZIP_MAX_ENTRIES, type DownloadSkipped } from '../../src/shared/downloads'
import { countFolder, walkFolder, walkName, zipRootName, type WalkOptions } from '../../src/main/files/folder-walk'
import { ZipCapError } from '../../src/main/files/zip-writer'

let tmp: string
let proj: string
let dataDir: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-folder-walk-')))
  proj = join(tmp, 'proj')
  dataDir = join(tmp, 'data')
  mkdirSync(proj)
  mkdirSync(dataDir)
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function opts(root: string, extra: Partial<WalkOptions> = {}): WalkOptions {
  return {
    root,
    rootName: root.split('/').pop() ?? '',
    includeAll: false,
    outside: false,
    env: { home: join(tmp, 'home'), platform: 'linux' },
    dataDir,
    ...extra,
  }
}

async function names(o: WalkOptions, skipped: DownloadSkipped = {}): Promise<string[]> {
  const out: string[] = []
  for await (const e of walkFolder(o, skipped)) out.push(e.name)
  return out
}

function write(rel: string, data = 'x'): void {
  const p = join(proj, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, data)
}

describe('walkFolder', () => {
  it('lists the root first, then depth-first in sorted order, with empty folders kept', async () => {
    write('b.txt', 'bb')
    write('a/z.txt')
    write('a/c/d.txt')
    mkdirSync(join(proj, 'empty'))
    const entries = []
    for await (const e of walkFolder(opts(proj))) entries.push(e)
    expect(entries.map((e) => e.name)).toEqual(['proj/', 'proj/a/', 'proj/a/c/', 'proj/a/c/d.txt', 'proj/a/z.txt', 'proj/b.txt', 'proj/empty/'])
    const b = entries.find((e) => e.name === 'proj/b.txt')
    expect(b?.kind).toBe('file')
    expect(b?.path).toBe(join(proj, 'b.txt'))
    expect(b?.stat.size).toBe(2)
    expect(entries[0]?.kind).toBe('folder')
  })

  it('names entries after the named folder, `download` when that name fails the filter', async () => {
    write('f.txt')
    expect(await names(opts(proj, { rootName: 'link-name' }))).toEqual(['link-name/', 'link-name/f.txt'])
    expect(await names(opts(proj, { rootName: 'bad‮name' }))).toEqual(['download/', 'download/f.txt'])
    expect(zipRootName('')).toBe('download')
    expect(zipRootName('a\\b')).toBe('download')
    expect(zipRootName('ok')).toBe('ok')
  })

  it('skips symlinks (never followed), specials, and counts each', async () => {
    write('real/f.txt')
    symlinkSync(join(proj, 'real'), join(proj, 'linkdir'))
    symlinkSync(join(proj, 'real', 'f.txt'), join(proj, 'linkfile'))
    symlinkSync('/nowhere', join(proj, 'dangling'))
    expect(spawnSync('mkfifo', [join(proj, 'fifo')]).status).toBe(0)
    const skipped: DownloadSkipped = {}
    expect(await names(opts(proj), skipped)).toEqual(['proj/', 'proj/real/', 'proj/real/f.txt'])
    expect(skipped).toEqual({ symlink: 3, special: 1 })
  })

  it('leaves out .git and node_modules below the root unless included', async () => {
    write('src/a.js')
    write('.git/HEAD')
    write('node_modules/foo/index.js')
    write('src/node_modules/bar/x.js')
    write('.gitignore')
    const skipped: DownloadSkipped = {}
    expect(await names(opts(proj), skipped)).toEqual(['proj/', 'proj/.gitignore', 'proj/src/', 'proj/src/a.js'])
    expect(skipped).toEqual({ excluded: 3 })
    const all: DownloadSkipped = {}
    expect(await names(opts(proj, { includeAll: true }), all)).toEqual([
      'proj/', 'proj/.git/', 'proj/.git/HEAD', 'proj/.gitignore', 'proj/node_modules/', 'proj/node_modules/foo/',
      'proj/node_modules/foo/index.js', 'proj/src/', 'proj/src/a.js', 'proj/src/node_modules/', 'proj/src/node_modules/bar/',
      'proj/src/node_modules/bar/x.js',
    ])
    expect(all).toEqual({})
  })

  it('walks .git and node_modules/foo when they are the root', async () => {
    write('.git/HEAD')
    write('.git/objects/ab')
    write('node_modules/foo/index.js')
    write('node_modules/foo/node_modules/dep/i.js')
    expect(await names(opts(join(proj, '.git')))).toEqual(['.git/', '.git/HEAD', '.git/objects/', '.git/objects/ab'])
    const skipped: DownloadSkipped = {}
    expect(await names(opts(join(proj, 'node_modules', 'foo')), skipped)).toEqual(['foo/', 'foo/index.js'])
    expect(skipped).toEqual({ excluded: 1 })
  })

  it('skips the data dir wherever it lies, inside the project too', async () => {
    write('keep.txt')
    const inside = join(proj, '.data')
    mkdirSync(inside)
    writeFileSync(join(inside, 'secret.key'), 'k')
    const skipped: DownloadSkipped = {}
    expect(await names(opts(proj, { dataDir: inside }), skipped)).toEqual(['proj/', 'proj/keep.txt'])
    expect(skipped).toEqual({ dataDir: 1 })
  })

  it('applies the outside rule to every entry of an outside root', async () => {
    const home = join(tmp, 'home')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'KEY')
    writeFileSync(join(home, '.zshrc'), 'x')
    mkdirSync(join(home, 'work'))
    writeFileSync(join(home, 'work', 'a.txt'), 'a')
    mkdirSync(join(home, 'work', '.cache'))
    // Naming the home's parent must not skip the rule (the home itself is refused as a root by the caller).
    const skipped: DownloadSkipped = {}
    const got = await names(opts(tmp, { outside: true, dataDir: join(tmp, 'elsewhere') }), skipped)
    expect(got).toContain(`${tmp.split('/').pop()}/home/work/a.txt`)
    expect(got.some((n) => n.includes('.ssh') || n.includes('.zshrc') || n.includes('.cache'))).toBe(false)
    expect(skipped.refused).toBe(3)
    // Inside a project the same names are fine (dot files download, §1.2).
    expect(await names(opts(join(home, 'work')))).toEqual(['work/', 'work/.cache/', 'work/a.txt'])
  })

  it('skips names a receiving system would misread', async () => {
    write('ok.txt')
    write('back\\slash')
    write('ctl\u0001x')
    write('bidi‮txt.exe')
    // APFS refuses a name that is not UTF-8 (EILSEQ) on the macOS runner; walkName's byte checks
    // below still cover it there.
    let badBytes = true
    try {
      writeFileSync(Buffer.concat([Buffer.from(proj + '/bad'), Buffer.from([0xff, 0xfe])]), 'x')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EILSEQ') throw err
      badBytes = false
    }
    const skipped: DownloadSkipped = {}
    expect(await names(opts(proj), skipped)).toEqual(['proj/', 'proj/ok.txt'])
    expect(skipped).toEqual({ name: badBytes ? 4 : 3 })
    expect(walkName(Buffer.from([0x61, 0xc3]))).toBeNull()
    expect(walkName(Buffer.from('é.txt'))).toBe('é.txt')
    // A leading BOM must not be stripped into a twin's name.
    expect(walkName(Buffer.from('\uFEFFfoo'))).not.toBe('foo')
  })

  it.runIf(process.getuid?.() !== 0)('skips unreadable folders whole', async () => {
    write('locked/f.txt')
    write('open.txt')
    chmodSync(join(proj, 'locked'), 0o000)
    try {
      const skipped: DownloadSkipped = {}
      expect(await names(opts(proj), skipped)).toEqual(['proj/', 'proj/open.txt'])
      expect(skipped).toEqual({ unreadable: 1 })
    } finally {
      chmodSync(join(proj, 'locked'), 0o755)
    }
  })

  it('goes at most 64 folders deep', async () => {
    let p = proj
    for (let i = 0; i < 66; i++) p = join(p, 'd')
    mkdirSync(p, { recursive: true })
    const skipped: DownloadSkipped = {}
    const got = await names(opts(proj), skipped)
    expect(got.length).toBe(1 + 64)
    expect(skipped).toEqual({ deep: 1 })
  })

  it('stops on abort with the reason, leaving no descriptor open', async () => {
    for (let i = 0; i < 30; i++) write(`d${i}/f.txt`)
    const fds = (): number => readdirSync('/proc/self/fd').length
    const before = process.platform === 'linux' ? fds() : 0
    const ac = new AbortController()
    let seen = 0
    const run = async (): Promise<void> => {
      const entries = walkFolder(opts(proj, { signal: ac.signal }))
      while (!(await entries.next()).done) {
        if (++seen === 5) ac.abort(new Error('gone'))
      }
    }
    await expect(run()).rejects.toThrow('gone')
    expect(seen).toBe(5)
    if (process.platform === 'linux') expect(fds()).toBe(before)
  })

  it('throws when the root is not a listable folder', async () => {
    write('f.txt')
    await expect(names(opts(join(proj, 'f.txt')))).rejects.toThrow()
    await expect(names(opts(join(proj, 'missing')))).rejects.toThrow()
  })
})

describe('countFolder', () => {
  it('counts both totals and the skips of each', async () => {
    write('a.txt', 'aaaa')
    write('src/b.txt', 'bb')
    write('.git/HEAD', '123456')
    write('node_modules/x/i.js', '1')
    symlinkSync('/nowhere', join(proj, 'node_modules', 'x', 'l'))
    symlinkSync('/nowhere', join(proj, 'l'))
    const r = await countFolder(opts(proj))
    expect(r).toEqual({
      ok: true,
      plain: { files: 2, folders: 2, bytes: 6 },
      all: { files: 4, folders: 5, bytes: 13 },
      skipped: { plain: { excluded: 2, symlink: 1 }, all: { symlink: 2 } },
    })
  })

  it('fails past a cap on the plain totals, by bytes and by entries', async () => {
    write('a.txt', 'a'.repeat(10))
    write('b.txt', 'b'.repeat(10))
    expect(await countFolder({ ...opts(proj), maxBytes: 15 })).toMatchObject({ ok: false, problem: 'too-large', cap: 'bytes' })
    expect(await countFolder({ ...opts(proj), maxEntries: 2 })).toMatchObject({ ok: false, problem: 'too-large', cap: 'entries' })
    expect(await countFolder({ ...opts(proj), maxEntries: 3, maxBytes: 20 })).toMatchObject({ ok: true })
  })

  it('stops counting .git and node_modules past a cap, the plain choice still fine', async () => {
    write('a.txt', 'a')
    for (let i = 0; i < 20; i++) write(`node_modules/p${i}/i.js`, 'x'.repeat(100))
    const r = await countFolder({ ...opts(proj), maxBytes: 500 })
    if (!r.ok) throw new Error(r.problem)
    expect(r.plain).toEqual({ files: 1, folders: 1, bytes: 1 })
    expect(r.allOver).toBe('too-large')
    expect(r.allCap).toBe('bytes')
    expect(r.all.bytes).toBeGreaterThan(500)
    expect(r.all.files).toBeLessThan(21)
  })

  it('refuses a folder with more names than the entry cap, even when most are skipped links', async () => {
    // The listing stops one past the cap, so the names after it were never read: zipping what was read
    // would leave files out without counting them. 20,000 links and one file is under the cap once
    // the links are skipped, and still refused.
    write('a.txt')
    mkdirSync(join(proj, 'many'))
    for (let i = 0; i < DOWNLOAD_ZIP_MAX_ENTRIES; i++) symlinkSync('/nowhere', join(proj, 'many', `l${i}`))
    write('many/real.txt')
    // The entry cap, not guessed from the totals (which stopped far under both caps).
    expect(await countFolder(opts(proj))).toMatchObject({ ok: false, problem: 'too-large', cap: 'entries' })
    await expect(names(opts(proj))).rejects.toBeInstanceOf(ZipCapError)
    // 20,000 symlinks: about 18 s on macOS (APFS) under load, so 30 s left too little room.
  }, 90_000)

  it('an over-full folder inside node_modules only makes the include choice too large', async () => {
    write('a.txt')
    const many = join(proj, 'node_modules', 'many')
    const fs = {
      lstat: (p: string): Promise<Stats> => lstat(p),
      readdir: (p: string): Promise<Buffer[]> =>
        Promise.resolve(p === many ? Array.from({ length: DOWNLOAD_ZIP_MAX_ENTRIES + 1 }, (_, i) => Buffer.from(`l${i}`)) : readdirSync(p, { encoding: 'buffer' })),
    }
    mkdirSync(many, { recursive: true })
    const r = await countFolder({ ...opts(proj), fs })
    if (!r.ok) throw new Error(r.problem)
    expect(r.plain).toEqual({ files: 1, folders: 1, bytes: 1 })
    expect(r.allOver).toBe('too-large')
    expect(r.allCap).toBe('entries')
    // With them included, the writer's walk refuses instead of zipping a cut listing.
    await expect(names(opts(proj, { fs, includeAll: true }))).rejects.toBeInstanceOf(ZipCapError)
    expect(await names(opts(proj, { fs }))).toEqual(['proj/', 'proj/a.txt'])
  })

  it('gives up after the time bound ("too many files to count"), even on a hung fs call', async () => {
    write('a.txt')
    write('slow/b.txt')
    const hung = new Promise<never>(() => {})
    const fs = {
      lstat: (p: string): Promise<Stats> => (p.endsWith('/slow') ? hung : lstat(p)),
      readdir: (p: string): Promise<Buffer[]> => Promise.resolve(readdirSync(p, { encoding: 'buffer' })),
    }
    const started = Date.now()
    // 500 ms, not 50: under load the one quick file could miss a 50 ms bound and count 0.
    const r = await countFolder({ ...opts(proj), fs, timeoutMs: 500 })
    expect(r).toEqual({ ok: false, problem: 'timeout', plain: { files: 1, folders: 1, bytes: 1 } })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it("passes the caller's abort through, not as a timeout", async () => {
    write('a.txt')
    const ac = new AbortController()
    ac.abort(new Error('closed'))
    await expect(countFolder({ ...opts(proj), signal: ac.signal })).rejects.toThrow('closed')
  })
})
