// Main answers terminal queries (design-web.md §5.2 "Main answers terminal queries", plan Task 14):
// with web access on, the headless copy's replies (DSR, DA, DECRQM) go to the pty, OSC 10/11/12
// colour queries are answered from the app theme, and every view's own replies are stripped from
// its input (TabManager.viewInput), while focus and mouse reports pass from any view. Off, the
// desktop answers as before. TabManager + TerminalMirror (a real HeadlessTerms behind FakeWorker) +
// views modelled as headless xterms that answer queries through their onData, as a page's does.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../src/main/sessions/session-registry'
import { TabManager } from '../../src/main/tabs/tab-manager'
import { oscColorReply, parseCssColor, TerminalMirror } from '../../src/main/terminals/mirror'
import type { FromWorker } from '../../src/main/terminals/mirror-protocol'
import { HeadlessTerms } from '../../src/main/terminals/mirror-worker'
import type { EventChannel, IpcEventMap } from '../../src/shared/ipc'
import type { XtermTheme } from '../../src/shared/theme'
import { FakeWorker } from '../fakes/fake-mirror-worker'
import { FakePtyBackend, type FakePty } from '../fakes/fake-pty-backend'

const P = 'aaaaaaaaaaaaaaaa'
const ESC = '\x1b'
const ST = `${ESC}\\`

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function until(done: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await wait(5)
  }
}

/** What Claude Code's TUI asks at startup, more or less: background colour, a mode, the cursor, DA1. */
const STARTUP = `${ESC}]11;?${ST}${ESC}[?2026$p${ESC}[6n${ESC}[c`
const THEME: XtermTheme = { foreground: '#d4d4d4', background: '#1e1e1e' }
/** The answers, in the order asked: the colour from THEME, then what xterm's core answers. */
const ANSWERS = `${ESC}]11;rgb:1e1e/1e1e/1e1e${ST}${ESC}[?2026;2$y${ESC}[1;1R${ESC}[?1;2c`

let root: string
let backend: FakePtyBackend
let logs: string[]

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-queries-')))
  backend = new FakePtyBackend()
  logs = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/**
 * A view's terminal: `tabs.data` into an xterm whose own replies (onData) go back as the view's
 * input, as the desktop page's and the web shell's do (terminal-session.ts).
 */
class View {
  readonly t = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  constructor(input: (data: string) => void) {
    this.t.onData(input)
  }
  write(data: string): void {
    this.t.write(data)
  }
  parsed(): Promise<void> {
    return new Promise((resolve) => this.t.write('', resolve))
  }
}

function setup(theme: () => XtermTheme | undefined = () => THEME) {
  const mirror = new TerminalMirror({
    createWorker: () => new FakeWorker(),
    log: (m) => logs.push(m),
    colors: theme
  })
  const views: View[] = []
  const tabs = new TabManager({
    backend,
    projectPath: (id) => (id === P ? root : undefined),
    loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/u' }),
    hooksPath: '/data/hooks.json',
    binDir: '/data/bin',
    sock: () => undefined,
    emit: <C extends EventChannel>(_p: string, channel: C, payload: IpcEventMap[C]) => {
      if (channel !== 'tabs.data') return
      const data = (payload as IpcEventMap['tabs.data']).data
      // Every view gets the same output (the remote view's own stream is the same chunks).
      for (const v of views) v.write(data)
    },
    log: (m) => logs.push(m),
    terminalTap: mirror
  })
  const view = (tabId: string): View => {
    const v = new View((data) => tabs.viewInput(P, tabId, data))
    views.push(v)
    return v
  }
  return { mirror, tabs, view }
}

const written = (pty: FakePty): string => pty.writes.join('')

