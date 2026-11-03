// The session gist: when it runs (src/main/sessions/session-gist.ts) over a real SessionRegistry and a
// fake runner, and the run itself (gist-run.ts) against a fake `claude` script found on PATH.
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GIST_ARGV, gistInput, gistOf, MAX_GIST_INPUT_CHARS, runGist } from '../../src/main/sessions/gist-run'
import { SessionGist } from '../../src/main/sessions/session-gist'
import { SessionRegistry } from '../../src/main/sessions/session-registry'

interface Call {
  prompts: readonly string[]
  signal: AbortSignal
  resolve(gist: string): void
  reject(err: Error): void
}

describe('SessionGist (when a gist runs)', () => {
  let reg: SessionRegistry
  let gist: SessionGist
  let enabled: boolean
  let calls: Call[]
  let logs: string[]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    enabled = true
    calls = []
    logs = []
    reg = new SessionRegistry({ projectName: () => 'p', broadcast: () => {}, write: () => {}, log: () => {} })
    gist = new SessionGist({
      enabled: () => enabled,
      sessions: reg,
      run: (prompts, signal) =>
        new Promise<string>((resolve, reject) => {
          calls.push({ prompts, signal, resolve, reject })
          signal.addEventListener('abort', () => reject(new Error('cancelled')))
        }),
      log: (m) => logs.push(m)
    })
  })

  afterEach(() => {
    gist.dispose()
    reg.dispose()
    vi.useRealTimers()
  })

  const start = (tabId: string): void => reg.tabStarted({ tabId, projectId: 'p', kind: 'claude', cwd: '/proj' })
  /** One whole turn: the prompt, then Stop. */
  const turn = (tabId: string, prompt: string): void => {
    reg.applyHook(tabId, 'UserPromptSubmit', { prompt })
    reg.applyHook(tabId, 'Stop', {})
  }
  const settle = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0)
  }

  it('runs after a turn ends with the recent prompts, and stores the gist', async () => {
    start('c1')
    reg.applyHook('c1', 'UserPromptSubmit', { prompt: 'add a file tree' })
    expect(calls).toHaveLength(0) // not while the turn runs
    reg.applyHook('c1', 'Stop', {})
    expect(calls.map((c) => c.prompts)).toEqual([['add a file tree']])
    calls[0]?.resolve('Adding a file tree plugin')
    await settle()
    expect(reg.get('c1')?.gist).toBe('Adding a file tree plugin')
  })

  it('does nothing while off, and for a turn whose prompts did not change', async () => {
    enabled = false
    start('c1')
    turn('c1', 'one')
    expect(calls).toHaveLength(0)
    enabled = true
    reg.applyHook('c1', 'UserPromptSubmit', { prompt: 'two' })
    reg.applyHook('c1', 'Stop', {})
    calls[0]?.resolve('g')
    await settle()
    await vi.advanceTimersByTimeAsync(120_000)
    // A permission prompt answered, a notification: back to waiting with the same prompts.
    reg.applyHook('c1', 'Notification', { notification_type: 'permission_prompt' })
    reg.applyHook('c1', 'Stop', {})
    // A turn of harness blocks only keeps the prompts as they were.
    turn('c1', '<task-notification><status>completed</status></task-notification>')
    expect(calls).toHaveLength(1)
  })

  it('keeps a minimum gap per tab and coalesces the turns inside it into one rerun', async () => {
    start('c1')
    turn('c1', 'p1')
    calls[0]?.resolve('g1')
    await settle()
    turn('c1', 'p2')
    turn('c1', 'p3')
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(59_000)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls.map((c) => c.prompts)).toEqual([['p1'], ['p1', 'p2', 'p3']])
  })

  it('runs one per tab at a time: a turn ending meanwhile reruns after it', async () => {
    start('c1')
    turn('c1', 'p1')
    turn('c1', 'p2')
    expect(calls).toHaveLength(1)
    calls[0]?.resolve('g1')
    await settle()
    // The rerun still waits for the gap.
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls[1]?.prompts).toEqual(['p1', 'p2'])
  })

  it('runs at most two at once app-wide; the others wait their turn', async () => {
    for (const t of ['a', 'b', 'c']) {
      start(t)
      turn(t, `prompt ${t}`)
    }
    expect(calls.map((c) => c.prompts[0])).toEqual(['prompt a', 'prompt b'])
    calls[0]?.reject(new Error('boom'))
    await settle()
    expect(calls.map((c) => c.prompts[0])).toEqual(['prompt a', 'prompt b', 'prompt c'])
    // A failure is logged and stays silent: no gist, and the same prompts are not retried.
    expect(logs).toEqual([expect.stringContaining('session a: gist failed: boom')])
    expect(reg.get('a')).not.toHaveProperty('gist')
    await vi.advanceTimersByTimeAsync(120_000)
    reg.applyHook('a', 'Notification', { notification_type: 'permission_prompt' })
    reg.applyHook('a', 'Stop', {})
    expect(calls).toHaveLength(3)
  })

  it('off cancels the runs and removes every gist; on gives the waiting tabs one', async () => {
    start('c1')
    start('c2')
    turn('c1', 'p1')
    calls[0]?.resolve('gist one')
    await settle()
    turn('c2', 'p2')
    expect(calls).toHaveLength(2)
    enabled = false
    gist.settingChanged()
    expect(calls[1]?.signal.aborted).toBe(true)
    await settle()
    expect(reg.get('c1')).not.toHaveProperty('gist')
    expect(reg.get('c2')).not.toHaveProperty('gist')
    expect(logs).toEqual([]) // a cancel is not a failure
    enabled = true
    gist.settingChanged()
    expect(calls.slice(2).map((c) => c.prompts)).toEqual([['p1'], ['p2']])
  })

  it('drops the result of a run whose tab closed, and its pending rerun', async () => {
    start('c1')
    turn('c1', 'p1')
    calls[0]?.resolve('g')
    await settle()
    turn('c1', 'p2') // a rerun scheduled for the end of the gap
    start('c2')
    turn('c2', 'q')
    reg.tabClosed('c2')
    expect(calls[1]?.signal.aborted).toBe(true)
    reg.tabClosed('c1')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls).toHaveLength(2)
  })
})

