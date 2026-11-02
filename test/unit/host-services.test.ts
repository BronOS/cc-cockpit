import { describe, expect, it } from 'vitest'
import { ServiceRegistry, type ActivationState, type ServiceHandle } from '../../src/host/services'

// Stands in for the loader (Task 4 backs these with its activation promises): a plugin is
// activating between start() and finish(); a settled one answers its last state.
class FakeActivations {
  private readonly pending = new Map<string, { promise: Promise<ActivationState>; resolve: (s: ActivationState) => void }>()
  private readonly settled = new Map<string, ActivationState>()

  start(id: string): void {
    let resolve!: (s: ActivationState) => void
    const promise = new Promise<ActivationState>((r) => (resolve = r))
    this.pending.set(id, { promise, resolve })
  }

  finish(id: string, state: ActivationState = { state: 'active' }): void {
    const p = this.pending.get(id)
    this.pending.delete(id)
    this.settled.set(id, state)
    p?.resolve(state)
  }

  activationOf = (id: string): Promise<ActivationState> | undefined =>
    this.pending.get(id)?.promise ?? (this.settled.has(id) ? Promise.resolve(this.settled.get(id)!) : undefined)

  isActivating = (id: string): boolean => this.pending.has(id)
}

/** Let every queued microtask and promise continuation run. */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

/** Where a promise stands after a flush: still pending, resolved or rejected. */
async function outcome(p: Promise<unknown>): Promise<{ value: unknown } | { error: Error } | 'pending'> {
  let r: { value: unknown } | { error: Error } | 'pending' = 'pending'
  p.then(
    (value) => (r = { value }),
    (error: Error) => (r = { error })
  )
  await flush()
  return r
}

const call = (h: ServiceHandle, method: string, ...args: unknown[]): Promise<unknown> => h[method]!(...args)

function setup(): { reg: ServiceRegistry; acts: FakeActivations; logs: [string, string][] } {
  const acts = new FakeActivations()
  const logs: [string, string][] = []
  const reg = new ServiceRegistry({
    activationOf: acts.activationOf,
    isActivating: acts.isActivating,
    log: (id, text) => logs.push([id, text])
  })
  return { reg, acts, logs }
}

const provider = (id: string, provides: Record<string, number>, uses?: Record<string, number>) => ({ id, services: { provides, uses } })
const consumer = (id: string, uses: Record<string, number>, provides?: Record<string, number>) => ({ id, services: { uses, provides } })

describe('ServiceRegistry provide and use', () => {
  it('calls the provider and returns its answer', async () => {
    const { reg, acts } = setup()
    reg.setSpec(provider('p', { triage: 1 }))
    reg.setSpec(consumer('c', { triage: 1 }))
    acts.finish('p')
    reg.provide('p', 'triage', {
      classify(items: string[], q: string) {
        return items.map((i) => `${q}:${i}`)
      },
      async slow() {
        await flush()
        return 'late'
      }
    })
    const h = reg.use('c', 'triage')
    await expect(call(h, 'classify', ['a', 'b'], 'q')).resolves.toEqual(['q:a', 'q:b'])
    await expect(call(h, 'slow')).resolves.toBe('late')
  })

  it('calls the method with the provided object as this', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    reg.provide('p', 's', {
      base() {
        return 40
      },
      plus(this: { base(): number }, n: number) {
        return this.base() + n
      }
    })
    await expect(call(reg.use('c', 's'), 'plus', 2)).resolves.toBe(42)
  })

  it('refuses a provide of an undeclared name and a use of an undeclared name, synchronously', () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { triage: 1 }))
    reg.setSpec(consumer('c', { triage: 1 }))
    expect(() => reg.provide('p', 'other', {})).toThrow('plugin p does not declare service "other" in services.provides')
    // A consumer's `uses` does not let it provide, and a provider's `provides` does not let it use.
    expect(() => reg.provide('c', 'triage', {})).toThrow('plugin c does not declare service "triage" in services.provides')
    expect(() => reg.use('p', 'triage')).toThrow('plugin p does not declare service "triage" in services.uses')
    expect(() => reg.use('c', 'other')).toThrow('plugin c does not declare service "other" in services.uses')
    expect(() => reg.use('unknown', 'triage')).toThrow('plugin unknown does not declare service "triage" in services.uses')
  })

  it('reads declarations with hasOwn: constructor is a name, not Object.prototype', () => {
    const { reg } = setup()
    reg.setSpec(consumer('c', { triage: 1 }))
    expect(() => reg.use('c', 'constructor')).toThrow('does not declare service "constructor"')
    expect(() => reg.provide('c', 'toString', {})).toThrow('does not declare service "toString"')
  })

  it('accepts only a plain object of functions with valid method names', () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    const bad = (impl: unknown): (() => void) => () => reg.provide('p', 's', impl)
    expect(bad(null)).toThrow('must be an object of functions')
    expect(bad(() => 1)).toThrow('must be an object of functions')
    expect(bad('x')).toThrow('must be an object of functions')
    class Impl {
      m(): number {
        return 1
      }
    }
    expect(bad(new Impl())).toThrow('must be a plain object (not a class instance)')
    expect(bad({ m: 1 })).toThrow('"m" must be a function')
    expect(bad({ on: () => 1 })).toThrow('"on" is not a valid method name (reserved for events)')
    expect(bad({ then: () => 1 })).toThrow('"then" is not a valid method name')
    expect(bad({ _private: () => 1 })).toThrow('"_private" is not a valid method name')
    expect(bad(JSON.parse('{"__proto__": 1}'))).toThrow('"__proto__" is not a valid method name')
    expect(bad({ prototype: () => 1 })).toThrow('"prototype" is not a valid method name')
    const withCtor = Object.create(null) as Record<string, unknown>
    withCtor.constructor = () => 1
    expect(bad(withCtor)).toThrow('"constructor" is not a valid method name')
    // An enumerable getter is not a function value (and is not run to find out).
    let ran = false
    const getter = Object.defineProperty({}, 'g', {
      enumerable: true,
      get() {
        ran = true
        return () => 1
      }
    })
    expect(bad(getter)).toThrow('"g" must be a function')
    expect(ran).toBe(false)
    // Null-prototype objects, empty objects and non-enumerable extras are fine.
    const nullProto = Object.create(null) as Record<string, unknown>
    nullProto.m = () => 1
    expect(bad(nullProto)).not.toThrow()
    expect(bad({})).not.toThrow()
    expect(bad(Object.defineProperty({ m: () => 1 }, 'hidden', { value: 5, enumerable: false }))).not.toThrow()
  })

  it('a handle reads then as undefined (await does not hang) and is not writable', async () => {
    const { reg } = setup()
    reg.setSpec(consumer('c', { s: 1 }))
    const h = reg.use('c', 's')
    expect((h as unknown as { then: unknown }).then).toBeUndefined()
    await expect(Promise.resolve(h)).resolves.toBe(h)
    expect((h as unknown as Record<symbol, unknown>)[Symbol.toPrimitive]).toBeUndefined()
    expect(() => {
      ;(h as unknown as Record<string, unknown>).x = 1
    }).toThrow(TypeError)
    // `on` is the reserved events member, not a method stub.
    expect(typeof h.on).toBe('function')
    expect(typeof h.on('changed', () => {})).toBe('function')
  })

  it('a handle obtained before the provider exists works once it provides', async () => {
    const { reg } = setup()
    reg.setSpec(consumer('c', { s: 1 }))
    const h = reg.use('c', 's')
    await expect(call(h, 'm')).rejects.toThrow('no enabled plugin in this project provides service "s"')
    reg.setSpec(provider('p', { s: 1 }))
    reg.provide('p', 's', { m: () => 'ok' })
    await expect(call(h, 'm')).resolves.toBe('ok')
  })
})

