import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionsSnapshot } from '../../src/shared/ipc'
import { hookHandler } from '../../src/main/sessions/hook-handler'
import { MAX_GIST_CHARS, SessionRegistry, type SessionChange } from '../../src/main/sessions/session-registry'

const P1 = 'p1'
const P2 = 'p2'
const names: Record<string, string> = { [P1]: 'alpha', [P2]: 'beta' }

/** What the window of project p1 was sent, each time. */
let sent: SessionsSnapshot[]
let reg: SessionRegistry
let logs: string[]

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  sent = []
  logs = []
  reg = new SessionRegistry({
    projectName: (id) => names[id],
    broadcast: (snapshotFor) => sent.push(snapshotFor(P1)),
    write: () => {},
    log: (m) => logs.push(m)
  })
})

afterEach(() => {
  reg.dispose()
  vi.useRealTimers()
})

const start = (tabId: string, projectId = P1, kind: 'claude' | 'shell' = 'claude'): void =>
  reg.tabStarted({ tabId, projectId, kind, cwd: '/proj' })

describe('entries', () => {
  it('creates a `starting` entry for a Claude tab only', () => {
    start('c1')
    start('s1', P1, 'shell')
    expect(reg.list().map((e) => [e.tabId, e.status])).toEqual([['c1', 'starting']])
    expect(reg.get('s1')).toBeUndefined()
  })

  it('applies hook events and exit, and keeps the entry until the tab closes', () => {
    start('c1')
    expect(reg.applyHook('c1', 'SessionStart', { session_id: 'sess' })).toBe(true)
    reg.applyHook('c1', 'UserPromptSubmit', { prompt: 'hi' })
    expect(reg.get('c1')).toMatchObject({ status: 'working', sessionId: 'sess', lastPrompt: 'hi' })
    reg.tabExited('c1', 2)
    expect(reg.get('c1')).toMatchObject({ status: 'ended', exitCode: 2 })
    reg.tabClosed('c1')
    expect(reg.get('c1')).toBeUndefined()
  })

  it('stores a signal death as 128 + n, also when node-pty reports it as code 0', () => {
    start('c1')
    start('c2')
    reg.tabExited('c1', 0, 9)
    reg.tabExited('c2', 0, null)
    expect(reg.get('c1')).toMatchObject({ status: 'ended', exitCode: 137 })
    expect(reg.get('c2')).toMatchObject({ status: 'ended', exitCode: 0 })
  })

  it('an answer key typed into a needs-permission tab moves it to working; nothing else does', () => {
    start('c1')
    reg.applyHook('c1', 'SessionStart', { session_id: 'sess' })
    reg.applyHook('c1', 'PreToolUse', { tool_name: 'Bash' })
    reg.applyHook('c1', 'Notification', { notification_type: 'permission_prompt', message: 'm' })
    // An arrow key, a focus report, another project's window: still blocked on the user.
    reg.userInput(P1, 'c1', '\x1b[B')
    reg.userInput(P1, 'c1', '\x1b[I')
    reg.userInput(P2, 'c1', '\r')
    reg.userInput(P1, 'nope', '\r')
    expect(reg.get('c1')?.status).toBe('needs-permission')
    reg.userInput(P1, 'c1', '\r')
    expect(reg.get('c1')).toMatchObject({ status: 'working', tool: 'Bash' })
  })

  it('ignores a hook for a tab it does not know', () => {
    expect(reg.applyHook('nope', 'Stop', {})).toBe(false)
    reg.tabExited('nope', 1)
    reg.tabClosed('nope')
    expect(sent).toEqual([])
  })

  it('a restart starts a fresh entry in the same place, keeping only the session id', () => {
    start('c1')
    start('c2')
    reg.applyHook('c1', 'SessionStart', { session_id: 'sess' })
    reg.applyHook('c1', 'UserPromptSubmit', { prompt: 'old' })
    reg.applyHook('c1', 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/a' } })
    reg.tabExited('c1', 0)
    start('c1')
    expect(reg.get('c1')).toMatchObject({ status: 'starting', sessionId: 'sess', files: [], queue: [] })
    expect(reg.get('c1')?.lastPrompt).toBeUndefined()
    expect(reg.get('c1')?.exitCode).toBeUndefined()
    expect(reg.list().map((e) => e.tabId)).toEqual(['c1', 'c2'])
  })

  it('lists by project', () => {
    start('a', P1)
    start('b', P2)
    start('c', P1)
    expect(reg.listByProject(P1).map((e) => e.tabId)).toEqual(['a', 'c'])
    expect(reg.listByProject('other')).toEqual([])
  })
})

describe('setName', () => {
  it('names an entry, shows it in the detail and the summary, clears with null, reports a change', () => {
    start('c1')
    const seen: string[] = []
    reg.onChange((c) => seen.push(`${c.entry?.name}`))
    expect(reg.setName('c1', 'Mine')).toBe(true)
    expect(reg.get('c1')!.name).toBe('Mine')
    expect(reg.snapshotFor(P1).own[0]!.name).toBe('Mine')
    expect(reg.summariesFor(P1)[0]!.name).toBe('Mine')
    reg.setName('c1', 'Mine')
    expect(seen).toEqual(['Mine'])
    reg.setName('c1', null)
    expect(reg.get('c1')!.name).toBeUndefined()
    expect(reg.setName('nope', 'x')).toBe(false)
  })

  it('is born with the tab (a restored tab) and survives a restart of the entry', () => {
    reg.tabStarted({ tabId: 'c1', projectId: P1, kind: 'claude', cwd: '/proj', name: 'Saved' })
    expect(reg.get('c1')!.name).toBe('Saved')
  })
})

describe('onChange', () => {
  it('reports start, change, exit and close synchronously, with the previous entry', () => {
    const changes: SessionChange[] = []
    reg.onChange((c) => changes.push(c))
    start('c1')
    reg.applyHook('c1', 'Stop', {})
    reg.tabExited('c1', 0)
    reg.tabClosed('c1')
    expect(changes.map((c) => [c.entry?.status, c.prev?.status])).toEqual([
      ['starting', undefined],
      ['waiting', 'starting'],
      ['ended', 'waiting'],
      [undefined, 'ended']
    ])
  })

  it('projectChanged re-announces only that project\'s tabs, entry unchanged', () => {
    start('a', P1)
    start('b', P2)
    const changes: SessionChange[] = []
    reg.onChange((c) => changes.push(c))
    reg.projectChanged(P1)
    expect(changes.map((c) => [c.tabId, c.entry === c.prev])).toEqual([['a', true]])
  })

  it('does not fire for an event the reducer ignored', () => {
    start('c1')
    reg.tabExited('c1', 0)
    const changes: SessionChange[] = []
    reg.onChange((c) => changes.push(c))
    reg.applyHook('c1', 'Stop', {})
    reg.tabExited('c1', 5)
    expect(changes).toEqual([])
  })

  it('unsubscribes, and a throwing subscriber breaks neither the others nor the hook', () => {
    const seen: string[] = []
    reg.onChange(() => {
      throw new Error('boom')
    })
    const off = reg.onChange((c) => seen.push(c.entry?.status ?? 'gone'))
    start('c1')
    reg.applyHook('c1', 'Stop', {})
    expect(seen).toEqual(['starting', 'waiting'])
    expect(logs.some((l) => l.includes('boom'))).toBe(true)
    off()
    reg.applyHook('c1', 'UserPromptSubmit', {})
    expect(seen).toHaveLength(2)
    expect(reg.get('c1')?.status).toBe('working')
  })
})

describe('summariesFor (ctx.sessions scope all, design-next §4.1)', () => {
  it('gives every tab of every project: status, tool, title, project name and colour as CSS, own for the caller', () => {
    const colored = new SessionRegistry({
      projectName: (id) => names[id],
      projectColor: (id) => (id === P1 ? 'blue' : id === P2 ? '#12abef' : undefined),
      broadcast: () => {},
      write: () => {}
    })
    try {
      colored.tabStarted({ tabId: 'a', projectId: P1, kind: 'claude', cwd: '/alpha' })
      colored.tabStarted({ tabId: 'b', projectId: P2, kind: 'claude', cwd: '/beta' })
      colored.tabStarted({ tabId: 's', projectId: P2, kind: 'shell', cwd: '/beta' })
      colored.applyHook('a', 'UserPromptSubmit', { prompt: 'alpha secret prompt' })
      colored.applyHook('a', 'PreToolUse', { tool_name: 'Bash' })
      colored.applyHook('b', 'UserPromptSubmit', { prompt: 'beta secret prompt' })
      colored.applyHook('b', 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/beta/secret.ts' } })
      colored.addNote('b', 'beta secret note')
      colored.send('b', 'beta queued text')
      colored.tabOutput('b', '\x1b]0;✳ Beta topic\x07')
      expect(colored.summariesFor(P1)).toEqual([
        { tabId: 'a', own: true, project: { name: 'alpha', color: 'var(--cc-project-blue)' }, status: 'working', tool: 'Bash' },
        { tabId: 'b', own: false, project: { name: 'beta', color: '#12abef' }, status: 'working', title: 'Beta topic' }
      ])
      expect(colored.summariesFor(P2).map((s) => s.own)).toEqual([false, true])
      // Nothing private of any tab, the caller's own included.
      const text = JSON.stringify(colored.summariesFor(P1))
      for (const secret of ['secret', '/alpha', '/beta', 'queued', 'sessionId', 'cwd', 'notes', 'files']) {
        expect(text).not.toContain(secret)
      }
    } finally {
      colored.dispose()
    }
  })

  it('leaves the colour out for a project without one', () => {
    start('a', P1)
    expect(reg.summariesFor('other')).toEqual([{ tabId: 'a', own: false, project: { name: 'alpha' }, status: 'starting' }])
  })
})

describe('snapshotFor (the per-window split)', () => {
  /** Two projects with private data in both. */
  function seed(): void {
    start('a', P1)
    start('b', P2)
    reg.applyHook('a', 'UserPromptSubmit', { prompt: 'alpha secret prompt' })
    reg.applyHook('a', 'PreToolUse', { tool_name: 'Bash' })
    reg.applyHook('a', 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/alpha/secret.ts' } })
    reg.applyHook('b', 'UserPromptSubmit', { prompt: 'beta secret prompt' })
    reg.applyHook('b', 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/beta/secret.ts' } })
    reg.send('b', 'beta queued text')
  }

  it('lists no other project\'s tab at all: the other windows\' strip is a plugin\'s (scope all)', () => {
    seed()
    expect(reg.snapshotFor(P1).own.map((d) => d.tabId)).toEqual(['a'])
    expect(reg.snapshotFor(P2).own.map((d) => d.tabId)).toEqual(['b'])
    expect(Object.keys(reg.snapshotFor(P1))).toEqual(['own'])
    // A project with no window tab at all gets nothing.
    expect(reg.snapshotFor('nobody')).toEqual({ own: [] })
  })

  it('gives the full entries of the window’s own project only', () => {
    seed()
    expect(reg.snapshotFor(P1).own).toEqual([
      {
        tabId: 'a',
        status: 'working',
        tool: 'Bash',
        lastPrompt: 'alpha secret prompt',
        notes: [],
        files: ['/alpha/secret.ts'],
        queue: []
      }
    ])
    expect(reg.snapshotFor(P2).own).toMatchObject([
      {
        tabId: 'b',
        lastPrompt: 'beta secret prompt',
        files: ['/beta/secret.ts'],
        queue: [{ text: 'beta queued text' }]
      }
    ])
  })

  it('window A receives no lastPrompt, notes, files or queue of project B', () => {
    seed()
    const forA = reg.snapshotFor(P1)
    const text = JSON.stringify(forA)
    for (const secret of ['beta secret prompt', '/beta/', 'beta queued text']) {
      expect(text).not.toContain(secret)
    }
  })

  it('exposes no field of the entry that detail does not name (cwd, project id, delivering, session id)', () => {
    start('a', P1)
    reg.applyHook('a', 'SessionStart', { session_id: 'sess-1' })
    const [own] = reg.snapshotFor(P1).own
    expect(Object.keys(own!).sort()).toEqual(['files', 'notes', 'queue', 'status', 'tabId'])
  })

  it('a queue change reaches the owning window’s next snapshot', () => {
    start('b', P2)
    const sentTo = (): SessionsSnapshot => reg.snapshotFor(P2)
    const { id } = reg.send('b', 'later')
    expect(sentTo().own[0]?.queue).toEqual([{ id, text: 'later' }])
    expect(reg.cancelQueued('b', id)).toBe(true)
    expect(sentTo().own[0]?.queue).toEqual([])
  })
})

describe('setActive (the tab the window shows)', () => {
  it('marks one Claude tab per project, reporting the tabs that gained and lost it', () => {
    start('a')
    start('b')
    start('x', P2)
    const changes: SessionChange[] = []
    reg.onChange((c) => changes.push(c))
    reg.setActive(P1, 'a')
    reg.setActive(P2, 'x')
    expect(reg.activeTab(P1)).toBe('a')
    expect(reg.activeTab(P2)).toBe('x')
    reg.setActive(P1, 'b')
    expect(reg.activeTab(P1)).toBe('b')
    // Same selection again: nothing to report.
    reg.setActive(P1, 'b')
    expect(changes.map((c) => c.tabId)).toEqual(['a', 'x', 'a', 'b'])
    // Nothing in the entry moved: a gist or status subscriber sees no transition.
    expect(changes.every((c) => c.entry === c.prev)).toBe(true)
  })

  it('a selected shell tab leaves no Claude tab active; a foreign id never marks another project', () => {
    start('a')
    start('sh', P1, 'shell')
    start('x', P2)
    reg.setActive(P1, 'a')
    reg.setActive(P1, 'sh')
    expect(reg.activeTab(P1)).toBeUndefined()
    reg.setActive(P1, 'x')
    expect(reg.activeTab(P1)).toBeUndefined()
    expect(reg.activeTab(P2)).toBeUndefined()
  })

  it('survives a restart of the tab, ends with its close, and clears with undefined', () => {
    start('a')
    reg.setActive(P1, 'a')
    reg.tabExited('a', 0)
    start('a')
    expect(reg.activeTab(P1)).toBe('a')
    reg.tabClosed('a')
    expect(reg.activeTab(P1)).toBeUndefined()
    start('b')
    reg.setActive(P1, 'b')
    reg.setActive(P1, undefined)
    expect(reg.activeTab(P1)).toBeUndefined()
  })
})

describe('cancelQueuedFor', () => {
  it('cancels an item of the project’s own tab', () => {
    start('a', P1)
    const { id } = reg.send('a', 'x')
    expect(reg.cancelQueuedFor(P1, 'a', id)).toBe(true)
    expect(reg.get('a')?.queue).toEqual([])
  })

  it('treats another project’s tab as unknown and leaves its queue alone', () => {
    start('a', P1)
    const { id } = reg.send('a', 'x')
    expect(reg.cancelQueuedFor(P2, 'a', id)).toBe(false)
    expect(reg.get('a')?.queue).toHaveLength(1)
    expect(reg.cancelQueuedFor(P1, 'nope', id)).toBe(false)
    expect(reg.cancelQueuedFor(P1, 'a', 'no-such-item')).toBe(false)
  })
})

describe('broadcast throttle', () => {
  it('sends the first change at once, then at most 10 per second, always the latest state', () => {
    start('c1') // leading edge: sent now
    expect(sent).toHaveLength(1)
    reg.applyHook('c1', 'SessionStart', {})
    reg.applyHook('c1', 'UserPromptSubmit', {})
    reg.applyHook('c1', 'PreToolUse', { tool_name: 'Bash' })
    expect(sent).toHaveLength(1) // folded into one trailing send
    vi.advanceTimersByTime(99)
    expect(sent).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sent).toHaveLength(2)
    expect(sent[1]?.own).toMatchObject([{ tabId: 'c1', status: 'working', tool: 'Bash' }])
    // Nothing pending: no further send.
    vi.advanceTimersByTime(1000)
    expect(sent).toHaveLength(2)
  })

  it('a change after a quiet spell goes out immediately again', () => {
    start('c1')
    vi.advanceTimersByTime(500)
    reg.applyHook('c1', 'Stop', {})
    expect(sent).toHaveLength(2)
  })

  it('never exceeds 10 snapshots in a second under a burst', () => {
    start('c1')
    for (let i = 0; i < 200; i++) {
      reg.applyHook('c1', i % 2 ? 'Stop' : 'UserPromptSubmit', {})
      vi.advanceTimersByTime(5)
    }
    // 200 changes over 1000 ms: the leading send plus one per 100 ms window.
    expect(sent.length).toBeLessThanOrEqual(11)
    expect(sent.length).toBeGreaterThanOrEqual(9)
  })

  it('dispose cancels a pending trailing send', () => {
    start('c1')
    reg.applyHook('c1', 'Stop', {})
    reg.dispose()
    vi.advanceTimersByTime(1000)
    expect(sent).toHaveLength(1)
  })

  it('a failing broadcast is logged and later ones still go out', () => {
    let calls = 0
    const bad = new SessionRegistry({
      projectName: () => 'x',
      broadcast: () => {
        calls++
        if (calls === 1) throw new Error('window gone')
      },
      write: () => {},
      log: (m) => logs.push(m)
    })
    bad.tabStarted({ tabId: 't', projectId: P1, kind: 'claude', cwd: '/' })
    vi.advanceTimersByTime(100)
    bad.applyHook('t', 'Stop', {})
    expect(calls).toBe(2)
    expect(logs.some((l) => l.includes('window gone'))).toBe(true)
    bad.dispose()
  })
})

describe('hook handler', () => {
  const tab = { kind: 'session', tabId: 'c1', projectId: P1 } as const

  it("applies the event for the caller's tab, synchronously, and replies null", () => {
    start('c1')
    const handler = hookHandler(reg)
    const result = handler({ event: 'UserPromptSubmit', payload: { prompt: 'hi' } }, tab)
    expect(result).toBeNull() // not a promise: nothing to await between dispatch and apply
    expect(reg.get('c1')).toMatchObject({ status: 'working', lastPrompt: 'hi' })
  })

  it('treats a null or non-object payload (oversized or non-JSON stdin) as no payload', () => {
    start('c1')
    const handler = hookHandler(reg)
    handler({ event: 'UserPromptSubmit', payload: null, truncated: true }, tab)
    expect(reg.get('c1')).toMatchObject({ status: 'working' })
    handler({ event: 'PreToolUse', payload: 'junk' }, tab)
    expect(reg.get('c1')).toMatchObject({ status: 'working' })
    expect(reg.get('c1')?.tool).toBeUndefined()
  })

  it('refuses an unknown event, a missing event and a non-tab caller', () => {
    start('c1')
    const handler = hookHandler(reg)
    expect(() => handler({ event: 'Bogus' }, tab)).toThrow(/unknown hook event/)
    expect(() => handler({}, tab)).toThrow(/unknown hook event/)
    expect(() => handler({ event: 42 }, tab)).toThrow(/unknown hook event/)
    expect(() => handler({ event: 'Stop' }, { kind: 'project', path: '/p', projectId: P1 })).toThrow(
      /Claude session token/
    )
    expect(reg.get('c1')?.status).toBe('starting')
  })

  it('refuses a window token (a shell tab running `ccc hook`) and creates no entry', () => {
    start('c1')
    const before = reg.list().map((e) => e.tabId)
    const handler = hookHandler(reg)
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      expect(() => handler({ event, payload: { session_id: 'x' } }, { kind: 'window', projectId: P1 })).toThrow(/Claude session token/)
    }
    expect(reg.list().map((e) => e.tabId)).toEqual(before)
    expect(reg.get('c1')?.status).toBe('starting')
  })

  it("uses the caller's tab, never an id from the args", () => {
    start('c1')
    start('c2')
    hookHandler(reg)({ event: 'Stop', tabId: 'c2', payload: { tabId: 'c2' } }, tab)
    expect(reg.get('c1')?.status).toBe('waiting')
    expect(reg.get('c2')?.status).toBe('starting')
  })

  it('a tab that is gone is ignored without an error (a hook can land after close)', () => {
    expect(hookHandler(reg)({ event: 'Stop' }, tab)).toBeNull()
  })
})

describe('addNote / setSteps (ccc session note / steps)', () => {
  it('updates the tab\'s entry, notifies subscribers and puts it in the own-project snapshot', () => {
    start('c1')
    const seen: SessionChange[] = []
    reg.onChange((c) => seen.push(c))
    reg.addNote('c1', 'building')
    reg.setSteps('c1', 2, 4)
    expect(reg.get('c1')).toMatchObject({ notes: ['building'], steps: { done: 2, total: 4 } })
    expect(seen.map((c) => c.tabId)).toEqual(['c1', 'c1'])
    expect(reg.snapshotFor(P1).own[0]).toMatchObject({ notes: ['building'], steps: { done: 2, total: 4 } })
    // Another project's window gets neither.
    expect(reg.snapshotFor(P2).own).toEqual([])
    expect(JSON.stringify(reg.snapshotFor(P2))).not.toContain('building')
  })

  it('throws for a tab with no entry (a shell tab or an unknown id) and for bad input', () => {
    start('s1', P1, 'shell')
    expect(() => reg.addNote('s1', 'x')).toThrow(/no Claude session/)
    expect(() => reg.setSteps('nope', 1, 2)).toThrow(/no Claude session/)
    start('c1')
    expect(() => reg.addNote('c1', ' ')).toThrow(/empty/)
    expect(() => reg.setSteps('c1', 3, 2)).toThrow(/steps/)
    expect(reg.get('c1')).toMatchObject({ notes: [] })
  })

  it('keeps notes and steps across hook events', () => {
    start('c1')
    reg.addNote('c1', 'n')
    reg.setSteps('c1', 1, 3)
    reg.applyHook('c1', 'UserPromptSubmit', { prompt: 'p' })
    reg.applyHook('c1', 'Stop', {})
    expect(reg.get('c1')).toMatchObject({ notes: ['n'], steps: { done: 1, total: 3 } })
  })
})

describe('terminal title (tabOutput)', () => {
  const title = (text: string): string => `\x1b]0;${text}\x07`

  it('names the entry after the topic, in the detail the window gets', () => {
    start('c1')
    reg.tabOutput('c1', `${title('✳ Claude Code')}banner`)
    expect(reg.get('c1')?.title).toBeUndefined()
    reg.tabOutput('c1', title('◐ Greeting in two words'))
    expect(reg.get('c1')?.title).toBe('Greeting in two words')
    vi.runAllTimers()
    expect(sent.at(-1)?.own[0]).toMatchObject({ tabId: 'c1', title: 'Greeting in two words' })
  })

  it('reports no change while only the spinner glyph animates, nor for the reset at exit', () => {
    start('c1')
    reg.tabOutput('c1', title('◐ Fix the build'))
    const changes: SessionChange[] = []
    reg.onChange((c) => changes.push(c))
    for (const glyph of ['◑', '◐', '✳', '◑']) reg.tabOutput('c1', `out ${title(`${glyph} Fix the build`)} more`)
    reg.tabOutput('c1', title(''))
    reg.tabOutput('c1', title('✳ Claude Code'))
    expect(changes).toEqual([])
    expect(reg.get('c1')?.title).toBe('Fix the build')
  })

  it('reads a title split across chunks, ignores tabs with no entry, and starts over on restart', () => {
    start('c1')
    reg.tabOutput('c1', '\x1b]0;✳ Split ti')
    reg.tabOutput('c1', 'tle\x07')
    expect(reg.get('c1')?.title).toBe('Split title')
    reg.tabOutput('nope', title('✳ x'))
    reg.tabOutput('c1', '\x1b]0;✳ half of a tit')
    reg.tabExited('c1', 1)
    start('c1')
    // The new process's output does not complete the dead one's sequence, and the old name goes.
    reg.tabOutput('c1', 'le\x07')
    expect(reg.get('c1')?.title).toBeUndefined()
  })
})

describe('setGist', () => {
  it('stores a one-line, capped gist, removes it on blank or undefined, and only reports changes', () => {
    start('c1')
    const changes: SessionChange[] = []
    reg.onChange((c) => changes.push(c))
    expect(reg.setGist('c1', '  Adding a file\n tree plugin  ')).toBe(true)
    expect(reg.get('c1')?.gist).toBe('Adding a file tree plugin')
    reg.setGist('c1', 'Adding a file tree plugin')
    expect(changes).toHaveLength(1)
    reg.setGist('c1', 'x'.repeat(MAX_GIST_CHARS + 50))
    expect(reg.get('c1')?.gist).toHaveLength(MAX_GIST_CHARS)
    vi.runAllTimers()
    expect(sent.at(-1)?.own[0]?.gist).toHaveLength(MAX_GIST_CHARS)
    reg.setGist('c1', '   ')
    expect(reg.get('c1')).not.toHaveProperty('gist')
    reg.setGist('c1', 'again')
    reg.setGist('c1', undefined)
    expect(reg.get('c1')).not.toHaveProperty('gist')
    expect(reg.setGist('nope', 'x')).toBe(false)
  })
})
