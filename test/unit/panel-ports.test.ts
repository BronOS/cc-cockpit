// Task 28: panel MessagePorts. main's hub (one channel per panel page, the host's end tagged from
// main's own records, the window's end with the renderer's nonce, a reload on host restart) and the
// host's side (a MessagePortMain adapted to ctx.panels, a reloaded page's port replacing the old
// one). Ports are in-memory fakes with MessagePortMain's start/close behaviour; no Electron.
import { describe, expect, it } from 'vitest'
import { HostContexts } from '../../src/host/ctx'
import { fromMainPort, panelPortTag, type MainPortLike, type PanelPort } from '../../src/host/ctx/ui'
import { CONNECT_WINDOW_MS, MAX_CONNECTS_PER_PANEL, PanelPortHub, type PanelPortDeps } from '../../src/main/plugins/panel-ports'
import { hostSpec } from '../fakes/host-spec'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** One end of an entangled pair, like MessagePortMain: queues until start(), tells the peer on close. */
class FakePort implements MainPortLike {
  peer: FakePort | undefined
  started = false
  closed = false
  readonly name: string
  private readonly queued: unknown[] = []
  private readonly messageListeners = new Set<(e: { data: unknown }) => void>()
  private readonly closeListeners = new Set<() => void>()

  constructor(name: string) {
    this.name = name
  }

  postMessage(message: unknown): void {
    if (this.closed) return
    this.peer?.arrive(message)
  }

  on(event: 'message' | 'close', listener: ((e: { data: unknown }) => void) | (() => void)): this {
    if (event === 'message') this.messageListeners.add(listener as (e: { data: unknown }) => void)
    else this.closeListeners.add(listener as () => void)
    return this
  }

  off(_event: 'message', listener: (e: { data: unknown }) => void): this {
    this.messageListeners.delete(listener)
    return this
  }

  start(): void {
    this.started = true
    for (const m of this.queued.splice(0)) this.dispatch(m)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const peer = this.peer
    if (peer && !peer.closed) {
      peer.closed = true
      for (const l of [...peer.closeListeners]) l()
    }
  }

  private arrive(message: unknown): void {
    if (this.closed) return
    if (this.started) this.dispatch(message)
    else this.queued.push(message)
  }

  private dispatch(message: unknown): void {
    queueMicrotask(() => {
      for (const l of [...this.messageListeners]) l({ data: message })
    })
  }
}

function channel(n: number): { host: FakePort; renderer: FakePort } {
  const host = new FakePort(`host${n}`)
  const renderer = new FakePort(`renderer${n}`)
  host.peer = renderer
  renderer.peer = host
  return { host, renderer }
}

interface Sent {
  host: { projectId: string; pluginId: string; panelId: string; port: FakePort }[]
  renderer: { windowId: number; payload: { panelKey: string; nonce: number }; port: FakePort }[]
  reloads: { projectId: string; pluginIds: string[] }[]
  channels: { host: FakePort; renderer: FakePort }[]
}

/** Project p1 (window 1) runs a.one with panels board and side; a.two declares inbox but is not running. */
function hub(overrides: Partial<PanelPortDeps<FakePort>> = {}): { hub: PanelPortHub<FakePort>; sent: Sent } {
  const sent: Sent = { host: [], renderer: [], reloads: [], channels: [] }
  const running: Record<string, Record<string, readonly string[]>> = { p1: { 'a.one': ['board', 'side'] } }
  const deps: PanelPortDeps<FakePort> = {
    createChannel: () => {
      const ch = channel(sent.channels.length + 1)
      sent.channels.push(ch)
      return ch
    },
    runningPanels: (projectId, pluginId) => running[projectId]?.[pluginId],
    toHost: (projectId, pluginId, panelId, port) => {
      sent.host.push({ projectId, pluginId, panelId, port })
      return true
    },
    toRenderer: (windowId, payload, port) => void sent.renderer.push({ windowId, payload, port }),
    reload: (projectId, pluginIds) => void sent.reloads.push({ projectId, pluginIds }),
    close: (port) => port.close(),
    log: () => {},
    ...overrides
  }
  return { hub: new PanelPortHub(deps), sent }
}

