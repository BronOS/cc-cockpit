// The Original frame: a document's own HTML and CSS (a designed mail) in a sandboxed srcdoc frame with no script
// and no network (original.mjs explains the walls). Over a limit it draws nothing (ok: false): show the renderer.
import { originalDocument, FRAME_SANDBOX } from './original.mjs'
import { env, h } from './dom.mjs'

const defaultParse = (html) => new DOMParser().parseFromString(html, 'text/html')

export function mountOriginal(container, opts = {}) {
  const { doc } = env(opts)
  const parsed = (opts.parse || defaultParse)(typeof opts.html === 'string' ? opts.html : '')
  const assets = new Map()
  const given = opts.assets
  const assetOf = (id) => {
    if (assets.has(id)) return assets.get(id)
    if (typeof given === 'function') return given(id)
    return given && Object.prototype.hasOwnProperty.call(given, id) ? given[id] : null
  }
  let built = originalDocument(parsed, { asset: assetOf })
  if (!built) return { el: null, ok: false, frame: null, links: [], setAsset() {}, destroy() {} }
  const frame = h(doc, 'iframe', {
    class: 'cc-kit-original-frame',
    sandbox: FRAME_SANDBOX,
    title: typeof opts.title === 'string' && opts.title ? opts.title : 'Original',
    referrerpolicy: 'no-referrer',
  })
  frame.setAttribute('srcdoc', built.html)
  const el = h(doc, 'div', { class: 'cc-kit-original' }, frame)
  container.appendChild(el)
  return {
    el,
    ok: true,
    frame,
    links: built.links,
    setAsset(id, dataUrl) {
      if (!built || !built.assets.has(id)) return
      assets.set(id, dataUrl)
      const next = originalDocument(parsed, { asset: assetOf })
      if (!next) return
      built = next
      frame.setAttribute('srcdoc', built.html)
    },
    destroy() {
      if (el.parentNode) el.parentNode.removeChild(el)
    },
  }
}
