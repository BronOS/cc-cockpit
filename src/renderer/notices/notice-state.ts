// The state behind ShellNotices.tsx, DOM-free so unit tests run it in plain Node (the renderer has no
// component harness): which link a notice may show, and the queue of pending `ccc plugin link` asks.

import type { IpcEventMap } from '../../shared/ipc'

export type LinkAsk = IpcEventMap['links.ask']

/**
 * The address an `app.linkNotice` may show, or undefined. Only an http(s) address becomes a link:
 * main checked it too, but this is the last place before an `href`, where a `javascript:` URL would run.
 */
export function linkNoticeUrl(payload: unknown): string | undefined {
  const url: unknown = (payload as { url?: unknown } | null | undefined)?.url
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : undefined
}

/**
 * What the shell does with an `app.linkNotice` (design-web.md §6.1): open the link in a new tab at once,
 * show the notice to click, or nothing (an address linkNoticeUrl refuses is never opened nor shown).
 * A page may open a tab only while it has transient user activation, and the person's click that led
 * here (in a plugin's frame: Chrome's User Activation v2 activates the ancestors too, or on a shell
 * button) usually still holds it when main's event arrives; without it the open would be blocked, so
 * the notice is shown instead of trying. `window.open` with `noopener` returns null even when it
 * opened, so activation is the only test there is before the call. Only the web shell ever opens: the
 * desktop never gets this event (main opens the system browser), and if it did it would show the notice.
 */
export type LinkNoticeAction = { kind: 'open'; url: string } | { kind: 'notice'; url: string } | { kind: 'none' }

export function linkNoticeAction(payload: unknown, env: { webShell: boolean; activationActive: boolean }): LinkNoticeAction {
  const url = linkNoticeUrl(payload)
  if (url === undefined) return { kind: 'none' }
  return env.webShell && env.activationActive ? { kind: 'open', url } : { kind: 'notice', url }
}

/**
 * A `links.ask` joins the queue once: the bridge's replay and a live event can both carry it. The
 * same array when it is already there, so React skips the render.
 */
export function addLinkAsk(asks: readonly LinkAsk[], ask: LinkAsk): readonly LinkAsk[] {
  return asks.some((a) => a.requestId === ask.requestId) ? asks : [...asks, ask]
}

/** An ask answered here, or settled in another view (`links.settled`), leaves the queue. */
export function dropLinkAsk(asks: readonly LinkAsk[], requestId: string): readonly LinkAsk[] {
  return asks.filter((a) => a.requestId !== requestId)
}

/**
 * Whether this page may offer Allow. Only the desktop approves a plugin link (main refuses a remote
 * view's Allow, design-web.md §6.1); a browser shows the ask with Deny and "Approve on the desktop".
 */
export function canAllowLink(webShell: boolean): boolean {
  return !webShell
}