describe('ServiceRegistry data copying', () => {
  it('copies arguments and results: a mutation on either side does not leak', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    const kept = { list: [1, 2] }
    let received: { list: number[] } | undefined
    reg.provide('p', 's', {
      take(arg: { list: number[] }) {
        received = arg
        arg.list.push(99)
        return 'ok'
      },
      give() {
        return kept
      }
    })
    const h = reg.use('c', 's')
    const mine = { list: [1] }
    await call(h, 'take', mine)
    expect(mine.list).toEqual([1])
    expect(received!.list).toEqual([1, 99])
    mine.list.push(7)
    expect(received!.list).toEqual([1, 99])
    const got = (await call(h, 'give')) as { list: number[] }
    expect(got).toEqual({ list: [1, 2] })
    expect(got).not.toBe(kept)
    got.list.push(3)
    expect(kept.list).toEqual([1, 2])
  })

  it('a class instance arrives as a plain object (prototype and methods dropped)', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    class Point {
      constructor(
        public x: number,
        public y: number
      ) {}
      sum(): number {
        return this.x + this.y
      }
    }
    let arrived: unknown
    reg.provide('p', 's', {
      echo(p: unknown) {
        arrived = p
        return new Point(3, 4)
      }
    })
    const got = await call(reg.use('c', 's'), 'echo', new Point(1, 2))
    expect(arrived).toEqual({ x: 1, y: 2 })
    expect(Object.getPrototypeOf(arrived)).toBe(Object.prototype)
    expect(got).toEqual({ x: 3, y: 4 })
    expect(got).not.toBeInstanceOf(Point)
    expect((got as { sum?: unknown }).sum).toBeUndefined()
  })

  it('a function or symbol in the arguments or the result is a plain-data error', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    let calls = 0
    reg.provide('p', 's', {
      echo(v: unknown) {
        calls++
        return v
      },
      fn() {
        return { cb: () => 1 }
      },
      sym() {
        return Symbol('x')
      }
    })
    const h = reg.use('c', 's')
    await expect(call(h, 'echo', { cb: () => 1 })).rejects.toThrow(
      /^service "s" echo\(\): arguments must be plain data \(no functions or symbols\): /
    )
    await expect(call(h, 'echo', Symbol('x'))).rejects.toThrow('service "s" echo(): arguments must be plain data')
    // Refused before the provider runs.
    expect(calls).toBe(0)
    await expect(call(h, 'fn')).rejects.toThrow('service "s" fn(): the result must be plain data')
    await expect(call(h, 'sym')).rejects.toThrow('service "s" sym(): the result must be plain data')
  })

  it('shared memory is refused, nested too: structuredClone would share it, not copy it', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    const kept = new SharedArrayBuffer(8)
    let calls = 0
    reg.provide('p', 's', {
      echo(v: unknown) {
        calls++
        return v
      },
      shared() {
        return { deep: [kept] }
      }
    })
    const h = reg.use('c', 's')
    const sab = new SharedArrayBuffer(8)
    const sharedArgs: [unknown, string][] = [
      [sab, 'a SharedArrayBuffer'],
      [{ a: [{ b: sab }] }, 'a SharedArrayBuffer'],
      [new Int32Array(sab), 'a Int32Array over a SharedArrayBuffer'],
      [new DataView(sab), 'a DataView over a SharedArrayBuffer'],
      [new Map([['k', new Set([new Uint8Array(sab)])]]), 'a Uint8Array over a SharedArrayBuffer'],
      [new Error('e', { cause: sab }), 'a SharedArrayBuffer'],
      [new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }), 'a WebAssembly.Memory']
    ]
    for (const [arg, what] of sharedArgs) {
      await expect(call(h, 'echo', arg)).rejects.toThrow(
        `service "s" echo(): arguments must be plain data (no shared memory): ${what} would be shared between the plugins, not copied`
      )
    }
    expect(calls).toBe(0)
    await expect(call(h, 'shared')).rejects.toThrow('service "s" shared(): the result must be plain data (no shared memory)')
    // Event data too, at emit.
    expect(() => reg.emit('p', 's', 'e', { buf: new Float64Array(new SharedArrayBuffer(8)) })).toThrow(
      'service "s" event "e": the data must be plain data (no shared memory)'
    )
    // Ordinary buffers, a sparse array and a cycle are copied as before.
    const cyclic: Record<string, unknown> = { bytes: new Uint8Array([1, 2]) }
    cyclic.self = cyclic
    const sparse: unknown[] = []
    sparse[1_000_000] = new ArrayBuffer(4)
    const back = (await call(h, 'echo', [cyclic, sparse])) as [Record<string, unknown>, unknown[]]
    expect(back[0].bytes).toEqual(new Uint8Array([1, 2]))
    expect(back[0].self).toBe(back[0])
    expect(back[1][1_000_000]).toBeInstanceOf(ArrayBuffer)
  })

  it('a throwing getter is reported as text only: the thrown object is never attached', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    const secret = { token: 'provider-owned' }
    const thrown = Object.assign(new Error('getter broke'), { secret })
    const nasty = {
      toString() {
        throw new Error('toString broke too')
      }
    }
    reg.provide('p', 's', {
      bad() {
        return {
          get x() {
            throw thrown
          }
        }
      },
      worse() {
        return {
          get x() {
            throw nasty
          }
        }
      }
    })
    const h = reg.use('c', 's')
    const err = (await call(h, 'bad').catch((e: unknown) => e)) as Error
    expect(err.message).toBe('service "s" bad(): the result must be plain data (no functions or symbols): getter broke')
    expect(err.cause).toBeUndefined()
    expect(Object.values(err)).not.toContain(secret)
    const err2 = (await call(h, 'worse').catch((e: unknown) => e)) as Error
    expect(err2.message).toBe('service "s" worse(): the result must be plain data (no functions or symbols): a value threw while being copied')
    expect(err2.cause).toBeUndefined()
  })
})

