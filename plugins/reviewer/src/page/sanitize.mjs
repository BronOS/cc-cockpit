// The allow-list sanitizer of annotate's HTML mode. The HTML comes from any plugin of the project
// (a Jira issue's rendered description, a mail), so it never reaches the DOM as markup: no
// innerHTML of it, ever. The page parses it with DOMParser (an inert document: no script runs, no
// image loads, no style applies), sanitizeTree() walks that tree into plain data that keeps only
// the allowed elements and attributes, and render() builds fresh elements from the data with
// createElement / setAttribute / createTextNode. Nothing is serialized and parsed again, so the
// parser differentials behind mutation XSS have nothing to work on. The page CSP blocks script as
// well; this does not count on it.
//
// Pure functions over the DOM node interface (nodeType, nodeName, namespaceURI, attributes,
// childNodes), so test/html.test.js runs them under node with small fake nodes.

/** Elements kept as themselves. Everything else is unwrapped (its children kept) or, in DROP, dropped whole. */
export const ALLOWED_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'ul', 'ol', 'li', 'pre', 'code', 'blockquote',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img', 'strong', 'em', 's', 'u', 'sub', 'sup',
  'span', 'div', 'details', 'summary', 'figure', 'figcaption', 'dl', 'dt', 'dd',
])

/**
 * The class names an element may carry (the reviewer's CSS styles them; README "HTML mode"). Any
 * other class is dropped, so a caller cannot dress its content up as the page's own UI.
 */
export const ALLOWED_CLASSES = new Set([
  'jira-panel', 'jira-panel-info', 'jira-panel-note', 'jira-panel-warning', 'jira-panel-error', 'jira-panel-success',
  'mention', 'card', 'card-header', 'meta', 'new', 'old', 'status', 'lozenge',
  'lozenge-info', 'lozenge-success', 'lozenge-warning', 'lozenge-error', 'attachment-list', 'fields', 'muted',
])

/**
 * Class names only one element may carry, on top of ALLOWED_CLASSES (added for the Jira issue view,
 * 2026-11-03): `facts` makes a `dl` a grid of label/value pairs, `person` a `span` a name chip, and the
 * two newer lozenge tones are `span` only. The older classes stay on any element, as callers use them.
 */
export const TAG_CLASSES = new Map([
  ['dl', new Set(['facts'])],
  ['span', new Set(['person', 'lozenge-neutral', 'lozenge-danger'])],
])

/**
 * The mail reading layout's classes (annotate's `kind: 'mail'`, app 0.13.0), on any element. They are
 * styled only under `.doc-body.mail` (review.css), so a document that is not a mail keeps its look
 * whatever classes it names: the header (subject, avatar, sender, recipients, time and an unread
 * chip), a card of a related item (a Jira issue), the remote-images bar, a call-to-action link, the
 * folded sender's footer, and a remote picture shown as a placeholder until it is loaded (`mail-minor`:
 * a logo or an avatar, hidden while it is not).
 */
export const MAIL_CLASSES = new Set([
  'mail-msg', 'mail-head', 'mail-avatar', 'mail-who', 'mail-from', 'mail-name', 'mail-addr', 'mail-to', 'mail-when',
  'mail-chip', 'mail-body', 'mail-related', 'mail-badge', 'mail-related-main', 'mail-related-title', 'mail-related-meta',
  'mail-status-to', 'mail-arrow', 'mail-related-open', 'mail-images-bar', 'mail-images-text', 'mail-cta', 'mail-footer',
  'mail-remote', 'mail-minor', 'mail-note',
])

// `data-action` ids and `data-part` names (features 'actions' and 'update'), and the original ids of
// `data-original` / `data-reader` (feature 'original'): what the host's review.actionSet, updateInput
// and the originals check accept.
const NAME = /^[a-z][a-z0-9-]{0,39}$/
const MAX_ACTION_LABEL = 60

// A lozenge has one colour: past the first tone named, the others are dropped (the CSS would
// otherwise pick by rule order, which a caller cannot see). `lozenge-error` is the older name of
// `lozenge-danger` and styled the same.
const LOZENGE_TONES = new Set(['lozenge-neutral', 'lozenge-info', 'lozenge-success', 'lozenge-warning', 'lozenge-danger', 'lozenge-error'])

