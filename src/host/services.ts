// Plugin services inside one plugin host (plan: plugin services; design §5): a plugin provides a
// named API with `ctx.services.provide`, others in the same project call it through the handle
// `ctx.services.use` returns.
//
// All plugins of a host share one JS realm with no isolation, so this is a contract, not a security
// boundary: the registry keeps plugins to what their manifests declare and keeps their objects
// apart (data is copied both ways, a provider's error object never reaches the consumer), and that
// is all. Calls are dispatched here, with no round trip to main.
//
// Everything is resolved on every call, never cached in the handle: a host restart, a dev reload,
// an errored provider or a re-`provide` replaces or removes the implementation, and a handle the
// consumer got once in `activate` must keep working across all of them.
//
// Events: the selected provider `emit`s, consumers subscribe with `handle.on`. Subscriptions are
// keyed by consumer, service and event, never by a provider instance, so they survive a provider
// release and re-provide (dev reload, restart of its activate) and a swap to another provider; the
// provider is resolved on every emit, as it is on every call.
//
// The loader owns the registry: it calls `setSpec`/`removeSpec`/`release`, runs every activate()
// in a `beginActivate` frame (the root of the call chain cycle detection follows) and backs the
// injected `activationOf`/`isActivating` with its own activation promises; ctx.services binds the
// plugin id.
//
// Caller id: each provider method runs in a call frame that records the consumer's bound id, and
// `caller` reads it back to the provider (per-caller usage, caps). Same contract-not-boundary rule.
import { AsyncLocalStorage } from 'node:async_hooks'
import { errorText } from '../shared/error-text'
import { selectProvider, serviceProblemMessage, type ServiceChoices, type ServicePlugin } from '../shared/services'

/** A plugin's settled activation (the loader's `PluginRunState` fits this shape). */
export type ActivationState = { state: 'active' } | { state: 'errored'; error: string }

export interface ServiceRegistryDeps {
  /**
   * The plugin's activation: pending while it activates, settled once done (never rejects), or
   * undefined when the host has no such plugin loaded. It must also cover the reload gap: while a
   * plugin is being reloaded (old copy unloaded, new one not registered yet) it returns a promise
   * of the NEW activation, so a call made in the gap waits instead of failing.
   */
  activationOf(pluginId: string): Promise<ActivationState> | undefined
  /**
   * True while `activationOf(pluginId)` is unsettled, the reload gap included. Synchronous on
   * purpose: cycle detection must decide before it starts waiting, and a promise cannot be asked
   * whether it settled without awaiting it.
   */
  isActivating(pluginId: string): boolean
  /** A line for the plugin's log: dropped emits (the emitter's log) and listener throws (the consumer's). */
  log?(pluginId: string, text: string): void
}

export type ServiceMethod = (...args: unknown[]) => Promise<unknown>
export type ServiceOn = (event: string, listener: (data: unknown) => void) => () => void

/**
 * The consumer's view of a service: every string property is an async method stub, except `on`
 * (subscribes to the service's events, returns a disposer) and `then`, which reads undefined so `await handle` does
 * not take the handle for a thenable and hang. (`then` is left out of the type: an `undefined`
 * member cannot sit beside the method index signature.)
 */
export type ServiceHandle = { readonly on: ServiceOn } & { readonly [method: string]: ServiceMethod }

/**
 * Names a provided object may not use as methods. `then` would make the handle a thenable;
 * `constructor`, `__proto__` and `prototype` are the Object-machinery words a lookup could confuse
 * with inherited members; `on` is the handle's own events member. `_`-prefixed names are refused
 * separately (private by convention, and a provider spreading a class instance would leak them).
 */
const RESERVED_METHODS = new Set(['then', 'constructor', '__proto__', 'prototype', 'on'])

function isValidMethodName(name: string): boolean {
  return name !== '' && !name.startsWith('_') && !RESERVED_METHODS.has(name)
}

