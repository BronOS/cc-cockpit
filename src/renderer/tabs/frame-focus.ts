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
// `blur`, at a page's `cc-plugin.tab-focus` hint and before a chord or Ask Claude from a frame, and a
// frame holding the keyboard counts only with evidence of the person:
// - the shell's own focus call put it there (focusActive, a pane chord, a select, `wantFocus`), or a
//   check accepted it on the pointer evidence below, and the focus has not moved within the shell
//   since (PageFrames.ownFocus), or
// - the person's pointer went into it: the last pointer position the shell saw is inside or on the
//   edge of the frame's box, no more than POINTER_FRESH_MS ago, with no shell `keydown` (and no focus
//   moving within the shell) after it. Typing in the Claude pane while the pointer rests over the
//   file beside it is no evidence: the keys went to the shell after the pointer stopped.
// The focused pane's own frame needs it too (the external review's MAJOR): with a file pane focused
// and the person typing in a shell field (the palette, a search box), the page's `focus()` would
// otherwise take their keys, since the selection alone says nothing about where they type now.
//
// The hint is more than a reason to look, measured: frame to frame (two frames of one plugin) the
// shell's `activeElement` can stay on the frame the person left, so at a hint from another frame
// while one is on record the shell focuses the hinting frame first (PageFrames.resync) and the
// evidence then decides. A hint can therefore move the keyboard between frames (to the hinting frame
// with evidence, else to nothing); it never reaches a terminal: resync runs only while a frame holds
// the keyboard, and nothing the check does focuses anything but a frame's pane (`pick`).
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
// body), always: a person who just clicked into the editor must never be typing into the Claude pane,
// where a stray Enter, digit or "y" can answer a permission prompt (CLAUDE.md). Nothing a page does
// (its `focus()`, its hint, any message) may move the keyboard INTO a terminal; keys enter one only
// from the person's own act on it in the shell (a press on it, its strip tab, a pane chord). There is
// no give-back to the element the person typed in a moment ago, even for a pane that mounts and takes
// the keys mid-word beside Claude: every check without evidence is one a page could have triggered
// (its own `focus()` raises the window `blur`, its hint the rest), and an earlier give-back let a hint
// from a second file push the keys out of the first one into Claude. The keys typed after such a
// steal are lost; losing keys is safe, misdirecting them is not. And the blurred frame lets the
// pointer through to its pane until the shell sees the pointer move (`passThrough`, PageTabArea.tsx):
// the person's next press on it lands on the shell's pane and picks it, and their next move gives
// fresh pointer evidence, so a click the shell could not prove costs one more click, never a key in
// the wrong pane.

import type { FrameRect } from './page-frames'

/** A box in viewport pixels; the frame layer sits at the viewport's origin, so this is a FrameRect. */
export type ViewportRect = FrameRect

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

/** What the shell does about a frame holding the keyboard: pick its pane, or blur it (keyboard on nothing; see the header). */
export type FramePick = { pick: string } | { blur: true }

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
}

/**
 * The decision (pure). `activeTab`: the tab whose frame holds the keyboard now (null: none does);
 * `activeId`: the view's focused pane, null while the keys are off (D3).
 *
 * - No frame holds the keyboard: nothing to do (null).
 * - Keys off: the frame is blurred, whatever the evidence; nothing is picked and nothing gets the
 *   keyboard until the person picks a pane the shell sees (a header or pane press, which the blurred
 *   frame's pass-through lets reach the shell, a terminal click, a chord).
 * - With evidence: the person moved into that pane; the shell picks it (dispatches the selection,
 *   so the outline and `tabs.selected` follow), or keeps it (null) when it is the focused pane.
 * - Without: the shell blurs the frame and the keyboard goes to nothing (the header's fail-safe),
 *   the focused pane's own frame included (the header: a shell field may have had the keys).
 */
export function framePick(activeTab: string | null, activeId: string | null, e: FrameEvidence): FramePick | null {
  if (activeTab === null) return null
  if (activeId === null) return { blur: true }
  if (!(e.own || (e.pointerNear && e.pointerFresh && !e.keyAfterPointer))) return { blur: true }
  return activeTab === activeId ? null : { pick: activeTab }
}

