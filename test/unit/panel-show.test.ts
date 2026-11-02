// `ccc panel show` (friction round 1, Task 7): argument parsing, the request the CLI builds, and
// the socket handler's refusals. The real effect (LayoutService.show) is covered by layout tests
// and the e2e in test/e2e/panels.spec.ts.
import { beforeEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../../src/cli/args'
import { buildRequest } from '../../src/cli/client'
import { panelShowHandler, registerPanelShowHandler, type PanelShowOptions } from '../../src/main/socket/handlers'
import type { Caller } from '../../src/main/socket/socket-server'

describe('ccc panel show arguments', () => {
  it('parses <plugin>/<panel>, with or without --project', () => {
    expect(parseArgs(['panel', 'show', 'acme.todo/list'])).toEqual({ kind: 'panel-show', plugin: 'acme.todo', panel: 'list' })
    expect(parseArgs(['panel', 'show', '--project', '/p', 'acme.todo/list'])).toEqual({
      kind: 'panel-show',
      plugin: 'acme.todo',
      panel: 'list',
      project: '/p'
    })
  })

  it('is a usage error for anything else', () => {
    for (const argv of [['panel'], ['panel', 'hide', 'a.b/c'], ['panel', 'show'], ['panel', 'show', 'list'], ['panel', 'show', 'a.b/'], ['panel', 'show', '/c'],
      ['panel', 'show', 'NOPE/c'], ['panel', 'show', 'a.b/c', 'd.e/f'], ['panel', 'show', '--x', 'a.b/c'], ['panel', 'show', '--project']]) {
      expect(parseArgs(argv).kind, argv.join(' ')).toBe('usage')
    }
  })

  it('sends only the plugin and panel; the project is routing', () => {
    const cmd = parseArgs(['panel', 'show', 'acme.todo/list'])
    if (cmd.kind !== 'panel-show') throw new Error('not panel-show')
    expect(buildRequest(cmd, { APP_TAB_TOKEN: 'tok', CC_COCKPIT_SOCK: '/s' }, '/cwd')).toMatchObject({
      cmd: 'panel.show',
      args: { plugin: 'acme.todo', panel: 'list' },
      token: 'tok'
    })
  })
})

describe('the panel.show socket handler', () => {
  const P = 'proj-1'
  const shown: Array<[string, string]> = []
  let enabled = true
  let window: number | undefined = 3
  let known = true
  let has = true
  const options: PanelShowOptions = {
    pluginKnown: () => known,
    enabledIn: () => enabled,
    windowIdOf: () => window,
    showPanel: (projectId, key) => {
      shown.push([projectId, key])
      return has
    }
  }
  const handler = panelShowHandler(options)
  const call = (args: Record<string, unknown>, caller: Caller = { kind: 'window', projectId: P }): unknown =>
    handler(args, caller, new AbortController().signal)
  beforeEach(() => {
    shown.length = 0
    enabled = true
    window = 3
    known = true
    has = true
  })

  it('is registered as panel.show', () => {
    const names: string[] = []
    registerPanelShowHandler({ handle: (cmd) => void names.push(cmd) }, options)
    expect(names).toEqual(['panel.show'])
  })

  it('shows the panel in the caller\'s project, never one named in args', () => {
    call({ plugin: 'acme.x', panel: 'list', projectId: 'other', project: 'other' })
    call({ plugin: 'acme.x', panel: 'list' }, { kind: 'project', path: '/p', projectId: P })
    expect(shown).toEqual([[P, 'acme.x/list'], [P, 'acme.x/list']])
  })

  it('refuses unknown plugin, disabled plugin, closed window, unknown panel, bad fields', () => {
    known = false
    expect(() => call({ plugin: 'acme.x', panel: 'list' })).toThrow('unknown plugin: acme.x')
    known = true
    enabled = false
    expect(() => call({ plugin: 'acme.x', panel: 'list' })).toThrow('plugin acme.x is not enabled in this project')
    enabled = true
    window = undefined
    expect(() => call({ plugin: 'acme.x', panel: 'list' })).toThrow(/not open/)
    window = 3
    has = false
    expect(() => call({ plugin: 'acme.x', panel: 'nosuch' })).toThrow('plugin acme.x has no panel "nosuch" in this project')
    expect(() => call({ plugin: 'acme.x', panel: 'a/b' })).toThrow('needs a panel id')
    expect(() => call({ plugin: 5, panel: 'x' })).toThrow('needs a plugin id')
    expect(() => call({ plugin: 'acme.x', panel: 'list' }, { kind: 'anonymous' })).toThrow(/tab token or --project/)
    expect(() => call({ plugin: 'acme.x', panel: 'list' }, { kind: 'project', path: '/n', projectId: undefined })).toThrow(/not open/)
  })
})