/** Event names (plan, Technical Details). Anchored with one bounded class: linear, no ReDoS. */
const EVENT_NAME = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/

function checkEventName(service: string, event: unknown): asserts event is string {
  if (typeof event !== 'string' || !EVENT_NAME.test(event)) {
    const shown = typeof event === 'string' ? `"${event}"` : `of type ${typeof event}`
    throw new Error(
      `service "${service}": event name ${shown} is invalid (a letter, then up to 63 letters, digits, ".", "_", ":" or "-")`
    )
  }
}

/**
 * Copy `value` for the other side; a non-cloneable part becomes a clear plain-data error, and so
 * does shared memory, which structuredClone does not copy (see sharedMemoryIn).
 */
export function cloneData<T>(value: T, what: string): T {
  let copy: T
  try {
    copy = structuredClone(value)
  } catch (err) {
    // DataCloneError (a function, a symbol, a DOM-only object) above all; a throwing getter lands
    // here too, and the same advice applies. The original text names the offending value.
    // Text only, never `cause: err`: a getter's throw is the plugin's own object (anything at all),
    // and attaching it would hand it to the other side, which is what copying is there to prevent.
    // eslint-disable-next-line preserve-caught-error -- the cause is left out on purpose (above)
    throw new Error(`${what} must be plain data (no functions or symbols): ${cloneFailureText(err)}`)
  }
  const shared = sharedMemoryIn(copy)
  if (shared !== undefined) {
    throw new Error(`${what} must be plain data (no shared memory): ${shared} would be shared between the plugins, not copied`)
  }
  return copy
}

/**
 * The text of structuredClone's failure as a plain string. Its own DataCloneError is a
 * DOMException; a getter's throw can be any value, whose `message` may be a getter or a non-string
 * and whose `toString` may throw again, so every read is guarded and only a string comes out.
 */
function cloneFailureText(err: unknown): string {
  const fallback = 'a value threw while being copied'
  try {
    const text = errorText(err)
    return typeof text === 'string' ? text : fallback
  } catch {
    return fallback
  }
}

/**
 * The first shared-memory object in a structuredClone result, described, or undefined.
 * structuredClone keeps a SharedArrayBuffer (alone, nested, or under a typed array or DataView) and
 * a shared WebAssembly.Memory pointing at the same memory, so provider and consumer (or two
 * listeners) would write into each other's data. Walked on the COPY, never the original: the copy
 * holds only data properties, so no plugin getter runs here. Typed arrays and buffers are not
 * descended into (their bytes are not objects; an index walk of a large one would be slow).
 */
function sharedMemoryIn(value: unknown): string | undefined {
  const isShared = (v: unknown): boolean => typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer
  const seen = new Set<object>()
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const v = stack.pop()
    if (typeof v !== 'object' || v === null || seen.has(v)) continue
    seen.add(v)
    if (isShared(v)) return 'a SharedArrayBuffer'
    if (ArrayBuffer.isView(v)) {
      if (isShared(v.buffer)) return `a ${v.constructor.name} over a SharedArrayBuffer`
      continue
    }
    if (v instanceof WebAssembly.Memory) return 'a WebAssembly.Memory'
    if (v instanceof Map) {
      for (const [k, x] of v) stack.push(k, x)
    } else if (v instanceof Set) {
      for (const x of v) stack.push(x)
    } else if (v instanceof Error) {
      // The clone keeps an Error's `cause` (an own, non-enumerable property).
      stack.push(Object.getOwnPropertyDescriptor(v, 'cause')?.value)
    } else if (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype) {
      // Object.keys, not an index loop: a sparse array stays sparse in the copy.
      for (const key of Object.keys(v)) stack.push((v as Record<string, unknown>)[key])
    }
  }
  return undefined
}

/** The fresh error a consumer gets for a provider's throw: same message and name, never the object. */
export interface ServiceCallError extends Error {
  service: string
  plugin: string
}

