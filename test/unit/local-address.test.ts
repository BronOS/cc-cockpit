// The remote windows' loopback block by address (local-address.ts): a host name is judged by what it
// resolves to and by this machine's interfaces, both faked here (never real DNS), plus the cache, the
// timeout, the queue and fail-closed on every failure.
import { describe, expect, it } from 'vitest'
import {
  LOOKUP_CACHE_MAX,
  LOOKUP_CACHE_MS,
  LOOKUP_ERROR_CACHE_MS,
  LOOKUP_QUEUE_MAX,
  LOOKUP_TIMEOUT_MS,
  LOOKUPS_MAX,
  LocalAddressCheck,
  canonicalAddress,
  type LocalAddressTimers
} from '../../src/main/remote/local-address'

const LAN = '10.0.10.91'
const INTERFACES = ['127.0.0.1', '::1', 'fe80::1%lo0', LAN, 'fe80::1c2b:3d4e:5f60:7182%en0', '2001:db8::5']

class FakeTimers implements LocalAddressTimers {
  private next = 0
  readonly pending = new Map<number, () => void>()
  readonly delays: number[] = []
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.next
    this.delays.push(ms)
    this.pending.set(id, fn)
    return id
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number)
  }
  fireAll(): void {
    const fns = [...this.pending.values()]
    this.pending.clear()
    for (const fn of fns) fn()
  }
}

interface Deferred {
  host: string
  resolve(addresses: string[]): void
  reject(err: Error): void
}

