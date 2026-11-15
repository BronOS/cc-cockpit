// downloads.ts offers (`ccc download`, design-download.md §2.2): every browser view of the window gets
// one payload, first answer wins, `hold` only in server mode, the desktop with no browser view refused,
// `ready`'s replay, the accept taken only from a remote view of the offer's window, a Try again only
// from the accepting device, and the per-window limits. Real trees in a temp dir, like downloads.test.ts.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Downloads, type DownloadsDeps, type DownloadView } from '../../src/main/files/downloads'
import {
  DOWNLOAD_OFFER_MS,
  DOWNLOAD_OFFERS_MAX,
  DOWNLOAD_OFFERS_WAITING_MAX,
  DOWNLOAD_OFFERS_WINDOW_MS,
  type DownloadFailed,
  type DownloadOffer,
  type DownloadStart,
} from '../../src/shared/downloads'
import { desktopViewId } from '../../src/shared/views'
import { windowSnapshot, type SnapshotSources } from '../../src/main/web/connection'

let tmp: string
let proj: string
let home: string
let outside: string
let clock: number
let offers: Array<{ windowId: number; offer: DownloadOffer }>
let settled: Array<{ windowId: number; requestId: string }>
let starts: Array<{ viewId: string; payload: DownloadStart }>
let failures: Array<{ viewId: string; payload: DownloadFailed }>
/** Whether a browser view is attached now: the offer's send and the desktop check both read it. */
let browsers: boolean

const WINDOW = 7
const CALLER = { projectId: 'p1', windowId: WINDOW }
const PHONE: DownloadView = { viewId: 'web:1', windowId: WINDOW, deviceId: 'dev-phone' }
const LAPTOP: DownloadView = { viewId: 'web:2', windowId: WINDOW, deviceId: 'dev-laptop' }

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-offers-')))
  proj = join(tmp, 'proj')
  home = join(tmp, 'home')
  outside = join(tmp, 'outside')
  for (const d of [proj, home, outside, join(tmp, 'data')]) mkdirSync(d)
  clock = 1_000_000
  offers = []
  settled = []
  starts = []
  failures = []
  browsers = true
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(tmp, { recursive: true, force: true })
})

function make(extra: Partial<DownloadsDeps> = {}): Downloads {
  return new Downloads({
    hooks: {
      start: (viewId, payload) => {
        starts.push({ viewId, payload })
        return true
      },
      failed: (viewId, payload) => failures.push({ viewId, payload }),
    },
    offers: {
      send: (windowId, offer) => {
        if (!browsers) return false
        offers.push({ windowId, offer })
        return true
      },
      settled: (windowId, requestId) => settled.push({ windowId, requestId }),
    },
    hasBrowserView: () => browsers,
    projectPath: (id) => (id === 'p1' ? proj : undefined),
    windowOf: (id) => (id === 'p1' ? WINDOW : undefined),
    dataDir: join(tmp, 'data'),
    env: { home, platform: 'linux' },
    now: () => clock,
    ...extra,
  })
}

function write(abs: string, data = 'hello'): string {
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, data)
  return abs
}

