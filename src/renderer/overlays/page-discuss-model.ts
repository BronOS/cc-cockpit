// The guards of a page-started Discuss (shared/design.md §4, spec-review S6), DOM-free so unit tests run them in
// plain Node (the renderer has no component harness).
//
// A perView overlay's page may ask core to open its Discuss popover (`ccPanel.overlay.discuss()`, the envelope's
// `discuss.open` on the copy's own port). The page, not the person, opens it, and what Send delivers goes to a Claude tab
// as core's Discuss (`overlays.discuss`, typed tabs included). So, as for a page tab's Ask Claude
// (page-tab-discuss-model.ts) and core's approvals (approval-model.ts), a send must be a deliberate act on a popover the
// person has seen:
// - only the top overlay's page opens it, only where the toolbar shows Discuss (`info.discuss` set, a view that may
//   write: never a read guest), and a request while it is open does nothing (it never re-arms Send);
// - Send is armed after about a second of the popover visible in a focused window (ApprovalArm), and a press begun
//   before that does not count (allowClickCounts);
// - the popover takes no focus (the page keeps the keyboard, so a key meant for the page never lands in it), and Enter
//   and Space inside are blocked, so no key sends;
// - opens are rate-limited: none for 2 s after the person cancelled one (DiscussCooldown), at most 5 a minute.
// Esc while it is open goes to the page's frame and so to main, which closes the window (accepted, spec-review S6).

import { allowClickCounts, ApprovalArm, type ArmTimers } from '../notices/approval-model'
import { DiscussCooldown } from '../tabs/page-tab-discuss-model'

/** Opens of one overlay's page-started popover in a minute. */
export const PAGE_DISCUSS_OPENS_PER_MINUTE = 5
const MINUTE_MS = 60_000

/** What a page's Discuss request does. `open` opens the popover; `already-open` does nothing (it counts as done). */
export type PageDiscussVerdict = 'open' | 'already-open' | 'not-top' | 'no-discuss' | 'not-write' | 'cooldown' | 'rate'

/** What OverlayStack knows when the request comes. */
export interface PageDiscussState {
  /** The asking overlay is this view's top overlay (its page is the frame on top). */
  top: boolean
  /** Its toolbar has Discuss (`OverlayInfo.discuss` set). */
  discuss: boolean
  /** This view may write (`shellAllows(access).write`: the owner, a write guest). */
  write: boolean
  /** Its Discuss popover is open now (either kind). */
  open: boolean
}

/** The text a refused request answers the page with. */
export function pageDiscussRefusal(verdict: Exclude<PageDiscussVerdict, 'open' | 'already-open'>): string {
  switch (verdict) {
    case 'not-top':
      return 'Discuss opens only from the window on top'
    case 'no-discuss':
      return 'Discuss is not available on this window'
    case 'not-write':
      return 'Discuss is not available in this view'
    case 'cooldown':
      return 'Discuss was just cancelled; try again in a moment'
    case 'rate':
      return 'Discuss was opened too often; try again in a minute'
  }
}

/**
 * Which page requests open the popover, per overlay: the state checks first (so a refused one never counts), then the
 * cooldown after a cancel, then the rate. One gate per view (OverlayStack).
 */
export class PageDiscussGate {
  private readonly opens = new Map<string, number[]>()
  private readonly cooldown: DiscussCooldown

  constructor(private readonly now: () => number = () => Date.now(), cooldown?: DiscussCooldown) {
    this.cooldown = cooldown ?? new DiscussCooldown(now)
  }

  request(overlayId: string, state: PageDiscussState): PageDiscussVerdict {
    if (!state.top) return 'not-top'
    if (!state.discuss) return 'no-discuss'
    if (!state.write) return 'not-write'
    if (state.open) return 'already-open'
    if (!this.cooldown.allows(overlayId)) return 'cooldown'
    const at = this.now()
    const recent = (this.opens.get(overlayId) ?? []).filter((t) => at - t < MINUTE_MS)
    if (recent.length >= PAGE_DISCUSS_OPENS_PER_MINUTE) {
      this.opens.set(overlayId, recent)
      return 'rate'
    }
    recent.push(at)
    this.opens.set(overlayId, recent)
    return 'open'
  }

  /** The person closed a page-opened popover without sending (Cancel, a click outside, Esc in the shell). */
  cancelled(overlayId: string): void {
    this.cooldown.cancelled(overlayId)
  }

  /** The overlay is gone: its counts with it. */
  forget(overlayId: string): void {
    this.opens.delete(overlayId)
  }
}

/** Which kind of popover: the ▾'s own (the person opened it) or one the page asked for. */
export type DiscussPopoverMode = 'menu' | 'page'

/** Whether the popover moves the focus into itself when it opens: the ▾'s does (keys), the page's never. */
export function popoverTakesFocus(mode: DiscussPopoverMode): boolean {
  return mode === 'menu'
}

/** A key pressed inside a page-opened popover: Enter and Space (which would press a focused button) do nothing. */
export function pagePopoverKey(key: string): 'block' | 'pass' {
  return key === 'Enter' || key === ' ' || key === 'Spacebar' ? 'block' : 'pass'
}

/**
 * Send's arming in a page-opened popover: ApprovalArm (about a second of the popover visible in a focused window)
 * plus the press rule (a press begun while disarmed does not count, even if the release lands armed). Made once per
 * open: a repeated request never reaches it (the gate says `already-open`), so it never starts the second over.
 */
export class PagePopoverArm {
  private readonly arm: ApprovalArm
  private pressArmed: boolean | undefined

  constructor(onChange: (armed: boolean) => void, timers?: ArmTimers) {
    this.arm = timers ? new ApprovalArm(onChange, timers) : new ApprovalArm(onChange)
  }

  get armed(): boolean {
    return this.arm.armed
  }

  /** The popover is seen (the page visible, the window focused) or not. */
  visible(seen: boolean): void {
    this.arm.visible(seen)
  }

  /** A pointer went down inside the popover. */
  pressBegan(): void {
    this.pressArmed = this.arm.armed
  }

  /** A click on Send: whether it sends. */
  click(): boolean {
    const counts = allowClickCounts(this.arm.armed, this.pressArmed)
    this.pressArmed = undefined
    return counts
  }

  dispose(): void {
    this.arm.dispose()
  }
}
