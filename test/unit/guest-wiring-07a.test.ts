// Task 07a: the guest deps of 03, 03b, 04 and 04b as main wires them (src/main/guest-wiring.ts), and that index.ts
// passes each one. The deps are optional on their modules (an unwired one fails closed: guests silently get
// nothing), so a missing one would type-check and pass every module's own tests; the text checks below catch it,
// as guest-wiring.test.ts does for 02's deps.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  downloadViewAllowedOf,
  guestRouterDeps,
  guestSeesOf,
  guestTabDeps,
  guestUnsavedOf,
  offerTakerOf,
  guestMayDeliverOf,
  ownerViewOf,
  pageSelectTargetOf,
  pluginFocusSelectOf,
  pluginFocusViewOf,
  type GuestRouterSources,
  type GuestTabSources
} from '../../src/main/guest-wiring'
import type { GuestService } from '../../src/main/ipc/guest-deps'
import { overlayHandler } from '../../src/main/socket/handlers'
import { windowSnapshot, type SnapshotSources } from '../../src/main/web/connection'
import { createGuestCloseAsks } from '../../src/main/tabs/guest-close-asks'
import type { GuestAccess, GuestOnlyAccess } from '../../src/shared/guests'
import type { ViewId, Who } from '../../src/shared/views'

const PROJECT = 'p1'
const WINDOW = 7
const GUEST: GuestOnlyAccess = { kind: 'guest', id: 'g1', name: 'Bob', role: 'write', projectId: PROJECT, scope: ['t1'] }
const FOCUS_REPORT = '\x1b[I'

/** A guest store with one live guest (g1) who sees tab t1 and plugin shown.one only. */
function fakeGuests(): GuestService {
  const access = (who: Who): GuestAccess => (who === 'owner' ? { kind: 'owner' } : who.guest === 'g1' ? GUEST : { kind: 'revoked' })
  return {
    access,
    whoAccess: () => ({ kind: 'revoked' }),
    tabVisible: (guestId, tabId) => guestId === 'g1' && tabId === 't1',
    pluginVisible: (projectId, pluginId) => projectId === PROJECT && pluginId === 'shown.one'
  } as Partial<GuestService> as GuestService
}

const whoOf = (viewId: ViewId): Who | undefined =>
  viewId === 'desktop:7' || viewId === 'web:1' ? 'owner' : viewId === 'web:2' ? { guest: 'g1' } : viewId === 'web:3' ? { guest: 'gone' } : undefined

