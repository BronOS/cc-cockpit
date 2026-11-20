// HungNavigationWatch (hung-navigation.ts): the hung-page watchdog's policy, on a fake clock. Kills
// only a navigation main started that has not ended while the page answers no probe, the pid it read
// when the navigation started, once; retries after the renderer is gone; and never kills a page that
// answers, a navigation that ended or was superseded, one with no renderer, or after dispose.
import { describe, expect, it } from 'vitest'
import {
  COMMIT_WAIT_MS,
  GONE_WAIT_MS,
  HungNavigationWatch,
  PROBE_WAIT_MS,
  WATCH_MAX_MS,
  type ProbeAnswer,
  type WatchedNavigation
} from '../../src/main/webview/hung-navigation'

/** A fake clock and the watch's deps, recording what it did. */
function harness(opts: { pid?: number; kill?: boolean } = {}) {
  let now = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  let nextTimer = 1
  const did: string[] = []
  /** What the next probes answer, in order; empty: never (a page that spins). */
  const answers: Array<ProbeAnswer | 'reject'> = []
  let pid = opts.pid ?? 4242
  const retries: Array<{ nav: WatchedNavigation; settle: (ok: boolean) => void }> = []
  const watch = new HungNavigationWatch({
    setTimer: (run, ms) => {
      const id = nextTimer++
      timers.set(id, { at: now + ms, run })
      return id
    },
    clearTimer: (id) => void timers.delete(id as number),
    now: () => now,
    pid: () => pid,
    probe: () => {
      did.push('probe')
      const a = answers.shift()
      if (a === undefined) return new Promise<ProbeAnswer>(() => {})
      return a === 'reject' ? Promise.reject(new Error('Render frame was disposed')) : Promise.resolve(a)
    },
    kill: (p) => {
      did.push(`kill ${p}`)
      return opts.kill ?? true
    },
    retry: (nav) => {
      did.push(`retry ${nav.kind}${nav.kind === 'load' ? ` ${nav.url}` : ''}`)
      return new Promise<void>((resolve, reject) => retries.push({ nav, settle: (ok) => (ok ? resolve() : reject(new Error('failed'))) }))
    },
    restarted: (nav) => void did.push(`notice ${nav.kind}`),
    log: () => {}
  })
  /** Move the clock on, running each timer due (and the promise reactions after each). */
  const advance = async (ms: number): Promise<void> => {
    const end = now + ms
    for (;;) {
      await Promise.resolve()
      await Promise.resolve()
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      now = due[1].at
      timers.delete(due[0])
      due[1].run()
    }
    now = end
    await Promise.resolve()
    await Promise.resolve()
  }
  return {
    watch,
    did,
    answers,
    retries,
    advance,
    timers,
    setPid: (p: number) => (pid = p)
  }
}

const HANG = COMMIT_WAIT_MS + PROBE_WAIT_MS

