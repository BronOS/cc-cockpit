// Main as the pty's flow consumer, and every view resyncing when it falls behind (design-web.md
// §5.2, plan Task 12): TabManager + TerminalMirror (a real HeadlessTerms behind FakeWorker) + the
// desktop page modelled as a headless xterm that acks what it parsed, as terminal-session.ts does.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/headless'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FLUSH_BYTES, HIGH_WATER } from '../../src/main/pty/pty-service'
import { TabManager } from '../../src/main/tabs/tab-manager'
import { DesktopFlow, MAX_REJOINS, VIEW_HIGH_WATER, VIEW_LOW_WATER } from '../../src/main/terminals/desktop-flow'
import {
  MAX_BACKLOG_CHARS,
  TerminalMirror,
  type MirrorSnapshot,
  type MirrorView,
  type MirrorWorkerLike
} from '../../src/main/terminals/mirror'
import type { FromWorker, MirrorItem, ToWorker } from '../../src/main/terminals/mirror-protocol'
import { ViewTerminals } from '../../src/main/web/view-terminals'
import type { EventChannel, IpcEventMap } from '../../src/shared/ipc'
import type { TermDataFrame, TermSnapshotFrame } from '../../src/shared/web-protocol'
import { FakeWorker } from '../fakes/fake-mirror-worker'
import { FakePtyBackend, type FakePty } from '../fakes/fake-pty-backend'

const P = 'aaaaaaaaaaaaaaaa'
const RIS = '\x1bc'

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait until `done` holds (a snapshot of 5,000 lines takes the worker a while), or fail. */
async function until(done: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await wait(5)
  }
}

function term(): Terminal {
  const t = new Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true })
  t.loadAddon(new Unicode11Addon())
  t.unicode.activeVersion = '11'
  return t
}

const written = (t: Terminal, data = ''): Promise<void> => new Promise((resolve) => t.write(data, resolve))

/** Every line of the active buffer (scrollback too) and the cursor, as text. */
function text(t: Terminal): string {
  const buf = t.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return `${buf.type} ${t.cols}x${t.rows} cursor ${buf.cursorX},${buf.cursorY}\n${lines.join('\n')}`
}

async function mirrorText(m: TerminalMirror, tabId: string): Promise<string> {
  const state = (await m.inspect(tabId))!
  const t = term()
  await written(t, state.data)
  return text(t)
}

/** 64 KiB of numbered 32-character lines: one flush each, and every line tells where it came from. */
function chunk(n: number): string {
  let out = ''
  for (let i = 0; i < FLUSH_BYTES / 32; i++) out += `${String(n * 10_000 + i).padStart(8, '0')} ${'abcdefghijklmnopqrstu'}\r\n`
  return out
}

/**
 * The desktop page as main sees it: `tabs.data` into an xterm, each live write acked once parsed
 * (TerminalSession.write), a snapshot (`reset`) written after a full reset and never acked. Acks are
 * held while `holdAcks` is set (a page that cannot keep up), and sent with `release`.
 */
class DesktopPage {
  readonly t = term()
  received = 0
  snapshots = 0
  holdAcks = false
  private held = 0

  constructor(private readonly ack: (count: number) => void) {}

  data(payload: IpcEventMap['tabs.data']): void {
    if (payload.reset) {
      this.snapshots++
      this.t.write(`${RIS}${payload.data}`)
      return
    }
    this.received += payload.data.length
    this.t.write(payload.data, () => {
      if (this.holdAcks) this.held += payload.data.length
      else this.ack(payload.data.length)
    })
  }

  async release(): Promise<void> {
    await written(this.t)
    const n = this.held
    this.held = 0
    if (n > 0) this.ack(n)
  }
}

let root: string
let backend: FakePtyBackend
let workers: MirrorWorkerLike[]
let logs: string[]

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-flow-')))
  backend = new FakePtyBackend()
  workers = []
  logs = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A worker that takes everything and never answers (hung, or drowning). */
class StalledWorker implements MirrorWorkerLike {
  readonly received: ToWorker[] = []
  terminated = false
  post(message: ToWorker): void {
    this.received.push(message)
  }
  onMessage(): void {}
  onExit(listener: (reason: string) => void): void {
    this.exit = listener
  }
  exit: (reason: string) => void = () => undefined
  terminate(): void {
    this.terminated = true
  }
}

