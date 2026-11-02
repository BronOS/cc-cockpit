// Request/response and one-way events between main and a plugin host (plan: Technical Details ›
// Plugin host RPC). The same class runs on both ends: main talks to the utilityProcess it spawned,
// the host talks to its parent port.
//
//   request   { "id": n, "method": string, "params"?: any }
//   response  { "id": n, "result"?: any }  |  { "id": n, "error": string }
//   event     { "event": string, "params"?: any }
//
// Every message travels as ONE JSON string, never as a structured-clone object: the size cap is
// then a plain length check (the same 1 MiB as the CLI socket), nothing exotic (functions, Maps,
// cyclic graphs) can cross, and a later transfer list (Task 28 hands out MessagePorts) still works
// next to a string.
//
// Identity is NOT in the messages. On main's side one endpoint exists per host process, and its
// handlers close over the project main spawned that process for; a host can name any project or
// tab id it likes in `params`, it is only ever looked up inside that scope (CLAUDE.md: main is the
// only authority).
//
// Untrusted input on main's side (a plugin runs in the host and can post anything on its port):
// every message is size-capped, parsed, shape-checked, and an unknown method gets an error reply.
// Nothing here throws on bad input; it is dropped (and logged) or answered with an error.
//
// Pure Node, no Electron import: unit tests drive it over an in-memory port pair.

import { errorText, toError } from '../shared/error-text'

/** The longest message accepted or sent, in UTF-16 code units of its JSON (~1 MiB). */
export const MAX_RPC_MESSAGE_LENGTH = 1024 * 1024

/** Default per-call timeout. Callers that wait on plugin code (activate) pass their own. */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000

const MAX_METHOD_LENGTH = 100

/** One end of a message channel: what main's utilityProcess and the host's parentPort both offer. */
export interface RpcPort {
  postMessage(message: string): void
  /** Subscribe to incoming messages; returns an unsubscribe. */
  onMessage(listener: (message: unknown) => void): () => void
}

export type RpcHandler = (params: unknown) => unknown

export interface RpcEndpointOptions {
  port: RpcPort
  /** Methods the other end may call. Anything else is answered with `unknown method`. */
  handlers?: Record<string, RpcHandler>
  /** One-way events from the other end. Unknown event names are the receiver's to ignore. */
  onEvent?: (event: string, params: unknown) => void
  defaultTimeoutMs?: number
  maxMessageLength?: number
  log?: (message: string) => void
}

/** A call failed on the other end (its handler threw), or the method does not exist there. */
export class RpcRemoteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RpcRemoteError'
  }
}

/** No answer in time. The other end may still run the call; its late answer is dropped. */
export class RpcTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`${method}: no answer within ${ms} ms`)
    this.name = 'RpcTimeoutError'
  }
}

/** The caller gave up on the call (its `signal` aborted). The other end may still run it. */
export class RpcAbortedError extends Error {
  constructor(method: string) {
    super(`${method}: abandoned by the caller`)
    this.name = 'RpcAbortedError'
  }
}

/** The endpoint was closed (the process exited, the window closed) before the answer came. */
export class RpcClosedError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'RpcClosedError'
  }
}

type Incoming =
  | { kind: 'request'; id: number; method: string; params: unknown }
  | { kind: 'response'; id: number; ok: true; result: unknown }
  | { kind: 'response'; id: number; ok: false; error: string }
  | { kind: 'event'; event: string; params: unknown }

/**
 * Parse and shape-check one raw message. A string reason when it is not something this protocol
 * sends; the reason is logged, never echoed back (a malformed message has no usable id).
 */
export function parseRpcMessage(raw: unknown, maxLength = MAX_RPC_MESSAGE_LENGTH): Incoming | string {
  if (typeof raw !== 'string') return 'not a string'
  if (raw.length > maxLength) return `message of ${raw.length} chars exceeds ${maxLength}`
  let msg: unknown
  try {
    msg = JSON.parse(raw)
  } catch {
    return 'not JSON'
  }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return 'not an object'
  const m = msg as Record<string, unknown>
  if ('event' in m) {
    if (!isName(m.event)) return 'bad event name'
    return { kind: 'event', event: m.event, params: m.params }
  }
  if (!Number.isSafeInteger(m.id) || (m.id as number) < 1) return 'bad id'
  const id = m.id as number
  if ('method' in m) {
    if (!isName(m.method)) return 'bad method name'
    return { kind: 'request', id, method: m.method, params: m.params }
  }
  // A response carries `id` and exactly one of `result`/`error`; anything else ({ id, foo }, or
  // both result and error) is not something this protocol sends and must not settle call `id`.
  // Shape hygiene only: a plugin able to post on the port can forge a well-formed answer too.
  const extra = Object.keys(m).filter((k) => k !== 'id' && k !== 'result' && k !== 'error')
  if (extra.length > 0 || ('error' in m && 'result' in m)) return 'bad response'
  if ('error' in m) {
    if (typeof m.error !== 'string') return 'bad error'
    return { kind: 'response', id, ok: false, error: m.error.slice(0, 2000) }
  }
  // A handler that returned undefined answers `{ id }`: JSON drops an undefined `result`.
  return { kind: 'response', id, ok: true, result: m.result }
}

function isName(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_METHOD_LENGTH
}

interface Pending {
  method: string
  resolve(value: unknown): void
  reject(err: Error): void
  /** Undefined for a call made with `timeoutMs: Infinity` (no timer at all). */
  timer: ReturnType<typeof setTimeout> | undefined
}

export class RpcEndpoint {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly handlers: Map<string, RpcHandler>
  private readonly unsubscribe: () => void
  private readonly defaultTimeoutMs: number
  private readonly maxLength: number
  private readonly log: (message: string) => void
  private closedReason: string | undefined

