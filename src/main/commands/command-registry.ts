// Commands main knows about: the core ones (the default keybinding table), per project those a
// plugin declared, and one per entry of the user's new-tab menu (app-wide in every project, a
// project's own only in that project). A command here is data (id, title, default chord); what
// running it does lives where the state is: tab commands run in the renderer through the tab IPC
// (scoped by the router), plugin commands are added when the plugin's host registers them
// (Task 26) and run in that host. Main resolves the keys so the renderer, the palette and the
// settings screen all see one table.
import type { CommandInfo, CommandSource, CommandsView, KeyBindingRow } from '../../shared/ipc'
import { normalizeChord, resolveKeys, type KeyPlatform } from '../../shared/keys'
import { tabCommandId, tabCommandTitle } from '../../shared/tab-commands'
import { TOGGLE_FLAG_COMMAND } from '../../shared/tab-flag'
import type { TabCommandEntry } from '../../shared/types'

interface CommandDef {
  id: string
  title: string
  /** Default chord as written for macOS; `Cmd` is Ctrl elsewhere. */
  key?: string
  source: CommandSource
}

/** A project's new-tab menu entries, valid ones only (tabCommandsOf applied). */
export interface TabCommandEntries {
  app: readonly TabCommandEntry[]
  project: readonly TabCommandEntry[]
}

const core = (id: string, title: string, key: string): CommandDef => ({ id, title, key, source: 'core' })

const tabSelect: CommandDef[] = Array.from({ length: 9 }, (_, i) => core(`tab.select.${i + 1}`, `Select Tab ${i + 1}`, `Cmd+${i + 1}`))

/** The default keybinding table (plan Technical Details). */
export const CORE_COMMANDS: readonly CommandDef[] = [
  core('tab.newClaude', 'New Claude Tab', 'Cmd+T'),
  core('tab.newShell', 'New Shell Tab', 'Cmd+Shift+T'),
  core('tab.close', 'Close Tab', 'Cmd+W'),
  // Flag or unflag the current tab with the last-used colour (shared/tab-flag.ts). Cmd+Shift+F:
  // free in this table and in every bundled plugin's; on macOS no system chord, on Linux
  // Ctrl+Shift+F reaches no terminal program as anything but Ctrl+F (a terminal cannot send Shift
  // with Ctrl+letter), and Ctrl+F, which readline and Claude Code use, stays theirs.
  core(TOGGLE_FLAG_COMMAND, 'Toggle Tab Flag', 'Cmd+Shift+F'),
  ...tabSelect,
  // Ctrl, not Cmd, on every platform: Cmd+Tab is macOS's app switcher. Held, it walks the tabs in
  // recent order with an overlay; released, it picks (tabs/tab-switcher.ts).
  core('tab.switchNext', 'Switch to Recent Tab', 'Ctrl+Tab'),
  core('tab.switchPrev', 'Switch to Recent Tab (Backward)', 'Ctrl+Shift+Tab'),
  core('zone.toggleLeft', 'Toggle Left Zone', 'Cmd+B'),
  core('zone.toggleBottom', 'Toggle Bottom Zone', 'Cmd+J'),
  core('zone.toggleRight', 'Toggle Right Zone', 'Cmd+Shift+B'),
  core('app.openSettings', 'Open Settings', 'Cmd+,'),
  core('palette.open', 'Command Palette', 'Cmd+Shift+P'),
  core('app.openFolder', 'Open Folder…', 'Cmd+O'),
  core('overlay.pop', 'Pop Top Overlay', 'Escape'),
  core('overlay.closeTop', 'Close Top Overlay', 'Cmd+Shift+W')
]

/**
 * One command per new-tab menu entry, app-wide first, then the project's (the menu's order). No
 * default chord, ever: an entry is the user's own, and any chord picked for it here could take one
 * Claude, the shell or a plugin relies on; the user binds it in Settings like any command.
 */
export function tabCommandDefs(entries: TabCommandEntries): CommandDef[] {
  const defs = (level: 'app' | 'project', list: readonly TabCommandEntry[]): CommandDef[] =>
    list.map((e) => ({ id: tabCommandId(level, e.id), title: tabCommandTitle(e.label, e.open), source: 'tabCommand' }))
  return [...defs('app', entries.app), ...defs('project', entries.project)]
}

export interface PluginCommandDef {
  /** The id the manifest declares; registered as `<pluginId>/<id>`. */
  id: string
  title: string
  key?: string
}

export class CommandRegistry {
  /** projectId -> full command id -> definition. */
  private readonly plugin = new Map<string, Map<string, CommandDef>>()

  constructor(
    private readonly platform: KeyPlatform,
    /** The user's overrides (`app.json` keyOverrides), read at every `view` so edits apply live. */
    private readonly overrides: () => Readonly<Record<string, string>>,
    /**
     * A project's new-tab menu entries, read at every `view`, `bindings` and `has` like the
     * overrides: an entry added, renamed or removed in Settings is in (or out of) the next table
     * with nothing to register. Must not throw: it is also asked for '' (the picker, no focused
     * window), and for a project whose record is gone; give the app-wide entries and no project ones.
     */
    private readonly tabCommands: (projectId: string) => TabCommandEntries = () => ({ app: [], project: [] })
  ) {}