function setup(worker: () => MirrorWorkerLike = () => new FakeWorker(), options: { stallMs?: number } = {}) {
  const mirror = new TerminalMirror({
    createWorker: () => {
      const w = worker()
      workers.push(w)
      return w
    },
    log: (m) => logs.push(m),
    stallMs: options.stallMs
  })
  let page: DesktopPage | undefined
  const events: Array<IpcEventMap['tabs.data']> = []
  const tabs: TabManager = new TabManager({
    backend,
    projectPath: (id) => (id === P ? root : undefined),
    loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/u' }),
    hooksPath: '/data/hooks.json',
    binDir: '/data/bin',
    sock: () => undefined,
    emit: <C extends EventChannel>(_p: string, channel: C, payload: IpcEventMap[C]) => {
      if (channel !== 'tabs.data') return
      events.push(payload as IpcEventMap['tabs.data'])
      page?.data(payload as IpcEventMap['tabs.data'])
    },
    log: (m) => logs.push(m),
    terminalTap: mirror
  })
  const newPage = (tabId: string): DesktopPage => (page = new DesktopPage((n) => tabs.ack(P, tabId, n)))
  return { mirror, tabs, events, newPage }
}

/**
 * Output the way a real pty gives it: a chunk whenever the pty is not paused, waiting for the
 * consumer otherwise. Returns the characters produced; throws when the pty stays paused.
 */
async function flood(pty: FakePty, chars: number, from = 0): Promise<number> {
  let sent = 0
  let n = from
  const deadline = Date.now() + 10_000
  while (sent < chars) {
    if (pty.paused) {
      if (Date.now() > deadline) throw new Error('the pty stayed paused')
      await tick()
      continue
    }
    const c = chunk(n++)
    pty.emit(c)
    sent += c.length
  }
  return sent
}

describe('web access off: the desktop is the flow consumer, as before', () => {
  it('every chunk reaches the desktop, its missing acks pause the pty, its acks and a re-attach resume it', () => {
    const { tabs, events } = setup()
    const tab = tabs.create(P, { kind: 'shell' })
    const pty = backend.last
    const paused = (): boolean => pty.paused
    for (let n = 0; !paused(); n++) pty.emit(chunk(n))
    expect(events.every((e) => e.reset === undefined)).toBe(true)
    expect(events.reduce((sum, e) => sum + e.data.length, 0)).toBe(HIGH_WATER + FLUSH_BYTES)
    tabs.ack(P, tab.id, HIGH_WATER + FLUSH_BYTES)
    expect(pty.paused).toBe(false)
    for (let n = 0; !paused(); n++) pty.emit(chunk(n))
    tabs.attach(P)
    expect(pty.paused).toBe(false)
    expect(events.some((e) => e.reset)).toBe(false)
  })
})

