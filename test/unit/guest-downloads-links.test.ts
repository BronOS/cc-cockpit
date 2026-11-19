// Task 03b (design-guests §9, D-23, the `app.linkNotice` row): a `ccc download` offer keeps its Claude tab in main
// only, the router's askInfo reads it so a write guest accepts only an offer from a tab it sees, and a link notice
// sent to one view is stamped with that view so the guest sink can pass a guest its own notices and nothing else.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { askInfoFrom, downloadOfferSource, trashAskSource } from '../../src/main/asks/guest-asks'
import { createOpenExternal } from '../../src/main/external/open-external'
import { Downloads } from '../../src/main/files/downloads'
import { IpcRouter, registerSessionHandlers, webCaller, type IpcMainLike } from '../../src/main/ipc/router'
import type { GuestService } from '../../src/main/ipc/guest-deps'
import { downloadHandler } from '../../src/main/socket/handlers'
import { ViewRegistry, type ViewSink } from '../../src/main/views/view-registry'
import type { DownloadOffer } from '../../src/shared/downloads'
import { askVisible, guestLinkNotice, type GuestFilterContext } from '../../src/shared/guest-filter'
import type { GuestOnlyAccess } from '../../src/shared/guests'
import type { IpcEventMap } from '../../src/shared/ipc'
import { remoteViewId, type GuestRole, type ViewId, type Who } from '../../src/shared/views'

const WINDOW = 7
const PROJECT = 'p1'

// ---------------------------------------------------------------------------------------------------------------
// Downloads.offerOrigin

let tmp: string
let proj: string
let sent: DownloadOffer[]

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-guest-offers-')))
  proj = join(tmp, 'proj')
  for (const d of [proj, join(tmp, 'home'), join(tmp, 'data')]) mkdirSync(d)
  writeFileSync(join(proj, 'a.txt'), 'hello')
  sent = []
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function downloads(): Downloads {
  return new Downloads({
    hooks: { start: () => true, failed: () => undefined },
    offers: {
      send: (_windowId, offer) => {
        sent.push(offer)
        return true
      },
      settled: () => undefined
    },
    hasBrowserView: () => true,
    projectPath: (id) => (id === PROJECT ? proj : undefined),
    windowOf: (id) => (id === PROJECT ? WINDOW : undefined),
    dataDir: join(tmp, 'data'),
    env: { home: join(tmp, 'home'), platform: 'linux' }
  })
}

