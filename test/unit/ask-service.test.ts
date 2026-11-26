// Task 02: Ask in main (shared/design.md §5; D1, D2, D3, D11, D12, D14; spec-review S5; design-parts.md §5, §7). The
// service runs against a fake overlay manager, a fake spawn and a fake claude --help; nothing real is spawned.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AskService, fenced, type AskServiceDeps } from '../../src/main/ask/ask-service'
import type { AskCaller, AskPerson } from '../../src/main/ask/ask-api'
import type { AskProcess, AskProcessHandlers } from '../../src/main/ask/ask-runner'
import { ASK_GUEST_FLAGS } from '../../src/main/ask/ask-argv'
import { ASK_IDLE_MS, ASK_MAX_ANSWER, ASK_MAX_DOCUMENT } from '../../src/shared/ask'
import type { AskPush } from '../../src/shared/overlay-envelope'

const P = 'aaaaaaaaaaaaaaaa'
const W = 1
const OWNER_VIEW = 'desktop:1'
const OWNER_B = 'remote:ob'
const GUEST_VIEW = 'remote:g1'
const READ_VIEW = 'remote:r1'
const SESSION = '11111111-2222-3333-4444-555555555555'
const HELP_ALL = '-p, --print --restricted --safe-mode --strict-mcp-config --tools <t> --permission-prompts <x> --input-format <f> --output-format <f> --verbose --include-partial-messages --model <m> --effort <e> --resume <id>'

interface FakeProc extends AskProcess {
  argv: readonly string[]
  cwd: string
  env: Record<string, string>
  written: string[]
  killed: boolean
  h: AskProcessHandlers
  emit(ev: unknown): void
  exit(code?: number): void
}

let dir: string
let projectRoot: string
let procs: FakeProc[]
let posts: { overlayId: string; copy: string; msg: { seq: number; data: AskPush } }[]
let copies: Map<string, string>
let notes: Map<string, { pluginId: string; key: string }>
let persons: Map<string, AskPerson | undefined>
let onAsk: (overlayId: string, view: string, copy: string) => Promise<unknown>
let ready: ((ev: { windowId: number; overlayId: string; copy: string; view: string }) => void)[]
let ends: ((ev: { windowId: number; overlayId: string; copy: string; view: string }) => void)[]
let help: () => Promise<string>
let parts: { overlayId: string; pluginId: string }[]
let opened: { projectId: string; sessionId: string; afterKill: boolean }[]
let clock: number

const ck = (overlayId: string, copy: string): string => overlayId + '/' + copy

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccc-ask-'))
  projectRoot = join(dir, 'project')
  procs = []
  posts = []
  copies = new Map([
    [ck('o1', 'c1'), OWNER_VIEW],
    [ck('o1', 'c2'), OWNER_B],
    [ck('o1', 'cg'), GUEST_VIEW],
    [ck('o1', 'cr'), READ_VIEW],
    [ck('o2', 'c1'), OWNER_VIEW]
  ])
  notes = new Map([
    ['o1', { pluginId: 'a.jira', key: 'jira:PROJ-1' }],
    ['o2', { pluginId: 'a.jira', key: 'jira:PROJ-2' }]
  ])
  persons = new Map<string, AskPerson | undefined>([
    [OWNER_VIEW, 'owner'],
    [OWNER_B, 'owner'],
    [GUEST_VIEW, { guest: 'g1' }],
    [READ_VIEW, undefined]
  ])
  onAsk = () => Promise.resolve({ text: 'The issue text' })
  ready = []
  ends = []
  help = () => Promise.resolve(HELP_ALL)
  parts = []
  opened = []
  clock = 1_000_000
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function service(over: Partial<AskServiceDeps> = {}): AskService {
  return new AskService({
    dataDir: dir,
    log: () => {},
    overlays: {
      copyOwner: (_w, overlayId, copy) => copies.get(ck(String(overlayId), String(copy))) as never,
      copiesOf: (_w, overlayId) =>
        [...copies].filter(([k]) => k.startsWith(String(overlayId) + '/')).map(([k, view]) => ({ copy: k.split('/')[1]!, view: view as never })),
      notesOf: (_w, overlayId) => notes.get(String(overlayId)),
      postEnvelope: (_w, overlayId, copy, text) => {
        if (!copies.has(ck(overlayId, copy))) return false
        posts.push({ overlayId, copy, msg: JSON.parse(text) })
        return true
      },
      onCopyReady: (fn) => {
        ready.push(fn as never)
        return () => {}
      },
      onCopyEnd: (fn) => {
        ends.push(fn as never)
        return () => {}
      },
      partsOf: () => parts,
      openerPluginOf: (_w, overlayId) => (String(overlayId) === 'o3' ? 'b.cal' : notes.get(String(overlayId))?.pluginId),
      askContext: (_w, overlayId, view, copy) => onAsk(overlayId, view, copy)
    },
    projectRoot: (id) => (id === P ? projectRoot : undefined),
    projectOfWindow: (w) => (w === W ? P : undefined),
    loginEnv: () => Promise.resolve({ PATH: '/usr/bin', HOME: '/home/u', APP_TAB_TOKEN: 'stale' }),
    askerOf: (view) => persons.get(view),
    openResumeTab: (projectId, sessionId) => {
      opened.push({ projectId, sessionId, afterKill: procs.every((p) => p.killed) })
      return 'tab-9'
    },
    readHelp: () => help(),
    now: () => clock,
    newToken: () => (procs.length.toString(16) + 'f'.repeat(64)).slice(0, 64),
    spawn: (argv, opts, h) => {
      let resolve!: () => void
      const exited = new Promise<void>((r) => (resolve = r))
      const p: FakeProc = {
        argv,
        cwd: opts.cwd,
        env: opts.env,
        written: [],
        killed: false,
        h,
        exited,
        write: (line) => p.written.push(line),
        kill: () => {
          if (p.killed) return
          p.killed = true
          resolve()
        },
        emit: (ev) => h.line(JSON.stringify(ev)),
        exit: (code = 1) => {
          resolve()
          h.exit({ code, signal: null, stderr: '' })
        }
      }
      procs.push(p)
      return p
    },
    ...over
  })
}