describe('web access on: main consumes the pty, the desktop drops and resyncs', () => {
  let m: TerminalMirror | undefined
  afterEach(() => m?.stop())

  it('a desktop that stops acking neither pauses the pty nor gets output past its limit; caught up, it matches the mirror', async () => {
    const s = setup()
    m = s.mirror
    m.start()
    const tab = s.tabs.create(P, { kind: 'shell' })
    const page = s.newPage(tab.id)
    page.holdAcks = true
    const pty = backend.last
    // Far past the pty's own limit: only the worker's acks let it through.
    const produced = await flood(pty, 4 * HIGH_WATER)
    expect(produced).toBeGreaterThanOrEqual(4 * HIGH_WATER)
    await m.whenParsed(tab.id)
    await tick()
    expect(pty.paused).toBe(false)
    // The desktop stopped getting live output at its limit (one chunk over at most).
    expect(page.received).toBeLessThanOrEqual(VIEW_HIGH_WATER + FLUSH_BYTES)
    expect(page.snapshots).toBe(0)
    // It catches up: everything it got is acked, so it is resynced with a snapshot.
    page.holdAcks = false
    await page.release()
    await until(() => page.snapshots === 1)
    // Back to the direct path: later output reaches it as it is flushed, not through the mirror.
    pty.emit('after the resync\r\n')
    await wait(20)
    expect(s.events.at(-1)).toEqual({ tabId: tab.id, data: 'after the resync\r\n' })
    await written(page.t)
    expect(text(page.t)).toBe(await mirrorText(m, tab.id))
  })

  it('a resync while output keeps coming: the snapshot, then the items after it, no gap and no double', async () => {
    const s = setup()
    m = s.mirror
    m.start()
    const tab = s.tabs.create(P, { kind: 'shell' })
    const page = s.newPage(tab.id)
    page.holdAcks = true
    const pty = backend.last
    await flood(pty, 2 * VIEW_HIGH_WATER)
    page.holdAcks = false
    await page.release()
    // Output while the snapshot is on its way is held for the desktop and delivered after it.
    for (let n = 500; n < 510; n++) pty.emit(`late ${n}\r\n`)
    await until(() => page.snapshots === 1)
    await wait(20)
    await m.whenParsed(tab.id)
    await written(page.t)
    expect(text(page.t)).toBe(await mirrorText(m, tab.id))
  })

  it('a page re-attaching gets a snapshot instead of a flow reset: its screen comes back', async () => {
    const s = setup()
    m = s.mirror
    m.start()
    const tab = s.tabs.create(P, { kind: 'shell' })
    s.newPage(tab.id)
    backend.last.emit('before the reload\r\nprompt$ ')
    // Flushed after FLUSH_MS, then parsed.
    await wait(20)
    await m.whenParsed(tab.id)
    // A reload: a fresh page with an empty terminal asks for its tabs again.
    const fresh = s.newPage(tab.id)
    s.tabs.attach(P)
    await until(() => fresh.snapshots === 1)
    await written(fresh.t)
    expect(text(fresh.t)).toContain('before the reload')
    expect(text(fresh.t)).toBe(await mirrorText(m, tab.id))
  })

  it("the mirror stopping hands the pty back to the desktop's acks", async () => {
    const s = setup()
    m = s.mirror
    m.start()
    const tab = s.tabs.create(P, { kind: 'shell' })
    const page = s.newPage(tab.id)
    page.holdAcks = true
    await flood(backend.last, 2 * VIEW_HIGH_WATER)
    m.stop()
    expect(logs.some((l) => l.includes('released while the desktop was behind'))).toBe(true)
    // The pty counts what the desktop still owes (its limit's worth): the next chunk pauses it, until
    // the page acks what it was sent.
    const pty = backend.last
    pty.emit(chunk(0))
    expect(pty.paused).toBe(true)
    page.holdAcks = false
    await page.release()
    expect(pty.paused).toBe(false)
    // Today's path: every chunk to the desktop, the desktop's missing acks pause the pty.
    page.holdAcks = true
    const before = s.events.length
    for (let n = 0; !pty.paused; n++) pty.emit(chunk(n))
    expect(s.events.length - before).toBe(HIGH_WATER / FLUSH_BYTES + 1)
    page.holdAcks = false
    await page.release()
    expect(pty.paused).toBe(false)
  })

  it('a closed tab gives its pty back (an exit drains), and a restart is taken again', async () => {
    const s = setup()
    m = s.mirror
    m.start()
    const tab = s.tabs.create(P, { kind: 'shell' })
    expect(m.seq(tab.id)).toBe(1)
    backend.last.exit(0)
    s.tabs.restart(P, tab.id)
    // The restarted process's pty is main's too: a desktop that never acks cannot pause it.
    const page = s.newPage(tab.id)
    page.holdAcks = true
    await flood(backend.last, 2 * HIGH_WATER)
    expect(page.received).toBeLessThanOrEqual(VIEW_HIGH_WATER + FLUSH_BYTES)
  })
})

