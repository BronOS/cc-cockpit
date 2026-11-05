// Fetching a marketplace index (plan: plugin marketplace, Task 3) and its preview images (design-next
// §6.1). The bytes are untrusted: this module only gets them safely (scheme, timeout, size cap while
// reading, no redirects); `parseMarketplaceIndex` judges an index, `MarketplaceService.preview` a
// preview. Pure Node, so unit tests load it.
import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { INDEX_TOO_LARGE, MAX_INDEX_BYTES, MAX_PREVIEW_BYTES } from '../../shared/marketplace'

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

/**
 * Read a local file, never more than `max` bytes and never a non-regular file (FIFO, /dev/zero).
 * `tooLarge` is the message when it passes `max`; any other failure is the caller's to word.
 */
async function readFileBytesLimited(path: string, max: number, tooLarge: string): Promise<Buffer> {
  // stat first: opening a FIFO would block. O_NONBLOCK covers a swap between stat and open.
  if (!(await stat(path)).isFile()) throw new Error('not a regular file')
  const fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    if (!(await fh.stat()).isFile()) throw new Error('not a regular file')
    const buf = Buffer.alloc(max + 1)
    let total = 0
    while (total <= max) {
      const { bytesRead } = await fh.read(buf, total, max + 1 - total, null)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > max) throw new IndexFetchError(tooLarge)
    return buf.subarray(0, total)
  } finally {
    await fh.close()
  }
}

/** Read a response body, failing as soon as it passes `max` bytes (not after buffering it). */
async function readBytesLimited(res: Response, max: number, tooLarge: string): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    // Nobody will read this body: cancelling frees the connection instead of leaving it open until the timeout.
    await res.body?.cancel().catch(() => undefined)
    throw new IndexFetchError(tooLarge)
  }
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      throw new IndexFetchError(tooLarge)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** Read a response body as text, failing as soon as it passes `max` bytes (not after buffering it). */
export async function readLimited(res: Response, max: number): Promise<string> {
  return (await readBytesLimited(res, max, INDEX_TOO_LARGE)).toString('utf8')
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
        return (await readFileBytesLimited(fileURLToPath(href), max, INDEX_TOO_LARGE)).toString('utf8')
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

/**
 * Gets the bytes of a preview image (design-next §6.1), or throws an Error whose message is safe to
 * show. The URL is one main built from a checked index URL and checked entry fields
 * (`MarketplaceService.preview`), never one from the renderer.
 */
export type PreviewFetcher = (url: string) => Promise<Uint8Array>

const PREVIEW_TOO_LARGE = `the preview is over ${MAX_PREVIEW_BYTES / 1024} KiB`

/**
 * The index fetcher's rules for a preview: https: or file: only, no redirect (a followed one could
 * leave the index's own host), the timeout over the body too, and the byte cap enforced while
 * reading. The hash and the PNG signature are the service's to check: they need the entry.
 */
export function createPreviewFetcher(options: FetcherOptions = {}): PreviewFetcher {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS
  const max = options.maxBytes ?? MAX_PREVIEW_BYTES
  return async (url) => {
    const checked = checkMarketplaceUrl(url)
    if ('problem' in checked) throw new Error(checked.problem)
    const href = checked.url
    if (href.startsWith('file:')) {
      try {
        return await readFileBytesLimited(fileURLToPath(href), max, PREVIEW_TOO_LARGE)
      } catch (err) {
        if (err instanceof IndexFetchError) throw err
        throw new Error('the preview file could not be read', { cause: err })
      }
    }
    const timeout = AbortSignal.timeout(timeoutMs)
    try {
      const res = await doFetch(href, { redirect: 'error', signal: timeout, headers: { Accept: 'image/png' } })
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        throw new IndexFetchError(`the server answered HTTP ${res.status}`)
      }
      return await readBytesLimited(res, max, PREVIEW_TOO_LARGE)
    } catch (err) {
      if (timeout.aborted) throw new Error('the server did not answer in time', { cause: err })
      if (err instanceof IndexFetchError) throw err
      throw new Error('the preview could not be fetched', { cause: err })
    }
  }
}
