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

  it('lists one usage block per core command but hook, in CORE_CLI_COMMANDS order', () => {
    const listed = CORE_CLI_COMMANDS.filter((c) => usageFor(c) !== undefined)
    expect(listed).toEqual(CORE_CLI_COMMANDS.filter((c) => c !== 'hook'))
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
