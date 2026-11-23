// The web shell's upload controller (src/renderer/web/upload-controller.ts, design-upload.md §3.1,
// §4.3, §5.3) with fakes for the invoke, the run and the dialogs: a clean upload, a clash answered each
// way, a cancel mid-run, a refusal at begin, a partial result (a terminal one cancelled on main before
// its paste), `pagehide` at each step (chooser, begin, clash, resolve, run, paste) and its order against
// the bridge's close, and a terminal source reaching the chooser and `uploads.paste`.

import { describe, expect, it } from 'vitest'
import {
  KEYS_OFF_HELD,
  leaveThenClose,
  UploadController,
  type UploadControllerDeps,
  type UploadFile
} from '../../src/renderer/web/upload-controller'
import { UploadUi, presetKey, type PresetStorage, type UploadResultNotice } from '../../src/renderer/notices/upload-model'
import type { UploadFileResult, UploadRunOptions } from '../../src/renderer/web/upload-client'
import type { UploadFileToken } from '../../src/shared/uploads'

const file = (name: string, size = 10): UploadFile => ({ name, size, slice: () => new Blob([]) })

type Call = { channel: string; payload: unknown }

/** A fake invoke: answers per channel from `answers` (a value, a function, or a thrown Error). */
function fakeInvoke(answers: Record<string, unknown>): { invoke: UploadControllerDeps['invoke']; calls: Call[] } {
  const calls: Call[] = []
  const invoke = (async (channel: string, payload?: unknown) => {
    calls.push({ channel, payload })
    const a = answers[channel]
    const v = typeof a === 'function' ? await (a as (p: unknown) => unknown)(payload) : a
    if (v instanceof Error) throw v
    return v
  }) as UploadControllerDeps['invoke']
  return { invoke, calls }
}

/**
 * A bridge as web/bridge.ts behaves around `close`: an invoke before it is sent (recorded) and answered
 * from `answers`; `close` rejects every pending call; an invoke after it is refused at once, unsent.
 */
function closingBridge(answers: Record<string, unknown>): { invoke: UploadControllerDeps['invoke']; close: () => void; sent: string[] } {
  const sent: string[] = []
  const pending = new Set<(err: Error) => void>()
  let closed = false
  const invoke = ((channel: string, payload?: unknown) => {
    if (closed) return Promise.reject(new Error('the bridge is closed'))
    sent.push(channel)
    return new Promise<unknown>((resolve, reject) => {
      pending.add(reject)
      const a = answers[channel]
      Promise.resolve(typeof a === 'function' ? (a as (p: unknown) => unknown)(payload) : a).then(
        (v) => (pending.delete(reject), v instanceof Error ? reject(v) : resolve(v)),
        (e: unknown) => (pending.delete(reject), reject(e))
      )
    })
  }) as UploadControllerDeps['invoke']
  const close = (): void => {
    closed = true
    sent.push('close')
    for (const reject of pending) reject(new Error('the bridge is closed'))
    pending.clear()
  }
  return { invoke, close, sent }
}

const tokensFor =(...indices: number[]): UploadFileToken[] => indices.map((index) => ({ index, token: `t${index}`, name: `n${index}` }))

/** A run that settles every token as `done` (or per `outcome`), reporting progress once per file. */
function fakeRun(outcome: (t: UploadFileToken) => UploadFileResult['outcome'] = () => 'done') {
  const runs: { tokens: readonly UploadFileToken[]; opts: UploadRunOptions }[] = []
  const run: NonNullable<UploadControllerDeps['run']> = async (files, tokens, opts) => {
    runs.push({ tokens, opts })
    let sent = 0
    return tokens.map((t) => {
      sent += files[t.index]?.size ?? 0
      opts.onProgress?.({ index: t.index, name: t.name, fileSent: 0, fileSize: 0, sent, total: 0 })
      const o = outcome(t)
      return { index: t.index, name: t.name, outcome: o, ...(o === 'failed' ? { reason: 'the disk is full' } : {}), ...(o === 'done' ? { path: `p/${t.name}` } : {}) }
    })
  }
  return { run, runs }
}