describe('gistInput / gistOf', () => {
  it('sends the prompts oldest first, dropping the oldest past the cap', () => {
    const input = gistInput(['first', 'second'])
    expect(input.indexOf('first')).toBeLessThan(input.indexOf('second'))
    const big = gistInput(['STALE'.repeat(1000), 'x'.repeat(MAX_GIST_INPUT_CHARS - 10), 'newest'])
    expect(big).toContain('newest')
    expect(big).not.toContain('STALE')
    expect(big.length).toBeLessThan(MAX_GIST_INPUT_CHARS + 1000)
  })

  it('takes the first line, without quotes or markdown', () => {
    expect(gistOf('\n"Adding a file tree plugin"\nmore\n')).toBe('Adding a file tree plugin')
    expect(gistOf('**Fixing the build**')).toBe('Fixing the build')
    expect(gistOf('# Fixing CI')).toBe('Fixing CI')
    expect(gistOf('  \n \n')).toBeUndefined()
  })
})

describe('runGist (a fake claude on PATH)', () => {
  let dir: string
  let log: string
  const node = process.execPath

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-gist-')))
    log = join(dir, 'calls.jsonl')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** A `claude` that records argv, stdin and env, then does what `body` says. */
  function fakeClaude(body: string): Record<string, string> {
    const script = join(dir, 'claude')
    writeFileSync(
      script,
      `#!${node}
const fs = require('node:fs')
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), input, env: process.env }) + '\\n')
  ${body}
})
`
    )
    chmodSync(script, 0o755)
    return { PATH: `${dir}:${dirname(node)}`, HOME: dir }
  }

  it('runs claude -p with the isolating flags, the prompts on stdin, and returns its first line', async () => {
    const env = fakeClaude(`process.stdout.write('Adding a file tree plugin\\n')`)
    const gist = await runGist(['add a file tree', '--help me'], new AbortController().signal, { env, cwd: dir })
    expect(gist).toBe('Adding a file tree plugin')
    const call = JSON.parse(readFileSync(log, 'utf8').trim())
    expect(['claude', ...call.argv]).toEqual(GIST_ARGV)
    expect(call.argv).toEqual(expect.arrayContaining(['-p', '--safe-mode', '--strict-mcp-config', '--no-session-persistence']))
    // The prompts travel on stdin only, never as an argument that could read as an option.
    expect(call.input).toContain('add a file tree')
    expect(call.input).toContain('--help me')
    expect(call.argv.join(' ')).not.toContain('file tree')
    expect(Object.keys(call.env).filter((k) => k.startsWith('APP_TAB') || k.startsWith('CC_COCKPIT'))).toEqual([])
  })

  it('rejects a failing run with its stderr, and an empty answer', async () => {
    let env = fakeClaude(`process.stderr.write('Not logged in\\n'); process.exit(1)`)
    await expect(runGist(['x'], new AbortController().signal, { env, cwd: dir })).rejects.toThrow(
      'gist run failed (exit code 1): Not logged in'
    )
    env = fakeClaude(`process.stdout.write('\\n\\n')`)
    await expect(runGist(['x'], new AbortController().signal, { env, cwd: dir })).rejects.toThrow('printed nothing')
  })

  it('rejects when claude is not on PATH', async () => {
    await expect(runGist(['x'], new AbortController().signal, { env: { PATH: dir }, cwd: dir })).rejects.toThrow(/ENOENT/)
  })

  it('kills a run that outlives its timeout, and one that is cancelled', async () => {
    const env = fakeClaude(`setInterval(() => {}, 1000)`)
    await expect(runGist(['x'], new AbortController().signal, { env, cwd: dir, timeoutMs: 300 })).rejects.toThrow('timed out')
    const controller = new AbortController()
    const run = runGist(['x'], controller.signal, { env, cwd: dir })
    setTimeout(() => controller.abort(), 100)
    await expect(run).rejects.toThrow('cancelled')
  })
})
