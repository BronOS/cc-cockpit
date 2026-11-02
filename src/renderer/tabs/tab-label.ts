import type { TabInfo } from '../../shared/ipc'

/**
 * Label of a tab: its kind plus the folder it runs in; a command tab is its menu entry's label
 * alone (the user named it, and it always runs in the project folder). Plain TypeScript (not in
 * TabBar.tsx) so pure modules and their unit tests can use it without JSX.
 */
export function tabLabel(tab: TabInfo): string {
  if (tab.kind === 'command') return tab.label ?? 'Command'
  const name = tab.kind === 'claude' ? 'Claude' : 'Shell'
  const folder = tab.cwd.split(/[\\/]/).filter(Boolean).pop()
  return folder ? `${name} · ${folder}` : name
}
