// The page's own Discuss button and the error state.
import { features, retry } from './connect.mjs'
import { env, h, listen } from './dom.mjs'

/**
 * Discuss with Claude from the page: opens core's popover (new session or a Claude tab), where the person sends.
 * The button sends nothing. Null on an app or an overlay without page-started Discuss.
 */
export function mountDiscussButton(container, opts = {}) {
  const { doc, panel } = env(opts)
  if (!features(panel).discuss) return { el: null, destroy() {} }
  const offs = []
  const el = h(doc, 'button', { type: 'button', class: 'cc-kit-discuss' }, typeof opts.label === 'string' && opts.label ? opts.label : 'Discuss with Claude')
  listen(el, 'click', () => Promise.resolve(panel.overlay.discuss()).catch(() => {}), offs)
  container.appendChild(el)
  return {
    el,
    destroy() {
      for (const o of offs.splice(0)) o()
      if (el.parentNode) el.parentNode.removeChild(el)
    },
  }
}

/** The error state: the message as text, and Try again when the host offers it (the owner's). */
export function mountError(container, opts = {}) {
  const { doc, panel } = env(opts)
  const offs = []
  const el = h(doc, 'div', { class: 'cc-kit-error', role: 'alert' }, h(doc, 'p', { class: 'cc-kit-error-text' }, `⚠ ${typeof opts.message === 'string' ? opts.message : 'This could not be loaded.'}`))
  if (opts.retry === true) {
    const b = h(doc, 'button', { type: 'button', class: 'cc-kit-primary' }, 'Try again')
    listen(b, 'click', () => (typeof opts.onRetry === 'function' ? opts.onRetry() : retry(panel)), offs)
    el.appendChild(b)
  }
  container.appendChild(el)
  return {
    el,
    destroy() {
      for (const o of offs.splice(0)) o()
      if (el.parentNode) el.parentNode.removeChild(el)
    },
  }
}