describe('Downloads.offerOrigin (D-23)', () => {
  it("keeps a session caller's tab on the offer, main-only: never in the offer's payload", async () => {
    const d = downloads()
    const { requestId } = await d.offer({ projectId: PROJECT, windowId: WINDOW, tabId: 't1' }, join(proj, 'a.txt'))
    expect(d.offerOrigin(WINDOW, requestId)).toEqual({ originTab: 't1' })
    expect(JSON.stringify(sent)).not.toMatch(/t1|originTab/)
    expect(JSON.stringify(d.pendingOffers(WINDOW))).not.toMatch(/originTab/)
  })

  it('answers {} for an offer with no tab (a window token), undefined for another window or an unknown id', async () => {
    const d = downloads()
    const { requestId } = await d.offer({ projectId: PROJECT, windowId: WINDOW }, join(proj, 'a.txt'))
    expect(d.offerOrigin(WINDOW, requestId)).toEqual({})
    expect(d.offerOrigin(WINDOW + 1, requestId)).toBeUndefined()
    expect(d.offerOrigin(WINDOW, 'offer-999')).toBeUndefined()
  })

  it('the origin is readable during the send (a guest sink filters the live offer then), and gone when the send fails', async () => {
    const during: unknown[] = []
    const d: Downloads = new Downloads({
      hooks: { start: () => true, failed: () => undefined },
      offers: {
        send: (windowId, offer) => {
          during.push(d.offerOrigin(windowId, offer.requestId))
          return true
        },
        settled: () => undefined
      },
      hasBrowserView: () => true,
      projectPath: (id) => (id === PROJECT ? proj : undefined),
      windowOf: (id) => (id === PROJECT ? WINDOW : undefined),
      dataDir: join(tmp, 'data'),
      env: { home: join(tmp, 'home'), platform: 'linux' }
    })
    await d.offer({ projectId: PROJECT, windowId: WINDOW, tabId: 't1' }, join(proj, 'a.txt'))
    expect(during).toEqual([{ originTab: 't1' }])
    const failing: Downloads = new Downloads({
      hooks: { start: () => true, failed: () => undefined },
      offers: {
        send: (windowId, offer) => {
          during.push(failing.offerOrigin(windowId, offer.requestId))
          throw new Error('sink gone')
        },
        settled: () => undefined
      },
      hasBrowserView: () => true,
      projectPath: (id) => (id === PROJECT ? proj : undefined),
      windowOf: (id) => (id === PROJECT ? WINDOW : undefined),
      dataDir: join(tmp, 'data'),
      env: { home: join(tmp, 'home'), platform: 'linux' }
    })
    await expect(failing.offer({ projectId: PROJECT, windowId: WINDOW, tabId: 't2' }, join(proj, 'a.txt'))).rejects.toThrow()
    expect(during).toEqual([{ originTab: 't1' }, { originTab: 't2' }])
    expect(failing.pendingOffers(WINDOW)).toEqual([])
  })

  it("asks hasBrowserView with the offer's origin tab, and gives the desktop answer at once when nobody can take it", async () => {
    const asked: unknown[] = []
    let takers = true
    const d = new Downloads({
      hooks: { start: () => true, failed: () => undefined },
      offers: { send: () => true, settled: () => undefined },
      hasBrowserView: (windowId, originTab) => {
        asked.push([windowId, originTab])
        return takers
      },
      projectPath: (id) => (id === PROJECT ? proj : undefined),
      windowOf: (id) => (id === PROJECT ? WINDOW : undefined),
      dataDir: join(tmp, 'data'),
      env: { home: join(tmp, 'home'), platform: 'linux' }
    })
    // A lone read guest (no taker): refused at once, no offer made.
    takers = false
    await expect(d.offer({ projectId: PROJECT, windowId: WINDOW, tabId: 't1' }, join(proj, 'a.txt'))).rejects.toThrow(/on this computer/)
    expect(d.pendingOffers(WINDOW)).toEqual([])
    takers = true
    await d.offer({ projectId: PROJECT, windowId: WINDOW, tabId: 't1' }, join(proj, 'a.txt'))
    await d.offer({ projectId: PROJECT, windowId: WINDOW, tabId: '' }, join(proj, 'a.txt'))
    expect(asked).toEqual([[WINDOW, 't1'], [WINDOW, 't1'], [WINDOW, undefined]])
    expect(d.pendingOffers(WINDOW)).toHaveLength(2)
  })

  it('an empty tab id is no tab', async () => {
    const d = downloads()
    const { requestId } = await d.offer({ projectId: PROJECT, windowId: WINDOW, tabId: '' }, join(proj, 'a.txt'))
    expect(d.offerOrigin(WINDOW, requestId)).toEqual({})
  })

  it('a declined offer is over (undefined); an accepted one keeps its origin for a Try again', async () => {
    const d = downloads()
    const declined = await d.offer({ projectId: PROJECT, windowId: WINDOW, tabId: 't1' }, join(proj, 'a.txt'))
    d.decline(WINDOW, declined.requestId)
    await Promise.resolve()
    expect(d.offerOrigin(WINDOW, declined.requestId)).toBeUndefined()
    const accepted = await d.offer({ projectId: PROJECT, windowId: WINDOW, tabId: 't2' }, join(proj, 'a.txt'))
    await d.accept({ viewId: 'web:1', windowId: WINDOW, deviceId: 'dev' }, accepted.requestId, false)
    expect(d.offerOrigin(WINDOW, accepted.requestId)).toEqual({ originTab: 't2' })
  })

  it('the window closing ends its offers', async () => {
    const d = downloads()
    const { requestId } = await d.offer({ projectId: PROJECT, windowId: WINDOW, tabId: 't1' }, join(proj, 'a.txt'))
    d.windowClosed(WINDOW)
    expect(d.offerOrigin(WINDOW, requestId)).toBeUndefined()
  })
})