/** A run that waits until its signal aborts, then answers every file cancelled. */
function hangingRun() {
  const signals: AbortSignal[] = []
  let started: () => void = () => undefined
  const running = new Promise<void>((r) => (started = r))
  const run: NonNullable<UploadControllerDeps['run']> = (_files, tokens, opts) =>
    new Promise((resolve) => {
      signals.push(opts.signal!)
      started()
      opts.signal!.addEventListener('abort', () => resolve(tokens.map((t) => ({ index: t.index, name: t.name, outcome: 'cancelled' as const }))))
    })
  return { run, signals, running: () => running }
}

const lastResult = (ui: UploadUi): UploadResultNotice => {
  const n = ui.get().notices.at(-1)
  if (n?.kind !== 'result') throw new Error(`no result notice: ${JSON.stringify(n)}`)
  return n
}

const mem = (): PresetStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('UploadController: a panel upload', () => {
  it('begins, runs and shows a clean result', async () => {
    const ui = new UploadUi()
    const { invoke, calls } = fakeInvoke({ 'uploads.begin': { uploadId: 'u1', refused: [], clashes: [], tokens: tokensFor(0, 1) } })
    const { run, runs } = fakeRun()
    const c = new UploadController({ invoke, ui, projectId: 'p', run })
    const files = [file('a.png', 5), file('b.png', 7)]
    await c.start({ source: { panel: 'cockpit.files/tree' }, folder: 'src', files })
    expect(calls[0]).toEqual({
      channel: 'uploads.begin',
      payload: { source: { panel: 'cockpit.files/tree' }, folder: 'src', files: [{ name: 'a.png', size: 5 }, { name: 'b.png', size: 7 }] }
    })
    // The File objects themselves go to the run only, never into the begin's payload.
    expect(runs[0]?.tokens).toEqual(tokensFor(0, 1))
    expect(calls.map((x) => x.channel)).toEqual(['uploads.begin'])
    const r = lastResult(ui)
    expect(r.text).toBe('Uploaded n0, n1 to src')
    expect(r.sticky).toBe(false)
    expect(ui.get().notices).toHaveLength(1)
  })

  it('shows progress with the position among the tokens and a Cancel', async () => {
    const ui = new UploadUi()
    const seen: string[] = []
    ui.subscribe(() => {
      const n = ui.get().notices[0]
      if (n?.kind === 'progress') seen.push(`${n.fileNo}/${n.fileCount} ${n.sent}/${n.total}`)
    })
    // File 1 refused at begin: the tokens are 0 and 2, so file 2 is the second of two.
    const { invoke } = fakeInvoke({ 'uploads.begin': { uploadId: 'u1', refused: [{ index: 1, reason: 'too big' }], clashes: [], tokens: tokensFor(0, 2) } })
    const { run } = fakeRun()
    const c = new UploadController({ invoke, ui, projectId: 'p', run })
    await c.start({ source: { panel: 'k' }, folder: '', files: [file('a', 3), file('b', 100), file('c', 4)] })
    expect(seen).toEqual(['1/2 0/7', '1/2 3/7', '2/2 7/7'])
    const r = lastResult(ui)
    expect(r.text).toBe('Uploaded 2 of 3 to the project folder; not uploaded: b (too big)')
    expect(r.sticky).toBe(true)
  })

  it('shows one notice for a refusal at begin, an {error} or a thrown one', async () => {
    for (const answer of [{ error: 'the disk is full' }, new Error('the disk is full')]) {
      const ui = new UploadUi()
      const { invoke, calls } = fakeInvoke({ 'uploads.begin': answer })
      const { run, runs } = fakeRun()
      await new UploadController({ invoke, ui, projectId: 'p', run }).start({ source: { panel: 'k' }, folder: '', files: [file('a')] })
      expect(runs).toHaveLength(0)
      expect(calls).toHaveLength(1)
      expect(ui.get().notices).toEqual([{ kind: 'result', id: 'upload-1', text: 'Nothing uploaded: the disk is full', sticky: true }])
    }
  })

  it('names skipped folders, with files and alone', async () => {
    const ui = new UploadUi()
    const { invoke, calls } = fakeInvoke({ 'uploads.begin': { uploadId: 'u1', refused: [], clashes: [], tokens: tokensFor(0) } })
    const c = new UploadController({ invoke, ui, projectId: 'p', run: fakeRun().run })
    await c.start({ source: { panel: 'k' }, folder: 'x', files: [file('a')], folders: ['photos'] })
    expect(lastResult(ui)).toMatchObject({ text: "Uploaded n0 to x; folders can't be uploaded: photos", sticky: true })
    await c.start({ source: { panel: 'k' }, folder: 'x', files: [], folders: ['raw'] })
    expect(lastResult(ui).text).toBe("Nothing uploaded: folders can't be uploaded: raw")
    expect(calls).toHaveLength(1)
  })

  it('shows a partial result and cancels what the run gave up on, so main frees the place', async () => {
    const ui = new UploadUi()
    const { invoke, calls } = fakeInvoke({ 'uploads.begin': { uploadId: 'u1', refused: [], clashes: [], tokens: tokensFor(0, 1, 2) } })
    const { run } = fakeRun((t) => (t.index === 1 ? 'failed' : 'done'))
    await new UploadController({ invoke, ui, projectId: 'p', run }).start({ source: { panel: 'k' }, folder: 'd', files: [file('a'), file('b'), file('c')] })
    expect(lastResult(ui)).toMatchObject({ text: 'Uploaded 2 of 3 to d; not uploaded: n1 (the disk is full)', sticky: true })
    await tick()
    expect(calls.map((x) => x.channel)).toEqual(['uploads.begin', 'uploads.cancel'])
  })

  it('survives a run that rejects', async () => {
    const ui = new UploadUi()
    const { invoke } = fakeInvoke({ 'uploads.begin': { uploadId: 'u1', refused: [], clashes: [], tokens: tokensFor(0) }, 'uploads.cancel': undefined })
    const run: NonNullable<UploadControllerDeps['run']> = () => Promise.reject(new Error('boom'))
    await new UploadController({ invoke, ui, projectId: 'p', run }).start({ source: { panel: 'k' }, folder: '', files: [file('a')] })
    expect(lastResult(ui).text).toBe('Nothing uploaded: n0 (the upload stopped unexpectedly)')
  })
})

