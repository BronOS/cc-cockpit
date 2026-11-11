// Panel ports of a remote view (plan Task 22, design-web.md §5.3, §5.5): main keeps the page end of
// each channel PanelPortHub makes for a browser view and relays it as `port.*` frames
// (main/web/port-relay.ts); the browser shell pipes them into a MessageChannel whose other end the
// frame gets (renderer/web/port-relay.ts PortRelay), and only frame loads the shell started get a
// port (FrameLoads). The round trip runs main's real connection, router, registry and hub against
// the real bridge and panel port bus, socket to socket; ports are main's FakePort on the host side
// and Node's MessageChannel (the browser's API) on the page side.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IpcRouter, registerPanelHandlers } from '../../src/main/ipc/router'
import { PanelPortHub } from '../../src/main/plugins/panel-ports'
import { ViewRegistry } from '../../src/main/views/view-registry'
import { WebConnections, type WsLike } from '../../src/main/web/connection'
import type { WebDevice } from '../../src/main/web/devices'
import { decodeJson, encodeFrame, parseClientFrame } from '../../src/main/web/protocol'
import { PortRelay as MainPortRelay, RELAY_HIGH_WATER } from '../../src/main/web/port-relay'
import { MAX_PANEL_MESSAGE_LENGTH as HOST_MAX } from '../../src/host/ctx/ui'
import { MAX_PANEL_MESSAGE_LENGTH as SDK_MAX } from '../../src/sdk/panel-core'
import { PANEL_PORT_CHANNEL, type LayoutView } from '../../src/shared/ipc'
import {
  CLOSE,
  MAX_FRAME_BYTES,
  MAX_PORT_MESSAGE_LENGTH,
  MAX_VIEWS_PER_DEVICE_WINDOW,
  PROTOCOL_VERSION,
  type ServerFrame
} from '../../src/shared/web-protocol'
import { createWebBridge, type BridgeStatus, type SocketLike, type WebBridge } from '../../src/renderer/web/bridge'
import {
  BLANK_URL,
  FRAME_RESET_WINDOW_MS,
  FrameLoads,
  MAX_FRAME_RESETS,
  PANEL_RECONNECT_MS,
  PortRelay as BrowserPortRelay,
  relayHandleOf,
  type FrameTarget
} from '../../src/renderer/web/port-relay'
import { deliverPanelPort, requestPanelPort, requestSlotPort } from '../../src/renderer/plugins/panel-port-bus'
import { channel, FakePort } from '../fakes/fake-main-port'
// The shell's `window.cockpit` (panel-port-bus.ts reads it): the renderer's own declaration.
import type {} from '../../src/renderer/env'

const DEVICE: WebDevice = { id: 'dev1', name: 'phone', createdAt: 0, lastSeenAt: 0, mode: 'link' }
const LAYOUT = { zones: {} } as unknown as LayoutView

/** Lets queued microtasks and Node port messages (macrotasks) run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** Main's end of a socket: frames go to the linked browser socket on a microtask. */
class LinkedWs implements WsLike {
  readyState = 1
  bufferedAmount = 0
  readonly sent: Array<Record<string, unknown>> = []
  closedWith: { code: number; reason: string } | undefined
  peer: LinkedSocket | undefined
  private onMessage: ((data: unknown, isBinary: boolean) => void) | undefined
  private onClose: (() => void) | undefined

  send(data: string): void {
    this.sent.push(decodeJson(data) as Record<string, unknown>)
    const peer = this.peer
    queueMicrotask(() => peer?.onmessage?.({ data }))
  }
  close(code = 1000, reason = ''): void {
    if (this.readyState !== 1) return
    this.readyState = 3
    this.closedWith = { code, reason }
    this.onClose?.()
    const peer = this.peer
    if (peer) {
      peer.readyState = 3
      queueMicrotask(() => peer.onclose?.({ code, reason }))
    }
  }
  on(event: 'message' | 'close', listener: (...args: never[]) => void): unknown {
    if (event === 'message') this.onMessage = listener as (data: unknown, isBinary: boolean) => void
    else this.onClose = listener as () => void
    return this
  }
  feed(frame: unknown): void {
    this.onMessage?.(Buffer.from(typeof frame === 'string' ? frame : JSON.stringify(frame)), false)
  }
  /** The peer hung up. */
  drop(): void {
    this.readyState = 3
    this.onClose?.()
  }
  frames(t: string): Array<Record<string, unknown>> {
    return this.sent.filter((f) => f.t === t)
  }
}

/** The browser's end: what it sends reaches main's connection on a microtask. */
class LinkedSocket implements SocketLike {
  readyState = 0
  readonly sent: string[] = []
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  constructor(readonly ws: LinkedWs) {
    ws.peer = this
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.({})
    })
  }
  send(data: string): void {
    if (this.readyState !== 1) throw new Error('not open')
    this.sent.push(data)
    queueMicrotask(() => this.ws.feed(data))
  }
  close(): void {
    this.readyState = 3
    this.ws.drop()
  }
  frames(t: string): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter((f) => f.t === t)
  }
}

/** No timers fire: the bridge's ready timeout and retries are not what these tests are about. */
const stillTimers = { now: () => 0, setTimeout: () => 0, clearTimeout: () => undefined }

