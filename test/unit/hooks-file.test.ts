import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wrapperScript, writeCccWrapper } from '../../src/main/hooks/ccc-wrapper'
import { HOOK_TIMEOUT_SECONDS, buildHooksSettings, hookCommand, statusLineCommand, writeHooksFile } from '../../src/main/hooks/hooks-file'
import { shellQuote } from '../../src/main/hooks/shell-quote'
import { HOOK_EVENTS } from '../../src/shared/hooks'

const POSIX = process.platform !== 'win32'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cch-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Run a command string through sh, as Claude runs a hook command. */
const sh = (command: string): string => execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })

describe('shellQuote', () => {
  it.skipIf(!POSIX).each([
    'plain',
    'with space',
    "it's",
    "'''",
    '$HOME `id` $(id) ; & | > < * ?',
    'line\nbreak',
    '',
    '-n'
  ])('round-trips %j through sh as one word', (value) => {
    expect(sh(`printf %s ${shellQuote(value)}`)).toBe(value)
  })
})

describe('buildHooksSettings', () => {
  const settings = buildHooksSettings('/data/bin/ccc')

  it('has exactly the seven events, each with one command hook of timeout 5', () => {
    expect(Object.keys(settings.hooks).sort()).toEqual([...HOOK_EVENTS].sort())
    for (const event of HOOK_EVENTS) {
      const groups = settings.hooks[event]
      expect(groups).toHaveLength(1)
      expect(groups?.[0]?.hooks).toHaveLength(1)
      expect(groups?.[0]?.hooks[0]).toMatchObject({
        type: 'command',
        command: `'/data/bin/ccc' hook ${event}`,
        timeout: HOOK_TIMEOUT_SECONDS
      })
    }
    expect(HOOK_TIMEOUT_SECONDS).toBe(5)
  })

  it('uses the matchers: * for PreToolUse, the file and dialog tools for PostToolUse, none elsewhere', () => {
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe('*')
    // The dialog tools' PostToolUse is the sign their dialog was answered (status-reducer.ts).
    expect(settings.hooks.PostToolUse?.[0]?.matcher).toBe(
      'Edit|Write|MultiEdit|NotebookEdit|AskUserQuestion|ExitPlanMode'
    )
    for (const event of HOOK_EVENTS) {
      if (event !== 'PreToolUse' && event !== 'PostToolUse') {
        expect(settings.hooks[event]?.[0]).not.toHaveProperty('matcher')
      }
    }
  })

  // An async hook would let ccc startup jitter reorder events at main (PreToolUse after the
  // permission Notification); see hooks-file.ts.
  it('runs every hook synchronously, so events reach main in the order Claude fired them', () => {
    for (const event of HOOK_EVENTS) {
      expect(settings.hooks[event]?.[0]?.hooks[0]).not.toHaveProperty('async')
    }
  })

  it.skipIf(!POSIX)('quotes a wrapper path containing a space and an apostrophe so sh runs it', () => {
    const dir = join(root, "it's a dir")
    mkdirSync(dir)
    const script = join(dir, 'ccc')
    writeFileSync(script, '#!/bin/sh\nprintf "%s|%s" "$1" "$2"\n', { mode: 0o755 })
    chmodSync(script, 0o755)
    expect(hookCommand(script, 'PreToolUse')).toContain("it'\\''s a dir/ccc' hook")
    expect(sh(hookCommand(script, 'PreToolUse'))).toBe('hook|PreToolUse')
  })
})

describe('the statusLine (app setting "Rate limits from the status line")', () => {
  it('is left out by default and with the setting off: the file holds the hooks only', () => {
    expect(buildHooksSettings('/data/bin/ccc')).not.toHaveProperty('statusLine')
    expect(buildHooksSettings('/data/bin/ccc', { statusLine: false })).not.toHaveProperty('statusLine')
  })

  it("is `'<ccc>' statusline` with the setting on, and nothing else: the person's padding and refreshInterval still merge in", () => {
    const settings = buildHooksSettings('/data/bin/ccc', { statusLine: true })
    expect(settings.statusLine).toEqual({ type: 'command', command: "'/data/bin/ccc' statusline" })
    // Claude deep-merges the layers: a padding or refreshInterval here would override the person's.
    expect(Object.keys(settings.statusLine ?? {}).sort()).toEqual(['command', 'type'])
    // The hooks are the same either way.
    expect(settings.hooks).toEqual(buildHooksSettings('/data/bin/ccc').hooks)
  })

  it.skipIf(!POSIX)('quotes the wrapper path so sh runs it with the one argument', () => {
    const dir = join(root, "it's a dir")
    mkdirSync(dir)
    const script = join(dir, 'ccc')
    writeFileSync(script, '#!/bin/sh\nprintf "%s|%s" "$#" "$1"\n', { mode: 0o755 })
    chmodSync(script, 0o755)
    expect(sh(statusLineCommand(script))).toBe('1|statusline')
  })

  it('is written to and removed from the file as the setting flips', () => {
    const file = join(root, 'hooks.json')
    writeHooksFile(file, '/data/bin/ccc', { statusLine: true })
    expect(JSON.parse(readFileSync(file, 'utf8')).statusLine).toEqual({ type: 'command', command: "'/data/bin/ccc' statusline" })
    writeHooksFile(file, '/data/bin/ccc', { statusLine: false })
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('statusLine')
  })
})

