// Task 03 (design-guests §4, spec-review 1-16): the router's guest gate over every invoke channel, the guest tab
// handlers (D-3, D-9, D-14, D-21), the trash rule (D-10), the guest list handlers (D-11 widening) and, through a
// router that only captures handlers, the second-line `isOwner` of each server-mode `adapted` site.
import { describe, expect, it } from 'vitest'
import {
  guestCall,
  IpcRouter,
  isOwner,
  registerCoreHandlers,
  registerGuestHandlers,
  registerNoticeHandlers,
  registerOAuthPasteHandlers,
  registerSessionHandlers,
  registerSettingsHandlers,
  registerSlotHandlers,
  registerTabHandlers,
  registerWebAccessHandlers,
  webCaller,
  type CallView,
  type GuestRouterDeps,
  type IpcEventLike,
  type IpcMainLike,
  type SlotHandlerDeps,
  type TabHandlerDeps
} from '../../src/main/ipc/router'
import { registerRoomStripHandlers, registerRoomViewHandlers } from '../../src/main/ipc/room-handlers'
import type { GuestService } from '../../src/main/ipc/guest-deps'
import { GUEST_CLASS, guestClassOf, guestRoleAllows, type GuestTarget } from '../../src/shared/guest-class'
import { remoteAllowed, type TabInfo } from '../../src/shared/ipc'
import type { GuestOnlyAccess, GuestScope, GuestView } from '../../src/shared/guests'
import type { SenderContext } from '../../src/main/windows/window-manager'
import type { GuestRole, Who } from '../../src/shared/views'

const PROJECT_A = 'aaaaaaaaaaaaaaaa'
const PROJECT_B = 'bbbbbbbbbbbbbbbb'
const CTX = { kind: 'project' as const, windowId: 1, projectId: PROJECT_A }

class FakeIpcMain implements IpcMainLike {
  readonly handlers = new Map<string, (event: IpcEventLike, ...args: unknown[]) => unknown>()
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void {
    this.handlers.set(channel, listener)
  }
}

const senders = new Map<number, SenderContext>([[11, CTX]])

function newRouter(logs: string[] = []): IpcRouter {
  return new IpcRouter(
    new FakeIpcMain(),
    (id) => senders.get(id),
    () => true,
    (m) => logs.push(m),
    (windowId, projectId) => windowId === 1 && projectId === PROJECT_A
  )
}

function guestAccess(id: string, role: GuestRole, projectId = PROJECT_A, scope: GuestScope = 'all'): GuestOnlyAccess {
  return { kind: 'guest', id, name: `Guest ${id}`, role, projectId, scope }
}

/** gR reads, gW writes, gB is a guest of another project; anyone else is revoked. Sees tab t1 and plugin p.vis. */
function fakeGuests(over: Partial<GuestService> = {}): GuestService & { opened: string[]; calls: unknown[][] } {
  const opened: string[] = []
  const calls: unknown[][] = []
  const known: Record<string, GuestOnlyAccess> = {
    gR: guestAccess('gR', 'read'),
    gW: guestAccess('gW', 'write'),
    gB: guestAccess('gB', 'write', PROJECT_B)
  }
  const list: GuestView[] = [
    { id: 'gW', name: 'Guest gW', role: 'write', projectId: PROJECT_A, scope: ['t1', 't2'], state: 'live', until: null },
    { id: 'gB', name: 'Guest gB', role: 'write', projectId: PROJECT_B, scope: 'all', state: 'live', until: null }
  ]
  const rec =
    (name: string) =>
    (...args: unknown[]): boolean => {
      calls.push([name, ...args])
      return true
    }
  return {
    opened,
    calls,
    access: (who: Who) => (who === 'owner' ? { kind: 'owner' } : (known[who.guest] ?? { kind: 'revoked' })),
    whoAccess: () => ({ kind: 'revoked' }),
    tabVisible: (_guestId, tabId) => tabId === 't1' || opened.includes(tabId),
    pluginVisible: (_projectId, pluginId) => pluginId === 'p.vis',
    openedTabs: () => opened,
    noteOpenedTab: (_guestId, tabId) => {
      opened.push(tabId)
    },
    list: () => list,
    invite: async (...args: unknown[]) => {
      calls.push(['invite', ...args])
      return { inviteId: 'i1', url: 'https://h/i', expiresAt: 1 } as never
    },
    revokeInvite: rec('revokeInvite'),
    kick: rec('kick'),
    setRole: rec('setRole'),
    setScope: rec('setScope'),
    shareTab: rec('shareTab'),
    remap: rec('remap') as GuestService['remap'],
    unsaved: () => [],
    onChange: () => () => undefined,
    ...over
  }
}

