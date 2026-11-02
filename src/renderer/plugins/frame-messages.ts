// What the shell says to a plugin page's iframe, and how it reads a plugin overlay's answer.
// DOM-free so unit tests load it; the frame side is src/sdk/panel-core.ts.
import { MAX_PANEL_MESSAGE_LENGTH, PORT_MESSAGE, THEME_MESSAGE } from '../../sdk/panel-core'
import type { Theme } from '../../shared/theme'

/** A page of a plugin (a panel, or an html overlay a plugin opened), not an inline overlay page. */
export function isPluginPage(src: string): boolean {
  return src.startsWith('cc-plugin://')
}

/** Hands the page its MessagePort (transferred alongside). */
export const portMessage = Object.freeze({ type: PORT_MESSAGE })

/** The theme as a page gets it: the CSS variables and the kind, not the xterm palette. */
export function themeMessage(theme: Theme): { type: string; theme: { kind: Theme['kind']; vars: Record<string, string> } } {
  return { type: THEME_MESSAGE, theme: { kind: theme.kind, vars: { ...theme.vars } } }
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
