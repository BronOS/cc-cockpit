// Web access's headless terminals (design-web.md §5.2, plan Task 10): main numbers each tab's
// stream (spawn, data, resize, close) and posts it to a worker that keeps one headless xterm per
// tab. Most tests run the real worker logic (HeadlessTerms) in-process behind a fake worker, with
// messages delivered on a later turn as across threads; one test bundles the real worker file and
// starts it with worker_threads, as the app does.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { build } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_RESTARTS,
  nodeMirrorWorker,
  RESTART_WINDOW_MS,
  TerminalMirror,
  type MirrorState,
  type MirrorWorkerLike
} from '../../src/main/terminals/mirror'
import type { FromWorker, MirrorItem, ToWorker } from '../../src/main/terminals/mirror-protocol'
import { HeadlessTerms } from '../../src/main/terminals/mirror-worker'
import { TabManager, type TerminalTap } from '../../src/main/tabs/tab-manager'
import type { EventChannel, IpcEventMap } from '../../src/shared/ipc'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

/** HeadlessTerms behind the worker interface; both directions are delivered on a later turn. */
class FakeWorker implements MirrorWorkerLike {
  readonly received: ToWorker[] = []
  readonly terms: HeadlessTerms
  terminated = false
  private readonly listeners: Array<(m: FromWorker) => void> = []
  private readonly exitListeners: Array<(reason: string) => void> = []

  constructor(scrollback?: number) {
    this.terms = new HeadlessTerms((m) => setImmediate(() => this.listeners.forEach((l) => l(m))), scrollback)
  }

  post(message: ToWorker): void {
    // Structured clone, as postMessage does: the worker never shares main's objects.
    const copy = structuredClone(message)
    this.received.push(copy)
    setImmediate(() => {
      if (!this.terminated) this.terms.handle(copy)
    })
  }

  onMessage(listener: (m: FromWorker) => void): void {
    this.listeners.push(listener)
  }

  onExit(listener: (reason: string) => void): void {
    this.exitListeners.push(listener)
  }

  terminate(): void {
    this.terminated = true
    this.terms.dispose()
  }

  /** The thread died on its own. */
  crash(reason = 'exit code 1'): void {
    this.terminated = true
    this.terms.dispose()
    for (const l of this.exitListeners) l(reason)
  }

  items(tabId?: string): MirrorItem[] {
    return this.received.flatMap((m) => (m.t === 'item' && (tabId === undefined || m.tabId === tabId) ? [m.item] : []))
  }
}

let workers: FakeWorker[]
let logs: string[]
let clock: number

function mirror(): TerminalMirror {
  return new TerminalMirror({
    createWorker: () => {
      const w = new FakeWorker()
      workers.push(w)
      return w
    },
    log: (m) => logs.push(m),
    now: () => clock
  })
}

/** The screen a serialized state draws, one string per row (trailing blanks trimmed). */
function screen(state: MirrorState | null): Promise<string[]> {
  if (!state) throw new Error('no state')
  const term = new Terminal({ cols: state.cols, rows: state.rows, allowProposedApi: true, scrollback: 0 })
  return new Promise((resolve) =>
    term.write(state.data, () => {
      const buf = term.buffer.active
      const rows: string[] = []
      for (let y = 0; y < state.rows; y++) rows.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '')
      term.dispose()
      resolve(rows)
    })
  )
}

beforeEach(() => {
  workers = []
  logs = []
  clock = 1_000_000
})

describe('off', () => {
  it('starts no worker and numbers nothing while web access is off', () => {
    const m = mirror()
    m.spawned('t1', 80, 24)
    m.data('t1', 'hello')
    m.resized('t1', 100, 30)
    m.closed('t1')
    expect(workers).toHaveLength(0)
    expect(m.running).toBe(false)
    expect(m.seq('t1')).toBeUndefined()
  })

  it('answers reads for nothing without a worker', async () => {
    const m = mirror()
    expect(await m.inspect('t1')).toBeNull()
    await m.whenParsed('t1')
    expect(m.backlog('t1')).toBe(0)
  })

  it('stop() ends the worker, forgets every tab and a later start begins fresh', async () => {
    const m = mirror()
    m.start()
    m.spawned('t1', 80, 24)
    m.data('t1', 'x')
    m.stop()
    expect(workers[0]!.terminated).toBe(true)
    expect(m.running).toBe(false)
    expect(m.seq('t1')).toBeUndefined()
    m.data('t1', 'ignored')
    m.start()
    expect(workers).toHaveLength(2)
    // The tab spawned before this start is not mirrored (Task 13 adds a baseline for it).
    m.data('t1', 'still ignored')
    expect(workers[1]!.received).toEqual([])
  })
})

