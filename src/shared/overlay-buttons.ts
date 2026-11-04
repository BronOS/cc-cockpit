// The extras an overlay spec may carry beyond its kind (design-next §3.1): a `type` saying what the
// overlay shows, the opener's own `buttons`, `ready` (when the loader goes) and `discuss`. One rule
// for both sides, as for the panel header: the host checks a call here so the plugin gets a
// TypeError at its call site, and main checks the same request again with the same function
// (parseOverlaySpec), because main never trusts what a host sends. The renderer gets only main's
// clean copy and draws every string as React text.
//
// Unknown keys are dropped from the clean copy, so a later release can add some and an older app
// ignores them. Kept free of Node and DOM imports: the host bundle, main and the tests import it.
import { panelHeaderIconProblem, plain } from './panel-header'

export const MAX_OVERLAY_BUTTONS = 4
export const MAX_OVERLAY_BUTTON_LABEL = 40
/** The type's data as JSON text. Bounded because it travels to every button provider. */
export const MAX_OVERLAY_TYPE_DATA = 4096
/** A tab id is a uuid; the cap only keeps a hostile string out of the clean copy. */
const MAX_DISCUSS_TAB_ID = 100
/** Plain and short: it travels back in every click and keys the button in main. No backtracking. */
const BUTTON_ID_RE = /^[A-Za-z0-9._-]{1,40}$/
const TYPE_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/

/** One button as the host sends it and main stores it. */
export interface CleanOverlayButton {
  id: string
  label: string
  icon?: string
  primary?: true
  disabled?: true
  busy?: true
}

export interface CleanOverlayType {
  name: string
  /** Plain JSON, already round-tripped through JSON text. */
  data: unknown
}

/** The checked extras; a key is present only when the caller set it. */
export interface CleanOverlayExtras {
  type?: CleanOverlayType
  buttons?: CleanOverlayButton[]
  ready?: 'load' | 'manual'
  discuss?: false | { tabId?: string }
}

function fail(message: string): never {
  throw new TypeError(`overlay: ${message}`)
}

/**
 * The buttons as stored (an empty list is fine: it clears them). Throws a TypeError naming the
 * broken limit: more than 4, an id that is not 1 to 40 of `A-Z a-z 0-9 . _ -`, a duplicate id, a
 * label that is empty or over 40 characters, an icon that is neither a core name nor a relative
 * `.svg` path (the panel header's rule), a flag that is not boolean.
 */
export function parseOverlayButtons(value: unknown, what = 'buttons'): CleanOverlayButton[] {
  if (!Array.isArray(value)) fail(`${what} must be an array`)
  if (value.length > MAX_OVERLAY_BUTTONS) fail(`${what}: at most ${MAX_OVERLAY_BUTTONS} buttons`)
  const ids = new Set<string>()
  const list: CleanOverlayButton[] = []
  for (const raw of value as unknown[]) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(`${what}: each button must be an object`)
    const { id, label, icon, primary, disabled, busy } = raw as Record<string, unknown>
    if (typeof id !== 'string' || !BUTTON_ID_RE.test(id)) {
      fail(`${what}: button id ${JSON.stringify(String(id)).slice(0, 60)} must be 1 to 40 letters, digits, ".", "_" or "-"`)
    }
    if (ids.has(id)) fail(`${what}: button id "${id}" is used twice`)
    ids.add(id)
    if (typeof label !== 'string' || plain(label).trim() === '') fail(`${what}: button "${id}": label must be a non-empty string`)
    if (label.length > MAX_OVERLAY_BUTTON_LABEL) {
      fail(`${what}: button "${id}": label is longer than ${MAX_OVERLAY_BUTTON_LABEL} characters`)
    }
    const button: CleanOverlayButton = { id, label: plain(label).trim() }
    if (icon !== undefined) {
      if (typeof icon !== 'string') fail(`${what}: button "${id}": icon must be a string`)
      const problem = panelHeaderIconProblem(icon)
      if (problem !== null) fail(`${what}: button "${id}": ${problem}`)
      button.icon = icon
    }
    for (const [key, flag] of [['primary', primary], ['disabled', disabled], ['busy', busy]] as const) {
      if (flag !== undefined && typeof flag !== 'boolean') fail(`${what}: button "${id}": ${key} must be a boolean`)
    }
    if (primary === true) button.primary = true
    if (disabled === true) button.disabled = true
    if (busy === true) button.busy = true
    list.push(button)
  }
  return list
}

function parseType(value: unknown): CleanOverlayType {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('type must be an object { name, data }')
  const { name, data } = value as Record<string, unknown>
  if (typeof name !== 'string' || !TYPE_NAME_RE.test(name)) {
    fail(`type name ${JSON.stringify(String(name)).slice(0, 60)} must be a lower-case noun of letters, digits and "-" (at most 64)`)
  }
  let text: string | undefined
  try {
    text = JSON.stringify(data)
  } catch {
    fail('type data is not JSON')
  }
  if (text === undefined) fail('type data must be plain JSON (use null for none)')
  if (text.length > MAX_OVERLAY_TYPE_DATA) fail(`type data is longer than ${MAX_OVERLAY_TYPE_DATA} characters of JSON`)
  return { name, data: JSON.parse(text) as unknown }
}

/**
 * The extras of an overlay spec `s` of the given kind, cleaned. `ready` is html only: the other
 * kinds have no page to call `ready()`. Throws a TypeError ("overlay: ...") for anything else.
 */
export function parseOverlayExtras(s: Record<string, unknown>, kind: string): CleanOverlayExtras {
  const out: CleanOverlayExtras = {}
  if (s.type !== undefined) out.type = parseType(s.type)
  if (s.buttons !== undefined) out.buttons = parseOverlayButtons(s.buttons)
  if (s.ready !== undefined) {
    if (s.ready !== 'load' && s.ready !== 'manual') fail('ready must be "load" or "manual"')
    if (kind !== 'html') fail('ready applies to html overlays only')
    out.ready = s.ready
  }
  if (s.discuss !== undefined) {
    if (s.discuss === false) {
      out.discuss = false
    } else {
      if (typeof s.discuss !== 'object' || s.discuss === null || Array.isArray(s.discuss)) {
        fail('discuss must be false or an object { tabId? }')
      }
      const { tabId } = s.discuss as Record<string, unknown>
      if (tabId !== undefined && (typeof tabId !== 'string' || tabId === '' || tabId.length > MAX_DISCUSS_TAB_ID)) {
        fail('discuss.tabId must be a non-empty string')
      }
      out.discuss = tabId === undefined ? {} : { tabId }
    }
  }
  return out
}
