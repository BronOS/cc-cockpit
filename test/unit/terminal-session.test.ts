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
    // The hidden input xterm focuses (TerminalSession listens for its focus).
    textarea: EventTarget | undefined
    unicode = { activeVersion: '' }
    modes = { synchronizedOutputMode: false, bracketedPasteMode: false }
    // What shared/terminal-screen.ts atGround reads: 0 is the parser's ground state.
    _core = { _inputHandler: { _parser: { currentState: 0 } } }
    readonly resizes: Array<[number, number]> = []
    // What xterm's own `paste` was handed (a person's paste; the upload's paths are main's to write, design-upload.md §4.3).
    readonly pasted: string[] = []
    scrolledToBottom = 0
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
      this.textarea = new EventTarget()
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
    paste(text: string): void {
      this.pasted.push(text)
    }
    scrollToBottom(): void {
      this.scrolledToBottom++
    }
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
vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class {
    serialize(options: { scrollback: number }): string {
      return `screen with ${options.scrollback} lines`
    }
  }
}))
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
  answerScreen(id: number, scrollback: number): void
  write(data: string, reset?: boolean, size?: { cols: number; rows: number }, local?: boolean): void
  attach(container: HTMLElement): void
  detach(container?: HTMLElement): void
  takeOnLoad(): void
  takeOnSelect(): void
  focus(): void
  dispose(): void
}
type ScreenReply = { id: number; screen?: { cols: number; rows: number; data: string }; busy?: true }
type Io = {
  input(d: string): void
  ack(n: number): void
  resize(c: number, r: number): void
  fit?(): void
  screen?(answer: ScreenReply): void
}
type SessionClass = new (tabId: string, io: Io) => Session
interface Registry {
  answerScreen(tabId: string, id: number, scrollback: number): void
  write(tabId: string, data: string, reset?: boolean, size?: { cols: number; rows: number }, local?: boolean): void
  get(tabId: string): Session
  takeOnSelect(tabId: string, shown?: readonly string[]): void
  activeChanged(shown: string | readonly string[]): void
  disposeAll(): void
}
type RegistryClass = new (ioFor: (id: string) => Io) => Registry
const file = '../../src/renderer/tabs/terminal-session'
const { TerminalSession, SessionRegistry, resetWindowLeftForTest } = (await import(file)) as {
  TerminalSession: SessionClass
  SessionRegistry: RegistryClass
  resetWindowLeftForTest(): void
}
const shellKind = (await import('../../src/renderer/shell-kind')) as {
  markWebShell(): void
  resetShellKindForTest(): void
}

interface FakeTerm {
  cols: number
  rows: number
  resizes: Array<[number, number]>
  textarea: EventTarget
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
    classList: { add: () => undefined, toggle: () => undefined, remove: () => undefined, contains: () => false }
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
  /** navigator.userActivation: whether the page has the person's transient activation now. */
  function activation(isActive: boolean): void {
    vi.stubGlobal('navigator', { userActivation: { isActive } })
  }

  it('a press in the pane takes while another view sizes the pty; never while this view sizes it', () => {
    const { s, container, fits } = session()
    // This view sizes the pty (web access off: the desktop always): nothing is sent.
    container.dispatchEvent(new Event('pointerdown'))
    expect(fits()).toBe(0)
    s.write('', false, { cols: 50, rows: 30 }, false)
    container.dispatchEvent(new Event('pointerdown'))
    expect(fits()).toBe(1)
  })

  // The bug: an idle desktop window got focus back when another window on its workspace closed
  // (a test run's), and its terminal took the size from the device the person was using.
  it('a window focus after a blur takes nothing; the first press or key in the page after it does', () => {
    const { s, fits } = session()
    s.write('', false, { cols: 50, rows: 30 }, false)
    fakeWindow.dispatchEvent(new Event('blur'))
    fakeWindow.dispatchEvent(new Event('focus'))
    expect(fits()).toBe(0)
    fakeWindow.dispatchEvent(new Event('keydown'))
    expect(fits()).toBe(1)
    // Once per return: the next key is typing, which main's own rule (a typing take) covers.
    fakeWindow.dispatchEvent(new Event('keydown'))
    expect(fits()).toBe(1)
    fakeWindow.dispatchEvent(new Event('blur'))
    fakeWindow.dispatchEvent(new Event('focus'))
    fakeWindow.dispatchEvent(new Event('pointerdown'))
    expect(fits()).toBe(2)
  })

