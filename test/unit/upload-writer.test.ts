// upload-writer.ts: the temp per file, chunks at their offsets (gaps, overlaps, past the size, short and
// broken bodies, one chunk at a time), the commit (exclusive link, numbering, the copy fallback, Replace
// and its mode, a target or a folder changed meanwhile), aborts, ENOSPC, and the temps record with its
// sweep at start. Real `Uploads` and real trees in a temp dir; the fs seam makes a write fail with
// ENOSPC and a link with EXDEV.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { open as realOpen, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UPLOAD_CHUNK_MAX_BYTES, UPLOAD_TEMP_PREFIX, type UploadBegun } from '../../src/shared/uploads'
import { Uploads, type UploadCaller } from '../../src/main/files/uploads'
import { UPLOAD_DISK_FULL_TEXT, UPLOAD_TOKEN_UNKNOWN_TEXT, UploadWriter, type UploadChunkResult, type UploadWriterFs } from '../../src/main/files/upload-writer'

let tmp: string
let proj: string
let outside: string
let tempsFile: string
/** Every error text a view could be shown: none may name a host path. */
let shown: string[]

const A: UploadCaller = { deviceId: 'dev-a', windowId: 3 }

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-upload-writer-')))
  proj = join(tmp, 'proj')
  outside = join(tmp, 'outside')
  mkdirSync(proj)
  mkdirSync(outside)
  mkdirSync(join(tmp, 'data'))
  tempsFile = join(tmp, 'data', 'uploads', 'temps.json')
  shown = []
})

afterEach(() => {
  for (const text of shown) {
    expect(text).not.toContain(tmp)
  }
  rmSync(tmp, { recursive: true, force: true })
})

interface Rig {
  uploads: Uploads
  writer: UploadWriter
  logs: string[]
}

function rig(fs?: Partial<UploadWriterFs>): Rig {
  const logs: string[] = []
  // The cycle the wiring has too: Uploads takes the writer, the writer reads Uploads through a getter.
  const ref: { uploads?: Uploads } = {}
  const writer = new UploadWriter({
    grants: () => ref.uploads as Uploads,
    projectRoot: () => proj,
    tempsFile,
    fs,
    log: (line) => logs.push(line),
  })
  const uploads = new Uploads({
    projectRoot: () => proj,
    dataDir: join(tmp, 'data'),
    writer,
    statfs: async () => ({ bavail: 100 * 1024 ** 3, bsize: 1 }),
    platform: 'linux',
    log: (line) => logs.push(line),
  })
  ref.uploads = uploads
  return { uploads, writer, logs }
}

async function begin(r: Rig, folder: string, specs: Array<{ name: string; size: number }>): Promise<UploadBegun> {
  const reply = await r.uploads.begin(A, { panel: 'cockpit.files/tree' }, folder, specs)
  if ('error' in reply) throw new Error(`refused: ${reply.error}`)
  return reply
}

/** A token for one file `name` of `size` bytes in `folder`, nothing clashing. */
async function tokenFor(r: Rig, folder: string, name: string, size: number): Promise<{ token: string; uploadId: string }> {
  const b = await begin(r, folder, [{ name, size }])
  const token = b.tokens?.[0]?.token
  if (!token) throw new Error('no token')
  return { token, uploadId: b.uploadId }
}

function body(...parts: string[]): Readable {
  return Readable.from(parts.map((p) => Buffer.from(p)))
}

/** A body that sends `first` and then breaks (the client went mid-chunk). */
function brokenBody(first: string): Readable {
  let sent = false
  return new Readable({
    read() {
      if (sent) return
      sent = true
      this.push(Buffer.from(first))
      setImmediate(() => this.destroy(new Error('aborted')))
    },
  })
}

async function put(r: Rig, token: string, offset: number, data: string | Readable, length?: number): Promise<UploadChunkResult> {
  const stream = typeof data === 'string' ? body(data) : data
  const len = length ?? (typeof data === 'string' ? Buffer.byteLength(data) : 0)
  const result = await r.writer.writeChunk(token, offset, stream, len)
  if (result.status !== 200) shown.push(result.error)
  return result
}