/**
 * What the shell's check found (PageTabArea.tsx checkFrameFocus): no page frame holds the keyboard
 * (`none`: a terminal, the shell, a webview panel's page outside the document), the visible frame of
 * `tab` holds it and keeps it (its pane is the focused one now, picked if it was not), or one held it
 * with no evidence and was blurred.
 */
export type FrameCheck = 'none' | 'blurred' | { tab: string }

/** Where main saw a chord it sent as `commands.trigger`: a page tab's frame, or a webview panel's view. */
export type ChordSource = 'page-tab' | 'webview'

/**
 * Whom a chord main sent (`commands.trigger`, which names no tab) runs for, after the check: the
 * frame's tab when a frame has the keys (design-split-pages.md §4 "Chords from a frame name their
 * tab"), and nobody (null, dropped) when the frame held them with no evidence: the person typed it
 * where the shell says no keys belong, and the pane the outline shows is not where they typed it
 * (Cmd+W there would close the file they did not click into). With no frame holding the keys, only a
 * webview panel's chord runs for the view's active tab (`{}`); one main saw in a page tab's frame is
 * dropped: that frame lost the keyboard before the chord got here (the external review's CRITICAL:
 * the window `blur`'s check blurred it in between, so Cmd+W typed into a file the shell had just
 * refused would have closed the Claude tab the outline shows). The source is unknown in the shell
 * otherwise, so anything but `webview` counts as a frame's.
 */
