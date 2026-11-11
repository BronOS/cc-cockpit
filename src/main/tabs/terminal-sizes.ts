// Which view sizes a tab's pty (design-web.md §5.2 "Size", plan Task 15).
//
// A tab can be shown by several views at once (the desktop window and browsers, a phone among
// them), each with its own pane size. One pty has one size, and every resize redraws Claude's whole
// screen, so the pty does not follow every view's resize observer: main remembers each view's size
// and the pty takes a view's size only when that view explicitly takes the terminal:
//
// - typing after another view typed: the take waits TAKE_DEBOUNCE_MS, and the sizing view typing
//   meanwhile cancels it, so a phone and a desktop typing in turn do not redraw Claude per keystroke;
// - "Fit to this screen" (`tabs.fit`), at once.
//
// The sizing view's own resizes apply at once (dragging the desktop window still reflows Claude,
// as today). A view that is not the sizer is only remembered; it draws at the pty's size (scaled or
// letterboxed, terminal-session.ts) until it takes. With only the desktop (web access off), it is
// always the sizer: today's behaviour. A desktop that sizes the tab fits its pane itself, at once
// (TabManager marks its size items `local`), rather than waiting a round trip for each size item.
//
// Hidden views (a minimized window, a browser tab in the background: `tabs.visibility`) never take:
// a size nobody looks at must not shrink Claude for the person who does. When the sizing view
// leaves (its connection closed) or is hidden, the size falls back to the remaining visible view that
// was active last (typed or reported a size); with none, the pty keeps its size, and the first view
// that shows again takes it. A hidden view that is the tab's only view still sizes it (nobody else
// can: a restarted tab in a minimized window must not stay at 80 x 24).
//
// View ids come from main (router CallView, never a payload); tab ids are checked by TabManager
// before they get here. No Electron, no timers of its own beyond the injected ones: vitest drives it.
//
// The rule itself lives in views/view-sizes.ts, shared with terminal overlays (OverlayManager).

import { ViewSizes, type ViewSizesDeps } from '../views/view-sizes'

export { TAKE_DEBOUNCE_MS } from '../views/view-sizes'

export type TerminalSizesDeps = ViewSizesDeps<string>

export class TerminalSizes extends ViewSizes<string> {
  /** The tab is gone. */
  tabGone(tabId: string): void {
    this.forget(tabId)
  }
}