describe('the download ask source', () => {
  const guest = (role: GuestRole): GuestOnlyAccess => ({ kind: 'guest', id: 'g', name: 'G', role, projectId: PROJECT, scope: ['t1'] })
  const sees = { tabVisible: (t: string) => t === 't1', pluginVisible: () => false }
  const origins: Record<string, { originTab?: string }> = { 'offer-1': { originTab: 't1' }, 'offer-2': { originTab: 't9' }, 'offer-3': {} }
  const info = askInfoFrom([
    trashAskSource({ pluginOf: () => undefined }),
    downloadOfferSource({ offerOrigin: (w, r) => (w === WINDOW ? origins[r] : undefined) })
  ])

  it("names the kind and the origin tab, and askVisible lets only a write guest seeing that tab", () => {
    const a = info(WINDOW, 'offer-1')
    expect(a).toEqual({ kind: 'download', info: { originTab: 't1' } })
    expect(askVisible(a!.kind, a!.info, guest('write'), sees)).toBe(true)
    expect(askVisible(a!.kind, a!.info, guest('read'), sees)).toBe(false)
    const hidden = info(WINDOW, 'offer-2')!
    expect(askVisible(hidden.kind, hidden.info, guest('write'), sees)).toBe(false)
    const none = info(WINDOW, 'offer-3')!
    expect(none.kind).toBe('download')
    expect(askVisible(none.kind, none.info, guest('write'), sees)).toBe(false)
    expect(info(WINDOW + 1, 'offer-1')).toBeUndefined()
  })
})

