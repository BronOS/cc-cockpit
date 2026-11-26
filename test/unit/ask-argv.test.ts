// Task 02 (ask-argv.ts): the two modes' flags (D2, D11, D12, D14) and the help check; the gate script
// (scripts/ask-guest-check.mjs, task 01) writes the same lists out and must not drift from them.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ASK_GUEST_FLAGS, ASK_OWNER_FLAGS, REQUIRED_FLAGS, askArgv, flagsFor, hasFlag, missingFlags } from '../../src/main/ask/ask-argv'

const SESSION = '11111111-2222-3333-4444-555555555555'
const ISOLATION = ['--restricted', '--safe-mode', '--strict-mcp-config', '--tools']

describe('askArgv', () => {
  it('owner argv has none of --restricted, --safe-mode, --strict-mcp-config, --tools; owner REQUIRED_FLAGS do not demand them', () => {
    const argv = askArgv({ bin: 'claude', mode: 'owner', model: 'sonnet' })
    for (const f of ISOLATION) expect(argv, f).not.toContain(f)
    for (const f of ISOLATION) expect(REQUIRED_FLAGS.owner, f).not.toContain(f)
    expect(argv).toEqual(['claude', ...ASK_OWNER_FLAGS, '--model', 'sonnet'])
    expect(argv).toContain('--permission-prompts')
    expect(argv[argv.indexOf('--permission-prompts') + 1]).toBe('none')
  })

  it('the guest argv adds the isolation and an empty tool list (D12), and its required flags demand them', () => {
    const argv = askArgv({ bin: 'claude', mode: 'guest' })
    expect(argv).toEqual(['claude', ...ASK_OWNER_FLAGS, '--restricted', '--safe-mode', '--strict-mcp-config', '--tools', ''])
    for (const f of ISOLATION) expect(REQUIRED_FLAGS.guest, f).toContain(f)
  })

  it('model, effort and resume: only from the lists and only a UUID', () => {
    expect(askArgv({ bin: 'claude', mode: 'owner', model: 'opus', effort: 'max', resume: SESSION }).slice(-6)).toEqual([
      '--model',
      'opus',
      '--effort',
      'max',
      '--resume',
      SESSION
    ])
    expect(() => askArgv({ bin: 'claude', mode: 'owner', model: '--settings' })).toThrow(/model must be one of/)
    expect(() => askArgv({ bin: 'claude', mode: 'owner', effort: 'ultra' })).toThrow(/effort must be one of/)
    expect(() => askArgv({ bin: 'claude', mode: 'owner', resume: '--settings=/tmp/x' })).toThrow(/session id/)
    expect(() => askArgv({ bin: 'claude', mode: 'owner', resume: 'abc' })).toThrow(/session id/)
    expect(() => askArgv({ bin: 'claude', mode: 'root' as never })).toThrow(/mode/)
    expect(() => askArgv({ bin: '-x', mode: 'owner' })).toThrow(/executable/)
  })

  it('flagsFor adds --effort and --resume only when used', () => {
    expect(flagsFor({ mode: 'owner' })).toEqual([...REQUIRED_FLAGS.owner])
    expect(flagsFor({ mode: 'guest', effort: 'low', resume: SESSION })).toEqual([...REQUIRED_FLAGS.guest, '--effort', '--resume'])
  })
})

describe('the help check', () => {
  it('a flag counts only as a word of its own', () => {
    const help = '  -p, --print  Print\n  --tools <tools...>  Built-in tools\n  --safe-mode-extra  not it\n'
    expect(hasFlag(help, '-p')).toBe(true)
    expect(hasFlag(help, '--tools')).toBe(true)
    expect(hasFlag(help, '--safe-mode')).toBe(false)
    expect(missingFlags(help, ['-p', '--safe-mode', '--tools'])).toEqual(['--safe-mode'])
  })
})

describe('the gate script', () => {
  it('scripts/ask-guest-check.mjs writes out the same owner and guest flags', () => {
    const text = readFileSync(join(__dirname, '..', '..', 'scripts', 'ask-guest-check.mjs'), 'utf8')
    const between = (name: string): unknown => {
      const start = text.indexOf('// ' + name + '-BEGIN')
      const end = text.indexOf('// ' + name + '-END')
      expect(start, name).toBeGreaterThan(-1)
      const line = text.slice(start, end)
      const list = line.slice(line.indexOf('['), line.lastIndexOf(']') + 1)
      return JSON.parse(list.replace(/'/g, '"'))
    }
    expect(between('ASK-GATE-OWNER-FLAGS')).toEqual([...ASK_OWNER_FLAGS])
    expect(between('ASK-GATE-GUEST-FLAGS')).toEqual([...ASK_GUEST_FLAGS])
  })
})
