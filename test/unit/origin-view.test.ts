// The origin view in the plugin host (design-web.md §5.3 "Where an action came from"): a page
// message's listener runs in its view, the RPC calls it makes carry the view to main, and the view
// is bounded to the listener's own work (a timer it starts gets none).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostContexts, type ContextDeps } from '../../src/host/ctx'
import { carryView, currentView, dispatchInView, DISPATCH_VIEW_MS } from '../../src/host/ctx/origin-view'
import { slotOpenTag } from '../../src/host/ctx/slots'
import type { PanelPort } from '../../src/host/ctx/ui'
import { RpcEndpoint, type RpcCallOptions, type RpcMeta } from '../../src/host/rpc'
import { hostSpec } from '../fakes/host-spec'
import { memoryPortPair, type MemoryPort } from '../fakes/memory-port'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
const later = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => {
  vi.useRealTimers()
})

describe('dispatchInView', () => {
  it('gives a synchronous listener its view, and nothing outside a dispatch', () => {
    expect(currentView()).toBeUndefined()
    let seen: string | undefined = 'unset'
    dispatchInView('web:1', () => {
      seen = currentView()
    })
    expect(seen).toBe('web:1')
    expect(currentView()).toBeUndefined()
    // The desktop window's page: no view, even inside a dispatch.
    dispatchInView(undefined, () => {
      seen = currentView()
    })
    expect(seen).toBeUndefined()
  })

  it("follows an async listener's awaits until it settles", async () => {
    const seen: (string | undefined)[] = []
    const done = dispatchInView('web:2', async () => {
      await Promise.resolve()
      seen.push(currentView())
      await later(5)
      seen.push(currentView())
    })
    await done
    expect(seen).toEqual(['web:2', 'web:2'])
  })

  it('gives a timer started inside a listener no view once the listener ended', async () => {
    const seen: (string | undefined)[] = []
    // A synchronous listener that starts an interval (a panel's `hello` starting a poll).
    let timer: ReturnType<typeof setInterval> | undefined
    dispatchInView('web:3', () => {
      timer = setInterval(() => seen.push(currentView()), 1)
    })
    await later(10)
    clearInterval(timer)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((v) => v === undefined)).toBe(true)
    // An async listener: a timeout that fires after its promise settled has none either, nor does a
    // promise chain it cached and a later caller awaits.
    let fired: string | undefined = 'unset'
    let cached: Promise<void> | undefined
    await dispatchInView('web:3', async () => {
      setTimeout(() => {
        fired = currentView()
      }, 5)
      cached = later(5)
    })
    await cached!.then(() => {
      fired = fired === 'unset' ? currentView() : fired
    })
    await later(10)
    expect(fired).toBeUndefined()
  })

  it('ends a dispatch that throws or rejects, and passes the error on', async () => {
    let inside: (() => string | undefined) | undefined
    expect(() =>
      dispatchInView('web:4', () => {
        inside = () => currentView()
        throw new Error('boom')
      })
    ).toThrow('boom')
    // The closure kept the store: dead after the throw.
    expect(dispatchInView(undefined, () => inside!())).toBeUndefined()
    const failed: unknown[] = []
    const rejected = dispatchInView(
      'web:4',
      async () => {
        await Promise.resolve()
        throw new Error('late')
      },
      (err) => failed.push(err)
    )
    await expect(rejected).rejects.toThrow('late')
    await flush()
    expect(failed).toEqual([new Error('late')])
  })

  it(`stops carrying the view ${DISPATCH_VIEW_MS} ms after the dispatch, even for a listener that never settles`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const seen: (string | undefined)[] = []
    let poke: (() => void) | undefined
    void dispatchInView('web:5', async () => {
      for (;;) {
        await new Promise<void>((resolve) => {
          poke = resolve
        })
        seen.push(currentView())
      }
    })
    poke!()
    await flush()
    vi.setSystemTime(Date.now() + DISPATCH_VIEW_MS + 1)
    poke!()
    await flush()
    expect(seen).toEqual(['web:5', undefined])
  })
})

