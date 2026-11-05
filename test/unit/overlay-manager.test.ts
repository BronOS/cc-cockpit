import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventChannel, IpcEventMap, OverlayInfo } from '../../src/shared/ipc'
import {
  chordOfInput,
  KILL_GRACE_MS,
  MAX_OVERLAY_MESSAGE_LENGTH,
  MAX_QUEUED_OVERLAY_LENGTH,
  MAX_QUEUED_OVERLAY_MESSAGES,
  MAX_RESULT_BYTES,
  OverlayManager,
  overlayUrlOf,
  parseOverlaySpec,
  sameSite,
  type DiscussSessions,
  type OverlayChannel,
  type OverlayResult,
  type OverlayTypeButtons,
  type OverlayTypeQuery,
  type UrlView,
  type UrlViewFactory,
  type ViewBounds
} from '../../src/main/overlays/overlay-manager'
import { WebviewManager, type WebviewView } from '../../src/main/webview/webview-manager'
import { OVERLAY_CLICK_TIMEOUT_MS, type CleanTypeButton } from '../../src/shared/overlay-buttons'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

const W1 = 1
const W2 = 2

class FakeView implements UrlView {
  bounds: ViewBounds[] = []
  visible = true
  focused = 0
  destroyed = 0
  constructor(
    readonly windowId: number,
    readonly url: string,
    readonly onChord: (chord: string) => boolean,
    readonly onGone: () => void,
    /** The page's first load ended (did-finish-load / did-fail-load in the real view). */
    readonly onLoaded: () => void = () => {}
  ) {}
  setBounds(bounds: ViewBounds): void {
    this.bounds.push(bounds)
  }
  setVisible(visible: boolean): void {
    this.visible = visible
  }
  focus(): void {
    this.focused++
  }
  destroy(): void {
    this.destroyed++
  }
}

class FakeViews implements UrlViewFactory {
  readonly created: FakeView[] = []
  readonly windowFocus: number[] = []
  create(
    windowId: number,
    url: string,
    onChord: (chord: string) => boolean,
    onGone: () => void,
    onLoaded?: () => void
  ): FakeView {
    const view = new FakeView(windowId, url, onChord, onGone, onLoaded)
    this.created.push(view)
    return view
  }
  focusWindow(windowId: number): void {
    this.windowFocus.push(windowId)
  }
  get last(): FakeView {
    const view = this.created.at(-1)
    if (!view) throw new Error('no view created')
    return view
  }
}

interface Emitted {
  windowId: number
  channel: EventChannel
  payload: unknown
}

let dir: string
let backend: FakePtyBackend
let views: FakeViews
let events: Emitted[]
/** Default key table: Esc pops, Cmd+Shift+W closes the top (as main's registry resolves them). */
let keyTable: Record<string, string>
/** Windows that are no longer open (the opener raced a window close). */
let closedWindows: Set<number>
/** The window token each terminal overlay's env() was asked for, in spawn order. */
let envTokens: string[]