// Dropped with everything inside: code, styles, embedded documents, forms and their controls,
// media that would load something, and head-only elements. Unwrapping these would show a script's
// source or a form's labels as text, which is noise at best.
const DROP = new Set([
  'script', 'style', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'param',
  'noscript', 'noembed', 'noframes', 'svg', 'math', 'form', 'input', 'button', 'select', 'option',
  'optgroup', 'textarea', 'datalist', 'output', 'meter', 'progress', 'canvas', 'video', 'audio', 'source',
  'track', 'picture', 'map', 'area', 'link', 'meta', 'base', 'title', 'head', 'portal', 'slot', 'dialog',
  'xmp', 'plaintext', 'marquee',
])

const HTML_NS = 'http://www.w3.org/1999/xhtml'
const ASSET_ID = /^[A-Za-z0-9._-]{1,100}$/
const MAX_ATTR = 500 // title and alt: a tooltip, not a document
const MAX_HREF = 2048
const MAX_SPAN = 1000
// Deeper than this, elements are unwrapped (their text stays): a document nested thousands deep is
// not one a person reads, and the walk is recursive.
const MAX_DEPTH = 100

/** An http(s) or mailto URL, normalized, or null for anything else (javascript:, data:, relative...). */
export function safeHref(raw) {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  // Browsers drop tabs and newlines inside a URL (java\nscript:), so a control char is a refusal.
  if (!v || v.length > MAX_HREF || /[\x00-\x1f\x7f]/.test(v)) return null
  let u
  try {
    u = new URL(v) // no base: a relative link has nowhere to go from this page
  } catch {
    return null
  }
  return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? u.href : null
}

/** The asset id an <img> names (`src="asset:<id>"` or `data-asset="<id>"`), or null. */
export function assetRef(src, dataAsset) {
  if (typeof dataAsset === 'string' && ASSET_ID.test(dataAsset)) return dataAsset
  if (typeof src === 'string' && src.startsWith('asset:') && ASSET_ID.test(src.slice(6))) return src.slice(6)
  return null
}

const attrsOf = (node) => {
  const out = new Map()
  for (const a of node.attributes || []) out.set(String(a.name).toLowerCase(), String(a.value))
  return out
}

const short = (s) => s.slice(0, MAX_ATTR)

function classesOf(tag, value) {
  const onTag = TAG_CLASSES.get(tag)
  let tone = false
  const kept = []
  for (const c of new Set(String(value).split(/\s+/))) {
    if (!ALLOWED_CLASSES.has(c) && !MAIL_CLASSES.has(c) && !(onTag && onTag.has(c))) continue
    if (LOZENGE_TONES.has(c)) {
      if (tone) continue
      tone = true
    }
    kept.push(c)
  }
  return kept.length ? kept.join(' ') : null
}

/** The allowed attributes of one allowed element, as [name, value] pairs. */
function cleanAttrs(tag, a) {
  const out = []
  const cls = a.has('class') ? classesOf(tag, a.get('class')) : null
  if (cls) out.push(['class', cls])
  if (a.has('title')) out.push(['title', short(a.get('title'))])
  if (tag === 'a') {
    const href = safeHref(a.get('href'))
    if (href) out.push(['href', href])
  }
  // A named region the caller may hide later (update's `hide`): a block or a span.
  if ((tag === 'div' || tag === 'p' || tag === 'span') && a.has('data-part') && NAME.test(a.get('data-part'))) out.push(['data-part', a.get('data-part')])
  // annotate's `originals` (feature 'original'): `div[data-original=id]` is where the page puts the
  // frame of original `id`, and `div[data-reader=id]` the allow-list rendering it stands for (hidden
  // in the Original view once that frame is there). Empty markers: the page fills them, not the caller.
  if (tag === 'div') {
    for (const name of ['data-original', 'data-reader']) if (a.has(name) && NAME.test(a.get(name))) out.push([name, a.get(name)])
  }
  // A markdown file's source lines of a block (markdown.mjs). Digits only, so nothing but a number
  // pair rides on it; on annotate's HTML it is harmless (the page reads it only for a markdown file).
  if (a.has('data-md-lines') && /^\d{1,7}-\d{1,7}$/.test(a.get('data-md-lines'))) out.push(['data-md-lines', a.get('data-md-lines')])
  if (tag === 'td' || tag === 'th') {
    for (const name of ['colspan', 'rowspan']) {
      const v = a.get(name)
      if (v && /^\d{1,4}$/.test(v.trim()) && +v >= 1 && +v <= MAX_SPAN) out.push([name, String(+v)])
    }
  }
  return out
}

