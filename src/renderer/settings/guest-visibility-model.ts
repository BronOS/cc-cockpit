// Which plugins guests see (design-guests §6, §16.1), as the Plugins page (app-wide) and This Project
// (the project's override) edit it: the control's value, what showing exposes, and whether a change
// is a widening that needs the armed confirm (D-11). DOM-free, so the rules are unit-tested in plain
// Node. Every answer here is a UI HINT: main checks each `settings.pluginGuestAccessSet` again by the
// view it bound (a `shown` from a desktop host's browser is refused there whatever this page offers),
// and resolves visibility with its own `guestVisibility` (shared/guest-access.ts), never with ours.
import type { PluginView } from '../../shared/ipc'
import type { GuestAccessResult, GuestVisibility } from '../../shared/guest-access'
import { guestExposure } from '../../shared/guest-exposure'

/** PluginView.guestAccess with the stored values the page edits. */
export type PluginGuestAccess = NonNullable<PluginView['guestAccess']>

/**
 * A plugin's guest access, absent read as hidden by default: `guestAccess` is optional until main's
 * settings service fills it (task 04), and a page that showed "Shown" for a field it never got would
 * tell the owner guests see a plugin they do not (or worse, the reverse once main fills it).
 */
export function guestAccessOf(plugin: Pick<PluginView, 'guestAccess'>): PluginGuestAccess {
  return plugin.guestAccess ?? { effective: 'hidden', source: 'default', aware: false }
}

export const GUEST_VISIBILITY_LABEL: Record<GuestVisibility, string> = { hidden: 'Hidden', shown: 'Shown' }

/** A plugin that sees every window's sessions and does not check the viewer: always hidden (`blocked`). */
export const GUEST_BLOCKED_TEXT = guestExposure({ aware: false, blocked: 'all-windows' }).summary

/**
 * What showing the plugin exposes (spec-review 18): the shared generic text (shared/guest-exposure.ts,
 * task 04's, from `aware` and the port each role gets), never the manifest's text (a plugin's own claim
 * of what it shows is the one thing the owner cannot check). One string, for the armed confirm.
 */
export function guestExposureText(access: Pick<PluginGuestAccess, 'aware' | 'blocked'>): string {
  const e = guestExposure(access)
  if (access.blocked !== undefined) return e.summary
  return `${e.summary} Read-only guests: ${e.read} Write guests: ${e.write}`
}

/**
 * The Plugins page's lines under the control: the blocked reason alone, or the summary ("If shown:"
 * while the app-wide value hides it, so it never reads as if guests saw it now) and one line per role.
 */
export function guestExposureLines(access: PluginGuestAccess): string[] {
  const e = guestExposure(access)
  if (access.blocked !== undefined) return [e.summary]
  const summary = appGuestValue(access) === 'shown' ? e.summary : `If shown: ${e.summary}`
  return [summary, `Read-only guests: ${e.read}`, `Write guests: ${e.write}`]
}

/**
 * The line (or two) about a plugin's windows under the card's guest lines (docs/design-overlay-views.md §7, D-4),
 * only for a plugin shown to guests: nothing while it is hidden or blocked. Plain words for the owner. The flags
 * come from main's reading of the manifest (`PluginView`), never from the page.
 */
export function guestWindowLines(plugin: Pick<PluginView, 'guestAccess' | 'overlaysPerView' | 'providesServices'>): string[] {
  const access = guestAccessOf(plugin)
  if (access.blocked !== undefined) return []
  if (access.effective !== 'shown' && appGuestValue(access) !== 'shown') return []
  if (plugin.overlaysPerView !== true) return ["Its windows stay on your screen; guests see a note."]
  const lines = ["Its windows show on guests' screens too."]
  if (plugin.providesServices === true) lines.push('What another plugin opens in it reaches guests only when that plugin is shown too; data it fetches itself is shown as its own.')
  return lines
}

/** Why Shown is off in a browser view of a desktop cockpit (main refuses a widening from it, design §16.2). */
export const GUEST_SHOW_DESKTOP_ONLY = 'Showing a plugin to guests is done in the cockpit window on the host computer; from a browser you can only hide it.'

/** The page's shell, as shell-kind.ts tells it (passed in so the rule is testable without the module's state). */
export interface GuestShell {
  /** The web shell (a browser view), not the Electron window. */
  webShell: boolean
  /** A browser view of a server-mode cockpit (isServerView). */
  serverView: boolean
}

/**
 * What a widening asks of this page (D-11, design §16.2): the desktop page saves at once (the owner at
 * the host's own screen); a server's browser is the owner's only screen, so it may widen, behind the
 * armed confirm (ApprovalDialog), which a click already on its way cannot answer; a browser of a
 * desktop cockpit may not widen at all (main refuses it: "a remote view cannot add or widen access").
 * A narrowing (hide, or use a global value that is hidden) is `direct` everywhere.
 */
