// Page tab frames (design-editor.md §1 "Frame lifetime", plan Task 2): the renderer's pool of page
// tab frames (renderer/tabs/page-frames.ts: lazy mount, LRU, a new port without a reload on a host
// restart and a web remount), the frame loader's reconnect and resync (renderer/web/port-relay.ts
// FrameLoads), main's relay pausing a page tab's port at the byte limit instead of closing it
// (main/web/port-relay.ts), the hub's page tab connects (main/plugins/panel-ports.ts), and the panel
// SDK's `ccPanel.tab` and `onConnect`. Frames and ports are fakes; no DOM, no Electron.
import { describe, expect, it, vi } from 'vitest'
import { PanelPortHub, type PanelPortDeps, type PageTabRecord } from '../../src/main/plugins/panel-ports'
import { PortRelay as MainPortRelay, RELAY_DRAIN_CHECK_MS, RELAY_HIGH_WATER, RELAY_LOW_WATER } from '../../src/main/web/port-relay'
import { FrameLoads, PortRelay as BrowserPortRelay, type FrameTarget } from '../../src/renderer/web/port-relay'
import { PageFrames, type PageFrameElement, type PageFramesOptions, type PageTabEntry } from '../../src/renderer/tabs/page-frames'
import { PanelClient, PORT_MESSAGE, TAB_MESSAGE, type PortLike, type ThemeRoot } from '../../src/sdk/panel-core'
import { isPageTabPortKey, pageTabPortKey } from '../../src/shared/page-tabs'
import { PANEL_PORT_CHANNEL } from '../../src/shared/ipc'
import { channel, FakePort } from '../fakes/fake-main-port'

const TAB_A = '0b4f6c2e-1d3a-4e5b-8c7d-9e0f1a2b3c4a'
const TAB_B = '0b4f6c2e-1d3a-4e5b-8c7d-9e0f1a2b3c4b'
const TAB_C = '0b4f6c2e-1d3a-4e5b-8c7d-9e0f1a2b3c4c'
const TAB_D = '0b4f6c2e-1d3a-4e5b-8c7d-9e0f1a2b3c4d'

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** A frame element as the pool drives it: what it loaded, whether it is hidden, gone, focused, what was posted. */
class FakeElement implements PageFrameElement {
  readonly loads: string[] = []
  readonly posts: Array<{ type: unknown; ports: number }> = []
  hidden = true
  removed = false
  focused = 0
  private listener: (() => void) | undefined
  constructor(readonly title: string) {}
  load(url: string): void {
    this.loads.push(url)
  }
  setHidden(hidden: boolean): void {
    this.hidden = hidden
  }
  post(message: unknown, transfer?: MessagePort[]): boolean {
    this.posts.push({ type: (message as { type?: unknown }).type, ports: transfer?.length ?? 0 })
    return true
  }
  onLoad(listener: () => void): void {
    this.listener = listener
  }
  remove(): void {
    this.removed = true
  }
  focus(): void {
    this.focused++
  }
  /** The page in it finished loading. */
  fire(): void {
    this.listener?.()
  }
  types(): unknown[] {
    return this.posts.map((p) => p.type)
  }
}

const entry = (id: string, plugin = 'a.one'): PageTabEntry => ({ id, plugin, type: 'file', title: `t-${id.slice(-1)}` })

function pool(over: Partial<PageFramesOptions> = {}) {
  const elements: FakeElement[] = []
  const srcAsked: string[] = []
  const connects: Array<{ tabId: string; deliver: (port: MessagePort) => void; cancelled: boolean }> = []
  const disconnects: string[] = []
  const pages: Record<string, string | null> = {}
  const frames = new PageFrames({
    createFrame: (title) => {
      const el = new FakeElement(title)
      elements.push(el)
      return el
    },
    src: (tabId) => {
      srcAsked.push(tabId)
      return Promise.resolve(tabId in pages ? pages[tabId]! : `cc-plugin://a.one/tab.html`)
    },
    pageUrl: (src) => src,
    connect: (tabId, deliver) => {
      const c = { tabId, deliver, cancelled: false }
      connects.push(c)
      return () => {
        c.cancelled = true
      }
    },
    disconnect: (tabId) => void disconnects.push(tabId),
    guard: false,
    portMessage: { type: PORT_MESSAGE, remote: false },
    theme: () => ({ type: 'cc-plugin.theme' }),
    ...over
  })
  /** The latest element made for the tab whose title ends like `id`. */
  const el = (id: string): FakeElement => elements.filter((e) => e.title === `t-${id.slice(-1)}`).at(-1)!
  const port = (): MessagePort => new MessageChannel().port1
  return { frames, elements, srcAsked, connects, disconnects, pages, el, port }
}

