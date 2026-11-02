// ctx.commands, ctx.notify, ctx.log and the clean-up on deactivate, against a fake main.
import { describe, expect, it, vi } from 'vitest'
import { HostContexts } from '../../src/host/ctx'
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

  it('rejects notify when there is no connection to main', async () => {
    const ctx = new HostContexts({ log: () => {} }).create(hostSpec({ id: 'a.one', dir: '/d', main: 'm.js' }))
    await expect(ctx.notify('x')).rejects.toThrow('no connection to the app')
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
