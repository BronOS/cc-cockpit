// zip-writer.ts: the zip a folder downloads as (design-download.md §1.4 "Writer"), read back by a strict
// test reader (central directory, local headers, descriptors, inflateRawSync, CRCs) and by `unzip -t`
// when it is on PATH. Real trees in a temp dir, walked by the real folder walk.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DownloadSkipped } from '../../src/shared/downloads'
import { walkFolder, type WalkEntry, type WalkOptions } from '../../src/main/files/folder-walk'
import { dosTime, ZipCapError, zipEntries, ZIP_CHUNK_BYTES, type ZipOptions } from '../../src/main/files/zip-writer'
import { readZip } from '../fakes/zip-reader'

let tmp: string
let proj: string
let savedTz: string | undefined

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-zip-writer-')))
  proj = join(tmp, 'proj')
  mkdirSync(proj)
  savedTz = process.env.TZ
})

afterEach(() => {
  // Node re-reads TZ on assignment, so a test's zone does not leak into the next.
  if (savedTz === undefined) delete process.env.TZ
  else process.env.TZ = savedTz
  rmSync(tmp, { recursive: true, force: true })
})

function walkOpts(root: string, extra: Partial<WalkOptions> = {}): WalkOptions {
  return {
    root,
    rootName: root.split('/').pop() ?? '',
    includeAll: false,
    outside: false,
    env: { home: join(tmp, 'home'), platform: 'linux' },
    dataDir: join(tmp, 'data'),
    ...extra,
  }
}

function write(rel: string, data: string | Buffer = 'x'): string {
  const p = join(proj, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, data)
  return p
}

async function collect(gen: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = []
  for await (const b of gen) out.push(b)
  return Buffer.concat(out)
}

async function zipOf(root: string, opts: ZipOptions = {}): Promise<Buffer> {
  return collect(zipEntries(walkFolder(walkOpts(root, opts.signal ? { signal: opts.signal } : {})), opts))
}

/** The walk's entries up front, so a test can change the tree between the walk and the writer's opens. */
async function walked(root: string): Promise<WalkEntry[]> {
  const out: WalkEntry[] = []
  for await (const e of walkFolder(walkOpts(root))) out.push(e)
  return out
}

async function* each<T>(items: T[]): AsyncGenerator<T> {
  for (const i of items) yield i
}

const fds = (): number => (process.platform === 'linux' ? readdirSync('/proc/self/fd').length : 0)