describe('PanelPortHub', () => {
  it("hands the host one end tagged from main's records and the asking window the other", () => {
    const { hub: h, sent } = hub()
    expect(h.connect('p1', 1, 'a.one/board', 7)).toBe(true)
    expect(sent.channels).toHaveLength(1)
    const ch = sent.channels[0]!
    expect(sent.host).toEqual([{ projectId: 'p1', pluginId: 'a.one', panelId: 'board', port: ch.host }])
    expect(sent.renderer).toEqual([{ windowId: 1, payload: { panelKey: 'a.one/board', nonce: 7 }, port: ch.renderer }])
    expect(ch.host.closed || ch.renderer.closed).toBe(false)
  })

  it("refuses anything but a declared panel of a plugin running in the asker's own project", () => {
    const { hub: h, sent } = hub()
    const refused: [string, number, unknown, unknown][] = [
      // Another project (p2 runs nothing; a.one runs in p1 only): the ids alone open nothing.
      ['p2', 2, 'a.one/board', 1],
      // A plugin that is not running (no host code, starting, failed, disabled, given up).
      ['p1', 1, 'a.two/inbox', 1],
      // A panel the running plugin does not declare, and core panels.
      ['p1', 1, 'a.one/other', 1],
      ['p1', 1, 'core/sessions', 1],
      // Malformed keys and nonces.
      ['p1', 1, 'a.one', 1],
      ['p1', 1, '/board', 1],
      ['p1', 1, `a.one/${'x'.repeat(300)}`, 1],
      ['p1', 1, 42, 1],
      ['p1', 1, 'a.one/board', '7'],
      ['p1', 1, 'a.one/board', 1.5]
    ]
    for (const [projectId, windowId, key, nonce] of refused) {
      expect(h.connect(projectId, windowId, key, nonce), String(key)).toBe(false)
    }
    // Nothing was made: no channel, nothing sent anywhere.
    expect(sent.channels).toEqual([])
    expect(sent.host).toEqual([])
    expect(sent.renderer).toEqual([])
  })

  it('closes both ends when the host cannot take its end (it went in between)', () => {
    const { hub: h, sent } = hub({ toHost: () => false })
    expect(h.connect('p1', 1, 'a.one/board', 1)).toBe(false)
    expect(sent.channels[0]!.host.closed).toBe(true)
    expect(sent.channels[0]!.renderer.closed).toBe(true)
    expect(sent.renderer).toEqual([])

    const throwing = hub({
      toHost: () => {
        throw new Error('plugin host has exited')
      }
    })
    expect(throwing.hub.connect('p1', 1, 'a.one/board', 1)).toBe(false)
    expect(throwing.sent.channels[0]!.renderer.closed).toBe(true)
  })

  it('gives every load of a page a new channel', () => {
    const { hub: h, sent } = hub()
    expect(h.connect('p1', 1, 'a.one/board', 1)).toBe(true)
    expect(h.connect('p1', 1, 'a.one/board', 2)).toBe(true)
    expect(sent.channels).toHaveLength(2)
    expect(sent.channels[0]!.host).not.toBe(sent.channels[1]!.host)
    expect(sent.renderer.map((r) => r.payload.nonce)).toEqual([1, 2])
  })

  it('caps connects per panel of a window: a page reloading itself in a loop costs main nothing more', () => {
    let now = 1_000
    const logs: string[] = []
    const { hub: h, sent } = hub({ now: () => now, log: (m) => logs.push(m) })
    for (let i = 0; i < MAX_CONNECTS_PER_PANEL; i++) expect(h.connect('p1', 1, 'a.one/board', i)).toBe(true)
    // Over the cap: refused before any channel is made, and logged once for the burst.
    expect(h.connect('p1', 1, 'a.one/board', 98)).toBe(false)
    expect(h.connect('p1', 1, 'a.one/board', 99)).toBe(false)
    expect(sent.channels).toHaveLength(MAX_CONNECTS_PER_PANEL)
    expect(logs.filter((l) => l.includes('connects in'))).toHaveLength(1)
    // Another panel, and the same panel in another window, have their own budget.
    expect(h.connect('p1', 1, 'a.one/side', 1)).toBe(true)
    expect(h.connect('p1', 2, 'a.one/board', 1)).toBe(true)
    // Once the window has passed, the page connects again.
    now += CONNECT_WINDOW_MS
    expect(h.connect('p1', 1, 'a.one/board', 100)).toBe(true)
  })

  it("tells the window to reload a restarted host's panels", () => {
    const { hub: h, sent } = hub()
    h.hostReady('p1', ['a.one', 'a.two'])
    h.hostReady('p1', [])
    expect(sent.reloads).toEqual([{ projectId: 'p1', pluginIds: ['a.one', 'a.two'] }])
  })
})

