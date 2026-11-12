// The renderer's key table: which chord fires which command, and which commands this window can
// run. DOM-free (events are typed structurally) so unit tests load it.
//
// Only commands with a registered handler claim their chord. Escape is bound to "pop the top
// overlay" by default, but with no overlay open the key must reach the terminal (vim, Claude's
// own Esc); claiming it for a command nobody handles would break both.
import type { CommandInfo, CommandsView } from '../../shared/ipc'
import { chordFromEvent, splitChord, type KeyEventLike } from '../../shared/keys'
import { parseDesktopAgent } from '../../shared/remote-agent'
import { parseTabCommandId } from '../../shared/tab-commands'
import { isWebShell } from '../shell-kind'
import { webKeyTable } from './web-keys'

export type CommandHandler = () => void

let chords = new Map<string, string>()
// Per command, the handlers registered for it, latest last; the latest one runs. A stack, not a
// single slot: the settings screen claims `overlay.closeTop` and an overlay opened over it (a cli
// login) claims it too; when that overlay goes, removing its handler must give the chord back to
// the settings screen rather than leave nobody holding it.
let handlers = new Map<string, CommandHandler[]>()
let commands: CommandInfo[] = []
// While > 0 no key fires a command: the keybinding editor is recording a chord, and the chord
// being pressed may well be a bound one (that is the point of rebinding it).
let captures = 0

/** Stop keys from firing commands until the returned function is called (once; further calls do nothing). */
export function captureKeys(): () => void {
  captures++
  let released = false
  return () => {
    if (released) return
    released = true
    captures--
  }
}

/**
 * Replace the table with main's resolved one (`commands.list`). In the web shell, chords the
 * browser keeps for itself (Ctrl/Cmd+W, T, N, Ctrl+Tab) move to their Alt alternative first
 * (web-keys.ts), so the menus and the palette show the chord that works in this browser. A remote
 * desktop window (user agent carries `cc-cockpit-desktop/`) keeps the desktop table.
 */
