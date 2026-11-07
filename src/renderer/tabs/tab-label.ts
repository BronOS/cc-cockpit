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
  if (tab.openedBy !== undefined) {
    lines.push(`Opened by ${tab.openedByName ? `${tab.openedByName} (${tab.openedBy})` : tab.openedBy}`)
  }
  return lines.join('\n')
}
