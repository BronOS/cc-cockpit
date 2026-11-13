// One plugin-side line to a page the shell draws (a slot frame, a settings page, a page tab frame):
// the port main handed this host, the instance's post / onMessage / onClose, and the end. The three
// hubs (slots.ts, settings-page.ts, tabs.ts) keep only their keying (per view, per plugin) and what
// is theirs (a page tab's onDiscuss); the port rules are here once, so a fix lands in all three.
//
// Messages follow the panel rules (host/ctx/ui.ts): ONE JSON string each, the same 1 MiB cap; a page's
// message that is not one is dropped and logged. Listeners run in the line's view (origin-view.ts),
// so what they open or focus shows on the screen the message came from. After the end a post does
// nothing, an onMessage registers nothing, and an onClose is told in a microtask, so a late listener
// still cleans up.
import type { Disposer, JsonValue } from '../../sdk/types'
import { errorText } from '../../shared/error-text'
import type { ViewId } from '../../shared/views'
import { dispatchInView } from './origin-view'
import { decodePortMessage, encodePortMessage, type PanelPort } from './ui'

export type MessageListener = (message: JsonValue) => void

export interface PortLineNames {
  /** What the line is in log lines and errors: `slot`, `settings page`, `page tab`. */
  kind: string
  /** The line's name after "post to" and "from" (`slot <id>`, `the settings page`). */
  who: string
  /** Shown after "post" when a post fails (` to <id>`, or empty). */
  postTo: string
}

export class PortLine {
  private readonly messageListeners = new Set<MessageListener>()
  private readonly closeListeners = new Set<() => void>()
  private readonly unsubscribe: () => void
  private endedNow = false

  constructor(
    readonly port: PanelPort,
    readonly view: ViewId | undefined,
    private readonly names: PortLineNames,
    /** The plugin's log (its id already bound). */
    private readonly log: (message: string) => void,
    /**
     * Run at the end before the close listeners: the hub drops its key and its own handlers, so a
     * close listener already sees the line gone.
     */
    private readonly onEnd: () => void
  ) {
    this.unsubscribe = port.onMessage((raw) => this.receive(raw))
  }

  get ended(): boolean {
    return this.endedNow
  }

  readonly post = (message: JsonValue): void => {
    const text = encodePortMessage(message, `${this.names.kind} post`)
    if (this.endedNow) return
    try {
      this.port.postMessage(text)
    } catch (err) {
      this.log(`${this.names.kind} post${this.names.postTo} failed: ${errorText(err)}`)
    }
  }

  readonly onMessage = (listener: MessageListener): Disposer => {
    if (typeof listener !== 'function') throw new TypeError(`${this.names.kind} onMessage needs a function`)
    if (this.endedNow) return () => {}
    // Wrapped: the same function registered twice is two registrations, each with its disposer.
    const entry: MessageListener = (m) => listener(m)
    this.messageListeners.add(entry)
    return () => {
      this.messageListeners.delete(entry)
    }
  }

  readonly onClose = (listener: () => void): Disposer => {
    if (typeof listener !== 'function') throw new TypeError(`${this.names.kind} onClose needs a function`)
    if (this.endedNow) {
      // Registered after the end: told at once, so a late listener still cleans up.
      queueMicrotask(() => this.safely('onClose', listener))
      return () => {}
    }
    const entry = (): void => listener()
    this.closeListeners.add(entry)
    return () => {
      this.closeListeners.delete(entry)
    }
  }

  /** End the line (once): the port closes, the listeners drop, the close listeners run. */
  end(): void {
    if (this.endedNow) return
    this.endedNow = true
    this.onEnd()
    this.unsubscribe()
    try {
      this.port.close()
    } catch {
      // Already closed on the other side.
    }
    const closers = [...this.closeListeners]
    this.messageListeners.clear()
    this.closeListeners.clear()
    for (const listener of closers) this.safely('onClose', listener)
  }

  private safely(what: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.log(`a ${this.names.kind} ${what} listener threw: ${errorText(err)}`)
    }
  }

  /** A message from the page: a JSON string within the cap, else dropped (logged). */
  private receive(raw: unknown): void {
    const got = decodePortMessage(raw)
    if (!got.ok) {
      this.log(`dropped a message from ${this.names.who}: ${got.reason === 'size' ? 'not a JSON string within the size cap' : 'not JSON'}`)
      return
    }
    for (const listener of [...this.messageListeners]) {
      this.safely('onMessage', () =>
        dispatchInView(
          this.view,
          () => listener(structuredClone(got.value)),
          (err) => this.log(`a ${this.names.kind} onMessage listener failed: ${errorText(err)}`)
        )
      )
    }
  }
}