function setup(answers: Record<string, string[] | Error> = {}) {
  let clock = 1_000_000
  const lookups: string[] = []
  const deferred: Deferred[] = []
  let manual = false
  let interfaces = [...INTERFACES]
  const timers = new FakeTimers()
  const check = new LocalAddressCheck({
    lookup: (host) => {
      lookups.push(host)
      if (manual) {
        return new Promise((resolve, reject) => {
          deferred.push({ host, resolve: (list) => resolve(list.map((address) => ({ address }))), reject })
        })
      }
      const answer = answers[host]
      if (answer === undefined) return Promise.reject(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }))
      if (answer instanceof Error) return Promise.reject(answer)
      return Promise.resolve(answer.map((address) => ({ address })))
    },
    interfaceAddresses: () => interfaces,
    now: () => clock,
    timers
  })
  return {
    check,
    lookups,
    deferred,
    timers,
    manual: () => void (manual = true),
    setInterfaces: (list: string[]) => void (interfaces = list),
    tick: (ms: number) => void (clock += ms)
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('canonicalAddress', () => {
  it('writes each spelling of an address the same way', () => {
    expect(canonicalAddress('127.0.0.1')).toBe('127.0.0.1')
    // dns.lookup's mapped form, URL's hex form and the bracketed host name all agree.
    expect(canonicalAddress('::ffff:127.0.0.1')).toBe('127.0.0.1')
    expect(canonicalAddress('[::ffff:7f00:1]')).toBe('127.0.0.1')
    expect(canonicalAddress('::FFFF:10.0.10.91')).toBe(LAN)
    expect(canonicalAddress('::127.0.0.1')).toBe('127.0.0.1')
    expect(canonicalAddress('::1')).toBe('0.0.0.1')
    expect(canonicalAddress('[::]')).toBe('0.0.0.0')
    // A zone id is dropped; compressed and full forms agree.
    expect(canonicalAddress('fe80::1%lo0')).toBe('fe80:0:0:0:0:0:0:1')
    expect(canonicalAddress('FE80:0000:0000:0000:0000:0000:0000:0001')).toBe('fe80:0:0:0:0:0:0:1')
    expect(canonicalAddress('2001:db8::5')).toBe('2001:db8:0:0:0:0:0:5')
    for (const text of ['example.com', '', '1.2.3', '::ffff:1.2.3.4.5', 'localhost']) expect(canonicalAddress(text), text).toBeUndefined()
  })
})

describe('LocalAddressCheck', () => {
  it('refuses a name resolving to loopback, in any form', async () => {
    const t = setup({
      'evil.localtest.me': ['127.0.0.1'],
      'v6.example': ['::1'],
      'mapped.example': ['::ffff:127.0.0.1'],
      'other127.example': ['127.9.8.7'],
      'mixed.example': ['93.184.216.34', '127.0.0.1']
    })
    for (const host of ['evil.localtest.me', 'v6.example', 'mapped.example', 'other127.example', 'mixed.example']) {
      expect(await t.check.allows(host), host).toBe(false)
    }
  })

  it('refuses a name resolving to the unspecified address', async () => {
    const t = setup({ 'zero.example': ['0.0.0.0'], 'zero6.example': ['::'] })
    expect(await t.check.allows('zero.example')).toBe(false)
    expect(await t.check.allows('zero6.example')).toBe(false)
  })

  it('refuses a name resolving to one of this machine own interface addresses', async () => {
    const t = setup({
      'lan.example': [LAN],
      'lanmapped.example': [`::ffff:${LAN}`],
      'linklocal.example': ['fe80::1c2b:3d4e:5f60:7182%en0'],
      'v6own.example': ['2001:0db8:0000:0000:0000:0000:0000:0005']
    })
    for (const host of ['lan.example', 'lanmapped.example', 'linklocal.example', 'v6own.example']) {
      expect(await t.check.allows(host), host).toBe(false)
    }
  })

  it('lets a public address and another machine on the LAN through', async () => {
    const t = setup({ 'example.com': ['93.184.216.34', '2606:2800:220:1::'], 'devbox.lan': ['10.0.20.115'] })
    expect(await t.check.allows('example.com')).toBe(true)
    expect(await t.check.allows('devbox.lan')).toBe(true)
    // A trailing dot is the same name.
    expect(await t.check.allows('example.com.')).toBe(true)
    expect(t.lookups).toEqual(['example.com', 'devbox.lan'])
  })

  it('judges IP literals with no lookup, synchronously', () => {
    const t = setup()
    expect(t.check.allows(LAN)).toBe(false)
    expect(t.check.allows('[::ffff:a00:a5b]')).toBe(false)
    expect(t.check.allows('[2001:db8::5]')).toBe(false)
    expect(t.check.allows('127.0.0.1')).toBe(false)
    expect(t.check.allows('10.0.20.115')).toBe(true)
    expect(t.check.allows('[2606:2800:220:1::]')).toBe(true)
    expect(t.lookups).toEqual([])
  })

  it('fails closed on a lookup error, an empty or unparseable answer, and caches the failure briefly', async () => {
    const t = setup({ 'empty.example': [], 'odd.example': ['not-an-address'], 'boom.example': new Error('EAI_AGAIN') })
    expect(await t.check.allows('missing.example')).toBe(false)
    expect(await t.check.allows('empty.example')).toBe(false)
    expect(await t.check.allows('odd.example')).toBe(false)
    expect(await t.check.allows('boom.example')).toBe(false)
    expect(t.lookups).toHaveLength(4)
    // Refused from the cache (synchronously), then asked again once LOOKUP_ERROR_CACHE_MS passed.
    expect(t.check.allows('boom.example')).toBe(false)
    expect(t.lookups).toHaveLength(4)
    t.tick(LOOKUP_ERROR_CACHE_MS)
    expect(await t.check.allows('boom.example')).toBe(false)
    expect(t.lookups).toHaveLength(5)
  })

  it('caches addresses per name, judges them against the current interfaces, and expires them', async () => {
    const t = setup({ 'host.example': ['192.168.50.7'] })
    expect(await t.check.allows('host.example')).toBe(true)
    // A cached name answers synchronously, with no second lookup.
    expect(t.check.allows('host.example')).toBe(true)
    expect(t.lookups).toEqual(['host.example'])
    // An interface coming up with that address (a VPN) counts at once, cache or not.
    t.setInterfaces([...INTERFACES, '192.168.50.7'])
    expect(t.check.allows('host.example')).toBe(false)
    t.setInterfaces(INTERFACES)
    t.tick(LOOKUP_CACHE_MS - 1)
    expect(t.check.allows('host.example')).toBe(true)
    t.tick(1)
    expect(await t.check.allows('host.example')).toBe(true)
    expect(t.lookups).toEqual(['host.example', 'host.example'])
  })

  it('keeps at most LOOKUP_CACHE_MAX names, the oldest going first', async () => {
    const answers: Record<string, string[]> = {}
    for (let i = 0; i <= LOOKUP_CACHE_MAX; i++) answers[`h${i}.example`] = ['93.184.216.34']
    const t = setup(answers)
    for (let i = 0; i <= LOOKUP_CACHE_MAX; i++) await t.check.allows(`h${i}.example`)
    expect(t.lookups).toHaveLength(LOOKUP_CACHE_MAX + 1)
    expect(t.check.allows(`h${LOOKUP_CACHE_MAX}.example`)).toBe(true)
    expect(await t.check.allows('h0.example')).toBe(true)
    expect(t.lookups).toHaveLength(LOOKUP_CACHE_MAX + 2)
  })

  it('shares one lookup between concurrent asks for a name', async () => {
    const t = setup()
    t.manual()
    const a = t.check.allows('slow.example')
    const b = t.check.allows('slow.example')
    expect(t.lookups).toEqual(['slow.example'])
    t.deferred[0]?.resolve(['127.0.0.1'])
    expect(await a).toBe(false)
    expect(await b).toBe(false)
  })

  it('refuses after LOOKUP_TIMEOUT_MS, the lookup keeping its slot until it ends', async () => {
    const t = setup()
    t.manual()
    const asks = Array.from({ length: LOOKUPS_MAX }, (_, i) => t.check.allows(`slow${i}.example`))
    expect(t.lookups).toHaveLength(LOOKUPS_MAX)
    const queued = t.check.allows('queued.example')
    await flush()
    // Every slot is taken: the next name waits, it is not looked up yet.
    expect(t.lookups).toHaveLength(LOOKUPS_MAX)
    expect(t.timers.delays.every((ms) => ms === LOOKUP_TIMEOUT_MS)).toBe(true)
    t.timers.fireAll()
    for (const ask of asks) expect(await ask).toBe(false)
    expect(await queued).toBe(false)
    // Timed out, but still running: the queued lookup starts only when one ends.
    expect(t.lookups).toHaveLength(LOOKUPS_MAX)
    t.deferred[0]?.resolve(['93.184.216.34'])
    await flush()
    expect(t.lookups.at(-1)).toBe('queued.example')
  })

  it('refuses at once when the queue is full', async () => {
    const t = setup()
    t.manual()
    for (let i = 0; i < LOOKUPS_MAX + LOOKUP_QUEUE_MAX; i++) void t.check.allows(`n${i}.example`)
    await flush()
    expect(t.check.allows('one-more.example')).toBe(false)
    // A name already being looked up still joins its lookup.
    expect(t.check.allows('n0.example')).toBeInstanceOf(Promise)
  })
})