describe('ServiceRegistry errors', () => {
  it('missing: no provider in this host', async () => {
    const { reg } = setup()
    reg.setSpec(consumer('c', { triage: 1 }))
    await expect(call(reg.use('c', 'triage'), 'm')).rejects.toThrow('no enabled plugin in this project provides service "triage"')
  })

  it('ambiguous: two providers and no pick, then the pick decides', async () => {
    const { reg } = setup()
    reg.setSpec(provider('a', { triage: 1 }))
    reg.setSpec(provider('b', { triage: 1 }))
    reg.setSpec(consumer('c', { triage: 1 }))
    reg.provide('a', 'triage', { who: () => 'a' })
    reg.provide('b', 'triage', { who: () => 'b' })
    const h = reg.use('c', 'triage')
    await expect(call(h, 'who')).rejects.toThrow('plugins a and b both provide service "triage"; pick one in Settings > Plugins')
    reg.setChoices({ triage: 'b' })
    await expect(call(h, 'who')).resolves.toBe('b')
    // A stale pick (not a provider here) counts as no pick.
    reg.setChoices({ triage: 'gone' })
    await expect(call(h, 'who')).rejects.toThrow('both provide service "triage"')
  })

  it('version mismatch between the consumer and the provider', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { triage: 1 }))
    reg.setSpec(consumer('c', { triage: 2 }))
    reg.provide('p', 'triage', { m: () => 1 })
    await expect(call(reg.use('c', 'triage'), 'm')).rejects.toThrow('"triage": c uses version 2, p provides version 1')
  })

  it('errored provider: its activation error text', async () => {
    const { reg, acts } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    reg.provide('p', 's', { m: () => 1 })
    acts.finish('p', { state: 'errored', error: 'activate() failed: boom' })
    await expect(call(reg.use('c', 's'), 'm')).rejects.toThrow('service "s": plugin p failed to activate: activate() failed: boom')
  })

  it('never provided: active but provide was not called', async () => {
    const { reg, acts } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    acts.finish('p')
    await expect(call(reg.use('c', 's'), 'm')).rejects.toThrow('p declares service "s" but did not provide it')
  })

  it('unknown method, including Object.prototype names', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    reg.provide('p', 's', { m: () => 1 })
    const h = reg.use('c', 's')
    await expect(call(h, 'nope')).rejects.toThrow('service "s" (plugin p) has no method "nope"')
    await expect(call(h, 'toString')).rejects.toThrow('has no method "toString"')
    await expect(call(h, 'constructor')).rejects.toThrow('has no method "constructor"')
  })

  it('a provider throw reaches the consumer as a fresh Error with the same message and name', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    const original = new TypeError('bad input')
    ;(original as unknown as { secret: string }).secret = 'provider internals'
    reg.provide('p', 's', {
      sync() {
        throw original
      },
      async later() {
        await flush()
        throw new RangeError('too far')
      },
      notAnError() {
        throw 'just a string'
      }
    })
    const h = reg.use('c', 's')
    const err = (await call(h, 'sync').catch((e: unknown) => e)) as Error & { service: string; plugin: string; secret?: string }
    expect(err).not.toBe(original)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('bad input')
    expect(err.name).toBe('TypeError')
    expect(err.service).toBe('s')
    expect(err.plugin).toBe('p')
    expect(err.secret).toBeUndefined()
    await expect(call(h, 'later')).rejects.toMatchObject({ message: 'too far', name: 'RangeError', service: 's', plugin: 'p' })
    await expect(call(h, 'notAnError')).rejects.toMatchObject({ message: 'just a string', name: 'Error', service: 's', plugin: 'p' })
  })

  it('a consumer whose reload dropped the use is refused on the next call', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    reg.provide('p', 's', { m: () => 1 })
    const h = reg.use('c', 's')
    reg.setSpec(consumer('c', {}))
    await expect(call(h, 'm')).rejects.toThrow('plugin c does not declare service "s" in services.uses')
  })
})

