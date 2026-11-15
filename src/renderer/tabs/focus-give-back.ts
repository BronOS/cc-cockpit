// Giving the keyboard back to the focused pane once a shell popup goes (the palette, Show Tab
// Beside's picker, the tab switcher, the tab and split menus, the dialogs, the settings screen,
// an overlay): the one rule every such place goes through (TabsPane `giveBack`). DOM-free; TabsPane
// feeds it the window's `blur` and reads `document.activeElement` for it.
//
// Why a rule (the external review's CRITICAL, round 3): the palette closes when its field loses the
// focus, and the switcher when the window does. A page tab's frame can take the keyboard with a
// script's `focus()` (frame-focus.ts), which blurs the palette's field and the shell's window: both
// popups closed and queued "back to the focused pane". The frame check then blurred the frame for
// want of evidence (keys to nothing), and the queued give-back put the keys into the Claude pane
// right after: the person's next Enter or "y", meant for the palette, could answer a permission
// prompt. A page moved the keys into a terminal, which the fail-safe model forbids (CLAUDE.md).
//
// The rule:
// - Only a close the person made gives the keyboard back (`person`: Escape, a pick, Enter, a click on
//   the shell, a chord). A close that came by itself (`auto`: the palette's field blurred, the window
//   blurred under the switcher, a modal or an overlay pushed a popup away, a plugin's close question
//   settled in another view) leaves the keyboard where it went. That is where the blur put it (a
//   frame, then the check decides; another app; a shell element Tab moved to) or on nothing: never a
//   terminal. The switcher never takes the keyboard, so nothing needs giving back after it anyway.
// - Even a person's close gives back only if, when the frame fires, the keyboard has not left the
//   shell since it was queued (no window `blur` in between) and no frame holds it: a page's `focus()`
//   timed with the person's Escape took the keys after the close, so the give-back would move them
//   out of the page (or, once the check blurred it, out of nothing) into the terminal.
// Losing keys is safe, misdirecting them is not: the cost is a click on the pane after a blur closed
// a popup (the person Alt+Tabs away with the palette open and comes back to keys on nothing).

/** Who closed the popup: the person's own act, or something else (a blur, a modal, an overlay). */
export type CloseCause = 'person' | 'auto'

export interface GiveBackDeps {
  /** Run `fn` at the next frame (requestAnimationFrame; tests inject one). */
  later(fn: () => void): void
  /** Whether an iframe (a page tab's frame, a panel's page) holds the keyboard now. */
  keyboardInFrame(): boolean
}

export class FocusGiveBack {
  private blurs = 0

  constructor(private readonly deps: GiveBackDeps) {}

  /** The shell's window lost the keyboard (to a frame of its own or another app). */
  windowBlurred(): void {
    this.blurs++
  }

  /**
   * A popup closed: run `restore` (TabsPane's focusActive, which still decides what is modal) at the
   * next frame, for a person's close whose keyboard stayed in the shell (header). An `auto` close
   * restores nothing.
   */
  closed(cause: CloseCause, restore: () => void): void {
    if (cause !== 'person') return
    const at = this.blurs
    this.deps.later(() => {
      if (this.blurs !== at || this.deps.keyboardInFrame()) return
      restore()
    })
  }
}
