// The page half of "web access off: the desktop fits its pane itself" (design-web.md §5.2 "Size"):
// TerminalSession.write with a `local` size item fits the pane at once instead of drawing at the
// pty's size, and a `local` item after a non-local one (the desktop sizing the tab again) drops the
// pty size it was drawn at. main's half (TabManager marking items `local`) is in terminal-sizes.test.ts.
//
// xterm and its addons need a DOM, so they are replaced by fakes that keep only what the session
// reads: cols x rows, the font size, write callbacks run in order, and the fit addon's measurement.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** What the pane fits now (FitAddon.proposeDimensions), set per test. */
const pane = { cols: 120, rows: 40 }

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown>
    element: { style: Record<string, string> } | undefined
    unicode = { activeVersion: '' }
    readonly resizes: Array<[number, number]> = []
    constructor(options: Record<string, unknown>) {
      this.options = { ...options }
    }
    loadAddon(addon: { activate?(term: unknown): void }): void {
      addon.activate?.(this)
    }
    attachCustomKeyEventHandler(): void {}
    onData(): { dispose(): void } {
      return { dispose: () => undefined }
    }
    onRender(): { dispose(): void } {
      return { dispose: () => undefined }
    }
    open(): void {
      this.element = { style: {} }
    }
    write(_data: string, cb?: () => void): void {
      cb?.()
    }
    resize(cols: number, rows: number): void {
      this.cols = cols
      this.rows = rows
      this.resizes.push([cols, rows])
    }
    focus(): void {}
    dispose(): void {}
  }
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    private term: { resize(cols: number, rows: number): void } | undefined
    activate(term: { resize(cols: number, rows: number): void }): void {
      this.term = term
    }
    proposeDimensions(): { cols: number; rows: number } {
      return { ...pane }
    }
    fit(): void {
      this.term?.resize(pane.cols, pane.rows)
    }
  }
}))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('../../src/renderer/prefs/prefs-store', () => ({
  currentPrefs: () => ({ terminalFont: { family: 'Mono', size: 13 } }),
  onPrefs: () => () => undefined
}))
vi.mock('../../src/renderer/theme/theme-store', () => ({
  currentXtermTheme: () => ({}),
  onXtermTheme: () => () => undefined
}))
vi.mock('../../src/renderer/theme/see-through', () => ({ xtermLookOptions: (_s: boolean, theme: unknown) => ({ theme }) }))
vi.mock('../../src/renderer/commands/keybindings', () => ({ commandForEvent: () => undefined }))
vi.mock('../../src/renderer/tabs/terminal-font', () => ({
  loadTerminalFont: () => Promise.resolve(),
  sameFont: () => true,
  xtermFontOptions: (font: { family: string; size: number }) => ({ fontFamily: font.family, fontSize: font.size })
}))

// Loaded by a path the node typecheck does not follow (the renderer has its own tsconfig, with the
// DOM lib and CSS imports); vitest transforms it like any other.
interface Session {
  readonly term: unknown
  write(data: string, reset?: boolean, size?: { cols: number; rows: number }, local?: boolean): void
  attach(container: HTMLElement): void
  takeOnLoad(): void
  takeOnSelect(): void
  dispose(): void
}
type Io = { input(d: string): void; ack(n: number): void; resize(c: number, r: number): void; fit?(): void }
type SessionClass = new (tabId: string, io: Io) => Session
interface Registry {
  write(tabId: string, data: string, reset?: boolean, size?: { cols: number; rows: number }, local?: boolean): void
  get(tabId: string): Session
  takeOnSelect(tabId: string): void
  activeChanged(tabId: string): void
  disposeAll(): void
}
type RegistryClass = new (ioFor: (id: string) => Io) => Registry
const file = '../../src/renderer/tabs/terminal-session'
const { TerminalSession, SessionRegistry } = (await import(file)) as {
  TerminalSession: SessionClass
  SessionRegistry: RegistryClass
}
const shellKind = (await import('../../src/renderer/shell-kind')) as {
  markWebShell(): void
  resetShellKindForTest(): void
}

interface FakeTerm {
  cols: number
  rows: number
  resizes: Array<[number, number]>
}

/** A laid-out pane (the active tab's); clientWidth/Height 0 is a hidden one. */
function laidOutPane(): HTMLElement {
  const target = new EventTarget()
  return Object.assign(target, {
    clientWidth: 800,
    clientHeight: 600,
    isConnected: true,
    parentElement: null,
    appendChild: () => undefined,
    classList: { toggle: () => undefined, remove: () => undefined, contains: () => false }
  }) as unknown as HTMLElement
}

/** Disposed after each test: each session listens on the shared fake window and document. */
let made: Array<{ dispose(): void }> = []