  // design-split-pages.md §4: the keyboard going into a page tab's frame blurs the shell's window
  // with the document still focused; coming back from a file pane is no return to the window.
  it('a blur with document.hasFocus() still true (the keyboard went into a frame) arms no take', async () => {
    const aTaskLater = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
    try {
      resetWindowLeftForTest()
      Object.assign(fakeDocument, { hasFocus: () => true })
      const { s, fits } = session()
      s.write('', false, { cols: 50, rows: 30 }, false)
      fakeWindow.dispatchEvent(new Event('blur'))
      await aTaskLater()
      fakeWindow.dispatchEvent(new Event('focus'))
      fakeWindow.dispatchEvent(new Event('keydown'))
      expect(fits()).toBe(0)
      // Leaving the window itself (the document without the keyboard) still arms one.
      Object.assign(fakeDocument, { hasFocus: () => false })
      fakeWindow.dispatchEvent(new Event('blur'))
      fakeWindow.dispatchEvent(new Event('focus'))
      fakeWindow.dispatchEvent(new Event('keydown'))
      expect(fits()).toBe(1)
      // The blur's own moment still saying focused, the document without it a task later: left.
      // (No reset here: the session keeps the count it saw, and the window is back already.)
      let focused = true
      Object.assign(fakeDocument, { hasFocus: () => focused })
      fakeWindow.dispatchEvent(new Event('blur'))
      focused = false
      await aTaskLater()
      fakeWindow.dispatchEvent(new Event('focus'))
      fakeWindow.dispatchEvent(new Event('pointerdown'))
      expect(fits()).toBe(2)
    } finally {
      delete (fakeDocument as { hasFocus?: unknown }).hasFocus
    }
  })

  // The review's finding: a flag set at the first real leave and never cleared armed every later
  // shell `focus`, the one coming back from a file pane's frame included.
  it('after one real leave and return, coming back from a frame arms no take (once per leave)', async () => {
    const aTaskLater = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
    try {
      resetWindowLeftForTest()
      let focused = false
      Object.assign(fakeDocument, { hasFocus: () => focused })
      const { s, fits } = session()
      s.write('', false, { cols: 50, rows: 30 }, false)
      // A real leave and return: one take on the first key.
      fakeWindow.dispatchEvent(new Event('blur'))
      focused = true
      fakeWindow.dispatchEvent(new Event('focus'))
      fakeWindow.dispatchEvent(new Event('keydown'))
      expect(fits()).toBe(1)
      // Into a file pane's frame and back, twice: the document kept the keyboard, nothing arms.
      for (let i = 0; i < 2; i++) {
        fakeWindow.dispatchEvent(new Event('blur'))
        await aTaskLater()
        fakeWindow.dispatchEvent(new Event('focus'))
        fakeWindow.dispatchEvent(new Event('pointerdown'))
      }
      expect(fits()).toBe(1)
      // A second real leave arms again.
      focused = false
      fakeWindow.dispatchEvent(new Event('blur'))
      focused = true
      fakeWindow.dispatchEvent(new Event('focus'))
      fakeWindow.dispatchEvent(new Event('keydown'))
      expect(fits()).toBe(2)
    } finally {
      delete (fakeDocument as { hasFocus?: unknown }).hasFocus
    }
  })

  it('a press or key with no return before it takes nothing (outside the pane)', () => {
    const { s, fits } = session()
    s.write('', false, { cols: 50, rows: 30 }, false)
    fakeWindow.dispatchEvent(new Event('keydown'))
    fakeWindow.dispatchEvent(new Event('pointerdown'))
    expect(fits()).toBe(0)
  })

  it('the page shown again takes nothing until the first press or key', () => {
    const { s, fits } = session()
    s.write('', false, { cols: 50, rows: 30 }, false)
    fakeDocument.dispatchEvent(new Event('visibilitychange'))
    expect(fits()).toBe(0)
    fakeWindow.dispatchEvent(new Event('pointerdown'))
    expect(fits()).toBe(1)
  })

  it('a press in the pane after a return takes once, not twice', () => {
    const { s, container, fits } = session()
    s.write('', false, { cols: 50, rows: 30 }, false)
    fakeWindow.dispatchEvent(new Event('blur'))
    fakeWindow.dispatchEvent(new Event('focus'))
    // The window's capture listener sees the press first and leaves it to the pane's.
    Object.assign(container, { contains: (node: unknown) => node === container })
    const press = new Event('pointerdown')
    Object.defineProperty(press, 'target', { value: container })
    fakeWindow.dispatchEvent(press)
    container.dispatchEvent(new Event('pointerdown'))
    expect(fits()).toBe(1)
    fakeWindow.dispatchEvent(new Event('keydown'))
    expect(fits()).toBe(1)
  })

