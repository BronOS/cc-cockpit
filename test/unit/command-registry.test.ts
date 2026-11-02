import { afterEach, describe, expect, it } from 'vitest'
import { CommandRegistry, CORE_COMMANDS } from '../../src/main/commands/command-registry'
import {
  captureKeys,
  commandForEvent,
  chordKeys,
  displayChord,
  fuzzyFilter,
  pluginCommandHandlers,
  registerHandlers,
  resetKeybindings,
  runCommand,
  runnableCommands,
  setCommands
} from '../../src/renderer/commands/keybindings'

const find = (view: ReturnType<CommandRegistry['view']>, id: string) =>
  view.commands.find((c) => c.id === id)

describe('CommandRegistry', () => {
  it('lists the core commands with the default keys', () => {
    const view = new CommandRegistry('darwin', () => ({})).view('p1')
    expect(view.commands).toHaveLength(CORE_COMMANDS.length)
    expect(find(view, 'tab.newClaude')).toMatchObject({ key: 'meta+t', source: 'core' })
    expect(find(view, 'tab.newShell')?.key).toBe('shift+meta+t')
    expect(find(view, 'tab.select.9')?.key).toBe('meta+9')
    expect(find(view, 'overlay.pop')?.key).toBe('escape')
    expect(view.conflicts).toEqual([])
  })

  it('has no conflicting defaults', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(new CommandRegistry(platform, () => ({})).view('p').conflicts).toEqual([])
    }
  })

  it('maps Cmd to Ctrl on Linux', () => {
    const view = new CommandRegistry('linux', () => ({})).view('p1')
    expect(find(view, 'tab.close')?.key).toBe('ctrl+w')
  })

  it('applies overrides live and ignores an unknown command id', () => {
    let overrides: Record<string, string> = { 'tab.newClaude': 'Cmd+N', 'no.such': 'Cmd+Z' }
    const reg = new CommandRegistry('darwin', () => overrides)
    let view = reg.view('p1')
    expect(find(view, 'tab.newClaude')?.key).toBe('meta+n')
    expect(view.commands.some((c) => c.id === 'no.such')).toBe(false)
    overrides = {}
    view = reg.view('p1')
    expect(find(view, 'tab.newClaude')?.key).toBe('meta+t')
  })

  it('reports a conflict and leaves both commands unbound in the view', () => {
    const reg = new CommandRegistry('darwin', () => ({ 'tab.newShell': 'Cmd+W', 'tab.close': 'Cmd+W' }))
    const view = reg.view('p1')
    expect(view.conflicts).toEqual([{ chord: 'meta+w', commands: ['tab.newShell', 'tab.close'] }])
    expect(find(view, 'tab.close')?.key).toBeUndefined()
  })

  it('namespaces plugin commands per project', () => {
    const reg = new CommandRegistry('darwin', () => ({}))
    reg.registerPlugin('p1', 'jira', [{ id: 'refresh', title: 'Jira: Refresh', key: 'Cmd+Shift+J' }])
    const view = reg.view('p1')
    expect(find(view, 'jira/refresh')).toMatchObject({ source: 'plugin', key: 'shift+meta+j' })
    expect(reg.view('p2').commands.some((c) => c.id === 'jira/refresh')).toBe(false)

    reg.unregisterPlugin('p1', 'jira')
    expect(find(reg.view('p1'), 'jira/refresh')).toBeUndefined()
  })

  it('a plugin cannot shadow a core command id, and its key can conflict with a core one', () => {
    const reg = new CommandRegistry('darwin', () => ({}))
    reg.registerPlugin('p1', 'evil', [{ id: 'x', title: 'X', key: 'Cmd+T' }])
    const view = reg.view('p1')
    expect(view.conflicts[0]?.chord).toBe('meta+t')
    // The core default keeps the chord; the plugin's loses it.
    expect(find(view, 'tab.newClaude')?.key).toBe('meta+t')
    expect(find(view, 'evil/x')?.key).toBeUndefined()
    expect(view.commands.filter((c) => c.id === 'tab.newClaude')).toHaveLength(1)
  })

  it('adds and removes one plugin command at a time (ctx.commands.register)', () => {
    const reg = new CommandRegistry('darwin', () => ({}))
    reg.addPluginCommand('p1', 'jira', { id: 'refresh', title: 'Jira: Refresh', key: 'Cmd+Shift+J' })
    reg.addPluginCommand('p1', 'jira', { id: 'open', title: 'Jira: Open' })
    expect(find(reg.view('p1'), 'jira/refresh')).toMatchObject({ source: 'plugin', title: 'Jira: Refresh', key: 'shift+meta+j' })
    expect(find(reg.view('p1'), 'jira/open')).toMatchObject({ title: 'Jira: Open' })
    // Registering the same id again replaces it; another project does not see it.
    reg.addPluginCommand('p1', 'jira', { id: 'open', title: 'Jira: Open board' })
    expect(find(reg.view('p1'), 'jira/open')?.title).toBe('Jira: Open board')
    expect(find(reg.view('p2'), 'jira/open')).toBeUndefined()
    reg.removePluginCommand('p1', 'jira', 'refresh')
    reg.removePluginCommand('p1', 'jira', 'never-added')
    reg.removePluginCommand('p9', 'jira', 'open')
    expect(find(reg.view('p1'), 'jira/refresh')).toBeUndefined()
    expect(find(reg.view('p1'), 'jira/open')).toBeDefined()
    reg.removePluginCommand('p1', 'jira', 'open')
    expect(reg.view('p1').commands.some((c) => c.source === 'plugin')).toBe(false)
  })

  it('forgets a closed project', () => {
    const reg = new CommandRegistry('darwin', () => ({}))
    reg.registerPlugin('p1', 'a', [{ id: 'b', title: 'B' }])
    reg.closeProject('p1')
    expect(find(reg.view('p1'), 'a/b')).toBeUndefined()
  })
})

