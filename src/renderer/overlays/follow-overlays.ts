import type { OverlayInfo } from '../../shared/ipc'

/** The two ways main tells this page its overlay stack (window.cockpit in the app, a fake in tests). */
export interface OverlayStackBridge {
  /** `overlays.list`: the stack as main had it when it answered. */
  list(): Promise<OverlayInfo[]>
  /** `overlays.updated`: the whole stack, after every change. Returns the unsubscribe. */
  onUpdated(listener: (stack: OverlayInfo[]) => void): () => void
}

/**
 * `overlays.list` resets terminal overlays' flow control in main, so the desktop page asks once per
 * page load (the same rule as `tabs.list`); a StrictMode remount reuses the answer.
 *
 * The web shell (`fresh()` true) asks on every call, as TabsPane does: main resets no flow for a
 * remote view's list (OverlayManager.list), and a reconnect remounts the shell, which must be drawn
 * from the new socket's list, not the first one's (overlays opened or closed while away, or a first
 * call the dropped socket rejected, kept for good).
 */
export function listOnce(list: () => Promise<OverlayInfo[]>, fresh: () => boolean): () => Promise<OverlayInfo[]> {
  let listed: Promise<OverlayInfo[]> | undefined
  return () => {
    if (fresh()) return list()
    listed ??= list()
    return listed
  }
}

/**
 * Follow main's overlay stack: `apply` gets the list answer, then every update. The two may
 * arrive in either order: an overlay opened (or closed) while `overlays.list` was in flight sends
 * `overlays.updated` before the list answer lands, and that answer is then an older snapshot.
 * Applied last, it hid a live overlay (main kept its process and the opener's pending result,
 * with nothing on screen to answer or close) or showed one already gone. An update always carries
 * the whole stack, so once one was applied the list answer is dropped. Returns the unsubscribe,
 * which also drops a list answer still in flight.
 */
export function followOverlays(
  bridge: OverlayStackBridge,
  apply: (stack: OverlayInfo[]) => void,
  onError: (err: unknown) => void
): () => void {
  let updated = false
  const off = bridge.onUpdated((stack) => {
    updated = true
    apply(stack)
  })
  bridge
    .list()
    .then((stack) => {
      if (!updated) apply(stack)
    })
    .catch(onError)
  return () => {
    updated = true
    off()
  }
}

/**
 * The order to keep the overlays' elements in the DOM: the ones already shown where they were,
 * new ones after them. The stack order (who is on top) is drawn with z-index and `inert` instead.
 * A plugin's `focus()` moves an overlay to the top of main's stack, and React moving its element
 * would move an html overlay's iframe, which reloads the page and loses what the user typed.
 */
export function domOrder(previous: readonly string[], stack: readonly OverlayInfo[]): string[] {
  const live = new Set(stack.map((o) => o.id))
  const order = previous.filter((id) => live.has(id))
  const placed = new Set(order)
  for (const o of stack) if (!placed.has(o.id)) order.push(o.id)
  return order
}