/**
 * Main with project p1 in window 1 running a.one (panels board, side) and the slot frame `f1` of
 * b.two, its connections accepting LinkedWs sockets, and a browser bridge per connect.
 */
function setup() {
  const windows = new Map<string, number>([['p1', 1]])
  const logs: string[] = []
  const router = new IpcRouter(
    { handle: () => undefined },
    () => undefined,
    () => false,
    (m) => logs.push(m),
    (windowId, projectId) => windows.get(projectId) === windowId
  )
  const views = new ViewRegistry<FakePort>({ windowIdOf: (projectId) => windows.get(projectId) })
  views.addDesktop(1, { send: () => undefined, isClosed: () => false })
  const hostPorts: Array<{ key: string; port: FakePort; view?: string }> = []
  let made = 0
  const running: Record<string, readonly string[]> = { 'a.one': ['board', 'side'] }
  const hub = new PanelPortHub<FakePort>({
    createChannel: () => channel(++made),
    runningPanels: (projectId, pluginId) => (projectId === 'p1' ? running[pluginId] : undefined),
    toHost: (_projectId, pluginId, panelId, port, view) => {
      hostPorts.push({ key: `${pluginId}/${panelId}`, port, ...(view !== undefined ? { view } : {}) })
      return true
    },
    toRenderer: (viewId, payload, port) => views.postPort(viewId, PANEL_PORT_CHANNEL, payload, port),
    reload: () => undefined,
    close: (port) => port.close(),
    slotFrame: (projectId, frameId) =>
      projectId === 'p1' && frameId === 's1'
        ? ({ info: { id: 's1', pluginId: 'b.two', type: 'strip' }, host: { kind: 'panel' } } as never)
        : undefined,
    slotToHost: (_projectId, open, port) => {
      hostPorts.push({ key: `@slot/${open.id}`, port, ...(open.view !== undefined ? { view: open.view } : {}) })
      return true
    },
    log: (m) => logs.push(m)
  })
  registerPanelHandlers(router, {
    connect: (projectId, viewId, panelKey, nonce) => hub.connect(projectId, viewId, panelKey, nonce),
    restartHost: async () => undefined,
    panelAction: () => false
  })
  router.handleProject('slots.connect', (ctx, payload, view) => {
    const p = payload as { frameId: string; nonce: number }
    return hub.connectSlot(ctx.projectId, view.viewId, p.frameId, p.nonce)
  })
  const gone: string[] = []
  const conns = new WebConnections({
    dispatch: (caller, ch, payload) => router.dispatch(caller, ch, payload),
    addView: (windowId, viewId, sink) => views.addRemote(windowId, viewId, sink),
    windowIdOf: (projectId) => windows.get(projectId),
    snapshot: () => ({ tabs: [], layout: LAYOUT, overlays: [], closeAsks: [], linkAsks: [] }),
    mirror: { join: () => undefined },
    hasTab: () => false,
    viewGone: (viewId) => {
      gone.push(viewId)
      hub.viewGone(viewId)
    },
    log: (m) => logs.push(m),
    helloTimeoutMs: 5000
  })
  const bridges: WebBridge[] = []

  /** A browser view of p1 on `device`: main's socket, the bridge, ready once `settle`d. */
  const browser = (device: WebDevice = DEVICE) => {
    const ws = new LinkedWs()
    conns.accept(ws, device)
    let socket: LinkedSocket | undefined
    const bridge = createWebBridge({
      url: 'ws://127.0.0.1/ws',
      project: 'p1',
      createSocket: () => (socket = new LinkedSocket(ws)),
      timers: stillTimers,
      onPort: deliverPanelPort
    })
    bridges.push(bridge)
    return { ws, bridge, socket: () => socket! }
  }
  return { hub, views, conns, hostPorts, logs, gone, browser, bridges }
}

let current: ReturnType<typeof setup> | undefined

/** The page side: the panel port bus reads `window.cockpit` (the bridge) as in the shell. */
function useWindow(bridge: WebBridge): void {
  vi.stubGlobal('window', { cockpit: bridge.api, addEventListener: () => undefined })
}

afterEach(() => {
  for (const b of current?.bridges ?? []) b.close()
  current = undefined
  vi.unstubAllGlobals()
})

/** Ask for `key`'s port the shell's way; resolves with port1 once main's `port.open` came. */
async function askPort(key: string): Promise<MessagePort | undefined> {
  let got: MessagePort | undefined
  requestPanelPort(key, (port) => {
    got = port
  })
  await settle()
  return got
}

/** The next message on a browser MessagePort. */
function nextMessage(port: MessagePort): Promise<unknown> {
  return new Promise((resolve) => {
    port.onmessage = (e: MessageEvent) => resolve(e.data)
  })
}

/** The next message on a host FakePort. */
function nextHostMessage(port: FakePort): Promise<unknown> {
  return new Promise((resolve) => {
    port.on('message', (e) => resolve(e.data))
    port.start()
  })
}

