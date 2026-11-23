// The web shell's upload client (design-upload.md §3.3) against a fake fetch and a fake clock: the bytes
// and offsets it sends, the chunk size's growth and floor, a cut chunk, a lost answer, a 409 resume, a
// refusal that ends one file, an abort and the progress it reports.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UPLOAD_CHUNK_MAX_BYTES,
  UPLOAD_CHUNK_MIN_BYTES,
  UPLOAD_CHUNK_START_BYTES,
  UPLOAD_IDLE_MS,
  UPLOAD_MAX_FILE_BYTES,
  type UploadFileToken
} from '../../src/shared/uploads'
import {
  runUpload,
  UPLOAD_CHUNK_RETRIES,
  UPLOAD_CHUNK_TIMEOUT_MS,
  UPLOAD_RETRY_BACKOFF_MS,
  uploadChunkDeadlineMs,
  type UploadFetch,
  type UploadProgress,
  type UploadSource
} from '../../src/renderer/web/upload-client'

const MIB = 1024 ** 2

/** A file of `size` bytes; the client only slices it. */
const fileOf = (size: number): UploadSource => ({
  size,
  slice: (start, end) => new Blob([new Uint8Array(Math.max(0, Math.min(end, size) - start))])
})
const tokenOf = (index: number, name = `f${index}`): UploadFileToken => ({ index, token: `tok-${index}`, name })

interface Call {
  token: string
  offset: number
  length: number
  at: number
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** What a script step may do with a call: answer, throw (a network error) or never answer. */
type Step = Response | Error | 'hang'

function rig(script: (call: Call, n: number) => Step, opts: { chunkMs?: number } = {}) {
  let clock = 0
  const calls: Call[] = []
  const sleeps: number[] = []
  const fetch: UploadFetch = async (url, init) => {
    const m = /^\/u\/([^?]+)\?offset=(\d+)$/.exec(url)
    expect(m).not.toBeNull()
    expect(init?.method).toBe('PUT')
    const body = init?.body as Blob
    const call: Call = { token: m![1]!, offset: Number(m![2]), length: body.size, at: clock }
    calls.push(call)
    const step = script(call, calls.length - 1)
    if (step === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    }
    clock += opts.chunkMs ?? 100
    if (step instanceof Error) throw step
    return step
  }
  return {
    calls,
    sleeps,
    fetch,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms)
    }
  }
}

/** An honest server for one file: acknowledges contiguous chunks and commits the last. */
const honest =
  (size: number) =>
  (call: Call): Response => {
    const end = call.offset + call.length
    return end >= size ? json(200, { done: true, name: 'f0', path: 'inbox/f0' }) : json(200, { received: end })
  }

const committed = (): Response => json(200, { done: true, name: 'n', path: 'p' })

afterEach(() => {
  vi.useRealTimers()
})

