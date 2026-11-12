// chordToAccelerator: canonical chords as Electron accelerators; AppMenu: the Open Folder
// accelerator follows the focused window's key table. menu.ts imports electron for installMenu
// only; the module is stubbed and AppMenu gets a fake install, so both load under Node.
import { describe, expect, it, vi } from 'vitest'
import { CommandRegistry } from '../../src/main/commands/command-registry'
import { AppMenu, chordToAccelerator, focusedProjectIdOf, openFolderKey, type MenuActions } from '../../src/main/menu'

vi.mock('electron', () => ({ app: {}, Menu: {} }))

describe('chordToAccelerator', () => {
  it('writes modifiers and the key the way Electron names them', () => {
    expect(chordToAccelerator('shift+meta+o')).toBe('Shift+Meta+O')
    expect(chordToAccelerator('ctrl+left')).toBe('Ctrl+Left')
    expect(chordToAccelerator(undefined)).toBeUndefined()
  })

  it("names the plus key Plus (a literal '+' is a separator to Electron) and refuses empty parts", () => {
    expect(chordToAccelerator('meta++')).toBe('Meta+Plus')
    expect(chordToAccelerator('ctrl+shift++')).toBe('Ctrl+Shift+Plus')
    expect(chordToAccelerator('meta+')).toBeUndefined()
    expect(chordToAccelerator('++')).toBeUndefined()
  })
})

describe('AppMenu', () => {
  function setup(): {
    menu: AppMenu
    installed: MenuActions[]
    overrides: Record<string, string>
    commands: CommandRegistry
    focus: { projectId: string; window: unknown }
    pickers: { count: number }
  } {
    const overrides: Record<string, string> = {}
    const commands = new CommandRegistry('darwin', () => overrides)
    const installed: MenuActions[] = []
    const focus = { projectId: '', window: undefined as unknown }
    const pickers = { count: 0 }
    const menu = new AppMenu({
      // The fake mirrors index.ts: a window that is leaving counts as unfocused.
      focusedProjectId: (leaving) => (leaving !== undefined && leaving === focus.window ? '' : focus.projectId),
      view: (projectId) => commands.view(projectId),
      openFolder: () => {},
      openProject: () => {
        pickers.count++
      },
      install: (actions) => installed.push(actions)
    })
    return { menu, installed, overrides, commands, focus, pickers }
  }
  const last = (installed: MenuActions[]): string | undefined => installed.at(-1)?.openFolderAccelerator

  it("drops the accelerator in a project where an override gave Cmd+O to a plugin command", () => {
    const { menu, installed, overrides, commands, focus } = setup()
    commands.registerPlugin('p1', 'acme', [{ id: 'go', title: 'Acme: Go' }])
    menu.refresh()
    expect(last(installed)).toBe('Meta+O')
    // The bug: the accelerator came from the core table only, so Cmd+O kept opening the dialog in
    // p1 although the settings screen showed the plugin command as the chord's owner.
    overrides['acme/go'] = 'Cmd+O'
    focus.projectId = 'p1'
    focus.window = 'w1'
    menu.refresh()
    expect(last(installed)).toBeUndefined()
    expect(installed).toHaveLength(2)
    // Another window (the picker, or a project without that plugin) keeps Cmd+O for the menu.
    focus.projectId = ''
    menu.refresh()
    expect(last(installed)).toBe('Meta+O')
  })

  it('falls back to the core table when the focused window blurs', () => {
    const { menu, installed, overrides, commands, focus } = setup()
    commands.registerPlugin('p1', 'acme', [{ id: 'go', title: 'Acme: Go' }])
    overrides['acme/go'] = 'Cmd+O'
    focus.projectId = 'p1'
    focus.window = 'w1'
    menu.refresh()
    expect(last(installed)).toBeUndefined()
    // Electron may still report the blurred window as focused; the leaving window does not count.
    menu.refresh('w1')
    expect(last(installed)).toBe('Meta+O')
  })

  it('follows a plugin command coming and going, and installs only when the chord changes', () => {
    const { menu, installed, overrides, commands, focus } = setup()
    focus.projectId = 'p1'
    overrides['acme/go'] = 'Cmd+O'
    menu.refresh()
    expect(last(installed)).toBe('Meta+O')
    menu.refresh()
    expect(installed).toHaveLength(1)
    commands.addPluginCommand('p1', 'acme', { id: 'go', title: 'Acme: Go' })
    menu.refresh()
    expect(last(installed)).toBeUndefined()
    commands.unregisterPlugin('p1', 'acme')
    menu.refresh()
    expect(last(installed)).toBe('Meta+O')
    expect(installed).toHaveLength(3)
  })

  it('File > Open Project shows the picker, with no accelerator of its own', () => {
    const { menu, installed, pickers } = setup()
    menu.refresh()
    const actions = installed.at(-1)!
    actions.openProject()
    expect(pickers.count).toBe(1)
    // Only Open Folder carries a chord; nothing in the actions names one for Open Project.
    expect(Object.keys(actions).sort()).toEqual(['openFolder', 'openFolderAccelerator', 'openProject'])
  })

  it("the picker's Open Folder hint is the chord the menu installs, and none when unbound", () => {
    const { overrides, commands } = setup()
    expect(openFolderKey(commands.view(''))).toBe('meta+o')
    overrides['app.openFolder'] = 'Cmd+Shift+O'
    expect(openFolderKey(commands.view(''))).toBe('shift+meta+o')
    overrides['app.openFolder'] = ''
    expect(openFolderKey(commands.view(''))).toBeUndefined()
  })

  it('keeps a rebound Open Folder chord, and none when it is unbound', () => {
    const { menu, installed, overrides } = setup()
    overrides['app.openFolder'] = 'Cmd+Shift+O'
    menu.refresh()
    expect(last(installed)).toBe('Shift+Meta+O')
    overrides['app.openFolder'] = ''
    menu.refresh()
    expect(last(installed)).toBeUndefined()
  })
})

describe('focusedProjectIdOf', () => {
  const senders = new Map<number, { kind: 'picker' } | { kind: 'project'; projectId: string }>([
    [11, { kind: 'project', projectId: 'p1' }],
    [13, { kind: 'picker' }]
  ])
  const resolve = (id: number) => senders.get(id)
  const win = (id: number, destroyed = false) => ({ isDestroyed: () => destroyed, webContents: { id } })

  it("gives a project window its project, and the picker and no window the core table ''", () => {
    expect(focusedProjectIdOf(win(11), undefined, resolve)).toBe('p1')
    expect(focusedProjectIdOf(win(13), undefined, resolve)).toBe('')
    expect(focusedProjectIdOf(null, undefined, resolve)).toBe('')
  })

  it("resolves a focused remote desktop window to '' (main never registers it as a sender)", () => {
    // design-remote-desktop.md §4: the server's page in it keeps the desktop key table itself; the
    // menu gives it the core table, with no case of its own.
    expect(focusedProjectIdOf(win(4242), undefined, resolve)).toBe('')
  })

  it("treats the window that is leaving, and a destroyed one, as unfocused", () => {
    const w = win(11)
    expect(focusedProjectIdOf(w, w, resolve)).toBe('')
    expect(focusedProjectIdOf(win(11, true), undefined, resolve)).toBe('')
  })
})