describe('ServiceRegistry activation waits', () => {
  it('waits for a still-activating provider, then calls it', async () => {
    const { reg, acts } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    acts.start('p')
    // Provided early in activate, but the call still waits for the activation to finish.
    reg.provide('p', 's', { m: () => 'done' })
    const p = call(reg.use('c', 's'), 'm')
    expect(await outcome(p)).toBe('pending')
    acts.finish('p')
    await expect(p).resolves.toBe('done')
  })

  it('a wait that ends in an errored activation fails with its error', async () => {
    const { reg, acts } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    acts.start('p')
    reg.provide('p', 's', { m: () => 'done' })
    const p = call(reg.use('c', 's'), 'm')
    // The loader releases an errored plugin's ctx, then settles its activation.
    reg.release('p')
    acts.finish('p', { state: 'errored', error: 'activate() did not finish within 10 s' })
    await expect(p).rejects.toThrow('plugin p failed to activate: activate() did not finish within 10 s')
  })

  it('a call made in the reload gap waits for the new copy and reaches it', async () => {
    const { reg, acts } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    acts.finish('p')
    reg.provide('p', 's', { v: () => 'old' })
    const h = reg.use('c', 's')
    await expect(call(h, 'v')).resolves.toBe('old')
    // Reload: the old copy is released and activationOf covers the gap with the new activation.
    reg.release('p')
    acts.start('p')
    const p = call(h, 'v')
    expect(await outcome(p)).toBe('pending')
    reg.provide('p', 's', { v: () => 'new' })
    acts.finish('p')
    await expect(p).resolves.toBe('new')
  })

  it('re-resolves after the wait: a reload that changed the declarations is honoured', async () => {
    const { reg, acts } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(provider('q', { other: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    acts.finish('q')
    acts.start('p')
    const p = call(reg.use('c', 's'), 'm')
    expect(await outcome(p)).toBe('pending')
    // While p reloads, the declarations move: p no longer provides s, q now does.
    reg.setSpec(provider('p', {}))
    reg.setSpec(provider('q', { s: 1 }))
    reg.provide('q', 's', { m: () => 'from q' })
    acts.finish('p')
    await expect(p).resolves.toBe('from q')
  })

  it('a call already running finishes on the old implementation after a release', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    let finish!: (v: string) => void
    reg.provide('p', 's', { m: () => new Promise<string>((r) => (finish = r)) })
    const p = call(reg.use('c', 's'), 'm')
    await flush()
    reg.release('p')
    finish('old answer')
    await expect(p).resolves.toBe('old answer')
  })
})

describe('ServiceRegistry provider replaced or removed', () => {
  it('a second provide replaces the first: the next call reaches the new implementation', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    reg.provide('p', 's', { v: () => 1 })
    const h = reg.use('c', 's')
    await expect(call(h, 'v')).resolves.toBe(1)
    reg.provide('p', 's', { v: () => 2, extra: () => 'x' })
    await expect(call(h, 'v')).resolves.toBe(2)
    await expect(call(h, 'extra')).resolves.toBe('x')
  })

  it('methods are snapshotted at provide: a later change to the object is not seen', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    const impl: Record<string, () => number> = { v: () => 1 }
    reg.provide('p', 's', impl)
    impl.v = () => 2
    impl.added = () => 3
    const h = reg.use('c', 's')
    await expect(call(h, 'v')).resolves.toBe(1)
    await expect(call(h, 'added')).rejects.toThrow('has no method "added"')
  })

  it('released provider: the call fails with the never-provided error', async () => {
    const { reg, acts } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    acts.finish('p')
    reg.provide('p', 's', { v: () => 1 })
    const h = reg.use('c', 's')
    await expect(call(h, 'v')).resolves.toBe(1)
    reg.release('p')
    await expect(call(h, 'v')).rejects.toThrow('p declares service "s" but did not provide it')
  })

  it('unloaded provider (spec removed): the call fails with the missing error', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    reg.provide('p', 's', { v: () => 1 })
    const h = reg.use('c', 's')
    reg.removeSpec('p')
    reg.release('p')
    await expect(call(h, 'v')).rejects.toThrow('no enabled plugin in this project provides service "s"')
  })
})

describe('ServiceRegistry cycles during activate', () => {
  it('A calls B while B calls A, both activating: the closing call fails at once', async () => {
    const { reg, acts } = setup()
    reg.setSpec(provider('a', { sa: 1 }, { sb: 1 }))
    reg.setSpec(provider('b', { sb: 1 }, { sa: 1 }))
    acts.start('a')
    acts.start('b')
    reg.provide('a', 'sa', { hi: () => 'from a' })
    reg.provide('b', 'sb', { hi: () => 'from b' })
    // a's activate awaits b; b's activate then awaits a.
    const aCall = call(reg.use('a', 'sb'), 'hi')
    expect(await outcome(aCall)).toBe('pending')
    const bCall = call(reg.use('b', 'sa'), 'hi')
    const bResult = await outcome(bCall)
    expect(bResult).toMatchObject({ error: { message: 'b -> a -> b: services called in a cycle during activate' } })
    // b's activate catches and finishes; a's waiting call then reaches b.
    acts.finish('b')
    await expect(aCall).resolves.toBe('from b')
    acts.finish('a')
  })

  it('a three-plugin cycle fails at once, naming the whole path', async () => {
    const { reg, acts } = setup()
    reg.setSpec(provider('a', { sa: 1 }, { sb: 1 }))
    reg.setSpec(provider('b', { sb: 1 }, { sc: 1 }))
    reg.setSpec(provider('c', { sc: 1 }, { sa: 1 }))
    for (const id of ['a', 'b', 'c']) acts.start(id)
    reg.provide('a', 'sa', { hi: () => 'a' })
    reg.provide('b', 'sb', { hi: () => 'b' })
    reg.provide('c', 'sc', { hi: () => 'c' })
    const aCall = call(reg.use('a', 'sb'), 'hi')
    const bCall = call(reg.use('b', 'sc'), 'hi')
    expect(await outcome(aCall)).toBe('pending')
    expect(await outcome(bCall)).toBe('pending')
    const cCall = call(reg.use('c', 'sa'), 'hi')
    expect(await outcome(cCall)).toMatchObject({
      error: { message: 'c -> a -> b -> c: services called in a cycle during activate' }
    })
    // c's activate fails on it: b's wait ends with c's error, then b finishes and a's call goes through.
    acts.finish('c', { state: 'errored', error: 'activate() failed: cycle' })
    await expect(bCall).rejects.toThrow('plugin c failed to activate: activate() failed: cycle')
    acts.finish('b')
    await expect(aCall).resolves.toBe('b')
  })

  it('A calling B during A activate with no cycle works, whether B is active or still activating', async () => {
    const { reg, acts } = setup()
    reg.setSpec(provider('a', { sa: 1 }, { sb: 1 }))
    reg.setSpec(provider('b', { sb: 1 }))
    reg.setSpec(consumer('d', { sa: 1 }))
    acts.start('a')
    acts.start('b')
    reg.provide('b', 'sb', { hi: () => 'b' })
    const aCall = call(reg.use('a', 'sb'), 'hi')
    expect(await outcome(aCall)).toBe('pending')
    // An unrelated consumer waiting on a (d is not activating) adds no edge and closes no cycle.
    reg.provide('a', 'sa', { hi: () => 'a' })
    const dCall = call(reg.use('d', 'sa'), 'hi')
    expect(await outcome(dCall)).toBe('pending')
    acts.finish('b')
    await expect(aCall).resolves.toBe('b')
    // b is now active: a second call during a's activate does not wait.
    await expect(call(reg.use('a', 'sb'), 'hi')).resolves.toBe('b')
    acts.finish('a')
    await expect(dCall).resolves.toBe('a')
  })

  it('a finished wait leaves no edge behind: the reverse call later is not a cycle', async () => {
    const { reg, acts } = setup()
    reg.setSpec(provider('a', { sa: 1 }, { sb: 1 }))
    reg.setSpec(provider('b', { sb: 1 }, { sa: 1 }))
    acts.start('a')
    acts.start('b')
    reg.provide('a', 'sa', { hi: () => 'a' })
    reg.provide('b', 'sb', { hi: () => 'b' })
    const aCall = call(reg.use('a', 'sb'), 'hi')
    acts.finish('b')
    await expect(aCall).resolves.toBe('b')
    // b reloads and calls a while a is still activating: one edge, b -> a, no cycle.
    acts.start('b')
    const bCall = call(reg.use('b', 'sa'), 'hi')
    expect(await outcome(bCall)).toBe('pending')
    acts.finish('a')
    await expect(bCall).resolves.toBe('a')
  })

  it('an edge from a plugin whose activate already ended does not count', async () => {
    const { reg, acts } = setup()
    reg.setSpec(provider('x', { sx: 1 }, { sy: 1 }))
    reg.setSpec(provider('y', { sy: 1 }, { sn: 1 }))
    reg.setSpec(provider('n', { sn: 1 }, { sx: 1 }))
    for (const id of ['x', 'y', 'n']) acts.start(id)
    reg.provide('x', 'sx', { hi: () => 'x' })
    reg.provide('y', 'sy', { hi: () => 'y' })
    reg.provide('n', 'sn', { hi: () => 'n' })
    // Edges y -> n and n -> x.
    const yCall = call(reg.use('y', 'sn'), 'hi')
    const nCall = call(reg.use('n', 'sx'), 'hi')
    expect(await outcome(yCall)).toBe('pending')
    expect(await outcome(nCall)).toBe('pending')
    // n's activate times out; before y's wait has even resumed, x calls y. n's call still waits on
    // x, but n holds no activation back any more, so y -> n -> x is no cycle.
    acts.finish('n', { state: 'errored', error: 'activate() did not finish within 10 s' })
    const xCall = call(reg.use('x', 'sy'), 'hi')
    expect(await outcome(xCall)).toBe('pending')
    await expect(yCall).rejects.toThrow('plugin n failed to activate')
    acts.finish('y')
    await expect(xCall).resolves.toBe('y')
    acts.finish('x')
    await expect(nCall).resolves.toBe('x')
  })
})

