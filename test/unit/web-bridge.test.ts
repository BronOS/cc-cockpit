// The web shell's bridge (src/renderer/web/bridge.ts): `window.cockpit` over the view's socket.
// A fake socket and fake time drive it; the frames it sends are read back with main's own parser
// (main/web/protocol.ts), so the two ends' codecs are checked against each other.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeJson, encodeFrame, parseClientFrame } from '../../src/main/web/protocol'
import type { CockpitApi, EventChannel, InvokeChannel } from '../../src/shared/ipc'
import { EVENT_CHANNELS, INVOKE_CHANNELS, remoteAllowed } from '../../src/shared/ipc'
import { CLOSE, MAX_FRAME_BYTES, PROTOCOL_VERSION, WS_PATH, type ServerFrame, type WebSnapshot } from '../../src/shared/web-protocol'
import {
  createWebBridge,
  decodeServerJson,
  encodeClientFrame,
  READY_TIMEOUT_MS,
  STABLE_MS,
  reconnectDelay,
  socketUrl,
  UNREACHABLE,
  utf8Length,
  type BridgeStatus,
  type SocketLike,
  type Timers,
  type WebBridge
} from '../../src/renderer/web/bridge'

class FakeSocket implements SocketLike {
  readyState = 0
  sent: string[] = []
  closedWith: { code?: number; reason?: string } | undefined
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  constructor(readonly url: string) {}
  send(data: string): void {
    if (this.readyState !== 1) throw new Error('not open')
    this.sent.push(data)
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason }
    this.readyState = 3
  }
  // Test side.
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }
  serverSend(frame: ServerFrame | Record<string, unknown>): void {
    this.onmessage?.({ data: encodeFrame(frame as ServerFrame) })
  }
  serverRaw(data: unknown): void {
    this.onmessage?.({ data })
  }
  serverClose(code: number, reason = ''): void {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
  /** The client frames sent, parsed by main's parser. */
  frames(): ReturnType<typeof parseClientFrame>[] {
    return this.sent.map((s) => parseClientFrame(s))
  }
}

class FakeTimers implements Timers {
  t = 1000
  private next = 1
  private timers = new Map<number, { at: number; fn: () => void }>()
  now = (): number => this.t
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.next++
    this.timers.set(id, { at: this.t + ms, fn })
    return id
  }
  clearTimeout = (h: unknown): void => {
    this.timers.delete(h as number)
  }
  advance(ms: number): void {
    const end = this.t + ms
    for (;;) {
      const due = [...this.timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.timers.delete(due[0])
      this.t = due[1].at
      due[1].fn()
    }
    this.t = end
  }
  pending(): number {
    return this.timers.size
  }
}

const SNAPSHOT: WebSnapshot = {
  tabs: [],
  layout: {} as WebSnapshot['layout'],
  overlays: []
}

interface Rig {
  bridge: WebBridge
  api: CockpitApi
  sockets: FakeSocket[]
  timers: FakeTimers
  statuses: BridgeStatus[]
  last(): FakeSocket
}

const bridges: WebBridge[] = []
afterEach(() => {
  for (const b of bridges.splice(0)) b.close()
})

function rig(checkSession?: () => Promise<boolean>): Rig {
  const sockets: FakeSocket[] = []
  const timers = new FakeTimers()
  const bridge = createWebBridge({
    url: 'ws://127.0.0.1:7330/ws',
    project: 'p1',
    timers,
    checkSession,
    createSocket: (url) => {
      const s = new FakeSocket(url)
      sockets.push(s)
      return s
    }
  })
  bridges.push(bridge)
  const statuses: BridgeStatus[] = []
  bridge.onStatus((s) => statuses.push(s))
  return { bridge, api: bridge.api, sockets, timers, statuses, last: () => sockets[sockets.length - 1]! }
}

