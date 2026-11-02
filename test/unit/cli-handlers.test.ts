// The socket handlers behind the user-facing `ccc` commands (Task 21), with a fake registry and a
// fake overlay opener, plus the `--html F` file reading (the one-shot page: its serving rules are
// OverlayManager.pageHtml's, tested in overlay-manager.test.ts).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_HTML_BYTES, type OverlayResult } from '../../src/main/overlays/overlay-manager'
import type { SessionEntry } from '../../src/main/sessions/status-reducer'
import {
  MAX_NOTIFY_CHARS,
  readHtmlFile,
  registerCliHandlers,
  type CliHandlerOptions
} from '../../src/main/socket/handlers'
import type { Caller, Handler } from '../../src/main/socket/socket-server'
import { SessionRegistry } from '../../src/main/sessions/session-registry'

const TAB: Caller = { kind: 'session', tabId: 't1', projectId: 'p1' }
const OUTSIDE: Caller = { kind: 'project', path: '/proj', projectId: 'p1' }
const ANON: Caller = { kind: 'anonymous' }
/** A shell tab's, command tab's or terminal overlay's token: the window of p1, no session. */
const WINDOW: Caller = { kind: 'window', projectId: 'p1' }

let dir: string
let handlers: Map<string, Handler>
let calls: { opened: string[]; notified: string[]; overlays: Array<{ windowId: number; spec: unknown; opener: string }> }
let registry: SessionRegistry
let result: OverlayResult
let windows: Record<string, number>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cch-'))
  handlers = new Map()
  calls = { opened: [], notified: [], overlays: [] }
  result = { kind: 'exit', code: 0 }
  windows = { p1: 7 }
  registry = new SessionRegistry({
    projectName: () => 'alpha',
    broadcast: () => {},
    write: () => {},
    log: () => {}
  })
  registry.tabStarted({ tabId: 't1', projectId: 'p1', kind: 'claude', cwd: '/proj' })
  registry.tabStarted({ tabId: 't2', projectId: 'p2', kind: 'claude', cwd: '/other' })
  registry.tabStarted({ tabId: 'sh', projectId: 'p1', kind: 'shell', cwd: '/proj' })
  const options: CliHandlerOptions = {
    openPath: (p) => {
      if (p.includes('missing')) throw new Error('not a directory')
      calls.opened.push(p)
    },
    notify: (t) => calls.notified.push(t),
    sessions: registry,
    project: (id) => (id === 'p1' ? { name: 'alpha', path: '/proj' } : id === 'p2' ? { name: 'beta', path: '/other' } : undefined),
    windowIdOf: (id) => windows[id],
    openOverlay: async (windowId, spec, opener) => {
      calls.overlays.push({ windowId, spec, opener })
      return result
    }
  }
  registerCliHandlers({ handle: (cmd, h) => void handlers.set(cmd, h) }, options)
})