describe('numbering', () => {
  it('numbers spawn, data, resize and close in one stream per tab', async () => {
    const m = mirror()
    m.start()
    m.spawned('a', 80, 24)
    m.spawned('b', 80, 24)
    m.data('a', 'one')
    m.data('b', 'other tab')
    m.resized('a', 100, 30)
    m.data('a', 'two')
    m.closed('a')
    expect(workers[0]!.items('a')).toEqual([
      { seq: 1, kind: 'spawn', cols: 80, rows: 24 },
      { seq: 2, kind: 'data', data: 'one' },
      { seq: 3, kind: 'resize', cols: 100, rows: 30 },
      { seq: 4, kind: 'data', data: 'two' },
      { seq: 5, kind: 'close' }
    ])
    expect(workers[0]!.items('b')).toEqual([
      { seq: 1, kind: 'spawn', cols: 80, rows: 24 },
      { seq: 2, kind: 'data', data: 'other tab' }
    ])
    expect(m.seq('a')).toBeUndefined()
    expect(m.seq('b')).toBe(2)
  })

  it('numbers neither an empty chunk, an unchanged size nor a size the pty would refuse', () => {
    const m = mirror()
    m.start()
    m.spawned('a', 80, 24)
    m.data('a', '')
    m.resized('a', 80, 24)
    for (const [c, r] of <Array<[number, number]>>[
      [0, 24],
      [80, 0],
      [1001, 24],
      [80.5, 24],
      [Number.NaN, 24]
    ]) {
      m.resized('a', c, r)
    }
    m.spawned('bad', 0, 0)
    expect(workers[0]!.items()).toEqual([{ seq: 1, kind: 'spawn', cols: 80, rows: 24 }])
    expect(m.seq('a')).toBe(1)
    expect(m.seq('bad')).toBeUndefined()
  })

  it('a restart is a numbered spawn item at the spawn size, and the content stays', async () => {
    const m = mirror()
    m.start()
    m.spawned('a', 20, 4)
    m.data('a', 'before restart')
    m.resized('a', 30, 4)
    m.spawned('a', 20, 4)
    m.data('a', '\r\nafter')
    expect(workers[0]!.items('a').map((i) => [i.seq, i.kind])).toEqual([
      [1, 'spawn'],
      [2, 'data'],
      [3, 'resize'],
      [4, 'spawn'],
      [5, 'data']
    ])
    const state = await m.inspect('a')
    expect(state).toMatchObject({ cols: 20, rows: 4 })
    expect((await screen(state)).slice(0, 2)).toEqual(['before restart', 'after'])
    expect(m.size('a')).toEqual({ cols: 20, rows: 4 })
  })

  it('reports how far the worker parsed, the backlog, and whenParsed', async () => {
    const m = mirror()
    m.start()
    m.spawned('a', 80, 24)
    m.data('a', 'abc')
    m.data('a', 'defgh')
    expect(m.backlog('a')).toBe(8)
    expect(m.parsed('a')).toBe(0)
    await m.whenParsed('a')
    expect(m.parsed('a')).toBe(3)
    expect(m.backlog('a')).toBe(0)
  })
})

describe('resize items in order', () => {
  it('applies a resize after the output enqueued before it was parsed, as every view does', async () => {
    const m = mirror()
    m.start()
    m.spawned('a', 10, 3)
    // X goes to the last column of the 10-column screen. A resize applied at once (before this
    // chunk was parsed) would put it at column 20 instead.
    m.data('a', '\x1b[999CX')
    m.resized('a', 20, 3)
    m.data('a', '\r\n\x1b[999CY')
    const rows = await screen(await m.inspect('a'))
    expect(rows[0]).toBe(`${' '.repeat(9)}X`)
    expect(rows[1]).toBe(`${' '.repeat(19)}Y`)
  })

  it('keeps tabs apart: one tab resizing does not touch another', async () => {
    const m = mirror()
    m.start()
    m.spawned('a', 10, 3)
    m.spawned('b', 10, 3)
    m.resized('a', 40, 5)
    m.data('b', 'b text')
    expect(await m.inspect('a')).toMatchObject({ cols: 40, rows: 5 })
    const b = await m.inspect('b')
    expect(b).toMatchObject({ cols: 10, rows: 3 })
    expect((await screen(b))[0]).toBe('b text')
  })
})

