import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventChannel, IpcEventMap, OverlayInfo } from '../../src/shared/ipc'
import {
  chordOfInput,
  KILL_GRACE_MS,
  MAX_RESULT_BYTES,
  OverlayManager,
  overlayUrlOf,
  parseOverlaySpec,
  sameSite,
  type OverlayResult,
  type UrlView,
  type UrlViewFactory,
  type ViewBounds
} from '../../src/main/overlays/overlay-manager'
import { WebviewManager, type WebviewView } from '../../src/main/webview/webview-manager'
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
    readonly onGone: () => void
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
    onGone: () => void
  ): FakeView {
    const view = new FakeView(windowId, url, onChord, onGone)
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
    expect(a.visible).toBe(true)
    expect(a.focused).toBe(1)
    // A terminal overlay over it must not be covered by the native view.
    void m.open(W1, terminal(['cat']), 'test')
    expect(a.visible).toBe(false)
    expect(views.windowFocus).toEqual([W1])
    // It ends: the url view is the top again.
    backend.last.exit(0)
    expect(a.visible).toBe(true)
    expect(a.focused).toBe(2)
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
    expect(m.infos(W1)).toEqual([{ id: expect.any(String), kind: 'terminal', title: 'Git' }])
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
    expect(page).toEqual({ id: page!.id, kind: 'html', title: 'Pick', src: 'cc-plugin://a.one/pick.html' })
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
