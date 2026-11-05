// One xterm.js instance per tab, kept outside React. Output can arrive before the tab's view has
// mounted (`tabs.create` resolves after the PTY started), and a hidden tab must keep receiving
// output so its scrollback survives; a registry that outlives the views covers both.
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { TerminalFont } from '../../shared/terminal-font'
import { commandForEvent } from '../commands/keybindings'
import { currentPrefs, onPrefs } from '../prefs/prefs-store'
import { xtermLookOptions } from '../theme/see-through'
import { currentXtermTheme, onXtermTheme } from '../theme/theme-store'
import { loadTerminalFont, sameFont, xtermFontOptions } from './terminal-font'

function openLink(uri: string): void {
  window.cockpit.invoke('app.openExternal', { url: uri }).catch((err: unknown) => {
    console.warn('open link failed', err)
  })
}

/**
 * Where a terminal's keystrokes, acks and size go: a tab's PTY by default, a terminal overlay's
 * through the overlay channels (OverlayStack). Both PTYs live in main and are scoped there.
 */
export interface TerminalIo {
  input(data: string): void
  ack(count: number): void
  resize(cols: number, rows: number): void
}

/** The tab channels. Failures are dropped: main ignores a tab that is gone. */
export function tabIo(tabId: string): TerminalIo {
  return {
    input: (data) => {
      window.cockpit.invoke('tabs.input', { tabId, data }).catch(() => {})
    },
    ack: (count) => {
      window.cockpit.invoke('tabs.ack', { tabId, count }).catch(() => {})
    },
    resize: (cols, rows) => {
      window.cockpit.invoke('tabs.resize', { tabId, cols, rows }).catch(() => {})
    }
  }
}

/** How a terminal is drawn, beyond the theme and the font. */
export interface TerminalLook {
  /**
   * A tab terminal of a see-through window (renderer/theme/see-through.ts): xterm's background is
   * made transparent so the terminal host's glass shows behind the text. Terminal overlays never
   * set it: they stay opaque in every window.
   */
  seeThrough?: boolean
}

export class TerminalSession {
  readonly term: Terminal
  private readonly fit = new FitAddon()
  private observer: ResizeObserver | undefined
  private container: HTMLElement | undefined
  private lastSize = ''
  private renderWatch: { dispose(): void } | undefined
  private disposed = false
  private readonly offTheme: () => void
  private readonly offPrefs: () => void
  /** The font last asked for (applied once it has loaded), and which ask is the latest. */
  private font: TerminalFont
  private fontAsk = 0

  constructor(
    tabId: string,
    private readonly io: TerminalIo = tabIo(tabId),
    look: TerminalLook = {}
  ) {
    const seeThrough = look.seeThrough === true
    this.term = new Terminal({
      // `term.unicode` (wide-character tables) is a proposed API.
      allowProposedApi: true,
      scrollback: 10_000,
      cursorBlink: true,
      // Settings › Appearance › Terminal; loaded before the first window rendered
      // (startPrefs), so the first cell measurement uses it.
      ...xtermFontOptions(currentPrefs().terminalFont),
      // The palette (transparent behind a see-through tab terminal) and allowTransparency with it.
      ...xtermLookOptions(seeThrough, currentXtermTheme()),
      // OSC 8 hyperlinks (`ls --hyperlink`, `gh`, ...) otherwise take xterm's default handler:
      // a confirm() dialog and window.open, which the window denies. Same route as plain URLs.
      linkHandler: { activate: (_event, uri) => openLink(uri) }
    })
    this.offTheme = onXtermTheme((theme) => {
      // A new object each time: xterm repaints on assignment, not on mutation.
      this.term.options.theme = xtermLookOptions(seeThrough, theme).theme
    })
    this.font = currentPrefs().terminalFont
    // Every prefs push lands here, a tab close side change included: only a new font is applied.
    this.offPrefs = onPrefs((prefs) => this.setFont(prefs.terminalFont))
    this.term.loadAddon(this.fit)
    this.term.loadAddon(new Unicode11Addon())
    this.term.unicode.activeVersion = '11'
    // The addon's default handler calls window.open, which the window denies (and which would
    // not reach the system browser anyway). Links go through main, which allows http(s) only.
    this.term.loadAddon(
      new WebLinksAddon((_event, uri) => openLink(uri))
    )
    // A chord bound to a command this window can run belongs to the app, not the terminal: xterm
    // must neither type it nor swallow it, so the window's key handler gets it. Everything else
    // (including Escape with no overlay open) is the terminal's.
    this.term.attachCustomKeyEventHandler((event) => commandForEvent(event) === undefined)
    this.term.onData((data) => {
      // The user typing or pasting; main ignores it for an exited tab.
      this.io.input(data)
    })
  }

