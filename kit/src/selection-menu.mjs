// A small menu above a selection in a rendered document: the page's actions (Note, Ask about this). Mouse and
// touch alike (it follows selectionchange); an action runs on its own click only, with the selection as it was.
import { h, listen, show } from './dom.mjs'

export function mountSelectionMenu(rendered, opts = {}) {
  const doc = opts.doc || rendered.root.ownerDocument
  const offs = []
  const menu = h(doc, 'div', { class: 'cc-kit-selmenu', role: 'toolbar', 'aria-label': 'Selection', hidden: true })
  let current = null
  const hide = () => {
    current = null
    show(menu, false)
  }
  for (const action of Array.isArray(opts.actions) ? opts.actions : []) {
    if (!action || typeof action.run !== 'function') continue
    const b = h(doc, 'button', { type: 'button', 'data-action': String(action.id) }, String(action.label))
    // Pressing the button must not clear the selection it acts on.
    listen(b, 'mousedown', (e) => e.preventDefault && e.preventDefault(), offs)
    listen(
      b,
      'click',
      () => {
        const sel = current
        if (!sel) return
        hide()
        action.run(sel)
      },
      offs
    )
    menu.appendChild(b)
  }
  const update = () => {
    const sel = rendered.selection()
    if (!sel) return hide()
    current = sel
    const range = rendered.rangeOf(sel.start, sel.end)
    const rect = range && typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null
    if (rect) {
      // Above the selection (a phone's own menu sits below it), kept on screen.
      menu.style.left = `${Math.max(4, rect.left)}px`
      menu.style.top = `${Math.max(4, rect.top - 40)}px`
    }
    show(menu, true)
  }
  listen(doc, 'selectionchange', update, offs)
  listen(rendered.root, 'mouseup', update, offs)
  listen(rendered.root, 'keyup', update, offs)
  ;(doc.body || rendered.root).appendChild(menu)
  return {
    el: menu,
    destroy() {
      for (const off of offs.splice(0)) off()
      if (menu.parentNode) menu.parentNode.removeChild(menu)
    },
  }
}
