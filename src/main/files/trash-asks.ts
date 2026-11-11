// The in-page Move to Trash confirm of ctx.files.trash (design-web.md §9.6, plan Task 16): the
// shared-ask core (asks/shared-asks.ts) the `ccc plugin link` confirm uses, put to every view of the
// project's window. The first answer from any of them wins, main tells the others (`trash.settled`),
// and a view joining mid-ask finds it in its `ready` snapshot (`trashAsks`).
//
// Why not the native box everywhere (trash-dialog.ts): it is the desktop's own screen. A trash
// started from a browser (the files tree's menu in a browser view) would wait on a sheet nobody at
// that browser can see, and in server mode the native box aborts main under Ozone headless. So:
//   - in server mode always this ask (never the native box, never a test run's queued fake): with no
//     browser attached the hidden page takes it and it waits for one (5 min);
//   - on the desktop while a browser is attached, this ask, on every view (the desktop page too);
//   - on the desktop with no browser, the native box as before (chooseAsk, asks/shared-asks.ts).
//
// Who may answer: any view of the window main bound the call to (the router passes the sender's
// window, never one from the payload). Unlike a plugin link, a trash is not something only the
// desktop may approve: the Trash is recoverable, the plugin asking already runs with the person's
// rights, and the person working from the browser is the one who clicked Move to Trash there.
//
// Never moves by itself: no view, a closed window, a host that went away (`signal`) and the wait
// running out (TRASH_ASK_MS) all settle "not moved" (false), as the native box's Cancel.
//
// No Electron import: the hooks are functions (index.ts posts through the ViewRegistry).

import { SharedAsks } from '../asks/shared-asks'
import type { ConfirmTrash, TrashDialogInfo } from './system-files'

/** How long the dialog waits for an answer; past it nothing is moved. */
export const TRASH_ASK_MS = 5 * 60_000

/** One pending confirm as the views get it (the `trash.ask` payload, and `ready`'s list). */
export interface TrashAskInfo extends TrashDialogInfo {
  requestId: string
}

export interface TrashAskHooks {
  /** Post the ask to every view of the window; false when no view took it. */
  send(windowId: number, ask: TrashAskInfo): boolean
  /** The ask is over: tell every view of the window. */
  settled?(windowId: number, requestId: string): void
}

export class TrashAsks {
  private readonly core: SharedAsks<TrashDialogInfo, boolean>

  constructor(hooks: TrashAskHooks, timeoutMs = TRASH_ASK_MS) {
    this.core = new SharedAsks<TrashDialogInfo, boolean>({ hooks, prefix: 'trash', refused: false, timeoutMs })
  }

  /** Ask every view of `windowId`; true only when a view answered Move. */
  readonly ask: ConfirmTrash = (windowId, info, signal) => this.core.ask(windowId, info, signal)

  /**
   * A view's answer. The router took the window from the sender, never from the payload: another
   * window naming the id is ignored. First answer wins; false for an unknown or settled id.
   */
  answer(windowId: number, requestId: string, move: boolean): boolean {
    return this.core.answer(windowId, requestId, move === true)
  }

  /** The asks still waiting in `windowId`, oldest first (`ready`'s `trashAsks`). */
  pendingFor(windowId: number): TrashAskInfo[] {
    return this.core.pendingFor(windowId)
  }

  /** The window closed: nobody can answer, so not moved. */
  windowClosed(windowId: number): void {
    this.core.windowClosed(windowId)
  }

  get size(): number {
    return this.core.size
  }
}
