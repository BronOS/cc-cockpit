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
}
type SessionClass = new (
  tabId: string,
  io: { input(d: string): void; ack(n: number): void; resize(c: number, r: number): void; fit?(): void }
) => Session
const file = '../../src/renderer/tabs/terminal-session'
const { TerminalSession } = (await import(file)) as { TerminalSession: SessionClass }

interface FakeTerm {
  cols: number
  rows: number
  resizes: Array<[number, number]>
}

function session() {
  const resized: Array<[number, number]> = []
  const s = new TerminalSession('t1', {
    input: () => undefined,
    ack: () => undefined,
    resize: (cols, rows) => resized.push([cols, rows]),
    fit: () => undefined
  })
  const container = { clientWidth: 800, clientHeight: 600, appendChild: () => undefined } as unknown as HTMLElement
  s.attach(container)
  return { s, term: s.term as unknown as FakeTerm, resized }
}

let observers: Array<() => void> = []
beforeEach(() => {
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
