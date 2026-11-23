// The terminal entry's paste rule (design-upload.md §4.3; plan Task 11): Uploads.paste writes the text into
// the tab as the calling view's own input, in the same step as its checks, and answers it, or holds it with a
// reason and writes nothing. Only for a finished upload from a tab,
// begun by the caller's device in its window; the automatic call at most once, `{text}` only when the tab
// is alive, selected in the calling view and (a Claude tab) `waiting`; Paste path (`manual`) any number of
// times in any status but `needs-permission` and `ended`. The owner gets absolute paths, a guest paths
// relative to the tab's starting folder (D-33). Real trees in a temp dir; the writer is a recorder and each
// file is settled by hand, as the writer would after its commit.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  UPLOAD_PASTE_AGAIN_TEXT,
  UPLOAD_PASTE_ENDED_TEXT,
  UPLOAD_PASTE_NO_INPUT_TEXT,
  UPLOAD_PASTE_NOT_SELECTED_TEXT,
  UPLOAD_PASTE_NOT_WAITING_TEXT,
  UPLOAD_PASTE_PERMISSION_TEXT,
  UPLOAD_PASTE_UNSAFE_TEXT,
  UPLOAD_UNKNOWN_TEXT,
  Uploads,
  type UploadCaller,
  type UploadPasteFacts,
  type UploadPasteTab
} from '../../src/main/files/uploads'
import type { TabStatus } from '../../src/shared/ipc'
import type { UploadBegun, UploadSource } from '../../src/shared/uploads'

const WINDOW = 3
const A: UploadCaller = { deviceId: 'dev-a', windowId: WINDOW }

let tmp: string
let proj: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-upload-paste-')))
  proj = join(tmp, 'my proj')
  for (const d of [proj, join(proj, 'sub'), join(proj, 'other'), join(tmp, 'data')]) mkdirSync(d)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function make(root = proj): Uploads {
  return new Uploads({
    projectRoot: (windowId) => (windowId === WINDOW || windowId === 4 ? root : undefined),
    dataDir: join(tmp, 'data'),
    writer: { abortUpload: async () => undefined },
    statfs: async () => ({ bavail: 100 * 1024 ** 3, bsize: 1 }),
    platform: 'linux'
  })
}

/**
 * A finished upload of `names` into `folder` from `source`: begun, then each file settled as the writer
 * does after its commit (`ok` false for the names in `failed`).
 */
async function finished(
  uploads: Uploads,
  names: string[],
  { source = { tab: 't1' } as UploadSource, folder = 'sub', caller = A, failed = [] as string[] } = {}
): Promise<string> {
  const begun = (await uploads.begin(caller, source, folder, names.map((name) => ({ name, size: 1 })))) as UploadBegun
  expect(begun.tokens, JSON.stringify(begun)).toHaveLength(names.length)
  for (const t of begun.tokens ?? []) {
    const path = folder === '' ? t.name : `${folder}/${t.name}`
    uploads.settle(t.token, failed.includes(t.name) ? { ok: false, reason: 'the disk is full' } : { ok: true, name: t.name, path })
  }
  return begun.uploadId
}

/**
 * The source tab `t1`, a Claude tab `waiting` in the project folder and selected, unless told otherwise; the
 * view's input taken (and recorded in `written` when given) unless `input` says otherwise.
 */
function facts(
  over: {
    tab?: Partial<UploadPasteTab> | null
    selected?: string | undefined
    guest?: boolean
    status?: TabStatus
    bracketed?: boolean
    input?: (tabId: string, data: string) => boolean
    written?: Array<[string, string]>
  } = {}
): UploadPasteFacts {
  const tab: UploadPasteTab | undefined =
    over.tab === null ? undefined : { kind: 'claude', cwd: proj, exited: false, status: over.status ?? 'waiting', ...over.tab }
  return {
    tab: (id) => (id === 't1' ? tab : undefined),
    selected: 'selected' in over ? over.selected : 't1',
    guest: over.guest ?? false,
    bracketed: 'bracketed' in over ? over.bracketed : false,
    input:
      over.input ??
      ((tabId, data) => {
        over.written?.push([tabId, data])
        return true
      })
  }
}

