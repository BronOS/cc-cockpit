import { describe, expect, it, vi } from 'vitest'
import {
  createReleaseFetcher,
  LATEST_RELEASE_API,
  parseLatestRelease,
  releaseUrl,
  UpdateChecker,
  versionOfTag,
  type AvailableUpdate
} from '../../src/main/updates/update-check'

const release = (tag: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify({ tag_name: tag, ...extra })

function setup(
  opts: {
    current?: string
    body?: string | Error
    enabled?: boolean
    dismissed?: string
  } = {}
) {
  const state = {
    enabled: opts.enabled ?? true,
    dismissed: opts.dismissed,
    body: opts.body ?? release('v1.1.0')
  }
  const changes: Array<AvailableUpdate | undefined> = []
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const fetchRelease = vi.fn(async () => {
    if (state.body instanceof Error) throw state.body
    return state.body
  })
  const checker = new UpdateChecker({
    current: opts.current ?? '1.0.0',
    fetchRelease,
    enabled: () => state.enabled,
    dismissed: () => state.dismissed,
    setDismissed: (v) => {
      state.dismissed = v
    },
    onChange: (u) => changes.push(u),
    now: () => 42,
    setInterval: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return t
    },
    clearInterval: (h) => {
      ;(h as { cleared: boolean }).cleared = true
    }
  })
  return { state, checker, fetchRelease, changes, timers }
}

describe('versionOfTag', () => {
  it('accepts only stable vX.Y.Z', () => {
    expect(versionOfTag('v1.2.3')).toBe('1.2.3')
    expect(versionOfTag('v0.10.0')).toBe('0.10.0')
  })
  it.each([
    'v1.2.3-rc.1',
    '1.2.3',
    'v1.2',
    'v1.2.3.4',
    'v01.2.3',
    'v1.2.3\n',
    ' v1.2.3',
    'v1.2.3/../x',
    'v1.2.3?x=1',
    '<script>',
    '',
    'v' + '9'.repeat(30) + '.0.0',
    42,
    null,
    undefined,
    {},
    ['v1.2.3']
  ])('refuses %j', (tag) => {
    expect(versionOfTag(tag)).toBeUndefined()
  })
})

describe('parseLatestRelease', () => {
  it('reads tag_name and ignores html_url and body', () => {
    expect(
      parseLatestRelease(
        release('v2.0.0', {
          html_url: 'https://evil.example/x',
          body: 'run this'
        })
      )
    ).toBe('2.0.0')
  })
  it('refuses invalid JSON and non-objects', () => {
    expect(parseLatestRelease('{nope')).toBeUndefined()
    expect(parseLatestRelease('[]')).toBeUndefined()
    expect(parseLatestRelease('null')).toBeUndefined()
    expect(parseLatestRelease('{}')).toBeUndefined()
  })
  it('builds the link from the fixed base only', () => {
    expect(releaseUrl('2.0.0')).toBe('https://github.com/BronOS/cc-cockpit/releases/tag/v2.0.0')
  })
})

describe('UpdateChecker.available', () => {
  it('shows a newer version, with a link built here', async () => {
    const t = setup({
      body: release('v1.1.0', { html_url: 'https://evil.example/' })
    })
    await t.checker.check()
    expect(t.checker.available()).toEqual({
      version: '1.1.0',
      url: 'https://github.com/BronOS/cc-cockpit/releases/tag/v1.1.0'
    })
    expect(t.changes).toHaveLength(1)
  })
  it('shows nothing for the same or an older version', async () => {
    for (const tag of ['v1.0.0', 'v0.9.9']) {
      const t = setup({ body: release(tag) })
      await t.checker.check()
      expect(t.checker.available()).toBeUndefined()
      expect(t.changes).toHaveLength(0)
    }
  })
  it('a dismissed version stays hidden, a newer one shows again', async () => {
    const t = setup()
    await t.checker.check()
    t.checker.dismiss()
    expect(t.state.dismissed).toBe('1.1.0')
    expect(t.checker.available()).toBeUndefined()
    await t.checker.check()
    expect(t.checker.available()).toBeUndefined()
    t.state.body = release('v1.2.0')
    await t.checker.check()
    expect(t.checker.available()?.version).toBe('1.2.0')
  })
  it('ignores a damaged updateDismissed value', async () => {
    const t = setup({ dismissed: 'garbage' })
    await t.checker.check()
    expect(t.checker.available()?.version).toBe('1.1.0')
  })
})

describe('UpdateChecker failures', () => {
  it.each([
    ['a network error', new Error('ECONNREFUSED')],
    ['invalid JSON', '{nope'],
    ['a hostile tag', release('v1.2.3; rm -rf /')],
    ['a prerelease tag', release('v9.0.0-beta.1')],
    ['a non-string tag', release({ a: 1 })]
  ])('is silent on %s', async (_name, body) => {
    const t = setup({ body })
    await expect(t.checker.check()).resolves.toBeUndefined()
    expect(t.checker.available()).toBeUndefined()
    expect(t.changes).toHaveLength(0)
  })
})

