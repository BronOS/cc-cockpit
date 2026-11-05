import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventChannel, IpcEventMap } from '../../src/shared/ipc'
import { KILL_GRACE_MS } from '../../src/main/pty/pty-service'
import { SHELL_MIN_LIFE_MS, TabManager, resolveCwd, type TabLifecycle } from '../../src/main/tabs/tab-manager'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

const A = 'aaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbb'

interface Emitted {
  projectId: string
  channel: EventChannel
  payload: unknown
}

let root: string
let projA: string
let projB: string
let outside: string
let backend: FakePtyBackend
let events: Emitted[]

beforeEach(() => {
  vi.useFakeTimers()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-tabs-')))
  projA = join(root, 'a')
  projB = join(root, 'b')
  outside = join(root, 'outside')
  for (const d of [projA, join(projA, 'sub'), projB, outside]) mkdirSync(d, { recursive: true })
  backend = new FakePtyBackend()
  events = []
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

/**
 * `sock: null` = main is not listening on its socket. `closeOnCleanExit` absent = keep every
 * exited tab (the behaviour the tests outside 'close on a clean exit' are written against).
 */
let clock = 0

function manager(
  sock: string | null = '/data/app.sock',
  lifecycle?: TabLifecycle,
  onTabsChanged?: (projectId: string) => void,
  loginEnv: Record<string, string> = { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/u' },
  closeOnCleanExit?: () => boolean
): TabManager {
  return new TabManager({
    onTabsChanged,
    closeOnCleanExit,
    now: () => clock,
    backend,
    projectPath: (id) => ({ [A]: projA, [B]: projB })[id],
    loginEnv: () => loginEnv,
    hooksPath: '/data/hooks.json',
    binDir: '/data/bin',
    sock: () => sock ?? undefined,
    lifecycle,
    emit: <C extends EventChannel>(projectId: string, channel: C, payload: IpcEventMap[C]) => {
      events.push({ projectId, channel, payload })
    },
    log: () => {}
  })
}

describe('create', () => {
  it('starts a Claude tab with our settings in the project folder', () => {
    const tabs = manager()
    const tab = tabs.create(A, { kind: 'claude' })
    expect(tab).toMatchObject({ kind: 'claude', cwd: projA })
    const pty = backend.last
    expect(pty.argv).toEqual(['claude', '--settings', '/data/hooks.json'])
    expect(pty.options.cwd).toBe(projA)
    expect(pty.options.env.APP_TAB_ID).toBe(tab.id)
    expect(pty.options.env.CC_COCKPIT_SOCK).toBe('/data/app.sock')
    expect(pty.options.env.PATH?.startsWith('/data/bin')).toBe(true)
    expect(tabs.list(A)).toEqual([tab])
    expect(tabs.list(B)).toEqual([])
  })

  it('exports no socket path while main is not listening, but keeps the tab vars', () => {
    const tabs = manager(null)
    const tab = tabs.create(A, { kind: 'claude' })
    const env = backend.last.options.env
    expect(env.APP_TAB_ID).toBe(tab.id)
    expect(env.APP_TAB_TOKEN).toMatch(/^[0-9a-f]{64}$/)
    expect('CC_COCKPIT_SOCK' in env).toBe(false)
  })

  it('a cockpit started from inside a Claude session passes no nested-session variables to its tabs', () => {
    // Design §3 / pty-env.ts: with CLAUDECODE set in the environment `claude` refuses to start.
    const tabs = manager('/data/app.sock', undefined, undefined, {
      PATH: '/usr/bin',
      SHELL: '/bin/zsh',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      ELECTRON_RUN_AS_NODE: '1'
    })
    for (const [i, kind, program] of [
      [0, 'claude', 'claude'],
      [1, 'shell', '/bin/zsh']
    ] as const) {
      tabs.create(A, { kind })
      // Check the spawn just made: if a create stopped spawning, `last` would still be the
      // previous tab and the shell iteration would re-check the Claude tab's env.
      expect(backend.spawned).toHaveLength(i + 1)
      expect(backend.last.argv[0]).toBe(program)
      const env = backend.last.options.env
      expect(env).not.toHaveProperty('CLAUDECODE')
      expect(env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT')
      expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
      expect(env.SHELL).toBe('/bin/zsh')
    }
  })

  it('passes a prompt as an argv argument and never types it', () => {
    manager().create(A, { kind: 'claude', prompt: 'hello' })
    expect(backend.last.argv).toEqual(['claude', '--settings', '/data/hooks.json', '--', ' hello'])
    expect(backend.last.writes).toEqual([])
  })

  it('starts a shell tab as a login shell with its own window token and the socket', () => {
    const tabs = manager()
    const tab = tabs.create(A, { kind: 'shell' })
    expect(backend.last.argv).toEqual(['/bin/zsh', '-l'])
    const env = backend.last.options.env
    expect(env.APP_TAB_TOKEN).toMatch(/^[0-9a-f]{64}$/)
    expect(env.APP_TAB_ID).toBe(tab.id)
    // Without the socket path the CLI would treat the token as "app not listening" and do nothing.
    expect(env.CC_COCKPIT_SOCK).toBe('/data/app.sock')
    // A window token: the project only, no tab id, so it never stands for a Claude session.
    expect(tabs.resolveToken(env.APP_TAB_TOKEN!)).toEqual({ kind: 'window', projectId: A })
    expect(tab.kind).toBe('shell')
  })

  it('refuses a prompt for a shell tab and an unknown kind', () => {
    const tabs = manager()
    expect(() => tabs.create(A, { kind: 'shell', prompt: 'x' })).toThrow(/prompt/)
    expect(() => tabs.create(A, { kind: 'vim' as 'shell' })).toThrow(/kind/)
    expect(backend.spawned).toHaveLength(0)
  })

  it('accepts a subfolder, absolute or relative', () => {
    const tabs = manager()
    expect(tabs.create(A, { kind: 'shell', cwd: 'sub' }).cwd).toBe(join(projA, 'sub'))
    expect(tabs.create(A, { kind: 'shell', cwd: join(projA, 'sub') }).cwd).toBe(join(projA, 'sub'))
  })

  it('refuses a cwd outside the project and creates nothing', () => {
    const tabs = manager()
    for (const cwd of ['..', '../b', outside, '/', join(projA, '..', 'outside'), 'sub/../..']) {
      expect(() => tabs.create(A, { kind: 'shell', cwd }), cwd).toThrow(/outside the project/)
    }
    expect(backend.spawned).toHaveLength(0)
    expect(tabs.list(A)).toEqual([])
  })

  it('refuses a symlink inside the project that points outside', () => {
    symlinkSync(outside, join(projA, 'escape'))
    expect(() => manager().create(A, { kind: 'shell', cwd: 'escape' })).toThrow(/outside the project/)
  })

  it('refuses a missing path, a file and an unknown project', () => {
    const tabs = manager()
    writeFileSync(join(projA, 'file.txt'), 'x')
    expect(() => tabs.create(A, { kind: 'shell', cwd: 'nope' })).toThrow(/does not exist/)
    expect(() => tabs.create(A, { kind: 'shell', cwd: 'file.txt' })).toThrow(/not a directory/)
    expect(() => tabs.create('cccccccccccccccc', { kind: 'shell' })).toThrow(/unknown project/)
  })

  it('creates no tab when the spawn fails', () => {
    const tabs = manager()
    backend.failWith = new Error('ENOENT: claude')
    expect(() => tabs.create(A, { kind: 'claude' })).toThrow(/ENOENT/)
    expect(tabs.list(A)).toEqual([])
    // Nothing half-registered: the next create works.
    expect(tabs.create(A, { kind: 'claude' }).id).toBeTruthy()
  })

  it('gives every tab its own id and token', () => {
    const tabs = manager()
    const one = tabs.create(A, { kind: 'claude' })
    const two = tabs.create(A, { kind: 'claude' })
    const three = tabs.create(B, { kind: 'claude' })
    expect(new Set([one.id, two.id, three.id]).size).toBe(3)
    const tokens = backend.spawned.map((p) => p.options.env.APP_TAB_TOKEN)
    expect(new Set(tokens).size).toBe(3)
    for (const t of tokens) expect(t).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('output and exit', () => {
  it('routes output and exit to the tab\'s project', () => {
    const tabs = manager()
    const a = tabs.create(A, { kind: 'shell' })
    const b = tabs.create(B, { kind: 'shell' })
    backend.spawned[0]!.emit('from a')
    backend.spawned[1]!.emit('from b')
    vi.advanceTimersByTime(20)
    expect(events).toEqual([
      { projectId: A, channel: 'tabs.data', payload: { tabId: a.id, data: 'from a' } },
      { projectId: B, channel: 'tabs.data', payload: { tabId: b.id, data: 'from b' } }
    ])
  })

  it('records the exit code and signal', () => {
    const tabs = manager()
    const tab = tabs.create(A, { kind: 'claude' })
    backend.last.exit(3)
    expect(tabs.list(A)[0]).toMatchObject({ id: tab.id, exit: { code: 3, signal: null } })
    expect(events.at(-1)).toEqual({
      projectId: A,
      channel: 'tabs.exit',
      payload: { tabId: tab.id, code: 3, signal: null, gen: 1 }
    })
    const two = tabs.create(A, { kind: 'claude' })
    backend.last.exit(0, 9)
    expect(tabs.list(A)[1]).toMatchObject({ id: two.id, exit: { code: 0, signal: 9 } })
  })

  it('writes to an exited tab are ignored', () => {
    const tabs = manager()
    const tab = tabs.create(A, { kind: 'claude' })
    backend.last.exit(1)
    tabs.input(A, tab.id, 'ls\r')
    expect(backend.last.writes).toEqual([])
  })
})

describe('project scoping', () => {
  it('treats another project\'s tab as unknown', () => {
    const tabs = manager()
    const tab = tabs.create(A, { kind: 'shell' })
    const pty = backend.last
    expect(() => tabs.close(B, tab.id)).toThrow(/unknown tab/)
    expect(() => tabs.restart(B, tab.id)).toThrow(/unknown tab/)
    expect(() => tabs.reorder(B, tab.id, 0)).toThrow(/unknown tab/)
    // Fire-and-forget calls are ignored rather than thrown: a late ack is a normal race.
    tabs.input(B, tab.id, 'evil')
    tabs.resize(B, tab.id, 10, 10)
    tabs.ack(B, tab.id, 5)
    expect(pty.writes).toEqual([])
    expect(pty.resizes).toEqual([])
    expect(pty.killed).toBe(0)
    expect(tabs.list(A)).toHaveLength(1)
  })
})

describe('input, resize', () => {
  it('sends typing straight to the PTY and validates the size', () => {
    const tabs = manager()
    const tab = tabs.create(A, { kind: 'shell' })
    tabs.input(A, tab.id, 'ls\r')
    tabs.resize(A, tab.id, 120, 40)
    tabs.resize(A, tab.id, 0, 40)
    expect(backend.last.writes).toEqual(['ls\r'])
    expect(backend.last.resizes).toEqual([[120, 40]])
  })

  it('flow control: pauses on unacked output, resumes on ack, resets on attach', () => {
    const tabs = manager()
    const tab = tabs.create(A, { kind: 'shell' })
    const pty = backend.last
    pty.emit('x'.repeat(1024 * 1024 + 10))
    vi.advanceTimersByTime(20)
    expect(pty.paused).toBe(true)
    tabs.ack(A, tab.id, 1024 * 1024 + 10)
    expect(pty.paused).toBe(false)
    pty.emit('x'.repeat(1024 * 1024 + 10))
    vi.advanceTimersByTime(20)
    expect(pty.paused).toBe(true)
    // The page reloaded and will never ack that: re-attaching unwedges the PTY.
    expect(tabs.attach(A)).toHaveLength(1)
    expect(pty.paused).toBe(false)
  })
})

describe('close', () => {
  it('kills the PTY, forgets the tab and drops its late exit', () => {
    const tabs = manager()
    const tab = tabs.create(A, { kind: 'shell' })
    const pty = backend.last
    tabs.close(A, tab.id)
    expect(pty.killed).toBe(1)
    expect(tabs.list(A)).toEqual([])
    pty.exit(0, 1)
    expect(events.filter((e) => e.channel === 'tabs.exit')).toEqual([])
    expect(() => tabs.close(A, tab.id)).toThrow(/unknown tab/)
  })

  it('closeProject kills only that project\'s tabs', () => {
    const tabs = manager()
    tabs.create(A, { kind: 'shell' })
    tabs.create(A, { kind: 'shell' })
    tabs.create(B, { kind: 'shell' })
    tabs.closeProject(A)
    expect(backend.spawned.map((p) => p.killed)).toEqual([1, 1, 0])
    expect(tabs.list(A)).toEqual([])
    expect(tabs.list(B)).toHaveLength(1)
  })

  it('a child that ignores HUP gets SIGKILL after the grace period, on close and closeProject', () => {
    const tabs = manager()
    const one = tabs.create(A, { kind: 'shell' })
    const closed = backend.last
    tabs.create(B, { kind: 'shell' })
    const windowClosed = backend.last
    tabs.close(A, one.id)
    tabs.closeProject(B)
    expect(closed.signals).toEqual([undefined])
    expect(windowClosed.signals).toEqual([undefined])
    vi.advanceTimersByTime(KILL_GRACE_MS)
    expect(closed.signals).toEqual([undefined, 'SIGKILL'])
    expect(windowClosed.signals).toEqual([undefined, 'SIGKILL'])
  })

  it('disposeAll kills everything', () => {
    const tabs = manager()
    tabs.create(A, { kind: 'shell' })
    tabs.create(B, { kind: 'shell' })
    tabs.disposeAll()
    expect(backend.spawned.map((p) => p.killed)).toEqual([1, 1])
    expect(tabs.list(A)).toEqual([])
  })
})

describe('reorder', () => {
  it('moves a tab and clamps the index', () => {
    const tabs = manager()
    const [t1, t2, t3] = [1, 2, 3].map(() => tabs.create(A, { kind: 'shell' }))
    const ids = (): string[] => tabs.list(A).map((t) => t.id)
    tabs.reorder(A, t3!.id, 0)
    expect(ids()).toEqual([t3!.id, t1!.id, t2!.id])
    tabs.reorder(A, t3!.id, 99)
    expect(ids()).toEqual([t1!.id, t2!.id, t3!.id])
    tabs.reorder(A, t2!.id, -5)
    expect(ids()).toEqual([t2!.id, t1!.id, t3!.id])
    expect(() => tabs.reorder(A, t1!.id, 1.5)).toThrow(/integer/)
  })
})

describe('rename', () => {
  it('names a Claude tab, tells the lifecycle and the saver, shows it in info, clears with null', () => {
    const renamed: Array<[string, string | null]> = []
    let saved = 0
    const tabs = manager(undefined, { renamed: (id, name) => renamed.push([id, name]) }, () => saved++)
    const tab = tabs.create(A, { kind: 'claude' })
    const before = saved
    tabs.rename(A, tab.id, '  My name ')
    expect(tabs.list(A)[0]!.name).toBe('My name')
    expect(renamed).toEqual([[tab.id, 'My name']])
    expect(saved).toBe(before + 1)
    tabs.rename(A, tab.id, 'My name')
    expect(renamed).toHaveLength(1)
    tabs.rename(A, tab.id, null)
    expect(tabs.list(A)[0]!.name).toBeUndefined()
    expect(renamed.at(-1)).toEqual([tab.id, null])
  })

  it('refuses another project, a shell tab and a bad name', () => {
    const tabs = manager()
    const claude = tabs.create(A, { kind: 'claude' })
    const shell = tabs.create(A, { kind: 'shell' })
    expect(() => tabs.rename(B, claude.id, 'x')).toThrow(/unknown tab/)
    expect(() => tabs.rename(A, shell.id, 'x')).toThrow(/Claude tab/)
    expect(() => tabs.rename(A, claude.id, '')).toThrow(/empty/)
    expect(() => tabs.rename(A, claude.id, 'a'.repeat(61))).toThrow(/60/)
    expect(() => tabs.rename(A, claude.id, 'a\u0000b')).toThrow(/control/)
  })

  it('a restored tab keeps its name, a restart keeps it, and the started event carries it', () => {
    const started: Array<string | undefined> = []
    const tabs = manager(undefined, { started: (t) => started.push(t.name) })
    const tab = tabs.restoreTab(A, { kind: 'claude', name: 'Saved' })
    expect(tab.name).toBe('Saved')
    expect(started).toEqual(['Saved'])
    // A bad saved name loses only the name.
    expect(tabs.restoreTab(A, { kind: 'claude', name: 'bad\u0007' }).name).toBeUndefined()
    expect(() => tabs.restoreTab(A, { kind: 'shell', name: 'x' })).toThrow(/Claude tab/)
  })
})

describe('restart', () => {
  it('relaunches an exited Claude tab with the same id, cwd and a new token', () => {
    const tabs = manager()
    const tab = tabs.create(A, { kind: 'claude', cwd: 'sub' })
    const firstToken = backend.last.options.env.APP_TAB_TOKEN
    backend.last.exit(2)
    const again = tabs.restart(A, tab.id)
    expect(again).toEqual({ id: tab.id, kind: 'claude', cwd: join(projA, 'sub'), gen: 2 })
    expect(backend.spawned).toHaveLength(2)
    expect(backend.last.argv).toEqual(['claude', '--settings', '/data/hooks.json'])
    expect(backend.last.options.cwd).toBe(join(projA, 'sub'))
    expect(backend.last.options.env.APP_TAB_ID).toBe(tab.id)
    expect(backend.last.options.env.APP_TAB_TOKEN).not.toBe(firstToken)
    // The new process can exit and be restarted again under the same id.
    backend.last.exit(0)
    expect(tabs.list(A)[0]!.exit).toEqual({ code: 0, signal: null })
  })

  it('resumes the session when its id is known and it had a prompt', () => {
    const tabs = manager()
    const tab = tabs.create(A, { kind: 'claude' })
    tabs.sessionStarted(tab.id, '0b6a3f0e-1c11-4f7e-9d0e-5b1f7a1c2d3e')
    tabs.sessionPrompted(tab.id)
    backend.last.exit(0)
    const again = tabs.restart(A, tab.id)
    expect(again.sessionId).toBe('0b6a3f0e-1c11-4f7e-9d0e-5b1f7a1c2d3e')
    expect(backend.last.argv).toEqual([
      'claude',
      '--settings',
      '/data/hooks.json',
      '--resume',
      '0b6a3f0e-1c11-4f7e-9d0e-5b1f7a1c2d3e'
    ])
  })

  it('refuses a running tab, and keeps the tab exited when the relaunch fails', () => {
    const tabs = manager()
    const tab = tabs.create(A, { kind: 'shell' })
    expect(() => tabs.restart(A, tab.id)).toThrow(/still running/)
    backend.last.exit(1)
    backend.failWith = new Error('boom')
    expect(() => tabs.restart(A, tab.id)).toThrow(/boom/)
    expect(tabs.list(A)[0]!.exit).toEqual({ code: 1, signal: null })
    // And a later restart still works; the failed one did not count as a process.
    const again = tabs.restart(A, tab.id)
    expect(again.exit).toBeUndefined()
    expect(again.gen).toBe(2)
  })

  it("numbers the tab's processes, and each exit carries the number of the process that ended", () => {
    // The renderer orders replies and events by it (tabs-store.ts): an exit of a restarted
    // process can arrive before the restart reply and must not be undone by it.
    const tabs = manager()
    const tab = tabs.create(A, { kind: 'shell' })
    expect(tab.gen).toBe(1)
    backend.last.exit(1)
    expect(events.at(-1)).toMatchObject({ channel: 'tabs.exit', payload: { tabId: tab.id, gen: 1 } })
    expect(tabs.restart(A, tab.id).gen).toBe(2)
    backend.last.exit(127)
    expect(events.at(-1)).toMatchObject({ channel: 'tabs.exit', payload: { tabId: tab.id, code: 127, gen: 2 } })
    expect(tabs.list(A)[0]).toMatchObject({ gen: 2, exit: { code: 127, signal: null } })
  })

  it('refuses to restart into a folder that left the project', () => {
    const tabs = manager()
    const tab = tabs.create(A, { kind: 'shell', cwd: 'sub' })
    backend.last.exit(0)
    rmSync(join(projA, 'sub'), { recursive: true })
    expect(() => tabs.restart(A, tab.id)).toThrow(/does not exist/)
  })
})

describe('resolveCwd', () => {
  it('defaults to the project folder', () => {
    expect(resolveCwd(projA, undefined)).toBe(projA)
    expect(resolveCwd(projA, '')).toBe(projA)
  })

  it('does not mistake a sibling with the same prefix for a subfolder', () => {
    mkdirSync(join(root, 'a-evil'))
    expect(() => resolveCwd(projA, join(root, 'a-evil'))).toThrow(/outside the project/)
  })

  it('allows a folder whose name starts with two dots', () => {
    mkdirSync(join(projA, '..cache'))
    expect(resolveCwd(projA, '..cache')).toBe(join(projA, '..cache'))
  })
})

describe('resolveToken', () => {
  it('maps a Claude tab token to that tab and its project', () => {
    const tabs = manager()
    const a = tabs.create(A, { kind: 'claude' })
    const tokenA = backend.last.options.env.APP_TAB_TOKEN!
    const b = tabs.create(B, { kind: 'claude' })
    const tokenB = backend.last.options.env.APP_TAB_TOKEN!
    expect(tabs.resolveToken(tokenA)).toEqual({ kind: 'session', tabId: a.id, projectId: A })
    expect(tabs.resolveToken(tokenB)).toEqual({ kind: 'session', tabId: b.id, projectId: B })
  })

  it('maps a shell or command tab token to a window token of its project, never a session', () => {
    const tabs = manager()
    tabs.create(A, { kind: 'shell' })
    const shell = backend.last.options.env.APP_TAB_TOKEN!
    tabs.createCommand(B, { label: 'dev', command: 'npm run dev' })
    const command = backend.last.options.env.APP_TAB_TOKEN!
    const claude = tabs.create(A, { kind: 'claude' })
    const session = backend.last.options.env.APP_TAB_TOKEN!
    expect(new Set([shell, command, session]).size).toBe(3)
    expect(tabs.resolveToken(shell)).toEqual({ kind: 'window', projectId: A })
    expect(tabs.resolveToken(command)).toEqual({ kind: 'window', projectId: B })
    expect(tabs.resolveToken(session)).toEqual({ kind: 'session', tabId: claude.id, projectId: A })
  })

  it('a shell tab\'s window token stops after close, and an old one after restart', () => {
    const tabs = manager()
    const tab = tabs.create(A, { kind: 'shell' })
    const first = backend.last.options.env.APP_TAB_TOKEN!
    backend.last.exit(1)
    // Kept while exited, like a Claude tab's: a background job of the shell may still call `ccc`.
    expect(tabs.resolveToken(first)).toEqual({ kind: 'window', projectId: A })
    tabs.restart(A, tab.id)
    const second = backend.last.options.env.APP_TAB_TOKEN!
    expect(second).not.toBe(first)
    expect(tabs.resolveToken(first)).toBeUndefined()
    expect(tabs.resolveToken(second)).toEqual({ kind: 'window', projectId: A })
    tabs.close(A, tab.id)
    expect(tabs.resolveToken(second)).toBeUndefined()
  })

  it('refuses unknown, malformed and empty tokens', () => {
    const tabs = manager()
    tabs.create(A, { kind: 'claude' })
    const token = backend.last.options.env.APP_TAB_TOKEN!
    expect(tabs.resolveToken('0'.repeat(64))).toBeUndefined()
    expect(tabs.resolveToken(token.toUpperCase())).toBeUndefined()
    expect(tabs.resolveToken(token.slice(0, 62))).toBeUndefined()
    expect(tabs.resolveToken('')).toBeUndefined()
    expect(tabs.resolveToken(undefined as unknown as string)).toBeUndefined()
  })

  it('stops resolving after close, and an old token stops after restart', () => {
    const tabs = manager()
    const tab = tabs.create(A, { kind: 'claude' })
    const first = backend.last.options.env.APP_TAB_TOKEN!
    backend.last.exit(0)
    // Still valid while exited: a SessionEnd hook can land just after the process exit.
    expect(tabs.resolveToken(first)).toEqual({ kind: 'session', tabId: tab.id, projectId: A })
    tabs.restart(A, tab.id)
    const second = backend.last.options.env.APP_TAB_TOKEN!
    expect(tabs.resolveToken(first)).toBeUndefined()
    expect(tabs.resolveToken(second)).toEqual({ kind: 'session', tabId: tab.id, projectId: A })
    tabs.close(A, tab.id)
    expect(tabs.resolveToken(second)).toBeUndefined()
  })
})

describe('lifecycle', () => {
  function recording(): { calls: string[]; lifecycle: TabLifecycle } {
    const calls: string[] = []
    return {
      calls,
      lifecycle: {
        started: (t) => calls.push(`started ${t.kind} ${t.projectId} ${t.tabId}`),
        exited: (id, code, signal) => calls.push(`exited ${id} ${code} ${signal}`),
        closed: (id) => calls.push(`closed ${id}`)
      }
    }
  }

  it('reports start, exit, restart, close in order', () => {
    const { calls, lifecycle } = recording()
    const tabs = manager('/data/app.sock', lifecycle)
    const tab = tabs.create(A, { kind: 'claude' })
    backend.last.exit(4, 9)
    tabs.restart(A, tab.id)
    tabs.close(A, tab.id)
    expect(calls).toEqual([
      `started claude ${A} ${tab.id}`,
      `exited ${tab.id} 4 9`,
      `started claude ${A} ${tab.id}`,
      `closed ${tab.id}`
    ])
  })

  it('reports the output of Claude tabs only (for the terminal title), after the window got it', () => {
    const outputs: string[] = []
    const tabs = manager('/data/app.sock', { output: (id, chunk) => outputs.push(`${id} ${chunk}`) })
    const claude = tabs.create(A, { kind: 'claude' })
    tabs.create(A, { kind: 'shell' })
    backend.spawned[0]!.emit('\x1b]0;✳ Topic\x07')
    backend.spawned[1]!.emit('shell output')
    vi.advanceTimersByTime(20)
    expect(outputs).toEqual([`${claude.id} \x1b]0;✳ Topic\x07`])
    expect(events.filter((e) => e.channel === 'tabs.data')).toHaveLength(2)
  })

  it('reports shell tabs too (the registry filters by kind) and nothing for a failed create', () => {
    const { calls, lifecycle } = recording()
    const tabs = manager('/data/app.sock', lifecycle)
    const shell = tabs.create(A, { kind: 'shell' })
    backend.failWith = new Error('spawn failed')
    expect(() => tabs.create(A, { kind: 'claude' })).toThrow(/spawn failed/)
    expect(calls).toEqual([`started shell ${A} ${shell.id}`])
  })

  it('reports every tab as closed when its project closes, and a late exit is dropped', () => {
    const { calls, lifecycle } = recording()
    const tabs = manager('/data/app.sock', lifecycle)
    const one = tabs.create(A, { kind: 'claude' })
    const two = tabs.create(A, { kind: 'claude' })
    tabs.create(B, { kind: 'claude' })
    const pty = backend.spawned[0]!
    calls.length = 0
    tabs.closeProject(A)
    expect(calls).toEqual([`closed ${one.id}`, `closed ${two.id}`])
    pty.exit(0)
    expect(calls).toHaveLength(2)
  })

  it('a throwing listener is logged and does not undo the tab operation', () => {
    const tabs = manager('/data/app.sock', {
      started: () => {
        throw new Error('listener bug')
      }
    })
    const tab = tabs.create(A, { kind: 'claude' })
    expect(tabs.list(A).map((t) => t.id)).toEqual([tab.id])
  })
})

describe('resumable session ids', () => {
  const RESUME = ['claude', '--settings', '/data/hooks.json', '--resume']
  const FRESH = ['claude', '--settings', '/data/hooks.json']

  it('a session nobody typed into is neither reported nor resumed', () => {
    const tabs = manager()
    const tab = tabs.create(A, { kind: 'claude' })
    tabs.sessionStarted(tab.id, 'sess-1')
    expect(tabs.list(A)[0]!.sessionId).toBeUndefined()
    backend.last.exit(0)
    tabs.restart(A, tab.id)
    expect(backend.last.argv).toEqual(FRESH)
  })

  it('a prompt before the SessionStart (none reported) changes nothing', () => {
    const tabs = manager()
    const tab = tabs.create(A, { kind: 'claude' })
    tabs.sessionPrompted(tab.id)
    expect(tabs.list(A)[0]!.sessionId).toBeUndefined()
  })

  it('/clear (a later SessionStart with a new id) makes the tab unresumable until the next prompt', () => {
    const tabs = manager()
    const tab = tabs.create(A, { kind: 'claude' })
    tabs.sessionStarted(tab.id, 'sess-1')
    tabs.sessionPrompted(tab.id)
    tabs.sessionStarted(tab.id, 'sess-2')
    expect(tabs.list(A)[0]!.sessionId).toBeUndefined()
    tabs.sessionPrompted(tab.id)
    expect(tabs.list(A)[0]!.sessionId).toBe('sess-2')
  })

  it('/clear reported with its source still drops resumability until the next prompt', () => {
    const changed: string[] = []
    const tabs = manager(undefined, undefined, (id) => changed.push(id))
    const tab = tabs.create(A, { kind: 'claude' })
    tabs.sessionStarted(tab.id, 'sess-1', 'startup')
    tabs.sessionPrompted(tab.id)
    changed.length = 0
    tabs.sessionStarted(tab.id, 'sess-2', 'clear')
    expect(tabs.list(A)[0]!.sessionId).toBeUndefined()
    expect(changed).toEqual([A])
  })

  it('an interactive /resume (source "resume") keeps the picked conversation resumable under its id', () => {
    const changed: string[] = []
    const tabs = manager(undefined, undefined, (id) => changed.push(id))
    const tab = tabs.create(A, { kind: 'claude' })
    tabs.sessionStarted(tab.id, 'sess-1', 'startup')
    tabs.sessionPrompted(tab.id)
    changed.length = 0
    // The user picks another stored conversation in the same process: no `resuming` any more.
    tabs.sessionStarted(tab.id, 'sess-old', 'resume')
    expect(tabs.list(A)[0]!.sessionId).toBe('sess-old')
    expect(changed).toEqual([A])
    // Quitting before another prompt resumes it, not a fresh claude.
    backend.last.exit(0)
    tabs.restart(A, tab.id)
    expect(backend.last.argv).toEqual([...RESUME, 'sess-old'])
  })

  it('an interactive /resume in a session nobody typed into is resumable as well', () => {
    const tabs = manager()
    const tab = tabs.create(A, { kind: 'claude' })
    tabs.sessionStarted(tab.id, 'sess-1', 'startup')
    tabs.sessionStarted(tab.id, 'sess-old', 'resume')
    expect(tabs.list(A)[0]!.sessionId).toBe('sess-old')
  })

  it('a fork (source "fork") carries its conversation and is resumable', () => {
    const tabs = manager()
    const tab = tabs.create(A, { kind: 'claude' })
    tabs.sessionStarted(tab.id, 'sess-1', 'startup')
    tabs.sessionPrompted(tab.id)
    tabs.sessionStarted(tab.id, 'sess-fork', 'fork')
    expect(tabs.list(A)[0]!.sessionId).toBe('sess-fork')
  })

  it('a startup SessionStart or an unknown source stays unresumable until a prompt', () => {
    const tabs = manager()
    const one = tabs.create(A, { kind: 'claude' })
    tabs.sessionStarted(one.id, 'sess-1', 'startup')
    const two = tabs.create(A, { kind: 'claude' })
    tabs.sessionStarted(two.id, 'sess-2', 'something-new')
    expect(tabs.list(A).map((t) => t.sessionId)).toEqual([undefined, undefined])
  })

  it('compact (the live id repeated) leaves a resumable id saved', () => {
    const tabs = manager()
    const tab = tabs.create(A, { kind: 'claude' })
    tabs.sessionStarted(tab.id, 'sess-1', 'startup')
    tabs.sessionPrompted(tab.id)
    tabs.sessionStarted(tab.id, 'sess-1', 'compact')
    expect(tabs.list(A)[0]!.sessionId).toBe('sess-1')
  })

  it('after a failed resume, the fresh process (source "startup") still replaces the saved id', () => {
    const tabs = manager()
    const tab = tabs.restoreTab(A, { kind: 'claude', resumeId: 'sess-1' })
    backend.last.exit(1)
    tabs.restart(A, tab.id)
    expect(backend.last.argv).toEqual(FRESH)
    tabs.sessionStarted(tab.id, 'sess-new', 'startup')
    expect(tabs.list(A)[0]!.sessionId).toBeUndefined()
  })

  it('a resumed process keeps resumable through its first SessionStart, even under a new id', () => {
    const tabs = manager()
    const tab = tabs.restoreTab(A, { kind: 'claude', resumeId: 'sess-1' })
    // Claude may give the resumed conversation a new id; it still holds the old messages.
    tabs.sessionStarted(tab.id, 'sess-1b')
    expect(tabs.list(A)[0]!.sessionId).toBe('sess-1b')
    // A second SessionStart in the same process is a /clear: an empty session.
    tabs.sessionStarted(tab.id, 'sess-2')
    expect(tabs.list(A)[0]!.sessionId).toBeUndefined()
  })

  it('the same id reported by a resumed process ends `resuming`, so a later /clear is not resumable', () => {
    const tabs = manager()
    const tab = tabs.restoreTab(A, { kind: 'claude', resumeId: 'sess-1' })
    tabs.sessionStarted(tab.id, 'sess-1')
    tabs.sessionStarted(tab.id, 'sess-2')
    expect(tabs.list(A)[0]!.sessionId).toBeUndefined()
  })

  it('a resumed Claude that fails before any SessionStart keeps the saved id; Restart runs fresh', () => {
    const changed: string[] = []
    const tabs = manager(undefined, undefined, (id) => changed.push(id))
    const tab = tabs.restoreTab(A, { kind: 'claude', resumeId: 'sess-1' })
    expect(backend.last.argv).toEqual([...RESUME, 'sess-1'])
    // Claude refused the id, or `claude` never ran (not on PATH: node-pty exits 1): main cannot
    // tell, so the record keeps the id and no change is saved.
    backend.last.exit(1)
    expect(tabs.list(A)[0]!.sessionId).toBe('sess-1')
    expect(changed).toEqual([])
    tabs.restart(A, tab.id)
    expect(backend.last.argv).toEqual(FRESH)
    // Still saved while the fresh process has not started a session.
    expect(tabs.list(A)[0]!.sessionId).toBe('sess-1')
    changed.length = 0
    // Its SessionStart replaces the id: only now is the old one dropped (the new one is not
    // resumable until a prompt).
    tabs.sessionStarted(tab.id, 'sess-new')
    expect(tabs.list(A)[0]!.sessionId).toBeUndefined()
    expect(changed).toEqual([A])
    tabs.sessionPrompted(tab.id)
    expect(tabs.list(A)[0]!.sessionId).toBe('sess-new')
    backend.last.exit(1)
    tabs.restart(A, tab.id)
    expect(backend.last.argv).toEqual([...RESUME, 'sess-new'])
  })

  it('after a failed resume, a fresh restart that dies too keeps the id and restarts fresh again', () => {
    const tabs = manager()
    const tab = tabs.restoreTab(A, { kind: 'claude', resumeId: 'sess-1' })
    backend.last.exit(127)
    tabs.restart(A, tab.id)
    expect(backend.last.argv).toEqual(FRESH)
    backend.last.exit(1)
    tabs.restart(A, tab.id)
    expect(backend.last.argv).toEqual(FRESH)
    expect(tabs.list(A)[0]!.sessionId).toBe('sess-1')
  })

  it('a resumed Claude killed by a signal before SessionStart counts as failed, even as code 0', () => {
    const tabs = manager()
    const tab = tabs.restoreTab(A, { kind: 'claude', resumeId: 'sess-1' })
    backend.last.exit(0, 9)
    tabs.restart(A, tab.id)
    expect(backend.last.argv).toEqual(FRESH)
    expect(tabs.list(A)[0]!.sessionId).toBe('sess-1')
  })

  it('a resumed Claude that quits normally, or fails after its SessionStart, keeps the id', () => {
    const tabs = manager()
    const quit = tabs.restoreTab(A, { kind: 'claude', resumeId: 'sess-1' })
    backend.last.exit(0)
    tabs.restart(A, quit.id)
    expect(backend.last.argv).toEqual([...RESUME, 'sess-1'])

    const crashed = tabs.restoreTab(A, { kind: 'claude', resumeId: 'sess-2' })
    tabs.sessionStarted(crashed.id, 'sess-2')
    backend.last.exit(1)
    tabs.restart(A, crashed.id)
    expect(backend.last.argv).toEqual([...RESUME, 'sess-2'])
  })
})

describe('restoreTab', () => {
  it('resumes a Claude session and keeps the id as the tab session id', () => {
    const tabs = manager()
    const tab = tabs.restoreTab(A, { kind: 'claude', resumeId: 'abc-123' })
    expect(backend.last.argv).toEqual(['claude', '--settings', '/data/hooks.json', '--resume', 'abc-123'])
    // Kept at once: quitting again before the SessionStart hook must not lose the session.
    expect(tab.sessionId).toBe('abc-123')
    expect(tabs.list(A)).toEqual([tab])
  })

  it('starts a Claude tab without an id fresh, and a shell tab as a login shell', () => {
    const tabs = manager()
    const fresh = tabs.restoreTab(A, { kind: 'claude' })
    expect(backend.last.argv).toEqual(['claude', '--settings', '/data/hooks.json'])
    expect(fresh.sessionId).toBeUndefined()
    tabs.restoreTab(A, { kind: 'shell', cwd: join(projA, 'sub') })
    expect(backend.last.argv).toEqual(['/bin/zsh', '-l'])
    expect(backend.last.options.cwd).toBe(join(projA, 'sub'))
  })

  it('refuses a session id that would be read as an option, and a shell resume', () => {
    const tabs = manager()
    expect(() => tabs.restoreTab(A, { kind: 'claude', resumeId: '--settings' })).toThrow(/invalid Claude session id/)
    expect(() => tabs.restoreTab(A, { kind: 'shell', resumeId: 'abc' })).toThrow(/only a Claude tab/)
    expect(tabs.list(A)).toEqual([])
  })

  it('still keeps the tab inside its project', () => {
    const tabs = manager()
    expect(() => tabs.restoreTab(A, { kind: 'shell', cwd: outside })).toThrow(/outside the project/)
    expect(() => tabs.restoreTab('cccccccccccccccc', { kind: 'shell' })).toThrow(/unknown project/)
  })

  it('does not report a change (the restorer saves once after the batch)', () => {
    const changed: string[] = []
    const tabs = manager(undefined, undefined, (id) => changed.push(id))
    tabs.restoreTab(A, { kind: 'shell' })
    expect(changed).toEqual([])
  })
})

describe('Claude plugin dirs', () => {
  const CORE = '/data/claude-plugins/core'

  /** A manager whose pluginDirsFor answers from `dirs` at call time and records who asked. */
  function withDirs(dirs: Record<string, string[]>, asked: string[] = []): TabManager {
    return new TabManager({
      backend,
      projectPath: (id) => ({ [A]: projA, [B]: projB })[id],
      loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/u' }),
      hooksPath: '/data/hooks.json',
      pluginDirsFor: (projectId) => {
        asked.push(projectId)
        return dirs[projectId] ?? []
      },
      binDir: '/data/bin',
      sock: () => '/data/app.sock',
      emit: () => {},
      log: () => {}
    })
  }

  it("a new Claude tab gets its project's dirs, before a prompt", () => {
    const asked: string[] = []
    const tabs = withDirs({ [A]: [CORE] }, asked)
    tabs.create(A, { kind: 'claude', prompt: 'hi' })
    expect(backend.last.argv).toEqual(['claude', '--settings', '/data/hooks.json', '--plugin-dir', CORE, '--', ' hi'])
    expect(asked).toEqual([A])
  })

  it('a tab restored at launch gets the dirs, with --resume after them', () => {
    const tabs = withDirs({ [A]: [CORE] })
    tabs.restoreTab(A, { kind: 'claude', resumeId: 'abc-123' })
    expect(backend.last.argv).toEqual([
      'claude',
      '--settings',
      '/data/hooks.json',
      '--plugin-dir',
      CORE,
      '--resume',
      'abc-123'
    ])
  })

  it('a restart reads the current set again (a running session keeps what it started with)', () => {
    const dirs: Record<string, string[]> = { [A]: [CORE] }
    const tabs = withDirs(dirs)
    const tab = tabs.create(A, { kind: 'claude' })
    const first = backend.last
    dirs[A] = [CORE, '/data/claude-plugins/acme.jira']
    expect(first.argv).toEqual(['claude', '--settings', '/data/hooks.json', '--plugin-dir', CORE])
    first.exit(0)
    tabs.restart(A, tab.id)
    expect(backend.last.argv).toEqual([
      'claude',
      '--settings',
      '/data/hooks.json',
      '--plugin-dir',
      CORE,
      '--plugin-dir',
      '/data/claude-plugins/acme.jira'
    ])
  })

  it('asks per project, and shell and command tabs never get them', () => {
    const asked: string[] = []
    const tabs = withDirs({ [A]: [CORE] }, asked)
    tabs.create(B, { kind: 'claude' })
    expect(backend.last.argv).toEqual(['claude', '--settings', '/data/hooks.json'])
    tabs.create(A, { kind: 'shell' })
    expect(backend.last.argv).toEqual(['/bin/zsh', '-l'])
    tabs.createCommand(A, { label: 'Top', command: 'top' })
    expect(backend.last.argv).not.toContain('--plugin-dir')
    expect(asked).toEqual([B])
  })
})

describe('onTabsChanged', () => {
  it('fires for create, reorder, restart, close and a new session id, per project', () => {
    const changed: string[] = []
    const tabs = manager(undefined, undefined, (id) => changed.push(id))
    const one = tabs.create(A, { kind: 'claude' })
    const two = tabs.create(A, { kind: 'shell' })
    tabs.create(B, { kind: 'shell' })
    expect(changed).toEqual([A, A, B])

    tabs.reorder(A, two.id, 0)
    // A new id alone is not saved (nothing to resume yet); its first prompt is.
    tabs.sessionStarted(one.id, 'sess-1')
    expect(changed.slice(3)).toEqual([A])
    tabs.sessionPrompted(one.id)
    expect(changed.slice(3)).toEqual([A, A])

    // The same id again, or a second prompt, is not a change.
    tabs.sessionStarted(one.id, 'sess-1')
    tabs.sessionPrompted(one.id)
    expect(changed).toHaveLength(5)

    backend.spawned[0]!.exit(1)
    tabs.restart(A, one.id)
    tabs.close(A, two.id)
    expect(changed.slice(5)).toEqual([A, A])
  })

  it('fires when /clear drops a saved session id, so quitting next does not resume the cleared one', () => {
    const changed: string[] = []
    const tabs = manager(undefined, undefined, (id) => changed.push(id))
    const tab = tabs.create(A, { kind: 'claude' })
    tabs.sessionStarted(tab.id, 'sess-1')
    tabs.sessionPrompted(tab.id)
    expect(tabs.list(A)[0]!.sessionId).toBe('sess-1')
    changed.length = 0
    // `/clear`: a new SessionStart in the same process, not resumable until its first prompt.
    tabs.sessionStarted(tab.id, 'sess-2')
    expect(changed).toEqual([A])
    expect(tabs.list(A)[0]!.sessionId).toBeUndefined()
    // A second /clear before any prompt: nothing saved changes.
    tabs.sessionStarted(tab.id, 'sess-3')
    expect(changed).toEqual([A])
  })

  it('is not told about a window closing or an unknown tab id, and a throwing listener is contained', () => {
    const changed: string[] = []
    const tabs = manager(undefined, undefined, (id) => {
      changed.push(id)
      throw new Error('listener bug')
    })
    const tab = tabs.create(A, { kind: 'shell' })
    expect(changed).toEqual([A])
    tabs.sessionStarted('no-such-tab', 'x')
    tabs.sessionPrompted('no-such-tab')
    tabs.closeProject(A)
    expect(changed).toEqual([A])
    expect(tabs.list(A)).toEqual([])
    expect(tab.kind).toBe('shell')
  })
})

describe('close on a clean exit', () => {
  const SESSION = '0b6a3f0e-1c11-4f7e-9d0e-5b1f7a1c2d3e'

  function rig(setting: { close: boolean } = { close: true }) {
    const calls: string[] = []
    const changed: string[] = []
    const tabs = manager(
      '/data/app.sock',
      {
        started: (t) => calls.push(`started ${t.tabId}`),
        exited: (id, code, signal) => calls.push(`exited ${id} ${code} ${signal}`),
        closed: (id) => calls.push(`closed ${id}`)
      },
      (projectId) => changed.push(projectId),
      undefined,
      () => setting.close
    )
    return { tabs, calls, changed, setting }
  }

  const channels = () => events.filter((e) => e.channel !== 'tabs.data').map((e) => e.channel)

  it('closes a Claude tab that exits 0 like the user\'s Close, and tells the renderer', () => {
    const { tabs, calls, changed } = rig()
    const keep = tabs.create(A, { kind: 'shell' })
    const tab = tabs.create(A, { kind: 'claude' })
    tabs.sessionStarted(tab.id, SESSION)
    tabs.sessionPrompted(tab.id)
    changed.length = 0
    calls.length = 0
    backend.last.exit(0)
    // Ended, then gone: the session registry sees the same sequence as Close after an exit.
    expect(calls).toEqual([`exited ${tab.id} 0 null`, `closed ${tab.id}`])
    expect(tabs.list(A).map((t) => t.id)).toEqual([keep.id])
    // The record is saved without it (restore.ts drops its session id, as for a closed tab).
    expect(changed).toEqual([A])
    expect(events.at(-1)).toEqual({ projectId: A, channel: 'tabs.removed', payload: { tabId: tab.id, gen: 1 } })
    expect(channels()).not.toContain('tabs.exit')
    // Gone for every caller: its token, input and a Close that raced it.
    expect(tabs.resolveToken(backend.last.options.env.APP_TAB_TOKEN!)).toBeUndefined()
    expect(() => tabs.close(A, tab.id)).toThrow('unknown tab')
  })

  it('closes a shell tab that exits 0, and the last tab leaves the project with none', () => {
    const { tabs } = rig()
    const tab = tabs.create(A, { kind: 'shell' })
    clock += SHELL_MIN_LIFE_MS
    backend.last.exit(0)
    expect(tabs.list(A)).toEqual([])
    expect(events.at(-1)).toMatchObject({ channel: 'tabs.removed', payload: { tabId: tab.id } })
  })

  it.each([0, 1, 130])('closes a shell tab that exits %i after its minimum life', (code) => {
    // A shell reports its last command: zsh's `exit` after Ctrl+C is 130, at a fresh prompt 1.
    const { tabs } = rig()
    tabs.create(A, { kind: 'shell' })
    clock += SHELL_MIN_LIFE_MS
    backend.last.exit(code)
    expect(tabs.list(A)).toEqual([])
  })

  it('keeps a shell tab killed by a signal, however long it ran', () => {
    const { tabs } = rig()
    const tab = tabs.create(A, { kind: 'shell' })
    clock += 60_000
    backend.last.exit(0, 9)
    expect(tabs.list(A).map((t) => t.id)).toEqual([tab.id])
  })

  it('keeps a shell tab that exits within the minimum life, even with code 0', () => {
    const { tabs } = rig()
    const tab = tabs.create(A, { kind: 'shell' })
    clock += SHELL_MIN_LIFE_MS - 1
    backend.last.exit(0)
    expect(tabs.list(A).map((t) => t.id)).toEqual([tab.id])
  })

  it('measures a restarted shell from its new spawn', () => {
    const { tabs } = rig()
    const tab = tabs.create(A, { kind: 'shell' })
    clock += 60_000
    backend.last.exit(0, 9)
    tabs.restart(A, tab.id)
    clock += 10
    backend.last.exit(1)
    expect(tabs.list(A).map((t) => t.id)).toEqual([tab.id])
    tabs.restart(A, tab.id)
    clock += SHELL_MIN_LIFE_MS
    backend.last.exit(1)
    expect(tabs.list(A)).toEqual([])
  })

  it('keeps a shell tab of any exit code under the keep setting', () => {
    const { tabs } = rig({ close: false })
    tabs.create(A, { kind: 'shell' })
    clock += 60_000
    backend.last.exit(1)
    expect(tabs.list(A)).toHaveLength(1)
  })

  it('keeps a command tab that exits non-zero, closes one that exits 0', () => {
    const { tabs } = rig()
    const failed = tabs.createCommand(A, { label: 'F', command: 'exit 3' })
    clock += 60_000
    backend.last.exit(3)
    tabs.createCommand(A, { label: 'O', command: 'true' })
    backend.last.exit(0)
    expect(tabs.list(A).map((t) => t.id)).toEqual([failed.id])
  })

  it('keeps a tab with its banner after a non-zero exit or a signal death', () => {
    const { tabs, calls } = rig()
    const failed = tabs.create(A, { kind: 'claude' })
    backend.last.exit(1)
    // node-pty can report a signal death as code 0: still a failure (exitStatus).
    const killed = tabs.create(A, { kind: 'shell' })
    backend.last.exit(0, 9)
    const hupped = tabs.create(A, { kind: 'claude' })
    backend.last.exit(129, 1)
    expect(tabs.list(A).map((t) => [t.id, t.exit])).toEqual([
      [failed.id, { code: 1, signal: null }],
      [killed.id, { code: 0, signal: 9 }],
      [hupped.id, { code: 129, signal: 1 }]
    ])
    expect(channels().filter((c) => c === 'tabs.exit')).toHaveLength(3)
    expect(channels()).not.toContain('tabs.removed')
    expect(calls.filter((c) => c.startsWith('closed'))).toEqual([])
  })

  it('never closes a restored tab whose --resume failed, nor drops its saved id', () => {
    const { tabs, changed } = rig()
    const tab = tabs.restoreTab(A, { kind: 'claude', resumeId: SESSION })
    backend.last.exit(1)
    expect(tabs.list(A)).toEqual([expect.objectContaining({ id: tab.id, sessionId: SESSION, exit: { code: 1, signal: null } })])
    // Restart starts fresh (no --resume); that process exits 0 without ever reporting a
    // SessionStart (hooks that cannot report): the id stays saved, so the tab stays too.
    tabs.restart(A, tab.id)
    expect(backend.last.argv).not.toContain('--resume')
    changed.length = 0
    backend.last.exit(0)
    expect(tabs.list(A)).toEqual([expect.objectContaining({ id: tab.id, sessionId: SESSION, exit: { code: 0, signal: null } })])
    expect(changed).toEqual([])
  })

  it('keeps a resumed tab that exits 0 before its SessionStart', () => {
    const { tabs } = rig()
    const tab = tabs.restoreTab(A, { kind: 'claude', resumeId: SESSION })
    backend.last.exit(0)
    expect(tabs.list(A)).toEqual([expect.objectContaining({ id: tab.id, sessionId: SESSION, exit: { code: 0, signal: null } })])
  })

  it('closes a resumed tab once its SessionStart came', () => {
    const { tabs } = rig()
    const tab = tabs.restoreTab(A, { kind: 'claude', resumeId: SESSION })
    tabs.sessionStarted(tab.id, SESSION, 'resume')
    backend.last.exit(0)
    expect(tabs.list(A)).toEqual([])
  })

  it('keeps every exited tab when the setting says keep, read at each exit', () => {
    const { tabs, setting } = rig({ close: false })
    const tab = tabs.create(A, { kind: 'claude' })
    backend.last.exit(0)
    expect(tabs.list(A)).toEqual([expect.objectContaining({ id: tab.id, exit: { code: 0, signal: null } })])
    expect(events.at(-1)).toMatchObject({ channel: 'tabs.exit', payload: { tabId: tab.id, code: 0 } })
    // Switched on: applies to the next exit of a tab already open.
    setting.close = true
    tabs.restart(A, tab.id)
    backend.last.exit(0)
    expect(tabs.list(A)).toEqual([])
  })

  it('keeps tabs (and their saved record) when main says no while quitting', () => {
    // index.ts answers false once before-quit ran: the tab must come back next launch.
    const { tabs, changed, setting } = rig()
    const tab = tabs.create(A, { kind: 'claude' })
    tabs.sessionStarted(tab.id, SESSION)
    tabs.sessionPrompted(tab.id)
    setting.close = false
    changed.length = 0
    backend.last.exit(0)
    expect(tabs.list(A)).toEqual([expect.objectContaining({ id: tab.id, sessionId: SESSION })])
    expect(changed).toEqual([])
  })

  it('a throwing setting reads as keep', () => {
    const tabs = manager('/data/app.sock', undefined, undefined, undefined, () => {
      throw new Error('settings bug')
    })
    const tab = tabs.create(A, { kind: 'claude' })
    backend.last.exit(0)
    expect(tabs.list(A).map((t) => t.id)).toEqual([tab.id])
  })

  it('a late clean exit of a process a restart replaced does not close the restarted tab', () => {
    const { tabs } = rig()
    const tab = tabs.create(A, { kind: 'claude' })
    const first = backend.last
    first.exit(2)
    tabs.restart(A, tab.id)
    // The old handle reports again (a duplicate or late exit): PtyService drops it.
    first.exit(0)
    expect(tabs.list(A)).toEqual([expect.objectContaining({ id: tab.id, gen: 2 })])
    expect(tabs.list(A)[0]!.exit).toBeUndefined()
    expect(channels()).not.toContain('tabs.removed')
    // The current process's clean exit does close it, reported with its own generation.
    backend.last.exit(0)
    expect(tabs.list(A)).toEqual([])
    expect(events.at(-1)).toEqual({ projectId: A, channel: 'tabs.removed', payload: { tabId: tab.id, gen: 2 } })
  })

  it('a tab closed by its window or the app quitting is not reported as removed', () => {
    const { tabs } = rig()
    tabs.create(A, { kind: 'claude' })
    const pty = backend.last
    tabs.closeProject(A)
    pty.exit(0)
    tabs.create(B, { kind: 'claude' })
    const other = backend.last
    tabs.disposeAll()
    other.exit(0)
    expect(channels()).not.toContain('tabs.removed')
  })
})

describe('command tabs', () => {
  const LOGS = { label: 'API logs', command: "docker compose logs -f | grep 'api' && echo \"$HOME\"; rm -i x" }

  function rig(setting: { close: boolean } = { close: false }) {
    const calls: string[] = []
    const changed: string[] = []
    const tabs = manager(
      '/data/app.sock',
      {
        started: (t) => calls.push(`started ${t.kind} ${t.tabId}`),
        exited: (id, code) => calls.push(`exited ${id} ${code}`),
        closed: (id) => calls.push(`closed ${id}`)
      },
      (projectId) => changed.push(projectId),
      undefined,
      () => setting.close
    )
    return { tabs, calls, changed, setting }
  }

  it('runs the command in the login shell as ONE argv element, in the project folder, titled by its label', () => {
    const { tabs, calls, changed } = rig()
    const tab = tabs.createCommand(A, LOGS)
    expect(tab).toMatchObject({ kind: 'command', cwd: projA, gen: 1, label: 'API logs', command: LOGS.command })
    expect(tab.notStarted).toBeUndefined()
    // Same flags as the login-env capture; the command line is never split or spliced.
    expect(backend.last.argv).toEqual(['/bin/zsh', '-l', '-i', '-c', LOGS.command])
    expect(backend.last.options.cwd).toBe(projA)
    expect(calls).toEqual([`started command ${tab.id}`])
    expect(changed).toEqual([A])
  })

  it('gets the login env, our bin dir, the socket and a window token (like a shell tab)', () => {
    const { tabs } = rig()
    const tab = tabs.createCommand(A, LOGS)
    const env = backend.last.options.env
    expect(env.PATH?.startsWith('/data/bin')).toBe(true)
    expect(env.HOME).toBe('/home/u')
    expect(env.APP_TAB_ID).toBe(tab.id)
    expect(env.CC_COCKPIT_SOCK).toBe('/data/app.sock')
    // `npm run dev & ccc browser open localhost:5173` reaches this window; a hook from it does not
    // reach a session (the window kind carries no tab id).
    expect(tabs.resolveToken(env.APP_TAB_TOKEN!)).toEqual({ kind: 'window', projectId: A })
    expect(tab.sessionId).toBeUndefined()
  })

  it('refuses an invalid copy (a NUL would cut the argv element short) and creates nothing', () => {
    const { tabs } = rig()
    expect(() => tabs.createCommand(A, { label: 'x', command: 'echo a\0b' })).toThrow('NUL')
    expect(() => tabs.createCommand(A, { label: '', command: 'htop' })).toThrow('label')
    expect(backend.spawned).toHaveLength(0)
    expect(tabs.list(A)).toEqual([])
  })

  it('cannot be made through create(): a command tab needs its looked-up command', () => {
    const tabs = manager()
    expect(() => tabs.create(A, { kind: 'command' as 'shell' })).toThrow('unknown tab kind')
    expect(backend.spawned).toHaveLength(0)
  })

  it('closes on a clean exit, keeps its banner on a failure, and Restart re-runs its command', () => {
    const { tabs, setting } = rig({ close: true })
    const tab = tabs.createCommand(A, LOGS)
    backend.last.exit(2)
    expect(tabs.list(A)).toEqual([expect.objectContaining({ id: tab.id, exit: { code: 2, signal: null } })])
    expect(events.at(-1)).toMatchObject({ channel: 'tabs.exit', payload: { tabId: tab.id, code: 2, gen: 1 } })
    const again = tabs.restart(A, tab.id)
    expect(again).toMatchObject({ id: tab.id, gen: 2, label: 'API logs' })
    expect(backend.spawned).toHaveLength(2)
    expect(backend.last.argv).toEqual(['/bin/zsh', '-l', '-i', '-c', LOGS.command])
    backend.last.exit(0)
    expect(tabs.list(A)).toEqual([])
    expect(events.at(-1)).toEqual({ projectId: A, channel: 'tabs.removed', payload: { tabId: tab.id, gen: 2 } })
    // With "keep" a clean exit leaves the tab and its banner.
    setting.close = false
    const kept = tabs.createCommand(A, LOGS)
    backend.last.exit(0)
    expect(tabs.list(A)).toEqual([expect.objectContaining({ id: kept.id, exit: { code: 0, signal: null } })])
  })

  it('a restored command tab comes back NOT started; only Restart runs it', () => {
    const { tabs, calls } = rig()
    const tab = tabs.restoreTab(A, { kind: 'command', cwd: join(projA, 'sub'), command: LOGS })
    // Nothing spawned, nobody told of a start: the app launching never runs a command itself.
    expect(backend.spawned).toHaveLength(0)
    expect(calls).toEqual([])
    expect(tab).toMatchObject({
      kind: 'command',
      cwd: join(projA, 'sub'),
      gen: 0,
      notStarted: true,
      exit: { code: 0, signal: null },
      label: 'API logs',
      command: LOGS.command
    })
    // Input, resize and ack for the waiting tab go nowhere; no crash, no spawn.
    tabs.input(A, tab.id, 'y\r')
    tabs.resize(A, tab.id, 100, 30)
    tabs.ack(A, tab.id, 5)
    expect(tabs.attach(A)).toEqual([tab])
    expect(backend.spawned).toHaveLength(0)

    const started = tabs.restart(A, tab.id)
    // Its first token is minted at this first start; none existed while it waited.
    expect(tabs.resolveToken(backend.last.options.env.APP_TAB_TOKEN!)).toEqual({ kind: 'window', projectId: A })
    expect(started).toMatchObject({ id: tab.id, gen: 1, cwd: join(projA, 'sub') })
    expect(started.notStarted).toBeUndefined()
    expect(started.exit).toBeUndefined()
    expect(backend.spawned).toHaveLength(1)
    expect(backend.last.argv).toEqual(['/bin/zsh', '-l', '-i', '-c', LOGS.command])
    expect(calls).toEqual([`started command ${tab.id}`])
    expect(() => tabs.restart(A, tab.id)).toThrow('still running')
  })

  it('a waiting tab can be closed like any stopped tab', () => {
    const { tabs, calls, changed } = rig()
    const tab = tabs.restoreTab(A, { kind: 'command', command: LOGS })
    tabs.close(A, tab.id)
    expect(tabs.list(A)).toEqual([])
    expect(calls).toEqual([`closed ${tab.id}`])
    expect(changed).toEqual([A])
  })

  it('restoreTab refuses a command tab without a valid command, and a command on another kind', () => {
    const tabs = manager()
    expect(() => tabs.restoreTab(A, { kind: 'command' })).toThrow('needs its command')
    expect(() => tabs.restoreTab(A, { kind: 'command', command: { label: 'x', command: 'a\0b' } })).toThrow('NUL')
    expect(() => tabs.restoreTab(A, { kind: 'shell', command: LOGS })).toThrow('only a command tab')
    expect(() => tabs.restoreTab(A, { kind: 'command', resumeId: 'abc', command: LOGS })).toThrow('only a Claude tab resumes')
    expect(tabs.list(A)).toEqual([])
  })

  it('keeps its own copy of the command for good (an edited or deleted entry does not reach it)', () => {
    const { tabs } = rig()
    const entry = { label: 'Dev', command: 'npm run dev' }
    const tab = tabs.createCommand(A, entry)
    entry.command = 'npm run prod'
    entry.label = 'Prod'
    backend.last.exit(1)
    expect(tabs.restart(A, tab.id)).toMatchObject({ label: 'Dev', command: 'npm run dev' })
    expect(backend.last.argv.at(-1)).toBe('npm run dev')
  })
})
