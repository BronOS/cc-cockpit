// uploads.ts: begin (folder, names, caps, disk, clashes), resolve, cancel, the tokens' binding and
// ownership, the limits (None mode's `none` device included), the idle clock, the drops and the folder
// chooser's listing. Real trees in a temp dir; a recording writer stands in for upload-writer.ts and a
// fake statfs for the disk.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UPLOAD_BEGINS_MAX,
  UPLOAD_BEGINS_WINDOW_MS,
  UPLOAD_FOLDER_LIST_MAX,
  UPLOAD_FREE_MARGIN_BYTES,
  UPLOAD_IDLE_MS,
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_MAX_FILES,
  type UploadBeginReply,
  type UploadBegun,
  type UploadResolveReply,
  type UploadSource,
} from '../../src/shared/uploads'
import {
  UPLOAD_FINISHED_KEPT,
  UPLOAD_PENDING_MS,
  UPLOAD_UNKNOWN_TEXT,
  Uploads,
  type UploadCaller,
  type UploadsDeps,
} from '../../src/main/files/uploads'

let tmp: string
let proj: string
let dataDir: string
let aborted: string[]
let freeBytes: number
/** Every text a view could be shown, checked at the end of each test for the project's absolute path. */
let shown: string[]

const WINDOW = 3
const A: UploadCaller = { deviceId: 'dev-a', windowId: WINDOW }
const B: UploadCaller = { deviceId: 'dev-b', windowId: WINDOW }
const SRC: UploadSource = { panel: 'cockpit.files/tree' }

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-uploads-')))
  proj = join(tmp, 'proj')
  dataDir = join(tmp, 'data')
  mkdirSync(proj)
  mkdirSync(dataDir)
  aborted = []
  freeBytes = 100 * 1024 ** 3
  shown = []
})

afterEach(() => {
  vi.useRealTimers()
  for (const text of shown) {
    expect(text).not.toContain(proj)
    expect(text).not.toContain(tmp)
  }
  rmSync(tmp, { recursive: true, force: true })
})

function make(extra: Partial<UploadsDeps> = {}): Uploads {
  return new Uploads({
    projectRoot: (windowId) => (windowId === WINDOW || windowId === 4 ? proj : undefined),
    dataDir,
    writer: {
      abortUpload: async (id) => {
        aborted.push(id)
      },
    },
    statfs: async () => ({ bavail: freeBytes, bsize: 1 }),
    platform: 'linux',
    ...extra,
  })
}

function files(...names: string[]): Array<{ name: string; size: number }> {
  return names.map((name) => ({ name, size: 10 }))
}

/** Records every text the answer carries (for the no-host-path check) and hands the answer back. */
function seen<T extends UploadBeginReply | UploadResolveReply | { error: string } | object>(reply: T): T {
  if ('error' in reply && typeof reply.error === 'string') shown.push(reply.error)
  if ('refused' in reply && Array.isArray(reply.refused)) for (const r of reply.refused as Array<{ reason: string }>) shown.push(r.reason)
  return reply
}

async function begin(up: Uploads, caller: UploadCaller, folder: unknown, list: unknown): Promise<UploadBeginReply> {
  return seen(await up.begin(caller, SRC, folder, list))
}

async function begun(up: Uploads, caller: UploadCaller, folder: unknown, list: unknown): Promise<UploadBegun> {
  const reply = await begin(up, caller, folder, list)
  if ('error' in reply) throw new Error(`refused: ${reply.error}`)
  return reply
}

async function refusal(up: Uploads, folder: unknown, list: unknown = files('a.txt')): Promise<string> {
  const reply = await begin(up, A, folder, list)
  if (!('error' in reply)) throw new Error('expected a refusal')
  return reply.error
}

