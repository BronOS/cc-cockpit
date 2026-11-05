import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MARKETPLACE_URL, MAX_PREVIEW_BYTES, STALE_AFTER_MS } from '../../src/shared/marketplace'
import { checkMarketplaceUrl, createIndexFetcher, createPreviewFetcher } from '../../src/main/marketplace/fetch-index'
import { MarketplaceService, PREVIEW_RETRY_MS, type MarketplaceState, marketplaceUrls } from '../../src/main/marketplace/marketplace-service'
import { fakePng } from '../fakes/png'

const COMMIT = 'a'.repeat(40)
const URL1 = 'https://example.com/index.json'
const entry = (id: string) => ({
  id, name: id, description: '', author: 'me', repo: 'https://example.com/r.git',
  version: '1.0.0', tag: 'v1.0.0', commit: COMMIT, api: 1
})
const indexText = (...ids: string[]) =>
  JSON.stringify({ schema: 1, plugins: ids.map(entry), revoked: [{ id: 'x.y', commit: COMMIT, reason: 'bad' }] })

// The single configured URL's state; a test that expects a state never wants undefined.
const at = (s: MarketplaceService): MarketplaceState => s.list()[0]!

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mp-svc-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// The default index is always fetched too: offline unless a test lists it, so `fetcher` and the cache
// folder hold only what the test is about.
function service(fetcher: (u: string) => Promise<string>, now = () => 1000, urls = [URL1], authorities: string[] = []) {
  return new MarketplaceService({
    dataDir: dir,
    urls: () => urls,
    authorities: () => authorities,
    fetcher: (u) => (u === DEFAULT_MARKETPLACE_URL && !urls.includes(u) ? Promise.reject(new Error('offline')) : fetcher(u)),
    now
  })
}