afterEach(() => {
  registry.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const call = async (cmd: string, args: Record<string, unknown>, caller: Caller): Promise<unknown> => {
  const h = handlers.get(cmd)
  if (!h) throw new Error(`no handler ${cmd}`)
  return h(args, caller)
}

describe('registration', () => {
  it('registers exactly the user commands', () => {
    expect([...handlers.keys()].sort()).toEqual(['notify', 'open', 'overlay', 'session.note', 'session.steps', 'sessions'])
  })
})

describe('open', () => {
  it('opens an absolute folder path, for a tab or a project caller alike', async () => {
    await call('open', { path: '/some/dir' }, OUTSIDE)
    await call('open', { path: '/other/dir' }, TAB)
    expect(calls.opened).toEqual(['/some/dir', '/other/dir'])
  })

  it.each([[undefined], [''], ['relative/dir'], [42], ['/a\0b']])('refuses path %j', async (path) => {
    await expect(call('open', { path }, OUTSIDE)).rejects.toThrow(/absolute folder path/)
    expect(calls.opened).toEqual([])
  })

  it('passes the registry error on (a path that is not a folder)', async () => {
    await expect(call('open', { path: '/missing' }, OUTSIDE)).rejects.toThrow('not a directory')
  })
})

describe('session note / steps', () => {
  it('act on the caller\'s own tab, whatever the args say', async () => {
    await call('session.note', { text: 'hi', tabId: 't2', projectId: 'p2' }, TAB)
    await call('session.steps', { done: 3, total: 5, tabId: 't2' }, TAB)
    expect(registry.get('t1')).toMatchObject({ notes: ['hi'], steps: { done: 3, total: 5 } })
    expect(registry.get('t2')).toMatchObject({ notes: [] })
    expect(registry.get('t2')?.steps).toBeUndefined()
  })

  it('refuse a caller that is not a Claude session: a window token, --project, nothing', async () => {
    for (const caller of [WINDOW, OUTSIDE, ANON]) {
      await expect(call('session.note', { text: 'x' }, caller)).rejects.toThrow(/needs a Claude session/)
      await expect(call('session.steps', { done: 1, total: 2 }, caller)).rejects.toThrow(/needs a Claude session/)
    }
    // Nothing was written to any entry, the shell tab's included.
    expect(registry.list().map((e) => [e.tabId, e.notes.length, e.steps])).toEqual([
      ['t1', 0, undefined],
      ['t2', 0, undefined]
    ])
  })

  it('caps notes at 20 (newest last) and at 500 characters each', async () => {
    for (let i = 1; i <= 25; i++) await call('session.note', { text: `n${i}` }, TAB)
    const notes = (registry.get('t1') as SessionEntry).notes
    expect(notes).toHaveLength(20)
    expect([notes[0], notes[19]]).toEqual(['n6', 'n25'])
    await call('session.note', { text: 'y'.repeat(900) }, TAB)
    expect((registry.get('t1') as SessionEntry).notes.at(-1)).toHaveLength(500)
  })

  it('validates the types and ranges main-side (the CLI is not trusted)', async () => {
    await expect(call('session.note', { text: 5 }, TAB)).rejects.toThrow(/needs text/)
    await expect(call('session.note', { text: '  ' }, TAB)).rejects.toThrow(/empty/)
    await expect(call('session.steps', { done: '3', total: '5' }, TAB)).rejects.toThrow(/steps/)
    await expect(call('session.steps', { done: 6, total: 5 }, TAB)).rejects.toThrow(/steps/)
    await expect(call('session.steps', { done: 0, total: 0 }, TAB)).rejects.toThrow(/steps/)
  })

  it('a shell tab has no session to annotate', async () => {
    await expect(call('session.note', { text: 'x' }, { kind: 'session', tabId: 'sh', projectId: 'p1' })).rejects.toThrow(
      /no Claude session/
    )
  })
})

describe('a window token (shell tab, command tab, terminal overlay)', () => {
  it('is accepted like --project by every window command, in the token\'s own window', async () => {
    await call('open', { path: '/w/dir' }, WINDOW)
    expect(calls.opened).toEqual(['/w/dir'])
    await call('notify', { text: 'from a shell tab' }, WINDOW)
    expect(calls.notified).toEqual(['from a shell tab'])
    expect(((await call('sessions', {}, WINDOW)) as unknown[]).length).toBe(2)
    expect(await call('overlay', { url: 'https://example.com/' }, WINDOW)).toEqual(result)
    expect(calls.overlays).toEqual([{ windowId: 7, spec: { kind: 'url', url: 'https://example.com/' }, opener: 'cli' }])
  })
})

describe('notify', () => {
  it('shows the trimmed text, cut to MAX_NOTIFY_CHARS', async () => {
    await call('notify', { text: '  build done ' }, ANON)
    await call('notify', { text: 'z'.repeat(MAX_NOTIFY_CHARS + 500) }, TAB)
    expect(calls.notified[0]).toBe('build done')
    expect(calls.notified[1]).toHaveLength(MAX_NOTIFY_CHARS)
  })

  it.each([[undefined], [''], ['   '], [7]])('refuses text %j', async (text) => {
    await expect(call('notify', { text }, ANON)).rejects.toThrow(/needs text/)
    expect(calls.notified).toEqual([])
  })
})

describe('sessions', () => {
  it('lists the Claude tabs of every window, with project names and no queued text', async () => {
    registry.applyHook('t1', 'UserPromptSubmit', { prompt: 'do it' })
    registry.addNote('t1', 'n')
    registry.setSteps('t1', 1, 2)
    const list = (await call('sessions', {}, ANON)) as Array<Record<string, unknown>>
    expect(list.map((s) => [s.tabId, s.project, s.projectPath, s.status])).toEqual([
      ['t1', 'alpha', '/proj', 'working'],
      ['t2', 'beta', '/other', 'starting']
    ])
    expect(list[0]).toMatchObject({ lastPrompt: 'do it', notes: ['n'], steps: { done: 1, total: 2 }, queued: 0, cwd: '/proj' })
    // A tab caller sees the same list, and nothing like a token or a queue body is in it.
    expect(await call('sessions', {}, TAB)).toEqual(list)
    expect(Object.keys(list[0] as object)).not.toContain('queue')
    expect(JSON.stringify(list)).not.toMatch(/token/i)
  })
})

describe('overlay', () => {
  it('opens in the window of the tab\'s project and returns how it ended', async () => {
    result = { kind: 'exit', code: 3 }
    const got = await call('overlay', { terminal: ['sh', '-c', 'exit 3'], cwd: dir }, TAB)
    expect(got).toEqual({ kind: 'exit', code: 3 })
    expect(calls.overlays).toEqual([
      { windowId: 7, spec: { kind: 'terminal', argv: ['sh', '-c', 'exit 3'], cwd: dir }, opener: 'cli' }
    ])
  })

  it('outside a tab, uses the window of the open project --project named', async () => {
    await call('overlay', { url: 'https://example.com/' }, OUTSIDE)
    expect(calls.overlays[0]).toMatchObject({ windowId: 7, spec: { kind: 'url', url: 'https://example.com/' } })
  })

  it('defaults the terminal cwd to the project folder', async () => {
    await call('overlay', { terminal: ['true'] }, TAB)
    expect(calls.overlays[0]?.spec).toEqual({ kind: 'terminal', argv: ['true'], cwd: '/proj' })
  })

  it('never opens a project: unknown, or known but not open, is an error before anything runs', async () => {
    await expect(call('overlay', { url: 'https://a/' }, { kind: 'project', path: '/nope', projectId: undefined })).rejects.toThrow(
      /not open/
    )
    windows = {}
    await expect(call('overlay', { url: 'https://a/' }, OUTSIDE)).rejects.toThrow(/not open/)
    await expect(call('overlay', { url: 'https://a/' }, TAB)).rejects.toThrow(/not open/)
    expect(calls.overlays).toEqual([])
  })

  it('an anonymous caller cannot open one', async () => {
    await expect(call('overlay', { url: 'https://a/' }, ANON)).rejects.toThrow(/tab token or --project/)
  })

  it('needs exactly one of terminal, url, html', async () => {
    await expect(call('overlay', {}, TAB)).rejects.toThrow(/exactly one/)
    await expect(call('overlay', { url: 'https://a/', terminal: ['x'] }, TAB)).rejects.toThrow(/exactly one/)
    expect(calls.overlays).toEqual([])
  })

  it('--html: the file\'s content becomes the html overlay', async () => {
    const file = join(dir, 'page.html')
    writeFileSync(file, '<p>hello</p>')
    await call('overlay', { html: file }, TAB)
    expect(calls.overlays[0]?.spec).toEqual({ kind: 'html', html: '<p>hello</p>' })
  })

  it('--html: an unreadable file is an error and opens nothing', async () => {
    await expect(call('overlay', { html: join(dir, 'missing.html') }, TAB)).rejects.toThrow(/cannot read/)
    expect(calls.overlays).toEqual([])
  })
})

describe('readHtmlFile', () => {
  it('reads a regular file, following a symlink the user made', async () => {
    const file = join(dir, 'a.html')
    writeFileSync(file, '<b>x</b>')
    symlinkSync(file, join(dir, 'link.html'))
    expect(await readHtmlFile(file)).toBe('<b>x</b>')
    expect(await readHtmlFile(join(dir, 'link.html'))).toBe('<b>x</b>')
  })

  it.each([[undefined], [''], ['rel.html'], [5], ['/a\0b']])('refuses %j as a path', async (file) => {
    await expect(readHtmlFile(file)).rejects.toThrow(/absolute file path/)
  })

  it('refuses a directory and a file over the overlay size limit', async () => {
    mkdirSync(join(dir, 'sub'))
    await expect(readHtmlFile(join(dir, 'sub'))).rejects.toThrow(/regular file/)
    const big = join(dir, 'big.html')
    writeFileSync(big, 'a'.repeat(MAX_HTML_BYTES + 1))
    await expect(readHtmlFile(big)).rejects.toThrow(/too large/)
  })

  it('does not leak the path in its errors beyond what the caller sent', async () => {
    await expect(readHtmlFile(join(dir, 'nope'))).rejects.toThrow('overlay: cannot read that file')
  })
})
