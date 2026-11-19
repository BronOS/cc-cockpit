// The remote windows' loopback block by address (remote-windows.ts `checkRemoteRequest`): whether a
// host a remote server's page sends a request to reaches this machine, decided by what the name
// resolves to, not by how it is spelled. The name rule (`isLoopbackHost`) catches `localhost` and the
// loopback literals; a DNS name that resolves to 127.0.0.1 (public wildcard names such as
// `*.localtest.me`, a rebinding domain) or to one of this machine's own interface addresses (its LAN
// address, where a dev server listening on 0.0.0.0 answers) passed it and reached a local listener.
// Chromium does not stop these either: in Electron 45 (Chromium 156) a page on `http://127.0.0.1:<L>`
// and one on a LAN address both reached a listener through a name mapped to 127.0.0.1 and through the
// machine's own LAN address, with every permission denied (Local Network Access asked for none).
//
// What refuses: any resolved address that is loopback (127/8, ::1), unspecified (0/8, ::), the
// IPv4-mapped or -compatible form of those, or an address of one of this machine's interfaces (read
// on every decision, so a VPN or Wi-Fi coming up counts at once). A name answering several addresses
// is refused when any one of them does: Chromium may connect to whichever.
//
// Fail closed. A lookup that errors, times out (LOOKUP_TIMEOUT_MS), answers nothing, answers an
// address that does not parse, or cannot be queued (LOOKUP_QUEUE_MAX) refuses the request: a name
// main cannot resolve is one Chromium most likely cannot reach either, so the refusal costs one page
// request (a broken image, a socket the web client retries); allowing would let a page that makes
// main's lookup fail (a slow name, a flood of unique names) skip the check.
//
// Cost. Only a request outside the server's own origin and past the name rule gets here (the web
// client's own traffic never does), and an IP literal is classified with no lookup. `dns.lookup` runs
// on libuv's thread pool, which file I/O shares and which has no timeout of its own, so at most
// LOOKUPS_MAX run at once and the rest wait in a bounded queue; the verdict's timeout counts from the
// ask, and a lookup still running after it keeps its slot until it ends (a hostile page's slow names
// cannot pile up threads). Addresses, not verdicts, are cached per name (LOOKUP_CACHE_MS, at most
// LOOKUP_CACHE_MAX names), and a failed lookup for LOOKUP_ERROR_CACHE_MS; concurrent asks for one name
// share one lookup.
//
// The limit: this is main's own lookup, and Chromium resolves the name again for the real request.
// A rebinding name (TTL 0, answers flipping between a public address and 127.0.0.1) can answer main
// one way and Chromium the other, and the cache keeps an allowed answer for LOOKUP_CACHE_MS. So the
// check narrows the hole (wildcard loopback names, a stable name for the LAN address, and a rebinding
// name on most tries) and does not close it: Electron offers no way to pin the address the request
// connects to. What is left is what the backlog item named: an unauthenticated request to a local
// service, since the device cookie is host-only and goes to the server's own host name alone.
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIPv4, isIPv6 } from 'node:net'
import { networkInterfaces } from 'node:os'

/** How long a name's resolved addresses are reused. */
export const LOOKUP_CACHE_MS = 10_000
/** How long a failed lookup refuses its name before it is tried again. */
export const LOOKUP_ERROR_CACHE_MS = 2_000
/** Names kept in the cache at most (the oldest go first). */
export const LOOKUP_CACHE_MAX = 256
/** A verdict waits this long for its lookup, queueing included; past it the request is refused. */
export const LOOKUP_TIMEOUT_MS = 5_000
/** Lookups running at once (libuv's pool has four threads, shared with file I/O). */
export const LOOKUPS_MAX = 2
/** Names waiting for a lookup slot at most; one more is refused at once. */
export const LOOKUP_QUEUE_MAX = 64

export interface LocalAddressTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface LocalAddressDeps {
  /** Every address `host` resolves to (`dns.lookup` with `all: true` in the app; a fake in tests). */
  lookup(host: string): Promise<ReadonlyArray<{ address: string }>>
  /** This machine's interface addresses (`os.networkInterfaces()` in the app; a fake in tests). */
  interfaceAddresses(): string[]
  now?(): number
  timers?: LocalAddressTimers
}

/** The app's resolver: the system's, as Node's `dns.lookup` asks it (hosts file included). */
export function systemLookup(host: string): Promise<ReadonlyArray<{ address: string }>> {
  return dnsLookup(host, { all: true, order: 'verbatim' })
}

/** The app's interface addresses, every interface (loopback ones included). */
export function systemInterfaceAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) for (const entry of list ?? []) out.push(entry.address)
  return out
}

