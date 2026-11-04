import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { PanelInfo, SlotFrameInfo } from '../../shared/ipc'
import type { LayoutState } from '../../shared/layout'
import { LayoutSync } from './layout-sync'

export interface LayoutController {
  layout: LayoutState
  panels: PanelInfo[]
  /** The app's own slot frames (the top bar's); empty for none. */
  appSlots: SlotFrameInfo[]
  /** Apply a pure layout operation and persist the result now (a click, a menu pick, a key). */
  commit(op: (layout: LayoutState) => LayoutState): void
  /** Apply an operation locally only, for a drag in progress; `flush` persists where it ended. */
  preview(op: (layout: LayoutState) => LayoutState): void
  /** Persist the current layout (end of a drag). */
  flush(): void
}

/**
 * The window's zone layout: a React view of a LayoutSync (layout-sync.ts holds the rules for
 * keeping local edits and main's copy in step). One sync per window, made by TabsPane, which hands
 * it to Zones and the app's slots to the top bar; it unsubscribes from `layout.updated` on unmount.
 */
export function useLayout(): LayoutController {
  // The constructor has no side effects, so StrictMode's discarded second instance costs nothing.
  const [sync] = useState(() => new LayoutSync(window.cockpit))
  useEffect(() => sync.start(), [sync])
  const { layout, panels, appSlots } = useSyncExternalStore(
    (listener) => sync.subscribe(listener),
    () => sync.get()
  )
  return useMemo(
    () => ({
      layout,
      panels,
      appSlots,
      commit: (op) => sync.commit(op),
      preview: (op) => sync.preview(op),
      flush: () => sync.flush()
    }),
    [sync, layout, panels, appSlots]
  )
}