describe("main's buffers stay bounded under a flood", () => {
  let m: TerminalMirror | undefined
  afterEach(() => m?.stop())

  it('a worker that does not keep up pauses the pty at its limit: inflight and held stop growing', async () => {
    const s = setup(() => new StalledWorker())
    m = s.mirror
    m.start()
    const tab = s.tabs.create(P, { kind: 'shell' })
    const page = s.newPage(tab.id)
    page.holdAcks = true
    // A remote view joins and waits for a snapshot that will not come.
    const view: MirrorView = { snapshot: () => undefined, item: () => undefined, closed: () => undefined }
    expect(m.join(tab.id, view)).toBeDefined()
    const pty = backend.last
    for (let n = 0; n < 100 && !pty.paused; n++) pty.emit(chunk(n))
    expect(pty.paused).toBe(true)
    // Data the kernel had already read when the pty paused still arrives.
    pty.emit(chunk(200))
    expect(m.backlog(tab.id)).toBeLessThanOrEqual(HIGH_WATER + 2 * FLUSH_BYTES)
    expect(m.inflightItems(tab.id)).toBeLessThanOrEqual(HIGH_WATER / FLUSH_BYTES + 3)
    expect(m.heldItems(tab.id)).toBeLessThanOrEqual(m.inflightItems(tab.id))
    expect(page.received).toBeLessThanOrEqual(VIEW_HIGH_WATER + FLUSH_BYTES)
  })

  it('a worker restart acks what the old one never parsed: the pty resumes', () => {
    const s = setup(() => new StalledWorker())
    m = s.mirror
    m.start()
    s.tabs.create(P, { kind: 'shell' })
    const pty = backend.last
    for (let n = 0; n < 100 && !pty.paused; n++) pty.emit(chunk(n))
    expect(pty.paused).toBe(true)
    ;(workers[0] as StalledWorker).exit('exit code 1')
    expect(pty.paused).toBe(false)
    expect(workers).toHaveLength(2)
  })

  it('past MAX_BACKLOG_CHARS (no flow control bound) the worker counts as drowned and starts afresh', () => {
    m = new TerminalMirror({
      createWorker: () => {
        const w = new StalledWorker()
        workers.push(w)
        return w
      },
      log: (l) => logs.push(l)
    })
    m.start()
    m.spawned('t', 80, 24)
    const piece = 'x'.repeat(FLUSH_BYTES)
    for (let sent = 0; sent <= MAX_BACKLOG_CHARS; sent += piece.length) m.data('t', piece)
    expect((workers[0] as StalledWorker).terminated).toBe(true)
    expect(workers).toHaveLength(2)
    expect(m.backlog('t')).toBe(0)
    expect(m.inflightItems('t')).toBe(0)
    expect(logs.some((l) => l.includes('behind'))).toBe(true)
  })

  it('a worker that stops answering is restarted: the paused pty resumes and the desktop is resynced and live', async () => {
    // The first worker hangs (takes everything, answers nothing); the restarted one works.
    const s = setup(() => (workers.length === 0 ? new StalledWorker() : new FakeWorker()), { stallMs: 50 })
    m = s.mirror
    m.start()
    const tab = s.tabs.create(P, { kind: 'shell' })
    const page = s.newPage(tab.id)
    const pty = backend.last
    // Main stops reading at its limit (the copy is not parsing), the desktop past its own.
    for (let n = 0; !pty.paused; n++) pty.emit(chunk(n))
    expect(pty.paused).toBe(true)
    // Without the stall check this stays paused forever: nothing ever acks it.
    await until(() => !pty.paused)
    expect((workers[0] as StalledWorker).terminated).toBe(true)
    expect(workers).toHaveLength(2)
    expect(logs.some((l) => l.includes('no answer in 50 ms'))).toBe(true)
    // Its resync (asked of the hung worker) is answered by the new one: the desktop is live again.
    await until(() => page.snapshots === 1)
    pty.emit('after the restart\r\n')
    await wait(20)
    expect(s.events.at(-1)).toEqual({ tabId: tab.id, data: 'after the restart\r\n' })
  })

  /** A desktop dropped at its limit that caught up and now waits for a snapshot the stalled worker never sends. */
  async function joiningOnStalledWorker() {
    const s = setup(() => new StalledWorker())
    m = s.mirror
    m.start()
    const tab = s.tabs.create(P, { kind: 'shell' })
    s.newPage(tab.id)
    const pty = backend.last
    for (let n = 0; !pty.paused; n++) pty.emit(chunk(n))
    const stalled = workers[0] as StalledWorker
    await until(() => stalled.received.some((msg) => msg.t === 'snapshot'))
    return { s, tab }
  }

  it('web access going off while the desktop waits for its resync logs that its screen may be stale', async () => {
    await joiningOnStalledWorker()
    m!.stop()
    expect(logs.some((l) => l.includes('released while the desktop was behind'))).toBe(true)
  })

  it('a tab closed while the desktop waits for its resync is just gone (no stale-screen log)', async () => {
    const { s, tab } = await joiningOnStalledWorker()
    s.tabs.close(P, tab.id)
    expect(logs.some((l) => l.includes('released while the desktop was behind'))).toBe(false)
    expect(m!.seq(tab.id)).toBeUndefined()
  })
})

