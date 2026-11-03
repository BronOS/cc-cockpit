// Task 27, host side: ctx.sessions, ctx.badge, ctx.overlay and ctx.panels as a plugin sees them.
// main is a recording fake `call`; a panel's MessagePort is an in-memory port pair (the real ports
// arrive with Task 28).
import { describe, expect, it } from 'vitest'
import { HostContexts, type ContextDeps, type LogLevel } from '../../src/host/ctx'
import type { PanelPort } from '../../src/host/ctx/ui'
import { MAX_OVERLAY_MESSAGE_LENGTH } from '../../src/shared/overlay-message'
import type { PluginContext } from '../../src/sdk/types'
import { hostSpec } from '../fakes/host-spec'
import { memoryPortPair, type MemoryPort } from '../fakes/memory-port'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

interface Call {
  method: string
  params: unknown
  options?: { timeoutMs?: number }
}

function setup(answer: (c: Call) => unknown = () => null): {
  contexts: HostContexts
  ctx: PluginContext
  other: PluginContext
  calls: Call[]
  logs: { pluginId: string; level: LogLevel; text: string }[]
} {
  const calls: Call[] = []
  const logs: { pluginId: string; level: LogLevel; text: string }[] = []
  const deps: ContextDeps = {
    log: (pluginId, level, text) => logs.push({ pluginId, level, text }),
    call: async (method, params, options) => {
      const c: Call = { method, params, ...(options ? { options } : {}) }
      calls.push(c)
      return answer(c)
    }
  }
  const contexts = new HostContexts(deps)
  const ctx = contexts.create(hostSpec({ id: 'a.one', dir: '/p/one', main: 'h.js', panels: ['board', 'side'] }))
  const other = contexts.create(hostSpec({ id: 'a.two', dir: '/p/two', main: 'h.js', panels: ['inbox'] }))
  return { contexts, ctx, other, calls, logs }
}

/** The host's end of a panel port, plus the panel page's end to drive it. */
function panelPort(): { port: PanelPort & { closed: boolean }; page: MemoryPort } {
  const [hostEnd, page] = memoryPortPair()
  const port = {
    closed: false,
    postMessage: (m: string) => hostEnd.postMessage(m),
    onMessage: (l: (m: unknown) => void) => hostEnd.onMessage(l),
    close() {
      port.closed = true
    }
  }
  return { port, page }
}

describe('ctx.sessions', () => {
  it('asks main, naming the plugin, and checks argument types first', async () => {
    const { ctx, calls } = setup((c) => (c.method === 'sessions.open' ? { tabId: 't9' } : []))
    await ctx.sessions.list()
    await ctx.sessions.send('t1', 'hello')
    await expect(ctx.sessions.open({ cwd: 'sub', prompt: 'go' })).resolves.toEqual({ tabId: 't9' })
    expect(calls).toEqual([
      { method: 'sessions.list', params: {} },
      { method: 'sessions.send', params: { pluginId: 'a.one', tabId: 't1', text: 'hello' } },
      { method: 'sessions.open', params: { pluginId: 'a.one', cwd: 'sub', prompt: 'go' } }
    ])
    await expect(ctx.sessions.send('t1', 5 as unknown as string)).rejects.toThrow('needs a tab id and text')
    await expect(ctx.sessions.open({ prompt: ['x'] as unknown as string })).rejects.toThrow('prompt must be a string')
    expect(calls).toHaveLength(3)
  })

  it("delivers main's sessions event to every plugin's listeners, each its own copy", () => {
    const { contexts, ctx, other, logs } = setup()
    const seen: unknown[] = []
    const off = ctx.sessions.onChange((s) => {
      seen.push(s)
      ;(s as unknown[]).length = 0 // a plugin that mutates what it got
    })
    other.sessions.onChange(() => {
      throw new Error('listener bug')
    })
    const seenByOther: unknown[] = []
    other.sessions.onChange((s) => seenByOther.push(s))
    const list = [{ tabId: 't1', status: 'waiting', cwd: '/p', notes: [], files: [] }]
    contexts.handleEvent('sessions', { sessions: list })
    expect(seen).toEqual([[]])
    expect(seenByOther).toEqual([list])
    expect(logs).toContainEqual({ pluginId: 'a.two', level: 'error', text: 'a sessions.onChange listener threw: listener bug' })
    off()
    contexts.handleEvent('sessions', { sessions: list })
    expect(seen).toHaveLength(1)
    expect(seenByOther).toHaveLength(2)
    // A deactivated plugin hears nothing more, and cannot subscribe again.
    contexts.dispose('a.two')
    contexts.handleEvent('sessions', { sessions: list })
    expect(seenByOther).toHaveLength(2)
    expect(() => other.sessions.onChange(() => {})).toThrow('deactivated')
  })
})