const owner = (view = OWNER_VIEW): AskCaller => ({ windowId: W, projectId: P, view: view as never, person: persons.get(view) })
const guest = (): AskCaller => ({ windowId: W, projectId: P, view: GUEST_VIEW as never, person: { guest: 'g1' } })
const copyOf = (view: string): string => [...copies].find(([k, v]) => v === view && k.startsWith('o1/'))![0].split('/')[1]!
const q = (view: string, question = 'What is this about?', extra: Record<string, unknown> = {}) => ({ overlayId: 'o1', copy: copyOf(view), question, ...extra })
const pushesTo = (copy: string) => posts.filter((p) => p.overlayId === 'o1' && p.copy === copy).map((p) => p.msg.data)

/** A whole turn of a fake claude: init, two deltas, the result. */
function answer(p: FakeProc, text = 'It is about X.', session = SESSION): void {
  p.emit({ type: 'system', subtype: 'init', session_id: session, tools: [], mcp_servers: [] })
  p.emit({ type: 'stream_event', event: { type: 'message_start' } })
  p.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: text.slice(0, 3) } } })
  p.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: text.slice(3) } } })
  p.emit({ type: 'result', subtype: 'success', result: text })
}

/** The user text a process was given on stdin, parsed. */
const sent = (p: FakeProc, i = 0): string => (JSON.parse(p.written[i]!) as { message: { content: string } }).message.content

