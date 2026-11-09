'use strict'
// The `usage-meter` slot page in the app's top bar: today's API-equivalent spend and, when core knows
// it, the 5-hour rate-limit window. The host sends `meter` (ccUsageView.meterView's result, or null
// before the first aggregate); the page sends `hello` and `open` (a click: show the Usage panel).
// The page reports its width (ccMeterWidth, dist/lib/meter-width.js) so the rest of the bar drags.

const row = document.getElementById('row')
const width = ccMeterWidth.watchWidth(row, () => ccPanel.slot, typeof ResizeObserver === 'function' ? ResizeObserver : undefined)

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function meterEl(m) {
  const b = el('button', 'cc-btn cc-ghost meter')
  b.type = 'button'
  b.title = m.tooltip
  b.setAttribute('aria-label', m.five ? `${m.text}, ${m.five.text}. Show the Usage panel` : `${m.text}. Show the Usage panel`)
  b.appendChild(el('span', 'cost', m.text))
  if (m.five) {
    const five = el('span', 'five')
    if (m.five.warn) five.dataset.warn = ''
    five.appendChild(el('span', '', m.five.text))
    const bar = el('span', 'bar')
    bar.setAttribute('aria-hidden', 'true')
    const fill = el('span')
    fill.style.width = `${Math.max(0, Math.min(100, Number(m.five.percent) || 0))}%`
    bar.appendChild(fill)
    five.appendChild(bar)
    b.appendChild(five)
  }
  b.addEventListener('click', () => ccPanel.post({ type: 'open' }))
  return b
}

ccPanel.onMessage((m) => {
  if (!m || typeof m !== 'object' || m.type !== 'meter') return
  if (m.meter && typeof m.meter === 'object' && typeof m.meter.text === 'string') row.replaceChildren(meterEl(m.meter))
  else row.replaceChildren()
  // The first message comes after the shell said this is a slot; an unchanged size is no observer
  // event, so report on every message (repeats are dropped).
  width.report()
})

ccPanel.post({ type: 'hello' })
