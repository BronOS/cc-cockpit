// Keys typed into a page tab's frame on the desktop (design-editor.md §1 "Keyboard"). A sandboxed
// frame's key events stay in the frame: the shell page's window listener never sees them, so Cmd+W,
// Ctrl+Tab or Cmd+T typed in an editor tab would do nothing. Main sees every key of the window's
// webContents first (`before-input-event`, frames included), so when the focused frame is a page
// tab's (PAGE_TAB_FRAME_NAME), the app's chords go to the shell as `commands.trigger`, as for a
// webview panel's page (webview-manager.ts webviewChord), and the page never gets them.
//
// Precedence: the app table (defaults plus the person's keyOverrides, CommandRegistry.view) wins for
// every chord it holds, whatever the page declared; the page's declared `keys` and everything else
// reach the page. The clash of a declared key with the table is shown in Settings › Keybindings
// (KeyBindingRow.pageKeys). Only chords with Cmd, Ctrl or Alt (forwardedCommand): Escape (overlay.pop)
// and bare keys are the page's typing. The web shell has no `before-input-event`: there the panel
// SDK forwards the same chords (panel-core.ts, the shell's `cc-plugin.tab` `keys`).
//
// No Electron import: index.ts hands the focused frame in, so vitest drives it.
import { PAGE_TAB_FRAME_NAME } from '../../shared/page-tabs'
import { forwardedCommand } from '../webview/webview-manager'

/** The fields of an Electron WebFrameMain this decides on. */
export interface FrameLike {
  readonly name: string
  readonly url: string
  /** Null for the page's main frame (the shell itself). */
  readonly parent: unknown
}

/**
 * Whether `frame` is a page tab's frame: a child frame of the shell named PAGE_TAB_FRAME_NAME that
 * shows a plugin page (cc-plugin://). The shell page itself (no parent) never is: its own window
 * listener runs its keys.
 */
export function isPageTabFrame(frame: FrameLike | null | undefined): boolean {
  if (!frame || frame.parent === null || frame.parent === undefined) return false
  return frame.name === PAGE_TAB_FRAME_NAME && frame.url.startsWith('cc-plugin:')
}

/** What `pageTabChord` needs from main (index.ts: the key table and the window's shell page). */
export interface PageTabChordDeps {
  /** The window's key table: the command bound to `chord`, if any. */
  commandFor(windowId: number, chord: string): string | undefined
  /** Send `commands.trigger` to the window's own shell page; false when the window is gone. */
  trigger(windowId: number, id: string): boolean
}

/**
 * A chord typed into a page tab's frame of `windowId`: true when it is an app chord, sent to the shell
 * (which runs it through its modal gate, command-gate.ts), so the caller swallows the key. The
 * keyboard stays in the frame: a command that moves it (a new tab) moves it itself.
 */
export function pageTabChord(deps: PageTabChordDeps, windowId: number, chord: string | null): boolean {
  if (chord === null) return false
  const id = forwardedCommand(chord, (c) => deps.commandFor(windowId, c))
  if (id === undefined) return false
  return deps.trigger(windowId, id)
}