function guestDeps(guests: GuestService = fakeGuests(), over: Partial<GuestRouterDeps> = {}): GuestRouterDeps {
  return {
    guests,
    frameOwner: (_projectId, frameId) => (frameId === 'f1' ? 'p.vis' : frameId === 'f2' ? 'p.hid' : undefined),
    overlayVisible: (_projectId, overlayId) => overlayId === 'o1',
    askInfo: (_windowId, requestId) =>
      requestId === 'r1' ? { kind: 'trash', info: { pluginId: 'p.vis' } } : requestId === 'r2' ? { kind: 'trash', info: { pluginId: 'p.hid' } } : undefined,
    ...over
  }
}

const owner = (viewId: `web:${number}` = 'web:3') => webCaller(CTX, viewId, 'owner')
const guest = (id: string, viewId: `web:${number}` = 'web:5') => webCaller(CTX, viewId, { guest: id })

const outcome = (p: Promise<unknown>): Promise<boolean> =>
  p.then(
    () => true,
    () => false
  )

describe('guest gate: every invoke channel as a read guest, a write guest and an owner', () => {
  // What the fakes above make visible, mirrored for the expectation (the table's extractors decide the targets).
  const visible = (t: GuestTarget, role: GuestRole): boolean => {
    if ('tab' in t) return t.tab === 't1'
    if ('plugin' in t) return t.plugin === 'p.vis'
    if ('panel' in t) return t.panel.startsWith('p.vis/')
    if ('frame' in t) return t.frame === 'f1'
    if ('overlay' in t) return t.overlay === 'o1'
    if ('ask' in t) return t.ask === 'r1' && role === 'write'
    return false
  }
  const shown = {
    tabId: 't1',
    panelKey: 'p.vis/main',
    pluginId: 'p.vis',
    frameId: 'f1',
    overlayId: 'o1',
    groupId: 'g1',
    requestId: 'r1',
    kind: 'shell',
    id: 'p.vis/cmd',
    target: { tabId: 't1' },
    beside: { tabId: 't1', direction: 'right' }
  }
  const hidden = {
    ...shown,
    tabId: 't9',
    panelKey: 'p.hid/main',
    pluginId: 'p.hid',
    frameId: 'f2',
    overlayId: 'o9',
    requestId: 'r2',
    id: 'p.hid/cmd',
    target: { tabId: 't9' },
    beside: { tabId: 't9', direction: 'right' }
  }
  const channels = Object.keys(GUEST_CLASS)

  it('reaches the handler exactly when REMOTE_CLASS, the role, a well-formed target and its visibility allow', async () => {
    const router = newRouter()
    router.setGuestDeps(guestDeps())
    const ran = new Map<string, number>()
    for (const channel of channels) {
      router.handleProject(channel as never, () => {
        ran.set(channel, (ran.get(channel) ?? 0) + 1)
        return undefined as never
      })
    }
    const wrong: string[] = []
    for (const channel of channels) {
      const rule = guestClassOf(channel)
      for (const [label, payload] of [
        ['shown', shown],
        ['hidden', hidden],
        ['malformed', undefined]
      ] as const) {
        const cases: Array<[string, ReturnType<typeof webCaller>, boolean]> = [['owner', owner(), remoteAllowed(channel)]]
        for (const [id, role] of [
          ['gR', 'read'],
          ['gW', 'write']
        ] as const) {
          const targets = rule.target ? rule.target(payload) : []
          const allowed =
            remoteAllowed(channel) && guestRoleAllows(role, rule.cls) && targets !== undefined && targets.every((t) => visible(t, role))
          cases.push([`${role} guest`, guest(id), allowed])
        }
        for (const [who, caller, expected] of cases) {
          const before = ran.get(channel) ?? 0
          const got = await outcome(router.dispatch(caller, channel, payload))
          const reached = (ran.get(channel) ?? 0) > before
          if (got !== expected || reached !== expected) wrong.push(`${channel} ${label} ${who}: expected ${expected}, got ${got} (handler ${reached})`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  it('never lets a read guest reach a write or no channel, nor any guest a no channel', () => {
    for (const channel of channels) {
      const cls = guestClassOf(channel).cls
      expect(guestRoleAllows('read', cls)).toBe(cls === 'read')
      expect(guestRoleAllows('write', cls)).toBe(cls !== 'no')
    }
  })

  it('refuses every guest call while no guest service is wired (fail closed), owners unchanged', async () => {
    const router = newRouter()
    let ran = 0
    for (const channel of channels) {
      router.handleProject(channel as never, () => {
        ran++
        return undefined as never
      })
    }
    for (const channel of channels) {
      for (const id of ['gR', 'gW']) expect(await outcome(router.dispatch(guest(id), channel, shown))).toBe(false)
    }
    expect(ran).toBe(0)
    expect(await outcome(router.dispatch(owner(), 'tabs.list', undefined))).toBe(true)
  })

  it('refuses a revoked guest and a guest of another project, and logs no payload', async () => {
    const logs: string[] = []
    const router = newRouter(logs)
    router.setGuestDeps(guestDeps())
    router.handleProject('tabs.list', () => [])
    expect(await outcome(router.dispatch(guest('gone'), 'tabs.list', { secret: 'MARKER' }))).toBe(false)
    expect(await outcome(router.dispatch(guest('gB'), 'tabs.list', { secret: 'MARKER' }))).toBe(false)
    expect(logs.join('\n')).toMatch(/refused for guest view web:5 \(not a live guest of this project\)/)
    expect(logs.join('\n')).not.toMatch(/MARKER/)
  })

  it('gives a handler the guest access only for a guest (owner CallViews are unchanged)', async () => {
    const router = newRouter()
    router.setGuestDeps(guestDeps())
    const views: CallView[] = []
    router.handleProject('tabs.list', (_ctx, _p, view) => {
      views.push(view)
      return []
    })
    await router.dispatch(owner(), 'tabs.list', undefined)
    await router.dispatch(guest('gR'), 'tabs.list', undefined)
    expect(views[0]).toEqual({ viewId: 'web:3', who: 'owner', remote: true })
    expect(views[1]?.access?.id).toBe('gR')
    expect(isOwner(views[0] as CallView)).toBe(true)
    expect(isOwner(views[1] as CallView)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------------------

/** A router that only captures handlers: a test then calls one with any CallView, past the gate. */
function capture(): { router: IpcRouter; call(channel: string, view: CallView, payload?: unknown): Promise<unknown> } {
  const handlers = new Map<string, (ctx: unknown, payload: unknown, view: CallView) => unknown>()
  const put = (channel: string, handler: (ctx: unknown, payload: unknown, view: CallView) => unknown): void => {
    handlers.set(channel, handler)
  }
  const router = {
    handleProject: put,
    handleWindow: put,
    guestService: () => undefined,
    presenceService: () => undefined,
    pluginAccessService: () => undefined,
    guestFilter: () => undefined,
    guestAccessNow: () => undefined
  } as unknown as IpcRouter
  return {
    router,
    call: (channel, view, payload) =>
      Promise.resolve().then(() => {
        const handler = handlers.get(channel)
        if (!handler) throw new Error(`no handler ${channel}`)
        return handler({ windowId: 1, projectId: PROJECT_A }, payload, view)
      })
  }
}

/** Deps where every member is a recorder (named calls land in `calls`), with `over` taking precedence. */
function recorderDeps<T>(calls: string[], over: Record<string, unknown> = {}): T {
  return new Proxy(over, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined
      if (key in target) return target[key]
      if (key === 'then') return undefined
      return (...args: unknown[]) => {
        calls.push(key)
        void args
        return undefined
      }
    }
  }) as T
}

describe('server-mode adapted sites refuse a guest even past the gate (isOwner, the second line)', () => {
  const guestView = (role: GuestRole): CallView => ({ viewId: 'web:5', who: { guest: `g${role}` }, remote: true, access: guestAccess(`g${role}`, role) })
  const ownerView: CallView = { viewId: 'web:3', who: 'owner', remote: true }

  it('projects.close', async () => {
    const calls: string[] = []
    const { router, call } = capture()
    registerCoreHandlers(router, recorderDeps(calls, { server: true }))
    for (const role of ['read', 'write'] as const) await expect(call('projects.close', guestView(role))).rejects.toThrow(/projects\.close/)
    expect(calls).not.toContain('closeProjectWindow')
    await call('projects.close', ownerView)
    expect(calls).toContain('closeProjectWindow')
  })

  it('oauth.paste', async () => {
    const calls: string[] = []
    const { router, call } = capture()
    registerOAuthPasteHandlers(router, recorderDeps(calls, { server: true }))
    for (const role of ['read', 'write'] as const) {
      const answer = await call('oauth.paste', guestView(role), { requestId: 'p1', text: 'code' }).catch((e: Error) => e)
      expect(answer instanceof Error || JSON.stringify(answer).includes('refused') || (answer as { ok?: boolean })?.ok === false).toBe(true)
    }
    expect(calls).toEqual([])
  })

  it('plugins.limits.set and plugins.globalLimits.set', async () => {
    const calls: string[] = []
    const { router, call } = capture()
    registerSettingsHandlers(router, recorderDeps(calls), { server: true })
    for (const channel of ['plugins.limits.set', 'plugins.globalLimits.set']) {
      for (const role of ['read', 'write'] as const) await expect(call(channel, guestView(role), { pluginId: 'p.vis', limits: {} })).rejects.toThrow(/refused/)
    }
    expect(calls).toEqual([])
  })

  it('notices.click and notices.dismiss', async () => {
    const calls: string[] = []
    const { router, call } = capture()
    registerNoticeHandlers(router, recorderDeps(calls, { server: true }))
    for (const channel of ['notices.click', 'notices.dismiss']) {
      for (const role of ['read', 'write'] as const) await expect(call(channel, guestView(role), { requestId: 'n1' })).rejects.toThrow(/in-page notices/)
    }
    expect(calls).toEqual([])
    await call('notices.click', ownerView, { requestId: 'n1' })
    expect(calls).toEqual(['click'])
  })

  it('links.answer: a guest never answers a plugin link (D-4)', async () => {
    const calls: string[] = []
    const { router, call } = capture()
    registerSessionHandlers(router, recorderDeps(calls))
    for (const role of ['read', 'write'] as const) {
      await expect(call('links.answer', guestView(role), { requestId: 'l1', allow: true })).resolves.toBe(false)
      await expect(call('links.answer', guestView(role), { requestId: 'l1', allow: false })).resolves.toBe(false)
    }
    expect(calls).toEqual([])
    await call('links.answer', ownerView, { requestId: 'l1', allow: false })
    expect(calls).toEqual(['linkAnswer'])
  })

  it('device revoke, disconnect and the web access settings', async () => {
    const calls: string[] = []
    const { router, call } = capture()
    registerWebAccessHandlers(router, recorderDeps(calls, { actorOf: () => ({ deviceId: 'd1', name: 'Mac' }) }), { server: true })
    for (const channel of ['settings.webDeviceRevoke', 'settings.webDeviceDisconnect', 'settings.webDevicesRevokeAll', 'settings.webAccess']) {
      for (const role of ['read', 'write'] as const) await expect(call(channel, guestView(role), { deviceId: 'd1' })).rejects.toThrow(/refused/)
    }
    expect(calls.filter((c) => c !== 'actorOf')).toEqual([])
  })

  it('room acts (pause, resume, remove, reveal, view, doc)', async () => {
    const calls: string[] = []
    const { router, call } = capture()
    registerRoomStripHandlers(router, recorderDeps(calls, { server: true }))
    registerRoomViewHandlers(router, recorderDeps(calls, { server: true }))
    for (const channel of ['rooms.pause', 'rooms.resume', 'rooms.remove', 'rooms.removeAnswer', 'rooms.reveal', 'rooms.view', 'rooms.doc', 'tabs.roomMark', 'rooms.deliverHeld']) {
      await expect(call(channel, guestView('write'), { roomId: 'r', tabId: 't1', name: 'n', requestId: 'q', remove: true, path: 'shared/a' })).rejects.toThrow(/refused/)
    }
    expect(calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe('guest tab handlers', () => {
  function tabsSetup(opts: { wired?: boolean; closeAnswer?: boolean; slowCreate?: boolean } = {}) {
    const router = newRouter()
    const guests = fakeGuests()
    router.setGuestDeps(guestDeps(guests))
    const calls: unknown[][] = []
    const live: TabInfo[] = [
      { id: 't1', kind: 'shell', cwd: '/work/a', gen: 1 } as TabInfo,
      { id: 't9', kind: 'claude', cwd: '/work/a', name: 'SECRET-NAME', gen: 1 } as TabInfo
    ]
    let next = 100
    let answerClose: (close: boolean) => void = () => undefined
    const rec =
      (name: string, result?: unknown) =>
      (...args: unknown[]) => {
        calls.push([name, ...args])
        return result
      }
    const deps = recorderDeps<TabHandlerDeps>([], {
      list: () => live,
      create: (...args: unknown[]) => {
        calls.push(['create', ...args])
        const tab = { id: `n${next++}`, kind: 'shell', cwd: '/work/a', gen: 1 } as TabInfo
        if (!opts.slowCreate) {
          live.push(tab)
          return tab
        }
        return new Promise<TabInfo>((resolve) =>
          setTimeout(() => {
            live.push(tab)
            resolve(tab)
          }, 5)
        )
      },
      close: (projectId: string, tabId: string) => {
        calls.push(['close', projectId, tabId])
        const i = live.findIndex((t) => t.id === tabId)
        if (i >= 0) live.splice(i, 1)
      },
      input: rec('input'),
      resize: rec('resize'),
      select: rec('select'),
      viewSelect: rec('viewSelect'),
      others: (...args: unknown[]) => void calls.push(['others', ...args]),
      everyone: (...args: unknown[]) => void calls.push(['everyone', ...args]),
      ...(opts.wired === false
        ? { guest: undefined }
        : {
            guest: {
              select: rec('guest.select'),
              resize: rec('guest.resize'),
              input: rec('guest.input'),
              closeAsk: (...args: unknown[]) => {
                calls.push(['guest.closeAsk', ...args])
                return new Promise<boolean>((resolve) => {
                  answerClose = resolve
                })
              },
              closeAnswer: rec('guest.closeAnswer', opts.closeAnswer ?? true)
            }
          })
    })
    registerTabHandlers(router, deps)
    return { router, calls, guests, live, answer: (close: boolean) => answerClose(close) }
  }

  it('a write guest opens a Claude or shell tab tagged with it, in the project folder, at most four live', async () => {
    const { router, calls, guests } = tabsSetup()
    for (let i = 0; i < 4; i++) await router.dispatch(guest('gW'), 'tabs.create', { kind: 'shell', cwd: '/etc' })
    expect(calls.filter((c) => c[0] === 'create')).toHaveLength(4)
    // The guest's id goes to TabManager (openedByGuest), the cwd it named does not (D-33).
    expect(calls[0]).toEqual(['create', PROJECT_A, { kind: 'shell' }, 1, 'gW'])
    expect(guests.opened).toEqual(['n100', 'n101', 'n102', 'n103'])
    await expect(router.dispatch(guest('gW'), 'tabs.create', { kind: 'claude' })).rejects.toThrow(/at most 4/)
  })

  it('counts creates still spawning toward the cap (frames of one socket read)', async () => {
    const { router, calls } = tabsSetup({ slowCreate: true })
    const results = await Promise.all(Array.from({ length: 6 }, () => outcome(router.dispatch(guest('gW'), 'tabs.create', { kind: 'shell' }))))
    expect(results.filter(Boolean)).toHaveLength(4)
    expect(calls.filter((c) => c[0] === 'create')).toHaveLength(4)
  })

  it('counts only live tabs toward the cap, and refuses other kinds and read guests', async () => {
    const { router, calls, guests, live } = tabsSetup()
    guests.opened.push('old1', 'old2', 'old3', 'old4')
    expect(live.some((t) => t.id.startsWith('old'))).toBe(false)
    await router.dispatch(guest('gW'), 'tabs.create', { kind: 'claude' })
    await expect(router.dispatch(guest('gW'), 'tabs.create', { kind: 'command', level: 'app', entryId: 'x' })).rejects.toThrow(/refused/)
    await expect(router.dispatch(guest('gR'), 'tabs.create', { kind: 'shell' })).rejects.toThrow(/refused/)
    expect(calls.filter((c) => c[0] === 'create')).toHaveLength(1)
  })

  it('a guest closes its own tab at once; any other visible tab asks the owner (D-9)', async () => {
    const { router, calls, live, answer } = tabsSetup()
    const mine = (await router.dispatch(guest('gW'), 'tabs.create', { kind: 'shell' })) as TabInfo
    await router.dispatch(guest('gW'), 'tabs.close', { tabId: mine.id })
    expect(calls.some((c) => c[0] === 'close' && c[2] === mine.id)).toBe(true)
    await expect(router.dispatch(guest('gW'), 'tabs.close', { tabId: 't1' })).resolves.toEqual({ asked: true })
    expect(calls.some((c) => c[0] === 'close' && c[2] === 't1')).toBe(false)
    expect(calls.find((c) => c[0] === 'guest.closeAsk')?.[2]).toMatchObject({ tabId: 't1', guestId: 'gW' })
    answer(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(calls.some((c) => c[0] === 'close' && c[2] === 't1')).toBe(true)
    expect(live.some((t) => t.id === 't1')).toBe(false)
    // No page removed it itself, so every view is told, the asking guest's included.
    expect(calls.filter((c) => c[0] === 'everyone')).toEqual([['everyone', 1, { channel: 'tabs.removed', payload: { tabId: 't1', gen: 1 } }]])
  })

  it('an owner No leaves the tab; a hidden tab is refused before any ask', async () => {
    const { router, calls, answer } = tabsSetup()
    await router.dispatch(guest('gW'), 'tabs.close', { tabId: 't1' })
    answer(false)
    await Promise.resolve()
    expect(calls.some((c) => c[0] === 'close')).toBe(false)
    await expect(router.dispatch(guest('gW'), 'tabs.close', { tabId: 't9' })).rejects.toThrow(/refused/)
    expect(calls.filter((c) => c[0] === 'guest.closeAsk')).toHaveLength(1)
  })

  it('tabs.guestCloseAnswer is the owner\'s only', async () => {
    const { router, calls } = tabsSetup()
    await expect(router.dispatch(guest('gW'), 'tabs.guestCloseAnswer', { requestId: 'guest-close-1', close: true })).rejects.toThrow(/refused/)
    await expect(router.dispatch(owner(), 'tabs.guestCloseAnswer', { requestId: 'guest-close-1', close: true })).resolves.toBe(true)
    expect(calls.filter((c) => c[0] === 'guest.closeAnswer')).toEqual([['guest.closeAnswer', 1, 'guest-close-1', true]])
  })

  it('input: a write guest types through the guest path (typed, never the active tab); a read guest never', async () => {
    const { router, calls } = tabsSetup()
    await router.dispatch(guest('gW'), 'tabs.input', { tabId: 't1', data: 'ls\r' })
    await expect(router.dispatch(guest('gR'), 'tabs.input', { tabId: 't1', data: 'x' })).rejects.toThrow(/refused/)
    await expect(router.dispatch(guest('gW'), 'tabs.input', { tabId: 't9', data: 'x' })).rejects.toThrow(/refused/)
    expect(calls.filter((c) => String(c[0]).endsWith('input'))).toEqual([['guest.input', PROJECT_A, 't1', 'ls\r', 'web:5']])
  })

  it('input from a guest is refused while the guest path is unwired', async () => {
    const { router, calls } = tabsSetup({ wired: false })
    await expect(router.dispatch(guest('gW'), 'tabs.input', { tabId: 't1', data: 'x' })).rejects.toThrow(/refused/)
    expect(calls.filter((c) => String(c[0]).endsWith('input'))).toEqual([])
  })

  it('resize and select from a guest go to the guest paths (D-14: no implicit size; no active tab)', async () => {
    const { router, calls } = tabsSetup()
    await router.dispatch(guest('gW'), 'tabs.resize', { tabId: 't1', cols: 80, rows: 24 })
    await router.dispatch(guest('gR'), 'tabs.selected', { tabId: 't1' })
    expect(calls.filter((c) => c[0] === 'resize' || c[0] === 'select')).toEqual([])
    expect(calls.some((c) => c[0] === 'guest.resize')).toBe(true)
    expect(calls.some((c) => c[0] === 'guest.select')).toBe(true)
  })

  it('tabs.list leaks nothing of a tab the guest cannot see', async () => {
    const { router } = tabsSetup()
    const reply = await router.dispatch(guest('gR'), 'tabs.list', undefined)
    expect(JSON.stringify(reply)).not.toMatch(/SECRET|t9/)
    expect((reply as TabInfo[]).map((t) => t.id)).toEqual(['t1'])
    const full = await router.dispatch(owner(), 'tabs.list', undefined)
    expect((full as TabInfo[]).map((t) => t.id)).toEqual(['t1', 't9'])
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe('trash.answer (D-10)', () => {
  function trashSetup(server: boolean) {
    const router = newRouter()
    router.setGuestDeps(guestDeps())
    const answers: unknown[][] = []
    registerSessionHandlers(
      router,
      recorderDeps([], {
        server,
        trashAnswer: (...args: unknown[]) => {
          answers.push(args)
          return true
        }
      })
    )
    return { router, answers }
  }

  it('on a desktop host a guest may only Deny', async () => {
    const { router, answers } = trashSetup(false)
    await expect(router.dispatch(guest('gW'), 'trash.answer', { requestId: 'r1', move: true })).resolves.toBe(false)
    await expect(router.dispatch(guest('gW'), 'trash.answer', { requestId: 'r1', move: false })).resolves.toBe(true)
    expect(answers).toEqual([[1, 'r1', false]])
  })

  it('on a server a write guest may Allow an ask of a plugin it sees', async () => {
    const { router, answers } = trashSetup(true)
    await expect(router.dispatch(guest('gW'), 'trash.answer', { requestId: 'r1', move: true })).resolves.toBe(true)
    expect(answers).toEqual([[1, 'r1', true]])
  })

  it('never an ask of a hidden plugin, an unknown ask, or from a read guest', async () => {
    const { router, answers } = trashSetup(true)
    for (const [id, requestId] of [
      ['gW', 'r2'],
      ['gW', 'nope'],
      ['gR', 'r1']
    ]) {
      await expect(router.dispatch(guest(id as string), 'trash.answer', { requestId, move: false })).rejects.toThrow(/refused/)
    }
    expect(answers).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe('guest list handlers (owner only; widening from a remote view only on a server, D-11)', () => {
  function guestsSetup(server: boolean) {
    const router = newRouter()
    const guests = fakeGuests()
    const set: unknown[][] = []
    router.setGuestDeps(guestDeps(guests))
    registerGuestHandlers(router, {
      server,
      setPluginGuestAccess: (...args: unknown[]) => {
        set.push(args)
        return { id: 'p.vis' } as never
      }
    })
    return { router, guests, set }
  }
  const invite = { name: 'Ann', role: 'write', scope: 'all', lifetime: '1d' }

  it('lists only the caller\'s project\'s guests', async () => {
    const { router } = guestsSetup(false)
    const list = (await router.dispatch(owner(), 'guests.list', undefined)) as GuestView[]
    expect(list.map((g) => g.id)).toEqual(['gW'])
  })

  it('a desktop host\'s browser owner may narrow but not widen', async () => {
    const { router, guests } = guestsSetup(false)
    await expect(router.dispatch(owner(), 'guests.invite', invite)).rejects.toThrow(/widen/)
    await expect(router.dispatch(owner(), 'guests.setRole', { guestId: 'gW', role: 'write' })).rejects.toThrow(/widen/)
    await expect(router.dispatch(owner(), 'guests.setScope', { guestId: 'gW', scope: ['t1', 't2', 't3'] })).rejects.toThrow(/widen/)
    await expect(router.dispatch(owner(), 'guests.setScope', { guestId: 'gW', scope: 'all' })).rejects.toThrow(/widen/)
    await expect(router.dispatch(owner(), 'guests.shareTab', { guestId: 'gW', tabId: 't3', shared: true })).rejects.toThrow(/widen/)
    await router.dispatch(owner(), 'guests.kick', { guestId: 'gW' })
    await router.dispatch(owner(), 'guests.setRole', { guestId: 'gW', role: 'read' })
    await router.dispatch(owner(), 'guests.setScope', { guestId: 'gW', scope: ['t1'] })
    await router.dispatch(owner(), 'guests.shareTab', { guestId: 'gW', tabId: 't2', shared: false })
    expect(guests.calls.map((c) => c[0])).toEqual(['kick', 'setRole', 'setScope', 'shareTab'])
  })

  it('a server\'s browser owner may widen', async () => {
    const { router, guests } = guestsSetup(true)
    await router.dispatch(owner(), 'guests.invite', invite)
    await router.dispatch(owner(), 'guests.setRole', { guestId: 'gW', role: 'write' })
    expect(guests.calls.map((c) => c[0])).toEqual(['invite', 'setRole'])
  })

  it('never acts on another project\'s guest, and never for a guest caller', async () => {
    const { router, guests } = guestsSetup(true)
    await expect(router.dispatch(owner(), 'guests.kick', { guestId: 'gB' })).resolves.toBe(false)
    for (const channel of ['guests.list', 'guests.invite', 'guests.kick', 'guests.setRole', 'guests.setScope', 'guests.shareTab']) {
      await expect(router.dispatch(guest('gW'), channel, { ...invite, guestId: 'gW' })).rejects.toThrow(/refused/)
    }
    expect(guests.calls).toEqual([])
  })

  it('plugin guest access: hiding is narrowing, showing is widening', async () => {
    const { router, set } = guestsSetup(false)
    await router.dispatch(owner(), 'settings.pluginGuestAccessSet', { pluginId: 'p.vis', target: 'project', value: 'hidden' })
    await expect(router.dispatch(owner(), 'settings.pluginGuestAccessSet', { pluginId: 'p.vis', target: 'project', value: 'shown' })).rejects.toThrow(/widen/)
    expect(set).toEqual([[PROJECT_A, { pluginId: 'p.vis', target: 'project', value: 'hidden' }]])
    await expect(router.dispatch(owner(), 'settings.pluginGuestAccessSet', { pluginId: '../x', target: 'project', value: 'hidden' })).rejects.toThrow(/bad plugin id/)
  })
})

describe('03e D: no fail-open default for a guest', () => {
  it('guestCall: the owner takes the owner path; a guest without bound access is refused, never the owner', () => {
    expect(guestCall({ who: 'owner' }, 'x')).toBeUndefined()
    // An owner with a stray access still takes the owner path: `who` decides, not whether access is set.
    expect(guestCall({ who: 'owner', access: guestAccess('gW', 'write') }, 'x')).toBeUndefined()
    expect(guestCall({ who: { guest: 'gW' }, access: guestAccess('gW', 'write') }, 'x')).toEqual(guestAccess('gW', 'write'))
    expect(() => guestCall({ who: { guest: 'gW' } }, 'tabs.input')).toThrow('tabs.input: refused')
  })

  it('webCaller takes who explicitly (no owner default)', () => {
    // @ts-expect-error -- who is required: a caller that forgot it must not become the owner
    expect(() => webCaller(CTX, 'web:3')).not.toThrow()
    expect(webCaller(CTX, 'web:3', { guest: 'gW' }).who).toEqual({ guest: 'gW' })
  })
})

describe('03e E: slots.height', () => {
  function slots() {
    const router = newRouter()
    router.setGuestDeps(guestDeps())
    const heights: unknown[][] = []
    const deps: SlotHandlerDeps = {
      connect: () => true,
      disconnect: () => undefined,
      setHeight: (projectId, frameId, height) => (heights.push([projectId, frameId, height]), true)
    }
    registerSlotHandlers(router, deps)
    return { router, heights }
  }

  it("a read guest's report changes nothing (false); a write guest's and the owner's set the height", async () => {
    const { router, heights } = slots()
    await expect(router.dispatch(guest('gR'), 'slots.height', { frameId: 'f1', height: 300 })).resolves.toBe(false)
    expect(heights).toEqual([])
    await expect(router.dispatch(guest('gW'), 'slots.height', { frameId: 'f1', height: 310 })).resolves.toBe(true)
    await expect(router.dispatch(owner(), 'slots.height', { frameId: 'f1', height: 320 })).resolves.toBe(true)
    expect(heights).toEqual([
      [PROJECT_A, 'f1', 310],
      [PROJECT_A, 'f1', 320]
    ])
    // A frame of a plugin the guest cannot see stays refused by the gate, before the handler.
    await expect(router.dispatch(guest('gW'), 'slots.height', { frameId: 'f2', height: 1 })).rejects.toThrow(/refused/)
  })
})

describe("03e A, B: a guest's Discuss (IpcRouter.discussGuest, openGuestTab)", () => {
  const viewOf = (id: string, role: GuestRole = 'write'): CallView => ({ viewId: 'web:5', who: { guest: id }, remote: true, access: guestAccess(id, role) })
  function setup() {
    let role: GuestRole | 'gone' = 'write'
    const guests = fakeGuests({
      access: (who: Who) => (who === 'owner' ? { kind: 'owner' } : role === 'gone' ? { kind: 'revoked' } : guestAccess((who as { guest: string }).guest, role))
    })
    const router = newRouter()
    router.setGuestDeps(guestDeps(guests))
    return { router, guests, setRole: (r: GuestRole | 'gone') => void (role = r) }
  }

  it('none for the owner; for a guest, allowed reads the access live: write, the project, the tab visible', () => {
    const { router, setRole } = setup()
    expect(router.discussGuest('pageTabs.discuss', CTX, { viewId: 'web:3', who: 'owner', remote: true })).toBeUndefined()
    const g = router.discussGuest('pageTabs.discuss', CTX, viewOf('gW'))!
    expect(g).toMatchObject({ id: 'gW', viewId: 'web:5' })
    expect(g.allowed({ kind: 'tab', tabId: 't1' })).toBe(true)
    expect(g.allowed({ kind: 'tab', tabId: 't9' })).toBe(false)
    expect(g.allowed({ kind: 'new' })).toBe(true)
    setRole('read')
    expect(g.allowed({ kind: 'tab', tabId: 't1' })).toBe(false)
    expect(g.allowed({ kind: 'new' })).toBe(false)
    setRole('gone')
    expect(g.allowed({ kind: 'tab', tabId: 't1' })).toBe(false)
    // A guest view with no bound access is refused outright (03e D).
    expect(() => router.discussGuest('pageTabs.discuss', CTX, { viewId: 'web:5', who: { guest: 'gW' }, remote: true })).toThrow(/refused/)
  })

  it("an overlay's Discuss gets seesOverlay: the one overlay rule over the access read live; none without the overlay; fail closed", () => {
    const { router, guests, setRole } = setup()
    let visible = true
    router.setGuestDeps(guestDeps(guests, { overlayVisible: (projectId, overlayId, access) => visible && projectId === PROJECT_A && overlayId === 'o1' && access.id === 'gW' }))
    expect(router.discussGuest('pageTabs.discuss', CTX, viewOf('gW'))!.seesOverlay).toBeUndefined()
    const g = router.discussGuest('overlays.discuss', CTX, viewOf('gW'), 'o1')!
    expect(g.seesOverlay!()).toBe(true)
    // `via` grew with a plugin hidden from the guest (or the guest hid it): no longer seen.
    visible = false
    expect(g.seesOverlay!()).toBe(false)
    visible = true
    expect(router.discussGuest('overlays.discuss', CTX, viewOf('gW'), 'o2')!.seesOverlay!()).toBe(false)
    setRole('read')
    expect(g.seesOverlay!()).toBe(false)
    setRole('write')
    // No rule wired: never seen.
    router.setGuestDeps(guestDeps(guests, { overlayVisible: undefined }))
    expect(g.seesOverlay!()).toBe(false)
  })

  it("a Discuss new session counts against the guest's cap with the opens in flight, is noted as its tab, and closes if access ended", async () => {
    const { router, guests, setRole } = setup()
    const g = router.discussGuest('overlays.discuss', CTX, viewOf('gW'))!
    guests.opened.push('o1', 'o2')
    const live = ['o1', 'o2', 'x']
    // Two opens in flight: the cap (4) counts them before either has spawned.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const first = g.openTab(live, async () => (await gate, { tabId: 'n1' }), (t) => t.tabId, () => undefined)
    const second = g.openTab(live, async () => (await gate, { tabId: 'n2' }), (t) => t.tabId, () => undefined)
    await expect(g.openTab(live, async () => ({ tabId: 'n3' }), (t) => t.tabId, () => undefined)).rejects.toThrow(/at most 4 tabs/)
    release()
    await expect(first).resolves.toEqual({ tabId: 'n1' })
    await expect(second).resolves.toEqual({ tabId: 'n2' })
    expect(guests.opened).toEqual(['o1', 'o2', 'n1', 'n2'])
    // Downgraded while it opened: the new tab is closed and not noted.
    guests.opened.length = 0
    const closed: string[] = []
    setRole('read')
    await expect(g.openTab([], async () => ({ tabId: 'n4' }), (t) => t.tabId, (id) => void closed.push(id))).rejects.toThrow(/refused/)
    expect(closed).toEqual(['n4'])
    expect(guests.opened).toEqual([])
  })
})