export type GuestChange = 'direct' | 'confirm' | 'refused'

/** A value the page can send: Hidden / Shown, or null ("Use global", the project's override only). */
export type GuestTarget = 'app' | 'project'

/**
 * Whether setting `value` at `target` can let guests see more, decided from the value it leaves in
 * force rather than from `value === 'shown'` alone: on This Project, "Use global" (null) with a global
 * Shown is a widening too (§16.2 lets only a null that falls back to hidden through as a narrowing). An
 * app-wide Shown is a widening even where this project's override hides it: it reaches every other
 * project's guests.
 */
export function isGuestWidening(access: PluginGuestAccess, target: GuestTarget, value: GuestVisibility | null): boolean {
  if (target === 'app') return value === 'shown'
  return (value ?? access.appValue ?? 'hidden') === 'shown'
}

/** How the page treats the change (GuestChange) in this shell. */
export function guestChange(access: PluginGuestAccess, target: GuestTarget, value: GuestVisibility | null, shell: GuestShell): GuestChange {
  if (!isGuestWidening(access, target, value)) return 'direct'
  if (!shell.webShell) return 'direct'
  return shell.serverView ? 'confirm' : 'refused'
}

/** Whether this shell may offer Shown at all (a desktop cockpit's browser may only hide). */
export function canShowToGuests(shell: GuestShell): boolean {
  return !shell.webShell || shell.serverView
}

/**
 * The Plugins page's control: the app-wide stored value (absent = hidden), not `effective`, which may
 * be this project's override (shown on its own line, guestOverrideNote).
 */
export function appGuestValue(access: PluginGuestAccess): GuestVisibility {
  return access.appValue ?? 'hidden'
}

/**
 * Under the app-wide control, when this window's project overrides it: what guests of this project get,
 * so a "Hidden" app-wide with "Shown" here (or the reverse) is never read as the whole story.
 */
export function guestOverrideNote(access: PluginGuestAccess): string | undefined {
  if (access.blocked !== undefined || access.source !== 'project') return undefined
  return `This project overrides it: ${GUEST_VISIBILITY_LABEL[access.effective].toLowerCase()} to its guests (This Project).`
}

/**
 * This Project's line: what guests of this project get and where it comes from ("from global" when the
 * project follows the app-wide value, "the default" when neither is set).
 */
export function guestEffectiveText(access: PluginGuestAccess): string {
  if (access.blocked !== undefined) return GUEST_BLOCKED_TEXT
  const value = GUEST_VISIBILITY_LABEL[access.effective]
  const from: Record<GuestAccessResult['source'], string> = {
    project: 'set for this project',
    app: 'the global value',
    default: 'the default'
  }
  return `Guests here: ${value.toLowerCase()} (${from[access.source]}).`
}

/** The value "Use global" falls back to, as This Project's select names it. */
export function globalGuestLabel(access: PluginGuestAccess): string {
  return `Use global (${GUEST_VISIBILITY_LABEL[access.appValue ?? 'hidden'].toLowerCase()})`
}

/** This Project's select value: `global` for no override. */
export type ProjectGuestChoice = 'global' | GuestVisibility

export function projectGuestChoice(access: PluginGuestAccess): ProjectGuestChoice {
  return access.projectValue ?? 'global'
}

/**
 * What unchecking This Project's "Use global" stores as the project's own value: the global one, so
 * nothing changes for guests until the person picks otherwise, except where storing Shown is a widening
 * this view cannot make (a desktop cockpit's browser): Hidden then, a narrowing it may make, rather
 * than a switch that does nothing.
 */
export function projectOverrideStart(access: PluginGuestAccess, shell: GuestShell): GuestVisibility {
  const global = access.appValue ?? 'hidden'
  return guestChange(access, 'project', global, shell) === 'refused' ? 'hidden' : global
}

/** What a choice sends (`settings.pluginGuestAccessSet`'s value): null for "Use global". */
export function projectGuestValue(choice: ProjectGuestChoice): GuestVisibility | null {
  return choice === 'global' ? null : choice
}

/**
 * The armed confirm's text (ApprovalDialog, server-mode browsers only). It says what showing exposes
 * and how far it reaches: app-wide reaches every project's guests.
 */
export function guestShowAskText(name: string, access: PluginGuestAccess, target: GuestTarget): { title: string; body: string; allowLabel: string } {
  const reach =
    target === 'app'
      ? "Every project's guests get it, except in a project that hides it under This Project."
      : "This project's guests get it."
  return { title: `Show ${name} to guests?`, body: `${guestExposureText(access)} ${reach}`, allowLabel: 'Show to guests' }
}
