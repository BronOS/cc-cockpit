// The web access wire protocol and the WebCaller binding (main/web/protocol.ts, connection.ts;
// plan Task 6): frames and `$bytes`, the hello that binds a socket to one open project window, invokes
// through the router's own handlers, events only to views of their window, and the gateway handing
// sockets to the connection only with a device.
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as wsModule from 'ws'
import type { EventChannel, LayoutView } from '../../src/shared/ipc'
import { IpcRouter, type ProjectContext } from '../../src/main/ipc/router'
import { OverlayManager } from '../../src/main/overlays/overlay-manager'
import { fakeSecretStore } from '../../src/main/secrets/secret-store'
import { ViewRegistry } from '../../src/main/views/view-registry'
import { AccessLog } from '../../src/main/web/access-log'
import { WebAuth } from '../../src/main/web/auth'
import { MAX_PENDING_INVOKES, WebConnections, windowSnapshot, type WsLike } from '../../src/main/web/connection'
import { DeviceStore, type WebDevice } from '../../src/main/web/devices'
import type { TerminalSource } from '../../src/main/web/view-terminals'
import type { MirrorView } from '../../src/main/terminals/mirror'
import { MAX_REJOINS, VIEW_HIGH_WATER, VIEW_LOW_WATER } from '../../src/main/terminals/desktop-flow'
import { WebGateway, type WsModule } from '../../src/main/web/gateway'
import {
  CLOSE,
  decodeJson,
  encodeFrame,
  eventAllowed,
  invokeAllowed,
  MAX_FRAME_BYTES,
  parseClientFrame,
  PROTOCOL_VERSION
} from '../../src/main/web/protocol'
import { webAccessOf } from '../../src/main/web/settings'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

const DEVICE: WebDevice = { id: 'dev1', name: 'phone', createdAt: 0, lastSeenAt: 0, mode: 'link' }
const LAYOUT = { zones: {} } as unknown as LayoutView

describe('frames', () => {
  it('Uint8Array and Buffer travel as $bytes and come back as a Uint8Array copy', () => {
    const bytes = new Uint8Array([0, 1, 2, 255])
    const text = encodeFrame({ t: 'result', id: 1, ok: true, v: { a: bytes, b: [Buffer.from('hi')] } })
    expect(JSON.parse(text)).toEqual({ t: 'result', id: 1, ok: true, v: { a: { $bytes: 'AAEC/w==' }, b: [{ $bytes: 'aGk=' }] } })
    const back = decodeJson(text) as { v: { a: Uint8Array; b: Uint8Array[] } }
    expect(back.v.a).toBeInstanceOf(Uint8Array)
    expect(Buffer.isBuffer(back.v.a)).toBe(false)
    expect([...back.v.a]).toEqual([0, 1, 2, 255])
    expect(Buffer.from(back.v.b[0] ?? []).toString()).toBe('hi')
    // A subarray sends its own bytes, not the whole buffer under it.
    expect(JSON.parse(encodeFrame({ t: 'event', ch: 'x', p: bytes.subarray(1, 3) })).p).toEqual({ $bytes: 'AQI=' })
  })

  it('only an object with exactly a valid $bytes string decodes to bytes', () => {
    expect(decodeJson('{"$bytes":"AAE=","x":1}')).toEqual({ $bytes: 'AAE=', x: 1 })
    expect(decodeJson('{"$bytes":"not base64!"}')).toEqual({ $bytes: 'not base64!' })
    expect(decodeJson('{"$bytes":"AAE"}')).toEqual({ $bytes: 'AAE' })
    expect(decodeJson('{"$bytes":5}')).toEqual({ $bytes: 5 })
    expect(decodeJson('{"$bytes":""}')).toEqual(new Uint8Array(0))
  })

  it('parses hello and invoke, and names what is wrong with anything else', () => {
    expect(parseClientFrame('{"t":"hello","v":1,"project":"p1","extra":true}')).toEqual({ t: 'hello', v: 1, project: 'p1' })
    expect(parseClientFrame('{"t":"invoke","id":3,"ch":"tabs.list","p":{"$bytes":"AA=="},"projectId":"other"}')).toEqual({
      t: 'invoke',
      id: 3,
      ch: 'tabs.list',
      p: new Uint8Array([0])
    })
    for (const bad of [
      'nope',
      '[]',
      'null',
      '"hello"',
      '{"t":"event","ch":"x"}',
      '{"t":"hello","v":"1","project":"p"}',
      '{"t":"hello","v":1,"project":""}',
      `{"t":"hello","v":1,"project":"${'x'.repeat(201)}"}`,
      '{"t":"invoke","id":-1,"ch":"tabs.list"}',
      '{"t":"invoke","id":1.5,"ch":"tabs.list"}',
      '{"t":"invoke","id":"1","ch":"tabs.list"}',
      '{"t":"invoke","id":1,"ch":""}',
      `{"t":"invoke","id":1,"ch":"${'x'.repeat(65)}"}`
    ]) {
      expect(parseClientFrame(bad)).toHaveProperty('error')
    }
  })

  it('the allow-lists: invoke channels and event channels, `no` class refused both ways', () => {
    expect(invokeAllowed('tabs.list')).toBe(true)
    expect(invokeAllowed('window.reopen')).toBe(false)
    expect(invokeAllowed('projects.openFolder')).toBe(false)
    // An event-only name is not an invoke, and the other way round.
    expect(invokeAllowed('tabs.data')).toBe(false)
    expect(eventAllowed('tabs.list')).toBe(false)
    expect(eventAllowed('tabs.data')).toBe(true)
    expect(eventAllowed('notify.chime')).toBe(false)
    for (const name of ['__proto__', 'toString', 'constructor', 'nope']) {
      expect(invokeAllowed(name)).toBe(false)
      expect(eventAllowed(name)).toBe(false)
    }
  })
})

