// Web access's headless terminals (design-web.md §5.2, plan Task 10): main numbers each tab's
// stream (spawn, data, resize, close) and posts it to a worker that keeps one headless xterm per
// tab. Most tests run the real worker logic (HeadlessTerms) in-process behind a fake worker, with
// messages delivered on a later turn as across threads; one test bundles the real worker file and
// starts it with worker_threads, as the app does.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/headless'
import { build } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_RESTARTS,
  nodeMirrorWorker,
  RESTART_WINDOW_MS,
  TerminalMirror,
  type MirrorSnapshot,
  type MirrorState,
  type MirrorView
} from '../../src/main/terminals/mirror'
import type { FromWorker, MirrorItem } from '../../src/main/terminals/mirror-protocol'
import { HeadlessTerms, type HeadlessTermsOptions } from '../../src/main/terminals/mirror-worker'
import { FakeWorker } from '../fakes/fake-mirror-worker'
import { TabManager, type TerminalTap } from '../../src/main/tabs/tab-manager'
import { encodeFrame, frameBytes, termDataFrame, termSnapshotFrames } from '../../src/main/web/protocol'
import { ViewTerminals } from '../../src/main/web/view-terminals'
import type { EventChannel, IpcEventMap } from '../../src/shared/ipc'
import type { TermDataFrame, TermSnapshotFrame } from '../../src/shared/web-protocol'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

let workers: FakeWorker[]
let logs: string[]
let clock: number

