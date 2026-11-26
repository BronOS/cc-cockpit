import { describe, expect, it } from 'vitest'
import { MAX_QUEUED_MESSAGES } from '../../src/sdk/panel-core'
import type { OverlayInfo, OverlayReadyAnswer } from '../../src/shared/ipc'
import type { ViewAccess } from '../../src/shared/views'
import {
  closeActionOf,
  copyRetryDelay,
  COPY_RETRY_MAX_MS,
  CopyLine,
  guestNoteText,
  htmlBodyOf,
  resultActionOf,
  type CopyLineState,
  type HtmlBodyShell
} from '../../src/renderer/overlays/overlay-copies'

// docs/design-overlay-views.md §5 (the shell's copy per view), §7 (the guest note), D-2 (✕ and results by access).

const html = (extra: Partial<OverlayInfo> = {}): OverlayInfo =>
  ({ id: 'o1', kind: 'html', title: 'Diff', size: 'default', src: 'cc-plugin://a.rev/r.html', ...extra }) as OverlayInfo

describe('what ✕ and a page result do, by access (D-2)', () => {
  it("a read guest's ✕ hides a perView overlay; everyone else's closes it", () => {
    expect(closeActionOf({ perView: true }, 'read')).toBe('hide')
    expect(closeActionOf({ perView: true }, 'write')).toBe('close')
    expect(closeActionOf({ perView: true }, 'owner')).toBe('close')
    // Not perView: main has no hide for it; the close stays (and main refuses a read guest's).
    expect(closeActionOf({}, 'read')).toBe('close')
  })

  it("a page result is the owner's result, a read guest's hide and a write guest's close with no result", () => {
    expect(resultActionOf('owner')).toBe('result')
    expect(resultActionOf('read')).toBe('hide')
    expect(resultActionOf('write')).toBe('close')
  })
})

describe('the guest note (§7)', () => {
  it("says where and, when the plugin is named, why", () => {
    expect(guestNoteText('Oleg', 'Reviewer')).toBe("Open on Oleg's screen. Reviewer does not show its windows to guests.")
    expect(guestNoteText('Oleg')).toBe("Open on Oleg's screen.")
    expect(guestNoteText('', ' ')).toBe("Open on the owner's screen.")
  })
})

describe("an html overlay's body in this view", () => {
  const owner: HtmlBodyShell = { hiddenPage: false, holds: () => true }
  const browser: HtmlBodyShell = { hiddenPage: false, holds: (h) => h?.viewId === 'web:1' }
  const guest: HtmlBodyShell = { hiddenPage: false, holds: () => false, guest: { ownerName: 'Oleg' } }
  const hidden: HtmlBodyShell = { hiddenPage: true, holds: (h) => h === undefined }

  it('a perView overlay is a page in every view but the hidden page', () => {
    const pv = html({ perView: true })
    expect(htmlBodyOf(pv, owner)).toEqual({ kind: 'page' })
    // No heldBy: a browser view does not read it as "the desktop holds it".
    expect(htmlBodyOf(pv, browser)).toEqual({ kind: 'page' })
    expect(htmlBodyOf(pv, guest)).toEqual({ kind: 'page' })
    expect(htmlBodyOf(pv, hidden)).toEqual({ kind: 'none' })
  })

  it("a final refusal shows a guest the note (the opener named when visible) and an owner view nothing", () => {
    expect(htmlBodyOf(html({ perView: true, pluginTitle: 'Reviewer' }), guest, 'not-allowed')).toEqual({
      kind: 'note',
      text: "Open on Oleg's screen. Reviewer does not show its windows to guests."
    })
    expect(htmlBodyOf(html({ perView: true }), guest, 'not-allowed')).toEqual({ kind: 'note', text: "Open on Oleg's screen." })
    expect(htmlBodyOf(html({ perView: true }), guest, 'unknown')).toEqual({ kind: 'none' })
    expect(htmlBodyOf(html({ perView: true }), owner, 'not-allowed')).toEqual({ kind: 'none' })
  })

  it('a perView page this view has no path to (its opener hidden from the guest) is the note at once, never a frame', () => {
    const noPath = { ...guest, hasPage: () => false }
    expect(htmlBodyOf(html({ perView: true }), noPath)).toEqual({ kind: 'note', text: "Open on Oleg's screen." })
    expect(htmlBodyOf(html({ perView: true }), { ...owner, hasPage: () => false })).toEqual({ kind: 'none' })
    expect(htmlBodyOf(html({ perView: true }), { ...guest, hasPage: () => true })).toEqual({ kind: 'page' })
  })

  it('any other overlay: the holder the page, the owner elsewhere Take over, a guest the note', () => {
    const held = html({ heldBy: { viewId: 'web:1', device: 'Phone' }, pluginTitle: 'Gmail' })
    expect(htmlBodyOf(held, browser)).toEqual({ kind: 'page' })
    expect(htmlBodyOf(held, { ...browser, holds: () => false })).toEqual({ kind: 'held', device: 'Phone' })
    expect(htmlBodyOf(html(), { ...browser, holds: () => false })).toEqual({ kind: 'held', device: 'Desktop' })
    expect(htmlBodyOf(held, guest)).toEqual({ kind: 'note', text: "Open on Oleg's screen. Gmail does not show its windows to guests." })
    // Server mode, no browser yet: the hidden page holds nothing to draw.
    expect(htmlBodyOf(html({ waiting: true }), hidden)).toEqual({ kind: 'none' })
  })
})

