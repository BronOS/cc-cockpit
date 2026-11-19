// The web client's guest flow (design-guests §3, §10, §16.4; D-29, D-32): the invite redeem in the
// sign-in step (renderer/web/sign-in.ts), its page texts and the guest's landing
// (renderer/web/guest-pages-model.ts), and the access a plugin page's port message carries
// (renderer/web/port-relay.ts withAccess).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PORT_MESSAGE } from '../../src/sdk/panel-core'
import { markWebShell, resetShellKindForTest, setGuestHint } from '../../src/renderer/shell-kind'
import {
  DEFAULT_OWNER_NAME,
  GUEST_ENDED_TEXT,
  guestGoneText,
  inviteErrorOf,
  inviteErrorText,
  landingOf,
  reconnectNotice
} from '../../src/renderer/web/guest-pages-model'
import { FrameLoads, PortRelay, relayHandleOf, withAccess } from '../../src/renderer/web/port-relay'
import { redeemInvite, sessionReplyOf, signIn, type SignInEnv } from '../../src/renderer/web/sign-in'
import { CLOSE, INVITE_PATH, SESSION_PATH, SIGN_IN_LINK_PATH, type WebInviteError } from '../../src/shared/web-protocol'

const TOKEN = 'A'.repeat(42) + '_'
const PIN = 'ab'.repeat(32)
const KEY = 'k'.repeat(43)
const GUEST = { name: 'Bob', role: 'write', project: 'p-bob' } as const

type Answer = { status: number; body: unknown } | 'throw'

/** A sign-in env whose session answers come in order (the last one repeats), and the redeem's answer. */
function env(o: { hash?: string; search?: string; session?: Answer | Answer[]; invite?: Answer; link?: Answer }) {
  const sessions = Array.isArray(o.session) ? [...o.session] : [o.session ?? { status: 200, body: { mode: 'link', device: null } }]
  const order: string[] = []
  const urls: string[] = []
  const keys: string[] = []
  const calls: Array<{ url: string; body?: unknown }> = []
  const answer = (a: Answer | undefined) => {
    if (a === undefined || a === 'throw') return Promise.reject(new Error('net'))
    return Promise.resolve({ ok: a.status >= 200 && a.status < 300, status: a.status, json: () => Promise.resolve(a.body) })
  }
  const e: SignInEnv = {
    location: { hash: o.hash ?? '', pathname: '/', search: o.search ?? '' },
    replaceUrl: (url) => {
      order.push('replace')
      urls.push(url)
    },
    fetch: (url, init) => {
      order.push(url)
      calls.push({ url, ...(init?.body !== undefined ? { body: JSON.parse(init.body) as unknown } : {}) })
      if (url === SESSION_PATH) return answer(sessions.length > 1 ? sessions.shift() : sessions[0])
      if (url === INVITE_PATH) return answer(o.invite)
      if (url === SIGN_IN_LINK_PATH) return answer(o.link)
      return answer(undefined)
    },
    userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36',
    storeKey: (key) => {
      order.push('store key')
      keys.push(key)
    }
  }
  return { env: e, order, urls, keys, calls }
}

const signedOut: Answer = { status: 200, body: { mode: 'link', device: null } }
const guestIn: Answer = { status: 200, body: { mode: 'link', device: { id: 'g1', name: 'Chrome on Android' }, guest: GUEST } }
const ended: Answer = { status: 200, body: { mode: 'link', device: null, guestEnded: true } }
const redeemed: Answer = { status: 200, body: { ok: true, key: KEY, device: { id: 'g1', name: 'n' }, project: 'p-bob' } }

