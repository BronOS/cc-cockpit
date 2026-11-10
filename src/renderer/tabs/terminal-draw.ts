// How a tab's terminal is drawn when its pty has another view's size (design-web.md §5.2 "Size",
// plan Task 15). Plain functions with no DOM or window: TerminalSession uses them, unit tests too.

/** A terminal size: the pty's (from main's stream) or this view's own (what its pane fits). */
export interface TermSize {
  cols: number
  rows: number
}

/** A size from main worth drawing at (main's PtyService bounds; anything else is ignored). */
export function usableSize(size: TermSize | undefined): size is TermSize {
  return (
    size !== undefined &&
    Number.isInteger(size.cols) &&
    Number.isInteger(size.rows) &&
    size.cols >= 1 &&
    size.rows >= 1 &&
    size.cols <= 1000 &&
    size.rows <= 1000
  )
}

/**
 * How a terminal of `pty` size is drawn in a pane that fits `own` (design-web.md §5.2 "Size"):
 * the pty's size always, so lines wrap where the program wrapped them; scaled down when it is larger
 * than the pane in either direction (the whole screen stays in view), letterboxed (top left, the
 * rest empty) when smaller. `fit`: offer "Fit to this screen" (the sizes differ).
 */
export function drawAt(own: TermSize | undefined, pty: TermSize | undefined): { scale: number; fit: boolean } {
  if (!own || !pty) return { scale: 1, fit: false }
  const scale = Math.min(1, own.cols / pty.cols, own.rows / pty.rows)
  return { scale, fit: own.cols !== pty.cols || own.rows !== pty.rows }
}