export function setCommands(view: CommandsView): void {
  // A cc-cockpit desktop window showing a remote server (design-remote-desktop.md §4) is a web shell
  // too, but nothing there keeps those chords, so it uses the desktop table. The user agent only
  // picks which chords this page listens to; a forged one changes nothing on the server.
  const inDesktopWindow = typeof navigator !== 'undefined' && parseDesktopAgent(navigator.userAgent) !== undefined
  if (isWebShell() && !inDesktopWindow) view = webKeyTable(view, typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac'))
  commands = view.commands
  chords = new Map()
  for (const c of view.commands) if (c.key) chords.set(c.key, c.id)
}

/**
 * Register the handlers of this window; returns the function that removes exactly them. A later
 * registration for the same id wins until it is removed, then the earlier one runs again.
 */
export function registerHandlers(map: Record<string, CommandHandler>): () => void {
  const added = Object.entries(map)
  for (const [id, fn] of added) handlers.set(id, [...(handlers.get(id) ?? []), fn])
  return () => {
    for (const [id, fn] of added) {
      const list = handlers.get(id)
      const at = list?.lastIndexOf(fn) ?? -1
      if (!list || at < 0) continue
      const rest = list.filter((_, i) => i !== at)
      if (rest.length > 0) handlers.set(id, rest)
      else handlers.delete(id)
    }
  }
}

/** The command a key event fires, or undefined (not bound, or nobody here can run it). */
export function commandForEvent(e: KeyEventLike): string | undefined {
  if (captures > 0) return undefined
  const chord = chordFromEvent(e)
  if (!chord) return undefined
  const id = chords.get(chord)
  return id !== undefined && handlers.has(id) ? id : undefined
}

/**
 * The effective chord of a command (default or the user's override), undefined when unbound. Read
 * from the table main last pushed, so a rebinding shows at the next render (the [+] menu renders
 * when it opens, and Settings is modal over it, so it never shows a stale chord).
 */
export function chordOf(id: string): string | undefined {
  return commands.find((c) => c.id === id)?.key
}

/** Run a command by id; false when this window has no handler for it. */
export function runCommand(id: string): boolean {
  const fn = handlers.get(id)?.at(-1)
  if (!fn) return false
  fn()
  return true
}

/**
 * A handler for every plugin command main lists: running one asks main (`commands.run`), which
 * runs it in this window's plugin host. Registered like the local ones, so plugin commands claim
 * their keys and show in the palette only while main lists them.
 */
export function pluginCommandHandlers(view: CommandsView, run: (id: string) => void): Record<string, CommandHandler> {
  const out: Record<string, CommandHandler> = {}
  for (const c of view.commands) if (c.source === 'plugin') out[c.id] = () => run(c.id)
  return out
}

/**
 * A handler for every new-tab menu entry main lists (`tab.newCommand.<level>.<entryId>`): running
 * one opens the entry's tab by level and id, the [+] menu's own path, so main looks the command
 * line up and the renderer never holds it. Rebuilt from each table like the plugin handlers, so
 * an entry removed in Settings loses its handler, and with it its chord and its palette row, at
 * the next `commands.updated`; one that main removed in between is refused by main at create.
 */
export function tabCommandHandlers(
  view: CommandsView,
  create: (level: 'app' | 'project', entryId: string) => void
): Record<string, CommandHandler> {
  const out: Record<string, CommandHandler> = {}
  for (const c of view.commands) {
    if (c.source !== 'tabCommand') continue
    const entry = parseTabCommandId(c.id)
    if (entry) out[c.id] = () => create(entry.level, entry.entryId)
  }
  return out
}

/** Commands the palette can offer: known to main and runnable here. */
export function runnableCommands(): CommandInfo[] {
  return commands.filter((c) => handlers.has(c.id))
}

/** Test seam: forget everything. */
export function resetKeybindings(): void {
  chords = new Map()
  handlers = new Map()
  commands = []
  captures = 0
}

/** Fuzzy filter over titles: every query character in order; contiguous and early matches first. */
export function fuzzyFilter<T extends { title: string }>(items: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...items]
  const scored: { item: T; score: number; index: number }[] = []
  items.forEach((item, index) => {
    const score = fuzzyScore(item.title.toLowerCase(), q)
    if (score !== null) scored.push({ item, score, index })
  })
  // Lower score is better; ties keep the original (registry) order.
  scored.sort((a, b) => a.score - b.score || a.index - b.index)
  return scored.map((s) => s.item)
}

function fuzzyScore(text: string, query: string): number | null {
  let pos = -1
  let score = 0
  let first = -1
  for (const ch of query) {
    const at = text.indexOf(ch, pos + 1)
    if (at < 0) return null
    if (first < 0) first = at
    else score += at - pos - 1 // characters skipped between two matches
    pos = at
  }
  return first + score
}

/** Show a canonical chord the way the platform writes it (`meta+shift+p` -> `⌘⇧P` on macOS). */
export function displayChord(chord: string, mac: boolean): string {
  return chordKeys(chord, mac).join(mac ? '' : '+')
}

/**
 * The keys of a chord as displayChord names them, one entry per key (the [+] menu draws a keycap
 * for each). displayChord is these joined.
 */
export function chordKeys(chord: string, mac: boolean): string[] {
  const names: Record<string, string> = mac
    ? { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' }
    : { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' }
  // splitChord, not split('+'): `meta++` (Cmd and Plus) split into empty parts, and the empty
  // key's `p[0]!.toUpperCase()` threw inside render, taking down the settings screen and the
  // palette. A chord it cannot take apart is shown as it is rather than thrown on.
  const parts = splitChord(chord)
  if (!parts) return [String(chord)]
  const show = (p: string): string => names[p] ?? (p.length <= 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1))
  return [...parts.mods, parts.key].map(show)
}
