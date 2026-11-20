// Task 27, host side: ctx.sessions, ctx.badge, ctx.overlay and ctx.panels as a plugin sees them.
// main is a recording fake `call`; a panel's MessagePort is an in-memory port pair (the real ports
// arrive with Task 28).
import { describe, expect, it } from 'vitest'
import { HostContexts, type ContextDeps, type LogLevel } from '../../src/host/ctx'
import { carryView, currentView } from '../../src/host/ctx/origin-view'
import type { PanelPort } from '../../src/host/ctx/ui'
import { MAX_OVERLAY_MESSAGE_LENGTH } from '../../src/shared/overlay-message'
import { ServiceRegistry } from '../../src/host/services'
import { MAX_OVERLAY_SOURCES } from '../../src/shared/overlay-buttons'
import type { OverlayHandle, OverlaySpec, PluginContext } from '../../src/sdk/types'
import type { ViewId } from '../../src/shared/views'
import { hostSpec } from '../fakes/host-spec'
import { memoryPortPair, type MemoryPort } from '../fakes/memory-port'

/** main's `from` for the desktop page (the owner's, `view` absent on the wire; docs/design-overlay-views.md §3). */
const OWNER = { access: 'owner' } as const

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
      { method: 'sessions.list', params: { pluginId: 'a.one', scope: 'window' } },
      { method: 'sessions.send', params: { pluginId: 'a.one', tabId: 't1', text: 'hello' } },
      { method: 'sessions.open', params: { pluginId: 'a.one', cwd: 'sub', prompt: 'go' } }
    ])
    await expect(ctx.sessions.send('t1', 5 as unknown as string)).rejects.toThrow('needs a tab id and text')
    await expect(ctx.sessions.open({ prompt: ['x'] as unknown as string })).rejects.toThrow('prompt must be a string')
    await expect(ctx.sessions.open({ focus: 1 as unknown as boolean })).rejects.toThrow('focus must be a boolean')
    await expect(ctx.sessions.open({ model: 'gpt' })).rejects.toThrow('sessions.open: model must be one of')
    await expect(ctx.sessions.open({ model: 5 as unknown as string })).rejects.toThrow('model must be one of')
    await expect(ctx.sessions.open({ effort: 'extreme' })).rejects.toThrow('sessions.open: effort must be one of')
    await expect(ctx.sessions.open({ effort: 1 as unknown as string })).rejects.toThrow('effort must be one of')
    expect(calls).toHaveLength(3)
    // focus goes to main only when true: a request without it is what an older host sent.
    await ctx.sessions.open({ prompt: 'go', focus: true })
    await ctx.sessions.open({ prompt: 'go', focus: false })
    expect(calls.slice(3)).toEqual([
      { method: 'sessions.open', params: { pluginId: 'a.one', cwd: undefined, prompt: 'go', focus: true } },
      { method: 'sessions.open', params: { pluginId: 'a.one', cwd: undefined, prompt: 'go' } }
    ])
    expect('focus' in (calls[4]?.params as object)).toBe(false)
    // Each listed model and effort passes through; absent ones are not sent.
    await ctx.sessions.open({ model: 'opus', effort: 'max' })
    expect(calls[calls.length - 1]?.params).toMatchObject({ model: 'opus', effort: 'max' })
    for (const model of ['haiku', 'sonnet', 'opus', 'fable']) await ctx.sessions.open({ model })
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) await ctx.sessions.open({ effort })
    expect('model' in (calls[4]?.params as object)).toBe(false)
  })

  it('open passes an allowed env through as plain data and rejects any other, naming the variable', async () => {
    const CODE_MODE = 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE'
    const { ctx, calls } = setup((c) => (c.method === 'sessions.open' ? { tabId: 't9', env: [CODE_MODE] } : []))
    await expect(ctx.sessions.open({ env: { [CODE_MODE]: '1' } })).resolves.toEqual({ tabId: 't9', env: [CODE_MODE] })
    expect(calls.at(-1)?.params).toMatchObject({ env: { [CODE_MODE]: '1' } })
    expect(Object.getPrototypeOf((calls.at(-1)?.params as { env: object }).env)).toBe(Object.prototype)
    await ctx.sessions.open({})
    expect('env' in (calls.at(-1)?.params as object)).toBe(false)
    const sent = calls.length
    await expect(ctx.sessions.open({ env: { PATH: '/evil' } })).rejects.toThrow('sessions.open: env: PATH is not allowed')
    await expect(ctx.sessions.open({ env: { [CODE_MODE]: '0' } })).rejects.toThrow(`${CODE_MODE} must be "1"`)
    await expect(ctx.sessions.open({ env: 'x' as never })).rejects.toThrow('sessions.open: env must be an object')
    expect(calls).toHaveLength(sent)
  })

  it('openShell sends only cwd and focus, checking their types first', async () => {
    const { ctx, calls } = setup((c) => (c.method === 'sessions.openShell' ? { tabId: 't7' } : []))
    await expect(ctx.sessions.openShell({ cwd: 'src', focus: true })).resolves.toEqual({ tabId: 't7' })
    await ctx.sessions.openShell()
    // Whatever else a plugin passes stays in the host.
    await ctx.sessions.openShell({ focus: false, command: 'rm -rf ~', env: { X: '1' } } as unknown as { focus: boolean })
    expect(calls).toEqual([
      { method: 'sessions.openShell', params: { pluginId: 'a.one', cwd: 'src', focus: true } },
      { method: 'sessions.openShell', params: { pluginId: 'a.one' } },
      { method: 'sessions.openShell', params: { pluginId: 'a.one' } }
    ])
    await expect(ctx.sessions.openShell({ cwd: 5 as unknown as string })).rejects.toThrow('sessions.openShell: cwd must be a string')
    await expect(ctx.sessions.openShell({ focus: 'yes' as unknown as boolean })).rejects.toThrow('focus must be a boolean')
    expect(calls).toHaveLength(3)
  })

  it('openCommand sends only argv, cwd, title and focus, checking the argv rule first', async () => {
    const { ctx, calls } = setup((c) => (c.method === 'sessions.openCommand' ? { tabId: 't8' } : []))
    expect(typeof ctx.sessions.openCommand).toBe('function')
    await expect(ctx.sessions.openCommand({ argv: ['glow', 'a b.md'], cwd: 'docs', title: 'Glow', focus: true })).resolves.toEqual({ tabId: 't8' })
    await ctx.sessions.openCommand({ argv: ['ls'], focus: false, env: { X: '1' }, command: 'rm -rf ~' } as unknown as { argv: string[] })
    expect(calls).toEqual([
      { method: 'sessions.openCommand', params: { pluginId: 'a.one', argv: ['glow', 'a b.md'], cwd: 'docs', title: 'Glow', focus: true } },
      { method: 'sessions.openCommand', params: { pluginId: 'a.one', argv: ['ls'] } }
    ])
    await expect(ctx.sessions.openCommand({ argv: [] })).rejects.toThrow('sessions.openCommand: argv must be an array')
    await expect(ctx.sessions.openCommand({ argv: ['a\0'] })).rejects.toThrow('NUL')
    await expect(ctx.sessions.openCommand(undefined as unknown as { argv: string[] })).rejects.toThrow('argv must be an array')
    await expect(ctx.sessions.openCommand({ argv: ['ls'], cwd: 5 as unknown as string })).rejects.toThrow('cwd must be a string')
    await expect(ctx.sessions.openCommand({ argv: ['ls'], title: 5 as unknown as string })).rejects.toThrow('title must be a string')
    await expect(ctx.sessions.openCommand({ argv: ['ls'], focus: 'yes' as unknown as boolean })).rejects.toThrow('focus must be a boolean')
    expect(calls).toHaveLength(2)
  })

  it('the three opens send beside and side only when given, checking their shape first', async () => {
    const { ctx, calls } = setup((c) => (c.method.startsWith('sessions.open') ? { tabId: 't9', placed: false } : []))
    await expect(ctx.sessions.open({ beside: 't1' })).resolves.toEqual({ tabId: 't9', placed: false })
    await ctx.sessions.openShell({ beside: 't1', side: 'down' })
    await ctx.sessions.openCommand({ argv: ['ls'], beside: 't1', side: 'right' })
    await ctx.sessions.openShell({})
    expect(calls.map((c) => c.params)).toEqual([
      { pluginId: 'a.one', beside: 't1' },
      { pluginId: 'a.one', beside: 't1', side: 'down' },
      { pluginId: 'a.one', argv: ['ls'], beside: 't1', side: 'right' },
      { pluginId: 'a.one' }
    ])
    await expect(ctx.sessions.open({ side: 'down' })).rejects.toThrow('sessions.open: side needs beside')
    await expect(ctx.sessions.openShell({ beside: 5 as unknown as string })).rejects.toThrow('beside must be a tab id')
    await expect(ctx.sessions.openCommand({ argv: ['ls'], beside: 't1', side: 'left' as 'down' })).rejects.toThrow("side must be 'right' or 'down'")
    expect(calls).toHaveLength(4)
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

// design-next §4.1: scope all (the declaration checked here first), focus, close, openFile.
describe('ctx.sessions scope all and the tab actions', () => {
  function declaring(answer: (c: Call) => unknown = () => null) {
    const base = setup(answer)
    const seer = base.contexts.create(hostSpec({ id: 'a.seer', dir: '/p/seer', main: 'h.js', sessionsAll: true }))
    return { ...base, seer }
  }

  it('throws for scope all without the declaration, before asking main', async () => {
    const { ctx, calls } = setup()
    await expect(ctx.sessions.list({ scope: 'all' })).rejects.toThrow('needs "access": { "sessions": "all-windows" }')
    expect(() => ctx.sessions.onChange(() => {}, { scope: 'all' })).toThrow('needs "access"')
    await expect(ctx.sessions.list({ scope: 'x' as 'all' })).rejects.toThrow('scope must be')
    expect(calls).toEqual([])
    // Scope window is the old call.
    await ctx.sessions.list({ scope: 'window' })
    expect(calls).toEqual([{ method: 'sessions.list', params: { pluginId: 'a.one', scope: 'window' } }])
  })

  it('asks main for summaries with the plugin id, and hands sessions.all only to scope all listeners', async () => {
    const { contexts, ctx, seer, calls } = declaring(() => [])
    await seer.sessions.list({ scope: 'all' })
    expect(calls).toEqual([{ method: 'sessions.list', params: { pluginId: 'a.seer', scope: 'all' } }])
    const all: unknown[] = []
    const own: unknown[] = []
    seer.sessions.onChange((s) => all.push(s), { scope: 'all' })
    seer.sessions.onChange((s) => own.push(s))
    const plain: unknown[] = []
    ctx.sessions.onChange((s) => plain.push(s))
    const summaries = [{ tabId: 't1', own: false, project: { name: 'p' }, status: 'working' }]
    contexts.handleEvent('sessions.all', { sessions: summaries })
    expect(all).toEqual([summaries])
    expect(own).toEqual([])
    expect(plain).toEqual([])
    contexts.handleEvent('sessions', { sessions: [] })
    expect(all).toHaveLength(1)
    expect(own).toEqual([[]])
    contexts.dispose('a.seer')
    contexts.handleEvent('sessions.all', { sessions: summaries })
    expect(all).toHaveLength(1)
  })

  it('the machine calls need the declaration before asking main; with it they ask with the plugin id', async () => {
    const { ctx, calls } = setup()
    await expect(ctx.sessions.machines()).rejects.toThrow('needs "access": { "sessions": "all-windows" }')
    await expect(ctx.sessions.focusMachine('m1')).rejects.toThrow('needs "access"')
    expect(() => ctx.sessions.onMachinesChange(() => {})).toThrow('needs "access"')
    expect(calls).toEqual([])
    const machines = [{ id: 'm1', name: 'devbox', reachable: true, waiting: 1, working: 0, idle: 0 }]
    const d = declaring((c) => (c.method === 'sessions.machines' ? machines : true))
    await expect(d.seer.sessions.machines()).resolves.toEqual(machines)
    await expect(d.seer.sessions.focusMachine('m1')).resolves.toBe(true)
    await expect(d.seer.sessions.focusMachine('' as string)).rejects.toThrow('needs a machine id')
    expect(d.calls).toEqual([
      { method: 'sessions.machines', params: { pluginId: 'a.seer' } },
      { method: 'sessions.focusMachine', params: { pluginId: 'a.seer', id: 'm1' } }
    ])
  })

  it('hands sessions.machines to onMachinesChange listeners only, a copy each, until disposed', () => {
    const { contexts, ctx, seer } = declaring()
    const heard: unknown[][] = []
    const off = seer.sessions.onMachinesChange((m) => {
      heard.push(m)
      ;(m as unknown[]).push('mutated')
    })
    const second: unknown[][] = []
    seer.sessions.onMachinesChange((m) => second.push(m))
    const plain: unknown[] = []
    ctx.sessions.onChange((s) => plain.push(s))
    const machines = [{ id: 'm1', name: 'devbox', reachable: false }]
    contexts.handleEvent('sessions.machines', { machines })
    expect(second).toEqual([machines])
    expect(plain).toEqual([])
    // Not a list: dropped.
    contexts.handleEvent('sessions.machines', { machines: 'x' })
    expect(second).toHaveLength(1)
    off()
    contexts.handleEvent('sessions.machines', { machines })
    expect(heard).toHaveLength(1)
    expect(second).toHaveLength(2)
    contexts.dispose('a.seer')
    contexts.handleEvent('sessions.machines', { machines })
    expect(second).toHaveLength(2)
  })

  it('asks main for the plan usage with the plugin id, no declaration needed', async () => {
    const usage = { fiveHour: { usedPercent: 10, resetsAt: 1 }, updatedAt: 2 }
    const { ctx, calls } = setup((c) => (c.method === 'sessions.rateLimits' ? usage : null))
    await expect(ctx.sessions.rateLimits()).resolves.toEqual(usage)
    expect(calls).toEqual([{ method: 'sessions.rateLimits', params: { pluginId: 'a.one' } }])
  })

  it('hands sessions.rateLimits to every plugin\'s onRateLimits listeners, a copy each, until disposed', () => {
    const { contexts, ctx, other, logs } = setup()
    const one: unknown[] = []
    const two: unknown[] = []
    const off = ctx.sessions.onRateLimits((r) => {
      one.push(r)
      ;(r as { updatedAt: number }).updatedAt = -1
    })
    other.sessions.onRateLimits((r) => two.push(r))
    ctx.sessions.onRateLimits(() => {
      throw new Error('boom')
    })
    const rateLimits = { sevenDay: { usedPercent: 70, resetsAt: 5 }, updatedAt: 9 }
    contexts.handleEvent('sessions.rateLimits', { rateLimits })
    expect(two).toEqual([rateLimits])
    expect(rateLimits.updatedAt).toBe(9)
    expect(logs.some((l) => l.pluginId === 'a.one' && l.text.includes('onRateLimits listener threw'))).toBe(true)
    // A malformed event is dropped; a disposer and a disposed plugin stop the calls.
    contexts.handleEvent('sessions.rateLimits', { rateLimits: null })
    contexts.handleEvent('sessions.rateLimits', { rateLimits: { updatedAt: 'x' } })
    expect(two).toHaveLength(1)
    off()
    contexts.dispose('a.two')
    contexts.handleEvent('sessions.rateLimits', { rateLimits })
    expect(one).toHaveLength(1)
    expect(two).toHaveLength(1)
    expect(() => ctx.sessions.onRateLimits('x' as unknown as () => void)).toThrow('needs a function')
  })

  it('sends focus, close (no RPC timeout) and openFile with the plugin id, checking the arguments', async () => {
    const { ctx, calls } = setup((c) => (c.method === 'sessions.focus' ? true : c.method === 'sessions.close' ? { closed: false } : null))
    await expect(ctx.sessions.focus('t1')).resolves.toBe(true)
    await expect(ctx.sessions.close('t1')).resolves.toEqual({ closed: false })
    await expect(ctx.sessions.openFile('t1', '/p/a.ts')).resolves.toBeUndefined()
    expect(calls).toEqual([
      { method: 'sessions.focus', params: { pluginId: 'a.one', tabId: 't1' } },
      { method: 'sessions.close', params: { pluginId: 'a.one', tabId: 't1' }, options: { timeoutMs: Infinity } },
      { method: 'sessions.openFile', params: { pluginId: 'a.one', tabId: 't1', path: '/p/a.ts' } }
    ])
    await expect(ctx.sessions.focus(5 as unknown as string)).rejects.toThrow('needs a tab id')
    await expect(ctx.sessions.close('')).rejects.toThrow('needs a tab id')
    await expect(ctx.sessions.openFile('t1', '')).rejects.toThrow('needs a path')
    expect(calls).toHaveLength(3)
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
    // A remote view's click: the listeners run in that view (origin-view.ts); a view main did not
    // mint is dropped, never read as the desktop's.
    const views: unknown[] = []
    const offView = ctx.panels.onAction('side', () => views.push(currentView()))
    contexts.handleEvent('panel.action', { pluginId: 'a.one', panelId: 'side', actionId: 'go', view: 'web:2' })
    contexts.handleEvent('panel.action', { pluginId: 'a.one', panelId: 'side', actionId: 'go' })
    contexts.handleEvent('panel.action', { pluginId: 'a.one', panelId: 'side', actionId: 'go', view: 'desktop:1' })
    expect(views).toEqual(['web:2', undefined])
    expect(heard).toEqual(['board:refresh', 'side:go', 'side:go', 'side:go'])
    offView()
    // Disposed: its listeners went with it.
    contexts.dispose('a.one')
    contexts.handleEvent('panel.action', { pluginId: 'a.one', panelId: 'side', actionId: 'late' })
    expect(heard).toEqual(['board:refresh', 'side:go', 'side:go', 'side:go'])
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

describe('ctx.overlay extras', () => {
  it('rejects a bad type, button list, ready or discuss before main is asked', async () => {
    const { ctx, calls } = setup()
    const html = { kind: 'html', file: 'p.html' } as const
    await expect(ctx.overlay.open({ ...html, type: { name: 'Bad', data: null } })).rejects.toThrow(/type name/)
    await expect(ctx.overlay.open({ ...html, buttons: [{ id: 'a b', label: 'A' }] })).rejects.toThrow(/button id/)
    await expect(ctx.overlay.open({ ...html, buttons: [{ id: 'a', label: 'A', icon: 'nope' }] })).rejects.toThrow(/svg/)
    await expect(ctx.overlay.open({ ...html, ready: 'soon' as never })).rejects.toThrow(/ready/)
    await expect(ctx.overlay.open({ kind: 'url', url: 'https://example.com/', ready: 'manual' })).rejects.toThrow(/html overlays only/)
    await expect(ctx.overlay.open({ ...html, discuss: true as never })).rejects.toThrow(/discuss/)
    expect(calls).toEqual([])
  })

  it('sends a good spec to main as given', async () => {
    const { ctx, calls } = setup(() => ({ kind: 'dismissed' }))
    const spec: OverlaySpec = {
      kind: 'html',
      file: 'p.html',
      type: { name: 'file', data: { path: 'a.ts' } },
      buttons: [{ id: 'edit', label: 'Edit', icon: 'settings' }],
      ready: 'manual',
      discuss: { tabId: 't1' }
    }
    await ctx.overlay.open(spec)
    expect(calls[0]?.params).toMatchObject({ spec })
  })

  it('setButtons checks the list where it is called; onButton and onDiscuss take functions only', () => {
    const { ctx } = setup(() => new Promise(() => {}))
    const overlay = ctx.overlay.start({ kind: 'html', file: 'p.html' })
    expect(() => overlay.setButtons([{ id: 'a', label: '' }])).toThrow(/label/)
    expect(() => overlay.setButtons(Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, label: 'B' })))).toThrow(/at most 4/)
    expect(() => overlay.setButtons([{ id: 'a', label: 'A' }])).not.toThrow()
    expect(() => overlay.onButton('a', 5 as never)).toThrow(TypeError)
    expect(() => overlay.onDiscuss('x' as never)).toThrow(TypeError)
    const off = overlay.onButton('a', () => {})
    expect(() => off()).not.toThrow()
    expect(() => overlay.onDiscuss(() => null)()).not.toThrow()
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
    contexts.handleEvent('overlay.message', { pluginId: 'a.one', handle, message: { n: 1 }, from: OWNER })
    // Another plugin's id with the same handle names nothing; nor does an unknown handle.
    contexts.handleEvent('overlay.message', { pluginId: 'a.two', handle, message: { n: 'x' }, from: OWNER })
    contexts.handleEvent('overlay.message', { pluginId: 'a.one', handle: 'nope', message: { n: 'y' }, from: OWNER })
    expect(heard).toEqual([{ n: 1 }])
    off()
    contexts.handleEvent('overlay.message', { pluginId: 'a.one', handle, message: { n: 2 }, from: OWNER })
    expect(heard).toEqual([{ n: 1 }])

    // A remote view's page: its listeners run in that view (origin-view.ts); a view main did not
    // mint is dropped, never read as the desktop's.
    const views: unknown[] = []
    const offView = overlay.onMessage(() => views.push(currentView()))
    contexts.handleEvent('overlay.message', { pluginId: 'a.one', handle, message: 1, view: 'web:4', from: { view: 'web:4', access: 'owner' } })
    contexts.handleEvent('overlay.message', { pluginId: 'a.one', handle, message: 2, from: OWNER })
    contexts.handleEvent('overlay.message', { pluginId: 'a.one', handle, message: 3, view: 'desktop:1', from: OWNER })
    expect(views).toEqual(['web:4', undefined])
    offView()

    overlay.onMessage((m) => heard.push(m))
    end({ kind: 'value', value: { done: true } })
    await expect(overlay.result).resolves.toEqual({ kind: 'value', value: { done: true } })

    // Ended: post, close and focus are no-ops (nothing sent), listeners are gone, onMessage is inert.
    const before = calls.length
    overlay.post({ late: true })
    overlay.close()
    overlay.focus()
    expect(calls.length).toBe(before)
    contexts.handleEvent('overlay.message', { pluginId: 'a.one', handle, message: { n: 3 }, from: OWNER })
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

  it('setDiscussPrimary sends the flag, refuses a non-boolean, and sends nothing once ended', async () => {
    const { ctx, calls, end } = pending()
    const overlay = ctx.overlay.start({ kind: 'url', url: 'https://example.com/' })
    const handle = handleOf(calls)
    overlay.setDiscussPrimary(true)
    expect(() => overlay.setDiscussPrimary('yes' as unknown as boolean)).toThrow(TypeError)
    expect(calls.slice(1)).toEqual([{ method: 'overlay.discussPrimary', params: { pluginId: 'a.one', handle, on: true } }])
    end({ kind: 'dismissed' })
    await overlay.result
    overlay.setDiscussPrimary(false)
    expect(calls).toHaveLength(2)
  })

  it('onDiscuss tells main on the first handler and when the last goes; ended, it sends nothing', async () => {
    const { ctx, calls, end } = pending()
    const overlay = ctx.overlay.start({ kind: 'url', url: 'https://example.com/' })
    const handle = handleOf(calls)
    const offA = overlay.onDiscuss(() => null)
    const offB = overlay.onDiscuss(() => ({ text: 'b' }))
    offA()
    offA()
    offB()
    expect(calls.slice(1)).toEqual([
      { method: 'overlay.discussable', params: { pluginId: 'a.one', handle, on: true } },
      { method: 'overlay.discussable', params: { pluginId: 'a.one', handle, on: false } }
    ])
    const offC = overlay.onDiscuss(() => null)
    expect(calls).toHaveLength(4)
    end({ kind: 'discussed', tabId: 't1', queued: false })
    await expect(overlay.result).resolves.toEqual({ kind: 'discussed', tabId: 't1', queued: false })
    offC()
    overlay.onDiscuss(() => null)
    expect(calls).toHaveLength(4)
  })

  it("main's overlay.discuss: the first handler with text wins, null passes, a throw or a bad answer fails", async () => {
    const { contexts, ctx, calls, logs } = pending()
    const overlay = ctx.overlay.start({ kind: 'url', url: 'https://example.com/' })
    const handle = handleOf(calls)
    const ask = (): Promise<unknown> => contexts.overlayDiscuss({ pluginId: 'a.one', handle, from: OWNER })
    await expect(ask()).resolves.toBeNull()
    const order: string[] = []
    overlay.onDiscuss(() => {
      order.push('a')
      return null
    })
    const offB = overlay.onDiscuss(async () => {
      order.push('b')
      return { text: 'x'.repeat(30_000) }
    })
    overlay.onDiscuss(() => {
      order.push('c')
      return { text: 'never asked' }
    })
    // Cut to the message cap here already, so a huge answer never crosses the port.
    await expect(ask()).resolves.toEqual({ text: 'x'.repeat(20_000) })
    expect(order).toEqual(['a', 'b'])
    offB()
    await expect(ask()).resolves.toEqual({ text: 'never asked' })
    // Another plugin's id with this handle names nothing.
    await expect(contexts.overlayDiscuss({ pluginId: 'a.two', handle, from: OWNER })).resolves.toBeNull()
    await expect(contexts.overlayDiscuss({ pluginId: 'a.one' })).rejects.toThrow(/bad handle/)
    const second = ctx.overlay.start({ kind: 'url', url: 'https://example.com/' })
    const handle2 = (calls.filter((c) => c.method === 'overlay.open')[1]?.params as { handle: string }).handle
    const offThrow = second.onDiscuss(() => {
      throw new Error('no draft')
    })
    await expect(contexts.overlayDiscuss({ pluginId: 'a.one', handle: handle2, from: OWNER })).rejects.toThrow('no draft')
    expect(logs).toContainEqual({ pluginId: 'a.one', level: 'error', text: 'an overlay onDiscuss handler threw: no draft' })
    offThrow()
    second.onDiscuss(() => ({ txt: 'x' }) as never)
    await expect(contexts.overlayDiscuss({ pluginId: 'a.one', handle: handle2, from: OWNER })).rejects.toThrow(/\{ text \} or null/)
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
    contexts.handleEvent('overlay.message', { pluginId: 'a.one', handle: handleOf(calls), message: 1, from: OWNER })
    expect(heard).toEqual([])
    overlay.post({ a: 1 })
    expect(calls.map((c) => c.method)).toEqual(['overlay.open'])
  })
})

// Per-view copies (docs/design-overlay-views.md §3, plan Task 7): a perView plugin's html overlay hears each view's
// copy connect and go, gets `from` (and `copy`) on every message, button and Discuss, posts to one copy or all, and
// hides one; the copy's view is a line of ctx.views while it is connected. main is a recording fake `call`, wrapped
// in carryView as host/index.ts does, so a request names the view of the listener it was made in.
describe('ctx.overlay per-view copies', () => {
  interface ViewCall extends Call {
    view?: string
  }

  function perViewSetup(): {
    contexts: HostContexts
    ctx: PluginContext
    plain: PluginContext
    calls: ViewCall[]
    logs: { pluginId: string; level: LogLevel; text: string }[]
    open: (c: PluginContext) => { overlay: OverlayHandle; handle: string }
  } {
    const calls: ViewCall[] = []
    const logs: { pluginId: string; level: LogLevel; text: string }[] = []
    const contexts = new HostContexts({
      log: (pluginId, level, text) => logs.push({ pluginId, level, text }),
      call: carryView(async (method: string, params: unknown, options?: { timeoutMs?: number; view?: ViewId }) => {
        calls.push({ method, params, ...(options?.view !== undefined ? { view: options.view } : {}) })
        // overlay.open stays open (the overlay is up), every other request answers true.
        return method === 'overlay.open' ? new Promise(() => {}) : true
      })
    })
    const ctx = contexts.create(hostSpec({ id: 'a.one', dir: '/p/one', main: 'h.js', panels: ['board'], overlaysPerView: true }))
    const plain = contexts.create(hostSpec({ id: 'a.two', dir: '/p/two', main: 'h.js' }))
    const open = (c: PluginContext): { overlay: OverlayHandle; handle: string } => {
      const overlay = c.overlay.start({ kind: 'html', file: 'review.html' })
      const handle = (calls.filter((x) => x.method === 'overlay.open').at(-1)?.params as { handle: string }).handle
      return { overlay, handle }
    }
    return { contexts, ctx, plain, calls, logs, open }
  }

  const ANN = { view: 'web:3', access: 'read', person: 'Ann' } as const
  const BO = { view: 'web:4', access: 'write', person: 'Bo' } as const

  it('a reload is the old copy going, then a new copy: onDisconnect then onConnect, each with from and its copy', () => {
    const { contexts, ctx, open } = perViewSetup()
    const { overlay, handle } = open(ctx)
    const order: unknown[] = []
    overlay.onConnect((from) => order.push(['connect', from, currentView(), ctx.views.access(from.view)]))
    overlay.onDisconnect((from) => order.push(['disconnect', from, currentView(), ctx.views.access(from.view)]))
    const ev = (event: string, copy: string, from: object, view?: string): void =>
      contexts.handleEvent(event, { pluginId: 'a.one', handle, copy, ...(view !== undefined ? { view } : {}), from })
    ev('overlay.connect', 'c1', ANN, 'web:3')
    // A repeated connect of a live copy, and a disconnect of a copy never announced: nothing.
    ev('overlay.connect', 'c1', ANN, 'web:3')
    ev('overlay.disconnect', 'zz', ANN, 'web:3')
    // The reload: main sends the old copy's disconnect, then the new copy's connect.
    ev('overlay.disconnect', 'c1', { view: 'web:3', access: 'read' }, 'web:3')
    ev('overlay.connect', 'c2', ANN, 'web:3')
    expect(order).toEqual([
      // Joined ctx.views before the listener ran; the listener runs in the copy's view.
      ['connect', { ...ANN, copy: 'c1' }, 'web:3', 'read'],
      // The connect's own from (main's disconnect may come when the view is gone), still a view while it runs.
      ['disconnect', { ...ANN, copy: 'c1' }, 'web:3', 'read'],
      ['connect', { ...ANN, copy: 'c2' }, 'web:3', 'read']
    ])
  })

  it('post goes to one copy with { copy }, to every copy without; a bad copy throws at the call site', () => {
    const { ctx, calls, open } = perViewSetup()
    const { overlay, handle } = open(ctx)
    overlay.post({ init: 1 }, { copy: 'c1' })
    overlay.post({ all: 1 })
    overlay.post({ all: 2 }, { copy: undefined })
    overlay.post({ all: 3 }, {})
    expect(calls.slice(1).map((c) => c.params)).toEqual([
      { pluginId: 'a.one', handle, message: { init: 1 }, copy: 'c1' },
      { pluginId: 'a.one', handle, message: { all: 1 } },
      { pluginId: 'a.one', handle, message: { all: 2 } },
      { pluginId: 'a.one', handle, message: { all: 3 } }
    ])
    for (const bad of [5, '', null]) expect(() => overlay.post({ a: 1 }, { copy: bad as never }), String(bad)).toThrow(/copy must be/)
    expect(() => overlay.post({ a: 1 }, null as never)).toThrow(/options must be an object/)
    expect(calls).toHaveLength(5)
  })

  it('hide sends that copy; a hide without a copy throws', () => {
    const { ctx, calls, open } = perViewSetup()
    const { overlay, handle } = open(ctx)
    overlay.hide({ copy: 'c1' })
    expect(calls.at(-1)).toEqual({ method: 'overlay.hide', params: { pluginId: 'a.one', handle, copy: 'c1' } })
    expect(() => overlay.hide(undefined as never)).toThrow(/options must be an object/)
    expect(() => overlay.hide({} as never)).toThrow(/copy must be/)
    expect(calls).toHaveLength(2)
  })

  it("a copy's view joins ctx.views with main's access while connected (counted with the plugin's panel lines); from carries the guest's person", () => {
    const { contexts, ctx, open } = perViewSetup()
    const { overlay, handle } = open(ctx)
    const changes: unknown[] = []
    ctx.views.onChange((e) => changes.push(e))
    const persons: unknown[] = []
    overlay.onConnect((from) => persons.push(from.person))
    contexts.handleEvent('overlay.connect', { pluginId: 'a.one', handle, copy: 'd1', from: OWNER })
    contexts.handleEvent('overlay.connect', { pluginId: 'a.one', handle, copy: 'g1', view: 'web:4', from: BO })
    expect(ctx.views.access('desktop')).toBe('owner')
    expect(ctx.views.access('web:4')).toBe('write')
    // A panel of the plugin open in the guest's view too: the view stays known until both lines end.
    const [hostEnd] = memoryPortPair()
    contexts.attachPanelPort('a.one', 'board', { postMessage: (m: string) => hostEnd.postMessage(m), onMessage: (l) => hostEnd.onMessage(l), close() {} }, 'web:4', 'write')
    contexts.handleEvent('overlay.disconnect', { pluginId: 'a.one', handle, copy: 'g1', view: 'web:4', from: BO })
    expect(ctx.views.access('web:4')).toBe('write')
    contexts.handleEvent('overlay.disconnect', { pluginId: 'a.one', handle, copy: 'd1', from: OWNER })
    expect(ctx.views.access('desktop')).toBeUndefined()
    expect(persons).toEqual([undefined, 'Bo'])
    expect(changes).toEqual([
      { view: 'desktop', access: 'owner' },
      { view: 'web:4', access: 'write' },
      { view: 'desktop', access: undefined }
    ])
  })

  it("a closed overlay ends its copies' lines in ctx.views and drops every listener", async () => {
    let end!: (r: unknown) => void
    const calls: Call[] = []
    const contexts = new HostContexts({
      log: () => {},
      call: async (method, params) => {
        calls.push({ method, params })
        return method === 'overlay.open' ? new Promise((resolve) => (end = resolve)) : true
      }
    })
    const ctx = contexts.create(hostSpec({ id: 'a.one', dir: '/p/one', main: 'h.js', overlaysPerView: true }))
    const overlay = ctx.overlay.start({ kind: 'html', file: 'review.html' })
    const handle = (calls[0]?.params as { handle: string }).handle
    const heard: unknown[] = []
    overlay.onConnect((from) => heard.push(from.copy))
    overlay.onDisconnect((from) => heard.push(`-${from.copy}`))
    contexts.handleEvent('overlay.connect', { pluginId: 'a.one', handle, copy: 'c1', view: 'web:3', from: ANN })
    expect(ctx.views.access('web:3')).toBe('read')
    end({ kind: 'dismissed' })
    await overlay.result
    expect(ctx.views.access('web:3')).toBeUndefined()
    // Ended: events reach no listener, and the copy members are inert.
    contexts.handleEvent('overlay.disconnect', { pluginId: 'a.one', handle, copy: 'c1', view: 'web:3', from: ANN })
    contexts.handleEvent('overlay.connect', { pluginId: 'a.one', handle, copy: 'c2', view: 'web:3', from: ANN })
    expect(heard).toEqual(['c1'])
    expect(ctx.views.access('web:3')).toBeUndefined()
    const before = calls.length
    overlay.post({ a: 1 }, { copy: 'c2' })
    overlay.hide({ copy: 'c2' })
    expect(calls).toHaveLength(before)
    expect(typeof overlay.onConnect(() => {})).toBe('function')
  })

  it('messages carry from and copy; one from an unknown copy, another view\'s copy or with no valid from is dropped', () => {
    const { contexts, ctx, logs, open } = perViewSetup()
    const { overlay, handle } = open(ctx)
    const heard: unknown[] = []
    overlay.onMessage((m, from) => heard.push([m, from]))
    contexts.handleEvent('overlay.connect', { pluginId: 'a.one', handle, copy: 'c3', view: 'web:3', from: ANN })
    contexts.handleEvent('overlay.connect', { pluginId: 'a.one', handle, copy: 'c4', view: 'web:4', from: BO })
    const msg = (copy: unknown, view: string | undefined, from: unknown, message: unknown = 1): void =>
      contexts.handleEvent('overlay.message', { pluginId: 'a.one', handle, message, copy, ...(view !== undefined ? { view } : {}), from })
    msg('c3', 'web:3', ANN, { note: 'a' })
    msg('c4', 'web:4', BO, { note: 'b' })
    msg('zz', 'web:3', ANN)
    // c4 is web:4's copy: a message naming it from web:3 is nobody's.
    msg('c4', 'web:3', ANN)
    msg(undefined, 'web:3', ANN)
    msg('c3', 'web:3', undefined)
    msg('c3', 'web:3', { view: 'web:3', access: 'owner', person: 'Ann' })
    expect(heard).toEqual([
      [{ note: 'a' }, { ...ANN, copy: 'c3' }],
      [{ note: 'b' }, { ...BO, copy: 'c4' }]
    ])
    expect(logs.filter((l) => /no valid sender/.test(l.text))).toHaveLength(2)
    // A gone copy's late message: dropped too.
    contexts.handleEvent('overlay.disconnect', { pluginId: 'a.one', handle, copy: 'c3', view: 'web:3', from: ANN })
    msg('c3', 'web:3', ANN)
    expect(heard).toHaveLength(2)
  })

  it("a desktop message naming an unknown or gone copy is dropped (the desktop's view and a missing copy's are both undefined)", () => {
    const { contexts, ctx, open } = perViewSetup()
    const { overlay, handle } = open(ctx)
    const heard: unknown[] = []
    overlay.onMessage((m, from) => heard.push([m, from]))
    const msg = (copy: string, message: unknown): void =>
      contexts.handleEvent('overlay.message', { pluginId: 'a.one', handle, message, copy, from: OWNER })
    msg('never', 1)
    contexts.handleEvent('overlay.connect', { pluginId: 'a.one', handle, copy: 'd1', from: OWNER })
    msg('d1', 2)
    contexts.handleEvent('overlay.disconnect', { pluginId: 'a.one', handle, copy: 'd1', from: OWNER })
    msg('d1', 3)
    expect(heard).toEqual([[2, { view: 'desktop', access: 'owner', copy: 'd1' }]])
  })

  it('a late onConnect first hears every live copy, each in its own view, before it returns; a gone copy is not replayed', () => {
    const { contexts, ctx, open } = perViewSetup()
    const { overlay, handle } = open(ctx)
    contexts.handleEvent('overlay.connect', { pluginId: 'a.one', handle, copy: 'd1', from: OWNER })
    contexts.handleEvent('overlay.connect', { pluginId: 'a.one', handle, copy: 'c3', view: 'web:3', from: ANN })
    contexts.handleEvent('overlay.connect', { pluginId: 'a.one', handle, copy: 'c4', view: 'web:4', from: BO })
    contexts.handleEvent('overlay.disconnect', { pluginId: 'a.one', handle, copy: 'c4', view: 'web:4', from: BO })
    const heard: unknown[] = []
    overlay.onConnect((from) => heard.push([from, currentView()]))
    expect(heard).toEqual([
      [{ view: 'desktop', access: 'owner', copy: 'd1' }, undefined],
      [{ ...ANN, copy: 'c3' }, 'web:3']
    ])
    // Later connects reach it as usual, once.
    contexts.handleEvent('overlay.connect', { pluginId: 'a.one', handle, copy: 'c5', view: 'web:5', from: { view: 'web:5', access: 'owner' } })
    expect(heard).toHaveLength(3)
  })

  it("onButton and onDiscuss get who acted, in that view; a Discuss with no valid from is refused", async () => {
    const { contexts, ctx, open } = perViewSetup()
    const { overlay, handle } = open(ctx)
    const got: unknown[] = []
    overlay.onButton('done', (from) => void got.push(['button', from, currentView()]))
    overlay.onDiscuss((from) => {
      got.push(['discuss', from, currentView()])
      return { text: `by ${from.person ?? 'owner'}` }
    })
    await contexts.overlayButtonClick({ source: 'opener', pluginId: 'a.one', handle, buttonId: 'done', view: 'web:4', from: BO })
    await expect(contexts.overlayDiscuss({ pluginId: 'a.one', handle, view: 'web:4', from: BO })).resolves.toEqual({ text: 'by Bo' })
    await expect(contexts.overlayDiscuss({ pluginId: 'a.one', handle, from: OWNER })).resolves.toEqual({ text: 'by owner' })
    expect(got).toEqual([
      ['button', BO, 'web:4'],
      ['discuss', BO, 'web:4'],
      ['discuss', { view: 'desktop', access: 'owner' }, undefined]
    ])
    await expect(contexts.overlayDiscuss({ pluginId: 'a.one', handle, view: 'web:4' })).rejects.toThrow(/bad from/)
    await expect(contexts.overlayDiscuss({ pluginId: 'a.one', handle, view: 'web:4', from: OWNER })).rejects.toThrow(/bad from/)
    await expect(contexts.overlayDiscuss({ pluginId: 'a.one', handle, view: 'nope', from: OWNER })).rejects.toThrow(/bad view/)
    expect(got).toHaveLength(3)
  })

  it('a throwing or rejecting listener is logged and the next one still runs; the host goes on', async () => {
    const { contexts, ctx, logs, open } = perViewSetup()
    const { overlay, handle } = open(ctx)
    const ran: string[] = []
    overlay.onConnect(() => {
      throw new Error('connect broke')
    })
    overlay.onConnect(async () => {
      await Promise.resolve()
      throw new Error('async connect broke')
    })
    overlay.onConnect((from) => void ran.push(`connect ${from.copy}`))
    overlay.onDisconnect(() => {
      throw new Error('disconnect broke')
    })
    overlay.onDisconnect((from) => void ran.push(`disconnect ${from.copy}`))
    overlay.onMessage(() => {
      throw new Error('message broke')
    })
    overlay.onMessage((m) => void ran.push(`message ${String(m)}`))
    contexts.handleEvent('overlay.connect', { pluginId: 'a.one', handle, copy: 'c1', view: 'web:3', from: ANN })
    contexts.handleEvent('overlay.message', { pluginId: 'a.one', handle, message: 'hi', copy: 'c1', view: 'web:3', from: ANN })
    contexts.handleEvent('overlay.disconnect', { pluginId: 'a.one', handle, copy: 'c1', view: 'web:3', from: ANN })
    await flush()
    expect(ran).toEqual(['connect c1', 'message hi', 'disconnect c1'])
    // The view's line ended even though a disconnect listener threw.
    expect(ctx.views.access('web:3')).toBeUndefined()
    expect(logs.map((l) => l.text)).toEqual(
      expect.arrayContaining([
        'an overlay onConnect listener threw: connect broke',
        'an overlay onConnect listener failed: async connect broke',
        'an overlay onDisconnect listener threw: disconnect broke',
        'an overlay onMessage listener threw: message broke'
      ])
    )
  })

  it('disposers remove listeners; a disposed plugin drops its copies from ctx.views', () => {
    const { contexts, ctx, open } = perViewSetup()
    const { overlay, handle } = open(ctx)
    const heard: unknown[] = []
    const off = overlay.onConnect((from) => heard.push(from.copy))
    off()
    off()
    contexts.handleEvent('overlay.connect', { pluginId: 'a.one', handle, copy: 'c1', view: 'web:3', from: ANN })
    expect(heard).toEqual([])
    expect(ctx.views.access('web:3')).toBe('read')
    contexts.dispose('a.one')
    // Re-created, the plugin knows of no view: its old overlay's copy went with it.
    const again = contexts.create(hostSpec({ id: 'a.one', dir: '/p/one', main: 'h.js', overlaysPerView: true }))
    expect(again.views.access('web:3')).toBeUndefined()
  })

  it("dispatch in the copy's view: a call made from inside onMessage without a view aims at that view (the origin hint)", async () => {
    const { contexts, ctx, calls, open } = perViewSetup()
    const { overlay, handle } = open(ctx)
    overlay.onMessage((m, from) => {
      void ctx.openExternal('https://example.com/hint')
      void ctx.openExternal('https://example.com/addressed', { view: from.view })
      overlay.post({ ack: m }, { copy: from.copy })
    })
    contexts.handleEvent('overlay.connect', { pluginId: 'a.one', handle, copy: 'c3', view: 'web:3', from: ANN })
    contexts.handleEvent('overlay.message', { pluginId: 'a.one', handle, message: 1, copy: 'c3', view: 'web:3', from: ANN })
    // The desktop page's copy: no hint, and its from.view 'desktop' is an address main resolves to this window.
    contexts.handleEvent('overlay.connect', { pluginId: 'a.one', handle, copy: 'd1', from: OWNER })
    contexts.handleEvent('overlay.message', { pluginId: 'a.one', handle, message: 2, copy: 'd1', from: OWNER })
    await flush()
    const opens = calls.filter((c) => c.method === 'openExternal')
    expect(opens).toEqual([
      { method: 'openExternal', params: { pluginId: 'a.one', url: 'https://example.com/hint' }, view: 'web:3' },
      { method: 'openExternal', params: { pluginId: 'a.one', url: 'https://example.com/addressed', view: 'web:3' }, view: 'web:3' },
      { method: 'openExternal', params: { pluginId: 'a.one', url: 'https://example.com/hint' } },
      { method: 'openExternal', params: { pluginId: 'a.one', url: 'https://example.com/addressed', view: 'desktop' } }
    ])
    expect(calls.find((c) => c.method === 'overlay.post')?.params).toEqual({ pluginId: 'a.one', handle, message: { ack: 1 }, copy: 'c3' })
  })

  it('a plugin without perView: the same API, one page; post { copy } and hide throw, copies never connect', () => {
    const { contexts, plain, calls, open } = perViewSetup()
    const { overlay, handle } = open(plain)
    expect(() => overlay.post({ a: 1 }, { copy: 'c1' })).toThrow(/"overlays": \{ "perView": true \}.*one page/)
    expect(() => overlay.hide({ copy: 'c1' })).toThrow(/use close\(\)/)
    // Generic code that answers by from.copy still works: undefined is a broadcast.
    overlay.post({ a: 1 }, { copy: undefined })
    expect(calls.at(-1)?.params).toEqual({ pluginId: 'a.two', handle, message: { a: 1 } })
    const heard: unknown[] = []
    overlay.onConnect((from) => heard.push(['connect', from]))
    overlay.onDisconnect((from) => heard.push(['disconnect', from]))
    overlay.onMessage((m, from) => heard.push([m, from]))
    contexts.handleEvent('overlay.connect', { pluginId: 'a.two', handle, copy: 'c1', view: 'web:3', from: ANN })
    expect(plain.views.access('web:3')).toBeUndefined()
    // Its holder's messages, with who posted and no copy; one naming a copy is nobody's.
    contexts.handleEvent('overlay.message', { pluginId: 'a.two', handle, message: 1, view: 'web:4', from: BO })
    contexts.handleEvent('overlay.message', { pluginId: 'a.two', handle, message: 2, from: OWNER })
    contexts.handleEvent('overlay.message', { pluginId: 'a.two', handle, message: 3, copy: 'c1', view: 'web:3', from: ANN })
    expect(heard).toEqual([
      [1, BO],
      [2, { view: 'desktop', access: 'owner' }]
    ])
    // Not html: the copy members throw like post and onMessage.
    const term = plain.overlay.start({ kind: 'terminal', argv: ['tig'] })
    expect(() => term.onConnect(() => {})).toThrow('only an html overlay')
    expect(() => term.hide({ copy: 'c1' })).toThrow('only an html overlay')
  })
})

// Provenance (docs/design-overlay-views.md §4, D-4): overlay calls made inside a service call carry the caller chain
// as `via`; handle.addSources sends a deferred fill's sources. main checks both again (host-api.ts).
describe('ctx.overlay provenance (via, addSources)', () => {
  /** A real registry: a.three (A) calls a.two (B), which calls a.one (the Reviewer), whose method opens an overlay. */
  function chain() {
    const calls: Call[] = []
    const registry = new ServiceRegistry({ activationOf: () => Promise.resolve({ state: 'active' }), isActivating: () => false, log: () => {} })
    const contexts = new HostContexts({
      log: () => {},
      call: async (method, params) => {
        calls.push({ method, params })
        // overlay.open stays open (the overlay is up), every other request answers true.
        return method === 'overlay.open' ? new Promise(() => {}) : true
      },
      services: () => registry
    })
    registry.setSpec({ id: 'a.one', services: { provides: { review: 1 } } })
    registry.setSpec({ id: 'a.two', services: { provides: { mail: 1 }, uses: { review: 1 } } })
    registry.setSpec({ id: 'a.three', services: { uses: { mail: 1 } } })
    const rev = contexts.create(hostSpec({ id: 'a.one', dir: '/p/one', main: 'h.js' }))
    const mail = contexts.create(hostSpec({ id: 'a.two', dir: '/p/two', main: 'h.js' }))
    const app = contexts.create(hostSpec({ id: 'a.three', dir: '/p/three', main: 'h.js' }))
    return { calls, rev, mail, app }
  }
  const of = (calls: Call[], method: string): Record<string, unknown>[] => calls.filter((c) => c.method === method).map((c) => c.params as Record<string, unknown>)

  it('A -> B -> Reviewer: open, post and setButtons inside the call carry [A, B]; a later post outside it carries none', async () => {
    const { calls, rev, mail, app } = chain()
    let handle!: OverlayHandle
    rev.services.provide('review', {
      show: () => {
        handle = rev.overlay.start({ kind: 'html', file: 'review.html', title: 'Re: salary' })
        handle.post({ content: 'the mail' })
        handle.setButtons([{ id: 'archive', label: 'Archive' }])
        return 'shown'
      }
    })
    const review = mail.services.use('review')
    mail.services.provide('mail', { open: () => review.show!() })
    await expect(app.services.use('mail').open!()).resolves.toBe('shown')
    expect(of(calls, 'overlay.open')[0]).toMatchObject({ pluginId: 'a.one', via: ['a.three', 'a.two'] })
    expect(of(calls, 'overlay.post')[0]).toMatchObject({ message: { content: 'the mail' }, via: ['a.three', 'a.two'] })
    expect(of(calls, 'overlay.setButtons')[0]).toMatchObject({ via: ['a.three', 'a.two'] })
    // The call settled: the chain is gone, so a later post names nobody (a deferred fill uses addSources).
    handle.post({ more: 1 })
    expect(of(calls, 'overlay.post')[1]).toEqual({ pluginId: 'a.one', handle: of(calls, 'overlay.open')[0]!.handle, message: { more: 1 } })
  })

  it("a plugin's own overlay (no service call) sends no via key at all", () => {
    const { calls, rev } = chain()
    const handle = rev.overlay.start({ kind: 'html', file: 'review.html' })
    handle.post({ a: 1 })
    expect('via' in of(calls, 'overlay.open')[0]!).toBe(false)
    expect('via' in of(calls, 'overlay.post')[0]!).toBe(false)
  })

  it('deferred addSources: strings only, each once; any kind; refused for a non-array; a no-op when nothing is left', async () => {
    const { calls, rev, mail } = chain()
    // Recorded while B's call was live, used later (the Reviewer keeps it with the stored content).
    let kept: string[] = []
    rev.services.provide('review', { prepare: () => void (kept = rev.services.callers()) })
    await mail.services.use('review').prepare!()
    expect(kept).toEqual(['a.two'])
    const term = rev.overlay.start({ kind: 'terminal', argv: ['less'] })
    term.addSources!([...kept, 'a.two', 5 as never, '', 'a.three'])
    const sent = of(calls, 'overlay.addSources')
    expect(sent[0]).toEqual({ pluginId: 'a.one', handle: of(calls, 'overlay.open')[0]!.handle, ids: ['a.two', 'a.three'] })
    expect(() => term.addSources!('a.two' as never)).toThrow('needs an array')
    term.addSources!([])
    term.addSources!([7 as never])
    expect(of(calls, 'overlay.addSources')).toHaveLength(1)
  })

  // Task 4 review: `via` only narrows, so a source cut to a bound fails open (a guest kept seeing a hidden plugin's
  // content). The host filters to its own plugins first and never truncates.
  it('never cuts sources: ids that name no plugin of this host first do not push real ones out; more than the floor all go', () => {
    const { calls, rev } = chain()
    const term = rev.overlay.start({ kind: 'terminal', argv: ['less'] })
    const junk = Array.from({ length: MAX_OVERLAY_SOURCES + 8 }, (_, i) => `x.${i}`)
    term.addSources!([...junk, 'a.two', 'a.three'])
    expect(of(calls, 'overlay.addSources')[0]!.ids).toEqual(['a.two', 'a.three'])
  })

  it('more than MAX_OVERLAY_SOURCES real plugins: every one attributed (addSources and a deep caller chain)', async () => {
    const calls: Call[] = []
    const registry = new ServiceRegistry({ activationOf: () => Promise.resolve({ state: 'active' }), isActivating: () => false, log: () => {} })
    const contexts = new HostContexts({
      log: () => {},
      call: async (method, params) => {
        calls.push({ method, params })
        return method === 'overlay.open' ? new Promise(() => {}) : true
      },
      services: () => registry
    })
    // p.0 -> p.1 -> ... -> p.(n-1) -> a.rev: a chain deeper than the floor.
    const n = MAX_OVERLAY_SOURCES + 6
    const ids = Array.from({ length: n }, (_, i) => `p.${i}`)
    registry.setSpec({ id: 'a.rev', services: { provides: { review: 1 } } })
    ids.forEach((id, i) =>
      registry.setSpec({ id, services: { provides: { [`s${i}`]: 1 }, uses: { [i === n - 1 ? 'review' : `s${i + 1}`]: 1 } } })
    )
    const rev = contexts.create(hostSpec({ id: 'a.rev', dir: '/p/rev', main: 'h.js' }))
    const ctxs = ids.map((id) => contexts.create(hostSpec({ id, dir: `/p/${id}`, main: 'h.js' })))
    rev.services.provide('review', { show: () => void rev.overlay.start({ kind: 'html', file: 'review.html' }) })
    ctxs.forEach((c, i) => {
      if (i === 0) return
      const next = i === n - 1 ? c.services.use('review') : c.services.use(`s${i + 1}`)
      c.services.provide(`s${i}`, { go: () => (i === n - 1 ? next.show!() : next.go!()) })
    })
    // p.0 is the outermost consumer: it calls s1 (p.1).
    await ctxs[0]!.services.use('s1').go!()
    expect(of(calls, 'overlay.open')[0]!.via).toEqual(ids)
    const term = rev.overlay.start({ kind: 'terminal', argv: ['less'] })
    term.addSources!(ids)
    expect(of(calls, 'overlay.addSources')[0]!.ids).toEqual(ids)
  })

  it('with no plugin filter (no registry), a list past the floor throws at the call site instead of losing an id', () => {
    const calls: Call[] = []
    const contexts = new HostContexts({ log: () => {}, call: async (method, params) => (calls.push({ method, params }), method === 'overlay.open' ? new Promise(() => {}) : true) })
    const ctx = contexts.create(hostSpec({ id: 'a.one', dir: '/p/one', main: 'h.js' }))
    const term = ctx.overlay.start({ kind: 'terminal', argv: ['less'] })
    expect(() => term.addSources!(Array.from({ length: MAX_OVERLAY_SOURCES + 1 }, (_, i) => `p.${i}`))).toThrow(RangeError)
    term.addSources!(Array.from({ length: MAX_OVERLAY_SOURCES }, (_, i) => `p.${i}`))
    expect((calls.find((c) => c.method === 'overlay.addSources')!.params as { ids: string[] }).ids).toHaveLength(MAX_OVERLAY_SOURCES)
  })
})

describe('ctx.panels', () => {
  it('posts JSON to the panel once it has a port, and hears what the panel posts', async () => {
    const { contexts, ctx, logs } = setup()
    // Not shown yet: dropped, no throw.
    ctx.panels.post('board', { early: true })
    const { port, page } = panelPort()
    expect(contexts.attachPanelPort('a.one', 'board', port, undefined, 'owner')).toBe(true)
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
    expect(contexts.attachPanelPort('a.one', 'inbox', stray.port, undefined, 'owner')).toBe(false)
    expect(stray.port.closed).toBe(true)
    const unknown = panelPort()
    expect(contexts.attachPanelPort('x.y', 'board', unknown.port, undefined, 'owner')).toBe(false)
    expect(unknown.port.closed).toBe(true)
  })

  it('a reloaded panel gets a new port: the old one is closed and hears nothing more', async () => {
    const { contexts, ctx } = setup()
    const heard: unknown[] = []
    ctx.panels.onMessage('board', (m) => heard.push(m))
    const first = panelPort()
    contexts.attachPanelPort('a.one', 'board', first.port, undefined, 'owner')
    const second = panelPort()
    contexts.attachPanelPort('a.one', 'board', second.port, undefined, 'owner')
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
    contexts.attachPanelPort('a.one', 'board', port, undefined, 'owner')
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