describe('PageFrames: mount on first select', () => {
  it('mounts nothing at restore; the first select asks for the page, loads it, and hands theme, intro and port', async () => {
    const t = pool()
    t.frames.sync([entry(TAB_A), entry(TAB_B)])
    expect(t.srcAsked).toEqual([])
    expect(t.elements).toHaveLength(0)
    t.frames.show(TAB_A)
    await settle()
    expect(t.srcAsked).toEqual([TAB_A])
    expect(t.elements).toHaveLength(1)
    const a = t.el(TAB_A)
    expect(a.loads).toEqual(['cc-plugin://a.one/tab.html'])
    expect(a.hidden).toBe(false)
    // Desktop: the port is asked at the load, after the theme; the intro goes right before it.
    expect(t.connects).toHaveLength(0)
    a.fire()
    expect(t.connects.map((c) => c.tabId)).toEqual([TAB_A])
    t.connects[0]!.deliver(t.port())
    expect(a.types()).toEqual(['cc-plugin.theme', TAB_MESSAGE, PORT_MESSAGE])
    expect(a.posts.at(-1)?.ports).toBe(1)
    // A terminal tab shown: the frame hides, alive.
    t.frames.show(null)
    expect(a.hidden).toBe(true)
    expect(a.removed).toBe(false)
  })

  it('a tab main names no page for (plugin off, the hidden page) mounts nothing until selected again or its host restarts', async () => {
    const t = pool()
    t.pages[TAB_A] = null
    t.frames.sync([entry(TAB_A)])
    t.frames.show(TAB_A)
    await settle()
    expect(t.elements).toHaveLength(0)
    expect(t.frames.isLive(TAB_A)).toBe(false)
    // The same selection again asks nothing more.
    t.frames.show(TAB_A)
    await settle()
    expect(t.srcAsked).toEqual([TAB_A])
    // Its plugin's host came up: asked again, and mounted since it is the one shown.
    t.pages[TAB_A] = 'cc-plugin://a.one/tab.html'
    t.frames.reconnect(['a.one'])
    await settle()
    expect(t.srcAsked).toEqual([TAB_A, TAB_A])
    expect(t.elements).toHaveLength(1)
  })

  it('a tab closed while its page was looked up mounts nothing', async () => {
    const t = pool()
    t.frames.sync([entry(TAB_A)])
    t.frames.show(TAB_A)
    t.frames.sync([])
    await settle()
    expect(t.elements).toHaveLength(0)
  })

  it('focus goes to the live frame of a tab only', async () => {
    const t = pool()
    t.frames.sync([entry(TAB_A)])
    t.frames.focus(TAB_A)
    t.frames.show(TAB_A)
    await settle()
    t.frames.focus(TAB_A)
    expect(t.el(TAB_A).focused).toBe(1)
  })
})

