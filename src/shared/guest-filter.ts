// What a guest receives (design-guests §5, shared/design.md §16.8; spec-review 3): pure filters, one per
// payload shape, used by every outbound route so the routes cannot drift apart:
//   - main/web's guest connection sink (`GUEST_EVENT`, D-18) and the `ready` snapshot (task 02);
//   - the router's invoke answers (`tabs.list`, `sessions.list`, `layout.get`, `commands.list`,
//     `overlays.list`, `groups.get`, `pageTabs.unsaved`, `window.info`, the `TabInfo` of `tabs.create` and
//     `tabs.restart`; task 03);
//   - the visibility predicates `tabVisible` and `askVisible`, also the router's target checks.
//
// Letters as the design's table names them: T only tabs in scope; S strip what a guest must not read
// (environment, room, who the tab is shared with, the flag's note, the host's paths, device names); P only
// visible plugins' items; G the split-group projection (D-16). D-33: the host's path and project record
// never reach a guest.
//
// Every filter takes a guest's context and returns a new value, or undefined for "send nothing". The owner
// never reaches these (`who === 'owner'` short-circuits before them). Pure: no Node, DOM or Electron.

import type { GuestAccess, GuestOnlyAccess, PresenceSnapshot } from './guests'
import { inScope } from './guests'
import type {
  CommandsView,
  IpcEventMap,
  LayoutView,
  OverlayInfo,
  PageHolder,
  PanelInfo,
  ProjectSummary,
  SessionsSnapshot,
  TabInfo,
  WindowInfo
} from './ipc'
import type { LayoutState, ZoneId } from './layout'
import { projectGroups, type GroupsSnapshot } from './tab-groups'

/** What one guest view's filters may ask about, live (main/web builds it per connection from GuestService). */
export interface GuestFilterContext {
  /** The receiving view. */
  viewId: string
  access: GuestOnlyAccess
  /** `tabVisible` with the guest's live data (scope, opened tabs, plugin visibility). */
  tabVisible(tabId: string): boolean
  pluginVisible(pluginId: string): boolean
  /** An overlay a shared tab or a visible plugin opened (OverlayManager's internal `origin`). */
  overlayVisible(overlayId: string): boolean
  /** The name of the person behind a view (the owner's D-24 name, or a guest's); undefined when unknown. */
  personOf(viewId: string | null): string | undefined
  /** The project's tab order now (after the change an event reports): `tabs.moved` re-indexes over it. */
  tabOrder(): readonly string[]
  /**
   * The project's folder (the host's path, absolute), only so a session's `files` can be made relative to it
   * (D-33); never sent. Absent or undefined: no file reaches the guest (fail closed).
   */
  projectRoot?(): string | undefined
}

/** The parts of a tab the visibility rule reads (`TabInfo` and main's tab records both have them). */
export interface TabVisibilityInput {
  id: string
  /** A command tab a plugin opened. */
  openedBy?: string
  /** A page tab's plugin. */
  page?: { plugin: string }
}

/**
 * The one tab visibility rule (design §7, D-21, D-27). The owner sees every tab; a revoked guest none. A
 * guest sees a tab in its scope (`all`: every tab of its project) or one it opened, unless a plugin it
 * cannot see opened the tab or draws its page: a hidden plugin's tab would show that plugin's data. A
 * tab a plugin opened gives no guest anything extra (D-27): it follows the scope like any other.
 */
export function tabVisible(
  access: GuestAccess,
  tab: TabVisibilityInput,
  openedTabs: readonly string[],
  pluginVisible: (pluginId: string) => boolean
): boolean {
  if (access.kind === 'owner') return true
  if (access.kind !== 'guest') return false
  if (tab.openedBy !== undefined && !pluginVisible(tab.openedBy)) return false
  if (tab.page !== undefined && !pluginVisible(tab.page.plugin)) return false
  return inScope(access.scope, tab.id) || openedTabs.includes(tab.id)
}

/** The plugin of a panel key (`<pluginId>/<panelId>`); undefined for anything else. */
export function pluginOfPanelKey(panelKey: string): string | undefined {
  const slash = panelKey.indexOf('/')
  return slash > 0 ? panelKey.slice(0, slash) : undefined
}

const panelVisible = (panelKey: string, ctx: GuestFilterContext): boolean => {
  const plugin = pluginOfPanelKey(panelKey)
  return plugin !== undefined && ctx.pluginVisible(plugin)
}

/** A view id as a guest may hold it: its own, else '' (another view's id says nothing it needs). */
const viewIdFor = (viewId: string | null, ctx: GuestFilterContext): string => (viewId === ctx.viewId ? viewId : '')

/** A device named as its person (never a device name: "Oleg's MacBook" is the owner's, not the guest's). */
const personFor = (viewId: string | null, ctx: GuestFilterContext): string => ctx.personOf(viewId) ?? ''

