// The real SystemShell: Electron's `shell`, for ctx.files.reveal / openWithSystem / trash. The only
// file that reaches `shell` for these (CLAUDE.md: Electron-only modules behind adapters);
// system-files.ts has the logic and the unit tests.
//
// Each member is a lambda that looks `shell.<name>` up at call time, not a bound reference taken at
// import: the e2e replaces `shell.showItemInFolder`, `shell.openPath` and `shell.trashItem` in main
// with recorders after launch (as it does `shell.openExternal`), and nothing may reach the real
// file manager, an app or the Trash from a test run.
//
// Per platform (Electron 45): showItemInFolder selects the item in Finder or Explorer; on Linux it
// asks the desktop's file manager over D-Bus (org.freedesktop.FileManager1), falling back to opening
// the parent folder. trashItem is the system Trash on every platform (GIO on Linux), never a delete.
import { shell } from 'electron'
import type { SystemShell } from './system-files'

export const electronSystemShell: SystemShell = {
  showItemInFolder: (fullPath) => shell.showItemInFolder(fullPath),
  openPath: (fullPath) => shell.openPath(fullPath),
  trashItem: (fullPath) => shell.trashItem(fullPath)
}
