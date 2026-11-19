// One kick, everything of the guest gone (spec-review item 30, design-guests §14; task 07b). The order is
// the guarantee: the guest's views close 4460 first (each view's end runs `viewGone`, which index.ts hands
// to the panel port relays and the webview viewers: guest-wiring.test.ts holds that wiring), then its
// device is revoked and the gateway cuts its plugin page tokens and its downloads (a running `/d/` stream
// included). Real GuestStore, DeviceStore, WebAuth, WebGateway, ViewRegistry and WebConnections; fakes only
// for the sockets and the gateway's page-token and download routes. The e2e (guest-gateway.spec.ts) times
// the same kick on a raw client: the close within 1 s of the reply and nothing after it.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { fakeSecretStore } from '../../src/main/secrets/secret-store'
import { ViewRegistry } from '../../src/main/views/view-registry'
import { AccessLog } from '../../src/main/web/access-log'
import { WebAuth } from '../../src/main/web/auth'
import { WebConnections, type WsLike } from '../../src/main/web/connection'
import { DeviceStore, type WebDevice } from '../../src/main/web/devices'
import { WebGateway } from '../../src/main/web/gateway'
import { guestContext } from '../../src/main/web/guest-events'
import { GuestStore } from '../../src/main/web/guests'
import { defaultLayout } from '../../src/shared/layout'
import { parseInviteFragment, PROTOCOL_VERSION, CLOSE } from '../../src/shared/web-protocol'

