// The guards of Ask Claude's question box over a page tab (PageTabDiscussDialog.tsx), DOM-free so unit
// tests run them in plain Node (the renderer has no component harness).
//
// The page decides when the box opens (`ccPanel.tab.discuss()`), and main cannot tell whether that
// followed a gesture. What the box sends goes to a Claude tab as the person's own text (typed tabs
// included, which main refuses a plugin's `sessions.send` for), so a send must be a deliberate act on a
// box the person has seen, as for core's approvals (approval-model.ts): a page that opens the box on
// the first Enter of a held Ctrl+Enter (VS Code's "insert line below") must not have the next Enter or
// its auto-repeat send `About: <title>` and the plugin's context unseen. So:
// - Send, its click and Ctrl/Cmd+Enter are armed only after the box has been visible (and the window
//   focused) for about a second (ApprovalArm), and a press begun before that does not count.
// - Ctrl/Cmd+Enter counts only as a fresh chord: never an auto-repeat, and only when the modifier was
//   pressed down after the box opened (one already held when it mounted is the page's chord going on).
// - A page that reopens the box as soon as it gets the keyboard back (on focus: a bug is enough) would
//   lock the window behind its backdrop, so a cancelled box does not reopen for its tab for a while.

/** What a key pressed in the question field does. */
export type DiscussKeyAction = 'send' | 'block' | 'pass'

export interface DiscussKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  repeat: boolean
}

/** Whether `key` is Ctrl/Cmd+Enter's modifier (Meta is Cmd on a Mac, the one `metaKey` reads). */
function isSendModifier(key: string): boolean {
  return key === 'Control' || key === 'Meta'
}

/**
 * The question field's keys. Tracks which send modifiers went down while the box was up: one held
 * from before it mounted shows no keydown here (its auto-repeats are `repeat`, which do not count).
 */
export class DiscussKeys {
  private readonly freshModifiers = new Set<string>()

  /**
   * A keydown in the box. 'send': a fresh Ctrl/Cmd+Enter while armed. 'block': a Ctrl/Cmd+Enter that
   * does not count (disarmed, a repeat, a modifier held from before), swallowed so it adds no line
   * either. 'pass': anything else (plain Enter is a newline in the question).
   */
  keyDown(e: DiscussKeyEvent, armed: boolean): DiscussKeyAction {
    if (isSendModifier(e.key)) {
      if (!e.repeat) this.freshModifiers.add(e.key)
      return 'pass'
    }
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return 'pass'
    if (!armed || e.repeat) return 'block'
    // The modifier this Enter carries must have gone down in the box: Control for ctrlKey, Meta for metaKey.
    const fresh = (e.ctrlKey && this.freshModifiers.has('Control')) || (e.metaKey && this.freshModifiers.has('Meta'))
    return fresh ? 'send' : 'block'
  }

  /** A keyup in the box: a released modifier is no longer down. */
  keyUp(key: string): void {
    if (isSendModifier(key)) this.freshModifiers.delete(key)
  }

  /** The window lost the keyboard: a modifier released elsewhere sends no keyup here. */
  reset(): void {
    this.freshModifiers.clear()
  }
}

/** How long a cancelled box does not reopen for the same tab. */
export const DISCUSS_REOPEN_COOLDOWN_MS = 2000

/**
 * The tabs whose box the person cancelled lately (Esc, Cancel, a click outside). Their page asking
 * again within the cooldown is ignored, so the person can get out (the tab bar, Ctrl+W) even from a
 * page that asks on every focus. One clock per tab: another tab's page still opens its box.
 */
export class DiscussCooldown {
  private readonly cancelledAt = new Map<string, number>()

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ms = DISCUSS_REOPEN_COOLDOWN_MS
  ) {}

  cancelled(tabId: string): void {
    this.cancelledAt.set(tabId, this.now())
  }

  allows(tabId: string): boolean {
    const at = this.cancelledAt.get(tabId)
    if (at === undefined) return true
    if (this.now() - at < this.ms) return false
    this.cancelledAt.delete(tabId)
    return true
  }
}

/** What TabsPane knows when a page asks for the box. */
export interface DiscussOpenState {
  /** A palette, overlay, the settings screen, the close dialog, the ccc offer or a box already up. */
  modalUp: boolean
  /** The Ctrl+Tab switcher is up. */
  switcherUp: boolean
  /** The tab this view shows now. */
  activeId: string | null | undefined
}

/**
 * Whether a page's ask opens the box: not over another modal or the switcher, only for the tab this
 * view shows now, and not during that tab's cooldown after a cancel.
 */
export function discussMayOpen(tabId: string, state: DiscussOpenState, cooldown: DiscussCooldown): boolean {
  if (state.modalUp || state.switcherUp || state.activeId !== tabId) return false
  return cooldown.allows(tabId)
}