describe('who and how', () => {
  it('opening spawns nothing; the first question spawns', async () => {
    const s = service()
    for (const fn of ready) fn({ windowId: W, overlayId: 'o1', copy: 'c1', view: OWNER_VIEW })
    expect(procs).toHaveLength(0)
    expect(pushesTo('c1').map((d) => d.type)).toEqual(['history'])
    await s.start(owner(), q(OWNER_VIEW))
    expect(procs).toHaveLength(1)
  })

  it('anything not the owner gets the guest argv; the owner a regular session', async () => {
    const s = service()
    await s.start(owner(), q(OWNER_VIEW))
    await s.start(guest(), q(GUEST_VIEW))
    const [o, g] = procs
    for (const f of ['--restricted', '--safe-mode', '--strict-mcp-config', '--tools']) expect(o!.argv).not.toContain(f)
    expect(g!.argv.join(' ')).toContain(ASK_GUEST_FLAGS.join(' '))
    expect(g!.argv[g!.argv.indexOf('--tools') + 1]).toBe('')
  })

  it('a caller with no person is refused, nothing spawned', async () => {
    const s = service()
    await expect(s.start({ ...owner(READ_VIEW), person: undefined }, q(READ_VIEW))).rejects.toThrow(/refused/)
    expect(procs).toHaveLength(0)
  })

  it('start, say, close from a view that is not copyOwner: refused', async () => {
    const s = service()
    const other = { overlayId: 'o1', copy: 'c2', question: 'x' }
    await expect(s.start(owner(), other)).rejects.toThrow(/not your copy/)
    await expect(s.say(owner(), other)).rejects.toThrow(/not your copy/)
    expect(() => s.close(owner(), other)).toThrow(/not your copy/)
    // copyOwner undefined (a released copy) refuses too.
    await expect(s.start(owner(), { overlayId: 'o1', copy: 'gone', question: 'x' })).rejects.toThrow(/not your copy/)
    expect(procs).toHaveLength(0)
  })

  it('an overlay with no notes key: one chat per copy, never stored, gone with its copy', async () => {
    copies.set(ck('o3', 'c1'), OWNER_VIEW)
    copies.set(ck('o3', 'c2'), OWNER_B)
    const s = service()
    await s.start(owner(), { overlayId: 'o3', copy: 'c1', question: 'q' })
    answer(procs[0]!)
    // Another owner view's copy has its own chat: no busy, no shared history.
    await s.start(owner(OWNER_B), { overlayId: 'o3', copy: 'c2', question: 'q2' })
    expect(procs).toHaveLength(2)
    expect(procs[1]!.argv).not.toContain('--resume')
    expect(() => readFileSync(join(dir, 'ask', P, createHash('sha256').update('b.cal').digest('hex') + '.json'), 'utf8')).toThrow()
    for (const fn of ends) fn({ windowId: W, overlayId: 'o3', copy: 'c1', view: OWNER_VIEW })
    expect(procs[0]!.killed).toBe(true)
    await expect(s.say(owner(), { overlayId: 'o3', copy: 'c1', question: 'again' })).rejects.toThrow(/no chat yet/)
    // An overlay with neither a key nor an opener plugin (the CLI's): no Ask.
    copies.set(ck('cli', 'c1'), OWNER_VIEW)
    await expect(s.start(owner(), { overlayId: 'cli', copy: 'c1', question: 'q' })).rejects.toThrow(/no Ask/)
  })

  it("cwd never from the payload: the project folder from main's record, whatever the request says", async () => {
    const s = service()
    await s.start(owner(), { ...q(OWNER_VIEW), cwd: '/etc', projectId: 'bbbbbbbbbbbbbbbb' })
    expect(procs[0]!.cwd).toBe(projectRoot)
  })

  it('the process gets an Ask token of its own, resolved while it runs, as the window owner of its project', async () => {
    const s = service()
    await s.start(owner(), q(OWNER_VIEW))
    const token = procs[0]!.env.APP_TAB_TOKEN!
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(procs[0]!.env.APP_TAB_ID).toBeUndefined()
    expect(s.resolveToken(token)).toEqual({ projectId: P })
    s.close(owner(), q(OWNER_VIEW))
    expect(s.resolveToken(token)).toBeUndefined()
  })
})

describe('the help check', () => {
  it('claude --help missing a mode flag: refused, nothing spawned', async () => {
    help = () => Promise.resolve(HELP_ALL.replace('--safe-mode', ''))
    const s = service()
    await expect(s.start(guest(), q(GUEST_VIEW))).rejects.toThrow(/lacks --safe-mode/)
    expect(procs).toHaveLength(0)
    // The owner mode does not need it (D2).
    await s.start(owner(), q(OWNER_VIEW))
    expect(procs).toHaveLength(1)
  })

  it('a --help that fails is not kept: the next question asks again', async () => {
    let calls = 0
    help = () => (++calls === 1 ? Promise.reject(new Error('ENOENT')) : Promise.resolve(HELP_ALL))
    const s = service()
    await expect(s.start(owner(), q(OWNER_VIEW))).rejects.toThrow(/did not answer --help/)
    await s.start(owner(), q(OWNER_VIEW))
    expect(calls).toBe(2)
    expect(procs).toHaveLength(1)
  })
})

