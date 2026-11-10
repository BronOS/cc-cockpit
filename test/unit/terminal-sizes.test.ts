// Terminal size per view (design-web.md §5.2 "Size", plan Task 15): the policy on its own
// (TerminalSizes), TabManager applying it to the pty with size items in the desktop's stream, the
// desktop's resync carrying sizes, and the page drawing at the pty's size (drawAt).
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TabManager } from '../../src/main/tabs/tab-manager'
import { TAKE_DEBOUNCE_MS, TerminalSizes } from '../../src/main/tabs/terminal-sizes'
import { DesktopFlow } from '../../src/main/terminals/desktop-flow'
import type { MirrorView } from '../../src/main/terminals/mirror'
import { drawAt } from '../../src/renderer/tabs/terminal-draw'
import type { EventChannel, IpcEventMap } from '../../src/shared/ipc'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

const D = 'desktop:1'
const W = 'web:1'
const W2 = 'web:2'

function policy() {
  const applied: string[] = []
  const sizes = new TerminalSizes({ apply: (tabId, cols, rows) => applied.push(`${tabId} ${cols}x${rows}`) })
  return { sizes, applied }
}

describe('TerminalSizes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("the first view sizes a tab and its own resizes apply at once; another view's are only remembered", () => {
    const { sizes, applied } = policy()
    sizes.report('t', D, 120, 40)
    sizes.report('t', W, 50, 30)
    sizes.report('t', W, 52, 31)
    sizes.report('t', D, 130, 40)
    expect(applied).toEqual(['t 120x40', 't 130x40'])
    expect(sizes.sizerOf('t')).toBe(D)
    expect(sizes.sizeOf('t', W)).toEqual({ cols: 52, rows: 31 })
  })

  it('typing after another view typed takes the size after the debounce; the sizer typing meanwhile cancels it', () => {
    const { sizes, applied } = policy()
    sizes.report('t', D, 120, 40)
    sizes.report('t', W, 50, 30)
    applied.length = 0
    sizes.typed('t', W)
    vi.advanceTimersByTime(TAKE_DEBOUNCE_MS - 1)
    expect(applied).toEqual([])
    sizes.typed('t', D)
    vi.advanceTimersByTime(TAKE_DEBOUNCE_MS * 2)
    expect(applied).toEqual([])
    sizes.typed('t', W)
    vi.advanceTimersByTime(TAKE_DEBOUNCE_MS)
    expect(applied).toEqual(['t 50x30'])
    expect(sizes.sizerOf('t')).toBe(W)
  })

  it('alternating typing does not resize per keystroke', () => {
    const { sizes, applied } = policy()
    sizes.report('t', D, 120, 40)
    sizes.report('t', W, 50, 30)
    applied.length = 0
    // A phone and a desktop typing in turn, a key every 100 ms each, for ten seconds.
    for (let i = 0; i < 100; i++) {
      sizes.typed('t', i % 2 === 0 ? W : D)
      vi.advanceTimersByTime(100)
    }
    expect(applied).toEqual([])
    expect(sizes.sizerOf('t')).toBe(D)
  })

  it('"Fit to this screen" takes at once; not for a view with no size for the tab, nor a hidden one', () => {
    const { sizes, applied } = policy()
    sizes.report('t', D, 120, 40)
    sizes.report('t', W, 50, 30)
    expect(sizes.take('t', W2)).toBe(false)
    expect(sizes.take('nope', W)).toBe(false)
    expect(sizes.take('t', W)).toBe(true)
    sizes.visible(D, false)
    expect(sizes.take('t', D)).toBe(false)
    expect(applied).toEqual(['t 120x40', 't 50x30'])
  })

  it('falls back to the remaining visible view active last when the sizer leaves', () => {
    const { sizes, applied } = policy()
    sizes.report('t', D, 120, 40)
    sizes.report('t', W2, 70, 20)
    sizes.report('t', W, 50, 30)
    sizes.take('t', W)
    // The desktop typed after the second browser reported: it was active last.
    sizes.typed('t', D)
    applied.length = 0
    sizes.viewGone(W)
    expect(applied).toEqual(['t 120x40'])
    expect(sizes.sizerOf('t')).toBe(D)
    // A view that leaves without sizing anything changes nothing.
    sizes.viewGone(W2)
    sizes.viewGone('web:9')
    expect(applied).toEqual(['t 120x40'])
  })

  it('a hidden window never sizes: hiding the sizer falls back, its resizes and typing do nothing, showing again takes only an unsized tab', () => {
    const { sizes, applied } = policy()
    sizes.report('t', D, 120, 40)
    sizes.report('t', W, 50, 30)
    applied.length = 0
    sizes.visible(D, false)
    expect(sizes.sizerOf('t')).toBe(W)
    sizes.report('t', D, 200, 60)
    sizes.typed('t', D)
    vi.advanceTimersByTime(TAKE_DEBOUNCE_MS * 2)
    expect(applied).toEqual(['t 50x30'])
    // Shown again: the browser still sizes the tab (it is visible), so the desktop waits for a take.
    sizes.visible(D, true)
    expect(applied).toEqual(['t 50x30'])
    sizes.typed('t', D)
    vi.advanceTimersByTime(TAKE_DEBOUNCE_MS)
    expect(applied).toEqual(['t 50x30', 't 200x60'])
  })

  it('with no visible view left the size stays; the first view shown again takes it', () => {
    const { sizes, applied } = policy()
    sizes.report('t', D, 120, 40)
    sizes.report('t', W, 50, 30)
    sizes.take('t', W)
    sizes.visible(D, false)
    applied.length = 0
    sizes.visible(W, false)
    expect(applied).toEqual([])
    expect(sizes.sizerOf('t')).toBeUndefined()
    sizes.visible(D, true)
    expect(applied).toEqual(['t 120x40'])
  })

  it("a hidden view that is the tab's only view still sizes it (web access off, a minimized window)", () => {
    const { sizes, applied } = policy()
    sizes.visible(D, false)
    sizes.report('t', D, 120, 40)
    sizes.report('t', D, 100, 40)
    expect(applied).toEqual(['t 120x40', 't 100x40'])
    // A visible browser joins: it sizes the tab at once (nobody visible does). It leaves while the
    // desktop is still minimized: the desktop, alone again, sizes it.
    sizes.report('t', W, 50, 30)
    expect(sizes.sizerOf('t')).toBe(W)
    sizes.viewGone(W)
    expect(applied).toEqual(['t 120x40', 't 100x40', 't 50x30', 't 100x40'])
  })

  it('a leaving or hidden view loses its pending take; a closed tab forgets its timers', () => {
    const { sizes, applied } = policy()
    sizes.report('t', D, 120, 40)
    sizes.report('t', W, 50, 30)
    sizes.report('u', D, 120, 40)
    sizes.report('u', W, 50, 30)
    applied.length = 0
    sizes.typed('t', W)
    sizes.typed('u', W)
    sizes.visible(W, false)
    sizes.typed('t', W2)
    vi.advanceTimersByTime(TAKE_DEBOUNCE_MS)
    sizes.visible(W, true)
    sizes.typed('t', W)
    sizes.tabGone('t')
    sizes.typed('u', W)
    sizes.viewGone(W)
    vi.advanceTimersByTime(TAKE_DEBOUNCE_MS * 2)
    expect(applied).toEqual([])
  })
})

