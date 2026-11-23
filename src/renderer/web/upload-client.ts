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
/**
 * Waits before each retry, 26 s in all: an offline browser rejects a fetch at once, so the waits are the
 * whole budget, and they cover a Wi-Fi handover or a short screen lock (design §3.3). They stay well
 * under the upload's idle clock (UPLOAD_IDLE_MS, 60 s): past it the token is gone and the retry's 404
 * would read as a file the server failed.
 */
export const UPLOAD_RETRY_BACKOFF_MS: readonly number[] = [1_000, 5_000, 20_000]
/**
 * A chunk's own client deadline, past the gateway's cut (30-35 s): Task 1 saw a cut resolve as a 408
 * only after Chromium's resend, up to about 119 s, so the client does not wait for it.
 */
export const UPLOAD_CHUNK_TIMEOUT_MS = 45_000
/**
 * The slowest commit the last chunk's deadline allows for, in bytes per ms (4 MiB/s). On a mount with no
 * hard links (exFAT, SMB, NFS) the last chunk's answer waits for a copy of the whole temp, up to 2 GiB,
 * which Node's request bound no longer covers once the body is in: a 45 s deadline would cut a file the
 * server then places, and its retry's 404 would read as a failure.
 */
const UPLOAD_COMMIT_FLOOR_BYTES_PER_MS = (4 * 1024 ** 2) / 1000

/** The client deadline of the chunk at `offset` of `length` bytes: the last one's grows with the file. */
export function uploadChunkDeadlineMs(offset: number, length: number, size: number): number {
  return offset + length >= size ? UPLOAD_CHUNK_TIMEOUT_MS + Math.ceil(size / UPLOAD_COMMIT_FLOOR_BYTES_PER_MS) : UPLOAD_CHUNK_TIMEOUT_MS
}
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
  // `rejected`: the fetch itself threw (no answer at all), not a proxy's 502-504.
  | { kind: 'network'; rejected: boolean }
  // The writer's 400 for a body that ended short or ran long: truncated back, the token live (§3.2).
  | { kind: 'short'; reason: string }
  | { kind: 'ended' }
  | { kind: 'refused'; reason: string }
  | { kind: 'aborted' }

/**
 * Sends `files[token.index]` for each token, in order, and answers how each ended. Never rejects and
 * never throws: an abort ends the file in flight and every later one as `cancelled`. A connection that
 * keeps failing ends that file; the next file then gets one attempt with no retries, and when that too
 * finds no link the rest fail untried (a dead link would otherwise spend the backoff on every one of up
 * to a hundred files). A refusal of one file (507, 413, a file that can no longer be read) lets the next
 * go on.
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
  // A file ran out of retries on network errors: the next one gets a single attempt, and a second
  // file failing the same way means the link, not the file (linkDead).
  let linkSuspect = false
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
      const url = `${UPLOAD_PATH_PREFIX}${encodeURIComponent(t.token)}?offset=${offset}`
      const attempt = await put(send, url, file, offset, length, uploadChunkDeadlineMs(offset, length, size), signal)
      const elapsed = now() - started

      // An abort that lands while the answer's body is read makes the parse fail, and a cancel's own
      // end of the tokens answers 404: neither is the file's failure. Only a commit answer read whole
      // stays `done`, since the file is then on the server.
      const committedNow = attempt.kind === 'ok' && attempt.body?.['done'] === true
      if (attempt.kind === 'aborted' || (aborted() && !committedNow)) {
        result.outcome = 'cancelled'
        break
      }
      if (attempt.kind === 'ok') {
        failures = 0
        lost = false
        linkSuspect = false
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
        // A 409 whose `expected` is ahead (a resend Chromium made after a cut, an answer lost): resume
        // there, no retry used. The writer never points behind an acknowledged offset (progress would
        // go back) nor at the size (it commits in the same step the last byte lands, and a PUT at the
        // size would be an empty chunk it refuses), so either is a broken server and ends the file.
        if (expected !== undefined && expected > offset && expected < size && resyncs < MAX_RESYNCS) {
          resyncs++
          offset = expected
          failures = 0
          lost = false
          linkSuspect = false
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
      // 'cut', 'network' and 'short': retried, a cut with a smaller chunk. A short body was answered,
      // so its token is live and a 404 after it is no lost answer.
      if (attempt.kind !== 'short') lost = true
      if (attempt.kind === 'cut') chunk = Math.max(Math.floor(chunk / 2), UPLOAD_CHUNK_MIN_BYTES)
      if (attempt.kind === 'network' && attempt.rejected && !(await readable(file, offset))) {
        // Chromium rejects the fetch of a `File` changed or removed since it was picked (a log still
        // written, a file gone from a dropped folder) like a link failure: that is this file's end, and
        // never the run's. Not run in a real browser here; the single attempt below covers it if not.
        if (aborted()) {
          result.outcome = 'cancelled'
          break
        }
        result.reason = REASON_GONE
        break
      }
      const budget = attempt.kind === 'network' && linkSuspect ? 0 : UPLOAD_CHUNK_RETRIES
      if (failures >= budget) {
        if (attempt.kind === 'cut') result.reason = REASON_CUT
        else if (attempt.kind === 'short') result.reason = attempt.reason
        else {
          result.reason = REASON_LOST
          if (linkSuspect) linkDead = true
          linkSuspect = true
        }
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

/** Whether the file can still be read at `offset`: one byte, to tell a vanished file from a dead link. */
async function readable(file: UploadSource, offset: number): Promise<boolean> {
  try {
    await file.slice(offset, Math.min(offset + 1, file.size)).arrayBuffer()
    return true
  } catch {
    return false
  }
}

/** One PUT of `file.slice(offset, offset + length)`, its answer sorted by status. */
async function put(
  send: UploadFetch,
  url: string,
  file: UploadSource,
  offset: number,
  length: number,
  deadlineMs: number,
  outer: AbortSignal | undefined
): Promise<Attempt> {
  const ac = new AbortController()
  let timedOut = false
  const onAbort = (): void => ac.abort()
  outer?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, deadlineMs)
  try {
    let res: Response
    try {
      res = await send(url, { method: 'PUT', body: file.slice(offset, offset + length), signal: ac.signal })
    } catch {
      if (outer?.aborted === true) return { kind: 'aborted' }
      return timedOut ? { kind: 'cut' } : { kind: 'network', rejected: true }
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
    if (res.status === 502 || res.status === 503 || res.status === 504) return { kind: 'network', rejected: false }
    if (res.status === 400) {
      // The writer's 400 with `expected` is a body that ended short or ran long (a proxy cutting it):
      // truncated back and the token kept for a retry (§3.2). Any other 400 is a refusal.
      const body = await jsonOf(res)
      const error = body?.['error']
      const reason = typeof error === 'string' && error.length > 0 ? error.slice(0, REASON_MAX_CHARS) : 'the server answered 400'
      return isCount(body?.['expected']) ? { kind: 'short', reason } : { kind: 'refused', reason }
    }
    // 413, 500, 507 (the writer's own, never retried: a failed file is settled and a retry finds 404
    // with the reason gone), 401, 403, anything else.
    return { kind: 'refused', reason: await reasonOf(res) }
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', onAbort)
  }
}
