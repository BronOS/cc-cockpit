// Fetching a marketplace index (plan: plugin marketplace, Task 3). The text is untrusted: this
// module only gets the bytes safely (scheme, timeout, size cap while reading, no redirects);
// `parseMarketplaceIndex` judges them. Pure Node, so unit tests load it.
import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { INDEX_TOO_LARGE, MAX_INDEX_BYTES } from '../../shared/marketplace'

export const FETCH_TIMEOUT_MS = 15_000

/** Gets the text of an index URL, or throws an Error whose message is safe to show. */
export type IndexFetcher = (url: string) => Promise<string>

/**
 * A usable marketplace URL in its canonical spelling (`HTTPS://a/b` and `https://a/b` are one index,
 * so whatever compares or keys by URL uses `url`: the cache file, "default index", a record's
 * `marketplace`), or why it is not one. Only `https:` and `file:` (the e2e and local indexes);
 * embedded credentials would end up in logs and in the cache file name's input.
 */
export function checkMarketplaceUrl(url: unknown): { url: string } | { problem: string } {
  if (typeof url !== 'string' || url === '' || url.length > 2048) return { problem: 'not a usable URL' }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { problem: 'not a valid URL' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'file:') return { problem: 'only https: and file: URLs are allowed' }
  if (parsed.username !== '' || parsed.password !== '') return { problem: 'a URL with credentials is not allowed' }
  // fileURLToPath throws on a remote host; refuse it here so the message stays ours.
  if (parsed.protocol === 'file:' && parsed.hostname !== '' && parsed.hostname !== 'localhost') {
    return { problem: 'a file: URL with a host is not allowed' }
  }
  return { url: parsed.href }
}

/**
 * A failure whose message is already the one to show: the catch blocks below pass it on and replace
 * anything else with a generic line. The class decides, not the text, so rewording a message cannot
 * quietly turn "too large" into "could not be fetched".
 */
class IndexFetchError extends Error {}

/** Read a local index file, never more than `max` bytes and never a non-regular file (FIFO, /dev/zero). */
async function readFileLimited(path: string, max: number): Promise<string> {
  // stat first: opening a FIFO would block. O_NONBLOCK covers a swap between stat and open.
  if (!(await stat(path)).isFile()) throw new Error('the index file could not be read')
  const fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    if (!(await fh.stat()).isFile()) throw new Error('the index file could not be read')
    const buf = Buffer.alloc(max + 1)
    let total = 0
    while (total <= max) {
      const { bytesRead } = await fh.read(buf, total, max + 1 - total, null)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > max) throw new IndexFetchError(INDEX_TOO_LARGE)
    return buf.subarray(0, total).toString('utf8')
  } finally {
    await fh.close()
  }
}

/** Read a response body as text, failing as soon as it passes `max` bytes (not after buffering it). */
async function readLimited(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    // Nobody will read this body: cancelling frees the connection instead of leaving it open until the timeout.
    await res.body?.cancel().catch(() => undefined)
    throw new IndexFetchError(INDEX_TOO_LARGE)
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      throw new IndexFetchError(INDEX_TOO_LARGE)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export interface FetcherOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  maxBytes?: number
}

export function createIndexFetcher(options: FetcherOptions = {}): IndexFetcher {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS
  const max = options.maxBytes ?? MAX_INDEX_BYTES
  return async (url) => {
    const checked = checkMarketplaceUrl(url)
    if ('problem' in checked) throw new Error(checked.problem)
    const href = checked.url
    if (href.startsWith('file:')) {
      try {
        return await readFileLimited(fileURLToPath(href), max)
      } catch (err) {
        if (err instanceof IndexFetchError) throw err
        throw new Error('the index file could not be read', { cause: err })
      }
    }
    const timeout = AbortSignal.timeout(timeoutMs)
    try {
      // redirect:'error': a followed redirect could leave https (or reach a host the user never chose).
      const res = await doFetch(href, { redirect: 'error', signal: timeout, headers: { Accept: 'application/json' } })
      if (!res.ok) {
        // Nobody will read this body: cancelling frees the connection instead of leaving it open until the timeout.
        await res.body?.cancel().catch(() => undefined)
        throw new IndexFetchError(`the server answered HTTP ${res.status}`)
      }
      // The timeout also covers reading the body: a stalled stream aborts the read.
      return await readLimited(res, max)
    } catch (err) {
      if (timeout.aborted) throw new Error('the server did not answer in time', { cause: err })
      if (err instanceof IndexFetchError) throw err
      throw new Error('the index could not be fetched', { cause: err })
    }
  }
}