/** A socket as the connection sees it: frames it sent, how it was closed, frames to feed in. */
class FakeWs implements WsLike {
  readyState = 1
  readonly sent: Array<Record<string, unknown>> = []
  closedWith: { code: number; reason: string } | undefined
  private onMessage: ((data: unknown, isBinary: boolean) => void) | undefined
  private onClose: (() => void) | undefined

  send(data: string): void {
    this.sent.push(decodeJson(data) as Record<string, unknown>)
  }
  close(code = 1000, reason = ''): void {
    if (this.readyState !== 1) return
    this.readyState = 3
    this.closedWith = { code, reason }
    this.onClose?.()
  }
  on(event: 'message' | 'close', listener: (...args: never[]) => void): unknown {
    if (event === 'message') this.onMessage = listener as (data: unknown, isBinary: boolean) => void
    else this.onClose = listener as () => void
    return this
  }
  feed(frame: unknown): void {
    this.onMessage?.(Buffer.from(typeof frame === 'string' ? frame : JSON.stringify(frame)), false)
  }
  feedBinary(): void {
    this.onMessage?.(Buffer.from([1, 2]), true)
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

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Two project windows (1: p1, 2: p2), a real router and registry, and a connection factory. */
function setup(
  over: { snapshot?: (ctx: ProjectContext) => never; mirror?: TerminalSource; hasTab?: (projectId: string, tabId: string) => boolean } = {}
) {
  const windows = new Map<string, number>([
    ['p1', 1],
    ['p2', 2]
  ])
  const logs: string[] = []
  const router = new IpcRouter(
    { handle: () => undefined },
    () => undefined,
    () => false,
    (m) => logs.push(m),
    (windowId, projectId) => windows.get(projectId) === windowId
  )
  const views = new ViewRegistry({ windowIdOf: (projectId) => windows.get(projectId) })
  const desktop = { send: vi.fn(), isClosed: () => false }
  views.addDesktop(1, desktop)
  const conns = new WebConnections({
    dispatch: (caller, channel, payload) => router.dispatch(caller, channel, payload),
    addView: (windowId, viewId, sink) => views.addRemote(windowId, viewId, sink),
    windowIdOf: (projectId) => windows.get(projectId),
    snapshot:
      over.snapshot ??
      (({ windowId, projectId }) => ({
        tabs: [{ id: `${projectId}-t1` } as never],
        layout: LAYOUT,
        overlays: [{ id: `o${windowId}` } as never]
      })),
    // No tab is held: these tests are about frames and events (the terminal stream has its own below).
    mirror: over.mirror ?? { join: () => undefined },
    hasTab: over.hasTab ?? (() => false),
    log: (m) => logs.push(m),
    helloTimeoutMs: 50
  })
  const connect = (project?: string): FakeWs => {
    const ws = new FakeWs()
    conns.accept(ws, DEVICE)
    if (project !== undefined) ws.feed({ t: 'hello', v: PROTOCOL_VERSION, project })
    return ws
  }
  return { windows, router, views, desktop, conns, connect, logs }
}

describe('handshake', () => {
  it('hello binds to the open project window: ready carries the view id and the snapshot', () => {
    const { connect, views, conns } = setup()
    const ws = connect('p1')
    expect(ws.sent).toEqual([
      {
        t: 'ready',
        v: PROTOCOL_VERSION,
        view: 'web:1',
        snapshot: { tabs: [{ id: 'p1-t1' }], layout: LAYOUT, overlays: [{ id: 'o1' }] }
      }
    ])
    expect(views.viewsOf(1)).toEqual(['desktop:1', 'web:1'])
    // A second view gets a fresh id.
    connect('p1')
    expect(views.viewsOf(1)).toEqual(['desktop:1', 'web:1', 'web:2'])
    expect(conns.size()).toBe(2)
  })

  it('an event right after hello comes after ready, never before it', () => {
    const { connect, views } = setup()
    const ws = connect('p1')
    views.toProject('p1', 'layout.updated', { n: 1 })
    expect(ws.sent.map((f) => f.t)).toEqual(['ready', 'event'])
  })

  it('a project with no open window, a wrong version, no hello in time: closed, never registered', async () => {
    const { connect, views } = setup()
    const ws = connect('p9')
    expect(ws.closedWith?.code).toBe(CLOSE.noProject)
    expect(ws.sent).toEqual([])
    const old = new FakeWs()
    setup().conns.accept(old, DEVICE)
    old.feed({ t: 'hello', v: PROTOCOL_VERSION + 1, project: 'p1' })
    expect(old.closedWith?.code).toBe(CLOSE.version)
    const silent = connect()
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(silent.closedWith?.code).toBe(CLOSE.noHello)
    expect(views.viewsOf(1)).toEqual(['desktop:1'])
  })

  it('a snapshot that throws closes the socket without registering the view', () => {
    const { connect, views } = setup({
      snapshot: () => {
        throw new Error('project record is gone')
      }
    })
    expect(connect('p1').closedWith?.code).toBe(CLOSE.failed)
    expect(views.viewsOf(1)).toEqual(['desktop:1'])
  })

  it('invoke before hello, a second hello, binary and bad frames close the socket', () => {
    const { connect, views } = setup()
    const early = connect()
    early.feed({ t: 'invoke', id: 1, ch: 'tabs.list' })
    expect(early.closedWith?.code).toBe(CLOSE.badFrame)
    const twice = connect('p1')
    twice.feed({ t: 'hello', v: PROTOCOL_VERSION, project: 'p2' })
    expect(twice.closedWith?.code).toBe(CLOSE.badFrame)
    // The rebind attempt is not a view of either window any more.
    expect(views.viewsOf(1)).toEqual(['desktop:1'])
    expect(views.viewsOf(2)).toEqual([])
    const binary = connect('p1')
    binary.feedBinary()
    expect(binary.closedWith?.code).toBe(CLOSE.badFrame)
    const junk = connect('p1')
    junk.feed('{not json')
    expect(junk.closedWith?.code).toBe(CLOSE.badFrame)
  })

  it('a bind that throws closes the socket with `failed` instead of escaping the message listener', () => {
    const { connect, views, logs } = setup()
    // The id the next connection mints is taken: ViewRegistry.addRemote throws on it.
    views.addRemote(1, 'web:1', { send: () => {}, isClosed: () => false })
    let ws: FakeWs | undefined
    expect(() => (ws = connect('p1'))).not.toThrow()
    expect(ws?.closedWith?.code).toBe(CLOSE.failed)
    expect(ws?.sent).toEqual([])
    expect(logs.some((m) => m.includes('bind failed'))).toBe(true)
    // The view that held the id is untouched.
    expect(views.viewsOf(1)).toEqual(['desktop:1', 'web:1'])
  })
})

// The incident behind SnapshotSources: the join read overlays with OverlayManager.list, the
// desktop's re-attach call, which marked the desktop's html pages not ready (posts then waited in
// the outbox for good), brought their loader back and reset its terminal overlays' flow.
describe('windowSnapshot leaves the desktop as it was', () => {
  it('html pages stay ready (a post is delivered, no loader) and a paused terminal stays paused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccc-web-snap-'))
    try {
      const backend = new FakePtyBackend()
      const emitted: Array<{ channel: EventChannel; payload: unknown }> = []
      const overlays = new OverlayManager({
        backend,
        views: {
          create: () => {
            throw new Error('no url views here')
          },
          focusWindow: () => {}
        },
        isWindowOpen: () => true,
        env: () => ({ PATH: '/usr/bin', TERM: 'xterm-256color' }),
        emit: (_windowId, channel, payload) => emitted.push({ channel, payload }),
        commandForChord: () => undefined,
        log: () => {}
      })
      void overlays.open(1, { kind: 'html', src: 'cc-plugin://a.one/p.html' }, 'plugin a.one', undefined, { onMessage: () => {} })
      void overlays.open(1, { kind: 'terminal', argv: ['yes'], cwd: dir }, 'test')
      const [page] = overlays.infos(1)
      overlays.pageReady(1, page!.id)
      const pty = backend.last
      // Flood past the high-water mark without acks: the desktop's terminal overlay is paused.
      pty.emit('y'.repeat(2 * 1024 * 1024))
      expect(pty.paused).toBe(true)
      const tabs = { list: vi.fn(() => []), attach: vi.fn() }
      const snap = windowSnapshot({ tabs, layouts: { view: () => LAYOUT }, overlays }, { windowId: 1, projectId: 'p1' })
      expect(snap.overlays.map((o) => o.id)).toEqual(overlays.infos(1).map((o) => o.id))
      expect(snap.overlays.some((o) => o.loading === true)).toBe(false)
      expect(tabs.list).toHaveBeenCalledWith('p1')
      expect(tabs.attach).not.toHaveBeenCalled()
      // No flow reset: the PTY stays paused until the desktop acks.
      expect(pty.paused).toBe(true)
      expect(pty.resumeCalls).toBe(0)
      // The page is still ready: the opener's post goes out at once, not into the outbox.
      emitted.length = 0
      expect(overlays.post(1, page!.id, '"hi"')).toBe(true)
      expect(emitted).toEqual([{ channel: 'overlays.message', payload: { overlayId: page!.id, message: '"hi"' } }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a project with no layout record throws (the connection closes with `failed`)', () => {
    const sources = { tabs: { list: () => [] }, layouts: { view: () => undefined }, overlays: { infos: () => [] } }
    expect(() => windowSnapshot(sources, { windowId: 1, projectId: 'p1' })).toThrow('project record is gone')
  })
})

describe('invoke', () => {
  it('round trip through the router: the handler gets the bound window, project and view', async () => {
    const { connect, router } = setup()
    const seen: unknown[] = []
    router.handleProject('layout.get', (ctx, payload, view) => {
      seen.push({ ctx, payload, view })
      return LAYOUT
    })
    const ws = connect('p1')
    // A payload naming another project or window changes nothing: only `p` reaches the handler,
    // and the context is the one bound at hello.
    ws.feed({ t: 'invoke', id: 7, ch: 'layout.get', p: { projectId: 'p2', windowId: 2 }, projectId: 'p2' })
    await flush()
    expect(ws.frames('result')).toEqual([{ t: 'result', id: 7, ok: true, v: LAYOUT }])
    expect(seen).toEqual([
      {
        ctx: { windowId: 1, projectId: 'p1' },
        payload: { projectId: 'p2', windowId: 2 },
        view: { viewId: 'web:1', who: 'owner', remote: true }
      }
    ])
  })

  it('a socket being closed (web access turned off: CLOSING for the grace) dispatches nothing more', async () => {
    const { connect, router } = setup()
    const input = vi.fn()
    router.handleProject('layout.get', input)
    const ws = connect('p1')
    // The gateway called close(4503): `ws` still emits the frames the peer sent before its close frame.
    ws.readyState = 2
    ws.feed({ t: 'invoke', id: 1, ch: 'layout.get' })
    await flush()
    expect(input).not.toHaveBeenCalled()
    expect(ws.sent.filter((f) => f.t === 'result')).toEqual([])
  })

  it('unknown and `no`-class channels answer refused without reaching a handler; the socket stays', async () => {
    const { connect, router } = setup()
    const reopen = vi.fn()
    router.handleProject('window.reopen', reopen)
    const ws = connect('p1')
    ws.feed({ t: 'invoke', id: 1, ch: 'window.reopen' })
    ws.feed({ t: 'invoke', id: 2, ch: 'nope.nope' })
    ws.feed({ t: 'invoke', id: 3, ch: '__proto__' })
    ws.feed({ t: 'invoke', id: 4, ch: 'tabs.data' })
    await flush()
    expect(reopen).not.toHaveBeenCalled()
    expect(ws.frames('result')).toEqual([
      { t: 'result', id: 1, ok: false, err: 'window.reopen: refused' },
      { t: 'result', id: 2, ok: false, err: 'nope.nope: refused' },
      { t: 'result', id: 3, ok: false, err: '__proto__: refused' },
      { t: 'result', id: 4, ok: false, err: 'tabs.data: refused' }
    ])
    expect(ws.closedWith).toBeUndefined()
  })

  it('a throwing handler returns its message only; a missing handler says so', async () => {
    const { connect, router } = setup()
    router.handleProject('tabs.close', () => {
      const err = new Error('tabs.close: unknown tab')
      ;(err as Error & { secret?: string }).secret = 'x'
      throw err
    })
    const ws = connect('p1')
    ws.feed({ t: 'invoke', id: 1, ch: 'tabs.close', p: { tabId: 'z' } })
    ws.feed({ t: 'invoke', id: 2, ch: 'tabs.rename' })
    await flush()
    expect(ws.frames('result')).toEqual([
      { t: 'result', id: 1, ok: false, err: 'tabs.close: unknown tab' },
      { t: 'result', id: 2, ok: false, err: 'tabs.rename: no handler' }
    ])
  })

  it('$bytes both ways: a Uint8Array result is encoded, a $bytes payload arrives as bytes', async () => {
    const { connect, router } = setup()
    let got: unknown
    router.handleProject('settings.marketplacePreview', (_ctx, payload) => {
      got = payload
      return new Uint8Array([9, 8, 7])
    })
    const ws = connect('p1')
    ws.sent.length = 0
    ws.feed({ t: 'invoke', id: 1, ch: 'settings.marketplacePreview', p: { blob: { $bytes: 'AQI=' } } })
    await flush()
    expect(got).toEqual({ blob: new Uint8Array([1, 2]) })
    expect(ws.frames('result')).toEqual([{ t: 'result', id: 1, ok: true, v: new Uint8Array([9, 8, 7]) }])
  })

  it('a result over the frame cap becomes an error; a result JSON cannot hold too', async () => {
    const { connect, router } = setup()
    router.handleProject('tabs.commands', () => 'x'.repeat(MAX_FRAME_BYTES) as never)
    router.handleProject('layout.get', () => ({ big: 1n }) as never)
    const ws = connect('p1')
    ws.feed({ t: 'invoke', id: 1, ch: 'tabs.commands' })
    ws.feed({ t: 'invoke', id: 2, ch: 'layout.get' })
    await flush()
    expect(ws.frames('result')).toEqual([
      { t: 'result', id: 1, ok: false, err: 'result too large' },
      { t: 'result', id: 2, ok: false, err: 'result not serializable' }
    ])
    expect(ws.closedWith).toBeUndefined()
  })

  it('more invokes in flight than the cap answer busy', async () => {
    const { connect, router } = setup()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    router.handleProject('tabs.commands', () => gate.then(() => ({}) as never))
    const ws = connect('p1')
    for (let i = 0; i <= MAX_PENDING_INVOKES; i++) ws.feed({ t: 'invoke', id: i, ch: 'tabs.commands' })
    expect(ws.frames('result')).toEqual([{ t: 'result', id: MAX_PENDING_INVOKES, ok: false, err: 'busy' }])
    release()
    await flush()
    await flush()
    expect(ws.frames('result')).toHaveLength(MAX_PENDING_INVOKES + 1)
  })

  it('an answer that arrives after the socket closed is dropped', async () => {
    const { connect, router } = setup()
    let release: () => void = () => undefined
    router.handleProject('tabs.commands', () => new Promise((resolve) => (release = () => resolve({} as never))))
    const ws = connect('p1')
    ws.feed({ t: 'invoke', id: 1, ch: 'tabs.commands' })
    await flush()
    ws.drop()
    release()
    await flush()
    expect(ws.frames('result')).toEqual([])
  })
})

describe('events and window lifetime', () => {
  it('events reach only the views of their project, the desktop view too', () => {
    const { connect, views, desktop } = setup()
    const a = connect('p1')
    const b = connect('p2')
    views.toProject('p1', 'layout.updated', { which: 'p1' })
    views.toProject('p2', 'tabs.exit', { tabId: 't', code: 0, signal: null, gen: 1 })
    expect(a.frames('event')).toEqual([{ t: 'event', ch: 'layout.updated', p: { which: 'p1' } }])
    expect(b.frames('event')).toEqual([{ t: 'event', ch: 'tabs.exit', p: { tabId: 't', code: 0, signal: null, gen: 1 } }])
    expect(desktop.send).toHaveBeenCalledWith('layout.updated', { which: 'p1' })
    // App-wide events reach every view.
    views.toAll('theme.changed', { kind: 'dark' })
    expect(a.frames('event')).toHaveLength(2)
    expect(b.frames('event')).toHaveLength(2)
  })

  it('a `no`-class event never leaves main for a remote view, while the desktop gets it', () => {
    const { connect, views, desktop } = setup()
    const ws = connect('p1')
    views.toWindow(1, 'notify.chime', { sound: 'x' } as never)
    views.toWindow(1, 'projects.changed', {} as never)
    expect(ws.frames('event')).toEqual([])
    expect(desktop.send).toHaveBeenCalledWith('notify.chime', { sound: 'x' })
  })

  it('an event over the frame cap closes the view (it reconnects to a fresh snapshot)', () => {
    const { connect, views } = setup()
    const ws = connect('p1')
    views.toProject('p1', 'layout.updated', { big: 'x'.repeat(MAX_FRAME_BYTES) } as never)
    expect(ws.closedWith?.code).toBe(CLOSE.tooLarge)
    expect(views.viewsOf(1)).toEqual(['desktop:1'])
  })

  it('the window closing closes its remote views; the router refuses a frame that races it', async () => {
    const { connect, views, windows, router } = setup()
    const handler = vi.fn(() => LAYOUT)
    router.handleProject('layout.get', handler)
    const ws = connect('p1')
    const other = connect('p2')
    windows.delete('p1')
    // A frame already on its way when the window went (before the registry tells the view).
    ws.feed({ t: 'invoke', id: 1, ch: 'layout.get' })
    await flush()
    expect(ws.frames('result')).toEqual([{ t: 'result', id: 1, ok: false, err: 'layout.get: refused' }])
    expect(handler).not.toHaveBeenCalled()
    views.removeWindow(1)
    expect(ws.closedWith?.code).toBe(CLOSE.windowClosed)
    expect(other.closedWith).toBeUndefined()
    // A new window for the same project does not adopt the old view.
    windows.set('p1', 3)
    views.toProject('p1', 'layout.updated', {})
    expect(ws.frames('event')).toEqual([])
  })

  it('a socket that closes leaves the registry', () => {
    const { connect, views, conns } = setup()
    const ws = connect('p1')
    ws.drop()
    expect(views.viewsOf(1)).toEqual(['desktop:1'])
    expect(conns.size()).toBe(0)
    views.toProject('p1', 'layout.updated', {})
    expect(ws.frames('event')).toEqual([])
  })
})

describe('through the gateway', () => {
  let gateway: WebGateway | undefined
  const dirs: string[] = []
  afterEach(async () => {
    await gateway?.stop()
    gateway = undefined
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function listening(mode: 'none' | 'link'): Promise<{ port: number; ctx: ReturnType<typeof setup> }> {
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const { port } = probe.address() as AddressInfo
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const dir = mkdtempSync(join(tmpdir(), 'ccc-wp-'))
    dirs.push(dir)
    const accessLog = new AccessLog()
    const devices = new DeviceStore({ filePath: join(dir, 'web-access.json'), accessLog })
    const auth = new WebAuth({ devices, secrets: fakeSecretStore(), accessLog })
    gateway = new WebGateway({ log: () => undefined, loadWs: async (): Promise<WsModule> => wsModule, auth, accessLog })
    const ctx = setup()
    gateway.setSocketHandler((ws, _req, device) => {
      ctx.conns.accept(ws, device)
    })
    await gateway.apply(webAccessOf({ enabled: true, port, mode }))
    return { port, ctx }
  }

  function open(port: number): Promise<{ client: wsModule.WebSocket; frames: Array<Record<string, unknown>>; closed: Promise<number> }> {
    const host = `127.0.0.1:${port}`
    const client = new wsModule.WebSocket(`ws://${host}/ws`, { origin: `http://${host}` })
    const frames: Array<Record<string, unknown>> = []
    client.on('message', (data: Buffer) => frames.push(decodeJson(data.toString()) as Record<string, unknown>))
    const closed = new Promise<number>((resolve) => client.on('close', (code) => resolve(code)))
    return new Promise((resolve, reject) => {
      client.on('open', () => resolve({ client, frames, closed }))
      client.on('error', reject)
    })
  }

  const until = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(check()).toBe(true)
  }

  it('a real socket: hello, ready, invoke round trip and an event', async () => {
    const { port, ctx } = await listening('none')
    ctx.router.handleProject('layout.get', () => LAYOUT)
    const { client, frames } = await open(port)
    client.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, project: 'p1' }))
    await until(() => frames.length === 1)
    expect(frames[0]).toMatchObject({ t: 'ready', view: 'web:1' })
    client.send(JSON.stringify({ t: 'invoke', id: 1, ch: 'layout.get' }))
    await until(() => frames.length === 2)
    expect(frames[1]).toEqual({ t: 'result', id: 1, ok: true, v: LAYOUT })
    ctx.views.toProject('p1', 'layout.updated', { n: 1 })
    await until(() => frames.length === 3)
    expect(frames[2]).toEqual({ t: 'event', ch: 'layout.updated', p: { n: 1 } })
    client.close()
  })

  it('no cookie, no upgrade: the connection never sees the socket', async () => {
    const { port, ctx } = await listening('link')
    await expect(open(port)).rejects.toThrow(/401/)
    expect(ctx.conns.size()).toBe(0)
  })

  it('a frame over 4 MiB from the view closes the socket and leaves the registry', async () => {
    const { port, ctx } = await listening('none')
    const { client, closed } = await open(port)
    client.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, project: 'p1' }))
    await until(() => ctx.views.viewsOf(1).length === 2)
    client.on('error', () => undefined)
    client.send('x'.repeat(MAX_FRAME_BYTES + 1))
    expect(await closed).toBe(1009)
    await until(() => ctx.views.viewsOf(1).length === 1)
  })
})

