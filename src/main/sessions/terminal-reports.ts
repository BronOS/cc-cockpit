// Whether a renderer input chunk is the person's input or only terminal reports (SessionInfo.typed,
// Autopilot v2 design "Core change" 2). The renderer's xterm `onData` carries both: what the person
// types or pastes, and the replies xterm writes by itself, with no one at the keyboard, to queries
// Claude Code's TUI makes and to modes it turns on. A takeover flag set by those would mark every
// tab the person merely switched to or clicked in, so a chunk made ONLY of reports is not input.
//
// The reports recognized (7-bit forms only: xterm.js never sends the 8-bit C1 ones):
//   focus          CSI I / CSI O                 sent just by switching to the tab (status-reducer.ts isAnswerKey)
//   mouse, SGR     CSI < Pb ; Px ; Py M|m        a click, drag or wheel while mouse tracking is on: looking, not typing
//   mouse, X10     CSI M + 3 bytes               the same in the legacy encoding (each byte >= 0x20)
//   cursor pos.    CSI Pr ; Pc R                 reply to DSR 6 (CSI ? Pr ; Pc R to DECXCPR)
//   device status  CSI Ps n                      reply to DSR 5
//   device attrs   CSI ? … c / CSI > … c         reply to DA1 / DA2
//   DECRPM         CSI ? Pd ; Ps $ y             reply to a mode query (DECRQM); the ANSI form without `?` too
//   window reports CSI 4|6|8 ; Ph ; Pw t         reply to XTWINOPS 14 / 16 / 18 (sizes)
//   OSC replies    OSC … BEL | OSC … ST          colour queries (OSC 10/11/4) and the like
//   DCS replies    DCS … ST                      DECRQSS / XTVERSION replies (not in the design's list; same kind)
//
// Everything else is the person's: printable keys, Enter, Backspace, Ctrl+C, arrows, a paste, and a
// report glued to any of those (a key and a focus report in one chunk still holds the key).
//
// Two edge cases, both decided on purpose:
// - Mouse wheel in alt-screen without mouse tracking: xterm's alternate-scroll turns the wheel into
//   arrow keys (CSI A / CSI B, or SS3 A / SS3 B in application cursor mode). They reach Claude's
//   prompt as history keys and can put an old prompt into its input box, so a later paste would be
//   glued to it: they count as typing, like the arrow keys they are (no way to tell them apart).
// - Shift/Ctrl+F3 is `CSI 1 ; Pm R` in xterm, the same bytes as a cursor position report. It reads
//   as a report; F3 changes nothing in Claude's input box, so missing it costs nothing.
//
// Pure, no Electron: vitest covers each kind (test/unit/terminal-reports.test.ts).

// Web access (design-web.md §5.2 "Main answers terminal queries"): while main's headless copy of a
// tab answers the program's queries, every view's own answers are stripped from its input
// (`stripQueryReplies`), or a desktop and a browser would both reply to one DSR and the program
// would read the second reply as typed text. The reports a view sends because the person acted on
// it (focus, mouse) pass: a second view can click and scroll in a TUI. A paste is never touched.

/**
 * Reports a view sends because of something the person did on it (focus, mouse). Parameters are
 * digits and `;` only, so a report can never swallow a typed letter.
 */
const PASS_PARTS = [
  '\\x1b\\[[IO]', // focus in / out
  '\\x1b\\[<\\d+;\\d+;\\d+[Mm]', // SGR mouse
  '\\x1b\\[M[\\x20-\\u{10FFFF}]{3}' // X10 mouse: three encoded bytes (UTF-8 mode can exceed 0x7f)
]

/**
 * Replies a terminal writes by itself to a program's query. OSC and DCS bodies stop at the first
 * ESC or BEL, so an unterminated one (Alt+] is ESC ]) does not match and stays the person's input.
 */
const REPLY_PARTS = [
  '\\x1b\\[\\??\\d+;\\d+R', // cursor position report (DSR 6), DECXCPR (DSR ?6)
  '\\x1b\\[[03]n', // device status (DSR 5 -> CSI 0 n, or 3 n: malfunction)
  '\\x1b\\[[?>][\\d;]*c', // device attributes (DA1 `?`, DA2 `>`)
  '\\x1b\\[\\??\\d+;\\d+\\$y', // DECRPM
  '\\x1b\\[[468];\\d+;\\d+t', // window reports (XTWINOPS 14/16/18)
  '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', // OSC reply, BEL or ST
  '\\x1bP[^\\x07\\x1b]*\\x1b\\\\' // DCS reply, ST
]

/** One report of either kind at the current position (sticky). */
const REPORT = new RegExp([...PASS_PARTS, ...REPLY_PARTS].join('|'), 'uy')
const PASS = new RegExp(PASS_PARTS.join('|'), 'uy')
const REPLY = new RegExp(REPLY_PARTS.join('|'), 'uy')

/** Bracketed paste markers (xterm wraps a paste in them when the program turned mode 2004 on). */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * True when `chunk` holds anything the person typed or pasted; false when it consists only of
 * terminal reports (one or several back to back) or is empty.
 */
export function isPersonInput(chunk: string): boolean {
  let at = 0
  while (at < chunk.length) {
    REPORT.lastIndex = at
    const m = REPORT.exec(chunk)
    // A match is never empty (each alternative starts with ESC), so the loop always advances.
    if (m === null) return true
    at += m[0].length
  }
  return false
}

/**
 * `chunk` without the query replies in it (web access on: main answers the program, see above).
 * Focus and mouse reports, keys, and a reply's neighbours stay, in order: a reply glued to a key
 * keeps the key. A bracketed paste is copied as it is (pasted text that happens to look like a
 * reply is still the person's); one missing its end marker runs to the end of the chunk, as xterm
 * sends a paste in one piece. Shift/Ctrl+F3 (`CSI 1 ; Pm R`, see the header) reads as a cursor
 * position report and is dropped too.
 */
export function stripQueryReplies(chunk: string): string {
  if (!chunk.includes('\x1b')) return chunk
  let out = ''
  let at = 0
  while (at < chunk.length) {
    const esc = chunk.indexOf('\x1b', at)
    if (esc < 0) {
      out += chunk.slice(at)
      break
    }
    out += chunk.slice(at, esc)
    if (chunk.startsWith(PASTE_START, esc)) {
      const end = chunk.indexOf(PASTE_END, esc + PASTE_START.length)
      const stop = end < 0 ? chunk.length : end + PASTE_END.length
      out += chunk.slice(esc, stop)
      at = stop
      continue
    }
    // Mouse first: an X10 report's three bytes are copied whole, never read as a reply's start.
    PASS.lastIndex = esc
    const kept = PASS.exec(chunk)
    if (kept) {
      out += kept[0]
      at = esc + kept[0].length
      continue
    }
    REPLY.lastIndex = esc
    const reply = REPLY.exec(chunk)
    if (reply) {
      at = esc + reply[0].length
      continue
    }
    // A key's ESC (Esc, Alt+x, an arrow): kept, and the scan goes on after it.
    out += '\x1b'
    at = esc + 1
  }
  return out
}