// ---------------------------------------------------------------------------------------------
// Tabs (T, S)

/**
 * S: one tab as a guest gets it. Dropped: the plugin environment (`env`, a plugin's tokens), room
 * membership, `sharedWith` (other guests), the flag's note (the colour stays: design §7), the host's
 * folder (`cwd`, D-33) and a command tab's command line (`command`, `argv`: the owner's, may hold
 * arguments). `typedBy` names the person, never the device.
 */
export function guestTabInfo(tab: TabInfo, ctx: GuestFilterContext): TabInfo {
  const out: TabInfo = { ...tab, cwd: '' }
  delete out.env
  delete out.room
  delete out.sharedWith
  delete out.command
  delete out.argv
  // A page tab's params are its plugin's `onOpen` input: the editor's is a file's host path, an outside one
  // included (D-33). The shell draws a page tab from its title and frame, never its params, so a guest's copy has none.
  if (tab.page !== undefined) {
    const page = { ...tab.page }
    delete page.params
    out.page = page
  }
  if (tab.flag !== undefined) out.flag = { color: tab.flag.color }
  if (tab.typedBy !== undefined) out.typedBy = { viewId: viewIdFor(tab.typedBy.viewId, ctx), device: personFor(tab.typedBy.viewId, ctx) }
  return out
}

/** T + S: the tabs a guest sees, in order. */
export function guestTabs(tabs: readonly TabInfo[], ctx: GuestFilterContext): TabInfo[] {
  return tabs.filter((t) => ctx.tabVisible(t.id)).map((t) => guestTabInfo(t, ctx))
}

/** `tabs.added`, and a single `TabInfo` answer (`tabs.create`, `tabs.restart`): undefined when not visible. */
export function guestTab(tab: TabInfo, ctx: GuestFilterContext): TabInfo | undefined {
  return ctx.tabVisible(tab.id) ? guestTabInfo(tab, ctx) : undefined
}

/** T for an event that names one tab (`tabs.exit`, `tabs.select`, `sessions.cancelQueued`-like payloads). */
export function guestByTab<P extends { tabId: string }>(p: P, ctx: GuestFilterContext): P | undefined {
  return ctx.tabVisible(p.tabId) ? p : undefined
}

/**
 * `tabs.removed` passes whatever the scope: it names only an id main minted and its generation, a guest's
 * page ignores an id it never held, and a visibility check on a tab that is already gone could strand a
 * tab the guest did hold (its scope can no longer be computed).
 */
export function guestTabRemoved(p: IpcEventMap['tabs.removed']): IpcEventMap['tabs.removed'] {
  return p
}

/** `tabs.typed`: visible tabs only; the device becomes the person. */
export function guestTyped(p: IpcEventMap['tabs.typed'], ctx: GuestFilterContext): IpcEventMap['tabs.typed'] | undefined {
  if (!ctx.tabVisible(p.tabId)) return undefined
  return { tabId: p.tabId, viewId: p.viewId === null ? null : viewIdFor(p.viewId, ctx), device: p.viewId === null ? null : personFor(p.viewId, ctx) }
}

/** `tabs.moved`: visible tabs only, `toIndex` recomputed over the tabs the guest sees. */
export function guestTabsMoved(p: IpcEventMap['tabs.moved'], ctx: GuestFilterContext): IpcEventMap['tabs.moved'] | undefined {
  if (!ctx.tabVisible(p.tabId)) return undefined
  const visible = ctx.tabOrder().filter((t) => ctx.tabVisible(t))
  const toIndex = visible.indexOf(p.tabId)
  return toIndex < 0 ? undefined : { tabId: p.tabId, toIndex }
}

/** `tabs.exitFocus`: only when the guest sees both the closed pane and the one the focus goes to. */
export function guestExitFocus(p: IpcEventMap['tabs.exitFocus'], ctx: GuestFilterContext): IpcEventMap['tabs.exitFocus'] | undefined {
  return ctx.tabVisible(p.tabId) && ctx.tabVisible(p.closed) ? p : undefined
}

/** `pageTabs.unsaved`: the visible ones. */
export function guestTabIds(ids: readonly string[], ctx: GuestFilterContext): string[] {
  return ids.filter((t) => ctx.tabVisible(t))
}

/** `sessions.list` / `sessions.snapshot`: shared tabs only, no room or held count (rooms are the owner's). */
export function guestSessions(s: SessionsSnapshot, ctx: GuestFilterContext): SessionsSnapshot {
  const root = ctx.projectRoot?.()
  return {
    own: s.own
      .filter((d) => ctx.tabVisible(d.tabId))
      .map((d) => {
        const out = { ...d }
        delete out.room
        delete out.held
        // D-33: the files the session touched, relative to the project; one outside it (a host path) is dropped.
        out.files = d.files.flatMap((f) => {
          const rel = projectRelative(f, root)
          return rel === undefined ? [] : [rel]
        })
        // The queue is the owner's texts waiting for the gate (and plugins' prompts): never a guest's to read.
        out.queue = []
        return out
      })
  }
}