describe('ctx.badge', () => {
  it("sends a badge for the plugin's own declared panel only", async () => {
    const { ctx, calls } = setup()
    ctx.badge('board', 3)
    ctx.badge('side', 'dot')
    ctx.badge('board', null)
    expect(() => ctx.badge('inbox', 1)).toThrow('panel "inbox" is not declared')
    expect(() => ctx.badge('a.two/inbox', 1)).toThrow('is not declared')
    expect(() => ctx.badge('board', -1)).toThrow('non-negative number')
    expect(() => ctx.badge('board', 'red' as never)).toThrow('non-negative number')
    await flush()
    expect(calls.map((c) => c.params)).toEqual([
      { pluginId: 'a.one', panelId: 'board', value: 3 },
      { pluginId: 'a.one', panelId: 'side', value: 'dot' },
      { pluginId: 'a.one', panelId: 'board', value: null }
    ])
  })

  it("logs main's refusal instead of throwing (the call is synchronous)", async () => {
    const { ctx, logs } = setup(() => {
      throw new Error('badge: no panel a.one/board in this window')
    })
    ctx.badge('board', 1)
    await flush()
    expect(logs).toContainEqual({ pluginId: 'a.one', level: 'error', text: 'badge board: badge: no panel a.one/board in this window' })
  })
})