/** A mirror the test drives: every join is recorded with its view, and its leave counted. */
class FakeMirror implements TerminalSource {
  readonly joins: Array<{ tabId: string; view: MirrorView; left: boolean }> = []
  join(tabId: string, view: MirrorView): () => void {
    const entry = { tabId, view, left: false }
    this.joins.push(entry)
    return () => {
      entry.left = true
    }
  }
}

describe('terminal streams (term.* frames instead of tabs.data)', () => {
  function terminals() {
    const mirror = new FakeMirror()
    const s = setup({ mirror, hasTab: (projectId, tabId) => projectId === 'p1' && tabId.startsWith('p1-') })
    const ws = s.connect('p1')
    return { ...s, mirror, ws }
  }

  it("a view's selection joins the tab (its own window's only), and the stream goes out as term frames", () => {
    const { conns, mirror, ws, views } = terminals()
    conns.select('web:1', 'p2-t1')
    conns.select('web:1', 'p1-t1')
    // The same tab again: already followed.
    conns.select('web:1', 'p1-t1')
    // A view id that is not open: ignored.
    conns.select('web:9', 'p1-t1')
    expect(mirror.joins.map((j) => j.tabId)).toEqual(['p1-t1'])
    const view = mirror.joins[0]!.view
    view.snapshot({ seq: 4, cols: 80, rows: 24, data: 'screen' })
    view.item({ seq: 5, kind: 'data', data: 'out' })
    view.item({ seq: 6, kind: 'resize', cols: 100, rows: 30 })
    // The desktop's output event is never framed for a remote view.
    views.toProject('p1', 'tabs.data', { tabId: 'p1-t1', data: 'desktop copy' })
    expect(ws.sent.slice(1)).toEqual([
      { t: 'term.snapshot', tabId: 'p1-t1', seq: 4, cols: 80, rows: 24, part: 1, parts: 1, data: 'screen' },
      { t: 'term.data', tabId: 'p1-t1', seq: 5, data: 'out' },
      { t: 'term.data', tabId: 'p1-t1', seq: 6, cols: 100, rows: 30 }
    ])
  })

  it("the view's acks are its own flow: past the limit it stops getting data, acked down it joins again", () => {
    const { conns, mirror, ws } = terminals()
    conns.select('web:1', 'p1-t1')
    const first = mirror.joins[0]!
    first.view.snapshot({ seq: 1, cols: 80, rows: 24, data: '' })
    const big = 'x'.repeat(VIEW_HIGH_WATER)
    first.view.item({ seq: 2, kind: 'data', data: big })
    first.view.item({ seq: 3, kind: 'data', data: 'over' })
    expect(first.left).toBe(true)
    expect(ws.frames('term.data')).toHaveLength(1)
    conns.ack('web:1', 'p1-t1', VIEW_HIGH_WATER - VIEW_LOW_WATER - 1)
    expect(mirror.joins).toHaveLength(1)
    conns.ack('web:1', 'p1-t1', 1)
    expect(mirror.joins).toHaveLength(2)
    expect(mirror.joins[1]!.tabId).toBe('p1-t1')
  })

  it('a failed send is resynced once on a later turn; a second failure closes the view', async () => {
    const { conns, mirror, ws, logs } = terminals()
    conns.select('web:1', 'p1-t1')
    // The socket throws while the frames go out (closing under the send).
    const snap = { seq: 1, cols: 80, rows: 24, data: 'a' }
    const failing = mirror.joins[0]!
    const realSend = ws.send.bind(ws)
    ws.send = () => {
      throw new Error('socket closing')
    }
    failing.view.snapshot(snap)
    expect(failing.left).toBe(true)
    expect(mirror.joins).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(mirror.joins).toHaveLength(2)
    mirror.joins[1]!.view.snapshot(snap)
    expect(ws.closedWith?.code).toBe(CLOSE.failed)
    expect(logs.some((l) => l.includes('terminal frames failed'))).toBe(true)
    ws.send = realSend
  })

  it('a resync that went out clears the failure: a later, unrelated one resyncs again instead of closing', async () => {
    const { conns, mirror, ws } = terminals()
    conns.select('web:1', 'p1-t1')
    const snap = { seq: 1, cols: 80, rows: 24, data: 'a' }
    const realSend = ws.send.bind(ws)
    const failing = (): void => {
      ws.send = () => {
        throw new Error('socket closing')
      }
    }
    failing()
    mirror.joins[0]!.view.snapshot(snap)
    await new Promise((resolve) => setTimeout(resolve, 5))
    ws.send = realSend
    mirror.joins[1]!.view.snapshot(snap)
    expect(ws.frames('term.snapshot')).toHaveLength(1)
    // Much later, a data frame fails: resynced once more, the view stays open.
    failing()
    mirror.joins[1]!.view.item({ seq: 2, kind: 'data', data: 'x' })
    expect(mirror.joins[1]!.left).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 5))
    ws.send = realSend
    expect(ws.closedWith).toBeUndefined()
    expect(mirror.joins).toHaveLength(3)
  })

  it(`joins that keep ending before their snapshot stop after ${MAX_REJOINS}: resynced once more, then the view closes`, async () => {
    const { conns, mirror, ws, logs } = terminals()
    conns.select('web:1', 'p1-t1')
    for (let i = 0; i < MAX_REJOINS; i++) mirror.joins[i]!.view.closed()
    // Given up: no fourth join in this turn, the connection's resync comes on a later one.
    expect(mirror.joins).toHaveLength(MAX_REJOINS)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(mirror.joins).toHaveLength(MAX_REJOINS + 1)
    expect(logs.some((l) => l.includes(`no snapshot after ${MAX_REJOINS} joins`))).toBe(true)
    for (let i = MAX_REJOINS; i < 2 * MAX_REJOINS; i++) mirror.joins[i]!.view.closed()
    expect(ws.closedWith?.code).toBe(CLOSE.failed)
  })

  it('the socket closing leaves every followed tab', () => {
    const { conns, mirror, ws } = terminals()
    conns.select('web:1', 'p1-t1')
    conns.select('web:1', 'p1-t2')
    ws.drop()
    expect(mirror.joins.map((j) => j.left)).toEqual([true, true])
    conns.select('web:1', 'p1-t3')
    conns.ack('web:1', 'p1-t1', 10)
    expect(mirror.joins).toHaveLength(2)
  })
})
