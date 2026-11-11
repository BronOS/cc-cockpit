// What the shell says to a plugin page's iframe, and how it reads a plugin overlay's answer.
// DOM-free so unit tests load it; the frame side is src/sdk/panel-core.ts.
import { MAX_PANEL_MESSAGE_LENGTH, PORT_MESSAGE, THEME_MESSAGE } from '../../sdk/panel-core'
import { MAX_OVERLAY_MESSAGE_LENGTH } from '../../shared/overlay-message'
import type { Theme } from '../../shared/theme'
import { isWebShell } from '../shell-kind'

/** A page of a plugin (a panel, or an html overlay a plugin opened), not an inline overlay page. */
export function isPluginPage(src: string): boolean {
  return src.startsWith('cc-plugin://')
}

/**
 * Hands the page its MessagePort (transferred alongside), and says whether the shell posting it is
 * the web shell (`ccPanel.view.remote`). `remote` comes from the shell that mounts the page
 * (shell-kind.ts), never from the page or the plugin's host; a UI hint only, main still refuses a
 * desktop-only call from a browser view (host-api.ts `desktopOnly`).
 */
export function portMessage(): Readonly<{ type: string; remote: boolean }> {
  return Object.freeze({ type: PORT_MESSAGE, remote: isWebShell() })
}

/** The theme as a page gets it: the CSS variables and the kind, not the xterm palette. */
export function themeMessage(
  theme: Theme,
  mac = false
): { type: string; theme: { kind: Theme['kind']; vars: Record<string, string> }; mac: boolean } {
  // `mac`: the SDK skips its scrollbar rule there (overlay scrollbars already look right).
  return { type: THEME_MESSAGE, theme: { kind: theme.kind, vars: { ...theme.vars } }, mac }
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
