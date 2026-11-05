// Key bindings for the new-tab menu entries (design §3 Custom commands › Keys for entries): each
// entry is a command of the key table, app-wide ones in every project and a project's only in its
// own; ids come from level + entry id, so a rename keeps the chord; a removed entry's override is
// ignored; running one opens the tab by level and id (the renderer never holds the command line).
import { afterEach, describe, expect, it } from 'vitest'
import { CommandRegistry, type TabCommandEntries } from '../../src/main/commands/command-registry'
import { AppearanceService } from '../../src/main/settings/appearance-service'
import { menuWithKeys, newTabMenu, TabCommandsService } from '../../src/main/tabs/tab-commands'
import {
  commandForEvent,
  registerHandlers,
  resetKeybindings,
  runCommand,
  runnableCommands,
  setCommands,
  tabCommandHandlers
} from '../../src/renderer/commands/keybindings'
import { parseTabCommandId, tabCommandId, tabCommandTitle } from '../../src/shared/tab-commands'
import type { TabCommandEntry } from '../../src/shared/types'

const A = 'aaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbb'
const entry = (id: string, label: string): TabCommandEntry => ({ id, label, command: `run ${id}` })

/** A registry over plain variables: app-wide entries, entries per project, the overrides. */
function rig(overrides: Record<string, string> = {}) {
  const state = {
    overrides,
    app: [entry('lg', 'lazygit')] as TabCommandEntry[],
    projects: { [A]: [entry('dev', 'npm run dev')] } as Record<string, TabCommandEntry[]>
  }
  const entries = (projectId: string): TabCommandEntries => ({ app: state.app, project: state.projects[projectId] ?? [] })
  const registry = new CommandRegistry('darwin', () => state.overrides, entries)
  return { state, registry }
}

const ids = (r: CommandRegistry, projectId: string): string[] =>
  r
    .view(projectId)
    .commands.filter((c) => c.source === 'tabCommand')
    .map((c) => c.id)

describe('tab command ids', () => {
  it('derive from level and entry id, and parse back', () => {
    expect(tabCommandId('app', 'lg')).toBe('tab.newCommand.app.lg')
    expect(tabCommandId('project', 'dev')).toBe('tab.newCommand.project.dev')
    expect(parseTabCommandId('tab.newCommand.app.lg')).toEqual({ level: 'app', entryId: 'lg' })
    expect(parseTabCommandId('tab.newCommand.project.0b6f-x_1')).toEqual({ level: 'project', entryId: '0b6f-x_1' })
    expect(tabCommandTitle('lazygit')).toBe('New tab: lazygit')
    expect(tabCommandTitle('lazygit', 'tab')).toBe('New tab: lazygit')
    expect(tabCommandTitle('lazygit', 'overlay')).toBe('Overlay: lazygit')
  })

  it('parse nothing else: core and plugin ids, an unknown level, a bad entry id', () => {
    for (const id of [
      'tab.newClaude',
      'hello/greet',
      'tab.newCommand.app',
      'tab.newCommand.app.',
      'tab.newCommand.user.lg',
      'tab.newCommand.app.a.b',
      'tab.newCommand.app.a/b',
      `tab.newCommand.app.${'x'.repeat(65)}`
    ]) {
      expect(parseTabCommandId(id), id).toBeUndefined()
    }
  })
})