describe('begin: the folder', () => {
  it('takes the project folder and a subfolder, and answers tokens when nothing clashes', async () => {
    mkdirSync(join(proj, 'sub'))
    const up = make()
    const root = await begun(up, A, '', files('a.txt', 'b.txt'))
    expect(root.refused).toEqual([])
    expect(root.clashes).toEqual([])
    expect(root.tokens?.map((t) => [t.index, t.name])).toEqual([
      [0, 'a.txt'],
      [1, 'b.txt'],
    ])
    const sub = await begun(up, B, 'sub', files('c.txt'))
    const grant = up.grant(sub.tokens![0]!.token)
    expect(grant).toMatchObject({
      uploadId: sub.uploadId,
      deviceId: 'dev-b',
      windowId: WINDOW,
      index: 0,
      folderReal: join(proj, 'sub'),
      folderRel: 'sub',
      name: 'c.txt',
      choice: 'new',
      size: 10,
    })
    // 32 random bytes base64url.
    expect(Buffer.from(sub.tokens![0]!.token, 'base64url')).toHaveLength(32)
  })

  it('refuses what is outside the project: .., an absolute path, a link out', async () => {
    const outside = join(tmp, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(proj, 'out'))
    const up = make()
    expect(await refusal(up, '../outside')).toMatch(/\.\./)
    expect(await refusal(up, outside)).toMatch(/relative/)
    expect(await refusal(up, 'out')).toMatch(/outside the project/)
    expect(await refusal(up, 'missing')).toMatch(/no such file or folder: missing/)
    expect(await refusal(up, 42)).toMatch(/path/)
  })

  it('refuses .git and below, a link to .git/hooks, and .GIT on darwin only', async () => {
    mkdirSync(join(proj, '.git', 'hooks'), { recursive: true })
    mkdirSync(join(proj, 'sub', '.git', 'hooks'), { recursive: true })
    mkdirSync(join(proj, '.github'))
    symlinkSync(join(proj, '.git', 'hooks'), join(proj, 'hooks-link'))
    const up = make()
    for (const folder of ['.git', '.git/hooks', 'sub/.git/hooks', 'hooks-link']) {
      expect(await refusal(up, folder)).toMatch(/is in \.git/)
    }
    expect('tokens' in (await begun(up, A, '.github', files('ci.yml')))).toBe(true)

    // `.GIT` exists as its own folder here (on a case-insensitive disk it is `.git` itself).
    const caseDir = join(tmp, 'case-proj')
    mkdirSync(join(caseDir, '.GIT', 'hooks'), { recursive: true })
    const darwin = make({ platform: 'darwin', projectRoot: () => caseDir })
    expect(seen(await darwin.begin(B, SRC, '.GIT/hooks', files('x')))).toMatchObject({ error: expect.stringMatching(/\.git/) })
    const linux = make({ projectRoot: () => caseDir })
    expect('tokens' in seen(await linux.begin(B, SRC, '.GIT/hooks', files('x')))).toBe(true)
  })

  it('refuses the data dir inside the project, and a file named as the folder', async () => {
    const inner = join(proj, 'appdata')
    mkdirSync(join(inner, 'sub'), { recursive: true })
    writeFileSync(join(proj, 'notes.txt'), 'x')
    const up = make({ dataDir: inner })
    expect(await refusal(up, 'appdata')).toMatch(/data folder/)
    expect(await refusal(up, 'appdata/sub')).toMatch(/data folder/)
    expect(await refusal(up, 'notes.txt')).toMatch(/not a folder/)
  })

  it('refuses when the window has no project', async () => {
    const up = make()
    expect(seen(await up.begin({ deviceId: 'dev-a', windowId: 99 }, SRC, '', files('a')))).toEqual({ error: 'the project is not open' })
  })
})

describe('begin: names, caps and the disk', () => {
  it('skips each refused name with its reason and numbers repeats within the upload', async () => {
    const up = make()
    const reply = await begun(up, A, '', [
      { name: 'ok.txt', size: 1 },
      { name: '..', size: 1 },
      { name: 'a/b', size: 1 },
      { name: 'evil‮txt.exe', size: 1 },
      { name: 'Ok.TXT', size: 1 },
      { name: '.env', size: 1 },
      { name: 7, size: 1 },
    ])
    expect(reply.refused.map((r) => r.index)).toEqual([1, 2, 3, 6])
    expect(reply.tokens?.map((t) => [t.index, t.name])).toEqual([
      [0, 'ok.txt'],
      [4, 'Ok (1).TXT'],
      [5, '.env'],
    ])
  })

  it('answers begun with no tokens when every file is refused, holding no place', async () => {
    const up = make()
    const reply = await begun(up, A, '', [{ name: '', size: 1 }])
    expect(reply.tokens).toEqual([])
    expect(reply.refused).toHaveLength(1)
    // Places are free: two more begin.
    await begun(up, A, '', files('a'))
    await begun(up, A, '', files('b'))
  })

  it('refuses the whole upload for a file over 2 GiB, more than 100 files, none, and a bad shape', async () => {
    const up = make()
    expect(await refusal(up, '', [{ name: 'big.iso', size: UPLOAD_MAX_FILE_BYTES + 1 }])).toMatch(/big\.iso is larger than/)
    expect('tokens' in (await begun(up, A, '', [{ name: 'edge.iso', size: UPLOAD_MAX_FILE_BYTES }]))).toBe(true)
    const many = Array.from({ length: UPLOAD_MAX_FILES + 1 }, (_, i) => ({ name: `f${i}`, size: 1 }))
    expect(await refusal(up, '', many)).toMatch(/at most 100 files/)
    expect(await refusal(up, '', [])).toMatch(/no files/)
    expect(await refusal(up, '', 'x')).toMatch(/not valid/)
    expect(await refusal(up, '', [{ name: 'a', size: -1 }])).toMatch(/not valid/)
    expect(await refusal(up, '', [{ name: 'a', size: 1.5 }])).toMatch(/not valid/)
    expect(await refusal(up, '', [null])).toMatch(/not valid/)
  })

  it('refuses when the disk would keep less than the margin free, and when statfs fails', async () => {
    freeBytes = UPLOAD_FREE_MARGIN_BYTES + 19
    const up = make()
    expect(await refusal(up, '', files('a', 'b'))).toMatch(/disk has .* free/)
    freeBytes = UPLOAD_FREE_MARGIN_BYTES + 20
    expect('tokens' in (await begun(up, A, '', files('a', 'b')))).toBe(true)
    const broken = make({ statfs: async () => Promise.reject(new Error(`ENOENT: ${proj}`)) })
    expect(await refusal(broken, '')).toBe("the server's free disk space cannot be read")
  })
})