describe('ctx.panels.header / onAction', () => {
  it("sends a checked header for the plugin's own declared panel, null clearing it", async () => {
    const { ctx, calls } = setup()
    ctx.panels.header('board', {
      meta: 'synced\n2 min ago',
      actions: [
        { id: 'refresh', icon: 'refresh', title: 'Refresh', busy: true },
        { id: 'star.1', icon: 'icons/star.svg', title: 'Star', disabled: false, extra: 1 } as never
      ]
    })
    ctx.panels.header('side', { meta: '' })
    ctx.panels.header('board', null)
    await flush()
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      [
        'panels.header',
        {
          pluginId: 'a.one',
          panelId: 'board',
          // A control character becomes a space; unknown keys and a false flag are left out.
          header: {
            meta: 'synced 2 min ago',
            actions: [
              { id: 'refresh', icon: 'refresh', title: 'Refresh', busy: true },
              { id: 'star.1', icon: 'icons/star.svg', title: 'Star' }
            ]
          }
        }
      ],
      // An empty header is the bare title, like null.
      ['panels.header', { pluginId: 'a.one', panelId: 'side', header: null }],
      ['panels.header', { pluginId: 'a.one', panelId: 'board', header: null }]
    ])
  })

  it('throws a TypeError naming the limit, before anything reaches main', async () => {
    const { ctx, calls } = setup()
    const action = (over: Record<string, unknown>) => ({ id: 'a', icon: 'refresh', title: 'A', ...over })
    const refused: [unknown, RegExp][] = [
      [{ meta: 'x'.repeat(121) }, /meta is longer than 120/],
      [{ meta: 5 }, /meta must be a string/],
      [{ actions: [action({ id: 'a' }), action({ id: 'b' }), action({ id: 'c' }), action({ id: 'd' })] }, /at most 3 actions/],
      [{ actions: [action({ id: '' })] }, /must be 1 to 40 letters/],
      [{ actions: [action({ id: 'x'.repeat(41) })] }, /must be 1 to 40 letters/],
      [{ actions: [action({ id: 'a b' })] }, /must be 1 to 40 letters/],
      [{ actions: [action({ id: 'a/b' })] }, /must be 1 to 40 letters/],
      [{ actions: [action({}), action({})] }, /"a" is used twice/],
      [{ actions: [action({ title: '' })] }, /title must be a non-empty string/],
      [{ actions: [action({ title: 'x'.repeat(81) })] }, /title is longer than 80/],
      [{ actions: [action({ icon: 'rocket' })] }, /icon must be one of refresh, add/],
      [{ actions: [action({ icon: 'icons/star.png' })] }, /icon must be one of/],
      [{ actions: [action({ icon: '../up.svg' })] }, /must not contain "\.\." segments/],
      [{ actions: [action({ icon: '/abs/star.svg' })] }, /must be relative to the plugin folder/],
      [{ actions: [action({ icon: 'a\\b.svg' })] }, /must use "\/" separators/],
      [{ actions: [action({ busy: 'yes' })] }, /busy must be a boolean/],
      [{ actions: [action({ disabled: 1 })] }, /disabled must be a boolean/],
      [{ actions: {} }, /actions must be an array/],
      [{ actions: ['refresh'] }, /each action must be an object/],
      ['meta', /header must be an object or null/],
      [undefined, /header must be an object or null/]
    ]
    for (const [header, message] of refused) {
      let thrown: unknown
      try {
        ctx.panels.header('board', header as never)
      } catch (err) {
        thrown = err
      }
      expect(thrown, JSON.stringify(header)).toBeInstanceOf(TypeError)
      expect((thrown as Error).message, JSON.stringify(header)).toMatch(message)
      expect((thrown as Error).message).toMatch(/^panels\.header: /)
    }
    // Exactly at the limits is fine.
    ctx.panels.header('board', {
      meta: 'x'.repeat(120),
      actions: [action({ id: 'x'.repeat(40), title: 't'.repeat(80) }), action({ id: 'b' }), action({ id: 'c' })]
    })
    expect(() => ctx.panels.header('inbox', null)).toThrow('panel "inbox" is not declared')
    expect(() => ctx.panels.onAction('inbox', () => {})).toThrow('panel "inbox" is not declared')
    expect(() => ctx.panels.onAction('board', 'x' as never)).toThrow('needs a function')
    await flush()
    expect(calls).toHaveLength(1)
  })

  it("delivers main's panel.action to that panel's listeners only, a throwing one logged", () => {
    const { contexts, ctx, other, logs } = setup()
    const heard: string[] = []
    const off = ctx.panels.onAction('board', (id) => heard.push(`board:${id}`))
    ctx.panels.onAction('side', (id) => heard.push(`side:${id}`))
    ctx.panels.onAction('board', () => {
      throw new Error('listener bug')
    })
    const heardByOther: string[] = []
    other.panels.onAction('inbox', (id) => heardByOther.push(id))
    contexts.handleEvent('panel.action', { pluginId: 'a.one', panelId: 'board', actionId: 'refresh' })
    expect(heard).toEqual(['board:refresh'])
    expect(logs).toContainEqual({ pluginId: 'a.one', level: 'error', text: 'a panels.onAction listener threw: listener bug' })
    contexts.handleEvent('panel.action', { pluginId: 'a.one', panelId: 'board', actionId: 7 })
    contexts.handleEvent('panel.action', { pluginId: 'nobody', panelId: 'board', actionId: 'x' })
    off()
    contexts.handleEvent('panel.action', { pluginId: 'a.one', panelId: 'board', actionId: 'again' })
    contexts.handleEvent('panel.action', { pluginId: 'a.one', panelId: 'side', actionId: 'go' })
    expect(heard).toEqual(['board:refresh', 'side:go'])
    expect(heardByOther).toEqual([])
    // Disposed: its listeners went with it.
    contexts.dispose('a.one')
    contexts.handleEvent('panel.action', { pluginId: 'a.one', panelId: 'side', actionId: 'late' })
    expect(heard).toEqual(['board:refresh', 'side:go'])
    expect(() => ctx.panels.header('board', null)).toThrow('deactivated')
  })

  it('disposing a plugin that set a header tells main (plugin.disposed), so main clears it', () => {
    const emitted: { event: string; params: unknown }[] = []
    const contexts = new HostContexts({ log: () => {}, call: async () => null, emit: (event, params) => emitted.push({ event, params }) })
    const one = contexts.create(hostSpec({ id: 'a.one', dir: '/p/one', main: 'h.js', panels: ['board'] }))
    const two = contexts.create(hostSpec({ id: 'a.two', dir: '/p/two', main: 'h.js', panels: ['inbox'] }))
    one.panels.header('board', { meta: 'hi' })
    // Only listening is nothing for main to clear.
    two.panels.onAction('inbox', () => {})
    contexts.dispose('a.two')
    expect(emitted).toEqual([])
    contexts.dispose('a.one')
    expect(emitted).toEqual([{ event: 'plugin.disposed', params: { pluginId: 'a.one' } }])
  })

  it("logs main's refusal instead of throwing", async () => {
    const { ctx, logs } = setup(() => {
      throw new Error('panels.header: no panel a.one/board in this window')
    })
    ctx.panels.header('board', { meta: 'x' })
    await flush()
    expect(logs).toContainEqual({
      pluginId: 'a.one',
      level: 'error',
      text: 'panels.header board: panels.header: no panel a.one/board in this window'
    })
  })
})