describe('relay round trip', () => {
  it('a panel of a browser view talks to its host both ways through main', async () => {
    const t = (current = setup())
    const { bridge, ws } = t.browser()
    await settle()
    expect(bridge.status()).toMatchObject({ state: 'ready', view: 'web:1' })
    useWindow(bridge)
    const page = await askPort('a.one/board')
    expect(page).toBeDefined()
    // The host's end is tagged with the view, and main told the browser `port.open` with the nonce asked.
    expect(t.hostPorts).toEqual([{ key: 'a.one/board', port: expect.any(FakePort), view: 'web:1' }])
    const open = ws.frames('port.open')
    expect(open).toEqual([{ t: 'port.open', key: 'a.one/board', nonce: expect.any(Number) }])
    const host = t.hostPorts[0]!.port

    // Page -> host.
    const atHost = nextHostMessage(host)
    page!.postMessage('{"q":1}')
    expect(await atHost).toBe('{"q":1}')
    // Host -> page.
    const atPage = nextMessage(page!)
    host.postMessage('{"a":2}')
    expect(await atPage).toBe('{"a":2}')
    page!.close()
  })

  it('a slot frame of a browser view gets its port the same way, under its @slot key', async () => {
    const t = (current = setup())
    const { bridge, ws } = t.browser()
    await settle()
    vi.stubGlobal('window', { cockpit: bridge.api, addEventListener: () => undefined })
    let page: MessagePort | undefined
    requestSlotPort('s1', (port) => {
      page = port
    })
    await settle()
    expect(page).toBeDefined()
    expect(ws.frames('port.open')).toEqual([{ t: 'port.open', key: '@slot/s1', nonce: expect.any(Number) }])
    expect(t.hostPorts).toEqual([{ key: '@slot/s1', port: expect.any(FakePort), view: 'web:1' }])
    page!.close()
  })

  it('a refused connect sends no port: the invoke answers false, as on the desktop', async () => {
    const t = (current = setup())
    const { bridge, ws } = t.browser()
    await settle()
    useWindow(bridge)
    const page = await askPort('a.two/inbox')
    expect(page).toBeUndefined()
    expect(ws.frames('port.open')).toEqual([])
    expect(ws.frames('result').at(-1)).toMatchObject({ ok: true, v: false })
    expect(t.hostPorts).toEqual([])
  })

  it('a port.open nobody waits for (the frame loaded again) is answered with port.close; main closes its end', async () => {
    const t = (current = setup())
    const { bridge, socket } = t.browser()
    await settle()
    useWindow(bridge)
    // Main connects with a nonce no request of this page holds.
    expect(t.hub.connect('p1', 'web:1', 'a.one/side', 999)).toBe(true)
    await settle()
    expect(socket().frames('port.close')).toEqual([{ t: 'port.close', key: 'a.one/side', nonce: 999 }])
    expect(t.hostPorts[0]!.port.closed).toBe(true)
  })

  it('releasing the page port (its frame unloaded) closes the host end; a late message of that load goes nowhere', async () => {
    const t = (current = setup())
    const { bridge, ws, socket } = t.browser()
    await settle()
    useWindow(bridge)
    const page = await askPort('a.one/board')
    const handle = relayHandleOf(page!)
    expect(handle?.key).toBe('a.one/board')
    const nonce = (ws.frames('port.open')[0] as { nonce: number }).nonce
    handle!.release()
    await settle()
    expect(socket().frames('port.close')).toEqual([{ t: 'port.close', key: 'a.one/board', nonce }])
    expect(t.hostPorts[0]!.port.closed).toBe(true)
    // Releasing again sends nothing more.
    handle!.release()
    await settle()
    expect(socket().frames('port.close')).toHaveLength(1)
    page!.close()
  })

  it('a reload replaces the port: the old one closes on both sides, the new one carries on', async () => {
    const t = (current = setup())
    const { bridge, ws } = t.browser()
    await settle()
    useWindow(bridge)
    const first = await askPort('a.one/board')
    const second = await askPort('a.one/board')
    expect(second).toBeDefined()
    const [n1, n2] = ws.frames('port.open').map((f) => f.nonce)
    expect(n1).not.toBe(n2)
    // Main told the browser the old one ended, and closed its old end (the host hears it).
    expect(ws.frames('port.close')).toEqual([{ t: 'port.close', key: 'a.one/board', nonce: n1 }])
    expect(t.hostPorts[0]!.port.closed).toBe(true)
    expect(t.hostPorts[1]!.port.closed).toBe(false)
    first!.close()
    second!.close()
  })

  it('the host ending its port tells the browser, and the handle hears it', async () => {
    const t = (current = setup())
    const { bridge, ws } = t.browser()
    await settle()
    useWindow(bridge)
    const page = await askPort('a.one/board')
    const closed = vi.fn()
    relayHandleOf(page!)!.onClosed(closed)
    t.hostPorts[0]!.port.close()
    await settle()
    expect(ws.frames('port.close')).toHaveLength(1)
    expect(closed).toHaveBeenCalledOnce()
    page!.close()
  })

  it('a view leaving closes every page end it held, so the host detaches it; nothing more is taken', async () => {
    const t = (current = setup())
    const { bridge, ws } = t.browser()
    await settle()
    useWindow(bridge)
    const a = await askPort('a.one/board')
    const b = await askPort('a.one/side')
    expect(t.hostPorts.map((h) => h.port.closed)).toEqual([false, false])
    ws.drop()
    expect(t.gone).toEqual(['web:1'])
    expect(t.hostPorts.map((h) => h.port.closed)).toEqual([true, true])
    // The view is gone: a connect for it is refused and both ends of the new channel close.
    expect(t.hub.connect('p1', 'web:1', 'a.one/board', 5)).toBe(false)
    expect(t.hostPorts[2]?.port.closed).toBe(true)
    a!.close()
    b!.close()
  })
})