function session(attached = true) {
  const resized: Array<[number, number]> = []
  // The calls in order: a take must come after this view's size reached main.
  const calls: string[] = []
  let fits = 0
  const s = new TerminalSession('t1', {
    input: () => undefined,
    ack: () => undefined,
    resize: (cols, rows) => {
      resized.push([cols, rows])
      calls.push(`resize ${cols}x${rows}`)
    },
    fit: () => {
      fits++
      calls.push('fit')
    }
  })
  made.push(s)
  const container = laidOutPane()
  if (attached) s.attach(container)
  return { s, term: s.term as unknown as FakeTerm, resized, calls, container, fits: () => fits }
}

let observers: Array<() => void> = []
const fakeWindow = new EventTarget()
const fakeDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' })
vi.stubGlobal('window', fakeWindow)
vi.stubGlobal('document', fakeDocument)
beforeEach(() => {
  vi.stubGlobal('window', fakeWindow)
  vi.stubGlobal('document', fakeDocument)
  vi.stubGlobal('requestAnimationFrame', () => 0)
  pane.cols = 120
  pane.rows = 40
  observers = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly cb: () => void) {
        observers.push(cb)
      }
      observe(): void {}
      disconnect(): void {}
    }
  )
})
afterEach(() => {
  for (const s of made) s.dispose()
  made = []
  vi.unstubAllGlobals()
})

/** The window was dragged: the pane fits another size and the observer fires. */
function drag(cols: number, rows: number): void {
  pane.cols = cols
  pane.rows = rows
  for (const cb of observers) cb()
}

describe('TerminalSession sizes', () => {
  it('a local size item fits the pane at once: a drag never waits for main, an older item never pulls it back', () => {
    const { s, term, resized } = session()
    expect([term.cols, term.rows]).toEqual([120, 40])
    drag(150, 45)
    expect([term.cols, term.rows]).toEqual([150, 45])
    // main's item for an earlier step of the drag lands after it: the pane's size stays.
    s.write('', false, { cols: 120, rows: 40 }, true)
    expect([term.cols, term.rows]).toEqual([150, 45])
    drag(100, 30)
    expect([term.cols, term.rows]).toEqual([100, 30])
    expect(resized).toEqual([
      [120, 40],
      [150, 45],
      [100, 30]
    ])
  })

  it("a non-local item draws at the pty's size; a local one after it fits the pane again", () => {
    const { s, term } = session()
    // Another view sizes the pty: drawn at its size, and a drag only remeasures the pane.
    s.write('', false, { cols: 50, rows: 30 }, false)
    expect([term.cols, term.rows]).toEqual([50, 30])
    drag(130, 42)
    expect([term.cols, term.rows]).toEqual([50, 30])
    // This view sizes the pty again (web access turned off, or it typed): the pane, not the pty size.
    s.write('', false, { cols: 50, rows: 30 }, true)
    expect([term.cols, term.rows]).toEqual([130, 42])
    drag(110, 35)
    expect([term.cols, term.rows]).toEqual([110, 35])
  })
})

describe('TerminalSession takes the size when the page loads', () => {
  // The load take is the browser page's (armLoadTake).
  beforeEach(() => shellKind.markWebShell())
  afterEach(() => shellKind.resetShellKindForTest())

  it('takes at once when another view already sizes the pty, else on the first size item', () => {
    const a = session()
    a.s.write('', false, { cols: 50, rows: 30 }, false)
    a.s.takeOnLoad()
    expect(a.fits()).toBe(1)
    const b = session()
    b.s.takeOnLoad()
    expect(b.fits()).toBe(0)
    b.s.write('', false, { cols: 50, rows: 30 }, false)
    expect(b.fits()).toBe(1)
    // Only once: a later size item from another view is not a take.
    b.s.write('', false, { cols: 60, rows: 30 }, false)
    expect(b.fits()).toBe(1)
  })

  it('a local size item (this view sizes the pty) drops the wait', () => {
    const { s, fits } = session()
    s.takeOnLoad()
    s.write('', false, { cols: 50, rows: 30 }, true)
    s.write('', false, { cols: 60, rows: 30 }, false)
    expect(fits()).toBe(0)
  })
})

describe('TerminalSession takes the size on interaction', () => {
  it('a press in the pane or the page shown again takes while another view sizes the pty; never while this view sizes it', () => {
    const { s, container, fits } = session()
    // This view sizes the pty (web access off: the desktop always): nothing is sent.
    container.dispatchEvent(new Event('pointerdown'))
    fakeDocument.dispatchEvent(new Event('visibilitychange'))
    expect(fits()).toBe(0)
    s.write('', false, { cols: 50, rows: 30 }, false)
    container.dispatchEvent(new Event('pointerdown'))
    expect(fits()).toBe(1)
    fakeDocument.dispatchEvent(new Event('visibilitychange'))
    expect(fits()).toBe(2)
  })

  it('a window focus takes only after the window was left (not the focus it gets at start)', () => {
    const { s, fits } = session()
    s.write('', false, { cols: 50, rows: 30 }, false)
    // The module's blur flag is shared by every session: a fresh module would start unset, but
    // an earlier test may have blurred; this test blurs itself and checks the take after it.
    fakeWindow.dispatchEvent(new Event('blur'))
    fakeWindow.dispatchEvent(new Event('focus'))
    expect(fits()).toBe(1)
  })

  it('a hidden pane (an inactive tab) never takes', () => {
    const { s, container, fits } = session()
    s.write('', false, { cols: 50, rows: 30 }, false)
    Object.assign(container, { clientWidth: 0, clientHeight: 0 })
    container.dispatchEvent(new Event('pointerdown'))
    fakeDocument.dispatchEvent(new Event('visibilitychange'))
    expect(fits()).toBe(0)
  })
})

