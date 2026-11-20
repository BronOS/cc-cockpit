// One view's copy of a `perView` html overlay (docs/design-overlay-views.md §5), and what the stack draws for an
// html overlay in this view. DOM-free so unit tests run it in plain Node; HtmlOverlay and OverlayStack wire it to
// the channels and the frame.
//
// The copy lifecycle in one view (CopyLine):
//   - every load of the page's frame is a new port, and `overlays.ready` on it mints a new copy (main releases the
//     view's previous one first), so a reload, a reconnect (the web shell remounts) or a remount is a new copy;
//   - every page call names the copy main answered (`loaded`, `message`, `result`); what the page sends before the
//     answer is held and sent once it names the copy, and main's events for a copy the answer has not named yet
//     (the opener's starting state from its onConnect, a hide, a reload) are buffered by copy id;
//   - the load ending (the frame unmounts, the page loads again) sends a plain `overlays.release` (never a hide),
//     also for a copy whose answer comes after the load ended;
//   - `overlays.hide` for the live copy takes the overlay off this view's stack; `overlays.reload` loads the page
//     again (a new copy). Main took both copies back itself, so neither is released.
//   - a refused connect: `cap` (too many connects of this view lately) and a failed call are asked again with a
//     backoff (COPY_RETRY_*), keeping the page and its port; any other refusal is final for this mount.
//
// The reconnect rule: a mounted line always ends in a live copy or a final refusal. Main drops a copy only by
// telling the view (`overlays.hide`, or `overlays.reload` for a queue that overflowed or an event its view could
// not take); a view whose socket closed comes back as a new shell (web/main.tsx remounts it), and a desktop page
// that reloaded lists again: every copy is new. The page's own posts answering false are never a signal (a read
// guest's one-way copy answers false to every one, which would loop into the cap).

import { MAX_QUEUED_MESSAGES } from '../../sdk/panel-core'
import type { OverlayCopyRefusal, OverlayInfo, OverlayReadyAnswer, PageHolder } from '../../shared/ipc'
import type { ViewAccess } from '../../shared/views'

/** What ✕ (and the close keys) send for an overlay in this view. */
export type CloseAction = 'close' | 'hide'

/**
 * D-2: a read guest's ✕ on a perView overlay hides its own copies (`overlays.release { hide: true }`); everyone
 * else's closes it for everyone (`overlays.close`: the owner, and a write guest). A read guest's ✕ on any other
 * overlay stays a close, which main refuses (it never holds such a page, and hiding one is not offered).
 */
export function closeActionOf(overlay: Pick<OverlayInfo, 'perView'>, access: ViewAccess): CloseAction {
  return access === 'read' && overlay.perView === true ? 'hide' : 'close'
}

/** What a page's `{ result }` becomes in this view. */
export type ResultAction = 'result' | 'hide' | 'close'

/**
 * A page's answer (`ccPanel.post({ result })`), §5 "✕ and results": the owner's is the overlay's result; a read
 * guest's is its hide (no result is sent: `overlays.result` is write-class, main refuses it); a write guest's
 * closes the overlay for everyone with no result (main refuses a guest's result whatever its role).
 */
export function resultActionOf(access: ViewAccess): ResultAction {
  if (access === 'owner') return 'result'
  return access === 'read' ? 'hide' : 'close'
}

/**
 * The note a guest sees where an overlay's page is not shown to it (§7): where it is, and why. `pluginTitle` is the
 * opener's name, which main sends a guest only while that plugin is visible to it (OverlayInfo.pluginTitle);
 * without it, only where. Plain text, drawn by React.
 */
export function guestNoteText(ownerName: string, pluginTitle?: string): string {
  const owner = ownerName.trim() === '' ? 'the owner' : ownerName
  const where = `Open on ${owner}'s screen.`
  return pluginTitle === undefined || pluginTitle.trim() === '' ? where : `${where} ${pluginTitle} does not show its windows to guests.`
}

/** What an html overlay's body shows in this view. */
export type HtmlBody =
  | { kind: 'page' }
  | { kind: 'none' }
  /** The owner's other view: where the page is, and Take over (design-web.md §5.4). */
  | { kind: 'held'; device: string }
  /** A guest: the note (guestNoteText), with nothing to press. */
  | { kind: 'note'; text: string }

export interface HtmlBodyShell {
  /** Server mode's hidden page (shell-kind isHiddenPage): never a perView copy. */
  hiddenPage: boolean
  /** This view is a guest's; its owner's name is the guest hint's (shell-kind currentGuest). */
  guest?: { ownerName: string }
  /** Whether this view holds a non-perView page (shell-kind holdsPage). */
  holds(heldBy: PageHolder | undefined): boolean
}

/**
 * The body of an html overlay here. A perView one loads its own copy in every eligible view, never in the hidden
 * page; a final refusal of this view's connect (`refused`) shows a guest the note (a shared tab's overlay whose
 * opener is hidden from it is in its list, but has no copy for it) and an owner view nothing. Any other overlay
 * has one holder: the holder shows the page (unless it is waiting for a browser), the owner's other views where it
 * is with Take over, and a guest the note.
 */
