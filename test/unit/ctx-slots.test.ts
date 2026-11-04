// Task 6, host side: ctx.slots (the provider of a slot) and ctx.panels.slots (the plugin that
// places them), as a plugin sees them. main is a recording fake `call`; a slot frame's MessagePort
// is an in-memory port pair, opened the way host/index.ts does it (slotOpenTag + attachSlotPort).
import { describe, expect, it } from 'vitest'
import { HostContexts, type ContextDeps, type LogLevel } from '../../src/host/ctx'
import { slotOpenTag } from '../../src/host/ctx/slots'
import type { PanelPort } from '../../src/host/ctx/ui'
import type { PluginContext, SlotInstance } from '../../src/sdk/types'
import { hostSpec } from '../fakes/host-spec'
import { memoryPortPair, type MemoryPort } from '../fakes/memory-port'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

interface Call {
  method: string
  params: unknown
}

function setup(answer: (c: Call) => unknown = () => null): {
  contexts: HostContexts
  provider: PluginContext
  placer: PluginContext
  calls: Call[]
  emitted: { event: string; params: unknown }[]
  logs: { pluginId: string; level: LogLevel; text: string }[]
} {
  const calls: Call[] = []
  const emitted: { event: string; params: unknown }[] = []
  const logs: { pluginId: string; level: LogLevel; text: string }[] = []
  const deps: ContextDeps = {
    log: (pluginId, level, text) => logs.push({ pluginId, level, text }),
    call: async (method, params) => {
      const c: Call = { method, params }
      calls.push(c)
      return answer(c)
    },
    emit: (event, params) => emitted.push({ event, params })
  }
  const contexts = new HostContexts(deps)
  const provider = contexts.create(hostSpec({ id: 'p.cal', dir: '/p/cal', main: 'h.js', slotTypes: ['agenda'] }))
  const placer = contexts.create(
    hostSpec({ id: 'p.inbox', dir: '/p/inbox', main: 'h.js', panels: ['main', 'web'], webviewPanels: ['web'], panelSlots: { main: ['agenda'] } })
  )
  return { contexts, provider, placer, calls, emitted, logs }
}

/** Main hands the host a slot frame: the tag text and the host's end of the port, plus the page's end. */
function openFrame(
  contexts: HostContexts,
  tag: Record<string, unknown>
): { page: MemoryPort; port: PanelPort & { closed: boolean }; attached: boolean } {
  const [hostEnd, page] = memoryPortPair()
  const port = {
    closed: false,
    postMessage: (m: string) => hostEnd.postMessage(m),
    onMessage: (l: (m: unknown) => void) => hostEnd.onMessage(l),
    close() {
      port.closed = true
    }
  }
  const parsed = slotOpenTag(JSON.stringify({ slotOpen: tag }))
  if (!parsed) throw new Error('bad tag')
  return { page, port, attached: contexts.attachSlotPort(parsed, port) }
}

const TAG = { pluginId: 'p.cal', id: 's1', type: 'agenda', host: { kind: 'panel', pluginId: 'p.inbox', panelId: 'main' }, params: { days: 2 } }

