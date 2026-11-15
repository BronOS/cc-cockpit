// Commands main knows about: the core ones (the default keybinding table), per project those a
// plugin declared, and one per entry of the user's new-tab menu (app-wide in every project, a
// project's own only in that project). A command here is data (id, title, default chord); what
// running it does lives where the state is: tab commands run in the renderer through the tab IPC
// (scoped by the router), plugin commands are added when the plugin's host registers them
// (Task 26) and run in that host. Main resolves the keys so the renderer, the palette and the
// settings screen all see one table.
import type { CommandInfo, CommandSource, CommandsView, KeyBindingRow } from '../../shared/ipc'
import { chordWith, normalizeChord, resolveKeys, splitChord, type KeyPlatform, type ResolvedKeys } from '../../shared/keys'
import { IN_GROUP_CORE_BASES, inGroupCommandId, tabCommandId, tabCommandTitle } from '../../shared/tab-commands'
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

/** A command for the palette and Settings › Keys only: the person may bind it, nothing is taken for it. */
const unbound = (id: string, title: string): CommandDef => ({ id, title, source: 'core' })

const ARROWS = [
  ['Left', 'left'],
  ['Right', 'right'],
  ['Up', 'up'],
  ['Down', 'down']
] as const

/**
 * The split view's commands (team run 001, decision D10; renderer/tabs/pane-commands.ts runs them).
 * Every chord carries Cmd (Ctrl on Linux) with Shift or Alt: a terminal program never gets Ctrl and
 * Alt together on an arrow from a shell's own bindings (readline and vim use one or the other), and
 * Ctrl+Shift+letter reaches no terminal program as anything but Ctrl+letter. Ctrl+Alt+Arrow is free
 * on Omarchy's Hyprland (its workspace and window keys all carry Super); older GNOME and KDE bind it
 * to workspaces, which the person can rebind here. A browser on a Mac keeps ⌥⌘←/→ (Chrome's tab
 * switch): web-keys.ts moves those there.
 */
const PANE_COMMANDS: readonly CommandDef[] = [
  core('pane.splitRight', 'Split Right', 'Cmd+Shift+D'),
  core('pane.splitDown', 'Split Down', 'Cmd+Alt+Shift+D'),
  core('pane.moveOut', 'Move Pane Out of Group', 'Cmd+Shift+X'),
  core('pane.zoom', 'Zoom Pane', 'Cmd+Shift+Enter'),
  ...ARROWS.map(([name, key]) => core(`pane.focus${name}`, `Focus Pane ${name === 'Up' ? 'Above' : name === 'Down' ? 'Below' : name}`, `Cmd+Alt+${key}`)),
  ...ARROWS.map(([name, key]) => core(`pane.resize${name}`, `Resize Pane ${name}`, `Cmd+Alt+Shift+${key}`)),
  ...ARROWS.map(([name]) => unbound(`pane.move${name}`, `Move Pane ${name}`)),
  unbound('pane.showBesideRight', 'Show Tab Beside (Right)…'),
  unbound('pane.showBesideDown', 'Show Tab Beside (Below)…'),
  unbound('pane.equalize', 'Equalize Panes'),
  unbound('pane.ungroup', 'Ungroup Panes')
]

const tabSelect: CommandDef[] =Array.from({ length: 9 }, (_, i) => core(`tab.select.${i + 1}`, `Select Tab ${i + 1}`, `Cmd+${i + 1}`))

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
  core('overlay.closeTop', 'Close Top Overlay', 'Cmd+Shift+W'),
  ...PANE_COMMANDS
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

/**
 * The "… in Group" commands (design-split-pages.md §4 "New tab in Group"): one per core new-tab
 * command and per menu entry that opens a tab (an overlay is never a pane, so an overlay entry gets
 * none). No `key` here: the default is derived at resolve time from the base's resolved chord
 * (CommandRegistry.resolve), so a rebound base moves it.
 */
export function inGroupDefs(entries: TabCommandEntries): Array<CommandDef & { base: string }> {
  const titles: Record<(typeof IN_GROUP_CORE_BASES)[number], string> = {
    'tab.newClaude': 'New Claude Tab in Group',
    'tab.newShell': 'New Shell Tab in Group'
  }
  const out: Array<CommandDef & { base: string }> = IN_GROUP_CORE_BASES.map((base) => ({
    id: inGroupCommandId(base),
    title: titles[base],
    source: 'core' as const,
    base
  }))
  for (const level of ['app', 'project'] as const) {
    for (const e of entries[level]) {
      if (e.open === 'overlay') continue
      const base = tabCommandId(level, e.id)
      out.push({ id: inGroupCommandId(base), title: `${tabCommandTitle(e.label, e.open)} in Group`, source: 'tabCommand', base })
    }
  }
  return out
}

