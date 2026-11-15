// downloads.ts: which paths may go (inside, outside, the data dir, zip roots), the one-use tokens and
// what a GET re-checks, and the live responses (exact file bytes, zips, the limits, drops, cuts).
// Real trees in a temp dir; a Writable that records the head and can hold its writes stands in for
// http's ServerResponse (the gateway's own tests drive a real one, Task 6).
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOWNLOAD_TOKEN_MS, downloadSizeText, type DownloadFailed, type DownloadStart } from '../../src/shared/downloads'
import {
  DOWNLOAD_DESKTOP_TEXT,
  Downloads,
  type DownloadsDeps,
  type DownloadTarget,
  type DownloadView,
  type ServeResult,
} from '../../src/main/files/downloads'
import { readZip } from '../fakes/zip-reader'

let tmp: string
let proj: string
let home: string
let dataDir: string
let out: string
let clock: number
let starts: Array<{ viewId: string; payload: DownloadStart }>
let failures: Array<{ viewId: string; payload: DownloadFailed }>
let viewAlive: boolean

const WINDOW = 7
const VIEW: DownloadView = { viewId: 'web:1', windowId: WINDOW, deviceId: 'dev-a' }

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-downloads-')))
  proj = join(tmp, 'proj')
  home = join(tmp, 'home')
  dataDir = join(tmp, 'data')
  out = join(tmp, 'out')
  for (const d of [proj, home, dataDir, out]) mkdirSync(d)
  clock = 1_000_000
  starts = []
  failures = []
  viewAlive = true
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function make(extra: Partial<DownloadsDeps> = {}): Downloads {
  return new Downloads({
    hooks: {
      start: (viewId, payload) => {
        if (!viewAlive) return false
        starts.push({ viewId, payload })
        return true
      },
      failed: (viewId, payload) => failures.push({ viewId, payload }),
    },
    projectPath: (id) => (id === 'p1' ? proj : undefined),
    windowOf: (id) => (id === 'p1' ? WINDOW : undefined),
    dataDir,
    env: { home, platform: 'linux' },
    now: () => clock,
    ...extra,
  })
}

function write(abs: string, data: string | Buffer = 'x'): void {
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, data)
}

const rel = (p: string): DownloadTarget => ({ projectId: 'p1', rel: p })
const abs = (p: string): DownloadTarget => ({ projectId: 'p1', abs: p })

/** A ServerResponse stand-in: records the head and the bytes; `hold` keeps each write unacknowledged until `release`. */
class FakeRes extends Writable {
  status: number | undefined
  headers: Record<string, string> | undefined
  readonly chunks: Buffer[] = []
  private held: boolean
  private pending: Array<() => void> = []

  constructor(opts: { hold?: boolean } = {}) {
    super({ highWaterMark: 16 * 1024 })
    this.held = opts.hold === true
  }

  writeHead(status: number, headers: Record<string, string>): this {
    this.status = status
    this.headers = headers
    return this
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(chunk)
    if (this.held) this.pending.push(() => cb())
    else cb()
  }

  release(): void {
    this.held = false
    for (const cb of this.pending.splice(0)) cb()
  }