describe('the context', () => {
  it('onAsk null, throws or past 10 s: refused, nothing spawned', async () => {
    const s = service()
    onAsk = () => Promise.resolve(null)
    await expect(s.start(owner(), q(OWNER_VIEW))).rejects.toThrow(/no document/)
    onAsk = () => Promise.reject(new Error('boom'))
    await expect(s.start(owner(), q(OWNER_VIEW))).rejects.toThrow(/refused \(boom\)/)
    vi.useFakeTimers()
    onAsk = () => new Promise(() => {})
    const late = s.start(owner(), q(OWNER_VIEW))
    const caught = expect(late).rejects.toThrow(/within 10 s/)
    await vi.advanceTimersByTimeAsync(10_001)
    await caught
    expect(procs).toHaveLength(0)
  })

  it("a part's null onAsk is left out; a part's text is its own fenced section", async () => {
    parts = [
      { overlayId: 'p1', pluginId: 'a.jira' },
      { overlayId: 'p2', pluginId: 'b.cal' }
    ]
    copies.set(ck('p1', 'x1'), OWNER_VIEW)
    copies.set(ck('p2', 'x2'), OWNER_VIEW)
    onAsk = (overlayId) => Promise.resolve(overlayId === 'p1' ? { text: 'Issue PROJ-1 body' } : overlayId === 'p2' ? null : { text: 'Mail body' })
    await service().start(owner(), q(OWNER_VIEW))
    const text = sent(procs[0]!)
    expect(text).toContain('Mail body')
    expect(text).toContain('(from a.jira)')
    expect(text).toContain('Issue PROJ-1 body')
    expect(text).not.toContain('b.cal')
  })

  it('the stdin fence is longer than any backtick run', async () => {
    const tick = String.fromCharCode(96)
    onAsk = () => Promise.resolve({ text: 'code ' + tick.repeat(7) + ' end' })
    await service().start(owner(), q(OWNER_VIEW, 'why?', { quote: tick.repeat(4) }))
    const text = sent(procs[0]!)
    expect(text).toContain(tick.repeat(8) + '\ncode ')
    expect(fenced(tick.repeat(4)).startsWith(tick.repeat(5) + '\n')).toBe(true)
    expect(fenced('plain').startsWith(tick.repeat(3) + '\n')).toBe(true)
  })

  it('question or quote over 10,000 refused; document and answer cut at 100,000', async () => {
    const s = service()
    await expect(s.start(owner(), q(OWNER_VIEW, 'x'.repeat(10_001)))).rejects.toThrow(/question is over/)
    await expect(s.start(owner(), q(OWNER_VIEW, 'why?', { quote: 'y'.repeat(10_001) }))).rejects.toThrow(/quote is over/)
    expect(procs).toHaveLength(0)
    onAsk = () => Promise.resolve({ text: 'd'.repeat(ASK_MAX_DOCUMENT + 50) })
    await s.start(owner(), q(OWNER_VIEW))
    const text = sent(procs[0]!)
    expect(text).toContain('d'.repeat(ASK_MAX_DOCUMENT) + '\n\n(the document was cut here)')
    expect(text).not.toContain('d'.repeat(ASK_MAX_DOCUMENT + 1))
    vi.useFakeTimers()
    const p = procs[0]!
    p.emit({ type: 'system', subtype: 'init', session_id: SESSION, tools: [], mcp_servers: [] })
    p.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a'.repeat(ASK_MAX_ANSWER + 10) } } })
    p.emit({ type: 'result', subtype: 'success', result: '' })
    const done = pushesTo('c1').find((d) => d.type === 'answer') as { text: string }
    expect(done.text).toBe('a'.repeat(ASK_MAX_ANSWER) + '\n\n(the answer was cut here)')
  })
})

