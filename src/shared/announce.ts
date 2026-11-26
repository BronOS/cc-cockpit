// handle.announce's shape and caps (design-parts.md §1), one rule for the plugin host (the opener's call site, the
// listeners' event) and main (host-api.ts, which checks the call again): a leaf with no imports.

/** `kind`: 1-40 characters of `a-z 0-9 . -`. */
const KIND = /^[a-z0-9.-]{1,40}$/
/** At most this many refs per announcement. */
export const MAX_ANNOUNCE_REFS = 20
/** At most this many characters per ref. */
export const MAX_ANNOUNCE_REF = 200
/** Announcements per overlay per minute: the opener's call and main both refuse the next. */
export const MAX_ANNOUNCES_PER_MINUTE = 5
/** The minute of MAX_ANNOUNCES_PER_MINUTE. */
export const ANNOUNCE_WINDOW_MS = 60_000

/** A kind as handle.announce and ctx.overlay.onAnnounce take it. */
export function isAnnounceKind(value: unknown): value is string {
  return typeof value === 'string' && KIND.test(value)
}

/**
 * An announcement's refs, checked: an array of at most MAX_ANNOUNCE_REFS strings of at most MAX_ANNOUNCE_REF
 * characters each, copied. Throws (TypeError or RangeError) for anything else: refused, never cut. Never the
 * document: every listener of the window hears the refs.
 */
export function checkAnnounceRefs(refs: unknown, what = 'announce'): string[] {
  if (!Array.isArray(refs)) throw new TypeError(`${what}: refs must be an array of strings`)
  if (refs.length > MAX_ANNOUNCE_REFS) throw new RangeError(`${what}: more than ${MAX_ANNOUNCE_REFS} refs`)
  const out: string[] = []
  for (const ref of refs as unknown[]) {
    if (typeof ref !== 'string') throw new TypeError(`${what}: every ref must be a string`)
    if (ref.length > MAX_ANNOUNCE_REF) throw new RangeError(`${what}: a ref longer than ${MAX_ANNOUNCE_REF} characters`)
    out.push(ref)
  }
  return out
}

/**
 * The minute budget of one overlay's announces: `times` (oldest first) is trimmed to the last minute and, when
 * there is room, `now` is added. False (nothing added) past MAX_ANNOUNCES_PER_MINUTE.
 */
export function takeAnnounce(times: number[], now = Date.now()): boolean {
  while (times.length > 0 && now - times[0]! >= ANNOUNCE_WINDOW_MS) times.shift()
  if (times.length >= MAX_ANNOUNCES_PER_MINUTE) return false
  times.push(now)
  return true
}