describe('Uploads.paste: the text (design §4.3)', () => {
  it("answers the owner's absolute paths in the picked order, escaped, space-separated, one trailing space", async () => {
    const uploads = make()
    const id = await finished(uploads, ['b.png', 'a (1).txt'])
    // The project root has a space: the whole path is escaped, the root included.
    expect(uploads.paste(A, id, false, facts())).toEqual({ text: `${join(proj, 'sub', 'b.png').replaceAll(' ', '\\ ')} ${join(proj, 'sub', 'a (1).txt').replace(/[ ()]/g, (c) => `\\${c}`)} ` })
  })

  it('pastes only the files that were written (a partial result)', async () => {
    const uploads = make()
    const id = await finished(uploads, ['a.txt', 'b.txt', 'c.txt'], { failed: ['b.txt'] })
    const reply = uploads.paste(A, id, false, facts())
    expect(reply).toEqual({ text: expect.stringContaining('a.txt') })
    expect('text' in reply && reply.text).toContain('c.txt')
    expect('text' in reply && reply.text).not.toContain('b.txt')
  })

  it("gives a guest paths relative to the tab's starting folder, never a host path", async () => {
    const uploads = make()
    const intoOther = await finished(uploads, ['x.png'], { folder: 'other' })
    const intoSub = await finished(uploads, ['y.png'])
    // The tab began in sub (TabInfo.cwd: absolute, real).
    const sub = facts({ guest: true, tab: { cwd: join(proj, 'sub') } })
    expect(uploads.paste(A, intoOther, false, sub)).toEqual({ text: '../other/x.png ' })
    expect(uploads.paste(A, intoSub, false, sub)).toEqual({ text: './y.png ' })
    // From the project folder: `./sub/y.png`; a hold carries the relative text too.
    const root = facts({ guest: true, status: 'working' })
    expect(uploads.paste(A, intoSub, true, root)).toEqual({ text: './sub/y.png ' })
    const again = make()
    const held = await finished(again, ['z.png'])
    const reply = again.paste(A, held, false, root)
    expect(reply).toEqual({ held: UPLOAD_PASTE_NOT_WAITING_TEXT, text: './sub/z.png ' })
    expect(JSON.stringify(reply)).not.toContain(tmp)
  })

  it("builds paths from the folder's real path when it is reached through a link inside the project", async () => {
    mkdirSync(join(proj, 'shared', 'assets'), { recursive: true })
    symlinkSync(join(proj, 'shared', 'assets'), join(proj, 'assets'))
    const uploads = make()
    const id = await finished(uploads, ['x.png'], { folder: 'assets' })
    expect(uploads.paste(A, id, true, facts())).toEqual({ text: `${join(proj, 'shared', 'assets', 'x.png').replaceAll(' ', '\\ ')} ` })
    // The guest's tab began in the project folder, then in a subfolder: both relative to real paths.
    expect(uploads.paste(A, id, true, facts({ guest: true }))).toEqual({ text: './shared/assets/x.png ' })
    expect(uploads.paste(A, id, true, facts({ guest: true, tab: { cwd: join(proj, 'sub') } }))).toEqual({
      text: '../shared/assets/x.png '
    })
  })

  it("a guest's paste for a tab that is gone says nothing of the paths", async () => {
    const uploads = make()
    const id = await finished(uploads, ['x.png'])
    expect(uploads.paste(A, id, false, facts({ guest: true, tab: null }))).toEqual({ held: UPLOAD_PASTE_ENDED_TEXT, text: '' })
  })

  it('holds a path with a bidi or control character anywhere in it, and Paste path is held again', async () => {
    // The root (never checked by begin: a cloned folder can be named anything) carries U+202E.
    const root = join(tmp, 'evil‮root')
    mkdirSync(root)
    mkdirSync(join(root, 'sub'))
    const uploads = make(root)
    const id = await finished(uploads, ['a.png'])
    const reply = uploads.paste(A, id, false, facts())
    expect(reply).toEqual({ held: UPLOAD_PASTE_UNSAFE_TEXT, text: `${join(root, 'sub', 'a.png')} ` })
    expect(uploads.paste(A, id, true, facts())).toEqual({ held: UPLOAD_PASTE_UNSAFE_TEXT, text: expect.any(String) })
  })
})