describe('the host side of a panel port', () => {
  /** What host/index.ts does with a port message from main. */
  function receive(contexts: HostContexts, message: string, raw: FakePort): PanelPort | undefined {
    const tag = panelPortTag(message)
    if (!tag) {
      raw.close()
      return undefined
    }
    const port: PanelPort = fromMainPort(raw, () => contexts.detachPanelPort(tag.pluginId, tag.panelId, port))
    contexts.attachPanelPort(tag.pluginId, tag.panelId, port)
    return port
  }

  function host(): { contexts: HostContexts; heard: unknown[]; post: (m: unknown) => void } {
    const contexts = new HostContexts({ log: () => {} })
    const ctx = contexts.create(hostSpec({ id: 'a.one', dir: '/p/one', main: 'h.js', panels: ['board'] }))
    const heard: unknown[] = []
    ctx.panels.onMessage('board', (m) => heard.push(m))
    return { contexts, heard, post: (m) => ctx.panels.post('board', m as never) }
  }

  const tag = JSON.stringify({ panelPort: { pluginId: 'a.one', panelId: 'board' } })

  it('starts the port once it is listened to; messages flow both ways as JSON strings', async () => {
    const { contexts, heard, post } = host()
    const ch = channel(1)
    // The page posted before the host had even attached its end: the port queues it.
    ch.renderer.postMessage(JSON.stringify({ ping: 1 }))
    receive(contexts, tag, ch.host)
    expect(ch.host.started).toBe(true)
    await flush()
    expect(heard).toEqual([{ ping: 1 }])

    const toPage: unknown[] = []
    ch.renderer.on('message', (e: { data: unknown }) => toPage.push(e.data))
    ch.renderer.start()
    post({ pong: 2 })
    await flush()
    expect(toPage).toEqual([JSON.stringify({ pong: 2 })])
  })

  it("a reloaded page's port replaces the old one; the old one's late close leaves the new one alone", async () => {
    const { contexts, heard, post } = host()
    const first = channel(1)
    receive(contexts, tag, first.host)
    const second = channel(2)
    receive(contexts, tag, second.host)
    // Attaching the new port closed the old one (and the old page hears nothing more).
    expect(first.host.closed).toBe(true)
    first.renderer.postMessage('"old"')
    second.renderer.postMessage('"new"')
    await flush()
    expect(heard).toEqual(['new'])

    const toNew: unknown[] = []
    second.renderer.on('message', (e: { data: unknown }) => toNew.push(e.data))
    second.renderer.start()
    post('still connected')
    await flush()
    expect(toNew).toEqual(['"still connected"'])

    // The new page goes (iframe removed, window closed): the host stops counting it as connected.
    second.renderer.close()
    expect(second.host.closed).toBe(true)
    post('dropped')
    await flush()
    expect(toNew).toEqual(['"still connected"'])
  })

  it('closes a port for a plugin or panel this host does not run, and one main did not tag', () => {
    const { contexts } = host()
    const undeclared = channel(1)
    receive(contexts, JSON.stringify({ panelPort: { pluginId: 'a.one', panelId: 'nope' } }), undeclared.host)
    expect(undeclared.host.closed).toBe(true)
    const otherPlugin = channel(2)
    receive(contexts, JSON.stringify({ panelPort: { pluginId: 'a.two', panelId: 'board' } }), otherPlugin.host)
    expect(otherPlugin.host.closed).toBe(true)
    const untagged = channel(3)
    receive(contexts, '{"id":1,"method":"x"}', untagged.host)
    expect(untagged.host.closed).toBe(true)
  })

  it('panelPortTag reads main\'s tag and nothing else', () => {
    expect(panelPortTag(tag)).toEqual({ pluginId: 'a.one', panelId: 'board' })
    expect(panelPortTag({ panelPort: { pluginId: 'a.one', panelId: 'board' } })).toBeUndefined()
    expect(panelPortTag('{"panelPort":{"pluginId":1,"panelId":"board"}}')).toBeUndefined()
    expect(panelPortTag('{"panelPort":null}')).toBeUndefined()
    expect(panelPortTag('null')).toBeUndefined()
    expect(panelPortTag('not json')).toBeUndefined()
    expect(panelPortTag(`{"panelPort":{"pluginId":"${'a'.repeat(2000)}","panelId":"b"}}`)).toBeUndefined()
  })
})