describe('web access on: main answers', () => {
  it("answers Claude-style startup queries with no view awake, in the order asked, colours from the theme", async () => {
    const { mirror, tabs } = setup()
    mirror.start()
    const tab = tabs.create(P, { kind: 'shell' })
    const pty = backend.last
    pty.emit(STARTUP)
    await until(() => written(pty) === ANSWERS)
    await wait(20)
    expect(written(pty)).toBe(ANSWERS)
    expect(mirror.answers(tab.id)).toBe(true)
    mirror.stop()
  })

  it('replies from two views never reach the pty; only main answers, once', async () => {
    const { mirror, tabs, view } = setup()
    mirror.start()
    const tab = tabs.create(P, { kind: 'shell' })
    const desktop = view(tab.id)
    const remote = view(tab.id)
    const pty = backend.last
    pty.emit(STARTUP)
    await until(() => written(pty).length >= ANSWERS.length)
    await desktop.parsed()
    await remote.parsed()
    await wait(20)
    // Both views answered (their xterms did), and main dropped every one of those answers.
    expect(written(pty)).toBe(ANSWERS)
    mirror.stop()
  })

  it('a report glued to a key keeps the key; focus and mouse reports from the second view pass', async () => {
    const { mirror, tabs } = setup()
    mirror.start()
    const tab = tabs.create(P, { kind: 'shell' })
    const pty = backend.last
    pty.writes.length = 0
    expect(tabs.viewInput(P, tab.id, `a${ESC}[12;5R`)).toBe('a')
    expect(tabs.viewInput(P, tab.id, `${ESC}[?1;2cb${ESC}]11;rgb:0000/0000/0000${ST}`)).toBe('b')
    const mouse = `${ESC}[<0;10;5M${ESC}[<0;10;5m${ESC}[<64;3;3M`
    expect(tabs.viewInput(P, tab.id, `${ESC}[I${mouse}`)).toBe(`${ESC}[I${mouse}`)
    expect(tabs.viewInput(P, tab.id, `${ESC}[0n`)).toBe('')
    expect(written(pty)).toBe(`ab${ESC}[I${mouse}`)
    mirror.stop()
  })

  it('the index.ts glue: a stripped reply never sets SessionInfo.typed, a real key does (a plugin send stays accepted until then)', () => {
    const { mirror, tabs } = setup()
    mirror.start()
    const tab = tabs.create(P, { kind: 'claude' })
    const reg = new SessionRegistry({ projectName: () => 'x', broadcast: () => {}, write: () => {} })
    reg.tabStarted({ tabId: tab.id, projectId: P, kind: 'claude', cwd: '/proj' })
    // What index.ts does for the renderer's tabs.input.
    const input = (data: string): void => reg.userInput(P, tab.id, tabs.viewInput(P, tab.id, data))
    input(`${ESC}[12;5R${ESC}[?1;2c`)
    expect(reg.get(tab.id)?.typed).toBe(false)
    input(`${ESC}[I`)
    expect(reg.get(tab.id)?.typed).toBe(false)
    input(`${ESC}[1;1Rh`)
    expect(reg.get(tab.id)?.typed).toBe(true)
    reg.dispose()
    mirror.stop()
  })

  it('a theme change applies to the next colour query; a theme without colours gets xterm defaults', async () => {
    let theme: XtermTheme | undefined = THEME
    const { mirror, tabs } = setup(() => theme)
    mirror.start()
    tabs.create(P, { kind: 'shell' })
    const pty = backend.last
    theme = { background: 'rgb(255, 0, 0)', foreground: '#00f' }
    pty.emit(`${ESC}]10;?;?${ESC}\\`)
    const both = `${ESC}]10;rgb:0000/0000/ffff${ST}${ESC}]11;rgb:ffff/0000/0000${ST}`
    await until(() => written(pty) === both)
    theme = undefined
    pty.emit(`${ESC}]11;?\x07${ESC}]12;?\x07`)
    const defaults = `${ESC}]11;rgb:0000/0000/0000${ST}${ESC}]12;rgb:ffff/ffff/ffff${ST}`
    await until(() => written(pty) === both + defaults)
    mirror.stop()
  })

  it('a colour being set (not asked) is not answered', async () => {
    const { mirror, tabs } = setup()
    mirror.start()
    tabs.create(P, { kind: 'shell' })
    const pty = backend.last
    pty.emit(`${ESC}]11;#123456${ST}${ESC}[c`)
    await until(() => written(pty).length > 0)
    await wait(20)
    expect(written(pty)).toBe(`${ESC}[?1;2c`)
    mirror.stop()
  })
})

describe('web access off: the desktop answers', () => {
  it('no mirror: the view replies pass as they are, nothing else answers', async () => {
    const { mirror, tabs, view } = setup()
    const tab = tabs.create(P, { kind: 'shell' })
    const desktop = view(tab.id)
    const pty = backend.last
    expect(mirror.answers(tab.id)).toBe(false)
    pty.emit(`${ESC}[6n${ESC}[c`)
    await until(() => written(pty).length > 0)
    await desktop.parsed()
    await wait(20)
    expect(written(pty)).toBe(`${ESC}[1;1R${ESC}[?1;2c`)
  })

  it('a tab without a tap answers through its view; turned off again, the view answers again', async () => {
    const { mirror, tabs, view } = setup()
    mirror.start()
    const tab = tabs.create(P, { kind: 'shell' })
    const desktop = view(tab.id)
    const pty = backend.last
    mirror.stop()
    expect(mirror.answers(tab.id)).toBe(false)
    pty.emit(`${ESC}[6n`)
    await until(() => written(pty).length > 0)
    await desktop.parsed()
    await wait(20)
    expect(written(pty)).toBe(`${ESC}[1;1R`)
  })
})