describe('the invite redeem', () => {
  it('clears the fragment before any request, posts the token alone, keeps the key and opens the project', async () => {
    const s = env({ hash: `#i=${TOKEN}`, search: '', invite: redeemed })
    expect(await signIn(s.env)).toEqual({ state: 'redeemed', project: 'p-bob' })
    expect(s.urls).toEqual(['/'])
    // Posted whatever the session would say: no session ask before it (a guest may redeem a new grant).
    expect(s.order).toEqual(['replace', INVITE_PATH, 'store key'])
    expect(s.calls[0]!.body).toEqual({ token: TOKEN })
    expect(s.keys).toEqual([KEY])
  })

  it("ignores the certificate pin (the guest's own app reads it, D-29) and keeps the query", async () => {
    const s = env({ hash: `#i=${TOKEN}&c=${PIN}`, search: '?project=x', invite: redeemed })
    expect(await signIn(s.env)).toEqual({ state: 'redeemed', project: 'p-bob' })
    expect(s.urls).toEqual(['/?project=x'])
    expect(s.calls[0]!.body).toEqual({ token: TOKEN })
  })

  it.each<[WebInviteError, number, string]>([
    ['used', 410, 'This invite was already used. Ask the host for a new one.'],
    ['owner-device', 409, 'This browser is signed in as the host. Open the invite in a private window.'],
    ['expired', 410, 'expired'],
    ['invalid', 404, 'does not work'],
    ['none-mode', 409, 'sign-in is off'],
    ['busy', 429, 'Too many tries'],
    ['full', 503, 'too many devices'],
    ['bad-request', 400, 'broken']
  ])('%s is told as plain page text, never the gateway\'s own text', async (error, status, text) => {
    const s = env({ hash: `#i=${TOKEN}`, invite: { status, body: { ok: false, error } }, session: signedOut })
    const state = await signIn(s.env)
    expect(state).toEqual({ state: 'invite-failed', text: expect.stringContaining(text) as string })
    expect(s.keys).toEqual([])
    expect(s.urls).toEqual(['/'])
  })

  it('an unknown error code, a junk answer or a 200 without key or project get the generic text', async () => {
    for (const invite of [
      { status: 500, body: { ok: false, error: '<b>owned</b>' } },
      { status: 502, body: 'gateway' },
      { status: 200, body: { ok: true, project: 'p' } },
      { status: 200, body: { ok: true, key: KEY, project: '' } }
    ]) {
      const s = env({ hash: `#i=${TOKEN}`, invite })
      expect(await signIn(s.env)).toEqual({ state: 'invite-failed', text: inviteErrorText(undefined) })
      expect(s.keys).toEqual([])
    }
  })

  it('a redeem that gets no answer says so', async () => {
    const r = await redeemInvite(env({ invite: 'throw' }).env, TOKEN)
    expect(r).toMatchObject({ ok: false, error: undefined, text: expect.stringContaining('did not answer') as string })
  })

  it('a broken invite fragment is told as a broken invite, without a request, and still cleared', async () => {
    for (const hash of ['#i=short', `#i=${TOKEN}&i=${TOKEN}`, `#i=${TOKEN}&x=1`]) {
      const s = env({ hash })
      expect(await signIn(s.env)).toEqual({ state: 'invite-failed', text: inviteErrorText('bad-request') })
      expect(s.urls).toEqual(['/'])
      expect(s.calls).toEqual([])
    }
  })

  it('a signed-in guest re-opening its spent invite goes on to its project; anyone else sees "used"', async () => {
    const used: Answer = { status: 410, body: { ok: false, error: 'used' } }
    const g = env({ hash: `#i=${TOKEN}`, invite: used, session: guestIn })
    expect(await signIn(g.env)).toEqual({ state: 'signed-in', device: { id: 'g1', name: 'Chrome on Android' }, guest: GUEST })
    expect(g.order).toEqual(['replace', INVITE_PATH, SESSION_PATH])
    const o = env({ hash: `#i=${TOKEN}`, invite: used, session: { status: 200, body: { mode: 'link', device: { id: 'd', name: 'n' } } } })
    expect(await signIn(o.env)).toEqual({ state: 'invite-failed', text: inviteErrorText('used') })
  })

  it('maps every error code and nothing else', () => {
    expect(inviteErrorOf('used')).toBe('used')
    expect(inviteErrorOf('USED')).toBeUndefined()
    expect(inviteErrorOf('__proto__')).toBeUndefined()
    expect(inviteErrorOf(undefined)).toBeUndefined()
  })
})

