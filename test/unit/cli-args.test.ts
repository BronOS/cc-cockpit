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
    expect(parseArgs(['web', 'revoke', '--', '-abc'])).toEqual({ kind: 'web-revoke', id: '-abc', all: false })
    expect(parseArgs(['web', 'revoke', '--', '--all'])).toEqual({ kind: 'web-revoke', id: '--all', all: false })
    expect(parseArgs(['web', 'stop'])).toEqual({ kind: 'web-stop' })
    expect(parseArgs(['web', '--help'])).toEqual({ kind: 'help', command: 'web' })
    expect(parseArgs(['web', 'status', '-h'])).toEqual({ kind: 'help', command: 'web' })
  })

  it.each([
    [['web'], /web needs status, revoke, stop, link, add-device, password, mode or set/],
    [['web', 'status', '--all'], /web status takes only --json/],
    [['web', 'revoke'], /one device id or --all/],
    [['web', 'revoke', 'a', 'b'], /one device id or --all/],
    [['web', 'revoke', '--all', 'a'], /one device id or --all/],
    [['web', 'revoke', ''], /one device id or --all/],
    [['web', 'revoke', '--json'], /unknown option --json/],
    [['web', 'stop', 'now'], /web stop takes no arguments/],
    [['web', 'bogus'], /unknown web command: bogus/],
    [['web', 'link', '--all'], /web link takes only --regenerate/],
    [['web', 'add-device', 'phone'], /web add-device takes no arguments/],
    [['web', 'mode'], /web mode takes link, password or none/],
    [['web', 'mode', 'open'], /web mode takes link, password or none/],
    [['web', 'mode', 'none', 'link'], /web mode takes/],
    [['web', 'mode', 'none', '--confirm'], /--confirm takes none-network or plain-http/],
    [['web', 'mode', 'none', '--confirm', 'everything'], /--confirm takes none-network or plain-http/],
    [['web', 'set'], /web set needs at least one option/],
    [['web', 'set', '--bind'], /--bind needs a value/],
    [['web', 'set', '--bind', ''], /--bind needs a value/],
    [['web', 'set', '--bind', 'a', '--bind', 'b'], /--bind given twice/],
    [['web', 'set', '--port', '70x0'], /--port takes a number/],
    [['web', 'set', '--port', '-1'], /--port takes a number/],
    [['web', 'set', '--port', '1e4'], /--port takes a number/],
    [['web', 'set', '--port', '123456'], /--port takes a number/],
    [['web', 'set', '--tls-cert', 'c.pem'], /--tls-cert and --tls-key go together/],
    [['web', 'set', '--start-folder'], /--start-folder needs a value/],
    [['web', 'set', '--start-folder', '/a', '--start-folder', '/b'], /--start-folder given twice/],
    [['web', 'set', '--tls-key', 'k.pem'], /--tls-cert and --tls-key go together/],
    [['web', 'set', '--no-tls', '--tls-cert', 'c', '--tls-key', 'k'], /--no-tls goes without/],
    [['web', 'set', '--confirm', 'all'], /--confirm takes none-network or plain-http/],
    [['web', 'set', '--enabled', 'false'], /unknown option --enabled/],
    [['web', 'set', '--mode'], /unknown option --mode/],
    [['web', 'set', 'bind=0.0.0.0'], /unknown option bind=0.0.0.0/]
  ])('%j is a usage error', (argv, message) => {
    const parsed = parseArgs(argv)
    expect(parsed.kind).toBe('usage')
    expect((parsed as { message: string }).message).toMatch(message)
  })

  it('parses link, add-device, password, mode and set (server-mode plan Task 12)', () => {
    expect(parseArgs(['web', 'link'])).toEqual({ kind: 'web-link', regenerate: false })
    expect(parseArgs(['web', 'link', '--regenerate'])).toEqual({ kind: 'web-link', regenerate: true })
    expect(parseArgs(['web', 'add-device'])).toEqual({ kind: 'web-add-device' })
    expect(parseArgs(['web', 'password'])).toEqual({ kind: 'web-password' })
    expect(parseArgs(['web', 'mode', 'password'])).toEqual({ kind: 'web-mode', mode: 'password', confirm: [] })
    expect(parseArgs(['web', 'mode', 'none', '--confirm', 'none-network'])).toEqual({ kind: 'web-mode', mode: 'none', confirm: ['none-network'] })
    // `confirm` goes to main, which refuses it with the reason (server mode: nobody to answer it).
    expect(parseArgs(['web', 'mode', 'confirm'])).toEqual({ kind: 'web-mode', mode: 'confirm', confirm: [] })
    expect(parseArgs(['web', 'set', '--bind', '0.0.0.0', '--confirm', 'none-network', '--confirm', 'plain-http'])).toEqual({
      kind: 'web-set',
      bind: '0.0.0.0',
      confirm: ['none-network', 'plain-http']
    })
    expect(
      parseArgs(['web', 'set', '--port', '7400', '--origin', 'https://box.example', '--host', 'box', '--host', 'box.lan:7400', '--tls-cert', 'c.pem', '--tls-key', '/k.pem'])
    ).toEqual({ kind: 'web-set', port: 7400, origin: 'https://box.example', hosts: ['box', 'box.lan:7400'], tls: { cert: 'c.pem', key: '/k.pem' }, confirm: [] })
    expect(parseArgs(['web', 'set', '--no-tls', '--origin', ''])).toEqual({ kind: 'web-set', tls: null, origin: '', confirm: [] })
    expect(parseArgs(['web', 'set', '--confirm', 'plain-http', '--confirm', 'plain-http'])).toEqual({ kind: 'web-set', confirm: ['plain-http'] })
    // The browser picker's start folder: a path as typed, or '' (back to the home folder).
    expect(parseArgs(['web', 'set', '--start-folder', '~/src'])).toEqual({ kind: 'web-set', startFolder: '~/src', confirm: [] })
    expect(parseArgs(['web', 'set', '--start-folder', ''])).toEqual({ kind: 'web-set', startFolder: '', confirm: [] })
  })

  it('never echoes an argument given to web password: it may be the password', () => {
    const parsed = parseArgs(['web', 'password', 'hunter2hunter2'])
    expect(parsed.kind).toBe('usage')
    expect((parsed as { message: string }).message).toMatch(/reads the password from stdin/)
    expect(JSON.stringify(parsed)).not.toContain('hunter2')
  })
})
