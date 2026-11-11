// The native dialogs main uses, behind one interface (design-web.md §9; plan 20261111-server-mode
// Task 3). Two implementations: electron-dialog.ts (the desktop: Electron's `dialog`, the only
// importer of it) and `serverDialogs` here, which never calls Electron.
//
// Why a server implementation: under Ozone headless Electron's `dialog.*` aborts the whole main
// process (SIGTRAP, spike evidence), so with no display a call must never reach it. A queued fake in
// a test run used to hide exactly that crash. What each call becomes with no screen to show it on:
//  - a message box rejects with ServerDialogError (every caller already treats a failing box as its
//    safe answer: Deny, Cancel, "close for everyone"), never a silent default answer;
//  - an open dialog answers canceled (the person has no native window to pick in; the browser has
//    its own picker);
//  - an error box becomes a log line (nobody is there to read a box).
//
// No Electron value import: only option types, so unit tests load this file in plain Node. `W` is the
// parent window type (BrowserWindow on the desktop) so logic modules never name it.
import type { MessageBoxOptions, MessageBoxReturnValue, OpenDialogOptions, OpenDialogReturnValue } from 'electron'

export interface Dialogs<W = unknown> {
  /** A native message box; `parent` makes it a sheet on that window. */
  showMessageBox(parent: W | undefined, options: MessageBoxOptions): Promise<MessageBoxReturnValue>
  /** A native open dialog; `canceled` when nothing was chosen. */
  showOpenDialog(parent: W | undefined, options: OpenDialogOptions): Promise<OpenDialogReturnValue>
  /** A blocking error box with no answer. */
  showErrorBox(title: string, content: string): void
}

/** A message box asked in server mode: there is no screen to show it on. */
export class ServerDialogError extends Error {
  constructor(title: string) {
    super(`no native dialog in server mode: ${title}`)
    this.name = 'ServerDialogError'
  }
}

/** The dialogs of a server-mode process: nothing ever reaches Electron's `dialog`. */
export function serverDialogs(log: (message: string) => void = (m) => console.error(m)): Dialogs {
  return {
    showMessageBox: (_parent, options) => Promise.reject(new ServerDialogError(options.title ?? options.message.split('\n')[0] ?? '')),
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    showErrorBox: (title, content) => log(`${title}: ${content}`)
  }
}
