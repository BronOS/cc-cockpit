// Task 29: dev reload of linked plugins. The DevWatcher against a fake watcher and fake services
// (debounce, ignore list, reload order, invalid manifest, unlink), then the real folder watchers
// against temp dirs (nothing touches the real data dir).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFolderWatcher,
  DEBOUNCE_MS,
  DevWatcher,
  isIgnoredPath,
  pollFolder,
  type DevWatcherDeps,
  type FolderWatch,
  type LinkedPlugin
} from '../../src/main/plugins/dev-watch'

interface FakeWatch extends FolderWatch {
  dir: string
  closed: boolean
  fire(rel?: string): void
  fail(err: Error): void
}

describe('isIgnoredPath', () => {
  it('ignores node_modules and .git at any depth, either separator', () => {
    expect(isIgnoredPath('node_modules/x/index.js')).toBe(true)
    expect(isIgnoredPath('sub/node_modules/x')).toBe(true)
    expect(isIgnoredPath('.git/HEAD')).toBe(true)
    expect(isIgnoredPath('a\\.git\\index')).toBe(true)
    expect(isIgnoredPath('src/host.js')).toBe(false)
    expect(isIgnoredPath('my_node_modules/a.js')).toBe(false)
    expect(isIgnoredPath('.github/workflows/ci.yml')).toBe(false)
  })
})

