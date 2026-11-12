// The `window.open` budget a web page gets (a plugin webview panel, a remote desktop window): a
// page calling it in a loop must not flood the system browser with tabs. One rule for both, so a
// remote server's page cannot open more than a webview panel's page can. No Electron import.

/** At most this many page-opened windows per view in OPEN_WINDOW_MS; calls past it are dropped. */
export const MAX_OPENS_PER_VIEW = 3
export const OPEN_WINDOW_MS = 10_000

/** One view's sliding window of `window.open` calls. */
export class OpenBudget {
  private opens: number[] = []

  /** Count one open at `now` (ms) when the budget allows it; false: dropped, nothing counted. */
  take(now: number): boolean {
    this.opens = this.opens.filter((t) => now - t < OPEN_WINDOW_MS)
    if (this.opens.length >= MAX_OPENS_PER_VIEW) return false
    this.opens.push(now)
    return true
  }
}