describe('caps and turns', () => {
  it("a second owner view's question during a turn is refused busy", async () => {
    const s = service()
    await s.start(owner(), q(OWNER_VIEW))
    await expect(s.say(owner(OWNER_B), q(OWNER_B))).rejects.toThrow(/busy/)
    answer(procs[0]!)
    await s.say(owner(OWNER_B), q(OWNER_B, 'and then?'))
    expect(procs).toHaveLength(1)
    expect(sent(procs[0]!, 1)).toBe('and then?')
  })

  it('past 3 per plugin per window, 6 per app or 10 a minute per window: refused', async () => {
    const s = service()
    for (let i = 1; i <= 8; i++) {
      notes.set('k' + i, { pluginId: i <= 4 ? 'a.jira' : 'p.' + i, key: 'key' + i })
      copies.set(ck('k' + i, 'c'), OWNER_VIEW)
    }
    const ask = (i: number) => s.start(owner(), { overlayId: 'k' + i, copy: 'c', question: 'q' })
    for (const i of [1, 2, 3]) await ask(i)
    await expect(ask(4)).rejects.toThrow(/3 chats of this plugin/)
    for (const i of [5, 6, 7]) await ask(i)
    await expect(ask(8)).rejects.toThrow(/6 chats already run/)
    expect(procs).toHaveLength(6)
    // The rate: ten spawns a minute per window, whatever ended meanwhile.
    for (const i of [1, 2, 3, 5, 6, 7]) s.close(owner(), { overlayId: 'k' + i, copy: 'c' })
    for (const i of [1, 2, 3, 5]) await ask(i)
    await expect(ask(6)).rejects.toThrow(/too many chats started this minute/)
    clock += 60_001
    await ask(6)
  })

  it("events reach only copies of the chat's own person", async () => {
    const s = service()
    for (const [copy, view] of [['c1', OWNER_VIEW], ['c2', OWNER_B], ['cg', GUEST_VIEW], ['cr', READ_VIEW]]) {
      for (const fn of ready) fn({ windowId: W, overlayId: 'o1', copy: copy!, view: view! })
    }
    // A read guest gets nothing at all, not even the history.
    expect(pushesTo('cr')).toEqual([])
    posts = []
    await s.start(owner(), q(OWNER_VIEW))
    vi.useFakeTimers()
    answer(procs[0]!)
    await vi.advanceTimersByTimeAsync(100)
    expect(pushesTo('c2').some((d) => d.type === 'answer')).toBe(true)
    expect(pushesTo('cg')).toEqual([])
    expect(pushesTo('cr')).toEqual([])
    // A view whose person changed (a narrowing) is detached at the next push.
    persons.set(OWNER_B, { guest: 'g1' })
    await s.say(owner(), q(OWNER_VIEW, 'more?'))
    expect(pushesTo('c2').filter((d) => d.type === 'state' && (d as { phase: string }).phase === 'thinking')).toHaveLength(1)
  })

  it('deltas are coalesced, then the answer, then ready; the turn is kept', async () => {
    vi.useFakeTimers()
    const s = service()
    await s.start(owner(), q(OWNER_VIEW))
    answer(procs[0]!, 'Hello there')
    const kinds = pushesTo('c1').map((d) => d.type)
    expect(kinds).toEqual(['state', 'state', 'delta', 'answer', 'state'])
    expect(pushesTo('c1').find((d) => d.type === 'delta')).toEqual({ type: 'delta', text: 'Hello there' })
    const seqs = posts.filter((p) => p.copy === 'c1').map((p) => p.msg.seq)
    expect(seqs).toEqual([1, 2, 3, 4, 5])
  })

  it('a pick change ends the process and the next question resumes the session with it', async () => {
    const s = service()
    await s.start(owner(), q(OWNER_VIEW))
    answer(procs[0]!)
    expect(s.pick(owner(), { overlayId: 'o1', copy: 'c1', model: 'opus', effort: 'high' })).toMatchObject({ model: 'opus', effort: 'high' })
    await s.say(owner(), q(OWNER_VIEW, 'again'))
    expect(procs[0]!.killed).toBe(true)
    const argv = procs[1]!.argv
    expect(argv.slice(argv.indexOf('--model'))).toEqual(['--model', 'opus', '--effort', 'high', '--resume', SESSION])
    expect(sent(procs[1]!)).toBe('again')
  })

  it('15 idle minutes end the process; the chat stays and resumes', async () => {
    vi.useFakeTimers()
    const s = service()
    await s.start(owner(), q(OWNER_VIEW))
    answer(procs[0]!)
    await vi.advanceTimersByTimeAsync(ASK_IDLE_MS + 1)
    expect(procs[0]!.killed).toBe(true)
    await s.say(owner(), q(OWNER_VIEW, 'still there?'))
    expect(procs[1]!.argv).toContain('--resume')
  })
})

