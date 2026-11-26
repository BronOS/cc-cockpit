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
  type ViewBounds,
  URL_OVERLAY_SERVER_REFUSAL
} from '../../src/main/overlays/overlay-manager'
import { WebviewManager, type WebviewView } from '../../src/main/webview/webview-manager'
import { OVERLAY_CLICK_TIMEOUT_MS, type CleanTypeButton } from '../../src/shared/overlay-buttons'
import { FakePtyBackend } from '../fakes/fake-pty-backend'
import { PluginPages } from '../../src/main/web/plugin-pages'
import { desktopViewId } from '../../src/shared/views'

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

function manager(opts: { server?: boolean } = {}): OverlayManager {
  return new OverlayManager({
    ownerView: () => true,
    ...opts,
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
      ownerView: () => true,
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
      ownerView: () => true,
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

  it('inlinePage gives the open page and its window for the web gateway; an /o/ path dies with the overlay', async () => {
    const m = manager()
    void m.open(W1, html('<p>page</p>'), 'cli')
    void m.open(W2, { kind: 'html', src: 'cc-plugin://a.one/pick.html' }, 'plugin a.one')
    const [page] = m.infos(W1)
    const [plugin] = m.infos(W2)
    expect(m.inlinePage(page!.id)).toEqual({ windowId: W1, html: '<p>page</p>' })
    // A plugin's page is a file, not an inline page; an unknown id is nothing.
    expect(m.inlinePage(plugin!.id)).toBeUndefined()
    expect(m.inlinePage('nope')).toBeUndefined()
    const pages = new PluginPages({ guestProject: () => undefined, guestPluginVisible: () => false,
      pluginIds: () => [],
      deviceViews: () => [{ windowId: W1, projectId: 'p1' }],
      pluginDir: () => undefined,
      overlayPage: (id) => m.inlinePage(id),
      sdkFile: '/nonexistent'
    })
    const path = `${pages.paths('dev1').overlays}${page!.id}/`
    expect((await pages.serve(path, 'GET', ['http://127.0.0.1:7330'])).status).toBe(200)
    m.close(W1, page!.id)
    expect(m.inlinePage(page!.id)).toBeUndefined()
    expect((await pages.serve(path, 'GET', ['http://127.0.0.1:7330'])).status).toBe(404)
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

describe('html overlays held by one view (design-web.md §5.4)', () => {
  const page = { kind: 'html', src: 'cc-plugin://a.one/chat.html' }
  /** A manager that also sends to one view, and names devices, as index.ts wires it. */
  const gone = new Set<string>()
  beforeEach(() => gone.clear())
  function viewsManager(): { m: OverlayManager; toView: Array<{ viewId: string; channel: EventChannel; payload: unknown }> } {
    const toView: Array<{ viewId: string; channel: EventChannel; payload: unknown }> = []
    const m = new OverlayManager({
      ownerView: () => true,
      backend,
      views,
      isWindowOpen: () => true,
      env: () => ({}),
      emit: <C extends EventChannel>(windowId: number, channel: C, payload: IpcEventMap[C]) => {
        events.push({ windowId, channel, payload })
      },
      emitToView: <C extends EventChannel>(viewId: string, channel: C, payload: IpcEventMap[C]) => {
        toView.push({ viewId, channel, payload })
        return !gone.has(viewId)
      },
      isViewLive: (viewId) => !gone.has(viewId),
      deviceOf: (viewId) => (viewId === 'web:1' ? 'Phone' : viewId === 'web:2' ? 'Tablet' : 'Desktop'),
      commandForChord: () => undefined,
      log: () => {}
    })
    return { m, toView }
  }
  function chat(m: OverlayManager, view?: string): { result: Promise<OverlayResult>; id: string; heard: unknown[] } {
    const heard: unknown[] = []
    const result = m.open(W1, page, 'plugin a.one', undefined, { onMessage: (message) => heard.push(message) }, 'a.one', view)
    return { result, id: m.infos(W1).at(-1)!.id, heard }
  }

  it('opens in the desktop view by default (no heldBy: the shape without web access)', () => {
    const { m } = viewsManager()
    const { id } = chat(m)
    expect(m.infos(W1)[0]).not.toHaveProperty('heldBy')
    // The desktop holds it: its reports count.
    m.pageReady(W1, id, 'desktop:1')
    expect(m.infos(W1)[0]?.loading).toBeUndefined()
  })

  it('opens in the view the opening action came from, named with its device', () => {
    const { m } = viewsManager()
    chat(m, 'web:1')
    expect(m.infos(W1)[0]?.heldBy).toEqual({ viewId: 'web:1', device: 'Phone' })
    // A terminal or url overlay is shared by every view: never held.
    void m.open(W1, terminal(['sleep', '9']), 'test', undefined, undefined, undefined, 'web:1')
    expect(m.infos(W1)[1]).not.toHaveProperty('heldBy')
  })

  it('take over moves the page: heldBy names the new view, the loader is back, posts wait for its port', () => {
    const { m, toView } = viewsManager()
    const { id } = chat(m)
    m.pageReady(W1, id, 'desktop:1')
    m.post(W1, id, '"one"')
    expect(toView).toEqual([{ viewId: 'desktop:1', channel: 'overlays.message', payload: { overlayId: id, message: '"one"' } }])
    // Nothing goes to the window as a whole: the page is one view's.
    expect(events.filter((e) => e.channel === 'overlays.message')).toEqual([])

    expect(m.take(W1, 'web:1', id)).toBe(true)
    expect(lastStack(W1)[0]).toMatchObject({ heldBy: { viewId: 'web:1', device: 'Phone' }, loading: true })
    // The old holder's page is gone from main's point of view: its late reports are dropped.
    m.post(W1, id, '"two"')
    m.pageReady(W1, id, 'desktop:1')
    expect(toView).toHaveLength(1)
    expect(lastStack(W1)[0]?.loading).toBe(true)
    // The new page's port is up: the queued post goes to that view, and the loader goes.
    m.pageReady(W1, id, 'web:1')
    expect(toView.at(-1)).toEqual({ viewId: 'web:1', channel: 'overlays.message', payload: { overlayId: id, message: '"two"' } })
    expect(lastStack(W1)[0]?.loading).toBeUndefined()

    // Taken back by the desktop: heldBy goes (absent = the desktop's).
    expect(m.take(W1, 'desktop:1', id)).toBe(true)
    expect(lastStack(W1)[0]).not.toHaveProperty('heldBy')
    // Taking what the view already holds changes nothing.
    const count = events.length
    expect(m.take(W1, 'desktop:1', id)).toBe(true)
    expect(events).toHaveLength(count)
  })

  it("hands the opener a remote holder's view with its page's messages (origin-view.ts), none for the desktop's", () => {
    const { m } = viewsManager()
    const views: unknown[] = []
    const opener = { onMessage: (_message: unknown, view?: string) => void views.push(view) }
    void m.open(W1, page, 'plugin a.one', undefined, opener, 'a.one', 'web:1')
    const remote = m.infos(W1).at(-1)!.id
    void m.open(W1, page, 'plugin a.one', undefined, opener, 'a.one')
    const desktop = m.infos(W1).at(-1)!.id
    expect(m.pageMessage(W1, remote, '{"a":1}', 'web:1')).toBe(true)
    expect(m.pageMessage(W1, desktop, '{"a":2}', 'desktop:1')).toBe(true)
    expect(views).toEqual(['web:1', undefined])
  })

  it('only the holder answers, reports and messages; the result settles the opener once', async () => {
    const { m } = viewsManager()
    const { id, result, heard } = chat(m, 'web:1')
    expect(m.pageMessage(W1, id, '{"a":1}', 'desktop:1')).toBe(false)
    expect(m.pageMessage(W1, id, '{"a":2}', 'web:1')).toBe(true)
    expect(heard).toEqual([{ a: 2 }])
    m.pageLoaded(W1, id, 'web:2')
    expect(m.infos(W1)[0]?.loading).toBe(true)
    expect(m.result(W1, id, 'not mine', 'desktop:1')).toBe(false)
    expect(m.result(W1, id, 'mine', 'web:1')).toBe(true)
    // Closed on every view (one stack per window), and a second answer finds it gone.
    expect(lastStack(W1)).toEqual([])
    expect(m.result(W1, id, 'again', 'web:1')).toBe(false)
    await expect(result).resolves.toEqual({ kind: 'value', value: 'mine' })
  })

  it('a view that left before start finished does not get the page; a post to a dropped holder waits', () => {
    const { m, toView } = viewsManager()
    gone.add('web:1')
    const first = chat(m, 'web:1')
    expect(m.infos(W1)[0]).not.toHaveProperty('heldBy')
    expect(first.id).toBeTruthy()
    gone.clear()
    const { id } = chat(m, 'web:2')
    m.pageReady(W1, id, 'web:2')
    gone.add('web:2')
    const sent = toView.length
    m.post(W1, id, '"late"')
    expect(toView).toHaveLength(sent + 1)
    // viewGone hands the page to the desktop, whose load delivers the queued post.
    m.viewGone('web:2')
    m.pageReady(W1, id, 'desktop:1')
    expect(toView.at(-1)).toEqual({ viewId: 'desktop:1', channel: 'overlays.message', payload: { overlayId: id, message: '"late"' } })
  })

  it('a late result, message or load report from the old holder after a take is dropped', async () => {
    const { m } = viewsManager()
    const { id, result, heard } = chat(m, 'web:1')
    m.pageReady(W1, id, 'web:1')
    expect(m.take(W1, 'web:2', id)).toBe(true)
    expect(m.pageMessage(W1, id, '{"a":1}', 'web:1')).toBe(false)
    expect(heard).toEqual([])
    expect(m.result(W1, id, 'stale', 'web:1')).toBe(false)
    m.pageReady(W1, id, 'web:1')
    m.pageLoaded(W1, id, 'web:1')
    expect(m.infos(W1)[0]?.loading).toBe(true)
    expect(m.infos(W1)).toHaveLength(1)
    expect(m.result(W1, id, 'fresh', 'web:2')).toBe(true)
    await expect(result).resolves.toEqual({ kind: 'value', value: 'fresh' })
  })

  it('take is scoped to the window and to html overlays', () => {
    const { m } = viewsManager()
    const { id } = chat(m)
    expect(m.take(W2, 'web:1', id)).toBe(false)
    expect(m.take(W1, 'web:1', 'nope')).toBe(false)
    void m.open(W1, terminal(['sleep', '9']), 'test')
    expect(m.take(W1, 'web:1', m.infos(W1)[1]!.id)).toBe(false)
    expect(m.infos(W1)[0]).not.toHaveProperty('heldBy')
  })

  it("a view's reload (list) reloads only the pages it holds", () => {
    const { m } = viewsManager()
    const remote = chat(m, 'web:1')
    const local = chat(m)
    m.pageReady(W1, remote.id, 'web:1')
    m.pageReady(W1, local.id, 'desktop:1')
    const infos = m.list(W1, 'desktop:1')
    expect(infos.find((o) => o.id === local.id)?.loading).toBe(true)
    expect(infos.find((o) => o.id === remote.id)?.loading).toBeUndefined()
  })

  it('the holding view leaving gives the page back to the desktop, which loads it', () => {
    const { m, toView } = viewsManager()
    const { id } = chat(m, 'web:1')
    m.pageReady(W1, id, 'web:1')
    m.post(W1, id, '1')
    // Another view leaving changes nothing.
    const count = events.length
    m.viewGone('web:2')
    expect(events).toHaveLength(count)
    m.viewGone('web:1')
    expect(lastStack(W1)[0]).not.toHaveProperty('heldBy')
    expect(lastStack(W1)[0]?.loading).toBe(true)
    m.post(W1, id, '2')
    m.pageReady(W1, id, 'desktop:1')
    expect(toView.map((e) => [e.viewId, (e.payload as { message: string }).message])).toEqual([
      ['web:1', '1'],
      ['desktop:1', '2']
    ])
  })
})

// design-web.md §9.9: a url overlay's page is a native view, which nobody on a server sees and a
// browser cannot show. Refused at the open by main's flag, whoever opens it, before anything exists.
describe('server mode: url overlays are refused at their open', () => {
  it('open rejects and start throws with the text; no view, no stack, nothing emitted', async () => {
    const m = manager({ server: true })
    await expect(m.open(W1, url(), 'cli')).rejects.toThrow(URL_OVERLAY_SERVER_REFUSAL)
    expect(() => m.start(W1, url(), 'plugin a.one', undefined, undefined, 'a.one', 'web:1')).toThrow(URL_OVERLAY_SERVER_REFUSAL)
    expect(views.created).toEqual([])
    expect(m.infos(W1)).toEqual([])
    expect(events).toEqual([])
    // A terminal overlay still opens there (its pty lives in main; browsers draw it).
    track(m.open(W1, terminal(), 'cli'))
    expect(m.infos(W1).map((i) => i.kind)).toEqual(['terminal'])
  })

  it('the desktop opens a url overlay as before', () => {
    track(manager({ server: false }).open(W1, url(), 'cli'))
    track(manager().open(W2, url(), 'cli'))
    expect(views.created.map((v) => v.windowId)).toEqual([W1, W2])
  })
})

describe('server mode: html overlays held by browsers only (design-web.md §9.8)', () => {
  const page = { kind: 'html', src: 'cc-plugin://a.one/chat.html' }
  const gone = new Set<string>()
  /** browserViews' answer, as index.ts gives it: the last to act first, then attach order. */
  let browsers: string[]
  beforeEach(() => {
    gone.clear()
    browsers = []
  })
  function serverManager(server = true): { m: OverlayManager; toView: Array<{ viewId: string; payload: unknown }> } {
    const toView: Array<{ viewId: string; payload: unknown }> = []
    const m = new OverlayManager({
      ownerView: () => true,
      server,
      backend,
      views,
      isWindowOpen: () => true,
      env: () => ({}),
      emit: <C extends EventChannel>(windowId: number, channel: C, payload: IpcEventMap[C]) => {
        events.push({ windowId, channel, payload })
      },
      emitToView: <C extends EventChannel>(viewId: string, _channel: C, payload: IpcEventMap[C]) => {
        toView.push({ viewId, payload })
        return !gone.has(viewId)
      },
      isViewLive: (viewId) => !gone.has(viewId),
      browserViews: () => browsers.filter((v) => !gone.has(v)),
      deviceOf: (viewId) => (viewId === 'web:1' ? 'Phone' : viewId === 'web:2' ? 'Tablet' : viewId === 'web:3' ? 'Laptop' : 'Desktop'),
      commandForChord: () => undefined,
      log: () => {}
    })
    return { m, toView }
  }
  function open(m: OverlayManager, view?: string): { result: Promise<OverlayResult>; id: string } {
    // A channel, so the opener can post (as a plugin's ctx.overlay.start); not passed for ccc's.
    const result = m.open(W1, page, 'plugin a.one', undefined, { onMessage: () => {} }, 'a.one', view)
    return { result, id: m.infos(W1).at(-1)!.id }
  }
  const messages = (toView: Array<{ viewId: string; payload: unknown }>): Array<[string, string]> =>
    toView.map((e) => [e.viewId, (e.payload as { message: string }).message])

  it('no origin view: held by the browser that acted last, never the hidden page', async () => {
    const { m, toView } = serverManager()
    browsers = ['web:2', 'web:1']
    const { id, result } = open(m)
    expect(m.infos(W1)[0]?.heldBy).toEqual({ viewId: 'web:2', device: 'Tablet' })
    // The hidden page's reports and answers are dropped; it cannot take the page either.
    m.pageReady(W1, id, 'desktop:1')
    expect(m.infos(W1)[0]?.loading).toBe(true)
    expect(m.result(W1, id, 'hidden', 'desktop:1')).toBe(false)
    expect(m.take(W1, 'desktop:1', id)).toBe(false)
    expect(m.infos(W1)[0]?.heldBy?.viewId).toBe('web:2')
    // The holder's page talks and answers.
    m.post(W1, id, '"hi"')
    m.pageReady(W1, id, 'web:2')
    expect(messages(toView)).toEqual([['web:2', '"hi"']])
    expect(m.result(W1, id, 'yes', 'web:2')).toBe(true)
    await expect(result).resolves.toEqual({ kind: 'value', value: 'yes' })
  })

  it("an origin view (a browser's own action) still wins; the desktop's id as origin is not one", () => {
    const { m } = serverManager()
    browsers = ['web:2', 'web:1']
    open(m, 'web:1')
    expect(m.infos(W1)[0]?.heldBy?.viewId).toBe('web:1')
    open(m, 'desktop:1')
    expect(m.infos(W1)[1]?.heldBy?.viewId).toBe('web:2')
    // An origin browser that left meanwhile: the window's other browser.
    gone.add('web:1')
    open(m, 'web:1')
    expect(m.infos(W1)[2]?.heldBy?.viewId).toBe('web:2')
  })

  it('a leaving holder passes the page to another browser, which loads it with the queued posts', () => {
    const { m, toView } = serverManager()
    browsers = ['web:2', 'web:1']
    const { id } = open(m)
    m.pageReady(W1, id, 'web:2')
    m.post(W1, id, '1')
    gone.add('web:2')
    m.viewGone('web:2')
    expect(lastStack(W1)[0]).toMatchObject({ heldBy: { viewId: 'web:1', device: 'Phone' }, loading: true })
    m.post(W1, id, '2')
    // Neither the hidden page nor the old holder delivers it.
    m.pageReady(W1, id, 'desktop:1')
    m.pageReady(W1, id, 'web:2')
    expect(messages(toView)).toEqual([['web:2', '1']])
    m.pageReady(W1, id, 'web:1')
    expect(messages(toView)).toEqual([
      ['web:2', '1'],
      ['web:1', '2']
    ])
  })

  it('with no browser attached the page waits, its posts kept, for the first browser to list the stack', async () => {
    const { m, toView } = serverManager()
    const { id, result } = open(m)
    // Nobody holds it: no heldBy, `waiting` (no view draws the page), and nothing reaches any view.
    expect(m.infos(W1)[0]).not.toHaveProperty('heldBy')
    expect(m.infos(W1)[0]?.waiting).toBe(true)
    m.post(W1, id, '"queued"')
    m.pageReady(W1, id, 'desktop:1')
    expect(m.result(W1, id, 'hidden', 'desktop:1')).toBe(false)
    expect(toView).toEqual([])
    expect(events.filter((e) => e.channel === 'overlays.message')).toEqual([])
    // The hidden page's own reload (list) does not take it.
    m.list(W1, 'desktop:1')
    expect(m.infos(W1)[0]).not.toHaveProperty('heldBy')
    // The first browser lists the stack: it holds the page now, and the window's views are told.
    const listed = m.list(W1, 'web:3')
    expect(listed[0]).toMatchObject({ heldBy: { viewId: 'web:3', device: 'Laptop' }, loading: true })
    expect(listed[0]).not.toHaveProperty('waiting')
    expect(lastStack(W1)[0]?.heldBy?.viewId).toBe('web:3')
    // A second browser listing later does not move it.
    m.list(W1, 'web:1')
    expect(m.infos(W1)[0]?.heldBy?.viewId).toBe('web:3')
    m.pageReady(W1, id, 'web:3')
    expect(messages(toView)).toEqual([['web:3', '"queued"']])
    expect(m.result(W1, id, 'answer', 'web:3')).toBe(true)
    await expect(result).resolves.toEqual({ kind: 'value', value: 'answer' })
  })

  it('the last holder leaving with no other browser: the page waits again, then goes to the next to list', () => {
    const { m, toView } = serverManager()
    browsers = ['web:1']
    const { id } = open(m)
    m.pageReady(W1, id, 'web:1')
    gone.add('web:1')
    m.viewGone('web:1')
    expect(lastStack(W1)[0]).not.toHaveProperty('heldBy')
    expect(lastStack(W1)[0]?.loading).toBe(true)
    m.post(W1, id, '"later"')
    m.pageReady(W1, id, 'desktop:1')
    expect(toView).toEqual([])
    m.list(W1, 'web:2')
    m.pageReady(W1, id, 'web:2')
    expect(messages(toView)).toEqual([['web:2', '"later"']])
  })

  it('a holder leaving while another browser has not listed yet: handed over once, no double delivery', () => {
    const { m, toView } = serverManager()
    browsers = ['web:1']
    const { id } = open(m)
    m.post(W1, id, '"q"')
    // web:2 attached (browserViews) but has not listed; web:1 leaves.
    browsers = ['web:1', 'web:2']
    gone.add('web:1')
    m.viewGone('web:1')
    expect(m.infos(W1)[0]?.heldBy?.viewId).toBe('web:2')
    // Its own list is a reload of a page it holds: the queue is delivered once, not twice.
    m.list(W1, 'web:2')
    m.pageReady(W1, id, 'web:2')
    m.pageReady(W1, id, 'web:2')
    expect(messages(toView)).toEqual([['web:2', '"q"']])
  })

  it('the opener closing a waiting overlay drops it: a later list finds nothing', async () => {
    const { m, toView } = serverManager()
    const { id, result } = open(m)
    m.post(W1, id, '"never"')
    expect(m.close(W1, id)).toBe(true)
    await result
    expect(m.list(W1, 'web:1')).toEqual([])
    expect(toView).toEqual([])
  })

  it('the outbox stays bounded while the page waits for a browser', () => {
    const { m } = serverManager()
    const { id } = open(m)
    for (let i = 0; i < MAX_QUEUED_OVERLAY_MESSAGES; i++) m.post(W1, id, String(i))
    expect(() => m.post(W1, id, 'more')).toThrow('queue is full')
  })

  it('a browser may still take over; terminal overlays are never held', () => {
    const { m } = serverManager()
    browsers = ['web:1', 'web:2']
    const { id } = open(m)
    expect(m.take(W1, 'web:2', id)).toBe(true)
    expect(m.infos(W1)[0]?.heldBy?.viewId).toBe('web:2')
    void m.open(W1, terminal(['sleep', '9']), 'test')
    m.list(W1, 'web:3')
    expect(m.infos(W1)[1]).not.toHaveProperty('heldBy')
  })

  it('on the desktop the rule is unchanged: the desktop holds by default and takes back from a leaving browser', () => {
    const { m } = serverManager(false)
    browsers = ['web:1']
    const { id } = open(m)
    expect(m.infos(W1)[0]).not.toHaveProperty('heldBy')
    m.list(W1, 'web:1')
    expect(m.infos(W1)[0]).not.toHaveProperty('heldBy')
    expect(m.take(W1, 'web:1', id)).toBe(true)
    m.viewGone('web:1')
    expect(m.infos(W1)[0]).not.toHaveProperty('heldBy')
    expect(m.take(W1, 'desktop:1', id)).toBe(true)
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

  it("a browser loading the shell does not reset a terminal overlay's flow (only the desktop page's reload does)", () => {
    const m = manager()
    void m.open(W1, terminal(['yes']), 'test')
    const pty = backend.last
    pty.emit('y'.repeat(2 * 1024 * 1024))
    expect(pty.paused).toBe(true)
    m.list(W1, 'web:1')
    expect(pty.paused).toBe(true)
  })

  it('terminal sizes are per view: the first to measure sizes it, typing in another view moves it, a leaving view gives it back', () => {
    const m = manager()
    void m.open(W1, terminal(['revdiff']), 'test')
    const pty = backend.last
    const id = m.infos(W1)[0]!.id
    m.resize(W1, id, 120, 40)
    // A phone showing the same overlay: remembered, the pty keeps the desktop's size.
    m.resize(W1, id, 50, 30, 'web:1')
    m.resize(W1, id, 30, 50, 'web:1')
    expect(pty.resizes).toEqual([[120, 40]])
    // A focus or mouse report is not the person typing there.
    m.input(W1, id, '\x1b[I', 'web:1')
    expect(pty.resizes).toEqual([[120, 40]])
    m.input(W1, id, 'j', 'web:1')
    expect(pty.resizes).toEqual([[120, 40], [30, 50]])
    // The desktop's own refit is only remembered while the phone sizes it; its typing takes it back.
    m.resize(W1, id, 130, 40)
    expect(pty.resizes).toEqual([[120, 40], [30, 50]])
    m.input(W1, id, 'k')
    m.input(W1, id, 'k')
    expect(pty.resizes).toEqual([[120, 40], [30, 50], [130, 40]])
    m.input(W1, id, 'j', 'web:1')
    m.viewGone('web:1')
    expect(pty.resizes).toEqual([[120, 40], [30, 50], [130, 40], [30, 50], [130, 40]])
  })

  it("only the sizing view answers a terminal overlay's queries: the others' replies are stripped, their keys pass", () => {
    const m = manager()
    void m.open(W1, terminal(['revdiff']), 'test')
    const pty = backend.last
    const id = m.infos(W1)[0]!.id
    const da1 = '\x1b[?62;22c'
    const osc11 = '\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\'
    m.resize(W1, id, 120, 40)
    m.resize(W1, id, 50, 30, 'web:1')
    // Both views' xterms answer DA1 and OSC 11 at start: only the desktop's (the sizer) reaches the pty.
    m.input(W1, id, da1 + osc11)
    m.input(W1, id, da1 + osc11, 'web:1')
    expect(pty.writes).toEqual([da1 + osc11])
    // A browser's late reply glued to a key keeps the key.
    m.input(W1, id, osc11 + 'j', 'web:1')
    expect(pty.writes).toEqual([da1 + osc11, 'j'])
    // The browser typed, so it sizes the overlay and answers now; the desktop's replies are stripped, its focus report passes.
    m.input(W1, id, da1, 'web:1')
    m.input(W1, id, da1)
    m.input(W1, id, '\x1b[I')
    expect(pty.writes).toEqual([da1 + osc11, 'j', da1, '\x1b[I'])
    // Back to the desktop when the browser leaves.
    m.viewGone('web:1')
    m.input(W1, id, da1)
    expect(pty.writes).toEqual([da1 + osc11, 'j', da1, '\x1b[I', da1])
  })

  it('a hidden desktop that measured first hands size and answering to a browser that measured', () => {
    const m = manager()
    void m.open(W1, terminal(['revdiff']), 'test')
    const pty = backend.last
    const id = m.infos(W1)[0]!.id
    const da1 = '\x1b[?62;22c'
    // The window is minimized: its local refit still arrives before the browser's over the WebSocket.
    m.viewVisible(desktopViewId(W1), false)
    m.resize(W1, id, 120, 40)
    expect(pty.resizes).toEqual([[120, 40]])
    m.resize(W1, id, 50, 30, 'web:1')
    expect(pty.resizes).toEqual([[120, 40], [50, 30]])
    // The browser answers; the throttled desktop's late reply is stripped, and its refit is only remembered.
    m.input(W1, id, da1, 'web:1')
    m.input(W1, id, da1)
    m.resize(W1, id, 130, 40)
    expect(pty.writes).toEqual([da1])
    expect(pty.resizes).toEqual([[120, 40], [50, 30]])
    // A hidden desktop typing (a stray key) does not take it either.
    m.input(W1, id, 'j')
    expect(pty.resizes).toEqual([[120, 40], [50, 30]])
    // Shown again, the desktop takes it back only once the browser is hidden or it types.
    m.viewVisible(desktopViewId(W1), true)
    expect(pty.resizes).toEqual([[120, 40], [50, 30]])
    m.input(W1, id, 'k')
    expect(pty.resizes).toEqual([[120, 40], [50, 30], [130, 40]])
  })

  it('a hidden sizer hands the overlay to the visible view active last; nobody visible keeps the size', () => {
    const m = manager()
    void m.open(W1, terminal(['revdiff']), 'test')
    const pty = backend.last
    const id = m.infos(W1)[0]!.id
    const da1 = '\x1b[?62;22c'
    m.resize(W1, id, 120, 40)
    m.resize(W1, id, 60, 20, 'web:2')
    m.resize(W1, id, 50, 30, 'web:1')
    m.input(W1, id, 'j', 'web:1')
    expect(pty.resizes).toEqual([[120, 40], [50, 30]])
    // The browser tab goes to the background: web:2 measured last after it, so it sizes and answers.
    m.viewVisible('web:1', false)
    expect(pty.resizes).toEqual([[120, 40], [50, 30], [60, 20]])
    m.input(W1, id, da1, 'web:1')
    m.input(W1, id, da1, 'web:2')
    expect(pty.writes).toEqual(['j', da1])
    // web:2 hidden too: the desktop is the one visible view left.
    m.viewVisible('web:2', false)
    expect(pty.resizes).toEqual([[120, 40], [50, 30], [60, 20], [120, 40]])
    // Every view hidden: the size stays, the desktop answers until one shows again, which takes it.
    m.viewVisible(desktopViewId(W1), false)
    expect(pty.resizes).toEqual([[120, 40], [50, 30], [60, 20], [120, 40]])
    m.input(W1, id, da1)
    expect(pty.writes).toEqual(['j', da1, da1])
    m.viewVisible('web:1', true)
    expect(pty.resizes).toEqual([[120, 40], [50, 30], [60, 20], [120, 40], [50, 30]])
  })

  it('a hidden desktop that is the only view still sizes and answers (web access off)', () => {
    const m = manager()
    void m.open(W1, terminal(['cat']), 'test')
    const pty = backend.last
    const id = m.infos(W1)[0]!.id
    m.viewVisible(desktopViewId(W1), false)
    m.resize(W1, id, 80, 24)
    m.resize(W1, id, 100, 30)
    m.input(W1, id, '\x1b[?62;22c')
    expect(pty.resizes).toEqual([[80, 24], [100, 30]])
    expect(pty.writes).toEqual(['\x1b[?62;22c'])
  })

  it('server mode: the hidden page never sizes nor answers a terminal overlay, even as its only view', () => {
    const m = manager({ server: true })
    void m.open(W1, terminal(['revdiff']), 'test')
    const pty = backend.last
    const id = m.infos(W1)[0]!.id
    const da1 = '\x1b[?62;22c'
    // The only view, visible or hidden, measuring and typing: nothing sizes, its replies are
    // stripped and its keys pass (nobody types there, but a key is never eaten).
    m.resize(W1, id, 58, 18)
    m.input(W1, id, da1 + 'j')
    m.viewVisible(desktopViewId(W1), false)
    m.resize(W1, id, 60, 20)
    m.input(W1, id, da1)
    expect(pty.resizes).toEqual([])
    expect(pty.writes).toEqual(['j'])
    // A browser that measures sizes it at once and answers; the hidden page still does not.
    m.viewVisible(desktopViewId(W1), true)
    m.resize(W1, id, 100, 30, 'web:1')
    m.input(W1, id, da1, 'web:1')
    m.input(W1, id, da1)
    m.input(W1, id, 'k')
    expect(pty.resizes).toEqual([[100, 30]])
    expect(pty.writes).toEqual(['j', da1, 'k'])
    // The browser leaves: its size stays on the pty, and nobody answers until the next browser.
    m.viewGone('web:1')
    m.resize(W1, id, 62, 21)
    m.input(W1, id, da1)
    expect(pty.resizes).toEqual([[100, 30]])
    expect(pty.writes).toEqual(['j', da1, 'k'])
    m.resize(W1, id, 90, 25, 'web:2')
    m.input(W1, id, da1, 'web:2')
    expect(pty.resizes).toEqual([[100, 30], [90, 25]])
    expect(pty.writes).toEqual(['j', da1, 'k', da1])
  })

  it('a terminal overlay with the desktop as its only view gets its input as it is (web access off)', () => {
    const m = manager()
    void m.open(W1, terminal(['cat']), 'test')
    const pty = backend.last
    const id = m.infos(W1)[0]!.id
    // Before any measure, and after: the desktop answers.
    m.input(W1, id, '\x1b[1;1R')
    m.resize(W1, id, 80, 24)
    m.input(W1, id, '\x1b[?62;22c')
    expect(pty.writes).toEqual(['\x1b[1;1R', '\x1b[?62;22c'])
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
    clicks: {
      key: string
      pluginId: string
      buttonId: string
      query: OverlayTypeQuery
      view?: string
      settle: (v: { close: boolean }) => void
      fail: (e: Error) => void
    }[]
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
        view?: string
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
      click: (key, pluginId, buttonId, query, view) =>
        new Promise((settle, fail) => host.clicks.push({ key, pluginId, buttonId, query, view, settle, fail })),
      ended: (key) => host.ended.push(key)
    }
    return host
  }

  function typed(host: ReturnType<typeof fakeHost>, hostWindow = W1): OverlayManager {
    return new OverlayManager({
      ownerView: () => true,
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

  it("a click hands the plugin the clicking view when it is a remote one (origin-view.ts), none for the desktop's", async () => {
    const host = fakeHost()
    host.answer = [{ pluginId: 'p.mail', id: 'read', label: 'Mark read' }]
    const m = typed(host)
    const views: unknown[] = []
    const channel: OverlayChannel = {
      onMessage: () => {},
      onButton: (_buttonId, view) => {
        views.push(view)
        return Promise.resolve()
      }
    }
    void m.open(W1, { ...url(), type: fileSpec.type, buttons: [{ id: 'star', label: 'Star' }] }, 'plugin p.rev', undefined, channel, 'p.rev')
    await settle()
    const id = m.infos(W1)[0]!.id
    expect(m.buttonClick(W1, id, { source: 'opener', buttonId: 'star' }, 'web:4')).toBe(true)
    await settle()
    expect(m.buttonClick(W1, id, { source: 'opener', buttonId: 'star' }, 'desktop:1')).toBe(true)
    expect(views).toEqual(['web:4', undefined])
    expect(m.buttonClick(W1, id, { source: 'type', pluginId: 'p.mail', buttonId: 'read' }, 'web:4')).toBe(true)
    expect(host.clicks.at(-1)!.view).toBe('web:4')
    host.clicks.at(-1)!.settle({ close: false })
    await settle()
    expect(m.buttonClick(W1, id, { source: 'type', pluginId: 'p.mail', buttonId: 'read' }, 'desktop:1')).toBe(true)
    expect(host.clicks.at(-1)!.view).toBeUndefined()
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
      // Kept apart from `sent` so its toEqual checks stay as they were.
      origins: [] as string[],
      opened: [] as { windowId: number; prompt: string }[],
      selected: [] as { windowId: number; tabId: string; view?: string }[],
      /** Guest ids the gate was handed (03e A), kept apart like `origins`. */
      guestIds: [] as Array<string | undefined>,
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
      send: (tabId, text, origin, guestId) => {
        if (s.sendError) throw s.sendError
        s.sent.push({ tabId, text })
        s.origins.push(origin)
        s.guestIds.push(guestId)
        return { id: `item-${s.sent.length}`, delivered: s.delivered }
      },
      openSession: (windowId, prompt) => {
        if (s.openError) return Promise.reject(s.openError)
        s.opened.push({ windowId, prompt })
        return Promise.resolve({ tabId: `new${s.next++}` })
      },
      selectTab: (windowId, tabId, ...view) => s.selected.push({ windowId, tabId, ...(view.length > 0 ? { view: view[0] } : {}) })
    }
    return s
  }

  function withDiscuss(sessions: ReturnType<typeof fakeSessions>): OverlayManager {
    return new OverlayManager({
      ownerView: () => true,
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

  it("the opener's onDiscuss hears whose Send it was: an owner's browser, a guest's view, none for the desktop", async () => {
    const sessions = fakeSessions()
    const m = withDiscuss(sessions)
    const views: Array<string | undefined> = []
    const ch: OverlayChannel = {
      onMessage: () => {},
      onDiscuss: (view) => {
        views.push(view)
        return Promise.resolve(null)
      }
    }
    const openOne = (): string => {
      void m.open(W1, fileSpec, 'plugin p.rev', undefined, ch, 'p.rev')
      const id = m.infos(W1).at(-1)!.id
      m.setDiscussHandler(W1, id, true)
      return id
    }
    // An owner's browser used to act as the desktop here (the view was lost on the way).
    await expect(m.discuss(W1, openOne(), { kind: 'tab', tabId: 't1' }, undefined, 'web:3')).resolves.toMatchObject({ ok: true })
    await expect(m.discuss(W1, openOne(), { kind: 'tab', tabId: 't1' }, undefined, desktopViewId(W1))).resolves.toMatchObject({ ok: true })
    await expect(m.discuss(W1, openOne(), { kind: 'tab', tabId: 't1' })).resolves.toMatchObject({ ok: true })
    // A guest's Send with no explicit view: the guest's own.
    // seesOverlay: the router's overlay check (an overlay's guest without one is refused, fail closed).
    const guest = { id: 'g1', viewId: 'web:8', allowed: () => true, seesOverlay: () => true, openTab: () => Promise.resolve(null) }
    await expect(m.discuss(W1, openOne(), { kind: 'tab', tabId: 't1' }, guest)).resolves.toMatchObject({ ok: true })
    expect(views).toEqual(['web:3', undefined, undefined, 'web:8'])
    // The owner's browser selects as before (project-wide): only the opener learned the view.
    expect(sessions.selected.slice(0, 3).every((s) => s.view === undefined)).toBe(true)
  })

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
    // Only the opt-out is marked (the page's intro offers no Discuss then); a bare overlay may still get a handler.
    expect(off!.discussOff).toBe(true)
    for (const o of [typed, preferred, bare]) expect(o).not.toHaveProperty('discussOff')
    // A handler brings it to an untyped overlay, and takes it away again; discuss: false stays off.
    expect(m.setDiscussHandler(W1, bare!.id, true)).toBe(true)
    expect(m.infos(W1)[3]!.discuss).toEqual({})
    expect(lastStack(W1)[3]!.discuss).toEqual({})
    m.setDiscussHandler(W1, bare!.id, false)
    expect(m.infos(W1)[3]).not.toHaveProperty('discuss')
    m.setDiscussHandler(W1, off!.id, true)
    expect(m.infos(W1)[2]).not.toHaveProperty('discuss')
    expect(m.infos(W1)[2]!.discussOff).toBe(true)
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

  it("a write guest's Discuss (03e A): refused when its access changed while the opener answered; else sent with its id, selected in its view only", async () => {
    const sessions = fakeSessions()
    const m = withDiscuss(sessions)
    let allowed = true
    const guest = { id: 'g1', viewId: 'web:9' as const, allowed: () => allowed, seesOverlay: () => true, openTab: () => Promise.reject(new Error('no')) }
    const ch = opener(async () => {
      allowed = false
      return { text: 'ctx' }
    })
    track(m.open(W1, fileSpec, 'plugin p.rev', undefined, ch, 'p.rev'))
    const id = m.infos(W1)[0]!.id
    m.setDiscussHandler(W1, id, true)
    await expect(m.discuss(W1, id, { kind: 'tab', tabId: 't2' }, guest)).resolves.toEqual({ ok: false, error: "Not sent: your access changed" })
    expect(sessions.sent).toEqual([])
    expect(m.infos(W1)).toHaveLength(1)
    allowed = true
    const ok = opener(() => Promise.resolve({ text: 'ctx' }))
    track(m.open(W1, fileSpec, 'plugin p.rev', undefined, ok, 'p.rev'))
    const id2 = m.infos(W1).at(-1)!.id
    m.setDiscussHandler(W1, id2, true)
    await expect(m.discuss(W1, id2, { kind: 'tab', tabId: 't2' }, guest)).resolves.toEqual({ ok: true, tabId: 't2', queued: false })
    expect(sessions.guestIds).toEqual(['g1'])
    expect(sessions.selected).toEqual([{ windowId: W1, tabId: 't2', view: 'web:9' }])
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
    // `core`: the person clicked Send, so their typing in the tab neither refuses nor drops it.
    expect(sessions.origins).toEqual(['core'])
    await flush()
    expect(r.results).toEqual([{ kind: 'discussed', tabId: 't2', queued: false }])
    expect(m.infos(W1)).toEqual([])
    expect(sessions.selected).toEqual([{ windowId: W1, tabId: 't2' }])
  })

  it('appends the window project prompt for an existing tab and for New session', async () => {
    const sessions = fakeSessions()
    const prompts: Record<number, string | undefined> = { [W1]: 'Answer first.' }
    sessions.deps.prompt = (windowId) => prompts[windowId]
    const m = withDiscuss(sessions)
    void m.open(W1, fileSpec, 'plugin p.rev', undefined, undefined, 'p.rev')
    await m.discuss(W1, m.infos(W1)[0]!.id, { kind: 'tab', tabId: 't1' })
    void m.open(W1, fileSpec, 'plugin p.rev', undefined, undefined, 'p.rev')
    await m.discuss(W1, m.infos(W1)[0]!.id, { kind: 'new' })
    expect(sessions.sent[0]!.text).toBe('About: Review src/x.ts\nFile: src/x.ts\n\nAnswer first.')
    expect(sessions.opened[0]!.prompt).toBe('About: Review src/x.ts\nFile: src/x.ts\n\nAnswer first.')
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

describe('perView overlays: one copy per view (docs/design-overlay-views.md §5)', () => {
  const page = { kind: 'html', src: 'cc-plugin://a.one/review.html' }
  const D = desktopViewId(W1)
  /** Remote views that left (emitToView false, isViewLive false). */
  const gone = new Set<string>()
  /** Views that are a guest's (ownerView false). */
  const guests = new Set<string>()
  /** Guest views mayConnectCopy lets through. */
  const allowed = new Set<string>()
  /** The channel's calls, in order: what the opener (host-api, Task 3) hears. */
  let heard: Array<[string, ...unknown[]]>
  let toView: Array<{ viewId: string; channel: EventChannel; payload: unknown }>
  let reloads: Array<[string, number, string, string]>
  beforeEach(() => {
    gone.clear()
    guests.clear()
    allowed.clear()
    heard = []
    toView = []
    reloads = []
  })
  function pvManager(opts: { server?: boolean; log?: (m: string) => void; guestOf?: (viewId: string) => string | undefined } = {}): OverlayManager {
    const { log, ...rest } = opts
    return new OverlayManager({
      ownerView: (viewId) => !guests.has(viewId),
      ...rest,
      backend,
      views,
      isWindowOpen: () => true,
      env: () => ({}),
      emit: <C extends EventChannel>(windowId: number, channel: C, payload: IpcEventMap[C]) => {
        events.push({ windowId, channel, payload })
      },
      emitToView: <C extends EventChannel>(viewId: string, channel: C, payload: IpcEventMap[C]) => {
        toView.push({ viewId, channel, payload })
        return !gone.has(viewId)
      },
      isViewLive: (viewId) => !gone.has(viewId),
      mayConnectCopy: (_windowId, _overlayId, viewId) => allowed.has(viewId),
      reloadCopy: (viewId, windowId, overlayId, copy) => reloads.push([viewId, windowId, overlayId, copy]),
      deviceOf: () => 'Device',
      commandForChord: () => undefined,
      log: log ?? (() => {})
    })
  }
  const channel: OverlayChannel = {
    onMessage: (message, view, copy) => heard.push(['message', message, view, copy]),
    onConnect: (copy, view) => heard.push(['connect', copy, view]),
    onDisconnect: (copy, view) => heard.push(['disconnect', copy, view])
  }
  function openPv(m: OverlayManager, perView = true): { result: Promise<OverlayResult>; id: string } {
    const result = m.open(W1, page, 'plugin a.one', undefined, channel, 'a.one', undefined, undefined, { perView })
    return { result, id: m.infos(W1).at(-1)!.id }
  }
  function connect(m: OverlayManager, id: string, view: string): string {
    const r = m.connectCopy(W1, id, view)
    if (!r.ok) throw new Error(`connect refused: ${r.reason}`)
    return r.copy
  }
  /** The messages each view got, as [view, copy, message]. */
  const sent = (): Array<[string, string | undefined, string]> =>
    toView
      .filter((e) => e.channel === 'overlays.message')
      .map((e) => {
        const p = e.payload as { message: string; copy?: string }
        return [e.viewId, p.copy, p.message]
      })

  it('info says perView, with no holder, no waiting and no window-wide loader', () => {
    const m = pvManager()
    openPv(m)
    const info = m.infos(W1)[0]!
    expect(info.perView).toBe(true)
    expect(info).not.toHaveProperty('heldBy')
    expect(info).not.toHaveProperty('waiting')
    expect(info).not.toHaveProperty('loading')
    // Opened from a browser it is still nobody's page.
    void m.open(W1, page, 'plugin a.one', undefined, channel, 'a.one', 'web:1', undefined, { perView: true })
    expect(m.infos(W1)[1]).not.toHaveProperty('heldBy')
    // The flag is for html only; a terminal overlay ignores it.
    void m.open(W1, terminal(['sleep', '9']), 'test', undefined, undefined, undefined, undefined, undefined, { perView: true })
    expect(m.infos(W1)[2]).not.toHaveProperty('perView')
  })

  it('connect, release and viewGone fire connect and disconnect in order; copy ids are 128-bit hex', () => {
    const m = pvManager()
    const { id } = openPv(m)
    const a = connect(m, id, D)
    const b = connect(m, id, 'web:1')
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(b).not.toBe(a)
    expect(m.copies(W1, id).map((c) => c.view)).toEqual([D, 'web:1'])
    expect(m.releaseCopy(W1, id, D, a)).toBe(true)
    m.viewGone('web:1')
    expect(heard).toEqual([
      ['connect', a, D],
      ['connect', b, 'web:1'],
      ['disconnect', a, D],
      ['disconnect', b, 'web:1']
    ])
    expect(m.copies(W1, id)).toEqual([])
    // The overlay itself stays open for the next view.
    expect(m.infos(W1)).toHaveLength(1)
  })

  it("a view's reconnect replaces its copy: disconnect of the old one, then connect of the new", () => {
    const m = pvManager()
    const { id } = openPv(m)
    const first = connect(m, id, 'web:1')
    const other = connect(m, id, 'web:2')
    const second = connect(m, id, 'web:1')
    expect(second).not.toBe(first)
    expect(heard.slice(2)).toEqual([
      ['disconnect', first, 'web:1'],
      ['connect', second, 'web:1']
    ])
    expect(m.copies(W1, id).map((c) => c.copy).sort()).toEqual([other, second].sort())
  })

  it("server mode: the hidden page never gets a copy; a browser does", () => {
    const m = pvManager({ server: true })
    const { id } = openPv(m)
    expect(m.connectCopy(W1, id, D)).toEqual({ ok: false, reason: 'hidden-page' })
    expect(connect(m, id, 'web:1')).toMatch(/^[0-9a-f]{32}$/)
    // Listing the stack never makes a browser "hold" it.
    m.list(W1, 'web:1')
    expect(m.infos(W1)[0]).not.toHaveProperty('heldBy')
    expect(m.infos(W1)[0]).not.toHaveProperty('waiting')
    expect(heard.map((h) => h[0])).toEqual(['connect'])
  })

  // Task 5 review: a read guest's hide (overlays.release { hide }) holds with no live copy and no port.
  it("guestHide records a guest's hide with no copy and a `none` port; never an owner view's or a non-perView overlay's", () => {
    const m = pvManager({ guestOf: (v) => (guests.has(v) ? 'g1' : undefined) })
    const { id } = openPv(m)
    guests.add('web:7')
    guests.add('web:8')
    // mayConnectCopy refuses web:7 (port `none`): no copy could ever connect, the ✕ still hides.
    expect(m.connectCopy(W1, id, 'web:7')).toEqual({ ok: false, reason: 'not-allowed' })
    expect(m.guestHide(W1, id, D)).toBe(false)
    expect(m.guestHide(W1, id, 'web:3')).toBe(false)
    expect(m.hiddenFrom(W1, id, 'g1')).toBe(false)
    // The same guest's other view has a copy: it goes with the hide.
    allowed.add('web:8')
    const other = connect(m, id, 'web:8')
    expect(m.guestHide(W1, id, 'web:7')).toBe(true)
    expect(m.hiddenFrom(W1, id, 'g1')).toBe(true)
    expect(m.copies(W1, id)).toEqual([])
    expect(toView).toContainEqual({ viewId: 'web:8', channel: 'overlays.hide', payload: { overlayId: id, copy: other } })
    // It holds: a reconnect of the same guest is refused even where the port allows it; a repeat is true.
    expect(m.connectCopy(W1, id, 'web:8')).toEqual({ ok: false, reason: 'not-allowed' })
    expect(m.guestHide(W1, id, 'web:7')).toBe(true)
    const plain = openPv(m, false)
    expect(m.guestHide(W1, plain.id, 'web:7')).toBe(false)
  })

  it('a guest view connects only when mayConnectCopy says so; owner views always may', () => {
    const m = pvManager()
    const { id } = openPv(m)
    guests.add('web:7')
    expect(m.connectCopy(W1, id, 'web:7')).toEqual({ ok: false, reason: 'not-allowed' })
    allowed.add('web:7')
    const guestCopy = m.connectCopy(W1, id, 'web:7')
    expect(guestCopy.ok).toBe(true)
    // A guest's copy talks, but its result never settles the opener (owner views only).
    if (guestCopy.ok) expect(m.copyResult(W1, id, 'web:7', guestCopy.copy, { pick: 1 })).toBe(false)
    expect(m.infos(W1)).toHaveLength(1)
    // Fail closed: with no mayConnectCopy wired, a guest gets nothing.
    const bare = new OverlayManager({
      ownerView: (viewId) => viewId !== 'web:7',
      backend,
      views,
      isWindowOpen: () => true,
      env: () => ({}),
      emit: () => {},
      commandForChord: () => undefined,
      log: () => {}
    })
    void bare.open(W1, page, 'plugin a.one', undefined, channel, 'a.one', undefined, undefined, { perView: true })
    const bareId = bare.infos(W1)[0]!.id
    expect(bare.connectCopy(W1, bareId, 'web:7')).toEqual({ ok: false, reason: 'not-allowed' })
    expect(bare.connectCopy(W1, bareId, 'web:1').ok).toBe(true)
  })

  it('refuses unknown overlays, non-perView ones, another window and a gone browser', () => {
    const m = pvManager()
    const { id } = openPv(m)
    const { id: plain } = openPv(m, false)
    expect(m.connectCopy(W1, 'nope', D)).toEqual({ ok: false, reason: 'unknown' })
    expect(m.connectCopy(W2, id, desktopViewId(W2))).toEqual({ ok: false, reason: 'unknown' })
    expect(m.connectCopy(W1, plain, D)).toEqual({ ok: false, reason: 'not-per-view' })
    expect(m.connectCopy(W1, id, desktopViewId(W2))).toEqual({ ok: false, reason: 'not-allowed' })
    gone.add('web:3')
    expect(m.connectCopy(W1, id, 'web:3')).toEqual({ ok: false, reason: 'not-allowed' })
    expect(heard).toEqual([])
  })

  it("a stale copy's loaded, ready, message and result are dropped and never touch its successor", async () => {
    const m = pvManager()
    const { id, result } = openPv(m)
    const r = track(result)
    const old = connect(m, id, 'web:1')
    const next = connect(m, id, 'web:1')
    expect(m.copyReady(W1, id, 'web:1', old)).toBe(false)
    expect(m.copyLoaded(W1, id, 'web:1', old)).toBe(false)
    expect(m.copyMessage(W1, id, 'web:1', old, '"late"')).toBe(false)
    expect(m.copyResult(W1, id, 'web:1', old, 1)).toBe(false)
    expect(m.copyState(W1, id, 'web:1', next)).toEqual({ copy: next, view: 'web:1', joined: false, ready: false, loaded: false })
    // Another view naming a live copy that is not its own is dropped the same way.
    expect(m.copyMessage(W1, id, 'web:2', next, '"forged"')).toBe(false)
    expect(m.copyResult(W1, id, D, next, 1)).toBe(false)
    expect(m.copyState(W1, id, 'web:2', next)).toBeUndefined()
    expect(m.releaseCopy(W1, id, 'web:2', next)).toBe(false)
    expect(m.releaseCopy(W1, id, 'web:1', old)).toBe(false)
    expect(m.releaseCopy(W1, id, 'web:1', 42)).toBe(false)
    expect(heard.filter((h) => h[0] === 'message')).toEqual([])
    // The live copy's own traffic counts.
    expect(m.copyMessage(W1, id, 'web:1', next, '{"a":1}')).toBe(true)
    expect(heard.at(-1)).toEqual(['message', { a: 1 }, 'web:1', next])
    expect(m.copyMessage(W1, id, D, connect(m, id, D), '"desk"')).toBe(true)
    // The desktop is no remote view: absent, as for a holder's message.
    expect(heard.at(-1)?.slice(0, 3)).toEqual(['message', 'desk', undefined])
    expect(m.copyResult(W1, id, 'web:1', next, { ok: true })).toBe(true)
    await flush()
    expect(r.results).toEqual([{ kind: 'value', value: { ok: true } }])
    expect(m.infos(W1)).toEqual([])
  })

  it('the holder paths never act on a perView overlay', () => {
    const m = pvManager()
    const { id } = openPv(m)
    const copy = connect(m, id, D)
    expect(m.result(W1, id, 1, D)).toBe(false)
    expect(m.pageMessage(W1, id, '"x"', D)).toBe(false)
    m.pageReady(W1, id, D)
    m.pageLoaded(W1, id, D)
    expect(m.copyState(W1, id, D, copy)).toMatchObject({ ready: false, loaded: false })
    expect(m.infos(W1)).toHaveLength(1)
  })

  it('a broadcast before the first targeted post is neither delivered nor queued; the targeted post joins', () => {
    const m = pvManager()
    const { id } = openPv(m)
    const a = connect(m, id, 'web:1')
    m.copyReady(W1, id, 'web:1', a)
    expect(m.post(W1, id, '"early"')).toBe(true)
    expect(sent()).toEqual([])
    expect(m.copyState(W1, id, 'web:1', a)?.joined).toBe(false)
    expect(m.post(W1, id, '"init"', { copy: a })).toBe(true)
    expect(m.copyState(W1, id, 'web:1', a)?.joined).toBe(true)
    m.post(W1, id, '"later"')
    expect(sent()).toEqual([
      ['web:1', a, '"init"'],
      ['web:1', a, '"later"']
    ])
    // A copy that joined before its port was up: its starting state and later broadcasts wait in its own
    // queue and go out in order at its ready; the unjoined copy gets nothing.
    const b = connect(m, id, 'web:2')
    m.post(W1, id, '"b-init"', { copy: b })
    m.post(W1, id, '"both"')
    const c = connect(m, id, D)
    m.post(W1, id, '"no-c"')
    expect(sent().slice(2)).toEqual([
      ['web:1', a, '"both"'],
      ['web:1', a, '"no-c"']
    ])
    m.copyReady(W1, id, 'web:2', b)
    expect(sent().slice(4)).toEqual([
      ['web:2', b, '"b-init"'],
      ['web:2', b, '"both"'],
      ['web:2', b, '"no-c"']
    ])
    m.copyReady(W1, id, D, c)
    expect(sent()).toHaveLength(7)
    // Nothing went to the window as a whole.
    expect(events.filter((e) => e.channel === 'overlays.message')).toEqual([])
  })

  it('a post to a gone copy is dropped; copy on a plain overlay names nothing', () => {
    const m = pvManager()
    const { id } = openPv(m)
    const a = connect(m, id, 'web:1')
    m.releaseCopy(W1, id, 'web:1', a)
    expect(m.post(W1, id, '"x"', { copy: a })).toBe(false)
    expect(m.post(W1, id, '"x"', { copy: 'made-up' })).toBe(false)
    expect(sent()).toEqual([])
    const { id: plain } = openPv(m, false)
    expect(m.post(W1, plain, '"x"', { copy: a })).toBe(false)
    // An oversized message is still the opener's own error.
    expect(() => m.post(W1, id, 'x'.repeat(MAX_OVERLAY_MESSAGE_LENGTH + 1))).toThrow(RangeError)
  })

  it("an overflowing copy is dropped and reloaded alone; the post still succeeds for the others and never throws", () => {
    const m = pvManager()
    const { id } = openPv(m)
    const slow = connect(m, id, 'web:1')
    const fast = connect(m, id, 'web:2')
    m.copyReady(W1, id, 'web:2', fast)
    m.post(W1, id, '"s"', { copy: slow })
    m.post(W1, id, '"f"', { copy: fast })
    // The slow copy's queue fills (its starting state plus 99 broadcasts), the next broadcast overflows it.
    for (let i = 0; i < MAX_QUEUED_OVERLAY_MESSAGES - 1; i++) expect(m.post(W1, id, `${i}`)).toBe(true)
    expect(reloads).toEqual([])
    expect(() => m.post(W1, id, '"over"')).not.toThrow()
    expect(reloads).toEqual([['web:1', W1, id, slow]])
    expect(heard.at(-1)).toEqual(['disconnect', slow, 'web:1'])
    expect(m.copies(W1, id).map((c) => c.copy)).toEqual([fast])
    // The fast copy got every one of them, the last included.
    expect(sent().filter(([v]) => v === 'web:2')).toHaveLength(MAX_QUEUED_OVERLAY_MESSAGES + 1)
    expect(sent().at(-1)).toEqual(['web:2', fast, '"over"'])
    // Its successor starts clean.
    const again = connect(m, id, 'web:1')
    m.post(W1, id, '"fresh"', { copy: again })
    m.copyReady(W1, id, 'web:1', again)
    expect(sent().at(-1)).toEqual(['web:1', again, '"fresh"'])
  })

  it("connectReady's answer says whether the copy's loader is gone already: a `load` overlay yes, a `manual` one not until its loaded", () => {
    const m = pvManager()
    const { id } = openPv(m)
    expect(m.connectReady(W1, id, 'web:1')).toEqual({ copy: expect.any(String), loaded: true })
    m.open(W1, { ...page, ready: 'manual' }, 'plugin a.one', undefined, channel, 'a.one', undefined, undefined, { perView: true })
    const manual = m.infos(W1).at(-1)!.id
    const answer = m.connectReady(W1, manual, 'web:1')
    expect(answer).toEqual({ copy: expect.any(String) })
    const copy = (answer as { copy: string }).copy
    expect(m.copyLoaded(W1, manual, 'web:1', copy)).toBe(true)
    expect(m.copyState(W1, manual, 'web:1', copy)?.loaded).toBe(true)
  })

  it("the size bound overflows a copy too, and a targeted post's overflow does not throw", () => {
    const m = pvManager()
    const { id } = openPv(m)
    const slow = connect(m, id, 'web:1')
    const big = `"${'x'.repeat(MAX_OVERLAY_MESSAGE_LENGTH - 2)}"`
    let posted = 0
    while (posted * big.length <= MAX_QUEUED_OVERLAY_LENGTH) {
      expect(() => m.post(W1, id, big, { copy: slow })).not.toThrow()
      posted++
    }
    expect(reloads).toEqual([['web:1', W1, id, slow]])
    expect(m.copies(W1, id)).toEqual([])
  })

  it('a ready copy whose view could not take a message is released, not queued for ever, with no reload', () => {
    const m = pvManager()
    const { id } = openPv(m)
    const a = connect(m, id, 'web:1')
    m.copyReady(W1, id, 'web:1', a)
    m.post(W1, id, '"init"', { copy: a })
    gone.add('web:1')
    expect(m.post(W1, id, '"lost"', { copy: a })).toBe(false)
    expect(heard.at(-1)).toEqual(['disconnect', a, 'web:1'])
    expect(m.copies(W1, id)).toEqual([])
    // That sink fails only for a closed view, so a reload over it could never arrive: none is sent, and the
    // view's next connect is a new copy.
    expect(reloads).toEqual([])
    gone.delete('web:1')
    expect(connect(m, id, 'web:1')).not.toBe(a)
  })

  it("the opener's hide of the desktop's copy uncovers the desktop while another view still shows it; a new copy covers again", () => {
    const m = pvManager()
    const { id } = openPv(m)
    const d = connect(m, id, D)
    connect(m, id, 'web:1')
    expect(m.coversDesktop(W1)).toBe(true)
    const before = events.length
    expect(m.hideCopy(W1, id, d)).toBe(true)
    expect(m.coversDesktop(W1)).toBe(false)
    // The list went out again, so main's listener decides covering anew.
    expect(events.slice(before).some((e) => e.channel === 'overlays.updated')).toBe(true)
    expect(m.infos(W1).map((o) => o.id)).toEqual([id])
    const after = events.length
    connect(m, id, D)
    expect(m.coversDesktop(W1)).toBe(true)
    expect(events.slice(after).some((e) => e.channel === 'overlays.updated')).toBe(true)
    // The desktop view going clears it too (its hide is per view, never per person).
    expect(m.hideCopy(W1, id, m.copies(W1, id).find((c) => c.view === D)!.copy)).toBe(true)
    expect(m.coversDesktop(W1)).toBe(false)
    m.viewGone(D)
    expect(m.coversDesktop(W1)).toBe(true)
  })

  it('a non-perView overlay always covers the desktop; hiding a browser copy leaves the desktop covered', () => {
    const m = pvManager()
    openPv(m, false)
    expect(m.coversDesktop(W1)).toBe(true)
    const m2 = pvManager()
    const { id } = openPv(m2)
    const w = connect(m2, id, 'web:1')
    expect(m2.hideCopy(W1, id, w)).toBe(true)
    expect(m2.coversDesktop(W1)).toBe(true)
    expect(m2.coversDesktop(W2)).toBe(false)
  })

  it('connects per (overlay, view) are capped like panel ports; another view keeps its budget', () => {
    const m = pvManager()
    const { id } = openPv(m)
    for (let i = 0; i < 10; i++) expect(m.connectCopy(W1, id, 'web:1').ok).toBe(true)
    expect(m.connectCopy(W1, id, 'web:1')).toEqual({ ok: false, reason: 'cap' })
    // The refusal released nothing: the view keeps its last copy.
    expect(m.copies(W1, id).map((c) => c.view)).toEqual(['web:1'])
    expect(m.connectCopy(W1, id, 'web:2').ok).toBe(true)
    vi.advanceTimersByTime(10_000)
    expect(m.connectCopy(W1, id, 'web:1').ok).toBe(true)
  })

  it('take over is refused for a perView overlay with a clear error; an unknown id still answers false', () => {
    const m = pvManager()
    const { id } = openPv(m)
    expect(() => m.take(W1, 'web:1', id)).toThrow(/not offered/)
    expect(m.take(W1, 'web:1', 'nope')).toBe(false)
  })

  it("loaded is per copy: one copy's report never clears another's loader, and the info never changes", () => {
    const m = pvManager()
    const { id } = openPv(m)
    const a = connect(m, id, D)
    const b = connect(m, id, 'web:1')
    const updates = events.filter((e) => e.channel === 'overlays.updated').length
    // `ready: 'load'` (the default): a copy's port clears that copy's loader.
    m.copyReady(W1, id, D, a)
    expect(m.copyState(W1, id, D, a)).toMatchObject({ ready: true, loaded: true })
    expect(m.copyState(W1, id, 'web:1', b)).toMatchObject({ ready: false, loaded: false })
    expect(events.filter((e) => e.channel === 'overlays.updated')).toHaveLength(updates)
    expect(m.infos(W1)[0]).not.toHaveProperty('loading')

    // `ready: 'manual'`: the port is not the loader; the page's own word is, per copy.
    void m.open(W1, { ...page, ready: 'manual' }, 'plugin a.one', undefined, channel, 'a.one', undefined, undefined, { perView: true })
    const manual = m.infos(W1)[1]!.id
    const c = connect(m, manual, D)
    const d = connect(m, manual, 'web:1')
    m.copyReady(W1, manual, D, c)
    expect(m.copyState(W1, manual, D, c)).toMatchObject({ ready: true, loaded: false })
    expect(m.copyLoaded(W1, manual, 'web:1', d)).toBe(true)
    expect(m.copyState(W1, manual, 'web:1', d)?.loaded).toBe(true)
    expect(m.copyState(W1, manual, D, c)?.loaded).toBe(false)
  })

  it('the overlay ending (✕) drops its copies with no disconnects', async () => {
    const m = pvManager()
    const { id, result } = openPv(m)
    const r = track(result)
    const a = connect(m, id, 'web:1')
    m.post(W1, id, '"queued"', { copy: a })
    expect(m.close(W1, id)).toBe(true)
    await flush()
    expect(r.results).toEqual([{ kind: 'dismissed' }])
    expect(heard).toEqual([['connect', a, 'web:1']])
    expect(m.copies(W1, id)).toEqual([])
    expect(m.copyReady(W1, id, 'web:1', a)).toBe(false)
    expect(sent()).toEqual([])
  })

  it('a non-perView overlay keeps one holder alongside a perView one', () => {
    const m = pvManager()
    const { id: pv } = openPv(m)
    const { id: plain } = openPv(m, false)
    connect(m, pv, 'web:1')
    expect(m.infos(W1)[1]).not.toHaveProperty('perView')
    expect(m.infos(W1)[1]?.loading).toBe(true)
    m.pageReady(W1, plain, D)
    m.post(W1, plain, '"held"')
    expect(toView.at(-1)).toEqual({ viewId: D, channel: 'overlays.message', payload: { overlayId: plain, message: '"held"' } })
    expect(m.take(W1, 'web:1', plain)).toBe(true)
    expect(m.infos(W1)[1]?.heldBy).toEqual({ viewId: 'web:1', device: 'Device' })
  })

  // Task 2 review (a): a guest's copy is a real copy once admitted, yet its result settles nothing; an owner
  // copy's result ends the overlay for every copy at once.
  it("copyResult refuses an admitted guest's copy; an owner copy's result ends it for every copy, with no disconnects", async () => {
    const m = pvManager()
    const { id, result } = openPv(m)
    const r = track(result)
    guests.add('web:7')
    allowed.add('web:7')
    const guest = connect(m, id, 'web:7')
    const desk = connect(m, id, D)
    const browser = connect(m, id, 'web:1')
    for (const [v, c] of [['web:7', guest], [D, desk], ['web:1', browser]] as const) m.copyReady(W1, id, v, c)
    expect(m.copyResult(W1, id, 'web:7', guest, { pick: 'guest' })).toBe(false)
    await flush()
    expect(r.results).toEqual([])
    expect(m.copies(W1, id)).toHaveLength(3)
    expect(m.copyResult(W1, id, 'web:1', browser, { pick: 'owner' })).toBe(true)
    await flush()
    expect(r.results).toEqual([{ kind: 'value', value: { pick: 'owner' } }])
    expect(m.copies(W1, id)).toEqual([])
    expect(heard.filter((h) => h[0] === 'disconnect')).toEqual([])
    // The other copies' traffic finds nothing afterwards.
    expect(m.copyMessage(W1, id, D, desk, '"late"')).toBe(false)
    expect(m.copyResult(W1, id, D, desk, 1)).toBe(false)
    expect(m.post(W1, id, '"after"')).toBe(false)
  })

  // Task 2 review (b): the opener answering inside its listeners, and listeners that throw.
  it('a post made inside onConnect queues and drains in order at copyReady; one inside onDisconnect is dropped', () => {
    const order: string[] = []
    // The listeners run only at connect and release, once `m` and `id` below exist.
    const answering: OverlayChannel = {
      onMessage: () => {},
      onConnect: (copy) => {
        order.push(`connect ${copy}`)
        m.post(W1, id, '"init"', { copy })
        m.post(W1, id, '"second"', { copy })
      },
      onDisconnect: (copy) => {
        order.push(`disconnect ${copy}`)
        expect(m.post(W1, id, '"bye"', { copy })).toBe(false)
      }
    }
    const m = pvManager()
    void m.open(W1, page, 'plugin a.one', undefined, answering, 'a.one', undefined, undefined, { perView: true })
    const id = m.infos(W1)[0]!.id
    const a = connect(m, id, 'web:1')
    // Queued (the page has no port yet) and joined by that first targeted post.
    expect(sent()).toEqual([])
    expect(m.copyState(W1, id, 'web:1', a)).toMatchObject({ joined: true, ready: false })
    expect(m.post(W1, id, '"broadcast"')).toBe(true)
    m.copyReady(W1, id, 'web:1', a)
    expect(sent()).toEqual([
      ['web:1', a, '"init"'],
      ['web:1', a, '"second"'],
      ['web:1', a, '"broadcast"']
    ])
    expect(m.releaseCopy(W1, id, 'web:1', a)).toBe(true)
    expect(order).toEqual([`connect ${a}`, `disconnect ${a}`])
    expect(sent()).toHaveLength(3)
  })

  it('a throwing onConnect or onDisconnect is logged and breaks neither the connect nor viewGone', () => {
    const logs: string[] = []
    const throwing: OverlayChannel = {
      onMessage: (message, view, copy) => heard.push(['message', message, view, copy]),
      onConnect: () => {
        throw new Error('connect boom')
      },
      onDisconnect: () => {
        throw new Error('disconnect boom')
      }
    }
    const m = pvManager({ log: (line) => logs.push(line) })
    void m.open(W1, page, 'plugin a.one', undefined, throwing, 'a.one', undefined, undefined, { perView: true })
    const id = m.infos(W1)[0]!.id
    const a = connect(m, id, 'web:1')
    const b = connect(m, id, 'web:2')
    // The copy is up and works despite the listener.
    expect(m.copyReady(W1, id, 'web:1', a)).toBe(true)
    expect(m.copyMessage(W1, id, 'web:1', a, '"hi"')).toBe(true)
    expect(heard).toEqual([['message', 'hi', 'web:1', a]])
    // viewGone still drops every copy of that view, the next view's included.
    m.viewGone('web:1')
    m.viewGone('web:2')
    expect(m.copies(W1, id)).toEqual([])
    expect(m.copyState(W1, id, 'web:2', b)).toBeUndefined()
    expect(logs.filter((l) => l.includes('onConnect failed: Error: connect boom'))).toHaveLength(2)
    expect(logs.filter((l) => l.includes('onDisconnect failed: Error: disconnect boom'))).toHaveLength(2)
    expect(m.infos(W1)).toHaveLength(1)
  })

  it('isPerView is main’s own flag: true only for an open perView overlay of that window', () => {
    const m = pvManager()
    const { id } = openPv(m)
    const { id: plain } = openPv(m, false)
    expect(m.isPerView(W1, id)).toBe(true)
    expect(m.isPerView(W1, plain)).toBe(false)
    expect(m.isPerView(W2, id)).toBe(false)
    expect(m.isPerView(W1, 'nope')).toBe(false)
    expect(m.isPerView(W1, 7)).toBe(false)
    m.close(W1, id)
    expect(m.isPerView(W1, id)).toBe(false)
  })

  it("hideCopy releases that copy and sends overlays.hide to its view only; a gone copy or another overlay is false", () => {
    const m = pvManager()
    const { id } = openPv(m)
    const { id: plain } = openPv(m, false)
    const a = connect(m, id, 'web:1')
    const b = connect(m, id, 'web:2')
    m.copyReady(W1, id, 'web:1', a)
    m.copyReady(W1, id, 'web:2', b)
    m.post(W1, id, '"init"', { copy: a })
    m.post(W1, id, '"init"', { copy: b })
    expect(m.hideCopy(W1, id, a)).toBe(true)
    expect(toView.filter((e) => e.channel === 'overlays.hide')).toEqual([{ viewId: 'web:1', channel: 'overlays.hide', payload: { overlayId: id, copy: a } }])
    expect(heard.at(-1)).toEqual(['disconnect', a, 'web:1'])
    expect(m.copies(W1, id).map((c) => c.copy)).toEqual([b])
    // Its page's late traffic is a stale copy's; broadcasts reach only the other copy.
    expect(m.copyMessage(W1, id, 'web:1', a, '"late"')).toBe(false)
    m.post(W1, id, '"all"')
    expect(sent().at(-1)).toEqual(['web:2', b, '"all"'])
    expect(sent().filter(([v]) => v === 'web:1')).toEqual([['web:1', a, '"init"']])
    // Nothing to hide twice, on another window, on a non-perView overlay, or a made-up copy.
    expect(m.hideCopy(W1, id, a)).toBe(false)
    expect(m.hideCopy(W2, id, b)).toBe(false)
    expect(m.hideCopy(W1, plain, b)).toBe(false)
    expect(m.hideCopy(W1, id, 'f'.repeat(32))).toBe(false)
    expect(m.hideCopy(W1, id, 5)).toBe(false)
    // A view that cannot take the event still has its copy released.
    gone.add('web:2')
    expect(m.hideCopy(W1, id, b)).toBe(true)
    expect(m.copies(W1, id)).toEqual([])
    expect(m.infos(W1)).toHaveLength(2)
  })
})

describe('00 contract: notes, envelopes and copy hooks (shared/tasks/00-contract.md)', () => {
  const page = { kind: 'html', src: 'cc-plugin://a.one/doc.html', notes: { key: 'doc:1' } }
  const D = desktopViewId(W1)
  const guests = new Set<string>()
  const allowed = new Set<string>()
  let toView: Array<{ viewId: string; channel: EventChannel; payload: unknown }>
  beforeEach(() => {
    guests.clear()
    allowed.clear()
    toView = []
  })
  function nm(): OverlayManager {
    return new OverlayManager({
      ownerView: (viewId) => !guests.has(viewId),
      backend,
      views,
      isWindowOpen: () => true,
      env: () => ({}),
      emit: <C extends EventChannel>(windowId: number, channel: C, payload: IpcEventMap[C]) => {
        events.push({ windowId, channel, payload })
      },
      emitToView: <C extends EventChannel>(viewId: string, channel: C, payload: IpcEventMap[C]) => {
        toView.push({ viewId, channel, payload })
        return true
      },
      isViewLive: () => true,
      mayConnectCopy: (_windowId, _overlayId, viewId) => allowed.has(viewId),
      guestOf: (viewId) => (guests.has(viewId) ? `guest-${viewId}` : undefined),
      reloadCopy: () => {},
      commandForChord: () => undefined,
      log: () => {}
    })
  }
  const channel: OverlayChannel = { onMessage: () => {} }
  function open(m: OverlayManager, window = W1): string {
    void m.open(window, page, 'plugin a.one', undefined, channel, 'a.one', undefined, undefined, { perView: true })
    return m.infos(window).at(-1)!.id
  }
  /** connectReady as the shell's `overlays.ready` does: minted and ready. */
  function ready(m: OverlayManager, id: string, view: string): string {
    const answer = m.connectReady(W1, id, view)
    if (!('copy' in answer)) throw new Error(`refused: ${answer.refused}`)
    return answer.copy
  }
  const envelopes = (): Array<[string, unknown]> =>
    toView
      .filter((e) => e.channel === 'overlays.message' && (e.payload as { envelope?: true }).envelope === true)
      .map((e) => [e.viewId, (e.payload as { copy?: string }).copy])

  it('a notes spec gives info.notes on a perView overlay, and is refused without perView', async () => {
    const m = nm()
    const id = open(m)
    expect(m.infos(W1).find((o) => o.id === id)?.notes).toBe(true)
    expect(m.notesOf(W1, id)).toEqual({ pluginId: 'a.one', key: 'doc:1' })
    // Fail closed: the whole open is refused, never an overlay opened without its notes.
    await expect(m.open(W1, page, 'plugin a.one', undefined, channel, 'a.one', undefined, undefined, { perView: false })).rejects.toThrow(/perView/)
    await expect(m.open(W1, page, 'plugin a.one', undefined, channel, 'a.one')).rejects.toThrow(/perView/)
    expect(m.infos(W1)).toHaveLength(1)
  })

  it('postEnvelope to a replaced, released or retired copy is dropped', () => {
    const m = nm()
    const id = open(m)
    const first = ready(m, id, D)
    expect(m.postEnvelope(W1, id, first, '{"$cc":1}')).toBe(true)
    // Replaced: the view's next connect.
    const second = ready(m, id, D)
    expect(m.postEnvelope(W1, id, first, '{"$cc":1}')).toBe(false)
    // Released: retired, still in copyViewOf's record, never a target.
    expect(m.releaseCopy(W1, id, D, second)).toBe(true)
    expect(m.copyViewOf(W1, id, second)).toBe(D)
    expect(m.postEnvelope(W1, id, second, '{"$cc":1}')).toBe(false)
    // Unknown copy, another window, gone overlay: nothing delivered.
    expect(m.postEnvelope(W1, id, 'made-up', '{"$cc":1}')).toBe(false)
    expect(m.postEnvelope(W2, id, first, '{"$cc":1}')).toBe(false)
    expect(envelopes()).toEqual([[D, first]])
  })

  it('postEnvelope to a copy mayConnectCopy no longer admits is dropped and never sets joined', () => {
    const m = nm()
    const id = open(m)
    guests.add('web:2')
    allowed.add('web:2')
    const owner = ready(m, id, D)
    const guest = ready(m, id, 'web:2')
    expect(m.postEnvelope(W1, id, guest, '{"$cc":1}')).toBe(true)
    // The rule is read at each push: a guest the opener's plugin (or a via plugin) is now hidden from gets nothing.
    allowed.delete('web:2')
    expect(m.postEnvelope(W1, id, guest, '{"$cc":1}')).toBe(false)
    // Main's pushes are not the opener's addressed post: neither copy joins broadcasts.
    expect(m.postEnvelope(W1, id, owner, '{"$cc":1}')).toBe(true)
    expect(m.copies(W1, id).map((c) => c.joined)).toEqual([false, false])
    expect(envelopes()).toEqual([
      ['web:2', guest],
      [D, owner]
    ])
    // A plain post never carries the mark.
    m.post(W1, id, '{"plain":1}', { copy: owner })
    const plain = toView.filter((e) => (e.payload as { message: string }).message === '{"plain":1}')
    expect(plain).toHaveLength(1)
    expect(plain[0]!.payload).not.toHaveProperty('envelope')
  })

  it('copyOwner of a retired copy or another window\'s overlay is undefined', () => {
    const m = nm()
    const id = open(m)
    const c = ready(m, id, 'web:1')
    expect(m.copyOwner(W1, id, c)).toBe('web:1')
    expect(m.copyOwner(W2, id, c)).toBeUndefined()
    expect(m.copiesOf(W1, id)).toEqual([{ copy: c, view: 'web:1' }])
    expect(m.copiesOf(W2, id)).toEqual([])
    m.releaseCopy(W1, id, 'web:1', c)
    expect(m.copyViewOf(W1, id, c)).toBe('web:1')
    expect(m.copyOwner(W1, id, c)).toBeUndefined()
    expect(m.copyOwner(W1, id, 7)).toBeUndefined()
  })

  it('onCopyEnd fires on release, replace, view gone (:951), hide, overflow and close', () => {
    const m = nm()
    const ended: string[] = []
    const readied: string[] = []
    m.onCopyEnd((e) => ended.push(e.copy))
    m.onCopyReady((e) => readied.push(e.copy))
    const id = open(m)
    // release
    const a = ready(m, id, D)
    m.releaseCopy(W1, id, D, a)
    // replace
    const b = ready(m, id, D)
    const b2 = ready(m, id, D)
    // view gone
    const c = ready(m, id, 'web:1')
    m.viewGone('web:1')
    // hide (the opener's handle.hide)
    const d = ready(m, id, 'web:3')
    expect(m.hideCopy(W1, id, d)).toBe(true)
    // overflow: a copy whose port never came up, its queue full
    const r = m.connectCopy(W1, id, 'web:4')
    if (!r.ok) throw new Error('refused')
    for (let i = 0; i <= MAX_QUEUED_OVERLAY_MESSAGES; i++) m.post(W1, id, '"x"', { copy: r.copy })
    expect(ended).toEqual([a, b, c, d, r.copy])
    expect(readied).toEqual([a, b, b2, c, d])
    // close: every live copy ends with the overlay (no opener disconnects, but main's services hear it)
    m.close(W1, id)
    expect(ended).toEqual([a, b, c, d, r.copy, b2])
    // The listener carries main's record of the copy.
    const seen: unknown[] = []
    const off = m.onCopyEnd((e) => seen.push(e))
    const id2 = open(m)
    const e = ready(m, id2, D)
    m.releaseCopy(W1, id2, D, e)
    expect(seen).toEqual([{ windowId: W1, overlayId: id2, copy: e, view: D, pluginId: 'a.one' }])
    off()
    m.releaseCopy(W1, id2, D, ready(m, id2, D))
    expect(seen).toHaveLength(1)
  })

  it('isOverlayPage is false for a closed overlay, another window or a throw', () => {
    const m = nm()
    const id = open(m)
    expect(m.isOverlayPage(W1, 'cc-plugin://a.one/doc.html')).toBe(true)
    // The page may set its own hash or query.
    expect(m.isOverlayPage(W1, 'cc-plugin://a.one/doc.html?x=1#y')).toBe(true)
    expect(m.isOverlayPage(W1, 'cc-plugin://a.one/other.html')).toBe(false)
    expect(m.isOverlayPage(W1, 'cc-plugin://b.two/doc.html')).toBe(false)
    expect(m.isOverlayPage(W2, 'cc-plugin://a.one/doc.html')).toBe(false)
    expect(m.isOverlayPage(W1, 'not a url')).toBe(false)
    expect(m.isOverlayPage(W1, 42)).toBe(false)
    // An inline page (the CLI's) is no plugin's overlay page.
    void m.open(W1, { kind: 'html', html: '<p>x</p>' }, 'cli')
    const inline = m.infos(W1).at(-1)!
    expect(inline.kind === 'html' && m.isOverlayPage(W1, inline.src)).toBe(false)
    m.close(W1, id)
    expect(m.isOverlayPage(W1, 'cc-plugin://a.one/doc.html')).toBe(false)
  })

  it('overlaysWithNotes matches the opener and the key; an overlay that never announced takes no parts', async () => {
    const m = nm()
    const id = open(m)
    void m.open(W1, page, 'plugin b.two', undefined, channel, 'b.two', undefined, undefined, { perView: true })
    expect(m.overlaysWithNotes(W1, 'a.one', 'doc:1')).toEqual([id])
    expect(m.overlaysWithNotes(W1, 'a.one', 'doc:2')).toEqual([])
    expect(m.overlaysWithNotes(W2, 'a.one', 'doc:1')).toEqual([])
    expect(m.partsOf(W1, id)).toEqual([])
    await expect(m.attachPart(W1, id, 'b.two', { kind: 'html', src: 'cc-plugin://b.two/p.html' }, channel, { perView: true, inHost: true })).rejects.toThrow(/did not announce/)
  })
})


// Task 14 (shared/design-parts.md §2): a part is in byId, never on the stack, so the window's keys act on its parent.
describe('parts and the stack', () => {
  const channel: OverlayChannel = { onMessage: () => {} }
  function parentOf(m: OverlayManager): { id: string; result: Promise<OverlayResult> } {
    const result = m.open(W1, { kind: 'html', src: 'cc-plugin://g.mail/t.html' }, 'plugin g.mail', undefined, channel, 'g.mail', undefined, undefined, { perView: true })
    const id = m.infos(W1).filter((i) => i.partOf === undefined).at(-1)!.id
    m.markAnnounced(W1, id)
    return { id, result }
  }
  function partOf(m: OverlayManager, parentId: string, plugin = 'j.jira'): { id: string; result: Promise<OverlayResult> } {
    const result = m.attachPart(W1, parentId, plugin, { kind: 'html', src: `cc-plugin://${plugin}/part.html` }, channel, { perView: true, inHost: true })
    return { id: m.partsOf(W1, parentId).find((p) => p.pluginId === plugin)!.overlayId, result }
  }

  it('Esc closes the parent with its parts, never a part alone', async () => {
    const m = manager()
    const under = parentOf(m)
    const top = parentOf(m)
    const part = partOf(m, top.id)
    // Focusing the part brings its parent up; it never becomes the top itself.
    expect(m.focus(W1, part.id)).toBe(true)
    expect(m.topKind(W1)).toBe('html')
    // Esc (from the part's page, through handleChord, or the shell's pop): the parent and its part go.
    expect(m.handleChord(W1, 'escape')).toBe(true)
    await expect(part.result).resolves.toEqual({ kind: 'dismissed' })
    await expect(top.result).resolves.toEqual({ kind: 'dismissed' })
    expect(m.infos(W1).map((i) => i.id)).toEqual([under.id])
    // Cmd+Shift+W the same.
    const again = partOf(m, under.id)
    expect(m.closeTop(W1)).toBe(true)
    await expect(again.result).resolves.toEqual({ kind: 'dismissed' })
    expect(m.infos(W1)).toEqual([])
  })

  it('closing the parent ends its parts first', async () => {
    const m = manager()
    const parent = parentOf(m)
    const order: string[] = []
    const jira = partOf(m, parent.id)
    const cal = partOf(m, parent.id, 'c.cal')
    void parent.result.then(() => order.push('parent'))
    void jira.result.then(() => order.push('jira'))
    void cal.result.then(() => order.push('cal'))
    // A part's own close (✕ on its strip, handle.close) ends that part alone.
    expect(m.close(W1, cal.id)).toBe(true)
    await flush()
    expect(order).toEqual(['cal'])
    expect(m.infos(W1).map((i) => i.id)).toEqual([parent.id, jira.id])
    m.close(W1, parent.id)
    await flush()
    await flush()
    expect(order).toEqual(['cal', 'jira', 'parent'])
    expect(m.close(W1, jira.id)).toBe(false)
    // The window closing ends parents and parts alike.
    const next = parentOf(m)
    const last = partOf(m, next.id)
    m.closeWindow(W1)
    await expect(last.result).resolves.toEqual({ kind: 'dismissed' })
  })
})