describe('main relay bounds', () => {
  function relay(buffered = 0) {
    const sent: Array<Record<string, unknown>> = []
    const logs: string[] = []
    let ok = true
    const r = new MainPortRelay({
      send: (frame) => {
        if (ok) sent.push(frame)
        return ok
      },
      buffered: () => buffered,
      log: (m) => logs.push(m)
    })
    return { r, sent, logs, fail: () => (ok = false) }
  }

  it('the three limits agree: the SDK, the host and the wire', () => {
    expect(MAX_PORT_MESSAGE_LENGTH).toBe(SDK_MAX)
    expect(MAX_PORT_MESSAGE_LENGTH).toBe(HOST_MAX)
  })

  it('a view behind by more than the high water loses that panel port (both sides), not the queue', async () => {
    const { r, sent, logs } = relay(RELAY_HIGH_WATER + 1)
    const ch = channel(1)
    r.take(PANEL_PORT_CHANNEL, { panelKey: 'a.one/board', nonce: 1 }, ch.renderer)
    ch.host.postMessage('{"x":1}')
    await settle()
    expect(sent).toEqual([
      { t: 'port.open', key: 'a.one/board', nonce: 1 },
      { t: 'port.close', key: 'a.one/board', nonce: 1 }
    ])
    expect(ch.host.closed).toBe(true)
    expect(r.size()).toBe(0)
    expect(logs.some((m) => m.includes('behind'))).toBe(true)
  })

  it('a message the socket cannot carry closes its port', async () => {
    const { r, sent, fail } = relay()
    const ch = channel(1)
    r.take(PANEL_PORT_CHANNEL, { panelKey: 'a.one/board', nonce: 1 }, ch.renderer)
    fail()
    ch.host.postMessage('{"x":1}')
    await settle()
    expect(sent).toEqual([{ t: 'port.open', key: 'a.one/board', nonce: 1 }])
    expect(ch.host.closed).toBe(true)
  })

  it('only JSON text within the cap passes either way, and only for the nonce of the held port', async () => {
    const { r, sent } = relay()
    const ch = channel(1)
    r.take(PANEL_PORT_CHANNEL, { panelKey: 'a.one/board', nonce: 1 }, ch.renderer)
    ch.host.postMessage({ not: 'text' })
    ch.host.postMessage('x'.repeat(MAX_PORT_MESSAGE_LENGTH + 1))
    await settle()
    expect(sent).toHaveLength(1)
    const got: unknown[] = []
    ch.host.on('message', (e) => got.push(e.data))
    ch.host.start()
    r.fromPage('a.one/board', 2, '"stale nonce"')
    r.fromPage('a.one/side', 1, '"other key"')
    r.fromPage('a.one/board', 1, 'y'.repeat(MAX_PORT_MESSAGE_LENGTH + 1))
    r.fromPage('a.one/board', 1, '"ok"')
    await settle()
    expect(got).toEqual(['"ok"'])
    // A close for another nonce leaves the port alone.
    r.closeFromPage('a.one/board', 2)
    expect(ch.host.closed).toBe(false)
    r.closeFromPage('a.one/board', 1)
    expect(ch.host.closed).toBe(true)
  })

  it('refuses what is not a panel port: the hub then closes both ends', () => {
    const { r } = relay()
    const ch = channel(1)
    expect(() => r.take('other.channel', { panelKey: 'a.one/board', nonce: 1 }, ch.renderer)).toThrow()
    expect(() => r.take(PANEL_PORT_CHANNEL, { panelKey: '', nonce: 1 }, ch.renderer)).toThrow()
    expect(() => r.take(PANEL_PORT_CHANNEL, { panelKey: 'a.one/board', nonce: 1.5 }, ch.renderer)).toThrow()
    expect(() => r.take(PANEL_PORT_CHANNEL, { panelKey: 'a.one/board', nonce: 1 }, {})).toThrow()
    r.closeAll()
    expect(() => r.take(PANEL_PORT_CHANNEL, { panelKey: 'a.one/board', nonce: 1 }, ch.renderer)).toThrow(/gone/)
    expect(r.size()).toBe(0)
  })

  it('a socket that cannot say port.open gets no port', () => {
    const { r, fail } = relay()
    fail()
    const ch = channel(1)
    expect(() => r.take(PANEL_PORT_CHANNEL, { panelKey: 'a.one/board', nonce: 1 }, ch.renderer)).toThrow()
    expect(r.size()).toBe(0)
  })

  it('an oversize port.msg frame costs only its port, never the view', async () => {
    const t = (current = setup())
    const { bridge, ws } = t.browser()
    await settle()
    useWindow(bridge)
    const page = await askPort('a.one/board')
    // Within the message cap in units, over the frame cap once JSON escapes every control character.
    t.hostPorts[0]!.port.postMessage('\u0001'.repeat(MAX_FRAME_BYTES / 6 + 10))
    await settle()
    expect(ws.closedWith).toBeUndefined()
    expect(ws.frames('port.close')).toHaveLength(1)
    expect(t.hostPorts[0]!.port.closed).toBe(true)
    expect(t.logs.some((m) => m.includes('message over'))).toBe(true)
    page!.close()
  })
})

