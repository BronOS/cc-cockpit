// Discuss with Claude (design-next §3.5): the limits and the preselection rule shared by the
// renderer's popover (DiscussPopover.tsx) and main (main/overlays/discuss.ts, overlay-manager.ts).
// The renderer applies them for a fast answer; main checks everything again, since the renderer is
// not trusted. Kept free of Node and DOM imports.

/** The whole message sent to Claude; the opener's context is cut to fit. */
export const MAX_DISCUSS_TEXT = 20_000
/** The overlay's type as one line (`File: …`, `Item: …`, `name: k=v …`), cut to this. */
export const MAX_DISCUSS_TYPE_LINE = 500
/** How long the opener's `onDiscuss` may take before Discuss shows its error and sends nothing. */
export const DISCUSS_ASK_MS = 5_000
/** New session from Discuss: at most this many tabs per window in DISCUSS_NEW_WINDOW_MS (the opener's own budget untouched). */
export const MAX_DISCUSS_NEW_SESSIONS = 5
export const DISCUSS_NEW_WINDOW_MS = 60_000

/** Where Discuss sends: an existing Claude tab of the overlay's window, or a new session. */
export type DiscussTarget = { kind: 'tab'; tabId: string } | { kind: 'new' }

/**
 * The target the popover opens on: the opener's `discuss.tabId` when it is one of the listed Claude
 * tabs of this window, else the window's active tab when that is a Claude tab, else New session.
 */
export function preselectDiscussTarget(
  tabs: readonly { tabId: string }[],
  preferred: string | undefined,
  active: string | null | undefined
): DiscussTarget {
  for (const id of [preferred, active]) {
    if (id && tabs.some((t) => t.tabId === id)) return { kind: 'tab', tabId: id }
  }
  return { kind: 'new' }
}
