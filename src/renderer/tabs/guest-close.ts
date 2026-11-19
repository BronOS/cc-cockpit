// D-9 (design-guests §7, spec-review 6): a write guest closes only the tabs it opened; its Close on any
// other shared tab asks the owner. Main answers that `tabs.close` with `{ asked: true }` and shows every
// owner view an approval (`tabs.guestCloseAsk`, ShellNotices' GuestCloseConfirm); the tab then closes
// (`tabs.removed` reaches the guest too) or stays. Main tells the asking guest's views the outcome
// (`tabs.guestCloseDone { tabId, closed }`, also `closed: false` on its 60 s timeout), so the notice says
// "Asked <owner> to close <title>." until then and "<owner> kept the tab open." at once on a Keep open. Our
// own wait (GUEST_CLOSE_WAIT_MS) stays as the fallback for an answer lost to a reconnect.
//
// The texts and the notices' timing, DOM-free so unit tests run them in plain Node (TabsPane draws them).
// Every text is plain text (React escapes it): a tab title and a guest's name are other people's words.

/** How long the guest waits for the owner before the notice says the tab was kept: main's 60 s, and a margin. */
export const GUEST_CLOSE_WAIT_MS = 65_000

/** How long "<owner> kept the tab open." stays before it goes by itself. */
export const KEPT_OPEN_SHOW_MS = 8_000

/** The owner's name when the hint has none (the Web access setting's default, D-24). */
export const DEFAULT_OWNER_NAME = 'Host'

export function askedCloseText(owner: string, title: string): string {
  return `Asked ${owner} to close ${title}.`
}

export function keptOpenText(owner: string): string {
  return `${owner} kept the tab open.`
}

/** The owner's approval's title (GuestCloseConfirm). */
export function guestCloseAskTitle(guestName: string, title: string): string {
  return `${guestName} asks to close ${title}.`
}

/** The approval's text under the title: what Close does, and that keeping it is the default. */
export const GUEST_CLOSE_ASK_TEXT =
  'Closing the tab ends what runs in it for everyone. Keep open leaves it as it is; no answer in a minute keeps it too.'

export interface GuestCloseNotice {
  tabId: string
  kind: 'asked' | 'kept'
  text: string
}

export interface GuestCloseTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realTimers: GuestCloseTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

/**
 * The guest's close notices, one per tab, newest last. `asked` starts (or restarts) a tab's wait;
 * `tabsChanged` drops the notice of a tab that left the strip (closed by the owner's answer, or gone
 * any other way: the notice is about that tab, and it is gone); after GUEST_CLOSE_WAIT_MS a waiting
 * notice turns into the kept-open line, which goes after KEPT_OPEN_SHOW_MS. `onChange` hears every list.
 */
export class GuestCloseNotices {
  private list: readonly GuestCloseNotice[] = []
  private readonly timers = new Map<string, unknown>()
  /** The owner's name each waiting notice was asked of, for its kept-open line. */
  private readonly owners = new Map<string, string>()
  private disposed = false

  constructor(
    private readonly onChange: (list: readonly GuestCloseNotice[]) => void,
    private readonly clock: GuestCloseTimers = realTimers
  ) {}

  get notices(): readonly GuestCloseNotice[] {
    return this.list
  }

  /** The guest's Close of `tabId` was answered `{ asked: true }`: the owner was asked. */
  asked(tabId: string, title: string, owner: string): void {
    if (this.disposed) return
    this.stop(tabId)
    this.owners.set(tabId, owner)
    this.set([...this.list.filter((n) => n.tabId !== tabId), { tabId, kind: 'asked', text: askedCloseText(owner, title) }])
    this.timers.set(
      tabId,
      this.clock.setTimeout(() => {
        this.timers.delete(tabId)
        this.keep(tabId)
      }, GUEST_CLOSE_WAIT_MS)
    )
  }

  /**
   * Main's `tabs.guestCloseDone` for this guest: `closed` drops the notice (`tabs.removed` would too, maybe
   * later), Keep open (or main's timeout) turns it into the kept-open line at once. A tab with no waiting
   * notice (already answered, dismissed, or asked from another view of this guest) changes nothing.
   */
  answered(tabId: string, closed: boolean): void {
    if (this.disposed) return
    if (closed) this.drop(tabId)
    else this.keep(tabId)
  }

  /** A waiting notice becomes "<owner> kept the tab open.", which goes by itself after KEPT_OPEN_SHOW_MS. */
  private keep(tabId: string): void {
    if (!this.list.some((n) => n.tabId === tabId && n.kind === 'asked')) return
    this.stop(tabId)
    const owner = this.owners.get(tabId) ?? DEFAULT_OWNER_NAME
    this.set(this.list.map((n) => (n.tabId === tabId ? { tabId, kind: 'kept', text: keptOpenText(owner) } : n)))
    this.timers.set(
      tabId,
      this.clock.setTimeout(() => {
        this.timers.delete(tabId)
        this.drop(tabId)
      }, KEPT_OPEN_SHOW_MS)
    )
  }

  /** The strip changed: a notice whose tab is no longer in it goes (with its timer). */
  tabsChanged(has: (tabId: string) => boolean): void {
    for (const n of this.list) if (!has(n.tabId)) this.drop(n.tabId)
  }

  /** The person dismissed a notice. */
  drop(tabId: string): void {
    this.stop(tabId)
    this.owners.delete(tabId)
    if (!this.list.some((n) => n.tabId === tabId)) return
    this.set(this.list.filter((n) => n.tabId !== tabId))
  }

  dispose(): void {
    this.disposed = true
    for (const id of [...this.timers.keys()]) this.stop(id)
  }

  private stop(tabId: string): void {
    const t = this.timers.get(tabId)
    if (t === undefined) return
    this.clock.clearTimeout(t)
    this.timers.delete(tabId)
  }

  private set(next: readonly GuestCloseNotice[]): void {
    this.list = next
    if (!this.disposed) this.onChange(next)
  }
}