describe('port frames on the wire', () => {
  it('parses port.msg and port.close from a page and refuses bad shapes', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'port.msg', key: 'a/b', nonce: 3, m: '{}' }))).toEqual({ t: 'port.msg', key: 'a/b', nonce: 3, m: '{}' })
    expect(parseClientFrame(JSON.stringify({ t: 'port.close', key: 'a/b', nonce: 3, extra: 1 }))).toEqual({ t: 'port.close', key: 'a/b', nonce: 3 })
    expect(parseClientFrame(JSON.stringify({ t: 'port.msg', key: 'a/b', nonce: 3, m: { x: 1 } }))).toEqual({ error: 'bad port message' })
    expect(parseClientFrame(JSON.stringify({ t: 'port.msg', key: '', nonce: 3, m: '' }))).toEqual({ error: 'bad port key' })
    expect(parseClientFrame(JSON.stringify({ t: 'port.close', key: 'k'.repeat(201), nonce: 3 }))).toEqual({ error: 'bad port key' })
    expect(parseClientFrame(JSON.stringify({ t: 'port.close', key: 'a/b', nonce: '3' }))).toEqual({ error: 'bad port nonce' })
    // A page cannot open a port itself: main opens them, for a connect it accepted.
    expect(parseClientFrame(JSON.stringify({ t: 'port.open', key: 'a/b', nonce: 3 }))).toEqual({ error: 'unknown frame' })
  })

  it('a port frame before hello closes the socket', () => {
    const t = (current = setup())
    const ws = new LinkedWs()
    t.conns.accept(ws, DEVICE)
    ws.feed({ t: 'port.close', key: 'a.one/board', nonce: 1 })
    expect(ws.closedWith?.code).toBe(CLOSE.badFrame)
  })
})

describe('live views per window and device', () => {
  it(`a device gets at most ${MAX_VIEWS_PER_DEVICE_WINDOW} views of one window; another device, or one leaving, makes room`, () => {
    const t = (current = setup())
    const hello = (device: WebDevice = DEVICE): LinkedWs => {
      const ws = new LinkedWs()
      t.conns.accept(ws, device)
      ws.feed({ t: 'hello', v: PROTOCOL_VERSION, project: 'p1' })
      return ws
    }
    const open = Array.from({ length: MAX_VIEWS_PER_DEVICE_WINDOW }, () => hello())
    expect(open.every((ws) => ws.closedWith === undefined)).toBe(true)
    const extra = hello()
    expect(extra.closedWith?.code).toBe(CLOSE.tooManyViews)
    expect(t.views.viewsOf(1)).toHaveLength(1 + MAX_VIEWS_PER_DEVICE_WINDOW)
    // Another device has its own budget.
    expect(hello({ ...DEVICE, id: 'dev2' }).closedWith).toBeUndefined()
    // One leaves: room for one more.
    open[0]!.drop()
    expect(hello().closedWith).toBeUndefined()
    expect(hello().closedWith?.code).toBe(CLOSE.tooManyViews)
  })

  it("None's anonymous caller is every browser at once: its views are not capped per device", () => {
    const t = (current = setup())
    const none: WebDevice = { id: 'none', name: 'No sign-in', createdAt: 0, lastSeenAt: 0, mode: 'none' }
    const views = Array.from({ length: MAX_VIEWS_PER_DEVICE_WINDOW + 2 }, () => {
      const ws = new LinkedWs()
      t.conns.accept(ws, none)
      ws.feed({ t: 'hello', v: PROTOCOL_VERSION, project: 'p1' })
      return ws
    })
    expect(views.every((ws) => ws.closedWith === undefined)).toBe(true)
    expect(t.views.viewsOf(1)).toHaveLength(1 + MAX_VIEWS_PER_DEVICE_WINDOW + 2)
  })

  it('the browser stops on tooManyViews instead of retrying', async () => {
    const statuses: BridgeStatus[] = []
    let socket: { onclose: SocketLike['onclose']; onopen: SocketLike['onopen'] } | undefined
    const bridge = createWebBridge({
      url: 'ws://x/ws',
      project: 'p1',
      createSocket: () =>
        (socket = {
          readyState: 1,
          send: () => undefined,
          close: () => undefined,
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null
        } as SocketLike),
      timers: stillTimers
    })
    bridge.onStatus((s) => statuses.push(s))
    socket!.onclose?.({ code: CLOSE.tooManyViews, reason: '' })
    expect(statuses.at(-1)).toMatchObject({ state: 'gone' })
    bridge.close()
  })
})

