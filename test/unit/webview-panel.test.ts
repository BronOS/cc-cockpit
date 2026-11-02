// Plan B Task 8: webview panels in the shell. main's cover/hide rule for a view (the renderer's
// placement reports plus the window's overlay stack), the renderer reports going only to the view
// of the sending window (router), the app chords a view forwards, ctx.panels.show from the host
// to the layout, and the renderer's DOM-free halves (the placement throttle, the shell layers).
import { describe, expect, it, vi } from 'vitest'
import { HostContexts, type ContextDeps } from '../../src/host/ctx'
import { appPageMatcher, IpcRouter, registerWebviewHandlers, type IpcEventLike, type IpcMainLike } from '../../src/main/ipc/router'
import { LayoutService } from '../../src/main/layout/layout-service'
import { HostApi, type HostApiDeps } from '../../src/main/plugins/host-api'
import {
  forwardedCommand,
  NAVIGATED_COALESCE_MS,
  webviewChord,
  WebviewManager,
  type WebviewChordDeps,
  type WebviewEvents,
  type WebviewOwner,
  type WebviewPage,
  type WebviewView
} from '../../src/main/webview/webview-manager'
import type { SenderContext } from '../../src/main/windows/window-manager'
import { PlacementReporter, type Placement } from '../../src/renderer/zones/placement-reporter'
import { acquireLayer, layersUp, onLayersChange } from '../../src/renderer/zones/shell-layers'
import type { LayoutView } from '../../src/shared/ipc'
import { defaultLayout, hidePanel, setZoneCollapsed, showPanel, zoneOf, type LayoutState } from '../../src/shared/layout'
import { hostSpec } from '../fakes/host-spec'
import { unusedOAuth, unusedSecrets } from '../fakes/unused-host-services'

interface FakeView extends WebviewView {
  windowId: number
  events: WebviewEvents
  page: WebviewPage
  /** Every setBounds / setVisible call, in order. */
  calls: string[]
  shown: boolean
  destroyed: boolean
}

const WIN = 7
const OTHER_WIN = 8
const owner = (windowId = WIN, projectId = 'P1', pluginId = 'a.one', panelId = 'view'): WebviewOwner => ({
  windowId,
  projectId,
  pluginId,
  panelId
})
const at = (x: number, y: number, width: number, height: number, visible = true) => ({ bounds: { x, y, width, height }, visible })

function setup(): {
  manager: WebviewManager
  views: FakeView[]
  pages: { owner: WebviewOwner; page: WebviewPage }[]
  openWindows: Set<number>
} {
  const views: FakeView[] = []
  const pages: { owner: WebviewOwner; page: WebviewPage }[] = []
  const openWindows = new Set([WIN, OTHER_WIN])
  const manager = new WebviewManager({
    views: {
      create: (windowId, _partition, events) => {
        const view: FakeView = {
          windowId,
          events,
          page: { url: '', title: '' },
          calls: [],
          shown: false,
          destroyed: false,
          async load(url) {
            view.page = { url, title: '' }
          },
          back: () => {},
          forward: () => {},
          reload: () => {},
          current: () => view.page,
          isFocused: () => false,
          setBounds: (b) => view.calls.push(`bounds ${b.x},${b.y},${b.width},${b.height}`),
          setVisible: (v) => {
            view.shown = v
            view.calls.push(`visible ${v}`)
          },
          destroy() {
            view.destroyed = true
          }
        }
        views.push(view)
        return view
      }
    },
    openExternal: () => {},
    isWindowOpen: (id) => openWindows.has(id),
    homeDir: () => '/nonexistent-home-for-tests',
    pageChanged: (o, page) => pages.push({ owner: o, page }),
    log: () => {}
  })
  return { manager, views, pages, openWindows }
}