describe('guestRouterDeps', () => {
  function sources(): GuestRouterSources {
    const overlayOrigins: Record<string, { tabId?: string; pluginId?: string }> = {
      'ov-tab': { tabId: 't1' },
      'ov-hidden': { tabId: 't2' },
      'ov-plugin': { pluginId: 'shown.one' },
      'ov-none': {}
    }
    return {
      guests: fakeGuests(),
      presence: { snapshotFor: () => ({}) as never, personOf: (v) => (v === 'web:2' ? 'Bob' : undefined), viewSelected: () => undefined, typed: () => undefined },
      pluginAccess: { visible: () => false, port: () => 'none' } as never,
      windowIdOf: (projectId) => (projectId === PROJECT ? WINDOW : undefined),
      overlays: {
        // OverlayManager.visibleTo's rule, over the fake origins.
        visibleTo: (windowId, overlayId, tabVisible, pluginVisible) => {
          const o = windowId === WINDOW ? overlayOrigins[overlayId] : undefined
          if (!o) return false
          if (o.tabId !== undefined) return tabVisible(o.tabId)
          return o.pluginId !== undefined && pluginVisible(o.pluginId)
        }
      },
      // f1: shown.one's frame in its own panel; f2: shown.one's frame in a hidden plugin's panel; f3: shown.one's in the top bar.
      slotFrame: (projectId, frameId) => {
        if (projectId !== PROJECT) return undefined
        if (frameId === 'f1') return { info: { pluginId: 'shown.one' }, host: { kind: 'panel', pluginId: 'shown.one', panelId: 'p' } }
        if (frameId === 'f2') return { info: { pluginId: 'shown.one' }, host: { kind: 'panel', pluginId: 'hidden.two', panelId: 'p' } }
        if (frameId === 'f3') return { info: { pluginId: 'shown.one' }, host: { kind: 'app', place: 'top-bar' } }
        return undefined
      },
      trashAsks: { pluginOf: (windowId, requestId) => (windowId === WINDOW && requestId === 'trash-1' ? 'shown.one' : undefined) },
      downloads: { offerOrigin: (windowId, requestId) => (windowId === WINDOW && requestId === 'offer-1' ? { originTab: 't1' } : undefined) },
      projectPath: (projectId) => (projectId === PROJECT ? '/Users/host/project' : undefined)
    }
  }

  it('has every GuestRouterDeps key, each answering from main', () => {
    const deps = guestRouterDeps(sources())
    expect(Object.keys(deps).sort()).toEqual(['askInfo', 'frameOwner', 'guests', 'overlayVisible', 'personOf', 'pluginAccess', 'presence', 'projectRoot'])
    expect(deps.frameOwner(PROJECT, 'f1')).toBe('shown.one')
    expect(deps.frameOwner(PROJECT, 'f9')).toBeUndefined()
    // A frame a hidden plugin's panel placed is not the guest's, though its provider is shown; an app slot is the provider's alone.
    expect(deps.frameOwner(PROJECT, 'f2')).toBeUndefined()
    expect(deps.frameOwner(PROJECT, 'f3')).toBe('shown.one')
    expect(deps.frameOwner('p2', 'f1')).toBeUndefined()
    expect(deps.askInfo(WINDOW, 'trash-1')).toEqual({ kind: 'trash', info: { pluginId: 'shown.one' } })
    expect(deps.askInfo(WINDOW, 'offer-1')).toEqual({ kind: 'download', info: { originTab: 't1' } })
    expect(deps.askInfo(WINDOW, 'guest-close-1')).toBeUndefined()
    expect(deps.askInfo(8, 'trash-1')).toBeUndefined()
    expect(deps.personOf('web:2')).toBe('Bob')
    expect(deps.projectRoot(PROJECT)).toBe('/Users/host/project')
    expect(deps.projectRoot('p2')).toBeUndefined()
  })

  it("an overlay is visible to a guest only by its origin: a tab it sees or a plugin shown to the project's guests", () => {
    const deps = guestRouterDeps(sources())
    expect(deps.overlayVisible(PROJECT, 'ov-tab', GUEST)).toBe(true)
    expect(deps.overlayVisible(PROJECT, 'ov-plugin', GUEST)).toBe(true)
    expect(deps.overlayVisible(PROJECT, 'ov-hidden', GUEST)).toBe(false)
    expect(deps.overlayVisible(PROJECT, 'ov-none', GUEST)).toBe(false)
    expect(deps.overlayVisible(PROJECT, 'ov-unknown', GUEST)).toBe(false)
    // Another guest (another id): its own tabs, not g1's.
    expect(deps.overlayVisible(PROJECT, 'ov-tab', { ...GUEST, id: 'g2' })).toBe(false)
    // No window open for the project: nothing.
    expect(deps.overlayVisible('p2', 'ov-tab', { ...GUEST, projectId: 'p2' })).toBe(false)
  })
})

