// The hung-page watchdog of a streamed page (server mode, design-web-browser.md §4.1): a page whose
// script never yields (`for (;;) {}`) commits no reload and no same-site navigation, since the old
// renderer must run its unload first (a cross-site one commits into another process by itself).
// `did-start-navigation` fires and then nothing: no `did-navigate`,
// no `unresponsive`, no `render-process-gone`, the same renderer pid for as long as it was watched
// (Electron 45, macOS and Linux, scripts/offscreen-input-check.mjs). A desktop Chrome offers "Page
// unresponsive: Exit page"; nobody is at a server's screen. So main does it: a navigation main started
// (reload, the address bar's load, back, forward; never one the page started) that has not ended after
// COMMIT_WAIT_MS while the page answers no probe within PROBE_WAIT_MS gets its renderer killed, and
// once it is gone the same navigation goes again, into a new renderer, with a notice to the viewers.
//
// - Only main's own calls arm it (the adapter's load / reload / back / forward), so nothing a page
//   or a browser sends decides a kill; the probe is main's own script, and the kill names the pid main
//   read when the navigation started, refused unless it is still the page's renderer (renderer-kill.ts).
// - A page that answers is never killed, however long its navigation takes (a slow server, a 204, a
//   download): the probe goes again every COMMIT_WAIT_MS until the navigation ends or WATCH_MAX_MS.
//   A probe that rejects (the frame disposed as it commits, say) is no answer yet: it goes again.
// - One kill per navigation: the retry is not watched (a page that spins in its load handler commits
//   first, so this never kills one twice), and a navigation started while a kill is out becomes the
//   one the retry loads (it went to a renderer that is going and would never commit).
// - The retry waits for `render-process-gone`: a navigation sent while the old process is still dying
//   never commits (Linux, Debian VM: a crash that dumps core through systemd-coredump sat in `do_exit`
//   for 42 to 46 s; a SIGKILL ends even that one, gone 4 ms later). Past GONE_WAIT_MS it gives up and a
//   later `render-process-gone` is the manager's like any crash (the view is dropped).
// - The input router resets on the same `render-process-gone` (ruling 2026-11-19 #11), so the typing
//   held for the hung page is dropped and the new page gets what comes next.
// Pure: timers, the probe, the pid, the kill and the retry are injected (unit tests drive a fake clock).

/** A navigation main started on the page, as the retry has to start it again. */
export type WatchedNavigation = { kind: 'load'; url: string } | { kind: 'reload' } | { kind: 'back' } | { kind: 'forward' }

/** What a probe of the page heard. `replaced`: the renderer was replaced meanwhile (no kill). */
export type ProbeAnswer = 'answered' | 'no-answer' | 'replaced' | 'unsure'

/** How long a navigation may go without ending before the page is probed. */
export const COMMIT_WAIT_MS = 3000
/** How long the probe waits for the page's answer. */
export const PROBE_WAIT_MS = 2000
/** How long one navigation is watched at most (a page that keeps answering is never killed). */
export const WATCH_MAX_MS = 60_000
/** How long a kill waits for `render-process-gone` (a SIGKILL takes about 50 ms, Linux and macOS). */
export const GONE_WAIT_MS = 10_000

export interface HungNavigationDeps {
  setTimer(run: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
  now(): number
  /** The page's renderer process id now (0 or less: none). */
  pid(): number
  /** Run the probe; the watch adds its own deadline (PROBE_WAIT_MS, then `no-answer`). */
  probe(): Promise<ProbeAnswer>
  /** Kill `pid` if it is still the page's renderer; false when nothing was killed. */
  kill(pid: number): boolean
  /** Start `nav` again (the old renderer is gone and the router has reset); settles as the load does. */
  retry(nav: WatchedNavigation): Promise<void>
  /** The page was killed and `nav` started again: tell the viewers. */
  restarted(nav: WatchedNavigation): void
  log(message: string): void
}

/** The retry of a killed navigation, settling as the new navigation does. */
export interface Retried {
  retry: Promise<void>
}

/** One watched navigation, as its caller (the adapter's load) sees it. */
export interface WatchedHandle {
  /** Whether the watch killed this navigation's renderer (its own promise then rejects with the kill). */
  killed(): boolean
  /**
   * Once the watch is done with a killed navigation: the retry's promise (boxed: a promise resolved
   * with a promise would wait for it), or undefined when there was none (the kill's renderer never
   * went). A navigation superseded by a newer one gets a resolved one.
   */
  outcome(): Promise<Retried | undefined>
}

class Watch implements WatchedHandle {
  timer: unknown
  probing = false
  wasKilled = false
  done = false
  private settled = false
  private settle!: (retried: Retried | undefined) => void
  private readonly result = new Promise<Retried | undefined>((resolve) => (this.settle = resolve))

  constructor(
    public nav: WatchedNavigation,
    readonly pid: number,
    readonly started: number
  ) {}

  killed(): boolean {
    return this.wasKilled
  }

  outcome(): Promise<Retried | undefined> {
    return this.result
  }

  finish(retry: Promise<void> | undefined): void {
    this.done = true
    if (this.settled) return
    this.settled = true
    this.settle(retry === undefined ? undefined : { retry })
  }
}

export class HungNavigationWatch {
  /** The navigation being watched (not yet killed). */
  private live: Watch | undefined
  /** A kill that is out: the navigation to start again once the renderer is gone, and the give-up timer. */
  private killing: { target: Watch; timer: unknown } | undefined
  private disposed = false
  /** Bumped by every start: a retry runs only if no navigation started since its renderer went. */
  private generation = 0
  /** The retry waiting for its turn (after the router's reset), and the navigation it is for. */
  private pendingRetry: { target: Watch; timer: unknown } | undefined

