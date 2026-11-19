// ctx.views (guests, design-guests §6, §16.5): the views each plugin's pages are open in, and who is
// behind each one, learned ONLY from main's port tags (panel, slot and page tab ports; host/index.ts parses
// them). A page's own claim (its `ccPanel.view`) is a UI hint and never reaches here.
//
//   access    main tags every port with its view's access: `owner` (the desktop page, an owner's view) or a
//             guest's role (`read` | `write`); a tag without one is refused, never read as the owner. Fixed for a
//             view's life: a role switch gives the guest new view ids (design §16.4), so one view never
//             changes access.
//   lifetime  a view is known to a plugin from its first open line of any kind and gone when its last
//             one ends (main never tells a host a view left, spec-review 17): each hub registers a line
//             when it opens one and releases it when the line ends, whichever way it ends.
//   replay    a new onChange listener first hears every view already known, at once: a line can open
//             before the plugin subscribes (a page connecting while it activates), and a listener that
//             missed it would count a guest's view as not there (Files would send it the project path).
//
// Per plugin: a plugin learns only of views its own pages are open in.

import type { Disposer, ViewAccess } from '../../sdk/types'
import { errorText } from '../../shared/error-text'
import type { ViewId } from '../../shared/views'

export type ViewChange = { view: string; access: ViewAccess | undefined }
type Listener = (e: ViewChange) => void

/**
 * The access in main's port tag, which main always writes (`owner` for the desktop page and an owner's view):
 * a guest role only on a remote view (the desktop window's page is always the owner's). Null for anything
 * else, absent included: the caller refuses the whole tag, as it does a view main did not mint, so a tag that
 * lost its access never reads as the owner (a plugin decides "refuse guests" from it).
 */
export function tagAccess(raw: unknown, view: ViewId | undefined): ViewAccess | null {
  if (raw === 'owner') return 'owner'
  if (view === undefined) return null
  return raw === 'read' || raw === 'write' ? raw : null
}

/** Lower of two accesses (owner > write > read): two lines of one view disagreeing is main's bug; the lesser wins. */
function lesser(a: ViewAccess, b: ViewAccess): ViewAccess {
  const rank = { read: 0, write: 1, owner: 2 } as const
  return rank[a] <= rank[b] ? a : b
}

export class HostViews {
  /** pluginId -> view ('desktop' or `web:<n>`) -> its access and how many of the plugin's lines it has open. */
  private readonly lines = new Map<string, Map<string, { access: ViewAccess; count: number }>>()
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(private readonly log: (pluginId: string, message: string) => void) {}

  /**
   * A line of the plugin opened in `view`: returns its release, to call when the line ends (a second call is
   * harmless). The view's first line makes it known (`onChange` with its access), its last release gone.
   */
  add(pluginId: string, view: string, access: ViewAccess): () => void {
    const views = this.lines.get(pluginId) ?? new Map<string, { access: ViewAccess; count: number }>()
    this.lines.set(pluginId, views)
    const entry = views.get(view)
    if (entry) {
      entry.count++
      entry.access = lesser(entry.access, access)
    } else {
      views.set(view, { access, count: 1 })
      this.emit(pluginId, { view, access })
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const now = this.lines.get(pluginId)?.get(view)
      if (!now) return
      now.count--
      if (now.count > 0) return
      this.lines.get(pluginId)?.delete(view)
      if (this.lines.get(pluginId)?.size === 0) this.lines.delete(pluginId)
      this.emit(pluginId, { view, access: undefined })
    }
  }

  /** The view's access for the plugin; undefined when none of its lines is open there. */
  access(pluginId: string, view: string): ViewAccess | undefined {
    return this.lines.get(pluginId)?.get(view)?.access
  }

  onChange(pluginId: string, listener: Listener): Disposer {
    const set = this.listeners.get(pluginId) ?? new Set<Listener>()
    // Wrapped: the same function registered twice is two registrations, each with its disposer.
    const entry: Listener = (e) => listener(e)
    set.add(entry)
    this.listeners.set(pluginId, set)
    // The views already open, before onChange returns (see "replay" above).
    for (const [view, { access }] of [...(this.lines.get(pluginId) ?? [])]) {
      if (!set.has(entry)) break
      try {
        entry({ view, access })
      } catch (err) {
        this.log(pluginId, `a views.onChange listener threw: ${errorText(err)}`)
      }
    }
    return () => {
      set.delete(entry)
      if (set.size === 0 && this.listeners.get(pluginId) === set) this.listeners.delete(pluginId)
    }
  }

  /** The plugin is gone: its listeners drop (its lines were ended, and released, by the hubs first). */
  removePlugin(pluginId: string): void {
    this.listeners.delete(pluginId)
    this.lines.delete(pluginId)
  }

  private emit(pluginId: string, e: ViewChange): void {
    for (const listener of [...(this.listeners.get(pluginId) ?? [])]) {
      try {
        listener({ ...e })
      } catch (err) {
        this.log(pluginId, `a views.onChange listener threw: ${errorText(err)}`)
      }
    }
  }
}
