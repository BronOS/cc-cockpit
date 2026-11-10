// A MessagePortMain stand-in for main's port code (panel-ports.ts, the web gateway's relay): two
// entangled ends that queue until start(), deliver asynchronously and tell the peer on close.
import type { MainPortLike } from '../../src/host/ctx/ui'

/** One end of an entangled pair, like MessagePortMain: queues until start(), tells the peer on close. */
export class FakePort implements MainPortLike {
  peer: FakePort | undefined
  started = false
  closed = false
  readonly name: string
  private readonly queued: unknown[] = []
  private readonly messageListeners = new Set<(e: { data: unknown }) => void>()
  private readonly closeListeners = new Set<() => void>()

  constructor(name: string) {
    this.name = name
  }

  postMessage(message: unknown): void {
    if (this.closed) return
    this.peer?.arrive(message)
  }

  on(event: 'message' | 'close', listener: ((e: { data: unknown }) => void) | (() => void)): this {
    if (event === 'message') this.messageListeners.add(listener as (e: { data: unknown }) => void)
    else this.closeListeners.add(listener as () => void)
    return this
  }

  off(_event: 'message', listener: (e: { data: unknown }) => void): this {
    this.messageListeners.delete(listener)
    return this
  }

  start(): void {
    this.started = true
    for (const m of this.queued.splice(0)) this.dispatch(m)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const peer = this.peer
    if (peer && !peer.closed) {
      peer.closed = true
      for (const l of [...peer.closeListeners]) l()
    }
  }

  private arrive(message: unknown): void {
    if (this.closed) return
    if (this.started) this.dispatch(message)
    else this.queued.push(message)
  }

  private dispatch(message: unknown): void {
    queueMicrotask(() => {
      for (const l of [...this.messageListeners]) l({ data: message })
    })
  }
}

/** A fresh entangled pair, named `host<n>` / `renderer<n>`. */
export function channel(n: number): { host: FakePort; renderer: FakePort } {
  const host = new FakePort(`host${n}`)
  const renderer = new FakePort(`renderer${n}`)
  host.peer = renderer
  renderer.peer = host
  return { host, renderer }
}
