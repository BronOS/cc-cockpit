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
// the wrong pane. Nor a chord on the wrong pane: the refusal also puts the view keys off (no outline,
// and no command acts on the active tab, D23 R1), since the person who clicked into the file and
// typed Cmd+W believes they are in it, and the outline and `activeId` were still on the pane beside it
// (the final review's MAJOR: Cmd+W ended the Claude session there). Unlike D3's keys off, the person's
// next click into a frame with evidence is picked (`framePick`'s `refused`), so that click still works.

declare const viewportSpace: unique symbol

/**
 * A box in viewport pixels: an element's `getBoundingClientRect()`, the space of a pointer event's
 * `clientX`/`clientY`. Not a FrameRect (page-frames.ts): that is relative to the frame layer, which
 * PageTabArea places at the page area's left and top (below the tab strip, beside the side panels),
 * so a layer box fed to the pointer check would put the evidence region that far up and to the left
 * of the frame. The brand keeps the two apart for the compiler: only `viewportRect` makes one.
 */
export interface ViewportRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
  readonly [viewportSpace]: true
}

/** A box measured in viewport pixels (a `getBoundingClientRect()`, or a test's stand-in for one). */
export function viewportRect(r: { left: number; top: number; width: number; height: number }): ViewportRect {
  return { left: r.left, top: r.top, width: r.width, height: r.height } as ViewportRect
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
 * `activeId`: the view's focused pane, null while the keys are off (D3); `refused`: the keys are off
 * because an earlier check refused a frame (TabsState.focusRefused), `activeId` then still named.
 *
 * - No frame holds the keyboard: nothing to do (null).
 * - Keys off (D3): the frame is blurred, whatever the evidence; nothing is picked and nothing gets the
 *   keyboard until the person picks a pane the shell sees (a header or pane press, which the blurred
 *   frame's pass-through lets reach the shell, a terminal click, a chord).
 * - With evidence: the person moved into that pane; the shell picks it (dispatches the selection,
 *   so the outline and `tabs.selected` follow), or keeps it (null) when it is the focused pane. After
 *   a refusal it is always picked, the focused pane's own frame too: the pick is what turns the keys
 *   back on (a refused click into the file, then the person's next one, with evidence, works).
 * - Without: the shell blurs the frame and the keyboard goes to nothing (the header's fail-safe),
 *   the focused pane's own frame included (the header: a shell field may have had the keys), and the
 *   view goes keys off (`refuse`, checkFrames) so no command acts on the pane the outline was on.
 */
export function framePick(activeTab: string | null, activeId: string | null, e: FrameEvidence, refused = false): FramePick | null {
  if (activeTab === null) return null
  if (activeId === null) return { blur: true }
  if (!(e.own || (e.pointerNear && e.pointerFresh && !e.keyAfterPointer))) return { blur: true }
  return activeTab === activeId && !refused ? null : { pick: activeTab }
}

/**
 * What the shell's check found (PageTabArea.tsx checkFrameFocus): no page frame holds the keyboard
 * (`none`: a terminal, the shell, a webview panel's page outside the document), the visible frame of
 * `tab` holds it and keeps it (its pane is the focused one now, picked if it was not), or one held it
 * with no evidence and was blurred.
 */
export type FrameCheck = 'none' | 'blurred' | { tab: string }

/**
 * Where main saw a chord it sent as `commands.trigger`: a page tab's frame, named by the tab main
 * recorded for it (page-tab-keys.ts PageTabFrameTabs; undefined when the message carried none), or a
 * webview panel's view.
 */
export type ChordSource = { from: 'page-tab'; tab: string | undefined } | { from: 'webview' }

/**
 * Whom a chord main sent (`commands.trigger`) runs for, after the check (design-split-pages.md §4
 * "Chords from a frame name their tab"), and nobody (null, dropped) when the frame held the keys with
 * no evidence: the person typed it where the shell says no keys belong, and the pane the outline shows
 * is not where they typed it (Cmd+W there would close the file they did not click into).
 * - A page tab's chord runs only for the tab main saw it typed in, and only while that tab's frame
 *   still holds the keyboard. Anything else is dropped: no frame holds it any more (the window
 *   `blur`'s check refused the frame in between: run for the active tab, Cmd+W typed into a file
 *   would close the Claude tab the outline shows), or another frame does (the external review's
 *   CRITICAL, round 2: Cmd+W typed in page A while page B took the keyboard before the chord got
 *   here would close B).
 * - A webview panel's chord runs for the frame's tab when one holds the keyboard in the shell's
 *   document (webviewChord focused the shell first, whose last focused element may be a frame), and
 *   for the view's active tab (`{}`) when none does.
 */
export function chordTarget(at: FrameCheck, source: ChordSource): { tabId?: string } | null {
  if (at === 'blurred') return null
  if (source.from === 'page-tab') return at !== 'none' && source.tab !== undefined && at.tab === source.tab ? { tabId: at.tab } : null
  return at === 'none' ? {} : { tabId: at.tab }
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

  /** A `pointermove`, `pointerdown`, `wheel` or a `pointerout` out of the shell's document, in viewport pixels. */
  moved(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    this.at = { x, y }
    this.movedAt = this.now()
    this.keyAfter = false
  }

  /** Whether `(x, y)` is the last position recorded: an event there is no move of the pointer. */
  isAt(x: number, y: number): boolean {
    return this.at !== null && this.at.x === x && this.at.y === y
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
  // A `pointerout` counts only as the pointer leaving the shell's document (`relatedTarget` null: out of
  // the window, onto a webview panel's native view), and not at the position already recorded. Chromium
  // sends boundary events when the element under a resting pointer changes (the shell scrolled or laid
  // out again under it), with the new element as `relatedTarget`; a real move from one shell element to
  // another always brings its `pointermove` at the same spot (measured, Electron 45), so such a
  // `pointerout` adds nothing and is skipped. Counted, one revived stale evidence after the person's
  // keys: in the e2e on macOS, focusing a shell field scrolled the document 21 px, the pane header under
  // the resting pointer gave way to the frame's pane, and a page's `focus()` then kept the keyboard while
  // they typed in that field. Measured too: with the pointer resting inside a cross-site frame, a
  // re-layout's boundary events carry the last position the shell saw, not the pointer's, so the
  // position check alone already held there; the `relatedTarget` rule does not rest on that. A press or
  // a wheel in place is the person's act and counts.
  win.addEventListener('pointermove', moved, true)
  win.addEventListener('pointerdown', moved, true)
  win.addEventListener(
    'pointerout',
    (e) => {
      const { clientX, clientY, relatedTarget } = e as PointerEvent
      if (relatedTarget) return
      if (!pointer.isAt(clientX, clientY)) moved(e)
    },
    true
  )
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
 * are off by D3), whether the keys are off by an earlier refusal (then `activeId` still names the
 * pane), picking a pane as the person's own act, and putting the view keys off when a frame is
 * refused. Nothing here focuses anything else (header).
 */
export interface FrameFocusHandler {
  activeId(): string | null
  /** The keys are off because a check refused a frame (TabsState.focusRefused). */
  refused(): boolean
  pick(tabId: string): void
  /**
   * A frame was blurred for want of evidence and the keyboard is on nothing: the view goes keys off
   * (the final review's MAJOR), so Cmd+W, the flag and the pane chords typed next, in the belief the
   * click went into the file, act on nothing rather than on the pane the outline was on (often the
   * Claude pane beside it: Cmd+W would end the session). Keys off moves no keys anywhere.
   */
  refuse(): void
}

/**
 * Whether the frame holding the keyboard now may keep it (design-split-pages.md §4): run at the
 * window's `blur`, at a page's `cc-plugin.tab-focus` hint (`hinted`: its frame's tab) and before a
 * chord or Ask Claude from a frame (PageTabArea.tsx checkFrameFocus), whose target it names. With
 * the person's evidence the pane is picked; without, the frame is blurred and lets the pointer
 * through to its pane until the pointer moves (so the next press on it is one the shell sees). A frame
 * kept or picked is `proven`: it counts as the shell's own focus until the focus moves within the
 * shell, so a chord typed in it minutes later (the pointer evidence long stale) still names it. A frame
 * blurred puts the view keys off (`refuse`). Its effects are only `resync`, `blurFrame`, `passThrough`,
 * `proven`, `pick` and `refuse`: never a terminal (header).
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
    handler.refuse()
    return 'blurred'
  }
  const rects = pool.frameRects()
  const others = [...rects].filter(([id]) => id !== tab).map(([, rect]) => rect)
  const decision = framePick(
    tab,
    handler.activeId(),
    {
      own: pool.ownFocus(tab),
      pointerNear: pointer.near(rects.get(tab) ?? null, others),
      pointerFresh: pointer.fresh(),
      keyAfterPointer: pointer.keyAfterPointer()
    },
    handler.refused()
  )
  if (decision === null || 'pick' in decision) {
    if (decision !== null) handler.pick(decision.pick)
    pool.proven(tab)
    return { tab }
  }
  pool.blurFrame(tab)
  pool.passThrough(tab)
  handler.refuse()
  return 'blurred'
}