export function htmlBodyOf(overlay: OverlayInfo, shell: HtmlBodyShell, refused?: OverlayCopyRefusal): HtmlBody {
  const note = (): HtmlBody => ({ kind: 'note', text: guestNoteText(shell.guest?.ownerName ?? '', overlay.pluginTitle) })
  if (overlay.perView === true) {
    if (shell.hiddenPage) return { kind: 'none' }
    if (refused === undefined) return { kind: 'page' }
    return shell.guest !== undefined && refused === 'not-allowed' ? note() : { kind: 'none' }
  }
  if (!shell.holds(overlay.heldBy)) return shell.guest !== undefined ? note() : { kind: 'held', device: overlay.heldBy?.device ?? 'Desktop' }
  return overlay.waiting === true ? { kind: 'none' } : { kind: 'page' }
}

/** The first wait before a refused (`cap`) or failed connect is asked again, doubled each time up to the max. */
export const COPY_RETRY_FIRST_MS = 1000
/** main's connect cap counts 10 connects in 10 s per view (panel-ports.ts CONNECT_WINDOW_MS): never wait longer. */
export const COPY_RETRY_MAX_MS = 10_000

/** The wait before connect attempt `attempt` (0 = the first retry). */
export function copyRetryDelay(attempt: number): number {
  return Math.min(COPY_RETRY_MAX_MS, COPY_RETRY_FIRST_MS * 2 ** Math.max(0, attempt))
}

/** What the stack shows for this view's copy: its loader, or the final refusal. */
export interface CopyLineState {
  loading: boolean
  refused?: OverlayCopyRefusal
}

/** The channels and the frame, as a CopyLine drives them (HtmlOverlay; fakes in tests). */
export interface CopyLineDeps {
  /** This view's access as the shell hints it (main decides again by the view it bound). */
  access: ViewAccess
  /** `overlays.ready`: mint this view's copy for the page's new port. */
  ready(): Promise<OverlayReadyAnswer | undefined>
  /** `overlays.loaded { copy }`. */
  loaded(copy: string): void
  /** `overlays.message { copy }`. */
  message(copy: string, text: string): void
  /** `overlays.release { copy }`: a plain let-go. */
  release(copy: string): void
  /** `overlays.release { hide: true }`: a read guest's hide. */
  hide(): void
  /** `overlays.close`: for everyone. */
  close(): void
  /** `overlays.result { copy }`: true when main took it. */
  result(copy: string, value: unknown): Promise<boolean>
  /** Load the page again (a new port, a new copy). */
  reload(): void
  /** main hid this view's copy: the overlay leaves this view's stack. */
  hidden(): void
  /** The loader or the final refusal changed. */
  state(state: CopyLineState): void
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(timer: unknown): void
  log?(message: string): void
}

/** Where a page's messages go: its port (the shell's end). */
export interface CopyPagePort {
  post(text: string): void
}

type Phase = 'idle' | 'asking' | 'waiting' | 'live' | 'refused'

/** One view's copy of one perView overlay, across the loads of its frame (see the header). */
export class CopyLine {
  /** The load generation: an answer or a timer of an older load is that load's, never this one's. */
  private visit = 0
  private phase: Phase = 'idle'
  private port: CopyPagePort | undefined
  private copy: string | undefined
  /** main's events for copies not named yet (an answer in flight), by copy id; bounded together. */
  private early = new Map<string, string[]>()
  private earlyCount = 0
  private earlyHide = new Set<string>()
  private earlyReload = new Set<string>()
  /** The page's posts before its copy is known (bounded like the page SDK's own queue). */
  private held: string[] = []
  /** The page said it has drawn before its copy was known. */
  private drawn = false
  private attempt = 0
  private timer: unknown
  private current: CopyLineState = { loading: true }

  constructor(private readonly deps: CopyLineDeps) {}

  /** A load of the frame has its port: ask for this view's copy. Returns the load's end (release). */
  attach(port: CopyPagePort): () => void {
    this.end()
    const visit = ++this.visit
    this.port = port
    this.attempt = 0
    this.report({ loading: true })
    this.ask()
    return () => {
      if (visit === this.visit) this.end()
    }
  }

  /** `overlays.message` for this overlay: to the page when it names the live copy, buffered while one is asked for. */
  fromMain(copy: string, text: string): void {
    if (this.phase === 'live' && copy === this.copy) {
      this.port?.post(text)
      return
    }
    if (this.phase !== 'asking') return
    if (this.earlyCount >= MAX_QUEUED_MESSAGES) {
      this.deps.log?.('overlay message dropped: its copy is not answered yet and the queue is full')
      return
    }
    const list = this.early.get(copy) ?? []
    list.push(text)
    this.early.set(copy, list)
    this.earlyCount++
  }

  /** `overlays.hide` for this overlay (the opener hid this view's copy, or a read guest's hide reached this view). */
  mainHide(copy: string): void {
    if (this.phase === 'live' && copy === this.copy) {
      this.taken()
      this.deps.hidden()
    } else if (this.phase === 'asking') this.earlyHide.add(copy)
  }