function mirror(options: HeadlessTermsOptions & { snapshotTimeoutMs?: number } = {}): TerminalMirror {
  return new TerminalMirror({
    createWorker: () => {
      const w = new FakeWorker(options)
      workers.push(w)
      return w
    },
    log: (m) => logs.push(m),
    now: () => clock,
    snapshotTimeoutMs: options.snapshotTimeoutMs
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
        const w = new FakeWorker({ scrollback: 10 })
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
    // An exited tab has no pty: the size is not taken, so not tapped; it is remembered for the view.
    tabs.resize(P, tab.id, 90, 30)
    tabs.restart(P, tab.id)
    tabs.close(P, tab.id)
    expect(tap.calls).toEqual([
      `spawned ${tab.id} 80x24`,
      `data ${tab.id} hello`,
      `resized ${tab.id} 120x40`,
      // A restart spawns at the sizing view's size (Task 15), not 80 x 24 and back.
      `spawned ${tab.id} 90x30`,
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

  it('answers a join with a snapshot across the thread, the xterm internals it reads included', async () => {
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
      m.data('a', `hidden cursor${ESC}[?25l${ESC}[`)
      const view = new ReplayView()
      m.join('a', view)
      await m.whenParsed('a')
      await wait(50)
      // Mid-CSI in the real worker too: the ground check reads xterm's parser there.
      expect(view.snap).toBeNull()
      m.data('a', '0m')
      await m.whenParsed('a')
      await wait(50)
      expect(view.snap).toMatchObject({ seq: 3, cols: 30, rows: 3 })
      expect(view.snap!.data).toContain(`${ESC}[?25l`)
      expect((await view.text()).split('\n')[1]).toBe('hidden cursor')
    } finally {
      m.stop()
    }
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

// --- Task 11: gap-free snapshots and joins ----------------------------------------------------------

const ESC = '\x1b'

/** xterm internals the mode test reads, the same ones extraModes reads. */
interface XtermInternals {
  coreService: { isCursorHidden: boolean; decPrivateModes: { cursorStyle?: string } }
  coreMouseService: { activeEncoding: string }
  buffer: { scrollTop: number; scrollBottom: number }
}

function viewTerminal(cols: number, rows: number): Terminal {
  const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true })
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  return term
}

const written = (term: Terminal, data = ''): Promise<void> => new Promise((resolve) => term.write(data, resolve))

/** Every line of the active buffer (scrollback included) plus the cursor, as plain text. */
function screenText(term: Terminal): string {
  const buf = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return `${buf.type} ${term.cols}x${term.rows} cursor ${buf.cursorX},${buf.cursorY}\n${lines.join('\n')}`
}

/** The mirror's own copy, read through serialize into a fresh terminal, once everything is parsed. */
async function mirrorText(m: TerminalMirror, tabId: string): Promise<string> {
  const state = (await m.inspect(tabId))!
  const term = viewTerminal(state.cols, state.rows)
  await written(term, state.data)
  return screenText(term)
}

/** A view the way a page is one: a terminal rebuilt from the snapshot, then the live items. */
class ReplayView implements MirrorView {
  term: Terminal | null = null
  snap: MirrorSnapshot | null = null
  seqs: number[] = []
  data = ''
  isClosed = false

  snapshot(s: MirrorSnapshot): void {
    expect(this.snap).toBeNull()
    this.snap = s
    this.term = viewTerminal(s.cols, s.rows)
    this.term.write(s.data)
  }

  item(item: MirrorItem): void {
    // Never before the snapshot, never a gap, never a double.
    expect(this.snap).not.toBeNull()
    const last = this.seqs.at(-1) ?? this.snap!.seq
    expect(item.seq).toBe(last + 1)
    this.seqs.push(item.seq)
    const term = this.term!
    if (item.kind === 'data') {
      this.data += item.data
      term.write(item.data)
    } else if (item.kind === 'resize' || item.kind === 'spawn') {
      term.write('', () => term.resize(item.cols, item.rows))
    } else {
      throw new Error('a close item reached a view')
    }
  }

  closed(): void {
    this.isClosed = true
  }

  async text(): Promise<string> {
    await written(this.term!)
    return screenText(this.term!)
  }
}

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** Claude-like output: colored lines, cursor moves and erases inside synchronized output, wide chars. */
function tuiStream(rand: () => number, frames: number): string {
  let out = `${ESC}[?2004h${ESC}[?1004h${ESC}[?25l`
  for (let f = 0; f < frames; f++) {
    out += `${ESC}[?2026h`
    const lines = 1 + Math.floor(rand() * 4)
    for (let i = 0; i < lines; i++) {
      out += `${ESC}[38;5;${Math.floor(rand() * 255)}m● line ${f}.${i} ${'x'.repeat(Math.floor(rand() * 90))}${ESC}[0m 漢字🙂\r\n`
    }
    out += `${ESC}[2A${ESC}[2K> prompt ${f}${ESC}[1B${ESC}[2K${ESC}]0;title ${f}\x07`
    out += `${ESC}[?2026l`
  }
  return out
}

/** Cut `text` into chunks at random places: inside escape sequences and surrogate pairs too. */
function chunks(text: string, rand: () => number): string[] {
  const out: string[] = []
  let at = 0
  while (at < text.length) {
    const n = 1 + Math.floor(rand() * 300)
    out.push(text.slice(at, at + n))
    at += n
  }
  return out
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Everything numbered so far is parsed, and the answers the worker posted with it arrived. */
async function settle(m: TerminalMirror, tabId: string): Promise<void> {
  await m.whenParsed(tabId)
  await wait(5)
}

describe('snapshots and joins', () => {
  let m: TerminalMirror | undefined
  afterEach(() => m?.stop())

  it('views joining at random moments under heavy output end identical, with no gap or double', async () => {
    const rand = rng(42)
    m = mirror({ groundWaitMs: 20 })
    m.start()
    m.spawned('t1', 100, 30)
    const all = chunks(tuiStream(rand, 400), rand)
    const views: ReplayView[] = []
    for (let i = 0; i < all.length; i++) {
      m.data('t1', all[i]!)
      // A resize now and then, as the desktop pane changes size.
      if (i === 150) m.resized('t1', 80, 24)
      if (i === 300) m.resized('t1', 120, 40)
      if (i % 37 === 0) {
        const view = new ReplayView()
        views.push(view)
        m.join('t1', view)
      }
      // Sometimes let the worker parse (callbacks run), sometimes pile items up in flight.
      if (rand() < 0.3) await tick()
    }
    await settle(m, 't1')
    await wait(50)
    const expected = await mirrorText(m, 't1')
    expect(views.length).toBeGreaterThan(10)
    expect(m.waitingViews('t1')).toBe(0)
    const seqs = new Set<number>()
    for (const view of views) {
      expect(view.snap).not.toBeNull()
      seqs.add(view.snap!.seq)
      // Every item after the snapshot's seq, up to the last one numbered: nothing lost or doubled.
      expect(view.seqs.at(-1) ?? view.snap!.seq).toBe(m.seq('t1'))
      expect(view.seqs.length).toBe(m.seq('t1')! - view.snap!.seq)
      expect(await view.text()).toBe(expected)
    }
    // The joins really landed at different points of the stream.
    expect(seqs.size).toBeGreaterThan(5)
  })

  it('a join while items are in flight gets them after the snapshot, not before', async () => {
    m = mirror()
    m.start()
    m.spawned('t', 40, 5)
    m.data('t', 'one\r\n')
    m.data('t', 'two\r\n')
    // Neither is parsed yet: main holds both for the view.
    const view = new ReplayView()
    m.join('t', view)
    m.data('t', 'three\r\n')
    expect(view.snap).toBeNull()
    await settle(m, 't')
    expect(view.snap).not.toBeNull()
    // Taken inside a write callback the worker reached after the request: what the snapshot does
    // not hold came live, in order, and nothing it holds came twice.
    expect(view.snap!.seq).toBeGreaterThanOrEqual(2)
    expect(['one\r\ntwo\r\nthree\r\n', 'two\r\nthree\r\n', 'three\r\n', '']).toContain(view.data)
    expect(view.snap!.data.length > 0 || view.data.length > 0).toBe(true)
    expect(view.seqs).toEqual(Array.from({ length: 4 - view.snap!.seq }, (_, i) => view.snap!.seq + 1 + i))
    expect(await view.text()).toBe(await mirrorText(m, 't'))
  })

  it('waits for the parser ground state when a chunk ends inside a CSI', async () => {
    m = mirror({ groundWaitMs: 1000 })
    m.start()
    m.spawned('t', 40, 5)
    m.data('t', `plain ${ESC}[3`)
    await settle(m, 't')
    const view = new ReplayView()
    m.join('t', view)
    await wait(20)
    // Mid-CSI: no snapshot yet; it would make the view print "1mred" as text.
    expect(view.snap).toBeNull()
    expect(m.waitingViews('t')).toBe(1)
    m.data('t', `1mred${ESC}[0m`)
    await settle(m, 't')
    expect(view.snap?.seq).toBe(3)
    expect(view.seqs).toEqual([])
    expect(await view.text()).toBe(await mirrorText(m, 't'))
    expect(await view.text()).toContain('plain red')
  })

  it('waits across an OSC split in two and a surrogate pair split in two', async () => {
    m = mirror({ groundWaitMs: 1000 })
    m.start()
    m.spawned('t', 40, 5)
    const view = new ReplayView()
    m.data('t', `${ESC}]0;a ti`)
    await settle(m, 't')
    m.join('t', view)
    m.data('t', `tle\x07ok \ud83d`)
    await settle(m, 't')
    // Inside the OSC at the join, then half a surrogate pair waiting in the decoder.
    expect(view.snap).toBeNull()
    m.data('t', '\ude42!')
    await settle(m, 't')
    expect(view.snap?.seq).toBe(4)
    expect(await view.text()).toContain('ok 🙂!')
  })

  it('takes the snapshot after the ground wait when the stream stops mid-sequence', async () => {
    m = mirror({ groundWaitMs: 20 })
    m.start()
    m.spawned('t', 40, 5)
    m.data('t', `x${ESC}[`)
    await settle(m, 't')
    const view = new ReplayView()
    m.join('t', view)
    await wait(5)
    expect(view.snap).toBeNull()
    await wait(60)
    expect(view.snap?.seq).toBe(2)
  })

  it('keeps the modes Claude Code sets through the snapshot', async () => {
    m = mirror()
    m.start()
    m.spawned('t', 60, 10)
    m.data(
      't',
      `main screen${ESC}[?2004h${ESC}[?1004h${ESC}[?1h${ESC}[?1000h${ESC}[?1006h${ESC}[?25l${ESC}[5 q` +
        `${ESC}[?1049h${ESC}[Halt screen${ESC}[2;8r${ESC}[?2026h${ESC}[3;4Hcursor`
    )
    await settle(m, 't')
    const view = new ReplayView()
    m.join('t', view)
    await wait(10)
    const term = view.term!
    await written(term)
    expect(term.modes).toMatchObject({
      bracketedPasteMode: true,
      sendFocusMode: true,
      applicationCursorKeysMode: true,
      mouseTrackingMode: 'vt200',
      synchronizedOutputMode: true
    })
    const core = (term as unknown as { _core: XtermInternals })._core
    expect(core.coreService.isCursorHidden).toBe(true)
    expect(core.coreMouseService.activeEncoding).toBe('SGR')
    expect(core.coreService.decPrivateModes.cursorStyle).toBe('bar')
    expect(core.buffer.scrollTop).toBe(1)
    expect(core.buffer.scrollBottom).toBe(7)
    expect(term.buffer.active.type).toBe('alternate')
    // The scroll region fix restores the cursor where the program left it.
    expect([term.buffer.active.cursorX, term.buffer.active.cursorY]).toEqual([9, 2])
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('alt screen')
    // The serialize addon alone drops cursor visibility, 2026, SGR mouse and the scroll region:
    // what extraModes is for (a new addon version that keeps them would show here).
    const plain = new SerializeAddon()
    const probe = new Terminal({ cols: 60, rows: 10, allowProposedApi: true })
    probe.loadAddon(plain)
    await written(probe, `${ESC}[?25l${ESC}[?2026h${ESC}[?1006h${ESC}[2;8r`)
    expect(plain.serialize()).not.toMatch(/\?25l|\?2026h|\?1006h|2;8r/)
    probe.dispose()
  })

  it('re-emits SGR-pixels mouse encoding and a blinking block cursor', async () => {
    m = mirror()
    m.start()
    m.spawned('t', 20, 5)
    m.data('t', `${ESC}[?1003h${ESC}[?1016h${ESC}[1 q`)
    await settle(m, 't')
    const view = new ReplayView()
    m.join('t', view)
    await wait(10)
    expect(view.snap!.data).toContain(`${ESC}[?1016h`)
    expect(view.snap!.data).toContain(`${ESC}[1 q`)
    // Nothing set, nothing re-emitted: a plain shell's snapshot carries no extra modes.
    m.spawned('plain', 20, 5)
    m.data('plain', 'hi')
    await settle(m, 'plain')
    const other = new ReplayView()
    m.join('plain', other)
    await wait(10)
    expect(other.snap!.data).not.toMatch(/\?25l|\?1006h|\?1016h| q|\?2026h/)
    expect(other.snap!.data).not.toContain(`${ESC}7`)
  })

  it('numbers resizes in the stream and a view applies them after the chunks before them', async () => {
    m = mirror()
    m.start()
    m.spawned('t', 20, 5)
    const view = new ReplayView()
    m.join('t', view)
    await wait(10)
    expect(view.snap?.seq).toBe(1)
    m.data('t', 'a'.repeat(30))
    m.resized('t', 40, 5)
    m.data('t', '\r\nb')
    m.spawned('t', 30, 5) // a restart: a size item for the view
    await settle(m, 't')
    expect(view.seqs).toEqual([2, 3, 4, 5])
    expect(await view.text()).toBe(await mirrorText(m, 't'))
  })

  it('views joining together share one request; a later join asks again', async () => {
    m = mirror()
    m.start()
    m.spawned('t', 20, 5)
    m.data('t', 'x')
    const a = new ReplayView()
    const b = new ReplayView()
    m.join('t', a)
    m.data('t', 'y')
    m.join('t', b)
    await settle(m, 't')
    const requests = (): number => workers[0]!.received.filter((r) => r.t === 'snapshot').length
    expect(requests()).toBe(1)
    expect(a.snap).toEqual(b.snap)
    expect(a.seqs.at(-1) ?? a.snap!.seq).toBe(3)
    expect(b.seqs.at(-1) ?? b.snap!.seq).toBe(3)
    const c = new ReplayView()
    m.join('t', c)
    await settle(m, 't')
    expect(requests()).toBe(2)
    expect(c.snap?.seq).toBe(3)
    // The same view twice is refused: it already follows the tab.
    expect(m.join('t', c)).toBeUndefined()
  })

  it('tells views when the tab closes, and refuses unknown tabs and a stopped mirror', async () => {
    m = mirror()
    expect(m.join('t', new ReplayView())).toBeUndefined()
    m.start()
    m.spawned('t', 20, 5)
    const live = new ReplayView()
    m.join('t', live)
    await wait(10)
    const waiting = new ReplayView()
    m.join('t', waiting)
    m.closed('t')
    expect(live.isClosed).toBe(true)
    expect(waiting.isClosed).toBe(true)
    await wait(10)
    expect(waiting.snap).toBeNull()
    expect(m.join('t', new ReplayView())).toBeUndefined()
    expect(m.join('never', new ReplayView())).toBeUndefined()
  })

  it('a view that left gets nothing more, and a request nobody waits for is dropped', async () => {
    m = mirror()
    m.start()
    m.spawned('t', 20, 5)
    const view = new ReplayView()
    const leave = m.join('t', view)!
    await wait(10)
    m.data('t', 'a')
    leave()
    m.data('t', 'b')
    await settle(m, 't')
    expect(view.data).toBe('a')
    // Left before its snapshot came: the answer finds nobody, and nothing is delivered.
    const early = new ReplayView()
    m.join('t', early)!()
    await settle(m, 't')
    expect(early.snap).toBeNull()
    expect(m.waitingViews('t')).toBe(0)
  })

  it('a worker that never answers a snapshot counts as hung: restarted, the new one answers the waiting views', async () => {
    m = mirror({ snapshotTimeoutMs: 20 })
    m.start()
    m.spawned('t', 20, 5)
    m.data('t', 'before')
    await settle(m, 't')
    // The worker hangs on snapshots only.
    const w = workers[0]!
    const handle = w.terms.handle.bind(w.terms)
    w.terms.handle = (message) => (message.t === 'snapshot' ? undefined : handle(message))
    const view = new ReplayView()
    m.join('t', view)
    await wait(60)
    expect(logs.some((l) => l.includes('no snapshot of tab t'))).toBe(true)
    expect(w.terminated).toBe(true)
    expect(workers).toHaveLength(2)
    // Not ended: it starts from the new worker's blank copy at the current seq, then the stream.
    expect(view.isClosed).toBe(false)
    expect(view.snap).toMatchObject({ seq: 2, cols: 20, rows: 5 })
    m.data('t', 'later')
    await settle(m, 't')
    expect(view.data).toBe('later')
    expect(m.waitingViews('t')).toBe(0)
  })

  it('past the restart budget a snapshot that never comes ends the waiting views', async () => {
    // Every worker hangs on snapshots: each timeout spends a restart, then the mirror gives up.
    m = new TerminalMirror({
      createWorker: () => {
        const w = new FakeWorker()
        const handle = w.terms.handle.bind(w.terms)
        w.terms.handle = (message) => (message.t === 'snapshot' ? undefined : handle(message))
        workers.push(w)
        return w
      },
      log: (l) => logs.push(l),
      now: () => clock,
      snapshotTimeoutMs: 10
    })
    m.start()
    m.spawned('t', 20, 5)
    const view = new ReplayView()
    m.join('t', view)
    for (let i = 0; i < 100 && !m.gaveUp; i++) await wait(10)
    expect(m.gaveUp).toBe(true)
    expect(workers).toHaveLength(MAX_RESTARTS + 1)
    expect(view.isClosed).toBe(true)
    expect(view.snap).toBeNull()
  })

  it('a worker restart asks the new worker for the waiting views; they start from the blank copy', async () => {
    m = mirror({ groundWaitMs: 1000 })
    m.start()
    m.spawned('t', 20, 5)
    m.data('t', `lost${ESC}[3`)
    await settle(m, 't')
    const live = new ReplayView()
    // Mid-CSI: this view waits.
    const waiting = new ReplayView()
    m.join('t', waiting)
    await wait(10)
    expect(waiting.snap).toBeNull()
    workers[0]!.crash()
    await settle(m, 't')
    expect(waiting.snap).toMatchObject({ seq: 2, cols: 20, rows: 5 })
    m.join('t', live)
    m.data('t', 'after')
    await settle(m, 't')
    expect(waiting.seqs).toEqual([3])
    expect(await waiting.text()).toBe(await mirrorText(m, 't'))
    expect(await waiting.text()).toContain('after')
    expect(await waiting.text()).not.toContain('lost')
  })

  it('stop and a given-up mirror end every view', async () => {
    m = mirror()
    m.start()
    m.spawned('t', 20, 5)
    const view = new ReplayView()
    m.join('t', view)
    m.stop()
    expect(view.isClosed).toBe(true)
    m.start()
    m.spawned('u', 20, 5)
    const other = new ReplayView()
    m.join('u', other)
    for (let i = 0; i <= MAX_RESTARTS; i++) workers.at(-1)!.crash()
    expect(m.gaveUp).toBe(true)
    expect(other.isClosed).toBe(true)
  })

  it('a view that throws is logged and the others still get every item', async () => {
    m = mirror()
    m.start()
    m.spawned('t', 20, 5)
    const good = new ReplayView()
    const bad: MirrorView = {
      snapshot: () => undefined,
      item: () => {
        throw new Error('view broke')
      },
      closed: () => undefined
    }
    m.join('t', bad)
    m.join('t', good)
    await wait(10)
    m.data('t', 'a')
    m.data('t', 'b')
    await settle(m, 't')
    expect(good.data).toBe('ab')
    expect(logs.filter((l) => l === 'terminal mirror view item failed: view broke')).toHaveLength(2)
  })

  it('the worker answers null for a tab it does not hold, and for one that closes while it waits', async () => {
    const out: FromWorker[] = []
    const terms = new HeadlessTerms((msg) => out.push(msg), { groundWaitMs: 1000 })
    terms.handle({ t: 'snapshot', id: 1, tabId: 'nope' })
    terms.handle({ t: 'item', tabId: 'a', item: { seq: 1, kind: 'spawn', cols: 10, rows: 2 } })
    terms.handle({ t: 'item', tabId: 'a', item: { seq: 2, kind: 'data', data: `${ESC}[` } })
    terms.handle({ t: 'snapshot', id: 2, tabId: 'a' })
    terms.handle({ t: 'snapshot', id: 3, tabId: 'a' })
    await wait(20)
    terms.handle({ t: 'item', tabId: 'a', item: { seq: 3, kind: 'close' } })
    expect(out.filter((msg) => msg.t === 'snapshot')).toEqual([
      { t: 'snapshot', ids: [1], tabId: 'nope', snapshot: null },
      { t: 'snapshot', ids: [2, 3], tabId: 'a', snapshot: null }
    ])
    terms.dispose()
  })
})

describe('term frames', () => {
  const snap = (data: string): MirrorSnapshot => ({ seq: 7, cols: 80, rows: 24, data })

  it('one part when it fits, an empty screen too', () => {
    expect(termSnapshotFrames('t', snap(''))).toEqual([
      { t: 'term.snapshot', tabId: 't', seq: 7, cols: 80, rows: 24, part: 1, parts: 1, data: '' }
    ])
    expect(termSnapshotFrames('t', snap('hello'))).toHaveLength(1)
  })

  it('splits above the cap by the exact encoded size, never a surrogate pair, and joins back', () => {
    const rand = rng(7)
    // Escapes (6 bytes in JSON), quotes and backslashes (2), CJK (3), emoji pairs (4), lone surrogates (6).
    const data = tuiStream(rand, 300) + '"\\\t\ud800x\udc00' + '🙂'.repeat(500)
    const cap = 4096
    const frames = termSnapshotFrames('tab', snap(data), cap)
    expect(frames.length).toBeGreaterThan(10)
    frames.forEach((f, i) => {
      expect(f).toMatchObject({ t: 'term.snapshot', tabId: 'tab', seq: 7, cols: 80, rows: 24, part: i + 1, parts: frames.length })
      const bytes = frameBytes(encodeFrame(f))
      expect(bytes).toBeLessThanOrEqual(cap)
      // Full but for the last character that did not fit (at most 6 bytes) and the part digits.
      if (i < frames.length - 1) expect(bytes).toBeGreaterThan(cap - 6 - 40)
      const last = f.data.charCodeAt(f.data.length - 1)
      const next = frames[i + 1]?.data.charCodeAt(0)
      if (next !== undefined && next >= 0xdc00 && next <= 0xdfff) expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    })
    expect(frames.map((f) => f.data).join('')).toBe(data)
    expect(() => termSnapshotFrames('t', snap('x'), 10)).toThrow('too small')
  })

  it('maps stream items to term.data frames; close is not sent', () => {
    expect(termDataFrame('t', { seq: 2, kind: 'data', data: 'x' })).toEqual({ t: 'term.data', tabId: 't', seq: 2, data: 'x' })
    expect(termDataFrame('t', { seq: 3, kind: 'resize', cols: 9, rows: 4 })).toEqual({
      t: 'term.data',
      tabId: 't',
      seq: 3,
      cols: 9,
      rows: 4
    })
    expect(termDataFrame('t', { seq: 4, kind: 'spawn', cols: 80, rows: 24 })).toMatchObject({ cols: 80, rows: 24 })
    expect(termDataFrame('t', { seq: 5, kind: 'close' })).toBeNull()
  })
})

/**
 * The page's side of the frames: joins a snapshot's parts in order, then applies every term.data
 * of the tab after it, checking the numbering as it goes.
 */
class PageTerminal {
  term: Terminal | null = null
  parts: TermSnapshotFrame[] = []
  snapshots = 0
  seq = 0

  frame(f: TermSnapshotFrame | TermDataFrame): void {
    if (f.t === 'term.snapshot') {
      expect(f.part).toBe(this.parts.length + 1)
      this.parts.push(f)
      if (f.part < f.parts) return
      this.term?.dispose()
      this.term = viewTerminal(f.cols, f.rows)
      this.term.write(this.parts.map((p) => p.data).join(''))
      this.seq = f.seq
      this.parts = []
      this.snapshots++
      return
    }
    // A live item only once a whole snapshot is in, and exactly the next one.
    expect(this.parts).toEqual([])
    expect(this.term).not.toBeNull()
    expect(f.seq).toBe(this.seq + 1)
    this.seq = f.seq
    const term = this.term!
    if ('data' in f) term.write(f.data)
    else term.write('', () => term.resize(f.cols, f.rows))
  }

  async text(): Promise<string> {
    await written(this.term!)
    return screenText(this.term!)
  }
}

describe('ViewTerminals', () => {
  let m: TerminalMirror | undefined
  afterEach(() => m?.stop())

  function view(allowed = (tabId: string) => tabId !== 'foreign', maxFrameBytes?: number) {
    const sent: Array<TermSnapshotFrame | TermDataFrame> = []
    const pages = new Map<string, PageTerminal>()
    const vt = new ViewTerminals({
      mirror: m!,
      canFollow: allowed,
      maxFrameBytes,
      send: (f) => {
        expect(frameBytes(encodeFrame(f))).toBeLessThanOrEqual(maxFrameBytes ?? Infinity)
        sent.push(f)
        let page = pages.get(f.tabId)
        if (!page) pages.set(f.tabId, (page = new PageTerminal()))
        page.frame(f)
      }
    })
    return { vt, sent, pages }
  }

  it('snapshots only the visible tab; another when selected; joined tabs stay live', async () => {
    m = mirror()
    m.start()
    for (const id of ['a', 'b', 'c']) {
      m.spawned(id, 20, 5)
      m.data(id, `tab ${id}\r\n`)
    }
    const { vt, sent, pages } = view()
    expect(vt.select('a')).toBe(true)
    await settle(m, 'a')
    expect(new Set(sent.map((f) => f.tabId))).toEqual(new Set(['a']))
    m.data('b', 'b while hidden\r\n')
    await settle(m, 'b')
    expect(sent.some((f) => f.tabId === 'b')).toBe(false)
    expect(vt.select('b')).toBe(true)
    await settle(m, 'b')
    expect(pages.get('b')!.snapshots).toBe(1)
    // Back to a: still followed, no new snapshot; its output kept coming while b showed.
    m.data('a', 'a while hidden\r\n')
    expect(vt.select('a')).toBe(true)
    await settle(m, 'a')
    expect(pages.get('a')!.snapshots).toBe(1)
    expect(sent.filter((f) => f.t === 'term.snapshot').map((f) => f.tabId)).toEqual(['a', 'b'])
    expect(vt.following().sort()).toEqual(['a', 'b'])
    expect(await pages.get('a')!.text()).toBe(await mirrorText(m, 'a'))
    expect(await pages.get('b')!.text()).toBe(await mirrorText(m, 'b'))
    expect(pages.has('c')).toBe(false)
  })

  it('refuses a tab the view may not follow and one the mirror does not hold', async () => {
    m = mirror()
    m.start()
    m.spawned('foreign', 20, 5)
    const { vt, sent } = view()
    expect(vt.select('foreign')).toBe(false)
    expect(vt.select('missing')).toBe(false)
    await wait(10)
    expect(sent).toEqual([])
    expect(vt.following()).toEqual([])
  })

  it('forgets a closed tab, leaves and rejoins, and sends nothing once disposed', async () => {
    m = mirror()
    m.start()
    m.spawned('a', 20, 5)
    m.spawned('b', 20, 5)
    const { vt, sent, pages } = view()
    vt.select('a')
    vt.select('b')
    await settle(m, 'b')
    m.closed('a')
    expect(vt.following()).toEqual(['b'])
    // A resync: leave and join again, a fresh snapshot.
    vt.leave('b')
    pages.delete('b')
    expect(vt.select('b')).toBe(true)
    await settle(m, 'b')
    expect(pages.get('b')!.snapshots).toBe(1)
    vt.dispose()
    const count = sent.length
    m.data('b', 'after dispose')
    await settle(m, 'b')
    expect(sent).toHaveLength(count)
    expect(vt.select('b')).toBe(false)
  })

  it('a failed send leaves the tab and tells the connection, which can rejoin with a fresh snapshot', async () => {
    m = mirror()
    m.start()
    m.spawned('t', 20, 5)
    m.data('t', 'hello\r\n')
    const sent: Array<TermSnapshotFrame | TermDataFrame> = []
    const failures: string[] = []
    let broken = true
    const vt = new ViewTerminals({
      mirror: m,
      canFollow: () => true,
      send: (f) => {
        if (broken) throw new Error('socket closing')
        sent.push(f)
      },
      failed: (tabId) => failures.push(tabId)
    })
    expect(vt.select('t')).toBe(true)
    await settle(m, 't')
    expect(failures).toEqual(['t'])
    expect(vt.following()).toEqual([])
    m.data('t', 'more\r\n')
    await settle(m, 't')
    expect(sent).toEqual([])
    broken = false
    expect(vt.select('t')).toBe(true)
    await settle(m, 't')
    expect(sent[0]?.t).toBe('term.snapshot')
  })

  it('a snapshot above the frame cap arrives in parts and is reassembled identical to the mirror', async () => {
    m = mirror()
    m.start()
    m.spawned('t', 80, 24)
    const rand = rng(3)
    for (const chunk of chunks(tuiStream(rand, 200), rand)) m.data('t', chunk)
    await settle(m, 't')
    const { vt, sent, pages } = view(undefined, 4096)
    vt.select('t')
    m.data('t', 'live after the join\r\n')
    await settle(m, 't')
    const parts = sent.filter((f): f is TermSnapshotFrame => f.t === 'term.snapshot')
    expect(parts.length).toBeGreaterThan(5)
    expect(parts.every((p) => p.parts === parts.length)).toBe(true)
    expect(pages.get('t')!.seq).toBe(m.seq('t'))
    expect(await pages.get('t')!.text()).toBe(await mirrorText(m, 't'))
  })
})
