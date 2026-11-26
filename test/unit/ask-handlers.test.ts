// 00 contract: the Ask channels are registered and refuse every call until their task fills them (S2: no service
// means refused, never a silent success), for the owner's desktop page as for anyone.
import { describe, expect, it } from 'vitest'
import { IpcRouter, type IpcEventLike, type IpcMainLike } from '../../src/main/ipc/router'
import { ASK_CHANNELS, registerAskHandlers } from '../../src/main/ipc/ask-handlers'
import type { SenderContext } from '../../src/main/windows/window-manager'

const APP_PAGE = 'file:///opt/cc-cockpit/out/renderer/index.html'
type Listener = (event: IpcEventLike, ...args: unknown[]) => unknown

class FakeIpcMain implements IpcMainLike {
  readonly handlers = new Map<string, Listener>()
  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener)
  }
  invoke(channel: string, senderId: number, payload: unknown): Promise<unknown> {
    const listener = this.handlers.get(channel)
    if (!listener) return Promise.reject(new Error(`no handler for ${channel}`))
    return Promise.resolve().then(() => listener({ sender: { id: senderId }, senderFrame: { parent: null, url: APP_PAGE } }, payload))
  }
}

describe('Ask handlers (00 contract stub)', () => {
  it('the stub refuses every call', async () => {
    const ipc = new FakeIpcMain()
    const senders = new Map<number, SenderContext>([[11, { kind: 'project', windowId: 1, projectId: 'aaaaaaaaaaaaaaaa' }]])
    const router = new IpcRouter(ipc, (id) => senders.get(id), (url) => url === APP_PAGE, () => undefined, () => true)
    const overlays = { copyOwner: () => 'desktop:1', notesOf: () => ({ pluginId: 'a.one', key: 'k' }) }
    registerAskHandlers(router, { overlays } as never)
    const payloads: Record<string, unknown> = {
      'overlays.ask.start': { overlayId: 'o1', copy: 'c1', question: 'why?' },
      'overlays.ask.say': { overlayId: 'o1', copy: 'c1', question: 'and?' },
      'overlays.ask.close': { overlayId: 'o1', copy: 'c1' },
      'overlays.ask.pick': { overlayId: 'o1', copy: 'c1' },
      'overlays.ask.continue': { overlayId: 'o1', copy: 'c1' }
    }
    for (const channel of ASK_CHANNELS) {
      expect(ipc.handlers.has(channel), channel).toBe(true)
      await expect(ipc.invoke(channel, 11, payloads[channel]), channel).rejects.toThrow(/refused \(Ask is not available/)
    }
  })
})
