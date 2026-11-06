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
//   cursor pos.    CSI Pr ; Pc R                 reply to DSR 6
//   device attrs   CSI ? … c / CSI > … c         reply to DA1 / DA2
//   DECRPM         CSI ? Pd ; Ps $ y             reply to a mode query (DECRQM); the ANSI form without `?` too
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

/**
 * One report at the current position (sticky). Parameters are digits and `;` only, so a report
 * can never swallow a typed letter; OSC and DCS bodies stop at the first ESC or BEL, so an
 * unterminated one (Alt+] is ESC ]) does not match and stays the person's input.
 */
const REPORT = new RegExp(
  [
    '\\x1b\\[[IO]', // focus in / out
    '\\x1b\\[<\\d+;\\d+;\\d+[Mm]', // SGR mouse
    '\\x1b\\[M[\\x20-\\u{10FFFF}]{3}', // X10 mouse: three encoded bytes (UTF-8 mode can exceed 0x7f)
    '\\x1b\\[\\d+;\\d+R', // cursor position report
    '\\x1b\\[[?>][\\d;]*c', // device attributes (DA1 `?`, DA2 `>`)
    '\\x1b\\[\\??\\d+;\\d+\\$y', // DECRPM
    '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', // OSC reply, BEL or ST
    '\\x1bP[^\\x07\\x1b]*\\x1b\\\\' // DCS reply, ST
  ].join('|'),
  'uy'
)

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