function rethrown(err: unknown, service: string, plugin: string): ServiceCallError {
  const fresh = new Error(errorText(err)) as ServiceCallError
  // A provider can throw anything; only an Error's own string name is carried over (a getter or a
  // non-string would leak behaviour or junk into the consumer's error).
  if (err instanceof Error && typeof err.name === 'string') fresh.name = err.name
  fresh.service = service
  fresh.plugin = plugin
  return fresh
}

interface Implementation {
  /** The provided object, kept only as `this` for its methods. */
  target: object
  /** Its methods, snapshotted at `provide` (a later change to the object is not seen). */
  methods: Map<string, (...args: unknown[]) => unknown>
}

/**
 * One step of the work a piece of code is doing on someone's behalf, kept in the async context
 * (`ServiceRegistry.chain`). An `activate` frame is a plugin's activate() (always the root: the
 * host starts activations, plugin code never does); a `call` frame is a provider method running for
 * the frame before it. `live` goes false when that activate settles (the loader ends it, timeout
 * included) or that method's promise settles: from then on, nothing waits on the work under it.
 */
interface Frame {
  plugin: string
  kind: 'activate' | 'call'
  live: boolean
  /**
   * A `call` frame's consumer: the plugin id its handle was bound to at `use`, never anything from
   * the arguments (`ServiceRegistry.caller`). Not always the previous frame's plugin: a call from a
   * command, a listener or a late timer starts a chain of its own.
   */
  caller?: string
}

/** What the loader runs each activate() in (see `ServiceRegistry.beginActivate`). */
export interface ActivateFrame {
  /** Run `fn` with this frame as the root of the call chain. */
  run<T>(fn: () => T): T
  /** The activate settled (or timed out): the frame no longer holds anything back. */
  end(): void
}

/**
 * A plugin activation the current code may be holding back: `plugin`'s activate is (as far as the
 * registry can tell) waiting on this code. `path` is the chain from that plugin to the caller,
 * for the cycle message.
 */
interface Blocker {
  plugin: string
  live: () => boolean
  path: string[]
}

/**
 * One waiting call: `from`'s activation (mid-activate) waits, through the plugins in `hops`
 * (`from` first, the caller last), on `to`'s activation. Counts only while `live()`.
 */
interface WaitEdge {
  from: string
  to: string
  hops: string[]
  live: () => boolean
}

/** One `handle.on` call. Each is its own subscription, even for the same listener twice. */
interface Subscription {
  consumer: string
  service: string
  event: string
  listener: (data: unknown) => unknown
  /**
   * Cleared by the disposer and by the consumer's `release`. Checked again at delivery, so an emit
   * queued just before either still reaches no one.
   */
  live: boolean
}

export class ServiceRegistry {
  /** Each plugin's declarations, in host order (the order ambiguous-provider messages list them). */
  private readonly specs = new Map<string, ServicePlugin>()
  private choices: ServiceChoices = {}
  /** pluginId -> service -> implementation. Maps, so a name like `constructor` is just a key. */
  private readonly impls = new Map<string, Map<string, Implementation>>()
  /** Calls currently waiting for an activation, for cycle detection (call flow step 3a). */
  private readonly waits = new Set<WaitEdge>()
  /** service -> event -> subscriptions, in subscription order (the order listeners are called). */
  private readonly subs = new Map<string, Map<string, Set<Subscription>>>()
  /** pluginId -> services whose dropped emits were already logged (log once per plugin and service). */
  private readonly droppedLogged = new Map<string, Set<string>>()
  /**
   * pluginId -> how many times it was released. A handle remembers the count at `use`; a handle of
   * a released copy (a timer left running after a reload or a failed activate) may not subscribe,
   * or the old code would keep receiving events beside the new copy until the next release.
   */
  private readonly releases = new Map<string, number>()
  /**
   * The call chain of the running code (frames, root first), for cycle detection through providers
   * that are already active (step 3a). Node's AsyncLocalStorage, so it follows awaits, timers and
   * promise callbacks started inside an activate or a provider method; see `liveChain` for why a
   * frame carried into a timer is harmless once its activate or method is done.
   */
  private readonly chain = new AsyncLocalStorage<readonly Frame[]>()

