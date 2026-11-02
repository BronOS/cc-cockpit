import { describe, expect, it } from 'vitest'
import type { HookEvent } from '../../src/shared/hooks'
import {
  MAX_FILES,
  MAX_NOTE_CHARS,
  MAX_NOTES,
  MAX_PATH_CHARS,
  MAX_PROMPT_CHARS,
  MAX_TOOL_CHARS,
  cap,
  isAnswerKey,
  newEntry,
  reduce,
  withNote,
  withSteps,
  type ReducerEvent,
  type SessionEntry,
  type TabStatus
} from '../../src/main/sessions/status-reducer'

const HOOKS: HookEvent[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd'
]

const base = (): SessionEntry => newEntry({ tabId: 't1', projectId: 'p1', kind: 'claude', cwd: '/proj' })
const withStatus = (status: TabStatus, extra: Partial<SessionEntry> = {}): SessionEntry => ({
  ...base(),
  status,
  ...extra
})
const hook = (event: HookEvent, payload: unknown = {}): ReducerEvent => ({ type: 'hook', event, payload })

/** Apply events in order, like the registry does. */
function run(start: SessionEntry, ...events: ReducerEvent[]): SessionEntry {
  return events.reduce(reduce, start)
}

describe('newEntry', () => {
  it('starts in `starting` with empty collections', () => {
    expect(base()).toEqual({
      tabId: 't1',
      projectId: 'p1',
      kind: 'claude',
      cwd: '/proj',
      status: 'starting',
      notes: [],
      files: [],
      queue: [],
      delivering: false
    })
  })
})

