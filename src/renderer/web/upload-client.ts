// The web shell's upload client (design-upload.md §3.3): sends the files of one `uploads.begin` to the
// gateway's `/u/<token>?offset=<n>` route, one file and one chunk at a time.
//
// Always `fetch` of `File.slice`, never `XMLHttpRequest` and never the `File` itself as a body: the
// spike (§11) saw an XHR PUT of a `File` posted from a panel frame fail for some files while an XHR of
// its slice and every fetch succeeded. Slices are also what the adaptive chunk size needs, and `fetch`
// has no upload progress, which acknowledged chunks give instead.
//
// The gateway bounds a whole request, body included, at 30 s (cut at 30-35 s, answered 408), so a
// fixed 8 MiB chunk would die and restart forever on a slow link: the size starts at 1 MiB, doubles
// after a full-size chunk under 2.5 s, and halves after one over 10 s or one the bound cut.
//
// Answers are told by status, never by body: an ended token's 404 is plain text even for a write guest
// (the guest block's bytes, §3.2), the writer's refusals are JSON `{error}`, a proxy's are anything.
import {
  UPLOAD_CHUNK_FAST_MS,
  UPLOAD_CHUNK_MAX_BYTES,
  UPLOAD_CHUNK_MIN_BYTES,
  UPLOAD_CHUNK_SLOW_MS,
  UPLOAD_CHUNK_START_BYTES,
  UPLOAD_PATH_PREFIX,
  type UploadFileToken
} from '../../shared/uploads'
import { keyedFetch } from './device-key'

/** What a file is to the client: the `File` of a picker or a drop, or a stand-in in a test. */
export interface UploadSource {
  readonly size: number
  slice(start: number, end: number): Blob
}

export type UploadFetch = (input: string, init?: RequestInit) => Promise<Response>

/** Acknowledged bytes: of the file being sent and of every file of the run. */
export interface UploadProgress {
  index: number
  name: string
  fileSent: number
  fileSize: number
  sent: number
  total: number
}

/** How one file ended: `done` with the committed name and project-relative path, or why it did not. */
export interface UploadFileResult {
  index: number
  /** The name main planned (the token's), the committed one in `name` of a `done` answer. */
  name: string
  outcome: 'done' | 'failed' | 'cancelled'
  path?: string
  reason?: string
}

export interface UploadRunOptions {
  /** Defaults to `keyedFetch` (the device key header). */
  fetch?: UploadFetch
  signal?: AbortSignal
  onProgress?: (progress: UploadProgress) => void
  /** A monotonic clock in ms (defaults to `performance.now`); the chunk timing reads it. */
  now?: () => number
  /** The backoff wait (defaults to a timer that an abort ends at once). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** A chunk is retried this many times after its first failure. */
export const UPLOAD_CHUNK_RETRIES = 3
/** Waits before each retry. */
export const UPLOAD_RETRY_BACKOFF_MS: readonly number[] = [500, 1_500, 4_000]
/**
 * A chunk's own client deadline, past the gateway's cut (30-35 s): Task 1 saw a cut resolve as a 408
 * only after Chromium's resend, up to about 119 s, so the client does not wait for it.
 */
export const UPLOAD_CHUNK_TIMEOUT_MS = 45_000
/** 409 answers followed without a retry per file; a server that keeps moving the offset is broken. */
const MAX_RESYNCS = 50

const REASON_CUT = 'the connection is too slow for this file'
const REASON_LOST = 'the connection was lost'
const REASON_ENDED = 'the upload was ended'
// A 404 after a lost answer: the writer fails a file (disk full, a write error) and drops its token,
// and the answer that carried the reason may be the one a link dropped (§3.2).
const REASON_ENDED_BY_SERVER = 'the server ended the upload (for example the disk was full)'
const REASON_UNEXPECTED = 'the server gave an unexpected answer'
const REASON_GONE = 'the file could not be read'
/** A server's own words are shown, capped: they are text in a notice, never markup. */
const REASON_MAX_CHARS = 200

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

/** The reason of a JSON `{error}` body, or the status line when the body is anything else. */
async function reasonOf(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json()
    if (body !== null && typeof body === 'object') {
      const error = (body as Record<string, unknown>)['error']
      if (typeof error === 'string' && error.length > 0) return error.slice(0, REASON_MAX_CHARS)
    }
  } catch {
    // Not JSON (a proxy's page, a plain-text 404): the status says it.
  }
  return `the server answered ${res.status}`
}

