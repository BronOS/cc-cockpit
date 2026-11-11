// design-next §3.3, host side: the registry of ctx.overlay.buttons providers (host/overlay-buttons.ts)
// and the toolbar requests through HostContexts (ctx.overlay.buttons, the opener's onButton and
// setButtons, a plugin's ctx ending). main is a recording fake `call`.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostContexts, type ContextDeps, type LogLevel } from '../../src/host/ctx'
import { currentView } from '../../src/host/ctx/origin-view'
import { OverlayButtonRegistry, PROVIDER_TIMEOUT_MS } from '../../src/host/overlay-buttons'
import type { OverlayInfo, OverlayTypeButton, PluginContext } from '../../src/sdk/types'
import { hostSpec } from '../fakes/host-spec'

const info = (data: unknown = { path: 'src/x.ts' }, name = 'file'): unknown => ({
  type: { name, data },
  title: 'src/x.ts',
  opener: 'p.rev'
})

function registry(timeoutMs?: number): { reg: OverlayButtonRegistry; logs: { pluginId: string; text: string }[] } {
  const logs: { pluginId: string; text: string }[] = []
  const reg = new OverlayButtonRegistry((pluginId, text) => logs.push({ pluginId, text }), timeoutMs)
  return { reg, logs }
}

const button = (id: string, run: OverlayTypeButton['run'] = () => {}, extra: Partial<OverlayTypeButton> = {}): OverlayTypeButton => ({
  id,
  label: id.toUpperCase(),
  run,
  ...extra
})

afterEach(() => {
  vi.useRealTimers()
})