  constructor(private readonly options: RpcEndpointOptions) {
    // A Map, not the object: a method named `__proto__` or `toString` must not reach a prototype.
    this.handlers = new Map(Object.entries(options.handlers ?? {}))
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
    this.maxLength = options.maxMessageLength ?? MAX_RPC_MESSAGE_LENGTH
    this.log = options.log ?? ((m) => console.warn(m))
    this.unsubscribe = options.port.onMessage((raw) => this.receive(raw))
  }

  get closed(): boolean {
    return this.closedReason !== undefined
  }

  /** Calls waiting for an answer (tests: nothing is left behind). */
  get pendingCalls(): number {
    return this.pending.size
  }

  /**
   * Call `method` on the other end. Rejects on a remote error, a timeout or close. `timeoutMs:
   * Infinity` waits for as long as the endpoint is open (ctx.overlay.open: the user decides when
   * an overlay ends); only `close` or `signal` ends such a call. An aborted `signal` drops the
   * pending entry and rejects with RpcAbortedError: a caller that answered by other means (runCli's
   * own timer) must not leave the entry behind for the life of the endpoint when the other end
   * never answers (a handler stuck in a loop blocks the host's event loop, so not even its
   * `cli.cancel` gets through).
   */
  call(method: string, params?: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.closedReason !== undefined) return Promise.reject(new RpcClosedError(this.closedReason))
    const { signal } = options
    if (signal?.aborted) return Promise.reject(new RpcAbortedError(method))
    const id = this.nextId++
    let text: string
    try {
      text = this.encode({ id, method, params })
    } catch (err) {
      return Promise.reject(toError(err))
    }
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    return new Promise((settleResolve, settleReject) => {
      // Every way out (answer, timeout, close, abort) goes through these two, so the abort
      // listener never outlives the call on a signal that lives longer than it.
      const onAbort = (): void => {
        if (this.pending.get(id) !== entry) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new RpcAbortedError(method))
      }
      const resolve = (value: unknown): void => {
        signal?.removeEventListener('abort', onAbort)
        settleResolve(value)
      }
      const reject = (err: Error): void => {
        signal?.removeEventListener('abort', onAbort)
        settleReject(err)
      }
      // No timer for Infinity: Node clamps a delay above 2^31-1 ms to 1 ms (TimeoutOverflowWarning),
      // so `setTimeout(fn, Infinity)` would time the call out at once.
      const timer =
        timeoutMs === Infinity
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id)
              reject(new RpcTimeoutError(method, timeoutMs))
            }, timeoutMs)
      const entry: Pending = { method, resolve, reject, timer }
      this.pending.set(id, entry)
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        this.options.port.postMessage(text)
      } catch (err) {
        // A port torn down between the closed check and here (the process just exited).
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new RpcClosedError(`cannot send ${method}: ${errorText(err)}`))
      }
    })
  }

  /** Fire-and-forget event. Dropped (and logged) when closed or too large. */
  emit(event: string, params?: unknown): void {
    if (this.closedReason !== undefined) return
    try {
      this.options.port.postMessage(this.encode({ event, params }))
    } catch (err) {
      this.log(`rpc: event ${event} not sent: ${errorText(err)}`)
    }
  }

  /**
   * Stop: every pending call rejects with `reason`, later calls reject at once, and incoming
   * messages are ignored (a late answer has nobody waiting). Idempotent.
   */
  close(reason = 'rpc closed'): void {
    if (this.closedReason !== undefined) return
    this.closedReason = reason
    this.unsubscribe()
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      this.pending.delete(id)
      p.reject(new RpcClosedError(`${p.method}: ${reason}`))
    }
  }

  /** JSON-encode and size-check an outgoing message (throws on either failing). */
  private encode(message: object): string {
    const text = JSON.stringify(message)
    if (text.length > this.maxLength) {
      throw new Error(`message of ${text.length} chars exceeds ${this.maxLength}`)
    }
    return text
  }

  private receive(raw: unknown): void {
    if (this.closedReason !== undefined) return
    const msg = parseRpcMessage(raw, this.maxLength)
    if (typeof msg === 'string') {
      this.log(`rpc: dropped a message: ${msg}`)
      return
    }
    switch (msg.kind) {
      case 'event':
        try {
          this.options.onEvent?.(msg.event, msg.params)
        } catch (err) {
          this.log(`rpc: event ${msg.event} handler failed: ${errorText(err)}`)
        }
        return
      case 'response': {
        const p = this.pending.get(msg.id)
        // Late (timed out) or never asked: nothing to settle.
        if (!p) return
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new RpcRemoteError(msg.error))
        return
      }
      case 'request':
        void this.answer(msg.id, msg.method, msg.params)
        return
    }
  }

  private async answer(id: number, method: string, params: unknown): Promise<void> {
    const handler = this.handlers.get(method)
    let reply: object
    if (!handler) {
      reply = { id, error: `unknown method: ${method}` }
    } else {
      try {
        reply = { id, result: await handler(params) }
      } catch (err) {
        reply = { id, error: errorText(err) }
      }
    }
    if (this.closedReason !== undefined) return
    let text: string
    try {
      text = this.encode(reply)
    } catch (err) {
      // The result was too large or not JSON-able: the caller still gets an answer.
      text = JSON.stringify({ id, error: `${method}: result not sent: ${errorText(err)}` })
    }
    try {
      this.options.port.postMessage(text)
    } catch (err) {
      this.log(`rpc: reply to ${method} not sent: ${errorText(err)}`)
    }
  }
}