  get body(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

const HEADERS = (name: string): Record<string, string> => ({ 'Content-Type': 'application/octet-stream', 'X-Name': name })

/** The token of the last `downloads.start`. */
function lastToken(): string {
  const url = starts.at(-1)?.payload.url ?? ''
  expect(url).toMatch(/^\/d\/[A-Za-z0-9_-]{43}$/)
  return url.slice(3)
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setTimeout(r, 1))
  expect(cond()).toBe(true)
}

async function get(d: Downloads, token = lastToken(), device = VIEW.deviceId, res = new FakeRes()): Promise<{ result: ServeResult; res: FakeRes }> {
  const result = await d.serve(token, device, res, HEADERS)
  return { result, res }
}

describe('start: which paths', () => {
  it('sends a project file to the asking view alone, as itself, with exact bytes and its length', async () => {
    write(join(proj, 'docs/report.pdf'), 'hello world')
    const d = make()
    const started = await d.start(VIEW, rel('docs/report.pdf'), false)
    expect(started).toMatchObject({ name: 'report.pdf', kind: 'file' })
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({ viewId: 'web:1', payload: { requestId: started.requestId, name: 'report.pdf' } })
    const { result, res } = await get(d)
    expect(result).toEqual({ status: 'sent', deviceId: 'dev-a', name: 'report.pdf', bytes: 11, completed: true })
    expect(res.status).toBe(200)
    expect(res.headers).toEqual({ 'Content-Type': 'application/octet-stream', 'X-Name': 'report.pdf', 'Content-Length': '11' })
    expect(res.body.toString()).toBe('hello world')
    expect(d.tokenCount).toBe(0)
  })

  it('allows dot files inside the project', async () => {
    write(join(proj, '.env'), 'SECRET=1')
    const d = make()
    await d.start(VIEW, rel('.env'), false)
    expect((await get(d)).res.body.toString()).toBe('SECRET=1')
  })

  it('refuses `..`, absolute plugin paths and dangling links', async () => {
    write(join(tmp, 'x'))
    symlinkSync(join(proj, 'nowhere'), join(proj, 'dangling'))
    const d = make()
    await expect(d.start(VIEW, rel('../x'), false)).rejects.toThrow('".." segments')
    await expect(d.start(VIEW, rel(join(tmp, 'x')), false)).rejects.toThrow('relative to the project folder')
    await expect(d.start(VIEW, rel('dangling'), false)).rejects.toThrow('no such file or folder: dangling')
    await expect(d.start(VIEW, abs(join(proj, 'dangling')), false)).rejects.toThrow('no such file or folder')
    expect(starts).toEqual([])
  })

  it('downloads a link inside under its own name with its target`s bytes; a plugin link out is refused', async () => {
    write(join(proj, 'real.txt'), 'target bytes')
    symlinkSync('real.txt', join(proj, 'alias.md'))
    write(join(out, 'f.txt'), 'outside')
    symlinkSync(join(out, 'f.txt'), join(proj, 'out-link'))
    const d = make()
    await d.start(VIEW, rel('alias.md'), false)
    expect(starts[0]?.payload.name).toBe('alias.md')
    expect((await get(d)).res.body.toString()).toBe('target bytes')
    await expect(d.start(VIEW, rel('out-link'), false)).rejects.toThrow('resolves outside the project folder')
  })

  it.skipIf(process.platform === 'win32')('refuses a FIFO', async () => {
    expect(spawnSync('mkfifo', [join(proj, 'fifo')]).status).toBe(0)
    const d = make()
    await expect(d.start(VIEW, rel('fifo'), false)).rejects.toThrow('fifo is not a file or folder')
  })

  it('zips the project folder under its name, leaving out the data dir inside it', async () => {
    write(join(proj, 'a.txt'), 'aaa')
    write(join(proj, 'sub/b.txt'), 'bb')
    write(join(proj, '.git/HEAD'), 'ref')
    const inner = join(proj, 'appdata')
    write(join(inner, 'secret.key'), 'k')
    const d = make({ dataDir: inner })
    const started = await d.start(VIEW, rel(''), false)
    expect(started).toMatchObject({ name: 'proj.zip', kind: 'folder' })
    const { result, res } = await get(d)
    expect(result).toMatchObject({ status: 'sent', completed: true })
    expect(res.headers?.['Content-Length']).toBeUndefined()
    const entries = readZip(res.body)
    expect(entries.map((e) => e.name)).toEqual(['proj/', 'proj/a.txt', 'proj/sub/', 'proj/sub/b.txt'])
    expect(entries.find((e) => e.name === 'proj/a.txt')?.data.toString()).toBe('aaa')
    // The include choice walks into .git (the data dir is still left out).
    await d.start(VIEW, rel(''), true)
    expect(readZip((await get(d)).res.body).map((e) => e.name)).toContain('proj/.git/HEAD')
    // And the data dir named directly is refused.
    await expect(d.start(VIEW, rel('appdata/secret.key'), false)).rejects.toThrow("in the app's data folder")
  })

  it('refuses the desktop page, a gone window and a view that went away', async () => {
    write(join(proj, 'f'))
    const d = make()
    await expect(d.start({ ...VIEW, viewId: 'desktop:7' }, rel('f'), false)).rejects.toThrow(DOWNLOAD_DESKTOP_TEXT)
    await expect(d.start({ ...VIEW, windowId: 8 }, rel('f'), false)).rejects.toThrow('the project window is gone')
    viewAlive = false
    await expect(d.start(VIEW, rel('f'), false)).rejects.toThrow('the browser view is gone')
    expect(d.tokenCount).toBe(0)
  })

  it('outside (the CLI): /tmp allowed; the home`s dot folders, /proc and the data dir refused', async () => {
    write(join(out, 'build.tgz'), 'tgz')
    write(join(home, '.ssh/id_ed25519'), 'key')
    write(join(home, '.config/x'), 'cfg')
    write(join(dataDir, 'secret.key'), 'k')
    const d = make()
    const resolved = await d.resolve(abs(join(out, 'build.tgz')), WINDOW)
    expect(resolved).toMatchObject({ kind: 'file', outside: true, named: join(out, 'build.tgz'), size: 3 })
    await d.start(VIEW, abs(join(out, 'build.tgz')), false)
    expect((await get(d)).res.body.toString()).toBe('tgz')
    await expect(d.start(VIEW, abs(join(home, '.ssh/id_ed25519')), false)).rejects.toThrow('protected place')
    await expect(d.start(VIEW, abs(join(home, '.config/x')), false)).rejects.toThrow('protected place')
    await expect(d.start(VIEW, abs(join(dataDir, 'secret.key')), false)).rejects.toThrow("in the app's data folder")
    await expect(d.start(VIEW, abs(dataDir), false)).rejects.toThrow("in the app's data folder")
    await expect(d.start(VIEW, abs('relative/x'), false)).rejects.toThrow('must be absolute')
  })

  it.skipIf(!existsSync('/proc/version'))('outside: /proc is refused', async () => {
    const d = make()
    await expect(d.start(VIEW, abs('/proc/version'), false)).rejects.toThrow('protected place')
  })

  it('outside: a /tmp link to ~/.ssh is refused by its target', async () => {
    write(join(home, '.ssh/id_ed25519'), 'key')
    symlinkSync(join(home, '.ssh/id_ed25519'), join(out, 'innocent.txt'))
    const d = make()
    await expect(d.start(VIEW, abs(join(out, 'innocent.txt')), false)).rejects.toThrow('protected place')
  })

  it('outside: the rule also holds against the home`s real path (a home reached through a link)', async () => {
    const realHome = join(tmp, 'usr-home')
    mkdirSync(realHome)
    write(join(realHome, '.ssh/id'), 'key')
    symlinkSync(realHome, join(tmp, 'home-link'))
    symlinkSync(join(realHome, '.ssh/id'), join(out, 'x'))
    const d = make({ env: { home: join(tmp, 'home-link'), platform: 'linux' } })
    await expect(d.start(VIEW, abs(join(out, 'x')), false)).rejects.toThrow('protected place')
    await expect(d.start(VIEW, abs(realHome), false)).rejects.toThrow('as a zip')
  })

  it('refuses / and the home as zip roots (without walking them)', async () => {
    const d = make()
    await expect(d.start(VIEW, abs('/'), false)).rejects.toThrow('cannot be downloaded as a zip: name a folder in it')
    await expect(d.start(VIEW, abs(home), false)).rejects.toThrow('cannot be downloaded as a zip')
  })

  it('a CLI path inside the project is the project`s; a link in it to /tmp is outside', async () => {
    write(join(proj, 'a.txt'), 'a')
    write(join(out, 'b.txt'), 'b')
    symlinkSync(join(out, 'b.txt'), join(proj, 'b-link'))
    const d = make()
    expect(await d.resolve(abs(join(proj, 'a.txt')), WINDOW)).toMatchObject({ outside: false, named: join(proj, 'a.txt'), real: join(proj, 'a.txt') })
    expect(await d.resolve(abs(proj), WINDOW)).toMatchObject({ kind: 'folder', outside: false, name: 'proj.zip' })
    expect(await d.resolve(abs(join(proj, 'b-link')), WINDOW)).toMatchObject({
      outside: true,
      named: join(proj, 'b-link'),
      real: join(out, 'b.txt'),
      name: 'b-link',
    })
  })

  it('refuses a folder over a cap before a view gets anything, with the counts', async () => {
    write(join(proj, 'big/a'), 'x'.repeat(60))
    write(join(proj, 'big/b'), 'x'.repeat(60))
    write(join(proj, 'mods/node_modules/m'), 'x'.repeat(200))
    write(join(proj, 'mods/a'), 'x')
    const d = make({ maxBytes: 100 })
    await expect(d.start(VIEW, rel('big'), false)).rejects.toThrow('big is too large to download')
    // The plain zip fits; the include choice does not.
    await d.start(VIEW, rel('mods'), false)
    await expect(d.start(VIEW, rel('mods'), true)).rejects.toThrow('mods with .git and node_modules is too large')
    expect(starts).toHaveLength(1)
    const many = make({ maxEntries: 2 })
    await expect(many.start(VIEW, rel('big'), false)).rejects.toThrow('more than 2 files and folders')
  })
})

describe('tokens', () => {
  it('re-checks at the GET: a parent swapped for a link out is refused, the token stays live', async () => {
    write(join(proj, 'a/f.txt'), 'inside')
    write(join(out, 'a/f.txt'), 'outside')
    const d = make()
    const { requestId } = await d.start(VIEW, rel('a/f.txt'), false)
    rmSync(join(proj, 'a'), { recursive: true })
    symlinkSync(join(out, 'a'), join(proj, 'a'))
    const { result, res } = await get(d)
    expect(result).toEqual({ status: 'refused', reason: 'a/f.txt resolves outside the project folder' })
    expect(res.status).toBeUndefined()
    expect(failures).toEqual([{ viewId: 'web:1', payload: { requestId, reason: 'a/f.txt resolves outside the project folder' } }])
    expect(d.tokenCount).toBe(1)
    // Put back: the same link now works (a retry within its life).
    rmSync(join(proj, 'a'))
    write(join(proj, 'a/f.txt'), 'inside')
    expect((await get(d)).res.body.toString()).toBe('inside')
  })

  it('refuses another device`s cookie and keeps the token for the right one', async () => {
    write(join(proj, 'f'), 'ok')
    const d = make()
    await d.start(VIEW, rel('f'), false)
    const token = lastToken()
    expect((await get(d, token, 'dev-b')).result).toMatchObject({ status: 'refused', reason: 'the link belongs to another browser' })
    expect(await d.serve(token, undefined, new FakeRes(), HEADERS)).toMatchObject({ status: 'refused' })
    expect(failures).toHaveLength(2)
    expect((await get(d, token)).result).toMatchObject({ status: 'sent', completed: true })
  })

  it('takes the gateway`s rule as a predicate over the token`s device', async () => {
    write(join(proj, 'f'), 'ok')
    const d = make()
    await d.start(VIEW, rel('f'), false)
    const token = lastToken()
    const asked: string[] = []
    expect(await d.serve(token, (id) => (asked.push(id), false), new FakeRes(), HEADERS)).toMatchObject({ status: 'refused', reason: 'the link belongs to another browser' })
    expect(asked).toEqual(['dev-a'])
    expect(await d.serve(token, (id) => id === 'dev-a', new FakeRes(), HEADERS)).toMatchObject({ status: 'sent', completed: true })
  })

  it('refuse tells a live token`s view and keeps the token; an unknown token tells nobody', async () => {
    write(join(proj, 'f'), 'ok')
    const d = make()
    const { requestId } = await d.start(VIEW, rel('f'), false)
    d.refuse(lastToken(), 'the link was opened from another site')
    d.refuse('unknown', 'x')
    expect(failures).toEqual([{ viewId: 'web:1', payload: { requestId, reason: 'the link was opened from another site' } }])
    expect(d.tokenCount).toBe(1)
    clock += DOWNLOAD_TOKEN_MS
    d.refuse(lastToken(), 'late')
    expect(failures).toHaveLength(1)
  })

  it('is used once and expires after its life', async () => {
    write(join(proj, 'f'), 'ok')
    const d = make()
    await d.start(VIEW, rel('f'), false)
    const token = lastToken()
    await get(d, token)
    expect((await get(d, token)).result).toEqual({ status: 'refused', reason: 'unknown or expired link' })
    await d.start(VIEW, rel('f'), false)
    clock += DOWNLOAD_TOKEN_MS
    expect((await get(d)).result).toEqual({ status: 'refused', reason: 'unknown or expired link' })
    // An unknown token names no view: nothing is told.
    expect(failures).toEqual([])
    expect((await get(d, 'nonsense')).result.status).toBe('refused')
  })

  it('gives a token to one of two GETs racing for it', async () => {
    write(join(proj, 'f'), 'ok')
    const d = make()
    await d.start(VIEW, rel('f'), false)
    const token = lastToken()
    const [a, b] = await Promise.all([get(d, token), get(d, token)])
    expect([a.result.status, b.result.status].sort()).toEqual(['refused', 'sent'])
  })

  it('keeps the token when the browser went away before the head', async () => {
    write(join(proj, 'f'), 'ok')
    const d = make()
    await d.start(VIEW, rel('f'), false)
    const token = lastToken()
    const gone = new FakeRes()
    gone.destroy()
    expect(await d.serve(token, 'dev-a', gone, HEADERS)).toEqual({ status: 'refused', reason: 'the browser went away' })
    expect(gone.status).toBeUndefined()
    expect(failures).toEqual([])
    expect((await get(d, token)).result).toMatchObject({ status: 'sent', completed: true })
  })

  it('a revoke landing while the GET is still in its awaits refuses it and says nothing', async () => {
    write(join(proj, 'f'), 'ok')
    const d = make()
    await d.start(VIEW, rel('f'), false)
    const res = new FakeRes()
    const serving = d.serve(lastToken(), 'dev-a', res, HEADERS)
    d.dropDevice('dev-a')
    expect(await serving).toMatchObject({ status: 'refused' })
    expect(res.status).toBeUndefined()
    expect(failures).toEqual([])
    expect(d.tokenCount).toBe(0)
  })

  it('refuses at the GET when the project window closed after the start', async () => {
    write(join(proj, 'f'), 'ok')
    let open = true
    const d = make({ windowOf: (id) => (id === 'p1' && open ? WINDOW : undefined) })
    await d.start(VIEW, rel('f'), false)
    open = false
    const { result, res } = await get(d)
    expect(result).toEqual({ status: 'refused', reason: 'the project window is gone' })
    expect(res.status).toBeUndefined()
    expect(failures).toHaveLength(1)
  })

  it('refuses a file that became a folder', async () => {
    write(join(proj, 'f'), 'ok')
    const d = make()
    await d.start(VIEW, rel('f'), false)
    rmSync(join(proj, 'f'))
    mkdirSync(join(proj, 'f'))
    expect((await get(d)).result).toMatchObject({ status: 'refused', reason: 'f changed from a file to a folder' })
  })
})

describe('streams', () => {
  const BIG = 256 * 1024

  it('sends exactly the size at the open: a file grown meanwhile is cut there', async () => {
    write(join(proj, 'log'), randomBytes(BIG))
    const d = make()
    await d.start(VIEW, rel('log'), false)
    const res = new FakeRes({ hold: true })
    const serving = d.serve(lastToken(), 'dev-a', res, HEADERS)
    await waitFor(() => res.chunks.length > 0)
    appendFileSync(join(proj, 'log'), 'more')
    res.release()
    expect(await serving).toMatchObject({ status: 'sent', completed: true, bytes: BIG })
    expect(res.headers?.['Content-Length']).toBe(String(BIG))
    expect(res.body.length).toBe(BIG)
  })

  it('cuts a file that shrank short of its length and tells the view', async () => {
    write(join(proj, 'log'), randomBytes(BIG))
    const d = make()
    const { requestId } = await d.start(VIEW, rel('log'), false)
    const res = new FakeRes({ hold: true })
    const serving = d.serve(lastToken(), 'dev-a', res, HEADERS)
    await waitFor(() => res.chunks.length > 0)
    truncateSync(join(proj, 'log'), 10)
    res.release()
    expect(await serving).toMatchObject({ status: 'sent', completed: false, cut: 'failed' })
    expect(res.destroyed).toBe(true)
    expect(failures).toEqual([{ viewId: 'web:1', payload: { requestId, reason: 'log could not be read to the end' } }])
    expect(d.liveCount).toBe(0)
  })

  it('cuts a zip that grew past a cap after the count (no end record) and tells the view', async () => {
    write(join(proj, 'dir/a'), 'x'.repeat(40))
    const d = make({ maxBytes: 100 })
    await d.start(VIEW, rel('dir'), false)
    appendFileSync(join(proj, 'dir/a'), 'y'.repeat(100))
    const { result, res } = await get(d)
    expect(result).toMatchObject({ status: 'sent', completed: false, cut: 'failed' })
    expect(() => readZip(res.body)).toThrow()
    expect(failures[0]?.payload.reason).toMatch(/size limit/)
  })

  it('a browser that goes away is a cut, not a failure', async () => {
    write(join(proj, 'log'), randomBytes(BIG))
    const d = make()
    await d.start(VIEW, rel('log'), false)
    const res = new FakeRes({ hold: true })
    const serving = d.serve(lastToken(), 'dev-a', res, HEADERS)
    await waitFor(() => res.chunks.length > 0)
    res.destroy()
    expect(await serving).toMatchObject({ status: 'sent', completed: false, cut: 'closed' })
    expect(failures).toEqual([])
  })

  it('limits each device to two at once, and keeps the third link for later', async () => {
    for (const n of ['a', 'b', 'c']) write(join(proj, n), randomBytes(BIG))
    const d = make()
    const held: FakeRes[] = []
    const serving: Array<Promise<ServeResult>> = []
    for (const n of ['a', 'b']) {
      await d.start(VIEW, rel(n), false)
      const res = new FakeRes({ hold: true })
      held.push(res)
      serving.push(d.serve(lastToken(), 'dev-a', res, HEADERS))
    }
    await waitFor(() => d.liveCount === 2)
    await d.start(VIEW, rel('c'), false)
    const third = lastToken()
    expect((await get(d, third)).result).toMatchObject({ status: 'refused', reason: expect.stringMatching(/already has 2 downloads/) })
    // Another device is not held up by this one.
    write(join(proj, 'd'), 'd')
    await d.start({ ...VIEW, viewId: 'web:2', deviceId: 'dev-b' }, rel('d'), false)
    expect((await get(d, lastToken(), 'dev-b')).result).toMatchObject({ status: 'sent', completed: true })
    for (const r of held) r.release()
    await Promise.all(serving)
    expect((await get(d, third)).result).toMatchObject({ status: 'sent', completed: true })
  })

  it('limits zips to three at once app-wide', async () => {
    write(join(proj, 'dir/blob'), randomBytes(BIG))
    const d = make()
    const held: FakeRes[] = []
    const serving: Array<Promise<ServeResult>> = []
    for (const dev of ['d1', 'd2', 'd3']) {
      await d.start({ ...VIEW, deviceId: dev }, rel('dir'), false)
      const res = new FakeRes({ hold: true })
      held.push(res)
      serving.push(d.serve(lastToken(), dev, res, HEADERS))
    }
    await waitFor(() => d.liveCount === 3)
    await d.start({ ...VIEW, deviceId: 'd4' }, rel('dir'), false)
    expect((await get(d, lastToken(), 'd4')).result).toMatchObject({ status: 'refused', reason: expect.stringMatching(/3 folders are being zipped/) })
    // A file is not a zip: it still goes.
    write(join(proj, 'f'), 'f')
    await d.start({ ...VIEW, deviceId: 'd4' }, rel('f'), false)
    expect((await get(d, lastToken(), 'd4')).result).toMatchObject({ status: 'sent', completed: true })
    for (const r of held) r.release()
    for (const r of await Promise.all(serving)) expect(r).toMatchObject({ completed: true })
  })

  it('dropDevice ends that device`s streams mid-way and its links; dropAll ends everything', async () => {
    write(join(proj, 'log'), randomBytes(BIG))
    write(join(proj, 'dir/blob'), randomBytes(BIG))
    const d = make()
    await d.start(VIEW, rel('log'), false)
    const a = new FakeRes({ hold: true })
    const servingA = d.serve(lastToken(), 'dev-a', a, HEADERS)
    await d.start({ ...VIEW, deviceId: 'dev-b' }, rel('dir'), false)
    const b = new FakeRes({ hold: true })
    const servingB = d.serve(lastToken(), 'dev-b', b, HEADERS)
    await d.start(VIEW, rel('log'), false)
    await waitFor(() => d.liveCount === 2)
    expect(d.tokenCount).toBe(1)
    expect(d.dropDevice('dev-a')).toBe(1)
    expect(await servingA).toMatchObject({ status: 'sent', completed: false, cut: 'dropped' })
    expect(a.destroyed).toBe(true)
    expect(d.tokenCount).toBe(0)
    expect(b.destroyed).toBe(false)
    await d.start({ ...VIEW, deviceId: 'dev-b' }, rel('log'), false)
    d.dropAll()
    expect(await servingB).toMatchObject({ status: 'sent', completed: false, cut: 'dropped' })
    expect(() => readZip(b.body)).toThrow()
    expect(d.tokenCount).toBe(0)
    expect(d.liveCount).toBe(0)
    expect(failures).toEqual([])
  })
})

describe('downloadSizeText', () => {
  it('reads as browsers show sizes', () => {
    expect(downloadSizeText(0)).toBe('0 B')
    expect(downloadSizeText(999)).toBe('999 B')
    expect(downloadSizeText(2_300_000)).toBe('2.3 MB')
    expect(downloadSizeText(48_000_000)).toBe('48 MB')
    expect(downloadSizeText(999_600)).toBe('1.0 MB')
    expect(downloadSizeText(2 * 1024 ** 3)).toBe('2.1 GB')
  })
})