describe('DevWatcher', () => {
  let linked: LinkedPlugin[]
  let watches: FakeWatch[]
  let order: string[]
  let revalidation: { ok: true } | { ok: false; reason: string } | undefined
  let log: ReturnType<typeof vi.fn<(m: string) => void>>
  let deps: DevWatcherDeps
  let watcher: DevWatcher

  beforeEach(() => {
    vi.useFakeTimers()
    linked = [{ id: 'a.dev', dir: '/dev/a' }]
    watches = []
    order = []
    revalidation = { ok: true }
    log = vi.fn<(m: string) => void>()
    deps = {
      linked: () => linked,
      revalidate: async (id) => {
        order.push(`revalidate ${id}`)
        return revalidation
      },
      reload: async (id, problem) => {
        order.push(`reload ${id}${problem === undefined ? '' : ` (${problem})`}`)
      },
      watch: (dir, onChange, onError) => {
        const w: FakeWatch = {
          dir,
          closed: false,
          close: () => {
            w.closed = true
          },
          fire: (rel) => onChange(rel),
          fail: (err) => onError(err)
        }
        watches.push(w)
        return w
      },
      log
    }
    watcher = new DevWatcher(deps)
  })
  afterEach(() => {
    watcher.dispose()
    vi.useRealTimers()
  })

  it('opens one watcher per linked plugin and closes those of plugins unlinked since', () => {
    linked = [
      { id: 'a.dev', dir: '/dev/a' },
      { id: 'b.dev', dir: '/dev/b' }
    ]
    watcher.sync()
    watcher.sync()
    expect(watches.map((w) => w.dir)).toEqual(['/dev/a', '/dev/b'])
    expect(watcher.watchedIds()).toEqual(['a.dev', 'b.dev'])
    linked = [{ id: 'b.dev', dir: '/dev/b' }]
    watcher.sync()
    expect(watches.map((w) => w.closed)).toEqual([true, false])
    expect(watcher.watchedIds()).toEqual(['b.dev'])
    // Relinked from another folder: the old watcher closes, a new one opens.
    linked = [{ id: 'b.dev', dir: '/dev/b2' }]
    watcher.sync()
    expect(watches.map((w) => [w.dir, w.closed])).toEqual([
      ['/dev/a', true],
      ['/dev/b', true],
      ['/dev/b2', false]
    ])
  })

  it('debounces a burst of events into one reload after 300 ms', async () => {
    watcher.sync()
    const w = watches[0]!
    w.fire('host.js')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1)
    w.fire('lib/dep.js')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1)
    expect(order).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(order).toEqual(['revalidate a.dev', 'reload a.dev'])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(order).toHaveLength(2)
  })

  it('ignores node_modules and .git, but reloads for an event without a path', async () => {
    watcher.sync()
    const w = watches[0]!
    w.fire('node_modules/dep/index.js')
    w.fire('.git/index')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(order).toEqual([])
    w.fire()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(order).toEqual(['revalidate a.dev', 'reload a.dev'])
  })

  it('re-validates the manifest first, then reloads (order)', async () => {
    watcher.sync()
    watches[0]!.fire('plugin.json')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(order).toEqual(['revalidate a.dev', 'reload a.dev'])
  })

  it('passes the reason of an invalid manifest on, and keeps watching so a fix brings it back', async () => {
    watcher.sync()
    revalidation = { ok: false, reason: 'invalid plugin: main is required' }
    watches[0]!.fire('plugin.json')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(order).toEqual(['revalidate a.dev', 'reload a.dev (invalid plugin: main is required)'])
    expect(watches[0]!.closed).toBe(false)
    revalidation = { ok: true }
    watches[0]!.fire('plugin.json')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(order.at(-1)).toBe('reload a.dev')
  })

  it('does not reload a plugin that was unlinked while the debounce ran', async () => {
    watcher.sync()
    watches[0]!.fire('host.js')
    linked = []
    watcher.sync()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(order).toEqual([])
    expect(watches[0]!.closed).toBe(true)
  })

  it('does not reload when the installer no longer knows the plugin', async () => {
    watcher.sync()
    revalidation = undefined
    watches[0]!.fire('host.js')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(order).toEqual(['revalidate a.dev'])
  })

  it('runs one more reload after a change that arrived during a running reload', async () => {
    let finish: (() => void) | undefined
    deps.reload = (id) => {
      order.push(`reload ${id}`)
      return new Promise<void>((resolve) => {
        finish = resolve
      })
    }
    watcher = new DevWatcher(deps)
    watcher.sync()
    const w = watches[0]!
    w.fire('host.js')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(order).toEqual(['revalidate a.dev', 'reload a.dev'])
    // Two more events while it runs: one rerun, not two and not an overlap.
    w.fire('host.js')
    w.fire('host.js')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(order).toHaveLength(2)
    finish?.()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(order).toEqual(['revalidate a.dev', 'reload a.dev', 'revalidate a.dev', 'reload a.dev'])
    finish?.()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(order).toHaveLength(4)
  })

  it('logs a failing reload and keeps working', async () => {
    deps.reload = async () => {
      throw new Error('host exploded')
    }
    watcher = new DevWatcher(deps)
    watcher.sync()
    watches[0]!.fire('host.js')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(log).toHaveBeenCalledWith('dev watch a.dev: reload failed: host exploded')
    deps.reload = async (id) => void order.push(`reload ${id}`)
    watches[0]!.fire('host.js')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(order.at(-1)).toBe('reload a.dev')
  })

  it('logs a watcher error instead of throwing, and a watcher that cannot start is retried by the next sync', () => {
    watcher.sync()
    expect(() => watches[0]!.fail(new Error('EMFILE'))).not.toThrow()
    expect(log).toHaveBeenCalledWith('dev watch a.dev: EMFILE')

    watcher.dispose()
    let attempts = 0
    const flaky = new DevWatcher({
      ...deps,
      watch: (dir, onChange, onError) => {
        if (++attempts === 1) throw new Error('ENOENT')
        return deps.watch(dir, onChange, onError)
      }
    })
    flaky.sync()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cannot watch /dev/a: ENOENT'))
    expect(flaky.watchedIds()).toEqual([])
    flaky.sync()
    expect(flaky.watchedIds()).toEqual(['a.dev'])
    flaky.dispose()
  })

  it('survives a linked() that throws', () => {
    deps.linked = () => {
      throw new Error('index broke')
    }
    watcher = new DevWatcher(deps)
    expect(() => watcher.sync()).not.toThrow()
    expect(log).toHaveBeenCalledWith('dev watch: cannot list linked plugins: index broke')
  })

  it('dispose closes every watcher, cancels pending reloads and ignores later events and syncs', async () => {
    watcher.sync()
    const w = watches[0]!
    w.fire('host.js')
    watcher.dispose()
    expect(w.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(order).toEqual([])
    w.fire('host.js')
    watcher.sync()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(order).toEqual([])
    expect(watches).toHaveLength(1)
  })
})

