// The terminal mirror's worker (terminals/mirror-worker.ts HeadlessTerms) in-process, behind the
// MirrorWorkerLike interface main uses: messages both ways are structured-cloned and delivered on a
// later turn, as worker_threads would. `crash` ends it as a dying thread does.
import type { MirrorWorkerLike } from '../../src/main/terminals/mirror'
import type { FromWorker, MirrorItem, ToWorker } from '../../src/main/terminals/mirror-protocol'
import { HeadlessTerms, type HeadlessTermsOptions } from '../../src/main/terminals/mirror-worker'

/** HeadlessTerms behind the worker interface; both directions are delivered on a later turn. */
export class FakeWorker implements MirrorWorkerLike {
  readonly received: ToWorker[] = []
  readonly terms: HeadlessTerms
  terminated = false
  private readonly listeners: Array<(m: FromWorker) => void> = []
  private readonly exitListeners: Array<(reason: string) => void> = []

  constructor(options: HeadlessTermsOptions = {}) {
    this.terms = new HeadlessTerms((m) => setImmediate(() => this.listeners.forEach((l) => l(m))), options)
  }

  post(message: ToWorker): void {
    // Structured clone, as postMessage does: the worker never shares main's objects.
    const copy = structuredClone(message)
    this.received.push(copy)
    setImmediate(() => {
      if (!this.terminated) this.terms.handle(copy)
    })
  }

  onMessage(listener: (m: FromWorker) => void): void {
    this.listeners.push(listener)
  }

  onExit(listener: (reason: string) => void): void {
    this.exitListeners.push(listener)
  }

  terminate(): void {
    this.terminated = true
    this.terms.dispose()
  }

  /** The thread died on its own. */
  crash(reason = 'exit code 1'): void {
    this.terminated = true
    this.terms.dispose()
    for (const l of this.exitListeners) l(reason)
  }

  items(tabId?: string): MirrorItem[] {
    return this.received.flatMap((m) => (m.t === 'item' && (tabId === undefined || m.tabId === tabId) ? [m.item] : []))
  }
}