describe('offers: who gets one', () => {
  it('a desktop with no browser view refuses: the file is already on this computer', async () => {
    browsers = false
    const d = make()
    const file = write(join(proj, 'report.pdf'))
    await expect(d.offer(CALLER, file)).rejects.toThrow(`this project is on this computer: ${file}`)
    expect(offers).toEqual([])
    expect(d.offerCount).toBe(0)
  })

  it('a desktop with a browser view: one payload to the window, the CLI line, nothing held', async () => {
    const d = make()
    const file = write(join(proj, 'out', 'report.pdf'))
    const r = await d.offer(CALLER, file)
    expect(r.text).toBe('offered report.pdf (5 B) to the browser views of this project; the person decides')
    expect(r.waiting).toBe(false)
    expect(offers).toEqual([
      { windowId: WINDOW, offer: { requestId: r.requestId, path: file, name: 'report.pdf', outside: false, runnable: false, kind: 'file', size: 5 } },
    ])
    expect(d.pendingOffers(WINDOW)).toEqual([offers[0]!.offer])
    expect(d.pendingOffers(WINDOW + 1)).toEqual([])
  })

  it('hold only in server mode: with no browser attached the offer waits, and a view joining finds it in ready', async () => {
    browsers = false
    const d = make({ server: true })
    const file = write(join(proj, 'report.pdf'))
    const r = await d.offer(CALLER, file)
    expect(r.waiting).toBe(true)
    expect(r.text).toBe('offered report.pdf (5 B); no browser shows this project now; the offer waits 10 min')
    expect(offers).toEqual([])
    const [pending] = d.pendingOffers(WINDOW)
    expect(pending).toMatchObject({ requestId: r.requestId, path: file, kind: 'file' })
    // The phone wakes, gets it in `ready`, and accepts.
    expect(await d.accept(PHONE, r.requestId, false)).toBe(true)
    expect(starts.map((s) => [s.viewId, s.payload.requestId, s.payload.name])).toEqual([['web:1', r.requestId, 'report.pdf']])
    expect(settled).toEqual([{ windowId: WINDOW, requestId: r.requestId }])
  })

  it('ready replays the waiting offers to a joining view (windowSnapshot), the window\'s own only', async () => {
    browsers = false
    const d = make({ server: true })
    const r = await d.offer(CALLER, write(join(proj, 'report.pdf')))
    const sources = {
      tabs: { list: () => [] },
      layouts: { view: () => ({}) },
      overlays: { infos: () => [] },
      closeAsks: { pendingFor: () => [] },
      linkAsks: { pendingFor: () => [] },
      downloadOffers: d
    } as unknown as SnapshotSources
    expect(windowSnapshot(sources, { windowId: WINDOW, projectId: 'p1' }).downloadOffers).toEqual([
      expect.objectContaining({ requestId: r.requestId, name: 'report.pdf' })
    ])
    expect(windowSnapshot(sources, { windowId: WINDOW + 1, projectId: 'p1' }).downloadOffers).toEqual([])
    // Answered: gone from the replay.
    d.decline(WINDOW, r.requestId)
    expect(windowSnapshot(sources, { windowId: WINDOW, projectId: 'p1' }).downloadOffers).toEqual([])
  })

  it('on a desktop the last browser leaving between the check and the send is the desktop case (never held)', async () => {
    const d = make({ hasBrowserView: () => true })
    browsers = false // the send finds nobody
    const file = write(join(proj, 'report.pdf'))
    await expect(d.offer(CALLER, file)).rejects.toThrow('this project is on this computer')
    expect(d.pendingOffers(WINDOW)).toEqual([])
  })

  it('an offer runs out after DOWNLOAD_OFFER_MS: settled for every view, nothing left to accept', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const d = make({ server: true })
    const r = await d.offer(CALLER, write(join(proj, 'a.txt')))
    vi.advanceTimersByTime(DOWNLOAD_OFFER_MS - 1)
    expect(d.pendingOffers(WINDOW)).toHaveLength(1)
    vi.advanceTimersByTime(1)
    await Promise.resolve()
    expect(settled).toEqual([{ windowId: WINDOW, requestId: r.requestId }])
    expect(await d.accept(PHONE, r.requestId, false)).toBe(false)
    expect(starts).toEqual([])
  })
})

