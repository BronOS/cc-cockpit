// Keeps the Terminal panel's selected tab in view in its strip (QA Q1, QR-N1). A narrow zone (a side
// zone) holds fewer tabs than there are, so the strip scrolls; the selected tab is brought into view
// when it is selected and again whenever the strip's width changes. Narrowing a side zone by its
// divider used to leave only the selected tab's icon showing, since nothing scrolled after a resize.

/** The parts of a strip element this needs (a fake in unit tests). */
export interface StripList {
  querySelectorAll(selector: string): ArrayLike<{ dataset: DOMStringMap; scrollIntoView(arg?: ScrollIntoViewOptions): void }>
}

type ObserverCtor = new (cb: (entries: { contentRect: { width: number } }[]) => void) => {
  observe(target: never): void
  disconnect(): void
}

/** Scrolls the strip so the tab `activeId` is visible (the nearest edge, the page never jumps). */
export function scrollSelectedIntoView(list: StripList, activeId: string): void {
  const el = Array.from(list.querySelectorAll('[data-panel-tab-id]')).find((t) => t.dataset.panelTabId === activeId)
  el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

/**
 * Brings the selected tab into view now, then on every change of the strip's width (a divider drag,
 * a window resize, the zone revealed). A height change alone does not scroll, so a person who
 * scrolled the strip by hand keeps their place until the width moves. Returns the cleanup.
 */
export function keepSelectedInView(
  list: StripList,
  activeId: string,
  Observer: ObserverCtor = ResizeObserver as unknown as ObserverCtor,
): () => void {
  scrollSelectedIntoView(list, activeId)
  let width: number | null = null
  const obs = new Observer((entries) => {
    const w = entries[entries.length - 1]?.contentRect.width
    if (w === undefined || w === width) return
    const first = width === null
    width = w
    // The first report is the observe itself, and the scroll above already ran for it.
    if (!first) scrollSelectedIntoView(list, activeId)
  })
  obs.observe(list as never)
  return () => obs.disconnect()
}