describe('MarketplaceService', () => {
  it('fetches, validates and caches, and a fresh service starts from the cache offline', async () => {
    const a = service(async () => indexText('a.b'))
    await a.refresh()
    expect(at(a)).toMatchObject({ url: URL1, fetchedAt: 1000, error: null })
    expect(at(a).index?.plugins.map((p) => p.id)).toEqual(['a.b'])
    expect(readdirSync(join(dir, 'marketplaces'))).toHaveLength(1)

    const b = service(async () => {
      throw new Error('offline')
    })
    expect(at(b).index).toBeNull()
    b.loadCache()
    expect(at(b).index?.plugins).toHaveLength(1)
    expect(at(b).index?.revoked).toHaveLength(1)
    await b.refresh()
    expect(at(b)).toMatchObject({ error: 'offline', fetchedAt: 1000 })
    expect(at(b).index?.revoked).toHaveLength(1)
  })

  it('refreshIfStale skips a fresh index and refetches after an hour or after an error', async () => {
    let t = 1000
    let calls = 0
    const s = service(async () => (calls++, indexText('a.b')), () => t)
    await s.refreshIfStale()
    expect(calls).toBe(1)
    t += STALE_AFTER_MS - 1
    await s.refreshIfStale()
    expect(calls).toBe(1)
    t += 1
    await s.refreshIfStale()
    expect(calls).toBe(2)
  })

  it('the timer refreshes a stale index, picks up a new revocation, and stops', async () => {
    vi.useFakeTimers()
    try {
      let t = 1000
      let body = indexText('a.b')
      let refreshed = 0
      const s = new MarketplaceService({
        dataDir: dir,
        urls: () => [URL1],
        authorities: () => [],
        now: () => t,
        onRefreshed: () => refreshed++,
        fetcher: async (u) => {
          if (u !== URL1) throw new Error('offline')
          return body
        }
      })
      await s.refresh()
      expect(refreshed).toBe(1)
      const stop = s.startPeriodicRefresh()
      body = JSON.stringify({ schema: 1, plugins: [], revoked: [{ id: 'n.ew', commit: COMMIT, reason: 'new' }] })
      // Fresh for now: the timer fires and fetches nothing.
      t += 60_000
      await vi.advanceTimersByTimeAsync(15 * 60_000)
      expect(refreshed).toBe(1)
      t += STALE_AFTER_MS
      await vi.advanceTimersByTimeAsync(15 * 60_000)
      expect(refreshed).toBe(2)
      expect(s.revocationFor({ id: 'n.ew', commit: COMMIT, marketplace: URL1 })?.reason).toBe('new')
      stop()
      t += STALE_AFTER_MS
      body = indexText()
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(refreshed).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the last good index on a failed or invalid fetch', async () => {
    let body = indexText('a.b')
    const s = service(async () => body)
    await s.refresh()
    body = 'not json'
    await s.refresh()
    expect(at(s).error).toBe('the index is not valid JSON')
    expect(at(s).index?.plugins).toHaveLength(1)
    body = JSON.stringify({ schema: 2, plugins: [] })
    await s.refresh()
    expect(at(s).error).toMatch(/schema/)
    expect(at(s).index?.plugins).toHaveLength(1)
  })

  it('refetches after an error and when the cached fetchedAt is in the future', async () => {
    let t = 1000
    let fail = true
    let calls = 0
    const s = service(async () => {
      calls++
      if (fail) throw new Error('down')
      return indexText('a.b')
    }, () => t)
    await s.refreshIfStale()
    expect(at(s).error).toBe('down')
    fail = false
    await s.refreshIfStale()
    expect(calls).toBe(2)
    expect(at(s).error).toBeNull()
    await s.refreshIfStale()
    expect(calls).toBe(2)
    t = 10 // clock moved back: fetchedAt (1000) is now in the future
    await s.refreshIfStale()
    expect(calls).toBe(3)
  })

  it('shares one in-flight fetch per URL', async () => {
    let calls = 0
    const s = service(async () => (calls++, await Promise.resolve(), indexText('a.b')))
    await Promise.all([s.refresh(), s.refreshIfStale(), s.refresh()])
    expect(calls).toBe(1)
  })

  describe('an index removed while its fetch is running', () => {
    /** A fetcher whose answers the test releases, one per call, in any order. */
    function pending() {
      const calls: ((text: string) => void)[] = []
      const fetcher = (): Promise<string> => new Promise((res) => void calls.push(res))
      return { calls, fetcher }
    }

    it('re-adding it starts a new fetch, and the visible index gets that answer, not the old one', async () => {
      const { calls, fetcher } = pending()
      const urls = [URL1]
      const s = service(fetcher, () => 1000, urls)
      const first = s.refresh()
      urls.length = 0
      s.prune()
      urls.push(URL1)
      const second = s.refresh()
      expect(calls).toHaveLength(2)
      calls[0]!(indexText('old.one'))
      await first
      expect(at(s).index).toBeNull()
      expect(readdirSync(dir)).toEqual([])
      calls[1]!(indexText('new.one'))
      await second
      expect(at(s)).toMatchObject({ fetchedAt: 1000, error: null })
      expect(at(s).index?.plugins.map((p) => p.id)).toEqual(['new.one'])
    })

    it('a stale answer after the new one neither overwrites it nor the cache', async () => {
      const { calls, fetcher } = pending()
      const urls = [URL1]
      const s = service(fetcher, () => 1000, urls)
      const first = s.refresh()
      urls.length = 0
      s.prune()
      urls.push(URL1)
      const second = s.refresh()
      calls[1]!(indexText('new.one'))
      await second
      calls[0]!(indexText('old.one'))
      await first
      expect(at(s).index?.plugins.map((p) => p.id)).toEqual(['new.one'])
      const fresh = service(() => Promise.reject(new Error('offline')))
      fresh.loadCache()
      expect(at(fresh).index?.plugins.map((p) => p.id)).toEqual(['new.one'])
    })

    it('its answer does not recreate the removed cache file', async () => {
      const { calls, fetcher } = pending()
      const urls = [URL1]
      const s = service(fetcher, () => 1000, urls)
      const first = s.refresh()
      urls.length = 0
      s.prune()
      calls[0]!(indexText('old.one'))
      await first
      expect(readdirSync(dir)).toEqual([])
    })

    it('an old fetch ending does not free the slot of the newer one, which callers still share', async () => {
      const { calls, fetcher } = pending()
      const urls = [URL1]
      const s = service(fetcher, () => 1000, urls)
      const first = s.refresh()
      urls.length = 0
      s.prune()
      urls.push(URL1)
      const second = s.refresh()
      calls[0]!(indexText('old.one'))
      await first
      const third = s.refresh()
      expect(calls).toHaveLength(2)
      calls[1]!(indexText('new.one'))
      await Promise.all([second, third])
      expect(at(s).index?.plugins.map((p) => p.id)).toEqual(['new.one'])
    })
  })

  it('leaves the cache file intact when a later fetch fails or is invalid', async () => {
    let body = indexText('a.b')
    const s = service(async () => body)
    await s.refresh()
    const file = join(dir, 'marketplaces', readdirSync(join(dir, 'marketplaces'))[0]!)
    const before = readFileSync(file, 'utf8')
    body = 'not json'
    await s.refresh()
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(readdirSync(join(dir, 'marketplaces'))).toHaveLength(1)
  })

  it('counts skipped entries', async () => {
    const s = service(async () => JSON.stringify({ schema: 1, plugins: [entry('a.b'), { id: 'bad' }] }))
    await s.refresh()
    expect(at(s).skippedEntries).toBe(1)
  })

  it('refuses a URL scheme other than https and file', async () => {
    let calls = 0
    const s = service(async () => (calls++, indexText()), () => 1, ['http://example.com/i.json'])
    await s.refresh()
    expect(calls).toBe(0)
    expect(at(s).error).toMatch(/https/)
  })

  it('ignores a corrupt or invalid cache file', () => {
    mkdirSync(join(dir, 'marketplaces'), { recursive: true })
    for (const f of ['{bad', JSON.stringify({ fetchedAt: 1, text: 'nope' })]) {
      const a = service(async () => indexText())
      writeFileSync(join(dir, 'marketplaces', `${createHash('sha256').update(URL1).digest('hex')}.json`), f)
      a.loadCache()
      expect(at(a).index).toBeNull()
    }
  })
})

describe('marketplaceUrls', () => {
  it('defaults to the official index and drops unusable entries', () => {
    expect(marketplaceUrls(undefined, {}, true)).toEqual([DEFAULT_MARKETPLACE_URL])
    expect(marketplaceUrls(['HTTPS://example.com/index.json', URL1, ' https://example.com/index.json'], {}, true)).toEqual([URL1])
    expect(marketplaceUrls([URL1, URL1, 'ftp://x', 5, 'https://u:p@h/x'], {}, true)).toEqual([URL1])
  })
  it('takes the env override only in a test run', () => {
    const env = { CC_COCKPIT_TEST: '1', CC_COCKPIT_MARKETPLACE_URLS: '' }
    expect(marketplaceUrls(undefined, env, false)).toEqual([])
    expect(marketplaceUrls(undefined, env, true)).toEqual([DEFAULT_MARKETPLACE_URL])
    expect(marketplaceUrls(undefined, { ...env, CC_COCKPIT_MARKETPLACE_URLS: `${URL1}, file:///a.json` }, false)).toEqual([
      URL1,
      'file:///a.json'
    ])
  })
})

describe('fetcher', () => {
  it('reads a file: index and refuses an oversized one', async () => {
    const f = join(dir, 'i.json')
    writeFileSync(f, 'hello')
    const url = `file://${f}`
    expect(await createIndexFetcher()(url)).toBe('hello')
    await expect(createIndexFetcher({ maxBytes: 3 })(url)).rejects.toThrow('too large')
    await expect(createIndexFetcher()(`file://${dir}/missing.json`)).rejects.toThrow('could not be read')
    // A directory, /dev/zero and a remote host or encoded slash fail with our own message, never hang.
    await expect(createIndexFetcher()(`file://${dir}`)).rejects.toThrow('could not be read')
    await expect(createIndexFetcher()('file:///dev/zero')).rejects.toThrow('could not be read')
    await expect(createIndexFetcher()('file://host/x')).rejects.toThrow('host')
    await expect(createIndexFetcher()('file:///a%2Fb')).rejects.toThrow('could not be read')
  })

  it('accepts a file of exactly the cap and refuses one byte more', async () => {
    const f = join(dir, 'i.json')
    writeFileSync(f, 'x'.repeat(16))
    expect(await createIndexFetcher({ maxBytes: 16 })(`file://${f}`)).toBe('x'.repeat(16))
    await expect(createIndexFetcher({ maxBytes: 15 })(`file://${f}`)).rejects.toThrow('too large')
  })

  // The regression this guards is a hang at startup: opening a FIFO with no writer blocks forever.
  it.skipIf(process.platform === 'win32')('refuses a FIFO without blocking, directly or through a symlink', async () => {
    const fifo = join(dir, 'pipe')
    execFileSync('mkfifo', [fifo])
    await expect(createIndexFetcher()(`file://${fifo}`)).rejects.toThrow('could not be read')
    const link = join(dir, 'link')
    symlinkSync(fifo, link)
    await expect(createIndexFetcher()(`file://${link}`)).rejects.toThrow('could not be read')
  }, 5_000)

  it('rejects bad schemes and credentials', async () => {
    expect(checkMarketplaceUrl('http://a/b')).toHaveProperty('problem')
    expect(checkMarketplaceUrl('https://u@a/b')).toHaveProperty('problem')
    expect(checkMarketplaceUrl(5)).toHaveProperty('problem')
    expect(checkMarketplaceUrl('HTTPS://a/b')).toEqual({ url: 'https://a/b' })
    await expect(createIndexFetcher()('ftp://a')).rejects.toThrow()
  })

  describe('https', () => {
    const res = (body: string, init?: ResponseInit) => new Response(body, init)
    it('caps the body while reading, with and without content-length', async () => {
      const big = 'x'.repeat(50)
      await expect(createIndexFetcher({ maxBytes: 10, fetch: async () => res(big) })(URL1)).rejects.toThrow('too large')
      await expect(
        createIndexFetcher({ maxBytes: 10, fetch: async () => res('', { headers: { 'content-length': '999' } }) })(URL1)
      ).rejects.toThrow('too large')
      expect(await createIndexFetcher({ fetch: async () => res('ok') })(URL1)).toBe('ok')
    })
    it('reports an HTTP error, a network error and passes redirect:error', async () => {
      await expect(createIndexFetcher({ fetch: async () => res('', { status: 404 }) })(URL1)).rejects.toThrow('HTTP 404')
      await expect(
        createIndexFetcher({ fetch: async () => { throw new TypeError('boom') } })(URL1)
      ).rejects.toThrow('could not be fetched')
      let seen: RequestInit | undefined
      await createIndexFetcher({ fetch: async (_u, i) => ((seen = i), res('ok')) })(URL1)
      expect(seen?.redirect).toBe('error')
    })
    /** A body delivered in pieces; `cancelled` says whether the reader gave up on it. */
    function chunked(chunks: string[], init?: ResponseInit): { response: Response; cancelled: () => boolean } {
      let cancelled = false
      let i = 0
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (i < chunks.length) c.enqueue(new TextEncoder().encode(chunks[i++]))
          else c.close()
        },
        cancel() {
          cancelled = true
        }
      })
      return { response: new Response(body, init), cancelled: () => cancelled }
    }
    it('stops reading and cancels as soon as a multi-chunk body passes the cap', async () => {
      const b = chunked(['xxxx', 'xxxx', 'xxxx', 'never read'])
      await expect(createIndexFetcher({ maxBytes: 10, fetch: async () => b.response })(URL1)).rejects.toThrow('too large')
      expect(b.cancelled()).toBe(true)
    })
    it('cancels the unread body when content-length alone is over the cap', async () => {
      // Otherwise the stream and its connection stay open until the timeout.
      const b = chunked(['never read'], { headers: { 'content-length': '999' } })
      await expect(createIndexFetcher({ maxBytes: 10, fetch: async () => b.response })(URL1)).rejects.toThrow('too large')
      expect(b.cancelled()).toBe(true)
    })
    it('accepts a body of exactly the cap in pieces', async () => {
      const b = chunked(['xxxxx', 'xxxxx'])
      expect(await createIndexFetcher({ maxBytes: 10, fetch: async () => b.response })(URL1)).toBe('x'.repeat(10))
    })
    it('survives odd headers and bodies: the bytes read are what count', async () => {
      for (const length of ['nonsense', '-5']) {
        expect(await createIndexFetcher({ fetch: async () => res('ok', { headers: { 'content-length': length } }) })(URL1)).toBe('ok')
        await expect(
          createIndexFetcher({ maxBytes: 1, fetch: async () => res('ok', { headers: { 'content-length': length } }) })(URL1)
        ).rejects.toThrow('too large')
      }
      expect(await createIndexFetcher({ fetch: async () => new Response(null) })(URL1)).toBe('')
      // Invalid UTF-8 is replaced, not thrown; parseMarketplaceIndex judges the text.
      const bad = new Response(new Uint8Array([0x7b, 0xff, 0x7d]))
      expect(await createIndexFetcher({ fetch: async () => bad })(URL1)).toBe('{\ufffd}')
    })
    it('cancels the body of an error response', async () => {
      const b = chunked(['<html>'])
      const notFound = new Response(b.response.body, { status: 503 })
      await expect(createIndexFetcher({ fetch: async () => notFound })(URL1)).rejects.toThrow('HTTP 503')
      expect(b.cancelled()).toBe(true)
    })
    it('shows only its own messages: a thrown error text comes from the network stack, not from us', async () => {
      const reveal = new TypeError('connect ECONNREFUSED 10.0.0.1:443')
      await expect(createIndexFetcher({ fetch: async () => Promise.reject(reveal) })(URL1)).rejects.toThrow(/^the index could not be fetched$/)
      const aborted = new DOMException('This operation was aborted', 'AbortError')
      await expect(createIndexFetcher({ fetch: async () => Promise.reject(aborted) })(URL1)).rejects.toThrow(/^the index could not be fetched$/)
    })
    it('times out a body that stalls after the headers', async () => {
      const server: Server = createServer((_req, r) => {
        r.writeHead(200, { 'content-type': 'application/json' })
        r.write('{')
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const port = (server.address() as { port: number }).port
      try {
        const f = createIndexFetcher({ timeoutMs: 100, fetch: (_u, i) => fetch(`http://127.0.0.1:${port}/`, i) })
        await expect(f(URL1)).rejects.toThrow('in time')
      } finally {
        server.closeAllConnections()
        server.close()
      }
    })
    it('times out a stalled server', async () => {
      const server: Server = createServer(() => undefined)
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const port = (server.address() as { port: number }).port
      try {
        // https scheme is required by the guard; the fake fetch redirects to the stalled http server.
        const f = createIndexFetcher({
          timeoutMs: 100,
          fetch: (_u, i) => fetch(`http://127.0.0.1:${port}/`, i)
        })
        await expect(f(URL1)).rejects.toThrow('in time')
      } finally {
        server.closeAllConnections()
        server.close()
      }
    })
  })
})