describe('ServiceRegistry cycles through active providers (call chain)', () => {
  /** a's activate (in its frame) calls `service`; returns the call and the frame. */
  const fromActivate = (reg: ServiceRegistry, id: string, service: string): { p: Promise<unknown>; end: () => void } => {
    const frame = reg.beginActivate(id)
    return { p: frame.run(() => call(reg.use(id, service), 'hi')), end: () => frame.end() }
  }

  it('A (activating) calls B (active), whose method calls A: fails at once, not after the timeout', async () => {
    const { reg, acts } = setup()
    reg.setSpec(provider('a', { sa: 1 }, { sb: 1 }))
    reg.setSpec(provider('b', { sb: 1 }, { sa: 1 }))
    acts.finish('b')
    acts.start('a')
    reg.provide('a', 'sa', { hi: () => 'from a' })
    const bToA = reg.use('b', 'sa')
    reg.provide('b', 'sb', { hi: () => bToA.hi!() })
    const { p, end } = fromActivate(reg, 'a', 'sb')
    // Before the chain was tracked this stayed pending until a's activate timed out: b is not
    // activating, so no edge a -> b was ever recorded and b's call simply waited on a.
    expect(await outcome(p)).toMatchObject({ error: { message: 'a -> b -> a: services called in a cycle during activate' } })
    end()
    acts.finish('a')
  })

  it('a longer chain through two active providers names every plugin', async () => {
    const { reg, acts } = setup()
    reg.setSpec(provider('a', { sa: 1 }, { sb: 1 }))
    reg.setSpec(provider('b', { sb: 1 }, { sc: 1 }))
    reg.setSpec(provider('c', { sc: 1 }, { sa: 1 }))
    acts.finish('b')
    acts.finish('c')
    acts.start('a')
    reg.provide('a', 'sa', { hi: () => 'a' })
    const bToC = reg.use('b', 'sc')
    const cToA = reg.use('c', 'sa')
    reg.provide('b', 'sb', { hi: () => bToC.hi!() })
    reg.provide('c', 'sc', { hi: async () => cToA.hi!() })
    const { p } = fromActivate(reg, 'a', 'sb')
    expect(await outcome(p)).toMatchObject({ error: { message: 'a -> b -> c -> a: services called in a cycle during activate' } })
  })

  it('a wait through an active provider is an edge: the activation that closes the cycle fails, listing the path', async () => {
    const { reg, acts } = setup()
    reg.setSpec(provider('a', { sa: 1 }, { sb: 1 }))
    reg.setSpec(provider('b', { sb: 1 }, { sc: 1 }))
    reg.setSpec(provider('c', { sc: 1 }, { sa: 1 }))
    acts.finish('b')
    acts.start('a')
    acts.start('c')
    reg.provide('a', 'sa', { hi: () => 'a' })
    reg.provide('c', 'sc', { hi: () => 'c' })
    const bToC = reg.use('b', 'sc')
    reg.provide('b', 'sb', { hi: () => bToC.hi!() })
    // a's activate -> b (active) -> waits on c's activation: the edge a -> c, through b.
    const { p: aCall } = fromActivate(reg, 'a', 'sb')
    expect(await outcome(aCall)).toBe('pending')
    // c's activate (no frame here: the plain mid-activate rule) calls a.
    const cCall = call(reg.use('c', 'sa'), 'hi')
    expect(await outcome(cCall)).toMatchObject({ error: { message: 'c -> a -> b -> c: services called in a cycle during activate' } })
    acts.finish('c')
    await expect(aCall).resolves.toBe('c')
  })

  it('a call chain without a cycle still works: A (activating) -> B (active) -> C (active)', async () => {
    const { reg, acts } = setup()
    reg.setSpec(provider('a', { sa: 1 }, { sb: 1 }))
    reg.setSpec(provider('b', { sb: 1 }, { sc: 1 }))
    reg.setSpec(provider('c', { sc: 1 }))
    acts.finish('b')
    acts.finish('c')
    acts.start('a')
    reg.provide('c', 'sc', { hi: () => 'c' })
    const bToC = reg.use('b', 'sc')
    reg.provide('b', 'sb', { hi: async () => `b+${String(await bToC.hi!())}` })
    await expect(fromActivate(reg, 'a', 'sb').p).resolves.toBe('b+c')
  })

  it('a timer started in activate counts while the activate runs and is unrelated once it ended', async () => {
    const { reg, acts } = setup()
    reg.setSpec(provider('a', { sa: 1 }, { sb: 1 }))
    reg.setSpec(provider('b', { sb: 1 }, { sa: 1 }))
    acts.finish('b')
    acts.start('a')
    reg.provide('a', 'sa', { hi: () => 'a' })
    const bToA = reg.use('b', 'sa')
    reg.provide('b', 'sb', { hi: () => bToA.hi!() })
    const frame = reg.beginActivate('a')
    // A real timer started inside the frame: AsyncLocalStorage carries the chain into it. Resolves
    // once the timer fired, with the call it made (wrapped, so the call's own outcome stays open).
    const fire = (): Promise<{ p: Promise<unknown> }> =>
      frame.run(() => new Promise((r) => setTimeout(() => r({ p: call(reg.use('a', 'sb'), 'hi') }), 0)))
    // While the activate runs: blocking, like any call it makes (documented over-approximation).
    await expect((await fire()).p).rejects.toThrow('a -> b -> a: services called in a cycle')
    // The activate ended (here: timed out) while a is still activating as far as the loader says
    // (say a reload started). The timer's chain is dead: its call just waits for a.
    frame.end()
    const late = (await fire()).p
    expect(await outcome(late)).toBe('pending')
    acts.finish('a')
    await expect(late).resolves.toBe('a')
  })

  it('a method that finished cuts the chain: work it left running is not part of the caller', async () => {
    const { reg, acts } = setup()
    reg.setSpec(provider('a', { sa: 1 }, { sb: 1 }))
    reg.setSpec(provider('b', { sb: 1 }, { sa: 1 }))
    acts.finish('b')
    acts.start('a')
    reg.provide('a', 'sa', { hi: () => 'a' })
    const bToA = reg.use('b', 'sa')
    let open!: () => void
    let later!: Promise<unknown>
    reg.provide('b', 'sb', {
      hi: () => {
        // A continuation registered inside b's method (so it carries the chain a -> b), run after
        // the method returned: a cache refresh, a timer.
        later = new Promise<void>((r) => (open = r)).then(() => bToA.hi!())
        return 'b'
      }
    })
    const frame = reg.beginActivate('a')
    await expect(frame.run(() => call(reg.use('a', 'sb'), 'hi'))).resolves.toBe('b')
    // a's activate is still running, but b's method is done: not a cycle, b's call waits for a.
    open()
    expect(await outcome(later)).toBe('pending')
    frame.end()
    acts.finish('a')
    await expect(later).resolves.toBe('a')
  })

  it('event listeners run outside the emitter\'s chain: a listener calling the activating emitter waits', async () => {
    const { reg, acts, logs } = setup()
    reg.setSpec(provider('a', { sa: 1 }))
    reg.setSpec(consumer('l', { sa: 1 }))
    acts.finish('l')
    acts.start('a')
    reg.provide('a', 'sa', { hi: () => 'a' })
    let fromListener: Promise<unknown> | undefined
    reg.use('l', 'sa').on('ready', () => {
      fromListener = call(reg.use('l', 'sa'), 'hi')
    })
    const frame = reg.beginActivate('a')
    frame.run(() => reg.emit('a', 'sa', 'ready'))
    await flush()
    expect(fromListener).toBeDefined()
    expect(await outcome(fromListener!)).toBe('pending')
    frame.end()
    acts.finish('a')
    await expect(fromListener).resolves.toBe('a')
    expect(logs).toEqual([])
  })
})

