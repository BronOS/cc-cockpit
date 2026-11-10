// Turning web access on and off at runtime (plan Task 13, design-web.md §5.2): tabs already running
// get a baseline in the mirror and their flow goes to main; turning off hands every tab back to the
// desktop's acks once the desktop has all its output, ends the remote views and the worker.
// TabManager + TerminalMirror (a real HeadlessTerms behind FakeWorker) + desktop pages modelled as
// headless xterms that ack what they parsed, as terminal-session.ts does.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/headless'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FLUSH_BYTES, HIGH_WATER, LOW_WATER, PtyService } from '../../src/main/pty/pty-service'
import { TabManager } from '../../src/main/tabs/tab-manager'
import { VIEW_HIGH_WATER } from '../../src/main/terminals/desktop-flow'
import { TerminalMirror } from '../../src/main/terminals/mirror'
import { ViewTerminals } from '../../src/main/web/view-terminals'
import type { EventChannel, IpcEventMap } from '../../src/shared/ipc'
import { FakeWorker } from '../fakes/fake-mirror-worker'
import { FakePtyBackend, type FakePty } from '../fakes/fake-pty-backend'

const P = 'aaaaaaaaaaaaaaaa'
const RIS = '\x1bc'

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
  t.resize(state.cols, state.rows)
  await written(t, state.data)
  return text(t)
}

/** 64 KiB of numbered 32-character lines: one flush each, and every line tells where it came from. */
function chunk(n: number): string {
  let out = ''
  for (let i = 0; i < FLUSH_BYTES / 32; i++) out += `${String(n * 10_000 + i).padStart(8, '0')} ${'abcdefghijklmnopqrstu'}\r\n`
  return out
}

/** A desktop page's terminal for one tab: live output acked once parsed, a snapshot never acked. */
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
let workers: FakeWorker[]
let logs: string[]
let mirror: TerminalMirror | undefined

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-toggle-')))
  backend = new FakePtyBackend()
  workers = []
  logs = []
})
afterEach(() => {
  mirror?.stop()
  mirror = undefined
  rmSync(root, { recursive: true, force: true })
})

function setup(options: { drainMs?: number } = {}) {
  const m = new TerminalMirror({
    createWorker: () => {
      const w = new FakeWorker()
      workers.push(w)
      return w
    },
    log: (l) => logs.push(l),
    drainMs: options.drainMs,
    drainPollMs: 5
  })
  mirror = m
  const pages = new Map<string, DesktopPage>()
  /** Every chunk the pty produced, per tab, in order: what the desktop must end up showing. */
  const truth = new Map<string, Terminal>()
  const tabs: TabManager = new TabManager({
    backend,
    projectPath: (id) => (id === P ? root : undefined),
    loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/u' }),
    hooksPath: '/data/hooks.json',
    binDir: '/data/bin',
    sock: () => undefined,
    emit: <C extends EventChannel>(_p: string, channel: C, payload: IpcEventMap[C]) => {
      if (channel !== 'tabs.data') return
      const p = payload as IpcEventMap['tabs.data']
      pages.get(p.tabId)?.data(p)
    },
    log: (l) => logs.push(l),
    terminalTap: m
  })
  /** A shell tab with its page and its reference terminal; `pty` emits through both. */
  const open = (): { id: string; pty: FakePty; page: DesktopPage; emit: (data: string) => void } => {
    const tab = tabs.create(P, { kind: 'shell' })
    const page = new DesktopPage((n) => tabs.ack(P, tab.id, n))
    pages.set(tab.id, page)
    const ref = term()
    truth.set(tab.id, ref)
    const pty = backend.last
    return {
      id: tab.id,
      pty,
      page,
      emit: (data) => {
        ref.write(data)
        pty.emit(data)
      }
    }
  }
  const truthText = async (tabId: string): Promise<string> => {
    const t = truth.get(tabId)!
    await written(t)
    return text(t)
  }
  return { m, tabs, open, truthText }
}

