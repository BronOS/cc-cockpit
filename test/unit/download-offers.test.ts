// downloads.ts offers (`ccc download`, design-download.md §2.2): every browser view of the window gets
// one payload, first answer wins, `hold` only in server mode, the desktop with no browser view refused,
// `ready`'s replay, the accept taken only from a remote view of the offer's window, a Try again only
// from the accepting device, and the per-window limits. Real trees in a temp dir, like downloads.test.ts.
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, type Stats } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOWNLOAD_GUEST_TEXT, Downloads, type DownloadsDeps, type DownloadView } from '../../src/main/files/downloads'
import {
  DOWNLOAD_OFFER_MS,
  DOWNLOAD_OFFERS_MAX,
  DOWNLOAD_OFFERS_WAITING_MAX,
  DOWNLOAD_OFFERS_WINDOW_MS,
  type DownloadFailed,
  type DownloadOffer,
  type DownloadStart,
} from '../../src/shared/downloads'
import type { GuestAccess } from '../../src/shared/guests'
import { desktopViewId } from '../../src/shared/views'
import { windowSnapshot, type SnapshotSources } from '../../src/main/web/connection'
import { openVerified } from '../../src/main/verified-read'

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

/** Never settles: an fs call on a dead network mount. */
const HUNG = new Promise<never>(() => {})

/**
 * Each await of an offer's checks that a dead mount can stall (resolve's data dir realpath, the file
 * probe's open, the folder count's lstat and readdir), hung for paths under `stalled/` (or while
 * `hangDataDir`), real for the rest.
 */
function stallingDeps(stall: 'realpath' | 'open' | 'lstat' | 'readdir', hangDataDir: { on: boolean }): Partial<DownloadsDeps> {
  const hit = (p: string): boolean => p.includes('/stalled')
  return {
    realpath: (p) => (stall === 'realpath' && hangDataDir.on ? HUNG : realpath(p)),
    probeOpen: (p, expect) => (stall === 'open' && hit(p) ? HUNG : openVerified(p, expect)),
    walkFs: {
      lstat: (p: string): Promise<Stats> => (stall === 'lstat' && hit(p) ? HUNG : lstat(p)),
      readdir: (p: string): Promise<Buffer[]> => (stall === 'readdir' && hit(p) ? HUNG : Promise.resolve(readdirSync(p, { encoding: 'buffer' }))),
    },
  }
}

/** `p` settled within 2 s, or 'still held'. */
function settledSoon<T>(p: Promise<T>): Promise<PromiseSettledResult<T> | 'still held'> {
  return Promise.race([
    p.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    ),
    new Promise<'still held'>((r) => setTimeout(() => r('still held'), 2000)),
  ])
}