describe('UploadController: clashes', () => {
  const clashBegin = { uploadId: 'u1', refused: [], clashes: [{ index: 0, name: 'a.png', replaceable: true }] }

  async function withClash(choice: 'replace' | 'keep-both' | 'cancel', resolveAnswer: unknown = { tokens: tokensFor(0, 1), refused: [] }) {
    const ui = new UploadUi()
    const { invoke, calls } = fakeInvoke({ 'uploads.begin': clashBegin, 'uploads.resolve': resolveAnswer, 'uploads.cancel': undefined })
    const { run, runs } = fakeRun()
    const c = new UploadController({ invoke, ui, projectId: 'p', run })
    const done = c.start({ source: { panel: 'k' }, folder: 'img', files: [file('a.png'), file('b.png')] })
    await tick()
    const clash = ui.get().clashes[0]
    expect(clash).toMatchObject({ folder: 'img', clashes: clashBegin.clashes })
    clash!.onAnswer(choice)
    // The controller ends the dialog itself (the dialog only calls onAnswer).
    expect(ui.get().clashes).toHaveLength(0)
    await done
    await tick()
    return { ui, calls, runs }
  }

  it('Replace and Keep both resolve and run with the answered tokens', async () => {
    for (const choice of ['replace', 'keep-both'] as const) {
      const { ui, calls, runs } = await withClash(choice)
      expect(calls[1]).toEqual({ channel: 'uploads.resolve', payload: { uploadId: 'u1', choice } })
      expect(runs[0]?.tokens).toEqual(tokensFor(0, 1))
      expect(lastResult(ui).text).toBe('Uploaded n0, n1 to img')
    }
  })

  it('Keep both past the numbering: resolve refusals join the result', async () => {
    const { ui } = await withClash('keep-both', { tokens: tokensFor(1), refused: [{ index: 0, reason: 'no free number' }] })
    expect(lastResult(ui).text).toBe('Uploaded 1 of 2 to img; not uploaded: a.png (no free number)')
  })

  it('Cancel resolves cancel, runs nothing and shows no notice', async () => {
    const { ui, calls, runs } = await withClash('cancel')
    expect(calls.map((x) => x.channel)).toEqual(['uploads.begin', 'uploads.resolve'])
    expect(calls[1]?.payload).toEqual({ uploadId: 'u1', choice: 'cancel' })
    expect(runs).toHaveLength(0)
    expect(ui.get().notices).toHaveLength(0)
  })

  it('a resolve refusal cancels the upload on main and says why', async () => {
    const { ui, calls, runs } = await withClash('replace', { error: 'icons is a folder' })
    expect(runs).toHaveLength(0)
    expect(calls.map((x) => x.channel)).toEqual(['uploads.begin', 'uploads.resolve', 'uploads.cancel'])
    expect(lastResult(ui).text).toBe('Nothing uploaded: icons is a folder')
  })
})

