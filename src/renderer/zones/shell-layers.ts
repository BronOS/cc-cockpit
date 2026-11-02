// What may cover a webview panel's native view (plan B Task 8). A WebContentsView paints above the
// whole shell page, so a menu, the command palette, a dialog, the settings screen or an overlay
// drawn by this page would sit UNDER it wherever the two overlap, and a splitter drag over it would
// lose the pointer to it. Each of those takes a layer here while it is up; a webview panel reports
// itself hidden while any layer is up (WebviewPanel.tsx) and main hides the view.
//
// A count, not a per-element overlap test: a menu opening is short-lived, a view blinking off for
// it costs nothing, and a missed overlap (a menu drawn under a view the user then cannot click)
// would be a real bug. DOM- and React-free on purpose, so unit tests drive it in plain Node; the
// hook components use is use-shell-layer.ts.

let count = 0
const listeners = new Set<() => void>()

function changed(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (err) {
      console.warn('shell layer listener failed', err)
    }
  }
}

/** A layer is up until the returned release is called (twice is harmless). */
export function acquireLayer(): () => void {
  count += 1
  changed()
  let released = false
  return () => {
    if (released) return
    released = true
    count -= 1
    changed()
  }
}

/** Whether any layer is up now. */
export function layersUp(): boolean {
  return count > 0
}

/** Hear every layer coming or going; returns the unsubscribe. */
export function onLayersChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
