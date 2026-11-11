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
 * The smallest scale a pty-sized terminal is drawn at in a smaller pane. Below it the text is
 * unreadable (a wide browser owning the size made a narrow desktop pane draw at ~45%), so the grid
 * is drawn at this scale and cropped: the pane scrolls, kept at the bottom and the cursor.
 */
export const MIN_DRAW_SCALE = 0.7

/**
 * How a terminal of `pty` size is drawn in a pane that fits `own` (design-web.md §5.2 "Size"):
 * the pty's size always, so lines wrap where the program wrapped them; scaled down when it is larger
 * than the pane in either direction, but never below MIN_DRAW_SCALE: past that `crop` says the grid
 * overflows the pane (`cropCols`, `cropRows`: in which direction) and the pane scrolls. Letterboxed
 * (top left, the rest empty) when smaller. `fit`: offer "Fit to this screen" (the sizes differ).
 */
export function drawAt(
  own: TermSize | undefined,
  pty: TermSize | undefined
): { scale: number; fit: boolean; cropCols: boolean; cropRows: boolean } {
  if (!own || !pty) return { scale: 1, fit: false, cropCols: false, cropRows: false }
  const colScale = own.cols / pty.cols
  const rowScale = own.rows / pty.rows
  const scale = Math.max(MIN_DRAW_SCALE, Math.min(1, colScale, rowScale))
  return {
    scale,
    fit: own.cols !== pty.cols || own.rows !== pty.rows,
    cropCols: colScale < MIN_DRAW_SCALE,
    cropRows: rowScale < MIN_DRAW_SCALE
  }
}
