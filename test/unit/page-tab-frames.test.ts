// Page tab frames (design-editor.md §1 "Frame lifetime", plan Task 2): the renderer's pool of page
// tab frames (renderer/tabs/page-frames.ts: lazy mount, LRU, a new port without a reload on a host
// restart and a web remount), the frame loader's reconnect and resync (renderer/web/port-relay.ts
// FrameLoads), main's relay pausing a page tab's port at the byte limit instead of closing it
// (main/web/port-relay.ts), the hub's page tab connects (main/plugins/panel-ports.ts), and the panel
// SDK's `ccPanel.tab` and `onConnect`. Frames and ports are fakes; no DOM, no Electron.
import { describe, expect, it, vi } from 'vitest'
import { PanelPortHub, type PanelPortDeps, type PageTabRecord } from '../../src/main/plugins/panel-ports'
import { PortRelay as MainPortRelay, RELAY_DRAIN_CHECK_MS, RELAY_HIGH_WATER, RELAY_LOW_WATER, RELAY_PAGE_TAB_HIGH_WATER } from '../../src/main/web/port-relay'
import { FrameLoads, PortRelay as BrowserPortRelay, type FrameTarget } from '../../src/renderer/web/port-relay'
import { ReadyReconnects, layerBox, pageTabEntries } from '../../src/renderer/tabs/page-frames'
import { pageTabMarks } from '../../src/renderer/tabs/tab-label'
import type { TabInfo } from '../../src/shared/ipc'
import { PanelClient, PORT_MESSAGE, TAB_MESSAGE, type PortLike, type ThemeRoot } from '../../src/sdk/panel-core'
import { isPageTabPortKey, pageTabPortKey } from '../../src/shared/page-tabs'
import { PANEL_PORT_CHANNEL } from '../../src/shared/ipc'
import { channel, FakePort } from '../fakes/fake-main-port'

import { entry, FakeElement, pool, settle, TAB_A, TAB_B, TAB_C, TAB_D } from '../fakes/fake-page-frames'

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

  it('a first select asks for focus while the page is looked up: the frame takes it once loaded, unless another tab is shown by then', async () => {
    const t = pool()
    t.frames.sync([entry(TAB_A), entry(TAB_B)])
    t.frames.show(TAB_A)
    t.frames.focus(TAB_A)
    await settle()
    // Not before its page is there (a frame focused before its load leaves the page without the keyboard).
    expect(t.el(TAB_A).focused).toBe(0)
    t.el(TAB_A).fire()
    expect(t.el(TAB_A).focused).toBe(1)
    // Once: a later load (a reload of the page) takes nothing by itself.
    t.el(TAB_A).fire()
    expect(t.el(TAB_A).focused).toBe(1)
    t.frames.show(TAB_B)
    t.frames.focus(TAB_B)
    t.frames.show(TAB_A)
    await settle()
    t.el(TAB_B).fire()
    expect(t.el(TAB_B).focused).toBe(0)
  })

  it('a frame that cannot be made (pageUrl or createFrame throws) is no unhandled rejection; the tab is tried again on its next select', async () => {
    const logs: string[] = []
    let fail = true
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown): void => void unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      const t = pool({
        pageUrl: (src) => {
          if (fail) throw new Error('bad url')
          return src
        },
        log: (m) => logs.push(m)
      })
      t.frames.sync([entry(TAB_A)])
      t.frames.show(TAB_A)
      await settle()
      await new Promise((r) => setTimeout(r, 0))
      expect(unhandled).toEqual([])
      expect(logs.join('\n')).toMatch(/could not be made: Error: bad url/)
      expect(t.frames.isLive(TAB_A)).toBe(false)
      fail = false
      t.frames.show(null)
      t.frames.show(TAB_A)
      await settle()
      expect(t.elements).toHaveLength(1)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
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

  it("web reconnect as it really happens: the fresh pane's empty list before tabs.list unmounts nothing, the frame keeps its page and takes one new port", async () => {
    const t = pool()
    const readies = new ReadyReconnects(() => t.frames.reconnect())
    readies.ready(1)
    t.frames.sync([entry(TAB_A), entry(TAB_B)])
    const a = await served(t, TAB_A)
    const before = t.connects.length
    // The bridge's new `ready` (before the shell mounts again): every live frame asks for a new port.
    readies.ready(2)
    expect(t.connects.slice(before).map((c) => c.tabId)).toEqual([TAB_A])
    // The old shell went (its tab area hid the layer); the new pane mounts with no list yet.
    t.frames.show(null)
    t.frames.sync(undefined)
    expect(t.frames.liveIds()).toEqual([TAB_A])
    expect(a.removed).toBe(false)
    expect(t.disconnects).toEqual([])
    // tabs.list answers: the same tabs, the same selection.
    t.frames.sync([entry(TAB_A), entry(TAB_B)])
    t.frames.show(TAB_A)
    t.connects.at(-1)!.deliver(t.port())
    expect(t.elements).toHaveLength(1)
    expect(a.loads).toHaveLength(1)
    expect(a.hidden).toBe(false)
    // One new port only: the show of a live frame asks nothing of its own.
    expect(t.connects).toHaveLength(before + 1)
    expect(a.types().filter((x) => x === PORT_MESSAGE)).toHaveLength(2)
  })

  it('an empty list once the pane has listed still unmounts (every tab closed)', async () => {
    const t = pool()
    t.frames.sync([entry(TAB_A)])
    await served(t, TAB_A)
    t.frames.sync([])
    expect(t.frames.liveIds()).toEqual([])
    expect(t.disconnects).toEqual([TAB_A])
  })
})

