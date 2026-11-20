// What a guest may call (design-guests §4, shared/design.md §16.3): one class per invoke channel, typed over
// IpcInvokeMap so a channel added without a guest entry fails to compile, and a lookup that answers `no` for
// any name that is not an own key (a frame's channel name is untrusted text). Checked in the router after
// `remoteAllowed` (it can only narrow REMOTE_CLASS: a unit test holds no `no` remote channel is read or
// write here), then the targets, then the handler:
//
//   remoteAllowed -> GUEST_CLASS (role >= cls) -> targets (in scope / visible / shown to this view) -> handler
//
// A channel whose request names a tab, panel, frame, overlay, plugin, group or ask carries a target
// extractor; the type makes one mandatory for a read or write entry whose request has such a field. The
// extractors run BEFORE the handler validates the payload, so they take `unknown` and fail closed: a
// malformed payload yields `undefined` and the call is refused. Nested ids the type cannot see
// (`commands.run`'s `<plugin>/<command>`, `tabs.create`'s `beside.tabId`, Discuss's `target.tabId`,
// `overlays.button`'s `pluginId`) have explicit extractors, each with its unit test.
//
// The owner never goes through this table (`who === 'owner'` short-circuits every guest check).
// Pure: no Node, DOM or Electron imports.

import { isPlainObject } from './guards'
import type { InvokeChannel, Req } from './ipc'
import type { GuestRole } from './views'

export type GuestClass = 'no' | 'read' | 'write'

/** What a call acts on, checked against the guest's scope and the plugins it may see. */
export type GuestTarget =
  | { tab: string }
  | { panel: string }
  | { plugin: string }
  | { frame: string }
  | { overlay: string }
  | { group: string }
  /** A shared ask's request id: it must be one this view was shown (shared/guest-filter.ts `askVisible`). */
  | { ask: string }

/** A call's targets, or undefined when the payload is malformed (the call is refused). */
export type GuestTargets = readonly GuestTarget[] | undefined
export type GuestExtractor = (req: unknown) => GuestTargets

type TargetField = 'tabId' | 'panelKey' | 'pluginId' | 'frameId' | 'overlayId' | 'groupId' | 'requestId'
type Names<R> = R extends object ? Extract<keyof R, TargetField> : never

/**
 * One channel's rule. A request with a target field cannot be read or write without an extractor; one
 * without may still have one (nested ids).
 */
export type GuestRule<C extends InvokeChannel> = [Names<Req<C>>] extends [never]
  ? { readonly cls: GuestClass; readonly target?: GuestExtractor }
  : { readonly cls: 'no' } | { readonly cls: 'read' | 'write'; readonly target: GuestExtractor }

/** A rule as a lookup by name returns it. */
export interface AnyGuestRule {
  readonly cls: GuestClass
  readonly target?: GuestExtractor
}

const NO = Object.freeze({ cls: 'no' }) as { readonly cls: 'no' }

/** Ids main mints (tab UUIDs, `<plugin>/<panel>` keys, request ids) are far below this. */
const MAX_TARGET_ID = 200

const own = (o: unknown, key: string): unknown => (isPlainObject(o) && Object.hasOwn(o, key) ? o[key] : undefined)
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_TARGET_ID

/** All of several extractors' targets; undefined when any of them is. */
function all(...extractors: GuestExtractor[]): GuestExtractor {
  return (req) => {
    const out: GuestTarget[] = []
    for (const ex of extractors) {
      const t = ex(req)
      if (t === undefined) return undefined
      out.push(...t)
    }
    return out
  }
}

function field(name: TargetField, make: (id: string) => GuestTarget): GuestExtractor {
  return (req) => {
    const v = own(req, name)
    return isId(v) ? [make(v)] : undefined
  }
}

export const byTab = field('tabId', (tab) => ({ tab }))
export const byPanel = field('panelKey', (panel) => ({ panel }))
export const byFrame = field('frameId', (frame) => ({ frame }))
export const byOverlay = field('overlayId', (overlay) => ({ overlay }))
export const byAsk = field('requestId', (ask) => ({ ask }))

/** `commands.run`: `id` is `<pluginId>/<command>`; the plugin is the target. Core commands never come here. */
export const byCommand: GuestExtractor = (req) => {
  const id = own(req, 'id')
  if (!isId(id)) return undefined
  const slash = id.indexOf('/')
  return slash > 0 ? [{ plugin: id.slice(0, slash) }] : undefined
}

/**
 * `tabs.create`: a guest opens only Claude and Shell tabs (never the owner's [+] menu commands); `beside`,
 * when present, must name a tab the guest sees.
 */