describe('runUpload', () => {
  it('sends a 20 MiB file as contiguous growing slices and ends done', async () => {
    const size = 20 * MIB
    const r = rig(honest(size), { chunkMs: 100 })
    const results = await runUpload([fileOf(size)], [tokenOf(0)], r)
    expect(results).toEqual([{ index: 0, name: 'f0', outcome: 'done', path: 'inbox/f0' }])
    // 1 MiB start, doubled after every fast full-size chunk, the last one the remainder.
    expect(r.calls.map((c) => c.length / MIB)).toEqual([1, 2, 4, 8, 5])
    let at = 0
    for (const c of r.calls) {
      expect(c.offset).toBe(at)
      at += c.length
    }
    expect(at).toBe(size)
    expect(r.calls.every((c) => c.length <= UPLOAD_CHUNK_MAX_BYTES)).toBe(true)
  })

  it('sends an empty file as one zero-length PUT at offset 0', async () => {
    const r = rig(() => json(200, { done: true, name: 'f0', path: 'f0' }))
    const results = await runUpload([fileOf(0)], [tokenOf(0)], r)
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]).toMatchObject({ offset: 0, length: 0 })
    expect(results[0]?.outcome).toBe('done')
  })

  it('shrinks to the floor on a slow link and no further', async () => {
    const size = 6 * MIB
    const r = rig(honest(size), { chunkMs: 11_000 })
    await runUpload([fileOf(size)], [tokenOf(0)], r)
    expect(r.calls.slice(0, 5).map((c) => c.length)).toEqual([
      UPLOAD_CHUNK_START_BYTES,
      UPLOAD_CHUNK_START_BYTES / 2,
      UPLOAD_CHUNK_MIN_BYTES,
      UPLOAD_CHUNK_MIN_BYTES,
      UPLOAD_CHUNK_MIN_BYTES
    ])
  })

  it('keeps the size between 2.5 s and 10 s', async () => {
    const size = 2 * MIB + 1000
    const r = rig(honest(size), { chunkMs: 5_000 })
    const results = await runUpload([fileOf(size)], [tokenOf(0)], r)
    expect(r.calls.map((c) => c.length)).toEqual([MIB, MIB, 1000])
    expect(results[0]?.outcome).toBe('done')
  })

  it('does not read the link speed from a short chunk', async () => {
    const r = rig(committed, { chunkMs: 1 })
    await runUpload([fileOf(10), fileOf(3 * MIB)], [tokenOf(0), tokenOf(1)], r)
    // The 10-byte file was fast by being short: the next file still starts at the start size.
    expect(r.calls[1]?.length).toBe(UPLOAD_CHUNK_START_BYTES)
  })

  it('retries a chunk the request bound cut (408) with half the size, after a backoff', async () => {
    const size = 3 * MIB
    const r = rig((c, n) => (n === 0 ? json(408, { error: 'cut' }) : honest(size)(c)))
    const results = await runUpload([fileOf(size)], [tokenOf(0)], r)
    expect(r.calls.slice(0, 2).map((c) => [c.offset, c.length])).toEqual([
      [0, MIB],
      [0, MIB / 2]
    ])
    expect(r.sleeps).toEqual([1_000])
    expect(results[0]?.outcome).toBe('done')
  })

  it('treats a chunk that outlives the client deadline as cut', async () => {
    vi.useFakeTimers()
    const size = 2 * MIB
    const r = rig((c, n) => (n === 0 ? 'hang' : honest(size)(c)))
    const run = runUpload([fileOf(size)], [tokenOf(0)], r)
    await vi.advanceTimersByTimeAsync(UPLOAD_CHUNK_TIMEOUT_MS + 1)
    const results = await run
    expect(r.calls[1]).toMatchObject({ offset: 0, length: MIB / 2 })
    expect(results[0]?.outcome).toBe('done')
  })

  it('sets the client deadline past the gateway cut (30 s bound, checked every 5 s)', () => {
    expect(UPLOAD_CHUNK_TIMEOUT_MS).toBeGreaterThan(35_000)
    expect(uploadChunkDeadlineMs(0, MIB, 3 * MIB)).toBe(UPLOAD_CHUNK_TIMEOUT_MS)
    // The last chunk's answer waits for the commit, a whole copy on a mount with no hard links.
    expect(uploadChunkDeadlineMs(2 * MIB, MIB, 3 * MIB)).toBeGreaterThan(UPLOAD_CHUNK_TIMEOUT_MS)
    expect(uploadChunkDeadlineMs(UPLOAD_MAX_FILE_BYTES - MIB, MIB, UPLOAD_MAX_FILE_BYTES)).toBeGreaterThanOrEqual(
      UPLOAD_CHUNK_TIMEOUT_MS + 500_000
    )
  })

  it('waits past 45 s for the last chunk of a large file while the server commits it', async () => {
    vi.useFakeTimers()
    const size = 400 * MIB
    // A stand-in that allocates nothing: the rig reads only the slice's size.
    const big: UploadSource = { size, slice: (start, end) => ({ size: end - start }) as unknown as Blob }
    const calls: number[] = []
    const fetch: UploadFetch = (url, init) => {
      const offset = Number(/offset=(\d+)$/.exec(url)![1])
      calls.push(offset)
      // The first PUT finds the server further on, at the last chunk, which commits for 2 minutes.
      if (offset === 0) return Promise.resolve(json(409, { expected: size - MIB }))
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(json(200, { done: true, name: 'big', path: 'big' })), 120_000)
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    }
    const run = runUpload([big], [tokenOf(0)], { fetch, now: () => 0 })
    await vi.advanceTimersByTimeAsync(121_000)
    const results = await run
    expect(calls).toEqual([0, size - MIB])
    expect(results[0]).toMatchObject({ outcome: 'done', path: 'big' })
  })

  it('retries after a network error at the same offset and size', async () => {
    const size = 2 * MIB
    const r = rig((c, n) => (n === 1 ? new TypeError('Failed to fetch') : honest(size)(c)))
    const results = await runUpload([fileOf(size)], [tokenOf(0)], r)
    // Chunk 0 acknowledged and doubled the size; the second attempt's network error, then the same slice again.
    expect(r.calls.map((c) => [c.offset, c.length])).toEqual([
      [0, MIB],
      [MIB, MIB],
      [MIB, MIB]
    ])
    expect(results[0]?.outcome).toBe('done')
  })

  it('retries 502, 503 and 504 like a network error', async () => {
    const r = rig((c, n) => (n < 3 ? new Response('bad gateway', { status: [502, 503, 504][n]! }) : honest(100)(c)))
    const results = await runUpload([fileOf(100)], [tokenOf(0)], r)
    expect(r.calls).toHaveLength(4)
    expect(r.sleeps).toEqual([...UPLOAD_RETRY_BACKOFF_MS])
    expect(results[0]?.outcome).toBe('done')
  })

  it('gives up after the retries on a dead link, tries the next file once, then fails the rest untried', async () => {
    const r = rig(() => new TypeError('Failed to fetch'))
    const results = await runUpload([fileOf(10), fileOf(10), fileOf(10)], [tokenOf(0), tokenOf(1), tokenOf(2)], r)
    expect(r.calls.map((c) => c.token)).toEqual([...Array<string>(1 + UPLOAD_CHUNK_RETRIES).fill('tok-0'), 'tok-1'])
    expect(results.map((x) => x.outcome)).toEqual(['failed', 'failed', 'failed'])
    for (const x of results) expect(x.reason).toMatch(/connection was lost/)
  })

  it('goes on to the next file when one file alone keeps failing, and gives the one after full retries again', async () => {
    // Whatever makes one file's fetch reject (here a readable file): the run does not end with it.
    const r = rig((c, n) => {
      if (c.token === 'tok-0') return new TypeError('Failed to fetch')
      if (c.token === 'tok-2' && n < 7) return new TypeError('Failed to fetch')
      return committed()
    })
    const results = await runUpload([fileOf(10), fileOf(10), fileOf(10)], [tokenOf(0), tokenOf(1), tokenOf(2)], r)
    expect(results.map((x) => x.outcome)).toEqual(['failed', 'done', 'done'])
    expect(results[0]?.reason).toMatch(/connection was lost/)
    // tok-1's acknowledged chunk cleared the doubt: tok-2 failed twice and was retried, not ended.
    expect(r.calls.map((c) => c.token)).toEqual(['tok-0', 'tok-0', 'tok-0', 'tok-0', 'tok-1', 'tok-2', 'tok-2', 'tok-2'])
  })

  it('ends a file that can no longer be read at once, without retries, and goes on', async () => {
    // Chromium rejects the fetch of a File changed or removed since it was picked; its slice cannot be read.
    const gone: UploadSource = {
      size: 10,
      slice: (start, end) =>
        ({ size: end - start, arrayBuffer: () => Promise.reject(new DOMException('changed', 'NotReadableError')) }) as unknown as Blob
    }
    const r = rig((c) => (c.token === 'tok-0' ? new TypeError('Failed to fetch') : committed()))
    const results = await runUpload([gone, fileOf(10)], [tokenOf(0), tokenOf(1)], r)
    expect(r.calls.map((c) => c.token)).toEqual(['tok-0', 'tok-1'])
    expect(r.sleeps).toEqual([])
    expect(results[0]).toMatchObject({ outcome: 'failed', reason: 'the file could not be read' })
    expect(results[1]?.outcome).toBe('done')
  })

  it('keeps the retry budget well under the idle clock and long enough for a short reconnect', () => {
    expect(UPLOAD_RETRY_BACKOFF_MS).toHaveLength(UPLOAD_CHUNK_RETRIES)
    const sum = UPLOAD_RETRY_BACKOFF_MS.reduce((a, b) => a + b, 0)
    expect(sum).toBeGreaterThanOrEqual(20_000)
    expect(sum).toBeLessThanOrEqual(UPLOAD_IDLE_MS / 2)
  })

  it('retries the writer 400 for a body that ended short at the same offset, and refuses any other 400', async () => {
    const short = (): Response => json(400, { error: 'the body ended before its length', expected: 0 })
    const r = rig((c, n) => (n === 0 ? short() : honest(10)(c)))
    const results = await runUpload([fileOf(10)], [tokenOf(0)], r)
    expect(r.calls.map((c) => c.offset)).toEqual([0, 0])
    expect(r.sleeps).toEqual([1_000])
    expect(results[0]?.outcome).toBe('done')

    const always = rig(short)
    const ended = await runUpload([fileOf(10)], [tokenOf(0)], always)
    expect(always.calls).toHaveLength(1 + UPLOAD_CHUNK_RETRIES)
    expect(ended[0]).toMatchObject({ outcome: 'failed', reason: 'the body ended before its length' })

    const shape = rig(() => json(400, { error: 'bad offset' }))
    const refused = await runUpload([fileOf(10)], [tokenOf(0)], shape)
    expect(shape.calls).toHaveLength(1)
    expect(refused[0]).toMatchObject({ outcome: 'failed', reason: 'bad offset' })
  })

  it('reads a 404 after a short body as an ended upload, not a lost answer', async () => {
    const r = rig((_c, n) => (n === 0 ? json(400, { error: 'short', expected: 0 }) : new Response('not found', { status: 404 })))
    const results = await runUpload([fileOf(10)], [tokenOf(0)], r)
    expect(results[0]?.reason).toBe('the upload was ended')
  })

  it('ends a file whose cut chunks never fit as too slow, and goes on to the next', async () => {
    const r = rig((c) => (c.token === 'tok-0' ? json(408, {}) : committed()))
    const results = await runUpload([fileOf(10), fileOf(10)], [tokenOf(0), tokenOf(1)], r)
    expect(results[0]).toMatchObject({ outcome: 'failed' })
    expect(results[0]?.reason).toMatch(/too slow/)
    expect(results[1]?.outcome).toBe('done')
  })

  it('resumes at the expected offset after a 409 without using a retry', async () => {
    const size = 4 * MIB
    // The first chunk landed but its answer did not (a Chromium resend); the retry is told where the file is.
    const r = rig((c, n) => (n === 0 ? json(409, { expected: 3 * MIB }) : honest(size)(c)))
    const results = await runUpload([fileOf(size)], [tokenOf(0)], r)
    expect(r.calls.map((c) => [c.offset, c.length])).toEqual([
      [0, MIB],
      [3 * MIB, MIB]
    ])
    expect(r.sleeps).toEqual([])
    expect(results[0]?.outcome).toBe('done')
  })

  it('fails a file whose 409 points nowhere new', async () => {
    const r = rig(() => json(409, { expected: 0 }))
    const results = await runUpload([fileOf(10)], [tokenOf(0)], r)
    expect(r.calls).toHaveLength(1)
    expect(results[0]?.outcome).toBe('failed')
  })

  it('ends the file on a 409 that points behind the acknowledged offset, and progress never goes back', async () => {
    const size = 3 * MIB
    const seen: number[] = []
    const r = rig((c, n) => (n === 0 ? honest(size)(c) : json(409, { expected: 0 })))
    const results = await runUpload([fileOf(size)], [tokenOf(0)], { ...r, onProgress: (p) => seen.push(p.sent) })
    expect(r.calls).toHaveLength(2)
    expect(seen).toEqual([MIB])
    expect(results[0]).toMatchObject({ outcome: 'failed', reason: 'the server gave an unexpected answer' })
  })

  it('ends the file on a 409 that points at the size, never sending an empty chunk there', async () => {
    const r = rig(() => json(409, { expected: 10 }))
    const results = await runUpload([fileOf(10)], [tokenOf(0)], r)
    expect(r.calls).toHaveLength(1)
    expect(results[0]).toMatchObject({ outcome: 'failed', reason: 'the server gave an unexpected answer' })
  })

  it('ends the file when every byte is acknowledged with no commit answer', async () => {
    const r = rig((c) => json(200, { received: c.offset + c.length }))
    const results = await runUpload([fileOf(10)], [tokenOf(0)], r)
    expect(r.calls).toHaveLength(1)
    expect(results[0]).toMatchObject({ outcome: 'failed', reason: 'the server gave an unexpected answer' })
  })

  it('ends one file on a 507 with the server reason, never retried, while the next continues', async () => {
    const r = rig((c) => (c.token === 'tok-0' ? json(507, { error: 'the disk is full' }) : committed()))
    const results = await runUpload([fileOf(10), fileOf(10)], [tokenOf(0), tokenOf(1)], r)
    expect(r.calls.map((c) => c.token)).toEqual(['tok-0', 'tok-1'])
    expect(results[0]).toEqual({ index: 0, name: 'f0', outcome: 'failed', reason: 'the disk is full' })
    expect(results[1]?.outcome).toBe('done')
  })

  it('shows a status line for a refusal that is not JSON', async () => {
    const r = rig(() => new Response('<html>', { status: 413 }))
    const results = await runUpload([fileOf(10)], [tokenOf(0)], r)
    expect(r.calls).toHaveLength(1)
    expect(results[0]).toMatchObject({ outcome: 'failed', reason: 'the server answered 413' })
  })

  it('caps a long server reason, never retrying a 500', async () => {
    const r = rig(() => json(500, { error: 'x'.repeat(5000) }))
    const results = await runUpload([fileOf(10)], [tokenOf(0)], r)
    expect(r.calls).toHaveLength(1)
    expect(results[0]?.reason).toHaveLength(200)
  })

  describe('a lost answer', () => {
    it('ends a file as failed, never done, when a network error is followed by a 404 on the retry', async () => {
      // The writer failed the file (507) and dropped its token; the link dropped the answer.
      const r = rig((_c, n) => (n === 0 ? new TypeError('Failed to fetch') : new Response('not found', { status: 404 })))
      const results = await runUpload([fileOf(10)], [tokenOf(0)], r)
      expect(r.calls).toHaveLength(2)
      expect(results[0]?.outcome).toBe('failed')
      expect(results[0]?.reason).toMatch(/server ended the upload/)
    })

    it('reads a 408 followed by a 404 the same way, going by the status and not the body', async () => {
      const r = rig((_c, n) => (n === 0 ? json(408, {}) : json(404, { error: 'something else' })))
      const results = await runUpload([fileOf(10)], [tokenOf(0)], r)
      expect(results[0]?.outcome).toBe('failed')
      expect(results[0]?.reason).toMatch(/server ended the upload/)
    })

    it('reads a chunk past the client deadline followed by a 404 the same way', async () => {
      vi.useFakeTimers()
      const r = rig((_c, n) => (n === 0 ? 'hang' : new Response('not found', { status: 404 })))
      const run = runUpload([fileOf(2 * MIB)], [tokenOf(0)], r)
      await vi.advanceTimersByTimeAsync(UPLOAD_CHUNK_TIMEOUT_MS + 1)
      const results = await run
      expect(r.calls).toHaveLength(2)
      expect(results[0]).toMatchObject({ outcome: 'failed' })
      expect(results[0]?.reason).toMatch(/server ended the upload/)
    })

    it('reads a proxy 502 followed by a 404 the same way', async () => {
      const r = rig((_c, n) => (n === 0 ? new Response('bad gateway', { status: 502 }) : new Response('nf', { status: 404 })))
      const results = await runUpload([fileOf(10)], [tokenOf(0)], r)
      expect(r.calls).toHaveLength(2)
      expect(results[0]?.reason).toMatch(/server ended the upload/)
    })

    it('says only that the upload ended for a 404 with nothing lost before it', async () => {
      const r = rig(() => new Response('not found', { status: 404 }))
      const results = await runUpload([fileOf(10)], [tokenOf(0)], r)
      expect(r.calls).toHaveLength(1)
      expect(results[0]).toMatchObject({ outcome: 'failed', reason: 'the upload was ended' })
    })

    it('forgets a loss once a chunk is acknowledged', async () => {
      const size = 3 * MIB
      const r = rig((c, n) => {
        if (n === 0) return new TypeError('Failed to fetch')
        if (n === 1) return honest(size)(c)
        return new Response('not found', { status: 404 })
      })
      const results = await runUpload([fileOf(size)], [tokenOf(0)], r)
      expect(results[0]?.reason).toBe('the upload was ended')
    })
  })

  it('aborts at once mid-chunk: the file in flight and every later one end cancelled', async () => {
    const ac = new AbortController()
    const r = rig(() => 'hang')
    const run = runUpload([fileOf(10), fileOf(10)], [tokenOf(0), tokenOf(1)], { ...r, signal: ac.signal })
    await Promise.resolve()
    ac.abort()
    const results = await run
    expect(r.calls).toHaveLength(1)
    expect(results.map((x) => x.outcome)).toEqual(['cancelled', 'cancelled'])
  })

  it('does not start when it is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = rig(() => json(200, {}))
    const results = await runUpload([fileOf(10)], [tokenOf(0)], { ...r, signal: ac.signal })
    expect(r.calls).toHaveLength(0)
    expect(results[0]?.outcome).toBe('cancelled')
  })

  it('stops waiting out a backoff on abort', async () => {
    const ac = new AbortController()
    const r = rig(() => new TypeError('Failed to fetch'))
    const results = await runUpload([fileOf(10)], [tokenOf(0)], {
      fetch: r.fetch,
      now: r.now,
      signal: ac.signal,
      sleep: async () => {
        ac.abort()
      }
    })
    expect(results[0]?.outcome).toBe('cancelled')
    expect(r.calls).toHaveLength(1)
  })

  it('stops the default backoff wait on abort without waiting it out', async () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    // A source whose probe read settles at once (no real Blob under fake timers).
    const src: UploadSource = { size: 10, slice: (s, e) => ({ size: e - s, arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Blob }
    const r = rig(() => new TypeError('Failed to fetch'))
    let settled = false
    const run = runUpload([src], [tokenOf(0)], { fetch: r.fetch, now: r.now, signal: ac.signal }).then((x) => {
      settled = true
      return x
    })
    await vi.advanceTimersByTimeAsync(10)
    expect(r.calls).toHaveLength(1)
    expect(settled).toBe(false)
    ac.abort()
    // Far less than the first backoff step: only an abort-aware wait has ended by now.
    await vi.advanceTimersByTimeAsync(10)
    expect(settled).toBe(true)
    expect((await run)[0]?.outcome).toBe('cancelled')
    expect(r.calls).toHaveLength(1)
  })

  it('ends a file cancelled, not failed, when the abort lands while an answer is read', async () => {
    const ac = new AbortController()
    // A 409 whose body errors as the abort tears it down: the parse fails, yet the person cancelled.
    const fetch: UploadFetch = async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          ac.abort()
          c.error(new DOMException('aborted', 'AbortError'))
        }
      })
      return new Response(body, { status: 409 })
    }
    const results = await runUpload([fileOf(10)], [tokenOf(0)], { fetch, signal: ac.signal })
    expect(results[0]?.outcome).toBe('cancelled')
  })

  it('ends a file cancelled when the cancel itself ends the token (a 404), and keeps a commit read whole', async () => {
    const ac = new AbortController()
    const ended = await runUpload([fileOf(10)], [tokenOf(0)], {
      fetch: async () => {
        ac.abort()
        return new Response('not found', { status: 404 })
      },
      signal: ac.signal
    })
    expect(ended[0]?.outcome).toBe('cancelled')

    const late = new AbortController()
    const done = await runUpload([fileOf(10), fileOf(10)], [tokenOf(0), tokenOf(1)], {
      fetch: async () => {
        late.abort()
        return committed()
      },
      signal: late.signal
    })
    // The first file is on the server; the abort ends only what comes after.
    expect(done.map((x) => x.outcome)).toEqual(['done', 'cancelled'])
  })

  it('reports acknowledged bytes over the whole run, with the file being sent', async () => {
    const seen: UploadProgress[] = []
    const sizes = [MIB + 5, 100]
    const r = rig((c) => honest(c.token === 'tok-0' ? sizes[0]! : sizes[1]!)(c), { chunkMs: 1 })
    await runUpload(sizes.map(fileOf), [tokenOf(0), tokenOf(1)], { ...r, onProgress: (p) => seen.push({ ...p }) })
    expect(seen).toEqual([
      { index: 0, sent: MIB },
      { index: 0, sent: MIB + 5 },
      { index: 1, sent: MIB + 105 }
    ])
  })

  it('counts a 409 jump forward in the progress', async () => {
    const seen: number[] = []
    const r = rig((c, n) => (n === 0 ? json(409, { expected: 2 * MIB }) : honest(3 * MIB)(c)))
    await runUpload([fileOf(3 * MIB)], [tokenOf(0)], { ...r, onProgress: (p) => seen.push(p.sent) })
    expect(seen[0]).toBe(2 * MIB)
  })

  it('sends files in the order of the tokens, one chunk at a time, and fails a file it was not given', async () => {
    let inFlight = 0
    let peak = 0
    const r = rig(committed)
    const fetch: UploadFetch = async (url, init) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      try {
        return await r.fetch(url, init)
      } finally {
        inFlight--
      }
    }
    const results = await runUpload([fileOf(1), fileOf(2)], [tokenOf(1), tokenOf(0), tokenOf(5)], { ...r, fetch })
    expect(r.calls.map((c) => c.token)).toEqual(['tok-1', 'tok-0'])
    expect(peak).toBe(1)
    expect(results[2]).toMatchObject({ index: 5, outcome: 'failed' })
  })

  it('puts the token in the URL path and the offset in the query, and the module never uses XHR', async () => {
    const urls: string[] = []
    const fetch: UploadFetch = async (url) => {
      urls.push(url)
      return committed()
    }
    await runUpload([fileOf(1)], [{ index: 0, token: 'a-b_c', name: 'n' }], { fetch })
    expect(urls).toEqual(['/u/a-b_c?offset=0'])
    const src = readFileSync(new URL('../../src/renderer/web/upload-client.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/new\s+XMLHttpRequest/)
  })
})