describe('renderer key table', () => {
  afterEach(() => resetKeybindings())
  const key = (k: string, mods: { meta?: boolean; shift?: boolean } = {}) => ({
    key: k,
    ctrlKey: false,
    altKey: false,
    shiftKey: mods.shift ?? false,
    metaKey: mods.meta ?? false
  })

  it('fires only commands that have a handler here', () => {
    setCommands(new CommandRegistry('darwin', () => ({})).view('p1'))
    // Escape is bound to "pop overlay" but no handler is registered: the key stays the terminal's.
    expect(commandForEvent(key('Escape'))).toBeUndefined()
    expect(commandForEvent(key('t', { meta: true }))).toBeUndefined()

    let ran = 0
    const off = registerHandlers({ 'tab.newClaude': () => ran++ })
    const id = commandForEvent(key('t', { meta: true }))
    expect(id).toBe('tab.newClaude')
    expect(runCommand(id!)).toBe(true)
    expect(ran).toBe(1)
    // Unbound keys pass through.
    expect(commandForEvent(key('t'))).toBeUndefined()
    off()
    expect(commandForEvent(key('t', { meta: true }))).toBeUndefined()
    expect(runCommand('tab.newClaude')).toBe(false)
  })

  it('fires nothing while a key capture is active (the keybinding editor records the chord)', () => {
    setCommands(new CommandRegistry('darwin', () => ({})).view('p1'))
    registerHandlers({ 'tab.newClaude': () => {} })
    expect(commandForEvent(key('t', { meta: true }))).toBe('tab.newClaude')
    const release = captureKeys()
    const releaseOther = captureKeys()
    expect(commandForEvent(key('t', { meta: true }))).toBeUndefined()
    // Releasing one capture twice does not release the other.
    release()
    release()
    expect(commandForEvent(key('t', { meta: true }))).toBeUndefined()
    releaseOther()
    expect(commandForEvent(key('t', { meta: true }))).toBe('tab.newClaude')
  })

  it('gives a command back to the earlier handler when the later one is removed', () => {
    // The settings screen holds overlay.closeTop; a cli login overlay over it claims it too and
    // goes away first: the chord must close the settings screen again, not be left unclaimed.
    const ran: string[] = []
    const offSettings = registerHandlers({ 'overlay.closeTop': () => ran.push('settings') })
    const offOverlay = registerHandlers({ 'overlay.closeTop': () => ran.push('overlay') })
    runCommand('overlay.closeTop')
    offOverlay()
    runCommand('overlay.closeTop')
    expect(ran).toEqual(['overlay', 'settings'])
    // Removing twice is harmless and leaves the other registration alone.
    offOverlay()
    expect(runCommand('overlay.closeTop')).toBe(true)
    offSettings()
    expect(runCommand('overlay.closeTop')).toBe(false)
  })

  it('offers the palette only the runnable commands', () => {
    setCommands(new CommandRegistry('darwin', () => ({})).view('p1'))
    registerHandlers({ 'tab.newShell': () => {}, 'unknown.id': () => {} })
    expect(runnableCommands().map((c) => c.id)).toEqual(['tab.newShell'])
  })

  it('a single user override wins the chord it shares with a default', () => {
    setCommands(
      new CommandRegistry('darwin', () => ({ 'tab.newShell': 'Cmd+T' })).view('p1')
    )
    registerHandlers({ 'tab.newShell': () => {}, 'tab.newClaude': () => {} })
    // A single user override beats the default, so it wins the chord.
    expect(commandForEvent(key('t', { meta: true }))).toBe('tab.newShell')
  })
})

