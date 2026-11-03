// ctx.commands, ctx.notify, ctx.openExternal, ctx.log and the clean-up on deactivate, against a fake main.
import { describe, expect, it, vi } from 'vitest'
import { HostContexts } from '../../src/host/ctx'
import { MAX_NOTIFY_TITLE, NOTIFY_ACTION_WAIT_MS } from '../../src/shared/notify'
import { hostSpec } from '../fakes/host-spec'

function setup(commands = ['refresh', 'other']) {
  const calls: [string, unknown][] = []
  const logs: [string, string, string][] = []
  let callResult: () => Promise<unknown> = () => Promise.resolve(null)
  const contexts = new HostContexts({
    log: (id, level, text) => void logs.push([id, level, text]),
    call: (method, params) => {
      calls.push([method, params])
      return callResult()
    }
  })
  const ctx = contexts.create(hostSpec({ id: 'a.one', dir: '/d', main: 'm.js', commands }))
  return { contexts, ctx, calls, logs, failCalls: (err: Error) => (callResult = () => Promise.reject(err)) }
}

describe('ctx.commands', () => {
  it('registers a declared command with main, and runs it on request', async () => {
    const { contexts, ctx, calls } = setup()
    const run = vi.fn()
    ctx.commands.register('refresh', run)
    expect(calls).toEqual([['commands.register', { pluginId: 'a.one', id: 'refresh' }]])
    await expect(contexts.runCommand({ pluginId: 'a.one', id: 'refresh' })).resolves.toBeNull()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('refuses a command the manifest does not declare, at the call site, without asking main', () => {
    const { ctx, calls } = setup()
    expect(() => ctx.commands.register('sneaky', () => {})).toThrow('not declared in plugin.json')
    expect(calls).toEqual([])
  })

  it('refuses to register the same command twice, and bad arguments', () => {
    const { ctx } = setup()
    ctx.commands.register('refresh', () => {})
    expect(() => ctx.commands.register('refresh', () => {})).toThrow('already registered')
    expect(() => ctx.commands.register('other', 'no' as never)).toThrow('id and a function')
  })

  it('the disposer unregisters (only its own registration) and allows registering again', async () => {
    const { contexts, ctx, calls } = setup()
    const off = ctx.commands.register('refresh', () => {})
    off()
    off()
    expect(calls.filter(([m]) => m === 'commands.unregister')).toHaveLength(1)
    await expect(contexts.runCommand({ pluginId: 'a.one', id: 'refresh' })).rejects.toThrow('is not registered')
    const second = vi.fn()
    ctx.commands.register('refresh', second)
    off() // the old disposer must not remove the new registration
    await contexts.runCommand({ pluginId: 'a.one', id: 'refresh' })
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('runCommand propagates a failing command and refuses unknown or malformed requests', async () => {
    const { contexts, ctx } = setup()
    ctx.commands.register('refresh', () => {
      throw new Error('command bug')
    })
    await expect(contexts.runCommand({ pluginId: 'a.one', id: 'refresh' })).rejects.toThrow('command bug')
    await expect(contexts.runCommand({ pluginId: 'a.one', id: 'other' })).rejects.toThrow('is not registered')
    await expect(contexts.runCommand({ pluginId: 'a.two', id: 'refresh' })).rejects.toThrow('is not registered')
    await expect(contexts.runCommand({ pluginId: 1, id: 'refresh' })).rejects.toThrow('must be strings')
  })

  it('logs (does not throw) when main refuses the registration', async () => {
    const { ctx, logs, failCalls } = setup()
    failCalls(new Error('main said no'))
    ctx.commands.register('refresh', () => {})
    await new Promise((r) => setTimeout(r, 0))
    expect(logs).toEqual([['a.one', 'error', 'registering command "refresh" with the app failed: main said no']])
  })

  it('deactivate hands every command back to main and refuses new ones', () => {
    const { contexts, ctx, calls } = setup()
    ctx.commands.register('refresh', () => {})
    ctx.commands.register('other', () => {})
    calls.length = 0
    contexts.dispose('a.one')
    expect(calls).toEqual([
      ['commands.unregister', { pluginId: 'a.one', id: 'refresh' }],
      ['commands.unregister', { pluginId: 'a.one', id: 'other' }]
    ])
    expect(() => ctx.commands.register('refresh', () => {})).toThrow('deactivated')
    contexts.dispose('a.one')
    expect(calls).toHaveLength(2)
  })
})

describe('ctx.notify with an action', () => {
  function actionSetup() {
    const events: [string, unknown][] = []
    const calls: { method: string; params: unknown; timeoutMs?: number }[] = []
    let answer: (value: unknown) => void = () => {}
    const contexts = new HostContexts({
      log: () => {},
      emit: (event, params) => void events.push([event, params]),
      call: (method, params, options) => {
        calls.push({ method, params, ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) })
        return new Promise((resolve) => (answer = resolve))
      }
    })
    const ctx = contexts.create(hostSpec({ id: 'a.one', dir: '/d', main: 'm.js' }))
    return { contexts, ctx, calls, events, answer: (value: unknown) => answer(value) }
  }

  it("waits for main's answer, bounded a little past main's own wait", async () => {
    const { ctx, calls, answer } = actionSetup()
    const result = ctx.notify('Standup in 2 min', { action: { label: 'Join' }, sound: true })
    await Promise.resolve()
    expect(calls).toEqual([
      {
        method: 'notify',
        params: { pluginId: 'a.one', text: 'Standup in 2 min', options: { sound: true, action: { label: 'Join' } } },
        timeoutMs: NOTIFY_ACTION_WAIT_MS + 30_000
      }
    ])
    answer({ clicked: true })
    await expect(result).resolves.toEqual({ clicked: true })
    // Anything but an explicit click is not one.
    const other = ctx.notify('again', { action: { label: 'Join' } })
    await Promise.resolve()
    answer({ clicked: 'yes' })
    await expect(other).resolves.toEqual({ clicked: false })
  })

  it('resolves { clicked: false } at dispose, tells main, and ignores a later answer', async () => {
    const { contexts, ctx, events, answer } = actionSetup()
    const result = ctx.notify('Standup', { action: { label: 'Join' } })
    await Promise.resolve()
    contexts.dispose('a.one')
    await expect(result).resolves.toEqual({ clicked: false })
    expect(events).toContainEqual(['plugin.disposed', { pluginId: 'a.one' }])
    answer({ clicked: true })
    await expect(result).resolves.toEqual({ clicked: false })
    await expect(ctx.notify('x', { action: { label: 'Join' } })).rejects.toThrow('deactivated')
  })

  it('does not tell main at dispose when nothing waits', async () => {
    const { contexts, ctx, events, answer } = actionSetup()
    const result = ctx.notify('Standup', { action: { label: 'Join' } })
    await Promise.resolve()
    answer({ clicked: false })
    await result
    contexts.dispose('a.one')
    expect(events).toEqual([])
  })
})

describe('ctx.notify and ctx.log', () => {
  it('asks main to notify with the plugin id, capping the text', async () => {
    const { ctx, calls } = setup()
    await ctx.notify('hello')
    await ctx.notify('x'.repeat(2000))
    expect(calls[0]).toEqual(['notify', { pluginId: 'a.one', text: 'hello' }])
    expect((calls[1]?.[1] as { text: string }).text).toHaveLength(500)
  })

  it('rejects empty or non-string text without bothering main, and passes main\'s refusal on', async () => {
    const { ctx, calls, failCalls } = setup()
    await expect(ctx.notify('')).rejects.toThrow('some text')
    await expect(ctx.notify(5 as never)).rejects.toThrow('some text')
    expect(calls).toEqual([])
    failCalls(new Error('too many notifications'))
    await expect(ctx.notify('x')).rejects.toThrow('too many notifications')
  })

  it('checks the options at the call site with main\'s rule, and sends them only when given', async () => {
    const { ctx, calls } = setup()
    for (const bad of [5, { title: '' }, { title: 'x'.repeat(MAX_NOTIFY_TITLE + 1) }, { sound: 1 }, { sound: 'x'.repeat(1025) }, { action: {} }]) {
      await expect(ctx.notify('hi', bad as never)).rejects.toBeInstanceOf(TypeError)
    }
    expect(calls).toEqual([])
    // Without an action: resolves once main showed it, never waiting for a click.
    await expect(ctx.notify('hi', { title: 'Calendar', sound: true })).resolves.toEqual({ clicked: false })
    await expect(ctx.notify('plain')).resolves.toEqual({ clicked: false })
    // A sound id from a "format": "sound" setting goes to main as it is ("" is the app's sound):
    // only main can tell whether the app offers it.
    await ctx.notify('own', { sound: 'builtin:bell' })
    await ctx.notify('default', { sound: '' })
    expect(calls).toEqual([
      ['notify', { pluginId: 'a.one', text: 'hi', options: { title: 'Calendar', sound: true } }],
      ['notify', { pluginId: 'a.one', text: 'plain' }],
      ['notify', { pluginId: 'a.one', text: 'own', options: { sound: 'builtin:bell' } }],
      ['notify', { pluginId: 'a.one', text: 'default', options: { sound: true } }]
    ])
  })

  it('rejects notify when there is no connection to main', async () => {
    const ctx = new HostContexts({ log: () => {} }).create(hostSpec({ id: 'a.one', dir: '/d', main: 'm.js' }))
    await expect(ctx.notify('x')).rejects.toThrow('no connection to the app')
  })

  it('ctx.openExternal asks main with its own plugin id, checks the shape first, and passes main\'s refusal on', async () => {
    const { contexts, ctx, calls, failCalls } = setup()
    await expect(ctx.openExternal('https://example.com/a')).resolves.toBeUndefined()
    expect(calls).toEqual([['openExternal', { pluginId: 'a.one', url: 'https://example.com/a' }]])
    // Shapes reject as TypeErrors at the call site, without a round trip.
    for (const bad of ['', 5, null, undefined, { href: 'https://x' }]) {
      await expect(ctx.openExternal(bad as never)).rejects.toBeInstanceOf(TypeError)
    }
    await expect(ctx.openExternal(`https://x/${'a'.repeat(2048)}`)).rejects.toThrow('over 2048 characters')
    expect(calls).toHaveLength(1)
    // Scheme, userinfo and rate are main's to decide: the host hands those on as they are.
    failCalls(new Error('openExternal: only http and https links are opened'))
    await expect(ctx.openExternal('file:///etc/passwd')).rejects.toThrow('only http and https')
    contexts.dispose('a.one')
    await expect(ctx.openExternal('https://example.com')).rejects.toThrow('deactivated')
  })

  it('sends log lines to main tagged with the plugin id and level', () => {
    const { ctx, logs } = setup()
    ctx.log.info('a', 1)
    ctx.log.error(new Error('bad').message)
    expect(logs).toEqual([
      ['a.one', 'info', 'a 1'],
      ['a.one', 'error', 'bad']
    ])
  })

  it('a plugin cannot change the ctx object', () => {
    const { ctx } = setup()
    expect(Object.isFrozen(ctx)).toBe(true)
    expect(Object.isFrozen(ctx.commands)).toBe(true)
    expect(Object.isFrozen(ctx.storage)).toBe(true)
  })
})
