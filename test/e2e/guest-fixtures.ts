// Guest e2e helpers (design-guests, task 07b): make a guest through the invite dialog's own service
// (`__ccTest.guestInvite`, src/main/index.ts), redeem its link as a plain HTTP client would, and hold a
// raw socket that records every frame, the close code and when it closed. A raw client is the one way to
// time "out within 1 s" (spec-review item 30): a page reconnects and hides it.
import { expect } from '@playwright/test'
import { WebSocket } from 'ws'
import type { GuestInviteAnswer, GuestInviteRequest, GuestView } from '../../src/shared/guests'
import {
  DEVICE_KEY_HEADER,
  INVITE_PATH,
  parseInviteFragment,
  PROTOCOL_VERSION,
  SESSION_PATH,
  socketProtocols,
  WS_PATH,
  type WebSessionReply
} from '../../src/shared/web-protocol'
import type { Cockpit } from './fixtures'

export interface Invited {
  link: string
  /** The link's fragment token (the only secret in it). */
  token: string
  inviteId: string
  guestId: string
  warning?: string
}

/** An invite for the cockpit's own project, through GuestStore.invite (the dialog's service). */
export async function inviteGuest(
  cockpit: Cockpit,
  req: Partial<GuestInviteRequest> & { name: string },
  projectDir: string = cockpit.projectDir
): Promise<Invited> {
  const answer = await cockpit.hook<GuestInviteAnswer>('guestInvite', projectDir, { role: 'read', scope: 'all', lifetime: '1d', ...req })
  if (!answer.ok) throw new Error(`invite refused: ${answer.error}`)
  const fragment = parseInviteFragment(answer.link.slice(answer.link.indexOf('#')))
  if (!fragment) throw new Error(`not an invite link: ${answer.link}`)
  return { link: answer.link, token: fragment.token, inviteId: answer.inviteId, guestId: answer.guestId, ...(answer.warning ? { warning: answer.warning } : {}) }
}

export const guestList = (cockpit: Cockpit): Promise<GuestView[]> => cockpit.hook<GuestView[]>('guests')

/** A redeemed guest device as a client holds it: the cookie pair and the origin key. */
export interface GuestClient {
  origin: string
  cookie: string
  key: string
  project: string
}

export interface Redeemed {
  status: number
  body: Record<string, unknown>
  client?: GuestClient
}

/** `POST /auth/invite` as the guest page sends it (sign-in.ts redeemInvite), with the gateway's own Origin. */
export async function redeem(origin: string, token: string, cookie?: string): Promise<Redeemed> {
  const res = await fetch(`${origin}${INVITE_PATH}`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ token })
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (res.status !== 200 || body.ok !== true) return { status: res.status, body }
  const set = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  return { status: res.status, body, client: { origin, cookie: set, key: String(body.key), project: String(body.project) } }
}

/** Redeems and insists it worked. */
export async function redeemOk(origin: string, token: string): Promise<GuestClient> {
  const r = await redeem(origin, token)
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return r.client!
}

export interface Answer {
  status: number
  type: string
  body: string
}

/** A GET as the guest's page makes it (keyed fetch: cookie plus the origin key header). */
export async function guestGet(client: GuestClient, path: string): Promise<Answer> {
  const res = await fetch(`${client.origin}${path}`, {
    headers: { Origin: client.origin, Cookie: client.cookie, [DEVICE_KEY_HEADER]: client.key },
    redirect: 'manual'
  })
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() }
}

export async function session(client: GuestClient): Promise<WebSessionReply> {
  const a = await guestGet(client, SESSION_PATH)
  return JSON.parse(a.body) as WebSessionReply
}

export interface Closed {
  code: number
  reason: string
  /** Date.now() when the close arrived. */
  at: number
}

export interface RawSocket {
  /** Every frame received, parsed, in order. */
  frames: Array<Record<string, unknown>>
  /** Raw text of every frame (a marker search reads these). */
  texts: string[]
  closed: Promise<Closed>
  /** Resolves with the first frame `pick` accepts (waits for later ones). */
  next(pick: (f: Record<string, unknown>) => boolean, timeout?: number): Promise<Record<string, unknown>>
  ws: WebSocket
  close(): void
}

/** Opens `/ws` as the guest (cookie and key as a page offers them) and says `hello` for `project`. */
export async function rawSocket(client: GuestClient, project: string = client.project): Promise<RawSocket> {
  const url = `ws${client.origin.slice('http'.length)}${WS_PATH}`
  const ws = new WebSocket(url, socketProtocols(client.key), { origin: client.origin, headers: { Cookie: client.cookie } })
  const frames: Array<Record<string, unknown>> = []
  const texts: string[] = []
  const waiters: Array<{ pick: (f: Record<string, unknown>) => boolean; resolve: (f: Record<string, unknown>) => void }> = []
  ws.on('message', (data, binary) => {
    if (binary) return
    const text = data.toString()
    texts.push(text)
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(text) as Record<string, unknown>
    } catch {
      return
    }
    frames.push(frame)
    for (const w of [...waiters]) {
      if (w.pick(frame)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(frame)
      }
    }
  })
  const closed = new Promise<Closed>((resolve) => {
    ws.on('close', (code, reason) => {
      resolve({ code, reason: reason.toString(), at: Date.now() })
    })
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
    ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)))
  })
  ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, project }))
  return {
    frames,
    texts,
    closed,
    ws,
    close: () => ws.close(),
    next: (pick, timeout = 10_000) => {
      const seen = frames.find(pick)
      if (seen) return Promise.resolve(seen)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no such frame in time')), timeout)
        waiters.push({ pick, resolve: (f) => (clearTimeout(timer), resolve(f)) })
      })
    }
  }
}

/** Whether an upgrade is refused before any frame (the gateway's answer to an ended guest). */
export async function upgradeRefused(client: GuestClient): Promise<boolean> {
  try {
    const s = await rawSocket(client)
    const c = await Promise.race([s.closed, new Promise<undefined>((r) => setTimeout(() => r(undefined), 3000))])
    s.close()
    return c !== undefined && s.frames.every((f) => f.t !== 'ready')
  } catch {
    return true
  }
}