/** Output the way a real pty gives it: a chunk whenever the pty is not paused. Throws when it stays paused. */
async function flood(tab: { pty: FakePty; emit: (data: string) => void }, chars: number, from: number): Promise<number> {
  let sent = 0
  let n = from
  const deadline = Date.now() + 10_000
  while (sent < chars) {
    if (tab.pty.paused) {
      if (Date.now() > deadline) throw new Error('the pty stayed paused')
      await tick()
      continue
    }
    const c = chunk(n++)
    tab.emit(c)
    sent += c.length
  }
  return n
}

describe('PtyService: what a toggle needs from the pty', () => {
  function service(): { pty: PtyService; handle: () => FakePty } {
    const b = new FakePtyBackend()
    const pty = new PtyService({ backend: b, sink: { data: () => undefined, exit: () => undefined } })
    pty.spawn('t', ['/bin/sh'], { cwd: '/', env: {}, cols: 80, rows: 24 })
    return { pty, handle: () => b.last }
  }

  it('knows the size the running pty has now, and nothing for an unknown one', () => {
    const { pty } = service()
    expect(pty.sizeOf('t')).toEqual({ cols: 80, rows: 24 })
    expect(pty.resize('t', 120, 40)).toBe(true)
    expect(pty.sizeOf('t')).toEqual({ cols: 120, rows: 40 })
    // A refused size is not taken.
    expect(pty.resize('t', 0, 40)).toBe(false)
    expect(pty.sizeOf('t')).toEqual({ cols: 120, rows: 40 })
    expect(pty.sizeOf('x')).toBeUndefined()
  })

  it('a flow switch starts the count at what the new consumer owes: paused past HIGH_WATER, resumed at LOW_WATER', () => {
    const { pty, handle } = service()
    expect(pty.setFlow('t', 'main')).toBe(true)
    expect(pty.setFlow('t', 'view', HIGH_WATER + 1)).toBe(true)
    expect(pty.unackedOf('t')).toBe(HIGH_WATER + 1)
    expect(handle().paused).toBe(true)
    pty.ack('t', HIGH_WATER + 1 - LOW_WATER)
    expect(handle().paused).toBe(false)
    // Garbage is no debt.
    pty.setFlow('t', 'main', Number.NaN)
    expect(pty.unackedOf('t')).toBe(0)
    pty.setFlow('t', 'view', -5)
    expect(pty.unackedOf('t')).toBe(0)
  })
})

