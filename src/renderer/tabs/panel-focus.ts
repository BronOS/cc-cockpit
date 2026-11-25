// The Terminal panel's focus asks (design-terminal-panel.md §6), DOM-free so unit tests run it. TabsPane
// asks (the toggle, New Terminal, a pick in the strip, the person's own close, main's exit focus) and the
// panel's body takes the ask once its selection is the target. An ask is consumed here, by its taker,
// never by a ref in the body: the body unmounts whenever the panel is hidden, collapsed or moved, and a
// remounted body with a fresh ref replayed the last ask (the review's S4), focusing a terminal the
// person had left long before. Hiding the panel drops a pending ask for the same reason.

/** What the body focuses: a panel tab's terminal, or the Shell button of an empty panel. */
export type PanelFocusTarget = { tabId: string } | { shell: true }

export class PanelFocusAsks {
  /** `tabId` null: whichever tab the panel shows (its Shell button when it has none). */
  private pending: { tabId: string | null } | null = null

  ask(tabId: string | null): void {
    this.pending = { tabId }
  }

  /** The panel went off screen: an ask made before it is nobody's any more. */
  drop(): void {
    this.pending = null
  }

  /**
   * What to focus now, given the panel's selection and its tabs, and the ask consumed; undefined when
   * there is no ask or it waits (a named tab that is not the selection yet, a panel still filling).
   * An ask for a tab the panel no longer holds is dropped.
   */
  take(activeId: string | null, ids: readonly string[]): PanelFocusTarget | undefined {
    const ask = this.pending
    if (ask === null) return undefined
    if (ask.tabId !== null && !ids.includes(ask.tabId)) {
      this.pending = null
      return undefined
    }
    const target = ask.tabId ?? activeId
    if (target === null) {
      if (ids.length > 0) return undefined
      this.pending = null
      return { shell: true }
    }
    if (target !== activeId) return undefined
    this.pending = null
    return { tabId: target }
  }
}