describe('the worker side', () => {
  it('posts xterm core replies and OSC 10/11/12 queries in stream order, never for a closed tab', async () => {
    const out: FromWorker[] = []
    const terms = new HeadlessTerms((m) => out.push(m))
    terms.handle({ t: 'item', tabId: 't', item: { seq: 1, kind: 'spawn', cols: 80, rows: 24 } })
    terms.handle({ t: 'item', tabId: 't', item: { seq: 2, kind: 'data', data: `${ESC}[c${ESC}]12;?\x07${ESC}]10;?;?;?${ST}` } })
    await until(() => out.some((m) => m.t === 'parsed' && m.seq === 2))
    expect(out.filter((m) => m.t === 'reply' || m.t === 'color')).toEqual([
      { t: 'reply', tabId: 't', data: `${ESC}[?1;2c` },
      { t: 'color', tabId: 't', ident: 12 },
      { t: 'color', tabId: 't', ident: 10 },
      { t: 'color', tabId: 't', ident: 11 },
      { t: 'color', tabId: 't', ident: 12 }
    ])
    out.length = 0
    terms.handle({ t: 'item', tabId: 't', item: { seq: 3, kind: 'data', data: `${ESC}[c` } })
    terms.handle({ t: 'item', tabId: 't', item: { seq: 4, kind: 'close' } })
    await wait(20)
    expect(out.filter((m) => m.t === 'reply' || m.t === 'color')).toEqual([])
    terms.dispose()
  })

  it('the mirror forwards a reply only for a tab it holds', async () => {
    const replies: string[] = []
    let listener: (m: FromWorker) => void = () => undefined
    const mirror = new TerminalMirror({
      createWorker: () => ({
        post: () => undefined,
        onMessage: (l) => (listener = l),
        onExit: () => undefined,
        terminate: () => undefined
      }),
      log: (m) => logs.push(m)
    })
    mirror.bindFlow({
      take: () => undefined,
      ack: () => undefined,
      release: () => undefined,
      reply: (tabId, data) => replies.push(`${tabId} ${data}`)
    })
    mirror.start()
    mirror.spawned('a', 80, 24)
    listener({ t: 'reply', tabId: 'a', data: 'x' })
    listener({ t: 'reply', tabId: 'b', data: 'y' })
    listener({ t: 'color', tabId: 'b', ident: 11 })
    listener({ t: 'color', tabId: 'a', ident: 11 })
    expect(replies).toEqual(['a x', `a ${ESC}]11;rgb:0000/0000/0000${ST}`])
    mirror.stop()
  })
})

describe('colours', () => {
  it('parses the forms a theme may hold', () => {
    expect(parseCssColor('#1e1e1e')).toEqual([0x1e, 0x1e, 0x1e])
    expect(parseCssColor('#abc')).toEqual([0xaa, 0xbb, 0xcc])
    expect(parseCssColor('#abcd')).toEqual([0xaa, 0xbb, 0xcc])
    expect(parseCssColor('#11223344')).toEqual([0x11, 0x22, 0x33])
    expect(parseCssColor('rgb(1, 2, 3)')).toEqual([1, 2, 3])
    expect(parseCssColor('rgba(255 128 0 / 0.5)')).toEqual([255, 128, 0])
    expect(parseCssColor('rgb(100%, 0%, 50%)')).toEqual([255, 0, 128])
    expect(parseCssColor('hsl(0, 100%, 50%)')).toEqual([255, 0, 0])
    expect(parseCssColor('hsl(120deg 100% 25%)')).toEqual([0, 128, 0])
    expect(parseCssColor('hsla(240, 100%, 50%, 0.3)')).toEqual([0, 0, 255])
    expect(parseCssColor('red')).toBeNull()
    expect(parseCssColor('rgb(a, b, c)')).toBeNull()
    expect(parseCssColor('#12')).toBeNull()
  })

  it('answers as xterm.js does, with defaults and the cursor falling back to the foreground', () => {
    expect(oscColorReply(11, { background: '#1e1e1e' })).toBe(`${ESC}]11;rgb:1e1e/1e1e/1e1e${ST}`)
    expect(oscColorReply(10, {})).toBe(`${ESC}]10;rgb:ffff/ffff/ffff${ST}`)
    expect(oscColorReply(11, undefined)).toBe(`${ESC}]11;rgb:0000/0000/0000${ST}`)
    expect(oscColorReply(12, { foreground: '#010203' })).toBe(`${ESC}]12;rgb:0101/0202/0303${ST}`)
    expect(oscColorReply(12, { foreground: '#010203', cursor: '#fff' })).toBe(`${ESC}]12;rgb:ffff/ffff/ffff${ST}`)
    expect(oscColorReply(11, { background: 'nonsense' })).toBe(`${ESC}]11;rgb:0000/0000/0000${ST}`)
  })
})