describe('a guest session', () => {
  it('the session answer carries the guest, checked; a malformed guest makes the answer malformed', () => {
    expect(sessionReplyOf({ mode: 'link', device: { id: 'g', name: 'n' }, guest: GUEST })).toEqual({ mode: 'link', device: { id: 'g', name: 'n' }, guest: GUEST })
    expect(sessionReplyOf({ mode: 'link', device: { id: 'g', name: 'n' }, guest: { ...GUEST, role: 'owner' } })).toBeUndefined()
    expect(sessionReplyOf({ mode: 'link', device: { id: 'g', name: 'n' }, guest: { ...GUEST, project: '' } })).toBeUndefined()
    expect(sessionReplyOf({ mode: 'link', device: { id: 'g', name: 'n' }, guest: null })).toBeUndefined()
    expect(sessionReplyOf({ mode: 'link', device: null, guestEnded: true })).toEqual({ mode: 'link', device: null, guestEnded: true })
    expect(sessionReplyOf({ mode: 'link', device: null, guestEnded: 'yes' })).toEqual({ mode: 'link', device: null })
  })

  it('a signed-in guest is signed in as the guest', async () => {
    expect(await signIn(env({ session: guestIn }).env)).toEqual({ state: 'signed-in', device: { id: 'g1', name: 'Chrome on Android' }, guest: GUEST })
  })

  it("an ended guest's cookie gets the ended page, never the owner's sign-in", async () => {
    const s = env({ session: ended })
    expect(await signIn(s.env)).toEqual({ state: 'guest-ended' })
    expect(s.calls.map((c) => c.url)).toEqual([SESSION_PATH])
  })

  it("an owner's access link opened on an ended guest's browser is still the owner's sign-in", async () => {
    const s = env({
      hash: '#t=tok',
      session: [ended, { status: 200, body: { mode: 'link', device: { id: 'd1', name: 'n' } } }],
      link: { status: 200, body: { device: { id: 'd1', name: 'n' }, key: KEY } }
    })
    expect(await signIn(s.env)).toEqual({ state: 'signed-in', device: { id: 'd1', name: 'n' } })
    expect(s.order).toEqual(['replace', SESSION_PATH, SIGN_IN_LINK_PATH, 'store key', SESSION_PATH])
  })
})

describe('landing (D-32)', () => {
  it('a guest goes to its own project from / or any other project; there it gets the shell', () => {
    expect(landingOf(GUEST, '')).toEqual({ go: 'redirect', href: '?project=p-bob' })
    expect(landingOf(GUEST, 'other')).toEqual({ go: 'redirect', href: '?project=p-bob' })
    expect(landingOf(GUEST, 'p-bob')).toEqual({ go: 'shell' })
  })

  it('the owner keeps the picker at / and the shell with a project', () => {
    expect(landingOf(undefined, '')).toEqual({ go: 'picker' })
    expect(landingOf(undefined, 'p1')).toEqual({ go: 'shell' })
  })
})

describe('guest texts', () => {
  it('close pages name the owner, or the default before any snapshot', () => {
    expect(guestGoneText(CLOSE.kicked, 'Oleg')).toBe('Oleg removed you.')
    expect(guestGoneText(CLOSE.kicked, undefined)).toBe(`${DEFAULT_OWNER_NAME} removed you.`)
    expect(guestGoneText(CLOSE.accessEnded, 'Oleg')).toBe('Your access ended.')
    expect(guestGoneText(CLOSE.noProject, 'Oleg')).toBeUndefined()
    expect(GUEST_ENDED_TEXT).toBe('Your guest access ended. Ask the host for a new invite.')
  })

  it("the role switch's line waits for the new ready and names the new role; no line after any other reconnect", () => {
    expect(reconnectNotice(CLOSE.roleChanged, { role: 'write', ownerName: 'Oleg' })).toBe('Oleg made you a write guest.')
    expect(reconnectNotice(CLOSE.roleChanged, { role: 'read', ownerName: 'Oleg' })).toBe('Oleg made you a read-only guest.')
    expect(reconnectNotice(CLOSE.accessChanged, { role: 'read', ownerName: 'Oleg' })).toBeUndefined()
    expect(reconnectNotice(undefined, { role: 'read', ownerName: 'Oleg' })).toBeUndefined()
    expect(reconnectNotice(CLOSE.roleChanged, undefined)).toBeUndefined()
  })
})