describe('every hook event', () => {
  const cases: Array<{
    name: string
    from: SessionEntry
    event: ReducerEvent
    expected: Partial<SessionEntry>
  }> = [
    {
      name: 'SessionStart -> idle and stores session_id',
      from: base(),
      event: hook('SessionStart', { session_id: 'abc' }),
      expected: { status: 'idle', sessionId: 'abc' }
    },
    {
      name: 'SessionStart without a usable session_id keeps the old one',
      from: withStatus('starting', { sessionId: 'old' }),
      event: hook('SessionStart', { session_id: 42 }),
      expected: { status: 'idle', sessionId: 'old' }
    },
    {
      name: 'UserPromptSubmit -> working and lastPrompt, clears the tool',
      from: withStatus('waiting', { tool: 'Bash' }),
      event: hook('UserPromptSubmit', { prompt: 'fix it' }),
      expected: { status: 'working', lastPrompt: 'fix it', tool: undefined }
    },
    {
      name: 'UserPromptSubmit with a non-string prompt keeps the old prompt',
      from: withStatus('waiting', { lastPrompt: 'before' }),
      event: hook('UserPromptSubmit', { prompt: { x: 1 } }),
      expected: { status: 'working', lastPrompt: 'before' }
    },
    {
      name: 'PreToolUse -> working and tool',
      from: withStatus('idle'),
      event: hook('PreToolUse', { tool_name: 'Bash' }),
      expected: { status: 'working', tool: 'Bash' }
    },
    {
      name: 'PreToolUse with a non-string tool_name keeps the old tool',
      from: withStatus('working', { tool: 'Read' }),
      event: hook('PreToolUse', { tool_name: 7 }),
      expected: { status: 'working', tool: 'Read' }
    },
    {
      name: 'PostToolUse -> working and adds the file',
      from: withStatus('working'),
      event: hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/proj/a.ts' } }),
      expected: { status: 'working', files: ['/proj/a.ts'] }
    },
    {
      name: 'Notification permission_prompt -> needs-permission',
      from: withStatus('working'),
      event: hook('Notification', { notification_type: 'permission_prompt', message: 'x' }),
      expected: { status: 'needs-permission' }
    },
    {
      name: 'Notification idle_prompt -> waiting',
      from: withStatus('idle'),
      event: hook('Notification', { notification_type: 'idle_prompt' }),
      expected: { status: 'waiting' }
    },
    {
      name: 'Stop -> waiting and clears the tool',
      from: withStatus('working', { tool: 'Bash' }),
      event: hook('Stop'),
      expected: { status: 'waiting', tool: undefined }
    },
    {
      name: 'SessionEnd -> ended without an exit code',
      from: withStatus('waiting', { tool: 'Bash' }),
      event: hook('SessionEnd', { reason: 'other' }),
      expected: { status: 'ended', tool: undefined }
    },
    {
      name: 'PTY exit -> ended with the exit code',
      from: withStatus('working', { tool: 'Bash' }),
      event: { type: 'exit', code: 3 },
      expected: { status: 'ended', tool: undefined, exitCode: 3 }
    }
  ]
  it.each(cases)('$name', ({ from, event, expected }) => {
    expect(reduce(from, event)).toMatchObject(expected)
  })

  it('does not change the entry it was given', () => {
    const from = withStatus('working', { files: ['/a'] })
    const copy = structuredClone(from)
    reduce(from, hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/b' } }))
    reduce(from, hook('Stop'))
    expect(from).toEqual(copy)
  })
})

describe('payloads that are not objects', () => {
  it.each([null, undefined, 'text', 12, [1, 2]])('are treated as no payload (%j)', (payload) => {
    expect(reduce(withStatus('waiting'), hook('UserPromptSubmit', payload))).toMatchObject({
      status: 'working'
    })
    expect(reduce(base(), hook('SessionStart', payload))).toMatchObject({ status: 'idle' })
    expect(reduce(withStatus('working'), hook('Stop', payload))).toMatchObject({ status: 'waiting' })
    // Nothing to read: no tool, no file, unknown notification kind.
    expect(reduce(withStatus('idle'), hook('PreToolUse', payload)).tool).toBeUndefined()
    expect(reduce(withStatus('idle'), hook('PostToolUse', payload)).files).toEqual([])
    expect(reduce(withStatus('working'), hook('Notification', payload)).status).toBe('working')
  })
})

describe('SessionStart session_id validation', () => {
  it.each(['-x', 'a b', 'a'.repeat(200), ''])('ignores %j and keeps the old id', (bad) => {
    const out = reduce(withStatus('starting', { sessionId: 'old' }), hook('SessionStart', { session_id: bad }))
    expect(out.sessionId).toBe('old')
  })
})

describe('SessionStart from compaction', () => {
  it('leaves a working tab working with its tool: auto-compaction happens mid-turn', () => {
    const out = reduce(
      withStatus('working', { tool: 'Bash', sessionId: 's' }),
      hook('SessionStart', { session_id: 's', source: 'compact' })
    )
    expect(out).toMatchObject({ status: 'working', tool: 'Bash', sessionId: 's' })
  })

  it.each<TabStatus>(['starting', 'idle', 'waiting', 'needs-permission'])(
    'still moves %s to the non-sendable idle',
    (from) => {
      const out = reduce(withStatus(from, { tool: 'Bash' }), hook('SessionStart', { source: 'compact' }))
      expect(out).toMatchObject({ status: 'idle', tool: undefined })
    }
  )

  it.each(['startup', 'resume', 'clear', undefined])('source %j moves a working tab to idle', (source) => {
    const out = reduce(withStatus('working', { tool: 'Bash' }), hook('SessionStart', { source }))
    expect(out).toMatchObject({ status: 'idle', tool: undefined })
  })

  it('a SessionEnd-ended entry still comes back as idle', () => {
    const ended = withStatus('ended')
    expect(reduce(ended, hook('SessionStart', { source: 'compact' })).status).toBe('idle')
  })
})

describe('Notification kinds', () => {
  const note = (payload: unknown, from: TabStatus = 'working'): TabStatus =>
    reduce(withStatus(from), hook('Notification', payload)).status

  it('reads notification_type', () => {
    expect(note({ notification_type: 'permission_prompt' })).toBe('needs-permission')
    expect(note({ notification_type: 'idle_prompt' }, 'idle')).toBe('waiting')
  })

  it('idle_prompt never leaves needs-permission or working', () => {
    expect(note({ notification_type: 'idle_prompt' }, 'needs-permission')).toBe('needs-permission')
    expect(note({ notification_type: 'idle_prompt' }, 'working')).toBe('working')
  })

  it('falls back to "permission" in the message only when notification_type is absent', () => {
    expect(note({ message: 'Claude needs your permission to use Bash' })).toBe('needs-permission')
    expect(note({ message: 'PERMISSION required' })).toBe('needs-permission')
    expect(note({ message: 'Claude is waiting for your input' })).toBe('working')
  })

  it('leaves the status alone for an unknown kind, even if the message mentions permission', () => {
    expect(note({ notification_type: 'auth_success' })).toBe('working')
    expect(note({ notification_type: 'worker_permission_prompt', message: 'permission' })).toBe('working')
    expect(note({ notification_type: 7, message: 'permission' })).toBe('working')
    expect(note({ message: 7 })).toBe('working')
  })
})

describe('ordering', () => {
  it('PreToolUse -> Notification(permission) -> PreToolUse (next tool) -> Stop ends in waiting', () => {
    const steps: Array<[ReducerEvent, TabStatus, string | undefined]> = [
      [hook('SessionStart', { session_id: 's' }), 'idle', undefined],
      [hook('UserPromptSubmit', { prompt: 'go' }), 'working', undefined],
      [hook('PreToolUse', { tool_name: 'Bash' }), 'working', 'Bash'],
      [hook('Notification', { notification_type: 'permission_prompt' }), 'needs-permission', 'Bash'],
      // Approved: the next tool's PreToolUse must take the tab out of needs-permission.
      [hook('PreToolUse', { tool_name: 'Edit' }), 'working', 'Edit'],
      [hook('Stop'), 'waiting', undefined]
    ]
    let entry = base()
    for (const [event, status, tool] of steps) {
      entry = reduce(entry, event)
      expect([entry.status, entry.tool]).toEqual([status, tool])
    }
  })

  it('needs-permission -> PostToolUse -> working (the approved tool finished)', () => {
    const entry = run(
      withStatus('needs-permission', { tool: 'Edit' }),
      hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/proj/a.ts' } })
    )
    expect(entry).toMatchObject({ status: 'working', files: ['/proj/a.ts'] })
  })

  it('applies PreToolUse and PostToolUse from every live status', () => {
    for (const status of ['starting', 'idle', 'working', 'needs-permission', 'waiting'] as const) {
      expect(reduce(withStatus(status), hook('PreToolUse', { tool_name: 'X' })).status).toBe('working')
      expect(reduce(withStatus(status), hook('PostToolUse', {})).status).toBe('working')
    }
  })
})

describe('dialog tools (AskUserQuestion, ExitPlanMode)', () => {
  it.each(['AskUserQuestion', 'ExitPlanMode'])('PreToolUse(%s) -> needs-permission, the tool kept', (tool) => {
    const entry = reduce(withStatus('working'), hook('PreToolUse', { tool_name: tool }))
    expect(entry).toMatchObject({ status: 'needs-permission', tool })
  })

  it('enters needs-permission from every live status, never waiting', () => {
    for (const status of ['starting', 'idle', 'working', 'needs-permission', 'waiting'] as const) {
      expect(reduce(withStatus(status), hook('PreToolUse', { tool_name: 'AskUserQuestion' })).status).toBe(
        'needs-permission'
      )
    }
  })

  it('other tools, and a near-miss name, stay plain working', () => {
    for (const tool of ['Bash', 'askuserquestion', 'AskUserQuestion ', 'EnterPlanMode', '']) {
      expect(reduce(withStatus('waiting'), hook('PreToolUse', { tool_name: tool })).status).toBe('working')
    }
  })

  it('question -> answered (PostToolUse) -> working with the tool cleared -> Stop -> waiting', () => {
    const steps: Array<[ReducerEvent, TabStatus, string | undefined]> = [
      [hook('UserPromptSubmit', { prompt: 'plan it' }), 'working', undefined],
      [hook('PreToolUse', { tool_name: 'AskUserQuestion' }), 'needs-permission', 'AskUserQuestion'],
      // An idle Notification during the dialog must not make the tab sendable.
      [hook('Notification', { notification_type: 'idle_prompt' }), 'needs-permission', 'AskUserQuestion'],
      [hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } }), 'working', undefined],
      [hook('PreToolUse', { tool_name: 'ExitPlanMode' }), 'needs-permission', 'ExitPlanMode'],
      [hook('PostToolUse', { tool_name: 'ExitPlanMode' }), 'working', undefined],
      [hook('PreToolUse', { tool_name: 'Edit' }), 'working', 'Edit'],
      [hook('Stop'), 'waiting', undefined]
    ]
    let entry = base()
    for (const [event, status, tool] of steps) {
      entry = reduce(entry, event)
      expect([entry.status, entry.tool]).toEqual([status, tool])
    }
    expect(entry.files).toEqual([])
  })

  it('a file tool PostToolUse keeps its tool name, as before', () => {
    const entry = reduce(
      withStatus('working', { tool: 'Edit' }),
      hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/a' } })
    )
    expect(entry.tool).toBe('Edit')
  })

  it('an answer key does not leave a dialog tool (several questions take several keys)', () => {
    const asking = reduce(withStatus('working'), hook('PreToolUse', { tool_name: 'AskUserQuestion' }))
    expect(reduce(asking, { type: 'answer' })).toBe(asking)
    const planning = reduce(withStatus('working'), hook('PreToolUse', { tool_name: 'ExitPlanMode' }))
    expect(reduce(planning, { type: 'answer' })).toBe(planning)
  })

  it('UserPromptSubmit and SessionEnd leave it like a permission prompt', () => {
    const asking = reduce(withStatus('working'), hook('PreToolUse', { tool_name: 'AskUserQuestion' }))
    expect(reduce(asking, hook('UserPromptSubmit', { prompt: 'x' }))).toMatchObject({ status: 'working', tool: undefined })
    expect(reduce(asking, hook('SessionEnd')).status).toBe('ended')
  })
})