describe('CommandRegistry with new-tab menu entries', () => {
  it('lists app-wide entries in every project and a project entry only in its own, unbound, titled by the label', () => {
    const { registry } = rig()
    expect(ids(registry, A)).toEqual(['tab.newCommand.app.lg', 'tab.newCommand.project.dev'])
    expect(ids(registry, B)).toEqual(['tab.newCommand.app.lg'])
    // '' (the picker, nothing focused) still sees the app-wide ones.
    expect(ids(registry, '')).toEqual(['tab.newCommand.app.lg'])
    const lg = registry.view(A).commands.find((c) => c.id === 'tab.newCommand.app.lg')
    expect(lg).toEqual({ id: 'tab.newCommand.app.lg', title: 'New tab: lazygit', source: 'tabCommand' })
    const row = registry.bindings(A).find((r) => r.id === 'tab.newCommand.project.dev')
    expect(row).toMatchObject({ title: 'New tab: npm run dev', source: 'tabCommand', overridden: false, inactive: false })
    expect(row?.key).toBeUndefined()
    expect(row?.defaultKey).toBeUndefined()
    expect(registry.has(A, 'tab.newCommand.project.dev')).toBe(true)
    expect(registry.has(B, 'tab.newCommand.project.dev')).toBe(false)
  })

  it('binds an override, keeps it through a rename, and ignores it once the entry is gone', () => {
    const { state, registry } = rig({ 'tab.newCommand.app.lg': 'Cmd+Shift+L' })
    const key = (projectId: string): string | undefined =>
      registry.view(projectId).commands.find((c) => c.id === 'tab.newCommand.app.lg')?.key
    expect(key(A)).toBe('shift+meta+l')
    expect(key(B)).toBe('shift+meta+l')
    state.app = [entry('lg', 'LazyGit!')]
    expect(registry.view(A).commands.find((c) => c.id === 'tab.newCommand.app.lg')).toMatchObject({
      title: 'New tab: LazyGit!',
      key: 'shift+meta+l'
    })
    // Removed: the override is still stored but names nothing; no command, no chord, no throw.
    state.app = []
    const view = registry.view(A)
    expect(ids(registry, A)).toEqual(['tab.newCommand.project.dev'])
    expect(view.commands.some((c) => c.key === 'shift+meta+l')).toBe(false)
    expect(registry.bindings(A).some((r) => r.id === 'tab.newCommand.app.lg')).toBe(false)
    expect(registry.has(A, 'tab.newCommand.app.lg')).toBe(false)
  })

  it('a project entry bound in one project does not put that chord in another', () => {
    const { registry } = rig({ 'tab.newCommand.project.dev': 'Cmd+Shift+D' })
    expect(registry.view(A).commands.find((c) => c.key === 'shift+meta+d')?.id).toBe('tab.newCommand.project.dev')
    expect(registry.view(B).commands.some((c) => c.key === 'shift+meta+d')).toBe(false)
  })

  it('reports a conflict with a core default; the user override wins it', () => {
    const { registry } = rig({ 'tab.newCommand.app.lg': 'Cmd+T' })
    const view = registry.view(A)
    expect(view.conflicts).toEqual([{ chord: 'meta+t', commands: ['tab.newClaude', 'tab.newCommand.app.lg'] }])
    expect(view.commands.find((c) => c.key === 'meta+t')?.id).toBe('tab.newCommand.app.lg')
    const rows = registry.bindings(A)
    expect(rows.find((r) => r.id === 'tab.newClaude')).toMatchObject({
      inactive: true,
      conflictsWith: ['New tab: lazygit']
    })
    expect(rows.find((r) => r.id === 'tab.newCommand.app.lg')).toMatchObject({
      inactive: false,
      conflictsWith: ['New Claude Tab']
    })
  })

  it('two entries given the same chord tie and neither fires', () => {
    const { registry } = rig({ 'tab.newCommand.app.lg': 'Cmd+Shift+L', 'tab.newCommand.project.dev': 'Cmd+Shift+L' })
    const view = registry.view(A)
    expect(view.conflicts).toEqual([{ chord: 'shift+meta+l', commands: ['tab.newCommand.app.lg', 'tab.newCommand.project.dev'] }])
    expect(view.commands.some((c) => c.key === 'shift+meta+l')).toBe(false)
  })
})

describe('binding an entry in Settings (AppearanceService.setKey)', () => {
  function service() {
    const r = rig()
    let keysChanged = 0
    const appearance = new AppearanceService({
      themes: { list: () => [], current: () => ({ id: 'x' }) as never, selected: () => undefined, setActive: () => {} },
      commands: r.registry,
      platform: 'darwin',
      overrides: {
        get: () => r.state.overrides,
        set: (next) => {
          r.state.overrides = next
        }
      },
      keysChanged: () => {
        keysChanged++
      },
      tabExit: { get: () => undefined, set: () => {} },
      claudeTabOnOpen: { get: () => undefined, set: () => {} },
      sessionGist: { get: () => undefined, set: () => {} },
      sessionGistChanged: () => {},
      notificationSounds: { get: () => undefined, set: () => {} },
      notificationSound: { get: () => undefined, set: () => {}, systemHas: async () => false },
      confirmTabClose: { get: () => undefined, set: () => {} },
      tabCloseSide: { get: () => undefined, set: () => {} },
      zoneAutoHide: { get: () => undefined, set: () => {} },
      minTerminalWidth: { get: () => undefined, set: () => {} },
      terminalFont: { get: () => undefined, set: () => {} },
      prefsChanged: () => {},
      tabCommands: { get: () => r.state.app },
      windowBackground: { get: () => undefined, set: () => {} },
      blurSupport: 'vibrancy',
      blurChanged: () => {}
    })
    return { ...r, appearance, keysChanged: () => keysChanged }
  }

  it('stores a chord for an entry of the asking project, and refuses one of another project', () => {
    const s = service()
    s.appearance.setKey(A, 'tab.newCommand.project.dev', 'Cmd+Shift+D')
    expect(s.state.overrides).toEqual({ 'tab.newCommand.project.dev': 'shift+meta+d' })
    expect(s.keysChanged()).toBe(1)
    expect(() => s.appearance.setKey(B, 'tab.newCommand.project.dev', 'Cmd+Shift+E')).toThrow('unknown command')
    // Reset drops the override: the entry is unbound again (it has no default).
    s.appearance.setKey(A, 'tab.newCommand.project.dev', null)
    expect(s.state.overrides).toEqual({})
    expect(s.registry.view(A).commands.find((c) => c.id === 'tab.newCommand.project.dev')?.key).toBeUndefined()
  })
})