describe('ServiceRegistry stale handles', () => {
  it('a handle from before the consumer\'s release cannot call; a new one can', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    let calls = 0
    reg.provide('p', 's', { v: () => ++calls })
    const old = reg.use('c', 's')
    await expect(call(old, 'v')).resolves.toBe(1)
    reg.release('c')
    await expect(call(old, 'v')).rejects.toThrow(
      'service "s": this handle belongs to a previous copy of plugin c; call ctx.services.use again'
    )
    expect(calls).toBe(1)
    await expect(call(reg.use('c', 's'), 'v')).resolves.toBe(2)
  })

  it('a call waiting for the provider\'s activation is refused if the consumer is released meanwhile', async () => {
    const { reg, acts } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    acts.start('p')
    let calls = 0
    reg.provide('p', 's', { v: () => ++calls })
    const waiting = call(reg.use('c', 's'), 'v')
    expect(await outcome(waiting)).toBe('pending')
    reg.release('c')
    acts.finish('p')
    await expect(waiting).rejects.toThrow('this handle belongs to a previous copy of plugin c')
    expect(calls).toBe(0)
  })

  it('a call already running in the provider finishes after the consumer\'s release', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    let finish!: (v: string) => void
    reg.provide('p', 's', { m: () => new Promise<string>((r) => (finish = r)) })
    const p = call(reg.use('c', 's'), 'm')
    await flush()
    reg.release('c')
    finish('done')
    await expect(p).resolves.toBe('done')
  })
})

