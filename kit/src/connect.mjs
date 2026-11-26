// The page's end of shared-page.js (kit/host): init, the plugin's state (joined from chunks), loading and
// failure. Every other message of the plugin's host goes to the page's own `message` handler.
import { safeHref } from './sanitize.mjs'

const ACCESS = ['owner', 'write', 'read']
/** The most chunks one state may come in (the host's MAX_CHUNKS); more is a broken stream, dropped. */
const MAX_CHUNKS = 256

/** Which of the app's overlay features this copy has (undefined members on an older app or overlay). */
export function features(panel = globalThis.ccPanel) {
  return {
    notes: !!(panel && panel.notes),
    ask: !!(panel && panel.ask),
    discuss: !!(panel && panel.overlay && typeof panel.overlay.discuss === 'function'),
  }
}

/** Listens to the host's kit messages; returns the unsubscribe. */
export function connect(handlers = {}, opts = {}) {
  const panel = opts.panel || globalThis.ccPanel
  const call = (name, ...args) => {
    const fn = handlers[name]
    if (typeof fn === 'function') fn(...args)
  }
  // The chunks of one state, in order on the one port: { id, n, parts }.
  let chunks = null
  const onMessage = (m) => {
    if (!m || typeof m !== 'object' || typeof m.type !== 'string' || !m.type.startsWith('cc-kit.')) {
      call('message', m)
      return
    }
    switch (m.type) {
      case 'cc-kit.init':
        if (!ACCESS.includes(m.access)) return
        call('init', { access: m.access, tab: typeof m.tab === 'string' ? m.tab : '', features: features(panel) })
        return
      case 'cc-kit.state':
        chunks = null
        call('state', m.state)
        return
      case 'cc-kit.chunk': {
        const ok = Number.isInteger(m.i) && Number.isInteger(m.n) && m.n > 1 && m.n <= MAX_CHUNKS && typeof m.text === 'string'
        if (!ok) return
        if (m.i === 0) chunks = { id: m.id, n: m.n, parts: [] }
        // Out of order, another stream, or a missing start: drop it all until the next start.
        if (!chunks || chunks.id !== m.id || chunks.n !== m.n || chunks.parts.length !== m.i) {
          chunks = null
          return
        }
        chunks.parts.push(m.text)
        if (chunks.parts.length < chunks.n) return
        const text = chunks.parts.join('')
        chunks = null
        let state
        try {
          state = JSON.parse(text)
        } catch {
          return
        }
        call('state', state)
        return
      }
      case 'cc-kit.loading':
        call('loading')
        return
      case 'cc-kit.failed':
        call('failed', { message: typeof m.message === 'string' ? m.message : '', retry: m.retry === true })
        return
      default:
    }
  }
  const off = panel.onMessage(onMessage)
  return typeof off === 'function' ? off : () => {}
}

/** The error page's Try again: tells the host (which runs its retry for the owner only). From a click only. */
export function retry(panel = globalThis.ccPanel) {
  panel.post({ type: 'cc-kit.retry' })
}

/**
 * Asks the host to open `url` (a click on a link). Only http(s): the host opens it only when it is in the
 * document it holds, with this view's `from.view`. False when nothing was posted.
 */
export function postLink(url, panel = globalThis.ccPanel) {
  const href = safeHref(url)
  if (!href || !/^https?:/.test(href)) return false
  panel.post({ type: 'cc-kit.link', url: href })
  return true
}
