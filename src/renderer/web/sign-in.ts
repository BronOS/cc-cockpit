// The web shell's sign-in step (design-web.md §4.2, plan Task 8): what the page does before it opens
// its socket. The gateway serves the same page at `/` to everyone; this decides what it shows.
//
// Access link: the desktop shows `<origin>/#t=<token>`. The fragment never reaches the server, a
// proxy's log or a Referer; the page reads it, takes it out of the address bar and history (so a
// reload, a bookmark or a shoulder does not keep it), then posts it once and gets the device
// cookie (HttpOnly: the page never sees it). The URL is cleared before the post, not after: a
// failed or hung post must not leave the token in the address bar either.
//
// Then the page asks the gateway whether this browser is signed in (SESSION_PATH): a device means
// go on (the picker, or the project in `?project=`), none means the signed-out page for the mode.
// DOM-free (the location, history and fetch are passed in) so unit tests run it in plain Node.
import type { WebAccessMode } from '../../shared/types'
import { SESSION_PATH, SIGN_IN_LINK_PATH, type WebSessionReply } from '../../shared/web-protocol'

/** The longest token the page will post (the gateway refuses longer ones anyway). */
const MAX_TOKEN_LENGTH = 512

export type SignInState =
  | { state: 'signed-in'; device: { id: string; name: string } }
  /** Not signed in; `error` is why the link just posted did not work, if one was. */
  | { state: 'signed-out'; mode: WebAccessMode; error?: string }
  /** The gateway did not answer (or answered nonsense): the host is away or web access went off. */
  | { state: 'unreachable'; error: string }

/** What the page passes in; the browser's own objects fit it. */
export interface SignInEnv {
  location: { hash: string; pathname: string; search: string }
  /** history.replaceState(null, '', url): changes the address bar and the current history entry. */
  replaceUrl(url: string): void
  fetch(input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; credentials?: 'same-origin'; cache?: 'no-store' }): Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
  }>
  /** navigator.userAgent, for the device's name on the desktop's list. */
  userAgent: string
}

/** The access link's token in a URL fragment (`#t=<token>`), or undefined. */
export function linkTokenOf(hash: string): string | undefined {
  if (!hash.startsWith('#')) return undefined
  let params: URLSearchParams
  try {
    params = new URLSearchParams(hash.slice(1))
  } catch {
    return undefined
  }
  const token = params.get('t')
  return token !== null && token.length > 0 && token.length <= MAX_TOKEN_LENGTH ? token : undefined
}

/**
 * A short name for this browser on the desktop's device list ("Firefox on Android"). The person
 * sees it next to Revoke, so it only has to tell their devices apart; main cleans and caps it.
 * Order matters: Edge and Opera say Chrome too, and Chrome says Safari.
 */
export function deviceName(userAgent: string): string {
  const ua = userAgent
  const browser = ua.includes('Firefox/')
    ? 'Firefox'
    : ua.includes('Edg/')
      ? 'Edge'
      : ua.includes('OPR/')
        ? 'Opera'
        : ua.includes('Chrome/') || ua.includes('CriOS/')
          ? 'Chrome'
          : ua.includes('Safari/')
            ? 'Safari'
            : 'Browser'
  const os = ua.includes('Android')
    ? 'Android'
    : ua.includes('iPhone') || ua.includes('iPad')
      ? 'iOS'
      : ua.includes('Mac OS X') || ua.includes('Macintosh')
        ? 'macOS'
        : ua.includes('Windows')
          ? 'Windows'
          : ua.includes('CrOS')
            ? 'ChromeOS'
            : ua.includes('Linux')
              ? 'Linux'
              : undefined
  return os === undefined ? browser : `${browser} on ${os}`
}

function errorOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const error = (body as Record<string, unknown>)['error']
  return typeof error === 'string' && error !== '' ? error.slice(0, 200) : undefined
}

function isMode(value: unknown): value is WebAccessMode {
  return value === 'link' || value === 'password' || value === 'confirm' || value === 'none'
}

/** The SESSION_PATH answer, checked; undefined when it is not one. */
export function sessionReplyOf(body: unknown): WebSessionReply | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const { mode, device } = body as Record<string, unknown>
  if (!isMode(mode)) return undefined
  if (device === null) return { mode, device: null }
  if (typeof device !== 'object') return undefined
  const { id, name } = device as Record<string, unknown>
  if (typeof id !== 'string' || typeof name !== 'string') return undefined
  return { mode, device: { id, name } }
}

/** Posts an access link's token; the error text when it did not let this browser in. */
async function postLink(env: SignInEnv, token: string): Promise<string | undefined> {
  try {
    const res = await env.fetch(SIGN_IN_LINK_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, name: deviceName(env.userAgent) }),
      credentials: 'same-origin',
      cache: 'no-store'
    })
    if (res.ok) return undefined
    return errorOf(await res.json().catch(() => undefined)) ?? `sign-in failed (${res.status})`
  } catch {
    return 'the host did not answer the sign-in'
  }
}

/**
 * The sign-in step: an access link in the URL is used (and cleared) first, then the gateway says
 * whether this browser is signed in. Never throws.
 */
export async function signIn(env: SignInEnv): Promise<SignInState> {
  const token = linkTokenOf(env.location.hash)
  let linkError: string | undefined
  if (env.location.hash !== '') {
    // Any fragment goes, a token or not: nothing else the page uses lives there.
    env.replaceUrl(env.location.pathname + env.location.search)
  }
  if (token !== undefined) linkError = await postLink(env, token)
  let reply: WebSessionReply | undefined
  try {
    const res = await env.fetch(SESSION_PATH, { credentials: 'same-origin', cache: 'no-store' })
    if (!res.ok) return { state: 'unreachable', error: `the host answered ${res.status}` }
    reply = sessionReplyOf(await res.json())
  } catch {
    return { state: 'unreachable', error: 'the host did not answer' }
  }
  if (!reply) return { state: 'unreachable', error: 'the host answered something else' }
  // A link that failed while the browser was already signed in (an old link opened again) is no
  // reason to stop: the device it has still works.
  if (reply.device) return { state: 'signed-in', device: reply.device }
  return linkError === undefined ? { state: 'signed-out', mode: reply.mode } : { state: 'signed-out', mode: reply.mode, error: linkError }
}

/** What the signed-out page says, by mode. Plain text: the page draws it as text. */
export function signedOutText(mode: WebAccessMode): string {
  switch (mode) {
    case 'link':
      return 'This browser is not signed in. On the desktop, open Settings › General › Web access and open the access link (or scan its QR code) on this device.'
    case 'password':
      return 'This browser is not signed in. Signing in with a password is not available in this version yet.'
    case 'confirm':
      return 'This browser is not signed in. Signing in with a desktop confirm is not available in this version yet.'
    case 'none':
      return 'Sign-in is off, but the host did not let this browser in. Reload the page.'
  }
}