  /** Everything this project's table holds: core, the menu entries, the plugins' commands. */
  private defs(projectId: string): CommandDef[] {
    return [...CORE_COMMANDS, ...tabCommandDefs(this.tabCommands(projectId)), ...(this.plugin.get(projectId)?.values() ?? [])]
  }

  /**
   * Add a plugin's commands to a project. The id is namespaced here, so a plugin cannot shadow a
   * core command or another plugin's; registering again replaces what the plugin had.
   */
  registerPlugin(projectId: string, pluginId: string, commands: readonly PluginCommandDef[]): void {
    this.unregisterPlugin(projectId, pluginId)
    const map = this.plugin.get(projectId) ?? new Map<string, CommandDef>()
    for (const c of commands) {
      const id = `${pluginId}/${c.id}`
      map.set(id, pluginDef(id, c))
    }
    this.plugin.set(projectId, map)
  }

  /**
   * Add one command of a plugin (the plugin's `ctx.commands.register`); the caller has checked it
   * is declared in the manifest. Same namespacing as `registerPlugin`; registering it again
   * replaces the earlier entry.
   */
  addPluginCommand(projectId: string, pluginId: string, c: PluginCommandDef): void {
    const map = this.plugin.get(projectId) ?? new Map<string, CommandDef>()
    const id = `${pluginId}/${c.id}`
    map.set(id, pluginDef(id, c))
    this.plugin.set(projectId, map)
  }

  removePluginCommand(projectId: string, pluginId: string, id: string): void {
    const map = this.plugin.get(projectId)
    if (!map) return
    map.delete(`${pluginId}/${id}`)
    if (map.size === 0) this.plugin.delete(projectId)
  }

  unregisterPlugin(projectId: string, pluginId: string): void {
    const map = this.plugin.get(projectId)
    if (!map) return
    for (const id of [...map.keys()]) if (id.startsWith(`${pluginId}/`)) map.delete(id)
    if (map.size === 0) this.plugin.delete(projectId)
  }

  /** Forget a closed project's plugin commands. */
  closeProject(projectId: string): void {
    this.plugin.delete(projectId)
  }

  /**
   * The commands of a project with their resolved chords. `key` is set only for a chord that
   * fires this command; a chord in an unresolved conflict is left off and listed in `conflicts`.
   */
  view(projectId: string): CommandsView {
    const defs = this.defs(projectId)
    const resolved = resolveKeys(keyed(defs), this.overrides(), this.platform)
    const commands: CommandInfo[] = defs.map((d) => {
      const key = resolved.keys.get(d.id)
      const bound = key !== undefined && resolved.bindings.get(key) === d.id
      return { id: d.id, title: d.title, ...(bound ? { key } : {}), source: d.source }
    })
    return { commands, conflicts: resolved.conflicts }
  }

  /** Is `id` a command of this project (core, a menu entry it lists, or a plugin command it has registered)? */
  has(projectId: string, id: string): boolean {
    return (
      CORE_COMMANDS.some((c) => c.id === id) ||
      this.plugin.get(projectId)?.has(id) === true ||
      tabCommandDefs(this.tabCommands(projectId)).some((c) => c.id === id)
    )
  }

  /**
   * One row per command for the keybinding list of the settings screen: the default chord, the
   * user's override, the chord claimed now (even inside a conflict, which `view` leaves off) and
   * who it clashes with. `inactive` marks a claimant that does not get the chord. `overrides`
   * replaces the stored ones, so the settings screen can judge a change before it stores it.
   */
  bindings(projectId: string, overrides: Readonly<Record<string, string>> = this.overrides()): KeyBindingRow[] {
    const defs = this.defs(projectId)
    const resolved = resolveKeys(keyed(defs), overrides, this.platform)
    const titles = new Map(defs.map((d) => [d.id, d.title]))
    return defs.map((d) => {
      const key = resolved.keys.get(d.id)
      const defaultKey = d.key === undefined ? undefined : normalizeChord(d.key, this.platform)
      const clash = key === undefined ? undefined : resolved.conflicts.find((c) => c.chord === key)
      const row: KeyBindingRow = {
        id: d.id,
        title: d.title,
        source: d.source,
        // Own property only: the object is user-writable JSON and ids like `constructor` exist.
        overridden: Object.hasOwn(overrides, d.id),
        conflictsWith: (clash?.commands ?? []).filter((id) => id !== d.id).map((id) => titles.get(id) ?? id),
        inactive: key !== undefined && resolved.bindings.get(key) !== d.id
      }
      if (defaultKey) row.defaultKey = defaultKey
      if (key !== undefined) row.key = key
      return row
    })
  }
}

function pluginDef(id: string, c: PluginCommandDef): CommandDef {
  return c.key === undefined ? { id, title: c.title, source: 'plugin' } : { id, title: c.title, key: c.key, source: 'plugin' }
}

/**
 * The commands as resolveKeys takes them. Only a plugin's default ranks below a core default when
 * a default chord collides; a menu entry has no default, so its rank never comes into play (its
 * chord is always the user's override, which outranks both).
 */
function keyed(defs: readonly CommandDef[]): Array<CommandDef & { core: boolean }> {
  return defs.map((d) => ({ ...d, core: d.source !== 'plugin' }))
}