  it('a focus of the terminal takes only with a gesture behind it (a Tab key), not the focus a window gets back', () => {
    const { s, term, fits } = session()
    s.write('', false, { cols: 50, rows: 30 }, false)
    activation(false)
    term.textarea.dispatchEvent(new Event('focus'))
    expect(fits()).toBe(0)
    activation(true)
    term.textarea.dispatchEvent(new Event('focus'))
    expect(fits()).toBe(1)
    // Programmatic focus (tab activation, restore) never takes, gesture or not.
    s.focus()
    expect(fits()).toBe(1)
  })

  it('"Fit to this screen" still takes at once', () => {
    let button: { hidden: boolean; listeners: Array<() => void> } | undefined
    // The button is made with document.createElement: given to the shared fake for this test only.
    Object.assign(fakeDocument, {
      createElement: () => {
        const made = { hidden: true, listeners: [] as Array<() => void> }
        button = made
        return Object.assign(made, {
          addEventListener: (_type: string, fn: () => void) => made.listeners.push(fn),
          remove: () => undefined,
          parentElement: null
        })
      }
    })
    vi.useFakeTimers()
    try {
      const { s, fits } = session()
      pane.cols = 120
      s.write('', false, { cols: 50, rows: 30 }, false)
      vi.advanceTimersByTime(1000)
      expect(button?.hidden).toBe(false)
      for (const fn of button?.listeners ?? []) fn()
      expect(fits()).toBe(1)
    } finally {
      vi.useRealTimers()
      delete (fakeDocument as { createElement?: unknown }).createElement
    }
  })