describe('the retry backoff for a refused (`cap`) or failed connect', () => {
  it('doubles from 1 s and never waits past the cap window', () => {
    expect([0, 1, 2, 3, 4, 9].map(copyRetryDelay)).toEqual([1000, 2000, 4000, 8000, COPY_RETRY_MAX_MS, COPY_RETRY_MAX_MS])
  })
})

/** A CopyLine over fakes: every channel call recorded, `ready` answered by hand, timers run by hand. */
function harness(access: ViewAccess = 'owner') {
  const calls: unknown[][] = []
  const posted: string[] = []
  const states: CopyLineState[] = []
  const answers: Array<{ resolve: (a: OverlayReadyAnswer | undefined) => void; reject: (e: unknown) => void }> = []
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  let resultOk = true
  const line = new CopyLine({
    access,
    ready: () =>
      new Promise((resolve, reject) => {
        calls.push(['ready'])
        answers.push({ resolve, reject })
      }),
    loaded: (copy) => calls.push(['loaded', copy]),
    message: (copy, text) => calls.push(['message', copy, text]),
    release: (copy) => calls.push(['release', copy]),
    hide: () => calls.push(['hide']),
    close: () => calls.push(['close']),
    result: async (copy, value) => {
      calls.push(['result', copy, value])
      return resultOk
    },
    reload: () => calls.push(['reload']),
    hidden: () => calls.push(['hidden']),
    state: (s) => states.push(s),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      ;(t as { cleared: boolean }).cleared = true
    },
    log: () => {}
  })
  const port = { post: (text: string) => posted.push(text) }
  /** Answer the latest `ready` and let its promise settle. */
  const answer = async (a: OverlayReadyAnswer | undefined): Promise<void> => {
    answers.at(-1)!.resolve(a)
    await Promise.resolve()
    await Promise.resolve()
  }
  const fail = async (err: unknown): Promise<void> => {
    answers.at(-1)!.reject(err)
    await Promise.resolve()
    await Promise.resolve()
  }
  return {
    line,
    calls,
    posted,
    states,
    timers,
    port,
    answer,
    fail,
    answers,
    refuseResult: () => {
      resultOk = false
    }
  }
}