  constructor(private readonly deps: ServiceRegistryDeps) {}

  /**
   * The frame the loader runs a plugin's activate() in, and ends when the activation settles. A
   * fresh chain, never the current one: the host's RPC handler starts activations, so whatever
   * context it happens to run in is not work the activate does for anyone.
   */
  beginActivate(pluginId: string): ActivateFrame {
    const frame: Frame = { plugin: pluginId, kind: 'activate', live: true }
    const chain: readonly Frame[] = [frame]
    return {
      run: (fn) => this.chain.run(chain, fn),
      end: () => {
        frame.live = false
      }
    }
  }

  /**
   * Add or replace a plugin's declarations (Task 4: on activate and on `plugin.reload`, since a dev
   * reload can change them). A replaced spec keeps its place in the order.
   */
  setSpec(spec: ServicePlugin): void {
    this.specs.set(spec.id, { id: spec.id, services: spec.services })
  }

  /** Forget a plugin's declarations (Task 4: on `unload`). Its implementations go with `release`. */
  removeSpec(pluginId: string): void {
    this.specs.delete(pluginId)
  }

  /** The project's provider picks (main sends them with every activate). */
  setChoices(choices: ServiceChoices): void {
    this.choices = { ...choices }
  }

  /**
   * Drop what the plugin registered (Task 4: wherever its ctx is released: deactivate, reload,
   * unload, errored activation): its implementations, its own subscriptions as a consumer (events
   * already queued for them are not delivered) and its "logged once" flags. Calls already running
   * finish on the old implementation. Other plugins' subscriptions to the services it provides stay:
   * they are keyed by service, so they get the events of whichever provider comes next.
   */
  release(pluginId: string): void {
    this.impls.delete(pluginId)
    this.droppedLogged.delete(pluginId)
    this.releases.set(pluginId, this.releaseCount(pluginId) + 1)
    for (const byEvent of this.subs.values()) {
      for (const set of byEvent.values()) {
        for (const sub of set) if (sub.consumer === pluginId) this.unsubscribe(sub)
      }
    }
  }

  /**
   * Send `event` to the consumers subscribed to it on `service`. Only a name in the caller's own
   * `provides` (else it throws, like `provide`), and only from the selected provider: a provider the
   * project did not pick (another is picked, or several and no pick) has its emits dropped, with one
   * line in its log per service until it is released. Dropped rather than thrown: a provider cannot
   * know whether it is the pick, and a choice change must not crash its event code.
   *
   * The event name and the data are checked first, whoever listens: a function or symbol in the
   * data throws the plain-data error here, synchronously, even with no subscribers or when the emit
   * is dropped, so the bug shows the first time the code runs. The data is copied now (a change the
   * emitter makes after `emit` returns is not seen) and once more per listener, so listeners cannot
   * see each other's mutations. Delivery is a microtask per listener, never inside `emit`.
   *
   * A consumer whose `uses` major differs from the provider's gets no events, as its calls fail with
   * the version error: the payload of another major is not the shape it expects. It stays
   * subscribed and receives events once the versions agree (a provider swap or a reload).
   * An emit nobody listens to is a silent no-op.
   */
  emit(pluginId: string, service: string, event: string, data?: unknown): void {
    if (this.declared(pluginId, 'provides', service) === undefined) {
      throw new Error(`plugin ${pluginId} does not declare service "${service}" in services.provides`)
    }
    checkEventName(service, event)
    const snapshot = cloneData(data, `service "${service}" event "${event}": the data`)
    const sel = selectProvider(service, [...this.specs.values()], this.choices)
    if (!sel.ok || sel.provider !== pluginId) {
      const why = sel.ok ? `${sel.provider} is the selected provider` : serviceProblemMessage(sel.problem)
      this.logDropped(pluginId, service, `service "${service}": events from ${pluginId} are dropped: ${why}`)
      return
    }
    const set = this.subs.get(service)?.get(event)
    if (!set) return
    let first = true
    for (const sub of set) {
      if (this.declared(sub.consumer, 'uses', service) !== sel.version) continue
      // The snapshot is plain data already, so these copies cannot fail.
      const copy = first ? snapshot : structuredClone(snapshot)
      first = false
      // Outside the emitter's call chain: nobody awaits a listener, so a call it makes is not work
      // the emitter's activate (or caller) waits on, and must not count toward a cycle.
      queueMicrotask(() => this.chain.exit(() => this.deliver(sub, copy)))
    }
  }