/** Open the latest socket and answer its hello with `ready`. */
function connect(r: Rig, view = 'web:1'): FakeSocket {
  const s = r.last()
  s.open()
  s.serverSend({ t: 'ready', v: PROTOCOL_VERSION, view, snapshot: SNAPSHOT })
  return s
}

/** The id of the last invoke frame the socket sent. */
function lastInvokeId(s: FakeSocket): number {
  const f = s.frames().at(-1)
  if (!f || !('t' in f) || f.t !== 'invoke') throw new Error('no invoke sent')
  return f.id
}

const anyApi = (api: CockpitApi): { invoke(ch: unknown, ...p: unknown[]): Promise<unknown>; on(ch: unknown, l: (p: unknown) => void): () => void } =>
  api as never

describe('codec', () => {
  it('round-trips bytes with main both ways', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128])
    const text = encodeClientFrame({ t: 'invoke', id: 3, ch: 'tabs.input', p: { tabId: 't', data: bytes } })
    const parsed = parseClientFrame(text)
    expect(parsed).toEqual({ t: 'invoke', id: 3, ch: 'tabs.input', p: { tabId: 't', data: bytes } })
    expect((parsed as { p: { data: unknown } }).p.data).toBeInstanceOf(Uint8Array)

    const fromMain = encodeFrame({ t: 'event', ch: 'tabs.data', p: { data: Buffer.from([9, 8, 7]) } })
    const decoded = decodeServerJson(fromMain) as { p: { data: Uint8Array } }
    expect(decoded.p.data).toBeInstanceOf(Uint8Array)
    expect([...decoded.p.data]).toEqual([9, 8, 7])
  })

  it('keeps a large payload intact (chunked base64)', () => {
    const bytes = new Uint8Array(200_000).map((_, i) => (i * 31) & 0xff)
    const text = encodeClientFrame({ t: 'invoke', id: 1, ch: 'x', p: bytes })
    expect([...(decodeJson(text) as { p: Uint8Array }).p]).toEqual([...bytes])
  })

  it('leaves look-alikes alone, as main does', () => {
    for (const v of [{ $bytes: 'abc' }, { $bytes: 'a$==' }, { $bytes: 1 }, { $bytes: 'AA==', x: 1 }]) {
      expect(decodeServerJson(JSON.stringify(v))).toEqual(decodeJson(JSON.stringify(v)))
      expect(decodeServerJson(JSON.stringify(v))).toEqual(v)
    }
  })

  it('counts UTF-8 bytes as Buffer does', () => {
    for (const s of ['', 'abc', 'é', '€', '😀', 'a\ud800b', '\udc00', 'x😀é€'.repeat(50)]) {
      expect(utf8Length(s)).toBe(Buffer.byteLength(s, 'utf8'))
    }
  })

  it('builds the socket URL from the page origin', () => {
    expect(socketUrl({ protocol: 'http:', host: '127.0.0.1:7330' }, WS_PATH)).toBe('ws://127.0.0.1:7330/ws')
    expect(socketUrl({ protocol: 'https:', host: 'box.ts.net' }, WS_PATH)).toBe('wss://box.ts.net/ws')
  })
})

