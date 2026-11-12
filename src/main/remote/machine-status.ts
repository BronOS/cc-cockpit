// The other machines in the sessions strip (design-remote-desktop.md §4.1): for every server with a
// remote window open, main asks its SESSIONS_PATH (`{ waiting, working, idle }` over the server's
// Claude tabs) through that server's partition, so the device cookie applies, at once when its first
// window opens and every POLL_MS after each answer, and stops when its last window closes. Nothing is
// asked for a server with no window. Plugins read the result through ctx.sessions.machines() /
// onMachinesChange (host-api.ts, the `"access": { "sessions": "all-windows" }` declaration).
//
// What a machine reads as:
//  - not answered yet: reachable, no counts (the chip shows at once, with the name only);
//  - a 200 with three counts: reachable, with them;
//  - a 404 (an older server with no SESSIONS_PATH) or a 200 that is not three counts: reachable, no
//    counts (it answered, it just has nothing to say);
//  - anything else (no answer, a timeout, a 401 because the device was revoked or the cookie is not
//    in yet, a 5xx): unreachable, no counts. No origin key known yet (RemoteNoKeyError: the window's
//    page has not loaded or signed in, so main has nothing to ask with) is no answer either way: the
//    reading stays as it was and the ask goes again after NO_KEY_RETRY_MS. Stale counts are dropped rather than kept dimmed: a
//    "2 waiting" the server can no longer confirm would send the person to a window that shows
//    otherwise. A 401 is reachable in the network sense, but the chip can show nothing true about it,
//    and the window itself shows the sign-in.
// Only a change of the list (a machine added or gone, a name, a state, a count) is announced, so the
// 5 s polls of an idle server cost the plugin hosts nothing.
//
// Ids. Each server gets an opaque machine id minted here, once per run, kept while the app runs (a
// window closed and reopened keeps its chip's key). Never the saved server id: that one is the record
// key every `remote.*` channel of the picker acts on (connect, edit, forget) and names the server's
// persistent partition (its cookie jar). A plugin needs neither, and handing it out would make any
// later path that takes a server id reachable with a plugin-learned value. A per-run id also tells a
// plugin nothing it could match across runs. No address, no `via`, nothing secret leaves here: the
// name is the person's own label for the server, from the local record, and only when they chose one
// (`chosenServerName`): a server's default name is its SSH host or the link's host, so an unnamed one
// is `Server <n>` instead, numbered in the order the servers were first listed in this run.
import { randomBytes } from 'node:crypto'
import { errorText } from '../../shared/error-text'
import { SESSIONS_PATH } from '../../shared/web-protocol'
import { warnLog } from '../warn-log'
import { RemoteHttpError, RemoteNoKeyError } from './remote-windows'

/** How long after an answer (or a failure) the next ask goes out. */
export const POLL_MS = 5_000
/** How soon the ask goes again when it could not go for want of an origin key (the page is loading). */
export const NO_KEY_RETRY_MS = 1_000
/** The highest count read from a server; a bigger one is not a count (no machine runs that many tabs). */
export const MAX_MACHINE_COUNT = 100_000

/** One server as plugins see it (ctx.sessions.machines, src/sdk/types.ts `MachineInfo`). */
export interface MachineInfo {
  id: string
  name: string
  reachable: boolean
  waiting?: number
  working?: number
  idle?: number
}

export interface MachineStatusTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface MachineStatusOptions {
  /** The servers with a remote window open now, in a stable order (RemoteWindows.serverIds). */
  servers(): string[]
  /**
   * The name the person chose for the server (shared/remote-servers.ts `chosenServerName`); null when
   * they chose none (the neutral `Server <n>` is shown), undefined for a server that is gone (left out).
   */
  name(serverId: string): string | null | undefined
  /** GET `path` on the server through its partition (RemoteWindows.fetchFromServer). */
  fetch(serverId: string, path: string): Promise<unknown>
  /** Tests: a fixed id per server. Default: random. */
  mintId?(): string
  timers?: MachineStatusTimers
  log?(message: string): void
}

type Reading = { reachable: true; counts?: { waiting: number; working: number; idle: number } } | { reachable: false }
/** The ask did not go (RemoteNoKeyError): the reading stays. */
const NOT_ASKED = 'not-asked'

interface Polled {
  /** The last reading; `{ reachable: true }` before the first answer. */
  reading: Reading
  timer: unknown
  inFlight: boolean
}

const realTimers: MachineStatusTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    // A pending poll must not keep main alive at quit.
    t.unref?.()
    return t
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** A count from the server: a safe whole number from 0 to MAX_MACHINE_COUNT, else undefined. */
function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_MACHINE_COUNT ? value : undefined
}

/** The SESSIONS_PATH answer, checked (it crosses machines); undefined when it is not three counts. */
export function countsOf(body: unknown): { waiting: number; working: number; idle: number } | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  const { waiting, working, idle } = body as Record<string, unknown>
  const w = countOf(waiting)
  const k = countOf(working)
  const i = countOf(idle)
  return w === undefined || k === undefined || i === undefined ? undefined : { waiting: w, working: k, idle: i }
}