describe('ReadyReconnects: the web reconnect signal', () => {
  it('reconnects at every newer ready after the first, never at the first nor a repeated or older one (a remount that is no reconnect)', () => {
    const calls: number[] = []
    let n = 0
    const r = new ReadyReconnects(() => calls.push(++n))
    r.ready(1)
    r.ready(1)
    expect(calls).toEqual([])
    r.ready(2)
    r.ready(2)
    r.ready(1)
    expect(calls).toEqual([1])
    r.ready(4)
    expect(calls).toEqual([1, 2])
  })
})

describe('page tab area helpers', () => {
  it('lays the layer over the placeholder only while a page tab shows and the box has a size', () => {
    const rect = { left: 10, top: 20, width: 300, height: 200 }
    expect(layerBox(true, rect)).toEqual(rect)
    expect(layerBox(false, rect)).toBeNull()
    expect(layerBox(true, undefined)).toBeNull()
    expect(layerBox(true, { ...rect, width: 0 })).toBeNull()
    expect(layerBox(true, { ...rect, height: 0 })).toBeNull()
  })

  it('takes the page tabs of a list, with their plugin, type and title; terminal tabs and a page tab with no spec are skipped', () => {
    const tabs = [
      { id: 't1', kind: 'shell' },
      { id: TAB_A, kind: 'page', page: { plugin: 'a.one', type: 'file', title: 'x.ts' } },
      { id: TAB_B, kind: 'page' }
    ] as unknown as TabInfo[]
    expect(pageTabEntries(tabs)).toEqual([{ id: TAB_A, plugin: 'a.one', type: 'file', title: 'x.ts' }])
  })

  it("names a page tab's dirty and unseen marks for its tooltip", () => {
    const tab = (over: Record<string, unknown>): TabInfo => ({ id: TAB_A, kind: 'page', ...over }) as unknown as TabInfo
    expect(pageTabMarks(tab({}))).toEqual([])
    expect(pageTabMarks(tab({ dirty: true }))).toEqual(['unsaved changes'])
    expect(pageTabMarks(tab({ dirty: true, unseen: true }))).toEqual(['unsaved changes', 'not seen yet'])
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

  it('a resync that comes while the port is held for the load is kept, and the frame takes a new port at its load', () => {
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
    // Main paused it (a slow link, the page still loading) and says resync once: nobody listens yet.
    relay.resync(key, 1)
    expect(delivers).toHaveLength(1)
    // The load: the held port is handed, then let go at once for a new one (the kept resync).
    loads.loaded(target.gen)
    expect(sent).toEqual([{ t: 'port.close', key, nonce: 1 }])
    expect(delivers).toHaveLength(2)
    relay.open(key, 2)
    delivers[1]!(page!)
    expect(target.posts).toEqual([TAB_MESSAGE, PORT_MESSAGE, TAB_MESSAGE, PORT_MESSAGE])
    expect(target.loads).toEqual([])
    expect(target.remounts).toEqual([])
    // The new port has no resync left over.
    expect(delivers).toHaveLength(2)
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
    t.setBuffered(RELAY_PAGE_TAB_HIGH_WATER + 1)
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

  it("a whole file's answer in one burst goes out past the panels' high water: no pause, so no resync asking for it again", async () => {
    const t = relay()
    const key = pageTabPortKey(TAB_A)
    const ch = channel(1)
    t.r.take(PANEL_PORT_CHANNEL, { panelKey: key, nonce: 1 }, ch.renderer)
    // The socket fills with each part sent (a slow link flushes nothing meanwhile): 24 parts of
    // 768 KiB, an 18 MiB answer, more than twice the panels' high water.
    const PART = 768 * 1024
    let buffered = 0
    const parts = 24
    for (let i = 0; i < parts; i++) {
      t.setBuffered(buffered)
      ch.host.postMessage(JSON.stringify({ t: 'file', part: i, parts }))
      await settle()
      buffered += PART
    }
    expect(buffered).toBeGreaterThan(2 * RELAY_HIGH_WATER)
    expect(t.r.paused(key)).toBe(false)
    expect(t.sent.filter((f) => f.t === 'port.msg')).toHaveLength(parts)
    expect(t.sent.some((f) => f.t === 'port.resync')).toBe(false)
    // A panel port is still closed at its own high water.
    const panel = channel(2)
    t.r.take(PANEL_PORT_CHANNEL, { panelKey: 'example.plugin/main', nonce: 2 }, panel.renderer)
    t.setBuffered(RELAY_HIGH_WATER + 1)
    panel.host.postMessage('"x"')
    await settle()
    expect(panel.host.closed).toBe(true)
  })

  it('a message the socket cannot carry is dropped alone and logged once; the port is not paused and later messages flow', async () => {
    let ok = true
    const sent: Array<Record<string, unknown>> = []
    const logs: string[] = []
    const r = new MainPortRelay({
      send: (f) => {
        if (ok || f.t !== 'port.msg') sent.push(f)
        return ok || f.t !== 'port.msg'
      },
      buffered: () => 0,
      log: (m) => logs.push(m),
      setTimeout: () => {
        throw new Error('no drain check: nothing is paused')
      },
      clearTimeout: () => {}
    })
    const key = pageTabPortKey(TAB_A)
    const ch = channel(1)
    r.take(PANEL_PORT_CHANNEL, { panelKey: key, nonce: 1 }, ch.renderer)
    ok = false
    ch.host.postMessage('"big"')
    ch.host.postMessage('"big again"')
    await settle()
    expect(r.paused(key)).toBe(false)
    expect(ch.host.closed).toBe(false)
    expect(logs.filter((m) => m.includes('did not go out'))).toHaveLength(1)
    ok = true
    ch.host.postMessage('"small"')
    await settle()
    expect(sent).toEqual([
      { t: 'port.open', key, nonce: 1 },
      { t: 'port.msg', key, nonce: 1, m: '"small"' }
    ])
  })

  it('closeAll stops the drain check of a paused port', async () => {
    const timers: Array<() => void> = []
    const r = new MainPortRelay({
      send: () => true,
      buffered: () => RELAY_PAGE_TAB_HIGH_WATER + 1,
      log: () => {},
      setTimeout: (fn) => (timers.push(fn), 1),
      clearTimeout: () => void timers.splice(0)
    })
    const key = pageTabPortKey(TAB_A)
    const ch = channel(1)
    r.take(PANEL_PORT_CHANNEL, { panelKey: key, nonce: 1 }, ch.renderer)
    ch.host.postMessage('"one"')
    await settle()
    expect(r.paused(key)).toBe(true)
    expect(timers).toHaveLength(1)
    r.closeAll()
    expect(timers).toHaveLength(0)
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
    expect(c.api.tab?.type).toBe('file')
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