describe('turning on: running tabs from a baseline', () => {
  it('several running tabs: each gets a blank baseline at its current size, numbered from 1, and main takes its flow', async () => {
    const { m, tabs, open } = setup()
    const a = open()
    const b = open()
    const c = open()
    tabs.resize(P, b.id, 100, 30)
    for (const t of [a, b, c]) t.emit(`before ${t.id}\r\n`)
    await wait(20)
    m.start()
    for (const t of [a, b, c]) {
      expect(m.seq(t.id)).toBe(1)
      expect(m.size(t.id)).toEqual(t === b ? { cols: 100, rows: 30 } : { cols: 80, rows: 24 })
      expect(workers[0]!.items(t.id)).toEqual([{ seq: 1, kind: 'spawn', ...m.size(t.id)! }])
    }
    for (const t of [a, b, c]) t.emit(`after ${t.id}\r\n`)
    await wait(20)
    for (const t of [a, b, c]) {
      await m.whenParsed(t.id)
      const copy = await mirrorText(m, t.id)
      // The copy is what the pty sent after the baseline (documented): the earlier output is the desktop's only.
      expect(copy).toContain(`after ${t.id}`)
      expect(copy).not.toContain(`before ${t.id}`)
      await written(t.page.t)
      expect(text(t.page.t)).toContain(`before ${t.id}`)
      expect(text(t.page.t)).toContain(`after ${t.id}`)
    }
    // Main consumes the ptys now: a desktop that stops acking no longer pauses Claude.
    a.page.holdAcks = true
    await flood(a, 3 * HIGH_WATER, 0)
    await m.whenParsed(a.id)
    await tick()
    expect(a.pty.paused).toBe(false)
  })

  it('a tab that exited is not taken; one restarted later is, from its spawn', async () => {
    const { m, tabs, open } = setup()
    const a = open()
    const b = open()
    // A shell that exits right after it started stays as an exited tab (SHELL_MIN_LIFE_MS).
    b.pty.exit(1)
    m.start()
    expect(m.seq(a.id)).toBe(1)
    expect(m.seq(b.id)).toBeUndefined()
    tabs.restart(P, b.id)
    expect(m.seq(b.id)).toBe(1)
  })

  it('a desktop that already owes output keeps that debt: its acks for it land on its own count', async () => {
    const { m, tabs, open } = setup()
    const a = open()
    a.page.holdAcks = true
    await flood(a, HIGH_WATER / 2, 0)
    await wait(20)
    m.start()
    // The pty is main's now; the desktop's count carried over (no fresh double allowance).
    a.page.holdAcks = false
    await a.page.release()
    expect(tabs.list(P)).toHaveLength(1)
    a.page.holdAcks = true
    await flood(a, 2 * VIEW_HIGH_WATER, 100)
    await m.whenParsed(a.id)
    // Everything the desktop got live, the old debt included, stays within its limit plus one chunk.
    expect(a.page.received - HIGH_WATER / 2).toBeLessThanOrEqual(VIEW_HIGH_WATER + FLUSH_BYTES)
  })
})

describe('turning on while a desktop is deep in debt', () => {
  it('the pty stays the desktop\'s until its page caught up, then main takes it; the page is never resynced from the blank copy', async () => {
    const { m, open, truthText } = setup()
    const a = open()
    a.page.holdAcks = true
    let n = 0
    let guard = 0
    while (!a.pty.paused && guard++ < 100) a.emit(chunk(n++))
    // Paused on the page: it owes more than HIGH_WATER (a background window during output).
    expect(a.pty.paused).toBe(true)
    m.start()
    expect(m.seq(a.id)).toBe(1)
    // Not taken: still paused until the page acks, as with web access off.
    await m.whenParsed(a.id)
    await tick()
    expect(a.pty.paused).toBe(true)
    // The page catches up: the pty resumes, and main takes it (its debt is under VIEW_LOW_WATER now).
    a.page.holdAcks = false
    await a.page.release()
    expect(a.pty.paused).toBe(false)
    const before = m.seq(a.id)!
    a.emit('after catching up\r\n')
    await until(() => m.seq(a.id)! > before)
    await written(a.page.t)
    expect(a.page.snapshots).toBe(0)
    expect(text(a.page.t)).toBe(await truthText(a.id))
    // Main's now: a page that stops acking no longer pauses the pty.
    a.page.holdAcks = true
    await flood(a, 3 * HIGH_WATER, n)
    await m.whenParsed(a.id)
    await tick()
    expect(a.pty.paused).toBe(false)
  })
})

