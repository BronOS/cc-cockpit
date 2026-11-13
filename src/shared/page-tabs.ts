// Page tabs (design-editor.md §1 "Core: page tabs"): a tab in the main tab bar whose content is a
// plugin page, beside Claude, shell and command tabs. The rules every side shares live here: the
// manifest entry, the type name, the caps and the checks of what a plugin hands main (params,
// title, icon). Pure, with no runtime import, like slots.ts: the manifest check, main's tab manager,
// restore and (later) the plugin host and the renderer all read these, and a copy would drift.
//
// main is the authority (CLAUDE.md): a page path never comes from the host (the manifest names it
// per type), and the title, icon and params a plugin asks for are checked and clamped here before
// a tab holds them. A saved record is user-writable, so restore runs the same checks again.
import type { JsonValue } from '../sdk/types'

/**
 * A page-tab type: a plain lower-case word, like a slot type (`file` for the editor). It names the
 * manifest entry (and so the page main loads) and the `ctx.tabs.onOpen` listener of the plugin.
 */
export const PAGE_TAB_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

/** A plugin's `contributes.tabs` entry: page tabs of `type` show the page at `page`. */
export interface PageTabContribution {
  type: string
  /** Plugin-relative path to the tab's html page (served by cc-plugin://, like an html panel's). */
  page: string
  /**
   * Chords the page takes while it has focus (design-editor.md §1 "Keyboard"): the editor's own
   * Ctrl+P, Ctrl+K, Ctrl+S... The app table and the person's overrides still win for chords they
   * hold; the routing is the shell's (Task 3). Each one is checked by normalizeChord at load.
   */
  keys?: string[]
}

/** At most this many `contributes.tabs` entries per plugin. */
export const MAX_PAGE_TAB_TYPES = 10
/** At most this many chords in one entry's `keys`. */
export const MAX_PAGE_TAB_KEYS = 32
/**
 * At most this many page tabs per plugin per project, open or restored (design-editor.md §1 "a cap
 * on page tabs per plugin"). Each is a frame with its own port once mounted; far above what a
 * person keeps open, far below what a plugin looping on `openPage` could pile into the bar.
 */
export const MAX_PAGE_TABS_PER_PLUGIN = 64
/** A page tab's `params`, as JSON, is at most this many bytes (the editor's are a path and a line). */
export const MAX_PAGE_TAB_PARAMS_BYTES = 4 * 1024
/** A title is one short line of the tab strip; longer is cut, not refused (the design's "clamped"). */
export const PAGE_TAB_TITLE_MAX = 80
/**
 * An icon is a NAME the shell maps to one of its own glyphs (a file kind, say), never markup, a URL
 * or a path: nothing a plugin sends is drawn as it is. An unknown name gets the shell's default.
 */
export const PAGE_TAB_ICON_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/** What a page tab holds besides the common tab fields: whose it is, what it shows, how it reads. */
export interface PageTabSpec {
  /** The plugin whose page it is (main took it from the host's own plugin, never from a payload). */
  plugin: string
  /** One of that plugin's `contributes.tabs` types. */
  type: string
  /** Plain JSON for the plugin's `onOpen` (the editor's `{ path, line?, col? }`); absent = none. */
  params?: JsonValue
  title: string
  icon?: string
}

// C0 controls and DEL. A title is drawn on one line of the strip; a newline or an escape byte there
// is either a damaged record or a plugin's mistake, so each is made a space rather than refused.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g

/**
 * The title as stored: control characters made spaces, trimmed, cut to PAGE_TAB_TITLE_MAX (UTF-16
 * code units, by code point so a surrogate pair is never split). Undefined when it is not text or
 * nothing is left: the caller refuses an open, restore drops the tab.
 */
export function pageTabTitleOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.replace(CONTROL, ' ').trim()
  if (cleaned.length === 0) return undefined
  if (cleaned.length <= PAGE_TAB_TITLE_MAX) return cleaned
  let out = ''
  for (const ch of cleaned) {
    if (out.length + ch.length > PAGE_TAB_TITLE_MAX) break
    out += ch
  }
  return out.trimEnd()
}

/** The icon name, or undefined when `value` is not one (the tab then shows the default glyph). */
export function pageTabIconOf(value: unknown): string | undefined {
  return typeof value === 'string' && PAGE_TAB_ICON_PATTERN.test(value) ? value : undefined
}

/**
 * `params` through JSON once, as slot params are (slots.ts slotParamsOf): what is kept is the parsed
 * copy, so a getter, a prototype or a function cannot ride along, and the byte count is that of the
 * text that is saved and handed back to the plugin. Throws naming the rule.
 */
export function pageTabParamsOf(params: unknown): JsonValue {
  let text: string | undefined
  try {
    text = JSON.stringify(params)
  } catch {
    // A cycle or a BigInt: the same answer as a function, without the engine's text.
    text = undefined
  }
  if (text === undefined) throw new Error('page tab params must be plain JSON')
  if (new TextEncoder().encode(text).length > MAX_PAGE_TAB_PARAMS_BYTES) {
    throw new Error(`page tab params are larger than ${MAX_PAGE_TAB_PARAMS_BYTES} bytes as JSON`)
  }
  return JSON.parse(text) as JsonValue
}

/**
 * A whole spec checked: the plugin id by `isPluginId` (the caller's, so this file stays import-free),
 * the type by its pattern, params by pageTabParamsOf, the title clamped, a bad icon dropped (it is
 * cosmetic). Throws naming the first problem.
 */
export function checkPageTabSpec(raw: unknown, isPluginId: (value: unknown) => boolean): PageTabSpec {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('a page tab needs its plugin, type and title')
  const { plugin, type, params, title, icon } = raw as Record<string, unknown>
  if (!isPluginId(plugin)) throw new Error('a page tab needs the id of its plugin')
  if (typeof type !== 'string' || !PAGE_TAB_TYPE_PATTERN.test(type)) {
    throw new Error(`a page tab type must match ${PAGE_TAB_TYPE_PATTERN.source}`)
  }
  const t = pageTabTitleOf(title)
  if (t === undefined) throw new Error('a page tab needs a title of plain text')
  const spec: PageTabSpec = { plugin: plugin as string, type, title: t }
  if (params !== undefined) spec.params = pageTabParamsOf(params)
  const i = pageTabIconOf(icon)
  if (i !== undefined) spec.icon = i
  return spec
}

/**
 * A tab's id as main makes it (randomUUID, TabManager): checked before any lookup of a page tab the
 * renderer names (`pageTabs.connect`), so junk from a renderer is not carried any further.
 */
export const PAGE_TAB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The prefix of a page tab's port key (pageTabPortKey). */
const PAGE_TAB_PORT_PREFIX = '@tab/'

/**
 * A page tab's frame gets its MessagePort on the panels' channel (PANEL_PORT_CHANNEL, the preload
 * and the renderer's port bus unchanged), under this key, as a slot frame does under `@slot/<id>`:
 * `@` never starts a plugin id, so it cannot collide with a panel's key.
 */
export function pageTabPortKey(tabId: string): string {
  return `${PAGE_TAB_PORT_PREFIX}${tabId}`
}

/**
 * Whether a port key is a page tab's. The web relays treat those differently from a panel's
 * (design-editor.md §1 "Relay backlog"): a page tab's port is paused and resynced at the byte
 * limit, never closed, and its frame takes a new port without loading again.
 */
export function isPageTabPortKey(key: string): boolean {
  return key.startsWith(PAGE_TAB_PORT_PREFIX)
}