describe('ctx.slots.onOpen', () => {
  it('throws for a type the manifest does not declare, and for a non-function', () => {
    const { provider } = setup()
    expect(() => provider.slots.onOpen('other', () => {})).toThrow('not declared in plugin.json contributes.slots')
    expect(() => provider.slots.onOpen('agenda', 5 as unknown as () => void)).toThrow('needs a function')
  })

  it('hands the listener the frame with a copy of host and params', () => {
    const { contexts, provider } = setup()
    const seen: SlotInstance[] = []
    provider.slots.onOpen('agenda', (s) => seen.push(s))
    expect(openFrame(contexts, TAG).attached).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ id: 's1', type: 'agenda', host: TAG.host, params: { days: 2 } })
    expect(Object.isFrozen(seen[0])).toBe(true)
  })

  it('closes the port of a plugin that is not here or does not provide the type', () => {
    const { contexts } = setup()
    const gone = openFrame(contexts, { ...TAG, pluginId: 'p.none' })
    expect(gone.attached).toBe(false)
    expect(gone.port.closed).toBe(true)
    const wrong = openFrame(contexts, { ...TAG, type: 'chart' })
    expect(wrong.attached).toBe(false)
    expect(wrong.port.closed).toBe(true)
    // The inbox places slots but provides none.
    const placer = openFrame(contexts, { ...TAG, pluginId: 'p.inbox' })
    expect(placer.attached).toBe(false)
  })

  it('routes post both ways with the panel message rules', async () => {
    const { contexts, provider, logs } = setup()
    let slot!: SlotInstance
    provider.slots.onOpen('agenda', (s) => (slot = s))
    const { page } = openFrame(contexts, TAG)
    const heard: unknown[] = []
    const off = slot.onMessage((m) => heard.push(m))
    const atPage: unknown[] = []
    page.onMessage((m) => atPage.push(m))
    slot.post({ hello: 1 })
    await flush()
    expect(atPage).toEqual(['{"hello":1}'])
    expect(() => slot.post('x'.repeat(1024 * 1024 + 1))).toThrow(RangeError)
    expect(() => slot.post(undefined as never)).toThrow('not JSON')
    page.postMessage('{"from":"page"}')
    await flush()
    expect(heard).toEqual([{ from: 'page' }])
    // Junk from the page is dropped and logged; a disposed listener hears nothing.
    page.postMessage('not json')
    await flush()
    expect(heard).toHaveLength(1)
    expect(logs.some((l) => l.text.includes('not JSON'))).toBe(true)
    off()
    page.postMessage('{"again":1}')
    await flush()
    expect(heard).toHaveLength(1)
    expect(() => slot.onMessage(1 as never)).toThrow('needs a function')
  })

  it('ends the frame on main\'s slot.close: onClose runs once, the port closes, post is a no-op', async () => {
    const { contexts, provider } = setup()
    let slot!: SlotInstance
    provider.slots.onOpen('agenda', (s) => (slot = s))
    const { page, port } = openFrame(contexts, TAG)
    let closed = 0
    slot.onClose(() => closed++)
    contexts.handleEvent('slot.close', { pluginId: 'p.cal', id: 's1' })
    contexts.handleEvent('slot.close', { pluginId: 'p.cal', id: 's1' })
    expect(closed).toBe(1)
    expect(port.closed).toBe(true)
    const atPage: unknown[] = []
    page.onMessage((m) => atPage.push(m))
    slot.post({ late: 1 })
    await flush()
    expect(atPage).toEqual([])
    // A listener added after the end is still told, so late cleanup runs.
    let late = 0
    slot.onClose(() => late++)
    await flush()
    expect(late).toBe(1)
  })

  it('ends only its own frame when the page\'s port closes, and a reconnect of an id closes the old frame', () => {
    const { contexts, provider } = setup()
    const slots: SlotInstance[] = []
    provider.slots.onOpen('agenda', (s) => slots.push(s))
    const first = openFrame(contexts, TAG)
    let firstClosed = 0
    slots[0]!.onClose(() => firstClosed++)
    const second = openFrame(contexts, TAG)
    expect(firstClosed).toBe(1)
    expect(first.port.closed).toBe(true)
    // The old port's late close must not take the new frame down.
    contexts.detachSlotPort('p.cal', 's1', first.port)
    let secondClosed = 0
    slots[1]!.onClose(() => secondClosed++)
    contexts.detachSlotPort('p.cal', 's1', first.port)
    expect(secondClosed).toBe(0)
    contexts.detachSlotPort('p.cal', 's1', second.port)
    expect(secondClosed).toBe(1)
  })

  it('a throwing onOpen or onClose listener is logged and does not stop the others', () => {
    const { contexts, provider, logs } = setup()
    const order: string[] = []
    provider.slots.onOpen('agenda', () => {
      throw new Error('boom')
    })
    provider.slots.onOpen('agenda', (s) => {
      order.push('second')
      s.onClose(() => {
        throw new Error('bye')
      })
      s.onClose(() => order.push('closed'))
    })
    openFrame(contexts, TAG)
    contexts.handleEvent('slot.close', { pluginId: 'p.cal', id: 's1' })
    expect(order).toEqual(['second', 'closed'])
    expect(logs.map((l) => l.text).join('\n')).toContain('slots.onOpen listener threw: boom')
    expect(logs.map((l) => l.text).join('\n')).toContain('onClose listener threw: bye')
  })

  it('a disposed onOpen listener hears nothing; dispose of the plugin closes its frames', () => {
    const { contexts, provider } = setup()
    let n = 0
    const off = provider.slots.onOpen('agenda', () => n++)
    off()
    openFrame(contexts, TAG)
    expect(n).toBe(0)
    let slot!: SlotInstance
    provider.slots.onOpen('agenda', (s) => (slot = s))
    const { port } = openFrame(contexts, { ...TAG, id: 's2' })
    let closed = 0
    slot.onClose(() => closed++)
    contexts.dispose('p.cal')
    expect(closed).toBe(1)
    expect(port.closed).toBe(true)
  })
})