describe('PageFrames: LRU of live frames', () => {
  it('keeps the most recent ones alive and hidden, unmounting the least recent past the cap', async () => {
    const t = pool({ maxLive: 2 })
    t.frames.sync([entry(TAB_A), entry(TAB_B), entry(TAB_C)])
    t.frames.show(TAB_A)
    t.frames.show(TAB_B)
    await settle()
    expect(t.frames.liveIds()).toEqual([TAB_B, TAB_A])
    expect(t.el(TAB_A).hidden).toBe(true)
    // Back to A: no new frame, no new load.
    t.frames.show(TAB_A)
    expect(t.elements).toHaveLength(2)
    expect(t.el(TAB_A).loads).toHaveLength(1)
    // C pushes out B (the least recent), never the shown one.
    t.frames.show(TAB_C)
    await settle()
    expect(t.frames.liveIds()).toEqual([TAB_C, TAB_A])
    expect(t.el(TAB_B).removed).toBe(true)
    expect(t.disconnects).toEqual([TAB_B])
    // B again loads afresh in a new element.
    t.frames.show(TAB_B)
    await settle()
    expect(t.el(TAB_B).removed).toBe(false)
    expect(t.elements).toHaveLength(4)
  })

  it('never unmounts a frame `keep` holds (a page with unsaved text)', async () => {
    const t = pool({ maxLive: 2, keep: (id) => id === TAB_A })
    t.frames.sync([entry(TAB_A), entry(TAB_B), entry(TAB_C), entry(TAB_D)])
    for (const id of [TAB_A, TAB_B, TAB_C, TAB_D]) t.frames.show(id)
    await settle()
    expect(t.frames.liveIds()).toEqual([TAB_D, TAB_A])
    expect(t.el(TAB_A).removed).toBe(false)
  })

  it("unmounts the frame of a tab that left the list, and tells main", async () => {
    const t = pool()
    t.frames.sync([entry(TAB_A), entry(TAB_B)])
    t.frames.show(TAB_A)
    await settle()
    t.frames.sync([entry(TAB_B)])
    expect(t.el(TAB_A).removed).toBe(true)
    expect(t.disconnects).toEqual([TAB_A])
    expect(t.frames.liveIds()).toEqual([])
  })
})

describe('PageFrames: a new port, never a reload', () => {
  async function served(t: ReturnType<typeof pool>, id: string): Promise<FakeElement> {
    t.frames.show(id)
    await settle()
    const el = t.el(id)
    el.fire()
    t.connects.at(-1)!.deliver(t.port())
    return el
  }

  it("host restart: the plugin's frames keep their page and get a new port; another plugin's are left alone", async () => {
    const t = pool()
    t.frames.sync([entry(TAB_A, 'a.one'), entry(TAB_B, 'b.two')])
    const a = await served(t, TAB_A)
    const b = await served(t, TAB_B)
    const before = t.connects.length
    t.frames.reconnect(['a.one'])
    // The old request is cancelled; a new one asked at once, for the page already served.
    expect(t.connects[0]!.cancelled).toBe(true)
    expect(t.connects.slice(before).map((c) => c.tabId)).toEqual([TAB_A])
    t.connects.at(-1)!.deliver(t.port())
    expect(a.loads).toHaveLength(1)
    expect(a.removed).toBe(false)
    expect(t.elements).toHaveLength(2)
    expect(a.types().slice(-2)).toEqual([TAB_MESSAGE, PORT_MESSAGE])
    expect(b.types().filter((x) => x === PORT_MESSAGE)).toHaveLength(1)
  })

  it('web reconnect: the pool outlives the tab area, so a remounted one finds the same frames and every one reconnects', async () => {
    const t = pool()
    t.frames.sync([entry(TAB_A)])
    const a = await served(t, TAB_A)
    // The shell remounts: a fresh tab list (same tabs), the same selection, then reconnect all.
    t.frames.show(null)
    t.frames.sync([entry(TAB_A)])
    t.frames.show(TAB_A)
    t.frames.reconnect()
    t.connects.at(-1)!.deliver(t.port())
    expect(t.elements).toHaveLength(1)
    expect(a.loads).toHaveLength(1)
    expect(a.types().filter((x) => x === PORT_MESSAGE)).toHaveLength(2)
  })
})

/** A frame for FrameLoads alone: what loaded, remounted, posted. */
class FakeTarget implements FrameTarget {
  readonly loads: string[] = []
  readonly remounts: number[] = []
  readonly posts: unknown[] = []
  gen = 0
  load(url: string): void {
    this.loads.push(url)
  }
  remount(frame: number): void {
    this.gen = frame
    this.remounts.push(frame)
  }
  post(message: unknown): boolean {
    this.posts.push((message as { type?: unknown }).type)
    return true
  }
}