describe('guestTabDeps', () => {
  function setup(): { deps: ReturnType<typeof guestTabDeps>; calls: string[] } {
    const calls: string[] = []
    const s: GuestTabSources = {
      presence: {
        viewSelected: (v, t) => void calls.push(`presence.selected ${v} ${t}`),
        typed: (v, t) => void calls.push(`presence.typed ${v} ${t}`)
      },
      tabExists: (projectId, tabId) => projectId === PROJECT && (tabId === 't1' || tabId === 't2'),
      selections: {
        guestActed: (p, v, t) => void calls.push(`guestActed ${p} ${v} ${t}`),
        guestTyped: (p, v, t) => void calls.push(`guestTyped ${p} ${v} ${t}`)
      },
      tabs: {
        guestResize: (p, t, c, r, v) => void calls.push(`guestResize ${p} ${t} ${c}x${r} ${v}`),
        viewInput: (_p, _t, data) => data
      },
      userInput: (p, t, d) => void calls.push(`userInput ${p} ${t} ${JSON.stringify(d)}`),
      closeAsks: createGuestCloseAsks({ toWindow: () => true, toGuest: () => undefined })
    }
    return { deps: guestTabDeps(s), calls }
  }

  it("a guest's selection is its view's own and its presence; an unknown tab never reaches presence", () => {
    const { deps, calls } = setup()
    deps.select(PROJECT, 't1', 'web:2')
    deps.select(PROJECT, 'nope', 'web:2')
    expect(calls).toEqual([`guestActed ${PROJECT} web:2 t1`, 'presence.selected web:2 t1', `guestActed ${PROJECT} web:2 nope`])
  })

  it("a guest's keys set typed and its presence; a focus report is no person's input", () => {
    const { deps, calls } = setup()
    deps.input(PROJECT, 't1', 'ls\r', 'web:2')
    deps.input(PROJECT, 't1', FOCUS_REPORT, 'web:2')
    expect(calls).toEqual([
      `userInput ${PROJECT} t1 ${JSON.stringify('ls\r')}`,
      `guestTyped ${PROJECT} web:2 t1`,
      'presence.typed web:2 t1',
      `userInput ${PROJECT} t1 ${JSON.stringify(FOCUS_REPORT)}`
    ])
  })

  it('a size report goes to the guest path (explicit take only); a close ask is settled by the first answer', async () => {
    const { deps, calls } = setup()
    deps.resize(PROJECT, 't1', 80, 24, 'web:2')
    expect(calls).toEqual([`guestResize ${PROJECT} t1 80x24 web:2`])
    const asked = deps.closeAsk(WINDOW, { tabId: 't2', guest: 'Bob', title: 'zsh' } as never)
    expect(deps.closeAnswer(WINDOW, 'guest-close-1', true)).toBe(true)
    expect(deps.closeAnswer(WINDOW, 'guest-close-1', false)).toBe(false)
    await expect(asked).resolves.toBe(true)
  })
})

describe('ownerViewOf, guestSeesOf, guestUnsavedOf', () => {
  it("owner views are the owner's only; a gone view is nobody's", () => {
    const owner = ownerViewOf(whoOf)
    expect(['desktop:7', 'web:1', 'web:2', 'web:9'].map(owner)).toEqual([true, true, false, false])
  })

  it('a guest view sees a pane only when its live guest sees the tab; owners and revoked guests never through this', () => {
    const sees = guestSeesOf(whoOf, fakeGuests())
    expect(sees('web:2', 't1')).toBe(true)
    expect(sees('web:2', 't2')).toBe(false)
    expect(sees('web:3', 't1')).toBe(false)
    expect(sees('web:1', 't1')).toBe(false)
    expect(sees('web:9', 't1')).toBe(false)
  })

  it("a guest's unsaved pages are the ones dirty in its own views, in its own project", () => {
    const seen: string[] = []
    const unsaved = guestUnsavedOf(whoOf, fakeGuests(), (projectId, inView) => {
      seen.push(projectId)
      // Three dirty page tabs: in the guest's view, in owner views, in another guest's view.
      const pages: Array<[string, ViewId[]]> = [
        ['notes.md', ['web:2']],
        ['plan.md', ['web:1', 'desktop:7']],
        ['other.md', ['web:3']]
      ]
      return pages.flatMap(([title, dirtyIn]) => (dirtyIn.some(inView) ? [title] : []))
    })
    expect(unsaved('g1')).toEqual(['notes.md'])
    expect(unsaved('gone')).toEqual([])
    expect(seen).toEqual([PROJECT])
  })
})

describe('offerTakerOf (ccc download offers, D-23)', () => {
  const roles: Record<string, GuestAccess> = {
    gW: { ...GUEST, id: 'gW', role: 'write' },
    gR: { ...GUEST, id: 'gR', role: 'read' }
  }
  function taker(views: Record<ViewId, Who>) {
    const seen: unknown[] = []
    const has = offerTakerOf({
      remoteViews: (windowId) => (windowId === WINDOW ? Object.keys(views) : []),
      whoOf: (viewId) => views[viewId],
      guests: { access: (who) => (who === 'owner' ? { kind: 'owner' } : (roles[who.guest] ?? { kind: 'revoked' })) },
      // askVisible's download rule: a write guest that sees the origin tab (t1 only here).
      sees: (viewId, access, originTab) => {
        seen.push([viewId, access.id, originTab])
        return access.role === 'write' && originTab === 't1'
      }
    })
    return { has, seen }
  }

  it("an owner's browser always takes; a lone read guest never (the 'on this computer' answer at once)", () => {
    expect(taker({ 'web:1': 'owner' }).has(WINDOW, 't1')).toBe(true)
    expect(taker({ 'web:1': 'owner' }).has(WINDOW)).toBe(true)
    expect(taker({ 'web:2': { guest: 'gR' } }).has(WINDOW, 't1')).toBe(false)
    expect(taker({}).has(WINDOW, 't1')).toBe(false)
    expect(taker({ 'web:1': 'owner' }).has(8, 't1')).toBe(false)
  })

  it('a write guest takes only an offer from a tab it sees; no origin tab, or a revoked guest, is no taker', () => {
    const { has, seen } = taker({ 'web:2': { guest: 'gW' }, 'web:3': { guest: 'gone' } })
    expect(has(WINDOW, 't1')).toBe(true)
    expect(has(WINDOW, 't2')).toBe(false)
    expect(has(WINDOW)).toBe(false)
    // The revoked guest's view is never asked about.
    expect(seen.every((s) => (s as unknown[])[0] === 'web:2')).toBe(true)
  })
})