const realTimers: LocalAddressTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** The eight 16-bit groups of IPv6 address `v6` (already checked by `isIPv6`, no zone). */
function v6Groups(v6: string): number[] | undefined {
  let text = v6
  // An embedded dotted IPv4 tail (`::ffff:127.0.0.1`, as `dns.lookup` writes it) is two hex groups.
  const lastColon = text.lastIndexOf(':')
  const last = text.slice(lastColon + 1)
  if (isIPv4(last)) {
    const [a, b, c, d] = last.split('.').map(Number) as [number, number, number, number]
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const parse = (part: string): number[] => (part === '' ? [] : part.split(':').map((g) => Number.parseInt(g, 16)))
  const head = parse(halves[0] as string)
  const rest = halves.length === 2 ? parse(halves[1] as string) : []
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
  if (fill < 0) return undefined
  const groups = [...head, ...new Array<number>(fill).fill(0), ...rest]
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return undefined
  return groups
}

/**
 * Address `text` in one canonical form, or undefined when it is not an IP address: brackets, a zone id
 * (`fe80::1%lo0`) and case dropped; an IPv4 address as itself; the IPv4-mapped (`::ffff:a.b.c.d`) and
 * IPv4-compatible (`::a.b.c.d`, `::` and `::1` included) forms as the IPv4 address they carry; any
 * other IPv6 address as its eight groups in hex, uncompressed. `dns.lookup`, `os.networkInterfaces()`
 * and `URL` each write some of these differently, so both sides go through this before comparing.
 */
export function canonicalAddress(text: string): string | undefined {
  let a = text.trim().toLowerCase()
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1)
  const zone = a.indexOf('%')
  if (zone >= 0) a = a.slice(0, zone)
  if (isIPv4(a)) return a
  if (!isIPv6(a)) return undefined
  const groups = v6Groups(a)
  if (groups === undefined) return undefined
  const high = groups.slice(0, 5)
  if (high.every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    const g6 = groups[6] as number
    const g7 = groups[7] as number
    return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`
  }
  return groups.map((g) => g.toString(16)).join(':')
}

/**
 * Whether canonical address `address` (`canonicalAddress`) is this machine: loopback or unspecified
 * (127/8 and 0/8; `::1` and `::` are 0.0.0.1 and 0.0.0.0 in canonical form), or one of `own`.
 */
function isThisMachine(address: string, own: ReadonlySet<string>): boolean {
  if (isIPv4(address)) {
    const first = Number(address.slice(0, address.indexOf('.')))
    if (first === 127 || first === 0) return true
  }
  return own.has(address)
}

interface CacheEntry {
  at: number
  /** The canonical addresses; undefined: the lookup failed (refused until LOOKUP_ERROR_CACHE_MS). */
  addresses: string[] | undefined
}

/** See the header. One per app: every remote server's partition asks the same one. */
export class LocalAddressCheck {
  private readonly now: () => number
  private readonly timers: LocalAddressTimers
  private readonly cache = new Map<string, CacheEntry>()
  /** The lookup per name in progress (shared by its concurrent asks). */
  private readonly inFlight = new Map<string, Promise<string[] | undefined>>()
  /** Names waiting for a slot, in order. */
  private readonly queue: Array<() => void> = []
  private running = 0

  constructor(private readonly deps: LocalAddressDeps) {
    this.now = deps.now ?? Date.now
    this.timers = deps.timers ?? realTimers
  }

  /**
   * Whether a request to `hostname` (`URL.hostname`: lower case, IPv6 bracketed) may go out: false when
   * it is, or resolves to, this machine (see the header). Synchronous for an IP literal and a cached
   * name; a promise, which never rejects, when a lookup is needed.
   */
  allows(hostname: string): boolean | Promise<boolean> {
    const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname
    if (host === '') return false
    const literal = canonicalAddress(host)
    if (literal !== undefined) return !isThisMachine(literal, this.ownAddresses())
    const cached = this.cached(host)
    if (cached !== null) return this.verdict(cached)
    let pending = this.inFlight.get(host)
    if (pending === undefined) {
      if (this.running >= LOOKUPS_MAX && this.queue.length >= LOOKUP_QUEUE_MAX) return false
      pending = this.resolve(host)
      this.inFlight.set(host, pending)
    }
    return this.withTimeout(pending).then((addresses) => this.verdict(addresses))
  }

  /** The cached addresses of `host` (undefined: a failed lookup), or null for nothing fresh. */
  private cached(host: string): string[] | undefined | null {
    const entry = this.cache.get(host)
    if (entry === undefined) return null
    const ttl = entry.addresses === undefined ? LOOKUP_ERROR_CACHE_MS : LOOKUP_CACHE_MS
    if (this.now() - entry.at < ttl) return entry.addresses
    this.cache.delete(host)
    return null
  }

  private verdict(addresses: string[] | undefined): boolean {
    if (addresses === undefined) return false
    const own = this.ownAddresses()
    return !addresses.some((address) => isThisMachine(address, own))
  }

  private ownAddresses(): Set<string> {
    const own = new Set<string>()
    for (const raw of this.deps.interfaceAddresses()) {
      const address = canonicalAddress(raw)
      if (address !== undefined) own.add(address)
    }
    return own
  }

  /** One lookup of `host` in a slot; never rejects (undefined: failed, empty or unparseable). */
  private async resolve(host: string): Promise<string[] | undefined> {
    // A waiter is handed the slot of the lookup that ends (`running` unchanged), so a fresh ask in
    // between cannot take it too.
    if (this.running >= LOOKUPS_MAX) await new Promise<void>((go) => this.queue.push(go))
    else this.running++
    let addresses: string[] | undefined
    try {
      const answers = await this.deps.lookup(host)
      const parsed = answers.map((a) => canonicalAddress(a.address))
      // An answer that does not parse is not one main can judge: refused like a failure.
      addresses = parsed.length > 0 && parsed.every((a) => a !== undefined) ? (parsed as string[]) : undefined
    } catch {
      addresses = undefined
    } finally {
      const next = this.queue.shift()
      if (next !== undefined) next()
      else this.running--
    }
    this.inFlight.delete(host)
    this.remember(host, addresses)
    return addresses
  }

  private remember(host: string, addresses: string[] | undefined): void {
    this.cache.delete(host)
    this.cache.set(host, { at: this.now(), addresses })
    while (this.cache.size > LOOKUP_CACHE_MAX) {
      const oldest = this.cache.keys().next().value as string
      this.cache.delete(oldest)
    }
  }

  /** `pending`, or undefined (refused) once LOOKUP_TIMEOUT_MS passed; the lookup itself runs on. */
  private withTimeout(pending: Promise<string[] | undefined>): Promise<string[] | undefined> {
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS)
      void pending.then((addresses) => {
        this.timers.clearTimeout(timer)
        resolve(addresses)
      })
    })
  }
}