describe('UploadController: cancel and leaving', () => {
  it('Cancel mid-run aborts the run and cancels on main', async () => {
    const ui = new UploadUi()
    const { invoke, calls } = fakeInvoke({ 'uploads.begin': { uploadId: 'u1', refused: [], clashes: [], tokens: tokensFor(0, 1) }, 'uploads.cancel': undefined })
    const h = hangingRun()
    const done = new UploadController({ invoke, ui, projectId: 'p', run: h.run }).start({ source: { panel: 'k' }, folder: '', files: [file('a'), file('b')] })
    await h.running()
    const progress = ui.get().notices[0]
    if (progress?.kind !== 'progress') throw new Error('no progress notice')
    progress.onCancel()
    progress.onCancel()
    await done
    expect(h.signals[0]?.aborted).toBe(true)
    expect(calls.filter((x) => x.channel === 'uploads.cancel')).toEqual([{ channel: 'uploads.cancel', payload: { uploadId: 'u1' } }])
    expect(lastResult(ui)).toMatchObject({ text: 'Upload cancelled', sticky: true })
  })

  it('a Cancel while the host is away still stops the bytes', async () => {
    const ui = new UploadUi()
    const { invoke } = fakeInvoke({ 'uploads.begin': { uploadId: 'u1', refused: [], clashes: [], tokens: tokensFor(0) }, 'uploads.cancel': new Error('host unreachable') })
    const h = hangingRun()
    const done = new UploadController({ invoke, ui, projectId: 'p', run: h.run }).start({ source: { panel: 'k' }, folder: '', files: [file('a')] })
    await h.running()
    const progress = ui.get().notices[0]
    if (progress?.kind === 'progress') progress.onCancel()
    await done
    expect(h.signals[0]?.aborted).toBe(true)
  })

  it('pagehide aborts two runs, cancels both on main and shows nothing more', async () => {
    const ui = new UploadUi()
    let n = 0
    const { invoke, calls } = fakeInvoke({
      'uploads.begin': () => ({ uploadId: `u${++n}`, refused: [], clashes: [], tokens: tokensFor(0) }),
      'uploads.cancel': undefined
    })
    const signals: AbortSignal[] = []
    let started = 0
    const run: NonNullable<UploadControllerDeps['run']> = (_f, tokens, opts) =>
      new Promise((resolve) => {
        signals.push(opts.signal!)
        started++
        opts.signal!.addEventListener('abort', () => resolve(tokens.map((t) => ({ index: t.index, name: t.name, outcome: 'cancelled' as const }))))
      })
    const c = new UploadController({ invoke, ui, projectId: 'p', run })
    const one = c.start({ source: { panel: 'k' }, folder: '', files: [file('a')] })
    const two = c.start({ source: { panel: 'k' }, folder: '', files: [file('b')] })
    while (started < 2) await tick()
    expect(ui.get().notices.map((x) => x.kind)).toEqual(['progress', 'progress'])
    const before = ui.get()
    c.leave()
    await Promise.all([one, two])
    expect(signals.map((s) => s.aborted)).toEqual([true, true])
    expect(calls.filter((x) => x.channel === 'uploads.cancel').map((x) => x.payload)).toEqual([{ uploadId: 'u1' }, { uploadId: 'u2' }])
    // No result notice after leaving: the page is going.
    expect(ui.get()).toBe(before)
    // And nothing starts after it.
    await c.start({ source: { panel: 'k' }, folder: '', files: [file('c')] })
    expect(calls.filter((x) => x.channel === 'uploads.begin')).toHaveLength(2)
  })

  // Not reachable through the real pagehide: leaveThenClose closes the bridge right after leave(), which
  // rejects the begin in flight (next test), so that case is left to main's idle clock. This pins the
  // controller's own rule for a begin answered after leave(), and the clash dialog's end.
  it('a begin answered after leave() is cancelled, and leave() closes an open clash dialog', async () => {
    const ui = new UploadUi()
    let answerBegin: (v: unknown) => void = () => undefined
    const { invoke, calls } = fakeInvoke({
      'uploads.begin': () => new Promise((r) => (answerBegin = r)),
      'uploads.cancel': undefined
    })
    const c = new UploadController({ invoke, ui, projectId: 'p', run: fakeRun().run })
    const one = c.start({ source: { panel: 'k' }, folder: '', files: [file('a')] })
    await tick()
    c.leave()
    answerBegin({ uploadId: 'late', refused: [], clashes: [], tokens: tokensFor(0) })
    await one
    expect(calls.map((x) => x.channel)).toEqual(['uploads.begin', 'uploads.cancel'])
    expect(calls[1]?.payload).toEqual({ uploadId: 'late' })

    const ui2 = new UploadUi()
    const f2 = fakeInvoke({ 'uploads.begin': { uploadId: 'u9', refused: [], clashes: [{ index: 0, name: 'a', replaceable: true }] }, 'uploads.cancel': undefined })
    const c2 = new UploadController({ invoke: f2.invoke, ui: ui2, projectId: 'p', run: fakeRun().run })
    const two = c2.start({ source: { panel: 'k' }, folder: '', files: [file('a')] })
    await tick()
    expect(ui2.get().clashes).toHaveLength(1)
    c2.leave()
    await two
    expect(ui2.get().clashes).toHaveLength(0)
    expect(f2.calls.map((x) => x.channel)).toEqual(['uploads.begin', 'uploads.cancel'])
  })

  it('the real pagehide during a begin: the closed bridge rejects it, no cancel is sent and no notice shows', async () => {
    const ui = new UploadUi()
    const bridge = closingBridge({ 'uploads.begin': () => new Promise(() => undefined) })
    const c = new UploadController({ invoke: bridge.invoke, ui, projectId: 'p', run: fakeRun().run })
    const one = c.start({ source: { panel: 'k' }, folder: '', files: [file('a')] })
    await tick()
    leaveThenClose(c, bridge.close)
    await one
    expect(bridge.sent).toEqual(['uploads.begin', 'close'])
    expect(ui.get().notices).toHaveLength(0)
  })

  it('pagehide with the folder chooser open ends it; nothing begins and nothing shows', async () => {
    const ui = new UploadUi()
    const { invoke, calls } = fakeInvoke({})
    const c = new UploadController({ invoke, ui, projectId: 'p', run: fakeRun().run })
    const done = c.startForTab('t', [file('a')])
    await tick()
    expect(ui.get().choosers).toHaveLength(1)
    c.leave()
    await done
    expect(ui.get().choosers).toHaveLength(0)
    expect(calls).toHaveLength(0)
    expect(ui.get().notices).toHaveLength(0)
  })

  it('pagehide while uploads.resolve is in flight still cancels on main, once', async () => {
    const ui = new UploadUi()
    const bridge = closingBridge({
      'uploads.begin': { uploadId: 'u1', refused: [], clashes: [{ index: 0, name: 'a', replaceable: true }] },
      'uploads.resolve': () => new Promise(() => undefined),
      'uploads.cancel': undefined
    })
    const c = new UploadController({ invoke: bridge.invoke, ui, projectId: 'p', run: fakeRun().run })
    const done = c.start({ source: { panel: 'k' }, folder: '', files: [file('a')] })
    await tick()
    ui.get().clashes[0]!.onAnswer('replace')
    await tick()
    leaveThenClose(c, bridge.close)
    await done
    expect(bridge.sent).toEqual(['uploads.begin', 'uploads.resolve', 'uploads.cancel', 'close'])
    expect(ui.get().notices).toHaveLength(0)
  })

  it('leaveThenClose sends the cancels before the bridge closes', async () => {
    const ui = new UploadUi()
    const bridge = closingBridge({ 'uploads.begin': { uploadId: 'u1', refused: [], clashes: [], tokens: tokensFor(0) }, 'uploads.cancel': undefined })
    const h = hangingRun()
    const c = new UploadController({ invoke: bridge.invoke, ui, projectId: 'p', run: h.run })
    const done = c.start({ source: { panel: 'k' }, folder: '', files: [file('a')] })
    await h.running()
    leaveThenClose(c, bridge.close)
    await done
    expect(bridge.sent).toEqual(['uploads.begin', 'uploads.cancel', 'close'])
  })
})