describe('PanelPortHub slot frames (design-next §2)', () => {
  type Open = { pluginId: string; id: string; type: string; host: unknown; params?: unknown }
  const frame = {
    info: { id: 's1', type: 'agenda', pluginId: 'a.cal', src: 'cc-plugin://a.cal/agenda.html', position: 'top' as const, height: 100, minHeight: 48 },
    host: { kind: 'panel' as const, pluginId: 'a.inbox', panelId: 'main' },
    params: { day: 'today' }
  }
  function slotHub(running = true): { hub: PanelPortHub<FakePort>; sent: Sent; opened: { projectId: string; open: Open; port: FakePort }[]; closed: string[] } {
    const opened: { projectId: string; open: Open; port: FakePort }[] = []
    const closed: string[] = []
    const made = hub({
      slotFrame: (projectId, frameId) => (projectId === 'p1' && frameId === 's1' ? frame : undefined),
      slotToHost: (projectId, open, port) => {
        if (!running) return false
        opened.push({ projectId, open, port })
        return true
      },
      slotClosed: (projectId, pluginId, frameId) => void closed.push(`${projectId}:${pluginId}:${frameId}`)
    })
    return { ...made, opened, closed }
  }

  it("hands the provider's host its end with main's record, the window its end under @slot/<id>", () => {
    const { hub: h, sent, opened } = slotHub()
    expect(h.connectSlot('p1', 1, 's1', 5)).toBe(true)
    const ch = sent.channels[0]!
    // The provider gets the port, the host panel's place and the params; never the host panel's host.
    expect(opened).toEqual([
      { projectId: 'p1', open: { pluginId: 'a.cal', id: 's1', type: 'agenda', host: frame.host, params: { day: 'today' } }, port: ch.host }
    ])
    expect(sent.host).toEqual([])
    expect(sent.renderer).toEqual([{ windowId: 1, payload: { panelKey: '@slot/s1', nonce: 5 }, port: ch.renderer }])
  })

  it('refuses a frame the project does not draw, junk ids and nonces, and a provider that is not running', () => {
    const { hub: h, sent } = slotHub()
    for (const [projectId, id, nonce] of [
      ['p2', 's1', 1],
      ['p1', 's2', 1],
      ['p1', 'a.cal/agenda', 1],
      ['p1', 7, 1],
      ['p1', 's1', '1']
    ] as const) {
      expect(h.connectSlot(projectId, 1, id, nonce), String(id)).toBe(false)
    }
    expect(sent.channels).toEqual([])
    const stopped = slotHub(false)
    expect(stopped.hub.connectSlot('p1', 1, 's1', 1)).toBe(false)
    expect(stopped.sent.channels[0]!.host.closed && stopped.sent.channels[0]!.renderer.closed).toBe(true)
    expect(stopped.sent.renderer).toEqual([])
  })

  it('closes a frame once: on unmount, when the layout drops it, and before it opens again', () => {
    const { hub: h, closed } = slotHub()
    h.connectSlot('p1', 1, 's1', 1)
    h.disconnectSlot('p1', 's1')
    h.disconnectSlot('p1', 's1')
    expect(closed).toEqual(['p1:a.cal:s1'])
    // Its page reloaded: the old instance closes before the new one opens.
    h.connectSlot('p1', 1, 's1', 2)
    h.connectSlot('p1', 1, 's1', 3)
    expect(closed).toEqual(['p1:a.cal:s1', 'p1:a.cal:s1'])
    // Still drawn: nothing. Gone from the layout (another project's change touches nothing): closed.
    h.slotFramesChanged('p1', new Set(['s1']))
    h.slotFramesChanged('p2', new Set())
    expect(closed).toHaveLength(2)
    h.slotFramesChanged('p1', new Set())
    expect(closed).toHaveLength(3)
    h.disconnectSlot('p1', 's1')
    expect(closed).toHaveLength(3)
  })
})

