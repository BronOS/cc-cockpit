import { describe, expect, it } from 'vitest'
import { formatUsageEntry, parseArgs, USAGE, USAGE_COLUMN, usageFor } from '../../src/cli/args'
import { CORE_CLI_COMMANDS, RESERVED_CLI_NAMES } from '../../src/shared/manifest'
import { HOOK_EVENTS } from '../../src/shared/hooks'

describe('parseArgs', () => {
  it.each(HOOK_EVENTS)('parses hook %s', (event) => {
    expect(parseArgs(['hook', event])).toEqual({ kind: 'hook', event })
  })

  it.each([
    [['hook']],
    [['hook', 'NoSuchEvent']],
    [['hook', 'stop']], // events are case-sensitive, like Claude's own
    [['hook', 'Stop', 'extra']]
  ])('treats the malformed hook line %j as nothing to do (never throws)', (argv) => {
    expect(parseArgs(argv)).toEqual({ kind: 'none' })
  })
})

// parseArgs dispatches through a table typed by CORE_CLI_COMMANDS (a core command that is not
// listed is a type error), so what is left to check is that the list is what parseArgs routes and
// that the reservation covers it.
describe('CORE_CLI_COMMANDS and RESERVED_CLI_NAMES', () => {
  it('reserves every core command, so a plugin can never take one', () => {
    expect(CORE_CLI_COMMANDS.length).toBeGreaterThan(5)
    for (const n of CORE_CLI_COMMANDS) expect(RESERVED_CLI_NAMES).toContain(n)
  })

  it('routes every core command itself, never as a plugin command', () => {
    for (const n of CORE_CLI_COMMANDS) {
      const parsed = parseArgs([n])
      expect(parsed.kind, n).not.toBe('plugin')
      if (parsed.kind === 'usage') expect(parsed.message, n).not.toMatch(/unknown command/)
    }
  })

  it('lists one usage block per core command but hook and statusline, in CORE_CLI_COMMANDS order', () => {
    const listed = CORE_CLI_COMMANDS.filter((c) => usageFor(c) !== undefined)
    expect(listed).toEqual(CORE_CLI_COMMANDS.filter((c) => c !== 'hook' && c !== 'statusline'))
    const firstWords = [...new Set([...USAGE.matchAll(/^ {2}ccc ([a-z]\S*)/gm)].map((m) => m[1]))]
    expect(firstWords).toEqual(listed)
  })

  it('formats a usage entry at USAGE_COLUMN, on the synopsis line only with two spaces to spare', () => {
    expect(formatUsageEntry({ synopsis: ['x'], text: ['does x'] })).toBe(`${'  ccc x'.padEnd(USAGE_COLUMN)}does x`)
    const long = 'y'.repeat(USAGE_COLUMN - 7)
    expect(formatUsageEntry({ synopsis: [long], text: ['a', 'b'] })).toBe(
      `  ccc ${long}\n${' '.repeat(USAGE_COLUMN)}a\n${' '.repeat(USAGE_COLUMN)}b`
    )
    expect(formatUsageEntry({ synopsis: ['z'], text: [] })).toBe('  ccc z')
  })
})

describe('ccc web (design-web.md §9.4)', () => {
  it('parses status, revoke and stop', () => {
    expect(parseArgs(['web', 'status'])).toEqual({ kind: 'web-status', json: false })
    expect(parseArgs(['web', 'status', '--json'])).toEqual({ kind: 'web-status', json: true })
    expect(parseArgs(['web', 'revoke', 'AbC-12_x'])).toEqual({ kind: 'web-revoke', id: 'AbC-12_x', all: false })
    expect(parseArgs(['web', 'revoke', '--all'])).toEqual({ kind: 'web-revoke', all: true })
    expect(parseArgs(['web', 'stop'])).toEqual({ kind: 'web-stop' })
    expect(parseArgs(['web', '--help'])).toEqual({ kind: 'help', command: 'web' })
    expect(parseArgs(['web', 'status', '-h'])).toEqual({ kind: 'help', command: 'web' })
  })

  it.each([
    [['web'], /web needs status, revoke or stop/],
    [['web', 'status', '--all'], /web status takes only --json/],
    [['web', 'revoke'], /one device id or --all/],
    [['web', 'revoke', 'a', 'b'], /one device id or --all/],
    [['web', 'revoke', '--all', 'a'], /one device id or --all/],
    [['web', 'revoke', ''], /one device id or --all/],
    [['web', 'revoke', '--json'], /unknown option --json/],
    [['web', 'stop', 'now'], /web stop takes no arguments/],
    // Task 12's subcommands are not parsed yet: a usage error, never a request.
    [['web', 'link'], /unknown web command: link/],
    [['web', 'bogus'], /unknown web command: bogus/]
  ])('%j is a usage error', (argv, message) => {
    const parsed = parseArgs(argv)
    expect(parsed.kind).toBe('usage')
    expect((parsed as { message: string }).message).toMatch(message)
  })
})