describe('clashes and resolve', () => {
  it('finds clashes by lstat: a regular file is replaceable, a folder and a link are not', async () => {
    writeFileSync(join(proj, 'a.txt'), 'old')
    mkdirSync(join(proj, 'dir'))
    symlinkSync(join(proj, 'a.txt'), join(proj, 'link'))
    symlinkSync(join(proj, 'gone'), join(proj, 'dangling'))
    const up = make()
    const reply = await begun(up, A, '', files('a.txt', 'dir', 'link', 'dangling', 'new.txt'))
    expect(reply.tokens).toBeUndefined()
    expect(reply.clashes).toEqual([
      { index: 0, name: 'a.txt', replaceable: true },
      { index: 1, name: 'dir', replaceable: false },
      { index: 2, name: 'link', replaceable: false },
      { index: 3, name: 'dangling', replaceable: false },
    ])
  })

  it('clashes case-insensitively on a case-insensitive disk (macOS)', async () => {
    writeFileSync(join(proj, 'README.md'), 'x')
    if (!existsSync(join(proj, 'readme.md'))) return // a case-sensitive disk: nothing to show here
    const up = make({ platform: 'darwin' })
    const reply = await begun(up, A, '', files('Readme.md'))
    expect(reply.clashes).toEqual([{ index: 0, name: 'Readme.md', replaceable: true }])
  })

  it('replace mints tokens with the replace choice for the clashes only', async () => {
    writeFileSync(join(proj, 'a.txt'), 'old')
    const up = make()
    const reply = await begun(up, A, '', files('a.txt', 'b.txt'))
    const resolved = seen(await up.resolve(A, reply.uploadId, 'replace'))
    if ('error' in resolved) throw new Error(resolved.error)
    expect(resolved.refused).toEqual([])
    expect(resolved.tokens.map((t) => [t.index, t.name, up.grant(t.token)?.choice])).toEqual([
      [0, 'a.txt', 'replace'],
      [1, 'b.txt', 'new'],
    ])
    // Answered once: a second answer is unknown.
    expect(seen(await up.resolve(A, reply.uploadId, 'keep-both'))).toEqual({ error: UPLOAD_UNKNOWN_TEXT })
  })

  it('refuses replace when a clash is not a regular file and stays pending for keep-both', async () => {
    writeFileSync(join(proj, 'a.txt'), 'old')
    writeFileSync(join(proj, 'a (1).txt'), 'older')
    mkdirSync(join(proj, 'dir'))
    const up = make()
    const reply = await begun(up, A, '', files('a.txt', 'dir', 'a (2).txt'))
    expect(seen(await up.resolve(A, reply.uploadId, 'replace'))).toEqual({ error: expect.stringMatching(/regular file/) })
    const resolved = seen(await up.resolve(A, reply.uploadId, 'keep-both'))
    if ('error' in resolved) throw new Error(resolved.error)
    // `a (1).txt` is on disk and `a (2).txt` is another file of this upload: a.txt becomes `a (3).txt`.
    expect(resolved.tokens.map((t) => [t.index, t.name, up.grant(t.token)?.choice])).toEqual([
      [0, 'a (3).txt', 'keep-both'],
      [1, 'dir (1)', 'keep-both'],
      [2, 'a (2).txt', 'new'],
    ])
  })

  it('keep-both refuses a file with no free number, with its reason', async () => {
    writeFileSync(join(proj, 'n'), 'x')
    for (let i = 1; i <= 99; i++) writeFileSync(join(proj, `n (${i})`), 'x')
    const up = make()
    const reply = await begun(up, A, '', files('n', 'other'))
    const resolved = seen(await up.resolve(A, reply.uploadId, 'keep-both'))
    if ('error' in resolved) throw new Error(resolved.error)
    expect(resolved.refused).toEqual([{ index: 0, reason: expect.stringMatching(/no free name for n/) }])
    expect(resolved.tokens.map((t) => t.name)).toEqual(['other'])
  })

  it('cancel ends a pending upload; a bad answer is refused', async () => {
    writeFileSync(join(proj, 'a.txt'), 'old')
    const up = make()
    const reply = await begun(up, A, '', files('a.txt'))
    expect(seen(await up.resolve(A, reply.uploadId, 'overwrite'))).toEqual({ error: 'the answer is not valid' })
    expect(await up.resolve(A, reply.uploadId, 'cancel')).toEqual({ tokens: [], refused: [] })
    expect(await up.resolve(A, reply.uploadId, 'replace')).toEqual({ error: UPLOAD_UNKNOWN_TEXT })
  })

  it('a pending upload nobody answers ends after UPLOAD_PENDING_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    writeFileSync(join(proj, 'a.txt'), 'old')
    const up = make()
    const reply = await begun(up, A, '', files('a.txt'))
    await vi.advanceTimersByTimeAsync(UPLOAD_PENDING_MS + 1)
    expect(await up.resolve(A, reply.uploadId, 'replace')).toEqual({ error: UPLOAD_UNKNOWN_TEXT })
  })
})