describe('OverlayButtonRegistry', () => {
  it('asks every provider of the type with one deep-frozen copy; buttons carry the registering plugin', async () => {
    const { reg } = registry()
    const seen: OverlayInfo[] = []
    reg.register('p.edit', 'file', (o) => {
      seen.push(o)
      // A provider that tries to change what the next one sees.
      expect(() => ((o.type.data as { path: string }).path = '/etc/passwd')).toThrow()
      return [button('edit', () => {}, { icon: 'check', primary: true })]
    })
    // A provider claiming another plugin's id in its answer: the registration decides.
    reg.register('p.mail', 'file', async (o) => {
      seen.push(o)
      return [{ ...button('read'), pluginId: 'p.edit' } as OverlayTypeButton]
    })
    reg.register('p.mail', 'inbox-item', () => [button('never')])
    const answer = await reg.list({ key: 'k1', info: info() })
    expect(answer).toEqual([
      { pluginId: 'p.edit', id: 'edit', label: 'EDIT', icon: 'check', primary: true },
      { pluginId: 'p.mail', id: 'read', label: 'READ' }
    ])
    expect(seen).toHaveLength(2)
    expect(seen[0]).toEqual({ type: { name: 'file', data: { path: 'src/x.ts' } }, title: 'src/x.ts', opener: 'p.rev' })
    // One copy of main's message, frozen all the way down: shared, since no provider can change it.
    expect(seen[0]).toBe(seen[1])
    expect(Object.isFrozen(seen[1]!.type.data)).toBe(true)
    expect((seen[1]!.type.data as { path: string }).path).toBe('src/x.ts')
  })

  it('skips a slow, throwing or malformed provider (logged in its plugin log); the rest shows', async () => {
    vi.useFakeTimers()
    const { reg, logs } = registry()
    reg.register('p.slow', 'file', () => new Promise(() => {}))
    reg.register('p.throw', 'file', () => {
      throw new Error('broken')
    })
    reg.register('p.junk', 'file', () => 'nope' as never)
    reg.register('p.norun', 'file', () => [{ id: 'x', label: 'X' } as never])
    reg.register('p.badid', 'file', () => [button('a b')])
    reg.register('p.ok', 'file', () => [button('ok')])
    const pending = reg.list({ key: 'k1', info: info() })
    await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS)
    await expect(pending).resolves.toEqual([{ pluginId: 'p.ok', id: 'ok', label: 'OK' }])
    expect(logs.map((l) => l.pluginId).sort()).toEqual(['p.badid', 'p.junk', 'p.norun', 'p.slow', 'p.throw'])
    expect(logs.find((l) => l.pluginId === 'p.slow')?.text).toMatch(/longer than 500 ms/)
    expect(logs.find((l) => l.pluginId === 'p.throw')?.text).toMatch(/broken/)
  })

  it('caps a plugin at 4 buttons across its providers and drops a repeated id', async () => {
    const { reg, logs } = registry()
    reg.register('p.one', 'file', () => [button('a'), button('b'), button('c')])
    reg.register('p.one', 'file', () => [button('a'), button('d'), button('e')])
    const ids = (await reg.list({ key: 'k', info: info() })).map((b) => b.id)
    expect(ids).toEqual(['a', 'b', 'c', 'd'])
    expect(logs.map((l) => l.text).join('\n')).toMatch(/"a" is used twice[\s\S]*more than 4/)
  })

  it('a click runs the button of the latest answer; { close: true } goes back, a throw is logged and rethrown', async () => {
    const { reg, logs } = registry()
    const runs: OverlayInfo[] = []
    let state = 'unread'
    reg.register('p.mail', 'inbox-item', () => [
      button(state === 'unread' ? 'read' : 'unread', (o) => {
        runs.push(o)
        state = state === 'unread' ? 'read' : 'unread'
      }),
      button('done', () => ({ close: true })),
      button('fail', () => {
        throw new Error('no network')
      })
    ])
    const item = info({ source: 'p.mail', id: 't1' }, 'inbox-item')
    await reg.list({ key: 'k', info: item })
    await expect(reg.click({ key: 'k', pluginId: 'p.mail', buttonId: 'read', info: item })).resolves.toBeNull()
    expect(runs[0]?.type.data).toEqual({ source: 'p.mail', id: 't1' })
    await expect(reg.click({ key: 'k', pluginId: 'p.mail', buttonId: 'done', info: item })).resolves.toEqual({ close: true })
    await expect(reg.click({ key: 'k', pluginId: 'p.mail', buttonId: 'fail', info: item })).rejects.toThrow('no network')
    expect(logs.at(-1)).toMatchObject({ pluginId: 'p.mail', text: expect.stringMatching(/"fail" failed: no network/) })
    // Not asked again yet: "unread" is not a button of that overlay.
    await expect(reg.click({ key: 'k', pluginId: 'p.mail', buttonId: 'unread', info: item })).rejects.toThrow(/no button "unread"/)
    await reg.list({ key: 'k', info: item })
    await expect(reg.click({ key: 'k', pluginId: 'p.mail', buttonId: 'unread', info: item })).resolves.toBeNull()
    // Another overlay's key, another plugin's id: nothing to run.
    await expect(reg.click({ key: 'k2', pluginId: 'p.mail', buttonId: 'done', info: item })).rejects.toThrow(/no button/)
    await expect(reg.click({ key: 'k', pluginId: 'p.other', buttonId: 'done', info: item })).rejects.toThrow(/no button/)
  })

  it('ended drops the runs, also of an answer that comes back after it', async () => {
    const { reg } = registry()
    let release!: () => void
    reg.register('p.one', 'file', () => new Promise<OverlayTypeButton[]>((resolve) => (release = () => resolve([button('a')]))))
    const pending = reg.list({ key: 'k', info: info() })
    await Promise.resolve()
    reg.ended({ key: 'k' })
    release()
    await pending
    await expect(reg.click({ key: 'k', pluginId: 'p.one', buttonId: 'a', info: info() })).rejects.toThrow(/no button/)
  })

  it("removePlugin (its ctx ended) takes its providers and runs, also from an ask under way; a disposer removes one", async () => {
    const { reg } = registry()
    let release!: () => void
    reg.register('p.one', 'file', () => new Promise<OverlayTypeButton[]>((resolve) => (release = () => resolve([button('late')]))))
    const off = reg.register('p.two', 'file', () => [button('b')])
    reg.register('p.three', 'file', () => [button('c')])
    const pending = reg.list({ key: 'k', info: info() })
    await Promise.resolve()
    reg.removePlugin('p.one')
    release()
    expect((await pending).map((b) => b.pluginId)).toEqual(['p.two', 'p.three'])
    reg.removePlugin('p.three')
    await expect(reg.click({ key: 'k', pluginId: 'p.three', buttonId: 'c', info: info() })).rejects.toThrow(/no button/)
    off()
    expect(await reg.list({ key: 'k', info: info() })).toEqual([])
  })

  it('refuses a bad registration and a malformed request', async () => {
    const { reg } = registry()
    expect(() => reg.register('p', 'File', () => [])).toThrow(TypeError)
    expect(() => reg.register('p', 'file', 'x' as never)).toThrow(/provider function/)
    await expect(reg.list({ key: '', info: info() })).rejects.toThrow(/bad key/)
    await expect(reg.list({ key: 'k', info: info({}, 'BAD') })).rejects.toThrow(/type name/)
    await expect(reg.list({ key: 'k', info: { ...(info() as object), title: 5 } })).rejects.toThrow(/title/)
    await expect(reg.click({ key: 'k', pluginId: 5, buttonId: 'a', info: info() })).rejects.toThrow(/bad button/)
  })
})