describe('offers: what the dialog is told', () => {
  it('an outside file is marked outside; a link names its real path; a refused outside path is exit 1', async () => {
    const d = make()
    const tmpFile = write(join(outside, 'notes.txt'))
    const a = await d.offer(CALLER, tmpFile)
    expect(offers.at(-1)!.offer).toMatchObject({ requestId: a.requestId, path: tmpFile, outside: true })
    expect(offers.at(-1)!.offer).not.toHaveProperty('real')

    symlinkSync(tmpFile, join(proj, 'link.txt'))
    const b = await d.offer(CALLER, join(proj, 'link.txt'))
    expect(offers.at(-1)!.offer).toMatchObject({ requestId: b.requestId, path: join(proj, 'link.txt'), real: tmpFile, outside: true, name: 'link.txt' })

    write(join(home, '.ssh', 'id_ed25519'))
    await expect(d.offer(CALLER, join(home, '.ssh', 'id_ed25519'))).rejects.toThrow(/protected place/)
    // A /tmp link to it is refused by its target.
    symlinkSync(join(home, '.ssh', 'id_ed25519'), join(outside, 'key'))
    await expect(d.offer(CALLER, join(outside, 'key'))).rejects.toThrow(/protected place/)
  })

  it('runnable by the name that is sent', async () => {
    const d = make()
    await d.offer(CALLER, write(join(proj, 'install.sh')))
    expect(offers.at(-1)!.offer).toMatchObject({ name: 'install.sh', runnable: true })
  })

  it('a folder: both totals, the plain skip counts, and the zip name', async () => {
    const d = make()
    write(join(proj, 'site', 'index.html'), '0123456789')
    write(join(proj, 'site', 'node_modules', 'x', 'big.js'), 'x'.repeat(100))
    symlinkSync('index.html', join(proj, 'site', 'alias.html'))
    const r = await d.offer(CALLER, join(proj, 'site'))
    expect(r.text).toBe('offered site.zip (1 file, 10 B before compression) to the browser views of this project; the person decides')
    const offer = offers.at(-1)!.offer
    expect(offer).toMatchObject({ kind: 'folder', name: 'site.zip', outside: false, runnable: false })
    if (offer.kind !== 'folder') throw new Error('not a folder offer')
    expect(offer.counts.plain).toEqual({ files: 1, folders: 1, bytes: 10 })
    expect(offer.counts.all).toEqual({ files: 2, folders: 3, bytes: 110 })
    expect(offer.skipped).toEqual({ excluded: 1, symlink: 1 })
    expect(offer).not.toHaveProperty('allTooLarge')
  })

  it('a folder whose include choice passes a cap says so; accepting with it fails to the view, without it works', async () => {
    const d = make({ maxBytes: 50 })
    write(join(proj, 'site', 'index.html'), '0123456789')
    write(join(proj, 'site', 'node_modules', 'x', 'big.js'), 'x'.repeat(100))
    const r = await d.offer(CALLER, join(proj, 'site'))
    expect(offers.at(-1)!.offer).toMatchObject({ kind: 'folder', allTooLarge: true })
    expect(await d.accept(PHONE, r.requestId, true)).toBe(false)
    expect(failures).toEqual([{ viewId: 'web:1', payload: { requestId: r.requestId, reason: expect.stringMatching(/with .git and node_modules is too large/) } }])
    // The Try again without the include choice, from the same device.
    expect(await d.accept(PHONE, r.requestId, false)).toBe(true)
    expect(starts).toHaveLength(1)
  })

  it('a plain folder over a cap is exit 1 with the limit', async () => {
    const d = make({ maxBytes: 5 })
    write(join(proj, 'site', 'index.html'), '0123456789')
    await expect(d.offer(CALLER, join(proj, 'site'))).rejects.toThrow(/is too large to download/)
    expect(offers).toEqual([])
  })
})

describe('offers: answers', () => {
  it('the first accept settles it for every view and starts in the accepting view only', async () => {
    const d = make()
    const r = await d.offer(CALLER, write(join(proj, 'a.txt')))
    expect(await d.accept(PHONE, r.requestId, false)).toBe(true)
    expect(settled).toEqual([{ windowId: WINDOW, requestId: r.requestId }])
    expect(starts.map((s) => s.viewId)).toEqual(['web:1'])
    expect(d.pendingOffers(WINDOW)).toEqual([])
    // The laptop's late Download finds an accepted offer of another device: refused, nothing started.
    expect(await d.accept(LAPTOP, r.requestId, false)).toBe(false)
    expect(d.decline(WINDOW, r.requestId)).toBe(false)
    expect(starts).toHaveLength(1)
  })

  it('an accept from another window’s view, the desktop page or the hidden page is refused', async () => {
    const d = make()
    const r = await d.offer(CALLER, write(join(proj, 'a.txt')))
    expect(await d.accept({ ...PHONE, windowId: WINDOW + 1 }, r.requestId, false)).toBe(false)
    expect(await d.accept({ viewId: desktopViewId(WINDOW), windowId: WINDOW, deviceId: 'none' }, r.requestId, false)).toBe(false)
    expect(await d.accept(PHONE, 'offer-999', false)).toBe(false)
    expect(starts).toEqual([])
    // Still waiting for a real answer.
    expect(d.pendingOffers(WINDOW)).toHaveLength(1)
    expect(settled).toEqual([])
  })

  it('Cancel in any view declines it for all; nothing downloads and a later accept is refused', async () => {
    const d = make()
    const r = await d.offer(CALLER, write(join(proj, 'a.txt')))
    expect(d.decline(WINDOW + 1, r.requestId)).toBe(false)
    expect(d.decline(WINDOW, r.requestId)).toBe(true)
    expect(settled).toEqual([{ windowId: WINDOW, requestId: r.requestId }])
    await Promise.resolve()
    expect(await d.accept(PHONE, r.requestId, false)).toBe(false)
    expect(starts).toEqual([])
    expect(d.offerCount).toBe(0)
  })

  it('a failed start tells the accepting view; Try again works from that device only, within the offer’s life', async () => {
    const d = make()
    const file = write(join(proj, 'a.txt'))
    const r = await d.offer(CALLER, file)
    rmSync(file)
    expect(await d.accept(PHONE, r.requestId, false)).toBe(false)
    expect(failures).toEqual([{ viewId: 'web:1', payload: { requestId: r.requestId, reason: expect.stringMatching(/no such file/) } }])
    write(file)
    // Another device cannot take the accepted offer over.
    expect(await d.accept(LAPTOP, r.requestId, false)).toBe(false)
    // The accepting device can, from another of its views too (a reconnect mints a new view id).
    expect(await d.accept({ ...PHONE, viewId: 'web:9' }, r.requestId, false)).toBe(true)
    expect(starts.map((s) => [s.viewId, s.payload.requestId])).toEqual([['web:9', r.requestId]])
    expect(await d.accept(PHONE, r.requestId, false)).toBe(true)
    clock += DOWNLOAD_OFFER_MS
    expect(await d.accept(PHONE, r.requestId, false)).toBe(false)
    expect(d.offerCount).toBe(0)
  })

  it('a closed window ends its offers, waiting and accepted', async () => {
    const d = make()
    const a = await d.offer(CALLER, write(join(proj, 'a.txt')))
    const b = await d.offer(CALLER, write(join(proj, 'b.txt')))
    await d.accept(PHONE, a.requestId, false)
    d.windowClosed(WINDOW)
    expect(settled.map((s) => s.requestId)).toEqual([a.requestId, b.requestId])
    expect(d.pendingOffers(WINDOW)).toEqual([])
    expect(await d.accept(PHONE, a.requestId, false)).toBe(false)
    expect(d.offerCount).toBe(0)
  })
})

