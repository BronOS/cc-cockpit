import { describe, expect, it, vi } from 'vitest'
import { HostContexts } from '../../src/host/ctx'
import { SettingsHolder } from '../../src/host/ctx/settings'
import { hostSpec } from '../fakes/host-spec'

describe('ctx.settings and onSettingsChange', () => {
  const make = (settings = { project: { limit: 5 }, app: { url: 'https://x' } }) => {
    const log = vi.fn()
    const contexts = new HostContexts({ log: (_id, _level, text) => log(text) })
    const ctx = contexts.create(hostSpec({ id: 'a.one', dir: '/d', main: 'm.js', settings }))
    return { contexts, ctx, log }
  }

  it('exposes the validated project and app values main sent', () => {
    const { ctx } = make()
    expect(ctx.settings).toEqual({ project: { limit: 5 }, app: { url: 'https://x' } })
  })

  it('hands out frozen snapshots; a plugin cannot change what listeners or later reads see', () => {
    const { ctx } = make()
    expect(Object.isFrozen(ctx.settings)).toBe(true)
    expect(Object.isFrozen(ctx.settings.project)).toBe(true)
    expect(() => {
      ;(ctx.settings.project as Record<string, unknown>).limit = 9
    }).toThrow()
    expect(ctx.settings.project.limit).toBe(5)
  })

  it('does not freeze or alias the spec object main built', () => {
    const settings = { project: { nested: { a: 1 } }, app: {} }
    const spec = hostSpec({ id: 'a.one', dir: '/d', main: 'm.js', settings: settings as never })
    new HostContexts({ log: () => {} }).create(spec)
    expect(Object.isFrozen(settings.project)).toBe(false)
  })

  it('pushes a change from main to the listeners and to ctx.settings', () => {
    const { contexts, ctx } = make()
    const seen: unknown[] = []
    const stop = ctx.onSettingsChange((s) => seen.push(s))
    contexts.handleEvent('settings', { pluginId: 'a.one', project: { limit: 7 }, app: {} })
    expect(seen).toEqual([{ project: { limit: 7 }, app: {} }])
    expect(ctx.settings.project.limit).toBe(7)
    stop()
    stop()
    contexts.handleEvent('settings', { pluginId: 'a.one', project: { limit: 8 }, app: {} })
    expect(seen).toHaveLength(1)
    expect(ctx.settings.project.limit).toBe(8)
  })

  it('applies a change only to the plugin it names', () => {
    const contexts = new HostContexts({ log: () => {} })
    const one = contexts.create(hostSpec({ id: 'a.one', dir: '/d', main: 'm.js' }))
    const two = contexts.create(hostSpec({ id: 'a.two', dir: '/d', main: 'm.js' }))
    contexts.handleEvent('settings', { pluginId: 'a.two', project: { x: 1 }, app: {} })
    expect(one.settings.project).toEqual({})
    expect(two.settings.project).toEqual({ x: 1 })
    // Unknown plugin, wrong event name, malformed payloads: ignored.
    contexts.handleEvent('settings', { pluginId: 'a.nope', project: {}, app: {} })
    contexts.handleEvent('other', { pluginId: 'a.one', project: { y: 1 }, app: {} })
    contexts.handleEvent('settings', null)
    contexts.handleEvent('settings', { pluginId: 'a.one', project: [], app: {} })
    expect(one.settings.project).toEqual({})
  })

  it('a throwing listener does not keep the others from hearing about the change', () => {
    const { contexts, ctx, log } = make()
    const second = vi.fn()
    ctx.onSettingsChange(() => {
      throw new Error('listener bug')
    })
    ctx.onSettingsChange(second)
    contexts.handleEvent('settings', { pluginId: 'a.one', project: {}, app: {} })
    expect(second).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('onSettingsChange listener threw: listener bug')
  })

  it('refuses a listener that is not a function, and listeners after deactivate', () => {
    const { contexts, ctx } = make()
    expect(() => ctx.onSettingsChange(5 as never)).toThrow('needs a function')
    contexts.dispose('a.one')
    expect(() => ctx.onSettingsChange(() => {})).toThrow('deactivated')
  })

  it('SettingsHolder drops a malformed update and logs it', () => {
    const log = vi.fn()
    const holder = new SettingsHolder({ project: {}, app: {} }, log)
    holder.update({ project: 'no', app: {} })
    expect(log).toHaveBeenCalledWith('settings update dropped: project and app must be objects')
    expect(holder.current).toEqual({ project: {}, app: {} })
  })
})