beforeEach(() => {
  vi.useFakeTimers()
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-overlays-')))
  backend = new FakePtyBackend()
  views = new FakeViews()
  events = []
  closedWindows = new Set()
  keyTable = { escape: 'overlay.pop', 'shift+meta+w': 'overlay.closeTop', 'meta+t': 'tab.newClaude' }
  envTokens = []
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function manager(): OverlayManager {
  return new OverlayManager({
    backend,
    views,
    isWindowOpen: (windowId) => !closedWindows.has(windowId),
    env: (token) => {
      envTokens.push(token)
      return { PATH: '/usr/bin', TERM: 'xterm-256color' }
    },
    emit: <C extends EventChannel>(windowId: number, channel: C, payload: IpcEventMap[C]) => {
      events.push({ windowId, channel, payload })
    },
    commandForChord: (_windowId, chord) => keyTable[chord],
    log: () => {}
  })
}

/** Track a promise's settlement synchronously-ish (after microtasks flush). */
function track(p: Promise<OverlayResult>): { results: OverlayResult[]; errors: unknown[] } {
  const out = { results: [] as OverlayResult[], errors: [] as unknown[] }
  p.then(
    (r) => out.results.push(r),
    (e: unknown) => out.errors.push(e)
  )
  return out
}

const flush = (): Promise<void> => Promise.resolve().then(() => undefined)

const terminal = (argv: string[] = ['true']) => ({ kind: 'terminal', argv, cwd: dir })
const url = (u = 'https://example.com/page') => ({ kind: 'url', url: u })
const html = (h = '<p>hi</p>') => ({ kind: 'html', html: h })

function lastStack(windowId: number): OverlayInfo[] {
  const e = events.filter((x) => x.windowId === windowId && x.channel === 'overlays.updated').at(-1)
  return (e?.payload as OverlayInfo[] | undefined) ?? []
}

describe('stack', () => {
  it('pushes overlays per window, newest on top, and tells only that window', () => {
    const m = manager()
    void m.open(W1, terminal(['a']), 'test')
    void m.open(W1, url(), 'test')
    void m.open(W2, html(), 'test')
    expect(m.infos(W1).map((o) => o.kind)).toEqual(['terminal', 'url'])
    expect(m.infos(W2).map((o) => o.kind)).toEqual(['html'])
    expect(m.topKind(W1)).toBe('url')
    expect(m.topKind(W2)).toBe('html')
    expect(lastStack(W1).map((o) => o.kind)).toEqual(['terminal', 'url'])
    expect(lastStack(W2).map((o) => o.kind)).toEqual(['html'])
    expect(m.topKind(3)).toBeUndefined()
  })

  it('closing a lower overlay keeps the order of the rest', async () => {
    const m = manager()
    const a = track(m.open(W1, { ...html(), title: 'a' }, 'test'))
    void m.open(W1, { ...html(), title: 'b' }, 'test')
    void m.open(W1, { ...html(), title: 'c' }, 'test')
    const [first] = m.infos(W1)
    expect(m.close(W1, first!.id)).toBe(true)
    await flush()
    expect(a.results).toEqual([{ kind: 'dismissed' }])
    expect(m.infos(W1).map((o) => o.title)).toEqual(['b', 'c'])
  })

  it('focus brings an overlay to the top of its own window only; a no-op for the top one or an ended one', async () => {
    const m = manager()
    void m.open(W1, url('https://a.example/'), 'test')
    const a = views.last
    const b = track(m.open(W1, { ...html(), title: 'b' }, 'test'))
    void m.open(W1, { ...html(), title: 'c' }, 'test')
    void m.open(W2, html(), 'test')
    // Loaded while covered: it stays hidden and the keyboard stays where it is.
    a.onLoaded()
    const [first, second] = m.infos(W1)
    expect(a.visible).toBe(false)
    // Another window's id is unknown here.
    expect(m.focus(W2, first!.id)).toBe(false)
    expect(m.focus(W1, 'nope')).toBe(false)
    const updates = (): number => events.filter((e) => e.windowId === W1 && e.channel === 'overlays.updated').length
    const before = updates()
    // To the top: the url view shows and gets the keyboard; the renderer gets the new order.
    expect(m.focus(W1, first!.id)).toBe(true)
    expect(m.infos(W1).map((o) => o.title)).toEqual(['b', 'c', 'https://a.example/'])
    expect(lastStack(W1).at(-1)!.id).toBe(first!.id)
    expect(a.visible).toBe(true)
    expect(a.focused).toBe(2)
    expect(updates()).toBe(before + 1)
    // Already on top: nothing changes, nothing sent.
    expect(m.focus(W1, first!.id)).toBe(true)
    expect(updates()).toBe(before + 1)
    expect(a.focused).toBe(2)
    // Covered again by focusing another: the url view hides; nothing ends.
    expect(m.focus(W1, second!.id)).toBe(true)
    expect(a.visible).toBe(false)
    expect(m.infos(W1)).toHaveLength(3)
    expect(m.infos(W2)).toHaveLength(1)
    // Ended: false.
    m.close(W1, second!.id)
    await flush()
    expect(b.results).toEqual([{ kind: 'dismissed' }])
    expect(m.focus(W1, second!.id)).toBe(false)
  })

  it('titles default from the spec and a caller title is kept', () => {
    const m = manager()
    void m.open(W1, terminal(['git', 'diff', '--', 'a b']), 'test')
    void m.open(W1, { ...url('https://example.com/x'), title: 'Docs' }, 'test')
    void m.open(W1, html(), 'test')
    expect(m.infos(W1).map((o) => o.title)).toEqual(['git diff -- a b', 'Docs', 'Overlay'])
  })

  it('only the top url view is visible and has the keyboard; the window gets it back after', () => {
    const m = manager()
    void m.open(W1, url('https://a.example/'), 'test')
    const a = views.last
    // Hidden while it loads (it would cover the loader), but it has the keyboard already.
    expect(a.visible).toBe(false)
    expect(a.focused).toBe(1)
    a.onLoaded()
    expect(a.visible).toBe(true)
    expect(a.focused).toBe(2)
    // A terminal overlay over it must not be covered by the native view.
    void m.open(W1, terminal(['cat']), 'test')
    expect(a.visible).toBe(false)
    expect(views.windowFocus).toEqual([W1])
    // It ends: the url view is the top again.
    backend.last.exit(0)
    expect(a.visible).toBe(true)
    expect(a.focused).toBe(3)
    expect(m.pop(W1)).toBe(true)
    expect(a.destroyed).toBe(1)
    expect(views.windowFocus).toEqual([W1, W1])
    expect(lastStack(W1)).toEqual([])
  })
})

// Review finding (ext round 8): main's `overlays.updated` listener hides the window's webview
// panels (index.ts: setWindowCovered), and hiding a shown one hands the keyboard to the shell
// page. When that ran after the url view was focused, the overlay opened over a visible browser
// panel got no keystrokes. Wired here as index.ts wires them, with both managers' fakes.
describe('a url overlay over a visible webview panel', () => {
  it('keeps the keyboard: the panel hides first, then the overlay is focused', async () => {
    const focus: string[] = []
    const fakeView = (): WebviewView => ({
      load: async () => {},
      back: () => {},
      forward: () => {},
      reload: () => {},
      current: () => ({ url: '', title: '' }),
      // The panel has the keyboard when the overlay opens.
      isFocused: () => true,
      setBounds: () => {},
      setVisible: () => {},
      destroy: () => {}
    })
    const webviews = new WebviewManager({
      views: { create: () => fakeView() },
      openExternal: () => {},
      isWindowOpen: () => true,
      focusShell: () => focus.push('shell'),
      homeDir: () => dir,
      log: () => {}
    })
    await webviews.navigate({ windowId: W1, projectId: 'P1', pluginId: 'a.one', panelId: 'view' }, 'https://example.com/')
    webviews.setPlacement(W1, 'a.one', 'view', { bounds: { x: 0, y: 0, width: 100, height: 100 }, visible: true })
    expect(webviews.isShown(W1, 'a.one', 'view')).toBe(true)
    const focusingViews: UrlViewFactory = {
      create: (windowId, u, onChord, onGone) => {
        const view = views.create(windowId, u, onChord, onGone)
        view.focus = () => {
          view.focused++
          focus.push('overlay')
        }
        return view
      },
      focusWindow: (windowId) => {
        views.focusWindow(windowId)
        focus.push('window')
      }
    }
    const m = new OverlayManager({
      backend,
      views: focusingViews,
      isWindowOpen: () => true,
      env: () => ({ PATH: '/usr/bin' }),
      emit: <C extends EventChannel>(windowId: number, channel: C, payload: IpcEventMap[C]) => {
        if (channel === 'overlays.updated') webviews.setWindowCovered(windowId, (payload as OverlayInfo[]).length > 0)
      },
      commandForChord: () => undefined,
      log: () => {}
    })
    void m.open(W1, url('https://login.example/'), 'test')
    expect(webviews.isShown(W1, 'a.one', 'view')).toBe(false)
    expect(focus).toEqual(['shell', 'overlay'])
    // Closed again: the panel shows, the window's page gets the keyboard back.
    expect(m.pop(W1)).toBe(true)
    expect(webviews.isShown(W1, 'a.one', 'view')).toBe(true)
    expect(focus).toEqual(['shell', 'overlay', 'window'])
  })
})

// Review finding (phase 4): the same overlay in a window that is in the background. The panel's
// hand-back is deferred (focusDue) until the window is focused, and focusing the overlay's view
// focuses the window (browser-window-focus -> windowFocused), which used to give the keyboard to
// the shell page again.
describe('a url overlay over a visible webview panel in a background window', () => {
  it('keeps the keyboard when the window gains focus, and on a later return', async () => {
    const focus: string[] = []
    let windowFocused = false
    const fakeView = (): WebviewView => ({
      load: async () => {},
      back: () => {},
      forward: () => {},
      reload: () => {},
      current: () => ({ url: '', title: '' }),
      isFocused: () => true,
      setBounds: () => {},
      setVisible: () => {},
      destroy: () => {}
    })
    const webviews = new WebviewManager({
      views: { create: () => fakeView() },
      openExternal: () => {},
      isWindowOpen: () => true,
      isWindowFocused: () => windowFocused,
      focusShell: () => focus.push('shell'),
      homeDir: () => dir,
      log: () => {}
    })
    await webviews.navigate({ windowId: W1, projectId: 'P1', pluginId: 'a.one', panelId: 'view' }, 'https://example.com/')
    webviews.setPlacement(W1, 'a.one', 'view', { bounds: { x: 0, y: 0, width: 100, height: 100 }, visible: true })
    const focusingViews: UrlViewFactory = {
      create: (windowId, u, onChord, onGone) => {
        const view = views.create(windowId, u, onChord, onGone)
        view.focus = () => {
          view.focused++
          focus.push('overlay')
          // wc.focus() brings the window forward on macOS.
          windowFocused = true
          webviews.windowFocused(windowId)
        }
        return view
      },
      focusWindow: (windowId) => {
        views.focusWindow(windowId)
        focus.push('window')
      }
    }
    const m = new OverlayManager({
      backend,
      views: focusingViews,
      isWindowOpen: () => true,
      env: () => ({ PATH: '/usr/bin' }),
      emit: <C extends EventChannel>(windowId: number, channel: C, payload: IpcEventMap[C]) => {
        if (channel === 'overlays.updated') webviews.setWindowCovered(windowId, (payload as OverlayInfo[]).length > 0)
      },
      commandForChord: () => undefined,
      log: () => {}
    })
    void m.open(W1, url('https://login.example/'), 'test')
    // No 'shell' after 'overlay': the overlay keeps the keyboard.
    expect(focus).toEqual(['overlay'])
    // The user leaves and returns with the overlay still up: still the overlay's.
    windowFocused = false
    webviews.windowFocused(W1)
    expect(focus).toEqual(['overlay'])
    expect(m.pop(W1)).toBe(true)
    expect(focus).toEqual(['overlay', 'window'])
  })
})

describe('results per kind', () => {
  it('terminal: spawns argv in cwd with the given env, resolves with the exit code and closes', async () => {
    const m = manager()
    const ok = track(m.open(W1, terminal(['true']), 'test'))
    const pty = backend.last
    expect(pty.argv).toEqual(['true'])
    expect(pty.options.cwd).toBe(dir)
    expect(pty.options.env).toEqual({ PATH: '/usr/bin', TERM: 'xterm-256color' })
    pty.exit(0)
    const bad = track(m.open(W1, terminal(['false']), 'test'))
    backend.last.exit(1)
    await flush()
    expect(ok.results).toEqual([{ kind: 'exit', code: 0 }])
    expect(bad.results).toEqual([{ kind: 'exit', code: 1 }])
    expect(m.infos(W1)).toEqual([])
  })

  it('terminal: a program killed by a signal does not read as a clean exit', async () => {
    const m = manager()
    const r = track(m.open(W1, terminal(['sleep', '9']), 'test'))
    backend.last.exit(0, 15)
    await flush()
    expect(r.results).toEqual([{ kind: 'exit', code: 143 }])
  })

  it('terminal: output goes to the window, input / resize / ack to its own PTY', () => {
    const m = manager()
    void m.open(W1, terminal(['cat']), 'test')
    const pty = backend.last
    const id = m.infos(W1)[0]!.id
    pty.emit('hello')
    vi.advanceTimersByTime(20)
    expect(events.filter((e) => e.channel === 'overlays.data')).toEqual([
      { windowId: W1, channel: 'overlays.data', payload: { overlayId: id, data: 'hello' } }
    ])
    m.input(W1, id, 'x')
    m.resize(W1, id, 100, 30)
    m.ack(W1, id, 5)
    expect(pty.writes).toEqual(['x'])
    expect(pty.resizes).toEqual([[100, 30]])
    // Another window cannot reach it.
    m.input(W2, id, 'evil')
    m.resize(W2, id, 1, 1)
    expect(pty.writes).toEqual(['x'])
    expect(pty.resizes).toEqual([[100, 30]])
  })

  it('terminal: a program that cannot start rejects and leaves no overlay', async () => {
    const m = manager()
    backend.failWith = new Error('ENOENT')
    const r = track(m.open(W1, terminal(['nope']), 'test'))
    await flush()
    expect(r.errors).toHaveLength(1)
    expect(m.infos(W1)).toEqual([])
  })

  it('start: throws (not rejects) a program that cannot start, a bad spec or a gone window', async () => {
    // The new-tab menu's overlay entries do not wait for the result, so a failure must surface at
    // the call to reach the user's click (design §3 Custom commands).
    const m = manager()
    backend.failWith = new Error('ENOENT')
    expect(() => m.start(W1, terminal(['nope']), 'test')).toThrow('ENOENT')
    expect(() => m.start(W1, { kind: 'terminal', argv: [], cwd: dir }, 'test')).toThrow('argv')
    closedWindows.add(W2)
    expect(() => m.start(W2, terminal(['cat']), 'test')).toThrow('window is gone')
    expect(m.infos(W1)).toEqual([])
    // A good one is on the stack at once; its result comes when the program exits.
    const r = track(m.start(W1, { ...terminal(['lazygit']), title: 'Git' }, 'test'))
    expect(m.infos(W1)).toEqual([{ id: expect.any(String), kind: 'terminal', title: 'Git', size: 'default', loading: true }])
    backend.last.exit(3)
    await flush()
    expect(r.results).toEqual([{ kind: 'exit', code: 3 }])
    expect(m.infos(W1)).toEqual([])
  })

  it('url: dismissed when closed; the view is destroyed', async () => {
    const m = manager()
    const r = track(m.open(W1, url('https://example.com/a?b#c'), 'test'))
    expect(views.last.url).toBe('https://example.com/a?b#c')
    expect(m.close(W1, m.infos(W1)[0]!.id)).toBe(true)
    await flush()
    expect(r.results).toEqual([{ kind: 'dismissed' }])
    expect(views.last.destroyed).toBe(1)
  })

  it('a gone opener (peerGone aborted) dismisses the overlay and kills its program', async () => {
    const m = manager()
    const gone = new AbortController()
    const r = track(m.open(W1, { kind: 'url', url: 'https://example.com/' }, 'cli', gone.signal))
    expect(m.infos(W1)).toHaveLength(1)
    gone.abort()
    await flush()
    expect(r.results).toEqual([{ kind: 'dismissed' }])
    expect(m.infos(W1)).toEqual([])
    expect(views.last.destroyed).toBe(1)
    // Already aborted when the overlay is created (the login env wait outlived the caller).
    const r2 = track(m.open(W1, { kind: 'url', url: 'https://example.com/' }, 'cli', gone.signal))
    await flush()
    expect(r2.results).toEqual([{ kind: 'dismissed' }])
    expect(m.infos(W1)).toEqual([])
  })

  it('url: a page that dies by itself (crash, closed) settles as dismissed and leaves the stack', async () => {
    const m = manager()
    const lower = track(m.open(W1, html(), 'test'))
    const r = track(m.open(W1, url(), 'test'))
    const view = views.last
    view.onGone()
    await flush()
    expect(r.results).toEqual([{ kind: 'dismissed' }])
    expect(m.infos(W1).map((o) => o.kind)).toEqual(['html'])
    expect(lastStack(W1).map((o) => o.kind)).toEqual(['html'])
    expect(view.destroyed).toBe(1)
    // The `destroyed` our own destroy() triggers (and any later one) changes nothing.
    view.onGone()
    await flush()
    expect(r.results).toHaveLength(1)
    expect(view.destroyed).toBe(1)
    expect(lower.results).toEqual([])
  })

  it('url: bounds from the renderer reach the view, rounded; nonsense is dropped', () => {
    const m = manager()
    void m.open(W1, url(), 'test')
    const id = m.infos(W1)[0]!.id
    m.setBounds(W1, id, { x: 0.4, y: 30.6, width: 800, height: 570.2 })
    m.setBounds(W1, id, { x: NaN, y: 0, width: 1, height: 1 })
    m.setBounds(W1, id, { x: 0, y: 0, width: -1, height: 1 })
    m.setBounds(W1, id, { x: 0, y: 0, width: 1e9, height: 1 })
    m.setBounds(W2, id, { x: 0, y: 0, width: 5, height: 5 })
    expect(views.last.bounds).toEqual([{ x: 0, y: 31, width: 800, height: 570 }])
  })

  it('html: the page’s value closes it, copied as plain JSON', async () => {
    const m = manager()
    const r = track(m.open(W1, html(), 'test'))
    const id = m.infos(W1)[0]!.id
    expect(m.result(W1, id, { answer: 42, list: [1, 'two'] })).toBe(true)
    await flush()
    expect(r.results).toEqual([{ kind: 'value', value: { answer: 42, list: [1, 'two'] } }])
    expect(m.infos(W1)).toEqual([])
  })

  it('html: undefined is null; a value that is not JSON or too large is refused', async () => {
    const m = manager()
    const r = track(m.open(W1, html(), 'test'))
    const id = m.infos(W1)[0]!.id
    expect(m.result(W1, id, 1n)).toBe(false)
    expect(m.result(W1, id, 'x'.repeat(MAX_RESULT_BYTES))).toBe(false)
    expect(m.result(W2, id, 1)).toBe(false)
    expect(m.infos(W1)).toHaveLength(1)
    expect(m.result(W1, id, undefined)).toBe(true)
    await flush()
    expect(r.results).toEqual([{ kind: 'value', value: null }])
  })

  it('a result is only accepted from an html overlay', () => {
    const m = manager()
    void m.open(W1, terminal(['cat']), 'test')
    void m.open(W1, url(), 'test')
    for (const o of m.infos(W1)) expect(m.result(W1, o.id, 1)).toBe(false)
    expect(m.infos(W1)).toHaveLength(2)
  })
})

describe('keys', () => {
  it('Esc (pop) closes a url or html top as dismissed', async () => {
    const m = manager()
    const a = track(m.open(W1, html(), 'test'))
    const b = track(m.open(W1, url(), 'test'))
    expect(m.pop(W1)).toBe(true)
    expect(m.pop(W1)).toBe(true)
    expect(m.pop(W1)).toBe(false)
    await flush()
    expect(b.results).toEqual([{ kind: 'dismissed' }])
    expect(a.results).toEqual([{ kind: 'dismissed' }])
  })

  it('Esc does not close a terminal top (it belongs to the program), even over others', () => {
    const m = manager()
    void m.open(W1, html(), 'test')
    void m.open(W1, terminal(['cat']), 'test')
    expect(m.pop(W1)).toBe(false)
    expect(m.infos(W1)).toHaveLength(2)
    expect(backend.last.killed).toBe(0)
  })

  it('closeTop closes any kind; a terminal is killed and dismissed, its late exit ignored', async () => {
    const m = manager()
    const r = track(m.open(W1, terminal(['cat']), 'test'))
    const pty = backend.last
    expect(m.closeTop(W1)).toBe(true)
    expect(pty.killed).toBe(1)
    pty.exit(0, 1)
    await flush()
    expect(r.results).toEqual([{ kind: 'dismissed' }])
    expect(m.closeTop(W1)).toBe(false)
  })

  it('a dismissed terminal program that ignores SIGHUP gets SIGKILL after the grace period', () => {
    const m = manager()
    void m.open(W1, terminal(['trap-hup']), 'test')
    const stubborn = backend.last
    void m.open(W1, terminal(['cat']), 'test')
    const polite = backend.last
    expect(m.closeTop(W1)).toBe(true)
    expect(m.closeTop(W1)).toBe(true)
    expect(stubborn.signals).toEqual([undefined])
    expect(polite.signals).toEqual([undefined])
    // `cat` ends on HUP; the other keeps running.
    polite.exit(0, 1)
    vi.advanceTimersByTime(KILL_GRACE_MS - 1)
    expect(stubborn.signals).toEqual([undefined])
    vi.advanceTimersByTime(1)
    expect(stubborn.signals).toEqual([undefined, 'SIGKILL'])
    expect(polite.signals).toEqual([undefined])
  })

  it('chords typed into a page resolve through the command table', () => {
    const m = manager()
    void m.open(W1, terminal(['cat']), 'test')
    void m.open(W1, url(), 'test')
    const view = views.last
    // Esc inside the url page pops it (the view reports the chord).
    expect(view.onChord('escape')).toBe(true)
    expect(m.topKind(W1)).toBe('terminal')
    // Esc now reaches the terminal's program: not consumed.
    expect(m.handleChord(W1, 'escape')).toBe(false)
    // Another command's chord or none at all is not an overlay key.
    expect(m.handleChord(W1, 'meta+t')).toBe(false)
    expect(m.handleChord(W1, null)).toBe(false)
    expect(m.handleChord(W1, 'shift+meta+w')).toBe(true)
    expect(m.infos(W1)).toEqual([])
    // Nothing open: no key is taken.
    expect(m.handleChord(W1, 'escape')).toBe(false)
  })

  it('a rebinding applies: the table decides, not the key name', () => {
    keyTable = { 'ctrl+q': 'overlay.pop' }
    const m = manager()
    void m.open(W1, html(), 'test')
    expect(m.handleChord(W1, 'escape')).toBe(false)
    expect(m.handleChord(W1, 'ctrl+q')).toBe(true)
  })

  it('chordOfInput maps Electron input, and ignores key-up and auto-repeat', () => {
    const base = {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      shift: false,
      control: false,
      alt: false,
      meta: false,
      isAutoRepeat: false
    }
    expect(chordOfInput(base)).toBe('escape')
    expect(chordOfInput({ ...base, key: 'W', code: 'KeyW', shift: true, meta: true })).toBe('shift+meta+w')
    expect(chordOfInput({ ...base, type: 'keyUp' })).toBeNull()
    expect(chordOfInput({ ...base, isAutoRepeat: true })).toBeNull()
  })
})

describe('url validation', () => {
  it('refuses file:, javascript:, data: and app schemes before a view is created', async () => {
    const m = manager()
    for (const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'vscode://x',
      'not a url',
      '',
      `https://e.com/${'a'.repeat(9000)}`
    ]) {
      const r = track(m.open(W1, url(bad), 'test'))
      await flush()
      expect(r.errors, bad).toHaveLength(1)
    }
    expect(views.created).toEqual([])
    expect(m.infos(W1)).toEqual([])
    expect(events).toEqual([])
  })

  it('overlayUrlOf normalizes http(s)', () => {
    expect(overlayUrlOf('HTTP://Example.com')).toBe('http://example.com/')
    expect(() => overlayUrlOf('ftp://example.com')).toThrow(/only http/)
  })

  it('sameSite compares host names only', () => {
    expect(sameSite('http://example.com/a', 'https://example.com:8443/b')).toBe(true)
    expect(sameSite('https://example.com/', 'https://evil.com/')).toBe(false)
    expect(sameSite('https://example.com/', 'https://sub.example.com/')).toBe(false)
    expect(sameSite('', 'https://example.com/')).toBe(false)
  })

  it('sameSite: a non-http(s) target on the same host is another site', () => {
    expect(sameSite('https://example.com/', 'ftp://example.com/')).toBe(false)
    expect(sameSite('https://example.com/', 'someapp://example.com/x')).toBe(false)
    expect(sameSite('https://example.com/', 'file://example.com/etc/hosts')).toBe(false)
  })
})

describe('spec validation', () => {
  it('refuses malformed specs with a reason', () => {
    const file = join(dir, 'f')
    writeFileSync(file, '')
    const bad: unknown[] = [
      null,
      'terminal',
      { kind: 'shell' },
      { kind: 'terminal', argv: [], cwd: dir },
      { kind: 'terminal', argv: 'ls', cwd: dir },
      { kind: 'terminal', argv: ['ls', 1], cwd: dir },
      { kind: 'terminal', argv: [''], cwd: dir },
      { kind: 'terminal', argv: ['ls\0x'], cwd: dir },
      { kind: 'terminal', argv: ['ls'], cwd: 'relative' },
      { kind: 'terminal', argv: ['ls'], cwd: join(dir, 'missing') },
      { kind: 'terminal', argv: ['ls'], cwd: file },
      { kind: 'terminal', argv: ['ls'] },
      { kind: 'html', html: 5 },
      { kind: 'html', html: 'x'.repeat(1024 * 1024 + 1) },
      { kind: 'html', html: '', title: 5 },
      { kind: 'html', html: '', title: 'x'.repeat(201) },
      // A plugin page is a cc-plugin:// URL and nothing else, and never together with inline html.
      { kind: 'html', src: 'https://example.com/' },
      { kind: 'html', src: 'file:///etc/passwd' },
      { kind: 'html', src: 'cc-overlay://x/' },
      { kind: 'html', src: 'cc-plugin:///no-host' },
      { kind: 'html', src: 5 },
      { kind: 'html', src: 'not a url' },
      { kind: 'html', src: 'cc-plugin://a.one/p.html', html: '<p>x</p>' }
    ]
    for (const spec of bad) expect(() => parseOverlaySpec(spec), JSON.stringify(spec)?.slice(0, 80)).toThrow()
  })

  it('accepts the named sizes on every kind and refuses anything else', () => {
    for (const size of ['default', 'large', 'full']) {
      expect(parseOverlaySpec({ kind: 'url', url: 'https://example.com/', size })).toMatchObject({ size })
      expect(parseOverlaySpec({ kind: 'html', html: '<p>x</p>', size })).toMatchObject({ size })
      expect(parseOverlaySpec({ kind: 'terminal', argv: ['ls'], cwd: dir, size })).toMatchObject({ size })
    }
    expect('size' in parseOverlaySpec({ kind: 'html', html: '<p>x</p>' })).toBe(false)
    for (const size of ['huge', 'LARGE', '', 90, null, {}]) {
      expect(() => parseOverlaySpec({ kind: 'html', html: '<p>x</p>', size })).toThrow(/size/)
      expect(() => parseOverlaySpec({ kind: 'terminal', argv: ['ls'], cwd: dir, size })).toThrow(/size/)
    }
  })

  it('accepts type, buttons, ready and discuss, and returns a clean copy of them', () => {
    const spec = parseOverlaySpec({
      kind: 'html',
      src: 'cc-plugin://a.one/p.html',
      type: { name: 'inbox-item', data: { source: 'a.one', id: 'm1' }, extra: 1 },
      buttons: [
        { id: 'read', label: ' Mark read\n', icon: 'check', primary: true, extra: 1 },
        { id: 'own', label: 'Own', icon: 'icons/own.svg', disabled: false, busy: true }
      ],
      ready: 'manual',
      discuss: { tabId: 't1', extra: 1 },
      unknown: 1
    })
    expect(spec).toEqual({
      kind: 'html',
      src: 'cc-plugin://a.one/p.html',
      type: { name: 'inbox-item', data: { source: 'a.one', id: 'm1' } },
      buttons: [
        { id: 'read', label: 'Mark read', icon: 'check', primary: true },
        { id: 'own', label: 'Own', icon: 'icons/own.svg', busy: true }
      ],
      ready: 'manual',
      discuss: { tabId: 't1' }
    })
    expect(parseOverlaySpec({ kind: 'url', url: 'https://example.com/', discuss: false })).toMatchObject({ discuss: false })
    expect(parseOverlaySpec({ kind: 'terminal', argv: ['ls'], cwd: dir, discuss: {}, type: { name: 'f', data: null } })).toMatchObject({
      discuss: {},
      type: { name: 'f', data: null }
    })
    expect(parseOverlaySpec({ kind: 'html', html: '<p>x</p>', ready: 'load' })).toMatchObject({ ready: 'load' })
    for (const key of ['type', 'buttons', 'ready', 'discuss']) {
      expect(key in parseOverlaySpec({ kind: 'html', html: '<p>x</p>' })).toBe(false)
    }
  })

  it('refuses a bad type, button list, ready or discuss', () => {
    const base = { kind: 'html', html: '<p>x</p>' }
    const btn = (b: object): object => ({ buttons: [{ id: 'a', label: 'A', ...b }] })
    const bad: [string, object, RegExp][] = [
      ['type not object', { type: 'file' }, /type/],
      ['type name caps', { type: { name: 'File', data: null } }, /type name/],
      ['type name digit first', { type: { name: '1a', data: null } }, /type name/],
      ['type name too long', { type: { name: `a${'b'.repeat(64)}`, data: null } }, /type name/],
      ['type no data', { type: { name: 'file' } }, /plain JSON/],
      ['type data function', { type: { name: 'file', data: () => 1 } }, /plain JSON/],
      ['type data too big', { type: { name: 'file', data: 'x'.repeat(4096) } }, /4096/],
      ['five buttons', { buttons: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, label: id })) }, /at most 4/],
      ['buttons not array', { buttons: {} }, /array/],
      ['button not object', { buttons: ['x'] }, /object/],
      ['id empty', btn({ id: '' }), /button id/],
      ['id space', btn({ id: 'a b' }), /button id/],
      ['id too long', btn({ id: 'a'.repeat(41) }), /button id/],
      ['duplicate id', { buttons: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }, /used twice/],
      ['label empty', btn({ label: ' ' }), /label/],
      ['label too long', btn({ label: 'x'.repeat(41) }), /longer than 40/],
      ['icon unknown', btn({ icon: 'nope' }), /svg/],
      ['icon absolute', btn({ icon: '/etc/x.svg' }), /icon/],
      ['icon dotdot', btn({ icon: '../x.svg' }), /icon/],
      ['icon not string', btn({ icon: 5 }), /icon/],
      ['primary not boolean', btn({ primary: 'yes' }), /primary/],
      ['disabled not boolean', btn({ disabled: 1 }), /disabled/],
      ['busy not boolean', btn({ busy: null }), /busy/],
      ['ready other', { ready: 'now' }, /ready/],
      ['discuss true', { discuss: true }, /discuss/],
      ['discuss tab number', { discuss: { tabId: 5 } }, /tabId/],
      ['discuss tab empty', { discuss: { tabId: '' } }, /tabId/]
    ]
    for (const [name, extra, pattern] of bad) {
      expect(() => parseOverlaySpec({ ...base, ...extra }), name).toThrow(pattern)
    }
  })

  it('refuses ready on a terminal or url overlay', () => {
    expect(() => parseOverlaySpec({ kind: 'url', url: 'https://example.com/', ready: 'manual' })).toThrow(/html overlays only/)
    expect(() => parseOverlaySpec({ kind: 'terminal', argv: ['ls'], cwd: dir, ready: 'load' })).toThrow(/html overlays only/)
  })

  it('keeps only the known fields', () => {
    expect(
      parseOverlaySpec({ kind: 'terminal', argv: ['ls', '-la'], cwd: dir, title: 'T', extra: 1 })
    ).toEqual({ kind: 'terminal', argv: ['ls', '-la'], cwd: dir, title: 'T' })
    expect(parseOverlaySpec({ kind: 'html', src: 'cc-plugin://a.one/pages/p.html', title: 'P', extra: 1 })).toEqual({
      kind: 'html',
      src: 'cc-plugin://a.one/pages/p.html',
      title: 'P'
    })
  })
})