describe('handshake', () => {
  it('says hello with the project and becomes ready with the view and snapshot', () => {
    const r = rig()
    expect(r.bridge.status()).toEqual({ state: 'connecting' })
    expect(r.last().url).toBe('ws://127.0.0.1:7330/ws')
    connect(r, 'web:7')
    expect(r.last().frames()).toEqual([{ t: 'hello', v: PROTOCOL_VERSION, project: 'p1' }])
    expect(r.bridge.status()).toEqual({ state: 'ready', view: 'web:7', generation: 1 })
    expect(r.bridge.snapshot()).toEqual(SNAPSHOT)
  })

  it('ignores a ready of another protocol version and a second ready', () => {
    const r = rig()
    const s = r.last()
    s.open()
    s.serverSend({ t: 'ready', v: PROTOCOL_VERSION + 1, view: 'web:1', snapshot: SNAPSHOT })
    expect(r.bridge.status().state).toBe('connecting')
    s.serverSend({ t: 'ready', v: PROTOCOL_VERSION, view: 'web:1', snapshot: SNAPSHOT })
    s.serverSend({ t: 'ready', v: PROTOCOL_VERSION, view: 'web:2', snapshot: SNAPSHOT })
    expect(r.bridge.status()).toEqual({ state: 'ready', view: 'web:1', generation: 1 })
  })

  it('gives up on a socket whose ready never comes, and retries', () => {
    const r = rig()
    const s = r.last()
    s.open()
    r.timers.advance(10_000)
    expect(s.closedWith).toBeDefined()
    s.serverClose(1006)
    expect(r.bridge.status().state).toBe('away')
  })

  it('rejects calls before ready', async () => {
    const r = rig()
    r.last().open()
    await expect(r.api.invoke('window.info')).rejects.toThrow(UNREACHABLE)
    expect(r.last().sent).toHaveLength(1) // the hello only
  })

  it('ignores junk frames without closing', () => {
    const r = rig()
    const s = connect(r)
    for (const junk of ['not json', '[]', 'null', '{"t":"nope"}', new ArrayBuffer(4), '{"t":"result","id":"x"}']) s.serverRaw(junk)
    expect(s.closedWith).toBeUndefined()
    expect(r.bridge.status().state).toBe('ready')
  })
})

describe('allow-lists', () => {
  it('refuses a channel outside the shared list without sending', async () => {
    const r = rig()
    const s = connect(r)
    for (const ch of ['nope', '__proto__', 'toString', 42, undefined]) {
      await expect(anyApi(r.api).invoke(ch)).rejects.toThrow('invalid channel')
    }
    expect(s.sent).toHaveLength(1)
  })

  it('refuses a no-class invoke channel without sending', async () => {
    const r = rig()
    const s = connect(r)
    const noClass = INVOKE_CHANNELS.filter((c) => !remoteAllowed(c))
    expect(noClass.length).toBeGreaterThan(0)
    for (const ch of noClass) {
      await expect(anyApi(r.api).invoke(ch)).rejects.toThrow('not available in a remote view')
    }
    expect(s.sent).toHaveLength(1)
  })

  it('throws on an unknown event channel, as the preload', () => {
    const r = rig()
    expect(() => anyApi(r.api).on('nope', () => undefined)).toThrow('invalid channel')
    expect(() => anyApi(r.api).on('__proto__', () => undefined)).toThrow('invalid channel')
    expect(() => anyApi(r.api).on(7, () => undefined)).toThrow('invalid channel')
  })

  it('accepts a no-class event listener that never fires', () => {
    const r = rig()
    const s = connect(r)
    const noClass = EVENT_CHANNELS.filter((c) => !remoteAllowed(c))
    expect(noClass).toContain('window.state')
    const seen = vi.fn()
    for (const ch of noClass) {
      const off = r.api.on(ch, seen)
      expect(typeof off).toBe('function')
      off()
      r.api.on(ch, seen)
      s.serverSend({ t: 'event', ch, p: {} })
    }
    expect(seen).not.toHaveBeenCalled()
  })

  it('refuses an oversize invoke locally instead of getting the socket closed', async () => {
    const r = rig()
    const s = connect(r)
    const big = 'x'.repeat(MAX_FRAME_BYTES)
    await expect(r.api.invoke('tabs.input', { tabId: 't', data: big } as never)).rejects.toThrow('payload too large')
    expect(s.sent).toHaveLength(1)
    expect(s.closedWith).toBeUndefined()
  })
})