/** A worker the test answers by hand: which items it parsed, and when the snapshot is taken. */
class ManualWorker implements MirrorWorkerLike {
  readonly received: ToWorker[] = []
  terminated = false
  private listener: (m: FromWorker) => void = () => undefined
  post(message: ToWorker): void {
    this.received.push(message)
  }
  onMessage(listener: (m: FromWorker) => void): void {
    this.listener = listener
  }
  onExit(): void {}
  terminate(): void {
    this.terminated = true
  }
  send(message: FromWorker): void {
    this.listener(message)
  }
  snapshotIds(): number[] {
    return this.received.flatMap((m) => (m.t === 'snapshot' ? [m.id] : []))
  }
}

describe('held items of a waiting view', () => {
  it('are pruned to the items after the parsed seq, and the snapshot still meets the stream', () => {
    const worker = new ManualWorker()
    const acks: Array<[string, number]> = []
    const m = new TerminalMirror({ createWorker: () => worker, log: (l) => logs.push(l) })
    m.bindFlow({ take: () => undefined, ack: (id, n) => acks.push([id, n]), release: () => undefined })
    m.start()
    m.spawned('t', 80, 24)
    for (let i = 0; i < 5; i++) m.data('t', `a${i}`)
    const got: Array<MirrorSnapshot | MirrorItem> = []
    m.join('t', { snapshot: (s) => got.push(s), item: (i) => got.push(i), closed: () => got.push({ seq: -1, kind: 'close' }) })
    for (let i = 0; i < 5; i++) m.data('t', `b${i}`)
    expect(m.heldItems('t')).toBe(11)
    worker.send({ t: 'parsed', tabId: 't', seq: 8 })
    expect(m.heldItems('t')).toBe(3)
    expect(m.inflightItems('t')).toBe(3)
    // The parsed characters were acked to the pty (data items 2..8: seven chunks of two).
    expect(acks).toEqual([['t', 14]])
    worker.send({ t: 'snapshot', ids: worker.snapshotIds(), tabId: 't', snapshot: { seq: 9, cols: 80, rows: 24, data: 'screen' } })
    expect(got.map((x) => x.seq)).toEqual([9, 10, 11])
    m.stop()
  })
})

describe('the stall check', () => {
  it('a worker that answers in time, or owes nothing, is not hung; one silent while it owes an answer is', async () => {
    const created: ManualWorker[] = []
    const acks: number[] = []
    const m = new TerminalMirror({
      createWorker: () => {
        const w = new ManualWorker()
        created.push(w)
        return w
      },
      log: (l) => logs.push(l),
      stallMs: 100
    })
    m.bindFlow({ take: () => undefined, ack: (_id, n) => acks.push(n), release: () => undefined })
    m.start()
    m.spawned('t', 80, 24)
    created[0]!.send({ t: 'parsed', tabId: 't', seq: 1 })
    // Idle: everything answered, nothing owed, however long.
    await wait(250)
    expect(created).toHaveLength(1)
    // Slow but steady: an answer every 20 ms while one item is always still owed.
    for (let i = 0; i < 12; i++) {
      m.data('t', `x${i}`)
      await wait(20)
      created[0]!.send({ t: 'parsed', tabId: 't', seq: m.seq('t')! - 1 })
    }
    expect(created).toHaveLength(1)
    // 'x11', the one item never answered.
    expect(m.backlog('t')).toBe(3)
    // Silent while it owes an item: hung, restarted, and the backlog acked so the pty resumes.
    await until(() => created.length === 2)
    expect(created[0]!.terminated).toBe(true)
    expect(logs.some((l) => l.includes('no answer in 100 ms'))).toBe(true)
    expect(m.backlog('t')).toBe(0)
    expect(acks.at(-1)).toBe(3)
    m.stop()
  })

  it('stopping ends the check: a stopped mirror restarts nothing', async () => {
    const created: ManualWorker[] = []
    const m = new TerminalMirror({
      createWorker: () => {
        const w = new ManualWorker()
        created.push(w)
        return w
      },
      log: (l) => logs.push(l),
      stallMs: 20
    })
    m.start()
    m.spawned('t', 80, 24)
    m.stop()
    await wait(60)
    expect(created).toHaveLength(1)
    expect(logs.some((l) => l.includes('no answer'))).toBe(false)
  })
})

