// The renderer: a document's HTML (or plain text) drawn through the allow-list sanitizer (sanitize.mjs: an inert
// parse, a walk into plain data, fresh elements; never innerHTML), plus what a page needs around it: text offsets,
// the selection as a note anchor, pictures that arrive later, notes marked in place, and links that only ask the
// host (postLink on a click).
import { ALLOWED_CLASSES, MAIL_CLASSES, TAG_CLASSES, isImageDataUrl, render, sanitizeTree } from './sanitize.mjs'
import { locate, makeAnchor } from './anchor.mjs'
import { postLink } from './connect.mjs'
import { elementsOf, env, h, listen, textNodesOf, toggleClass } from './dom.mjs'

/** Classes the sanitizer itself adds (an image placeholder): kept with `classes: 'none'`. */
const OWN_CLASSES = new Set(['img-missing'])

/** The parse of a document's HTML: inert (no script runs, nothing loads). */
const defaultParse = (html) => new DOMParser().parseFromString(html, 'text/html')

/** Drops every caller class from a sanitized tree (`classes: 'none'`). */
function stripClasses(nodes) {
  for (const n of nodes) {
    if ('text' in n) continue
    n.attrs = n.attrs.filter(([k, v]) => k !== 'class' || OWN_CLASSES.has(v))
    stripClasses(n.children)
  }
}

/** The text offset in `root` of a DOM boundary point (node, offset), or null when it is not inside root. */
export function offsetOf(root, node, offset) {
  let count = 0
  let found = null
  const walk = (n) => {
    if (n.nodeType === 3) {
      if (n === node) found = count + Math.min(offset, n.nodeValue.length)
      else count += n.nodeValue.length
      return
    }
    const kids = n.childNodes || []
    for (let i = 0; i < kids.length && found === null; i++) {
      if (n === node && i === offset) {
        found = count
        return
      }
      walk(kids[i])
    }
    if (found === null && n === node) found = count
  }
  walk(root)
  return found
}

/** The text node and offset in it at text offset `at` of `root` (the end of the last node for the very end). */
function pointAt(root, at) {
  let count = 0
  let last = null
  for (const t of textNodesOf(root)) {
    const len = t.nodeValue.length
    if (at < count + len) return { node: t, offset: at - count }
    count += len
    last = t
  }
  return last && at === count ? { node: last, offset: last.nodeValue.length } : null
}