describe('invoke and result', () => {
  it('matches results by id, out of order', async () => {
    const r = rig()
    const s = connect(r)
    const a = r.api.invoke('window.info')
    const idA = lastInvokeId(s)
    const b = r.api.invoke('theme.get')
    const idB = lastInvokeId(s)
    expect(idA).not.toBe(idB)
    expect(s.frames().slice(1)).toEqual([
      { t: 'invoke', id: idA, ch: 'window.info', p: undefined },
      { t: 'invoke', id: idB, ch: 'theme.get', p: undefined }
    ])
    s.serverSend({ t: 'result', id: idB, ok: true, v: 'B' })
    s.serverSend({ t: 'result', id: idA, ok: true, v: 'A' })
    await expect(a).resolves.toBe('A')
    await expect(b).resolves.toBe('B')
  })

  it('sends the one payload argument', () => {
    const r = rig()
    const s = connect(r)
    r.api.invoke('tabs.rename', { tabId: 't1', title: 'x' } as never).catch(() => undefined)
    expect(s.frames().at(-1)).toMatchObject({ t: 'invoke', ch: 'tabs.rename', p: { tabId: 't1', title: 'x' } })
  })

  it('rejects with main\'s message only', async () => {
    const r = rig()
    const s = connect(r)
    const p = r.api.invoke('window.info')
    s.serverSend({ t: 'result', id: lastInvokeId(s), ok: false, err: 'no such tab' })
    const err = await p.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('no such tab')
  })

  it('ignores a result for an unknown or already answered id', async () => {
    const r = rig()
    const s = connect(r)
    const p = r.api.invoke('window.info')
    const id = lastInvokeId(s)
    s.serverSend({ t: 'result', id: id + 100, ok: true, v: 'stray' })
    s.serverSend({ t: 'result', id, ok: true, v: 'first' })
    s.serverSend({ t: 'result', id, ok: false, err: 'second' })
    await expect(p).resolves.toBe('first')
  })

  it('decodes bytes in a result', async () => {
    const r = rig()
    const s = connect(r)
    const p = r.api.invoke('window.info')
    s.serverSend({ t: 'result', id: lastInvokeId(s), ok: true, v: { b: Buffer.from([1, 2]) } })
    const v = (await p) as unknown as { b: Uint8Array }
    expect(v.b).toBeInstanceOf(Uint8Array)
    expect([...v.b]).toEqual([1, 2])
  })
})

describe('events', () => {
  it('routes an event to the listeners of its channel only, payload only', () => {
    const r = rig()
    const s = connect(r)
    const a = vi.fn()
    const b = vi.fn()
    r.api.on('tabs.removed', a)
    r.api.on('theme.changed', b)
    s.serverSend({ t: 'event', ch: 'tabs.removed', p: { tabId: 't' } })
    expect(a).toHaveBeenCalledWith({ tabId: 't' })
    expect(b).not.toHaveBeenCalled()
  })

  it('stops after unsubscribe; one throwing listener does not stop the others', () => {
    const r = rig()
    const s = connect(r)
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const good = vi.fn()
    const off = r.api.on('tabs.removed', () => {
      throw new Error('boom')
    })
    r.api.on('tabs.removed', good)
    s.serverSend({ t: 'event', ch: 'tabs.removed', p: 1 })
    expect(good).toHaveBeenCalledTimes(1)
    off()
    s.serverSend({ t: 'event', ch: 'tabs.removed', p: 2 })
    expect(good).toHaveBeenCalledTimes(2)
    expect(err).toHaveBeenCalledTimes(1)
    err.mockRestore()
  })

  it('drops an event on a channel outside the list or of the no class', () => {
    const r = rig()
    const s = connect(r)
    const seen = vi.fn()
    r.api.on('tabs.removed', seen)
    s.serverSend({ t: 'event', ch: 'nope', p: 1 })
    s.serverSend({ t: 'event', ch: 'window.state' as EventChannel, p: 1 })
    s.serverSend({ t: 'event', ch: 7, p: 1 })
    expect(seen).not.toHaveBeenCalled()
  })

  it('keeps listeners across a reconnect', () => {
    const r = rig()
    connect(r)
    const seen = vi.fn()
    r.api.on('tabs.removed', seen)
    r.last().serverClose(1006)
    r.timers.advance(reconnectDelay(1))
    const s2 = connect(r, 'web:2')
    s2.serverSend({ t: 'event', ch: 'tabs.removed', p: 'after' })
    expect(seen).toHaveBeenCalledWith('after')
  })
})