  /** `overlays.reload` for this overlay: main dropped the copy; the page loads again as a new one. */
  mainReload(copy: string): void {
    if (this.phase === 'live' && copy === this.copy) {
      this.taken()
      this.deps.reload()
    } else if (this.phase === 'asking') this.earlyReload.add(copy)
  }

  /** The page posted a message (JSON text, not a result). */
  fromPage(text: string): void {
    if (this.phase === 'live' && this.copy !== undefined) {
      this.deps.message(this.copy, text)
      return
    }
    if (this.phase !== 'asking' && this.phase !== 'waiting') return
    if (this.held.length < MAX_QUEUED_MESSAGES) this.held.push(text)
    else this.deps.log?.('overlay message dropped: the page has no copy yet and the queue is full')
  }

  /** The page says it has drawn (`ccPanel.ready()`): this copy's loader goes. */
  pageDrawn(): void {
    if (this.phase === 'live' && this.copy !== undefined) {
      this.deps.loaded(this.copy)
      this.report({ loading: false })
    } else if (this.phase === 'asking' || this.phase === 'waiting') this.drawn = true
  }

  /**
   * The page's `{ result }`, by this view's access (resultActionOf). `onRefused` lets the page answer again when
   * main refused the value (or there was no copy to answer for).
   */
  pageResult(value: unknown, onRefused: () => void): void {
    const action = resultActionOf(this.deps.access)
    if (action === 'hide') return this.deps.hide()
    if (action === 'close') return this.deps.close()
    const copy = this.phase === 'live' ? this.copy : undefined
    if (copy === undefined) {
      this.deps.log?.('overlay result not sent: the page has no copy yet')
      onRefused()
      return
    }
    this.deps.result(copy, value).then(
      (accepted) => {
        if (accepted) return
        this.deps.log?.('overlay result refused (not JSON, or too large)')
        onRefused()
      },
      (err: unknown) => {
        this.deps.log?.(`overlay result refused: ${String(err)}`)
        onRefused()
      }
    )
  }

  private ask(): void {
    const visit = this.visit
    this.phase = 'asking'
    this.deps.ready().then(
      (answer) => this.answered(visit, answer),
      (err: unknown) => this.answered(visit, undefined, err)
    )
  }

  private answered(visit: number, answer: OverlayReadyAnswer | undefined, err?: unknown): void {
    if (visit !== this.visit) {
      // The load ended (or another began) before main answered: let that copy go.
      if (answer !== undefined && 'copy' in answer) this.deps.release(answer.copy)
      return
    }
    if (err !== undefined) {
      this.deps.log?.(`overlay copy connect failed: ${String(err)}`)
      return this.retry()
    }
    if (answer === undefined || 'refused' in answer) {
      const reason: OverlayCopyRefusal = answer?.refused ?? 'not-per-view'
      if (reason === 'cap') return this.retry()
      this.clearBuffers()
      this.phase = 'refused'
      this.report({ loading: false, refused: reason })
      return
    }
    const copy = answer.copy
    const early = this.early.get(copy) ?? []
    const hide = this.earlyHide.has(copy)
    const reload = this.earlyReload.has(copy)
    const held = this.held
    const drawn = this.drawn
    this.clearBuffers()
    this.phase = 'live'
    this.copy = copy
    this.attempt = 0
    // main took this copy back before its answer arrived: nothing goes to the page or main.
    if (hide) return this.mainHide(copy)
    if (reload) return this.mainReload(copy)
    for (const text of early) this.port?.post(text)
    for (const text of held) this.deps.message(copy, text)
    if (drawn) this.deps.loaded(copy)
    this.report({ loading: answer.loaded !== true && !drawn })
  }

  /** A `cap` refusal or a failed call: ask again later for the same load (the page keeps its port and posts). */
  private retry(): void {
    const visit = this.visit
    this.phase = 'waiting'
    const delay = copyRetryDelay(this.attempt++)
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
    this.timer = set(() => {
      this.timer = undefined
      if (visit === this.visit && this.phase === 'waiting') this.ask()
    }, delay)
  }

  /** main released the live copy itself (a hide, a reload): never released again from here. */
  private taken(): void {
    this.copy = undefined
    this.phase = 'idle'
  }

  /** The current load ends: its live copy is let go (a plain release), its retry and buffers dropped. */
  private end(): void {
    if (this.timer !== undefined) {
      const clear = this.deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>))
      clear(this.timer)
      this.timer = undefined
    }
    if (this.phase === 'live' && this.copy !== undefined) this.deps.release(this.copy)
    this.visit++
    this.port = undefined
    this.copy = undefined
    this.phase = 'idle'
    this.clearBuffers()
  }

  private clearBuffers(): void {
    this.early.clear()
    this.earlyCount = 0
    this.earlyHide.clear()
    this.earlyReload.clear()
    this.held = []
    this.drawn = false
  }

  private report(next: CopyLineState): void {
    if (next.loading === this.current.loading && next.refused === this.current.refused) return
    this.current = next
    this.deps.state(next)
  }
}