async function jsonOf(res: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await res.json()
    return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal?.aborted === true) return resolve()
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })

/** One attempt's end, before the loop decides what it means. */
type Attempt =
  | { kind: 'ok'; body: Record<string, unknown> | undefined }
  | { kind: 'resync'; expected: number | undefined }
  | { kind: 'cut' }
  | { kind: 'network' }
  | { kind: 'ended' }
  | { kind: 'refused'; reason: string }
  | { kind: 'aborted' }

/**
 * Sends `files[token.index]` for each token, in order, and answers how each ended. Never rejects and
 * never throws: an abort ends the file in flight and every later one as `cancelled`. A connection that
 * keeps failing ends that file and the rest (a dead link would otherwise spend the backoff on every
 * one of up to a hundred files); a refusal of one file (507, 413, a vanished file) lets the next go on.
 */
export async function runUpload(
  files: readonly UploadSource[],
  tokens: readonly UploadFileToken[],
  opts: UploadRunOptions = {}
): Promise<UploadFileResult[]> {
  const send = opts.fetch ?? keyedFetch
  const now = opts.now ?? ((): number => performance.now())
  const sleep = opts.sleep ?? defaultSleep
  const signal = opts.signal
  // A function, not a property read: TypeScript narrows `signal?.aborted` for good after one check, but an abort comes at any await.
  const aborted = (): boolean => signal?.aborted === true
  const results: UploadFileResult[] = []
  let total = 0
  for (const t of tokens) total += files[t.index]?.size ?? 0
  let sentBefore = 0
  // Carried across files: the link's speed is the person's, not the file's.
  let chunk = UPLOAD_CHUNK_START_BYTES
  let linkDead = false

  for (const t of tokens) {
    const file = files[t.index]
    const result: UploadFileResult = { index: t.index, name: t.name, outcome: 'failed' }
    results.push(result)
    if (aborted()) {
      result.outcome = 'cancelled'
      continue
    }
    if (linkDead) {
      result.reason = REASON_LOST
      continue
    }
    if (file === undefined) {
      result.reason = REASON_GONE
      continue
    }
    const size = file.size
    let offset = 0
    let failures = 0
    let resyncs = 0
    // A network error or a cut since the last acknowledged chunk: a 404 now may be a file the server
    // failed whose answer was lost, not a token that simply ended.
    let lost = false

    const progress = (): void =>
      opts.onProgress?.({ index: t.index, name: t.name, fileSent: offset, fileSize: size, sent: sentBefore + offset, total })

    // An empty file is one zero-length PUT at offset 0 that commits it, so the loop runs once for it.
    for (;;) {
      if (aborted()) {
        result.outcome = 'cancelled'
        break
      }
      const length = Math.min(chunk, size - offset)
      const started = now()
      const attempt = await put(send, `${UPLOAD_PATH_PREFIX}${encodeURIComponent(t.token)}?offset=${offset}`, file, offset, length, signal)
      const elapsed = now() - started

      if (attempt.kind === 'aborted') {
        result.outcome = 'cancelled'
        break
      }
      if (attempt.kind === 'ok') {
        failures = 0
        lost = false
        const body = attempt.body
        if (body?.['done'] === true) {
          offset = size
          progress()
          result.outcome = 'done'
          if (typeof body['name'] === 'string') result.name = body['name']
          if (typeof body['path'] === 'string') result.path = body['path']
          break
        }
        const received = body?.['received']
        // The server's count wins when it is a sane one; a short chunk answer would otherwise skew the offset.
        const next = isCount(received) && received > offset && received <= size ? received : offset + length
        if (next >= size) {
          // Every byte sent and no commit answer: not a state the writer produces.
          result.reason = REASON_UNEXPECTED
          break
        }
        offset = next
        // Only a full-size chunk says anything about the link: a short last chunk is fast by being short.
        if (length === chunk) {
          if (elapsed < UPLOAD_CHUNK_FAST_MS) chunk = Math.min(chunk * 2, UPLOAD_CHUNK_MAX_BYTES)
          else if (elapsed > UPLOAD_CHUNK_SLOW_MS) chunk = Math.max(Math.floor(chunk / 2), UPLOAD_CHUNK_MIN_BYTES)
        }
        progress()
        continue
      }
      if (attempt.kind === 'resync') {
        const expected = attempt.expected
        // A 409 whose `expected` is a place to go (a resend Chromium made after a cut, an answer lost):
        // resume there, no retry used. One that points nowhere new is a failed attempt like any other.
        if (expected !== undefined && expected !== offset && expected <= size && resyncs < MAX_RESYNCS) {
          resyncs++
          offset = expected
          failures = 0
          lost = false
          progress()
          continue
        }
        result.reason = REASON_UNEXPECTED
        break
      }
      if (attempt.kind === 'ended') {
        result.reason = lost ? REASON_ENDED_BY_SERVER : REASON_ENDED
        break
      }
      if (attempt.kind === 'refused') {
        result.reason = attempt.reason
        break
      }
      // 'cut' and 'network': retried, a cut with a smaller chunk.
      lost = true
      if (attempt.kind === 'cut') chunk = Math.max(Math.floor(chunk / 2), UPLOAD_CHUNK_MIN_BYTES)
      if (failures >= UPLOAD_CHUNK_RETRIES) {
        result.reason = attempt.kind === 'cut' ? REASON_CUT : REASON_LOST
        if (attempt.kind === 'network') linkDead = true
        break
      }
      const wait = UPLOAD_RETRY_BACKOFF_MS[Math.min(failures, UPLOAD_RETRY_BACKOFF_MS.length - 1)] ?? 0
      failures++
      await sleep(wait, signal)
    }
    sentBefore += offset
  }
  return results
}