describe('ServiceRegistry events', () => {
  it('delivers to several consumers, asynchronously and in subscription order', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c1', { s: 1 }))
    reg.setSpec(consumer('c2', { s: 1 }))
    const got: string[] = []
    reg.use('c1', 's').on('changed', (d) => got.push(`c1:${String(d)}`))
    reg.use('c2', 's').on('changed', (d) => got.push(`c2:${String(d)}`))
    reg.use('c2', 's').on('other', () => got.push('wrong event'))
    reg.emit('p', 's', 'changed', 'x')
    // Never inside emit: a listener runs on a later microtask.
    expect(got).toEqual([])
    await flush()
    expect(got).toEqual(['c1:x', 'c2:x'])
  })

  it('the disposer stops delivery, also for an emit already queued, and a second call is harmless', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    const got: unknown[] = []
    const off = reg.use('c', 's').on('e', (d) => got.push(d))
    const kept = reg.use('c', 's').on('e', (d) => got.push(`kept ${String(d)}`))
    reg.emit('p', 's', 'e', 1)
    off()
    await flush()
    expect(got).toEqual(['kept 1'])
    off()
    reg.emit('p', 's', 'e', 2)
    await flush()
    expect(got).toEqual(['kept 1', 'kept 2'])
    kept()
    kept()
    reg.emit('p', 's', 'e', 3)
    await flush()
    expect(got).toEqual(['kept 1', 'kept 2'])
  })

  it('the same listener subscribed twice is two subscriptions, each with its own disposer', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    let n = 0
    const fn = (): void => {
      n++
    }
    const h = reg.use('c', 's')
    const off1 = h.on('e', fn)
    h.on('e', fn)
    reg.emit('p', 's', 'e')
    await flush()
    expect(n).toBe(2)
    off1()
    reg.emit('p', 's', 'e')
    await flush()
    expect(n).toBe(3)
  })

  it("a non-selected provider's emits are dropped and logged once per plugin and service", async () => {
    const { reg, logs } = setup()
    reg.setSpec(provider('a', { s: 1, t: 1 }))
    reg.setSpec(provider('b', { s: 1, t: 1 }))
    reg.setSpec(consumer('c', { s: 1, t: 1 }))
    const got: string[] = []
    reg.use('c', 's').on('e', (d) => got.push(String(d)))
    // Two providers, no pick: nobody is selected.
    reg.emit('a', 's', 'e', 'a1')
    reg.emit('a', 's', 'e', 'a2')
    reg.emit('a', 't', 'e', 'a3')
    await flush()
    expect(got).toEqual([])
    expect(logs).toEqual([
      ['a', 'service "s": events from a are dropped: plugins a and b both provide service "s"; pick one in Settings > Plugins'],
      ['a', 'service "t": events from a are dropped: plugins a and b both provide service "t"; pick one in Settings > Plugins']
    ])
    reg.setChoices({ s: 'b' })
    reg.emit('a', 's', 'e', 'a4')
    reg.emit('b', 's', 'e', 'b1')
    reg.emit('b', 's', 'e', 'b2')
    await flush()
    expect(got).toEqual(['b1', 'b2'])
    // Already logged for a + s; b, the pick, logged nothing.
    expect(logs).toHaveLength(2)
    // A release resets the flags: the next dropped emit is logged again, with the current reason.
    reg.release('a')
    reg.emit('a', 's', 'e', 'a5')
    await flush()
    expect(got).toEqual(['b1', 'b2'])
    expect(logs[2]).toEqual(['a', 'service "s": events from a are dropped: b is the selected provider'])
  })

  it('emit of an undeclared service throws; with no subscribers it is a silent no-op', async () => {
    const { reg, logs } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    expect(() => reg.emit('p', 'other', 'e')).toThrow('plugin p does not declare service "other" in services.provides')
    // A consumer cannot emit on a service it uses.
    expect(() => reg.emit('c', 's', 'e')).toThrow('plugin c does not declare service "s" in services.provides')
    expect(() => reg.emit('p', 's', 'nobody', { x: 1 })).not.toThrow()
    await flush()
    expect(logs).toEqual([])
  })

  it('a listener throw (or an async rejection) is contained and logged to the consumer', async () => {
    const { reg, logs } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c1', { s: 1 }))
    reg.setSpec(consumer('c2', { s: 1 }))
    const got: unknown[] = []
    reg.use('c1', 's').on('e', () => {
      throw new Error('listener broke')
    })
    reg.use('c1', 's').on('e', async () => {
      await flush()
      throw new Error('later broke')
    })
    reg.use('c2', 's').on('e', (d) => got.push(d))
    expect(() => reg.emit('p', 's', 'e', 7)).not.toThrow()
    await flush()
    await flush()
    expect(got).toEqual([7])
    expect(logs).toEqual([
      ['c1', 'service "s": listener for "e" threw: listener broke'],
      ['c1', 'service "s": listener for "e" threw: later broke']
    ])
  })

  it('subscriptions survive a provider release and re-provide, and a swap to another provider', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    const got: unknown[] = []
    reg.use('c', 's').on('e', (d) => got.push(d))
    reg.provide('p', 's', { m: () => 1 })
    reg.emit('p', 's', 'e', 'before')
    await flush()
    // The provider reloads: released, then provides again from its new activate.
    reg.release('p')
    reg.provide('p', 's', { m: () => 2 })
    reg.emit('p', 's', 'e', 'after reload')
    await flush()
    // Another provider appears and is picked: its events reach the same subscription.
    reg.setSpec(provider('q', { s: 1 }))
    reg.setChoices({ s: 'q' })
    reg.emit('q', 's', 'e', 'from q')
    reg.emit('p', 's', 'e', 'from p, not picked')
    await flush()
    expect(got).toEqual(['before', 'after reload', 'from q'])
  })

  it('a released consumer receives nothing, even an emit already queued; others keep theirs', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    reg.setSpec(consumer('d', { s: 1 }))
    const got: string[] = []
    const old = reg.use('c', 's')
    const off = old.on('e', (d) => got.push(`c:${String(d)}`))
    reg.use('d', 's').on('e', (d) => got.push(`d:${String(d)}`))
    reg.emit('p', 's', 'e', 1)
    reg.release('c')
    await flush()
    expect(got).toEqual(['d:1'])
    reg.emit('p', 's', 'e', 2)
    await flush()
    expect(got).toEqual(['d:1', 'd:2'])
    // The old copy's disposer is harmless; its handle may not subscribe again (a leftover timer
    // would otherwise listen beside the new copy).
    expect(() => off()).not.toThrow()
    expect(() => old.on('e', () => {})).toThrow('this handle belongs to a previous copy of plugin c; call ctx.services.use again')
    // The new copy subscribes through a new handle.
    reg.use('c', 's').on('e', (d) => got.push(`new c:${String(d)}`))
    reg.emit('p', 's', 'e', 3)
    await flush()
    expect(got).toEqual(['d:1', 'd:2', 'd:3', 'new c:3'])
  })

  it('data is copied at emit and once per listener: no listener sees another one or the emitter mutate it', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c1', { s: 1 }))
    reg.setSpec(consumer('c2', { s: 1 }))
    const seen: { list: number[] }[] = []
    reg.use('c1', 's').on('e', (d) => {
      const data = d as { list: number[] }
      data.list.push(99)
      seen.push(data)
    })
    reg.use('c2', 's').on('e', (d) => seen.push(d as { list: number[] }))
    const sent = { list: [1] }
    reg.emit('p', 's', 'e', sent)
    // A change after emit returns is not seen.
    sent.list.push(2)
    await flush()
    expect(seen[0]!.list).toEqual([1, 99])
    expect(seen[1]!.list).toEqual([1])
    expect(seen[0]).not.toBe(seen[1])
    expect(seen[0]).not.toBe(sent)
    expect(sent.list).toEqual([1, 2])
  })

  it('a function or symbol in the data is the plain-data error, thrown by emit even with no listener', async () => {
    const { reg, logs } = setup()
    reg.setSpec(provider('a', { s: 1 }))
    reg.setSpec(provider('b', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    reg.setChoices({ s: 'a' })
    let calls = 0
    reg.use('c', 's').on('e', () => calls++)
    expect(() => reg.emit('a', 's', 'e', { cb: () => 1 })).toThrow(
      /^service "s" event "e": the data must be plain data \(no functions or symbols\): /
    )
    expect(() => reg.emit('a', 's', 'e', Symbol('x'))).toThrow('the data must be plain data')
    expect(() => reg.emit('a', 's', 'quiet', { cb: () => 1 })).toThrow('the data must be plain data')
    // Checked before the drop: the non-selected provider hears about the bug too.
    expect(() => reg.emit('b', 's', 'e', { cb: () => 1 })).toThrow('the data must be plain data')
    await flush()
    expect(calls).toBe(0)
    expect(logs).toEqual([])
  })

  it('invalid event names are refused by emit and on; valid ones use the documented characters', () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    const h = reg.use('c', 's')
    for (const bad of ['', '1abc', '_x', 'has space', 'a/b', 'x'.repeat(65), 'é']) {
      expect(() => reg.emit('p', 's', bad)).toThrow(`service "s": event name "${bad}" is invalid`)
      expect(() => h.on(bad, () => {})).toThrow(`service "s": event name "${bad}" is invalid`)
    }
    expect(() => reg.emit('p', 's', 42 as unknown as string)).toThrow('event name of type number is invalid')
    for (const good of ['a', 'rulesChanged', 'mail.new', 'item:updated', 'a_b-c', 'x'.repeat(64)]) {
      expect(() => reg.emit('p', 's', good)).not.toThrow()
      expect(() => h.on(good, () => {})).not.toThrow()
    }
  })

  it('on refuses a non-function listener and a consumer whose reload dropped the use', () => {
    const { reg } = setup()
    reg.setSpec(consumer('c', { s: 1 }))
    const h = reg.use('c', 's')
    expect(() => h.on('e', 'nope' as unknown as () => void)).toThrow('service "s": the listener for "e" must be a function')
    reg.setSpec(consumer('c', {}))
    expect(() => h.on('e', () => {})).toThrow('plugin c does not declare service "s" in services.uses')
  })

  it('a consumer with another major gets no events until the versions agree', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('old', { s: 1 }))
    reg.setSpec(consumer('new', { s: 2 }))
    const got: string[] = []
    reg.use('old', 's').on('e', (d) => got.push(`old:${String(d)}`))
    reg.use('new', 's').on('e', (d) => got.push(`new:${String(d)}`))
    reg.emit('p', 's', 'e', 1)
    await flush()
    expect(got).toEqual(['old:1'])
    // The provider reloads at version 2: the subscriptions stay, the deliveries follow the versions.
    reg.setSpec(provider('p', { s: 2 }))
    reg.emit('p', 's', 'e', 2)
    await flush()
    expect(got).toEqual(['old:1', 'new:2'])
  })
})