  constructor(private readonly deps: HungNavigationDeps) {}

  /** main is about to start `nav` on the page: watch it. Call before the navigation call. */
  start(nav: WatchedNavigation): WatchedHandle {
    const watch = new Watch(nav, this.deps.pid(), this.deps.now())
    this.generation++
    if (this.disposed) {
      watch.finish(undefined)
      return watch
    }
    if (this.killing) {
      // It went to a renderer that is going: the retry starts this one instead, and the older
      // navigation counts as superseded (resolved, as an ERR_ABORTED load is).
      this.killing.target.finish(Promise.resolve())
      watch.wasKilled = true
      this.killing.target = watch
      return watch
    }
    this.stop(this.live, Promise.resolve())
    this.live = watch
    watch.timer = this.deps.setTimer(() => this.check(watch), COMMIT_WAIT_MS)
    return watch
  }

  /**
   * The navigation ended: the main frame committed (a new page or in-page) or failed (not an abort).
   * A kill that is out is not ended by it (the killed navigation's own failure comes before its gone).
   */
  ended(): void {
    this.stop(this.live, undefined)
  }

  /**
   * `render-process-gone`: true when it is the renderer this watch killed (the retry has started, and
   * the manager must not drop the view); false for any other (a crash: the manager's).
   */
  gone(): boolean {
    const k = this.killing
    if (!k) {
      // Whatever was watched went with its renderer; nothing to kill any more.
      this.stop(this.live, undefined)
      return false
    }
    this.killing = undefined
    this.deps.clearTimer(k.timer)
    const nav = k.target.nav
    this.deps.log(`webview: the page did not answer while a ${nav.kind} waited; its renderer was killed and the ${nav.kind} started again`)
    this.deps.restarted(nav)
    // Not in this event: the input router hears the same `render-process-gone` after this listener
    // and resets, and the retry goes after that. A navigation started in between (the person's, or a
    // plugin's load B) stands: the retry of the killed one would overwrite it (codex review), so it
    // runs only if the generation is still the one of the gone.
    const gen = this.generation
    const target = k.target
    const timer = this.deps.setTimer(() => {
      if (this.pendingRetry?.timer !== timer) return
      this.pendingRetry = undefined
      if (this.generation !== gen) {
        target.finish(Promise.resolve())
        return
      }
      let retry: Promise<void>
      try {
        retry = this.deps.retry(nav)
      } catch (err) {
        retry = Promise.reject(err instanceof Error ? err : new Error(String(err)))
      }
      target.finish(retry)
    }, 0)
    this.pendingRetry = { target, timer }
    return true
  }

  /** The page is going (destroy): no timer stays, every caller waiting hears "none". */
  dispose(): void {
    this.disposed = true
    this.stop(this.live, undefined)
    if (this.killing) {
      this.deps.clearTimer(this.killing.timer)
      this.killing.target.finish(undefined)
      this.killing = undefined
    }
    if (this.pendingRetry) {
      this.deps.clearTimer(this.pendingRetry.timer)
      this.pendingRetry.target.finish(undefined)
      this.pendingRetry = undefined
    }
  }

  private stop(watch: Watch | undefined, outcome: Promise<void> | undefined): void {
    if (!watch) return
    if (watch.timer !== undefined) this.deps.clearTimer(watch.timer)
    watch.timer = undefined
    if (this.live === watch) this.live = undefined
    watch.finish(outcome)
  }

  private check(watch: Watch): void {
    watch.timer = undefined
    if (watch.done || this.live !== watch || watch.probing) return
    if (this.deps.now() - watch.started >= WATCH_MAX_MS) {
      this.stop(watch, undefined)
      return
    }
    watch.probing = true
    let answered = false
    const decide = (answer: ProbeAnswer): void => {
      if (answered) return
      answered = true
      this.deps.clearTimer(deadline)
      watch.probing = false
      if (watch.done || this.live !== watch) return
      if (answer === 'replaced') return void this.stop(watch, undefined)
      if (answer === 'no-answer') return void this.kill(watch)
      // Answered (a slow navigation on a live page) or unsure: look again later.
      watch.timer = this.deps.setTimer(() => this.check(watch), COMMIT_WAIT_MS)
    }
    const deadline = this.deps.setTimer(() => decide('no-answer'), PROBE_WAIT_MS)
    let probe: Promise<ProbeAnswer>
    try {
      probe = this.deps.probe()
    } catch {
      probe = Promise.resolve('unsure')
    }
    probe.then(decide, () => decide('unsure'))
  }

  private kill(watch: Watch): void {
    // pid 0: there was no renderer when the navigation started (one already gone): nothing to kill.
    if (!(watch.pid > 0) || !this.deps.kill(watch.pid)) {
      this.deps.log('webview: the page answers nothing while a navigation waits, and its renderer could not be killed')
      this.stop(watch, undefined)
      return
    }
    this.live = undefined
    watch.wasKilled = true
    const timer = this.deps.setTimer(() => {
      const k = this.killing
      if (!k || k.timer !== timer) return
      this.killing = undefined
      this.deps.log('webview: a killed renderer did not go in time; the navigation was not started again')
      // The target, not `watch`: a navigation started meanwhile took its place.
      k.target.finish(undefined)
    }, GONE_WAIT_MS)
    this.killing = { target: watch, timer }
  }
}
