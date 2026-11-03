// The one check for a link main hands to the system browser (shell.openExternal): a renderer's
// `app.openExternal` (a link clicked in a terminal, src/main/ipc/router.ts) and a plugin's
// `ctx.openExternal` (src/main/plugins/host-api.ts) both go through it, so a scheme refused for one
// is refused for the other. No Electron and no Node import: the plugin host checks the shape with
// the same constants.

/** Longest link a renderer may hand to the OS; a terminal can print megabytes of "URL" without a break. */
export const MAX_EXTERNAL_URL_LENGTH = 8192
/** Longest link a plugin may open (ctx.openExternal): far above any real page address. */
export const MAX_PLUGIN_URL_LENGTH = 2048

export interface WebUrlRules {
  /** Prefixed to every refusal (`app.openExternal`, `openExternal`). */
  method: string
  maxLength: number
  /**
   * Refuse `user:pass@` in the URL. A plugin's link is not one the person read before it opened:
   * `https://bank.example@evil.example/` shows a trusted name in front of another host, and a
   * password in a URL ends up in the browser's history.
   */
  noUserinfo?: boolean
}

/**
 * Parse a link to be opened outside the app. Only http and https pass: `file:`, `javascript:`,
 * custom app schemes (`ssh:`, `vscode:`) and the like would let text printed in a terminal (a build
 * log, a file Claude was asked to cat), or a plugin, launch another program. The normalized `href`
 * is returned, not the raw string, so what is checked is exactly what is opened.
 */
export function checkWebUrl(value: unknown, rules: WebUrlRules): string {
  const { method, maxLength } = rules
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${method}: url must be a non-empty string`)
  if (value.length > maxLength) throw new Error(`${method}: url is over ${maxLength} characters`)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${method}: not a valid URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${method}: only http and https links are opened`)
  }
  if (rules.noUserinfo && (parsed.username !== '' || parsed.password !== '')) {
    throw new Error(`${method}: a URL with a user name or password (user:pass@) is not opened`)
  }
  // Normalizing can grow the text (percent-encoding a space is 3 chars): what is opened must be in
  // the limit too, not only what was asked.
  if (parsed.href.length > maxLength) throw new Error(`${method}: url is over ${maxLength} characters`)
  return parsed.href
}
