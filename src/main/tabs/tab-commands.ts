// The user's own entries of the new-tab menu (design §3 Tabs, "Custom commands"): a label and a
// shell command line, app-wide (`app.json` › `tabCommands`) and per project (the project record's
// `tabCommands`). The menu shows Claude, Shell, the app-wide entries, then the project's. An entry
// opens a tab, or (`open: 'overlay'`) a terminal overlay over the tabs.
//
// Authority (CLAUDE.md: main is the only authority):
//  - The renderer names an entry by level and id (`tabs.create` with kind 'command'); main looks
//    the command up here, in its own settings, and so also decides tab or overlay (the renderer's
//    menu only shows a hint). Command text from a renderer or a plugin is never run: the router
//    does not even read such a field, and plugins have no way to name an entry.
//  - Ids are minted here. A saved list may keep an id only if that level already has it, so the
//    page cannot plant ids of its choosing (or one entry under two names).
//  - Both files are user-writable: reading drops whatever is not a valid entry (and anything past
//    the cap) instead of failing, while saving refuses an invalid list as a whole and says why.
//
// No Electron import; index.ts wires the stores in, vitest drives it.
import { randomUUID } from 'node:crypto'
import type { TabCommandMenu } from '../../shared/ipc'
import {
  checkTabCommandLabel,
  checkTabCommandLine,
  checkTabCommandOpen,
  TAB_COMMAND_ENTRY_ID as ENTRY_ID,
  TAB_COMMANDS_MAX,
  tabCommandId
} from '../../shared/tab-commands'
import type { TabCommandEntry, TabCommandLevel, TabCommandOpen } from '../../shared/types'
import { isPlainObject } from '../../shared/guards'

/**
 * The stored entries of one level, as far as they are valid: bad entries dropped (not an object,
 * a bad id, label or command), a repeated id kept only the first time, at most TAB_COMMANDS_MAX.
 * Never throws: a damaged file costs the entries that are damaged, not the menu.
 */
export function tabCommandsOf(stored: unknown): TabCommandEntry[] {
  if (!Array.isArray(stored)) return []
  const out: TabCommandEntry[] = []
  const seen = new Set<string>()
  for (const raw of stored as unknown[]) {
    if (out.length >= TAB_COMMANDS_MAX) break
    if (!isPlainObject(raw)) continue
    const { id } = raw
    if (typeof id !== 'string' || !ENTRY_ID.test(id) || seen.has(id)) continue
    const label = checkTabCommandLabel(raw.label)
    const command = checkTabCommandLine(raw.command)
    if (!label.ok || !command.ok) continue
    seen.add(id)
    out.push(entryOf(id, label.value, command.value, raw.open))
  }
  return out
}

/**
 * An entry as stored and handed out: `open` only when it is an overlay, so a tab entry keeps the
 * `{ id, label, command }` shape files had before the field (a save does not add `open: 'tab'` to
 * every entry of the user's `app.json`), and a damaged `open` is dropped (a tab).
 */
function entryOf(id: string, label: string, command: string, open: unknown): TabCommandEntry {
  return checkTabCommandOpen(open) === 'overlay' ? { id, label, command, open: 'overlay' } : { id, label, command }
}

/**
 * A whole list the settings page wants saved for one level, checked: each entry needs a valid
 * label and command; its `id` is kept when `current` (the level's stored entries) has it and no
 * earlier entry of the list took it, else a new one is minted (a new entry has none). Throws,
 * naming the entry, for anything invalid; nothing is stored then.
 */
export function checkTabCommands(
  next: unknown,
  current: readonly TabCommandEntry[],
  mintId: () => string = randomUUID
): TabCommandEntry[] {
  if (!Array.isArray(next)) throw new Error('give a list of commands')
  if (next.length > TAB_COMMANDS_MAX) throw new Error(`at most ${TAB_COMMANDS_MAX} commands`)
  const known = new Set(current.map((e) => e.id))
  const used = new Set<string>()
  return (next as unknown[]).map((raw, i) => {
    if (!isPlainObject(raw)) throw new Error(`command ${i + 1}: give a label and a command`)
    const label = checkTabCommandLabel(raw.label)
    if (!label.ok) throw new Error(`command ${i + 1}: ${label.reason}`)
    const command = checkTabCommandLine(raw.command)
    if (!command.ok) throw new Error(`command ${i + 1} (${label.value}): ${command.reason}`)
    const id = typeof raw.id === 'string' && known.has(raw.id) && !used.has(raw.id) ? raw.id : mintId()
    used.add(id)
    return entryOf(id, label.value, command.value, raw.open)
  })
}