export const byTabCreate: GuestExtractor = (req) => {
  const kind = own(req, 'kind')
  if (kind !== 'claude' && kind !== 'shell') return undefined
  const beside = own(req, 'beside')
  if (beside === undefined) return []
  const tab = own(beside, 'tabId')
  return isId(tab) ? [{ tab }] : undefined
}

/** A Discuss target (shared/discuss.ts): a tab names a target; `new` (a new session) names none. */
function discussTarget(raw: unknown): GuestTargets {
  const kind = own(raw, 'kind')
  if (kind === 'new') return []
  const tab = own(raw, 'tabId')
  return kind === 'tab' && isId(tab) ? [{ tab }] : undefined
}

const byDiscussTarget: GuestExtractor = (req) => discussTarget(own(req, 'target'))
export const byPageDiscuss = all(byTab, byDiscussTarget)
export const byOverlayDiscuss = all(byOverlay, byDiscussTarget)

/** `overlays.button`: the overlay, and for a type button (`source: 'type'`) the plugin that registered it. */
export const byOverlayButton: GuestExtractor = all(byOverlay, (req) => {
  const pluginId = own(req, 'pluginId')
  if (pluginId === undefined) return []
  return isId(pluginId) ? [{ plugin: pluginId }] : undefined
})

/** Every invoke channel's guest rule (design §16.3). Default `no`. */
export const GUEST_CLASS: { readonly [C in InvokeChannel]: GuestRule<C> } = Object.freeze({
  // read: a read-only guest may call these (a write guest too). Targets checked before the handler.
  // the project as { id, name, colour } only (D-33, guestProject)
  'window.info': { cls: 'read' },
  // a link opens as a notice in the asking view only (app.linkNotice `to`)
  'app.openExternal': { cls: 'read' },
  // the view's own appearance
  'theme.get': { cls: 'read' },
  // this view's own scheme report
  'theme.scheme': { cls: 'read' },
  'prefs.get': { cls: 'read' },
  // filtered: shared tabs, no room or held (guestSessions)
  'sessions.list': { cls: 'read' },
  // filtered: visible plugins' panels only (guestLayout)
  'layout.get': { cls: 'read' },
  // filtered: visible plugins' and core commands (guestCommands)
  'commands.list': { cls: 'read' },
  // a port only for a visible plugin; one-way per guestPort (D-17)
  'panels.connect': { cls: 'read', target: byPanel },
  'slots.connect': { cls: 'read', target: byFrame },
  'slots.disconnect': { cls: 'read', target: byFrame },
  'slots.height': { cls: 'read', target: byFrame },
  // the tab must be visible, its plugin too (tabVisible)
  'pageTabs.src': { cls: 'read', target: byTab },
  'pageTabs.connect': { cls: 'read', target: byTab },
  'pageTabs.disconnect': { cls: 'read', target: byTab },
  // filtered to visible tabs
  'pageTabs.unsaved': { cls: 'read' },
  // filtered: overlays a shared tab or a visible plugin opened (guestOverlays)
  'overlays.list': { cls: 'read' },
  // a terminal overlay's flow control
  'overlays.ack': { cls: 'read', target: byOverlay },
  'webviews.current': { cls: 'read', target: byPanel },
  // a read guest is a viewer, never the size owner (spec-review 14)
  'webviews.place': { cls: 'read', target: byPanel },
  // filtered: shared tabs, stripped (guestTabs)
  'tabs.list': { cls: 'read' },
  // the D-16 projection (projectGroups)
  'groups.get': { cls: 'read' },
  // the view's own hidden mark
  'tabs.visibility': { cls: 'read' },
  // the view's own terminal flow
  'tabs.ack': { cls: 'read', target: byTab },
  // per view only: never the project's activeTab or lastActing (design §7)
  'tabs.selected': { cls: 'read', target: byTab },
  // filtered (guestPresence)
  'presence.get': { cls: 'read' },

  // write: write guests only.
  'sessions.cancelQueued': { cls: 'write', target: byTab },
  // desktop host: an Allow is ignored (Deny only, D-10); re-checked at answer
  'trash.answer': { cls: 'write', target: byAsk },
  // D-23: an offer from a shared tab, to this guest's own device
  'downloads.accept': { cls: 'write', target: byAsk },
  'downloads.answer': { cls: 'write', target: byAsk },
  // a visible plugin's command (`<pluginId>/<command>`)
  'commands.run': { cls: 'write', target: byCommand },
  'panels.action': { cls: 'write', target: byPanel },
  'pageTabs.dirty': { cls: 'write', target: byTab },
  // the page tab and the Discuss target tab both visible
  'pageTabs.discuss': { cls: 'write', target: byPageDiscuss },
  'overlays.close': { cls: 'write', target: byOverlay },
  'overlays.input': { cls: 'write', target: byOverlay },
  'overlays.resize': { cls: 'write', target: byOverlay },
  'overlays.result': { cls: 'write', target: byOverlay },
  // a type button names its plugin: it must be visible too
  'overlays.button': { cls: 'write', target: byOverlayButton },
  // into a visible tab only
  'overlays.discuss': { cls: 'write', target: byOverlayDiscuss },
  'webviews.step': { cls: 'write', target: byPanel },
  'webviews.fit': { cls: 'write', target: byPanel },
  'webviews.input': { cls: 'write', target: byPanel },
  'webviews.insertText': { cls: 'write', target: byPanel },
  'webviews.selectChoose': { cls: 'write', target: byPanel },
  // kinds `claude` and `shell` only; `beside` a visible tab; cap MAX_GUEST_TABS (D-21)
  'tabs.create': { cls: 'write', target: byTabCreate },
  // a tab it opened; any other asks the owner (D-9)
  'tabs.close': { cls: 'write', target: byTab },
  'tabs.restart': { cls: 'write', target: byTab },
  // sets `typed` (D-3)
  'tabs.input': { cls: 'write', target: byTab },
  // a report; the size is taken only by explicit acts (D-14)
  'tabs.resize': { cls: 'write', target: byTab },
  // Fit to this screen: an explicit take (D-14)
  'tabs.fit': { cls: 'write', target: byTab },

  // no: everything else. Settings, plugins, marketplace, updates, projects, remote servers, OAuth, the plugin-link
  // approval (D-4), web access and devices, guests themselves, layout and group writes, tab flags, renames, reorders and
  // room marks, rooms, close asks, the host's own screen (dialogs, bounds, screens), html overlay pages (a guest never
  // holds one), the [+] menu's command tabs, settings pages and notices.
  'window.reopen': NO,
  'projects.recent': NO,
  'projects.openFolder': NO,
  'projects.openRecent': NO,
  'projects.showPicker': NO,
  'projects.closePicker': NO,
  'projects.close': NO,
  'projects.relink': NO,
  'projects.forget': NO,
  'remote.list': NO,
  'remote.connect': NO,
  'remote.open': NO,
  'remote.edit': NO,
  'remote.pickKey': NO,
  'remote.rename': NO,
  'remote.forget': NO,
  'updates.state': NO,
  'updates.setEnabled': NO,
  'updates.dismiss': NO,
  'updates.openRelease': NO,
  'sessions.closeAnswer': NO,
  'links.answer': NO,
  'layout.set': NO,
  'plugins.restart': NO,
  'plugins.limits.get': NO,
  'plugins.limits.set': NO,
  'plugins.globalLimits.get': NO,
  'plugins.globalLimits.set': NO,
  'settingsPage.info': NO,
  'settingsPage.connect': NO,
  'settingsPage.disconnect': NO,
  'settings.projects': NO,
  'settings.projectOpen': NO,
  'settings.projectRelink': NO,
  'settings.projectRemove': NO,
  'settings.plugins': NO,
  'settings.pluginInstall': NO,
  'settings.pluginLink': NO,
  'settings.pluginUpdate': NO,
  'settings.pluginUninstall': NO,
  'settings.pluginBundledOff': NO,
  'settings.pluginServices': NO,
  'settings.pluginServiceProvider': NO,
  'settings.marketplace': NO,
  'settings.marketplaceInstall': NO,
  'settings.marketplaceUpdate': NO,
  'settings.marketplaceUpdateAll': NO,
  'settings.marketplaceRefresh': NO,
  'settings.marketplacePreview': NO,
  'settings.marketplaceSetUrls': NO,
  'settings.pluginSettingsSave': NO,
  'settings.pluginProjectDefaultsSave': NO,
  'settings.project': NO,
  'settings.projectPluginEnable': NO,
  'settings.projectPluginSettingsSave': NO,
  'settings.projectPanelMove': NO,
  'settings.projectColorSet': NO,
  'settings.appearance': NO,
  'settings.themeSet': NO,
  'settings.keySet': NO,
  'settings.tabExitSet': NO,
  'settings.claudeTabOnOpenSet': NO,
  'settings.sessionGistSet': NO,
  'settings.statusLineUsageSet': NO,
  'settings.keepAwakeSet': NO,
  'settings.discussPromptSet': NO,
  'settings.projectDiscussPromptSet': NO,
  'settings.notificationSoundsSet': NO,
  'settings.notificationSoundOptions': NO,
  'settings.notificationSoundSet': NO,
  'notify.soundData': NO,
  'notices.click': NO,
  'notices.dismiss': NO,
  'oauth.paste': NO,
  'settings.zoneAutoHideSet': NO,
  'settings.minTerminalWidthSet': NO,
  'settings.confirmTabClose': NO,
  'settings.confirmTabCloseSet': NO,
  'settings.tabCloseSideSet': NO,
  'settings.terminalFontSet': NO,
  'settings.windowBackgroundSet': NO,
  'settings.tabCommandsSet': NO,
  'settings.cccStatus': NO,
  'settings.cccInstall': NO,
  'settings.cccOfferSet': NO,
  'settings.webAccess': NO,
  'settings.webAccessSet': NO,
  'settings.webAccessLink': NO,
  'settings.webAccessRegenerate': NO,
  'settings.webAccessAddDevice': NO,
  'settings.webDeviceDisconnect': NO,
  'settings.webDeviceRevoke': NO,
  'settings.webDevicesRevokeAll': NO,
  'settings.webAccessSetPassword': NO,
  'webAccess.state': NO,
  'webAccess.confirmAnswer': NO,
  'ccc.offer': NO,
  'overlays.bounds': NO,
  'overlays.message': NO,
  'overlays.ready': NO,
  'overlays.loaded': NO,
  // A guest holds no copy yet: Task 5 of docs/plans/20261120-overlay-views.md widens it (read, own copy only).
  'overlays.release': NO,
  'overlays.take': NO,
  'webviews.placement': NO,
  'tabs.commands': NO,
  'tabs.reorder': NO,
  'tabs.rename': NO,
  'tabs.flag': NO,
  'tabs.toggleFlag': NO,
  'tabs.roomMark': NO,
  'rooms.deliverHeld': NO,
  'rooms.view': NO,
  'rooms.doc': NO,
  'rooms.pause': NO,
  'rooms.resume': NO,
  'rooms.remove': NO,
  'rooms.removeAnswer': NO,
  'rooms.reveal': NO,
  'tabs.screen': NO,
  'groups.place': NO,
  'groups.remove': NO,
  'groups.dissolve': NO,
  'groups.resize': NO,
  'groups.area': NO,
  'groups.rename': NO,
  'guests.list': NO,
  'guests.invite': NO,
  'guests.revokeInvite': NO,
  'guests.kick': NO,
  'guests.setRole': NO,
  'guests.setScope': NO,
  'guests.shareTab': NO,
  'settings.pluginGuestAccessSet': NO,
  'tabs.guestCloseAnswer': NO
})

