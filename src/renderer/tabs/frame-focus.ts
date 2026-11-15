// Which frame has the keys (docs/design-split-pages.md §4 "Unprompted focus is allowed, so the
// shell checks"). DOM-free: the decision and the evidence it rests on; PageTabArea.tsx feeds it the
// DOM's events and TabsPane acts on what it decides.
//
// Why a check at all: Chromium lets a sandboxed cross-site frame call `focus()` with no user
// activation and take the keyboard from the shell (the review's spike, Electron 45). A file pane that
// mounts while the person types in the Claude pane beside it (a restore, Show Tab Beside, a remount
// after an LRU trim) could pull their keys into the page, which is what D4 exists to stop: a plugin
// never takes the keys from a Claude tab waiting for input. `navigator.userActivation` cannot tell
// the cases apart, since it is true precisely while the person types.
//
// What the shell can see: the iframe element gets no `focus` or `focusin` event when the keyboard
// goes into it; the shell's window gets a `blur` (shell to frame) or nothing at all (frame to frame),
// and `document.activeElement` changes silently. So the shell reads `activeElement` at the window's
// `blur`, at a page's `cc-plugin.tab-focus` hint (only a reason to look) and before a chord or Ask
// Claude from a frame, and a frame holding the keyboard counts only with evidence of the person:
// - the shell's own focus call put it there (focusActive, a pane chord, a select, `wantFocus`), or
// - the person's pointer went into it: the last pointer position the shell saw is inside or on the
//   edge of the frame's box, with no shell `keydown` (and no focus moving within the shell) after it.
//   Typing in the Claude pane while the pointer rests over the file beside it is no evidence: the keys
//   went to the shell after the pointer stopped.
//
// "On the edge" is wider than a pixel or two, measured: the shell gets NO event as the pointer goes
// into a cross-site frame (no `pointerout`, no `pointerover` of the iframe, no `:hover` on it; the
// e2e's moves, Electron 45), and nothing while it is inside one. So the last position the shell has is
// that of the last `pointermove` over its own area before the frame, one event's travel short of the
// frame's edge (a pointer at 1000 px/s moves about 16 px per frame). It counts within
// POINTER_NEAR_PX, for the visible frame nearest to it only (two frames across a divider are 6 px
// apart, so a position between them is evidence for one at most). A pointer that jumps into a frame
// from far away (a test's teleporting mouse) or crosses from one frame straight into another with no
// event over the shell between them leaves no evidence: that frame is blurred, and the person clicks
// its pane header (or moves over the shell and back) to pick it.

/** A box in viewport pixels. */
export interface ViewportRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * How far outside a frame's box the last pointer position may be and still count as "went into it":
 * about one pane header (22 px) and one event's travel of a quick pointer. The nearest frame wins
 * when several are this close (`pointerNear`).
 */
export const POINTER_NEAR_PX = 24

/** What the shell does about a frame holding the keyboard. */
export type FramePick = { pick: string } | { blur: true }

/**
 * The decision (pure). `activeTab`: the tab whose frame holds the keyboard now (null: none does);
 * `activeId`: the view's focused pane, null while the keys are off (D3); `ownFocus`: the shell's own
 * focus call put the keyboard in that frame; `pointer`: the last pointer position is in or on the
 * edge of that frame's box (pointerNear); `keyAfterPointer`: a shell keydown (or a focus within the shell) came
 * after that position.
 *
 * - No frame holds the keyboard, or the focused pane's frame does: nothing to do (null).
 * - Keys off: the frame is blurred, whatever the evidence; nothing is picked until the person picks
 *   a pane the shell sees (a header press, a terminal click, a chord).
 * - With evidence: the person moved into that pane; the shell picks it (dispatches the selection,
 *   so the outline and `tabs.selected` follow).
 * - Without: the shell blurs the frame and gives the keyboard back to the focused pane.
 */
export function framePick(
  activeTab: string | null,
  activeId: string | null,
  ownFocus: boolean,
  pointer: boolean,
  keyAfterPointer: boolean
): FramePick | null {
  if (activeTab === null) return null
  if (activeId === null) return { blur: true }
  if (activeTab === activeId) return null
  if (ownFocus || (pointer && !keyAfterPointer)) return { pick: activeTab }
  return { blur: true }
}

/** How far `at` is from `rect` in px (0 inside it); Infinity for an empty box. */
export function distanceTo(at: { x: number; y: number }, rect: ViewportRect): number {
  if (!(rect.width > 0) || !(rect.height > 0)) return Number.POSITIVE_INFINITY
  const dx = Math.max(rect.left - at.x, 0, at.x - (rect.left + rect.width))
  const dy = Math.max(rect.top - at.y, 0, at.y - (rect.top + rect.height))
  return Math.hypot(dx, dy)
}

/**
 * Whether `at` is inside `rect` or within `near` px of it, and nearer to it than to any of `others`
 * (the other visible frames; a tie is evidence for none).
 */
export function pointerNear(
  at: { x: number; y: number } | null,
  rect: ViewportRect | null,
  others: readonly ViewportRect[] = [],
  near = POINTER_NEAR_PX
): boolean {
  if (!at || !rect) return false
  const d = distanceTo(at, rect)
  if (!(d <= near)) return false
  return others.every((o) => d < distanceTo(at, o))
}

/**
 * The pointer half of the evidence: the last pointer position the shell saw and whether a shell key
 * (or a focus within the shell) came after it. The shell's own focus calls are the pool's half
 * (PageFrames.ownFocus).
 */
export class PointerEvidence {
  private at: { x: number; y: number } | null = null
  private keyAfter = false

  /** A `pointermove` or `pointerout` in the shell's document, in viewport pixels. */
  moved(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    this.at = { x, y }
    this.keyAfter = false
  }

  /**
   * A `keydown` in the shell's document, or the focus moving to an element of the shell: whatever
   * holds the keyboard after this was not put there by the pointer's last move.
   */
  shellKey(): void {
    this.keyAfter = true
  }

  /** Whether the last pointer position is in or near `rect`, nearer to it than to `others` (pointerNear). */
  near(rect: ViewportRect | null, others: readonly ViewportRect[] = []): boolean {
    return pointerNear(this.at, rect, others)
  }

  /** Whether a shell key (or shell focus) came after the last pointer position. */
  keyAfterPointer(): boolean {
    return this.keyAfter
  }
}