describe('zipEntries', () => {
  it('writes UTF-8 names, empty files and folders, files deflated behind a descriptor and folders stored', async () => {
    write('ünï 日本.txt', 'grüße\n'.repeat(100))
    write('empty.txt', '')
    mkdirSync(join(proj, 'emptydir'))
    const entries = readZip(await zipOf(proj))
    expect(entries.map((e) => e.name)).toEqual(['proj/', 'proj/empty.txt', 'proj/emptydir/', 'proj/ünï 日本.txt'])
    for (const e of entries) {
      expect(e.versionMadeBy >> 8).toBe(3) // Unix
      expect(e.versionNeeded).toBe(20)
    }
    const [root, empty, dir, named] = entries
    expect(root).toMatchObject({ method: 0, flags: 0x0800, size: 0, compressedSize: 0, crc: 0 })
    expect(dir).toMatchObject({ method: 0, flags: 0x0800, size: 0, compressedSize: 0, crc: 0 })
    // Never method 0 with a descriptor: even the empty file is deflated.
    expect(empty).toMatchObject({ method: 8, flags: 0x0808, size: 0 })
    expect(named).toMatchObject({ method: 8, flags: 0x0808 })
    expect(named?.data.toString()).toBe('grüße\n'.repeat(100))
    expect(named?.compressedSize).toBeLessThan(named?.size ?? 0)
  })

  it('carries only 0644 and 0755: exec bits kept, setuid, setgid, sticky and group write dropped', async () => {
    chmodSync(write('plain.txt'), 0o666)
    chmodSync(write('run.sh'), 0o700)
    chmodSync(write('suid'), 0o4755)
    chmodSync(write('sgid'), 0o2775)
    mkdirSync(join(proj, 'locked'))
    chmodSync(join(proj, 'locked'), 0o1700)
    const byName = new Map(readZip(await zipOf(proj)).map((e) => [e.name, e]))
    expect(byName.get('proj/plain.txt')?.mode).toBe(0o100644)
    expect(byName.get('proj/run.sh')?.mode).toBe(0o100755)
    expect(byName.get('proj/suid')?.mode).toBe(0o100755)
    expect(byName.get('proj/sgid')?.mode).toBe(0o100755)
    expect(byName.get('proj/locked/')?.mode).toBe(0o040755)
    expect(byName.get('proj/')?.mode).toBe(0o040755)
    // The DOS directory bit on folders, nothing in the low byte of a file's.
    expect((byName.get('proj/locked/')?.externalAttrs ?? 0) & 0xff).toBe(0x10)
    expect((byName.get('proj/plain.txt')?.externalAttrs ?? 0) & 0xff).toBe(0)
  })

  it("stamps DOS time in the server's local time and the 0x5455 mtime in UTC", async () => {
    const f = write('a.txt')
    const when = new Date('2024-01-02T03:04:06Z')
    utimesSync(f, when, when)
    process.env.TZ = 'UTC'
    const utc = readZip(await zipOf(proj)).find((e) => e.name === 'proj/a.txt')
    expect(utc?.dosDate).toBe(((2024 - 1980) << 9) | (1 << 5) | 2)
    expect(utc?.dosTime).toBe((3 << 11) | (4 << 5) | 3)
    expect(utc?.mtime).toBe(when.getTime() / 1000)
    process.env.TZ = 'Asia/Tokyo' // UTC+9, no daylight saving
    const tokyo = readZip(await zipOf(proj)).find((e) => e.name === 'proj/a.txt')
    expect(tokyo?.dosTime).toBe((12 << 11) | (4 << 5) | 3)
    expect(tokyo?.dosDate).toBe(utc?.dosDate)
    expect(tokyo?.mtime).toBe(utc?.mtime)
  })

  it('clamps DOS dates outside 1980..2107 instead of wrapping them', () => {
    process.env.TZ = 'UTC'
    expect(dosTime(new Date('1970-01-01T00:00:00Z'))).toEqual({ time: 0, date: (1 << 5) | 1 })
    expect(dosTime(new Date('2200-06-01T00:00:00Z'))).toEqual({ time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 })
    expect(dosTime(new Date(Number.NaN))).toEqual({ time: 0, date: (1 << 5) | 1 })
  })

  it('writes fixed bytes for a fixed tree with fixed mtimes (TZ=UTC)', async () => {
    process.env.TZ = 'UTC'
    const root = join(tmp, 'fixed')
    mkdirSync(join(root, 'empty'), { recursive: true })
    writeFileSync(join(root, 'a.txt'), 'hello\n')
    writeFileSync(join(root, 'run.sh'), '')
    chmodSync(join(root, 'a.txt'), 0o644)
    chmodSync(join(root, 'run.sh'), 0o755)
    const when = new Date('2024-01-02T03:04:06Z')
    for (const p of ['a.txt', 'run.sh', 'empty', '']) utimesSync(join(root, p), when, when)
    const zip = await zipOf(root)
    // The layout spelled out by hand (APPNOTE 4.3): if zlib ever deflates "hello\n" (cb48cdc9c9e70200) or
    // "" (0300) differently, only those bytes and the sizes after them change.
    const hex = [
      // fixed/: local header, stored, UTF-8, DOS 2024-01-02 03:04:06, 0x5455 mtime 1704164646
      '504b0304 1400 0008 0000 8318 2258 00000000 00000000 00000000 0600 0900', hexOf('fixed/'), '5554 0500 01 26 7d 93 65',
      // fixed/a.txt: local header with bit 3, deflated data, descriptor
      '504b0304 1400 0808 0800 8318 2258 00000000 00000000 00000000 0b00 0900', hexOf('fixed/a.txt'), '5554 0500 01 26 7d 93 65',
      'cb48cdc9c9e70200',
      '504b0708 20303a36 08000000 06000000',
      '504b0304 1400 0008 0000 8318 2258 00000000 00000000 00000000 0c00 0900', hexOf('fixed/empty/'), '5554 0500 01 26 7d 93 65',
      '504b0304 1400 0808 0800 8318 2258 00000000 00000000 00000000 0c00 0900', hexOf('fixed/run.sh'), '5554 0500 01 26 7d 93 65',
      '0300',
      '504b0708 00000000 02000000 00000000',
      // Central directory: made by Unix 2.0, external attributes mode << 16 (| 0x10 for folders), offsets.
      '504b0102 1403 1400 0008 0000 8318 2258 00000000 00000000 00000000 0600 0900 0000 0000 0000 1000ed41 00000000', hexOf('fixed/'), '5554 0500 01 26 7d 93 65',
      '504b0102 1403 1400 0808 0800 8318 2258 20303a36 08000000 06000000 0b00 0900 0000 0000 0000 0000a481 2d000000', hexOf('fixed/a.txt'), '5554 0500 01 26 7d 93 65',
      '504b0102 1403 1400 0008 0000 8318 2258 00000000 00000000 00000000 0c00 0900 0000 0000 0000 1000ed41 77000000', hexOf('fixed/empty/'), '5554 0500 01 26 7d 93 65',
      '504b0102 1403 1400 0808 0800 8318 2258 00000000 02000000 00000000 0c00 0900 0000 0000 0000 0000ed81 aa000000', hexOf('fixed/run.sh'), '5554 0500 01 26 7d 93 65',
      // End record: 4 entries, the directory's size and offset.
      '504b0506 0000 0000 0400 0400 05010000 ef000000 0000',
    ]
      .join('')
      .replace(/ /g, '')
    expect(zip.toString('hex')).toBe(hex)
    readZip(zip)
  })

  it('cuts a file appended while streaming at its fstat size', async () => {
    const original = randomBytes(3 * ZIP_CHUNK_BYTES + 100)
    const p = write('grow.bin', original)
    let appended = false
    const zip = await zipOf(proj, {
      onChunk: (entry) => {
        if (!appended && entry.path === p) {
          appendFileSync(p, randomBytes(5 * ZIP_CHUNK_BYTES))
          appended = true
        }
      },
    })
    expect(appended).toBe(true)
    const e = readZip(zip).find((x) => x.name === 'proj/grow.bin')
    expect(e?.size).toBe(original.length)
    expect(e?.data.equals(original)).toBe(true)
  })

  it('writes a file that shrank while read with what it had', async () => {
    const original = randomBytes(3 * ZIP_CHUNK_BYTES)
    const p = write('shrink.bin', original)
    const cut = ZIP_CHUNK_BYTES + 1000
    const zip = await zipOf(proj, {
      onChunk: (entry, read) => {
        if (entry.path === p && read === ZIP_CHUNK_BYTES) truncateSync(p, cut)
      },
    })
    const e = readZip(zip).find((x) => x.name === 'proj/shrink.bin')
    expect(e?.size).toBe(cut)
    expect(e?.data.equals(original.subarray(0, cut))).toBe(true)
  })

  it('skips a file that cannot be opened now, the zip still valid', async () => {
    write('a.txt', 'a')
    const gone = write('gone.txt')
    const linked = write('linked.txt')
    const fifo = write('fifo')
    const swapped = write('swapped.txt')
    write('z.txt', 'z')
    const entries = await walked(proj)
    unlinkSync(gone)
    unlinkSync(linked)
    symlinkSync(join(proj, 'a.txt'), linked)
    unlinkSync(fifo)
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
    unlinkSync(swapped)
    writeFileSync(swapped, 'another file, another inode')
    const skipped: DownloadSkipped = {}
    const zip = await collect(zipEntries(each(entries), { skipped }))
    expect(readZip(zip).map((e) => e.name)).toEqual(['proj/', 'proj/a.txt', 'proj/z.txt'])
    expect(skipped).toEqual({ unreadable: 2, symlink: 1, special: 1 })
  })

  it('throws past a cap mid-stream, before the end record', async () => {
    write('a.txt', '12345')
    const b = write('b.txt', '12345')
    const entries = await walked(proj)
    appendFileSync(b, 'grown after the count')
    const bytes = await partial(zipEntries(each(entries), { maxBytes: 10 }))
    expect(bytes.error).toBeInstanceOf(ZipCapError)
    expect((bytes.error as ZipCapError).cap).toBe('bytes')
    expect(bytes.data.length).toBeGreaterThan(0)
    expect(() => readZip(bytes.data)).toThrow()
    expect(bytes.data.includes(Buffer.from('504b0506', 'hex'))).toBe(false)

    const many = await partial(zipEntries(each(entries), { maxEntries: 2 }))
    expect((many.error as ZipCapError).cap).toBe('entries')
    expect(many.data.includes(Buffer.from('504b0506', 'hex'))).toBe(false)
  })

  it('stops the walk and closes every descriptor on abort', async () => {
    for (let i = 0; i < 20; i++) write(`d${i}/f.bin`, randomBytes(2 * ZIP_CHUNK_BYTES))
    const before = fds()
    const ac = new AbortController()
    let chunks = 0
    const sink = new Writable({
      write(_c, _e, cb) {
        if (++chunks === 5) ac.abort(new Error('gone'))
        cb()
      },
    })
    await expect(pipeline(Readable.from(zipEntries(walkFolder(walkOpts(proj, { signal: ac.signal })), { signal: ac.signal })), sink)).rejects.toThrow()
    expect(chunks).toBeLessThan(40)
    expect(fds()).toBe(before)
  })

  it('on a write error destroys the source mid-entry, closing the descriptor and the walk', async () => {
    write('a.bin', randomBytes(8 * ZIP_CHUNK_BYTES))
    for (let i = 0; i < 5; i++) write(`b${i}.txt`)
    const before = fds()
    let opened = 0
    let writes = 0
    const sink = new Writable({
      write(_c, _e, cb) {
        cb(++writes === 3 ? new Error('socket reset') : null)
      },
    })
    const walk = walkFolder(walkOpts(proj))
    const counted = (async function* () {
      for await (const e of walk) {
        opened++
        yield e
      }
    })()
    await expect(pipeline(Readable.from(zipEntries(counted)), sink)).rejects.toThrow('socket reset')
    expect(opened).toBeLessThan(4)
    expect(fds()).toBe(before)
    expect((await walk.next()).done).toBe(true) // returned, not left suspended
  })

  it('reads no further ahead than the response takes (back-pressure)', async () => {
    const size = 128 * ZIP_CHUNK_BYTES // 8 MiB, incompressible
    write('big.bin', randomBytes(size))
    let read = 0
    let release: (() => void) | undefined
    const sink = new Writable({
      highWaterMark: 1,
      write(_c, _e, cb) {
        if (release === undefined) release = cb // hold the first write: the socket is not draining
        else cb()
      },
    })
    const done = pipeline(Readable.from(zipEntries(walkFolder(walkOpts(proj)), { onChunk: (_e, n) => void (read = n) })), sink)
    await new Promise((r) => setTimeout(r, 200))
    expect(read).toBeLessThan(size / 2)
    release?.()
    await done
    expect(read).toBe(size)
  })

  it.runIf(spawnSync('unzip', ['-v']).status === 0)('passes unzip -t and extracts as written', async () => {
    write('src/ünï.ts', 'export const x = 1\n'.repeat(500))
    chmodSync(write('bin/run'), 0o755)
    mkdirSync(join(proj, 'empty'))
    write('big.bin', randomBytes(3 * ZIP_CHUNK_BYTES + 7))
    const file = join(tmp, 'out.zip')
    writeFileSync(file, await zipOf(proj))
    const test = spawnSync('unzip', ['-t', file], { encoding: 'utf8' })
    expect(test.stdout).toContain('No errors detected')
    expect(test.status).toBe(0)
    const out = join(tmp, 'out')
    expect(spawnSync('unzip', ['-q', file, '-d', out]).status).toBe(0)
    expect(readdirSync(join(out, 'proj')).sort()).toEqual(['big.bin', 'bin', 'empty', 'src'])
    expect(readdirSync(join(out, 'proj', 'src'))).toEqual(['ünï.ts'])
  })
})

function hexOf(s: string): string {
  return Buffer.from(s, 'utf8').toString('hex')
}

/** What a writer gave before it threw (a response would be destroyed with it). */
async function partial(gen: AsyncGenerator<Buffer>): Promise<{ data: Buffer; error: unknown }> {
  const out: Buffer[] = []
  try {
    for await (const b of gen) out.push(b)
  } catch (error) {
    return { data: Buffer.concat(out), error }
  }
  return { data: Buffer.concat(out), error: undefined }
}
