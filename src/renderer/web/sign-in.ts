// The web shell's sign-in step (design-web.md §4.2, plan Task 8): what the page does before it opens
// its socket. The gateway serves the same page at `/` to everyone; this decides what it shows.
//
// Access link: the desktop shows `<origin>/#t=<token>`. The fragment never reaches the server, a
// proxy's log or a Referer; the page reads it, takes it out of the address bar and history (so a
// reload, a bookmark or a shoulder does not keep it), then, when this browser has no device yet,
// posts it once and gets the device cookie (HttpOnly: the page never sees it). The URL is cleared
// before the post, not after: a failed or hung post must not leave the token in the address bar.
//
// The page asks the gateway whether this browser is signed in (SESSION_PATH) before it posts a
// link, and posts only when it is not: a device means go on (the picker, or the project in
// `?project=`), none means the link is posted, or the signed-out page for the mode without one.
//
// Password and desktop confirm (plan Task 27) have a page of their own on the signed-out screen
// (main.tsx): the password is posted once per press, and the confirm asks for a code, shows it, and
// polls with its ticket until the desktop answers. The ticket is kept in sessionStorage by the
// page, so a reload while waiting goes on with the same request (one waits at a time) instead of
// asking again. Both end in the same device cookie and a fresh page load.
//
// Every sign-in also answers the device's origin key (device-key.ts, design-web.md §4.1): the page
// keeps it (`storeKey`) before it loads again, and sends it with every request behind sign-in, the
// session check included (main.tsx passes a fetch that adds it). A browser with the cookie but not the
// key (its site data cleared, a device from before the key) is signed out and signs in again.
// DOM-free (the location, history and fetch are passed in) so unit tests run it in plain Node.
import { parseDesktopAgent } from '../../shared/remote-agent'
import { deviceKeyOf } from './device-key'
import type { WebAccessMode } from '../../shared/types'
import {
  CONFIRM_ASK_PATH,
  CONFIRM_POLL_PATH,
  SESSION_PATH,
  SIGN_IN_LINK_PATH,
  SIGN_IN_PASSWORD_PATH,
  type WebConfirmPoll,
  type WebConfirmTicket,
  type WebSessionReply
} from '../../shared/web-protocol'

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
  /** Keeps a sign-in's origin key for this origin (device-key.ts storeDeviceKey). */
  storeKey(key: string): void
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

const DESKTOP_DEVICE_PREFIX = 'cc-cockpit desktop on '

/**
 * A short name for this browser on the desktop's device list ("Firefox on Android"). The person
 * sees it next to Revoke, so it only has to tell their devices apart; main cleans and caps it.
 * Order matters: Edge and Opera say Chrome too, and Chrome says Safari.
 */
export function deviceName(userAgent: string): string {
  // A cc-cockpit desktop window names itself (design-remote-desktop.md §5.2). Main caps device names
  // at 60 characters (MAX_DEVICE_NAME), so the hostname is cut to keep the whole name whole.
  const desktop = parseDesktopAgent(userAgent)
  if (desktop !== undefined) return `${DESKTOP_DEVICE_PREFIX}${desktop.hostname.slice(0, 60 - DESKTOP_DEVICE_PREFIX.length)}`
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

/** A JSON post to a sign-in route, with this page's cookies (the answer may set the device's). */
function postJson(env: Pick<SignInEnv, 'fetch'>, path: string, body: unknown): ReturnType<SignInEnv['fetch']> {
  return env.fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store'
  })
}

/** Posts a sign-in; the error text when it did not let this browser in. Keeps the answer's origin key. */
async function postSignIn(env: Pick<SignInEnv, 'fetch' | 'storeKey'>, path: string, body: unknown): Promise<string | undefined> {
  try {
    const res = await postJson(env, path, body)
    const answer: unknown = await res.json().catch(() => undefined)
    if (res.ok) {
      const key = deviceKeyOf(answer)
      // A gateway that let this browser in always answers a key; without one the cookie is no use.
      if (key === undefined) return 'the host answered no device key'
      env.storeKey(key)
      return undefined
    }
    return errorOf(answer) ?? `sign-in failed (${res.status})`
  } catch {
    return 'the host did not answer the sign-in'
  }
}

/** Posts an access link's token; the error text when it did not let this browser in. */
function postLink(env: SignInEnv, token: string): Promise<string | undefined> {
  return postSignIn(env, SIGN_IN_LINK_PATH, { token, name: deviceName(env.userAgent) })
}

/**
 * Signs in with the password; the error text when it did not let this browser in. A wrong one can
 * take a moment to answer (the host slows guesses down), which the page says while it waits.
 */
export function signInWithPassword(env: Pick<SignInEnv, 'fetch' | 'userAgent' | 'storeKey'>, password: string): Promise<string | undefined> {
  return postSignIn(env, SIGN_IN_PASSWORD_PATH, { password, name: deviceName(env.userAgent) })
}

/** The CONFIRM_ASK_PATH answer, checked. */
function confirmTicketOf(body: unknown): WebConfirmTicket | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const { code, ticket, expiresAt } = body as Record<string, unknown>
  if (typeof code !== 'string' || code.length === 0 || code.length > 16) return undefined
  if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > MAX_TOKEN_LENGTH) return undefined
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return undefined
  return { code, ticket, expiresAt }
}