describe('ownership', () => {
  it('another device gets the same answer as an unknown id, and changes nothing', async () => {
    writeFileSync(join(proj, 'a.txt'), 'old')
    const up = make()
    const pending = await begun(up, A, '', files('a.txt'))
    const running = await begun(up, A, '', files('b.txt'))
    expect(await up.resolve(B, pending.uploadId, 'replace')).toEqual({ error: UPLOAD_UNKNOWN_TEXT })
    expect(await up.resolve(A, 'nope', 'replace')).toEqual({ error: UPLOAD_UNKNOWN_TEXT })
    expect(await up.resolve(A, 5, 'replace')).toEqual({ error: UPLOAD_UNKNOWN_TEXT })
    await up.cancel(B, running.uploadId)
    expect(up.grant(running.tokens![0]!.token)).toBeDefined()
    expect(aborted).toEqual([])
    expect(up.outcome(B, running.uploadId)).toBeUndefined()
    // The beginning device still owns both.
    expect('tokens' in (await up.resolve(A, pending.uploadId, 'replace'))).toBe(true)
    await up.cancel(A, running.uploadId)
    expect(up.grant(running.tokens![0]!.token)).toBeUndefined()
    expect(aborted).toEqual([running.uploadId])
  })
})

describe('limits', () => {
  it('2 at once per device, 6 app-wide; a settled upload frees its place', async () => {
    const up = make()
    const first = await begun(up, A, '', files('a'))
    await begun(up, A, '', files('b'))
    expect(await refusal(up, '', files('c'))).toMatch(/2 uploads are already running from this device/)
    up.settle(first.tokens![0]!.token, { ok: true, name: 'a', path: 'a' })
    await begun(up, A, '', files('c'))
    for (const d of ['d1', 'd2']) {
      await begun(up, { deviceId: d, windowId: WINDOW }, '', files('x'))
      await begun(up, { deviceId: d, windowId: WINDOW }, '', files('y'))
    }
    expect(seen(await up.begin({ deviceId: 'd3', windowId: WINDOW }, SRC, '', files('z')))).toEqual({
      error: expect.stringMatching(/already running 6 uploads/),
    })
  })

  it('parallel begins cannot all pass the place check', async () => {
    const up = make()
    const replies = await Promise.all([1, 2, 3].map((i) => begin(up, A, '', files(`f${i}`))))
    expect(replies.filter((r) => 'tokens' in r)).toHaveLength(2)
    expect(replies.filter((r) => 'error' in r)).toHaveLength(1)
  })

  it('a pending upload holds no place; resolve takes one or refuses and stays pending', async () => {
    writeFileSync(join(proj, 'a.txt'), 'old')
    const up = make()
    const pending = await begun(up, A, '', files('a.txt'))
    await begun(up, A, '', files('b'))
    await begun(up, A, '', files('c'))
    expect(seen(await up.resolve(A, pending.uploadId, 'replace'))).toEqual({ error: expect.stringMatching(/already running/) })
    await up.dropWindow(4) // another window: nothing of this one ends
    expect(await up.cancel(A, pending.uploadId)).toBeUndefined()
  })

  it(`${UPLOAD_BEGINS_MAX} begins per ${UPLOAD_BEGINS_WINDOW_MS / 60_000} min per device`, async () => {
    let now = 1_000_000
    const up = make({ now: () => now })
    for (let i = 0; i < UPLOAD_BEGINS_MAX; i++) {
      const reply = await begun(up, A, '', files(`f${i}`))
      await up.cancel(A, reply.uploadId)
    }
    expect(await refusal(up, '')).toMatch(/at most 20 uploads may start/)
    // Another device has its own budget.
    expect('tokens' in (await begin(up, B, '', files('x')))).toBe(true)
    now += UPLOAD_BEGINS_WINDOW_MS
    expect('tokens' in (await begin(up, A, '', files('x')))).toBe(true)
  })

  it('None mode: every view is the device none, so its limits and ownership are shared', async () => {
    const up = make()
    const viewOne: UploadCaller = { deviceId: 'none', windowId: WINDOW }
    const viewTwo: UploadCaller = { deviceId: 'none', windowId: 4 }
    const first = await begun(up, viewOne, '', files('a'))
    await begun(up, viewTwo, '', files('b'))
    expect(seen(await up.begin(viewTwo, SRC, '', files('c')))).toEqual({ error: expect.stringMatching(/from this device/) })
    // Another None-mode view (a new view id, another window) is the same device: it may cancel.
    await up.cancel(viewTwo, first.uploadId)
    expect(aborted).toEqual([first.uploadId])
    await up.dropDevice('none')
    expect('tokens' in (await begin(up, viewOne, '', files('d')))).toBe(true)
  })
})