describe('MarketplaceService revocations', () => {
  const OTHER = 'https://other.example/index.json'
  const revokedText = (id: string, commit: string, reason = 'bad') =>
    JSON.stringify({ schema: 1, plugins: [], revoked: [{ id, commit, reason }] })
  const byUrl = (texts: Record<string, string>) => async (u: string) => {
    const text = texts[u]
    if (text === undefined) throw new Error('offline')
    return text
  }

  it('enforces from the index recorded on the plugin, on id and full commit', async () => {
    const s = service(byUrl({ [URL1]: revokedText('a.b', COMMIT), [DEFAULT_MARKETPLACE_URL]: indexText() }), () => 1000, [URL1, DEFAULT_MARKETPLACE_URL])
    await s.refresh()
    expect(s.revocationFor({ id: 'a.b', commit: COMMIT, marketplace: URL1 })).toEqual({ reason: 'bad', source: URL1 })
    expect(s.revocationFor({ id: 'a.b', commit: 'b'.repeat(40), marketplace: URL1 })).toBeNull()
    expect(s.revocationFor({ id: 'c.d', commit: COMMIT, marketplace: URL1 })).toBeNull()
  })

  it('enforces from the default index, also for a plugin with no recorded index', async () => {
    const s = service(byUrl({ [DEFAULT_MARKETPLACE_URL]: revokedText('a.b', COMMIT) }), () => 1000, [DEFAULT_MARKETPLACE_URL])
    await s.refresh()
    expect(s.revocationFor({ id: 'a.b', commit: COMMIT })).toEqual({ reason: 'bad', source: DEFAULT_MARKETPLACE_URL })
    expect(s.revocationFor({ id: 'a.b', commit: COMMIT, marketplace: URL1 })?.source).toBe(DEFAULT_MARKETPLACE_URL)
    expect(s.revocationWarnings({ id: 'a.b', commit: COMMIT })).toEqual([])
  })

  it('a good copy of the issuing index withdraws its revocation while the other authority has none', async () => {
    const s = service(byUrl({ [URL1]: indexText() }), () => 1000, [URL1])
    await s.refresh()
    const plugin = { id: 'a.b', commit: COMMIT, marketplace: URL1 }
    expect(s.revocationFor({ ...plugin, recordedSource: URL1 })).toBeNull()
    // Nothing recorded, or recorded by the index that cannot be read: still not known.
    expect(s.revocationFor(plugin)).toBeUndefined()
    expect(s.revocationFor({ ...plugin, recordedSource: DEFAULT_MARKETPLACE_URL })).toBeUndefined()
  })

  it('an issuer with no usable copy keeps its revocation, whatever the other authority says', async () => {
    const s = service(byUrl({ [DEFAULT_MARKETPLACE_URL]: indexText() }), () => 1000, [DEFAULT_MARKETPLACE_URL])
    await s.refresh()
    expect(s.revocationFor({ id: 'a.b', commit: COMMIT, marketplace: URL1, recordedSource: URL1 })).toBeUndefined()
  })

  it('an index without authority over the plugin cannot withdraw', async () => {
    const s = service(byUrl({ [OTHER]: indexText() }), () => 1000, [OTHER])
    await s.refresh()
    expect(s.revocationFor({ id: 'a.b', commit: COMMIT, recordedSource: OTHER })).toBeUndefined()
  })

  it('is unknown, not "not revoked", while an authority has no usable index', async () => {
    const s = service(byUrl({ [URL1]: indexText() }), () => 1000, [URL1])
    await s.refresh()
    // The default index was never fetched and has no cache: nothing says this commit is clean.
    expect(s.revocationFor({ id: 'a.b', commit: COMMIT, marketplace: URL1 })).toBeUndefined()
  })

  it('a revocation from an unrelated index only warns, naming that index', async () => {
    const s = service(
      byUrl({ [URL1]: indexText(), [OTHER]: revokedText('a.b', COMMIT, 'their word'), [DEFAULT_MARKETPLACE_URL]: indexText() }),
      () => 1000,
      [URL1, OTHER, DEFAULT_MARKETPLACE_URL]
    )
    await s.refresh()
    for (const plugin of [{ id: 'a.b', commit: COMMIT, marketplace: URL1 }, { id: 'a.b', commit: COMMIT }]) {
      expect(s.revocationFor(plugin)).toBeNull()
      expect(s.revocationWarnings(plugin)).toEqual([{ reason: 'their word', source: OTHER }])
    }
    // From its own index it is no warning: it is enforced.
    expect(s.revocationWarnings({ id: 'a.b', commit: COMMIT, marketplace: OTHER })).toEqual([])
  })

  it('a failed or invalid fetch keeps the revocations, and only a good fetch reports a refresh', async () => {
    let refreshed = 0
    let body: string | Error = revokedText('a.b', COMMIT)
    const s = new MarketplaceService({
      dataDir: dir,
      urls: () => [URL1],
      authorities: () => [],
      now: () => 1000,
      onRefreshed: () => refreshed++,
      fetcher: async () => {
        if (body instanceof Error) throw body
        return body
      }
    })
    const plugin = { id: 'a.b', commit: COMMIT, marketplace: URL1 }
    await s.refresh()
    expect(refreshed).toBe(1)
    body = new Error('offline')
    await s.refresh()
    body = 'not json'
    await s.refresh()
    expect(refreshed).toBe(1)
    expect(s.revocationFor(plugin)?.reason).toBe('bad')
    body = indexText()
    await s.refresh()
    expect(refreshed).toBe(2)
  })

  it('applies from the cache offline, also for an authority no longer on the list', async () => {
    const online = service(byUrl({ [URL1]: revokedText('a.b', COMMIT) }))
    await online.refresh()
    const plugin = { id: 'a.b', commit: COMMIT, marketplace: URL1 }

    const offline = service(byUrl({}))
    offline.loadCache()
    await offline.refresh()
    expect(offline.revocationFor(plugin)?.reason).toBe('bad')

    // Taking the index off the list must not be an override.
    const removed = service(byUrl({}), () => 1000, [], [URL1])
    removed.loadCache()
    expect(removed.revocationFor(plugin)?.reason).toBe('bad')
    expect(removed.list()).toEqual([])
    // Without the record nothing asks for it, and no record means no authority.
    const unrecorded = service(byUrl({}), () => 1000, [])
    unrecorded.loadCache()
    expect(unrecorded.revocationFor(plugin)).toBeUndefined()
  })
})

