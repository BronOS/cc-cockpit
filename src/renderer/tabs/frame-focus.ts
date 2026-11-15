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
//   edge of the frame's box, no more than POINTER_FRESH_MS ago, with no shell `keydown` (and no focus
//   moving within the shell) after it. Typing in the Claude pane while the pointer rests over the
//   file beside it is no evidence: the keys went to the shell after the pointer stopped.
//
// "On the edge" is wider than a pixel or two, measured: the shell gets NO event as the pointer goes
// into a cross-site frame (no `pointerout`, no `pointerover` of the iframe, no `:hover` on it; the
// e2e's moves, Electron 45), and nothing while it is inside one. So the last position the shell has is
// that of the last `pointermove` over its own area before the frame, one event's travel short of the
// frame's edge (a pointer at 1000 px/s moves about 16 px per frame). It counts within
// POINTER_NEAR_PX, for the visible frame nearest to it only (two frames across a divider are 6 px
// apart, so a position between them is evidence for one at most). A pointer that jumps into a frame
// from far away (a test's teleporting mouse, a touch or pen tap), crosses from one frame straight into
// another with no event over the shell between them, or rested there longer than POINTER_FRESH_MS
// (or since a key) leaves no evidence.
//
// Without evidence the frame is blurred and, failing safe, the keyboard goes to NOTHING (the shell's
// body): a person who just clicked into the editor must never be typing into the Claude pane, where a
// stray Enter, digit or "y" can answer a permission prompt (CLAUDE.md). The one exception is the
// element the person was typing in a moment ago (a shell `keydown` within GIVE_BACK_MS, the pointer
// not near the frame): a pane mounting beside Claude while they type took the keys mid-word, and
// they get them back exactly where they were. And the blurred frame lets the pointer through to its
// pane until the shell sees the pointer move (`passThrough`, PageTabArea.tsx): the person's next press
// on it lands on the shell's pane and picks it, and their next move gives fresh pointer evidence, so a
// click the shell could not prove costs one more click, never a key in the wrong pane.

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

/**
 * How long the last pointer position stays evidence (ms). Hover is not consent for ever: a page that
 * focuses itself later (a host message, a loop) is not picked because the pointer stopped beside its
 * frame minutes ago. Long enough for a person to come in over the header and travel to the line they
 * click (that travel is inside the frame, where the shell sees no event).
 */
export const POINTER_FRESH_MS = 3000

/**
 * How recent a shell `keydown` must be for its element to get the keyboard back from a frame that
 * took it with no evidence (ms): the "typing while a pane mounts" case, a key every few hundred ms.
 * A click after a pause gets no give-back, so it never routes keys into a terminal.
 */
export const GIVE_BACK_MS = 500

/**
 * What the shell does about a frame holding the keyboard: pick its pane, or blur it, and either leave
 * the keyboard on nothing or (`giveBack`) give it back to the element the person was just typing in.
 */
export type FramePick = { pick: string } | { blur: true; giveBack: boolean }

/** What the shell knows about the frame holding the keyboard (checkFrameFocus gathers it). */
export interface FrameEvidence {
  /** The shell's own focus call put the keyboard in that frame (PageFrames.ownFocus). */
  own: boolean
  /** The last pointer position is in or on the edge of that frame's box (pointerNear). */
  pointerNear: boolean
  /** That position is no older than POINTER_FRESH_MS. */
  pointerFresh: boolean
  /** A shell keydown (or a focus within the shell) came after that position. */
  keyAfterPointer: boolean
  /** A shell keydown came within GIVE_BACK_MS, and its element is still where the person typed. */
  recentKey: boolean
}

/**
 * The decision (pure). `activeTab`: the tab whose frame holds the keyboard now (null: none does);
 * `activeId`: the view's focused pane, null while the keys are off (D3).
 *
 * - No frame holds the keyboard, or the focused pane's frame does: nothing to do (null).
 * - Keys off: the frame is blurred, whatever the evidence; nothing is picked and nothing gets the
 *   keyboard until the person picks a pane the shell sees (a header or pane press, which the blurred
 *   frame's pass-through lets reach the shell, a terminal click, a chord).
 * - With evidence: the person moved into that pane; the shell picks it (dispatches the selection,
 *   so the outline and `tabs.selected` follow).
 * - Without: the shell blurs the frame. The keyboard goes back only to the element of a shell key
 *   within GIVE_BACK_MS, and only with the pointer not near the frame (a person typing in Claude with
 *   the pointer resting over the file who then clicks into it gets no keys in Claude); else nowhere.
 */
export function framePick(activeTab: string | null, activeId: string | null, e: FrameEvidence): FramePick | null {
  if (activeTab === null) return null
  if (activeId === null) return { blur: true, giveBack: false }
  if (activeTab === activeId) return null
  if (e.own || (e.pointerNear && e.pointerFresh && !e.keyAfterPointer)) return { pick: activeTab }
  return { blur: true, giveBack: e.recentKey && !e.pointerNear }
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
 * The pointer half of the evidence: the last pointer position the shell saw and when, whether a shell
 * key (or a focus within the shell) came after it, and the last shell key's element and time (the
 * give-back). `T` is the element type (DOM-free here). The shell's own focus calls are the pool's
 * half (PageFrames.ownFocus).
 */
export class PointerEvidence<T = unknown> {
  private at: { x: number; y: number } | null = null
  private movedAt = Number.NEGATIVE_INFINITY
  private keyAfter = false
  private key: { target: T; at: number } | null = null

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** A `pointermove`, `pointerdown` or `pointerout` in the shell's document, in viewport pixels. */
  moved(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    this.at = { x, y }
    this.movedAt = this.now()
    this.keyAfter = false
  }

  /** A `keydown` in the shell's document, at `target` (the element that had the keyboard). */
  shellKey(target: T | null): void {
    this.keyAfter = true
    this.key = target === null ? null : { target, at: this.now() }
  }

  /**
   * The focus moved to `target`, an element of the shell: whatever holds the keyboard after this was
   * not put there by the pointer's last move, and a key typed before it into another element is not
   * where the person types now.
   */
  shellFocus(target: T): void {
    this.keyAfter = true
    if (this.key && this.key.target !== target) this.key = null
  }

  /** Whether the last pointer position is in or near `rect`, nearer to it than to `others` (pointerNear). */
  near(rect: ViewportRect | null, others: readonly ViewportRect[] = []): boolean {
    return pointerNear(this.at, rect, others)
  }

  /** Whether the last pointer position is no older than POINTER_FRESH_MS. */
  fresh(): boolean {
    return this.now() - this.movedAt <= POINTER_FRESH_MS
  }

  /** Whether a shell key (or shell focus) came after the last pointer position. */
  keyAfterPointer(): boolean {
    return this.keyAfter
  }

  /** The element of the last shell key, when it came within GIVE_BACK_MS; else null. */
  recentKeyTarget(): T | null {
    return this.key !== null && this.now() - this.key.at <= GIVE_BACK_MS ? this.key.target : null
  }
}