describe('the [+] menu shows chords', () => {
  it('adds each entry its chord from the key table, by command id', () => {
    const { registry } = rig({ 'tab.newCommand.project.dev': 'Cmd+Shift+D' })
    const keys = new Map(registry.view(A).commands.map((c) => [c.id, c.key]))
    const menu = menuWithKeys(newTabMenu([entry('lg', 'lazygit')], [entry('dev', 'npm run dev')]), (id) => keys.get(id))
    expect(menu).toEqual({
      app: [{ id: 'lg', label: 'lazygit' }],
      project: [{ id: 'dev', label: 'npm run dev', key: 'shift+meta+d' }]
    })
  })
})

describe('live updates through TabCommandsService', () => {
  it('an added, renamed or removed entry is in the next table without registering anything', () => {
    const store = { app: [] as unknown, projects: { [A]: [] } as Record<string, unknown> }
    let n = 0
    const service = new TabCommandsService({
      app: { get: () => store.app, set: (next) => (store.app = next) },
      project: { get: (p) => store.projects[p], set: (p, next) => (store.projects[p] = next) },
      mintId: () => `id${++n}`
    })
    const registry = new CommandRegistry(
      'darwin',
      () => ({}),
      (p) => ({ app: service.list(p, 'app'), project: store.projects[p] ? service.list(p, 'project') : [] })
    )
    service.set(A, 'project', [{ label: 'dev', command: 'npm run dev' }])
    expect(registry.view(A).commands.filter((c) => c.source === 'tabCommand').map((c) => [c.id, c.title])).toEqual([
      ['tab.newCommand.project.id1', 'New tab: dev']
    ])
    service.set(A, 'project', [{ id: 'id1', label: 'serve', command: 'npm run serve' }])
    expect(registry.view(A).commands.find((c) => c.id === 'tab.newCommand.project.id1')?.title).toBe('New tab: serve')
    service.set(A, 'project', [])
    expect(registry.view(A).commands.some((c) => c.source === 'tabCommand')).toBe(false)
  })
})

describe('renderer dispatch (tabCommandHandlers)', () => {
  afterEach(() => resetKeybindings())

  it('opens the entry by level and id when its chord is pressed, and offers it in the palette', () => {
    const { registry } = rig({ 'tab.newCommand.app.lg': 'Cmd+Shift+L' })
    const view = registry.view(A)
    setCommands(view)
    const created: Array<[string, string]> = []
    const off = registerHandlers(tabCommandHandlers(view, (level, entryId) => created.push([level, entryId])))
    const press = { key: 'L', code: 'KeyL', metaKey: true, shiftKey: true, ctrlKey: false, altKey: false }
    const id = commandForEvent(press)
    expect(id).toBe('tab.newCommand.app.lg')
    runCommand(id!)
    expect(created).toEqual([['app', 'lg']])
    expect(runnableCommands().map((c) => c.id)).toEqual(['tab.newCommand.app.lg', 'tab.newCommand.project.dev'])
    runCommand('tab.newCommand.project.dev')
    expect(created).toEqual([
      ['app', 'lg'],
      ['project', 'dev']
    ])
    off()
  })

  it('gives core and plugin commands no handler, and a removed entry none after the next table', () => {
    const { state, registry } = rig({ 'tab.newCommand.app.lg': 'Cmd+Shift+L' })
    const handlers = tabCommandHandlers(registry.view(A), () => {})
    expect(Object.keys(handlers)).toEqual(['tab.newCommand.app.lg', 'tab.newCommand.project.dev'])
    state.app = []
    const view = registry.view(A)
    setCommands(view)
    registerHandlers(tabCommandHandlers(view, () => {}))
    const press = { key: 'L', code: 'KeyL', metaKey: true, shiftKey: true, ctrlKey: false, altKey: false }
    expect(commandForEvent(press)).toBeUndefined()
    expect(runCommand('tab.newCommand.app.lg')).toBe(false)
  })
})
