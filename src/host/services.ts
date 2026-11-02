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
// The loader owns the registry: it calls `setSpec`/`removeSpec`/`release` and backs the injected
// `activationOf`/`isActivating` with its own activation promises; ctx.services binds the plugin id.
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

/** Copy `value` for the other side; a non-cloneable part becomes a clear plain-data error. */
export function cloneData<T>(value: T, what: string): T {
  try {
    return structuredClone(value)
  } catch (err) {
    // DataCloneError (a function, a symbol, a DOM-only object) above all; a throwing getter lands
    // here too, and the same advice applies. The original text names the offending value.
    // The cause is structuredClone's own DOMException, not an object of either plugin's, so it is
    // safe to attach (unlike a provider's throw, see rethrown()).
    throw new Error(`${what} must be plain data (no functions or symbols): ${errorText(err)}`, { cause: err })
  }
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

/** One waiting call: `from` (mid-activate) waits on `to`'s activation. */
interface WaitEdge {
  from: string
  to: string
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

  constructor(private readonly deps: ServiceRegistryDeps) {}

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
      queueMicrotask(() => this.deliver(sub, copy))
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
        return (...args: unknown[]) => this.call(pluginId, service, prop, args)
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
      if (this.releaseCount(consumer) !== releasesAtUse) {
        throw new Error(`service "${service}": this handle belongs to a released copy of plugin ${consumer}; it can no longer subscribe`)
      }
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

  /** Call flow (plan, Technical Details) steps 1-6. */
  private async call(consumer: string, service: string, method: string, args: unknown[]): Promise<unknown> {
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
    // Step 4: the implementation and the method, looked up after any wait (a release meanwhile
    // means the provider is gone, and the consumer must hear that rather than reach a stale copy).
    const impl = this.impls.get(provider)?.get(service)
    if (!impl) throw new Error(`${provider} declares service "${service}" but did not provide it`)
    const fn = impl.methods.get(method)
    if (!fn) throw new Error(`service "${service}" (plugin ${provider}) has no method "${method}"`)
    // Step 5: copy in, call, copy out. Both copies happen here in the host, so neither side ever
    // holds an object the other can mutate. No timeout (step 6): a consumer races its own.
    const input = cloneData(args, `service "${service}" ${method}(): arguments`)
    let result: unknown
    try {
      result = await fn.apply(impl.target, input)
    } catch (err) {
      throw rethrown(err, service, provider)
    }
    return cloneData(result, `service "${service}" ${method}(): the result`)
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
   * Step 3a. A call from a plugin that is itself mid-activate, waiting on another activation, is a
   * "waiting on" edge. If the provider already waits (directly or through others) on the caller,
   * this wait would close a cycle in which every activate awaits the next: all would hang until
   * their 10 s timeouts and end errored. Fail this call at once instead, so the activate that made
   * it can go on (or fail) and the others unblock.
   *
   * Known over-approximation: the registry cannot tell a call awaited by `activate` from one the
   * plugin merely started during it (a fire-and-forget call, a timer). Both count as blocking.
   */
  private async waitFor(caller: string, provider: string, activation: Promise<ActivationState>): Promise<void> {
    if (!this.deps.isActivating(caller)) {
      await activation
      return
    }
    const path = this.pathFrom(provider, caller)
    if (path) throw new Error(`${[caller, ...path].join(' -> ')}: services called in a cycle during activate`)
    const edge: WaitEdge = { from: caller, to: provider }
    this.waits.add(edge)
    try {
      await activation
    } finally {
      this.waits.delete(edge)
    }
  }

  /**
   * A path of waiting edges from `start` to `goal`, as the list of plugins after `start`'s caller
   * (`[start, ..., goal]`), or undefined. Edges from a plugin that is no longer activating are
   * skipped: its activate timed out or ended while a call it started still waits, so that call no
   * longer holds an activation back.
   */
  private pathFrom(start: string, goal: string): string[] | undefined {
    const seen = new Set<string>()
    const walk = (node: string): string[] | undefined => {
      if (node === goal) return [node]
      if (seen.has(node)) return undefined
      seen.add(node)
      if (!this.deps.isActivating(node)) return undefined
      for (const e of this.waits) {
        if (e.from !== node) continue
        const rest = walk(e.to)
        if (rest) return [node, ...rest]
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