describe('toggling while a tab floods', () => {
  it('on, then off, mid-flood: the pty never sticks and the desktop ends up with the whole stream', async () => {
    const { m, open, truthText } = setup()
    const a = open()
    let n = await flood(a, 2 * HIGH_WATER, 0)
    m.start()
    n = await flood(a, 4 * HIGH_WATER, n)
    const off = m.drain()
    n = await flood(a, 2 * HIGH_WATER, n)
    await off
    expect(m.running).toBe(false)
    await flood(a, 2 * HIGH_WATER, n)
    await until(() => !a.pty.paused)
    await written(a.page.t)
    // While main consumed the pty the flood outran the page now and then, and it was resynced from
    // the copy (never dropped at the toggle: the drain waited for it): it shows exactly the stream.
    expect(text(a.page.t)).toBe(await truthText(a.id))
    expect(logs.some((l) => l.includes('stale'))).toBe(false)
    expect(workers[0]!.terminated).toBe(true)
  })

  it('off while the desktop is behind: the tab stays held until the desktop is resynced, then goes back to it', async () => {
    const { m, open, truthText } = setup()
    const a = open()
    const b = open()
    m.start()
    b.emit('quiet tab\r\n')
    a.page.holdAcks = true
    let n = await flood(a, 3 * VIEW_HIGH_WATER, 0)
    await m.whenParsed(a.id)
    const off = m.drain()
    let done = false
    void off.then(() => (done = true))
    await wait(30)
    // The live desktop's tab went back at once; the one behind is still the mirror's.
    expect(m.seq(b.id)).toBeUndefined()
    expect(m.seq(a.id)).toBeDefined()
    expect(m.turningOff).toBe(true)
    expect(done).toBe(false)
    // The page catches up: resynced from the copy, live again, released; the mirror ends.
    a.page.holdAcks = false
    await a.page.release()
    await off
    expect(a.page.snapshots).toBe(1)
    expect(m.running).toBe(false)
    expect(logs.some((l) => l.includes('stale'))).toBe(false)
    // Today's path from here: the desktop's acks pause the pty again.
    n = await flood(a, 2 * HIGH_WATER, n)
    a.page.holdAcks = true
    let guard = 0
    while (!a.pty.paused && guard++ < 100) a.emit(chunk(n++))
    expect(a.pty.paused).toBe(true)
    a.page.holdAcks = false
    await a.page.release()
    expect(a.pty.paused).toBe(false)
    await written(a.page.t)
    // What the resync could not bring back (before the baseline) has scrolled out of the 5,000 lines.
    expect(text(a.page.t)).toBe(await truthText(a.id))
  })

  it('off with a desktop that never catches up: released at the deadline, logged, the pty is the desktop\'s', async () => {
    const { m, open } = setup({ drainMs: 60 })
    const a = open()
    m.start()
    a.page.holdAcks = true
    await flood(a, 3 * VIEW_HIGH_WATER, 0)
    await m.whenParsed(a.id)
    await m.drain()
    expect(m.running).toBe(false)
    expect(logs.some((l) => l.includes('not resynced in time'))).toBe(true)
    expect(logs.some((l) => l.includes('its screen may be stale'))).toBe(true)
    // The desktop's unacked output is the pty's count again: it stays paused until the page acks.
    a.emit(chunk(999))
    expect(a.pty.paused).toBe(true)
    await a.page.release()
    expect(a.pty.paused).toBe(false)
  })
})

describe('turning off with remote views', () => {
  it('a remote view attached is ended, the worker goes, and a late join finds nothing', async () => {
    const { m, open } = setup()
    const a = open()
    m.start()
    a.emit('hello remote\r\n')
    await wait(20)
    const frames: string[] = []
    const vt = new ViewTerminals({ mirror: m, canFollow: () => true, send: (f) => frames.push(f.t) })
    expect(vt.select(a.id)).toBe(true)
    await until(() => frames.includes('term.snapshot'))
    expect(vt.following()).toEqual([a.id])
    await m.drain()
    // The view's join ended with the mirror; a rejoin found the tab no longer held.
    expect(vt.following()).toEqual([])
    expect(vt.select(a.id)).toBe(false)
    expect(m.running).toBe(false)
    expect(workers[0]!.terminated).toBe(true)
    vt.dispose()
  })
})