describe('FrameLoads.reconnect (web shell)', () => {
  it('lets the old relayed port go and hands the served page a new one with no load; a resync from main does the same', () => {
    const target = new FakeTarget()
    const sent: Array<Record<string, unknown>> = []
    let page: MessagePort | undefined
    const relay = new BrowserPortRelay({ send: (f) => (sent.push(f), true), deliver: (_k, _n, p) => ((page = p), true) })
    const delivers: Array<(port: MessagePort) => void> = []
    const loads = new FrameLoads({
      guard: true,
      early: true,
      portMessage: { type: PORT_MESSAGE },
      target,
      theme: () => ({ type: 'cc-plugin.theme' }),
      intro: () => ({ type: TAB_MESSAGE }),
      connect: (deliver) => {
        delivers.push(deliver)
        return () => {}
      }
    })
    const key = pageTabPortKey(TAB_A)
    loads.started('/p/t/a.one/tab.html')
    relay.open(key, 1)
    delivers[0]!(page!)
    loads.loaded(target.gen)
    expect(target.posts).toEqual(['cc-plugin.theme', TAB_MESSAGE, PORT_MESSAGE])

    loads.reconnect()
    // The old port is let go (main hears it); a new one is asked, and handed with no load or remount.
    expect(sent).toEqual([{ t: 'port.close', key, nonce: 1 }])
    expect(delivers).toHaveLength(2)
    relay.open(key, 2)
    delivers[1]!(page!)
    expect(target.posts.slice(3)).toEqual([TAB_MESSAGE, PORT_MESSAGE])
    expect(target.loads).toEqual([])
    expect(target.remounts).toEqual([])

    // main: `port.resync` for the held nonce (a stale one does nothing).
    relay.resync(key, 1)
    expect(delivers).toHaveLength(2)
    relay.resync(key, 2)
    expect(delivers).toHaveLength(3)
    expect(target.remounts).toEqual([])

    // main ending a page tab's port (the host went) is not followed by a reload.
    vi.useFakeTimers()
    try {
      relay.open(key, 3)
      delivers[2]!(page!)
      relay.remoteClosed(key, 3)
      vi.advanceTimersByTime(10_000)
      expect(target.remounts).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a frame still loading asks again for the same load; a stopped or unstarted one asks nothing', () => {
    const target = new FakeTarget()
    const delivers: Array<(port: MessagePort) => void> = []
    const loads = new FrameLoads({
      guard: true,
      early: true,
      portMessage: { type: PORT_MESSAGE },
      target,
      connect: (deliver) => {
        delivers.push(deliver)
        return () => {}
      }
    })
    loads.reconnect()
    expect(delivers).toHaveLength(0)
    loads.started('/p/t/a.one/tab.html')
    expect(delivers).toHaveLength(1)
    loads.reconnect()
    expect(delivers).toHaveLength(2)
    // The first request's late port is dropped; the second's waits for the load.
    const late = new MessageChannel()
    delivers[0]!(late.port1)
    loads.loaded(target.gen)
    expect(target.posts).toEqual([])
    delivers[1]!(new MessageChannel().port1)
    expect(target.posts).toEqual([PORT_MESSAGE])
  })
})

describe('main relay: a page tab port is paused and resynced, not closed', () => {
  function relay() {
    let buffered = 0
    const sent: Array<Record<string, unknown>> = []
    const logs: string[] = []
    const timers: Array<() => void> = []
    const r = new MainPortRelay({
      send: (frame) => (sent.push(frame), true),
      buffered: () => buffered,
      log: (m) => logs.push(m),
      setTimeout: (fn, ms) => {
        expect(ms).toBe(RELAY_DRAIN_CHECK_MS)
        timers.push(fn)
        return timers.length
      },
      clearTimeout: () => {}
    })
    const tick = (): void => {
      for (const fn of timers.splice(0)) fn()
    }
    return { r, sent, logs, tick, setBuffered: (n: number) => (buffered = n) }
  }

  it('drops the host messages while behind, keeps the port, and says port.resync once the socket drained', async () => {
    const t = relay()
    const key = pageTabPortKey(TAB_A)
    expect(isPageTabPortKey(key)).toBe(true)
    const ch = channel(1)
    t.r.take(PANEL_PORT_CHANNEL, { panelKey: key, nonce: 4 }, ch.renderer)
    t.setBuffered(RELAY_HIGH_WATER + 1)
    ch.host.postMessage('"one"')
    await settle()
    expect(t.r.paused(key)).toBe(true)
    expect(ch.host.closed).toBe(false)
    expect(t.r.size()).toBe(1)
    expect(t.logs.some((m) => m.includes('paused'))).toBe(true)
    // Still behind (above the low water): nothing is said, messages keep being dropped.
    t.setBuffered(RELAY_LOW_WATER + 1)
    ch.host.postMessage('"two"')
    await settle()
    t.tick()
    expect(t.sent).toEqual([{ t: 'port.open', key, nonce: 4 }])
    // Drained: the browser is told once; the port stays paused until it is replaced.
    t.setBuffered(0)
    t.tick()
    ch.host.postMessage('"three"')
    await settle()
    t.tick()
    expect(t.sent).toEqual([
      { t: 'port.open', key, nonce: 4 },
      { t: 'port.resync', key, nonce: 4 }
    ])
    // The frame's new port replaces it (the old one closes both ways), and flows.
    const ch2 = channel(2)
    t.r.take(PANEL_PORT_CHANNEL, { panelKey: key, nonce: 5 }, ch2.renderer)
    expect(ch.host.closed).toBe(true)
    ch2.host.postMessage('"four"')
    await settle()
    expect(t.sent.slice(2)).toEqual([
      { t: 'port.close', key, nonce: 4 },
      { t: 'port.open', key, nonce: 5 },
      { t: 'port.msg', key, nonce: 5, m: '"four"' }
    ])
  })

  it('a message the socket cannot carry pauses a page tab port too; closeAll stops the drain check', async () => {
    let ok = true
    const timers: Array<() => void> = []
    const sent: Array<Record<string, unknown>> = []
    const r = new MainPortRelay({
      send: (f) => {
        if (ok || f.t !== 'port.msg') sent.push(f)
        return ok || f.t !== 'port.msg'
      },
      buffered: () => 0,
      log: () => {},
      setTimeout: (fn) => (timers.push(fn), 1),
      clearTimeout: () => void timers.splice(0)
    })
    const key = pageTabPortKey(TAB_A)
    const ch = channel(1)
    r.take(PANEL_PORT_CHANNEL, { panelKey: key, nonce: 1 }, ch.renderer)
    ok = false
    ch.host.postMessage('"big"')
    await settle()
    expect(r.paused(key)).toBe(true)
    expect(ch.host.closed).toBe(false)
    r.closeAll()
    expect(timers).toHaveLength(0)
    expect(sent).toEqual([{ t: 'port.open', key, nonce: 1 }])
  })
})

describe('PanelPortHub: page tabs', () => {
  const D1 = 'desktop:1'
  const W1 = 'web:1'
  function hub(over: Partial<PanelPortDeps<FakePort>> = {}) {
    const toHost: Array<{ projectId: string; open: Record<string, unknown>; port: FakePort }> = []
    const toRenderer: Array<{ viewId: string; payload: { panelKey: string; nonce: number } }> = []
    const closed: unknown[][] = []
    const tabs: Record<string, PageTabRecord> = { [TAB_A]: { id: TAB_A, pluginId: 'a.one', type: 'file', params: { path: 'a.ts' } } }
    let n = 0
    const h = new PanelPortHub<FakePort>({
      createChannel: () => channel(++n),
      runningPanels: () => undefined,
      toHost: () => false,
      toRenderer: (viewId, payload) => void toRenderer.push({ viewId, payload }),
      reload: () => {},
      close: (port) => port.close(),
      pageTab: (projectId, tabId) => (projectId === 'p1' ? tabs[tabId] : undefined),
      pageTabToHost: (projectId, open, port) => {
        toHost.push({ projectId, open, port })
        return true
      },
      pageTabClosed: (projectId, pluginId, tabId, view) => void closed.push([projectId, pluginId, tabId, view]),
      log: () => {},
      ...over
    })
    return { h, toHost, toRenderer, closed }
  }

  it("hands the tab's own plugin its end with main's type and params, and the view the other under @tab/<id>", () => {
    const t = hub()
    expect(t.h.connectPageTab('p1', D1, TAB_A, 3)).toBe(true)
    expect(t.toHost.map((x) => x.open)).toEqual([{ pluginId: 'a.one', id: TAB_A, type: 'file', params: { path: 'a.ts' } }])
    expect(t.toRenderer).toEqual([{ viewId: D1, payload: { panelKey: pageTabPortKey(TAB_A), nonce: 3 } }])
    // A remote view's instance names the view.
    expect(t.h.connectPageTab('p1', W1, TAB_A, 4)).toBe(true)
    expect(t.toHost[1]!.open.view).toBe(W1)
  })

  it('refuses a tab that is not a page tab of the project, a bad id or nonce, or a plugin that does not run', () => {
    const t = hub()
    expect(t.h.connectPageTab('p2', D1, TAB_A, 1)).toBe(false)
    expect(t.h.connectPageTab('p1', D1, TAB_B, 1)).toBe(false)
    expect(t.h.connectPageTab('p1', D1, 'not-a-uuid', 1)).toBe(false)
    expect(t.h.connectPageTab('p1', D1, TAB_A, 1.5)).toBe(false)
    expect(t.toHost).toHaveLength(0)
    const down = hub({ pageTabToHost: () => false })
    expect(down.h.connectPageTab('p1', D1, TAB_A, 1)).toBe(false)
    expect(down.toRenderer).toHaveLength(0)
  })

  it('a reconnect in a view closes that view\'s old instance first; unmount and a view leaving close it once', () => {
    const t = hub()
    t.h.connectPageTab('p1', D1, TAB_A, 1)
    t.h.connectPageTab('p1', W1, TAB_A, 1)
    t.h.connectPageTab('p1', D1, TAB_A, 2)
    expect(t.closed).toEqual([['p1', 'a.one', TAB_A, undefined]])
    t.h.disconnectPageTab('p1', D1, TAB_A)
    t.h.disconnectPageTab('p1', D1, TAB_A)
    expect(t.closed).toHaveLength(2)
    t.h.viewGone(W1)
    expect(t.closed.at(-1)).toEqual(['p1', 'a.one', TAB_A, W1])
    expect(t.closed).toHaveLength(3)
  })
})

describe('panel SDK: ccPanel.tab and onConnect', () => {
  class Port implements PortLike {
    readonly sent: string[] = []
    onmessage: ((event: { data: unknown }) => void) | null = null
    closed = false
    postMessage(message: string): void {
      this.sent.push(message)
    }
    close(): void {
      this.closed = true
    }
  }
  const root: ThemeRoot = { colorScheme: '', setProperty: () => {}, removeProperty: () => undefined }

  it('a page tab learns its type from the shell, and hears every new connection after its queue went out', () => {
    const c = new PanelClient(root)
    const calls: string[] = []
    c.api.onConnect(() => calls.push('connect'))
    c.api.post({ hello: 1 })
    expect(c.api.tab).toBeUndefined()
    c.receive({ type: TAB_MESSAGE, tab: { type: 'file' } }, [])
    expect(c.api.tab).toEqual({ type: 'file' })
    expect(Object.isFrozen(c.api.tab)).toBe(true)
    const first = new Port()
    c.receive({ type: PORT_MESSAGE }, [first])
    expect(first.sent).toEqual(['{"hello":1}'])
    expect(calls).toEqual(['connect'])
    // The host restarted: a new port, the old one closed, the page told to re-send.
    const second = new Port()
    c.receive({ type: PORT_MESSAGE }, [second])
    expect(first.closed).toBe(true)
    expect(calls).toEqual(['connect', 'connect'])
    // The first intro wins; a bad type is ignored.
    c.receive({ type: TAB_MESSAGE, tab: { type: 'Other' } }, [])
    expect(c.api.tab?.type).toBe('file')
  })

  it('a throwing listener does not stop the others; unsubscribe works', () => {
    const warnings: string[] = []
    const c = new PanelClient(root, (m) => warnings.push(m))
    const calls: number[] = []
    c.api.onConnect(() => {
      throw new Error('boom')
    })
    const off = c.api.onConnect(() => calls.push(1))
    c.receive({ type: PORT_MESSAGE }, [new Port()])
    off()
    c.receive({ type: PORT_MESSAGE }, [new Port()])
    expect(calls).toEqual([1])
    expect(warnings.some((w) => w.includes('onConnect'))).toBe(true)
    expect(() => c.api.onConnect(5 as unknown as () => void)).toThrow(TypeError)
  })
})