export function chordTarget(at: FrameCheck, from: ChordSource): { tabId?: string } | null {
  if (at === 'blurred') return null
  if (at === 'none') return from === 'webview' ? {} : null
  return { tabId: at.tab }
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
 * The pointer half of the evidence: the last pointer position the shell saw and when, and whether a
 * shell key (or a focus within the shell) came after it. It keeps no element to give the keyboard
 * back to (the header: there is no give-back). The shell's own focus calls are the pool's half
 * (PageFrames.ownFocus).
 */
export class PointerEvidence {
  private at: { x: number; y: number } | null = null
  private movedAt = Number.NEGATIVE_INFINITY
  private keyAfter = false

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** A `pointermove`, `pointerdown` or `pointerout` in the shell's document, in viewport pixels. */
  moved(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    this.at = { x, y }
    this.movedAt = this.now()
    this.keyAfter = false
  }

  /**
   * A `keydown` in the shell's document, or the focus moving to an element of the shell: whatever
   * holds the keyboard after this was not put there by the pointer's last move.
   */
  shellInput(): void {
    this.keyAfter = true
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
}

/** What the shell's evidence listeners report to besides the pointer (PageTabArea.tsx: the pool and the check). */
export interface EvidenceSinks {
  /** Run the check (checkFrames) for the frame holding the keyboard, if any. */
  check(): void
  /** The shell sees the pointer again: a frame letting it through takes it back (PageFrames.endPassThrough). */
  endPassThrough(): void
  /** The focus moved within the shell (PageFrames.shellFocused). */
  shellFocused(): void
  /** Whether a `focusin` target is a page tab frame (the shell's iframe), or none: not a focus within the shell. */
  isFrame(target: EventTarget | null): boolean
  /** Run `fn` a task later (default setTimeout 0; tests inject one). */
  later?(fn: () => void): void
}

/**
 * The shell's listeners for the focus evidence, once for the page (PageTabArea.tsx, with the pool):
 * `win` is the shell's window, `doc` its document. The iframe element gets no `focus` or `focusin`
 * when the keyboard goes into it (Electron 45, the review's spike), so a `focusin` on anything else is
 * the focus moving within the shell. A press or a key inside a frame never reaches this document.
 */
export function watchShellEvidence(win: EventTarget, doc: EventTarget, pointer: PointerEvidence, sinks: EvidenceSinks): void {
  const later = sinks.later ?? ((fn: () => void) => void setTimeout(fn, 0))
  // A task later, not in the `blur` itself: the browser is still moving the keyboard into the frame
  // then, and a blur and refocus made during that event are undone by it (the e2e's frame kept the
  // keyboard, its document still focused, with the shell's textarea focused too). Keys typed in that
  // task's gap (or, for a page's hint, in the cross-process message's) land in the frame and stay
  // there: a mount-time steal while the person types can put a character into the page (an editor's
  // buffer, then its autosave). The gap is a few ms; nothing typed before the blur is replayed.
  win.addEventListener('blur', () => later(() => sinks.check()))
  const moved = (e: Event): void => {
    const { clientX, clientY } = e as PointerEvent
    pointer.moved(clientX, clientY)
    // The shell sees the pointer again: a frame blurred for want of evidence takes it back (the
    // position just recorded is the evidence for its next click).
    sinks.endPassThrough()
  }
  win.addEventListener('pointermove', moved, true)
  win.addEventListener('pointerdown', moved, true)
  win.addEventListener('pointerout', moved, true)
  win.addEventListener('wheel', moved, { capture: true, passive: true })
  win.addEventListener('keydown', () => pointer.shellInput(), true)
  doc.addEventListener(
    'focusin',
    (e) => {
      if (sinks.isFrame(e.target)) return
      pointer.shellInput()
      sinks.shellFocused()
    },
    true
  )
}

/** What the check needs of the frame pool (PageFrames; a fake in the unit tests). */
export interface FrameCheckPool {
  keyboardTab(): string | null
  resync(tabId: string): void
  isVisible(tabId: string): boolean
  frameRects(): ReadonlyMap<string, ViewportRect>
  ownFocus(tabId: string): boolean
  proven(tabId: string): void
  blurFrame(tabId: string): void
  passThrough(tabId: string): void
}

/**
 * What the check needs from TabsPane, which owns the selection: the focused pane (null while the keys
 * are off, D3) and picking a pane as the person's own act. Nothing here focuses anything else (header).
 */
export interface FrameFocusHandler {
  activeId(): string | null
  pick(tabId: string): void
}

/**
 * Whether the frame holding the keyboard now may keep it (design-split-pages.md §4): run at the
 * window's `blur`, at a page's `cc-plugin.tab-focus` hint (`hinted`: its frame's tab) and before a
 * chord or Ask Claude from a frame (PageTabArea.tsx checkFrameFocus), whose target it names. With
 * the person's evidence the pane is picked; without, the frame is blurred and lets the pointer
 * through to its pane until the pointer moves (so the next press on it is one the shell sees). A frame
 * kept or picked is `proven`: it counts as the shell's own focus until the focus moves within the
 * shell, so a chord typed in it minutes later (the pointer evidence long stale) still names it. Its
 * effects are only `resync`, `blurFrame`, `passThrough`, `proven` and `pick`: never a terminal (header).
 */
export function checkFrames(pool: FrameCheckPool, handler: FrameFocusHandler, pointer: PointerEvidence, hinted?: string): FrameCheck {
  // Frame to frame, the shell's `activeElement` can stay on the frame the person left (measured:
  // two frames of one plugin); a hint from another frame while one holds the keyboard puts it right
  // first (resync is a no-op unless a frame holds it), and the evidence below decides as for any frame.
  if (hinted !== undefined && pool.keyboardTab() !== hinted) pool.resync(hinted)
  const tab = pool.keyboardTab()
  if (tab === null) return 'none'
  // Only a visible pane's frame names a target (a hidden one has no box and cannot hold the
  // keyboard; were one to, nothing the person sees is there).
  if (!pool.isVisible(tab)) {
    pool.blurFrame(tab)
    return 'blurred'
  }
  const rects = pool.frameRects()
  const others = [...rects].filter(([id]) => id !== tab).map(([, rect]) => rect)
  const decision = framePick(tab, handler.activeId(), {
    own: pool.ownFocus(tab),
    pointerNear: pointer.near(rects.get(tab) ?? null, others),
    pointerFresh: pointer.fresh(),
    keyAfterPointer: pointer.keyAfterPointer()
  })
  if (decision === null || 'pick' in decision) {
    if (decision !== null) handler.pick(decision.pick)
    pool.proven(tab)
    return { tab }
  }
  pool.blurFrame(tab)
  pool.passThrough(tab)
  return 'blurred'
}