describe('browser relay', () => {
  function browserRelay(deliver: (key: string, nonce: number, port: MessagePort) => boolean = () => true) {
    const sent: Array<Record<string, unknown>> = []
    const r = new BrowserPortRelay({
      send: (frame) => {
        sent.push(frame)
        return true
      },
      deliver
    })
    return { r, sent }
  }

  it('ignores malformed port.open frames and messages for another nonce', async () => {
    const ports: MessagePort[] = []
    const { r, sent } = browserRelay((_k, _n, port) => {
      ports.push(port)
      return true
    })
    r.open('', 1)
    r.open('a/b', 'x')
    r.open('a/b', 1.5)
    expect(ports).toHaveLength(0)
    r.open('a/b', 1)
    expect(ports).toHaveLength(1)
    const got: unknown[] = []
    ports[0]!.onmessage = (e: MessageEvent) => got.push(e.data)
    r.message('a/b', 2, '"stale"')
    r.message('a/b', 1, { not: 'text' })
    r.message('a/b', 1, '"ok"')
    await settle()
    expect(got).toEqual(['"ok"'])
    // The page's messages go out as port.msg with its key and nonce; non-text is dropped.
    ports[0]!.postMessage({ not: 'text' })
    ports[0]!.postMessage('"up"')
    await settle()
    expect(sent).toEqual([{ t: 'port.msg', key: 'a/b', nonce: 1, m: '"up"' }])
    // A socket drop closes every port, says nothing, and the relay takes nothing more.
    r.closeAll()
    expect(r.size()).toBe(0)
    r.open('a/b', 3)
    expect(ports).toHaveLength(1)
    expect(sent).toHaveLength(1)
    ports[0]!.close()
  })

  it('port.close from main ends the port and notifies once; a stale close does nothing', () => {
    const ports: MessagePort[] = []
    const { r, sent } = browserRelay((_k, _n, port) => {
      ports.push(port)
      return true
    })
    r.open('a/b', 1)
    const closed = vi.fn()
    relayHandleOf(ports[0]!)!.onClosed(closed)
    r.remoteClosed('a/b', 2)
    expect(r.size()).toBe(1)
    r.remoteClosed('a/b', 1)
    r.remoteClosed('a/b', 1)
    expect(closed).toHaveBeenCalledOnce()
    expect(r.size()).toBe(0)
    // Main ended it: nothing is sent back.
    expect(sent).toEqual([])
    ports[0]!.close()
  })
})

/**
 * A frame as FrameLoads sees it: what was loaded (src on the element), remounted (a new element) and
 * posted. `gen` is the generation of the element in the document now.
 */
class FakeFrame implements FrameTarget {
  readonly loads: string[] = []
  readonly remounts: number[] = []
  readonly posts: Array<{ message: unknown; ports: number }> = []
  hasWindow = true
  gen = 0
  load(url: string): void {
    this.loads.push(url)
  }
  remount(frame: number): void {
    this.gen = frame
    this.remounts.push(frame)
  }
  post(message: unknown, transfer?: MessagePort[]): boolean {
    if (!this.hasWindow) return false
    this.posts.push({ message, ports: transfer?.length ?? 0 })
    return true
  }
  types(): unknown[] {
    return this.posts.map((p) => (p.message as { type?: unknown }).type)
  }
}

const PORT_MESSAGE = { type: 'cc-plugin.port' }
const THEME = { type: 'cc-plugin.theme' }
const PAGE = '/p/t/a.one/panel.html'