describe('answering a permission dialog (keystroke)', () => {
  const answer: ReducerEvent = { type: 'answer' }

  it('needs-permission -> answer -> working, the tool kept (no hook fires at approval)', () => {
    const entry = reduce(withStatus('needs-permission', { tool: 'Bash' }), answer)
    expect(entry).toMatchObject({ status: 'working', tool: 'Bash' })
  })

  it('changes nothing from any other status, ended included', () => {
    for (const status of ['starting', 'idle', 'working', 'waiting', 'ended'] as const) {
      const entry = withStatus(status)
      expect(reduce(entry, answer)).toBe(entry)
    }
    const dead = reduce(withStatus('needs-permission'), { type: 'exit', code: 1 })
    expect(reduce(dead, answer)).toBe(dead)
  })

  it('a later permission Notification puts the tab back', () => {
    const entry = run(
      withStatus('needs-permission'),
      answer,
      hook('PreToolUse', { tool_name: 'Bash' }),
      hook('Notification', { notification_type: 'permission_prompt', message: 'm' })
    )
    expect(entry.status).toBe('needs-permission')
  })

  it('isAnswerKey: Enter or a lone digit 1-9, as the whole chunk', () => {
    for (const key of ['\r', '1', '2', '9']) expect(isAnswerKey(key)).toBe(true)
    // Esc (denies, back to the prompt), arrows, focus and mouse reports, pastes, typed text.
    for (const key of ['\x1b', '\x1b[A', '\x1b[B', '\x1b[I', '\x1b[O', '\x1b[M !!', '0', 'y', '\n', '1\r', '\r\r', '12', '', '\x1b[200~1\x1b[201~']) {
      expect(isAnswerKey(key)).toBe(false)
    }
  })
})