function tempsIn(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.startsWith(UPLOAD_TEMP_PREFIX))
}

function recorded(): string[] {
  if (!existsSync(tempsFile)) return []
  return (JSON.parse(readFileSync(tempsFile, 'utf8')) as { temps: string[] }).temps
}

/** Past the record's debounced save (JsonFile, 300 ms). */
const settleRecord = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400))

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
  if (!check()) throw new Error('timed out')
}

/** fs.open whose handles fail every write with ENOSPC (its message names the path, as Node's does). */
const fullDisk: Partial<UploadWriterFs> = {
  open: async (path, flags, mode) => {
    const handle = await realOpen(path, flags, mode)
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'write') {
          return async () => {
            throw Object.assign(new Error(`ENOSPC: no space left on device, write '${path}'`), { code: 'ENOSPC' })
          }
        }
        const value = Reflect.get(target, key) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    }) as FileHandle
  },
}

describe('chunks and offsets', () => {
  it('writes a file in chunks at their offsets and commits it on the last byte', async () => {
    const r = rig()
    mkdirSync(join(proj, 'sub'))
    const { token, uploadId } = await tokenFor(r, 'sub', 'a.txt', 10)
    expect(await put(r, token, 0, 'hello')).toEqual({ status: 200, reply: { received: 5 } })
    // The temp is in the target folder and on the record, on disk, before the next chunk.
    const [temp] = tempsIn(join(proj, 'sub'))
    expect(temp).toMatch(/^\.cc-upload-[0-9a-f]{16}$/)
    expect(recorded()).toEqual([join(proj, 'sub', temp!)])
    expect(await put(r, token, 5, 'world')).toEqual({ status: 200, reply: { done: true, name: 'a.txt', path: 'sub/a.txt' } })
    expect(readFileSync(join(proj, 'sub', 'a.txt'), 'utf8')).toBe('helloworld')
    expect(tempsIn(join(proj, 'sub'))).toEqual([])
    // A new file never gets an exec bit (a File carries no mode).
    expect(statSync(join(proj, 'sub', 'a.txt')).mode & 0o111).toBe(0)
    expect(r.uploads.outcome(A, uploadId)?.state).toBe('finished')
    expect(r.uploads.outcome(A, uploadId)?.results.get(0)).toEqual({ ok: true, name: 'a.txt', path: 'sub/a.txt' })
    // The token died with the commit.
    expect(await put(r, token, 10, 'x')).toMatchObject({ status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT })
    await settleRecord()
    expect(recorded()).toEqual([])
  })

  it('refuses a gap and an overlap with 409 and the offset expected, and a chunk past the size with 413', async () => {
    const r = rig()
    const { token } = await tokenFor(r, '', 'a.txt', 10)
    expect(await put(r, token, 3, 'abc')).toMatchObject({ status: 409, expected: 0 })
    // Refused before anything was made: no temp for a chunk that cannot be written.
    expect(tempsIn(proj)).toEqual([])
    expect(await put(r, token, 0, 'abcd')).toEqual({ status: 200, reply: { received: 4 } })
    expect(await put(r, token, 2, 'cdef')).toMatchObject({ status: 409, expected: 4 })
    expect(await put(r, token, 6, 'efgh')).toMatchObject({ status: 409, expected: 4 })
    expect(await put(r, token, 4, 'efghijk')).toMatchObject({ status: 413 })
    expect(await put(r, token, 4, 'x', UPLOAD_CHUNK_MAX_BYTES + 1)).toMatchObject({ status: 413 })
    expect(await put(r, token, -1, 'x')).toMatchObject({ status: 400 })
    expect(await put(r, token, 4, body(), 0)).toMatchObject({ status: 400 })
    // Nothing of the refused chunks reached the file.
    expect(await put(r, token, 4, 'efghij')).toMatchObject({ status: 200, reply: { done: true } })
    expect(readFileSync(join(proj, 'a.txt'), 'utf8')).toBe('abcdefghij')
  })

  it('an unknown token is 404, and refusals before the body leave it unread', async () => {
    const r = rig()
    const stream = body('abc')
    expect(await r.writer.writeChunk('nope', 0, stream, 3)).toMatchObject({ status: 404, error: UPLOAD_TOKEN_UNKNOWN_TEXT })
    expect(stream.readableEnded).toBe(false)
  })

  it('a short body is truncated back to its offset and the token kept for the retry', async () => {
    const r = rig()
    const { token } = await tokenFor(r, '', 'a.txt', 10)
    expect(await put(r, token, 0, 'abcd')).toMatchObject({ status: 200 })
    // Declared 6, only 2 came.
    expect(await put(r, token, 4, body('ef'), 6)).toMatchObject({ status: 400, expected: 4 })
    const [temp] = tempsIn(proj)
    expect(statSync(join(proj, temp!)).size).toBe(4)
    expect(await put(r, token, 4, 'efghij')).toMatchObject({ status: 200, reply: { done: true, name: 'a.txt' } })
    expect(readFileSync(join(proj, 'a.txt'), 'utf8')).toBe('abcdefghij')
  })

  it('a body that breaks mid-chunk is truncated back, and one longer than its length too', async () => {
    const r = rig()
    const { token } = await tokenFor(r, '', 'a.txt', 6)
    expect(await put(r, token, 0, brokenBody('abc'), 6)).toMatchObject({ status: 400, expected: 0 })
    const [temp] = tempsIn(proj)
    expect(statSync(join(proj, temp!)).size).toBe(0)
    expect(await put(r, token, 0, body('abc', 'defgh'), 3)).toMatchObject({ status: 400, expected: 0 })
    expect(statSync(join(proj, temp!)).size).toBe(0)
    expect(await put(r, token, 0, 'abcdef')).toMatchObject({ status: 200, reply: { done: true } })
    expect(readFileSync(join(proj, 'a.txt'), 'utf8')).toBe('abcdef')
  })

  it('a declared-empty file commits on its one zero-length chunk at 0', async () => {
    const r = rig()
    const { token } = await tokenFor(r, '', '.gitkeep', 0)
    expect(await put(r, token, 0, body(), 0)).toEqual({ status: 200, reply: { done: true, name: '.gitkeep', path: '.gitkeep' } })
    expect(statSync(join(proj, '.gitkeep')).size).toBe(0)
    expect(tempsIn(proj)).toEqual([])
  })

  it('runs chunks of one file one at a time: a retry waits for the chunk still being read', async () => {
    const r = rig()
    const { token } = await tokenFor(r, '', 'a.txt', 6)
    const slow = new PassThrough()
    const first = put(r, token, 0, slow, 3)
    slow.write('ab')
    await until(() => tempsIn(proj).length === 1)
    // The client gave up and sent again from 0 while the first is still reading.
    const second = put(r, token, 0, 'abc')
    slow.end('c')
    expect(await first).toEqual({ status: 200, reply: { received: 3 } })
    // It saw what the first left, not the state before it.
    expect(await second).toMatchObject({ status: 409, expected: 3 })
  })

  it('touches the upload on every piece read', async () => {
    const r = rig()
    const { token, uploadId } = await tokenFor(r, '', 'a.txt', 6)
    const touched: string[] = []
    const touch = r.uploads.touch.bind(r.uploads)
    r.uploads.touch = (id: string): void => {
      touched.push(id)
      touch(id)
    }
    await put(r, token, 0, body('ab', 'cd', 'ef'), 6)
    expect(touched).toEqual([uploadId, uploadId, uploadId])
  })
})