describe('ServiceRegistry caller()', () => {
  /** A gate a test opens by hand, to hold a method mid-call. */
  const gate = (): { wait: Promise<void>; open: () => void } => {
    let open!: () => void
    const wait = new Promise<void>((r) => (open = r))
    return { wait, open }
  }

  it('two consumers each see their own id, taken from the handle, not the arguments', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c1', { s: 1 }))
    reg.setSpec(consumer('c2', { s: 1 }))
    reg.provide('p', 's', { who: () => reg.caller('p') })
    await expect(call(reg.use('c1', 's'), 'who')).resolves.toBe('c1')
    await expect(call(reg.use('c2', 's'), 'who')).resolves.toBe('c2')
    // An argument naming someone else changes nothing.
    await expect(call(reg.use('c1', 's'), 'who', { caller: 'c2' })).resolves.toBe('c1')
  })

  it('nested A -> B -> C: C sees B; B sees A before and after its await of C', async () => {
    const { reg } = setup()
    reg.setSpec(consumer('a', { sb: 1 }))
    reg.setSpec(provider('b', { sb: 1 }, { sc: 1 }))
    reg.setSpec(provider('c', { sc: 1 }))
    reg.provide('c', 'sc', { who: async () => {
      await flush()
      return reg.caller('c')
    } })
    const bToC = reg.use('b', 'sc')
    reg.provide('b', 'sb', { who: async () => {
      const before = reg.caller('b')
      const inC = await bToC.who!()
      return { before, inC, after: reg.caller('b') }
    } })
    await expect(call(reg.use('a', 'sb'), 'who')).resolves.toEqual({ before: 'a', inC: 'b', after: 'a' })
  })

  it('concurrent calls from two consumers do not mix ids', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c1', { s: 1 }))
    reg.setSpec(consumer('c2', { s: 1 }))
    const g1 = gate()
    const g2 = gate()
    const gates: Record<string, Promise<void>> = { one: g1.wait, two: g2.wait }
    reg.provide('p', 's', { who: async (name: string) => {
      const start = reg.caller('p')
      await gates[name]
      return [start, reg.caller('p')]
    } })
    const p1 = call(reg.use('c1', 's'), 'who', 'one')
    const p2 = call(reg.use('c2', 's'), 'who', 'two')
    await flush()
    // Both are mid-call; release them in the opposite order of their start.
    g2.open()
    g1.open()
    await expect(p1).resolves.toEqual(['c1', 'c1'])
    await expect(p2).resolves.toEqual(['c2', 'c2'])
  })

  it('undefined outside any call, in activate, in an event listener and for a plugin not serving the call', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    expect(reg.caller('p')).toBeUndefined()
    const frame = reg.beginActivate('p')
    expect(frame.run(() => reg.caller('p'))).toBeUndefined()
    frame.end()
    let inListener: unknown = 'unset'
    reg.use('c', 's').on('ev', () => {
      inListener = [reg.caller('c'), reg.caller('p')]
    })
    reg.provide('p', 's', { go: () => {
      // Emitted inside c's call: the listener still runs outside it.
      reg.emit('p', 's', 'ev')
      // Another plugin's code running in p's frame (one realm) is not serving this call.
      return reg.caller('c')
    } })
    await expect(call(reg.use('c', 's'), 'go')).resolves.toBeUndefined()
    await flush()
    expect(inListener).toEqual([undefined, undefined])
    expect(reg.caller('p')).toBeUndefined()
  })

  it('a timer started during a call sees the id while the call runs and undefined after it returned', async () => {
    const { reg } = setup()
    reg.setSpec(provider('p', { s: 1 }))
    reg.setSpec(consumer('c', { s: 1 }))
    const seen: Record<string, unknown> = {}
    const timerFired = gate()
    const late = gate()
    let finish!: () => void
    reg.provide('p', 's', { work: async () => {
      setTimeout(() => {
        seen.during = reg.caller('p')
        timerFired.open()
      }, 0)
      // Started now, fires once the test says so, after the call returned.
      void late.wait.then(() => setTimeout(() => (seen.after = reg.caller('p'), finish()), 0))
      await timerFired.wait
      return 'done'
    } })
    await expect(call(reg.use('c', 's'), 'work')).resolves.toBe('done')
    const afterDone = new Promise<void>((r) => (finish = r))
    late.open()
    await afterDone
    expect(seen).toEqual({ during: 'c', after: undefined })
  })
})
