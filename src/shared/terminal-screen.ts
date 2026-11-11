// A terminal's screen and modes as a string another terminal can start from (design-web.md §5.2).
// Shared by web access's headless copies (main/terminals/mirror-worker.ts, a view's snapshot) and the
// desktop page's xterm (renderer/tabs/terminal-session.ts, the screen that seeds a copy when web
// access starts while the tab runs, or after the worker restarted; terminals/mirror.ts "Seeding").
// No xterm import: the worker passes an @xterm/headless Terminal, the page an @xterm/xterm one, and
// both have the same core (6.0.0, the pinned version) behind `_core`.

/** The public part of a Terminal both packages have, all this module reads besides `_core`. */
export interface ScreenTerminal {
  readonly cols: number
  readonly rows: number
  readonly modes: { readonly synchronizedOutputMode: boolean }
}

/** A terminal's screen: the serialize addon's output plus `extraModes`, at the size it was taken. */
export interface TerminalScreen {
  cols: number
  rows: number
  data: string
}

/**
 * The desktop page's answer to main's `tabs.screenAsk` (`tabs.screen`): `screen` when it has one;
 * `busy` when its parser was inside an escape sequence at the asked point (a screen taken there would
 * leave the copy printing the sequence's tail as text), and main asks again later; neither when the
 * page has no terminal for the tab. Untrusted data in main: checked against the ask out for the tab
 * and MAX_SCREEN_CHARS (mirror.ts `screen`).
 */
export interface ScreenAnswer {
  id: number
  screen?: TerminalScreen
  busy?: true
}

/**
 * The longest screen main takes from a page (UTF-16 units). A copy's own snapshot of 5,000 lines of
 * Claude's output is well under 1 MiB; this is far above that and still bounds what one IPC message
 * can make main hold and hand to the worker. Over it, the page sends the screen without scrollback
 * (`screenOf`), and main refuses one still over (the copy then starts blank).
 */
export const MAX_SCREEN_CHARS = 8 * 1024 * 1024

/** The xterm internals `atGround` and `extraModes` read (6.0.0); absent fields read as "unknown". */
interface XtermCore {
  _inputHandler?: {
    _parser?: { currentState?: number }
    _stringDecoder?: { _interim?: number }
  }
  coreService?: {
    isCursorHidden?: boolean
    decPrivateModes?: { cursorStyle?: 'block' | 'underline' | 'bar'; cursorBlink?: boolean }
  }
  coreMouseService?: { activeEncoding?: string }
  buffer?: { scrollTop?: number; scrollBottom?: number }
}

function coreOf(term: ScreenTerminal): XtermCore {
  return ((term as unknown as { _core?: XtermCore })._core ?? {}) as XtermCore
}

/**
 * Whether the parser is between sequences: ParserState.GROUND (0) and no half surrogate pair
 * waiting in the string decoder. A flushed chunk can end inside an escape sequence (PtyService
 * flushes on time and size, not on sequence boundaries) and a serialized screen carries no parser
 * state, so a terminal started from a screen taken mid-sequence would print the sequence's tail as
 * text. xterm internals (6.0.0, the pinned version): if they move, this reads as ground, which only
 * brings that risk back (the tests catch it on an upgrade).
 */
export function atGround(term: ScreenTerminal): boolean {
  const ih = coreOf(term)._inputHandler
  const state = ih?._parser?.currentState
  const interim = ih?._stringDecoder?._interim ?? 0
  return (state === undefined || state === 0) && interim === 0
}

/** DECSCUSR's steady shapes; the blinking one is one less. */
const CURSOR_STYLE: Record<string, number> = { block: 2, underline: 4, bar: 6 }

/**
 * Modes the serialize addon (0.14.0) does not write but a live program relies on. Measured in the
 * spike against the addon's _serializeModes: it keeps DECCKM 1, DECNKM 66, 2004, IRM 4, DECOM 6,
 * 45, 1004, DECAWM 7 off, mouse tracking 9/1000/1002/1003 and the alt screen 1049; it drops:
 * - cursor visibility (DECTCEM 25): Claude Code hides the cursor; a view would show a stray one;
 * - mouse encoding (1006 SGR, 1016 SGR-pixels): without it a view with mouse tracking would send
 *   X10 reports the program cannot parse;
 * - the scroll region (DECSTBM): set inside DECSC/DECRC, since DECSTBM homes the cursor;
 * - the cursor style (DECSCUSR);
 * - synchronized output (2026): a snapshot inside a sync block would draw the half-drawn frame at
 *   once (harmless, the closing 2026l follows), but re-emitting keeps the view identical.
 * Still lost (design-web.md §7a): the window title (main has its own), charsets (G0-G3), the saved
 * cursor slot (the DECSTBM fix even overwrites it), tab stops, the normal screen's cursor while the
 * alt screen is on.
 */
export function extraModes(term: ScreenTerminal): string {
  const core = coreOf(term)
  let out = ''
  if (core.coreService?.isCursorHidden) out += '\x1b[?25l'
  const encoding = core.coreMouseService?.activeEncoding
  if (encoding === 'SGR') out += '\x1b[?1006h'
  else if (encoding === 'SGR_PIXELS') out += '\x1b[?1016h'
  const top = core.buffer?.scrollTop
  const bottom = core.buffer?.scrollBottom
  if (top !== undefined && bottom !== undefined && (top !== 0 || bottom !== term.rows - 1)) {
    out += `\x1b7\x1b[${top + 1};${bottom + 1}r\x1b8`
  }
  const modes = core.coreService?.decPrivateModes
  if (modes?.cursorStyle !== undefined) {
    const steady = CURSOR_STYLE[modes.cursorStyle]
    if (steady !== undefined) out += `\x1b[${modes.cursorBlink ? steady - 1 : steady} q`
  }
  // Last: everything above must apply before the view starts deferring its rendering.
  if (term.modes.synchronizedOutputMode) out += '\x1b[?2026h'
  return out
}

/**
 * The desktop page's screen of a tab for main (`tabs.screen`), taken inside a write callback so it
 * holds exactly the output written before: `serialize(n)` is the page's serialize addon with `n`
 * lines of scrollback. 'busy' when the parser is inside a sequence (see ScreenAnswer). Over
 * MAX_SCREEN_CHARS it is taken again without scrollback: the modes and the screen are what the copy
 * needs most (the alt screen, mouse tracking); main refuses one still over.
 */
export function screenOf(term: ScreenTerminal, serialize: (scrollback: number) => string, scrollback: number): TerminalScreen | 'busy' {
  if (!atGround(term)) return 'busy'
  const modes = extraModes(term)
  let data = serialize(scrollback) + modes
  if (data.length > MAX_SCREEN_CHARS && scrollback > 0) data = serialize(0) + modes
  return { cols: term.cols, rows: term.rows, data }
}
