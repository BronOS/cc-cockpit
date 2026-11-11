// The shared-ask core (design-web.md §5.1, §9.6): a question main puts to every view of one window
// (the desktop page, the hidden page in server mode, browser views), answered by whichever view
// answers first. Main tells every view when it is over (`settled`), so the others take their dialog
// down, and a view joining mid-ask finds it in its `ready` snapshot (`pendingFor`).
//
// Moved out of LinkAsks (plugins/link-asks.ts) so the trash confirm (plan Task 16) is the same
// machinery, not a copy: what differs per ask is who may give which answer (LinkAsks refuses a
// remote Allow on the desktop), which the owner checks before it calls `answer` here.
//
// Never answers by itself with anything but `refused`: no view took the ask, a closed window, a
// vanished caller (`signal`) and the wait running out all settle with it. The wait must end (a window
// can sit unattended overnight), so every ask carries a timeout.
//
// No Electron import: the hooks are functions (index.ts posts through the ViewRegistry), so vitest
// drives it.

/** How main reaches a window's views (index.ts: the ViewRegistry). */
export interface SharedAskHooks<Info> {
  /** Post the ask to every view of the window; false when no view took it (settled `refused` at once). */
  send(windowId: number, ask: Info & { requestId: string }): boolean
  /** The ask is over: tell every view of the window. */
  settled?(windowId: number, requestId: string): void
}

export interface SharedAskOptions<Info, Answer> {
  hooks: SharedAskHooks<Info>
  /** The request id's prefix (`link-1`): ids name the kind in logs and frames. */
  prefix: string
  /** The answer when nobody gave one (timeout, abort, closed window, no view). */
  refused: Answer
  timeoutMs: number
}

interface Pending<Info, Answer> {
  windowId: number
  info: Info & { requestId: string }
  resolve: (answer: Answer) => void
  timer: ReturnType<typeof setTimeout>
  offAbort?: () => void
}

export class SharedAsks<Info extends object, Answer> {
  private next = 1
  private readonly pending = new Map<string, Pending<Info, Answer>>()

  constructor(private readonly options: SharedAskOptions<Info, Answer>) {}

  /** Ask every view of `windowId`; resolves with the first answer, or `refused`. */
  ask(windowId: number, info: Info, signal?: AbortSignal): Promise<Answer> {
    const requestId = `${this.options.prefix}-${this.next++}`
    return new Promise<Answer>((resolve) => {
      if (signal?.aborted) return resolve(this.options.refused)
      const timer = setTimeout(() => this.settle(requestId, this.options.refused), this.options.timeoutMs)
      timer.unref?.()
      const entry: Pending<Info, Answer> = { windowId, info: { ...info, requestId }, resolve, timer }
      if (signal) {
        const onAbort = (): void => this.settle(requestId, this.options.refused)
        signal.addEventListener('abort', onAbort, { once: true })
        entry.offAbort = () => signal.removeEventListener('abort', onAbort)
      }
      this.pending.set(requestId, entry)
      let sent: boolean
      try {
        sent = this.options.hooks.send(windowId, entry.info)
      } catch {
        sent = false
      }
      if (!sent) this.settle(requestId, this.options.refused)
    })
  }

  /** Whether `requestId` is waiting in `windowId` (an id of another window is not). */
  isPending(windowId: number, requestId: string): boolean {
    return this.pending.get(requestId)?.windowId === windowId
  }

  /**
   * A view's answer: the caller took the window from the sender, never from the payload, and decided
   * whether that view may give `answer`. First answer wins; false for an unknown or settled id and for
   * another window's.
   */
  answer(windowId: number, requestId: string, answer: Answer): boolean {
    if (!this.isPending(windowId, requestId)) return false
    this.settle(requestId, answer)
    return true
  }

  /** The asks still waiting in `windowId`, oldest first (`ready`'s list). Copies. */
  pendingFor(windowId: number): Array<Info & { requestId: string }> {
    const out: Array<Info & { requestId: string }> = []
    for (const entry of this.pending.values()) if (entry.windowId === windowId) out.push({ ...entry.info })
    return out
  }

  /** The window closed: nobody can answer, so `refused`. */
  windowClosed(windowId: number): void {
    for (const [id, entry] of [...this.pending]) if (entry.windowId === windowId) this.settle(id, this.options.refused)
  }

  get size(): number {
    return this.pending.size
  }

  private settle(requestId: string, answer: Answer): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    this.pending.delete(requestId)
    clearTimeout(entry.timer)
    entry.offAbort?.()
    entry.resolve(answer)
    try {
      this.options.hooks.settled?.(entry.windowId, requestId)
    } catch {
      // Best effort: a view that missed it still has its dialog, whose late answer finds nothing.
    }
  }
}

/**
 * Which confirm a window's ask goes to, decided per call from the live view list: the shared in-page
 * ask in server mode or while the window has a browser view attached, else `native` (the desktop's
 * box as a sheet, or in a test run on the desktop the queued fake standing in for it). One rule for
 * `ccc plugin link` (LinkAsks) and ctx.files.trash (TrashAsks).
 *
 * A browser joining while a native box is up is not shown a second one: that box stays the answer
 * for the request. In server mode always shared (design-web.md §9.6): the native dialog aborts main
 * under Ozone headless, and a test run's queued fake would answer what the browser should. With no
 * browser attached the hidden page takes the ask, so it waits there for a browser to join (`ready`)
 * or runs out.
 */
export function chooseAsk<Info, Answer>(options: {
  /** Main's server-mode flag for the run. */
  server: boolean
  hasRemoteView(windowId: number): boolean
  shared: (windowId: number, info: Info, signal?: AbortSignal) => Promise<Answer>
  native: (windowId: number, info: Info, signal?: AbortSignal) => Promise<Answer>
}): (windowId: number, info: Info, signal?: AbortSignal) => Promise<Answer> {
  return (windowId, info, signal) =>
    options.server || options.hasRemoteView(windowId) ? options.shared(windowId, info, signal) : options.native(windowId, info, signal)
}