describe('writeHooksFile', () => {
  it('writes valid JSON, replaces an older file and leaves no temp file behind', () => {
    const file = join(root, 'data', 'hooks.json')
    writeHooksFile(file, '/old/ccc')
    writeHooksFile(file, '/new/ccc')
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed).toEqual(JSON.parse(JSON.stringify(buildHooksSettings('/new/ccc'))))
    expect(parsed).not.toHaveProperty('schemaVersion')
    expect(readdirSync(join(root, 'data'))).toEqual(['hooks.json'])
  })
})

describe('ccc wrapper', () => {
  it('is a sh script that runs the Electron binary as Node on the CLI entry, passing arguments through', () => {
    const text = wrapperScript({ electronBinary: '/e/Electron', cliEntry: '/app/out/cli/index.js', dataDir: '/data' })
    expect(text.startsWith('#!/bin/sh\n')).toBe(true)
    expect(text).toContain(
      `CC_COCKPIT_DATA_DIR='/data' ELECTRON_RUN_AS_NODE=1 exec '/e/Electron' '/app/out/cli/index.js' "$@"`
    )
  })

  it.skipIf(!POSIX)('is written 0755 and works with spaces and apostrophes in every path', () => {
    const dir = join(root, "o'brien dir")
    mkdirSync(dir)
    // Node stands in for the Electron binary: both honour ELECTRON_RUN_AS_NODE-style invocation
    // `bin script args`, and the script reports what the wrapper handed it.
    const cli = join(dir, 'index.js')
    writeFileSync(
      cli,
      'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), asNode: process.env.ELECTRON_RUN_AS_NODE, data: process.env.CC_COCKPIT_DATA_DIR, stdin: require("fs").readFileSync(0, "utf8") }))'
    )
    const wrapper = join(dir, 'bin', 'ccc')
    writeCccWrapper(wrapper, { electronBinary: process.execPath, cliEntry: cli, dataDir: join(dir, 'data dir') })
    expect(statSync(wrapper).mode & 0o777).toBe(0o755)
    const out = execFileSync(wrapper, ['hook', 'Stop', 'two words'], { encoding: 'utf8', input: '{"a":1}' })
    expect(JSON.parse(out)).toEqual({
      argv: ['hook', 'Stop', 'two words'],
      asNode: '1',
      data: join(dir, 'data dir'),
      stdin: '{"a":1}'
    })
  })

  // A dev rebuild empties out/, and a moved app leaves a stale binary path: a hook must still
  // exit 0 with nothing on stderr, never 1 (missing entry) or 126/127 (missing binary).
  it.skipIf(!POSIX)('exits 0 silently when the CLI entry or the Electron binary is missing', () => {
    const wrapper = join(root, 'bin', 'ccc')
    const cases = [
      { electronBinary: process.execPath, cliEntry: join(root, 'gone', 'index.js'), dataDir: root },
      { electronBinary: join(root, 'gone', 'Electron'), cliEntry: wrapper, dataDir: root }
    ]
    for (const targets of cases) {
      writeCccWrapper(wrapper, targets)
      const result = spawnSync(wrapper, ['hook', 'Stop'], { encoding: 'utf8', input: '{}' })
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toBe('')
    }
  })

  it('replaces an existing wrapper in place', () => {
    const wrapper = join(root, 'bin', 'ccc')
    writeCccWrapper(wrapper, { electronBinary: '/a', cliEntry: '/b', dataDir: '/c' })
    writeCccWrapper(wrapper, { electronBinary: '/x', cliEntry: '/y', dataDir: '/z' })
    expect(readFileSync(wrapper, 'utf8')).toContain("exec '/x' '/y'")
    expect(readdirSync(join(root, 'bin'))).toEqual(['ccc'])
    expect(existsSync(wrapper)).toBe(true)
  })
})