describe('downloadViewAllowedOf (ctx.files.download, D-23)', () => {
  it("an owner's or a write guest's view gets a download; a read guest's, a revoked guest's or a gone view never", () => {
    const access = (who: Who): GuestAccess =>
      who === 'owner' ? { kind: 'owner' } : who.guest === 'gW' ? { ...GUEST, id: 'gW' } : who.guest === 'gR' ? { ...GUEST, id: 'gR', role: 'read' } : { kind: 'revoked' }
    const views: Record<ViewId, Who> = { 'web:1': 'owner', 'web:2': { guest: 'gW' }, 'web:3': { guest: 'gR' }, 'web:4': { guest: 'gone' } }
    const allowed = downloadViewAllowedOf((v) => views[v], { access })
    expect(['web:1', 'web:2', 'web:3', 'web:4', 'web:9'].map(allowed)).toEqual([true, true, false, false, false])
  })
})

describe('ready replays pending guest close asks (D-9)', () => {
  it("windowSnapshot lists the window's pending guest close asks; absent, none", async () => {
    const asks = createGuestCloseAsks({ toWindow: () => true, toGuest: () => undefined })
    const pending = asks.ask(WINDOW, { tabId: 't2', guestId: 'g1', guestName: 'Bob', title: 'zsh' })
    const base: SnapshotSources = {
      tabs: { list: () => [] },
      layouts: { view: () => ({ layout: {} as never, panels: [] }) },
      overlays: { infos: () => [] },
      closeAsks: { pendingFor: () => [] },
      linkAsks: { pendingFor: () => [] }
    }
    const ctx = { windowId: WINDOW, projectId: PROJECT }
    expect(windowSnapshot({ ...base, guestCloseAsks: asks }, ctx).guestCloseAsks).toEqual([
      { requestId: 'guest-close-1', tabId: 't2', guestId: 'g1', guestName: 'Bob', title: 'zsh' }
    ])
    expect(windowSnapshot({ ...base, guestCloseAsks: asks }, { ...ctx, windowId: 8 }).guestCloseAsks).toEqual([])
    expect(windowSnapshot(base, ctx).guestCloseAsks).toEqual([])
    asks.windowClosed(WINDOW)
    await expect(pending).resolves.toBe(false)
  })
})

describe('ccc overlay carries its origin tab', () => {
  it("a session token's tab, never one from args; a window token none", async () => {
    const calls: unknown[] = []
    const handler = overlayHandler({
      project: () => ({ name: 'p', path: '/tmp' }),
      windowIdOf: () => WINDOW,
      openOverlay: async (windowId, _spec, opener, _peerGone, origin) => {
        calls.push({ windowId, opener, origin })
        return { status: 'closed' } as never
      }
    })
    const signal = new AbortController().signal
    await handler({ url: 'https://example.com', tabId: 'forged' }, { kind: 'session', tabId: 't1', projectId: PROJECT }, signal)
    await handler({ url: 'https://example.com', tabId: 'forged' }, { kind: 'window', projectId: PROJECT }, signal)
    expect(calls).toEqual([
      { windowId: WINDOW, opener: 'cli', origin: { tabId: 't1' } },
      { windowId: WINDOW, opener: 'cli', origin: undefined }
    ])
  })
})

// ---------------------------------------------------------------------------------------------------------------
// index.ts passes each dep (read as text, as guest-wiring.test.ts and the no-direct-*.test.ts guards do)

const INDEX = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8')

