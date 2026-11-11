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
import { isWebShell } from '../shell-kind'
import { xtermLookOptions } from '../theme/see-through'
import { currentXtermTheme, onXtermTheme } from '../theme/theme-store'
import { drawAt, type TermSize, usableSize } from './terminal-draw'
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
  /**
   * "Fit to this screen": the pty takes this view's size (`tabs.fit`). Absent for a terminal whose
   * pty only this view sizes (an overlay's): it never gets a size item, so it never offers one.
   */
  fit?(): void
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
    },
    fit: () => {
      window.cockpit.invoke('tabs.fit', { tabId }).catch(() => {})
    }
  }
}

/** How long the pty's size must differ from this view's before "Fit to this screen" shows. */
const FIT_BUTTON_DELAY_MS = 400

/** The smallest font a scaled-down terminal is drawn with (xterm cannot measure a cell smaller). */
const MIN_SCALED_FONT_PX = 4

/**
 * Whether this window was ever left (blurred) since the page loaded: a window `focus` before that
 * is the window being shown at start or restore, not the person coming back to it, and must not
 * take a terminal's size (two side-by-side windows would otherwise ping-pong at every launch).
 */
let windowLeft = false
let watchingBlur = false

/** ESC c: full reset (screen, scrollback, modes), parsed in order with the writes before it. */
const RIS = '\x1bc'

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
  /**
   * The pty's size from main's stream (`tabs.data` size items and snapshots) while this view follows
   * it: another view sizes the pty (terminal-sizes.ts), and the terminal is drawn at that size
   * whatever the pane. Undefined while this view sizes the pty itself (`local` items, and before the
   * first item): the terminal fits its pane at once, as before web access, and the pty catches up.
   * The desktop with web access off is always so; a remote view (no `local` from its bridge) follows.
   */
  private ptySize: TermSize | undefined
  /** What this view's pane fits, as last measured (and reported to main). */
  private ownSize: TermSize | undefined
  /** "Fit to this screen", shown over the terminal while the pty has another view's size. */
  private fitButton: HTMLButtonElement | undefined
  private fitTimer: ReturnType<typeof setTimeout> | undefined
  private renderWatch: { dispose(): void } | undefined
  /** Keeps the cursor in view while the grid is cropped (layout). */
  private cursorWatch: { dispose(): void } | undefined
  private disposed = false
  /** Set while this.focus() runs: a programmatic focus (tab activation, start, restore) never takes. */
  private focusing = false
  /**
   * takeOnLoad() or takeOnSelect() is waiting: for the pane to be laid out (a tab just selected or
   * created has no terminal attached yet) and for the pty's first size item (resolvePendingTake).
   */
  private pendingTake = false
  /** The window and page listeners of the take on focus, removed on dispose. */
  private readonly offTakeListeners: () => void
  private readonly offTheme: () => void
  private readonly offPrefs: () => void
  /** The font last asked for (applied once it has loaded), and which ask is the latest. */
  private font: TerminalFont
  private fontAsk = 0
  /** The font size the person chose; the drawn size is smaller while a larger pty is scaled to the pane (layout). */
  private baseFontSize: number

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
    this.baseFontSize = this.font.size
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
    this.offTakeListeners = this.listenForTakes()
    this.term.onData((data) => {
      // The user typing or pasting; main ignores it for an exited tab.
      this.io.input(data)
    })
  }

  /**
   * Write PTY output and acknowledge it once xterm has parsed it. The ack unit is the string
   * length (UTF-16 units) of what was written, which is what main counts (pty-service.ts, or the
   * view's own count while web access is on, desktop-flow.ts).
   *
   * `reset`: `data` is a whole screen from main (a resync after this view fell behind, or a page
   * re-attaching, design-web.md §5.2). The terminal starts over with it: a full reset (RIS) goes in
   * the same write, so output queued before it is still parsed first, then wiped, never drawn over
   * the snapshot. Not acked: main never counts a snapshot.
   *
   * `size`: the pty's size at this point of the stream (a size item, `data` '', or a snapshot's size;
   * design-web.md §5.2 "Size"). From then on the terminal is drawn at the pty's size, not its pane's,
   * unless `local`: this view sizes the pty, so it fits its pane (a window drag must not wait a round
   * trip to main for every step, and an item from earlier in the drag must not pull it back).
   */
  write(data: string, reset = false, size?: TermSize, local = false): void {
    if (this.disposed) return
    // The size applies at its point of the stream: after the writes queued before it are parsed
    // (they wrap at the old size, as on every other copy), before the ones after it. xterm runs a
    // write's callback before it parses the next write.
    if (usableSize(size)) {
      const at = { cols: size.cols, rows: size.rows }
      this.term.write('', () => (local ? this.fitLocally() : this.setPtySize(at)))
    }
    if (reset) this.term.write(`${RIS}${data}`)
    else if (data.length > 0) this.term.write(data, () => this.io.ack(data.length))
  }

  /**
   * The person moved to this view's terminal: it takes the pty's size, as "Fit to this screen" does
   * (design-web.md §5.2 "Size"). Only while another view sizes the pty (`ptySize`): with web access
   * off, or while this view sizes it, nothing is sent and the terminal keeps fitting at once.
   */
  private takeSize(): void {
    this.pendingTake = false
    if (this.disposed || !this.ptySize || !this.io.fit || !this.shown()) return
    this.io.fit()
  }

  /**
   * The browser page just loaded and this is the active tab: take as a click would. When the pty's
   * size item has not reached this view yet it waits for the first one (a size from another view
   * takes; a `local` one means this view sizes the pty already and drops the wait), so the take
   * never lands later for another reason.
   */
  takeOnLoad(): void {
    if (this.disposed) return
    this.pendingTake = true
    this.resolvePendingTake()
  }

  /**
   * The person selected this tab in this view (a tab bar click, the switcher, a tab shortcut, a tab
   * made with +): take as a click in the pane would. A tab whose terminal is not attached and laid
   * out yet takes once it is (refit), as the load take waits for its size item. Programmatic
   * selections never call this (TabsPane), and a wait is dropped once another tab is active
   * (cancelPendingTake).
   */
  takeOnSelect(): void {
    if (this.disposed) return
    this.pendingTake = true
    this.resolvePendingTake()
  }

  /** Another tab became active: a take still waiting here would land on a tab nobody picked. */
  cancelPendingTake(): void {
    this.pendingTake = false
  }

  /**
   * A waiting take lands once the pane is laid out and the pty's size is known: another view's
   * size takes. With none, the desktop page sizes the pty itself (it is told `local` items, and
   * none at all when the pty already had its size), so the wait ends there: web access off sends
   * nothing. A browser page is only told sizes of other views' kind, so no size there means its
   * first item has not come yet (setPtySize resolves it; a `local` one drops it, fitLocally).
   */
  private resolvePendingTake(): void {
    if (!this.pendingTake || this.disposed || !this.shown()) return
    if (this.ptySize) this.takeSize()
    else if (!isWebShell()) this.pendingTake = false
  }

  /** Attached to a pane that is laid out (the active tab: an inactive one is display:none). */
  private shown(): boolean {
    const el = this.container
    return el !== undefined && el.isConnected && el.clientWidth > 0 && el.clientHeight > 0
  }

  /**
   * Takes on real gestures only: a pointer press in the pane, a focus of the terminal that this
   * class did not start (Tab key, a click), the window focused after it was left, the page shown
   * again. Programmatic focus (this.focus(), tab activation at start or restore) never takes.
   */
  private listenForTakes(): () => void {
    if (!watchingBlur) {
      // Once for the page, on the first terminal (no listener for a page with none).
      watchingBlur = true
      window.addEventListener('blur', () => (windowLeft = true))
    }
    const onWindowFocus = (): void => {
      if (windowLeft) this.takeSize()
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') this.takeSize()
    }
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }

  private readonly onPointerDown = (): void => this.takeSize()

  private readonly onTermFocus = (): void => {
    if (!this.focusing) this.takeSize()
  }

  /** Show the terminal in `container`; safe to call again with a new container (a remount). */
  attach(container: HTMLElement): void {
    if (this.disposed) return
    this.observer?.disconnect()
    this.container?.removeEventListener('pointerdown', this.onPointerDown, true)
    this.container = container
    if (this.term.element) container.appendChild(this.term.element)
    else this.term.open(container)
    // Capture: xterm handles the press on its own elements first otherwise.
    container.addEventListener('pointerdown', this.onPointerDown, true)
    this.term.textarea?.removeEventListener('focus', this.onTermFocus)
    this.term.textarea?.addEventListener('focus', this.onTermFocus)
    // Fires once on observe and again whenever the pane is resized or un-hidden (a hidden tab is
    // display:none, 0x0, and cannot be measured).
    this.observer = new ResizeObserver(() => this.refit())
    this.observer.observe(container)
    this.refit()
  }

  detach(): void {
    this.container?.removeEventListener('pointerdown', this.onPointerDown, true)
    this.container?.classList.remove('terminal-crop', 'terminal-crop-cols', 'terminal-crop-rows')
    this.observer?.disconnect()
    this.observer = undefined
    this.container = undefined
  }

  /** Send our size again (a restarted PTY): main applies it when this view sizes the tab. */
  resetSize(): void {
    this.lastSize = ''
    this.refit()
  }

  focus(): void {
    if (this.disposed) return
    this.focusing = true
    try {
      this.term.focus()
    } finally {
      this.focusing = false
    }
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
      this.baseFontSize = font.size
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
    // The pane's size is measured at the chosen font: a scaled-down font (layout) would count more
    // cells and feed back into the size this view reports. layout() scales again in the same tick.
    if (this.term.options.fontSize !== this.baseFontSize) {
      this.term.options.fontSize = this.baseFontSize
      if (!this.fit.proposeDimensions()) return
    }
    const own = this.fit.proposeDimensions()
    if (!own || !(own.cols > 0) || !(own.rows > 0)) return
    this.ownSize = { cols: own.cols, rows: own.rows }
    // While this view sizes the pty, fit the pane at once (the pty follows this view's report).
    if (!this.ptySize) this.fit.fit()
    this.layout()
    const size = `${own.cols}x${own.rows}`
    if (size !== this.lastSize) {
      this.lastSize = size
      this.io.resize(own.cols, own.rows)
    }
    // A take waiting for this pane to be laid out (takeOnSelect of a tab just shown or created):
    // after the resize, so main knows the size this view takes.
    this.resolvePendingTake()
  }

  /** This view sizes the pty again: fit the pane, no more drawing at another view's size. */
  private fitLocally(): void {
    if (this.disposed) return
    this.pendingTake = false
    if (!this.ptySize) return
    this.ptySize = undefined
    this.refit()
  }

  /** The pty took `size` (a size item reached its point of the stream): draw at it. */
  private setPtySize(size: TermSize): void {
    if (this.disposed) return
    this.ptySize = size
    if (this.term.cols !== size.cols || this.term.rows !== size.rows) this.term.resize(size.cols, size.rows)
    this.layout()
    this.resolvePendingTake()
  }

  /** Scale or letterbox the pty-sized terminal in the pane, and show "Fit to this screen" when they differ. */
  private layout(): void {
    const el = this.term.element
    if (!el) return
    const { scale, fit, cropCols, cropRows } = drawAt(this.ownSize, this.ptySize)
    // Scaled by the font size, not a CSS transform: xterm maps a click with the element's scaled
    // bounding box but unscaled cell metrics, so every mouse coordinate would be off by the scale.
    // term.resize keeps cols x rows, so the pty-sized grid just gets smaller cells.
    const fontSize = scale < 1 ? Math.max(MIN_SCALED_FONT_PX, this.baseFontSize * scale) : this.baseFontSize
    if (this.term.options.fontSize !== fontSize) this.term.options.fontSize = fontSize
    const container = this.container
    // Below MIN_DRAW_SCALE the grid overflows the pane: it scrolls (terminal-crop), kept at the
    // bottom and the cursor, where Claude Code's prompt is. Only along the cropped axis: the other
    // one fits at the scale, give or take the pixel or two a scaled font's cell rounding adds, and
    // must not scroll (nor show a bar) for that.
    const crop = cropCols || cropRows
    container?.classList.toggle('terminal-crop', crop)
    container?.classList.toggle('terminal-crop-cols', cropCols)
    container?.classList.toggle('terminal-crop-rows', cropRows)
    if (crop && !this.cursorWatch) {
      this.cursorWatch = this.term.onCursorMove(() => this.keepCursorInView())
    } else if (!crop && this.cursorWatch) {
      this.cursorWatch.dispose()
      this.cursorWatch = undefined
      // Back to fitting: overflow is hidden again, and a scroll offset left from the crop would
      // keep the grid shifted off its top left corner.
      if (container) {
        container.scrollTop = 0
        container.scrollLeft = 0
      }
    }
    if (crop) requestAnimationFrame(() => this.keepCursorInView(true))
    if (!fit || !this.io.fit || !container) {
      clearTimeout(this.fitTimer)
      this.fitTimer = undefined
      if (this.fitButton) this.fitButton.hidden = true
      return
    }
    // Not at once: while this view sizes the pty, its own resize differs from the pty's size for
    // one round trip to main (a window being dragged), which must not flash the button.
    if (this.fitButton && !this.fitButton.hidden) return
    this.fitTimer ??= setTimeout(() => {
      this.fitTimer = undefined
      if (!this.disposed && drawAt(this.ownSize, this.ptySize).fit) this.showFit()
    }, FIT_BUTTON_DELAY_MS)
  }

  /** While cropped: scroll the pane so the cursor's cell (and, `bottom`, the last row) is in view. */
  private keepCursorInView(bottom = false): void {
    const pane = this.container
    const el = this.term.element
    if (this.disposed || !pane || !el || !pane.classList.contains('terminal-crop')) return
    const cellW = el.scrollWidth / this.term.cols
    const cellH = el.scrollHeight / this.term.rows
    if (!(cellW > 0) || !(cellH > 0)) return
    const buf = this.term.buffer.active
    const x = buf.cursorX * cellW
    const y = buf.cursorY * cellH
    // An axis that is not cropped stays at 0 (overflow hidden there, layout's per-axis classes).
    if (!pane.classList.contains('terminal-crop-rows')) pane.scrollTop = 0
    else if (bottom) pane.scrollTop = pane.scrollHeight
    else if (y + cellH > pane.scrollTop + pane.clientHeight) pane.scrollTop = y + cellH - pane.clientHeight
    else if (y < pane.scrollTop) pane.scrollTop = y
    if (!pane.classList.contains('terminal-crop-cols')) pane.scrollLeft = 0
    else if (x + cellW > pane.scrollLeft + pane.clientWidth) pane.scrollLeft = x + cellW * 4 - pane.clientWidth
    else if (x < pane.scrollLeft) pane.scrollLeft = Math.max(0, x - cellW * 4)
  }

  private showFit(): void {
    const container = this.container
    if (!container) return
    if (!this.fitButton) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'terminal-fit'
      button.textContent = 'Fit to this screen'
      button.title = 'Resize the terminal to this window (it has another screen’s size now)'
      button.addEventListener('click', () => {
        this.io.fit?.()
        this.focus()
      })
      this.fitButton = button
    }
    // In the pane's parent (the tab's view) when it has one: the pane scrolls while cropped, and
    // the button must stay in its corner.
    const parent = container.parentElement ?? container
    if (this.fitButton.parentElement !== parent) parent.appendChild(this.fitButton)
    this.fitButton.hidden = false
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.offTheme()
    this.offPrefs()
    this.detach()
    clearTimeout(this.fitTimer)
    this.renderWatch?.dispose()
    this.cursorWatch?.dispose()
    this.offTakeListeners()
    this.fitButton?.remove()
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

  /**
   * Output for a tab (`reset`: a whole screen; `size`: the pty's size at this point; `local`: this view
   * sizes it, TerminalSession.write);
   * dropped when the tab is closed.
   */
  write(tabId: string, data: string, reset = false, size?: TermSize, local = false): void {
    if (this.closed.has(tabId)) return
    this.get(tabId).write(data, reset, size, local)
  }

  get(tabId: string): TerminalSession {
    let session = this.sessions.get(tabId)
    if (!session) {
      session = new TerminalSession(tabId, this.ioFor(tabId), this.look)
      this.sessions.set(tabId, session)
      if (this.selectTake === tabId) {
        this.selectTake = undefined
        session.takeOnSelect()
      }
    }
    return session
  }

  /**
   * The person selected `tabId` in this view (TerminalSession.takeOnSelect) but its session is
   * not made yet (a tab just created with +): get() hands the take to it when it is.
   */
  private selectTake: string | undefined

  /** The page loaded with `tabId` active: its terminal takes the size; none yet, nothing (never created for it). */
  takeOnLoad(tabId: string): void {
    this.sessions.get(tabId)?.takeOnLoad()
  }

  /** The person selected `tabId` here: its terminal takes the size, now or once it is attached. */
  takeOnSelect(tabId: string): void {
    if (this.closed.has(tabId)) return
    this.activeChanged(tabId)
    const session = this.sessions.get(tabId)
    if (session) session.takeOnSelect()
    else this.selectTake = tabId
  }

  /**
   * `tabId` is the active tab now, whoever changed it: a take waiting on any other tab is
   * dropped, so a programmatic selection (restore, a plugin's focus, a close) never inherits one.
   */
  activeChanged(tabId: string): void {
    if (this.selectTake !== tabId) this.selectTake = undefined
    for (const [id, session] of this.sessions) if (id !== tabId) session.cancelPendingTake()
  }

  dispose(tabId: string): void {
    this.closed.add(tabId)
    if (this.selectTake === tabId) this.selectTake = undefined
    this.sessions.get(tabId)?.dispose()
    this.sessions.delete(tabId)
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) session.dispose()
    this.sessions.clear()
    this.closed.clear()
    this.selectTake = undefined
  }
}