describe('Uploads.paste: the automatic call (design §4.3)', () => {
  it.each<[TabStatus, string | undefined]>([
    ['waiting', undefined],
    ['idle', UPLOAD_PASTE_NOT_WAITING_TEXT],
    ['starting', UPLOAD_PASTE_NOT_WAITING_TEXT],
    ['working', UPLOAD_PASTE_NOT_WAITING_TEXT],
    ['needs-permission', UPLOAD_PASTE_PERMISSION_TEXT],
    ['ended', UPLOAD_PASTE_ENDED_TEXT]
  ])('a Claude tab %s: %s', async (status, held) => {
    const uploads = make()
    const id = await finished(uploads, ['a.png'])
    const reply = uploads.paste(A, id, false, facts({ status }))
    if (held === undefined) expect(reply).toEqual({ text: expect.stringMatching(/a\.png $/) })
    else expect(reply).toEqual({ held, text: expect.stringMatching(/a\.png $/) })
  })

  it('a Claude tab with no status (no registry entry) is not at the prompt', async () => {
    const uploads = make()
    const id = await finished(uploads, ['a.png'])
    const tab: UploadPasteTab = { kind: 'claude', cwd: proj, exited: false }
    expect(uploads.paste(A, id, false, { ...facts(), tab: () => tab })).toMatchObject({ held: UPLOAD_PASTE_NOT_WAITING_TEXT })
  })

  it('a shell tab needs only to be alive and selected', async () => {
    const uploads = make()
    const id = await finished(uploads, ['a.png'])
    expect(uploads.paste(A, id, false, facts({ tab: { kind: 'shell', status: undefined } }))).toEqual({ text: expect.any(String) })
  })

  it('holds when another tab is selected in the calling view, or none is', async () => {
    const uploads = make()
    const one = await finished(uploads, ['a.png'])
    const two = await finished(uploads, ['b.png'])
    expect(uploads.paste(A, one, false, facts({ selected: 't2' }))).toMatchObject({ held: UPLOAD_PASTE_NOT_SELECTED_TEXT })
    expect(uploads.paste(A, two, false, facts({ selected: undefined }))).toMatchObject({ held: UPLOAD_PASTE_NOT_SELECTED_TEXT })
  })

  it('holds for an ended tab: closed, exited, or no longer a Claude or shell tab', async () => {
    const uploads = make()
    const closed = await finished(uploads, ['a.png'])
    const exited = await finished(uploads, ['b.png'])
    expect(uploads.paste(A, closed, false, facts({ tab: null }))).toMatchObject({ held: UPLOAD_PASTE_ENDED_TEXT })
    expect(uploads.paste(A, exited, false, facts({ tab: { exited: true } }))).toMatchObject({ held: UPLOAD_PASTE_ENDED_TEXT })
    const page = await finished(uploads, ['c.png'])
    expect(uploads.paste(A, page, false, facts({ tab: { kind: 'page' } }))).toMatchObject({ held: UPLOAD_PASTE_ENDED_TEXT })
  })

  it('is taken once per upload: a second automatic call is held, whatever the first answered', async () => {
    const uploads = make()
    const pasted = await finished(uploads, ['a.png'])
    expect(uploads.paste(A, pasted, false, facts())).toEqual({ text: expect.any(String) })
    expect(uploads.paste(A, pasted, false, facts())).toEqual({ held: UPLOAD_PASTE_AGAIN_TEXT, text: expect.any(String) })
    const held = await finished(uploads, ['b.png'])
    expect(uploads.paste(A, held, false, facts({ status: 'working' }))).toMatchObject({ held: UPLOAD_PASTE_NOT_WAITING_TEXT })
    // At the prompt now: still the automatic call's second go, so held.
    expect(uploads.paste(A, held, false, facts())).toMatchObject({ held: UPLOAD_PASTE_AGAIN_TEXT })
  })
})