describe('ended entries', () => {
  it('a PTY exit is final: late hooks do not revive the entry', () => {
    const dead = reduce(withStatus('working'), { type: 'exit', code: 1 })
    for (const event of HOOKS) expect(reduce(dead, hook(event, { session_id: 'x' }))).toBe(dead)
    // A second exit does not overwrite the first code.
    expect(reduce(dead, { type: 'exit', code: 9 })).toBe(dead)
  })

  it('SessionEnd alone is not final: /clear sends SessionStart in the same process', () => {
    const ended = reduce(withStatus('waiting'), hook('SessionEnd', { reason: 'clear' }))
    expect(ended.status).toBe('ended')
    expect(reduce(ended, hook('Stop'))).toBe(ended)
    expect(reduce(ended, hook('PreToolUse', { tool_name: 'X' }))).toBe(ended)
    expect(reduce(ended, hook('SessionStart', { session_id: 'new' }))).toMatchObject({
      status: 'idle',
      sessionId: 'new'
    })
  })

  it('a PTY exit after SessionEnd records the exit code', () => {
    const ended = reduce(withStatus('waiting'), hook('SessionEnd'))
    expect(reduce(ended, { type: 'exit', code: 0 })).toMatchObject({ status: 'ended', exitCode: 0 })
  })
})

describe('unknown events', () => {
  it('an event name the reducer does not know leaves the entry alone', () => {
    const entry = withStatus('waiting')
    // The socket handler refuses these before they get here; the reducer must not guess either.
    expect(reduce(entry, hook('Bogus' as HookEvent))).toBe(entry)
  })
})