describe('close', () => {
  it('frees the headless terminal and forgets the tab', async () => {
    const m = mirror()
    m.start()
    m.spawned('a', 80, 24)
    m.spawned('b', 80, 24)
    m.data('a', 'x')
    await m.whenParsed('a')
    expect(workers[0]!.terms.size()).toBe(2)
    m.closed('a')
    await m.whenParsed('b')
    await new Promise((r) => setImmediate(r))
    expect(workers[0]!.terms.size()).toBe(1)
    expect(m.seq('a')).toBeUndefined()
    expect(await m.inspect('a')).toBeNull()
    // Late output for a closed tab (a racing flush) is dropped, not numbered.
    m.data('a', 'late')
    expect(workers[0]!.items('a').at(-1)).toEqual({ seq: 3, kind: 'close' })
  })

  it('releases a whenParsed waiter when its tab closes', async () => {
    const m = mirror()
    m.start()
    m.spawned('a', 80, 24)
    m.data('a', 'x')
    const waiting = m.whenParsed('a')
    m.closed('a')
    await waiting
  })
})

describe('worker restart', () => {
  it('starts a new worker with a blank terminal per tab at the current seq, and numbering goes on', async () => {
    const m = mirror()
    const restarted: number[] = []
    m.onRestart(() => restarted.push(1))
    m.start()
    m.spawned('a', 30, 4)
    m.data('a', 'lost with the old worker')
    m.resized('a', 40, 5)
    await m.whenParsed('a')
    workers[0]!.crash()
    expect(workers).toHaveLength(2)
    expect(m.running).toBe(true)
    expect(restarted).toEqual([1])
    expect(workers[1]!.received).toEqual([{ t: 'reset', tabId: 'a', seq: 3, cols: 40, rows: 5 }])
    m.data('a', 'after the restart')
    expect(workers[1]!.items('a')).toEqual([{ seq: 4, kind: 'data', data: 'after the restart' }])
    const state = await m.inspect('a')
    expect(state).toMatchObject({ cols: 40, rows: 5 })
    expect((await screen(state))[0]).toBe('after the restart')
    expect(m.parsed('a')).toBe(4)
    expect(logs.some((l) => l.includes('worker ended (exit code 1)'))).toBe(true)
  })

  it('fails pending inspects, releases waiters and ignores the dead worker afterwards', async () => {
    const m = mirror()
    m.start()
    m.spawned('a', 80, 24)
    m.data('a', 'x')
    const waiting = m.whenParsed('a')
    const inspecting = m.inspect('a')
    const old = workers[0]!
    old.crash()
    await expect(inspecting).rejects.toThrow('restarted')
    await waiting
    // The tab's numbering is not moved by anything the old worker might still say.
    expect(m.parsed('a')).toBe(2)
  })

  it(`gives up after ${MAX_RESTARTS} restarts within the window, and a new start tries again`, async () => {
    const m = mirror()
    m.start()
    m.spawned('a', 80, 24)
    for (let i = 0; i < MAX_RESTARTS; i++) {
      workers.at(-1)!.crash()
      clock += 1000
    }
    expect(workers).toHaveLength(MAX_RESTARTS + 1)
    expect(m.running).toBe(true)
    workers.at(-1)!.crash()
    expect(workers).toHaveLength(MAX_RESTARTS + 1)
    expect(m.running).toBe(false)
    expect(m.gaveUp).toBe(true)
    m.data('a', 'nothing to post to')
    expect(logs.some((l) => l.includes('giving up'))).toBe(true)
    m.start()
    expect(m.running).toBe(true)
    expect(m.gaveUp).toBe(false)
  })

  it('crashes spread out over time keep restarting', () => {
    const m = mirror()
    m.start()
    for (let i = 0; i < MAX_RESTARTS * 3; i++) {
      workers.at(-1)!.crash()
      clock += RESTART_WINDOW_MS
    }
    expect(m.running).toBe(true)
  })

  it('an exit reported by a stopped worker restarts nothing', () => {
    const m = mirror()
    m.start()
    const w = workers[0]!
    m.stop()
    w.crash()
    expect(workers).toHaveLength(1)
    expect(m.running).toBe(false)
  })

  it('a restart listener that throws is logged', () => {
    const m = mirror()
    m.onRestart(() => {
      throw new Error('boom')
    })
    m.start()
    workers[0]!.crash()
    expect(logs.some((l) => l.includes('restart listener failed: boom'))).toBe(true)
  })
})