describe('Uploads.paste: Paste path, the manual call (design §4.3)', () => {
  it('pastes after a held automatic call, in any status but needs-permission and ended, any number of times', async () => {
    const uploads = make()
    const id = await finished(uploads, ['a.png'])
    expect(uploads.paste(A, id, false, facts({ status: 'working' }))).toMatchObject({ held: UPLOAD_PASTE_NOT_WAITING_TEXT })
    for (const status of ['working', 'idle', 'starting', 'waiting', 'working'] as const) {
      expect(uploads.paste(A, id, true, facts({ status })), status).toEqual({ text: expect.stringMatching(/a\.png $/) })
    }
  })

  it('is refused in needs-permission (a keystroke could answer the dialog) and for an ended tab', async () => {
    const uploads = make()
    const id = await finished(uploads, ['a.png'])
    expect(uploads.paste(A, id, true, facts({ status: 'needs-permission' }))).toMatchObject({ held: UPLOAD_PASTE_PERMISSION_TEXT })
    expect(uploads.paste(A, id, true, facts({ status: 'ended' }))).toMatchObject({ held: UPLOAD_PASTE_ENDED_TEXT })
    expect(uploads.paste(A, id, true, facts({ tab: null }))).toMatchObject({ held: UPLOAD_PASTE_ENDED_TEXT })
    // Main checks the selection again: the click types into the tab the view shows, or nowhere.
    expect(uploads.paste(A, id, true, facts({ selected: 't2' }))).toMatchObject({ held: UPLOAD_PASTE_NOT_SELECTED_TEXT })
    // None of those took the automatic call.
    expect(uploads.paste(A, id, false, facts())).toEqual({ text: expect.any(String) })
  })
})

describe('Uploads.paste: the write, in the same step as the checks (design §4.3, external review)', () => {
  it('writes the answered text into the source tab as the view\'s input before it answers, bracketed when the terminal is', async () => {
    const uploads = make()
    const plain = await finished(uploads, ['a.png'])
    const written: Array<[string, string]> = []
    const reply = uploads.paste(A, plain, false, facts({ written }))
    expect(reply).toEqual({ text: expect.stringMatching(/a\.png $/) })
    expect(written).toEqual([['t1', (reply as { text: string }).text]])
    const wrapped = await finished(uploads, ['b.png'])
    const more: Array<[string, string]> = []
    const second = uploads.paste(A, wrapped, false, facts({ written: more, bracketed: true }))
    expect(more).toEqual([['t1', `\x1b[200~${(second as { text: string }).text}\x1b[201~`]])
  })

  it('reads the status at the write: a tab that reached needs-permission after an earlier answer gets nothing', async () => {
    // The old flow answered `{text}` at `waiting` and the page typed it a round trip later, through
    // `tabs.input`, which checks no status. Here every write follows its own check in one step.
    const uploads = make()
    const id = await finished(uploads, ['a.png'])
    const written: Array<[string, string]> = []
    expect(uploads.paste(A, id, false, facts({ written, status: 'working' }))).toMatchObject({ held: UPLOAD_PASTE_NOT_WAITING_TEXT })
    expect(uploads.paste(A, id, true, facts({ written, status: 'needs-permission' }))).toMatchObject({ held: UPLOAD_PASTE_PERMISSION_TEXT })
    expect(uploads.paste(A, id, true, facts({ written, selected: 't2' }))).toMatchObject({ held: UPLOAD_PASTE_NOT_SELECTED_TEXT })
    expect(uploads.paste(A, id, false, facts({ written }))).toMatchObject({ held: UPLOAD_PASTE_AGAIN_TEXT })
    expect(written).toEqual([])
    expect(uploads.paste(A, id, true, facts({ written }))).toEqual({ text: expect.any(String) })
    expect(written).toHaveLength(1)
  })

  it('holds as not selected, writing nothing, when the page shows no terminal of the tab (no mode sent)', async () => {
    const uploads = make()
    const id = await finished(uploads, ['a.png'])
    const written: Array<[string, string]> = []
    expect(uploads.paste(A, id, true, facts({ written, bracketed: undefined }))).toEqual({
      held: UPLOAD_PASTE_NOT_SELECTED_TEXT,
      text: expect.stringMatching(/a\.png $/)
    })
    expect(uploads.paste(A, id, false, facts({ written, bracketed: undefined }))).toMatchObject({ held: UPLOAD_PASTE_NOT_SELECTED_TEXT })
    expect(written).toEqual([])
  })

  it('holds when the view may not type into the tab now, and that takes the automatic call', async () => {
    const uploads = make()
    const id = await finished(uploads, ['a.png'])
    expect(uploads.paste(A, id, false, facts({ input: () => false }))).toMatchObject({ held: UPLOAD_PASTE_NO_INPUT_TEXT, text: expect.any(String) })
    expect(uploads.paste(A, id, false, facts())).toMatchObject({ held: UPLOAD_PASTE_AGAIN_TEXT })
  })
})

