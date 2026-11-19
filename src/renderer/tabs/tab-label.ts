import type { TabInfo } from '../../shared/ipc'
import { argvText } from '../../shared/tab-commands'

/**
 * Label of a tab: its kind plus the folder it runs in; a command tab is its menu entry's label
 * alone (the user named it, and it always runs in the project folder). A Claude tab the person
 * named (`named`: SessionDetail.name) shows that name; else, when its session has a terminal title
 * (`title`: the topic Claude Code generated, SessionDetail.title), it is named after it. Plain
 * TypeScript (not in TabBar.tsx) so pure modules and their unit tests can use it without JSX.
 */
export function tabLabel(tab: TabInfo, title?: string, named?: string): string {
  // A page tab's title is the one main clamped from its plugin's request (shared/page-tabs.ts).
  if (tab.kind === 'page') return tab.page?.title ?? 'Page'
  if (tab.kind === 'command') return tab.label ?? 'Command'
  if (tab.kind === 'claude' && named) return named
  if (tab.kind === 'claude' && title) return title
  const kind = tab.kind === 'claude' ? 'Claude' : 'Shell'
  const folder = tab.cwd.split(/[\\/]/).filter(Boolean).pop()
  return folder ? `${kind} · ${folder}` : kind
}

/**
 * The tooltip lines of a command tab under the flag note: what it runs (the user's command line, or a
 * plugin's argv quoted for reading, shared/tab-commands.ts argvText), where, and for a tab a plugin
 * opened, which plugin ("Opened by Files (cockpit.files)", the bare id when the name is not known).
 * That last line is the safeguard of plugin command tabs (design.md §3 "Custom commands"); a user's
 * own command tab has none. Undefined for any other tab (TabBar shows the terminal title and cwd).
 */
export function commandTooltip(tab: TabInfo): string | undefined {
  if (tab.kind !== 'command') return undefined
  const runs = tab.argv !== undefined ? argvText(tab.argv) : tab.command
  if (runs === undefined) return undefined
  const lines = [runs, tab.cwd]
  const by = openedByLine(tab)
  if (by !== undefined) lines.push(by)
  return lines.join('\n')
}

/**
 * "Opened by Files (cockpit.files)" for a tab a plugin opened (a command tab's `openedBy`, a page
 * tab's `page.plugin`), the bare id when the plugin's name is not known; undefined for a tab the
 * person opened. The id stays beside the name: a manifest name is the plugin's own text, the id is
 * what the Plugins page lists (and `cockpit.` ids are reserved for bundled plugins).
 */
export function openedByLine(tab: TabInfo): string | undefined {
  const id = tab.openedBy ?? (tab.kind === 'page' ? tab.page?.plugin : undefined)
  if (id === undefined) return undefined
  const name = tab.openedBy !== undefined ? tab.openedByName : tab.pluginName
  return `Opened by ${name ? `${name} (${id})` : id}`
}

/**
 * "Opened by guest Ada" for a tab a write guest opened (D-21), the tooltip line; undefined for any other
 * tab. Main sets `openedByGuest` (the guest's id) from the caller it bound, never from a payload; the
 * name comes from `nameOf` (the guest list or presence, guests/tab-access-model.ts `guestNameOf`), and a
 * guest no list knows any more is "a guest", never its raw id.
 */
export function openedByGuestLine(tab: TabInfo, nameOf: (guestId: string) => string | undefined = () => undefined): string | undefined {
  if (tab.openedByGuest === undefined || tab.openedByGuest === '') return undefined
  const name = nameOf(tab.openedByGuest)
  return name !== undefined && name !== '' ? `Opened by guest ${name}` : 'Opened by a guest'
}

/**
 * What a page tab's core marks say to a screen reader (the dots are aria-hidden): unsaved changes in
 * some view (`dirty`) and opened while another tab was selected (`unseen`, design-editor.md §1).
 * Empty for a tab with neither; any tab kind may carry `unseen`, only page tabs `dirty`.
 */
export function pageTabMarks(tab: TabInfo): string[] {
  const marks: string[] = []
  if (tab.dirty) marks.push('unsaved changes')
  if (tab.unseen) marks.push('not seen yet')
  return marks
}