describe('HungNavigationWatch', () => {
  it('kills a stalled reload whose page answers no probe, then retries it once the renderer is gone', async () => {
    const h = harness()
    const handle = h.watch.start({ kind: 'reload' })
    await h.advance(COMMIT_WAIT_MS - 1)
    expect(h.did).toEqual([])
    await h.advance(1)
    expect(h.did).toEqual(['probe'])
    await h.advance(PROBE_WAIT_MS)
    expect(h.did).toEqual(['probe', 'kill 4242'])
    expect(handle.killed()).toBe(true)
    // Not retried before the renderer is gone: a navigation sent to a dying process never commits.
    await h.advance(1000)
    expect(h.did).toEqual(['probe', 'kill 4242'])
    expect(h.watch.gone()).toBe(true)
    // The notice at once; the retry a turn later, after the input router's reset.
    expect(h.did).toEqual(['probe', 'kill 4242', 'notice reload'])
    await h.advance(0)
    expect(h.did).toEqual(['probe', 'kill 4242', 'notice reload', 'retry reload'])
    const outcome = await handle.outcome()
    expect(outcome?.retry).toBeInstanceOf(Promise)
    // The retry is not watched: nothing more, however long it takes.
    await h.advance(WATCH_MAX_MS)
    expect(h.did).toEqual(['probe', 'kill 4242', 'notice reload', 'retry reload'])
    expect(h.timers.size).toBe(0)
  })

  it('a load hands its caller the retry, which settles as the new load does', async () => {
    const h = harness()
    const handle = h.watch.start({ kind: 'load', url: 'https://b.test/' })
    await h.advance(HANG)
    h.watch.gone()
    await h.advance(0)
    const retry = (await handle.outcome())?.retry
    expect(h.did.at(-1)).toBe('retry load https://b.test/')
    let settled = false
    void retry?.then(() => (settled = true))
    h.retries[0]?.settle(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(true)
  })

  it('never kills a page that answers, however long its navigation takes (a slow server, a 204)', async () => {
    const h = harness()
    for (let i = 0; i < 40; i++) h.answers.push('answered')
    const handle = h.watch.start({ kind: 'load', url: 'https://slow.test/' })
    await h.advance(WATCH_MAX_MS + COMMIT_WAIT_MS * 2)
    expect(h.did.filter((d) => d.startsWith('kill'))).toEqual([])
    expect(h.did.filter((d) => d === 'probe').length).toBeGreaterThan(5)
    // Watched no longer past WATCH_MAX_MS: nothing left running.
    expect(h.timers.size).toBe(0)
    expect(handle.killed()).toBe(false)
    expect(await handle.outcome()).toBeUndefined()
  })

  it('a probe that rejects is no answer yet: it goes again, and kills only on silence', async () => {
    const h = harness()
    h.answers.push('reject', 'unsure')
    h.watch.start({ kind: 'reload' })
    await h.advance(COMMIT_WAIT_MS)
    await h.advance(COMMIT_WAIT_MS)
    expect(h.did).toEqual(['probe', 'probe'])
    await h.advance(HANG)
    expect(h.did).toEqual(['probe', 'probe', 'probe', 'kill 4242'])
  })

  it('a probe that says no-answer kills at once (a full input queue)', async () => {
    const h = harness()
    h.answers.push('no-answer')
    h.watch.start({ kind: 'reload' })
    await h.advance(COMMIT_WAIT_MS)
    expect(h.did).toEqual(['probe', 'kill 4242'])
  })

  it('a renderer replaced meanwhile is never killed (the probe heard a reset)', async () => {
    const h = harness()
    h.answers.push('replaced')
    h.watch.start({ kind: 'reload' })
    await h.advance(WATCH_MAX_MS)
    expect(h.did).toEqual(['probe'])
    expect(h.timers.size).toBe(0)
  })

  it('a navigation that ended (commit or failure) is not watched any more', async () => {
    const h = harness()
    h.watch.start({ kind: 'back' })
    await h.advance(COMMIT_WAIT_MS - 1)
    h.watch.ended()
    await h.advance(WATCH_MAX_MS)
    expect(h.did).toEqual([])
    expect(h.timers.size).toBe(0)
  })

  it('ending while the probe is out kills nothing when the probe then times out', async () => {
    const h = harness()
    h.watch.start({ kind: 'reload' })
    await h.advance(COMMIT_WAIT_MS)
    expect(h.did).toEqual(['probe'])
    h.watch.ended()
    await h.advance(PROBE_WAIT_MS * 2)
    expect(h.did).toEqual(['probe'])
  })

  it('a newer navigation supersedes the watch: the clock starts again, the old one resolves', async () => {
    const h = harness()
    const first = h.watch.start({ kind: 'load', url: 'https://a.test/' })
    await h.advance(COMMIT_WAIT_MS - 100)
    h.watch.start({ kind: 'load', url: 'https://b.test/' })
    expect((await first.outcome())?.retry).toBeInstanceOf(Promise)
    expect(first.killed()).toBe(false)
    await h.advance(COMMIT_WAIT_MS - 1)
    expect(h.did).toEqual([])
    await h.advance(1 + PROBE_WAIT_MS)
    expect(h.did).toEqual(['probe', 'kill 4242'])
    h.watch.gone()
    await h.advance(0)
    expect(h.did.at(-1)).toBe('retry load https://b.test/')
  })

  it('a navigation started while a kill is out is the one the retry starts (and the older resolves)', async () => {
    const h = harness()
    const first = h.watch.start({ kind: 'reload' })
    await h.advance(HANG)
    expect(h.did).toEqual(['probe', 'kill 4242'])
    const second = h.watch.start({ kind: 'load', url: 'https://c.test/' })
    expect(second.killed()).toBe(true)
    expect((await first.outcome())?.retry).toBeInstanceOf(Promise)
    expect(h.watch.gone()).toBe(true)
    await h.advance(0)
    expect(h.did).toEqual(['probe', 'kill 4242', 'notice load', 'retry load https://c.test/'])
    expect((await second.outcome())?.retry).toBeInstanceOf(Promise)
    // One kill: nothing is armed for it.
    await h.advance(WATCH_MAX_MS)
    expect(h.did.filter((d) => d.startsWith('kill'))).toEqual(['kill 4242'])
  })

  // Codex review: the retry waits a turn after the gone; a navigation started in between (load B)
  // must stand, not be overwritten by the retry of the killed one.
  it('a navigation started between the gone and the retry stands; the killed one is not retried', async () => {
    const h = harness()
    const a = h.watch.start({ kind: 'load', url: 'https://a.test/' })
    await h.advance(HANG)
    expect(h.watch.gone()).toBe(true)
    h.setPid(0)
    const b = h.watch.start({ kind: 'load', url: 'https://b.test/' })
    await h.advance(0)
    expect(h.did).toEqual(['probe', 'kill 4242', 'notice load'])
    // The killed load settles as superseded (resolved), B is watched on its own.
    expect((await a.outcome())?.retry).toBeInstanceOf(Promise)
    expect(b.killed()).toBe(false)
    await h.advance(WATCH_MAX_MS)
    expect(h.did.filter((d) => d.startsWith('retry'))).toEqual([])
    expect(h.timers.size).toBe(0)
  })

  it('dispose between the gone and the retry runs no retry', async () => {
    const h = harness()
    const a = h.watch.start({ kind: 'reload' })
    await h.advance(HANG)
    h.watch.gone()
    h.watch.dispose()
    await h.advance(1000)
    expect(h.did.filter((d) => d.startsWith('retry'))).toEqual([])
    expect(await a.outcome()).toBeUndefined()
    expect(h.timers.size).toBe(0)
  })

  it('kills the pid read when the navigation started, never one read later', async () => {
    const h = harness({ pid: 11 })
    h.watch.start({ kind: 'reload' })
    h.setPid(12)
    await h.advance(HANG)
    expect(h.did).toEqual(['probe', 'kill 11'])
  })

  it('no renderer when the navigation started (pid 0): nothing to kill, nothing more', async () => {
    const h = harness({ pid: 0 })
    const handle = h.watch.start({ kind: 'reload' })
    await h.advance(HANG)
    expect(h.did).toEqual(['probe'])
    expect(handle.killed()).toBe(false)
    expect(h.watch.gone()).toBe(false)
    expect(h.timers.size).toBe(0)
  })

  it('a kill refused (the renderer replaced or gone in between) retries nothing', async () => {
    const h = harness({ kill: false })
    const handle = h.watch.start({ kind: 'reload' })
    await h.advance(HANG)
    expect(h.did).toEqual(['probe', 'kill 4242'])
    expect(handle.killed()).toBe(false)
    expect(h.watch.gone()).toBe(false)
    expect(h.did).toEqual(['probe', 'kill 4242'])
  })

  it('a crash it did not cause is the manager\'s, and ends the watch', async () => {
    const h = harness()
    h.watch.start({ kind: 'reload' })
    await h.advance(COMMIT_WAIT_MS - 1)
    expect(h.watch.gone()).toBe(false)
    await h.advance(WATCH_MAX_MS)
    expect(h.did).toEqual([])
  })

  it('a killed renderer that never goes: it gives up, and a later gone is the manager\'s', async () => {
    const h = harness()
    const handle = h.watch.start({ kind: 'load', url: 'https://a.test/' })
    await h.advance(HANG)
    await h.advance(GONE_WAIT_MS)
    expect(await handle.outcome()).toBeUndefined()
    expect(h.watch.gone()).toBe(false)
    expect(h.did).toEqual(['probe', 'kill 4242'])
  })

  it('a navigation that ends while a kill is out does not cancel the retry (its own failure comes first)', async () => {
    const h = harness()
    h.watch.start({ kind: 'reload' })
    await h.advance(HANG)
    h.watch.ended()
    expect(h.watch.gone()).toBe(true)
    await h.advance(0)
    expect(h.did.at(-1)).toBe('retry reload')
  })

  it('dispose leaves no timer and kills nothing later, also with a kill out', async () => {
    const h = harness()
    const a = h.watch.start({ kind: 'reload' })
    await h.advance(COMMIT_WAIT_MS)
    h.watch.dispose()
    await h.advance(WATCH_MAX_MS)
    expect(h.did).toEqual(['probe'])
    expect(await a.outcome()).toBeUndefined()
    expect(h.timers.size).toBe(0)

    const k = harness()
    const b = k.watch.start({ kind: 'reload' })
    await k.advance(HANG)
    k.watch.dispose()
    expect(k.timers.size).toBe(0)
    expect(await b.outcome()).toBeUndefined()
    expect(k.watch.gone()).toBe(false)
    const c = k.watch.start({ kind: 'reload' })
    await k.advance(WATCH_MAX_MS)
    expect(k.did).toEqual(['probe', 'kill 4242'])
    expect(await c.outcome()).toBeUndefined()
  })
})