describe('ctx.overlay', () => {
  it('asks main with no timeout and returns its result', async () => {
    const { ctx, calls } = setup(() => ({ kind: 'value', value: 42 }))
    await expect(ctx.overlay.open({ kind: 'html', file: 'pick.html' })).resolves.toEqual({ kind: 'value', value: 42 })
    expect(calls).toEqual([
      {
        method: 'overlay.open',
        params: { pluginId: 'a.one', spec: { kind: 'html', file: 'pick.html' }, handle: expect.any(String) },
        options: { timeoutMs: Infinity }
      }
    ])
    await expect(ctx.overlay.open(null as never)).rejects.toThrow('needs a spec object')
  })
})

describe('ctx.overlay.start', () => {
  /** main's overlay.open stays pending until `end` is called; every other call answers true. */
  function pending(): ReturnType<typeof setup> & { end: (result: unknown) => void } {
    let end!: (result: unknown) => void
    const opened = new Promise((resolve) => {
      end = resolve
    })
    return { ...setup((c) => (c.method === 'overlay.open' ? opened : true)), end }
  }
  const handleOf = (calls: Call[]): string => (calls[0]?.params as { handle: string }).handle

  it('opens with a handle; posts go out behind the open, page messages reach onMessage, result resolves', async () => {
    const { contexts, ctx, calls, end } = pending()
    const overlay = ctx.overlay.start({ kind: 'html', file: 'chat.html' })
    // Posted before main even created the overlay: sent right behind the open request (main queues it).
    overlay.post({ hello: 1 })
    const handle = handleOf(calls)
    expect(handle).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls.map((c) => c.method)).toEqual(['overlay.open', 'overlay.post'])
    expect(calls[1]?.params).toEqual({ pluginId: 'a.one', handle, message: { hello: 1 } })

    const heard: unknown[] = []
    const off = overlay.onMessage((m) => heard.push(m))
    contexts.handleEvent('overlay.message', { pluginId: 'a.one', handle, message: { n: 1 } })
    // Another plugin's id with the same handle names nothing; nor does an unknown handle.
    contexts.handleEvent('overlay.message', { pluginId: 'a.two', handle, message: { n: 'x' } })
    contexts.handleEvent('overlay.message', { pluginId: 'a.one', handle: 'nope', message: { n: 'y' } })
    expect(heard).toEqual([{ n: 1 }])
    off()
    contexts.handleEvent('overlay.message', { pluginId: 'a.one', handle, message: { n: 2 } })
    expect(heard).toEqual([{ n: 1 }])

    overlay.onMessage((m) => heard.push(m))
    end({ kind: 'value', value: { done: true } })
    await expect(overlay.result).resolves.toEqual({ kind: 'value', value: { done: true } })

    // Ended: post, close and focus are no-ops (nothing sent), listeners are gone, onMessage is inert.
    const before = calls.length
    overlay.post({ late: true })
    overlay.close()
    overlay.focus()
    expect(calls.length).toBe(before)
    contexts.handleEvent('overlay.message', { pluginId: 'a.one', handle, message: { n: 3 } })
    expect(heard).toEqual([{ n: 1 }])
    expect(typeof overlay.onMessage(() => {})).toBe('function')
  })

  it('close asks main to dismiss it, for any kind; post and onMessage are for html only', async () => {
    const { ctx, calls, end } = pending()
    const term = ctx.overlay.start({ kind: 'terminal', argv: ['lazygit'] })
    expect(() => term.post({ a: 1 })).toThrow(TypeError)
    expect(() => term.onMessage(() => {})).toThrow('only an html overlay')
    term.close()
    expect(calls[1]).toMatchObject({ method: 'overlay.close', params: { pluginId: 'a.one', handle: handleOf(calls) } })
    end({ kind: 'dismissed' })
    await expect(term.result).resolves.toEqual({ kind: 'dismissed' })
  })

  it('focus asks main to bring it to the front, for any kind', async () => {
    const { ctx, calls, end } = pending()
    const term = ctx.overlay.start({ kind: 'terminal', argv: ['micro', 'a.ts'] })
    term.focus()
    expect(calls[1]).toEqual({ method: 'overlay.focus', params: { pluginId: 'a.one', handle: handleOf(calls) } })
    end({ kind: 'dismissed' })
    await expect(term.result).resolves.toEqual({ kind: 'dismissed' })
    term.focus()
    expect(calls).toHaveLength(2)
    // A refused open leaves nothing to focus.
    const bad = ctx.overlay.start(null as never)
    await expect(bad.result).rejects.toThrow('needs a spec object')
    bad.focus()
    expect(calls).toHaveLength(2)
  })

  it("disposing a plugin with an overlay open or opening tells main (plugin.disposed); one without does not", () => {
    const emitted: { event: string; params: unknown }[] = []
    const contexts = new HostContexts({
      log: () => {},
      call: () => new Promise(() => {}),
      emit: (event, params) => emitted.push({ event, params })
    })
    const one = contexts.create(hostSpec({ id: 'a.one', dir: '/p/one', main: 'h.js' }))
    contexts.create(hostSpec({ id: 'a.two', dir: '/p/two', main: 'h.js' }))
    void one.overlay.open({ kind: 'terminal', argv: ['tig'] })
    contexts.dispose('a.two')
    expect(emitted).toEqual([])
    contexts.dispose('a.one')
    expect(emitted).toEqual([{ event: 'plugin.disposed', params: { pluginId: 'a.one' } }])
  })

  it('refuses a message over the limit or not JSON, naming the limit', () => {
    const { ctx, calls } = pending()
    const overlay = ctx.overlay.start({ kind: 'html', file: 'chat.html' })
    expect(() => overlay.post('x'.repeat(MAX_OVERLAY_MESSAGE_LENGTH))).toThrow(
      new RangeError(`overlay post: message of ${MAX_OVERLAY_MESSAGE_LENGTH + 2} chars exceeds ${MAX_OVERLAY_MESSAGE_LENGTH}`)
    )
    expect(() => overlay.post(10n as never)).toThrow(TypeError)
    // The largest that fits goes out.
    overlay.post('x'.repeat(MAX_OVERLAY_MESSAGE_LENGTH - 2))
    expect(calls.map((c) => c.method)).toEqual(['overlay.open', 'overlay.post'])
  })

  it('a refused open rejects result and leaves an inert handle', async () => {
    const { ctx, calls } = setup((c) => {
      if (c.method === 'overlay.open') throw new Error('overlay: a.one already has 3 overlays open')
      return true
    })
    const overlay = ctx.overlay.start({ kind: 'html', file: 'chat.html' })
    await expect(overlay.result).rejects.toThrow('already has 3 overlays open')
    overlay.post({ a: 1 })
    expect(calls.map((c) => c.method)).toEqual(['overlay.open'])
    const bad = ctx.overlay.start(null as never)
    await expect(bad.result).rejects.toThrow('needs a spec object')
  })

  it('a disposed plugin drops its handles: page messages no longer reach its listeners', async () => {
    const { contexts, ctx, calls } = pending()
    const overlay = ctx.overlay.start({ kind: 'html', file: 'chat.html' })
    const heard: unknown[] = []
    overlay.onMessage((m) => heard.push(m))
    contexts.dispose('a.one')
    contexts.handleEvent('overlay.message', { pluginId: 'a.one', handle: handleOf(calls), message: 1 })
    expect(heard).toEqual([])
    overlay.post({ a: 1 })
    expect(calls.map((c) => c.method)).toEqual(['overlay.open'])
  })
})

