// The state behind ShellNotices.tsx, DOM-free so unit tests run it in plain Node (the renderer has no
// component harness): which link a notice may show, the queues of pending `ccc plugin link` and
// Move to Trash asks, and a server's in-page notices with the browser tab's title mark.

import type { IpcEventMap } from '../../shared/ipc'
import { isSignInId } from '../../shared/oauth-paste'

export type LinkAsk = IpcEventMap['links.ask']
export type TrashAsk = IpcEventMap['trash.ask']
export type PageNotice = IpcEventMap['notices.show']

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
 * A plugin's OAuth sign-in in a server's browser (design-web.md §9.9): an `app.linkNotice` whose
 * `signIn` names main's pending sign-in. Its notice keeps the link and adds a box for the address the
 * provider's redirect ends on (`oauth.paste`); undefined for a plain link or a malformed id (then the
 * plain notice, linkNoticeAction).
 */
export type OAuthSignInNotice = { url: string; signIn: string; ended?: true }

export function oauthSignInOf(payload: unknown): OAuthSignInNotice | undefined {
  const url = linkNoticeUrl(payload)
  const signIn: unknown = (payload as { signIn?: unknown } | null | undefined)?.signIn
  return url !== undefined && isSignInId(signIn) ? { url, signIn } : undefined
}

/** At most this many sign-in notices at once (one pending sign-in per plugin; a few plugins at most). */
export const MAX_SIGN_IN_NOTICES = 4

/**
 * A sign-in notice joins once, by id (the same array when it is there); past the cap the oldest goes,
 * its sign-in long since replaced or timed out (a paste for it is refused like any other).
 */
export function addSignIn(list: readonly OAuthSignInNotice[], n: OAuthSignInNotice): readonly OAuthSignInNotice[] {
  if (list.some((x) => x.signIn === n.signIn)) return list
  return [...list, n].slice(-MAX_SIGN_IN_NOTICES)
}

/**
 * `oauth.signInEnded`: a sign-in that brought a code (`finished`, pasted here or in another view) loses
 * its notice; one that ended otherwise (timed out, the attempt limit, replaced, the provider's refusal)
 * keeps it marked `ended`, which says so in place of the box. The same array when nothing changes (no
 * such notice here, or already marked), so React skips the render.
 */
export function endSignIn(list: readonly OAuthSignInNotice[], signIn: string, finished: boolean): readonly OAuthSignInNotice[] {
  const at = list.findIndex((n) => n.signIn === signIn)
  if (at < 0) return list
  if (finished) return list.filter((n) => n.signIn !== signIn)
  if (list[at]!.ended === true) return list
  return list.map((n, i) => (i === at ? { ...n, ended: true } : n))
}

/**
 * Any shared ask's queue (links, trash): joins once, by request id (the bridge's replay and a live
 * event can both carry it); the same array when it is already there, so React skips the render.
 */
export function addSharedAsk<A extends { requestId: string }>(asks: readonly A[], ask: A): readonly A[] {
  return asks.some((a) => a.requestId === ask.requestId) ? asks : [...asks, ask]
}

/** Any shared ask answered here, or settled in another view (`links.settled`, `trash.settled`), leaves its queue. */
export function dropSharedAsk<A extends { requestId: string }>(asks: readonly A[], requestId: string): readonly A[] {
  return asks.filter((a) => a.requestId !== requestId)
}

/**
 * Whether this page may offer Allow on the desktop's link dialog. Only the desktop approves a plugin
 * link (main refuses a remote view's Allow, design-web.md §6.1); a browser shows the ask with Deny
 * and "Approve on the desktop". A server's browser views (§9.6) get the ApprovalDialog instead,
 * which always offers Allow.
 */
export function canAllowLink(webShell: boolean): boolean {
  return !webShell
}

/**
 * The browser tab's title while in-page notices are unseen (design-web.md §9.9): a notice that came
 * while the tab was in the background would be missed, so the title counts them, `(2) cc-cockpit`,
 * until the tab is shown again. `base` is the page's own title; zero unseen leaves it as it is.
 */
export function titleWithMark(base: string, unseen: number): string {
  return unseen > 0 ? `(${unseen}) ${base}` : base
}

/** The title the mark last put on, and the page's own title it was put around. */
export interface TitleMark {
  base: string
  set: string
}

/**
 * The next title mark for the current `document.title`. The base is the page's own title: the last
 * one's base while the title is still what the mark set, else the current title, so a title the page
 * (or the shell) wrote meanwhile becomes the new base instead of being overwritten with an old one.
 */
export function nextTitleMark(current: string, last: TitleMark | undefined, unseen: number): TitleMark {
  const base = last !== undefined && current === last.set ? last.base : current
  return { base, set: titleWithMark(base, unseen) }
}

/**
 * The unseen notice ids after a `notices.show`: it counts only when the page is hidden now (one shown
 * on a visible page was seen). The same set when nothing changes, so React skips the render.
 */
export function noteUnseen(unseen: ReadonlySet<string>, requestId: string, hidden: boolean): ReadonlySet<string> {
  if (!hidden || unseen.has(requestId)) return unseen
  return new Set([...unseen, requestId])
}

/** A notice that ended (clicked or dismissed anywhere, timed out) is no longer unseen. */
export function dropUnseen(unseen: ReadonlySet<string>, requestId: string): ReadonlySet<string> {
  if (!unseen.has(requestId)) return unseen
  const next = new Set(unseen)
  next.delete(requestId)
  return next
}