export interface PluginCommandDef {
  /** The id the manifest declares; registered as `<pluginId>/<id>`. */
  id: string
  title: string
  key?: string
}

/**
 * The keys page tabs of one type declare (manifest `contributes.tabs` `keys`), for the keybinding
 * editor's conflicts (design-editor.md §1 "Keyboard"). `label` names them ("Editor file tabs").
 */
export interface PageTabKeys {
  label: string
  keys: readonly string[]
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
    private readonly tabCommands: (projectId: string) => TabCommandEntries = () => ({ app: [], project: [] }),
    /**
     * The page tab keys of a project's plugins, read at every `bindings` like the rest. Never part of
     * the table: the app's command wins a chord both hold, and a page's own keys reach it only while
     * it has focus; this only shows the clash. Must not throw (asked for '' too).
     */
    private readonly pageTabKeys: (projectId: string) => readonly PageTabKeys[] = () => []
  ) {}

  /**
   * Everything this project's table holds (core, the menu entries, their "in Group" commands, the
   * plugins' commands), with the "in Group" defaults filled in, and the table resolved.
   *
   * `resolveKeys` runs twice (design-split-pages.md §4). Pass 1 resolves every other command with
   * the overrides. Each derived default is then its base's resolved chord plus Alt, and none when
   * the base has no chord, does not fire it (an unresolved conflict), already carries Alt, or when
   * any command claims that chord in pass 1: a derived command never takes a chord from another one
   * (two bases never hold one chord, so two derived defaults never meet either). Pass 2 resolves it
   * all, so the person's override of a derived command wins like any override.
   */
  private resolve(projectId: string, overrides: Readonly<Record<string, string>>): { defs: CommandDef[]; resolved: ResolvedKeys } {
    const entries = this.tabCommands(projectId)
    const head = [...CORE_COMMANDS, ...tabCommandDefs(entries)]
    const plugins = [...(this.plugin.get(projectId)?.values() ?? [])]
    const first = resolveKeys(keyed([...head, ...plugins]), overrides, this.platform)
    const claimed = new Set(first.keys.values())
    const derived = inGroupDefs(entries).map(({ base, ...d }): CommandDef => {
      const chord = first.keys.get(base)
      if (chord === undefined || first.bindings.get(chord) !== base) return d
      if (splitChord(chord)?.mods.includes('alt') !== false) return d
      const key = chordWith(chord, 'alt')
      return claimed.has(key) ? d : { ...d, key }
    })
    const defs = [...head, ...derived, ...plugins]
    return { defs, resolved: resolveKeys(keyed(defs), overrides, this.platform) }
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
    const { defs, resolved } = this.resolve(projectId, this.overrides())
    const commands: CommandInfo[] = defs.map((d) => {
      const key = resolved.keys.get(d.id)
      const bound = key !== undefined && resolved.bindings.get(key) === d.id
      return { id: d.id, title: d.title, ...(bound ? { key } : {}), source: d.source }
    })
    return { commands, conflicts: resolved.conflicts }
  }

  /** Is `id` a command of this project (core, a menu entry it lists or its "in Group" command, or a plugin command it has registered)? */
  has(projectId: string, id: string): boolean {
    if (CORE_COMMANDS.some((c) => c.id === id) || this.plugin.get(projectId)?.has(id) === true) return true
    const entries = this.tabCommands(projectId)
    return tabCommandDefs(entries).some((c) => c.id === id) || inGroupDefs(entries).some((c) => c.id === id)
  }

  /**
   * One row per command for the keybinding list of the settings screen: the default chord, the
   * user's override, the chord claimed now (even inside a conflict, which `view` leaves off) and
   * who it clashes with. `inactive` marks a claimant that does not get the chord. `overrides`
   * replaces the stored ones, so the settings screen can judge a change before it stores it.
   */
  bindings(projectId: string, overrides: Readonly<Record<string, string>> = this.overrides()): KeyBindingRow[] {
    const { defs, resolved } = this.resolve(projectId, overrides)
    const titles = new Map(defs.map((d) => [d.id, d.title]))
    // chord -> the page tab kinds that declare it (written for macOS like every manifest chord).
    const pageKeys = new Map<string, string[]>()
    for (const p of this.pageTabKeys(projectId)) {
      for (const raw of p.keys) {
        const chord = normalizeChord(raw, this.platform)
        if (chord === null) continue
        const list = pageKeys.get(chord) ?? []
        if (!list.includes(p.label)) list.push(p.label)
        pageKeys.set(chord, list)
      }
    }
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
      const pages = key === undefined ? undefined : pageKeys.get(key)
      if (pages) row.pageKeys = [...pages]
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
