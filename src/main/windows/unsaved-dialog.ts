// Unsaved changes in page tabs at a window close or a quit (design-editor.md §1 "Dirty and close").
// A page tab (the editor's file) holds text main never sees; main only knows, per (tab, view), that a
// page said it holds unsaved changes (TabManager.setPageDirty). Closing the window or quitting the
// app ends every page, so either asks first, on the desktop, with a native box: Discard (close or
// quit anyway) or Cancel (nothing happens). The page cannot block or delay it: it only ever reported.
//
// A tab's own close asks in the renderer (close-confirm.ts, CloseTabDialog), and server mode's Close
// project asks in the browser with the in-page approval (web/CloseProject.tsx). Server mode has no
// window close button and its quit is a stop signal: nothing here runs there.
//
// The rules of when to ask are WindowManager's (window close) and QuitGuard's (quit); this file is
// the box, the guard, and the fake a test run answers with. No Electron value import, as
// close-dialog.ts: the message box and the window lookup come from index.ts.
import type { MessageBoxOptions } from 'electron'

/** What is being ended: one window's tabs, or the app's (every window). */
export type UnsavedKind = 'window' | 'quit'

/**
 * Ask whether to discard the unsaved changes of `titles` (page tab titles, at least one): true is
 * Discard (go ahead), false is Cancel. `windowId`: the window the box sits on (a quit: the focused
 * one, or none).
 */
export type AskUnsaved = (windowId: number | undefined, titles: readonly string[], kind: UnsavedKind) => Promise<boolean>

/** At most this many titles are named; the rest are counted. */
const NAMED = 5

/**
 * The titles as lines: each one plain text (a page tab title is checked and clamped by main,
 * page-tabs.ts), at most NAMED of them, then "and N more".
 */
export function unsavedList(titles: readonly string[]): string {
  const shown = titles.slice(0, NAMED).map((t) => `• ${t}`)
  if (titles.length > NAMED) shown.push(`and ${titles.length - NAMED} more`)
  return shown.join('\n')
}

/** The message box. Cancel is the default: Enter never throws text away. */
export function unsavedDialogOptions(kind: UnsavedKind, titles: readonly string[]): MessageBoxOptions {
  const one = titles.length === 1
  return {
    type: 'warning',
    buttons: [kind === 'quit' ? 'Discard and Quit' : 'Discard and Close', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: one ? 'A tab has unsaved changes.' : `${titles.length} tabs have unsaved changes.`,
    detail: `${unsavedList(titles)}\n\n${kind === 'quit' ? 'Quitting' : 'Closing the window'} discards ${one ? 'them' : 'all of them'}.`
  }
}

/** The Electron pieces the real box needs (index.ts passes BrowserWindow.fromId and dialogs.showMessageBox). */
export interface UnsavedDialogDeps<W> {
  windowOf(windowId: number): W | undefined
  showMessageBox(parent: W | undefined, options: MessageBoxOptions): Promise<{ response: number }>
}

/**
 * The real box, as a sheet on the window when there is one. A box that fails to show discards, as
 * close-dialog.ts closes for everyone: the person asked to close or quit, and an app that can never
 * be closed is worse; the failure is logged.
 */
export function electronAskUnsaved<W>(deps: UnsavedDialogDeps<W>): AskUnsaved {
  return async (windowId, titles, kind) => {
    const parent = windowId === undefined ? undefined : deps.windowOf(windowId)
    try {
      return (await deps.showMessageBox(parent, unsavedDialogOptions(kind, titles))).response === 0
    } catch (err) {
      console.warn('unsaved changes dialog failed, going ahead', err)
      return true
    }
  }
}

/**
 * A test run's box, as QueuedCloseAsk: it records what would have been asked (the `unsavedAsks`
 * hook) and answers with what a test queued (`answerUnsaved`). None queued: a window close is
 * Cancel (the window stays, as Esc would leave it), a quit is Discard, so a test run's quit (the
 * harness closing the app) always ends.
 */
export class QueuedUnsavedAsk {
  private readonly answers: boolean[] = []
  private readonly shown: Array<{ windowId: number | undefined; titles: string[]; kind: UnsavedKind }> = []

  readonly ask: AskUnsaved = async (windowId, titles, kind) => {
    this.shown.push({ windowId, titles: [...titles], kind })
    return this.answers.shift() ?? kind === 'quit'
  }

  answer(...answers: boolean[]): void {
    this.answers.push(...answers)
  }

  asks(): Array<{ windowId: number | undefined; titles: string[]; kind: UnsavedKind }> {
    return this.shown.map((a) => ({ ...a, titles: [...a.titles] }))
  }
}

/** What QuitGuard needs (index.ts: the tab manager, the box, `app.quit`). */
export interface QuitGuardDeps {
  /** Every open project's unsaved page tab titles now. */
  unsaved(): string[]
  /** The window the box goes on (the focused project window), if any. */
  windowId?(): number | undefined
  ask: AskUnsaved
  /** Quit again, once Discard was answered (`app.quit`). */
  quit(): void
  log?(message: string): void
}

/**
 * The quit's ask (desktop `before-quit`): `beforeQuit` is true when the quit must be stopped
 * (`event.preventDefault()`) because the box is up or about to be. Discard quits again and lets that
 * quit through; Cancel leaves everything as it was, and a later quit asks again. A second quit while
 * the box is up waits for the same answer.
 */
export class QuitGuard {
  private confirmed = false
  private asking = false

  constructor(private readonly deps: QuitGuardDeps) {}

  beforeQuit(): boolean {
    if (this.confirmed) return false
    if (this.asking) return true
    const titles = this.deps.unsaved()
    if (titles.length === 0) return false
    this.asking = true
    const done = (discard: boolean): void => {
      this.asking = false
      if (!discard) return
      this.confirmed = true
      this.deps.quit()
    }
    let windowId: number | undefined
    try {
      windowId = this.deps.windowId?.()
    } catch {
      windowId = undefined
    }
    this.deps.ask(windowId, titles, 'quit').then(done, (err: unknown) => {
      this.deps.log?.(`quit: unsaved changes dialog failed, quitting: ${String(err)}`)
      done(true)
    })
    return true
  }
}
