// ctx.overlay.onAnnounce and the window's live announcements (design-parts.md §1, spec-review S12).
//
// An overlay's opener says what it shows (`handle.announce({ kind, refs })`, host/ctx/ui.ts): the host tells main
// (`overlay.announce`), main records it as the opener's consent to parts and answers with its own record of the
// overlay, sent to this window's host as `overlay.announced { overlay: { id, opener, title, type }, kind, refs }`;
// `overlay.unannounced { id }` follows when that overlay ends (a new announce of it replaces the last). This registry holds the
// live ones and runs every plugin's listeners of the kind. One host serves every plugin of the window, so the
// listeners of all of them are here; no manifest key guards it (one realm: a declaration would guard nothing).
//
// Rules:
// - `kind` 1-40 of `a-z 0-9 . -`; `refs` at most 20 strings of at most 200 characters (checked at the opener's call,
//   checked again here on main's event: anything else is dropped, never cut).
// - Each listener gets its own frozen copy, has ANNOUNCE_LISTENER_MS to settle, and a throw, a rejection or a timeout
//   is logged in its plugin's log and skipped: the rest run (all at once, so a slow one delays nobody).
// - A listener added later first hears the live announcements of its kind (as onConnect replays copies).
// - An announcement ends with its overlay (`overlay.unannounced`); a plugin's listeners end with its ctx.
import { checkAnnounceRefs, isAnnounceKind } from '../shared/announce'
import { errorText } from '../shared/error-text'

export { checkAnnounceRefs, isAnnounceKind, MAX_ANNOUNCE_REF, MAX_ANNOUNCE_REFS, MAX_ANNOUNCES_PER_MINUTE } from '../shared/announce'

/** How long one listener may take (its promise); past it the listener is logged and skipped. */
export const ANNOUNCE_LISTENER_MS = 2000
/** Longest overlay id or title taken from main's event (main mints ids; titles are capped there too). */
const MAX_OVERLAY_ID = 100
const MAX_TITLE = 1000
const MAX_PLUGIN_ID = 200

/** What a listener hears (sdk/types.ts OverlayAnnouncement). */
export interface Announcement {
  readonly overlay: {
    readonly id: string
    readonly opener: string
    readonly title: string
    readonly type?: { readonly name: string; readonly data: unknown }
  }
  readonly kind: string
  readonly refs: readonly string[]
}

export type AnnounceListener = (announcement: Announcement) => unknown

/** main's `overlay.announced` params, checked; undefined (dropped) for anything malformed. */
export function parseAnnounced(params: unknown): Announcement | undefined {
  try {
    const { overlay, kind, refs } = (params ?? {}) as Record<string, unknown>
    if (!isAnnounceKind(kind)) return undefined
    if (typeof overlay !== 'object' || overlay === null) return undefined
    const { id, opener, title, type } = overlay as Record<string, unknown>
    if (typeof id !== 'string' || id === '' || id.length > MAX_OVERLAY_ID) return undefined
    if (typeof opener !== 'string' || opener === '' || opener.length > MAX_PLUGIN_ID) return undefined
    if (typeof title !== 'string' || title.length > MAX_TITLE) return undefined
    let cleanType: { name: string; data: unknown } | undefined
    if (type !== undefined) {
      const name = (type as { name?: unknown } | null)?.name
      if (typeof name !== 'string') return undefined
      // Plain data only (main sent JSON over the port); a copy, so a listener never shares it.
      cleanType = { name, data: structuredClone((type as { data?: unknown }).data ?? null) }
    }
    return deepFreeze({
      overlay: { id, opener, title, ...(cleanType ? { type: cleanType } : {}) },
      kind,
      refs: checkAnnounceRefs(refs)
    })
  } catch {
    return undefined
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

/** A fresh frozen copy per listener: one listener cannot change what the next one hears. */
function copyOf(a: Announcement): Announcement {
  return deepFreeze(structuredClone(a) as Announcement)
}

interface Entry {
  readonly pluginId: string
  readonly kind: string
  readonly listener: AnnounceListener
}

export class OverlayAnnouncements {
  /** The live announcements of this window, by overlay id (a new one of an overlay replaces its last). */
  private readonly live = new Map<string, Announcement>()
  private readonly entries = new Set<Entry>()

  constructor(
    private readonly log: (pluginId: string, message: string) => void,
    private readonly listenerMs = ANNOUNCE_LISTENER_MS
  ) {}

  /**
   * ctx.overlay.onAnnounce(kind, listener) of `pluginId`: from now on it hears every announcement of `kind`, and
   * first the live ones (each in its own turn, as below). Returns the disposer.
   */
  listen(pluginId: string, kind: unknown, listener: unknown): () => void {
    if (!isAnnounceKind(kind)) throw new TypeError('overlay.onAnnounce: kind must be 1 to 40 characters of a-z, 0-9, . and -')
    if (typeof listener !== 'function') throw new TypeError('overlay.onAnnounce needs a function')
    // Wrapped: the same function registered twice is two registrations, each with its disposer.
    const entry: Entry = { pluginId, kind, listener: (a) => (listener as AnnounceListener)(a) }
    this.entries.add(entry)
    for (const a of [...this.live.values()]) {
      if (a.kind === kind && this.entries.has(entry)) this.run(entry, a)
    }
    return () => {
      this.entries.delete(entry)
    }
  }

  /** main's `overlay.announced`: recorded (replacing the overlay's last) and heard by every listener of its kind. */
  announced(params: unknown): void {
    const a = parseAnnounced(params)
    if (!a) return
    this.live.set(a.overlay.id, a)
    for (const entry of [...this.entries]) {
      if (entry.kind === a.kind && this.entries.has(entry)) this.run(entry, a)
    }
  }

  /** main's `overlay.unannounced { id }`: that overlay's announcement is void; a later listener does not hear it. */
  unannounced(params: unknown): void {
    const id = (params as { id?: unknown } | null)?.id
    if (typeof id === 'string') this.live.delete(id)
  }

  /** The plugin's ctx ended: its listeners go (a reloaded copy registers its own). */
  removePlugin(pluginId: string): void {
    for (const entry of [...this.entries]) if (entry.pluginId === pluginId) this.entries.delete(entry)
  }

  /** The overlay ids with a live announcement (tests; whether a part may attach is main's call, never this). */
  liveIds(): string[] {
    return [...this.live.keys()]
  }

  /** One listener on one announcement: its own copy, a deadline, and a throw, rejection or timeout logged and skipped. */
  private run(entry: Entry, a: Announcement): void {
    let outcome: unknown
    try {
      outcome = entry.listener(copyOf(a))
    } catch (err) {
      this.log(entry.pluginId, `an overlay.onAnnounce("${entry.kind}") listener threw: ${errorText(err)}`)
      return
    }
    if (typeof (outcome as { then?: unknown } | null)?.then !== 'function') return
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.listenerMs)
      // A deadline never keeps the host alive on its own.
      ;(timer as { unref?: () => void }).unref?.()
    })
    void Promise.race([Promise.resolve(outcome).then(() => 'done' as const), deadline])
      .then((end) => {
        if (end === 'timeout') {
          this.log(entry.pluginId, `an overlay.onAnnounce("${entry.kind}") listener took more than ${this.listenerMs} ms; skipped`)
        }
      })
      .catch((err: unknown) => {
        this.log(entry.pluginId, `an overlay.onAnnounce("${entry.kind}") listener failed: ${errorText(err)}`)
      })
      .finally(() => clearTimeout(timer))
  }
}