describe('failures', () => {
  it('ENOSPC fails the file with 507 and deletes its temp; the token is gone', async () => {
    const r = rig(fullDisk)
    const { token, uploadId } = await tokenFor(r, '', 'a.txt', 4)
    expect(await put(r, token, 0, 'abcd')).toEqual({ status: 507, error: UPLOAD_DISK_FULL_TEXT, failed: true })
    expect(tempsIn(proj)).toEqual([])
    expect(existsSync(join(proj, 'a.txt'))).toBe(false)
    expect(r.uploads.outcome(A, uploadId)?.results.get(0)).toEqual({ ok: false, reason: UPLOAD_DISK_FULL_TEXT })
    expect(await put(r, token, 0, 'abcd')).toMatchObject({ status: 404 })
    await settleRecord()
    expect(recorded()).toEqual([])
  })

  it('a folder swapped for a link before the first chunk receives nothing', async () => {
    const r = rig()
    mkdirSync(join(proj, 'sub'))
    const { token } = await tokenFor(r, 'sub', 'a.txt', 4)
    renameSync(join(proj, 'sub'), join(proj, 'sub2'))
    symlinkSync(outside, join(proj, 'sub'))
    expect(await put(r, token, 0, 'abcd')).toMatchObject({ status: 500, failed: true })
    expect(readdirSync(outside)).toEqual([])
  })

  it('a folder swapped for a link between begin and commit is refused, and the temp gives its bytes back', async () => {
    const r = rig()
    mkdirSync(join(proj, 'sub'))
    const { token } = await tokenFor(r, 'sub', 'a.txt', 8)
    expect(await put(r, token, 0, 'abcd')).toMatchObject({ status: 200 })
    renameSync(join(proj, 'sub'), join(proj, 'sub2'))
    symlinkSync(outside, join(proj, 'sub'))
    expect(await put(r, token, 4, 'efgh')).toMatchObject({ status: 500, error: 'the folder changed since the upload began', failed: true })
    expect(readdirSync(outside)).toEqual([])
    // The temp moved with its folder, where its name no longer leads: truncated through the descriptor.
    const [temp] = tempsIn(join(proj, 'sub2'))
    expect(statSync(join(proj, 'sub2', temp!)).size).toBe(0)
    expect(readdirSync(join(proj, 'sub2')).filter((n) => !n.startsWith(UPLOAD_TEMP_PREFIX))).toEqual([])
  })
})