describe('real folder watchers', () => {
  // Poll interval of these tests. pollFolder's ticks do real fs I/O on the libuv threadpool, which
  // fake timers cannot drive, so this half runs in real time: positive checks wait for an event
  // (never for a fixed time), and the few negative checks are best-effort, said so where they are.
  const POLL_MS = 30
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-devwatch-')))
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(root, 'host.js'), '1')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const until = async (cond: () => boolean, ms = 3_000): Promise<void> => {
    const start = Date.now()
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error('timed out')
      await sleep(20)
    }
  }

  /**
   * Rewrite `file` with new content (another size each time) until `cond` holds. No fixed warm-up
   * sleep is long enough: FSEvents can take longer to start, and an event it missed is never
   * re-fired; a poller's first scan is only the baseline, so a change made before it never counts.
   * Writing again until something is seen works for both, and proves the watcher is live.
   */
  const touchUntil = async (file: string, cond: () => boolean, ms = 5_000): Promise<void> => {
    let n = 0
    await until(() => {
      if (cond()) return true
      writeFileSync(file, 'x'.repeat(2 + n++))
      return false
    }, ms)
  }

  /**
   * Wait until no change arrived for a few poll intervals: the last write of a touchUntil can still
   * be reported by the next scan. Best-effort: under load a late report only makes the following
   * "something changed" check weaker (it may count that report), never fail.
   */
  const quiet = async (changes: unknown[]): Promise<void> => {
    for (let n = -1; n !== changes.length; ) {
      n = changes.length
      await sleep(5 * POLL_MS)
    }
  }

  it('polling: reports a changed, added or removed file, ignores node_modules, stops on close', async () => {
    const changes: (string | undefined)[] = []
    const errors: Error[] = []
    const w = pollFolder(root, (rel) => void changes.push(rel), (e) => void errors.push(e), POLL_MS)
    try {
      // Best-effort negative check (nothing signals "a scan ran" without a change): give the
      // baseline scan a few intervals, write under node_modules, give it a few more. Nothing else
      // writes meanwhile, so a slow machine can only make this pass vacuously, never fail.
      await sleep(4 * POLL_MS)
      writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'x')
      await sleep(5 * POLL_MS)
      expect(changes).toEqual([])
      await touchUntil(join(root, 'host.js'), () => changes.length >= 1)
      await quiet(changes)
      const seen = changes.length
      writeFileSync(join(root, 'new.js'), '2')
      await until(() => changes.length > seen)
      rmSync(join(root, 'new.js'))
      await until(() => changes.length > seen + 1)
      expect(errors).toEqual([])
    } finally {
      w.close()
    }
    // Best-effort negative check too: close() stops the interval and a scan in flight checks
    // `closed` before reporting, so nothing may arrive however long this waits.
    const after = changes.length
    writeFileSync(join(root, 'host.js'), 'again')
    await sleep(5 * POLL_MS)
    expect(changes).toHaveLength(after)
  })

  it('polling: a folder that disappears is a change, not an error', async () => {
    const changes: unknown[] = []
    const errors: Error[] = []
    const w = pollFolder(root, () => void changes.push(1), (e) => void errors.push(e), POLL_MS)
    try {
      // Removed before the baseline scan, the folder would hash as "missing" from the start and
      // never count as a change: see one change first, so the baseline is known to exist.
      await touchUntil(join(root, 'host.js'), () => changes.length >= 1)
      await quiet(changes)
      const seen = changes.length
      rmSync(root, { recursive: true, force: true })
      await until(() => changes.length > seen)
      expect(errors).toEqual([])
    } finally {
      w.close()
    }
  })

  it('polling: reports once when the folder has more files than the scan covers', async () => {
    const changes: unknown[] = []
    const errors: Error[] = []
    // A cap of 20 (injected) instead of the real 20,000: host.js and many/ count, node_modules
    // does not, so 25 files in many/ pass it. host.js sorts first and stays inside the cap.
    mkdirSync(join(root, 'many'))
    for (let i = 0; i < 25; i++) writeFileSync(join(root, 'many', `f${i}`), '')
    const w = pollFolder(root, () => void changes.push(1), (e) => void errors.push(e), POLL_MS, 20)
    try {
      await until(() => errors.length >= 1)
      // A reported change comes from a scan after the baseline one, and that scan was truncated
      // too: had the warning not been once-only it would have been logged again by now.
      await touchUntil(join(root, 'host.js'), () => changes.length >= 1)
      expect(errors).toHaveLength(1)
      expect(errors[0]!.message).toBe('more than 20 files: changes in later entries are not detected')
    } finally {
      w.close()
    }
  })

  it('the factory watches a real folder (native recursive watch on macOS, polling elsewhere)', async () => {
    const changes: (string | undefined)[] = []
    const w = createFolderWatcher(process.platform, POLL_MS)(root, (rel) => void changes.push(rel), () => {})
    try {
      mkdirSync(join(root, 'sub'))
      // Written until seen: FSEvents may start after the first writes (see touchUntil).
      await touchUntil(join(root, 'sub', 'a.js'), () => changes.length >= 1, 10_000)
    } finally {
      w.close()
    }
  }, 15_000)

  it('the factory polls on Linux and falls back to polling when the native watch cannot start', async () => {
    const changes: unknown[] = []
    const errors: Error[] = []
    const linux = createFolderWatcher('linux', POLL_MS)(root, () => void changes.push(1), (e) => void errors.push(e))
    try {
      await touchUntil(join(root, 'host.js'), () => changes.length >= 1)
    } finally {
      linux.close()
    }
    // A folder fs.watch refuses (it does not exist): reported once, then polled.
    const gone = join(root, 'missing')
    const errs: Error[] = []
    const w = createFolderWatcher('darwin', POLL_MS)(gone, () => {}, (e) => void errs.push(e))
    try {
      await until(() => errs.length >= 1)
    } finally {
      w.close()
    }
  })
})