describe('the pick', () => {
  it('model or effort outside session-options lists refused', () => {
    const s = service()
    expect(() => s.pick(owner(), { overlayId: 'o1', copy: 'c1', model: '--dangerously' })).toThrow(/model must be one of/)
    expect(() => s.pick(owner(), { overlayId: 'o1', copy: 'c1', effort: 'ultra' })).toThrow(/effort must be one of/)
    expect(s.pick(owner(), { overlayId: 'o1', copy: 'c1' })).toMatchObject({ models: ['haiku', 'sonnet', 'opus', 'fable'] })
  })

  it("the owner's pick survives a restart; a guest's pick is not saved", async () => {
    service().pick(owner(), { overlayId: 'o1', copy: 'c1', model: 'haiku', effort: 'low' })
    const saved = JSON.parse(readFileSync(join(dir, 'ask.json'), 'utf8'))
    expect(saved).toMatchObject({ model: 'haiku', effort: 'low' })
    const s = service()
    s.pick(guest(), { overlayId: 'o1', copy: 'cg', model: 'fable' })
    expect(JSON.parse(readFileSync(join(dir, 'ask.json'), 'utf8'))).toMatchObject({ model: 'haiku', effort: 'low' })
    // A new chat (another key) starts with the owner's remembered pick.
    await s.start(owner(), { overlayId: 'o2', copy: 'c1', question: 'q' })
    const argv = procs[0]!.argv
    expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 4)).toEqual(['--model', 'haiku', '--effort', 'low'])
    await s.start(guest(), q(GUEST_VIEW))
    expect(procs[1]!.argv).toContain('fable')
  })
})

describe('ends', () => {
  it('killed on last copy end, plugin off, and each narrowing path (role, hidden, unshared, kick, revoke): the service side, dropGuest; the paths are in ask-guests.test.ts', async () => {
    const s = service()
    await s.start(owner(), q(OWNER_VIEW))
    await s.start(owner(OWNER_B), { overlayId: 'o2', copy: 'c1', question: 'q' }).catch(() => {})
    // Two copies of the owner's o1 chat: the first end keeps it, the last ends the process.
    s.pick(owner(OWNER_B), { overlayId: 'o1', copy: 'c2' })
    for (const fn of ends) fn({ windowId: W, overlayId: 'o1', copy: 'c1', view: OWNER_VIEW })
    expect(procs[0]!.killed).toBe(false)
    for (const fn of ends) fn({ windowId: W, overlayId: 'o1', copy: 'c2', view: OWNER_B })
    expect(procs[0]!.killed).toBe(true)
    await s.start(guest(), q(GUEST_VIEW))
    const g = procs.at(-1)!
    s.dropGuest('g1')
    expect(g.killed).toBe(true)
    expect(pushesTo('cg').at(-1)).toMatchObject({ type: 'end', error: true })
    // The guest's chat is gone from memory: a say has nothing to continue.
    await expect(s.say(guest(), q(GUEST_VIEW))).rejects.toThrow(/no chat yet/)
  })

  it('a guest chat whose init lists a tool or MCP server is ended', async () => {
    const s = service()
    await s.start(guest(), q(GUEST_VIEW))
    procs[0]!.emit({ type: 'system', subtype: 'init', session_id: SESSION, tools: ['Bash'], mcp_servers: [] })
    expect(procs[0]!.killed).toBe(true)
    expect(pushesTo('cg').at(-1)).toMatchObject({ type: 'end', error: true })
    await s.start(guest(), q(GUEST_VIEW))
    procs[1]!.emit({ type: 'system', subtype: 'init', session_id: SESSION, tools: [], mcp_servers: [{ name: 'x' }] })
    expect(procs[1]!.killed).toBe(true)
  })

  it("a guest's exit text never carries claude's stderr (host paths); the owner's does", async () => {
    const s = service()
    await s.start(guest(), q(GUEST_VIEW))
    procs[0]!.h.exit({ code: 1, signal: null, stderr: 'error at /home/owner/secret/file' })
    expect(JSON.stringify(pushesTo('cg'))).not.toContain('/home/owner')
    await s.start(owner(), q(OWNER_VIEW))
    procs[1]!.h.exit({ code: 1, signal: null, stderr: 'error at /home/owner/x' })
    expect(JSON.stringify(pushesTo('c1'))).toContain('/home/owner/x')
  })
})