describe('ctx.panels', () => {
  it('posts JSON to the panel once it has a port, and hears what the panel posts', async () => {
    const { contexts, ctx, logs } = setup()
    // Not shown yet: dropped, no throw.
    ctx.panels.post('board', { early: true })
    const { port, page } = panelPort()
    expect(contexts.attachPanelPort('a.one', 'board', port)).toBe(true)
    ctx.panels.post('board', { items: [1, 2] })
    expect(page.sent).toEqual([])
    const received: unknown[] = []
    page.onMessage((m) => received.push(m))
    await flush()
    expect(received).toEqual(['{"items":[1,2]}'])

    const heard: unknown[] = []
    ctx.panels.onMessage('board', (m) => heard.push(m))
    page.postMessage(JSON.stringify({ click: 'row-1' }))
    page.postMessage('not json')
    page.postMessage({ not: 'a string' } as never)
    await flush()
    expect(heard).toEqual([{ click: 'row-1' }])
    expect(logs.filter((l) => l.text.startsWith('dropped a message from panel a.one/board'))).toHaveLength(2)
  })

  it('refuses panels the plugin does not declare and non-JSON messages', () => {
    const { contexts, ctx } = setup()
    expect(() => ctx.panels.post('inbox', 1)).toThrow('is not declared')
    expect(() => ctx.panels.onMessage('inbox', () => {})).toThrow('is not declared')
    expect(() => ctx.panels.post('board', (() => 1) as never)).toThrow('not JSON')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => ctx.panels.post('board', cyclic as never)).toThrow('not JSON')
    expect(() => ctx.panels.post('board', 'x'.repeat(1024 * 1024 + 1))).toThrow('exceeds')
    // A port for another plugin's panel, or for a plugin that does not run here, is closed at once.
    const stray = panelPort()
    expect(contexts.attachPanelPort('a.one', 'inbox', stray.port)).toBe(false)
    expect(stray.port.closed).toBe(true)
    const unknown = panelPort()
    expect(contexts.attachPanelPort('x.y', 'board', unknown.port)).toBe(false)
    expect(unknown.port.closed).toBe(true)
  })

  it('a reloaded panel gets a new port: the old one is closed and hears nothing more', async () => {
    const { contexts, ctx } = setup()
    const heard: unknown[] = []
    ctx.panels.onMessage('board', (m) => heard.push(m))
    const first = panelPort()
    contexts.attachPanelPort('a.one', 'board', first.port)
    const second = panelPort()
    contexts.attachPanelPort('a.one', 'board', second.port)
    expect(first.port.closed).toBe(true)
    first.page.postMessage('"from the old page"')
    second.page.postMessage('"from the new page"')
    await flush()
    // Listeners survive the reload.
    expect(heard).toEqual(['from the new page'])
    contexts.detachPanelPort('a.one', 'board')
    expect(second.port.closed).toBe(true)
  })

  it('closes the ports and drops the listeners of a deactivated plugin', async () => {
    const { contexts, ctx } = setup()
    const heard: unknown[] = []
    ctx.panels.onMessage('board', (m) => heard.push(m))
    const { port, page } = panelPort()
    contexts.attachPanelPort('a.one', 'board', port)
    contexts.dispose('a.one')
    expect(port.closed).toBe(true)
    page.postMessage('"late"')
    await flush()
    expect(heard).toEqual([])
    expect(() => ctx.panels.post('board', 1)).toThrow('deactivated')
    expect(() => ctx.badge('board', 1)).toThrow('deactivated')
    await expect(ctx.overlay.open({ kind: 'url', url: 'https://x' })).rejects.toThrow('deactivated')
    await expect(ctx.sessions.list()).rejects.toThrow('deactivated')
  })
})
