// Terminal size per view (design-web.md §5.2 "Size", plan Task 15): the policy on its own
// (TerminalSizes), TabManager applying it to the pty with size items in the desktop's stream, the
// desktop's resync carrying sizes, and the page drawing at the pty's size (drawAt).
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SERVER_INITIAL_COLS, SERVER_INITIAL_ROWS, TabManager } from '../../src/main/tabs/tab-manager'
import { TAKE_DEBOUNCE_MS, TerminalSizes } from '../../src/main/tabs/terminal-sizes'
import { DesktopFlow } from '../../src/main/terminals/desktop-flow'
import type { MirrorView } from '../../src/main/terminals/mirror'
import { drawAt, MIN_DRAW_SCALE } from '../../src/renderer/tabs/terminal-draw'
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

  it('a focus or click take (tabs.fit) wins at once over a pending typing take; a hidden view cannot take', () => {
    const { sizes, applied } = policy()
    sizes.report('t', D, 120, 40)
    sizes.report('t', W, 50, 30)
    sizes.report('t', W2, 90, 30)
    sizes.typed('t', W)
    expect(sizes.take('t', W2)).toBe(true)
    vi.advanceTimersByTime(TAKE_DEBOUNCE_MS)
    expect(sizes.sizerOf('t')).toBe(W2)
    expect(applied).toEqual(['t 120x40', 't 90x30'])
    sizes.visible(D, false)
    expect(sizes.take('t', D)).toBe(false)
    expect(sizes.sizerOf('t')).toBe(W2)
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

describe('TerminalSizes: a view that is never measured (server mode, design-web.md §9.8)', () => {
  function serverPolicy() {
    const applied: string[] = []
    const sizes = new TerminalSizes({
      apply: (tabId, cols, rows) => applied.push(`${tabId} ${cols}x${rows}`),
      measured: (viewId) => viewId.startsWith('web:'),
      debounceMs: 0
    })
    return { sizes, applied }
  }

  it("the hidden page's reports are dropped: it never sizes, not as a key's only view, nor hidden, nor by typing or Fit", () => {
    const { sizes, applied } = serverPolicy()
    sizes.report('t', D, 60, 20)
    sizes.visible(D, false)
    sizes.report('t', D, 61, 20)
    sizes.visible(D, true)
    sizes.typed('t', D)
    expect(sizes.take('t', D)).toBe(false)
    expect(applied).toEqual([])
    expect(sizes.sizerOf('t')).toBeUndefined()
    expect(sizes.sizeOf('t', D)).toBeUndefined()
  })

  it('a browser sizes; its size stays on the pty after it leaves (nothing to fall back to), and the next browser takes it', () => {
    const { sizes, applied } = serverPolicy()
    sizes.report('t', D, 60, 20)
    sizes.report('t', W, 100, 30)
    expect(applied).toEqual(['t 100x30'])
    sizes.viewGone(W)
    sizes.report('t', D, 62, 21)
    expect(applied).toEqual(['t 100x30'])
    expect(sizes.sizerOf('t')).toBeUndefined()
    sizes.report('t', W2, 90, 25)
    expect(applied).toEqual(['t 100x30', 't 90x25'])
    expect(sizes.sizerOf('t')).toBe(W2)
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
    // The desktop sized the tab first (`local`: it fits its pane itself); then it follows the browser.
    expect(events).toEqual([
      { tabId: tab.id, data: '', cols: 120, rows: 40, local: true },
      { tabId: tab.id, data: 'before' },
      { tabId: tab.id, data: '', cols: 50, rows: 30 }
    ])
    // The same order for the mirror (and so for every remote view).
    expect(tapped).toEqual(['spawned 80x24', 'resized 120x40', 'data before', 'resized 50x30'])
  })

  it("a view's focus or mouse report and its query replies never take the size, nor cancel another view's take", async () => {
    const { tabs } = manager()
    const tab = tabs.create(P, { kind: 'shell' })
    const pty = backend.last
    tabs.resize(P, tab.id, 120, 40, D)
    tabs.resize(P, tab.id, 50, 30, W)
    // A phone that only shows the tab: clicked into (focus), scrolled (SGR mouse), and its xterm
    // answering the program's start-up queries (DA1, a cursor position report).
    tabs.viewInput(P, tab.id, '\x1b[I', W)
    tabs.viewInput(P, tab.id, '\x1b[<64;10;5M', W)
    tabs.viewInput(P, tab.id, '\x1b[?1;2c\x1b[3;1R', W)
    await vi.advanceTimersByTimeAsync(TAKE_DEBOUNCE_MS * 2)
    expect(pty.resizes).toEqual([[120, 40]])
    expect(tabs.sizerOf(tab.id)).toBe(D)
    // The phone types for real; the desktop's own automatic reply meanwhile does not cancel the take.
    tabs.viewInput(P, tab.id, 'x', W)
    tabs.viewInput(P, tab.id, '\x1b[?1;2c', D)
    await vi.advanceTimersByTimeAsync(TAKE_DEBOUNCE_MS)
    expect(pty.resizes).toEqual([[120, 40], [50, 30]])
    expect(tabs.sizerOf(tab.id)).toBe(W)
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

  it('an exited tab still gets the desktop its size (no pty to resize), and no remote item', () => {
    const { tabs, events, tapped } = manager()
    const tab = tabs.create(P, { kind: 'shell' })
    tabs.resize(P, tab.id, 100, 30, D)
    backend.last.exit(0)
    events.length = 0
    tapped.length = 0
    tabs.resize(P, tab.id, 90, 25, D)
    expect(events).toEqual([{ tabId: tab.id, data: '', cols: 90, rows: 25, local: true }])
    expect(tapped).toEqual([])
    // A phone sizing the exited tab, then the desktop pressing "Fit to this screen".
    tabs.resize(P, tab.id, 50, 30, W)
    tabs.resize(P, tab.id, 80, 24, D)
    events.length = 0
    expect(tabs.fit(P, tab.id, D)).toBe(true)
    expect(events).toEqual([{ tabId: tab.id, data: '', cols: 80, rows: 24, local: true }])
  })

  it('web access off: the desktop is the only view, every size item says it fits its pane itself', () => {
    const { tabs, events } = manager()
    const tab = tabs.create(P, { kind: 'shell' })
    // A window drag: each report resizes the pty at once and is marked local, so the page never
    // waits for (or is pulled back by) an item from earlier in the drag.
    tabs.resize(P, tab.id, 120, 40, D)
    tabs.resize(P, tab.id, 121, 40, D)
    tabs.resize(P, tab.id, 125, 41, D)
    tabs.viewInput(P, tab.id, 'x', D)
    // Minimized: the only view still sizes the tab (a restart in a hidden window included).
    tabs.viewVisible(D, false)
    tabs.resize(P, tab.id, 100, 30, D)
    backend.last.exit(0)
    tabs.restart(P, tab.id)
    expect(backend.last.options.cols).toBe(100)
    expect(events.map((e) => `${e.cols}x${e.rows} ${e.local === true}`)).toEqual([
      '120x40 true',
      '121x40 true',
      '125x41 true',
      '100x30 true',
      '100x30 true'
    ])
  })

  it('the desktop follows while a browser sizes the tab and fits itself again once it sizes it', async () => {
    const { tabs, events, tapped } = manager()
    const tab = tabs.create(P, { kind: 'shell' })
    const pty = backend.last
    tabs.resize(P, tab.id, 120, 40, D)
    // The browser reports the same size: nothing to resize when it takes, but the desktop must
    // hear it no longer sizes the tab (a resize of its own would otherwise fit locally).
    tabs.resize(P, tab.id, 120, 40, W)
    events.length = 0
    expect(tabs.fit(P, tab.id, W)).toBe(true)
    expect(events).toEqual([{ tabId: tab.id, data: '', cols: 120, rows: 40 }])
    // Following: the desktop's own resize is only remembered.
    tabs.resize(P, tab.id, 130, 40, D)
    expect(pty.resizes).toEqual([[120, 40]])
    // The desktop types and takes the size back: local again.
    tabs.viewInput(P, tab.id, 'x', D)
    await vi.advanceTimersByTimeAsync(TAKE_DEBOUNCE_MS)
    expect(events.slice(1)).toEqual([{ tabId: tab.id, data: '', cols: 130, rows: 40, local: true }])
    // The browser takes again at the desktop's size, then leaves: the desktop sizes again at the
    // same size, which is a desktop-only item (no pty resize, nothing in the mirror's stream).
    tabs.resize(P, tab.id, 130, 40, W)
    expect(tabs.fit(P, tab.id, W)).toBe(true)
    tapped.length = 0
    events.length = 0
    tabs.viewGone(W)
    expect(tabs.sizerOf(tab.id)).toBe(D)
    expect(events).toEqual([{ tabId: tab.id, data: '', cols: 130, rows: 40, local: true }])
    expect(tapped).toEqual([])
    expect(pty.resizes).toEqual([[120, 40], [130, 40]])
    // Told once: the desktop sizing again at the same size is no new item.
    events.length = 0
    expect(tabs.fit(P, tab.id, D)).toBe(true)
    expect(events).toEqual([])
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
  const none = { cropCols: false, cropRows: false }
  it('scales a larger pty down to the pane, letterboxes a smaller one, offers a fit when they differ', () => {
    expect(drawAt(undefined, { cols: 80, rows: 24 })).toEqual({ scale: 1, fit: false, ...none })
    expect(drawAt({ cols: 80, rows: 24 }, undefined)).toEqual({ scale: 1, fit: false, ...none })
    expect(drawAt({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toEqual({ scale: 1, fit: false, ...none })
    expect(drawAt({ cols: 160, rows: 48 }, { cols: 80, rows: 24 })).toEqual({ scale: 1, fit: true, ...none })
    expect(drawAt({ cols: 60, rows: 24 }, { cols: 80, rows: 24 })).toEqual({ scale: 0.75, fit: true, ...none })
    expect(drawAt({ cols: 80, rows: 18 }, { cols: 40, rows: 24 })).toEqual({ scale: 0.75, fit: true, ...none })
  })

  it(`never scales below MIN_DRAW_SCALE (${MIN_DRAW_SCALE}): the grid is cropped in the direction that does not fit`, () => {
    expect(drawAt({ cols: 70, rows: 24 }, { cols: 100, rows: 24 })).toEqual({ scale: 0.7, fit: true, ...none })
    expect(drawAt({ cols: 45, rows: 24 }, { cols: 100, rows: 24 })).toEqual({
      scale: MIN_DRAW_SCALE,
      fit: true,
      cropCols: true,
      cropRows: false
    })
    expect(drawAt({ cols: 100, rows: 10 }, { cols: 100, rows: 40 })).toEqual({
      scale: MIN_DRAW_SCALE,
      fit: true,
      cropCols: false,
      cropRows: true
    })
    expect(drawAt({ cols: 10, rows: 5 }, { cols: 100, rows: 40 })).toMatchObject({ cropCols: true, cropRows: true })
  })
})

describe('TabManager in server mode: only browsers size a pty (design-web.md §9.8)', () => {
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

  function manager(server: boolean) {
    const events: Array<IpcEventMap['tabs.data']> = []
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
      server
    })
    return { tabs, events }
  }

  it('a tab nobody sized starts at 120x40 and the hidden page is told the size (it follows, never local)', () => {
    const { tabs, events } = manager(true)
    const tab = tabs.create(P, { kind: 'shell' })
    expect(backend.last.options.cols).toBe(SERVER_INITIAL_COLS)
    expect(backend.last.options.rows).toBe(SERVER_INITIAL_ROWS)
    expect([SERVER_INITIAL_COLS, SERVER_INITIAL_ROWS]).toEqual([120, 40])
    expect(events).toEqual([{ tabId: tab.id, data: '', cols: 120, rows: 40 }])
  })

  it("the desktop view is never measured: its resize, typing, hiding and Fit never size the pty, even as the only view", async () => {
    const { tabs, events } = manager(true)
    const tab = tabs.create(P, { kind: 'shell' })
    const pty = backend.last
    events.length = 0
    tabs.resize(P, tab.id, 58, 18, D)
    tabs.viewInput(P, tab.id, 'x', D)
    tabs.viewVisible(D, false)
    tabs.viewVisible(D, true)
    expect(tabs.fit(P, tab.id, D)).toBe(false)
    await vi.advanceTimersByTimeAsync(TAKE_DEBOUNCE_MS * 2)
    expect(pty.resizes).toEqual([])
    expect(tabs.sizerOf(tab.id)).toBeUndefined()
    expect(events).toEqual([])
  })

  it('a browser sizes the tab; its size survives it leaving, a restart with none attached gets 120x40', () => {
    const { tabs, events } = manager(true)
    const tab = tabs.create(P, { kind: 'shell' })
    const pty = backend.last
    tabs.resize(P, tab.id, 58, 18, D)
    tabs.resize(P, tab.id, 100, 30, W)
    expect(pty.resizes).toEqual([[100, 30]])
    expect(tabs.sizerOf(tab.id)).toBe(W)
    // The hidden page follows the browser's size: never `local`.
    expect(events.every((e) => e.local === undefined)).toBe(true)
    tabs.viewGone(W)
    tabs.resize(P, tab.id, 60, 20, D)
    expect(pty.resizes).toEqual([[100, 30]])
    // The size a browser gave a running tab stays while it runs; a restart with that browser
    // still attached spawns at its size.
    tabs.resize(P, tab.id, 90, 25, W2)
    pty.exit(0)
    tabs.restart(P, tab.id)
    expect(backend.last.options.cols).toBe(90)
    // Restarted overnight with no browser attached: the server default, not the hidden page's size.
    tabs.viewGone(W2)
    backend.last.exit(0)
    events.length = 0
    tabs.restart(P, tab.id)
    expect([backend.last.options.cols, backend.last.options.rows]).toEqual([120, 40])
    expect(events).toEqual([{ tabId: tab.id, data: '', cols: 120, rows: 40 }])
  })

  it('the desktop keeps today\'s behaviour: a new tab is 80x24, untold, and the hidden Keep running view sizes as the only view', () => {
    const { tabs, events } = manager(false)
    const tab = tabs.create(P, { kind: 'shell' })
    expect([backend.last.options.cols, backend.last.options.rows]).toEqual([80, 24])
    expect(events).toEqual([])
    tabs.viewVisible(D, false)
    tabs.resize(P, tab.id, 100, 30, D)
    expect(backend.last.resizes).toEqual([[100, 30]])
    expect(tabs.sizerOf(tab.id)).toBe(D)
    expect(events).toEqual([{ tabId: tab.id, data: '', cols: 100, rows: 30, local: true }])
  })
})
