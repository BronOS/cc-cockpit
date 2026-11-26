// The side column's tabs (Details · Ask, a plugin's Reply). D7: the first tab is the last one the owner chose
// (makePage keeps it, from the { type: 'cc-kit.tab' } a click posts here) or the page's pick (a draft opens Reply).
// Under 700 px the bar sits at the bottom and a chosen tab opens full height with "← Back" (cc-kit.css).
import { env, h, listen, show, toggleClass } from './dom.mjs'

const TAB_ID = /^[a-z][a-z0-9-]{0,39}$/

export function mountSideTabs(container, opts = {}) {
  const { doc, panel } = env(opts)
  const offs = []
  const tabs = (Array.isArray(opts.tabs) ? opts.tabs : []).filter((t) => t && TAB_ID.test(t.id) && t.panel)
  const bar = h(doc, 'div', { class: 'cc-kit-tabbar', role: 'tablist' })
  const back = h(doc, 'button', { type: 'button', class: 'cc-kit-tab-back' }, '← Back')
  const body = h(doc, 'div', { class: 'cc-kit-tabbody' }, back)
  const el = h(doc, 'div', { class: 'cc-kit-tabs' }, bar, body)
  const buttons = new Map()
  let current = null

  const select = (id, byUser = false) => {
    if (!buttons.has(id)) return
    current = id
    for (const t of tabs) {
      const on = t.id === id
      const b = buttons.get(t.id)
      b.setAttribute('aria-selected', on ? 'true' : 'false')
      b.setAttribute('tabindex', on ? '0' : '-1')
      toggleClass(b, 'cc-kit-tab-on', on)
      show(t.panel, on)
    }
    toggleClass(el, 'cc-kit-tabs-open', byUser)
    if (typeof opts.onSelect === 'function') opts.onSelect(id, byUser)
  }
  for (const t of tabs) {
    const b = h(doc, 'button', { type: 'button', role: 'tab', class: 'cc-kit-tab', 'data-tab': t.id }, String(t.label))
    listen(
      b,
      'click',
      () => {
        select(t.id, true)
        // The person chose it: the host keeps it as the last used tab (the owner's views only).
        if (panel && typeof panel.post === 'function') panel.post({ type: 'cc-kit.tab', tab: t.id })
      },
      offs
    )
    buttons.set(t.id, b)
    bar.appendChild(b)
    t.panel.setAttribute('role', 'tabpanel')
    body.appendChild(t.panel)
  }
  listen(back, 'click', () => toggleClass(el, 'cc-kit-tabs-open', false), offs)
  container.appendChild(el)
  const first = typeof opts.selected === 'string' && buttons.has(opts.selected) ? opts.selected : tabs.length ? tabs[0].id : null
  if (first) select(first, false)
  return {
    el,
    select: (id) => select(id, false),
    selected: () => current,
    destroy() {
      for (const o of offs.splice(0)) o()
      if (el.parentNode) el.parentNode.removeChild(el)
    },
  }
}
