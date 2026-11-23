// A fixed-window rate counter: HostApi's per-plugin budgets (`host-api.ts`), the mail frame's link
// opens and the upload begins per device (`files/uploads.ts`). Pure, no imports, so a module that needs
// it does not pull in HostApi's.

/**
 * A fixed-window counter per key (a plugin id; an upload's device id): `take` is false once the window's
 * budget is spent. `max` is a number, or a function of the key read on every take (the person's
 * per-plugin limits: a change applies to the next call).
 */
export class RateWindow {
  private readonly windows = new Map<string, { start: number; count: number }>()

  constructor(
    private readonly max: number | ((key: string) => number),
    private readonly windowMs: number
  ) {}

  /** The budget of `key` now. */
  limit(key: string): number {
    return typeof this.max === 'number' ? this.max : this.max(key)
  }

  take(key: string, now = Date.now()): boolean {
    let win = this.windows.get(key)
    if (!win || now - win.start >= this.windowMs) {
      // Keys are plugin ids this host runs (checked before) or signed-in devices, so the map stays small.
      win = { start: now, count: 0 }
      this.windows.set(key, win)
    }
    if (win.count >= this.limit(key)) return false
    win.count++
    return true
  }

  /**
   * Give back a token whose call was refused before it did anything (an ended tab, a full queue,
   * a spec the overlay manager rejects): a plugin retrying a refused call must not lock itself
   * out. If the window rolled over in between, the token goes back to the new window; at most one
   * extra per refused call, and a refused call started nothing.
   */
  refund(key: string): void {
    const win = this.windows.get(key)
    if (win && win.count > 0) win.count--
  }
}