describe('DesktopFlow on its own', () => {
  function flow(join: (tabId: string, view: MirrorView) => (() => void) | undefined, seq = 0) {
    const out: Array<[string, string, boolean]> = []
    const f = new DesktopFlow({ emit: (id, d, r) => out.push([id, d, r]), join, seq: () => seq, log: (l) => logs.push(l), highWater: 10, lowWater: 4 })
    return { f, out }
  }

  it('holds only taken tabs; a join the mirror refuses leaves the tab live', () => {
    const { f } = flow(() => undefined)
    expect(f.data('x', 'anything')).toBe(true)
    f.take('t')
    expect(f.data('t', '0123456789')).toBe(true)
    expect(f.data('t', 'more')).toBe(false)
    expect(f.modeOf('t')).toBe('behind')
    f.ack('t', 6)
    expect(f.modeOf('t')).toBe('live')
    expect(f.unackedOf('t')).toBe(4)
  })

  it('a snapshot is not counted; a join that ends before its snapshot asks again', () => {
    const views: MirrorView[] = []
    const { f, out } = flow((_id, v) => {
      views.push(v)
      return () => undefined
    }, 5)
    f.take('t')
    f.resync('t')
    expect(f.modeOf('t')).toBe('joining')
    views[0]!.closed()
    expect(views).toHaveLength(2)
    views[0]!.snapshot({ seq: 5, cols: 80, rows: 24, data: 'stale join' })
    expect(out).toEqual([])
    views[1]!.snapshot({ seq: 4, cols: 80, rows: 24, data: 'x'.repeat(100) })
    expect(f.unackedOf('t')).toBe(0)
    views[1]!.item({ seq: 5, kind: 'data', data: 'abc' })
    expect(out).toEqual([
      ['t', 'x'.repeat(100), true],
      ['t', 'abc', false]
    ])
    expect(f.modeOf('t')).toBe('live')
    expect(f.unackedOf('t')).toBe(3)
  })

  it(`joins that keep ending before their snapshot stop after ${MAX_REJOINS}: live again, and logged`, () => {
    const views: MirrorView[] = []
    const { f, out } = flow((_id, v) => {
      views.push(v)
      return () => undefined
    }, 5)
    f.take('t')
    f.resync('t')
    for (let i = 0; i < MAX_REJOINS; i++) views[i]!.closed()
    expect(views).toHaveLength(MAX_REJOINS)
    expect(f.modeOf('t')).toBe('live')
    expect(logs.some((l) => l.includes('could not be resynced'))).toBe(true)
    expect(f.data('t', 'next')).toBe(true)
    expect(out).toEqual([])
    // A later episode tries again from scratch, and a snapshot resets the count.
    f.resync('t')
    views.at(-1)!.closed()
    views.at(-1)!.snapshot({ seq: 5, cols: 80, rows: 24, data: 'screen' })
    expect(f.modeOf('t')).toBe('live')
    expect(views).toHaveLength(MAX_REJOINS + 2)
  })

  it('a rejoin the stopping mirror refuses leaves the tab live but marked: the release logs the stale screen', () => {
    let up = true
    const views: MirrorView[] = []
    const { f } = flow((_id, v) => {
      if (!up) return undefined
      views.push(v)
      return () => undefined
    })
    f.take('t')
    f.resync('t')
    // mirror.stop(): the joins end first (their rejoin finds no mirror), then the release.
    up = false
    views[0]!.closed()
    expect(f.modeOf('t')).toBe('live')
    expect(logs).toEqual([])
    f.release('t')
    expect(logs.some((l) => l.includes('released while the desktop was behind'))).toBe(true)
  })
})