// Design-next §6.1: a listing's preview, fetched lazily from the index's own folder, checked against
// the entry's sha256 and the PNG signature, and cached under <data>/marketplace/previews/.
describe('MarketplaceService.preview', () => {
  const PNG = fakePng()
  const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
  const PREVIEW_URL = `https://example.com/previews/a.b/${COMMIT}.png`
  const listed = (sha256: string | null = sha(PNG)) =>
    JSON.stringify({
      schema: 1,
      plugins: [{ ...entry('a.b'), ...(sha256 !== null ? { preview: { sha256 } } : {}) }, entry('c.d')],
      revoked: []
    })

  /** A service over one listed index whose previews come from `previews` (by URL); `asked` records each fetch. */
  async function setup(previews: (url: string) => Promise<Uint8Array>, opts: { text?: string; now?: () => number } = {}) {
    const asked: string[] = []
    const logs: string[] = []
    const s = new MarketplaceService({
      dataDir: dir,
      urls: () => [URL1],
      authorities: () => [],
      fetcher: async (u) => (u === URL1 ? (opts.text ?? listed()) : Promise.reject(new Error('offline'))),
      previewFetcher: (u) => (asked.push(u), previews(u)),
      now: opts.now ?? (() => 1000),
      log: (m) => logs.push(m)
    })
    await s.refresh()
    return { s, asked, logs }
  }
  const cacheDir = (): string => join(dir, 'marketplace', 'previews')

  it('fetches from the index folder, checks the hash, caches, and serves the cache after', async () => {
    const { s, asked } = await setup(async () => PNG)
    expect(Buffer.from((await s.preview(URL1, 'a.b'))!)).toEqual(PNG)
    expect(asked).toEqual([PREVIEW_URL])
    expect(readdirSync(cacheDir())).toEqual([`${sha(PNG)}.png`])
    // A cache hit: no second fetch, the same bytes.
    expect(Buffer.from((await s.preview(URL1, 'a.b'))!)).toEqual(PNG)
    expect(asked).toHaveLength(1)
  })

  it('shares one fetch between concurrent asks', async () => {
    let release: (b: Uint8Array) => void = () => {}
    const { s, asked } = await setup(() => new Promise((r) => (release = r)))
    const both = Promise.all([s.preview(URL1, 'a.b'), s.preview(URL1, 'a.b')])
    await Promise.resolve()
    release(PNG)
    const [x, y] = await both
    expect(x).not.toBeNull()
    expect(y).not.toBeNull()
    expect(asked).toHaveLength(1)
  })

  it('refuses a wrong hash and a body that is not a PNG, and caches neither', async () => {
    const other = fakePng({ width: 1600 })
    const { s, logs } = await setup(async () => other)
    expect(await s.preview(URL1, 'a.b')).toBeNull()
    expect(logs.join('\n')).toMatch(/does not match the hash/)
    expect(() => readdirSync(cacheDir())).toThrow()

    rmSync(join(dir, 'marketplaces'), { recursive: true, force: true })
    const notPng = Buffer.from('GIF89a not a png at all')
    const { s: s2 } = await setup(async () => notPng, { text: listed(sha(notPng)) })
    expect(await s2.preview(URL1, 'a.b')).toBeNull()
  })

  it('refuses a correctly hashed PNG whose IHDR size is out of range, and caches nothing', async () => {
    // A third-party index controls bytes and hash: the hash matches, so only the framing check can refuse it.
    const bomb = fakePng({ width: 30000, height: 30000 })
    const { s } = await setup(async () => bomb, { text: listed(sha(bomb)) })
    expect(await s.preview(URL1, 'a.b')).toBeNull()
    expect(() => readdirSync(cacheDir())).toThrow()
  })

  it('a fetch failure (redirect, oversized, HTTP error) is null and retried only after PREVIEW_RETRY_MS', async () => {
    let t = 1000
    let fail = true
    const { s, asked } = await setup(async () => (fail ? Promise.reject(new Error('the server answered HTTP 302')) : PNG), { now: () => t })
    expect(await s.preview(URL1, 'a.b')).toBeNull()
    fail = false
    expect(await s.preview(URL1, 'a.b')).toBeNull()
    expect(asked).toHaveLength(1)
    t += PREVIEW_RETRY_MS
    expect(await s.preview(URL1, 'a.b')).not.toBeNull()
    expect(asked).toHaveLength(2)
  })

  it('asks nothing for a listing without a preview, an unknown id, an unconfigured index or bad input', async () => {
    const { s, asked } = await setup(async () => PNG)
    expect(await s.preview(URL1, 'c.d')).toBeNull()
    expect(await s.preview(URL1, 'no.such')).toBeNull()
    expect(await s.preview('https://other.example/index.json', 'a.b')).toBeNull()
    expect(await s.preview(5, 'a.b')).toBeNull()
    expect(await s.preview(URL1, { id: 'a.b' })).toBeNull()
    expect(asked).toEqual([])
  })

  it('a changed cache file is fetched again, not shown', async () => {
    const { s, asked } = await setup(async () => PNG)
    await s.preview(URL1, 'a.b')
    writeFileSync(join(cacheDir(), `${sha(PNG)}.png`), Buffer.concat([PNG, Buffer.from('x')]))
    expect(Buffer.from((await s.preview(URL1, 'a.b'))!)).toEqual(PNG)
    expect(asked).toHaveLength(2)
  })

  it('drops cached previews no index lists any more when it writes one', async () => {
    mkdirSync(cacheDir(), { recursive: true })
    writeFileSync(join(cacheDir(), `${'f'.repeat(64)}.png`), PNG)
    writeFileSync(join(cacheDir(), 'stray.png.tmp'), 'x')
    const { s } = await setup(async () => PNG)
    await s.preview(URL1, 'a.b')
    expect(readdirSync(cacheDir())).toEqual([`${sha(PNG)}.png`])
  })

  it('keeps the cache while a configured index has not been read: its previews are not known yet', async () => {
    mkdirSync(cacheDir(), { recursive: true })
    const other = `${'e'.repeat(64)}.png`
    writeFileSync(join(cacheDir(), other), PNG)
    const OFFLINE = 'https://offline.example/index.json'
    const s = new MarketplaceService({
      dataDir: dir,
      urls: () => [URL1, OFFLINE],
      authorities: () => [],
      fetcher: async (u) => (u === URL1 ? listed() : Promise.reject(new Error('offline'))),
      previewFetcher: async () => PNG,
      now: () => 1000
    })
    await s.refresh()
    await s.preview(URL1, 'a.b')
    expect(readdirSync(cacheDir()).sort()).toEqual([`${sha(PNG)}.png`, other].sort())
  })
})