describe('commit', () => {
  it('numbers a name that appeared since begin, never overwriting it', async () => {
    const r = rig()
    const { token } = await tokenFor(r, '', 'a.txt', 3)
    writeFileSync(join(proj, 'a.txt'), 'theirs')
    expect(await put(r, token, 0, 'new')).toEqual({ status: 200, reply: { done: true, name: 'a (1).txt', path: 'a (1).txt' } })
    expect(readFileSync(join(proj, 'a.txt'), 'utf8')).toBe('theirs')
    expect(readFileSync(join(proj, 'a (1).txt'), 'utf8')).toBe('new')
  })

  it('never follows a link at the final name, dangling or not', async () => {
    const r = rig()
    const { token } = await tokenFor(r, '', 'a.txt', 3)
    symlinkSync(join(outside, 'planted.txt'), join(proj, 'a.txt'))
    writeFileSync(join(outside, 'kept.txt'), 'kept')
    const second = await tokenFor(r, '', 'b.txt', 3)
    symlinkSync(join(outside, 'kept.txt'), join(proj, 'b.txt'))
    expect(await put(r, token, 0, 'new')).toMatchObject({ status: 200, reply: { done: true, name: 'a (1).txt' } })
    expect(await put(r, second.token, 0, 'new')).toMatchObject({ status: 200, reply: { done: true, name: 'b (1).txt' } })
    expect(existsSync(join(outside, 'planted.txt'))).toBe(false)
    expect(readFileSync(join(outside, 'kept.txt'), 'utf8')).toBe('kept')
    expect(lstatSync(join(proj, 'a.txt')).isSymbolicLink()).toBe(true)
  })

  it('copies where hard links are refused (EXDEV), exclusively, and the temp goes', async () => {
    const tried: string[] = []
    const r = rig({
      link: async (_from, to) => {
        tried.push(to)
        throw Object.assign(new Error(`EXDEV: cross-device link not permitted, link '${to}'`), { code: 'EXDEV' })
      },
    })
    const { token } = await tokenFor(r, '', 'a.txt', 3)
    writeFileSync(join(proj, 'a.txt'), 'theirs')
    expect(await put(r, token, 0, 'new')).toMatchObject({ status: 200, reply: { done: true, name: 'a (1).txt' } })
    expect(tried.map((p) => p.slice(proj.length + 1))).toEqual(['a.txt', 'a (1).txt'])
    expect(readFileSync(join(proj, 'a.txt'), 'utf8')).toBe('theirs')
    expect(readFileSync(join(proj, 'a (1).txt'), 'utf8')).toBe('new')
    expect(tempsIn(proj)).toEqual([])
  })

  it('refuses with a reason when no numbered name is free', async () => {
    const r = rig()
    const { token, uploadId } = await tokenFor(r, '', 'a.txt', 1)
    writeFileSync(join(proj, 'a.txt'), '')
    for (let n = 1; n <= 99; n++) writeFileSync(join(proj, `a (${n}).txt`), '')
    expect(await put(r, token, 0, 'x')).toMatchObject({ status: 500, failed: true })
    const outcome = r.uploads.outcome(A, uploadId)?.results.get(0)
    expect(outcome).toMatchObject({ ok: false })
    expect(outcome && !outcome.ok && outcome.reason).toContain('no free name for a.txt')
    expect(tempsIn(proj)).toEqual([])
  })

  it('Replace keeps the replaced file’s mode minus setuid, setgid and sticky', async () => {
    const r = rig()
    writeFileSync(join(proj, 'run.sh'), 'old')
    chmodSync(join(proj, 'run.sh'), 0o4755)
    const b = await begin(r, '', [{ name: 'run.sh', size: 3 }])
    expect(b.clashes).toEqual([{ index: 0, name: 'run.sh', replaceable: true }])
    const resolved = await r.uploads.resolve(A, b.uploadId, 'replace')
    if ('error' in resolved) throw new Error(resolved.error)
    expect(await put(r, resolved.tokens[0]!.token, 0, 'new')).toEqual({ status: 200, reply: { done: true, name: 'run.sh', path: 'run.sh' } })
    expect(readFileSync(join(proj, 'run.sh'), 'utf8')).toBe('new')
    expect(statSync(join(proj, 'run.sh')).mode & 0o7777).toBe(0o755)
    expect(tempsIn(proj)).toEqual([])
  })

  it('Replace is refused when the target became a folder or a link since the answer', async () => {
    const r = rig()
    writeFileSync(join(proj, 'a.txt'), 'old')
    writeFileSync(join(proj, 'b.txt'), 'old')
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    const b = await begin(r, '', [
      { name: 'a.txt', size: 3 },
      { name: 'b.txt', size: 3 },
    ])
    const resolved = await r.uploads.resolve(A, b.uploadId, 'replace')
    if ('error' in resolved) throw new Error(resolved.error)
    rmSync(join(proj, 'a.txt'))
    mkdirSync(join(proj, 'a.txt'))
    rmSync(join(proj, 'b.txt'))
    symlinkSync(join(outside, 'secret.txt'), join(proj, 'b.txt'))
    expect(await put(r, resolved.tokens[0]!.token, 0, 'new')).toMatchObject({ status: 500, error: 'a.txt changed meanwhile', failed: true })
    expect(await put(r, resolved.tokens[1]!.token, 0, 'new')).toMatchObject({ status: 500, error: 'b.txt changed meanwhile', failed: true })
    expect(statSync(join(proj, 'a.txt')).isDirectory()).toBe(true)
    expect(lstatSync(join(proj, 'b.txt')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret')
    expect(tempsIn(proj)).toEqual([])
  })

  it('Keep both commits under the numbered name resolve chose', async () => {
    const r = rig()
    writeFileSync(join(proj, 'a.txt'), 'old')
    const b = await begin(r, '', [{ name: 'a.txt', size: 3 }])
    const resolved = await r.uploads.resolve(A, b.uploadId, 'keep-both')
    if ('error' in resolved) throw new Error(resolved.error)
    expect(await put(r, resolved.tokens[0]!.token, 0, 'new')).toMatchObject({ status: 200, reply: { done: true, name: 'a (1).txt' } })
    expect(readFileSync(join(proj, 'a.txt'), 'utf8')).toBe('old')
  })
})

describe('aborts', () => {
  it('a cancel mid-chunk stops the body, deletes the temp and drops its record entry', async () => {
    const r = rig()
    const { token, uploadId } = await tokenFor(r, '', 'a.txt', 10)
    const slow = new PassThrough()
    const chunk = put(r, token, 0, slow, 10)
    slow.write('abc')
    await until(() => tempsIn(proj).length === 1)
    expect(recorded()).toHaveLength(1)
    await r.uploads.cancel(A, uploadId)
    expect(await chunk).toMatchObject({ status: 404 })
    expect(slow.destroyed).toBe(true)
    expect(tempsIn(proj)).toEqual([])
    expect(existsSync(join(proj, 'a.txt'))).toBe(false)
    await settleRecord()
    expect(recorded()).toEqual([])
  })

  it('a drop deletes the temps of every file of the upload, the ones between chunks too', async () => {
    const r = rig()
    const b = await begin(r, '', [
      { name: 'a.txt', size: 6 },
      { name: 'b.txt', size: 6 },
    ])
    await put(r, b.tokens![0]!.token, 0, 'abc')
    await put(r, b.tokens![1]!.token, 0, 'abc')
    expect(tempsIn(proj)).toHaveLength(2)
    await r.uploads.dropDevice(A.deviceId)
    expect(tempsIn(proj)).toEqual([])
    expect(await put(r, b.tokens![0]!.token, 3, 'def')).toMatchObject({ status: 404 })
  })
})

describe('the temps record and the sweep', () => {
  it('a crash mid-upload leaves a temp the next start removes', async () => {
    const r = rig()
    const { token } = await tokenFor(r, '', 'a.txt', 10)
    await put(r, token, 0, 'abcd')
    const [temp] = tempsIn(proj)
    expect(recorded()).toEqual([join(proj, temp!)])
    // The next start: a new writer over the same record, nothing live.
    const next = rig()
    expect(await next.writer.sweepTemps()).toBe(1)
    expect(tempsIn(proj)).toEqual([])
    expect(recorded()).toEqual([])
  })

  it('deletes only a regular file named as a temp, whatever a hand-edited record lists', async () => {
    writeFileSync(join(proj, 'keep.txt'), 'keep')
    mkdirSync(join(proj, '.cc-upload-0123456789abcdef'))
    writeFileSync(join(outside, 'x'), 'x')
    symlinkSync(join(outside, 'x'), join(proj, '.cc-upload-fedcba9876543210'))
    mkdirSync(join(tmp, 'data', 'uploads'), { recursive: true })
    writeFileSync(
      tempsFile,
      JSON.stringify({
        schemaVersion: 1,
        temps: [join(proj, 'keep.txt'), join(proj, '.cc-upload-0123456789abcdef'), join(proj, '.cc-upload-fedcba9876543210'), 'relative/.cc-upload-0000000000000000', 42],
      })
    )
    const r = rig()
    expect(await r.writer.sweepTemps()).toBe(0)
    expect(readFileSync(join(proj, 'keep.txt'), 'utf8')).toBe('keep')
    expect(existsSync(join(proj, '.cc-upload-0123456789abcdef'))).toBe(true)
    expect(readFileSync(join(outside, 'x'), 'utf8')).toBe('x')
    expect(recorded()).toEqual([])
  })

  it('a record that is not a list is read as empty', async () => {
    mkdirSync(join(tmp, 'data', 'uploads'), { recursive: true })
    writeFileSync(tempsFile, JSON.stringify({ schemaVersion: 1, temps: 'x' }))
    const r = rig()
    expect(await r.writer.sweepTemps()).toBe(0)
    expect(recorded()).toEqual([])
  })

  it('makes no temp when the record cannot be written', async () => {
    // A record from a newer app version is left read-only (JsonFile): no temp a sweep would not find.
    mkdirSync(join(tmp, 'data', 'uploads'), { recursive: true })
    writeFileSync(tempsFile, JSON.stringify({ schemaVersion: 99, temps: [] }))
    const r = rig()
    const { token } = await tokenFor(r, '', 'a.txt', 3)
    expect(await put(r, token, 0, 'abc')).toMatchObject({ status: 500, failed: true })
    expect(tempsIn(proj)).toEqual([])
  })
})