describe('changed files', () => {
  const edit = (path: unknown, tool = 'Edit'): ReducerEvent =>
    hook('PostToolUse', { tool_name: tool, tool_input: { file_path: path } })

  it('dedupes and keeps first-seen order', () => {
    const entry = run(base(), edit('/a'), edit('/b'), edit('/a'))
    expect(entry.files).toEqual(['/a', '/b'])
  })

  it('takes notebook_path for NotebookEdit and ignores file_path there', () => {
    const nb = hook('PostToolUse', { tool_name: 'NotebookEdit', tool_input: { notebook_path: '/n.ipynb' } })
    expect(reduce(base(), nb).files).toEqual(['/n.ipynb'])
    const wrong = hook('PostToolUse', { tool_name: 'NotebookEdit', tool_input: { file_path: '/x' } })
    expect(reduce(base(), wrong).files).toEqual([])
    // And notebook_path means nothing to the other tools.
    const other = hook('PostToolUse', { tool_name: 'Edit', tool_input: { notebook_path: '/n.ipynb' } })
    expect(reduce(base(), other).files).toEqual([])
  })

  it('ignores non-string, empty and absurdly long paths without coercing them', () => {
    const bad = [42, null, undefined, { toString: () => '/x' }, ['/x'], '', 'x'.repeat(MAX_PATH_CHARS + 1)]
    for (const path of bad) expect(reduce(base(), edit(path)).files).toEqual([])
    expect(reduce(base(), hook('PostToolUse', { tool_name: 'Edit', tool_input: 'file' })).files).toEqual([])
    expect(reduce(base(), hook('PostToolUse', { tool_name: 'Edit', tool_input: null })).files).toEqual([])
  })

  it('stores a path that starts with `-` verbatim, and does not resolve relative ones', () => {
    const entry = run(base(), edit('-rf'), edit('--help'), edit('rel/path.ts'))
    expect(entry.files).toEqual(['-rf', '--help', 'rel/path.ts'])
  })

  it('drops the 501st distinct file but still dedupes and still sets working', () => {
    let entry = base()
    for (let i = 0; i < MAX_FILES; i++) entry = reduce(entry, edit(`/f${i}`))
    expect(entry.files).toHaveLength(MAX_FILES)
    const full = reduce(withStatus('idle', { files: entry.files }), edit('/one-too-many'))
    expect(full.files).toHaveLength(MAX_FILES)
    expect(full.files).not.toContain('/one-too-many')
    expect(full.status).toBe('working')
    // A file that is already in the list is not "new", full or not.
    expect(reduce(full, edit('/f0')).files).toHaveLength(MAX_FILES)
  })
})

describe('caps', () => {
  it('truncates an oversized prompt to 2 KiB', () => {
    const entry = reduce(base(), hook('UserPromptSubmit', { prompt: 'p'.repeat(MAX_PROMPT_CHARS + 500) }))
    expect(entry.lastPrompt).toBe('p'.repeat(MAX_PROMPT_CHARS))
  })

  it('truncates a long tool name to 100 chars', () => {
    const entry = reduce(base(), hook('PreToolUse', { tool_name: 't'.repeat(MAX_TOOL_CHARS + 50) }))
    expect(entry.tool).toHaveLength(MAX_TOOL_CHARS)
  })

  it('does not leave half a surrogate pair at the cut', () => {
    const emoji = '\u{1F600}'
    const text = 'a'.repeat(9) + emoji // the pair starts at index 9, so a cut at 10 would split it
    expect(cap(text, 10)).toBe('a'.repeat(9))
    expect(cap(text, 11)).toBe(text)
    expect(cap('short', 10)).toBe('short')
  })
})

describe('withNote / withSteps (ccc session note / steps)', () => {
  it('appends notes newest last, trimmed', () => {
    const e = withNote(withNote(base(), '  first '), 'second')
    expect(e.notes).toEqual(['first', 'second'])
  })

  it('keeps the newest MAX_NOTES: the 21st note pushes out the oldest', () => {
    let e = base()
    for (let i = 1; i <= MAX_NOTES + 1; i++) e = withNote(e, `n${i}`)
    expect(e.notes).toHaveLength(MAX_NOTES)
    expect(e.notes[0]).toBe('n2')
    expect(e.notes.at(-1)).toBe(`n${MAX_NOTES + 1}`)
  })

  it('cuts a long note to MAX_NOTE_CHARS and refuses a blank one', () => {
    expect(withNote(base(), 'x'.repeat(MAX_NOTE_CHARS + 50)).notes[0]).toHaveLength(MAX_NOTE_CHARS)
    expect(() => withNote(base(), '   ')).toThrow(/empty/)
  })

  it('does not mutate the entry it was given', () => {
    const e = base()
    withNote(e, 'x')
    withSteps(e, 1, 2)
    expect(e.notes).toEqual([])
    expect(e.steps).toBeUndefined()
  })

  it('sets steps for 0 <= done <= total, total >= 1', () => {
    expect(withSteps(base(), 3, 5).steps).toEqual({ done: 3, total: 5 })
    expect(withSteps(base(), 0, 1).steps).toEqual({ done: 0, total: 1 })
    expect(withSteps(base(), 5, 5).steps).toEqual({ done: 5, total: 5 })
  })

  it.each([
    [6, 5],
    [0, 0],
    [-1, 5],
    [1.5, 3],
    ['3', '5'],
    [null, 5],
    [1, 2_000_000],
    [Number.NaN, 5]
  ])('refuses steps %j/%j', (done, total) => {
    expect(() => withSteps(base(), done, total)).toThrow(/steps/)
  })
})