  it('a hidden pane (an inactive tab) never takes', () => {
    const { s, container, fits } = session()
    s.write('', false, { cols: 50, rows: 30 }, false)
    Object.assign(container, { clientWidth: 0, clientHeight: 0 })
    container.dispatchEvent(new Event('pointerdown'))
    fakeDocument.dispatchEvent(new Event('visibilitychange'))
    fakeWindow.dispatchEvent(new Event('keydown'))
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

  it('selecting a split group takes for every pane it shows (D2), also panes not attached yet', () => {
    const { r, fits } = registry()
    for (const id of ['a', 'b', 'c', 'z']) r.write(id, '', false, { cols: 50, rows: 30 }, false)
    r.get('a').attach(laidOutPane())
    // b is laid out once the group shows (after the selection's render); z is a pane hidden by zoom.
    r.takeOnSelect('a', ['a', 'b', 'c'])
    // The selection's effect: the panes shown keep their waiting takes.
    r.activeChanged(['a', 'b', 'c'])
    r.get('b').attach(laidOutPane())
    r.get('z').attach(laidOutPane())
    expect(fits).toEqual(['a', 'b'])
    // A new pane whose session does not exist yet takes once it does.
    r.takeOnSelect('a', ['a', 'n'])
    r.write('n', '', false, { cols: 50, rows: 30 }, false)
    r.get('n').attach(laidOutPane())
    expect(fits).toEqual(['a', 'b', 'a', 'n'])
  })
})

describe('the screen main asks for (tabs.screenAsk)', () => {
  function asked(): { s: Session; term: { _core: { _inputHandler: { _parser: { currentState: number } } } }; replies: ScreenReply[] } {
    const replies: ScreenReply[] = []
    const s = new TerminalSession('t1', {
      input: () => undefined,
      ack: () => undefined,
      resize: () => undefined,
      screen: (answer) => replies.push(answer)
    })
    made.push(s)
    return { s, term: s.term as never, replies }
  }

  it('answers with its screen at the scrollback asked, after what was written before the ask', () => {
    const { s, replies } = asked()
    s.answerScreen(4, 5000)
    expect(replies).toEqual([{ id: 4, screen: { cols: 80, rows: 24, data: 'screen with 5000 lines' } }])
  })

  it('busy when its parser is inside a sequence; nothing to give once disposed', () => {
    const { s, term, replies } = asked()
    term._core._inputHandler._parser.currentState = 3
    s.answerScreen(1, 5000)
    s.dispose()
    s.answerScreen(2, 5000)
    expect(replies).toEqual([{ id: 1, busy: true }, { id: 2 }])
  })

  it('a tab with no terminal on this page answers with no screen at once', () => {
    const replies: Array<[string, ScreenReply]> = []
    const registry = new SessionRegistry((id) => ({
      input: () => undefined,
      ack: () => undefined,
      resize: () => undefined,
      screen: (answer) => replies.push([id, answer])
    }))
    registry.answerScreen('nope', 9, 5000)
    expect(replies).toEqual([['nope', { id: 9 }]])
    registry.disposeAll()
  })
})

// Guests (D-14, spec-review 14): a guest view's implicit gestures take nothing; a write guest's own key in
// the pane sends its held size first (terminal-access.ts gates the io, the session tells it the act).
const guestKind = (await import('../../src/renderer/shell-kind')) as {
  markWebShell(): void
  setGuestHint(g: { id: string; name: string; role: 'read' | 'write'; ownerName: string } | undefined): void
  resetShellKindForTest(): void
}
const { gateTerminalIo } = (await import('../../src/renderer/tabs/terminal-access')) as {
  gateTerminalIo(io: Io, access: 'owner' | 'read' | 'write'): Io & { act?(): void }
}

describe("a guest view's terminal", () => {
  afterEach(() => guestKind.resetShellKindForTest())

  it('takes nothing on a press, a selection or a page load, while another view sizes the pty', () => {
    guestKind.markWebShell()
    guestKind.setGuestHint({ id: 'g1', name: 'Ana', role: 'write', ownerName: 'Host' })
    const { s, container, fits } = session()
    s.write('', false, { cols: 50, rows: 30 }, false)
    container.dispatchEvent(new Event('pointerdown'))
    s.takeOnSelect()
    s.takeOnLoad()
    expect(fits()).toBe(0)
  })

  it("a write guest's key or paste in the pane sends its held size; a press does not", () => {
    guestKind.markWebShell()
    guestKind.setGuestHint({ id: 'g1', name: 'Ana', role: 'write', ownerName: 'Host' })
    const calls: string[] = []
    const io = gateTerminalIo(
      {
        input: (d) => void calls.push(`input ${d}`),
        ack: () => undefined,
        resize: (c, r) => void calls.push(`resize ${c}x${r}`),
        fit: () => void calls.push('fit')
      },
      'write'
    )
    const s = new TerminalSession('t1', io)
    made.push(s)
    const container = laidOutPane()
    s.attach(container)
    // Attaching measured the pane: held, not sent.
    container.dispatchEvent(new Event('pointerdown'))
    expect(calls).toEqual([])
    container.dispatchEvent(new Event('paste'))
    expect(calls).toEqual(['resize 120x40'])
    container.dispatchEvent(new Event('keydown'))
    expect(calls).toEqual(['resize 120x40'])
  })
})

// The terminal entry of uploads (design-upload.md §4.1, §4.3; terminal-drop.ts holds the rules): attached
// only with an entry, after the own-act listener, so a write guest's file paste is still its act; main writes
// the paths (the terminal only reports its paste mode, as the person's act), and the registry never makes a
// terminal to paste into.
const drop = (await import('../../src/renderer/tabs/terminal-drop')) as {
  onTerminalUpload(fn: (tabId: string, files: readonly unknown[], opts: unknown) => void): () => void
}
type EntrySession = Session & {
  attach(container: HTMLElement, entry?: { tabId: string; select(): void }): void
  detach(): void
  pasteMode(): { bracketed: boolean } | undefined
}

describe('the uploads entry on a terminal', () => {
  afterEach(() => guestKind.resetShellKindForTest())

  const filePaste = (): Event => {
    const e = new Event('paste', { cancelable: true })
    return Object.assign(e, { clipboardData: { types: ['Files'], files: [{ name: 'image.png', size: 1, type: 'image/png', slice: () => new Blob([]) }] } })
  }

  it("a write guest's file paste uploads and still counts as its act (the own-act listener runs first)", () => {
    guestKind.markWebShell()
    guestKind.setGuestHint({ id: 'g1', name: 'Ana', role: 'write', ownerName: 'Host' })
    const calls: string[] = []
    const off = drop.onTerminalUpload((tabId) => void calls.push(`upload ${tabId}`))
    const io = gateTerminalIo({ input: (d) => void calls.push(`input ${d}`), ack: () => undefined, resize: (c, r) => void calls.push(`resize ${c}x${r}`) }, 'write')
    const s = new TerminalSession('t1', io) as unknown as EntrySession
    made.push(s)
    const container = laidOutPane()
    s.attach(container, { tabId: 't1', select: () => undefined })
    const e = filePaste()
    container.dispatchEvent(e)
    off()
    expect(calls).toEqual(['resize 120x40', 'upload t1'])
    expect(e.defaultPrevented).toBe(true)
  })

  it('without an entry (a command tab, a read view, the desktop) a file paste is left to xterm', () => {
    const calls: string[] = []
    const off = drop.onTerminalUpload(() => void calls.push('upload'))
    const { s, container } = session(false)
    ;(s as unknown as EntrySession).attach(container)
    const e = filePaste()
    container.dispatchEvent(e)
    off()
    expect(calls).toEqual([])
    expect(e.defaultPrevented).toBe(false)
  })

  it('a detach takes the entry off; a reattach without one leaves it off', () => {
    const calls: string[] = []
    const off = drop.onTerminalUpload(() => void calls.push('upload'))
    const { s, container } = session(false)
    const es = s as unknown as EntrySession
    es.attach(container, { tabId: 't1', select: () => undefined })
    container.dispatchEvent(filePaste())
    expect(calls).toEqual(['upload'])
    es.detach()
    container.dispatchEvent(filePaste())
    es.attach(container)
    container.dispatchEvent(filePaste())
    off()
    expect(calls).toEqual(['upload'])
  })

  it("a write guest's pasted paths are its act: its held size goes first, as before a key", () => {
    guestKind.markWebShell()
    guestKind.setGuestHint({ id: 'g1', name: 'Ana', role: 'write', ownerName: 'Host' })
    const calls: string[] = []
    const io = gateTerminalIo({ input: (d) => void calls.push(`input ${d}`), ack: () => undefined, resize: (c, r) => void calls.push(`resize ${c}x${r}`) }, 'write')
    const s = new TerminalSession('t1', io) as unknown as EntrySession
    made.push(s)
    s.attach(laidOutPane())
    expect(calls).toEqual([])
    expect(s.pasteMode()).toEqual({ bracketed: false })
    expect(calls).toEqual(['resize 120x40'])
    // Main writes the paths (design-upload.md §4.3): nothing is typed here.
    expect((s.term as { pasted: string[] }).pasted).toEqual([])
  })

  it("reports the terminal's bracketed-paste mode and scrolls to the prompt; types nothing; the registry answers only for a terminal it holds", () => {
    const { s, term } = session()
    const t = term as unknown as { pasted: string[]; scrolledToBottom: number; modes: { bracketedPasteMode: boolean } }
    t.modes.bracketedPasteMode = true
    expect((s as unknown as EntrySession).pasteMode()).toEqual({ bracketed: true })
    expect(t.scrolledToBottom).toBe(1)
    expect(t.pasted).toEqual([])
    const reg = new SessionRegistry(() => ({ input: () => undefined, ack: () => undefined, resize: () => undefined })) as unknown as Registry & {
      pasteMode(tabId: string): { bracketed: boolean } | undefined
    }
    expect(reg.pasteMode('none')).toBeUndefined()
    reg.get('t')
    expect(reg.pasteMode('t')).toEqual({ bracketed: false })
    reg.disposeAll()
    expect(reg.pasteMode('t')).toBeUndefined()
  })
})

// design-terminal-panel.md §4 and §13.10: a tab moving between the main tab area and the Terminal panel
// is attached to its new pane, and the old pane's cleanup may run after that (another commit).
describe('detaching a pane the terminal has left', () => {
  it("the old pane's late detach keeps the new pane; the new pane's own detach takes it off", () => {
    const { s, resized } = session(false)
    const oldPane = laidOutPane()
    const newPane = laidOutPane()
    s.attach(oldPane)
    s.attach(newPane)
    s.detach(oldPane)
    // Still on the new pane: a resize there is measured and reported.
    drag(150, 45)
    expect(resized.at(-1)).toEqual([150, 45])
    s.detach(newPane)
    const before = resized.length
    drag(90, 30)
    expect(resized).toHaveLength(before)
  })

  it('a detach keeps the session: its output is still parsed and acked, and the registry hands out the same one', () => {
    const acks: number[] = []
    const registry = new SessionRegistry(() => ({ input: () => undefined, ack: (n) => acks.push(n), resize: () => undefined }))
    const first = registry.get('t9')
    made.push({ dispose: () => registry.disposeAll() })
    const paneA = laidOutPane()
    first.attach(paneA)
    first.detach(paneA)
    registry.write('t9', 'hello')
    expect(acks).toEqual([5])
    expect(registry.get('t9')).toBe(first)
  })
})