describe('the download socket handler passes the tab main resolved', () => {
  it("a session token's tab, never one from args; a window token none", async () => {
    const calls: unknown[] = []
    const handler = downloadHandler({
      windowIdOf: () => WINDOW,
      offer: async (caller) => {
        calls.push(caller)
        return { text: 'ok' }
      }
    })
    const signal = new AbortController().signal
    await handler({ path: '/p/a', tabId: 'forged' }, { kind: 'session', tabId: 't1', projectId: PROJECT }, signal)
    await handler({ path: '/p/a', tabId: 'forged' }, { kind: 'window', projectId: PROJECT }, signal)
    expect(calls).toEqual([
      { projectId: PROJECT, windowId: WINDOW, tabId: 't1' },
      { projectId: PROJECT, windowId: WINDOW }
    ])
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The router: downloads.accept / downloads.answer from a guest, through askInfo with the real source

class FakeIpcMain implements IpcMainLike {
  handle(): void {}
}

describe('a guest answering a download offer (router, D-23)', () => {
  function setup() {
    const router = new IpcRouter(
      new FakeIpcMain(),
      () => undefined,
      () => true,
      () => undefined,
      (w, p) => w === WINDOW && p === PROJECT
    )
    const roles: Record<string, GuestRole> = { gR: 'read', gW: 'write' }
    const guests = {
      access: (who: Who) =>
        who === 'owner'
          ? { kind: 'owner' }
          : roles[who.guest]
            ? { kind: 'guest', id: who.guest, name: who.guest, role: roles[who.guest], projectId: PROJECT, scope: ['t1'] }
            : { kind: 'revoked' },
      tabVisible: (_g: string, tabId: string) => tabId === 't1',
      pluginVisible: () => false
    } as unknown as GuestService
    const origins: Record<string, { originTab?: string }> = { 'offer-1': { originTab: 't1' }, 'offer-2': { originTab: 't9' }, 'offer-3': {} }
    router.setGuestDeps({
      guests,
      askInfo: askInfoFrom([downloadOfferSource({ offerOrigin: (w, r) => (w === WINDOW ? origins[r] : undefined) })])
    })
    const accepted: unknown[][] = []
    const declined: unknown[][] = []
    registerSessionHandlers(
      router,
      new Proxy(
        {
          downloadAccept: async (...args: unknown[]) => {
            accepted.push(args)
            return true
          },
          downloadDecline: (...args: unknown[]) => {
            declined.push(args)
            return true
          }
        } as Record<string, unknown>,
        { get: (t, k) => (typeof k === 'string' && k in t ? t[k] : k === 'then' ? undefined : () => undefined) }
      ) as never
    )
    const caller = (id: string) => webCaller({ kind: 'project', windowId: WINDOW, projectId: PROJECT }, 'web:5', { guest: id })
    return { router, caller, accepted, declined }
  }

  it('a write guest accepts and declines an offer from a tab it sees', async () => {
    const { router, caller, accepted, declined } = setup()
    await expect(router.dispatch(caller('gW'), 'downloads.accept', { requestId: 'offer-1', all: false })).resolves.toBe(true)
    await expect(router.dispatch(caller('gW'), 'downloads.answer', { requestId: 'offer-1' })).resolves.toBe(true)
    expect(accepted).toEqual([[WINDOW, 'web:5', 'offer-1', false]])
    expect(declined).toEqual([[WINDOW, 'offer-1']])
  })

  it('never an offer from a hidden tab or from no tab, an unknown one, or from a read guest', async () => {
    const { router, caller, accepted, declined } = setup()
    for (const [id, requestId] of [
      ['gW', 'offer-2'],
      ['gW', 'offer-3'],
      ['gW', 'offer-9'],
      ['gR', 'offer-1']
    ] as const) {
      await expect(router.dispatch(caller(id), 'downloads.accept', { requestId, all: false })).rejects.toThrow(/refused/)
      await expect(router.dispatch(caller(id), 'downloads.answer', { requestId })).rejects.toThrow(/refused/)
    }
    expect(accepted).toEqual([])
    expect(declined).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Link notices: stamped with the asking view; the guest sink passes only its own

class Sink implements ViewSink {
  payloads: Array<IpcEventMap['app.linkNotice']> = []
  send(channel: string, payload: unknown): void {
    if (channel === 'app.linkNotice') this.payloads.push(payload as IpcEventMap['app.linkNotice'])
  }
  isClosed(): boolean {
    return false
  }
}

describe('link notices for guests', () => {
  const OWNER_VIEW = remoteViewId(1)
  const GUEST_VIEW = remoteViewId(2)
  function setup(server: boolean) {
    const views = new ViewRegistry({ windowIdOf: () => undefined, log: () => undefined })
    const desk = new Sink()
    const owner = new Sink()
    const guestSink = new Sink()
    views.addDesktop(1, desk)
    views.addRemote(1, OWNER_VIEW, owner, 'owner')
    views.addRemote(1, GUEST_VIEW, guestSink, { guest: 'g' })
    const system: string[] = []
    const open = createOpenExternal({
      server,
      system: async (url) => void system.push(url),
      views,
      log: () => undefined
    })
    return { open, owner, guestSink, system }
  }
  // What the guest sink does with each notice its view is sent (shared/guest-filter.ts guestLinkNotice).
  const forGuest = (viewId: ViewId, notices: Array<IpcEventMap['app.linkNotice']>) =>
    notices.map((n) => guestLinkNotice(n, { viewId } as GuestFilterContext)).filter((n) => n !== undefined)

  for (const server of [false, true]) {
    it(`${server ? 'server' : 'desktop'}: the asking view's notice carries its id, and its guest gets it`, async () => {
      const { open, guestSink, owner } = setup(server)
      await open('https://example.com/a', { windowId: 1, viewId: GUEST_VIEW })
      await open('https://example.com/p', { windowId: 1, viewId: GUEST_VIEW }, { page: true })
      expect(guestSink.payloads).toEqual([
        { url: 'https://example.com/a', to: GUEST_VIEW },
        { url: 'https://example.com/p', page: true, to: GUEST_VIEW }
      ])
      expect(owner.payloads).toEqual([])
      expect(forGuest(GUEST_VIEW, guestSink.payloads)).toHaveLength(2)
    })
  }

  it('server: a broadcast (no browser asked) has no `to`, so the guest sink drops it; the owner view gets it', async () => {
    const { open, guestSink, owner } = setup(true)
    await open('https://example.com/b', { windowId: 1 })
    expect(owner.payloads).toEqual([{ url: 'https://example.com/b' }])
    expect(guestSink.payloads).toEqual([{ url: 'https://example.com/b' }])
    expect(forGuest(GUEST_VIEW, guestSink.payloads)).toEqual([])
  })

  it("server: a sign-in's notice is never a guest's, even stamped for its view", async () => {
    const { open, guestSink } = setup(true)
    await open('https://example.com/s', { windowId: 1, viewId: GUEST_VIEW }, { signIn: 'S'.repeat(22) })
    expect(guestSink.payloads).toEqual([{ url: 'https://example.com/s', signIn: 'S'.repeat(22), to: GUEST_VIEW }])
    expect(forGuest(GUEST_VIEW, guestSink.payloads)).toEqual([])
  })

  it("a notice stamped for another view never passes a guest's filter", () => {
    expect(forGuest(GUEST_VIEW, [{ url: 'https://example.com/o', to: OWNER_VIEW }])).toEqual([])
  })
})