describe('FrameLoads (navigation guard)', () => {
  function loads(guard: boolean, over: { early?: boolean; connect?: (deliver: (port: MessagePort) => void) => () => void } = {}) {
    const frame = new FakeFrame()
    let now = 100_000
    const timers: Array<{ fn: () => void; at: number }> = []
    const connects: Array<(port: MessagePort) => void> = []
    const cleanups = vi.fn()
    const l = new FrameLoads({
      guard,
      early: over.early ?? guard,
      portMessage: PORT_MESSAGE,
      target: frame,
      theme: () => THEME,
      intro: () => ({ type: 'cc-plugin.slot' }),
      connect:
        over.connect ??
        ((deliver) => {
          connects.push(deliver)
          return cleanups
        }),
      now: () => now,
      setTimeout: (fn, ms) => timers.push({ fn, at: now + ms }),
      clearTimeout: (h) => {
        const i = timers.findIndex((x) => x === h)
        if (i >= 0) timers.splice(i, 1)
      },
      log: () => undefined
    })
    const advance = (ms: number): void => {
      now += ms
      for (const t of timers.filter((x) => x.at <= now)) {
        timers.splice(timers.indexOf(t), 1)
        t.fn()
      }
    }
    /** The element in the document now fires `load`. */
    const load = (): void => l.loaded(frame.gen)
    return { l, frame, connects, cleanups, advance, load }
  }

  /** A relay whose port.open hands port1 to `page()`; `sent` holds the frames to main. */
  function relay() {
    const sent: Array<Record<string, unknown>> = []
    let page: MessagePort | undefined
    const r = new BrowserPortRelay({ send: (f) => (sent.push(f), true), deliver: (_k, _n, port) => ((page = port), true) })
    return { r, sent, page: () => page! }
  }

  it('desktop: every load gets the theme and a port, asked for at the load, as before', () => {
    const { l, frame, connects } = loads(false)
    l.loaded(0)
    l.loaded(0)
    expect(connects).toHaveLength(2)
    expect(frame.types()).toEqual(['cc-plugin.theme', 'cc-plugin.theme'])
    expect(frame.loads).toEqual([])
    expect(frame.remounts).toEqual([])
  })

  it('web: the port is asked for when the shell sets src, held, and posted inside the load it expected', () => {
    const { l, frame, connects, load } = loads(true)
    l.started(PAGE)
    expect(connects).toHaveLength(1)
    // It arrives before the page has loaded: nothing goes into the frame yet.
    const ch = new MessageChannel()
    connects[0]!(ch.port1)
    expect(frame.posts).toEqual([])
    load()
    expect(connects).toHaveLength(1)
    expect(frame.types()).toEqual(['cc-plugin.theme', 'cc-plugin.slot', 'cc-plugin.port'])
    expect(frame.posts.at(-1)?.ports).toBe(1)
    // Theme changes reach the served page.
    l.themeChanged({ type: 'cc-plugin.theme', n: 2 })
    expect(frame.posts).toHaveLength(4)
    ch.port2.close()
  })

  it('web: a port slower than the page is posted when it arrives', () => {
    const { l, frame, connects, load } = loads(true)
    l.started(PAGE)
    load()
    expect(frame.types()).toEqual(['cc-plugin.theme'])
    const ch = new MessageChannel()
    connects[0]!(ch.port1)
    expect(frame.types()).toEqual(['cc-plugin.theme', 'cc-plugin.slot', 'cc-plugin.port'])
    ch.port2.close()
  })

  it('web: a navigated frame gets no theme and no port; a new frame element is mounted, not src on the old one', () => {
    const { l, frame, connects, cleanups, load } = loads(true)
    const { r, sent, page } = relay()
    l.started(PAGE)
    // The port arrives and is held; the page navigates before its own load: it is never posted.
    r.open('a.one/board', 1)
    connects[0]!(page())
    load()
    expect(frame.types().at(-1)).toBe('cc-plugin.port')
    const before = frame.posts.length
    // The page navigated itself: its port ends (main hears it), the element is replaced.
    load()
    expect(cleanups).toHaveBeenCalledOnce()
    expect(sent).toEqual([{ t: 'port.close', key: 'a.one/board', nonce: 1 }])
    expect(frame.loads).toEqual([])
    expect(frame.remounts).toEqual([1])
    expect(frame.posts).toHaveLength(before)
    l.themeChanged(THEME)
    expect(frame.posts).toHaveLength(before)
    // The new element's port is asked for at once; a late port of the old request is closed.
    expect(connects).toHaveLength(2)
    const late = new MessageChannel()
    connects[0]!(late.port1)
    expect(frame.posts).toHaveLength(before)
    // The new element's first load is the shell's own: served.
    load()
    expect(frame.types().at(-1)).toBe('cc-plugin.theme')
    late.port2.close()
  })

  it('web: a load of the replaced element (its page cancelled our navigation with its own) is never served', () => {
    const { l, frame, connects, load } = loads(true)
    l.started(PAGE)
    load()
    // A link without a target: a foreign page loads in the frame; a new element is asked for.
    load()
    expect(frame.remounts).toEqual([1])
    const posts = frame.posts.length
    // The port for the new element arrives; then the old element fires a load (the foreign page's
    // own next destination), before React put the new element in.
    const ch = new MessageChannel()
    connects[1]!(ch.port1)
    l.loaded(0)
    expect(frame.posts).toHaveLength(posts)
    expect(frame.remounts).toEqual([1])
    // The new element's first load gets the theme and the held port.
    load()
    expect(frame.types().slice(posts)).toEqual(['cc-plugin.theme', 'cc-plugin.slot', 'cc-plugin.port'])
    ch.port2.close()
  })

  it('web: a new src is a new frame element too', () => {
    const { l, frame, connects, load } = loads(true)
    l.started(PAGE)
    load()
    l.started('/p/t/a.one/other.html')
    expect(frame.remounts).toEqual([1])
    expect(connects).toHaveLength(2)
    // A load the old element still fires is ignored; the new one's is served.
    l.loaded(0)
    expect(frame.types()).toEqual(['cc-plugin.theme'])
    load()
    expect(frame.types()).toEqual(['cc-plugin.theme', 'cc-plugin.theme'])
  })

  it(`web: after ${MAX_FRAME_RESETS} resets in ${FRAME_RESET_WINDOW_MS / 1000} s the frame is stopped (blank) until a new src`, () => {
    const { l, frame, connects, advance, load } = loads(true)
    l.started(PAGE)
    // A page that navigates again on every load: each unexpected load remounts, then is served once.
    for (let i = 0; i < MAX_FRAME_RESETS; i++) {
      load()
      load()
      advance(100)
    }
    expect(frame.remounts).toHaveLength(MAX_FRAME_RESETS)
    expect(frame.loads).toEqual([])
    // The last remount is served; the page navigates once more: stopped.
    load()
    load()
    expect(frame.loads).toEqual([BLANK_URL])
    expect(frame.remounts).toHaveLength(MAX_FRAME_RESETS)
    const asked = connects.length
    const posts = frame.posts.length
    // The blank load and anything after it are ignored.
    load()
    load()
    expect(connects).toHaveLength(asked)
    expect(frame.posts).toHaveLength(posts)
    // A new src starts over.
    l.started('/p/t/a.one/other.html')
    load()
    expect(connects).toHaveLength(asked + 1)
    expect(frame.posts).toHaveLength(posts + 1)
  })

  it('web: resets older than the window do not count', () => {
    const { l, frame, advance, load } = loads(true)
    l.started(PAGE)
    for (let i = 0; i < MAX_FRAME_RESETS * 2; i++) {
      load()
      load()
      advance(FRAME_RESET_WINDOW_MS / MAX_FRAME_RESETS + 1)
    }
    expect(frame.loads).not.toContain(BLANK_URL)
    expect(frame.remounts).toHaveLength(MAX_FRAME_RESETS * 2)
  })

  it('web: no path for the page (undefined src) serves nothing', () => {
    const { l, connects, frame, load } = loads(true)
    l.started(undefined)
    load()
    expect(connects).toHaveLength(0)
    expect(frame.posts).toHaveLength(0)
    expect(frame.loads).toHaveLength(0)
    expect(frame.remounts).toHaveLength(0)
  })

  it('web, a port made at the load (overlays): asked for at each served load, so a page put back gets a fresh one', () => {
    const { l, frame, connects, load } = loads(true, { early: false })
    l.started(PAGE)
    expect(connects).toHaveLength(0)
    load()
    expect(connects).toHaveLength(1)
    connects[0]!(new MessageChannel().port1)
    expect(frame.types()).toEqual(['cc-plugin.theme', 'cc-plugin.slot', 'cc-plugin.port'])
    // The page navigated itself: nothing for it; the new element's load gets a new port.
    load()
    expect(connects).toHaveLength(1)
    load()
    expect(connects).toHaveLength(2)
    connects[1]!(new MessageChannel().port1)
    expect(frame.types().filter((t) => t === 'cc-plugin.port')).toHaveLength(2)
  })

  it('a relayed port is released when its page goes (next load or unmount)', () => {
    const { l, connects, load } = loads(true)
    const { r, sent, page } = relay()
    l.started(PAGE)
    load()
    r.open('a.one/board', 4)
    connects[0]!(page())
    expect(r.size()).toBe(1)
    // The frame navigated: its page is gone, main hears port.close.
    load()
    expect(sent).toEqual([{ t: 'port.close', key: 'a.one/board', nonce: 4 }])
    expect(r.size()).toBe(0)
    // And on unmount.
    load()
    r.open('a.one/board', 5)
    connects[1]!(page())
    l.dispose()
    expect(sent.at(-1)).toEqual({ t: 'port.close', key: 'a.one/board', nonce: 5 })
  })

  it('a port held for a load that never came is released when the frame unmounts', () => {
    const { l, connects } = loads(true)
    const { r, sent, page } = relay()
    l.started(PAGE)
    r.open('a.one/board', 1)
    connects[0]!(page())
    l.dispose()
    expect(sent).toEqual([{ t: 'port.close', key: 'a.one/board', nonce: 1 }])
  })

  it("main ending a panel's port mounts its frame again later; a slot's does not", () => {
    for (const key of ['a.one/board', '@slot/s1']) {
      const { l, connects, frame, advance, load } = loads(true)
      const { r, page } = relay()
      l.started(PAGE)
      load()
      r.open(key, 1)
      connects[0]!(page())
      r.remoteClosed(key, 1)
      advance(PANEL_RECONNECT_MS)
      expect(frame.remounts).toEqual(key.startsWith('@') ? [] : [1])
      expect(frame.loads).toEqual([])
      // The new element's load is the shell's own: served, with a new port asked for at the remount.
      if (key.startsWith('@')) continue
      expect(connects).toHaveLength(2)
      load()
      expect(frame.types().at(-1)).toBe('cc-plugin.theme')
    }
  })

  it('a page that loads again before the reconnect is due cancels it', () => {
    const { l, connects, frame, advance, load } = loads(true)
    const { r, page } = relay()
    l.started(PAGE)
    load()
    r.open('a.one/board', 1)
    connects[0]!(page())
    r.remoteClosed('a.one/board', 1)
    // panels.reload loaded it again first.
    l.started(PAGE)
    load()
    advance(PANEL_RECONNECT_MS)
    expect(frame.remounts).toEqual([])
  })

  it('a frame with no window closes the port it cannot hand over and releases it', () => {
    const { l, frame, connects, load } = loads(true)
    const { r, sent, page } = relay()
    l.started(PAGE)
    load()
    frame.hasWindow = false
    r.open('a.one/board', 1)
    connects[0]!(page())
    expect(sent).toEqual([{ t: 'port.close', key: 'a.one/board', nonce: 1 }])
  })
})

// A ServerFrame of each new kind encodes as the bridge reads it (types only, kept in step).
describe('port frame types', () => {
  it('encode as plain JSON', () => {
    const frames: ServerFrame[] = [
      { t: 'port.open', key: 'k', nonce: 1 },
      { t: 'port.msg', key: 'k', nonce: 1, m: '{}' },
      { t: 'port.close', key: 'k', nonce: 1 }
    ]
    for (const f of frames) expect(JSON.parse(encodeFrame(f))).toEqual(f)
  })
})