describe('PanelPortHub settings pages (design-next §5.4)', () => {
  type Open = { pluginId: string; id: string; scope: 'app' | 'project' }
  /** p1 (window 1) runs a.one with a page for both scopes and a.app with an app-only page; p2 runs nothing. */
  function pageHub(running = true): { hub: PanelPortHub<FakePort>; sent: Sent; opened: { projectId: string; open: Open; port: FakePort }[]; closed: string[] } {
    const opened: { projectId: string; open: Open; port: FakePort }[] = []
    const closed: string[] = []
    const scopes: Record<string, Record<string, readonly ('app' | 'project')[]>> = { p1: { 'a.one': ['app', 'project'], 'a.app': ['app'] } }
    const made = hub({
      settingsPageScopes: (projectId, pluginId) => scopes[projectId]?.[pluginId],
      settingsPageToHost: (projectId, open, port) => {
        if (!running) return false
        opened.push({ projectId, open, port })
        return true
      },
      settingsPageClosed: (projectId, pluginId, id) => void closed.push(`${projectId}:${pluginId}:${id}`)
    })
    return { ...made, opened, closed }
  }

  it("hands that plugin's backend in the sender's own host its end, the window its end under @settings/<id>", () => {
    const { hub: h, sent, opened } = pageHub()
    expect(h.connectSettingsPage('p1', 1, 'a.one', 'project', 4)).toBe(true)
    const ch = sent.channels[0]!
    expect(opened).toEqual([{ projectId: 'p1', open: { pluginId: 'a.one', id: 'p1', scope: 'project' }, port: ch.host }])
    expect(sent.host).toEqual([])
    expect(sent.renderer).toEqual([{ windowId: 1, payload: { panelKey: '@settings/a.one', nonce: 4 }, port: ch.renderer }])
  })

  it('refuses a plugin not running in the asking project, an undeclared scope, junk ids, scopes and nonces', () => {
    const { hub: h, sent } = pageHub()
    for (const [projectId, pluginId, scope, nonce] of [
      // Another project's window asks for a.one: its host is not p1's.
      ['p2', 'a.one', 'app', 1],
      ['p1', 'a.two', 'app', 1],
      ['p1', 'a.app', 'project', 1],
      ['p1', 'a.one', 'global', 1],
      ['p1', 'A One', 'app', 1],
      ['p1', 7, 'app', 1],
      ['p1', 'a.one', 'app', '1'],
      ['p1', 'a.one', 'app', 1.5]
    ] as const) {
      expect(h.connectSettingsPage(projectId, 1, pluginId, scope, nonce), `${String(pluginId)} ${String(scope)}`).toBe(false)
    }
    expect(sent.channels).toEqual([])
    const stopped = pageHub(false)
    expect(stopped.hub.connectSettingsPage('p1', 1, 'a.one', 'app', 1)).toBe(false)
    expect(stopped.sent.channels[0]!.host.closed && stopped.sent.channels[0]!.renderer.closed).toBe(true)
    expect(stopped.sent.renderer).toEqual([])
  })

  it('keeps one page per plugin: a new connect closes the older one first; unmount closes it once', () => {
    const { hub: h, opened, closed } = pageHub()
    h.connectSettingsPage('p1', 1, 'a.one', 'app', 1)
    h.connectSettingsPage('p1', 1, 'a.app', 'app', 2)
    // The other scope of the same plugin is still the same plugin's page.
    h.connectSettingsPage('p1', 1, 'a.one', 'project', 3)
    expect(opened.map((o) => o.open.id)).toEqual(['p1', 'p2', 'p3'])
    expect(closed).toEqual(['p1:a.one:p1'])
    h.disconnectSettingsPage('p1', 'a.one')
    h.disconnectSettingsPage('p1', 'a.one')
    h.disconnectSettingsPage('p2', 'a.app')
    expect(closed).toEqual(['p1:a.one:p1', 'p1:a.one:p3'])
    h.disconnectSettingsPage('p1', 'a.app')
    expect(closed).toEqual(['p1:a.one:p1', 'p1:a.one:p3', 'p1:a.app:p2'])
  })

  it('caps connects per page of a window like a panel', () => {
    const { hub: h } = pageHub()
    for (let i = 0; i < MAX_CONNECTS_PER_PANEL; i++) expect(h.connectSettingsPage('p1', 1, 'a.one', 'app', i)).toBe(true)
    expect(h.connectSettingsPage('p1', 1, 'a.one', 'app', 99)).toBe(false)
  })
})