describe('UploadController: a terminal source', () => {
  const begin = { uploadId: 'u1', refused: [], clashes: [], tokens: tokensFor(0) }

  async function chooseAndRun(deps: Partial<UploadControllerDeps>, answers: Record<string, unknown>, storage = mem()) {
    const ui = new UploadUi()
    const { invoke, calls } = fakeInvoke({ 'uploads.begin': begin, 'uploads.cancel': undefined, ...answers })
    const c = new UploadController({ invoke, ui, projectId: 'proj', run: fakeRun().run, storage, ...deps })
    const done = c.startForTab('tab-1', [file('shot.png', 4)], { pasted: true })
    await tick()
    const chooser = ui.get().choosers[0]
    expect(chooser).toMatchObject({ tab: 'tab-1', files: [{ name: 'shot.png', size: 4 }] })
    chooser!.onAnswer('docs')
    expect(ui.get().choosers).toHaveLength(0)
    await done
    return { ui, calls, storage, chooser: chooser!, c }
  }

  it('opens the chooser at the preset, writes it after begin and pastes the text', async () => {
    const storage = mem()
    storage.data.set(presetKey('proj'), 'assets')
    const pasted: [string, string][] = []
    const { ui, calls, chooser } = await chooseAndRun(
      { keysOff: () => false, pasteInto: (tab, text) => (pasted.push([tab, text]), true) },
      { 'uploads.paste': { text: '/p/docs/n0 ' } },
      storage
    )
    expect(chooser.preset).toBe('assets')
    expect(calls[0]?.payload).toEqual({ source: { tab: 'tab-1' }, folder: 'docs', files: [{ name: 'shot.png', size: 4, pasted: true }] })
    expect(storage.data.get(presetKey('proj'))).toBe('docs')
    expect(calls[1]).toEqual({ channel: 'uploads.paste', payload: { uploadId: 'u1' } })
    expect(pasted).toEqual([['tab-1', '/p/docs/n0 ']])
    expect(lastResult(ui)).toMatchObject({ text: 'Uploaded n0 to docs', sticky: false })
    expect(lastResult(ui).held).toBeUndefined()
  })

  it('a chooser Cancel begins nothing', async () => {
    const ui = new UploadUi()
    const { invoke, calls } = fakeInvoke({})
    const c = new UploadController({ invoke, ui, projectId: 'p', run: fakeRun().run })
    const done = c.startForTab('t', [file('a')])
    await tick()
    ui.get().choosers[0]!.onAnswer(undefined)
    await done
    expect(calls).toHaveLength(0)
    expect(ui.get().notices).toHaveLength(0)
  })

  it('a held paste stays with Paste path; the manual call pastes', async () => {
    const pasted: string[] = []
    let paste = 0
    const { ui, calls } = await chooseAndRun(
      { pasteInto: (_t, text) => (pasted.push(text), true) },
      { 'uploads.paste': () => (++paste === 1 ? { held: 'Claude is busy', text: '/p/docs/n0 ' } : { text: '/p/docs/n0 ' }) }
    )
    const r = lastResult(ui)
    expect(r).toMatchObject({ sticky: true, held: { reason: 'Claude is busy', text: '/p/docs/n0 ' } })
    expect(pasted).toEqual([])
    r.onPaste!()
    await tick()
    expect(calls.at(-1)).toEqual({ channel: 'uploads.paste', payload: { uploadId: 'u1', manual: true } })
    expect(pasted).toEqual(['/p/docs/n0 '])
  })

  it('keys-off is held without asking main, and a later Paste path asks with manual', async () => {
    let off = true
    const { ui, calls } = await chooseAndRun({ keysOff: () => off, pasteInto: () => true }, { 'uploads.paste': { text: 'x ' } })
    expect(calls.some((x) => x.channel === 'uploads.paste')).toBe(false)
    const r = lastResult(ui)
    expect(r.held).toEqual({ reason: KEYS_OFF_HELD, text: '' })
    r.onPaste!()
    await tick()
    expect(calls.some((x) => x.channel === 'uploads.paste')).toBe(false)
    off = false
    lastResult(ui).onPaste!()
    await tick()
    expect(calls.filter((x) => x.channel === 'uploads.paste').map((x) => x.payload)).toEqual([{ uploadId: 'u1', manual: true }])
  })

  it('a paste call that rejects (not wired yet) keeps the result with a hold', async () => {
    const { ui } = await chooseAndRun({}, { 'uploads.paste': new Error('refused') })
    expect(lastResult(ui)).toMatchObject({ text: 'Uploaded n0 to docs', sticky: true, held: { reason: 'refused', text: '' } })
  })

  it('no paste when nothing committed or the run was cancelled', async () => {
    for (const outcome of ['failed', 'cancelled'] as const) {
      const ui = new UploadUi()
      const { invoke, calls } = fakeInvoke({ 'uploads.begin': begin, 'uploads.cancel': undefined, 'uploads.paste': { text: 'x' } })
      const c = new UploadController({ invoke, ui, projectId: 'p', run: fakeRun(() => outcome).run, pasteInto: () => true })
      const done = c.startForTab('t', [file('a')])
      await tick()
      ui.get().choosers[0]!.onAnswer('')
      await done
      expect(calls.some((x) => x.channel === 'uploads.paste')).toBe(false)
    }
  })

  it('a partial result cancels on main first (awaited), then pastes; a later Paste path is still answered', async () => {
    const ui = new UploadUi()
    // Main's side as uploads.ts now has it: the cancel finishes the partly settled upload, so the paste
    // (auto and manual) finds it; before the cancel answers, a paste would find it running.
    let finished = false
    let answerCancel: () => void = () => undefined
    let paste = 0
    const { invoke, calls } = fakeInvoke({
      'uploads.begin': { uploadId: 'u1', refused: [], clashes: [], tokens: tokensFor(0, 1) },
      'uploads.cancel': () => new Promise<void>((r) => (answerCancel = () => ((finished = true), r()))),
      'uploads.paste': () =>
        !finished ? { held: 'the upload is still running', text: '' } : ++paste === 1 ? { held: 'Claude is busy', text: '/p/d/n0 ' } : { text: '/p/d/n0 ' }
    })
    const pasted: string[] = []
    const run = fakeRun((t) => (t.index === 1 ? 'failed' : 'done')).run
    const c = new UploadController({ invoke, ui, projectId: 'p', run, keysOff: () => false, pasteInto: (_t, text) => (pasted.push(text), true) })
    const done = c.startForTab('t', [file('a'), file('b')])
    await tick()
    ui.get().choosers[0]!.onAnswer('d')
    while (!calls.some((x) => x.channel === 'uploads.cancel')) await tick()
    await tick()
    // The paste waits for the cancel's answer.
    expect(calls.map((x) => x.channel)).toEqual(['uploads.begin', 'uploads.cancel'])
    answerCancel()
    await done
    expect(calls.map((x) => x.channel)).toEqual(['uploads.begin', 'uploads.cancel', 'uploads.paste'])
    expect(calls[2]?.payload).toEqual({ uploadId: 'u1' })
    const r = lastResult(ui)
    expect(r).toMatchObject({ text: 'Uploaded 1 of 2 to d; not uploaded: n1 (the disk is full)', sticky: true, held: { reason: 'Claude is busy' } })
    r.onPaste!()
    await tick()
    expect(calls.at(-1)).toEqual({ channel: 'uploads.paste', payload: { uploadId: 'u1', manual: true } })
    expect(pasted).toEqual(['/p/d/n0 '])
  })

  it('a pagehide while the automatic paste is in flight shows no result notice', async () => {
    const ui = new UploadUi()
    const bridge = closingBridge({
      'uploads.begin': begin,
      'uploads.paste': () => new Promise(() => undefined)
    })
    const c = new UploadController({ invoke: bridge.invoke, ui, projectId: 'p', run: fakeRun().run, keysOff: () => false, pasteInto: () => true })
    const done = c.startForTab('t', [file('a')])
    await tick()
    ui.get().choosers[0]!.onAnswer('')
    while (!bridge.sent.includes('uploads.paste')) await tick()
    const before = ui.get().notices
    leaveThenClose(c, bridge.close)
    await done
    expect(ui.get().notices).toBe(before)
    expect(ui.get().notices.some((n) => n.kind === 'result')).toBe(false)
  })

  it('a manual paste in flight at pagehide shows nothing when it answers', async () => {
    let answer: (v: unknown) => void = () => undefined
    let paste = 0
    const { ui, c } = await chooseAndRun(
      { keysOff: () => false, pasteInto: () => true },
      { 'uploads.paste': () => (++paste === 1 ? { held: 'Claude is busy', text: 'x ' } : new Promise((r) => (answer = r))) }
    )
    lastResult(ui).onPaste!()
    await tick()
    const before = ui.get()
    c.leave()
    answer({ held: 'still busy', text: 'x ' })
    await tick()
    expect(ui.get()).toBe(before)
    expect(lastResult(ui).held?.reason).toBe('Claude is busy')
  })

  it('a drop of folders only says so without a chooser', async () => {
    const ui = new UploadUi()
    const { invoke, calls } = fakeInvoke({})
    await new UploadController({ invoke, ui, projectId: 'p' }).startForTab('t', [], { folders: ['photos'] })
    expect(ui.get().choosers).toHaveLength(0)
    expect(calls).toHaveLength(0)
    expect(lastResult(ui).text).toBe("Nothing uploaded: folders can't be uploaded: photos")
  })
})
