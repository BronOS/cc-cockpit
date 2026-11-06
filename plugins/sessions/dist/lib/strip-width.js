'use strict'
// The strip page's width report (slots/strip.js): the top bar sizes the `sessions-strip` frame to
// what the page says it draws (`ccPanel.slot.setWidth`), and what the strip does not need of the bar
// stays a drag region (macOS: the bar is the window's title bar, and an iframe can never drag it).
// Split out of the page with the observer and the slot passed in, so node:test runs it with fakes.
// A classic <script src="/dist/lib/strip-width.js"> sets the global `ccStripWidth`.
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.ccStripWidth = api
})(typeof globalThis === 'object' ? globalThis : this, function () {
  /**
   * Watch `row` (the entries, laid out at their own `max-content` width, NOT the frame's: a row that
   * filled its frame would report the frame's width back and could never shrink, and would grow
   * with the bar's cap) and report its width, rounded up so the last entry is not clipped. An empty
   * row reports 0: no entry, no room taken, the whole bar drags.
   *
   * `getSlot` is read on every report, not once: the shell tells the page it is a slot only after
   * load, just before its port, so `ccPanel.slot` is undefined when this script starts. The page
   * calls `report()` again once it hears from its host (by then the slot is set); the observer
   * covers every later change (entries, font, zoom). A width equal to the last one sent is not sent
   * again; the shell drops repeats too, this only saves a message.
   *
   * Returns `{ report, stop }`.
   */
  function watchWidth(row, getSlot, Observer) {
    let sent
    function report() {
      const slot = getSlot()
      if (!slot || typeof slot.setWidth !== 'function') return
      const width = row.childElementCount === 0 ? 0 : Math.ceil(row.getBoundingClientRect().width)
      if (width === sent) return
      sent = width
      slot.setWidth(width)
    }
    const observer = typeof Observer === 'function' ? new Observer(report) : undefined
    if (observer) observer.observe(row)
    return {
      report,
      stop() {
        if (observer) observer.disconnect()
      }
    }
  }

  return { watchWidth }
})