describe('preview fetcher', () => {
  const PNG = fakePng()
  it('reads a file: preview, capped, regular files only', async () => {
    const f = join(dir, 'p.png')
    writeFileSync(f, PNG)
    expect(Buffer.from(await createPreviewFetcher()(`file://${f}`))).toEqual(PNG)
    await expect(createPreviewFetcher({ maxBytes: 10 })(`file://${f}`)).rejects.toThrow(`over ${MAX_PREVIEW_BYTES / 1024} KiB`)
    await expect(createPreviewFetcher()(`file://${dir}`)).rejects.toThrow('could not be read')
    const link = join(dir, 'l.png')
    symlinkSync('/dev/zero', link)
    await expect(createPreviewFetcher()(`file://${link}`)).rejects.toThrow('could not be read')
  })

  it('https: refuses a redirect, an HTTP error and an oversized body; returns the bytes', async () => {
    let seen: RequestInit | undefined
    const ok = await createPreviewFetcher({ fetch: async (_u, i) => ((seen = i), new Response(new Uint8Array(PNG))) })(URL1)
    expect(Buffer.from(ok)).toEqual(PNG)
    expect(seen?.redirect).toBe('error')
    await expect(createPreviewFetcher({ fetch: async () => new Response('', { status: 404 }) })(URL1)).rejects.toThrow('HTTP 404')
    await expect(
      createPreviewFetcher({ fetch: async () => Promise.reject(new TypeError('redirect mode is set to error')) })(URL1)
    ).rejects.toThrow(/^the preview could not be fetched$/)
    await expect(createPreviewFetcher({ maxBytes: 10, fetch: async () => new Response(new Uint8Array(PNG)) })(URL1)).rejects.toThrow('KiB')
    await expect(
      createPreviewFetcher({ fetch: async () => new Response('', { headers: { 'content-length': String(MAX_PREVIEW_BYTES + 1) } }) })(URL1)
    ).rejects.toThrow('KiB')
    await expect(createPreviewFetcher()('ftp://a/p.png')).rejects.toThrow('only https')
  })
})
