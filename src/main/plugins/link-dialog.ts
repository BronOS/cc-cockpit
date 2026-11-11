// The native confirm of `ccc plugin link` (plan B Task 6), apart from main's bootstrap: what the
// message box says and which button is the default (Deny), and the fake a test run answers with
// instead. The rules around it (who may ask, how often, display-safe text) are link-request.ts's.
//
// No Electron value import: the message box and the window lookup are passed in by index.ts, so
// the options and the fallback paths are unit-tested; only the MessageBoxOptions type is used.
import type { MessageBoxOptions } from 'electron'
import type { LinkCaller, LinkDialogInfo } from './link-request'

/** PluginDevOptions.confirmLink: true only for Allow. */
export type ConfirmLink = (windowId: number, info: LinkDialogInfo, signal?: AbortSignal) => Promise<boolean>

/** Button index of Allow; Deny is 0. */
const ALLOW = 1

/** The message box; `info` is already display-safe (linkDialogInfo). */
export function linkDialogOptions(info: LinkDialogInfo, signal?: AbortSignal): MessageBoxOptions {
  return {
    type: 'warning',
    // Deny first, and both the default and the cancel button: Enter or Escape never allows.
    buttons: ['Deny', 'Allow'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    // The id first: the name is the plugin's own text and could imitate a second parenthesis.
    message: `Link plugin ${info.id} (named "${info.name}")?`,
    // Only what main knows about the caller (review finding: it said "a Claude session" also for
    // a `--project` call from outside any tab, and a tab may be a plain shell).
    detail:
      `${callerText(info.caller)} asked to link the plugin in\n${info.path}\n\n` +
      'A linked plugin runs with full access to your computer, like any program you start, and stays until it is unlinked. ' +
      'Allow only a plugin you wrote or trust.',
    ...(signal ? { signal } : {})
  }
}

function callerText(caller: LinkCaller): string {
  return caller === 'tab'
    ? 'A "ccc plugin link" command in a tab of this window'
    : 'A "ccc plugin link" command run outside the app\'s tabs (naming this project with --project)'
}

/** The Electron pieces the real dialog needs (index.ts passes BrowserWindow.fromId and dialogs.showMessageBox). */
export interface LinkDialogDeps<W> {
  windowOf(windowId: number): W | undefined
  showMessageBox(parent: W, options: MessageBoxOptions): Promise<{ response: number }>
}

/**
 * The real confirm, as a sheet on the caller's window. A window that is gone, a dialog that fails
 * or one closed by `signal` (the `ccc` caller went away) is a Deny.
 */
export function electronConfirmLink<W>(deps: LinkDialogDeps<W>): ConfirmLink {
  return async (windowId, info, signal) => {
    const parent = deps.windowOf(windowId)
    if (parent === undefined) return false
    try {
      return (await deps.showMessageBox(parent, linkDialogOptions(info, signal))).response === ALLOW
    } catch {
      return false
    }
  }
}

/**
 * A test run's dialog: it records what would have been shown (the `linkDialogs` hook) and answers
 * with what a test queued (`answerLink`); none queued is Deny, the real dialog's own default.
 */
export class QueuedLinkConfirm {
  private readonly answers: boolean[] = []
  private readonly shown: Array<{ windowId: number } & LinkDialogInfo> = []

  readonly confirm: ConfirmLink = async (windowId, info) => {
    this.shown.push({ windowId, ...info })
    return this.answers.shift() ?? false
  }

  answer(...answers: boolean[]): void {
    this.answers.push(...answers)
  }

  dialogs(): Array<{ windowId: number } & LinkDialogInfo> {
    return [...this.shown]
  }
}