/**
 * `file` relative to `root`, or undefined when it is not strictly inside it. Pure string work (no Node here), so it
 * fails closed: both must be absolute POSIX paths, and a `.` or `..` segment or an empty one in `file` (anything a
 * resolve would move) is refused rather than resolved; so is a case or Unicode spelling that differs from the root's.
 */
export function projectRelative(file: string, root: string | undefined): string | undefined {
  if (root === undefined || !root.startsWith('/') || !file.startsWith('/')) return undefined
  const base = root.length > 1 && root.endsWith('/') ? root.slice(0, -1) : root
  const prefix = base === '/' ? '/' : base + '/'
  if (!file.startsWith(prefix)) return undefined
  const rel = file.slice(prefix.length)
  if (rel === '') return undefined
  if (rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return undefined
  return rel
}

/** G: `groups.get` / `groups.changed` (D-16). */
export function guestGroups(s: GroupsSnapshot, ctx: GuestFilterContext): GroupsSnapshot {
  return projectGroups(s, (t) => ctx.tabVisible(t))
}

// ---------------------------------------------------------------------------------------------
// Plugins (P)

function guestPanelInfo(p: PanelInfo, ctx: GuestFilterContext): PanelInfo {
  // A plugin settings page is never a guest's (design §5): no gear target. Slot frames another plugin
  // draws in this panel follow that plugin's visibility.
  const out: PanelInfo = { ...p }
  delete out.settings
  if (p.slots !== undefined) out.slots = p.slots.filter((s) => ctx.pluginVisible(s.pluginId))
  return out
}

function guestLayoutState(l: LayoutState, ctx: GuestFilterContext): LayoutState {
  const zones = {} as LayoutState['zones']
  for (const z of Object.keys(l.zones) as ZoneId[]) {
    const zone = l.zones[z]
    zones[z] = { ...zone, panels: zone.panels.filter((p) => panelVisible(p.panelKey, ctx)) }
  }
  const remembered: LayoutState['remembered'] = {}
  for (const [key, placement] of Object.entries(l.remembered)) if (panelVisible(key, ctx)) remembered[key] = placement
  return { zones, hidden: l.hidden.filter((k) => panelVisible(k, ctx)), remembered }
}

/** `layout.get` / `layout.updated`: visible plugins' panels and slot frames only; `reveal` of a hidden one dropped. */
export function guestLayout(v: LayoutView, ctx: GuestFilterContext): LayoutView {
  const out: LayoutView = {
    layout: guestLayoutState(v.layout, ctx),
    panels: v.panels.filter((p) => panelVisible(p.panelKey, ctx)).map((p) => guestPanelInfo(p, ctx))
  }
  if (v.reveal !== undefined && panelVisible(v.reveal, ctx)) out.reveal = v.reveal
  if (v.appSlots !== undefined) out.appSlots = v.appSlots.filter((s) => ctx.pluginVisible(s.pluginId))
  if (v.seq !== undefined) out.seq = v.seq
  return out
}

/**
 * `commands.list` / `commands.updated`: core commands (the shell offers only GUEST_SAFE_COMMANDS of them),
 * visible plugins' commands; the owner's [+] menu entries never. Key conflicts are a settings matter: none.
 */
export function guestCommands(v: CommandsView, ctx: GuestFilterContext): CommandsView {
  return {
    commands: v.commands.filter((c) => {
      if (c.source === 'core') return true
      if (c.source !== 'plugin') return false
      const plugin = pluginOfPanelKey(c.id)
      return plugin !== undefined && ctx.pluginVisible(plugin)
    }),
    conflicts: []
  }
}

/** `panels.reload`: the visible plugins of the list; nothing when none is left. */
export function guestPanelsReload(p: IpcEventMap['panels.reload'], ctx: GuestFilterContext): IpcEventMap['panels.reload'] | undefined {
  const pluginIds = p.pluginIds.filter((id) => ctx.pluginVisible(id))
  return pluginIds.length > 0 ? { pluginIds } : undefined
}

/** Webview events (`webviews.navigated`, `cursor`, `selection`, `select`): only for a visible plugin's panel. */
export function guestByPanel<P extends { panelKey: string }>(p: P, ctx: GuestFilterContext): P | undefined {
  return panelVisible(p.panelKey, ctx) ? p : undefined
}

// ---------------------------------------------------------------------------------------------
// Overlays

function guestHolder(h: PageHolder, ctx: GuestFilterContext): PageHolder {
  return { viewId: viewIdFor(h.viewId, ctx), device: personFor(h.viewId, ctx) }
}

/**
 * `overlays.list` / `overlays.updated`: overlays a shared tab or a visible plugin opened; other plugins'
 * type buttons only when visible; Discuss only for a write guest and only into a visible tab.
 */
export function guestOverlays(list: readonly OverlayInfo[], ctx: GuestFilterContext): OverlayInfo[] {
  return list
    .filter((o) => ctx.overlayVisible(o.id))
    .map((o) => {
      const { typeButtons, discuss, heldBy, ...rest } = o
      const out: OverlayInfo = { ...rest }
      if (typeButtons !== undefined) out.typeButtons = typeButtons.filter((b) => ctx.pluginVisible(b.pluginId))
      if (discuss !== undefined && ctx.access.role === 'write' && (discuss.tabId === undefined || ctx.tabVisible(discuss.tabId))) {
        out.discuss = discuss
      }
      if (heldBy !== undefined) out.heldBy = guestHolder(heldBy, ctx)
      return out
    })
}

/** `overlays.data`: a visible overlay's terminal output only. */
export function guestByOverlay<P extends { overlayId: string }>(p: P, ctx: GuestFilterContext): P | undefined {
  return ctx.overlayVisible(p.overlayId) ? p : undefined
}

// ---------------------------------------------------------------------------------------------
// The project (D-33)

/** The project as a guest sees it: id, name and colour; the host's folder never (`path: ''`). */
export function guestProject(p: ProjectSummary): ProjectSummary {
  const out: ProjectSummary = { id: p.id, name: p.name, path: '', missing: false }
  if (p.color !== undefined) out.color = p.color
  return out
}

/** `window.info` for a guest: the project filtered (D-33). A guest is never bound to the picker. */
export function guestWindowInfo(w: WindowInfo): WindowInfo {
  if (w.kind !== 'project') return { ...w, home: '' }
  const out: WindowInfo = { kind: 'project', project: guestProject(w.project) }
  if (w.fullScreen !== undefined) out.fullScreen = w.fullScreen
  if (w.transparent !== undefined) out.transparent = w.transparent
  return out
}

// ---------------------------------------------------------------------------------------------
// Notices, asks, presence

/** `app.linkNotice`: only the notice main stamped for this view (`to`); a broadcast one never. */
export function guestLinkNotice(p: IpcEventMap['app.linkNotice'], ctx: GuestFilterContext): IpcEventMap['app.linkNotice'] | undefined {
  return p.to === ctx.viewId && p.signIn === undefined ? p : undefined
}

/** The shared asks main puts to a window's views. */
export type GuestAskKind = 'link' | 'trash' | 'download' | 'close' | 'roomRemove' | 'guestClose'

/** What an ask's visibility rests on: its plugin (trash), its main-only origin tab (download). */
export interface GuestAskInfo {
  pluginId?: string
  /** A `ccc download` offer's tab (`CliCall.tabId`), kept by main, never on the wire. */
  originTab?: string
}

/**
 * Whether an ask is shown to (and may be answered from) a view of `access` (design §9, D-4, D-10, D-23):
 * the owner every ask; a read guest none; a write guest a trash confirm of a visible plugin and a
 * download offer started from a tab it sees. The plugin link (code installed as the owner), plugin close
 * asks, room asks and the owner's own D-9 asks are never a guest's. The same rule drops the ask at the
 * sink and refuses the answer in the router (the answer re-checks at answer time: the role may have
 * changed). Whether an Allow counts on a desktop host is the router's (D-10), not this.
 */
export function askVisible(
  kind: GuestAskKind,
  info: GuestAskInfo,
  access: GuestAccess,
  ctx: Pick<GuestFilterContext, 'tabVisible' | 'pluginVisible'>
): boolean {
  if (access.kind === 'owner') return true
  if (access.kind !== 'guest' || access.role !== 'write') return false
  if (kind === 'trash') return info.pluginId !== undefined && ctx.pluginVisible(info.pluginId)
  if (kind === 'download') return info.originTab !== undefined && ctx.tabVisible(info.originTab)
  return false
}

/**
 * `presence.get` / `presence.changed` for a guest: a person on a tab this guest cannot see is "elsewhere"
 * (no tab id); who typed last only for visible tabs.
 */
export function guestPresence(s: PresenceSnapshot, ctx: GuestFilterContext): PresenceSnapshot {
  const lastTyped: Record<string, string> = {}
  for (const [tabId, person] of Object.entries(s.lastTyped)) if (ctx.tabVisible(tabId)) lastTyped[tabId] = person
  return {
    seq: s.seq,
    people: s.people.map((p) => {
      if (p.tabId === null || ctx.tabVisible(p.tabId)) {
        const out = { ...p }
        delete out.elsewhere
        return out
      }
      return { ...p, tabId: null, elsewhere: true as const }
    }),
    lastTyped
  }
}