describe('the idle clock', () => {
  it('a 100-file upload whose later files wait past 60 s still completes while bytes flow', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const up = make()
    const reply = await begun(up, A, '', Array.from({ length: 100 }, (_, i) => ({ name: `f${i}`, size: 5 })))
    const tokens = reply.tokens!
    // One file every 3 s with a byte every second: 300 s in all, never 60 s of silence.
    for (const t of tokens) {
      for (let s = 0; s < 3; s++) {
        await vi.advanceTimersByTimeAsync(1_000)
        up.touch(reply.uploadId)
      }
      expect(up.grant(t.token)).toBeDefined()
      up.settle(t.token, { ok: true, name: t.name, path: t.name })
    }
    expect(aborted).toEqual([])
    const outcome = up.outcome(A, reply.uploadId)
    expect(outcome?.state).toBe('finished')
    expect(outcome?.results.size).toBe(100)
    expect(outcome?.source).toEqual(SRC)
  })

  it('silence for UPLOAD_IDLE_MS ends it and deletes its temps; a slow chunk that keeps sending does not', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const log: string[] = []
    const up = make({ log: (l) => log.push(l) })
    const reply = await begun(up, A, '', files('a', 'b'))
    await vi.advanceTimersByTimeAsync(UPLOAD_IDLE_MS - 1_000)
    up.touch(reply.uploadId)
    await vi.advanceTimersByTimeAsync(UPLOAD_IDLE_MS - 1_000)
    expect(aborted).toEqual([])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(aborted).toEqual([reply.uploadId])
    expect(up.grant(reply.tokens![0]!.token)).toBeUndefined()
    expect(up.outcome(A, reply.uploadId)).toBeUndefined()
    expect(log).toHaveLength(1)
    // Its place is free again.
    await begun(up, A, '', files('c'))
    await begun(up, A, '', files('d'))
  })
})

