// Where a remote view keeps its own zone sizes and collapsed zones (design-web.md §5.1, open
// question 1): in the browser, per project, never in main. The desktop keeps its geometry in the
// project record through `layout.set` as before; a phone and a desktop differ, so a browser view
// resizing a zone must not move the desktop's splitter (main also refuses it: LayoutService.set
// `keepGeometry`). The browser's own storage is per browser profile and per gateway origin, which
// is what a "view" means in v1 (one person, several devices).
//
// Storage can be missing or throw (a private window, blocked site data, a full quota): then the
// geometry lives for the page's life only, and the zones still work.
import { normalizeGeometry, type LayoutGeometry } from '../../shared/layout'

export interface GeometryStore {
  /** The stored geometry, or undefined (none yet: the view starts from the desktop's). */
  load(): LayoutGeometry | undefined
  save(geometry: LayoutGeometry): void
}

/** The part of `localStorage` this needs; structural so tests can pass a fake. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const GEOMETRY_KEY_PREFIX = 'cc-cockpit.zone-geometry.'

/**
 * A store in `storage` under the project's key. `storage` is a getter because merely reading
 * `window.localStorage` throws where site data is blocked. No project (cannot happen for a project
 * window): kept in memory only.
 */
export function browserGeometryStore(storage: () => StorageLike | undefined, projectId: string | undefined): GeometryStore {
  let memory: LayoutGeometry | undefined
  const key = projectId === undefined || projectId === '' ? undefined : GEOMETRY_KEY_PREFIX + projectId
  return {
    load() {
      if (key === undefined) return memory
      try {
        const raw = storage()?.getItem(key)
        if (typeof raw !== 'string') return memory
        // Another tab of the same browser, an old build or a hand edit wrote it: checked and clamped.
        return normalizeGeometry(JSON.parse(raw))
      } catch {
        return memory
      }
    },
    save(geometry) {
      memory = geometry
      if (key === undefined) return
      try {
        storage()?.setItem(key, JSON.stringify(geometry))
      } catch {
        // Not stored: it stays for this page's life (memory above).
      }
    }
  }
}
