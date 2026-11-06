// The native confirm of ctx.files.trash, apart from main's bootstrap (the shape of link-dialog.ts):
// what the message box says and which button is the default (Cancel), and the fake a test run
// answers with instead. The rules around it (who may ask, the path checks before and after) are
// system-files.ts's; the one-dialog-at-a-time and rate rules are HostApi's.
//
// Why a dialog a plugin cannot skip: a host is plain Node that could delete files itself, but this
// call is the one that carries the app's name to the person, and a menu item is one mis-click from
// a folder of work. The Trash is recoverable; the dialog makes sure the person meant it anyway.
//
// No Electron value import: the message box and the window lookup are passed in by index.ts.
import type { MessageBoxOptions } from 'electron'
import type { ConfirmTrash, TrashDialogInfo } from './system-files'

/** Button index of the move; Cancel is 0. */
const MOVE = 1

/** The system's name for the Trash: Windows calls it the Recycle Bin. */
export function trashName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'Recycle Bin' : 'Trash'
}

/** The message box; `info` is already display-safe (system-files.ts). */
export function trashDialogOptions(info: TrashDialogInfo, platform: NodeJS.Platform, signal?: AbortSignal): MessageBoxOptions {
  const bin = trashName(platform)
  return {
    type: 'warning',
    // Cancel first, and both the default and the cancel button: Enter or Escape never moves anything.
    buttons: ['Cancel', `Move to ${bin}`],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: `Move the ${info.kind} ${info.path} to the ${bin}?`,
    detail: `The plugin ${info.pluginId} asked to move it, with everything in it for a folder. You can restore it from the ${bin}.`,
    ...(signal ? { signal } : {})
  }
}

/** The Electron pieces the real dialog needs (index.ts passes BrowserWindow.fromId and dialog.showMessageBox). */
export interface TrashDialogDeps<W> {
  windowOf(windowId: number): W | undefined
  showMessageBox(parent: W, options: MessageBoxOptions): Promise<{ response: number }>
  platform?: NodeJS.Platform
}

/**
 * The real confirm, as a sheet on the project's window. A window that is gone, a dialog that fails
 * or one closed by `signal` (the host went away) is a Cancel.
 */
export function electronConfirmTrash<W>(deps: TrashDialogDeps<W>): ConfirmTrash {
  const platform = deps.platform ?? process.platform
  return async (windowId, info, signal) => {
    const parent = deps.windowOf(windowId)
    if (parent === undefined) return false
    try {
      return (await deps.showMessageBox(parent, trashDialogOptions(info, platform, signal))).response === MOVE
    } catch {
      return false
    }
  }
}

/**
 * A test run's dialog: it records what would have been shown (the `trashDialogs` hook) and answers
 * with what a test queued (`answerTrash`); none queued is Cancel, the real dialog's own default.
 */
export class QueuedTrashConfirm {
  private readonly answers: boolean[] = []
  private readonly shown: Array<{ windowId: number } & TrashDialogInfo> = []

  readonly confirm: ConfirmTrash = async (windowId, info) => {
    this.shown.push({ windowId, ...info })
    return this.answers.shift() ?? false
  }

  answer(...answers: boolean[]): void {
    this.answers.push(...answers)
  }

  dialogs(): Array<{ windowId: number } & TrashDialogInfo> {
    return [...this.shown]
  }
}