describe('Uploads.paste: whose upload (design §3.1, §4.3)', () => {
  it('answers one refusal for an unknown id, another device, another window, a panel source, an unfinished or an empty upload', async () => {
    const uploads = make()
    const id = await finished(uploads, ['a.png'])
    const fromPanel = await finished(uploads, ['b.png'], { source: { panel: 'cockpit.files/tree' } })
    const allFailed = await finished(make(), ['c.png'], { failed: ['c.png'] })
    const throwsUnknown = (fn: () => unknown): void => expect(fn).toThrow(UPLOAD_UNKNOWN_TEXT)
    throwsUnknown(() => uploads.paste(A, 'nope', false, facts()))
    throwsUnknown(() => uploads.paste(A, 42, false, facts()))
    throwsUnknown(() => uploads.paste({ deviceId: 'dev-b', windowId: WINDOW }, id, false, facts()))
    throwsUnknown(() => uploads.paste({ deviceId: 'dev-a', windowId: 4 }, id, false, facts()))
    throwsUnknown(() => uploads.paste(A, fromPanel, false, facts()))
    throwsUnknown(() => uploads.paste(A, allFailed, false, facts()))
    // Still running: one file of two settled.
    const begun = (await uploads.begin(A, { tab: 't1' }, 'sub', [{ name: 'd.png', size: 1 }, { name: 'e.png', size: 1 }])) as UploadBegun
    const first = begun.tokens?.[0]
    if (!first) throw new Error('no token')
    uploads.settle(first.token, { ok: true, name: 'd.png', path: 'sub/d.png' })
    throwsUnknown(() => uploads.paste(A, begun.uploadId, false, facts()))
    // The refusals took nothing: the owner's own automatic call still pastes.
    expect(uploads.paste(A, id, false, facts())).toEqual({ text: expect.any(String) })
  })

  it("a cancel of a partly settled upload finishes it, and its written files paste", async () => {
    const uploads = make()
    const begun = (await uploads.begin(A, { tab: 't1' }, 'sub', [{ name: 'd.png', size: 1 }, { name: 'e.png', size: 1 }])) as UploadBegun
    const first = begun.tokens?.[0]
    if (!first) throw new Error('no token')
    uploads.settle(first.token, { ok: true, name: 'd.png', path: 'sub/d.png' })
    await uploads.cancel(A, begun.uploadId)
    expect(uploads.paste(A, begun.uploadId, false, facts())).toEqual({ text: `${join(proj, 'sub', 'd.png').replaceAll(' ', '\\ ')} ` })
  })
})