describe('a toggle during a drain', () => {
  it('on again while draining: the drain is called off, the worker stays, released tabs are taken back from a new baseline', async () => {
    const { m, open } = setup()
    const a = open()
    const b = open()
    m.start()
    a.page.holdAcks = true
    await flood(a, 3 * VIEW_HIGH_WATER, 0)
    await m.whenParsed(a.id)
    const off = m.drain()
    await wait(20)
    expect(m.seq(b.id)).toBeUndefined()
    const before = m.seq(a.id)!
    m.start()
    await off
    expect(m.turningOff).toBe(false)
    expect(m.running).toBe(true)
    expect(workers).toHaveLength(1)
    // b: a fresh stream (the worker freed its old terminal on release and has reported that close,
    // so it numbers from 1 again); a: the same stream.
    expect(m.seq(b.id)).toBe(1)
    expect(m.seq(a.id)).toBe(before)
    a.page.holdAcks = false
    await a.page.release()
    await until(() => a.page.snapshots === 1)
  })

  it('on again in the same turn a drain released a tab: the old stream\'s late answers are not the new one\'s, the flood never stalls', async () => {
    const { m, open } = setup()
    const a = open()
    const b = open()
    m.start()
    // a's desktop is behind, so the drain below waits on it and keeps the worker.
    a.page.holdAcks = true
    await flood(a, 3 * VIEW_HIGH_WATER, 0)
    await m.whenParsed(a.id)
    // b's desktop is live (under its limit), with items posted and not parsed when the drain releases it.
    let n = 0
    for (let i = 0; i < 10; i++) b.emit(chunk(n++))
    const old = m.seq(b.id)!
    expect(old).toBeGreaterThan(10)
    expect(m.parsed(b.id)!).toBeLessThan(old)
    const off = m.drain()
    expect(m.seq(b.id)).toBeUndefined()
    // In the same turn: the worker has not answered for b's old stream (its data, its close).
    m.start()
    expect(workers).toHaveLength(1)
    // The baseline comes after the close (old + 1), so nothing the old stream reports moves it.
    expect(m.seq(b.id)).toBe(old + 2)
    expect(m.parsed(b.id)).toBe(old + 1)
    await off
    for (let i = 0; i < 5; i++) {
      await tick()
      expect(m.parsed(b.id)!).toBeLessThanOrEqual(m.seq(b.id)!)
    }
    expect(m.parsed(b.id)!).toBeLessThanOrEqual(m.seq(b.id)!)
    // Main consumes b's pty again: a page that stops acking cannot pause it, and the worker's real
    // `parsed` keeps it going (no watchdog restart).
    b.page.holdAcks = true
    await flood(b, 4 * HIGH_WATER, n)
    await m.whenParsed(b.id)
    expect(m.parsed(b.id)).toBe(m.seq(b.id))
    expect(m.inflightItems(b.id)).toBe(0)
    expect(logs.some((l) => l.includes('worker ended'))).toBe(false)
    expect(workers).toHaveLength(1)
    // A view joining now gets a snapshot that meets the stream, matching the copy.
    const frames: string[] = []
    const vt = new ViewTerminals({ mirror: m, canFollow: () => true, send: (f) => frames.push(f.t) })
    expect(vt.select(b.id)).toBe(true)
    await until(() => frames.includes('term.snapshot'))
    expect(logs.some((l) => l.includes('does not meet the stream'))).toBe(false)
    vt.dispose()
    b.page.holdAcks = false
    await b.page.release()
  })

  it('a tab spawned while draining is not taken, a held tab restarting is handed back, a crash ends the drain', async () => {
    const { m, tabs, open } = setup()
    const a = open()
    const b = open()
    m.start()
    a.page.holdAcks = true
    b.page.holdAcks = true
    await flood(a, 3 * VIEW_HIGH_WATER, 0)
    await flood(b, 3 * VIEW_HIGH_WATER, 0)
    await m.whenParsed(a.id)
    await m.whenParsed(b.id)
    const off = m.drain()
    const c = open()
    expect(m.seq(c.id)).toBeUndefined()
    // b's process ends and is started again: its new pty is the desktop's.
    b.pty.exit(0)
    tabs.restart(P, b.id)
    expect(m.seq(b.id)).toBeUndefined()
    expect(m.seq(a.id)).toBeDefined()
    workers[0]!.crash()
    await off
    expect(m.running).toBe(false)
    expect(workers).toHaveLength(1)
  })
})