describe('offers: a stalled check never holds a place', () => {
  // The stalled target per stall: a file for the realpath (resolve) and the open (the probe), a folder
  // for the count's lstat and readdir.
  for (const stall of ['realpath', 'open', 'lstat', 'readdir'] as const) {
    for (const how of ['the callers leave', 'the window closes'] as const) {
      it(`a ${stall} stalled in ${DOWNLOAD_OFFERS_WAITING_MAX} offers: ${how}, their places free at once, a healthy offer works`, async () => {
        const hangDataDir = { on: true }
        const d = make({ ...stallingDeps(stall, hangDataDir), walkTimeoutMs: 60_000 })
        const target = stall === 'lstat' || stall === 'readdir' ? join(proj, 'stalled') : write(join(proj, 'stalled', 'a.txt'))
        mkdirSync(join(proj, 'stalled'), { recursive: true })
        write(join(proj, 'stalled', 'b.txt'))
        const callers = Array.from({ length: DOWNLOAD_OFFERS_WAITING_MAX }, () => new AbortController())
        const stuck = callers.map((ac) => d.offer(CALLER, target, ac.signal))
        // All places are held: one more is refused before any fs call.
        await expect(d.offer(CALLER, write(join(proj, 'ok.txt')))).rejects.toThrow(/already waiting/)
        if (how === 'the callers leave') for (const ac of callers) ac.abort()
        else d.windowClosed(WINDOW)
        for (const p of stuck) {
          const r = await settledSoon(p)
          expect(r).toMatchObject({ status: 'rejected' })
          expect(String((r as PromiseRejectedResult).reason)).toMatch(how === 'the callers leave' ? /went away/ : /window is gone/)
        }
        hangDataDir.on = false
        await expect(d.offer(CALLER, join(proj, 'ok.txt'))).resolves.toMatchObject({ waiting: false })
        expect(offers.map((o) => o.offer.name)).toEqual(['ok.txt'])
      })
    }
  }

  it('the folder count\'s budget frees the place of a walk stalled with its caller still there', async () => {
    const d = make({ ...stallingDeps('lstat', { on: false }), walkTimeoutMs: 50 })
    mkdirSync(join(proj, 'stalled'))
    const stuck = Array.from({ length: DOWNLOAD_OFFERS_WAITING_MAX }, () => d.offer(CALLER, join(proj, 'stalled'), new AbortController().signal))
    // All at once: awaited one by one, the later ones can reject before anything listens (an
    // unhandled rejection on the slower macOS runner).
    await Promise.all(stuck.map((p) => expect(p).rejects.toThrow('stalled has too many files to count')))
    await expect(d.offer(CALLER, write(join(proj, 'ok.txt')))).resolves.toMatchObject({ waiting: false })
  })

  it('a stalled check that finishes after its caller left makes no offer', async () => {
    let release: ((v: string) => void) | undefined
    const d = make({ realpath: (p) => (release ? realpath(p) : new Promise<string>((r) => (release = r)).then(() => realpath(p))) })
    const ac = new AbortController()
    const p = d.offer(CALLER, write(join(proj, 'a.txt')), ac.signal)
    await vi.waitFor(() => expect(release).toBeDefined())
    ac.abort()
    await expect(p).rejects.toThrow(/went away/)
    release?.('')
    await new Promise((r) => setTimeout(r, 50))
    expect(offers).toEqual([])
    expect(d.offerCount).toBe(0)
  })

  it('a start (ctx.files.download, an accept) stalled in its checks ends when the window closes, with no token', async () => {
    const hangDataDir = { on: true }
    const d = make(stallingDeps('realpath', hangDataDir))
    write(join(proj, 'a.txt'))
    const p = d.start(PHONE, { projectId: 'p1', rel: 'a.txt' }, false)
    d.windowClosed(WINDOW)
    const r = await settledSoon(p)
    expect(r).toMatchObject({ status: 'rejected' })
    expect(String((r as PromiseRejectedResult).reason)).toMatch(/window is gone/)
    expect(starts).toEqual([])
  })
})

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
    // The start went through: a second click (another tab of the same browser) is no Try again.
    expect(await d.accept(PHONE, r.requestId, false)).toBe(false)
    expect(starts).toHaveLength(1)
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