  private logDropped(pluginId: string, service: string, text: string): void {
    let logged = this.droppedLogged.get(pluginId)
    if (!logged) this.droppedLogged.set(pluginId, (logged = new Set()))
    if (logged.has(service)) return
    logged.add(service)
    this.deps.log?.(pluginId, text)
  }

  /** Call one listener; its throw (or an async listener's rejection) goes to the consumer's log. */
  private deliver(sub: Subscription, data: unknown): void {
    if (!sub.live) return
    const fail = (err: unknown): void =>
      this.deps.log?.(sub.consumer, `service "${sub.service}": listener for "${sub.event}" threw: ${errorText(err)}`)
    try {
      const listener = sub.listener
      const result = listener(data)
      // An async listener: without this its rejection would be unhandled in the shared host process.
      if (result instanceof Promise) result.catch(fail)
    } catch (err) {
      fail(err)
    }
  }

  private releaseCount(pluginId: string): number {
    return this.releases.get(pluginId) ?? 0
  }

  private unsubscribe(sub: Subscription): void {
    sub.live = false
    const byEvent = this.subs.get(sub.service)
    const set = byEvent?.get(sub.event)
    if (!byEvent || !set) return
    set.delete(sub)
    if (set.size === 0) byEvent.delete(sub.event)
    if (byEvent.size === 0) this.subs.delete(sub.service)
  }