describe('pluginCommandHandlers', () => {
  afterEach(() => resetKeybindings())

  it('gives every plugin command a handler that asks main to run it, and core commands none', () => {
    const view = {
      commands: [
        { id: 'tab.close', title: 'Close tab', key: 'meta+w', source: 'core' as const },
        { id: 'acme.jira/refresh', title: 'Jira: Refresh', key: 'shift+meta+j', source: 'plugin' as const },
        { id: 'acme.jira/open', title: 'Jira: Open', source: 'plugin' as const }
      ],
      conflicts: []
    }
    const ran: string[] = []
    const handlers = pluginCommandHandlers(view, (id) => ran.push(id))
    expect(Object.keys(handlers)).toEqual(['acme.jira/refresh', 'acme.jira/open'])

    // Registered like local handlers: the plugin's chord now fires it and the palette offers it.
    setCommands(view)
    const off = registerHandlers(handlers)
    expect(commandForEvent({ key: 'j', code: 'KeyJ', metaKey: true, shiftKey: true, ctrlKey: false, altKey: false })).toBe(
      'acme.jira/refresh'
    )
    expect(runnableCommands().map((c) => c.id)).toEqual(['acme.jira/refresh', 'acme.jira/open'])
    expect(runCommand('acme.jira/open')).toBe(true)
    expect(ran).toEqual(['acme.jira/open'])
    off()
    expect(runnableCommands()).toEqual([])
  })
})

describe('fuzzyFilter', () => {
  const items = [
    { title: 'New Claude Tab' },
    { title: 'New Shell Tab' },
    { title: 'Close Tab' },
    { title: 'Command Palette' }
  ]
  it('keeps everything for an empty query', () => {
    expect(fuzzyFilter(items, '  ')).toHaveLength(4)
  })
  it('matches characters in order and ranks contiguous matches first', () => {
    expect(fuzzyFilter(items, 'claude').map((i) => i.title)).toEqual(['New Claude Tab'])
    expect(fuzzyFilter(items, 'nct').map((i) => i.title)).toContain('New Claude Tab')
    expect(fuzzyFilter(items, 'tab')[0]?.title).toBe('Close Tab')
    expect(fuzzyFilter(items, 'zzz')).toEqual([])
  })
})

describe('chordKeys', () => {
  it('names each key of a chord on its own, for one keycap per key', () => {
    expect(chordKeys('shift+meta+t', true)).toEqual(['⇧', '⌘', 'T'])
    expect(chordKeys('ctrl+shift+t', false)).toEqual(['Ctrl', 'Shift', 'T'])
    expect(chordKeys('meta++', true)).toEqual(['⌘', '+'])
    // A chord it cannot take apart stays one cap, as displayChord shows it.
    expect(chordKeys('meta+', true)).toEqual(['meta+'])
  })
})

describe('displayChord', () => {
  it('writes mac glyphs and Linux names', () => {
    expect(displayChord('shift+meta+p', true)).toBe('⇧⌘P')
    expect(displayChord('ctrl+t', false)).toBe('Ctrl+T')
    expect(displayChord('escape', true)).toBe('Escape')
  })

  it('shows the plus key, and never throws on a chord with empty parts (it used to crash the settings screen and the palette)', () => {
    expect(displayChord('meta++', true)).toBe('⌘+')
    expect(displayChord('meta++', false)).toBe('Meta++')
    expect(displayChord('ctrl+shift++', false)).toBe('Ctrl+Shift++')
    expect(displayChord('+', true)).toBe('+')
    for (const odd of ['meta+', '++', '', 'meta+++', 'meta++p']) {
      expect(() => displayChord(odd, true), odd).not.toThrow()
      expect(() => displayChord(odd, false), odd).not.toThrow()
    }
  })
})