describe('webview cover/hide state machine (main)', () => {
  it('shows a view only while the last report says so, with an area, and moves it first', async () => {
    const { manager, views } = setup()
    await manager.navigate(owner(), 'https://example.com/')
    const view = views[0] as FakeView
    // No report yet: hidden at zero bounds.
    expect(view.shown).toBe(false)
    expect(manager.isShown(WIN, 'a.one', 'view')).toBe(false)
    manager.setPlacement(WIN, 'a.one', 'view', at(10, 40, 300, 200))
    expect(view.shown).toBe(true)
    // Bounds go before visibility: a view coming back appears at its new place.
    expect(view.calls.slice(-2)).toEqual(['bounds 10,40,300,200', 'visible true'])
    // The panel collapsed, a menu opened, a drag started: the renderer says not visible.
    manager.setPlacement(WIN, 'a.one', 'view', at(10, 40, 300, 200, false))
    expect(view.shown).toBe(false)
    manager.setPlacement(WIN, 'a.one', 'view', at(10, 40, 300, 200))
    expect(view.shown).toBe(true)
    // An empty area never shows, whatever `visible` says.
    manager.setPlacement(WIN, 'a.one', 'view', at(10, 40, 0, 200))
    expect(view.shown).toBe(false)
  })

  it('hides every view of a window while it has an overlay, and puts them back after', async () => {
    const { manager, views } = setup()
    await manager.navigate(owner(), 'https://example.com/')
    await manager.navigate(owner(WIN, 'P1', 'a.one', 'side'), 'https://example.com/')
    await manager.navigate(owner(OTHER_WIN, 'P2'), 'https://example.com/')
    manager.setPlacement(WIN, 'a.one', 'view', at(0, 0, 100, 100))
    manager.setPlacement(WIN, 'a.one', 'side', at(0, 100, 100, 100))
    manager.setPlacement(OTHER_WIN, 'a.one', 'view', at(0, 0, 100, 100))
    expect(views.map((v) => v.shown)).toEqual([true, true, true])

    manager.setWindowCovered(WIN, true)
    expect(views.map((v) => v.shown)).toEqual([false, false, true])
    // A report while covered is kept but does not show the view.
    manager.setPlacement(WIN, 'a.one', 'view', at(5, 5, 120, 100))
    expect((views[0] as FakeView).shown).toBe(false)
    expect(manager.isShown(WIN, 'a.one', 'view')).toBe(false)

    manager.setWindowCovered(WIN, false)
    expect(views.map((v) => v.shown)).toEqual([true, true, true])
    expect((views[0] as FakeView).calls.slice(-2)).toEqual(['bounds 5,5,120,100', 'visible true'])
  })

  it('a view created while its window is covered starts hidden; a closed window forgets the cover', async () => {
    const { manager, views } = setup()
    manager.setPlacement(WIN, 'a.one', 'view', at(0, 0, 100, 100))
    manager.setWindowCovered(WIN, true)
    await manager.navigate(owner(), 'https://example.com/')
    expect((views[0] as FakeView).shown).toBe(false)
    manager.closeWindow(WIN)
    manager.setPlacement(WIN, 'a.one', 'view', at(0, 0, 100, 100))
    await manager.navigate(owner(), 'https://example.com/')
    expect((views[1] as FakeView).shown).toBe(true)
  })

  it('ignores reports from another window: they only move that window\'s own view', async () => {
    const { manager, views } = setup()
    await manager.navigate(owner(), 'https://example.com/')
    manager.setPlacement(WIN, 'a.one', 'view', at(0, 0, 100, 100, false))
    const view = views[0] as FakeView
    const before = [...view.calls]
    // Window 8 shows the same plugin's panel (another project): its report is keyed by window 8.
    manager.setPlacement(OTHER_WIN, 'a.one', 'view', at(50, 50, 400, 400))
    expect(view.calls).toEqual(before)
    expect(view.shown).toBe(false)
  })

  it('hides a window\'s views when its page reloads, until the new page reports', async () => {
    const { manager, views } = setup()
    await manager.navigate(owner(), 'https://example.com/')
    manager.setPlacement(WIN, 'a.one', 'view', at(0, 0, 100, 100))
    manager.resetWindow(WIN)
    expect((views[0] as FakeView).shown).toBe(false)
    manager.setPlacement(WIN, 'a.one', 'view', at(0, 0, 100, 100))
    expect((views[0] as FakeView).shown).toBe(true)
  })

  it('tells the window what the view shows (coalesced), and an empty page when it goes', async () => {
    vi.useFakeTimers()
    try {
      const { manager, views, pages, openWindows } = setup()
      await manager.navigate(owner(), 'https://example.com/')
      const view = views[0] as FakeView
      view.page = { url: 'https://example.com/a', title: 'A' }
      view.events.navigated(true)
      view.page = { url: 'https://example.com/b', title: 'B' }
      view.events.navigated(true)
      expect(pages.map((p) => p.page.url)).toEqual(['https://example.com/a'])
      vi.advanceTimersByTime(NAVIGATED_COALESCE_MS)
      expect(pages.map((p) => p.page.url)).toEqual(['https://example.com/a', 'https://example.com/b'])
      expect(pages[0]?.owner).toEqual(owner())
      manager.destroyPlugin(WIN, 'a.one')
      expect(pages.at(-1)?.page).toEqual({ url: '', title: '' })
      // A closing window is not told anything.
      await manager.navigate(owner(), 'https://example.com/')
      openWindows.delete(WIN)
      const count = pages.length
      manager.closeWindow(WIN)
      expect(pages).toHaveLength(count)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('forwardedCommand (app chords typed into a webview)', () => {
  const table: Record<string, string> = {
    'meta+t': 'tab.newClaude',
    'meta+shift+b': 'zone.toggleRight',
    escape: 'overlay.pop',
    'meta+shift+w': 'overlay.closeTop',
    'ctrl+k': 'a.one/run',
    'alt+x': 'a.one/alt',
    f5: 'a.one/bare',
    k: 'a.one/letter'
  }
  const lookup = (chord: string): string | undefined => table[chord]

  it('forwards a bound chord with Cmd, Ctrl or Alt', () => {
    expect(forwardedCommand('meta+t', lookup)).toBe('tab.newClaude')
    expect(forwardedCommand('meta+shift+b', lookup)).toBe('zone.toggleRight')
    expect(forwardedCommand('ctrl+k', lookup)).toBe('a.one/run')
    expect(forwardedCommand('alt+x', lookup)).toBe('a.one/alt')
  })

  it('leaves the page its keys: unbound, bare or shifted-only chords, and the overlay keys', () => {
    expect(forwardedCommand('meta+y', lookup)).toBeUndefined()
    expect(forwardedCommand('f5', lookup)).toBeUndefined()
    expect(forwardedCommand('k', lookup)).toBeUndefined()
    expect(forwardedCommand('shift+k', lookup)).toBeUndefined()
    expect(forwardedCommand('escape', lookup)).toBeUndefined()
    expect(forwardedCommand('meta+shift+w', lookup)).toBeUndefined()
    expect(forwardedCommand('', lookup)).toBeUndefined()
  })
})

describe('webviewChord (main\'s routing of a chord typed into a view)', () => {
  // Window 1 has an overlay up that takes Esc; window 2 is another project's window.
  function setup(opts: { overlayTakes?: string; closed?: number[] } = {}) {
    const log: string[] = []
    const deps: WebviewChordDeps = {
      overlayChord: (w, c) => {
        log.push(`overlay ${w} ${c}`)
        return c === opts.overlayTakes
      },
      // Each window has its own key table (user overrides): only window 1 binds meta+t.
      commandFor: (w, c) => (w === 1 && c === 'meta+t' ? 'tab.newClaude' : w === 2 && c === 'meta+j' ? 'zone.toggleBottom' : undefined),
      shell: (w) =>
        opts.closed?.includes(w)
          ? undefined
          : { focus: () => void log.push(`focus ${w}`), trigger: (id) => void log.push(`trigger ${w} ${id}`) }
    }
    return { log, route: (w: number, c: string) => webviewChord(deps, w, c) }
  }

  it('the overlay keys go first; a chord an overlay takes is not run as a command', () => {
    const { log, route } = setup({ overlayTakes: 'meta+t' })
    expect(route(1, 'meta+t')).toBe(true)
    expect(log).toEqual(['overlay 1 meta+t'])
  })

  it('a forwarded command focuses and triggers in the owning window only, focus first', () => {
    const { log, route } = setup()
    expect(route(1, 'meta+t')).toBe(true)
    expect(log).toEqual(['overlay 1 meta+t', 'focus 1', 'trigger 1 tab.newClaude'])
    log.length = 0
    // Window 2's table is used for window 2's view: meta+t is unbound there, the page keeps it.
    expect(route(2, 'meta+t')).toBe(false)
    expect(route(2, 'meta+j')).toBe(true)
    expect(log).toEqual(['overlay 2 meta+t', 'overlay 2 meta+j', 'focus 2', 'trigger 2 zone.toggleBottom'])
  })

  it('leaves the key to the page when nothing takes it or the window is gone', () => {
    const { log, route } = setup({ closed: [1] })
    expect(route(1, 'k')).toBe(false)
    expect(route(1, 'meta+t')).toBe(false)
    expect(log).toEqual(['overlay 1 k', 'overlay 1 meta+t'])
  })
})

// --- router -------------------------------------------------------------------------------------

type Listener = (event: IpcEventLike, ...args: unknown[]) => unknown
const APP_FILE = '/opt/cc-cockpit/out/renderer/index.html'
const APP_PAGE = 'file:///opt/cc-cockpit/out/renderer/index.html'

class FakeIpcMain implements IpcMainLike {
  readonly handlers = new Map<string, Listener>()
  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener)
  }
  invoke(channel: string, senderId: number, payload?: unknown): Promise<unknown> {
    const listener = this.handlers.get(channel)
    if (!listener) return Promise.reject(new Error(`no handler for ${channel}`))
    return Promise.resolve().then(() => listener({ sender: { id: senderId }, senderFrame: { parent: null, url: APP_PAGE } }, payload))
  }
}

describe('registerWebviewHandlers', () => {
  /** webContents 11 is project P1's window (7), 12 project P2's (8), 13 the picker. */
  const senders = new Map<number, SenderContext>([
    [11, { kind: 'project', windowId: WIN, projectId: 'P1' }],
    [12, { kind: 'project', windowId: OTHER_WIN, projectId: 'P2' }],
    [13, { kind: 'picker', windowId: 9 }]
  ])

  function routerSetup(): { ipc: FakeIpcMain; calls: unknown[][] } {
    const ipc = new FakeIpcMain()
    const router = new IpcRouter(ipc, (id) => senders.get(id), appPageMatcher({ kind: 'file', path: APP_FILE }), () => {})
    const calls: unknown[][] = []
    registerWebviewHandlers(router, {
      // P1 has a.one/view; P2 has none.
      panel: (projectId, panelKey) => (projectId === 'P1' && panelKey === 'a.one/view' ? { pluginId: 'a.one', panelId: 'view' } : undefined),
      views: {
        setPlacement: (...args) => calls.push(['placement', ...args]),
        back: (o) => calls.push(['back', o]),
        forward: (o) => calls.push(['forward', o]),
        reload: (o) => calls.push(['reload', o]),
        current: (o) => {
          calls.push(['current', o])
          return { url: 'https://example.com/', title: 'Example' }
        }
      }
    })
    return { ipc, calls }
  }

  it('passes a report on with the sender\'s window, never one from the payload', async () => {
    const { ipc, calls } = routerSetup()
    await ipc.invoke('webviews.placement', 11, { panelKey: 'a.one/view', x: 1, y: 2, width: 3, height: 4, visible: true, windowId: 99 })
    expect(calls).toEqual([['placement', WIN, 'a.one', 'view', { bounds: { x: 1, y: 2, width: 3, height: 4 }, visible: true }]])
  })

  it('refuses a panel that is not a webview panel of the sender\'s project', async () => {
    const { ipc, calls } = routerSetup()
    // Window 8 (project P2) naming P1's panel: not a panel of ITS project.
    await expect(
      ipc.invoke('webviews.placement', 12, { panelKey: 'a.one/view', x: 0, y: 0, width: 10, height: 10, visible: true })
    ).rejects.toThrow(/not a webview panel of this project/)
    await expect(ipc.invoke('webviews.step', 11, { panelKey: 'core/sessions', step: 'back' })).rejects.toThrow(/not a webview panel/)
    await expect(ipc.invoke('webviews.current', 13, { panelKey: 'a.one/view' })).rejects.toThrow(/not a project window/)
    expect(calls).toEqual([])
  })

  it('checks the payload shape', async () => {
    const { ipc, calls } = routerSetup()
    await expect(ipc.invoke('webviews.placement', 11, { panelKey: 'a.one/view', x: '1', y: 0, width: 1, height: 1, visible: true })).rejects.toThrow(
      /must be numbers/
    )
    await expect(ipc.invoke('webviews.placement', 11, { panelKey: 'a.one/view', x: 1, y: 0, width: 1, height: 1, visible: 'yes' })).rejects.toThrow(
      /visible must be a boolean/
    )
    await expect(ipc.invoke('webviews.step', 11, { panelKey: 'a.one/view', step: 'close' })).rejects.toThrow(/back, forward or reload/)
    await expect(ipc.invoke('webviews.step', 11, 'nope')).rejects.toThrow(/bad payload/)
    expect(calls).toEqual([])
  })

  it('runs toolbar steps and reads the page of the sender\'s own view', async () => {
    const { ipc, calls } = routerSetup()
    await ipc.invoke('webviews.step', 11, { panelKey: 'a.one/view', step: 'reload' })
    await expect(ipc.invoke('webviews.current', 11, { panelKey: 'a.one/view' })).resolves.toEqual({ url: 'https://example.com/', title: 'Example' })
    const o = { windowId: WIN, projectId: 'P1', pluginId: 'a.one', panelId: 'view' }
    expect(calls).toEqual([
      ['reload', o],
      ['current', o]
    ])
  })
})

// --- layout: show, kind, webviewPanel ------------------------------------------------------------

const P = 'aaaaaaaaaaaaaaaa'

function layoutSetup(): { service: LayoutService; stored: Map<string, LayoutState>; published: LayoutView[] } {
  const stored = new Map<string, LayoutState>([[P, defaultLayout()]])
  const published: LayoutView[] = []
  const service = new LayoutService({
    getLayout: (id) => stored.get(id),
    setLayout: (id, layout) => stored.set(id, layout),
    publish: (_id, view) => published.push(view)
  })
  service.setPluginPanels(P, 'a.one', [
    { id: 'view', title: 'View', kind: 'webview', defaultZone: 'right' },
    { id: 'page', title: 'Page', entry: 'page.html', defaultZone: 'left' }
  ])
  return { service, stored, published }
}

describe('showPanel (shared/layout)', () => {
  const placed = (): LayoutState => {
    let l = defaultLayout()
    l = { ...l, zones: { ...l.zones, right: { ...l.zones.right, panels: [{ panelKey: 'a/v', open: false, size: 200 }] } } }
    return l
  }

  it('opens a closed panel, expands its zone, and unhides a hidden one', () => {
    const opened = showPanel(placed(), 'a/v')
    expect(opened.zones.right.panels[0]?.open).toBe(true)
    const collapsed = setZoneCollapsed(opened, 'right', true)
    expect(showPanel(collapsed, 'a/v').zones.right.collapsed).toBe(false)
    const hidden = hidePanel(collapsed, 'a/v')
    const back = showPanel(hidden, 'a/v')
    expect(back.hidden).toEqual([])
    expect(zoneOf(back, 'a/v')).toBe('right')
    expect(back.zones.right.panels.find((p) => p.panelKey === 'a/v')?.open).toBe(true)
    expect(back.zones.right.collapsed).toBe(false)
  })

  it('leaves a shown panel and an unknown one alone', () => {
    const shown = showPanel(placed(), 'a/v')
    expect(showPanel(shown, 'a/v')).toBe(shown)
    const l = placed()
    expect(showPanel(l, 'nope/x')).toBe(l)
  })
})

describe('LayoutService and webview panels', () => {
  it('marks webview panels for the renderer and resolves only those by key', () => {
    const { service } = layoutSetup()
    const panels = service.view(P)!.panels
    expect(panels.find((p) => p.panelKey === 'a.one/view')).toMatchObject({ kind: 'webview' })
    expect(panels.find((p) => p.panelKey === 'a.one/view')?.src).toBeUndefined()
    expect(panels.find((p) => p.panelKey === 'a.one/page')?.kind).toBeUndefined()
    expect(service.webviewPanel(P, 'a.one/view')).toEqual({ pluginId: 'a.one', panelId: 'view' })
    expect(service.webviewPanel(P, 'a.one/page')).toBeUndefined()
    expect(service.webviewPanel(P, 'core/sessions')).toBeUndefined()
    expect(service.webviewPanel('other', 'a.one/view')).toBeUndefined()
    expect(service.webviewPanel(P, 42)).toBeUndefined()
    expect(service.webviewPanel(P, 'view')).toBeUndefined()
  })

  it('show stores and publishes the shown layout once, and refuses a panel the project lacks', () => {
    const { service, stored, published } = layoutSetup()
    stored.set(P, setZoneCollapsed(service.view(P)!.layout, 'right', true))
    const before = published.length
    expect(service.show(P, 'a.one/view')).toBe(true)
    const layout = stored.get(P)!
    expect(layout.zones.right.collapsed).toBe(false)
    expect(layout.zones.right.panels.find((p) => p.panelKey === 'a.one/view')?.open).toBe(true)
    expect(published).toHaveLength(before + 1)
    // Already shown: nothing to store or publish.
    expect(service.show(P, 'a.one/view')).toBe(true)
    expect(published).toHaveLength(before + 1)
    expect(service.show(P, 'a.two/view')).toBe(false)
  })
})

// --- ctx.panels.show: host and main ----------------------------------------------------------------

describe('ctx.panels.show', () => {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  it('host: asks main for a declared panel of either kind, throws for an undeclared one, logs a refusal', async () => {
    const calls: { method: string; params: unknown }[] = []
    const logs: string[] = []
    const deps: ContextDeps = {
      log: (_id, _level, text) => logs.push(text),
      call: async (method, params) => {
        calls.push({ method, params })
        if ((params as { panelId?: string }).panelId === 'page') throw new Error('panels.show: no panel a.one/page in this window')
        return null
      }
    }
    const ctx = new HostContexts(deps).create(
      hostSpec({ id: 'a.one', dir: '/p/one', main: 'h.js', panels: ['view', 'page'], webviewPanels: ['view'] })
    )
    ctx.panels.show('view')
    ctx.panels.show('page')
    expect(() => ctx.panels.show('other')).toThrow('panel "other" is not declared')
    await flush()
    expect(calls).toEqual([
      { method: 'panels.show', params: { pluginId: 'a.one', panelId: 'view' } },
      { method: 'panels.show', params: { pluginId: 'a.one', panelId: 'page' } }
    ])
    expect(logs).toContain('panels.show page: panels.show: no panel a.one/page in this window')
  })

  function api(showPanel?: HostApiDeps['showPanel']): HostApi {
    const deps: HostApiDeps = {
      listSessions: () => [],
      session: () => undefined,
      send: () => {
        throw new Error('unused')
      },
      onSessionsChange: () => () => {},
      openTab: async () => {
        throw new Error('unused')
      },
      setBadge: () => true,
      ...(showPanel ? { showPanel } : {}),
      openOverlay: async () => {
        throw new Error('unused')
      },
      secrets: unusedSecrets,
      oauth: unusedOAuth,
      log: () => {}
    }
    return new HostApi(
      deps,
      {
        projectId: 'P1',
        windowId: WIN,
        projectDir: '/p',
        plugins: [
          { id: 'a.one', dir: '/p/one', panels: ['view', 'page'], webviewPanels: ['view'] },
          { id: 'a.two', dir: '/p/two', panels: ['inbox'] }
        ]
      },
      () => {}
    )
  }
  const call = (a: HostApi, params: unknown): Promise<unknown> => Promise.resolve().then(() => a.handlers['panels.show']?.(params))

  it('main: shows the plugin\'s own panel in the host\'s project, refuses anything else', async () => {
    const shown: string[][] = []
    const a = api((projectId, key) => {
      shown.push([projectId, key])
      return key !== 'a.one/page'
    })
    await expect(call(a, { pluginId: 'a.one', panelId: 'view' })).resolves.toBeNull()
    await expect(call(a, { pluginId: 'a.one', panelId: 'page' })).rejects.toThrow(/no panel a\.one\/page in this window/)
    // Another plugin's panel, a core panel, an unknown plugin: refused before the layout is asked.
    await expect(call(a, { pluginId: 'a.one', panelId: 'inbox' })).rejects.toThrow(/declares no panel "inbox"/)
    await expect(call(a, { pluginId: 'a.two', panelId: 'core/sessions' })).rejects.toThrow(/declares no panel/)
    await expect(call(a, { pluginId: 'a.three', panelId: 'view' })).rejects.toThrow(/unknown plugin/)
    expect(shown).toEqual([
      ['P1', 'a.one/view'],
      ['P1', 'a.one/page']
    ])
    await expect(call(api(), { pluginId: 'a.one', panelId: 'view' })).rejects.toThrow(/not available/)
  })
})

// --- renderer halves ------------------------------------------------------------------------------

describe('PlacementReporter', () => {
  function reporterSetup(): { reporter: PlacementReporter; sent: Placement[]; frame: () => void; scheduled: () => number } {
    const sent: Placement[] = []
    let queued: (() => void) | undefined
    let count = 0
    const reporter = new PlacementReporter(
      (p) => sent.push(p),
      (fn) => {
        count++
        queued = fn
        return () => {
          if (queued === fn) queued = undefined
        }
      }
    )
    return {
      reporter,
      sent,
      frame: () => {
        const fn = queued
        queued = undefined
        fn?.()
      },
      scheduled: () => count
    }
  }
  const p = (x: number, visible = true): Placement => ({ x, y: 0, width: 100, height: 50, visible })

  it('sends a change of visibility at once, and only one move per frame (the latest)', () => {
    const { reporter, sent, frame } = reporterSetup()
    reporter.update(p(1))
    expect(sent).toEqual([p(1)])
    reporter.update(p(2))
    reporter.update(p(3))
    expect(sent).toHaveLength(1)
    frame()
    expect(sent).toEqual([p(1), p(3)])
    // Hiding cancels the queued move and goes out at once.
    reporter.update(p(4))
    reporter.update(p(4, false))
    expect(sent.at(-1)).toEqual(p(4, false))
    frame()
    expect(sent).toHaveLength(3)
  })

  it('sends nothing main already has, rounds sub-pixels, and drops a move that came back', () => {
    const { reporter, sent, frame, scheduled } = reporterSetup()
    reporter.update(p(1))
    reporter.update({ ...p(1), x: 1.2 })
    expect(scheduled()).toBe(0)
    reporter.update(p(5))
    reporter.update(p(1))
    frame()
    expect(sent).toEqual([p(1)])
  })

  it('hides the view when disposed and sends nothing after', () => {
    const { reporter, sent, frame } = reporterSetup()
    reporter.update(p(1))
    reporter.update(p(2))
    reporter.dispose()
    frame()
    expect(sent).toEqual([p(1), p(1, false)])
    reporter.update(p(9))
    expect(sent).toHaveLength(2)
    // A reporter that never showed has nothing to hide.
    const other = reporterSetup()
    other.reporter.dispose()
    expect(other.sent).toEqual([])
  })
})

describe('shell layers', () => {
  it('counts layers, tells listeners, and a second release is harmless', () => {
    const seen: boolean[] = []
    const off = onLayersChange(() => seen.push(layersUp()))
    expect(layersUp()).toBe(false)
    const a = acquireLayer()
    const b = acquireLayer()
    a()
    a()
    expect(layersUp()).toBe(true)
    b()
    expect(layersUp()).toBe(false)
    off()
    acquireLayer()()
    expect(seen).toEqual([true, true, true, false])
  })
})