describe('TerminalSession takes the size when the person selects its tab', () => {
  afterEach(() => shellKind.resetShellKindForTest())

  it('takes at once while another view sizes the pty', () => {
    const { s, fits } = session()
    s.write('', false, { cols: 50, rows: 30 }, false)
    s.takeOnSelect()
    expect(fits()).toBe(1)
  })

  it('web access off (the desktop sizes the pty): nothing is sent, and no wait is left behind', () => {
    const a = session()
    // Its own size items are `local`.
    a.s.write('', false, { cols: 120, rows: 40 }, true)
    a.s.takeOnSelect()
    // None at all (the pty already had the pane's size): the desktop still sizes it.
    const b = session()
    b.s.takeOnSelect()
    // Web access turned on later and a browser took the size: not a take of the old selection.
    a.s.write('', false, { cols: 50, rows: 30 }, false)
    b.s.write('', false, { cols: 50, rows: 30 }, false)
    expect(a.fits()).toBe(0)
    expect(b.fits()).toBe(0)
  })

  it('a terminal not attached yet (a tab just made) takes once it is attached, after its size reached main', () => {
    const { s, container, calls, fits } = session(false)
    s.write('', false, { cols: 50, rows: 30 }, false)
    s.takeOnSelect()
    expect(fits()).toBe(0)
    s.attach(container)
    expect(fits()).toBe(1)
    expect(calls).toEqual(['resize 120x40', 'fit'])
  })

  it('a pane not laid out yet takes when it is shown', () => {
    const { s, container, fits } = session()
    s.write('', false, { cols: 50, rows: 30 }, false)
    Object.assign(container, { clientWidth: 0, clientHeight: 0 })
    s.takeOnSelect()
    expect(fits()).toBe(0)
    Object.assign(container, { clientWidth: 800, clientHeight: 600 })
    drag(120, 40)
    expect(fits()).toBe(1)
  })

  it("in a browser, a terminal waits for its first size item (another view's takes, a local one drops it)", () => {
    shellKind.markWebShell()
    const a = session()
    a.s.takeOnSelect()
    expect(a.fits()).toBe(0)
    a.s.write('', false, { cols: 50, rows: 30 }, false)
    expect(a.fits()).toBe(1)
    const b = session()
    b.s.takeOnSelect()
    b.s.write('', false, { cols: 50, rows: 30 }, true)
    b.s.write('', false, { cols: 60, rows: 30 }, false)
    expect(b.fits()).toBe(0)
  })
})

describe('SessionRegistry selection takes', () => {
  function registry() {
    const fits: string[] = []
    const r = new SessionRegistry((id) => ({
      input: () => undefined,
      ack: () => undefined,
      resize: () => undefined,
      fit: () => fits.push(id)
    }))
    made.push({ dispose: () => r.disposeAll() })
    return { r, fits }
  }

  it("a person's selection takes; a programmatic one (only activeChanged) never does", () => {
    const { r, fits } = registry()
    r.write('a', '', false, { cols: 50, rows: 30 }, false)
    r.write('b', '', false, { cols: 50, rows: 30 }, false)
    r.get('a').attach(laidOutPane())
    r.get('b').attach(laidOutPane())
    // Restore, main's tabs.select (a plugin's focus, the Sessions panel), a close's neighbour.
    r.activeChanged('a')
    r.activeChanged('b')
    expect(fits).toEqual([])
    r.takeOnSelect('a')
    expect(fits).toEqual(['a'])
  })

  it('a tab made with + takes once its terminal exists and is attached', () => {
    const { r, fits } = registry()
    r.takeOnSelect('new')
    r.activeChanged('new')
    r.write('new', '', false, { cols: 50, rows: 30 }, false)
    expect(fits).toEqual([])
    r.get('new').attach(laidOutPane())
    expect(fits).toEqual(['new'])
  })

  it('a waiting take is dropped when another tab becomes active first', () => {
    const { r, fits } = registry()
    // Selected before its session exists, then a programmatic change to another tab.
    r.takeOnSelect('x')
    r.activeChanged('y')
    r.write('x', '', false, { cols: 50, rows: 30 }, false)
    r.get('x').attach(laidOutPane())
    // Selected with its session made but not attached, then another tab is selected.
    r.write('p', '', false, { cols: 50, rows: 30 }, false)
    r.takeOnSelect('p')
    r.activeChanged('q')
    r.get('p').attach(laidOutPane())
    expect(fits).toEqual([])
  })
})