describe('drops', () => {
  async function three(up: Uploads): Promise<UploadBegun[]> {
    return [
      await begun(up, A, '', files('a')),
      await begun(up, B, '', files('b')),
      await begun(up, { deviceId: 'dev-c', windowId: 4 }, '', files('c')),
    ]
  }

  it('dropDevice ends that device only', async () => {
    const up = make()
    const [a, b] = await three(up)
    await up.dropDevice('dev-a')
    expect(aborted).toEqual([a!.uploadId])
    expect(up.grant(a!.tokens![0]!.token)).toBeUndefined()
    expect(up.grant(b!.tokens![0]!.token)).toBeDefined()
  })

  it('dropWindow ends that window only, dropAll every one', async () => {
    const up = make()
    const [a, b, c] = await three(up)
    await up.dropWindow(4)
    expect(aborted).toEqual([c!.uploadId])
    await up.dropAll()
    expect(aborted.sort()).toEqual([a!.uploadId, b!.uploadId, c!.uploadId].sort())
  })

  it('a drop removes pending and finished uploads too, and a pending one asks the writer nothing', async () => {
    writeFileSync(join(proj, 'x'), 'old')
    const up = make()
    const pending = await begun(up, A, '', files('x'))
    const done = await begun(up, A, '', files('y'))
    up.settle(done.tokens![0]!.token, { ok: true, name: 'y', path: 'y' })
    await up.dropDevice('dev-a')
    expect(aborted).toEqual([])
    expect(up.outcome(A, done.uploadId)).toBeUndefined()
    expect(await up.resolve(A, pending.uploadId, 'replace')).toEqual({ error: UPLOAD_UNKNOWN_TEXT })
  })

  it('a drop while a begin is still checking keeps nothing for it', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const up = make({
      statfs: async () => {
        await gate
        return { bavail: freeBytes, bsize: 1 }
      },
    })
    const pendingBegin = up.begin(A, SRC, '', files('a'))
    await new Promise((r) => setTimeout(r, 20))
    await up.dropDevice('dev-a')
    release()
    expect(seen(await pendingBegin)).toEqual({ error: 'the upload was ended' })
  })

  it('keeps only the last UPLOAD_FINISHED_KEPT finished uploads of a device', async () => {
    const own: string[] = []
    let now = 1
    const one = make({ now: () => now })
    for (let i = 0; i < UPLOAD_FINISHED_KEPT + 2; i++) {
      now += UPLOAD_BEGINS_WINDOW_MS // past the begins budget
      const reply = await begun(one, A, '', files('a'))
      one.settle(reply.tokens![0]!.token, { ok: true, name: 'a', path: 'a' })
      own.push(reply.uploadId)
    }
    expect(one.outcome(A, own[0])).toBeUndefined()
    expect(one.outcome(A, own[1])).toBeUndefined()
    expect(one.outcome(A, own[2])?.state).toBe('finished')
  })
})

describe('folders', () => {
  it('lists subfolders only, sorted, without .git, the data dir or links', async () => {
    for (const d of ['src', 'Docs', '.github', '.git', 'appdata', 'b']) mkdirSync(join(proj, d))
    writeFileSync(join(proj, 'file.txt'), 'x')
    symlinkSync(join(proj, 'src'), join(proj, 'src-link'))
    const up = make({ dataDir: join(proj, 'appdata') })
    expect(await up.folders(WINDOW, '')).toEqual({ folders: ['.github', 'Docs', 'b', 'src'], more: false })
    expect(await up.folders(WINDOW, 'src')).toEqual({ folders: [], more: false })
  })

  it('drops .GIT on darwin only', async () => {
    mkdirSync(join(proj, '.GIT'))
    expect(await make({ platform: 'darwin' }).folders(WINDOW, '')).toEqual({ folders: [], more: false })
    expect(await make().folders(WINDOW, '')).toEqual({ folders: ['.GIT'], more: false })
  })

  it(`cuts at ${UPLOAD_FOLDER_LIST_MAX} with more`, async () => {
    for (let i = 0; i < UPLOAD_FOLDER_LIST_MAX + 3; i++) mkdirSync(join(proj, `d${String(i).padStart(4, '0')}`))
    const reply = await make().folders(WINDOW, '')
    if ('error' in reply) throw new Error(reply.error)
    expect(reply.folders).toHaveLength(UPLOAD_FOLDER_LIST_MAX)
    expect(reply.folders[0]).toBe('d0000')
    expect(reply.more).toBe(true)
  })

  it('refuses a path as begin refuses its folder', async () => {
    mkdirSync(join(proj, '.git'))
    writeFileSync(join(proj, 'f'), 'x')
    const up = make()
    for (const path of ['..', '.git', 'f', 'missing']) {
      const reply = seen(await up.folders(WINDOW, path))
      expect(reply).toHaveProperty('error')
    }
    expect(seen(await up.folders(99, ''))).toEqual({ error: 'the project is not open' })
  })
})