describe('a remote view (ViewTerminals) drops and resyncs on its own acks', () => {
  let m: TerminalMirror | undefined
  afterEach(() => m?.stop())

  /** The page's side: snapshot parts joined, live data written, each live write acked. */
  function page(onAck: (n: number) => void) {
    const t = term()
    const st = { parts: [] as string[], snapshots: 0, liveChars: 0, holdAcks: false, held: 0 }
    const frame = (f: TermSnapshotFrame | TermDataFrame): void => {
      if (f.t === 'term.snapshot') {
        st.parts.push(f.data)
        if (f.part < f.parts) return
        st.snapshots++
        t.write(`${RIS}${st.parts.join('')}`)
        st.parts = []
        return
      }
      if (!('data' in f)) return
      const n = f.data.length
      st.liveChars += n
      t.write(f.data, () => {
        if (st.holdAcks) st.held += n
        else onAck(n)
      })
    }
    return { t, st, frame }
  }

  it('past its limit a view stops getting live frames without pausing the pty; acked down, it gets a snapshot and matches the mirror', async () => {
    const s = setup()
    m = s.mirror
    m.start()
    const tab = s.tabs.create(P, { kind: 'shell' })
    s.newPage(tab.id)
    const p = page((n) => vt.ack(tab.id, n))
    const vt = new ViewTerminals({ mirror: m, canFollow: () => true, send: (f) => p.frame(f) })
    p.st.holdAcks = true
    expect(vt.select(tab.id)).toBe(true)
    await until(() => p.st.snapshots === 1)
    await flood(backend.last, 3 * VIEW_HIGH_WATER)
    await m.whenParsed(tab.id)
    expect(vt.isBehind(tab.id)).toBe(true)
    expect(p.st.liveChars).toBeLessThanOrEqual(VIEW_HIGH_WATER + FLUSH_BYTES)
    expect(backend.last.paused).toBe(false)
    // A page-supplied ack of more than was ever sent (Infinity, NaN) catches nothing up.
    vt.ack(tab.id, Infinity)
    vt.ack(tab.id, Number.NaN)
    expect(vt.isBehind(tab.id)).toBe(true)
    // Caught up: acked down to the low mark, it joins again and gets a fresh snapshot.
    p.st.holdAcks = false
    await written(p.t)
    vt.ack(tab.id, p.st.held - VIEW_LOW_WATER)
    expect(vt.isBehind(tab.id)).toBe(false)
    await until(() => p.st.snapshots === 2)
    backend.last.emit('live again\r\n')
    await wait(20)
    await m.whenParsed(tab.id)
    await written(p.t)
    expect(text(p.t)).toBe(await mirrorText(m, tab.id))
    vt.dispose()
  })

  it('a snapshot larger than the limit does not trip it (snapshots are not counted)', async () => {
    const s = setup()
    m = s.mirror
    m.start()
    const tab = s.tabs.create(P, { kind: 'shell' })
    s.newPage(tab.id)
    await flood(backend.last, 256 * 1024)
    await m.whenParsed(tab.id)
    const p = page((n) => vt.ack(tab.id, n))
    // A limit far below the snapshot's size (5,000 lines of scrollback).
    const vt = new ViewTerminals({ mirror: m, canFollow: () => true, send: (f) => p.frame(f), highWater: 1024, lowWater: 512 })
    vt.select(tab.id)
    await until(() => p.st.snapshots === 1)
    backend.last.emit('small\r\n')
    await wait(20)
    await m.whenParsed(tab.id)
    expect(vt.isBehind(tab.id)).toBe(false)
    expect(p.st.liveChars).toBe('small\r\n'.length)
    vt.dispose()
  })
})