describe('TabManager: the pty takes the sizing view, the desktop gets size items in its stream', () => {
  const P = 'aaaaaaaaaaaaaaaa'
  let root: string
  let backend: FakePtyBackend
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-sizes-')))
    backend = new FakePtyBackend()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(root, { recursive: true, force: true })
  })

  function manager() {
    const events: Array<IpcEventMap['tabs.data']> = []
    const tapped: string[] = []
    const tabs = new TabManager({
      backend,
      projectPath: (id) => (id === P ? root : undefined),
      loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/u' }),
      hooksPath: '/data/hooks.json',
      binDir: '/data/bin',
      sock: () => undefined,
      emit: <C extends EventChannel>(_p: string, channel: C, payload: IpcEventMap[C]) => {
        if (channel === 'tabs.data') events.push(payload as IpcEventMap['tabs.data'])
      },
      log: () => undefined,
      terminalTap: {
        spawned: (id, c, r) => tapped.push(`spawned ${c}x${r}`),
        data: (_id, d) => tapped.push(`data ${d}`),
        resized: (_id, c, r) => tapped.push(`resized ${c}x${r}`),
        closed: () => tapped.push('closed')
      }
    })
    return { tabs, events, tapped }
  }

  it("a remote view's resize does not resize the pty; its typing take does, and the desktop gets the size in order", async () => {
    const { tabs, events, tapped } = manager()
    const tab = tabs.create(P, { kind: 'shell' })
    const pty = backend.last
    tabs.resize(P, tab.id, 120, 40, D)
    tabs.resize(P, tab.id, 50, 30, W)
    expect(pty.resizes).toEqual([[120, 40]])
    pty.emit('before')
    await vi.advanceTimersByTimeAsync(20)
    tabs.viewInput(P, tab.id, 'x', W)
    tabs.viewInput(P, tab.id, 'y', W)
    await vi.advanceTimersByTimeAsync(TAKE_DEBOUNCE_MS)
    expect(pty.resizes).toEqual([[120, 40], [50, 30]])
    expect(tabs.sizerOf(tab.id)).toBe(W)
    expect(events).toEqual([
      { tabId: tab.id, data: '', cols: 120, rows: 40 },
      { tabId: tab.id, data: 'before' },
      { tabId: tab.id, data: '', cols: 50, rows: 30 }
    ])
    // The same order for the mirror (and so for every remote view).
    expect(tapped).toEqual(['spawned 80x24', 'resized 120x40', 'data before', 'resized 50x30'])
  })

  it('fit, fallback on disconnect, and a junk or foreign size never remembered', () => {
    const { tabs, events } = manager()
    const tab = tabs.create(P, { kind: 'shell' })
    const pty = backend.last
    tabs.resize(P, tab.id, 120, 40, D)
    tabs.resize(P, tab.id, 0, 30, W)
    tabs.resize('bbbbbbbbbbbbbbbb', tab.id, 50, 30, W)
    expect(tabs.fit(P, tab.id, W)).toBe(false)
    tabs.resize(P, tab.id, 50, 30, W)
    expect(tabs.fit('bbbbbbbbbbbbbbbb', tab.id, W)).toBe(false)
    expect(tabs.fit(P, tab.id, W)).toBe(true)
    // Fitting again at the size the pty has is no new item.
    expect(tabs.fit(P, tab.id, W)).toBe(true)
    tabs.viewGone(W)
    expect(pty.resizes).toEqual([[120, 40], [50, 30], [120, 40]])
    expect(events.map((e) => `${e.cols}x${e.rows}`)).toEqual(['120x40', '50x30', '120x40'])
  })

  it('a hidden desktop never sizes while a browser is visible', () => {
    const { tabs } = manager()
    const tab = tabs.create(P, { kind: 'shell' })
    const pty = backend.last
    tabs.resize(P, tab.id, 120, 40, D)
    tabs.resize(P, tab.id, 50, 30, W)
    tabs.viewVisible(D, false)
    tabs.resize(P, tab.id, 200, 60, D)
    expect(tabs.fit(P, tab.id, D)).toBe(false)
    expect(pty.resizes).toEqual([[120, 40], [50, 30]])
  })

  it("a restart spawns at the sizing view's size and tells the desktop", () => {
    const { tabs, events, tapped } = manager()
    const tab = tabs.create(P, { kind: 'shell' })
    tabs.resize(P, tab.id, 50, 30, W)
    backend.last.exit(0)
    events.length = 0
    tapped.length = 0
    tabs.restart(P, tab.id)
    expect(backend.last.options.cols).toBe(50)
    expect(tapped).toEqual(['spawned 50x30'])
    expect(events).toEqual([{ tabId: tab.id, data: '', cols: 50, rows: 30 }])
  })

  it('a closed tab forgets its sizes and pending takes', async () => {
    const { tabs } = manager()
    const tab = tabs.create(P, { kind: 'shell' })
    tabs.resize(P, tab.id, 120, 40, D)
    tabs.resize(P, tab.id, 50, 30, W)
    tabs.viewInput(P, tab.id, 'x', W)
    tabs.close(P, tab.id)
    await vi.advanceTimersByTimeAsync(TAKE_DEBOUNCE_MS)
    expect(tabs.sizerOf(tab.id)).toBeUndefined()
  })
})

