// 00 contract: the notes channels are registered and refuse every call until their task fills them (S2: no service
// means refused, never a silent success), for the owner's desktop page as for anyone.
import { describe, expect, it } from 'vitest'
import { IpcRouter, type IpcEventLike, type IpcMainLike } from '../../src/main/ipc/router'
import { NOTES_CHANNELS, registerNotesHandlers } from '../../src/main/ipc/notes-handlers'
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

describe('notes handlers (00 contract stub)', () => {
  it('the stub refuses every call', async () => {
    const ipc = new FakeIpcMain()
    const senders = new Map<number, SenderContext>([[11, { kind: 'project', windowId: 1, projectId: 'aaaaaaaaaaaaaaaa' }]])
    const router = new IpcRouter(ipc, (id) => senders.get(id), (url) => url === APP_PAGE, () => undefined, () => true)
    const overlays = { copyOwner: () => 'desktop:1', notesOf: () => ({ pluginId: 'a.one', key: 'k' }) }
    registerNotesHandlers(router, { overlays, authorOf: () => ({ access: 'owner' }) } as never)
    const payloads: Record<string, unknown> = {
      'overlays.notes.read': { overlayId: 'o1', copy: 'c1' },
      'overlays.notes.write': { overlayId: 'o1', copy: 'c1', op: 'setGlobal', text: 'x' }
    }
    for (const channel of NOTES_CHANNELS) {
      expect(ipc.handlers.has(channel), channel).toBe(true)
      await expect(ipc.invoke(channel, 11, payloads[channel]), channel).rejects.toThrow(/refused \(notes are not available/)
    }
  })
})
