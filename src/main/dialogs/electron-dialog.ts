// The only importer of Electron's `dialog` (test/unit/no-direct-dialog.test.ts guards it). It is a
// pass-through: parent and options reach Electron unchanged, and a call without a parent is the
// parentless overload (a sheet on no window). The server-mode counterpart is dialogs.ts.
import { dialog, type BrowserWindow } from 'electron'
import type { Dialogs } from './dialogs'

/**
 * `dialog` through the Dialogs interface. `dialog` is read at each call, never captured, so a test
 * that replaces a member after launch still takes effect.
 */
export function electronDialogs(): Dialogs<BrowserWindow> {
  return {
    showMessageBox: (parent, options) =>
      parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options),
    showOpenDialog: (parent, options) =>
      parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options),
    showErrorBox: (title, content) => dialog.showErrorBox(title, content)
  }
}
