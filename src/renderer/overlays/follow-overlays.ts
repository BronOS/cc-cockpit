import type { OverlayInfo } from '../../shared/ipc'

/** The two ways main tells this page its overlay stack (window.cockpit in the app, a fake in tests). */
export interface OverlayStackBridge {
  /** `overlays.list`: the stack as main had it when it answered. */
  list(): Promise<OverlayInfo[]>
  /** `overlays.updated`: the whole stack, after every change. Returns the unsubscribe. */
  onUpdated(listener: (stack: OverlayInfo[]) => void): () => void
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