  /**
   * Register `impl` as the plugin's implementation of `service`. Only a name in its own `provides`;
   * `impl` must be a plain object whose own enumerable properties are all functions with valid
   * method names. A second `provide` of the same name replaces the first.
   */
  provide(pluginId: string, service: string, impl: unknown): void {
    if (this.declared(pluginId, 'provides', service) === undefined) {
      throw new Error(`plugin ${pluginId} does not declare service "${service}" in services.provides`)
    }
    if (typeof impl !== 'object' || impl === null) {
      throw new Error(`service "${service}": the implementation must be an object of functions`)
    }
    // Plain objects only: a class instance's methods live on its prototype, which a copy of own
    // properties would miss, so it would look like a service with no methods. Refusing says so.
    const proto: unknown = Object.getPrototypeOf(impl)
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`service "${service}": the implementation must be a plain object (not a class instance)`)
    }
    const methods = new Map<string, (...args: unknown[]) => unknown>()
    // Descriptors, not reads: an enumerable getter would run provider code here and could answer
    // differently on every read. Symbol keys are not callable through the handle and are ignored.
    for (const [name, desc] of Object.entries(Object.getOwnPropertyDescriptors(impl))) {
      if (!desc.enumerable) continue
      if (!isValidMethodName(name)) {
        const why = name === 'on' ? ' (reserved for events)' : ''
        throw new Error(`service "${service}": "${name}" is not a valid method name${why}`)
      }
      if (typeof desc.value !== 'function') {
        throw new Error(`service "${service}": "${name}" must be a function`)
      }
      methods.set(name, desc.value as (...args: unknown[]) => unknown)
    }
    let mine = this.impls.get(pluginId)
    if (!mine) this.impls.set(pluginId, (mine = new Map()))
    mine.set(service, { target: impl, methods })
  }

  /**
   * The consumer's handle for `service`. Only a name in its own `uses` (checked now and again on
   * every call, since a reload can drop it). The handle holds no provider: each call resolves one.
   */
  use(pluginId: string, service: string): ServiceHandle {
    if (this.declared(pluginId, 'uses', service) === undefined) {
      throw new Error(`plugin ${pluginId} does not declare service "${service}" in services.uses`)
    }
    const releasesAtUse = this.releaseCount(pluginId)
    // A null-prototype target, so no Object.prototype member answers before the trap does.
    const target = Object.create(null) as object
    return new Proxy(target, {
      get: (_t, prop) => {
        // Symbols (util.inspect.custom, Symbol.toPrimitive, ...) are never methods.
        if (typeof prop === 'symbol') return undefined
        if (prop === 'then') return undefined
        if (prop === 'on') return this.onFor(pluginId, service, releasesAtUse)
        return (...args: unknown[]) => this.call(pluginId, service, prop, args, releasesAtUse)
      },
      set: () => false,
      defineProperty: () => false,
      deleteProperty: () => false
    }) as ServiceHandle
  }

  /**
   * The handle's `on`: subscribe `listener` to `event` and return its disposer (calling it again,
   * or after the consumer's release, does nothing). Refused synchronously when the consumer no
   * longer declares the service (a reload dropped it), for an invalid event name or a non-function
   * listener, and from a handle of a released copy of the consumer (see `releases`).
   */
  private onFor(consumer: string, service: string, releasesAtUse: number): ServiceOn {
    return (event, listener) => {
      if (this.declared(consumer, 'uses', service) === undefined) {
        throw new Error(`plugin ${consumer} does not declare service "${service}" in services.uses`)
      }
      this.checkFresh(consumer, service, releasesAtUse)
      checkEventName(service, event)
      if (typeof listener !== 'function') {
        throw new Error(`service "${service}": the listener for "${event}" must be a function`)
      }
      const sub: Subscription = { consumer, service, event, listener, live: true }
      let byEvent = this.subs.get(service)
      if (!byEvent) this.subs.set(service, (byEvent = new Map()))
      let set = byEvent.get(event)
      if (!set) byEvent.set(event, (set = new Set()))
      set.add(sub)
      return () => {
        if (sub.live) this.unsubscribe(sub)
      }
    }
  }

  /**
   * A handle of a released copy of the consumer (a timer or listener the old code left running
   * after a reload, a deactivate or a failed activate) may neither subscribe nor call: the old code
   * would go on acting beside the new copy, against providers that never expect it.
   */
  private checkFresh(consumer: string, service: string, releasesAtUse: number): void {
    if (this.releaseCount(consumer) !== releasesAtUse) {
      throw new Error(`service "${service}": this handle belongs to a previous copy of plugin ${consumer}; call ctx.services.use again`)
    }
  }

  /**
   * Call flow (plan, Technical Details) steps 1-6. A stale handle is refused at the start and again
   * after any activation wait (the consumer can be released meanwhile); a call already running in
   * the provider when the consumer is released finishes.
   */
  private async call(consumer: string, service: string, method: string, args: unknown[], releasesAtUse: number): Promise<unknown> {
    this.checkFresh(consumer, service, releasesAtUse)
    // Resolve, and if the provider is still activating, wait and resolve again: the wait can span
    // a reload that changed the declarations, so the provider after it may be another one.
    let provider: string
    for (;;) {
      provider = this.resolve(consumer, service)
      const activation = this.deps.activationOf(provider)
      // Not loaded at all: nothing to wait for; the implementation check below decides.
      if (activation === undefined) break
      if (!this.deps.isActivating(provider)) {
        const state = await activation
        // The await (one microtask) may have let a reload start; resolve again if so.
        if (this.deps.isActivating(provider)) continue
        this.checkActive(provider, service, state)
        break
      }
      await this.waitFor(consumer, provider, activation)
    }
    this.checkFresh(consumer, service, releasesAtUse)
    // Step 4: the implementation and the method, looked up after any wait (a release meanwhile
    // means the provider is gone, and the consumer must hear that rather than reach a stale copy).
    const impl = this.impls.get(provider)?.get(service)
    if (!impl) throw new Error(`${provider} declares service "${service}" but did not provide it`)
    const fn = impl.methods.get(method)
    if (!fn) throw new Error(`service "${service}" (plugin ${provider}) has no method "${method}"`)
    // Step 5: copy in, call, copy out. Both copies happen here in the host, so neither side ever
    // holds an object the other can mutate. No timeout (step 6): a consumer races its own.
    const input = cloneData(args, `service "${service}" ${method}(): arguments`)
    // The method runs as a frame of the caller's chain, so a call it makes back into an activation
    // that is waiting on this one is seen as the cycle it is (step 3a, through an active provider).
    const frame: Frame = { plugin: provider, kind: 'call', live: true, caller: consumer }
    const chain = [...this.liveChain(), frame]
    let result: unknown
    try {
      result = await this.chain.run(chain, () => fn.apply(impl.target, input))
    } catch (err) {
      throw rethrown(err, service, provider)
    } finally {
      frame.live = false
    }
    return cloneData(result, `service "${service}" ${method}(): the result`)
  }

  /**
   * `ctx.services.caller()` for `pluginId`: the plugin whose call `pluginId` is serving right now,
   * or undefined. Read from the innermost frame of the current chain only, and only when that frame
   * - is a `call` frame: an `activate` frame serves no one, and listeners run outside any chain
   *   (`emit` delivers them with `chain.exit`), so both read undefined;
   * - is still live: a timer or promise callback the method started carries the frame, but once
   *   the method's promise settled the call is over, and a late timer must not be counted against
   *   a caller that is gone (the same rule `liveChain` applies for cycles);
   * - is a call into `pluginId` itself. All plugins share one realm, so code of plugin X can run
   *   inside a frame where another plugin is the provider (a function X left on a global, called
   *   from Y's method). X is not serving that call; answering Y's caller to X would let X count work
   *   against a plugin that never called X.
   * Nested calls answer the innermost: inside C, for A -> B -> C, the caller is B, and back in B
   * after its await of C the context is B's own frame again, whose caller is A.
   */
  caller(pluginId: string): string | undefined {
    const frames = this.chain.getStore()
    const frame = frames?.[frames.length - 1]
    if (!frame || frame.kind !== 'call' || !frame.live || frame.plugin !== pluginId) return undefined
    return frame.caller
  }

  /**
   * The current chain cut to its live tail. Each frame is work the one before it started; it holds
   * that one back only while every frame after it is still running. So the walk goes from the end
   * and stops at the first finished frame: a timer an activate or a provider method started carries
   * its chain (AsyncLocalStorage follows timers), but once that activate or method is done the
   * timer's calls hold nothing back and are treated like any unrelated call. While it is still
   * running they count as blocking it: the registry cannot tell a call the activate awaits from one
   * it merely started (the same over-approximation as in `waitFor`).
   */
  private liveChain(): Frame[] {
    const frames = this.chain.getStore() ?? []
    let start = frames.length
    while (start > 0 && frames[start - 1]!.live) start--
    return frames.slice(start)
  }

  /**
   * The activations a call from `consumer` in the current context may be holding back: each live
   * `activate` frame of the chain (through the provider methods after it), and the consumer itself
   * when it is mid-activate without a frame here (a call from its activate seen without the chain,
   * kept as the plain rule step 3a started with).
   */
  private blockers(consumer: string): Blocker[] {
    const live = this.liveChain()
    const names = live.map((f) => f.plugin)
    if (names[names.length - 1] !== consumer) names.push(consumer)
    const out: Blocker[] = []
    live.forEach((f, i) => {
      if (f.kind === 'activate') out.push({ plugin: f.plugin, live: () => f.live, path: names.slice(i) })
    })
    if (this.deps.isActivating(consumer) && !out.some((b) => b.plugin === consumer)) {
      out.push({ plugin: consumer, live: () => this.deps.isActivating(consumer), path: [consumer] })
    }
    return out
  }

  /** Steps 1-2: the selected provider for this consumer, or the problem as an error. */
  private resolve(consumer: string, service: string): string {
    const version = this.declared(consumer, 'uses', service)
    if (version === undefined) {
      throw new Error(`plugin ${consumer} does not declare service "${service}" in services.uses`)
    }
    const sel = selectProvider(service, [...this.specs.values()], this.choices, { id: consumer, version })
    if (!sel.ok) throw new Error(serviceProblemMessage(sel.problem))
    return sel.provider
  }

  private checkActive(provider: string, service: string, state: ActivationState): void {
    if (state.state === 'errored') {
      throw new Error(`service "${service}": plugin ${provider} failed to activate: ${state.error}`)
    }
  }

  /**
   * Step 3a. A call made on behalf of a plugin that is mid-activate (see `blockers`), waiting on
   * another activation, is a "waiting on" edge from each such plugin. The wait would close a cycle
   * in which every activate awaits the next, and all would hang until their 10 s timeouts and end
   * errored, when either
   * - the provider is itself one of those plugins: its activate called an active provider whose
   *   method calls back into it (`A -> B -> A`, B active: no edge is ever recorded for that, as
   *   nothing waits on B, so only the call chain shows it), or
   * - the provider already waits, directly or through others, on one of them (the edges).
   * Fail this call at once instead, so the activate that made it can go on (or fail) and the others
   * unblock.
   *
   * Known over-approximation: the registry cannot tell a call awaited by `activate` from one the
   * plugin merely started during it (a fire-and-forget call, a timer). Both count as blocking.
   */
  private async waitFor(caller: string, provider: string, activation: Promise<ActivationState>): Promise<void> {
    const blockers = this.blockers(caller)
    if (blockers.length === 0) {
      await activation
      return
    }
    for (const b of blockers) {
      const path = b.plugin === provider ? [provider] : this.pathFrom(provider, b.plugin)
      if (path) throw new Error(`${[...b.path, ...path].join(' -> ')}: services called in a cycle during activate`)
    }
    const edges: WaitEdge[] = blockers.map((b) => ({ from: b.plugin, to: provider, hops: b.path, live: b.live }))
    for (const e of edges) this.waits.add(e)
    try {
      await activation
    } finally {
      for (const e of edges) this.waits.delete(e)
    }
  }

  /**
   * A path of waiting edges from `start` to `goal`, as the plugins it passes through, `start` first
   * and `goal` last (with the provider methods between, from each edge's `hops`), or undefined.
   * An edge that is no longer live is skipped: the activate it came from timed out or ended while a
   * call it started still waits, so that call no longer holds an activation back.
   */
  private pathFrom(start: string, goal: string): string[] | undefined {
    const seen = new Set<string>()
    const walk = (node: string): string[] | undefined => {
      if (node === goal) return [node]
      if (seen.has(node)) return undefined
      seen.add(node)
      for (const e of this.waits) {
        if (e.from !== node || !e.live()) continue
        const rest = walk(e.to)
        if (rest) return [...e.hops, ...rest]
      }
      return undefined
    }
    return walk(start)
  }

  /** The declared major of `service` in the plugin's `provides` or `uses`, read with hasOwn. */
  private declared(pluginId: string, side: 'provides' | 'uses', service: string): number | undefined {
    const map = this.specs.get(pluginId)?.services?.[side]
    return map !== undefined && Object.hasOwn(map, service) ? map[service] : undefined
  }
}