describe('offers: limits per window', () => {
  it(`${DOWNLOAD_OFFERS_WAITING_MAX} waiting at once; an answer frees a place`, async () => {
    const d = make()
    const ids: string[] = []
    for (let i = 0; i < DOWNLOAD_OFFERS_WAITING_MAX; i++) ids.push((await d.offer(CALLER, write(join(proj, `f${i}.txt`)))).requestId)
    await expect(d.offer(CALLER, write(join(proj, 'more.txt')))).rejects.toThrow(/already waiting/)
    d.decline(WINDOW, ids[0]!)
    await expect(d.offer(CALLER, join(proj, 'more.txt'))).resolves.toMatchObject({ waiting: false })
  })

  it(`${DOWNLOAD_OFFERS_MAX} per ${DOWNLOAD_OFFERS_WINDOW_MS / 60_000} minutes, counted per window`, async () => {
    const d = make()
    const file = write(join(proj, 'a.txt'))
    for (let i = 0; i < DOWNLOAD_OFFERS_MAX; i++) {
      const r = await d.offer(CALLER, file)
      d.decline(WINDOW, r.requestId)
    }
    await expect(d.offer(CALLER, file)).rejects.toThrow(/in the last 10 minutes/)
    // A refused path does not count: the limit is on offers made.
    clock += DOWNLOAD_OFFERS_WINDOW_MS
    await expect(d.offer(CALLER, join(proj, 'missing.txt'))).rejects.toThrow(/no such file/)
    await expect(d.offer(CALLER, file)).resolves.toMatchObject({ waiting: false })
  })

  it('parallel calls count in flight: only the free places pass', async () => {
    const d = make()
    const file = write(join(proj, 'a.txt'))
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => d.offer(CALLER, file)))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(DOWNLOAD_OFFERS_WAITING_MAX)
    expect(offers).toHaveLength(DOWNLOAD_OFFERS_WAITING_MAX)
  })

  it('a caller that went away during the walk gets no offer', async () => {
    const d = make()
    const ac = new AbortController()
    const p = d.offer(CALLER, write(join(proj, 'a.txt')), ac.signal)
    ac.abort()
    await expect(p).rejects.toThrow(/went away/)
    expect(offers).toHaveLength(0)
  })

  it('a window gone during the awaits gets no offer', async () => {
    let open = true
    const d = make({ windowOf: (id) => (id === 'p1' && open ? WINDOW : undefined) })
    const p = d.offer(CALLER, write(join(proj, 'a.txt')))
    open = false
    await expect(p).rejects.toThrow(/gone/)
    expect(offers).toHaveLength(0)
  })

  it('a throwing send is not reported as the desktop case', async () => {
    const d = make({
      offers: {
        send: () => {
          throw new Error('boom')
        },
        settled: () => undefined,
      },
    })
    await expect(d.offer(CALLER, write(join(proj, 'a.txt')))).rejects.toThrow('could not be sent')
  })

  it('no offer hooks: refused', async () => {
    const d = make({ offers: undefined })
    await expect(d.offer(CALLER, write(join(proj, 'a.txt')))).rejects.toThrow('downloads are not available')
  })
})