describe('terminal frames', () => {
  const part = (tabId: string, seq: number, n: number, of: number, data: string) =>
    ({ t: 'term.snapshot', tabId, seq, cols: 80, rows: 24, part: n, parts: of, data }) as const

  it('hands term.data to the tabs.data listeners and a whole snapshot, its parts joined, with reset', () => {
    const r = rig()
    const s = connect(r)
    const seen = vi.fn()
    r.api.on('tabs.data', seen)
    s.serverSend(part('t1', 4, 1, 3, 'ab'))
    s.serverSend(part('t1', 4, 2, 3, 'cd'))
    // Another tab's snapshot may interleave; each tab is joined on its own.
    s.serverSend(part('t2', 9, 1, 1, 'other'))
    expect(seen.mock.calls).toEqual([[{ tabId: 't2', data: 'other', reset: true }]])
    s.serverSend(part('t1', 4, 3, 3, 'ef'))
    s.serverSend({ t: 'term.data', tabId: 't1', seq: 5, data: 'live' })
    // A size item is not passed on yet (per-view sizes, plan Task 15).
    s.serverSend({ t: 'term.data', tabId: 't1', seq: 6, cols: 100, rows: 30 })
    expect(seen.mock.calls.slice(1)).toEqual([[{ tabId: 't1', data: 'abcdef', reset: true }], [{ tabId: 't1', data: 'live' }]])
  })

  it('drops a snapshot whose parts come out of order, and junk terminal frames', () => {
    const r = rig()
    const s = connect(r)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const seen = vi.fn()
    r.api.on('tabs.data', seen)
    s.serverSend(part('t1', 4, 2, 2, 'no first part'))
    s.serverSend(part('t1', 4, 1, 2, 'a'))
    s.serverSend(part('t1', 5, 2, 2, 'another seq'))
    s.serverSend(part('t1', 4, 2, 2, 'too late'))
    for (const junk of [
      { t: 'term.data', tabId: 7, seq: 1, data: 'x' },
      { t: 'term.data', tabId: 't1', seq: 1.5, data: 'x' },
      part('t1', 1, 0, 1, 'x'),
      part('t1', 1, 2, 1, 'x'),
      { t: 'term.snapshot', tabId: 't1', seq: 1, part: 1, parts: 1, data: 5 }
    ]) {
      s.serverSend(junk)
    }
    expect(seen).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('forgets the parts of a dropped socket', () => {
    const r = rig()
    connect(r)
    const seen = vi.fn()
    r.api.on('tabs.data', seen)
    r.last().serverSend(part('t1', 4, 1, 2, 'old socket'))
    r.last().serverClose(1006)
    r.timers.advance(reconnectDelay(1))
    const s2 = connect(r, 'web:2')
    s2.serverSend(part('t1', 4, 2, 2, 'new socket'))
    expect(seen).not.toHaveBeenCalled()
    s2.serverSend(part('t1', 8, 1, 1, 'fresh'))
    expect(seen).toHaveBeenCalledWith({ tabId: 't1', data: 'fresh', reset: true })
  })
})

describe('drops and reconnect', () => {
  it('rejects calls in flight on a drop, goes away, and reconnects with backoff', async () => {
    const r = rig()
    const s1 = connect(r)
    const p = r.api.invoke('window.info')
    s1.serverClose(1006)
    await expect(p).rejects.toThrow(UNREACHABLE)
    expect(r.bridge.status()).toEqual({ state: 'away', retryAt: r.timers.t + 500, attempt: 1 })
    await expect(r.api.invoke('window.info')).rejects.toThrow(UNREACHABLE)
    expect(r.sockets).toHaveLength(1)

    r.timers.advance(499)
    expect(r.sockets).toHaveLength(1)
    r.timers.advance(1)
    expect(r.sockets).toHaveLength(2)
    // The second attempt fails too: the wait doubles.
    r.last().serverClose(1006)
    expect(r.bridge.status()).toMatchObject({ state: 'away', attempt: 2, retryAt: r.timers.t + 1000 })
    r.timers.advance(1000)
    expect(r.sockets).toHaveLength(3)
  })

  it('a fresh ready after a reconnect is a new generation with the new snapshot and view', async () => {
    const r = rig()
    connect(r, 'web:1')
    r.last().serverClose(1006)
    r.timers.advance(500)
    const s2 = r.last()
    s2.open()
    expect(s2.frames()).toEqual([{ t: 'hello', v: PROTOCOL_VERSION, project: 'p1' }])
    const fresh: WebSnapshot = { ...SNAPSHOT, tabs: [{ id: 't9' } as never] }
    s2.serverSend({ t: 'ready', v: PROTOCOL_VERSION, view: 'web:2', snapshot: fresh })
    expect(r.bridge.status()).toEqual({ state: 'ready', view: 'web:2', generation: 2 })
    expect(r.bridge.snapshot()).toEqual(fresh)
    // Calls work on the new socket.
    const p = r.api.invoke('window.info')
    s2.serverSend({ t: 'result', id: lastInvokeId(s2), ok: true, v: 'ok' })
    await expect(p).resolves.toBe('ok')
    expect(r.statuses.map((s) => s.state)).toEqual(['ready', 'away', 'ready'])
  })

  it('resets the backoff after a good connection', () => {
    const r = rig()
    connect(r)
    for (let i = 0; i < 3; i++) {
      r.last().serverClose(1006)
      r.timers.advance(reconnectDelay(i + 1))
    }
    connect(r)
    r.timers.advance(STABLE_MS)
    r.last().serverClose(1006)
    expect(r.bridge.status()).toMatchObject({ state: 'away', attempt: 1 })
  })

  it('keeps the backoff when a connection is closed right after ready', () => {
    const r = rig()
    connect(r)
    for (let i = 1; i <= 3; i++) {
      r.last().serverClose(CLOSE.tooLarge)
      expect(r.bridge.status()).toMatchObject({ state: 'away', attempt: i })
      r.timers.advance(reconnectDelay(i))
      connect(r)
    }
  })

  it('gives up on a socket that never opens, and retryNow drops a pending connect', () => {
    const r = rig()
    r.timers.advance(READY_TIMEOUT_MS)
    expect(r.last().closedWith).toBeDefined()
    r.last().serverClose(1006)
    expect(r.bridge.status()).toMatchObject({ state: 'away', attempt: 1 })
    r.timers.advance(500)
    expect(r.sockets).toHaveLength(2)
    // Away with a connect pending: Retry now drops it and starts over instead of doing nothing.
    const hung = r.last()
    r.bridge.retryNow()
    expect(r.sockets).toHaveLength(3)
    expect(hung.closedWith).toBeDefined()
    // The dropped socket's late close does not count as the new one ending.
    hung.serverClose(1006)
    expect(r.bridge.status()).toMatchObject({ state: 'away', attempt: 1 })
    connect(r)
    expect(r.bridge.status().state).toBe('ready')
  })

  it('goes to a signed-out state when the session check says so, and keeps retrying when it fails', async () => {
    const answers = [Promise.reject(new Error('net')), Promise.resolve(false)]
    const r = rig(() => answers.shift()!)
    connect(r)
    r.last().serverClose(1006)
    await Promise.resolve()
    await Promise.resolve()
    expect(r.bridge.status().state).toBe('away')
    r.timers.advance(500)
    r.last().serverClose(1006)
    await Promise.resolve()
    await Promise.resolve()
    expect(r.bridge.status()).toMatchObject({ state: 'gone', reason: expect.stringContaining('signed out') })
    r.timers.advance(60_000)
    expect(r.sockets).toHaveLength(2)
  })

  it('caps the backoff', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(reconnectDelay)).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000])
  })

  it('a result from the old socket never answers a call on the new one', async () => {
    const r = rig()
    const s1 = connect(r)
    s1.serverClose(1006)
    r.timers.advance(500)
    const s2 = connect(r)
    const p = r.api.invoke('window.info')
    const id = lastInvokeId(s2)
    s1.serverSend({ t: 'result', id, ok: true, v: 'old' })
    s1.serverSend({ t: 'event', ch: 'tabs.removed', p: 'old' })
    s2.serverSend({ t: 'result', id, ok: true, v: 'new' })
    await expect(p).resolves.toBe('new')
  })

  it('retryNow skips the wait, only while away', () => {
    const r = rig()
    connect(r)
    r.bridge.retryNow()
    expect(r.sockets).toHaveLength(1)
    r.last().serverClose(1006)
    r.bridge.retryNow()
    expect(r.sockets).toHaveLength(2)
    // The cancelled timer does not open another socket later (a pending connect is dropped by a
    // second Retry now, see below; here the next one is the only extra).
    r.timers.advance(60_000)
    expect(r.sockets).toHaveLength(2)
  })

  it('treats a socket that throws on creation as a failed attempt', () => {
    const timers = new FakeTimers()
    let n = 0
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const bridge = createWebBridge({
      url: 'ws://x/ws',
      project: 'p1',
      timers,
      createSocket: (url) => {
        n++
        if (n === 1) throw new Error('blocked')
        return new FakeSocket(url)
      }
    })
    bridges.push(bridge)
    expect(bridge.status()).toMatchObject({ state: 'away', attempt: 1 })
    timers.advance(500)
    expect(n).toBe(2)
    warn.mockRestore()
  })

  it.each([
    [CLOSE.noProject, 'not open'],
    [CLOSE.windowClosed, 'closed'],
    [CLOSE.version, 'Reload'],
    [CLOSE.turnedOff, 'turned off']
  ])('close %i is final: gone, no retry', (code, text) => {
    const r = rig()
    connect(r)
    r.last().serverClose(code)
    const st = r.bridge.status()
    expect(st.state).toBe('gone')
    expect((st as { reason: string }).reason).toContain(text)
    expect(r.timers.pending()).toBe(0)
    r.timers.advance(60_000)
    expect(r.sockets).toHaveLength(1)
  })

  it.each([CLOSE.tooLarge, CLOSE.badFrame, CLOSE.failed, CLOSE.noHello, 1000, 1001, 1006, 1009])(
    'close %i is retried',
    (code) => {
      const r = rig()
      connect(r)
      r.last().serverClose(code)
      expect(r.bridge.status().state).toBe('away')
    }
  )

  it('close() rejects calls, closes the socket and never reconnects', async () => {
    const r = rig()
    const s = connect(r)
    const p = r.api.invoke('window.info')
    r.bridge.close()
    await expect(p).rejects.toThrow(UNREACHABLE)
    expect(s.closedWith).toBeDefined()
    s.serverClose(1000)
    r.timers.advance(60_000)
    expect(r.sockets).toHaveLength(1)
    expect(r.timers.pending()).toBe(0)
  })
})

describe('shape', () => {
  it('every invoke channel the shell may call from a remote view is sendable', () => {
    const r = rig()
    const s = connect(r)
    for (const ch of INVOKE_CHANNELS.filter((c) => remoteAllowed(c)) as InvokeChannel[]) {
      void anyApi(r.api).invoke(ch, {}).catch(() => undefined)
    }
    expect(s.frames().slice(1).every((f) => 't' in f && f.t === 'invoke')).toBe(true)
  })
})