/** The text of a node and its descendants (bounded by MAX_DEPTH, as the walk is). */
function textOf(node, depth = 0) {
  if (node.nodeType === 3) return String(node.nodeValue || '')
  if (node.nodeType !== 1 || depth >= MAX_DEPTH) return ''
  // What the walk drops is no label either (a script's source, an SVG's text).
  if ((node.namespaceURI && node.namespaceURI !== HTML_NS) || DROP.has(String(node.nodeName).toLowerCase())) return ''
  let t = ''
  for (const c of node.childNodes || []) t += textOf(c, depth + 1)
  return t
}

/**
 * The sanitized children of `parent`: an array of { text } and { tag, attrs: [[name, value]],
 * children }. Images are { tag: 'img', attrs } with `data-asset`, `alt`, `title` and `class` only,
 * and never a src: the page sets it from the asset the host sends. An image naming no asset
 * becomes { tag: 'span', attrs: [['class', 'img-missing']] } with its alt as text.
 */
export function sanitizeTree(parent, depth = 0) {
  const out = []
  for (const node of parent.childNodes || []) {
    if (node.nodeType === 3) {
      if (node.nodeValue) out.push({ text: String(node.nodeValue) })
      continue
    }
    if (node.nodeType !== 1) continue // comments, processing instructions, doctypes
    // Only HTML elements: SVG and MathML content has its own script and link rules.
    if (node.namespaceURI && node.namespaceURI !== HTML_NS) continue
    const tag = String(node.nodeName).toLowerCase()
    if (DROP.has(tag)) continue
    if (!ALLOWED_TAGS.has(tag) || depth >= MAX_DEPTH) {
      out.push(...sanitizeTree(node, depth + 1))
      continue
    }
    const a = attrsOf(node)
    if (tag === 'img') {
      const id = assetRef(a.get('src'), a.get('data-asset'))
      const alt = a.has('alt') ? short(a.get('alt')) : ''
      if (!id) {
        out.push({ tag: 'span', attrs: [['class', 'img-missing']], children: [{ text: alt ? `[image: ${alt}]` : '[image]' }] })
        continue
      }
      const attrs = [['data-asset', id], ['alt', alt]]
      if (a.has('title')) attrs.push(['title', short(a.get('title'))])
      const cls = a.has('class') ? classesOf('img', a.get('class')) : null
      if (cls) attrs.push(['class', cls])
      out.push({ tag: 'img', attrs, children: [] })
      continue
    }
    // A caller's button (feature 'actions'): `<span data-action="id">Label</span>` becomes a button
    // of the page's own, labelled with the span's text only (no markup of the caller's inside a
    // control), which the page posts as { type: 'action', id }. The host emits only an id the
    // caller's strings have. No label, or a bad id: the span's text stays as text.
    if (tag === 'span' && a.has('data-action')) {
      const id = a.get('data-action')
      const label = textOf(node).replace(/\s+/g, ' ').trim().slice(0, MAX_ACTION_LABEL)
      if (NAME.test(id) && label) {
        const attrs = [['type', 'button'], ['class', 'doc-action'], ['data-action', id]]
        if (a.has('title')) attrs.push(['title', short(a.get('title'))])
        out.push({ tag: 'button', attrs, children: [{ text: label }] })
        continue
      }
    }
    const children = tag === 'br' || tag === 'hr' ? [] : sanitizeTree(node, depth + 1)
    out.push({ tag, attrs: cleanAttrs(tag, a), children })
  }
  return out
}

/**
 * The DOM of a sanitized tree, built in `doc` (a DocumentFragment). Every image goes inside a
 * `span.asset-box.pending` that carries its alt text in `data-alt`: the box shows a placeholder
 * until the asset comes and the alt text if it never does, both through CSS (`content:
 * attr(data-alt)`), so no text node is added or removed later and a note's offsets stay true.
 */
export function render(tree, doc) {
  const frag = doc.createDocumentFragment()
  const build = (nodes, into) => {
    for (const n of nodes) {
      if ('text' in n) {
        into.appendChild(doc.createTextNode(n.text))
        continue
      }
      const e = doc.createElement(n.tag)
      for (const [name, value] of n.attrs) e.setAttribute(name, value)
      if (n.tag === 'img') {
        const box = doc.createElement('span')
        box.setAttribute('class', 'asset-box pending')
        const alt = (n.attrs.find(([k]) => k === 'alt') || [])[1]
        box.setAttribute('data-alt', alt || 'image')
        box.appendChild(e)
        into.appendChild(box)
        continue
      }
      build(n.children, e)
      into.appendChild(e)
    }
  }
  build(tree, frag)
  return frag
}

/** A data: URL the page may set as an image src: one of the four image types, base64, nothing else. */
export const isImageDataUrl = (s) => typeof s === 'string' && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/.test(s)
