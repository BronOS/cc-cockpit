// An in-memory message channel for RPC tests: two RpcPorts wired to each other. Delivery is
// asynchronous (a microtask, never a timer, so fake timers do not hold messages back), like a real
// port, and `sent` records what each side posted.
import type { RpcPort } from '../../src/host/rpc'

export interface MemoryPort extends RpcPort {
  /** Every raw message this side posted, oldest first. */
  sent: string[]
  /** Deliver `message` to this side's listeners as if the other side had posted it. */
  inject(message: unknown): void
}

class Side implements MemoryPort {
  readonly sent: string[] = []
  readonly listeners = new Set<(m: unknown) => void>()
  peer: Side | undefined

  postMessage(message: string): void {
    this.sent.push(message)
    this.peer?.inject(message)
  }

  onMessage(listener: (m: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  inject(message: unknown): void {
    queueMicrotask(() => {
      for (const l of [...this.listeners]) l(message)
    })
  }
}

export function memoryPortPair(): [MemoryPort, MemoryPort] {
  const a = new Side()
  const b = new Side()
  a.peer = b
  b.peer = a
  return [a, b]
}