describe('through the host (HostContexts)', () => {
  interface Call {
    method: string
    params: unknown
  }

  function setup(answer: (c: Call) => unknown = () => new Promise(() => {})): {
    contexts: HostContexts
    ctx: PluginContext
    calls: Call[]
    events: Call[]
    logs: { pluginId: string; level: LogLevel; text: string }[]
  } {
    const calls: Call[] = []
    const events: Call[] = []
    const logs: { pluginId: string; level: LogLevel; text: string }[] = []
    const deps: ContextDeps = {
      log: (pluginId, level, text) => logs.push({ pluginId, level, text }),
      call: async (method, params) => {
        const c = { method, params }
        calls.push(c)
        return answer(c)
      },
      emit: (method, params) => events.push({ method, params })
    }
    const contexts = new HostContexts(deps)
    const ctx = contexts.create(hostSpec({ id: 'a.one', dir: '/p/one', main: 'h.js', panels: [] }))
    return { contexts, ctx, calls, events, logs }
  }

  it('ctx.overlay.buttons registers for the plugin; main asks and clicks through the host methods', async () => {
    const { contexts, ctx } = setup()
    expect(() => ctx.overlay.buttons('Not A Type', () => [])).toThrow(TypeError)
    let clicked = 0
    ctx.overlay.buttons('file', () => [button('edit', () => void clicked++)])
    await expect(contexts.overlayButtons({ key: 'k', info: info() })).resolves.toEqual([{ pluginId: 'a.one', id: 'edit', label: 'EDIT' }])
    await expect(contexts.overlayButtonClick({ source: 'type', key: 'k', pluginId: 'a.one', buttonId: 'edit', info: info() })).resolves.toBeNull()
    expect(clicked).toBe(1)
    contexts.handleEvent('overlay.ended', { key: 'k' })
    await expect(contexts.overlayButtonClick({ source: 'type', key: 'k', pluginId: 'a.one', buttonId: 'edit', info: info() })).rejects.toThrow()
    await expect(contexts.overlayButtonClick({ source: 'page', key: 'k' })).rejects.toThrow(/source/)
  })

  it("the opener's onButton runs on main's click; setButtons goes to main for that handle", async () => {
    const { contexts, ctx, calls, logs } = setup()
    const overlay = ctx.overlay.start({ kind: 'url', url: 'https://example.com/', buttons: [{ id: 'star', label: 'Star' }] })
    const handle = (calls[0]?.params as { handle: string }).handle
    const order: string[] = []
    overlay.onButton('star', async () => {
      await Promise.resolve()
      order.push('first')
    })
    overlay.onButton('star', () => {
      throw new Error('second broke')
    })
    overlay.onButton('other', () => order.push('other'))
    await expect(contexts.overlayButtonClick({ source: 'opener', pluginId: 'a.one', handle, buttonId: 'star' })).resolves.toBeNull()
    expect(order).toEqual(['first'])
    expect(logs.some((l) => /second broke/.test(l.text))).toBe(true)
    // Another plugin's id or handle runs nothing.
    await contexts.overlayButtonClick({ source: 'opener', pluginId: 'a.two', handle, buttonId: 'other' })
    await contexts.overlayButtonClick({ source: 'opener', pluginId: 'a.one', handle: 'nope', buttonId: 'other' })
    expect(order).toEqual(['first'])

    overlay.setButtons([{ id: 'unstar', label: 'Unstar', primary: true }])
    await Promise.resolve()
    expect(calls.at(-1)).toEqual({ method: 'overlay.setButtons', params: { pluginId: 'a.one', handle, buttons: [{ id: 'unstar', label: 'Unstar', primary: true }] } })
  })

  it("a remote view's click runs the handler in that view (origin-view.ts); a view main never mints is refused", async () => {
    const { contexts, ctx, calls } = setup()
    const views: unknown[] = []
    ctx.overlay.buttons('file', () => [button('edit', () => void views.push(currentView()))])
    await contexts.overlayButtons({ key: 'k', info: info() })
    await contexts.overlayButtonClick({ source: 'type', key: 'k', pluginId: 'a.one', buttonId: 'edit', info: info(), view: 'web:5' })
    await contexts.overlayButtonClick({ source: 'type', key: 'k', pluginId: 'a.one', buttonId: 'edit', info: info() })
    await expect(
      contexts.overlayButtonClick({ source: 'type', key: 'k', pluginId: 'a.one', buttonId: 'edit', info: info(), view: 'nope' })
    ).rejects.toThrow(/bad view/)
    const overlay = ctx.overlay.start({ kind: 'url', url: 'https://example.com/', buttons: [{ id: 'star', label: 'Star' }] })
    const handle = (calls.find((c) => c.method === 'overlay.open')?.params as { handle: string }).handle
    overlay.onButton('star', async () => {
      await Promise.resolve()
      views.push(currentView())
    })
    await contexts.overlayButtonClick({ source: 'opener', pluginId: 'a.one', handle, buttonId: 'star', view: 'web:6' })
    await contexts.overlayButtonClick({ source: 'opener', pluginId: 'a.one', handle, buttonId: 'star' })
    await expect(contexts.overlayButtonClick({ source: 'opener', pluginId: 'a.one', handle, buttonId: 'star', view: 7 })).rejects.toThrow(/bad view/)
    expect(views).toEqual(['web:5', undefined, 'web:6', undefined])
  })

  it('a ctx that added type buttons tells main when it ends; its providers go with it', async () => {
    const { contexts, ctx, events } = setup()
    ctx.overlay.buttons('file', () => [button('edit')])
    contexts.dispose('a.one')
    expect(events).toContainEqual({ method: 'plugin.disposed', params: { pluginId: 'a.one' } })
    await expect(contexts.overlayButtons({ key: 'k', info: info() })).resolves.toEqual([])
  })
})