/** The text of the call or object literal starting at `head` (which ends in its opening bracket), up to its close. */
function block(head: string): string {
  const start = INDEX.indexOf(head)
  expect(start, head).toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let i = start + head.length - 1; i < INDEX.length; i++) {
    const c = INDEX[i]
    if (c === '(' || c === '{') depth++
    else if ((c === ')' || c === '}') && --depth === 0) return INDEX.slice(start, i + 1)
  }
  throw new Error(`unclosed ${head}`)
}

describe("index.ts wires 07a's guest deps", () => {
  it('sets the router guest deps from guestRouterDeps and registers the guest handlers', () => {
    const deps = block('router.setGuestDeps(')
    expect(deps).toContain('guestRouterDeps({')
    for (const key of ['guests: guestStore', 'presence', 'pluginAccess: pluginGuestAccess', 'overlays', 'slotFrame:', 'trashAsks', 'downloads']) {
      expect(deps).toContain(key)
    }
    expect(block('registerGuestHandlers(router, {')).toContain('setPluginGuestAccess: (projectId, req) => settings.setPluginGuestAccess(projectId, req)')
  })

  it("gives the tab handlers the guest paths, everyone and the guest's create", () => {
    const tabsDeps = block('registerTabHandlers(router, {')
    expect(tabsDeps).toContain('guest: guestTabDeps({')
    expect(tabsDeps).toContain('closeAsks: guestCloseAsks')
    expect(tabsDeps).toContain('everyone: (windowId, event) => views.toWindow(windowId, event.channel, event.payload)')
    expect(tabsDeps).toContain('create: async (projectId, options, windowId, guestId) =>')
    expect(tabsDeps).toContain('createTab(projectId, options, windowId, guestId)')
    expect(tabsDeps).toContain('presence.typed(viewId, tabId)')
    expect(tabsDeps).toContain('presence.viewSelected(viewId, tabId)')
    expect(block('function createTab(projectId: string, options: TabCreateRequest, windowId: number, openedByGuest?: string): TabInfo | null {')).toContain(
      '...(openedByGuest !== undefined ? { openedByGuest } : {})'
    )
  })

  it('wires the guest store, the plugin visibility store and their change hooks', () => {
    const store = block('new GuestStore({')
    expect(store).toContain('pluginShown: (projectId, pluginId) => pluginGuestAccess.visible(projectId, pluginId)')
    expect(store).toContain('unsavedOf: guestUnsavedOf(')
    expect(store).toContain('notify: (text) =>')
    expect(INDEX).toContain('pluginGuestAccess.onChange(() => guestStore.pluginAccessChanged())')
    expect(INDEX).toContain('guestStore.pluginAccessChanged(projectId)')
    expect(block('new SettingsService({')).toContain('guestAccess: pluginGuestAccess')
    expect(block('new TabRestorer({')).toContain('onRestored: (projectId, idMap) => guestStore.remap(projectId, idMap)')
  })

  it("leaves guests out of the owner's dialogs, overlays and close counts (D-31)", () => {
    expect(block('new CloseAsks({')).toContain('ownerView')
    expect(block('new OverlayManager({')).toContain('ownerView')
    expect(block('confirmTrash: chooseAsk({')).toContain('hasRemoteView: hasOwnerRemoteView')
    expect(block('confirmLink: chooseAsk({')).toContain('hasRemoteView: hasOwnerRemoteView')
    expect(block('new Downloads({')).toContain('hasBrowserView: offerTakerOf({')
    expect(INDEX).toContain("if (!downloadViewAllowedOf((v) => views.whoOf(v), guestStore)(viewId)) throw new Error('a read-only guest cannot download')")
  })

  it('wires panel ports, overlays, sessions, exit focus and presence for guests', () => {
    const ports = block('new PanelPortHub<Electron.MessagePortMain>({')
    expect(ports).toContain('guestAccess: (viewId) => guestStore.whoAccess(viewId)')
    expect(ports).toContain('guestPort: (projectId, pluginId, role) => pluginGuestAccess.port(projectId, pluginId, role)')
    expect(block('registerOverlayHandlers(router, {')).toContain('guestResize:')
    expect(block('registerSessionHandlers(router, {')).toMatch(/\n\s+server,\n/)
    expect(INDEX).toContain('selections.exitFocus(projectId, tabId, panes, guestSeesOf(')
    expect(INDEX).toContain('presence.tabClosed(tabId)')
    expect(INDEX).toContain('presence.projectClosed(projectId)')
    // The desktop page is the owner in presence (desktop only), and leaves with its window.
    expect(INDEX).toContain("if (!server) presence.viewJoined(desktopViewId(windowId), projectId, 'owner')")
    expect(INDEX).toContain('presence.viewLeft(desktopViewId(windowId))')
    expect(INDEX).toContain('{ tabs, layouts, overlays, closeAsks, guestCloseAsks, linkAsks,')
    expect(INDEX).toContain('guestCloseAsks.windowClosed(windowId)')
    // 03e: a plugin's page tab focus selects where it acted; a guest's never reaches the owner's views.
    expect(INDEX).toContain("const target: PageSelectTarget = focus ? pageSelectTarget(view) : 'none'")
    expect(INDEX).toContain("const tab = tabs.createPage(projectId, spec, { focus: target === 'project' })")
    expect(INDEX).toContain('selectPageTab(projectId, tabId, pageSelectTarget(view))')
    // 03e A, B: a guest's queued Discuss text is checked again at the paste; its new session is its tab.
    expect(block('new SessionRegistry({')).toContain('guestMayDeliver: (guestId: string, tabId: string): boolean => guestMayDeliverOf(guestStore,')
    expect(INDEX).toContain("send: (tabId, text, origin, guestId) => (guestId === undefined ? sessions.send(tabId, text, origin) : sessions.send(tabId, text, origin, guestId)),")
    expect(INDEX).toContain('...(guestId === undefined ? {} : { openedByGuest: guestId })')
    expect(INDEX).toContain("if (tab) views.toView(view, 'tabs.added', tab)\n      views.toView(view, 'tabs.select', { tabId })")
    expect(INDEX).toContain("if (gen !== undefined) sendToProject(projectId, 'tabs.removed', { tabId, gen })")
    expect(INDEX).toContain('discuss: (caller, tabId, question, target, guest) => pageTabDiscuss.discuss(caller, tabId, question, target, guest),')
    // The caller's view goes too (docs/design-overlay-views.md §3): the opener hears who asked.
    expect(INDEX).toContain('discuss: (windowId, overlayId, target, guest, viewId) => overlays.discuss(windowId, overlayId, target, guest, viewId),')
    // docs/design-overlay-views.md §3, §5: who acted is read live from the guest store; a guest gets no copy until Task 5.
    expect(INDEX).toContain('viewAccess: (viewId) => guestStore.whoAccess(viewId),')
    expect(block('new OverlayManager({')).toContain('mayConnectCopy: () => false,')
    expect(block('registerOverlayHandlers(router, {')).toContain('perView: (windowId, overlayId) => overlays.isPerView(windowId, overlayId),')
    expect(INDEX).toContain("else if (target !== 'none') views.toView(target.viewId, 'tabs.select', { tabId })")
    // 03e (D-9): the outcome reaches the asking guest's own views only; an ended guest's asks settle.
    expect(INDEX).toContain("if (who !== undefined && who !== 'owner' && who.guest === guestId) views.toView(viewId, channel, payload)")
    expect(block('new GuestStore({')).toContain('ended: (guestId) => settleGuestCloseAsks(guestCloseAsks, guestId)')
    expect(INDEX).toContain('openOverlay(windowId, spec, opener, peerGone, undefined, undefined, undefined, origin)')
    // 03f: a plugin-opened tab's focus and ctx.sessions.focus follow the same rule.
    const announce = INDEX.slice(INDEX.indexOf('const announcePluginTab = ('), INDEX.indexOf('const openShellTab = async ('))
    expect(announce).toContain('const target = pageSelectTarget(origin)')
    expect(announce).toContain('const selectIn = pluginFocusViewOf(target, origin, windowId, (v) => views.windowOf(v))')
    expect(announce).toContain("if (to?.to === 'project') sendToProject(projectId, 'tabs.select', { tabId: to.tabId })")
    expect(announce).not.toContain('desktopViewId')
    expect(INDEX).toContain('openTab: (projectId, options, windowId, focus, place, view) => openClaudeTab(projectId, options, windowId, focus === true, place, view),')
    expect(INDEX).toContain('openShellTab: (projectId, options, windowId, focus, place, view) => openShellTab(projectId, options, windowId, focus === true, place, view),')
    expect(INDEX).toContain('openCommandTab: (projectId, options, windowId, focus, place, view) => openCommandTab(projectId, options, windowId, focus === true, place, view),')
    expect(INDEX).toContain('whoOf: (viewId) => views.whoOf(viewId)')
  })
})