/** Draws `input` into `target`; see README "Renderer". */
export function renderDocument(target, input, opts = {}) {
  const { doc, panel } = env(opts)
  const root = h(doc, 'div', { class: 'cc-kit-doc' })
  const offs = []
  if (input && typeof input.html === 'string') {
    const parsed = (opts.parse || defaultParse)(input.html)
    const tree = sanitizeTree(parsed && parsed.body ? parsed.body : parsed)
    if (opts.classes === 'none') stripClasses(tree)
    root.appendChild(render(tree, doc))
  } else {
    toggleClass(root, 'cc-kit-text', true)
    root.appendChild(doc.createTextNode(input && typeof input.text === 'string' ? input.text : ''))
  }
  const assetOf =
    typeof opts.assets === 'function'
      ? opts.assets
      : (id) => (opts.assets && Object.prototype.hasOwnProperty.call(opts.assets, id) ? opts.assets[id] : null)

  const setAsset = (id, dataUrl) => {
    if (typeof id !== 'string' || !isImageDataUrl(dataUrl)) return false
    let found = false
    for (const e of elementsOf(root)) {
      if (String(e.nodeName).toLowerCase() !== 'img' || e.getAttribute('data-asset') !== id) continue
      e.setAttribute('src', dataUrl)
      if (e.parentNode && e.parentNode.getAttribute) toggleClass(e.parentNode, 'pending', false)
      found = true
    }
    return found
  }
  for (const e of [...elementsOf(root)]) {
    if (String(e.nodeName).toLowerCase() !== 'img') continue
    const id = e.getAttribute('data-asset')
    const url = id ? assetOf(id) : null
    if (url) setAsset(id, url)
  }

  // A link asks the host on a click (the frame never navigates); the host opens only the document's own links.
  const onLink = typeof opts.onLink === 'function' ? opts.onLink : (url) => postLink(url, panel)
  listen(
    root,
    'click',
    (event) => {
      for (let n = event.target; n && n !== root; n = n.parentNode) {
        if (n.nodeType === 1 && String(n.nodeName).toLowerCase() === 'a') {
          if (typeof event.preventDefault === 'function') event.preventDefault()
          const href = n.getAttribute('href')
          if (href) onLink(href)
          return
        }
      }
    },
    offs
  )

  target.appendChild(root)
  if (opts.start === 'end') {
    root.scrollTop = root.scrollHeight
    target.scrollTop = target.scrollHeight
  }

  const text = () => {
    let s = ''
    for (const t of textNodesOf(root)) s += t.nodeValue
    return s
  }
  const rendered = {
    root,
    text,
    selection(sel) {
      const s = sel || (doc.getSelection ? doc.getSelection() : null)
      if (!s || !s.rangeCount || s.isCollapsed) return null
      const range = s.getRangeAt(0)
      const start = offsetOf(root, range.startContainer, range.startOffset)
      const end = offsetOf(root, range.endContainer, range.endOffset)
      if (start === null || end === null || end <= start) return null
      const full = text()
      const selected = full.slice(start, end)
      if (!selected.trim()) return null
      return { start, end, text: selected, ...makeAnchor(full, start, end) }
    },
    rangeOf(start, end) {
      const a = pointAt(root, start)
      const b = pointAt(root, end)
      if (!a || !b || typeof doc.createRange !== 'function') return null
      const range = doc.createRange()
      range.setStart(a.node, a.offset)
      range.setEnd(b.node, b.offset)
      return range
    },
    setAsset,
    destroy() {
      for (const off of offs.splice(0)) off()
      if (root.parentNode) root.parentNode.removeChild(root)
    },
  }
  return rendered
}

/** Unwraps the kit's note marks (their text stays where it was). */
function unmark(root) {
  for (const e of [...elementsOf(root)]) {
    if (e === root || e.getAttribute('data-note') === null || String(e.nodeName).toLowerCase() !== 'mark') continue
    const parent = e.parentNode
    while (e.firstChild) parent.insertBefore(e.firstChild, e)
    parent.removeChild(e)
  }
  if (typeof root.normalize === 'function') root.normalize()
}

/** Wraps text [start, end) of root in marks of note `id` (one per text node it crosses). */
function wrap(root, start, end, id) {
  const doc = root.ownerDocument
  let count = 0
  for (const t of [...textNodesOf(root)]) {
    const len = t.nodeValue.length
    const from = Math.max(start, count)
    const to = Math.min(end, count + len)
    count += len
    if (from >= to) continue
    let part = t
    if (from - (count - len) > 0) part = part.splitText(from - (count - len))
    if (to - from < part.nodeValue.length) part.splitText(to - from)
    const mark = h(doc, 'mark', { class: 'cc-kit-note', 'data-note': id })
    part.parentNode.insertBefore(mark, part)
    mark.appendChild(part)
  }
}

/** Marks every note it can find in the document; the map says where each is (null: its quote is gone). */
export function markNotes(rendered, notes) {
  const root = rendered.root
  unmark(root)
  const where = new Map()
  const full = rendered.text()
  for (const note of Array.isArray(notes) ? notes : []) {
    if (!note || typeof note.id !== 'string') continue
    const at = locate(full, note)
    where.set(note.id, at)
  }
  for (const [id, at] of where) if (at) wrap(root, at.start, at.end, id)
  return where
}

/** Scrolls note `id`'s first mark into view and flashes it; false when it has none. */
export function focusNote(rendered, id) {
  for (const e of elementsOf(rendered.root)) {
    if (e.getAttribute('data-note') !== id) continue
    if (typeof e.scrollIntoView === 'function') e.scrollIntoView({ block: 'center' })
    toggleClass(e, 'cc-kit-flash', true)
    setTimeout(() => toggleClass(e, 'cc-kit-flash', false), 1200)
    return true
  }
  return false
}

export { ALLOWED_CLASSES, MAIL_CLASSES, TAG_CLASSES }
