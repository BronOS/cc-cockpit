// The DOM-free half of the zone layout: the window's working copy of the layout and how it stays
// in step with main. Split from use-layout.ts (the React wrapper) so unit tests, which run in
// plain Node, can play out the races between local edits, `layout.set` answers and
// `layout.updated` events with a fake bridge.
import type { CockpitApi, LayoutView, PanelInfo, SlotFrameInfo } from '../../shared/ipc'
import { defaultLayout, type LayoutState } from '../../shared/layout'

/** The part of `window.cockpit` this needs; structural so tests can pass a fake. */
export type LayoutBridge = Pick<CockpitApi, 'invoke' | 'on'>

export interface LayoutSnapshot {
  layout: LayoutState
  panels: PanelInfo[]
  /** The app's own slot frames (`LayoutView.appSlots`: the top bar's `sessions-strip`); empty for none. */
  appSlots: SlotFrameInfo[]
}

const NO_SLOTS: SlotFrameInfo[] = []

/**
 * main owns the stored layout and the list of panels that exist; this keeps a working copy so a
 * drag or a click shows at once, and sends the result back with `layout.set` (main re-validates
 * it, and its debounced record write batches the rest).
 *
 * Two rules keep a local edit from being lost or from clobbering main's copy:
 *  - No edit before the first view. Until `layout.get` (or an event) has answered, the working
 *    copy is an empty default; a key pressed then would send that and main would store it over
 *    the user's real layout (placement, hidden list, sizes, remembered).
 *  - While a local edit is unanswered (a drag between pointermove and pointerup, or a `layout.set`
 *    in flight), a view from main updates the panels (badges, titles) but not the layout. A badge
 *    publish arriving mid-drag would otherwise put main's old layout back and the flush would send
 *    that, losing the drag; the answer to the edit's `layout.set` brings main's reconciled layout.
 */
export class LayoutSync {
  private snapshot: LayoutSnapshot = { layout: defaultLayout(), panels: [], appSlots: NO_SLOTS }
  private ready = false
  /** Bumped by every local edit. */
  private edits = 0
  /** The edit count main has answered for; `edits !== acked` means a local edit is unanswered. */
  private acked = 0
  private readonly listeners = new Set<() => void>()

  constructor(private readonly bridge: LayoutBridge) {}

  /**
   * Subscribe to `layout.updated` and ask for the current view; returns the unsubscribe. Not in
   * the constructor: React's StrictMode runs an effect, its cleanup and the effect again, so a
   * start / stop / start must leave exactly one subscription.
   */
  start(): () => void {
    let sawEvent = false
    // Subscribe before asking so an update between the two is not lost; the event is newer than
    // the answer, so the answer is dropped when one arrived first.
    const off = this.bridge.on('layout.updated', (view) => {
      sawEvent = true
      this.onView(view)
    })
    this.bridge
      .invoke('layout.get')
      .then((view) => {
        if (!sawEvent) this.onView(view)
      })
      .catch(() => {
        // Without a layout the window still works: the zones stay empty, the terminal fills it,
        // and edits stay off until an event brings a layout.
      })
    return off
  }

  get(): LayoutSnapshot {
    return this.snapshot
  }

  /** Be told when the snapshot changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Apply a pure layout operation and persist the result now (a click, a menu pick, a key). */
  commit(op: (layout: LayoutState) => LayoutState): void {
    if (this.apply(op)) this.flush()
  }

  /** Apply an operation locally only, for a drag in progress; `flush` persists where it ended. */
  preview(op: (layout: LayoutState) => LayoutState): void {
    this.apply(op)
  }

  /** Persist the current layout (end of a drag). */
  flush(): void {
    if (!this.ready) return
    const sent = this.edits
    this.bridge
      .invoke('layout.set', { layout: this.snapshot.layout })
      .then((view) => {
        // An answer to an older `layout.set` must not undo a newer edit.
        if (this.edits !== sent) return
        this.acked = sent
        this.take(view)
      })
      .catch(() => {
        // Not stored. The edit stays unanswered (views keep off the layout) so what the user sees
        // is not reverted; the next edit sends the whole layout again.
      })
  }

  private apply(op: (l: LayoutState) => LayoutState): boolean {
    if (!this.ready) return false
    const next = op(this.snapshot.layout)
    if (next === this.snapshot.layout) return false
    this.edits += 1
    this.set({ ...this.snapshot, layout: next })
    return true
  }

  /** A view main sent on its own (an event, or the `layout.get` answer). */
  private onView(view: LayoutView): void {
    // The app's slot frames are not the layout: like the panels, they follow main at once.
    if (this.ready && this.edits !== this.acked) this.set({ ...this.snapshot, panels: view.panels, appSlots: view.appSlots ?? NO_SLOTS })
    else this.take(view)
  }

  private take(view: LayoutView): void {
    this.ready = true
    this.set({ layout: view.layout, panels: view.panels, appSlots: view.appSlots ?? NO_SLOTS })
  }

  private set(next: LayoutSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