describe('UpdateChecker setting and timer', () => {
  it('makes no request while the setting is off', async () => {
    const t = setup({ enabled: false })
    t.checker.start()
    await t.checker.check()
    t.timers[0]!.fn()
    expect(t.fetchRelease).not.toHaveBeenCalled()
  })
  it('checks at start and every 24 hours, and stop clears the timer', async () => {
    const t = setup()
    t.checker.start()
    await vi.waitFor(() => expect(t.fetchRelease).toHaveBeenCalledTimes(1))
    expect(t.timers).toHaveLength(1)
    expect(t.timers[0]!.ms).toBe(24 * 60 * 60 * 1000)
    t.timers[0]!.fn()
    await vi.waitFor(() => expect(t.fetchRelease).toHaveBeenCalledTimes(2))
    t.checker.stop()
    expect(t.timers[0]!.cleared).toBe(true)
    expect(t.checker.lastCheckedAt).toBe(42)
  })
  it('turning the setting off clears the notice and stops the timer; on checks again', async () => {
    const t = setup()
    t.checker.start()
    await vi.waitFor(() => expect(t.checker.available()).toBeDefined())
    t.state.enabled = false
    t.checker.settingChanged()
    expect(t.checker.available()).toBeUndefined()
    expect(t.timers[0]!.cleared).toBe(true)
    t.state.enabled = true
    t.checker.settingChanged()
    await vi.waitFor(() => expect(t.checker.available()).toBeDefined())
    expect(t.fetchRelease).toHaveBeenCalledTimes(2)
  })
  it('does not announce a reply that arrives after the setting went off', async () => {
    const t = setup()
    let release!: (s: string) => void
    t.fetchRelease.mockImplementationOnce(() => new Promise<string>((r) => (release = r)))
    const p = t.checker.check()
    t.state.enabled = false
    release(JSON.stringify({ tag_name: 'v3.0.0' }))
    await p
    expect(t.checker.available()).toBeUndefined()
  })
  it('off then on while a request is out still checks, and the old reply is dropped', async () => {
    const t = setup({ body: release('v2.0.0') })
    let stale!: (s: string) => void
    t.fetchRelease.mockImplementationOnce(() => new Promise<string>((r) => (stale = r)))
    t.checker.start()
    await vi.waitFor(() => expect(t.fetchRelease).toHaveBeenCalledTimes(1))
    t.state.enabled = false
    t.checker.settingChanged()
    t.state.enabled = true
    t.checker.settingChanged()
    await vi.waitFor(() => expect(t.checker.available()?.version).toBe('2.0.0'))
    expect(t.fetchRelease).toHaveBeenCalledTimes(2)
    stale(release('v3.0.0'))
    await new Promise((r) => setTimeout(r, 0))
    expect(t.checker.available()?.version).toBe('2.0.0')
  })
})

describe('createReleaseFetcher', () => {
  const fetcherOf = (res: Response | Error, maxBytes?: number) => {
    const fetchFn = vi.fn(async () => {
      if (res instanceof Error) throw res
      return res
    })
    return {
      fetchFn,
      fetcher: createReleaseFetcher({
        fetch: fetchFn as unknown as typeof fetch,
        maxBytes
      })
    }
  }

  it('asks the fixed URL with no redirects and no credentials', async () => {
    const { fetchFn, fetcher } = fetcherOf(new Response('{"tag_name":"v1.0.1"}'))
    await expect(fetcher()).resolves.toBe('{"tag_name":"v1.0.1"}')
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(LATEST_RELEASE_API)
    expect(init.redirect).toBe('error')
    expect(init.credentials).toBe('omit')
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i)
  })
  it('fails on 404', async () => {
    await expect(fetcherOf(new Response('nf', { status: 404 })).fetcher()).rejects.toThrow('HTTP 404')
  })
  it('fails on a network error and on a refused redirect', async () => {
    await expect(fetcherOf(new Error('down')).fetcher()).rejects.toThrow('down')
    await expect(fetcherOf(new TypeError('redirect mode is set to error')).fetcher()).rejects.toThrow()
  })
  it('fails on an oversized body', async () => {
    await expect(fetcherOf(new Response('x'.repeat(100)), 10).fetcher()).rejects.toThrow()
    const stream = new Response(
      new ReadableStream({
        start: (c) => {
          c.enqueue(new Uint8Array(50))
          c.enqueue(new Uint8Array(50))
          c.close()
        }
      })
    )
    await expect(fetcherOf(stream, 60).fetcher()).rejects.toThrow()
  })
})
