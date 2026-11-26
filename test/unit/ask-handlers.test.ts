// Task 02 (ask-handlers.ts): who may Ask, as the router bound the caller. "The person" is isOwner(view), never
// view.remote; a guest Asks only with write access bound to the call; continue is the owner's alone.
import { describe, expect, it } from 'vitest'
import { ASK_CHANNELS, askPersonOf, registerAskHandlers } from '../../src/main/ipc/ask-handlers'
import type { AskApi, AskCaller } from '../../src/main/ask/ask-api'
import type { CallView, IpcRouter } from '../../src/main/ipc/router'

const ctx = { windowId: 1, projectId: 'aaaaaaaaaaaaaaaa' }
const ownerView = { viewId: 'desktop:1', who: 'owner', remote: false } as unknown as CallView
const ownerBrowser = { viewId: 'remote:o', who: 'owner', remote: true } as unknown as CallView
const writeGuest = { viewId: 'remote:w', who: { guest: 'g1' }, remote: true, access: { kind: 'guest', id: 'g1', role: 'write' } } as unknown as CallView
const readGuest = { viewId: 'remote:r', who: { guest: 'g2' }, remote: true, access: { kind: 'guest', id: 'g2', role: 'read' } } as unknown as CallView
const unbound = { viewId: 'remote:u', who: { guest: 'g3' }, remote: true } as unknown as CallView
const noWho = { viewId: 'remote:n', remote: true } as unknown as CallView

function wired(asks?: Partial<AskApi>): { handlers: Map<string, (c: typeof ctx, p: unknown, v: CallView) => unknown>; calls: { method: string; who: AskCaller }[] } {
  const handlers = new Map<string, (c: typeof ctx, p: unknown, v: CallView) => unknown>()
  const calls: { method: string; who: AskCaller }[] = []
  const router = { handleProject: (channel: string, fn: never) => handlers.set(channel, fn) } as unknown as IpcRouter
  const record = (method: string) => (who: AskCaller) => {
    calls.push({ method, who })
    return method === 'pick' ? { models: [], efforts: [] } : method === 'continueInTab' ? Promise.resolve({ tabId: 't' }) : method === 'close' ? null : Promise.resolve(null)
  }
  const api = asks === undefined ? undefined : ({ start: record('start'), say: record('say'), close: record('close'), pick: record('pick'), continueInTab: record('continueInTab'), ...asks } as unknown as AskApi)
  registerAskHandlers(router, { asks: api })
  return { handlers, calls }
}

describe('Ask handlers', () => {
  it('anything not isOwner(view) gets the guest argv: an owner browser is the owner, a write guest a guest (the argv itself: ask-service.test.ts)', () => {
    expect(askPersonOf(ownerView, 'c')).toBe('owner')
    expect(askPersonOf(ownerBrowser, 'c')).toBe('owner')
    expect(askPersonOf(writeGuest, 'c')).toEqual({ guest: 'g1' })
  })

  it("a read guest's start is refused; a view with no who or no bound access is refused (fail closed)", async () => {
    expect(askPersonOf(readGuest, 'c')).toBeUndefined()
    expect(() => askPersonOf(unbound, 'c')).toThrow(/refused/)
    expect(() => askPersonOf(noWho, 'c')).toThrow(/refused/)
    const { handlers, calls } = wired({})
    const start = handlers.get('overlays.ask.start')!
    await expect(Promise.resolve().then(() => start(ctx, {}, readGuest))).rejects.toThrow(/refused/)
    await expect(Promise.resolve().then(() => start(ctx, {}, noWho))).rejects.toThrow(/refused/)
    expect(calls).toEqual([])
    await start(ctx, { overlayId: 'o', copy: 'c', question: 'q' }, writeGuest)
    expect(calls).toEqual([{ method: 'start', who: { windowId: 1, projectId: ctx.projectId, view: 'remote:w', person: { guest: 'g1' } } }])
  })

  it('continue is the owner alone; every channel is refused with no service', async () => {
    const { handlers, calls } = wired({})
    await expect(Promise.resolve().then(() => handlers.get('overlays.ask.continue')!(ctx, {}, writeGuest))).rejects.toThrow(/refused/)
    expect(calls).toEqual([])
    expect(await handlers.get('overlays.ask.continue')!(ctx, {}, ownerBrowser)).toEqual({ tabId: 't' })
    const none = wired(undefined)
    for (const channel of ASK_CHANNELS) {
      await expect(Promise.resolve().then(() => none.handlers.get(channel)!(ctx, {}, ownerView)), channel).rejects.toThrow(/not available/)
    }
  })
})
