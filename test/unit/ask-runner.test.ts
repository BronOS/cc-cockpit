// Task 02 (ask-runner.ts): the real spawn against the fake claude (test/fixtures/bin/claude), so the Ask's process
// handling and the fixture's -p branch are both exercised: lines, the exit, the help read.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { askArgv, REQUIRED_FLAGS, missingFlags } from '../../src/main/ask/ask-argv'
import { readHelp, spawnAsk } from '../../src/main/ask/ask-runner'

const FAKE = resolve(__dirname, '..', 'fixtures', 'bin', 'claude')
const SESSION = '11111111-2222-3333-4444-555555555555'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccc-ask-run-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const env = (extra: Record<string, string> = {}): Record<string, string> => ({ PATH: process.env.PATH ?? '/usr/bin', ...extra })

function run(argv: string[], input: string[], extra: Record<string, string> = {}): Promise<{ lines: unknown[]; code: number | null; stderr: string }> {
  return new Promise((done) => {
    const lines: unknown[] = []
    const p = spawnAsk(argv, { cwd: dir, env: env(extra) }, {
      line: (text) => lines.push(JSON.parse(text)),
      exit: (info) => done({ lines, code: info.code, stderr: info.stderr })
    })
    for (const text of input) p.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
    setTimeout(() => p.kill(), 1500)
  })
}

describe('spawnAsk with the fake claude', () => {
  it('its --help lists every flag both modes require', async () => {
    const help = await readHelp(FAKE, env())
    expect(missingFlags(help, [...REQUIRED_FLAGS.guest, '--effort', '--resume'])).toEqual([])
  })

  it('a guest run: an init with no tools and a UUID session, the answer, the result', async () => {
    const { lines } = await run(askArgv({ bin: FAKE, mode: 'guest' }), ['hello'])
    const init = lines[0] as { subtype: string; tools: unknown[]; session_id: string }
    expect(init.subtype).toBe('init')
    expect(init.tools).toEqual([])
    expect(init.session_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(lines.at(-1)).toMatchObject({ type: 'result', subtype: 'success', result: 'FAKE-ANSWER hello' })
  })

  it('an owner run lists tools; --resume keeps the id, or fails before init when the session is gone', async () => {
    const owner = await run(askArgv({ bin: FAKE, mode: 'owner', resume: SESSION }), ['again'])
    expect(owner.lines[0]).toMatchObject({ session_id: SESSION, tools: ['Bash', 'Read'] })
    const gone = await run(askArgv({ bin: FAKE, mode: 'owner', resume: SESSION }), ['again'], { FAKE_CLAUDE_ASK_NO_SESSION: '1' })
    expect(gone.lines).toEqual([])
    expect(gone.code).toBe(1)
    expect(gone.stderr).toContain('No conversation found')
  })
})