describe('the worker side', () => {
  it('reports a malformed message instead of throwing', () => {
    const out: FromWorker[] = []
    const terms = new HeadlessTerms((m) => out.push(m))
    terms.handle({ t: 'item', tabId: 'a', item: null as unknown as MirrorItem })
    expect(out[0]).toMatchObject({ t: 'log' })
    terms.dispose()
  })

  it('ignores items for a tab it never saw spawn, and a spawn at a bad size', () => {
    const out: FromWorker[] = []
    const terms = new HeadlessTerms((m) => out.push(m))
    terms.handle({ t: 'item', tabId: 'a', item: { seq: 2, kind: 'data', data: 'x' } })
    terms.handle({ t: 'item', tabId: 'a', item: { seq: 1, kind: 'spawn', cols: 5000, rows: 2 } })
    expect(terms.size()).toBe(0)
    expect(out).toEqual([])
  })

  it('keeps the configured scrollback and no more', async () => {
    const m = new TerminalMirror({
      createWorker: () => {
        const w = new FakeWorker(10)
        workers.push(w)
        return w
      }
    })
    m.start()
    m.spawned('a', 20, 2)
    for (let i = 0; i < 50; i++) m.data('a', `line ${i}\r\n`)
    const state = await m.inspect('a')
    const lines = state!.data.split('\r\n')
    expect(state!.data).not.toContain('line 30\r')
    expect(state!.data).toContain('line 49')
    expect(lines.length).toBeLessThanOrEqual(13)
  })
})

describe('TabManager tap points', () => {
  const P = 'aaaaaaaaaaaaaaaa'
  let root: string
  let backend: FakePtyBackend
  let order: string[]

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-mirror-tabs-')))
    backend = new FakePtyBackend()
    order = []
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function manager(tap: TerminalTap, log: (m: string) => void = () => undefined): TabManager {
    return new TabManager({
      backend,
      projectPath: (id) => (id === P ? root : undefined),
      loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/u' }),
      hooksPath: '/data/hooks.json',
      binDir: '/data/bin',
      sock: () => undefined,
      emit: <C extends EventChannel>(_p: string, channel: C, payload: IpcEventMap[C]) => {
        if (channel === 'tabs.data') order.push(`emit ${(payload as IpcEventMap['tabs.data']).data}`)
      },
      log,
      terminalTap: tap
    })
  }

  function recorder(): TerminalTap & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      spawned: (id, c, r) => calls.push(`spawned ${id} ${c}x${r}`),
      data: (id, chunk) => {
        calls.push(`data ${id} ${chunk}`)
        order.push(`tap ${chunk}`)
      },
      resized: (id, c, r) => calls.push(`resized ${id} ${c}x${r}`),
      closed: (id) => calls.push(`closed ${id}`)
    }
  }

  it('taps the spawn size, the flushed chunks right after the renderer, sizes the pty took, a restart and the close', async () => {
    const tap = recorder()
    const tabs = manager(tap)
    const tab = tabs.create(P, { kind: 'shell' })
    expect(tap.calls).toEqual([`spawned ${tab.id} 80x24`])
    backend.last.emit('hello')
    await new Promise((r) => setTimeout(r, 30))
    expect(order).toEqual(['emit hello', 'tap hello'])
    tabs.resize(P, tab.id, 120, 40)
    tabs.resize(P, tab.id, 0, 40)
    tabs.resize('bbbbbbbbbbbbbbbb', tab.id, 50, 50)
    backend.last.exit(1)
    // An exited tab has no pty: the size is not taken, so not tapped.
    tabs.resize(P, tab.id, 90, 30)
    tabs.restart(P, tab.id)
    tabs.close(P, tab.id)
    expect(tap.calls).toEqual([
      `spawned ${tab.id} 80x24`,
      `data ${tab.id} hello`,
      `resized ${tab.id} 120x40`,
      `spawned ${tab.id} 80x24`,
      `closed ${tab.id}`
    ])
  })

  it('taps the close of every tab when a window closes', () => {
    const tap = recorder()
    const tabs = manager(tap)
    const a = tabs.create(P, { kind: 'shell' })
    const b = tabs.create(P, { kind: 'shell' })
    tabs.closeProject(P)
    expect(tap.calls.filter((c) => c.startsWith('closed'))).toEqual([`closed ${a.id}`, `closed ${b.id}`])
  })

  it('a throwing tap is logged and the tab works on', () => {
    const logged: string[] = []
    const tabs = manager(
      {
        spawned: () => {
          throw new Error('tap broke')
        },
        data: () => undefined,
        resized: () => undefined,
        closed: () => undefined
      },
      (m) => logged.push(m)
    )
    const tab = tabs.create(P, { kind: 'shell' })
    expect(tabs.list(P).map((t) => t.id)).toEqual([tab.id])
    expect(logged).toEqual(['terminal tap failed: tap broke'])
  })

  it('end to end with the mirror: what the tab printed is in the headless copy', async () => {
    const m = mirror()
    m.start()
    const tabs = manager(m)
    const tab = tabs.create(P, { kind: 'shell' })
    backend.last.emit('$ echo hi\r\nhi\r\n')
    await new Promise((r) => setTimeout(r, 30))
    tabs.resize(P, tab.id, 100, 30)
    const state = await m.inspect(tab.id)
    expect(state).toMatchObject({ cols: 100, rows: 30 })
    expect((await screen(state)).slice(0, 2)).toEqual(['$ echo hi', 'hi'])
    tabs.close(P, tab.id)
    expect(m.seq(tab.id)).toBeUndefined()
    m.stop()
  })
})

