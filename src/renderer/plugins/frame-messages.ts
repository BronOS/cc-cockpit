// What the shell says to a plugin page's iframe, and how it reads a plugin overlay's answer.
// DOM-free so unit tests load it; the frame side is src/sdk/panel-core.ts.
import { MAX_PANEL_MESSAGE_LENGTH, PORT_MESSAGE, THEME_MESSAGE } from '../../sdk/panel-core'
import { MAX_OVERLAY_MESSAGE_LENGTH } from '../../shared/overlay-message'
import { BUNDLED_TERMINAL_FONTS, type TerminalFont } from '../../shared/terminal-font'
import type { Theme } from '../../shared/theme'
import type { ViewAccess } from '../../shared/views'
import { isWebShell, viewAccessHint } from '../shell-kind'

/** A page of a plugin (a panel, or an html overlay a plugin opened), not an inline overlay page. */
export function isPluginPage(src: string): boolean {
  return src.startsWith('cc-plugin://')
}

/**
 * Hands the page its MessagePort (transferred alongside), and says whether the shell posting it is
 * the web shell (`ccPanel.view.remote`) and this view's access (`ccPanel.view.access`: `owner`, or a
 * guest's role, design-guests §6). Both come from the shell that mounts the page (shell-kind.ts), never
 * from the page or the plugin's host; UI hints only, main still refuses a desktop-only call from a
 * browser view (host-api.ts `desktopOnly`) and anything a guest may not do (GUEST_CLASS).
 */
export function portMessage(): Readonly<{ type: string; remote: boolean; access: ViewAccess }> {
  return Object.freeze({ type: PORT_MESSAGE, remote: isWebShell(), access: viewAccessHint() })
}

/**
 * The port message for a port main marked one-way (PanelPortPayload.oneWay, D-17: a read guest of a
 * plugin that is not guest-aware, whose posts main drops): `oneWay: true` added, so the page may hide
 * controls that would do nothing. Any other message (an intro, the theme) and a two-way port's message
 * go as they are. A hint: main's relay drops the posts whatever the page shows.
 */
export function withPortFlags(message: unknown, oneWay: boolean): unknown {
  if (!oneWay || typeof message !== 'object' || message === null || (message as { type?: unknown }).type !== PORT_MESSAGE) return message
  return Object.freeze({ ...message, oneWay: true })
}

/** The longest theme value the panel SDK keeps (panel-core.ts cleanTheme): a longer family list is left out. */
const MAX_PAGE_VAR_LENGTH = 100
const BUNDLED_FAMILIES = new Set(BUNDLED_TERMINAL_FONTS.map((f) => f.family.toLowerCase()))
const GENERIC_FAMILIES = new Set(['monospace', 'ui-monospace', 'serif', 'sans-serif', 'system-ui'])

/**
 * The terminal font as page variables, for a page tab (an editor draws code in the font the person
 * picked for terminals): `--cc-terminal-font-size` (px) and, when it names a font a page can use,
 * `--cc-terminal-font-family`. The fonts bundled with the app are @font-face rules of the shell's own
 * document, which a plugin frame cannot load, so they are dropped from the list; a list left with only
 * generic names (or too long for the SDK's cap) sets no family, and the page falls back to its own
 * (`var(--cc-terminal-font-family, var(--cc-font-mono))`).
 */
export function terminalFontVars(font: TerminalFont): Record<string, string> {
  const vars: Record<string, string> = { '--cc-terminal-font-size': `${font.size}px` }
  // A CSS family list: names separated by commas outside quotes.
  const names: string[] = []
  let cur = ''
  let quote: string | null = null
  for (const ch of font.family) {
    if (quote) {
      if (ch === quote) quote = null
      cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === ',') {
      names.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  names.push(cur.trim())
  const unquote = (n: string): string => n.replace(/^["']|["']$/g, '').trim().toLowerCase()
  const kept = names.filter((n) => n !== '' && !BUNDLED_FAMILIES.has(unquote(n)))
  const family = kept.join(', ')
  if (kept.some((n) => !GENERIC_FAMILIES.has(unquote(n))) && family.length <= MAX_PAGE_VAR_LENGTH) vars['--cc-terminal-font-family'] = family
  return vars
}

/**
 * The theme as a page gets it: the CSS variables and the kind, not the xterm palette. `font` (page
 * tabs): the terminal font's variables are added (terminalFontVars).
 */
export function themeMessage(
  theme: Theme,
  mac = false,
  font?: TerminalFont
): { type: string; theme: { kind: Theme['kind']; vars: Record<string, string> }; mac: boolean } {
  // `mac`: the SDK skips its scrollbar rule there (overlay scrollbars already look right).
  const vars = font ? { ...theme.vars, ...terminalFontVars(font) } : { ...theme.vars }
  return { type: THEME_MESSAGE, theme: { kind: theme.kind, vars }, mac }
}

/**
 * The value a plugin overlay page answers with: panel.js posts one JSON string per message, and a
 * message that is an object with an own `result` closes the overlay with that value. Anything
 * else (not a string, too long, not JSON, no `result`) is not an answer.
 */
export function overlayResultOf(data: unknown): { value: unknown } | undefined {
  if (typeof data !== 'string' || data.length > MAX_PANEL_MESSAGE_LENGTH) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  if (!Object.prototype.hasOwnProperty.call(parsed, 'result')) return undefined
  return { value: (parsed as { result: unknown }).result }
}

/**
 * A plugin overlay page's message for its opener (ctx.overlay.start): what it posted when that is
 * not an answer (overlayResultOf comes first), as the JSON text to relay, or undefined when it is
 * not a string or is over the overlay limit (main checks both again). Parsed once here only to
 * tell JSON from junk; main parses its own copy.
 */
export function overlayMessageOf(data: unknown): string | undefined {
  if (typeof data !== 'string' || data.length > MAX_OVERLAY_MESSAGE_LENGTH) return undefined
  try {
    JSON.parse(data)
  } catch {
    return undefined
  }
  return data
}