describe('DesktopFlow: a resync carries the sizes', () => {
  it('the snapshot carries its size and a size item of the join reaches the desktop in order', () => {
    const views: MirrorView[] = []
    const out: unknown[] = []
    const f = new DesktopFlow({
      emit: (id, data, reset, size) => out.push([id, data, reset, size]),
      join: (_id, v) => {
        views.push(v)
        return () => undefined
      },
      seq: () => 7,
      log: () => undefined
    })
    f.take('t')
    expect(f.passes('t')).toBe(true)
    f.resync('t')
    expect(f.passes('t')).toBe(false)
    expect(f.passes('other')).toBe(true)
    views[0]!.snapshot({ seq: 4, cols: 100, rows: 30, data: 'screen' })
    views[0]!.item({ seq: 5, kind: 'data', data: 'a' })
    views[0]!.item({ seq: 6, kind: 'resize', cols: 60, rows: 20 })
    views[0]!.item({ seq: 7, kind: 'spawn', cols: 80, rows: 24 })
    expect(out).toEqual([
      ['t', 'screen', true, { cols: 100, rows: 30 }],
      ['t', 'a', false, undefined],
      ['t', '', false, { cols: 60, rows: 20 }],
      ['t', '', false, { cols: 80, rows: 24 }]
    ])
    // Caught up at the newest item: live again, sizes go direct.
    expect(f.passes('t')).toBe(true)
  })
})

describe('drawAt: the page draws at the pty size', () => {
  it('scales a larger pty down to the pane, letterboxes a smaller one, offers a fit when they differ', () => {
    expect(drawAt(undefined, { cols: 80, rows: 24 })).toEqual({ scale: 1, fit: false })
    expect(drawAt({ cols: 80, rows: 24 }, undefined)).toEqual({ scale: 1, fit: false })
    expect(drawAt({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toEqual({ scale: 1, fit: false })
    expect(drawAt({ cols: 160, rows: 48 }, { cols: 80, rows: 24 })).toEqual({ scale: 1, fit: true })
    expect(drawAt({ cols: 40, rows: 24 }, { cols: 80, rows: 24 })).toEqual({ scale: 0.5, fit: true })
    expect(drawAt({ cols: 80, rows: 12 }, { cols: 40, rows: 24 })).toEqual({ scale: 0.5, fit: true })
  })
})
