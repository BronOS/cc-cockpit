// Pure helpers for the status words (the tab strip, the close dialog, Discuss) and the top bar's
// class, unit-testable without a DOM. The other windows' strip and its order left core with
// design-next §4: the bundled cockpit.sessions plugin draws them (plugins/sessions/dist/lib/view.js).
import { isDialogTool, type DialogTool } from '../../shared/hooks'
import type { TabStatus } from '../../shared/ipc'

const LABEL: Record<TabStatus, string> = {
  starting: 'starting',
  idle: 'idle',
  working: 'working',
  'needs-permission': 'needs permission',
  waiting: 'waiting for input',
  ended: 'ended'
}

export function statusLabel(status: TabStatus): string {
  return LABEL[status]
}

/**
 * What a dialog tool's dialog is called. A `needs-permission` tab whose tool is one of these is
 * not asking for permission: Claude put a question (or its plan) to the user, so the status reads
 * "needs you · question" instead of "needs permission · AskUserQuestion". A Record over the type,
 * so a tool added to DIALOG_TOOLS without a word here fails the typecheck.
 */
const DIALOG_WORD: Record<DialogTool, string> = {
  AskUserQuestion: 'question',
  ExitPlanMode: 'plan approval'
}

/** `status · tool` (the tool only while there is one); a dialog tool's dialog as `needs you · <dialog>`. */
export function statusText(status: TabStatus, tool?: string): string {
  if (status === 'needs-permission' && isDialogTool(tool)) return `needs you · ${DIALOG_WORD[tool]}`
  return tool ? `${statusLabel(status)} · ${tool}` : statusLabel(status)
}

/**
 * The top bar's class list. `title-bar` (macOS: the bar is the window's title bar) reserves the
 * traffic lights' room; `full-screen` collapses it, because macOS hides the lights in full screen
 * and the gap would be dead space. Full screen means nothing without the in-page title bar.
 */
export function topStripClass(titleBar: boolean, fullScreen: boolean): string {
  if (!titleBar) return 'top-strip'
  return fullScreen ? 'top-strip title-bar full-screen' : 'top-strip title-bar'
}