/**
 * The entries part of the new-tab menu: app-wide first, then the project's; labels (and whether
 * an entry opens an overlay, for the menu's hint) only, never the command line.
 */
export function newTabMenu(app: readonly TabCommandEntry[], project: readonly TabCommandEntry[]): TabCommandMenu {
  const items = (list: readonly TabCommandEntry[]): TabCommandMenu['app'] =>
    list.map(({ id, label, open }) => (open === 'overlay' ? { id, label, open } : { id, label }))
  return { app: items(app), project: items(project) }
}

/**
 * The menu with each entry's chord (`keyOf`: the canonical chord that fires a command id in the
 * project's resolved table, CommandRegistry.view), so the [+] menu shows it next to the label the
 * way menus show shortcuts. A chord in an unresolved conflict fires nothing and is not shown.
 */
export function menuWithKeys(menu: TabCommandMenu, keyOf: (commandId: string) => string | undefined): TabCommandMenu {
  const items = (level: TabCommandLevel): TabCommandMenu['app'] =>
    menu[level].map((item) => {
      const key = keyOf(tabCommandId(level, item.id))
      return key === undefined ? item : { ...item, key }
    })
  return { app: items('app'), project: items('project') }
}

export interface TabCommandsDeps {
  /** `app.json` › `tabCommands`, as stored (unvalidated). */
  app: { get(): unknown; set(next: TabCommandEntry[]): void }
  /**
   * The project record's `tabCommands`, as stored. `get` throws for a project main does not know
   * (the router resolved the id from the sender, so that is a record deleted under a live window).
   */
  project: { get(projectId: string): unknown; set(projectId: string, next: TabCommandEntry[]): void }
  mintId?: () => string
}

export class TabCommandsService {
  constructor(private readonly deps: TabCommandsDeps) {}

  /** One level's valid entries (tabCommandsOf applied). */
  list(projectId: string, level: TabCommandLevel): TabCommandEntry[] {
    return tabCommandsOf(level === 'app' ? this.deps.app.get() : this.deps.project.get(projectId))
  }

  /** What the [+] menu lists under Claude and Shell for this project's window. */
  menu(projectId: string): TabCommandMenu {
    return newTabMenu(this.list(projectId, 'app'), this.list(projectId, 'project'))
  }

  /** Replace one level's list (Settings: add, edit, remove, reorder); returns what was stored. */
  set(projectId: string, level: unknown, entries: unknown): TabCommandEntry[] {
    const which = levelOf(level)
    const checked = checkTabCommands(entries, this.list(projectId, which), this.deps.mintId)
    if (which === 'app') this.deps.app.set(checked)
    else this.deps.project.set(projectId, checked)
    return checked
  }

  /**
   * The label, command and place (tab or overlay) of the entry the renderer picked, looked up in
   * main's own settings: the only way a command tab or overlay gets its command line, and the only
   * thing that decides which of the two it is. Throws for an unknown level or id (an entry deleted
   * in another window after this menu was drawn, or a forged request).
   */
  resolve(projectId: string, level: unknown, entryId: unknown): ResolvedTabCommand {
    const which = levelOf(level)
    if (typeof entryId !== 'string') throw new Error('give the command entry id')
    const entry = this.list(projectId, which).find((e) => e.id === entryId)
    if (!entry) throw new Error('no such command in the new-tab menu (edited or removed meanwhile?)')
    return { label: entry.label, command: entry.command, open: checkTabCommandOpen(entry.open) }
  }
}

/**
 * Run a resolved entry where its settings say: `to.tab` for a tab entry (its TabInfo is returned),
 * `to.overlay` for an overlay entry (null: no tab was made; the overlay is on the window's stack).
 * The menu click and the entry's key binding both arrive here through `tabs.create`, so neither
 * the renderer's menu (which may be stale) nor a forged request picks the place: main's own entry
 * does.
 */
export function openTabCommand<T>(
  entry: ResolvedTabCommand,
  to: { tab(entry: { label: string; command: string }): T; overlay(entry: { label: string; command: string }): void }
): T | null {
  const { label, command } = entry
  if (entry.open === 'overlay') {
    to.overlay({ label, command })
    return null
  }
  return to.tab({ label, command })
}

/** An entry looked up for running (TabCommandsService.resolve). */
export interface ResolvedTabCommand {
  label: string
  command: string
  open: TabCommandOpen
}

function levelOf(level: unknown): TabCommandLevel {
  if (level !== 'app' && level !== 'project') throw new Error("give the level: 'app' or 'project'")
  return level
}
