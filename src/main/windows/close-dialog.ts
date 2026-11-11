// What closing a project window means while browsers have it open (design-web.md §5.6, plan
// Task 26): today closing the desktop window closes the project and every tab in it, and with
// remote views attached that would also cut the person off on their other device. So the close asks
// first: "Close for everyone" (today's close, the browsers are told the window closed) or "Keep
// running for <device>" (the window is hidden, the project and its Claude tabs keep running for the
// browser). Cancel (Esc) leaves the window as it was. With no remote view nothing asks: today's close.
//
// The rules (when to ask, what each answer does) are WindowManager's; this file is the dialog: what
// the message box says, which button is the default, and the fake a test run answers with. No
// Electron value import, as link-dialog.ts: the message box and the window lookup come from index.ts.
import type { MessageBoxOptions } from 'electron'

/** The person's answer. `cancel` is Esc or the box failing to show for a window that is gone. */
export type CloseChoice = 'everyone' | 'keep' | 'cancel'

/** WindowManagerOptions.askClose: `devices` are the names of the devices with a live view of the window. */
export type AskClose = (windowId: number, devices: readonly string[]) => Promise<CloseChoice>

/** Button order: index = response. */
const CHOICES: readonly CloseChoice[] = ['everyone', 'keep', 'cancel']

/**
 * The devices as one phrase: "Pixel", "Pixel and iPad", "Pixel, iPad and 2 more". Names are the
 * requester's own text, already plain and at most MAX_DEVICE_NAME long (devices.ts), and a native
 * button shows them as text; the count is capped so a button never grows past a short line.
 */
export function devicesText(devices: readonly string[]): string {
  const names = devices.length > 0 ? devices : ['a browser']
  if (names.length === 1) return names[0]!
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`
}

/** The message box. Keep running is the default: Enter never ends tabs someone else is using. */
export function closeDialogOptions(devices: readonly string[]): MessageBoxOptions {
  const who = devicesText(devices)
  return {
    type: 'question',
    buttons: ['Close for everyone', `Keep running for ${who}`, 'Cancel'],
    defaultId: 1,
    cancelId: 2,
    noLink: true,
    message: `${who} ${devices.length > 1 ? 'have' : 'has'} this project open in a browser.`,
    detail:
      'Close for everyone ends its tabs and Claude sessions, here and in the browser. ' +
      'Kept running, this window is hidden and everything keeps going; open the project again ' +
      '(the project picker, "ccc open" or the dock) to bring the window back.'
  }
}

/** The Electron pieces the real dialog needs (index.ts passes BrowserWindow.fromId and dialogs.showMessageBox). */
export interface CloseDialogDeps<W> {
  windowOf(windowId: number): W | undefined
  showMessageBox(parent: W, options: MessageBoxOptions): Promise<{ response: number }>
}

/**
 * The real dialog, as a sheet on the window being closed. A window that is gone has nothing to ask
 * about (`cancel`: its own close is already under way). A box that fails to show closes for
 * everyone: the person asked to close, and a window that can never be closed is worse than the
 * browser being told the window closed.
 */
export function electronAskClose<W>(deps: CloseDialogDeps<W>): AskClose {
  return async (windowId, devices) => {
    const parent = deps.windowOf(windowId)
    if (parent === undefined) return 'cancel'
    try {
      return CHOICES[(await deps.showMessageBox(parent, closeDialogOptions(devices))).response] ?? 'cancel'
    } catch (err) {
      console.warn('window close dialog failed, closing for everyone', err)
      return 'everyone'
    }
  }
}

/**
 * A test run's dialog, as QueuedLinkConfirm: it records what would have been asked (the
 * `windowCloseAsks` hook) and answers with what a test queued (`answerWindowClose`); none queued is
 * Cancel, which leaves the window open, as Esc would.
 */
export class QueuedCloseAsk {
  private readonly answers: CloseChoice[] = []
  private readonly shown: Array<{ windowId: number; devices: string[] }> = []

  readonly ask: AskClose = async (windowId, devices) => {
    this.shown.push({ windowId, devices: [...devices] })
    return this.answers.shift() ?? 'cancel'
  }

  answer(...answers: CloseChoice[]): void {
    this.answers.push(...answers)
  }

  asks(): Array<{ windowId: number; devices: string[] }> {
    return this.shown.map((a) => ({ windowId: a.windowId, devices: [...a.devices] }))
  }
}