/** The rule of a channel name from anywhere: `no` for a name that is not an own key (`__proto__`, `toString`). */
export function guestClassOf(channel: string): AnyGuestRule {
  return Object.hasOwn(GUEST_CLASS, channel) ? (GUEST_CLASS[channel as InvokeChannel] as AnyGuestRule) : NO
}

/** Whether a guest of `role` may call a channel of class `cls` (before its targets are checked). */
export function guestRoleAllows(role: GuestRole, cls: GuestClass): boolean {
  if (cls === 'read') return true
  if (cls === 'write') return role === 'write'
  return false
}

const PANE_FOCUS = ['pane.focusLeft', 'pane.focusRight', 'pane.focusUp', 'pane.focusDown'] as const
const TAB_SELECT = Array.from({ length: 9 }, (_, i) => `tab.select.${i + 1}`)

/**
 * The core commands (main/commands/command-registry.ts CORE_COMMANDS) a guest's shell offers and runs
 * (spec-review 10, 24): navigation of what it sees for every guest, plus new Claude and Shell tabs, Close
 * and the overlay keys for a write guest. A UI rule: each of them ends in a channel main checks anyway
 * (GUEST_CLASS), so this list only keeps the shell from offering what main would refuse. Plugin
 * commands (`<pluginId>/<command>`) are not here: `commands.run` checks the plugin's visibility.
 */
export const GUEST_SAFE_COMMANDS: Readonly<Record<GuestRole, readonly string[]>> = Object.freeze({
  read: Object.freeze([...TAB_SELECT, 'tab.switchNext', 'tab.switchPrev', 'palette.open', 'pane.zoom', ...PANE_FOCUS]),
  write: Object.freeze([
    ...TAB_SELECT,
    'tab.switchNext',
    'tab.switchPrev',
    'palette.open',
    'pane.zoom',
    ...PANE_FOCUS,
    'tab.newClaude',
    'tab.newShell',
    'tab.close',
    'overlay.pop',
    'overlay.closeTop'
  ])
})