export class MachineStatus {
  private readonly options: MachineStatusOptions
  private readonly timers: MachineStatusTimers
  private readonly log: (message: string) => void
  /** serverId -> its poll state, only while it has a window open. */
  private readonly polled = new Map<string, Polled>()
  /** serverId -> machine id, for the whole run. */
  private readonly ids = new Map<string, string>()
  /** serverId -> its neutral label (`Server <n>`), for the whole run, so a chip's label never shifts. */
  private readonly labels = new Map<string, string>()
  private readonly listeners = new Set<(machines: MachineInfo[]) => void>()
  /** What listeners last heard (JSON), so only a change is announced. */
  private last = '[]'
  private disposed = false

  constructor(options: MachineStatusOptions) {
    this.options = options
    this.timers = options.timers ?? realTimers
    this.log = options.log ?? warnLog
  }

  /**
   * The remote windows changed (one opened or closed): a server with a first window starts polling
   * at once, one with none left stops. Its in-flight ask, if any, is then dropped on arrival.
   */
  sync(): void {
    if (this.disposed) return
    const now = new Set(this.options.servers())
    for (const [serverId, p] of [...this.polled]) {
      if (now.has(serverId)) continue
      if (p.timer !== undefined) this.timers.clearTimeout(p.timer)
      this.polled.delete(serverId)
    }
    for (const serverId of now) {
      if (this.polled.has(serverId)) continue
      const p: Polled = { reading: { reachable: true }, timer: undefined, inFlight: false }
      this.polled.set(serverId, p)
      this.poll(serverId, p)
    }
    this.announce()
  }

  /** A server's name may have changed (the picker's edit): announce the list again if it differs. */
  refresh(): void {
    if (!this.disposed) this.announce()
  }

  /** The machines now, in the order of `servers()`; a server with no record any more is left out. */
  machines(): MachineInfo[] {
    const out: MachineInfo[] = []
    for (const serverId of this.options.servers()) {
      const p = this.polled.get(serverId)
      const chosen = this.options.name(serverId)
      if (p === undefined || chosen === undefined) continue
      const name = chosen ?? this.labelOf(serverId)
      const m: MachineInfo = { id: this.idOf(serverId), name, reachable: p.reading.reachable }
      if (p.reading.reachable && p.reading.counts !== undefined) Object.assign(m, p.reading.counts)
      out.push(m)
    }
    return out
  }

  /** The server a machine id names, only while it is listed (a window open); undefined otherwise. */
  serverOf(machineId: string): string | undefined {
    for (const [serverId, id] of this.ids) if (id === machineId && this.polled.has(serverId)) return serverId
    return undefined
  }

  /** Hear the whole list again whenever it changes; returns the unsubscribe. */
  onChange(listener: (machines: MachineInfo[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Quit: every timer cleared, nothing announced any more. */
  dispose(): void {
    this.disposed = true
    for (const p of this.polled.values()) if (p.timer !== undefined) this.timers.clearTimeout(p.timer)
    this.polled.clear()
    this.listeners.clear()
  }

  // -------------------------------------------------------------------------------------------

  private labelOf(serverId: string): string {
    let label = this.labels.get(serverId)
    if (label === undefined) {
      label = `Server ${this.labels.size + 1}`
      this.labels.set(serverId, label)
    }
    return label
  }

  private idOf(serverId: string): string {
    let id = this.ids.get(serverId)
    if (id === undefined) {
      id = this.options.mintId?.() ?? `m-${randomBytes(9).toString('base64url')}`
      this.ids.set(serverId, id)
    }
    return id
  }

  /**
   * One ask. Never two at once for a server: the next is scheduled only after this one settles (the
   * fetch is bounded by the adapter's timeout), so a slow server is asked less often, not piled on.
   * An answer for a server that stopped being polled (its last window closed, maybe reopened since:
   * a new Polled) is dropped.
   */
  private poll(serverId: string, p: Polled): void {
    if (p.inFlight) return
    p.inFlight = true
    p.timer = undefined
    void this.options
      .fetch(serverId, SESSIONS_PATH)
      .then(
        (body): Reading => {
          const counts = countsOf(body)
          return counts === undefined ? { reachable: true } : { reachable: true, counts }
        },
        (err: unknown): Reading | typeof NOT_ASKED => {
          if (err instanceof RemoteNoKeyError) return NOT_ASKED
          if (err instanceof RemoteHttpError && err.status === 404) return { reachable: true }
          // Once per change of state, not every 5 s while a server stays away.
          if (p.reading.reachable) this.log(`remote ${serverId}: the session counts did not answer: ${errorText(err)}`)
          return { reachable: false }
        }
      )
      .then((reading) => {
        p.inFlight = false
        if (this.disposed || this.polled.get(serverId) !== p) return
        if (reading !== NOT_ASKED) {
          p.reading = reading
          this.announce()
        }
        p.timer = this.timers.setTimeout(() => {
          if (!this.disposed && this.polled.get(serverId) === p) this.poll(serverId, p)
        }, reading === NOT_ASKED ? NO_KEY_RETRY_MS : POLL_MS)
      })
  }

  private announce(): void {
    const machines = this.machines()
    const json = JSON.stringify(machines)
    if (json === this.last) return
    this.last = json
    for (const listener of [...this.listeners]) {
      try {
        listener(structuredClone(machines))
      } catch (err) {
        this.log(`machine status: a listener threw: ${errorText(err)}`)
      }
    }
  }
}
