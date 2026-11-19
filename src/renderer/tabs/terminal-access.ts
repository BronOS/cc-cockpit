// What a guest view's terminals send (design-guests §8, D-14, spec-review 14). DOM-free so unit tests run
// it in plain Node; terminal-session.ts wraps every tab's and overlay's io with it.
//
// - A read guest sends nothing that reaches the pty or sizes it: no input (keys, mouse and focus reports
//   all come through xterm's onData), no size report, no "Fit to this screen" (no `fit` member, so the
//   button never shows and no take can run).
// - A write guest sends its input, but takes the size only by its own explicit acts: its first key or
//   paste in that terminal (`act`), or Fit. Until then its size reports are held (the latest only) and
//   go out at that act, before the key: main's take on typing reads the view's last report. A focus or
//   mouse report is no act (it comes through onData too, with nobody typing).
// - Implicit takes (page load, select, a pointer press, a refocus gesture) are the owner's only
//   (implicitTakesAllowed); TerminalSession.takeSize, where they all end, asks it.
// - Neither guest answers `tabs.screenAsk` (`tabs.screen` is guest `no`; main never asks a guest).
//
// A UI hint only: main refuses every one of these from a guest view by the access it bound (GUEST_CLASS,
// ViewSizes), so this keeps the page from sending what would be refused or from pulling the size by an
// accident the rule says is not the guest's.

import type { ScreenAnswer } from '../../shared/terminal-screen'
import type { ViewAccess } from '../../shared/views'

/**
 * Where a terminal's keystrokes, acks and size go: a tab's PTY by default, a terminal overlay's
 * through the overlay channels (OverlayStack). Both PTYs live in main and are scoped there. Here, not in
 * terminal-session.ts (which re-exports it), so this module loads in plain Node with no DOM or CSS.
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
  /**
   * This view's screen of the terminal, answering main's `tabs.screenAsk` (`tabs.screen`). Absent
   * for a terminal main never asks about (an overlay's).
   */
  screen?(answer: ScreenAnswer): void
  /**
   * The person's own key or paste in this terminal (a write guest's explicit act, D-14: its held size
   * report goes out now, before the key). Set only by gateTerminalIo; focus and mouse reports come
   * through `input` and are no act.
   */
  act?(): void
}

/** Whether this view's implicit gestures may take a terminal's size: the owner's only (D-14). */
export function implicitTakesAllowed(access: ViewAccess): boolean {
  return access === 'owner'
}

/**
 * `io` as a view of `access` may use it. The owner's comes back as it is (the same object). Read when the
 * terminal is made: a role switch reconnects the web shell, which remounts it with new terminals.
 */
export function gateTerminalIo(io: TerminalIo, access: ViewAccess): TerminalIo {
  if (access === 'owner') return io
  const ack = (count: number): void => io.ack(count)
  if (access === 'read') {
    return { input: () => {}, ack, resize: () => {} }
  }
  let acted = false
  let held: { cols: number; rows: number } | undefined
  const act = (): void => {
    if (acted) return
    acted = true
    const size = held
    held = undefined
    if (size) io.resize(size.cols, size.rows)
  }
  const gated: TerminalIo = {
    input: (data) => io.input(data),
    ack,
    resize: (cols, rows) => {
      if (acted) io.resize(cols, rows)
      else held = { cols, rows }
    },
    act
  }
  const fit = io.fit
  if (fit) {
    gated.fit = () => {
      // Fit is an explicit take: this view's size first (held until now), then the take.
      act()
      fit.call(io)
    }
  }
  return gated
}