class FakeWs implements WsLike {
  readyState = 1
  bufferedAmount = 0
  readonly sent: Array<Record<string, unknown>> = []
  closedWith: { code: number; reason: string } | undefined
  private onMessage: ((data: unknown, isBinary: boolean) => void) | undefined
  private onClose: (() => void) | undefined
  constructor(private readonly events: string[]) {}
  send(data: string | Uint8Array): void {
    if (typeof data === 'string') this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(code = 1000, reason = ''): void {
    if (this.readyState !== 1) return
    this.readyState = 3
    this.closedWith = { code, reason }
    this.events.push(`close ${code}`)
    this.onClose?.()
  }
  on(event: 'message' | 'close', listener: (...args: never[]) => void): unknown {
    if (event === 'message') this.onMessage = listener as (data: unknown, isBinary: boolean) => void
    else this.onClose = listener as () => void
    return this
  }
  feed(frame: unknown): void {
    this.onMessage?.(Buffer.from(JSON.stringify(frame)), false)
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccc-guest-kick-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('a kick closes the guest views 4460 (their viewGone runs), then revokes the device: page tokens and downloads cut; the owner untouched', async () => {
  const events: string[] = []
  const accessLog = new AccessLog()
  const devices = new DeviceStore({ filePath: join(dir, 'web-access.json'), accessLog })
  const auth = new WebAuth({ devices, secrets: fakeSecretStore(), accessLog })
  // Never started: its constructor's revoke listener is the part under test.
  new WebGateway({
    log: () => {},
    auth,
    accessLog,
    pages: { tokens: { dropDevice: (id: string) => events.push(`page tokens ${id}`) } } as never,
    downloads: {
      dropDevice: (id: string) => {
        events.push(`downloads ${id}`)
        return 1
      },
      dropAll: () => 0,
      serve: () => undefined,
      refuse: () => undefined
    } as never
  })
  const windows = new Map([['p1', 1]])
  const views = new ViewRegistry({ windowIdOf: (projectId) => windows.get(projectId) })
  // eslint-disable-next-line prefer-const -- the store and the connections need each other
  let store: GuestStore
  const conns: WebConnections = new WebConnections({
    dispatch: async () => undefined,
    addView: (windowId, viewId, sink, who) => views.addRemote(windowId, viewId, sink, who),
    windowIdOf: (projectId) => windows.get(projectId),
    snapshot: () => ({ tabs: [{ id: 't1' } as never], layout: { layout: defaultLayout(), panels: [] }, overlays: [], closeAsks: [], linkAsks: [] }) as never,
    mirror: { join: () => undefined },
    hasTab: () => true,
    guests: {
      access: (who) => store.access(who),
      context: (viewId, access) =>
        guestContext({ guests: store, overlayVisible: () => false, personOf: () => undefined, tabOrder: () => ['t1'], ownerName: () => 'Host' }, viewId, access),
      viewsChanged: (id, live) => store.viewsChanged(id, live)
    },
    viewGone: (viewId) => events.push(`viewGone ${viewId}`),
    log: () => {},
    helloTimeoutMs: 50
  })
  store = new GuestStore({
    devices,
    accessLog,
    mode: () => 'link',
    target: () => ({ origin: 'https://box.example:7330', loopbackOnly: false }),
    pluginShown: () => false,
    tabOf: (id) => (id === 't1' ? { projectId: 'p1' } : undefined),
    whoOfView: (v) => views.whoOf(v),
    closeGuestViews: (guestId, code, reason) => conns.closeGuest(guestId, code, reason),
    guestLive: (id) => conns.guestLive(id),
    dropPageTokens: (id) => events.push(`store page tokens ${id}`),
    notify: () => {},
    log: () => {},
    setInterval: () => ({ stop: () => {} })
  })

  const invite = await store.invite('p1', { name: 'Bob', role: 'write', scope: 'all', lifetime: 'forever' })
  if (!invite.ok) throw new Error(invite.error)
  const redeemed = store.redeem({ token: parseInviteFragment(new URL(invite.link).hash)?.token }, { ownerDevice: false })
  if (!redeemed.ok) throw new Error(redeemed.error)
  const guestDevice = devices.list().find((d) => d.id === redeemed.device.id) as WebDevice
  const ownerDevice: WebDevice = { id: 'owner-dev', name: 'Mine', createdAt: 0, lastSeenAt: 0, mode: 'link' }

  const connect = (device: WebDevice): FakeWs => {
    const ws = new FakeWs(events)
    conns.accept(ws, device)
    ws.feed({ t: 'hello', v: PROTOCOL_VERSION, project: 'p1' })
    return ws
  }
  const guestA = connect(guestDevice)
  const guestB = connect(guestDevice)
  const owner = connect(ownerDevice)
  expect([guestA, guestB, owner].map((ws) => ws.sent[0]?.t)).toEqual(['ready', 'ready', 'ready'])
  const guestViews = [guestA, guestB].map((ws) => String(ws.sent[0]?.view))
  expect(guestViews.map((v) => views.whoOf(v))).toEqual([{ guest: invite.guestId }, { guest: invite.guestId }])
  events.length = 0

  expect(store.kick(invite.guestId)).toBe(true)

  expect(guestA.closedWith?.code).toBe(CLOSE.kicked)
  expect(guestB.closedWith?.code).toBe(CLOSE.kicked)
  expect(owner.closedWith).toBeUndefined()
  const id = guestDevice.id
  // Every view's own end ran (relays, viewers) before the device went; then the gateway cut the rest.
  const lastClose = Math.max(...events.map((e, i) => (e.startsWith('close') || e.startsWith('viewGone') ? i : -1)))
  const firstCut = events.findIndex((e) => e.startsWith('page tokens') || e.startsWith('downloads'))
  expect(events.filter((e) => e.startsWith('viewGone')).sort()).toEqual(guestViews.map((v) => `viewGone ${v}`).sort())
  expect(events).toContain(`page tokens ${id}`)
  expect(events).toContain(`downloads ${id}`)
  expect(lastClose).toBeLessThan(firstCut)
  expect(devices.list().some((d) => d.id === id)).toBe(false)
  expect(store.access({ guest: invite.guestId })).toEqual({ kind: 'revoked' })
  // The cookie is a tombstone (D-32): a fresh connect of that device is refused before any frame.
  const again = new FakeWs(events)
  conns.accept(again, guestDevice)
  again.feed({ t: 'hello', v: PROTOCOL_VERSION, project: 'p1' })
  expect(again.sent.some((f) => f.t === 'ready')).toBe(false)
  expect(again.closedWith?.code).toBe(CLOSE.accessEnded)
})