  /**
   * Write PTY output and acknowledge it once xterm has parsed it. The ack unit is the string
   * length (UTF-16 units) of what was written, which is what the PTY service counts (task 6).
   */
  write(data: string): void {
    if (this.disposed) return
    this.term.write(data, () => this.io.ack(data.length))
  }

  /** Show the terminal in `container`; safe to call again with a new container (a remount). */
  attach(container: HTMLElement): void {
    if (this.disposed) return
    this.observer?.disconnect()
    this.container = container
    if (this.term.element) container.appendChild(this.term.element)
    else this.term.open(container)
    // Fires once on observe and again whenever the pane is resized or un-hidden (a hidden tab is
    // display:none, 0x0, and cannot be measured).
    this.observer = new ResizeObserver(() => this.refit())
    this.observer.observe(container)
    this.refit()
  }

  detach(): void {
    this.observer?.disconnect()
    this.observer = undefined
    this.container = undefined
  }

  /** Forget the size main knows: a restarted PTY starts at the default size, not ours. */
  resetSize(): void {
    this.lastSize = ''
    this.refit()
  }

  focus(): void {
    if (!this.disposed) this.term.focus()
  }

  /**
   * Draw with another font: once it has loaded (xterm measures the cell as the options change),
   * set the options, then fit again: a new cell size is a new cols x rows, which goes to the PTY
   * through the same path as a window resize. A hidden tab cannot be fitted now; its
   * ResizeObserver fits it when it is shown. Rapid changes (typing a size) apply only the last.
   */
  private setFont(font: TerminalFont): void {
    if (this.disposed || sameFont(font, this.font)) return
    this.font = font
    const ask = ++this.fontAsk
    void loadTerminalFont(font).then(() => {
      if (this.disposed || ask !== this.fontAsk) return
      // term.options is xterm's proxy: each assignment goes through its option setter.
      Object.assign(this.term.options, xtermFontOptions(font))
      this.refit()
    })
  }

  /** Fit to the container and tell main the new size when it changed. */
  private refit(): void {
    const el = this.container
    if (this.disposed || !el || el.clientWidth === 0 || el.clientHeight === 0) return
    // A terminal opened while its tab was hidden has a 0x0 cell until xterm re-measures after
    // the pane is shown; the ResizeObserver can run before that. Fitting then would do nothing
    // and the stale 80x24 would be sent to main (shrinking a live PTY after a reload), so wait
    // for the next render, by which time the cell size is known, and retry.
    if (!this.fit.proposeDimensions()) {
      this.renderWatch ??= this.term.onRender(() => {
        this.renderWatch?.dispose()
        this.renderWatch = undefined
        this.refit()
      })
      return
    }
    this.fit.fit()
    const { cols, rows } = this.term
    const size = `${cols}x${rows}`
    if (size === this.lastSize) return
    this.lastSize = size
    this.io.resize(cols, rows)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.offTheme()
    this.offPrefs()
    this.detach()
    this.renderWatch?.dispose()
    this.term.dispose()
  }
}

/** All sessions of the window, created on first use (output or view, whichever comes first). */
export class SessionRegistry {
  private readonly sessions = new Map<string, TerminalSession>()

  /**
   * `ioFor` routes a session's input, acks and size (tabs by default); `look` is how each of its
   * terminals is drawn (TerminalLook).
   */
  constructor(
    private readonly ioFor: (id: string) => TerminalIo = tabIo,
    private readonly look: TerminalLook = {}
  ) {}

  /** Closed tabs: late output for them must not resurrect a session that nobody disposes. */
  private readonly closed = new Set<string>()

  /** Output for a tab; dropped when the tab is closed. */
  write(tabId: string, data: string): void {
    if (this.closed.has(tabId)) return
    this.get(tabId).write(data)
  }

  get(tabId: string): TerminalSession {
    let session = this.sessions.get(tabId)
    if (!session) {
      session = new TerminalSession(tabId, this.ioFor(tabId), this.look)
      this.sessions.set(tabId, session)
    }
    return session
  }

  dispose(tabId: string): void {
    this.closed.add(tabId)
    this.sessions.get(tabId)?.dispose()
    this.sessions.delete(tabId)
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) session.dispose()
    this.sessions.clear()
    this.closed.clear()
  }
}