describe('the real worker thread', () => {
  // Bundled as the app's build does (xterm external), under node_modules so its requires resolve.
  let dir: string
  beforeEach(() => {
    const cache = join(__dirname, '..', '..', 'node_modules', '.cache')
    mkdirSync(cache, { recursive: true })
    dir = mkdtempSync(join(cache, 'terminal-mirror-test-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('parses in a worker_threads worker and answers inspect', async () => {
    const out = await build({
      entryPoints: [join(__dirname, '..', '..', 'src', 'main', 'terminals', 'mirror-worker.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      external: ['@xterm/*'],
      logLevel: 'silent'
    })
    const entry = join(dir, 'mirror-worker.js')
    writeFileSync(entry, out.outputFiles[0]!.text)
    const m = new TerminalMirror({ createWorker: nodeMirrorWorker(entry), log: (l) => logs.push(l) })
    m.start()
    try {
      m.spawned('a', 30, 3)
      m.data('a', 'from the worker\r\n')
      m.resized('a', 40, 4)
      await m.whenParsed('a')
      expect(m.parsed('a')).toBe(3)
      const state = await m.inspect('a')
      expect(state).toMatchObject({ cols: 40, rows: 4 })
      expect((await screen(state))[0]).toBe('from the worker')
    } finally {
      m.stop()
    }
    expect(logs).toEqual(['terminal mirror: worker ready'])
  }, 20_000)

  it('reports a worker that exits on its own', async () => {
    const entry = join(dir, 'dies.js')
    writeFileSync(entry, 'process.exit(3)\n')
    const reasons: string[] = []
    const factory = nodeMirrorWorker(entry)
    const w = factory()
    await new Promise<void>((resolve) =>
      w.onExit((reason) => {
        reasons.push(reason)
        resolve()
      })
    )
    expect(reasons).toEqual(['exit code 3'])
  }, 20_000)

  it('a terminated worker reports no exit', async () => {
    const entry = join(dir, 'idle.js')
    writeFileSync(entry, 'setInterval(() => {}, 1000)\n')
    const w = nodeMirrorWorker(entry)()
    const reasons: string[] = []
    w.onExit((r) => reasons.push(r))
    w.terminate()
    await new Promise((r) => setTimeout(r, 200))
    expect(reasons).toEqual([])
  })
})
