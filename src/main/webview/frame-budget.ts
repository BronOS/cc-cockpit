// An app-wide budget on off-screen pages' painting (backlog item offscreen-frame-area-cap; numbers
// in design-web-browser.md §3.3 "Frame budget"). Every paint of a streamed page is JPEG-encoded on
// main's thread, so the cost is about painted area per second, summed over the pages that animate
// (4 per project, 12 per app). Past BUDGET_AREA_RATE the pages' frame rates are lowered together,
// never below FRAME_RATE_FLOOR, and restored as pages stop animating or close.
//
// Pure: pages, the clock and the Electron call (`setRate`, behind electron-offscreen-webview.ts) are
// injected. Main decides; a page and a viewer never name a rate.

/** The rate a page paints at when the budget is not binding (design-web-browser.md §3.3). */
export const FRAME_RATE_MAX = 30
/** The lowest rate the budget sets: a page stays usable (5 fps) however many animate. */
export const FRAME_RATE_FLOOR = 5
/**
 * Painted CSS px per second, summed over animating pages with viewers, that main is allowed.
 * Measured 2026-11-20 on the Debian VM (16 cores, headless Electron 45.1.0, the bench's flood of 8
 * tabs beside the pages, p99 limit 20 ms), unbudgeted at 30 fps, main's p99 by pages at 1280x800 /
 * 1920x1080: 1: 5.7 / 8.4 ms; 4: 6.2 / 9.9; 8: 6.7 / 12.4; 12: 7.5 / 36.5 (area rate 746 Mpx/s, max
 * 95 ms). The knee is between 8 and 12 big pages (500-750 Mpx/s). 250 Mpx/s (4 pages at 1920x1080 at
 * 30 fps, p99 9.9 ms) leaves margin for a busier VM: 12 pages at 1920x1080 are then held to 12 fps
 * and measured p99 13.7 ms (10.4 ms at a 120 Mpx/s trial, 17.2 ms at 400 Mpx/s).
 */
export const BUDGET_AREA_RATE = 250_000_000
/** A page counts as animating when it painted at least this many times in the last WINDOW_MS. */
export const ANIMATING_PAINTS = 3
export const WINDOW_MS = 1000

export interface BudgetPage {
  /** Set the page's frame rate (the adapter's `webContents.setFrameRate`). */
  setRate(rate: number): void
}

interface Entry {
  page: BudgetPage
  area: number
  /** A browser shows the page (the adapter's painting flag). */
  viewed: boolean
  /** Paint times (ms) within the window. */
  paints: number[]
  rate: number
}

export class FrameBudget {
  private readonly pages = new Map<string, Entry>()

  constructor(
    private readonly now: () => number,
    private readonly budget: number = BUDGET_AREA_RATE
  ) {}

  add(id: string, page: BudgetPage, width: number, height: number): void {
    this.pages.set(id, { page, area: width * height, viewed: false, paints: [], rate: FRAME_RATE_MAX })
  }

  remove(id: string): void {
    this.pages.delete(id)
    this.evaluate()
  }

  resize(id: string, width: number, height: number): void {
    const e = this.pages.get(id)
    if (e) e.area = width * height
  }

  setViewed(id: string, viewed: boolean): void {
    const e = this.pages.get(id)
    if (!e) return
    e.viewed = viewed
    e.paints = []
  }

  /** A paint happened (cheap; the decision is made by `evaluate`, on a timer). */
  paint(id: string): void {
    const e = this.pages.get(id)
    if (!e || !e.viewed) return
    const t = this.now()
    e.paints.push(t)
    if (e.paints.length > 4 * FRAME_RATE_MAX) e.paints.splice(0, e.paints.length - 4 * FRAME_RATE_MAX)
  }

  /** Recompute every page's rate; calls `setRate` only for a page whose rate changed. */
  evaluate(): void {
    const t = this.now()
    let sum = 0
    const animating: Entry[] = []
    for (const e of this.pages.values()) {
      while (e.paints.length > 0 && e.paints[0]! <= t - WINDOW_MS) e.paints.shift()
      if (e.viewed && e.paints.length >= ANIMATING_PAINTS) {
        animating.push(e)
        sum += e.area
      }
    }
    // One rate for all animating pages: the sum of area x rate fits the budget, within [floor, max].
    const shared = sum === 0 ? FRAME_RATE_MAX : Math.max(FRAME_RATE_FLOOR, Math.min(FRAME_RATE_MAX, Math.floor(this.budget / sum)))
    for (const e of this.pages.values()) {
      // A page that is not animating goes back to the top rate: its paints cost nothing, and a
      // page that wakes up is lowered at the next evaluation.
      const want = animating.includes(e) ? shared : FRAME_RATE_MAX
      if (want !== e.rate) {
        e.rate = want
        e.page.setRate(want)
      }
    }
  }
}
