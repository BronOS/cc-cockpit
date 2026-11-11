// The guards of ApprovalDialog.tsx (design-web.md §9.6), DOM-free so unit tests run them in plain
// Node (the renderer has no component harness).
//
// An in-page approval must not be given by anything but a deliberate click on Allow: neither keys
// typed for Claude nor a click already on its way when the ask appears. So Allow is never the
// default and never focused, no key answers Allow, and Allow is armed only after the dialog has been
// visible and focused for about a second. "Visible" is the page's own visibility plus window focus: a browser tab in the
// background shows nothing, so the second starts over when the person comes back to it. And the dialog must be the top
// one (ApprovalStack): one covered by another dialog is not seen either.

/** How long the dialog must have been visible before Allow takes a click. */
export const APPROVAL_ARM_MS = 1000

export interface ArmTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/**
 * Allow's arming: `visible(true)` starts the second, `visible(false)` disarms and stops it, and
 * `onChange` hears every change of `armed`. Starts disarmed; the owner calls `visible` with the
 * page's state at once.
 */
export class ApprovalArm {
  private timer: unknown
  private armedNow = false
  private disposed = false
  private lastVisible: boolean | undefined

  constructor(
    private readonly onChange: (armed: boolean) => void,
    private readonly timers: ArmTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as never) },
    private readonly delayMs = APPROVAL_ARM_MS
  ) {}

  get armed(): boolean {
    return this.armedNow
  }

  visible(on: boolean): void {
    if (this.disposed) return
    // The same state again changes nothing. A window `focus` event also fires when the focus moves
    // from a plugin's frame inside the page to the page itself (the press on Allow after a right
    // click in the Files panel): the window had the focus all along, and restarting the second there
    // would disable Allow under the very press that was meant for it (plan Task 16).
    if (on === this.lastVisible) return
    this.lastVisible = on
    this.stop()
    if (!on) {
      this.set(false)
      return
    }
    // Shown again after a hidden spell: the second starts over (a click on its way to the page
    // the person just came back to must not land on an armed Allow).
    this.set(false)
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined
      this.set(true)
    }, this.delayMs)
  }

  /**
   * Armed at once, with no second: a desktop confirm on its first show (enterArmedAtOnce),
   * which keeps the native dialog's behaviour there. A later `visible(false)` disarms it as any other.
   */
  armNow(): void {
    if (this.disposed) return
    this.lastVisible = true
    this.stop()
    this.set(true)
  }

  dispose(): void {
    this.stop()
    this.disposed = true
  }

  private stop(): void {
    if (this.timer === undefined) return
    this.timers.clearTimeout(this.timer)
    this.timer = undefined
  }

  private set(armed: boolean): void {
    if (armed === this.armedNow) return
    this.armedNow = armed
    this.onChange(armed)
  }
}

/**
 * The approvals open in this page, newest on top (ApprovalDialog portals each into `document.body` as
 * it mounts, so the newest is drawn over the others). Only the top one counts as seen: a link ask and
 * a trash ask can be up at once, and one covered by another must not arm behind it, or taking the
 * upper one down would bare an Allow that is already armed. `enter` tells the new dialog it is on top
 * and the one under it that it no longer is; its returned `leave` tells the one below it is on top
 * again, which starts that dialog's second over (ApprovalArm.visible).
 */
export class ApprovalStack {
  private readonly entries: Array<{ onTop(top: boolean): void }> = []

  enter(onTop: (top: boolean) => void): () => void {
    const entry = { onTop }
    const below = this.entries.at(-1)
    this.entries.push(entry)
    below?.onTop(false)
    onTop(true)
    let left = false
    return () => {
      if (left) return
      left = true
      const at = this.entries.indexOf(entry)
      if (at < 0) return
      const wasTop = at === this.entries.length - 1
      this.entries.splice(at, 1)
      if (wasTop) this.entries.at(-1)?.onTop(true)
    }
  }

  /** How many are open (tests). */
  get size(): number {
    return this.entries.length
  }
}

/**
 * The page's one stack: every approval that can be up at once enters it, ApprovalDialog, the
 * desktop's own link confirm (LinkDialog, ShellNotices.tsx) and the web access risk confirm
 * (RiskConfirmDialog.tsx) alike. A dialog outside it would cover one inside without the covered one
 * knowing (external review round 2: a desktop link confirm over a trash ask let Move to Trash arm
 * underneath, enabled the moment the link confirm went).
 */
export const approvalStack = new ApprovalStack()

/**
 * The place in the stack of a desktop confirm that stands in for a native dialog (the link confirm,
 * the risk confirm: the safe button focused, the page behind inert): its accept is ready at once when
 * it first shows, but covered by another approval it disarms, and bared again it needs a fresh
 * second as any other, so a double click meant for the upper dialog cannot land on it. Returns the
 * stack's `leave`.
 */
export function enterArmedAtOnce(stack: ApprovalStack, arm: ApprovalArm): () => void {
  let first = true
  return stack.enter((top) => {
    if (first) {
      // `enter` tells a new dialog it is on top before returning: its first show.
      first = false
      arm.armNow()
      return
    }
    arm.visible(top)
  })
}

/**
 * Whether a click on Allow counts: Allow is armed now, and the press that ends in this click began
 * on an armed Allow (`pressArmed`; undefined when no press was seen, as for an assistive technology's
 * click). A press begun before arming, released after, is not the person answering this dialog.
 */
export function allowClickCounts(armed: boolean, pressArmed: boolean | undefined): boolean {
  return armed && pressArmed !== false
}

/**
 * What a key pressed inside the dialog does. Escape is Deny (the native dialog's Cancel); Enter and
 * Space, which would press the focused button, do nothing, so no key ever answers Allow; Tab moves
 * between the buttons. Keys typed elsewhere (a terminal) never reach the dialog: it takes no focus.
 */
export function approvalKey(key: string): 'deny' | 'block' | 'pass' {
  if (key === 'Escape') return 'deny'
  if (key === 'Enter' || key === ' ' || key === 'Spacebar') return 'block'
  return 'pass'
}