/** The CONFIRM_POLL_PATH answer, checked. */
export function confirmPollOf(body: unknown): WebConfirmPoll | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const b = body as Record<string, unknown>
  switch (b['state']) {
    case 'pending':
      return typeof b['code'] === 'string' && typeof b['expiresAt'] === 'number' ? { state: 'pending', code: b['code'], expiresAt: b['expiresAt'] } : undefined
    case 'allowed': {
      const device = b['device'] as Record<string, unknown> | null | undefined
      if (!device || typeof device !== 'object' || typeof device['id'] !== 'string' || typeof device['name'] !== 'string') return undefined
      return { state: 'allowed', device: { id: device['id'], name: device['name'] } }
    }
    case 'denied':
      return { state: 'denied' }
    case 'gone':
      return { state: 'gone' }
    default:
      return undefined
  }
}

/** Asks the desktop to let this browser in: the code to show and the ticket to poll with, or why not. */
export async function askConfirm(env: Pick<SignInEnv, 'fetch' | 'userAgent'>): Promise<{ ok: true; ticket: WebConfirmTicket } | { ok: false; error: string }> {
  try {
    const res = await postJson(env, CONFIRM_ASK_PATH, { name: deviceName(env.userAgent) })
    const body: unknown = await res.json().catch(() => undefined)
    if (!res.ok) return { ok: false, error: errorOf(body) ?? `the request failed (${res.status})` }
    const ticket = confirmTicketOf(body)
    return ticket ? { ok: true, ticket } : { ok: false, error: 'the host answered something else' }
  } catch {
    return { ok: false, error: 'the host did not answer' }
  }
}

/**
 * Where this browser's request stands. `allowed` means the answer carried the device cookie and the
 * origin key, which is kept (the page then loads again, signed in); `error` is a failed poll, which
 * the page retries.
 */
export async function pollConfirm(env: Pick<SignInEnv, 'fetch' | 'storeKey'>, ticket: string): Promise<WebConfirmPoll | { state: 'error'; error: string }> {
  try {
    const res = await postJson(env, CONFIRM_POLL_PATH, { ticket })
    const body: unknown = await res.json().catch(() => undefined)
    if (!res.ok) return { state: 'error', error: errorOf(body) ?? `the host answered ${res.status}` }
    const poll = confirmPollOf(body)
    if (poll?.state === 'allowed') {
      const key = deviceKeyOf(body)
      if (key === undefined) return { state: 'error', error: 'the host answered no device key' }
      env.storeKey(key)
    }
    return poll ?? { state: 'error', error: 'the host answered something else' }
  } catch {
    return { state: 'error', error: 'the host did not answer' }
  }
}

/** The code as the page shows it: `123 456`, easier to read off and type on the desktop. */
export function shownCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code
}

/** Asks the gateway whether this browser is signed in; an `unreachable` state when it cannot tell. */
async function sessionOf(env: SignInEnv): Promise<WebSessionReply | Extract<SignInState, { state: 'unreachable' }>> {
  let reply: WebSessionReply | undefined
  try {
    const res = await env.fetch(SESSION_PATH, { credentials: 'same-origin', cache: 'no-store' })
    if (!res.ok) return { state: 'unreachable', error: `the host answered ${res.status}` }
    reply = sessionReplyOf(await res.json())
  } catch {
    return { state: 'unreachable', error: 'the host did not answer' }
  }
  return reply ?? { state: 'unreachable', error: 'the host answered something else' }
}

/**
 * The sign-in step: an access link in the URL is cleared first, then the gateway says whether this
 * browser is signed in, and the link is posted only when it is not. Never throws.
 *
 * Signed in already (the QR scanned again, an old tab with the link): the link is not posted.
 * Posting it would add a second device record each time, each one a "new device" notice on the
 * desktop and a place under the device cap until it expires, and would use up a one-time "add a
 * device" token for nothing. The device the browser has goes on.
 */
export async function signIn(env: SignInEnv): Promise<SignInState> {
  const token = linkTokenOf(env.location.hash)
  if (env.location.hash !== '') {
    // Any fragment goes, a token or not: nothing else the page uses lives there.
    env.replaceUrl(env.location.pathname + env.location.search)
  }
  let reply = await sessionOf(env)
  if ('state' in reply) return reply
  if (reply.device) return { state: 'signed-in', device: reply.device }
  if (token === undefined) return { state: 'signed-out', mode: reply.mode }
  const linkError = await postLink(env, token)
  reply = await sessionOf(env)
  if ('state' in reply) return reply
  if (reply.device) return { state: 'signed-in', device: reply.device }
  return linkError === undefined ? { state: 'signed-out', mode: reply.mode } : { state: 'signed-out', mode: reply.mode, error: linkError }
}

/** What the signed-out page says, by mode. Plain text: the page draws it as text. */
export function signedOutText(mode: WebAccessMode): string {
  switch (mode) {
    case 'link':
      return 'This browser is not signed in. On the desktop, open Settings › General › Web access and open the access link (or scan its QR code) on this device.'
    case 'password':
      return 'This browser is not signed in. Enter the web access password set on the desktop.'
    case 'confirm':
      return 'This browser is not signed in. Ask the desktop: this page shows a code, and whoever is at the desktop types it there to let this browser in.'
    case 'none':
      return 'Sign-in is off, but the host did not let this browser in. Reload the page.'
  }
}