describe('carryView', () => {
  it('adds the current view to the options only inside a remote dispatch', async () => {
    const got: (RpcCallOptions | undefined)[] = []
    const call = carryView((_method: string, _params: unknown, options?: RpcCallOptions) => {
      got.push(options)
      return null
    })
    call('m', {}, { timeoutMs: 5 })
    dispatchInView('web:6', () => call('m', {}, { timeoutMs: 5 }))
    dispatchInView('web:6', () => call('m', {}))
    dispatchInView(undefined, () => call('m', {}))
    expect(got).toEqual([{ timeoutMs: 5 }, { timeoutMs: 5, view: 'web:6' }, { view: 'web:6' }, undefined])
  })
})

describe('the RPC envelope', () => {
  it("carries a request's view to main's handler, and drops one main never mints", async () => {
    const [hostPort, mainPort] = memoryPortPair()
    const metas: (RpcMeta | undefined)[] = []
    const main = new RpcEndpoint({ port: mainPort, handlers: { 'sessions.focus': (_p, meta) => (metas.push(meta), true) } })
    const host = new RpcEndpoint({ port: hostPort })
    await host.call('sessions.focus', {}, { view: 'web:7' })
    await host.call('sessions.focus', {})
    // A host (any plugin code) writing its own envelope: only an id main could have minted passes.
    for (const view of ['desktop:1', 'web:0', 'web:x', 5]) {
      hostPort.postMessage(JSON.stringify({ id: 900, method: 'sessions.focus', params: {}, view }))
    }
    await flush()
    expect(metas).toEqual([{ view: 'web:7' }, {}, {}, {}, {}, {}])
    main.close()
    host.close()
  })
})

describe('page listeners in the host', () => {
  interface Call {
    method: string
    options: RpcCallOptions | undefined
  }

  function setup(): { contexts: HostContexts; calls: Call[] } {
    const calls: Call[] = []
    const deps: ContextDeps = {
      log: () => {},
      // The host's real wrapping (host/index.ts): carryView around the RPC call.
      call: carryView(async (method: string, _params: unknown, options?: RpcCallOptions) => {
        calls.push({ method, options })
        return true
      }),
      emit: () => {}
    }
    return { contexts: new HostContexts(deps), calls }
  }

  function pagePort(): { page: MemoryPort; port: PanelPort } {
    const [hostEnd, page] = memoryPortPair()
    return {
      page,
      port: { postMessage: (m) => hostEnd.postMessage(m), onMessage: (l) => hostEnd.onMessage(l), close: () => {} }
    }
  }

  it("runs a panel's onMessage in the view of the page that posted, so its calls act there only", async () => {
    const { contexts, calls } = setup()
    const ctx = contexts.create(hostSpec({ id: 'p.sess', dir: '/p/sess', main: 'h.js', panels: ['main'] }))
    ctx.panels.onMessage('main', async (m) => {
      await Promise.resolve()
      await ctx.sessions.focus((m as { tabId: string }).tabId)
    })
    const desktop = pagePort()
    const phone = pagePort()
    contexts.attachPanelPort('p.sess', 'main', desktop.port)
    contexts.attachPanelPort('p.sess', 'main', phone.port, 'web:8')
    phone.page.postMessage(JSON.stringify({ tabId: 't1' }))
    await flush()
    desktop.page.postMessage(JSON.stringify({ tabId: 't2' }))
    await flush()
    expect(calls.map((c) => c.options?.view)).toEqual(['web:8', undefined])
  })

  it("runs a slot's onMessage in its frame's view (the strip's click, the usage meter's open)", async () => {
    const { contexts, calls } = setup()
    const ctx = contexts.create(hostSpec({ id: 'p.use', dir: '/p/use', main: 'h.js', panels: ['usage'], slotTypes: ['meter'] }))
    ctx.slots.onOpen('meter', (slot) => {
      slot.onMessage(() => {
        void ctx.panels.show('usage')
      })
    })
    const tag = slotOpenTag(
      JSON.stringify({ slotOpen: { pluginId: 'p.use', id: 's1', type: 'meter', host: { kind: 'app', place: 'top-bar' }, view: 'web:9' } })
    )
    const frame = pagePort()
    expect(contexts.attachSlotPort(tag!, frame.port)).toBe(true)
    frame.page.postMessage(JSON.stringify({ type: 'open' }))
    await flush()
    // A timer the plugin started outside any message: no view.
    await ctx.panels.show('usage')
    expect(calls.map((c) => [c.method, c.options?.view])).toEqual([
      ['panels.show', 'web:9'],
      ['panels.show', undefined]
    ])
  })
})