/** One PUT of `file.slice(offset, offset + length)`, its answer sorted by status. */
async function put(
  send: UploadFetch,
  url: string,
  file: UploadSource,
  offset: number,
  length: number,
  outer: AbortSignal | undefined
): Promise<Attempt> {
  const ac = new AbortController()
  let timedOut = false
  const onAbort = (): void => ac.abort()
  outer?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, UPLOAD_CHUNK_TIMEOUT_MS)
  try {
    let res: Response
    try {
      res = await send(url, { method: 'PUT', body: file.slice(offset, offset + length), signal: ac.signal })
    } catch {
      if (outer?.aborted === true) return { kind: 'aborted' }
      return { kind: timedOut ? 'cut' : 'network' }
    }
    if (res.status === 200) return { kind: 'ok', body: await jsonOf(res) }
    if (res.status === 409) {
      const body = await jsonOf(res)
      const expected = body?.['expected']
      return { kind: 'resync', expected: isCount(expected) ? expected : undefined }
    }
    // The gateway's cut, as Node answers it (design §3.3); Chromium may have resent once before this.
    if (res.status === 408) return { kind: 'cut' }
    // A 404 is told by its status alone: an ended token's body is plain text for a write guest.
    if (res.status === 404) return { kind: 'ended' }
    // A proxy in front dropping the request is a link problem, retried like one.
    if (res.status === 502 || res.status === 503 || res.status === 504) return { kind: 'network' }
    // 400, 413, 500, 507 (the writer's own, never retried: a failed file is settled and a retry finds 404
    // with the reason gone), 401, 403, anything else.
    return { kind: 'refused', reason: await reasonOf(res) }
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', onAbort)
  }
}