// D-23 (design-guests §9): only a write guest's view is minted a link, and a guest sees and takes a
// `ccc download` offer only when it sees the tab the command ran in (main's own `CliCall.tabId`).
describe('offers: guests (D-23)', () => {
  /** PHONE (web:1) is a guest's view, LAPTOP (web:2) the owner's; the guest sees the tabs in `seen`. */
  function guests(access: GuestAccess, seen: string[] = []) {
    const asked: string[] = []
    return {
      asked,
      deps: {
        guests: {
          whoAccess: (viewId: string): GuestAccess => (viewId === LAPTOP.viewId ? { kind: 'owner' } : access),
          tabVisible: (guestId: string, tabId: string) => (asked.push(`${guestId} ${tabId}`), seen.includes(tabId))
        }
      } satisfies Partial<DownloadsDeps>
    }
  }
  const writeGuest = { kind: 'guest', id: 'g1', name: 'Bob', role: 'write', projectId: 'p1', scope: ['t1'] } as const
  const readGuest = { ...writeGuest, role: 'read' } as const

  it("start refuses a read guest's view and a gone guest's, live; a write guest and the owner get a link", async () => {
    const file = write(join(proj, 'a.txt'))
    const target = { projectId: 'p1', abs: file }
    await expect(make(guests(readGuest).deps).start(PHONE, target, false)).rejects.toThrow(DOWNLOAD_GUEST_TEXT)
    await expect(make(guests({ kind: 'revoked' }).deps).start(PHONE, target, false)).rejects.toThrow(DOWNLOAD_GUEST_TEXT)
    expect(starts).toEqual([])
    await expect(make(guests(writeGuest).deps).start(PHONE, target, false)).resolves.toMatchObject({ name: 'a.txt', kind: 'file' })
    await expect(make(guests(readGuest).deps).start(LAPTOP, target, false)).resolves.toMatchObject({ name: 'a.txt' })
    expect(starts.map((s) => s.viewId)).toEqual(['web:1', 'web:2'])
  })

  it("an offer keeps the caller's tab for originOf; a call with no tab has none", async () => {
    const d = make()
    const withTab = await d.offer({ ...CALLER, tabId: 't1' }, write(join(proj, 'a.txt')))
    const without = await d.offer(CALLER, write(join(proj, 'b.txt')))
    expect(d.originOf(withTab.requestId)).toBe('t1')
    expect(d.originOf(without.requestId)).toBeUndefined()
    expect(d.originOf('offer-999')).toBeUndefined()
    // The origin is main's own: never in the payload the views get.
    expect(JSON.stringify(offers)).not.toContain('t1')
  })

  it("a guest's accept of an offer from a tab it cannot see is refused and settles nothing for the owner", async () => {
    const g = guests(writeGuest, [])
    const d = make(g.deps)
    const r = await d.offer({ ...CALLER, tabId: 't9' }, write(join(proj, 'a.txt')))
    expect(await d.accept(PHONE, r.requestId, false)).toBe(false)
    expect(g.asked).toEqual(['g1 t9'])
    expect(settled).toEqual([])
    expect(starts).toEqual([])
    expect(d.pendingOffers(WINDOW)).toHaveLength(1)
    // The owner's view still takes it.
    expect(await d.accept(LAPTOP, r.requestId, false)).toBe(true)
    expect(starts.map((s) => s.viewId)).toEqual(['web:2'])
  })

  it("an offer with no origin tab is never a guest's, whatever it sees", async () => {
    const d = make(guests(writeGuest, ['t1']).deps)
    const r = await d.offer(CALLER, write(join(proj, 'a.txt')))
    expect(await d.accept(PHONE, r.requestId, false)).toBe(false)
    expect(settled).toEqual([])
    expect(d.pendingOffers(WINDOW)).toHaveLength(1)
  })

  it("a revoked guest's accept is refused before the answer", async () => {
    const d = make(guests({ kind: 'revoked' }, ['t1']).deps)
    const r = await d.offer({ ...CALLER, tabId: 't1' }, write(join(proj, 'a.txt')))
    expect(await d.accept(PHONE, r.requestId, false)).toBe(false)
    expect(settled).toEqual([])
  })

  it('a write guest who sees the origin tab takes it: settled for every view, started in its view', async () => {
    const d = make(guests(writeGuest, ['t1']).deps)
    const r = await d.offer({ ...CALLER, tabId: 't1' }, write(join(proj, 'a.txt')))
    expect(await d.accept(PHONE, r.requestId, false)).toBe(true)
    expect(settled).toEqual([{ windowId: WINDOW, requestId: r.requestId }])
    expect(starts.map((s) => s.viewId)).toEqual(['web:1'])
  })
})