describe('slotOpenTag', () => {
  it('accepts main\'s tag and refuses malformed ones', () => {
    expect(slotOpenTag(JSON.stringify({ slotOpen: TAG }))).toEqual(TAG)
    expect(slotOpenTag(JSON.stringify({ slotOpen: { ...TAG, host: { kind: 'app', place: 'top-bar' }, params: undefined } }))).toMatchObject({
      host: { kind: 'app', place: 'top-bar' }
    })
    expect(slotOpenTag(JSON.stringify({ panelPort: { pluginId: 'a', panelId: 'b' } }))).toBeUndefined()
    expect(slotOpenTag(JSON.stringify({ slotOpen: { ...TAG, id: '../x' } }))).toBeUndefined()
    expect(slotOpenTag(JSON.stringify({ slotOpen: { ...TAG, type: 'Bad Type' } }))).toBeUndefined()
    expect(slotOpenTag(JSON.stringify({ slotOpen: { ...TAG, host: { kind: 'app', place: 'sidebar' } } }))).toBeUndefined()
    expect(slotOpenTag('{')).toBeUndefined()
    expect(slotOpenTag(5)).toBeUndefined()
    expect(slotOpenTag('x'.repeat(40_000))).toBeUndefined()
  })
})

describe('ctx.slots.available', () => {
  it('asks main, naming the plugin, and resolves its boolean', async () => {
    const { provider, placer, calls } = setup((c) => c.method === 'slots.available')
    await expect(placer.slots.available('agenda')).resolves.toBe(true)
    expect(calls).toEqual([{ method: 'slots.available', params: { pluginId: 'p.inbox', type: 'agenda' } }])
    await expect(provider.slots.available('Bad')).rejects.toThrow('type must match')
    expect(calls).toHaveLength(1)
  })

  it('is false for anything but true from main', async () => {
    const { placer } = setup(() => 'yes')
    await expect(placer.slots.available('agenda')).resolves.toBe(false)
  })
})

describe('ctx.panels.slots', () => {
  const placement = { type: 'agenda', position: 'top' as const, height: 120 }

  it('sends the checked copy to main and tells main to clear at dispose', async () => {
    const { contexts, placer, calls, emitted } = setup()
    placer.panels.slots('main', [{ ...placement, height: 9999.4, params: { a: [1] } }])
    await flush()
    expect(calls).toEqual([
      { method: 'panels.slots', params: { pluginId: 'p.inbox', panelId: 'main', placements: [{ type: 'agenda', position: 'top', height: 600, params: { a: [1] } }] } }
    ])
    placer.panels.slots('main', null)
    expect(calls[1]).toEqual({ method: 'panels.slots', params: { pluginId: 'p.inbox', panelId: 'main', placements: null } })
    contexts.dispose('p.inbox')
    expect(emitted).toEqual([{ event: 'plugin.disposed', params: { pluginId: 'p.inbox' } }])
  })

  it('throws at the call site for what main would refuse', () => {
    const { placer, calls } = setup()
    expect(() => placer.panels.slots('nope', [])).toThrow('not declared')
    expect(() => placer.panels.slots('main', [{ ...placement, type: 'chart' }])).toThrow('does not list slot "chart"')
    expect(() => placer.panels.slots('main', [{ ...placement, type: 'sessions-strip' }])).toThrow('placed by the app')
    expect(() => placer.panels.slots('main', [{ ...placement, position: 'left' as never }])).toThrow('position')
    expect(() => placer.panels.slots('main', [{ ...placement, height: 'tall' as never }])).toThrow('height')
    expect(() => placer.panels.slots('main', Array(5).fill(placement))).toThrow('at most 4')
    expect(() => placer.panels.slots('main', [{ ...placement, params: 'x'.repeat(5000) }])).toThrow('4096')
    expect(() => placer.panels.slots('main', 'x' as never)).toThrow('array or null')
    expect(calls).toEqual([])
  })

  it('logs a refusal from main instead of throwing', async () => {
    const { placer, logs } = setup(() => {
      throw new Error('no panel')
    })
    placer.panels.slots('main', [placement])
    await flush()
    expect(logs.some((l) => l.level === 'error' && l.text.includes('panels.slots main: no panel'))).toBe(true)
  })

  it('is refused after the plugin is deactivated', () => {
    const { contexts, placer } = setup()
    contexts.dispose('p.inbox')
    expect(() => placer.panels.slots('main', null)).toThrow('deactivated')
  })
})
