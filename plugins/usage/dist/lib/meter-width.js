'use strict'
// The meter page's width report (slots/meter.js): the top bar sizes a slot frame to what the page
// says it draws (`ccPanel.slot.setWidth`), so the rest of the bar still drags the window (macOS).
// The same rule as cockpit.sessions' strip (its dist/lib/strip-width.js; a plugin page loads only
// its own files, so it is a copy): measure an element laid out at its own `max-content` width, never
// the frame, which would only echo its width back; an empty one is 0. Split out of the page with the
// observer and the slot passed in, so node:test runs it with fakes. A classic
// <script src="/dist/lib/meter-width.js"> sets the global `ccMeterWidth`.
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.ccMeterWidth = api
})(typeof globalThis === 'object' ? globalThis : this, function () {
  /**
   * Watch `row` and report its width, rounded up. `getSlot` is read on every report: the shell says
   * the page is a slot only after load. A width equal to the last one sent is not sent again.
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