describe('html page', () => {
  it('is served at cc-overlay://<id>/ while the overlay is open, and nothing else is', () => {
    const m = manager()
    void m.open(W1, html('<p>page</p>'), 'test')
    void m.open(W1, terminal(['cat']), 'test')
    const [page, term] = m.infos(W1)
    expect(page).toMatchObject({ kind: 'html', src: `cc-overlay://${page!.id}/` })
    expect(m.pageHtml(`cc-overlay://${page!.id}/`)).toBe('<p>page</p>')
    expect(m.pageHtml(`cc-overlay://${page!.id}/other`)).toBeUndefined()
    expect(m.pageHtml(`https://${page!.id}/`)).toBeUndefined()
    expect(m.pageHtml(`cc-overlay://${term!.id}/`)).toBeUndefined()
    expect(m.pageHtml('not a url')).toBeUndefined()
    m.close(W1, page!.id)
    expect(m.pageHtml(`cc-overlay://${page!.id}/`)).toBeUndefined()
  })

  it("shows a plugin's page at its own cc-plugin:// URL (nothing in memory) and takes its result", async () => {
    const m = manager()
    const result = m.open(W1, { kind: 'html', src: 'cc-plugin://a.one/pick.html', title: 'Pick' }, 'plugin a.one')
    const [page] = m.infos(W1)
    expect(page).toEqual({
      id: page!.id,
      kind: 'html',
      title: 'Pick',
      src: 'cc-plugin://a.one/pick.html',
      size: 'default',
      loading: true
    })
    expect(m.pageHtml(`cc-overlay://${page!.id}/`)).toBeUndefined()
    expect(m.result(W1, page!.id, { picked: 'b' })).toBe(true)
    await expect(result).resolves.toEqual({ kind: 'value', value: { picked: 'b' } })
    expect(m.infos(W1)).toEqual([])
  })

  // `ccc overlay --html F` (Task 21) is an html overlay whose page is the file's content, so the
  // one-shot rules of the plan are these: the host is a random per-overlay name, only `/` is
  // served, and the mapping is gone with the overlay.
  it('serves a one-shot page under a random 128-bit name: unknown name 404, one path only, gone after close', () => {
    const m = manager()
    void m.open(W1, html('<p>one</p>'), 'cli')
    void m.open(W1, html('<p>two</p>'), 'cli')
    const [one, two] = m.infos(W1)
    // 128 bits of randomness (a UUID v4), different per overlay.
    expect(one!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(one!.id).not.toBe(two!.id)
    expect(m.pageHtml('cc-overlay://00000000-0000-4000-8000-000000000000/')).toBeUndefined()
    for (const path of ['/index.html', '/a/b', '/x']) {
      expect(m.pageHtml(`cc-overlay://${one!.id}${path}`)).toBeUndefined()
    }
    // Each name maps to its own page only.
    expect(m.pageHtml(`cc-overlay://${one!.id}/`)).toBe('<p>one</p>')
    expect(m.pageHtml(`cc-overlay://${two!.id}/`)).toBe('<p>two</p>')
    m.closeWindow(W1)
    expect(m.pageHtml(`cc-overlay://${one!.id}/`)).toBeUndefined()
    expect(m.pageHtml(`cc-overlay://${two!.id}/`)).toBeUndefined()
  })
})

describe('html page messages (an opener with a channel)', () => {
  const page = { kind: 'html', src: 'cc-plugin://a.one/chat.html' }
  const sent = (windowId: number): unknown[] =>
    events.filter((e) => e.windowId === windowId && e.channel === 'overlays.message').map((e) => e.payload)
  function chat(m: OverlayManager): { result: Promise<OverlayResult>; id: string; heard: unknown[]; created: string[] } {
    const heard: unknown[] = []
    const created: string[] = []
    const result = m.open(W1, page, 'plugin a.one', undefined, {
      onCreated: (id) => created.push(id),
      onMessage: (message) => heard.push(message)
    })
    return { result, id: m.infos(W1).at(-1)!.id, heard, created }
  }

  it('tells the opener the id at once, holds posts until the page is ready, then sends them in order', () => {
    const m = manager()
    const { id, created } = chat(m)
    expect(created).toEqual([id])
    expect(m.post(W1, id, '{"n":1}')).toBe(true)
    expect(m.post(W1, id, '{"n":2}')).toBe(true)
    expect(sent(W1)).toEqual([])
    m.pageReady(W1, id)
    expect(sent(W1)).toEqual([
      { overlayId: id, message: '{"n":1}' },
      { overlayId: id, message: '{"n":2}' }
    ])
    // Loaded: straight out. A renderer reload (list) holds them again until the page is back.
    m.post(W1, id, '3')
    expect(sent(W1)).toHaveLength(3)
    m.list(W1)
    m.post(W1, id, '4')
    expect(sent(W1)).toHaveLength(3)
    m.pageReady(W1, id)
    expect(sent(W1).at(-1)).toEqual({ overlayId: id, message: '4' })
  })

  it("passes the page's messages to the opener only, parsed; the overlay stays until its result", async () => {
    const m = manager()
    const { result, id, heard } = chat(m)
    expect(m.pageMessage(W1, id, '{"draft":"a"}')).toBe(true)
    expect(m.pageMessage(W1, id, '[1,2]')).toBe(true)
    expect(heard).toEqual([{ draft: 'a' }, [1, 2]])
    expect(m.infos(W1)).toHaveLength(1)
    // Another window's renderer, junk, a non-string and oversize text go nowhere.
    expect(m.pageMessage(W2, id, '{}')).toBe(false)
    expect(m.pageMessage(W1, id, '{oops')).toBe(false)
    expect(m.pageMessage(W1, id, 5)).toBe(false)
    expect(m.pageMessage(W1, id, JSON.stringify('x'.repeat(MAX_OVERLAY_MESSAGE_LENGTH)))).toBe(false)
    expect(heard).toHaveLength(2)
    expect(m.result(W1, id, { sent: true })).toBe(true)
    await expect(result).resolves.toEqual({ kind: 'value', value: { sent: true } })
    // Ended: posting, a late page message and ready are all no-ops.
    expect(m.post(W1, id, '1')).toBe(false)
    expect(m.pageMessage(W1, id, '1')).toBe(false)
    m.pageReady(W1, id)
    expect(sent(W1)).toEqual([])
  })

  it('a message over the limit throws, naming it; the queue is bounded in count and size', () => {
    const m = manager()
    const { id } = chat(m)
    expect(() => m.post(W1, id, 'x'.repeat(MAX_OVERLAY_MESSAGE_LENGTH + 1))).toThrow(`exceeds ${MAX_OVERLAY_MESSAGE_LENGTH}`)
    expect(m.post(W1, id, 'x'.repeat(MAX_OVERLAY_MESSAGE_LENGTH))).toBe(true)
    const big = 'y'.repeat(MAX_OVERLAY_MESSAGE_LENGTH)
    const fit = Math.floor(MAX_QUEUED_OVERLAY_LENGTH / MAX_OVERLAY_MESSAGE_LENGTH) - 1
    for (let i = 0; i < fit; i++) m.post(W1, id, big)
    expect(() => m.post(W1, id, big)).toThrow('queue is full')

    const other = chat(m)
    for (let i = 0; i < MAX_QUEUED_OVERLAY_MESSAGES; i++) m.post(W1, other.id, String(i))
    expect(() => m.post(W1, other.id, 'more')).toThrow('queue is full')
    // Esc dismisses it without asking the page; its queue goes with it.
    m.pop(W1)
    m.pageReady(W1, other.id)
    expect(sent(W1)).toEqual([])
  })

  it('an overlay opened without a channel (the CLI, inline html) takes no posts or page messages', () => {
    const m = manager()
    void m.open(W1, html(), 'cli')
    const [inline] = m.infos(W1)
    expect(m.post(W1, inline!.id, '1')).toBe(false)
    expect(m.pageMessage(W1, inline!.id, '1')).toBe(false)
    // A terminal opener with a channel learns the id (for close) but has no page to message.
    const created: string[] = []
    void m.open(W1, terminal(['sleep', '9']), 'plugin a.one', undefined, { onCreated: (id) => created.push(id), onMessage: () => {} })
    const term = m.infos(W1).at(-1)!
    expect(created).toEqual([term.id])
    expect(m.post(W1, term.id, '1')).toBe(false)
  })
})

describe('window close and quit', () => {
  it('open for a window that closed meanwhile rejects and creates nothing', async () => {
    const m = manager()
    closedWindows.add(W1)
    const results = [terminal(['cat']), url(), html()].map((spec) => track(m.open(W1, spec, 'test')))
    await flush()
    for (const r of results) {
      expect(r.results).toEqual([])
      expect(String(r.errors[0])).toMatch(/window is gone/)
    }
    expect(backend.spawned).toEqual([])
    expect(views.created).toEqual([])
    expect(m.infos(W1)).toEqual([])
    expect(events).toEqual([])
  })


  it('closing a window resolves every overlay it had as dismissed, and no other window', async () => {
    const m = manager()
    const t = track(m.open(W1, terminal(['cat']), 'test'))
    const pty = backend.last
    const u = track(m.open(W1, url(), 'test'))
    const view = views.last
    const h = track(m.open(W1, html(), 'test'))
    const other = track(m.open(W2, html(), 'test'))
    m.closeWindow(W1)
    await flush()
    for (const r of [t, u, h]) expect(r.results).toEqual([{ kind: 'dismissed' }])
    expect(other.results).toEqual([])
    expect(pty.killed).toBe(1)
    expect(view.destroyed).toBe(1)
    expect(m.infos(W1)).toEqual([])
    expect(m.infos(W2)).toHaveLength(1)
    // The program's exit after the window is gone changes nothing.
    pty.exit(0, 1)
    await flush()
    expect(t.results).toHaveLength(1)
  })

  it('quit dismisses everything', async () => {
    const m = manager()
    const a = track(m.open(W1, terminal(['cat']), 'test'))
    const b = track(m.open(W2, url(), 'test'))
    m.disposeAll()
    await flush()
    expect(a.results).toEqual([{ kind: 'dismissed' }])
    expect(b.results).toEqual([{ kind: 'dismissed' }])
  })
})

describe('window tokens of terminal overlays', () => {
  it('gives each terminal overlay its own token for its window, and only while it is open', async () => {
    const m = manager()
    const a = track(m.open(W1, terminal(['cat']), 'test'))
    const ptyA = backend.last
    void m.open(W2, terminal(['cat']), 'test')
    expect(envTokens).toHaveLength(2)
    const [tokenA, tokenB] = envTokens as [string, string]
    expect(tokenA).toMatch(/^[0-9a-f]{64}$/)
    expect(tokenB).not.toBe(tokenA)
    expect(m.resolveToken(tokenA)).toEqual({ windowId: W1 })
    expect(m.resolveToken(tokenB)).toEqual({ windowId: W2 })
    // Its program ending revokes it, as does the window closing.
    ptyA.exit(0)
    await flush()
    expect(a.results).toEqual([{ kind: 'exit', code: 0 }])
    expect(m.resolveToken(tokenA)).toBeUndefined()
    m.closeWindow(W2)
    expect(m.resolveToken(tokenB)).toBeUndefined()
  })

  it('a dismissed overlay\'s token stops at once; url and html overlays have none', () => {
    const m = manager()
    void m.open(W1, url(), 'test')
    void m.open(W1, html(), 'test')
    expect(envTokens).toEqual([])
    void m.open(W1, terminal(['cat']), 'test')
    const token = envTokens[0]!
    expect(m.resolveToken(token)).toEqual({ windowId: W1 })
    expect(m.closeTop(W1)).toBe(true)
    expect(m.resolveToken(token)).toBeUndefined()
  })

  it('a program that cannot start leaves no live token; malformed tokens never match', () => {
    const m = manager()
    backend.failWith = new Error('ENOENT')
    expect(() => m.start(W1, terminal(['nope']), 'test')).toThrow('ENOENT')
    expect(m.resolveToken(envTokens[0]!)).toBeUndefined()
    void m.open(W1, terminal(['cat']), 'test')
    const token = envTokens[1]!
    for (const bad of ['', token.toUpperCase(), token.slice(0, 62), '0'.repeat(64), undefined as unknown as string]) {
      expect(m.resolveToken(bad)).toBeUndefined()
    }
  })
})

describe('exactly one result', () => {
  it('every way out after the first is a no-op', async () => {
    const m = manager()
    const r = track(m.open(W1, terminal(['cat']), 'test'))
    const pty = backend.last
    const id = m.infos(W1)[0]!.id
    pty.exit(3)
    expect(m.close(W1, id)).toBe(false)
    expect(m.closeTop(W1)).toBe(false)
    m.closeWindow(W1)
    m.disposeAll()
    await flush()
    expect(r.results).toEqual([{ kind: 'exit', code: 3 }])

    const h = track(m.open(W1, html(), 'test'))
    const hid = m.infos(W1)[0]!.id
    expect(m.result(W1, hid, 1)).toBe(true)
    expect(m.result(W1, hid, 2)).toBe(false)
    expect(m.close(W1, hid)).toBe(false)
    await flush()
    expect(h.results).toEqual([{ kind: 'value', value: 1 }])
  })

  it('an id from another window is unknown', () => {
    const m = manager()
    void m.open(W1, html(), 'test')
    const id = m.infos(W1)[0]!.id
    expect(m.close(W2, id)).toBe(false)
    expect(m.close(W1, 42 as unknown as string)).toBe(false)
    expect(m.infos(W1)).toHaveLength(1)
  })

  it('list resets a terminal overlay’s flow control (a reloaded page re-attaches)', () => {
    const m = manager()
    void m.open(W1, terminal(['yes']), 'test')
    const pty = backend.last
    // Flood past the high-water mark without acks: the PTY is paused.
    pty.emit('y'.repeat(2 * 1024 * 1024))
    expect(pty.paused).toBe(true)
    m.list(W1)
    expect(pty.paused).toBe(false)
  })
})

// design-next §3.4: the overlay is on the stack at once and `loading` until its body is ready.
describe('loader state per kind', () => {
  const loadingOf = (windowId = W1): Array<boolean> => m0.infos(windowId).map((o) => o.loading === true)
  let m0: OverlayManager
  beforeEach(() => {
    m0 = manager()
  })

  it('terminal: loading until the first output, which reaches the renderer before the update', () => {
    void m0.open(W1, terminal(['cat']), 'test')
    expect(loadingOf()).toEqual([true])
    expect(lastStack(W1)[0]!.loading).toBe(true)
    events.length = 0
    backend.last.emit('hello')
    // Output is batched (PtyService) and goes out on its timer.
    vi.advanceTimersByTime(20)
    expect(loadingOf()).toEqual([false])
    expect(events.map((e) => e.channel)).toEqual(['overlays.data', 'overlays.updated'])
    expect(lastStack(W1)[0]).not.toHaveProperty('loading')
    // More output changes nothing more.
    events.length = 0
    backend.last.emit('again')
    vi.advanceTimersByTime(20)
    expect(events.map((e) => e.channel)).toEqual(['overlays.data'])
  })

  it('url: loading and its view hidden until the first load ends; later loads and a closed one are no-ops', () => {
    void m0.open(W1, url(), 'test')
    const view = views.last
    expect(loadingOf()).toEqual([true])
    expect(view.visible).toBe(false)
    view.onLoaded()
    expect(loadingOf()).toEqual([false])
    expect(view.visible).toBe(true)
    events.length = 0
    view.onLoaded()
    expect(events).toEqual([])
    // A second one closes before its page loads: the late event finds nothing.
    void m0.open(W1, url('https://b.example/'), 'test')
    const late = views.last
    expect(m0.closeTop(W1)).toBe(true)
    events.length = 0
    late.onLoaded()
    expect(events).toEqual([])
    expect(late.visible).toBe(false)
  })

  it('html (ready: load, the default): the port coming up ends it, for a plugin page and an inline one', () => {
    void m0.open(W1, html(), 'test')
    void m0.open(W1, { kind: 'html', src: 'cc-plugin://a.one/p.html' }, 'plugin a.one', undefined, { onMessage: () => {} })
    const [inline, page] = m0.infos(W1)
    expect(loadingOf()).toEqual([true, true])
    m0.pageReady(W1, inline!.id)
    expect(loadingOf()).toEqual([false, true])
    m0.pageReady(W1, page!.id)
    expect(loadingOf()).toEqual([false, false])
  })

  it('html (ready: manual): only the page saying it has drawn ends it; another window cannot', () => {
    void m0.open(W1, { kind: 'html', src: 'cc-plugin://a.one/p.html', ready: 'manual' }, 'plugin a.one')
    const [page] = m0.infos(W1)
    m0.pageReady(W1, page!.id)
    expect(loadingOf()).toEqual([true])
    m0.pageLoaded(W2, page!.id)
    m0.pageLoaded(W1, 'nope')
    expect(loadingOf()).toEqual([true])
    m0.pageLoaded(W1, page!.id)
    expect(loadingOf()).toEqual([false])
    expect(lastStack(W1)[0]).not.toHaveProperty('loading')
  })

  it('pageLoaded on a terminal or url overlay changes nothing (their loader follows the program or view)', () => {
    void m0.open(W1, terminal(['cat']), 'test')
    void m0.open(W1, url(), 'test')
    for (const o of m0.infos(W1)) m0.pageLoaded(W1, o.id)
    m0.pageReady(W1, m0.infos(W1)[0]!.id)
    expect(loadingOf()).toEqual([true, true])
  })

  it('a renderer reload (list) brings back the loader of html overlays only', () => {
    void m0.open(W1, html(), 'test')
    void m0.open(W1, terminal(['cat']), 'test')
    const [page] = m0.infos(W1)
    m0.pageReady(W1, page!.id)
    backend.last.emit('x')
    vi.advanceTimersByTime(20)
    expect(loadingOf()).toEqual([false, false])
    expect(m0.list(W1).map((o) => o.loading === true)).toEqual([true, false])
    m0.pageReady(W1, page!.id)
    expect(loadingOf()).toEqual([false, false])
  })
})

describe('toolbar buttons in the info', () => {
  const withButtons = {
    ...{ kind: 'html', src: 'cc-plugin://a.one/p.html' },
    buttons: [
      { id: 'read', label: 'Mark read', icon: 'check', primary: true },
      { id: 'star', label: 'Star', icon: 'icons/star.svg', busy: true },
      { id: 'plain', label: 'Plain', disabled: true }
    ]
  }

  it("a core icon stays a name, a plugin .svg becomes that plugin's cc-plugin:// URL", () => {
    const m = manager()
    void m.open(W1, withButtons, 'plugin a.one', undefined, undefined, 'a.one')
    expect(m.infos(W1)[0]!.buttons).toEqual([
      { id: 'read', label: 'Mark read', icon: 'check', primary: true },
      { id: 'star', label: 'Star', iconSrc: 'cc-plugin://a.one/icons/star.svg', busy: true },
      { id: 'plain', label: 'Plain', disabled: true }
    ])
  })

  it('without an opener plugin a .svg icon is dropped (no folder to read it from); no buttons, no key', () => {
    const m = manager()
    void m.open(W1, withButtons, 'cli')
    expect(m.infos(W1)[0]!.buttons?.[1]).toEqual({ id: 'star', label: 'Star', busy: true })
    void m.open(W1, { ...html(), buttons: [] }, 'cli')
    void m.open(W1, html(), 'cli')
    expect(m.infos(W1)[1]).not.toHaveProperty('buttons')
    expect(m.infos(W1)[2]).not.toHaveProperty('buttons')
  })
})

describe('toolbar clicks and type buttons (design-next §3.3)', () => {
  /** A fake window host: answers `list` from `answer`, records every call. */
  function fakeHost(): {
    source: OverlayTypeButtons
    lists: { key: string; query: OverlayTypeQuery }[]
    clicks: { key: string; pluginId: string; buttonId: string; query: OverlayTypeQuery; settle: (v: { close: boolean }) => void; fail: (e: Error) => void }[]
    ended: string[]
    answer: CleanTypeButton[]
  } {
    const host = {
      lists: [] as { key: string; query: OverlayTypeQuery }[],
      clicks: [] as {
        key: string
        pluginId: string
        buttonId: string
        query: OverlayTypeQuery
        settle: (v: { close: boolean }) => void
        fail: (e: Error) => void
      }[],
      ended: [] as string[],
      answer: [] as CleanTypeButton[],
      source: undefined as unknown as OverlayTypeButtons
    }
    host.source = {
      list: (key, query) => {
        host.lists.push({ key, query })
        return Promise.resolve(host.answer.map((b) => ({ ...b })))
      },
      click: (key, pluginId, buttonId, query) =>
        new Promise((settle, fail) => host.clicks.push({ key, pluginId, buttonId, query, settle, fail })),
      ended: (key) => host.ended.push(key)
    }
    return host
  }

  function typed(host: ReturnType<typeof fakeHost>, hostWindow = W1): OverlayManager {
    return new OverlayManager({
      backend,
      views,
      isWindowOpen: () => true,
      env: () => ({}),
      emit: <C extends EventChannel>(windowId: number, channel: C, payload: IpcEventMap[C]) => {
        events.push({ windowId, channel, payload })
      },
      commandForChord: () => undefined,
      typeButtons: (windowId) => (windowId === hostWindow ? host.source : undefined),
      pluginTitle: (id) => ({ 'p.edit': 'Editor', 'p.mail': 'Gmail' })[id] ?? id,
      log: () => {}
    })
  }

  const fileSpec = { ...html(), title: 'src/x.ts', type: { name: 'file', data: { path: 'src/x.ts' } } }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await flush()
  }

  it('asks the window host once when a typed overlay opens; the answer shows with plugin titles and icons', async () => {
    const host = fakeHost()
    host.answer = [
      { pluginId: 'p.mail', id: 'read', label: 'Mark read', icon: 'icons/read.svg' },
      { pluginId: 'p.edit', id: 'edit', label: 'Edit', icon: 'check' }
    ]
    const m = typed(host)
    void m.open(W1, fileSpec, 'plugin p.rev', undefined, undefined, 'p.rev')
    void m.open(W1, html(), 'cli')
    expect(host.lists).toHaveLength(1)
    expect(host.lists[0]!.query).toEqual({ type: { name: 'file', data: { path: 'src/x.ts' } }, title: 'src/x.ts', opener: 'p.rev' })
    await settle()
    expect(m.infos(W1)[0]!.typeButtons).toEqual([
      { id: 'read', label: 'Mark read', iconSrc: 'cc-plugin://p.mail/icons/read.svg', pluginId: 'p.mail', pluginTitle: 'Gmail' },
      { id: 'edit', label: 'Edit', icon: 'check', pluginId: 'p.edit', pluginTitle: 'Editor' }
    ])
    expect(m.infos(W1)[1]).not.toHaveProperty('typeButtons')
    // The opener as a provider sees it: the CLI and core have no plugin id.
    void m.open(W1, { ...fileSpec }, 'cli')
    void m.open(W1, { ...fileSpec }, 'new-tab menu')
    expect(host.lists.slice(1).map((l) => l.query.opener)).toEqual(['cli', 'core'])
    // Each overlay has its own key, which is not its id.
    const ids = m.infos(W1).map((o) => o.id)
    expect(new Set(host.lists.map((l) => l.key)).size).toBe(3)
    for (const l of host.lists) expect(ids).not.toContain(l.key)
  })

  it('a type click runs on the host with the info, shows busy until it settles, then asks again', async () => {
    const host = fakeHost()
    host.answer = [{ pluginId: 'p.mail', id: 'read', label: 'Mark read' }]
    const m = typed(host)
    void m.open(W1, fileSpec, 'plugin p.rev', undefined, undefined, 'p.rev')
    await settle()
    const id = m.infos(W1)[0]!.id
    expect(m.buttonClick(W1, id, { source: 'type', pluginId: 'p.mail', buttonId: 'read' })).toBe(true)
    expect(host.clicks).toHaveLength(1)
    expect(host.clicks[0]).toMatchObject({ key: host.lists[0]!.key, pluginId: 'p.mail', buttonId: 'read', query: host.lists[0]!.query })
    expect(m.infos(W1)[0]!.typeButtons?.[0]).toMatchObject({ id: 'read', busy: true })
    // Busy: a second click (a renderer that raced the update) is refused.
    expect(m.buttonClick(W1, id, { source: 'type', pluginId: 'p.mail', buttonId: 'read' })).toBe(false)
    host.answer = [{ pluginId: 'p.mail', id: 'unread', label: 'Mark unread' }]
    host.clicks[0]!.settle({ close: false })
    await settle()
    expect(host.lists).toHaveLength(2)
    expect(m.infos(W1)[0]!.typeButtons).toEqual([{ id: 'unread', label: 'Mark unread', pluginId: 'p.mail', pluginTitle: 'Gmail' }])
  })

  it('refuses a click on a button main does not show, a busy or disabled one, another window, no host', async () => {
    const host = fakeHost()
    host.answer = [
      { pluginId: 'p.mail', id: 'read', label: 'Mark read' },
      { pluginId: 'p.mail', id: 'wait', label: 'Wait', busy: true },
      { pluginId: 'p.mail', id: 'off', label: 'Off', disabled: true }
    ]
    const m = typed(host)
    void m.open(W1, fileSpec, 'plugin p.rev', undefined, undefined, 'p.rev')
    void m.open(W2, fileSpec, 'plugin p.rev', undefined, undefined, 'p.rev')
    await settle()
    const id = m.infos(W1)[0]!.id
    for (const click of [
      { source: 'type' as const, pluginId: 'p.edit', buttonId: 'read' },
      { source: 'type' as const, pluginId: 'p.mail', buttonId: 'nope' },
      { source: 'type' as const, pluginId: 'p.mail', buttonId: 'wait' },
      { source: 'type' as const, pluginId: 'p.mail', buttonId: 'off' },
      // The opener has no buttons and no channel.
      { source: 'opener' as const, buttonId: 'read' }
    ]) {
      expect(m.buttonClick(W1, id, click), JSON.stringify(click)).toBe(false)
    }
    expect(m.buttonClick(W2, id, { source: 'type', pluginId: 'p.mail', buttonId: 'read' })).toBe(false)
    // Window 2 has no running host: it got no type buttons and takes no type click.
    const id2 = m.infos(W2)[0]!.id
    expect(m.infos(W2)[0]).not.toHaveProperty('typeButtons')
    expect(m.buttonClick(W2, id2, { source: 'type', pluginId: 'p.mail', buttonId: 'read' })).toBe(false)
    expect(host.clicks).toEqual([])
  })

  it('{ close: true } dismisses the overlay; the host forgets its key when it ends', async () => {
    const host = fakeHost()
    host.answer = [{ pluginId: 'p.mail', id: 'done', label: 'Done' }]
    const m = typed(host)
    const t = track(m.open(W1, fileSpec, 'plugin p.rev', undefined, undefined, 'p.rev'))
    await settle()
    expect(m.buttonClick(W1, m.infos(W1)[0]!.id, { source: 'type', pluginId: 'p.mail', buttonId: 'done' })).toBe(true)
    host.clicks[0]!.settle({ close: true })
    await settle()
    expect(t.results).toEqual([{ kind: 'dismissed' }])
    expect(m.infos(W1)).toEqual([])
    expect(host.ended).toEqual([host.lists[0]!.key])
    // No second ask for an overlay that is gone.
    expect(host.lists).toHaveLength(1)
  })

  it('a click that fails or passes 30 s leaves the button idle again (and the overlay open)', async () => {
    const host = fakeHost()
    host.answer = [{ pluginId: 'p.mail', id: 'read', label: 'Mark read' }]
    const m = typed(host)
    void m.open(W1, fileSpec, 'plugin p.rev', undefined, undefined, 'p.rev')
    await settle()
    const id = m.infos(W1)[0]!.id
    m.buttonClick(W1, id, { source: 'type', pluginId: 'p.mail', buttonId: 'read' })
    host.clicks[0]!.fail(new Error('boom'))
    await settle()
    expect(m.infos(W1)[0]!.typeButtons?.[0]).not.toHaveProperty('busy')
    m.buttonClick(W1, id, { source: 'type', pluginId: 'p.mail', buttonId: 'read' })
    await vi.advanceTimersByTimeAsync(OVERLAY_CLICK_TIMEOUT_MS - 1)
    expect(m.infos(W1)[0]!.typeButtons?.[0]).toMatchObject({ busy: true })
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(m.infos(W1)[0]!.typeButtons?.[0]).not.toHaveProperty('busy')
    expect(m.infos(W1)).toHaveLength(1)
  })

  it('only the newest answer applies, and none after the overlay ended', async () => {
    const host = fakeHost()
    let release: Array<(b: CleanTypeButton[]) => void> = []
    host.source.list = (key, query) => {
      host.lists.push({ key, query })
      return new Promise((resolve) => release.push(resolve))
    }
    const m = typed(host)
    void m.open(W1, fileSpec, 'plugin p.rev', undefined, undefined, 'p.rev')
    const id = m.infos(W1)[0]!.id
    m.refreshTypeButtons(W1)
    release[1]!([{ pluginId: 'p.mail', id: 'new', label: 'New' }])
    await settle()
    release[0]!([{ pluginId: 'p.mail', id: 'old', label: 'Old' }])
    await settle()
    expect(m.infos(W1)[0]!.typeButtons?.map((b) => b.id)).toEqual(['new'])
    release = []
    m.refreshTypeButtons(W1)
    m.close(W1, id)
    release[0]!([{ pluginId: 'p.mail', id: 'late', label: 'Late' }])
    await settle()
    expect(m.infos(W1)).toEqual([])
  })

  it("an opener click goes to the opener's channel only; setButtons replaces them and asks again", async () => {
    const host = fakeHost()
    const m = typed(host)
    const clicks: string[] = []
    let finishClick!: () => void
    const channel: OverlayChannel = {
      onMessage: () => {},
      onButton: (buttonId) => {
        clicks.push(buttonId)
        return new Promise<void>((resolve) => (finishClick = resolve))
      }
    }
    // A url overlay: the opener's buttons work on every kind, and nothing reaches a page.
    void m.open(W1, { ...url(), type: fileSpec.type, buttons: [{ id: 'star', label: 'Star' }] }, 'plugin p.rev', undefined, channel, 'p.rev')
    const id = m.infos(W1)[0]!.id
    expect(m.buttonClick(W1, id, { source: 'opener', buttonId: 'star' })).toBe(true)
    expect(clicks).toEqual(['star'])
    expect(m.infos(W1)[0]!.buttons).toEqual([{ id: 'star', label: 'Star', busy: true }])
    expect(m.buttonClick(W1, id, { source: 'opener', buttonId: 'star' })).toBe(false)
    expect(m.buttonClick(W1, id, { source: 'opener', buttonId: 'other' })).toBe(false)
    finishClick()
    await settle()
    expect(m.infos(W1)[0]!.buttons).toEqual([{ id: 'star', label: 'Star' }])
    expect(host.lists).toHaveLength(2)
    expect(events.some((e) => e.channel === 'overlays.message')).toBe(false)

    expect(m.setButtons(W1, id, [{ id: 'unstar', label: 'Unstar', icon: 'x.svg' }])).toBe(true)
    expect(m.infos(W1)[0]!.buttons).toEqual([{ id: 'unstar', label: 'Unstar', iconSrc: 'cc-plugin://p.rev/x.svg' }])
    expect(host.lists).toHaveLength(3)
    expect(() => m.setButtons(W1, id, [{ id: 'a b', label: 'x' }])).toThrow(/button id/)
    expect(m.setButtons(W2, id, [])).toBe(false)
    expect(m.setButtons(W1, id, [])).toBe(true)
    expect(m.infos(W1)[0]).not.toHaveProperty('buttons')
  })

  it("a channel's messaging stays html-only: post to a url overlay with a channel is refused", () => {
    const m = typed(fakeHost())
    void m.open(W1, url(), 'plugin p.rev', undefined, { onMessage: () => {} }, 'p.rev')
    const id = m.infos(W1)[0]!.id
    expect(m.post(W1, id, '"x"')).toBe(false)
    expect(m.pageMessage(W1, id, '"x"')).toBe(false)
  })
})