describe('pageSelectTargetOf (03e: a guest\'s click that makes a plugin focus a page tab)', () => {
  it("never selects in the owner's views for a guest's view; the owner's or no view: the project, as before; a gone view: nowhere", () => {
    const target = pageSelectTargetOf(whoOf)
    expect(target('web:2')).toEqual({ viewId: 'web:2' })
    expect(target('web:3')).toEqual({ viewId: 'web:3' })
    expect(target('web:1')).toBe('project')
    expect(target('desktop:7')).toBe('project')
    expect(target(undefined)).toBe('project')
    expect(target('web:99')).toBe('none')
  })
})

describe('pluginFocusViewOf, pluginFocusSelectOf (03f: a plugin-opened tab with focus from a guest\'s click)', () => {
  const windowOf = (v: ViewId): number | undefined => ({ 'desktop:7': 7, 'web:1': 7, 'web:2': 7, 'web:5': 8 })[v]
  const target = pageSelectTargetOf(whoOf)
  it('the view pluginFocus works for: the guest\'s own (of this window); the owner\'s origin or the desktop page; none for a gone view', () => {
    expect(pluginFocusViewOf(target('web:2'), 'web:2', 7, windowOf)).toBe('web:2')
    expect(pluginFocusViewOf({ viewId: 'web:5' }, 'web:5', 7, windowOf)).toBeUndefined()
    expect(pluginFocusViewOf(target('web:1'), 'web:1', 7, windowOf)).toBe('web:1')
    expect(pluginFocusViewOf(target(undefined), undefined, 7, windowOf)).toBe('desktop:7')
    expect(pluginFocusViewOf('project', 'web:5', 7, windowOf)).toBe('desktop:7')
    expect(pluginFocusViewOf(target('web:99'), 'web:99', 7, windowOf)).toBeUndefined()
  })
  it("a guest's: always its own view, a plain tab included; the owner's: unchanged; none: nothing", () => {
    expect(pluginFocusSelectOf({ viewId: 'web:2' }, { to: 'window', tabId: 't' })).toEqual({ to: 'view', view: 'web:2', tabId: 't' })
    expect(pluginFocusSelectOf({ viewId: 'web:2' }, { to: 'view', view: 'web:2', tabId: 'a' })).toEqual({ to: 'view', view: 'web:2', tabId: 'a' })
    expect(pluginFocusSelectOf({ viewId: 'web:2' }, undefined)).toBeUndefined()
    expect(pluginFocusSelectOf('project', { to: 'window', tabId: 't' })).toEqual({ to: 'project', tabId: 't' })
    expect(pluginFocusSelectOf('project', { to: 'view', view: 'web:1', tabId: 'a' })).toEqual({ to: 'view', view: 'web:1', tabId: 'a' })
    expect(pluginFocusSelectOf('none', { to: 'window', tabId: 't' })).toBeUndefined()
  })
})

