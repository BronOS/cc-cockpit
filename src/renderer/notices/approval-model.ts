// The guards of ApprovalDialog.tsx (design-web.md §9.6), DOM-free so unit tests run them in plain
// Node (the renderer has no component harness).
//
// An in-page approval must not be given by anything but a deliberate click on Allow: neither keys
// typed for Claude nor a click already on its way when the ask appears. So Allow is never the
// default and never focused, no key answers Allow, and Allow is armed only after the dialog has been
// visible for about a second. "Visible" is the page's own visibility: a browser tab in the
// background shows nothing, so the second starts over when the person comes back to it.

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
