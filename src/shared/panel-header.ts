// ctx.panels.header: what a plugin may put in the title bar of one of its own panels (design §5
// "Panel header"). One rule for both sides: the host checks a call here so the plugin gets a
// TypeError at its call site, and main checks the same request again with the same function,
// because main never trusts what a host sends (a host can be any code, not only our ctx). The
// renderer gets only main's cleaned copy and draws every string as React text, never as HTML.
//
// Kept free of Node and DOM imports: the host bundle, main and the tests all import it.
import { relativePathProblem } from './manifest'

/**
 * The core icon set an action may name, drawn by the app in its own stroke style
 * (renderer/zones/PanelHeaderBar.tsx). Anything else in `icon` is a path to an .svg of the plugin.
 */
export const PANEL_HEADER_ICONS = [
  'refresh',
  'add',
  'search',
  'filter',
  'settings',
  'open-external',
  'check',
  'sort'
] as const
export type PanelHeaderIconName = (typeof PANEL_HEADER_ICONS)[number]

export const MAX_PANEL_HEADER_META = 120
export const MAX_PANEL_HEADER_ACTIONS = 3
export const MAX_PANEL_HEADER_TITLE = 80
/** Same cap as a manifest file reference (shared/manifest.ts MAX_PATH_LENGTH). */
const MAX_ICON_PATH = 260
/** Plain and short: it travels back in every click and keys the action in main. No backtracking. */
const ACTION_ID_RE = /^[A-Za-z0-9._-]{1,40}$/

/** One action as the host sends it and main stores it: `icon` is a core name or a plugin path. */
export interface CleanHeaderAction {
  id: string
  icon: string
  title: string
  busy?: true
  disabled?: true
}

/** A checked header; null (from parsePanelHeader) means the bare title. */
export interface CleanPanelHeader {
  meta?: string
  actions?: CleanHeaderAction[]
}

export function isPanelHeaderIcon(icon: string): icon is PanelHeaderIconName {
  return (PANEL_HEADER_ICONS as readonly string[]).includes(icon)
}

/**
 * Control characters out (a newline or a tab would break the one-line header, an escape would
 * show as a box): each becomes a space. Bidi and other format characters stay: the text is drawn
 * as text, in its own span, and cannot reach past it.
 */
export function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
}

/**
 * Why `icon` is not a usable icon (the tail of an error message), or null when it is: a core name
 * or a relative `.svg` path inside the plugin folder (the manifest's `icon` rule). One rule for the
 * panel header and the overlay buttons (shared/overlay-buttons.ts).
 */
export function panelHeaderIconProblem(icon: string): string | null {
  if (isPanelHeaderIcon(icon)) return null
  // A plugin's own file, by the manifest's rule (no absolute path, no "..", "/" only), and an
  // SVG: it is drawn as a mask over the header's colour, which only a vector shape survives.
  // Where it really leads (a symlink out) is checked when it is fetched: cc-plugin:// serves
  // only files inside the plugin folder (plugin-protocol.ts).
  const problem = icon.length > MAX_ICON_PATH ? 'is too long' : relativePathProblem(icon)
  if (problem !== null) return `icon "${icon.slice(0, 80)}" ${problem}`
  if (!icon.toLowerCase().endsWith('.svg')) {
    return `icon must be one of ${PANEL_HEADER_ICONS.join(', ')} or a path to an .svg file`
  }
  return null
}

function fail(message: string): never {
  throw new TypeError(`panels.header: ${message}`)
}

/**
 * The header `value` as stored, or null for the bare title (null itself, and a header with no
 * meta and no actions). Throws a TypeError naming the broken limit for anything else: a meta over
 * 120 chars, more than 3 actions, an id that is not 1 to 40 of `A-Z a-z 0-9 . _ -`, a duplicate id,
 * an empty title or one over 80 chars, an icon that is neither a core name nor a relative `.svg`
 * path inside the plugin folder (the manifest's `icon` rule), a busy/disabled that is not boolean.
 * Unknown keys are ignored, as in plugin.json, so a later release can add some.
 */
export function parsePanelHeader(value: unknown): CleanPanelHeader | null {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) fail('header must be an object or null')
  const { meta, actions } = value as Record<string, unknown>
  const out: CleanPanelHeader = {}
  if (meta !== undefined) {
    if (typeof meta !== 'string') fail('meta must be a string')
    if (meta.length > MAX_PANEL_HEADER_META) fail(`meta is longer than ${MAX_PANEL_HEADER_META} characters`)
    const text = plain(meta).trim()
    if (text !== '') out.meta = text
  }
  if (actions !== undefined) {
    if (!Array.isArray(actions)) fail('actions must be an array')
    if (actions.length > MAX_PANEL_HEADER_ACTIONS) fail(`at most ${MAX_PANEL_HEADER_ACTIONS} actions`)
    const ids = new Set<string>()
    const list: CleanHeaderAction[] = []
    for (const raw of actions as unknown[]) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('each action must be an object')
      const { id, icon, title, busy, disabled } = raw as Record<string, unknown>
      if (typeof id !== 'string' || !ACTION_ID_RE.test(id)) {
        fail(`action id ${JSON.stringify(String(id)).slice(0, 60)} must be 1 to 40 letters, digits, ".", "_" or "-"`)
      }
      if (ids.has(id)) fail(`action id "${id}" is used twice`)
      ids.add(id)
      if (typeof title !== 'string' || plain(title).trim() === '') fail(`action "${id}": title must be a non-empty string`)
      if (title.length > MAX_PANEL_HEADER_TITLE) fail(`action "${id}": title is longer than ${MAX_PANEL_HEADER_TITLE} characters`)
      if (typeof icon !== 'string') fail(`action "${id}": icon must be a string`)
      const iconProblem = panelHeaderIconProblem(icon)
      if (iconProblem !== null) fail(`action "${id}": ${iconProblem}`)
      if (busy !== undefined && typeof busy !== 'boolean') fail(`action "${id}": busy must be a boolean`)
      if (disabled !== undefined && typeof disabled !== 'boolean') fail(`action "${id}": disabled must be a boolean`)
      const action: CleanHeaderAction = { id, icon, title: plain(title).trim() }
      if (busy === true) action.busy = true
      if (disabled === true) action.disabled = true
      list.push(action)
    }
    if (list.length > 0) out.actions = list
  }
  return out.meta !== undefined || out.actions !== undefined ? out : null
}