describe('guestMayDeliverOf (03e A)', () => {
  it("only a live write guest of the tab's project that sees the tab", () => {
    const access: Record<string, GuestAccess> = {
      gW: { kind: 'guest', id: 'gW', name: 'W', role: 'write', projectId: PROJECT, scope: 'all' },
      gR: { kind: 'guest', id: 'gR', name: 'R', role: 'read', projectId: PROJECT, scope: 'all' },
      gX: { kind: 'guest', id: 'gX', name: 'X', role: 'write', projectId: 'p2', scope: 'all' }
    }
    const may = guestMayDeliverOf(
      { access: (who) => (who === 'owner' ? { kind: 'owner' } : (access[who.guest] ?? { kind: 'revoked' })), tabVisible: (_g, t) => t !== 'hidden' },
      (t) => (t === 'gone' ? undefined : t === 'other' ? 'p2' : PROJECT)
    )
    expect(may('gW', 't1')).toBe(true)
    expect(may('gW', 'hidden')).toBe(false)
    expect(may('gW', 'gone')).toBe(false)
    expect(may('gW', 'other')).toBe(false)
    expect(may('gR', 't1')).toBe(false)
    expect(may('gX', 'other')).toBe(true)
    expect(may('kicked', 't1')).toBe(false)
  })
})