describe('Discuss with Claude (design-next §3.5)', () => {
  /** Fake sessions: Claude tabs per window, the gate's answers, the tabs opened and selected. */
  function fakeSessions() {
    const s = {
      claude: new Map<number, Set<string>>([[W1, new Set(['t1', 't2'])], [W2, new Set(['t9'])]]),
      sent: [] as { tabId: string; text: string }[],
      opened: [] as { windowId: number; prompt: string }[],
      selected: [] as { windowId: number; tabId: string }[],
      notReady: new Set<string>(),
      delivered: true,
      sendError: undefined as Error | undefined,
      openError: undefined as Error | undefined,
      next: 1,
      deps: undefined as unknown as DiscussSessions
    }
    s.deps = {
      isClaudeTab: (windowId, tabId) => s.claude.get(windowId)?.has(tabId) === true,
      notReady: (tabId) => s.notReady.has(tabId),
      send: (tabId, text) => {
        if (s.sendError) throw s.sendError
        s.sent.push({ tabId, text })
        return { delivered: s.delivered }
      },
      openSession: (windowId, prompt) => {
        if (s.openError) return Promise.reject(s.openError)
        s.opened.push({ windowId, prompt })
        return Promise.resolve({ tabId: `new${s.next++}` })
      },
      selectTab: (windowId, tabId) => s.selected.push({ windowId, tabId })
    }
    return s
  }

  function withDiscuss(sessions: ReturnType<typeof fakeSessions>): OverlayManager {
    return new OverlayManager({
      backend,
      views,
      isWindowOpen: () => true,
      env: () => ({}),
      emit: <C extends EventChannel>(windowId: number, channel: C, payload: IpcEventMap[C]) => {
        events.push({ windowId, channel, payload })
      },
      commandForChord: () => undefined,
      pluginTitle: (id) => ({ 'p.rev': 'Reviewer' })[id] ?? id,
      discuss: sessions.deps,
      log: () => {}
    })
  }

  /** An opener channel whose onDiscuss answers `answer()`. */
  function opener(answer: () => Promise<unknown>): OverlayChannel & { asks: number } {
    const ch = {
      asks: 0,
      onMessage: () => {},
      onDiscuss: () => {
        ch.asks++
        return answer()
      }
    }
    return ch
  }

  const fileSpec = { ...html(), title: 'Review src/x.ts', type: { name: 'file', data: { path: 'src/x.ts' } } }

  it('shows on a typed overlay or once the opener has a handler; never with discuss: false or on a bare one', () => {
    const m = withDiscuss(fakeSessions())
    void m.open(W1, fileSpec, 'plugin p.rev', undefined, undefined, 'p.rev')
    void m.open(W1, { ...fileSpec, discuss: { tabId: 't2' } }, 'plugin p.rev', undefined, undefined, 'p.rev')
    void m.open(W1, { ...fileSpec, discuss: false }, 'plugin p.rev', undefined, undefined, 'p.rev')
    void m.open(W1, html(), 'cli')
    const [typed, preferred, off, bare] = m.infos(W1)
    expect(typed!.discuss).toEqual({})
    expect(preferred!.discuss).toEqual({ tabId: 't2' })
    expect(off).not.toHaveProperty('discuss')
    expect(bare).not.toHaveProperty('discuss')
    // A handler brings it to an untyped overlay, and takes it away again; discuss: false stays off.
    expect(m.setDiscussHandler(W1, bare!.id, true)).toBe(true)
    expect(m.infos(W1)[3]!.discuss).toEqual({})
    expect(lastStack(W1)[3]!.discuss).toEqual({})
    m.setDiscussHandler(W1, bare!.id, false)
    expect(m.infos(W1)[3]).not.toHaveProperty('discuss')
    m.setDiscussHandler(W1, off!.id, true)
    expect(m.infos(W1)[2]).not.toHaveProperty('discuss')
    // Another window's id is unknown.
    expect(m.setDiscussHandler(W2, bare!.id, true)).toBe(false)
  })

  it('setDiscussPrimary marks Discuss primary or plain, kept while Discuss is hidden', () => {
    const m = withDiscuss(fakeSessions())
    void m.open(W1, fileSpec, 'plugin p.rev', undefined, undefined, 'p.rev')
    void m.open(W1, html(), 'cli')
    const [typed, bare] = m.infos(W1)
    expect(m.setDiscussPrimary(W1, typed!.id, true)).toBe(true)
    expect(m.infos(W1)[0]!.discuss).toEqual({ primary: true })
    expect(lastStack(W1)[0]!.discuss).toEqual({ primary: true })
    m.setDiscussPrimary(W1, typed!.id, false)
    expect(m.infos(W1)[0]!.discuss).toEqual({})
    // No Discuss yet: nothing to draw, but the flag shows once a handler brings it.
    m.setDiscussPrimary(W1, bare!.id, true)
    expect(m.infos(W1)[1]).not.toHaveProperty('discuss')
    m.setDiscussHandler(W1, bare!.id, true)
    expect(m.infos(W1)[1]!.discuss).toEqual({ primary: true })
    expect(m.setDiscussPrimary(W2, bare!.id, true)).toBe(false)
  })

  it('sends to an existing tab through the gate, closes as discussed and selects the tab', async () => {
    const sessions = fakeSessions()
    const m = withDiscuss(sessions)
    const ch = opener(() => Promise.resolve({ text: 'The review so far' }))
    const r = track(m.open(W1, fileSpec, 'plugin p.rev', undefined, ch, 'p.rev'))
    const id = m.infos(W1)[0]!.id
    m.setDiscussHandler(W1, id, true)
    const answer = await m.discuss(W1, id, { kind: 'tab', tabId: 't2' })
    expect(answer).toEqual({ ok: true, tabId: 't2', queued: false })
    expect(ch.asks).toBe(1)
    expect(sessions.sent).toEqual([
      { tabId: 't2', text: 'About: Review src/x.ts\nFile: src/x.ts\n\nThe review so far' }
    ])
    await flush()
    expect(r.results).toEqual([{ kind: 'discussed', tabId: 't2', queued: false }])
    expect(m.infos(W1)).toEqual([])
    expect(sessions.selected).toEqual([{ windowId: W1, tabId: 't2' }])
  })

  it('a busy tab queues it: the result says queued', async () => {
    const sessions = fakeSessions()
    sessions.delivered = false
    const m = withDiscuss(sessions)
    const r = track(m.open(W1, fileSpec, 'plugin p.rev', undefined, undefined, 'p.rev'))
    const answer = await m.discuss(W1, m.infos(W1)[0]!.id, { kind: 'tab', tabId: 't1' })
    expect(answer).toEqual({ ok: true, tabId: 't1', queued: true })
    // No handler: no ask, no context; .
    expect(sessions.sent[0]!.text).toBe('About: Review src/x.ts\nFile: src/x.ts')
    await flush()
    expect(r.results).toEqual([{ kind: 'discussed', tabId: 't1', queued: true }])
  })

  it('New session opens a tab with the text as its first prompt, at most 5 a minute per window', async () => {
    const sessions = fakeSessions()
    const m = withDiscuss(sessions)
    for (let i = 0; i < 5; i++) {
      void m.open(W1, fileSpec, 'plugin p.rev', undefined, undefined, 'p.rev')
      const answer = await m.discuss(W1, m.infos(W1)[0]!.id, { kind: 'new' })
      expect(answer).toEqual({ ok: true, tabId: `new${i + 1}`, queued: false })
    }
    expect(sessions.opened).toHaveLength(5)
    expect(sessions.opened[0]).toEqual({ windowId: W1, prompt: 'About: Review src/x.ts\nFile: src/x.ts' })
    expect(sessions.selected.map((s) => s.tabId)).toEqual(['new1', 'new2', 'new3', 'new4', 'new5'])
    void m.open(W1, fileSpec, 'plugin p.rev', undefined, undefined, 'p.rev')
    const sixth = await m.discuss(W1, m.infos(W1)[0]!.id, { kind: 'new' })
    expect(sixth.ok).toBe(false)
    expect(m.infos(W1)).toHaveLength(1)
    // Another window has its own budget; the minute passing gives this one its budget back.
    void m.open(W2, fileSpec, 'plugin p.rev', undefined, undefined, 'p.rev')
    expect((await m.discuss(W2, m.infos(W2)[0]!.id, { kind: 'new' })).ok).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect((await m.discuss(W1, m.infos(W1)[0]!.id, { kind: 'new' })).ok).toBe(true)
  })

  it('a refused new tab gives its budget back and leaves the overlay open', async () => {
    const sessions = fakeSessions()
    sessions.openError = new Error('the project window was closed')
    const m = withDiscuss(sessions)
    void m.open(W1, fileSpec, 'plugin p.rev', undefined, undefined, 'p.rev')
    const id = m.infos(W1)[0]!.id
    for (let i = 0; i < 6; i++) {
      expect(await m.discuss(W1, id, { kind: 'new' })).toEqual({ ok: false, error: 'No new session: the project window was closed' })
    }
    sessions.openError = undefined
    expect((await m.discuss(W1, id, { kind: 'new' })).ok).toBe(true)
  })

  it('an overlay dismissed while its new session opens: the session stays and is selected, the opener heard dismissed', async () => {
    const sessions = fakeSessions()
    let release!: (v: { tabId: string }) => void
    sessions.deps.openSession = () => new Promise((resolve) => (release = resolve))
    const m = withDiscuss(sessions)
    const r = track(m.open(W1, fileSpec, 'plugin p.rev', undefined, undefined, 'p.rev'))
    const id = m.infos(W1)[0]!.id
    const pending = m.discuss(W1, id, { kind: 'new' })
    await flush()
    m.close(W1, id)
    release({ tabId: 'new1' })
    expect(await pending).toEqual({ ok: true, tabId: 'new1', queued: false })
    await flush()
    expect(r.results).toEqual([{ kind: 'dismissed' }])
    expect(sessions.selected).toEqual([{ windowId: W1, tabId: 'new1' }])
  })

  it("an onDiscuss that throws or times out is the popover's error, and nothing is sent", async () => {
    const sessions = fakeSessions()
    const m = withDiscuss(sessions)
    const thrower = opener(() => Promise.reject(new Error('no draft')))
    void m.open(W1, fileSpec, 'plugin p.rev', undefined, thrower, 'p.rev')
    const id = m.infos(W1)[0]!.id
    m.setDiscussHandler(W1, id, true)
    expect(await m.discuss(W1, id, { kind: 'tab', tabId: 't1' })).toEqual({
      ok: false,
      error: 'Reviewer could not give its context: no draft'
    })
    const slow = opener(() => new Promise(() => {}))
    void m.open(W1, fileSpec, 'plugin p.rev', undefined, slow, 'p.rev')
    const slowId = m.infos(W1)[1]!.id
    m.setDiscussHandler(W1, slowId, true)
    const pending = m.discuss(W1, slowId, { kind: 'tab', tabId: 't1' })
    // A second Send while the first waits is refused.
    expect(await m.discuss(W1, slowId, { kind: 'tab', tabId: 't1' })).toEqual({ ok: false, error: 'Already sending' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await pending).toEqual({ ok: false, error: 'Reviewer could not give its context: onDiscuss took longer than 5 s' })
    const odd = opener(() => Promise.resolve({ txt: 'x' }))
    void m.open(W1, fileSpec, 'plugin p.rev', undefined, odd, 'p.rev')
    const oddId = m.infos(W1)[2]!.id
    m.setDiscussHandler(W1, oddId, true)
    expect((await m.discuss(W1, oddId, { kind: 'tab', tabId: 't1' })).ok).toBe(false)
    expect(sessions.sent).toEqual([])
    expect(m.infos(W1)).toHaveLength(3)
  })

  it('null from onDiscuss means no extra context', async () => {
    const sessions = fakeSessions()
    const m = withDiscuss(sessions)
    const ch = opener(() => Promise.resolve(null))
    void m.open(W1, { ...html(), title: 'Notes' }, 'plugin p.rev', undefined, ch, 'p.rev')
    const id = m.infos(W1)[0]!.id
    m.setDiscussHandler(W1, id, true)
    expect((await m.discuss(W1, id, { kind: 'tab', tabId: 't1' })).ok).toBe(true)
    expect(sessions.sent[0]!.text).toBe('About: Notes')
  })

  it("refuses a tab that is not this window's Claude tab, now and again just before the send", async () => {
    const sessions = fakeSessions()
    const m = withDiscuss(sessions)
    let release!: (v: unknown) => void
    const ch = opener(() => new Promise((resolve) => (release = resolve)))
    void m.open(W1, fileSpec, 'plugin p.rev', undefined, ch, 'p.rev')
    const id = m.infos(W1)[0]!.id
    // Another window's tab, or a shell tab id, is refused before the opener is asked.
    expect((await m.discuss(W1, id, { kind: 'tab', tabId: 't9' })).ok).toBe(false)
    expect((await m.discuss(W1, id, { kind: 'tab', tabId: 'shell1' })).ok).toBe(false)
    m.setDiscussHandler(W1, id, true)
    expect(ch.asks).toBe(0)
    // The tab closes while the opener is asked: checked again, nothing sent.
    const pending = m.discuss(W1, id, { kind: 'tab', tabId: 't1' })
    await flush()
    sessions.claude.get(W1)!.delete('t1')
    release({ text: 'ctx' })
    expect(await pending).toEqual({ ok: false, error: 'That Claude tab is gone; pick another' })
    expect(sessions.sent).toEqual([])
    expect(m.infos(W1)).toHaveLength(1)
  })

  // The incident: a tab resumed by an app restart sat idle; a Discuss to it was queued as
  // "queued 1" and never delivered (no Stop comes until the person runs a prompt).
  it('refuses an idle tab (no Stop would deliver it), and the overlay stays open', async () => {
    const sessions = fakeSessions()
    sessions.notReady.add('t1')
    const m = withDiscuss(sessions)
    void m.open(W1, fileSpec, 'plugin p.rev', undefined, opener(() => Promise.resolve(null)), 'p.rev')
    const id = m.infos(W1)[0]!.id
    const answer = await m.discuss(W1, id, { kind: 'tab', tabId: 't1' })
    expect(answer).toEqual({ ok: false, error: expect.stringMatching(/is idle and would not take the text/) })
    expect(sessions.sent).toEqual([])
    expect(m.infos(W1)).toHaveLength(1)
    // A new session is not a tab target: unaffected.
    expect((await m.discuss(W1, id, { kind: 'new' })).ok).toBe(true)
  })

  it('refuses a bare overlay, another window and an overlay that closed meanwhile', async () => {
    const sessions = fakeSessions()
    const m = withDiscuss(sessions)
    void m.open(W1, html(), 'cli')
    const bare = m.infos(W1)[0]!.id
    expect((await m.discuss(W1, bare, { kind: 'tab', tabId: 't1' })).ok).toBe(false)
    void m.open(W1, fileSpec, 'plugin p.rev', undefined, undefined, 'p.rev')
    const id = m.infos(W1)[1]!.id
    expect((await m.discuss(W2, id, { kind: 'tab', tabId: 't9' })).ok).toBe(false)
    let release!: (v: unknown) => void
    const ch = opener(() => new Promise((resolve) => (release = resolve)))
    void m.open(W1, fileSpec, 'plugin p.rev', undefined, ch, 'p.rev')
    const third = m.infos(W1)[2]!.id
    m.setDiscussHandler(W1, third, true)
    const pending = m.discuss(W1, third, { kind: 'tab', tabId: 't1' })
    await flush()
    m.close(W1, third)
    release(null)
    expect(await pending).toEqual({ ok: false, error: 'The overlay closed' })
    expect(sessions.sent).toEqual([])
    // Without main's sessions wired, Send is an error too.
    const plain = manager()
    void plain.open(W1, fileSpec, 'plugin p.rev', undefined, undefined, 'p.rev')
    expect((await plain.discuss(W1, plain.infos(W1)[0]!.id, { kind: 'new' })).ok).toBe(false)
  })
})