describe("a plugin page's port message carries the view's access", () => {
  afterEach(() => resetShellKindForTest())

  it('owner on the desktop and in an owner browser, the role in a guest browser; a new object each time', () => {
    const msg = Object.freeze({ type: PORT_MESSAGE, remote: true })
    expect(withAccess(msg)).toEqual({ type: PORT_MESSAGE, remote: true, access: 'owner' })
    markWebShell()
    setGuestHint({ id: 'g1', name: 'Bob', role: 'read', ownerName: 'Host' })
    expect(withAccess(msg)).toEqual({ type: PORT_MESSAGE, remote: true, access: 'read' })
    expect(msg).toEqual({ type: PORT_MESSAGE, remote: true })
  })

  it("an inline overlay's port message is left as it is", () => {
    const overlay = { type: 'cc-overlay.port' }
    expect(withAccess(overlay, 'read')).toBe(overlay)
  })
})

describe('ports for guests', () => {
  afterEach(() => resetShellKindForTest())
  /** Lets MessagePort deliveries (macrotasks in Node) run. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

  it("FrameLoads hands a plugin page its port with the view's access", () => {
    markWebShell()
    setGuestHint({ id: 'g1', name: 'Bob', role: 'write', ownerName: 'Host' })
    const posts: unknown[] = []
    const ch = new MessageChannel()
    const l = new FrameLoads({
      target: { load: () => undefined, remount: () => undefined, post: (m) => (posts.push(m), true) },
      guard: false,
      portMessage: Object.freeze({ type: PORT_MESSAGE, remote: true }),
      connect: (deliver) => {
        deliver(ch.port1)
        return () => undefined
      }
    })
    l.loaded(0)
    expect(posts).toEqual([{ type: PORT_MESSAGE, remote: true, access: 'write' }])
    ch.port2.close()
    ch.port1.close()
  })

  it("a one-way port (D-17) relays main to page only: the page's messages are dropped, logged once", async () => {
    const ports: MessagePort[] = []
    const sent: unknown[] = []
    const r = new PortRelay({ send: (f) => (sent.push(f), true), deliver: (_k, _n, port) => (ports.push(port), true) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    r.open('a/b', 1, true)
    const got: unknown[] = []
    ports[0]!.onmessage = (e: MessageEvent) => got.push(e.data)
    r.message('a/b', 1, '"down"')
    ports[0]!.postMessage('"up"')
    ports[0]!.postMessage('"again"')
    await settle()
    expect(got).toEqual(['"down"'])
    expect(sent).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
    // Its end still tells main (the page's port went away), as any port's.
    relayHandleOf(ports[0]!)!.release()
    expect(sent).toEqual([{ t: 'port.close', key: 'a/b', nonce: 1 }])
    warn.mockRestore()
    ports[0]!.close()
  })

  it('a two-way port still sends what the page posts', async () => {
    const ports: MessagePort[] = []
    const sent: unknown[] = []
    const r = new PortRelay({ send: (f) => (sent.push(f), true), deliver: (_k, _n, port) => (ports.push(port), true) })
    r.open('a/b', 1)
    ports[0]!.postMessage('"up"')
    await settle()
    expect(sent).toEqual([{ t: 'port.msg', key: 'a/b', nonce: 1, m: '"up"' }])
    r.closeAll()
    ports[0]!.close()
  })
})