describe('kept sessions (D14)', () => {
  it('the question after Esc passes --resume <stored id>; the history goes to the reopened copy', async () => {
    const s = service()
    await s.start(owner(), q(OWNER_VIEW))
    answer(procs[0]!)
    for (const fn of ends) fn({ windowId: W, overlayId: 'o1', copy: 'c1', view: OWNER_VIEW })
    expect(procs[0]!.killed).toBe(true)
    copies.set(ck('o1', 'c3'), OWNER_VIEW)
    for (const fn of ready) fn({ windowId: W, overlayId: 'o1', copy: 'c3', view: OWNER_VIEW })
    const history = pushesTo('c3')[0] as { type: string; turns: { question: string; answer: string }[] }
    expect(history.type).toBe('history')
    expect(history.turns).toEqual([{ question: 'What is this about?', answer: 'It is about X.' }])
    onAsk = () => Promise.reject(new Error('a resumed session asks for no document'))
    await s.say(owner(), { overlayId: 'o1', copy: 'c3', question: 'more' })
    expect(procs[1]!.argv.slice(-2)).toEqual(['--resume', SESSION])
    expect(sent(procs[1]!)).toBe('more')
  })

  it('the store survives a restart: a new service resumes the session', async () => {
    const s = service()
    await s.start(owner(), q(OWNER_VIEW))
    answer(procs[0]!)
    const again = service()
    await again.say(owner(), q(OWNER_VIEW, 'after the restart'))
    expect(procs[1]!.argv.slice(-2)).toEqual(['--resume', SESSION])
  })

  it('a non-UUID session id is never stored or resumed: a fresh session starts', async () => {
    const s = service()
    await s.start(owner(), q(OWNER_VIEW))
    answer(procs[0]!, 'ok', '--settings=/tmp/evil')
    const file = readFileSync(join(dir, 'ask', P, createHash('sha256').update('a.jira').digest('hex') + '.json'), 'utf8')
    expect(file).not.toContain('evil')
    const again = service()
    await again.start(owner(), q(OWNER_VIEW, 'next'))
    expect(procs[1]!.argv).not.toContain('--resume')
  })

  it("a guest's chat is never written", async () => {
    const s = service()
    await s.start(guest(), q(GUEST_VIEW))
    answer(procs[0]!)
    expect(() => readFileSync(join(dir, 'ask', P, createHash('sha256').update('a.jira').digest('hex') + '.json'), 'utf8')).toThrow()
  })

  it('a session that cannot be resumed is forgotten: the next question starts fresh', async () => {
    const s = service()
    await s.start(owner(), q(OWNER_VIEW))
    answer(procs[0]!)
    s.close(owner(), q(OWNER_VIEW))
    await s.say(owner(), q(OWNER_VIEW, 'again'))
    procs[1]!.exit(1)
    expect(pushesTo('c1').at(-1)).toMatchObject({ type: 'end', message: expect.stringMatching(/could not be resumed/) })
    await s.say(owner(), q(OWNER_VIEW, 'once more'))
    expect(procs[2]!.argv).not.toContain('--resume')
  })

  it('dropped with the plugin and the project', async () => {
    const s = service()
    await s.start(owner(), q(OWNER_VIEW))
    answer(procs[0]!)
    s.removePlugin('a.jira')
    expect(procs[0]!.killed).toBe(true)
    await expect(service().say(owner(), q(OWNER_VIEW))).rejects.toThrow(/no chat yet/)
    const t = service()
    await t.start(owner(), q(OWNER_VIEW))
    answer(procs[1]!)
    t.dropProject(P)
    await expect(service().say(owner(), q(OWNER_VIEW))).rejects.toThrow(/no chat yet/)
  })

  it('continue refused for a guest and for a key with no session; the Ask process ends before the tab spawns', async () => {
    const s = service()
    await expect(s.continueInTab(guest(), q(GUEST_VIEW))).rejects.toThrow(/only the owner/)
    await expect(s.continueInTab(owner(), q(OWNER_VIEW))).rejects.toThrow(/no session/)
    await s.start(owner(), q(OWNER_VIEW))
    answer(procs[0]!)
    expect(await s.continueInTab(owner(), q(OWNER_VIEW))).toEqual({ tabId: 'tab-9' })
    expect(opened).toEqual([{ projectId: P, sessionId: SESSION, afterKill: true }])
    expect(pushesTo('c1').at(-1)).toMatchObject({ type: 'end', error: false })
    // The session is the tab's now: the next question starts a fresh one, and the history says where it went.
    await expect(s.continueInTab(owner(), q(OWNER_VIEW))).rejects.toThrow(/no session/)
    copies.set(ck('o1', 'c4'), OWNER_VIEW)
    for (const fn of ready) fn({ windowId: W, overlayId: 'o1', copy: 'c4', view: OWNER_VIEW })
    expect(pushesTo('c4')[0]).toMatchObject({ type: 'history', continuedIn: 'tab-9' })
  })
})