describe('CopyLine: one view’s copy across the loads of its frame', () => {
  it('a load asks for a copy; every page call then names it; its end is a plain release', async () => {
    const h = harness()
    const end = h.line.attach(h.port)
    expect(h.calls).toEqual([['ready']])
    await h.answer({ copy: 'c1', loaded: true })
    h.line.fromPage('{"a":1}')
    h.line.pageDrawn()
    h.line.fromMain('c1', '"init"')
    expect(h.posted).toEqual(['"init"'])
    end()
    expect(h.calls).toEqual([['ready'], ['message', 'c1', '{"a":1}'], ['loaded', 'c1'], ['release', 'c1']])
    // Never a hide for an unmount or a reload.
    expect(h.calls.some((c) => c[0] === 'hide')).toBe(false)
  })

  it("main's events before the answer are kept by copy: the answered copy's go to the page in order, others are dropped", async () => {
    const h = harness()
    h.line.attach(h.port)
    h.line.fromMain('c1', '"start"')
    h.line.fromMain('old', '"stale"')
    h.line.fromMain('c1', '"next"')
    expect(h.posted).toEqual([])
    await h.answer({ copy: 'c1' })
    expect(h.posted).toEqual(['"start"', '"next"'])
    // A message for a copy that is not this view's live one reaches nobody.
    h.line.fromMain('old', '"late"')
    expect(h.posted).toEqual(['"start"', '"next"'])
  })

  // 00 contract (spec-review S12): main's envelope pushes keep their mark down to the port, live or buffered across
  // an answer in flight, and an unmarked text never gains it.
  it("main's envelope mark reaches the port, live and buffered, in order with the opener's posts", async () => {
    const h = harness()
    const got: Array<[string, true | undefined]> = []
    h.line.attach({ post: (text: string, envelope?: true) => got.push([text, envelope]) })
    h.line.fromMain('c1', '{"$cc":1,"ev":"notes"}', true)
    h.line.fromMain('c1', '"plain"')
    h.line.fromMain('old', '{"$cc":1}', true)
    await h.answer({ copy: 'c1' })
    h.line.fromMain('c1', '{"$cc":1,"ev":"ask"}', true)
    h.line.fromMain('c1', '{"$cc":1,"forged":true}')
    expect(got).toEqual([
      ['{"$cc":1,"ev":"notes"}', true],
      ['"plain"', undefined],
      ['{"$cc":1,"ev":"ask"}', true],
      ['{"$cc":1,"forged":true}', undefined]
    ])
  })

  it("the page's posts and ready() before the answer are held, then sent with the copy", async () => {
    const h = harness()
    h.line.attach(h.port)
    h.line.fromPage('"early"')
    h.line.pageDrawn()
    expect(h.calls).toEqual([['ready']])
    await h.answer({ copy: 'c1' })
    expect(h.calls).toEqual([['ready'], ['message', 'c1', '"early"'], ['loaded', 'c1']])
    expect(h.states.at(-1)).toEqual({ loading: false })
  })

  it("the loader is the copy's own: gone at the answer for a `load` overlay, at the page's ready() for a `manual` one", async () => {
    const load = harness()
    load.line.attach(load.port)
    await load.answer({ copy: 'c1', loaded: true })
    expect(load.states).toEqual([{ loading: false }])
    const manual = harness()
    manual.line.attach(manual.port)
    await manual.answer({ copy: 'c2' })
    expect(manual.states).toEqual([])
    manual.line.pageDrawn()
    expect(manual.calls.at(-1)).toEqual(['loaded', 'c2'])
    expect(manual.states).toEqual([{ loading: false }])
  })

  // Codex review, finding 7: a `manual` page that draws while an image still holds the frame's `load` back says
  // ready() before the load attaches; dropped, its loader stayed up for good. Its SDK marks that ready `early` and
  // says it again once the port came (panel-core.ts): the second one names the load, whatever the phase.
  it("a ready() before the frame's load attaches: the early one is not used, the SDK's repeat at the port clears that load's loader, across a cap retry", async () => {
    const h = harness()
    h.line.pageDrawn(true)
    expect(h.calls).toEqual([])
    h.line.attach(h.port)
    expect(h.calls).toEqual([['ready']])
    await h.answer({ refused: 'cap' })
    // The port came with the load: the SDK's repeat lands while the copy is asked for again.
    h.line.pageDrawn()
    h.timers.at(-1)!.fn()
    await h.answer({ copy: 'c1' })
    expect(h.calls).toEqual([['ready'], ['ready'], ['loaded', 'c1']])
    expect(h.states.at(-1)).toEqual({ loading: false })
    // Once only: the next load starts with its loader up again.
    h.line.attach(h.port)
    await h.answer({ copy: 'c2' })
    expect(h.calls.filter((c) => c[0] === 'loaded')).toEqual([['loaded', 'c1']])
    expect(h.states.at(-1)).toEqual({ loading: true })
  })

  // Second codex review, finding 4: a manual-ready page that reloads itself (the same frame, its window kept) draws
  // before the new load's `load`: its ready came while the previous copy was live, marked that copy loaded, and the
  // new copy's loader stayed up for good.
  for (const drewBefore of [true, false]) {
    it(`an early ready() of the next load while a copy is live (that copy ${drewBefore ? 'drawn' : 'never drawn'}) goes to the next load, never to the live copy`, async () => {
      const h = harness()
      h.line.attach(h.port)
      await h.answer({ copy: 'c1' })
      if (drewBefore) h.line.pageDrawn()
      const loadedBefore = h.calls.filter((c) => c[0] === 'loaded').length
      // The page reloaded itself: its new document draws before its frame's load.
      h.line.pageDrawn(true)
      expect(h.calls.filter((c) => c[0] === 'loaded')).toHaveLength(loadedBefore)
      // Still loading (states are reported on a change only, so none went to loading: false).
      if (!drewBefore) expect(h.states.some((st) => !st.loading)).toBe(false)
      // The load attaches (a new copy), the port reaches the page, and its SDK says ready again.
      h.line.attach(h.port)
      h.line.pageDrawn()
      await h.answer({ copy: 'c2' })
      expect(h.calls.filter((c) => c[0] === 'loaded')).toEqual([...(drewBefore ? [['loaded', 'c1']] : []), ['loaded', 'c2']])
      expect(h.states.at(-1)).toEqual({ loading: false })
    })
  }

  it("a live copy's own ready() does not clear the next load's loader", async () => {
    const h = harness()
    h.line.attach(h.port)
    await h.answer({ copy: 'c1' })
    h.line.pageDrawn()
    h.line.attach(h.port)
    await h.answer({ copy: 'c2' })
    expect(h.calls.filter((c) => c[0] === 'loaded')).toEqual([['loaded', 'c1']])
    expect(h.states.at(-1)).toEqual({ loading: true })
  })

  it('a page load after another is a new copy; the old one is released, a late answer for an ended load too', async () => {
    const h = harness()
    const end1 = h.line.attach(h.port)
    await h.answer({ copy: 'c1' })
    end1()
    h.line.attach(h.port)
    await h.answer({ copy: 'c2' })
    h.line.fromMain('c1', '"old"')
    h.line.fromMain('c2', '"new"')
    expect(h.posted).toEqual(['"new"'])
    expect(h.calls.filter((c) => c[0] === 'release')).toEqual([['release', 'c1']])
    // Unmounted before main answered: that copy is let go when its answer lands.
    const late = harness()
    const end = late.line.attach(late.port)
    end()
    await late.answer({ copy: 'c9' })
    expect(late.calls).toEqual([['ready'], ['release', 'c9']])
  })

  it('overlays.hide of the live copy takes the overlay off this view; overlays.reload loads the page again; neither releases', async () => {
    const h = harness()
    const end = h.line.attach(h.port)
    await h.answer({ copy: 'c1' })
    h.line.mainHide('other')
    expect(h.calls).toEqual([['ready']])
    h.line.mainHide('c1')
    end()
    expect(h.calls).toEqual([['ready'], ['hidden']])

    const r = harness()
    const endR = r.line.attach(r.port)
    await r.answer({ copy: 'c1' })
    r.line.mainReload('c1')
    // The reload remounts the frame: its load ends (no release, main dropped it) and the next one connects.
    endR()
    r.line.attach(r.port)
    expect(r.calls).toEqual([['ready'], ['reload'], ['ready']])
  })

  it('a hide or reload that came before the answer naming that copy is applied when it lands', async () => {
    const h = harness()
    h.line.attach(h.port)
    h.line.fromMain('c1', '"start"')
    h.line.mainHide('c1')
    await h.answer({ copy: 'c1' })
    expect(h.posted).toEqual([])
    expect(h.calls).toEqual([['ready'], ['hidden']])
    const r = harness()
    r.line.attach(r.port)
    r.line.mainReload('c7')
    await r.answer({ copy: 'c7' })
    expect(r.calls).toEqual([['ready'], ['reload']])
  })

  it('a `cap` refusal or a failed call asks again on the same load with a backoff, keeping what the page sent', async () => {
    const h = harness()
    h.line.attach(h.port)
    h.line.fromPage('"hello"')
    await h.answer({ refused: 'cap' })
    expect(h.timers.map((t) => t.ms)).toEqual([1000])
    expect(h.states).toEqual([])
    h.timers[0]!.fn()
    await h.fail(new Error('socket closed'))
    expect(h.timers.map((t) => t.ms)).toEqual([1000, 2000])
    h.timers[1]!.fn()
    await h.answer({ copy: 'c1', loaded: true })
    expect(h.calls).toEqual([['ready'], ['ready'], ['ready'], ['message', 'c1', '"hello"']])
    // The next load starts its backoff from the beginning again.
  })

  it("a retry timer of an ended load does nothing", async () => {
    const h = harness()
    const end = h.line.attach(h.port)
    await h.answer({ refused: 'cap' })
    end()
    expect(h.timers[0]!.cleared).toBe(true)
    h.timers[0]!.fn()
    expect(h.calls).toEqual([['ready']])
  })

  it('a final refusal stops asking and says why; nothing the page sends goes anywhere', async () => {
    for (const refused of ['not-allowed', 'unknown', 'hidden-page', 'not-per-view'] as const) {
      const h = harness('read')
      const end = h.line.attach(h.port)
      await h.answer({ refused })
      h.line.fromPage('"x"')
      h.line.pageDrawn()
      end()
      expect(h.timers, refused).toEqual([])
      expect(h.calls, refused).toEqual([['ready']])
      expect(h.states, refused).toEqual([{ loading: false, refused }])
    }
    // An answer with no copy at all (the overlay is not perView after all) is final too.
    const h = harness()
    h.line.attach(h.port)
    await h.answer(undefined)
    expect(h.states).toEqual([{ loading: false, refused: 'not-per-view' }])
  })

  it("a page result: the owner's goes with the copy; a read guest's is a hide and a write guest's a close, never a result", async () => {
    const owner = harness('owner')
    owner.line.attach(owner.port)
    await owner.answer({ copy: 'c1' })
    let again = 0
    owner.line.pageResult({ ok: 1 }, () => again++)
    await Promise.resolve()
    expect(owner.calls.at(-1)).toEqual(['result', 'c1', { ok: 1 }])
    expect(again).toBe(0)
    owner.refuseResult()
    owner.line.pageResult('too big', () => again++)
    await Promise.resolve()
    await Promise.resolve()
    expect(again).toBe(1)

    const read = harness('read')
    read.line.attach(read.port)
    await read.answer({ copy: 'c2' })
    read.line.pageResult({ ok: 1 }, () => {})
    expect(read.calls).toEqual([['ready'], ['hide']])

    const write = harness('write')
    write.line.attach(write.port)
    await write.answer({ copy: 'c3' })
    write.line.pageResult({ ok: 1 }, () => {})
    expect(write.calls).toEqual([['ready'], ['close']])

    // The owner's result before the copy is known: not sent, the page may answer again.
    const early = harness('owner')
    early.line.attach(early.port)
    let refused = 0
    early.line.pageResult(1, () => refused++)
    expect(refused).toBe(1)
    expect(early.calls).toEqual([['ready']])
  })

  it("what waits for an answer is bounded", async () => {
    const h = harness()
    h.line.attach(h.port)
    for (let i = 0; i < MAX_QUEUED_MESSAGES + 5; i++) {
      h.line.fromMain('c1', `${i}`)
      h.line.fromPage(`${i}`)
    }
    await h.answer({ copy: 'c1' })
    expect(h.posted).toHaveLength(MAX_QUEUED_MESSAGES)
    expect(h.calls.filter((c) => c[0] === 'message')).toHaveLength(MAX_QUEUED_MESSAGES)
  })
})
