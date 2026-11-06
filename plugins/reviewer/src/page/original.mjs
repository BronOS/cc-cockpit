// annotate's `originals` (feature 'original', app 0.13.0): a document's own HTML and CSS (a designed
// mail: a Jira notification's issue card, its old values struck through in red and the new ones in
// green, layout tables), shown as the sender made it inside a frame that can neither run script nor
// reach the network, beside the allow-list rendering of sanitize.mjs (the Reader view).
//
// The frame is the wall, and it must hold even when the caller's sanitizer (the Gmail plugin's
// original mode, the second wall) and this walk (a third) miss something:
//
// - `<iframe sandbox="">` (FRAME_SANDBOX): every sandbox flag on, no `allow-*` token. No script
//   (no allow-scripts: inline script, event handlers and javascript: URLs are blocked by the browser,
//   and a meta refresh too: "Refused to execute the redirect ... the document is sandboxed"), an
//   opaque origin (no allow-same-origin: nothing in it can reach this page, its storage or its port
//   to the host), no form submission (allow-forms), no popups (allow-popups), no top navigation.
//   The reviewer page is itself sandboxed (`allow-scripts` only, core's PluginFrame / HtmlOverlay)
//   and sandbox flags only add up down the tree.
// - A CSP from two places, both enforced. The frame is a `srcdoc` document, and Chromium gives a
//   srcdoc document its parent's policy container: the reviewer page's header CSP (core's pluginCsp:
//   `default-src 'none'`, img-src only this plugin's files and data:, no frames, no connect) applies
//   inside it as is. The document also starts with ORIGINAL_CSP as a meta tag, the first child of
//   its head (written here, before any of the caller's markup, so nothing of the mail comes before
//   it): images from data: only (an asset reaches the frame as its data: URL), inline styles only,
//   nothing else at all, no form action, no base URL. Verified in Electron 45 (Chromium 156): an http
//   image, a CSS url() background, `@import`, `<link rel=stylesheet>` and `<base href>` in a srcdoc
//   frame each print two violations, one per policy.
// - Why srcdoc and not a document served by a custom protocol with the CSP as a header: the header
//   would be the only policy (a protocol response does not inherit the parent's), main would have to
//   hold the mail and map a URL to it, and the reviewer page's `frame-src 'none'` would have to open
//   for that URL. A srcdoc frame is not a fetch: `frame-src 'none'` does not stop it (verified), it
//   gets the parent's header policy on top of the meta one, and its document exists nowhere else, so
//   nothing can load it by URL. The meta policy cannot carry `sandbox` (a header-only directive);
//   the iframe attribute does that.
//
// Links. A frame without script cannot tell this page which link was clicked, and this page may not
// look inside it (no allow-same-origin). A plain link would navigate the frame: the reviewer page's
// `frame-src 'none'` blocks that (ERR_BLOCKED_BY_CSP) but leaves an error page in the frame instead of
// the mail. So every link gets `target="_blank"`: a sandboxed frame without allow-popups is refused a
// new window ("Blocked opening ... in a sandboxed frame whose 'allow-popups' permission is not set")
// and the frame stays as it was (verified). The link keeps its look, with its URL as the tooltip, and
// opens from the page's own Links list (a button of the page, not of the frame), through the same
// `open-link` path as the Reader view's links: the host opens only a link of the caller's own strings.
//
// Pure functions over the DOM node interface, like sanitize.mjs, so test/html.test.js runs them under
// node with fake nodes; the real parser is the app's test/e2e/reviewer-original.spec.ts.

import { safeHref, assetRef, isImageDataUrl } from './sanitize.mjs'

/** The frame's sandbox attribute: present and empty, every restriction on. */
export const FRAME_SANDBOX = ''

/** The meta CSP at the top of every frame document (see the header for the header policy it adds to). */
export const ORIGINAL_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'"

/**
 * The frame's own defaults, before the caller's styles (which may override them): a white "paper"
 * page in light colours whatever the app's theme, and pictures not loaded yet drawn as a dashed box of
 * their declared size (logos and avatars, `data-minor`, kept invisible until then).
 */
export const BASE_CSS =
  'html{background:#fff;color:#222;color-scheme:light}' +
  'body{margin:0;padding:16px 20px;font:14px/1.5 Arial,Helvetica,sans-serif;overflow-wrap:break-word}' +
  'img{max-width:100%}' +
  'img[data-cc-pending]{outline:1px dashed #b4b4b4;outline-offset:-1px;color:#888;font-size:12px}' +
  'img[data-cc-pending][data-minor]{visibility:hidden}'

// Dropped with everything inside: code, embedded documents, form controls, media that loads, head
// elements (a <style> is read apart, below), and the foreign SVG and MathML trees (their own link and
// script rules; an SVG <style> decodes entities, so its text could close our own <style>).
const DROP = new Set([
  'script', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'param', 'noscript', 'noembed',
  'noframes', 'svg', 'math', 'input', 'button', 'select', 'option', 'optgroup', 'textarea', 'datalist', 'output',
  'meter', 'progress', 'canvas', 'video', 'audio', 'source', 'track', 'picture', 'map', 'area', 'link', 'meta', 'base',
  'title', 'portal', 'slot', 'dialog', 'xmp', 'plaintext', 'marquee', 'keygen', 'image', 'fencedframe', 'search',
])

// Kept as themselves: what a designed mail is made of. Anything else (form, html, body, an unknown
// tag) is unwrapped, its content kept.
const KEEP = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'ul', 'ol', 'li', 'pre', 'code', 'blockquote', 'div', 'span',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col', 'a', 'img', 'strong', 'em', 'b',
  'i', 'u', 's', 'strike', 'del', 'ins', 'sub', 'sup', 'small', 'big', 'font', 'center', 'mark', 'abbr', 'cite', 'q',
  'dfn', 'kbd', 'samp', 'var', 'tt', 'wbr', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'address',
  'figure', 'figcaption', 'details', 'summary', 'dl', 'dt', 'dd', 'bdi', 'bdo', 'time', 'hgroup', 'label', 'fieldset',
  'legend',
])
const VOID = new Set(['br', 'hr', 'img', 'col', 'wbr'])

// Presentational attributes only: no URL-bearing one (src, srcset, background, poster, action,
// formaction, xlink:href, ping, cite...) and no event handler. href and src are handled by tag below.
const ATTRS = new Set([
  'style', 'class', 'id', 'title', 'dir', 'lang', 'align', 'valign', 'bgcolor', 'color', 'face', 'size', 'width', 'height',
  'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'nowrap', 'alt', 'role', 'hidden', 'span', 'start',
  'type', 'reversed', 'headers', 'scope', 'clear', 'hspace', 'vspace', 'open', 'datetime',
])
const ATTR_NAME = /^[a-z][a-z-]*$/

const HTML_NS = 'http://www.w3.org/1999/xhtml'
const MAX_DEPTH = 200 // deeper elements are unwrapped (the walk is recursive)
const MAX_NODES = 200000
const MAX_ATTR = 2000
const MAX_STYLE_ATTR = 8000
const MAX_CSS = 512 * 1024 // all <style> text together; past it the original is not shown (Reader instead)
const MAX_LINKS = 200
const MAX_LINK_TEXT = 80
/** The largest frame document (pictures included, as data: URLs); past it, Reader. */
export const MAX_FRAME_DOC = 16 * 1024 * 1024

const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s) => escText(s).replace(/"/g, '&quot;')

const textOf = (node, depth = 0) => {
  if (node.nodeType === 3) return String(node.nodeValue || '')
  if (node.nodeType !== 1 || depth > MAX_DEPTH) return ''
  let t = ''
  for (const c of node.childNodes || []) t += textOf(c, depth + 1)
  return t
}

/**
 * The frame document of an original, from its inert parse (DOMParser's Document, or a fake node with
 * childNodes): `{ html, links, assets }`, or null when it is over a limit (the caller shows Reader).
 * `asset(id)` gives a loaded picture's data: URL, else null (the picture is a pending box until the
 * document is built again with it). `links`: the document's http(s) and mailto links once each, as
 * `{ href, text }`, for the page's Links list. `assets`: the ids its pictures name, so the page knows
 * which frames to build again when an asset comes.
 */
export function originalDocument(root, { asset = () => null } = {}) {
  const css = []
  let cssChars = 0
  const links = new Map()
  const assets = new Set()
  let nodes = 0
  let over = false

  const attrsOf = (node) => {
    const out = new Map()
    for (const a of node.attributes || []) {
      const name = String(a.name).toLowerCase()
      if (!out.has(name)) out.set(name, String(a.value))
    }
    return out
  }

  const write = (node, depth) => {
    let s = ''
    for (const c of node.childNodes || []) {
      if (over) return s
      if (++nodes > MAX_NODES) {
        over = true
        return s
      }
      if (c.nodeType === 3) {
        s += escText(String(c.nodeValue || ''))
        continue
      }
      if (c.nodeType !== 1) continue // comments, doctypes, processing instructions
      if (c.namespaceURI && c.namespaceURI !== HTML_NS) continue
      const tag = String(c.nodeName).toLowerCase()
      if (tag === 'style') {
        // Read apart and written into the head. `<` cannot close our <style> once escaped as CSS
        // (`\3c `); a parser's style text never holds `</style` anyway, a fake node's might.
        const t = textOf(c).replace(/</g, '\\3c ')
        cssChars += t.length
        if (cssChars > MAX_CSS) over = true
        else css.push(t)
        continue
      }
      if (DROP.has(tag)) continue
      if (tag === 'head') {
        write(c, depth + 1) // only its <style>s come out of it: everything else there is in DROP
        continue
      }
      if (!KEEP.has(tag) || depth >= MAX_DEPTH) {
        s += write(c, depth + 1)
        continue
      }
      s += `<${tag}${attrsHtml(tag, c, attrsOf(c))}>`
      if (VOID.has(tag)) continue
      s += write(c, depth + 1)
      s += `</${tag}>`
    }
    return s
  }

  const attrsHtml = (tag, node, a) => {
    const out = []
    for (const [name, value] of a) {
      if (!ATTRS.has(name) || !ATTR_NAME.test(name)) continue
      if (value.length > (name === 'style' ? MAX_STYLE_ATTR : MAX_ATTR)) continue
      out.push([name, value])
    }
    if (tag === 'img') {
      const id = assetRef(a.get('src'), a.get('data-asset'))
      if (id) {
        assets.add(id)
        const url = asset(id)
        if (url && isImageDataUrl(url)) out.push(['src', url])
        else out.push(['data-cc-pending', ''])
        if (a.has('data-minor')) out.push(['data-minor', ''])
      } else if (isImageDataUrl(a.get('src'))) {
        out.push(['src', a.get('src')]) // a picture inside the mail itself (data: image only)
      }
    }
    if (tag === 'a') {
      const href = safeHref(a.get('href'))
      if (href) {
        // target=_blank: a click asks for a popup, which the sandbox refuses; the frame never navigates.
        out.push(['href', href], ['target', '_blank'], ['rel', 'noopener noreferrer'])
        if (!a.has('title')) out.push(['title', href])
        if (!links.has(href) && links.size < MAX_LINKS) {
          const text = textOf(node).replace(/\s+/g, ' ').trim()
          links.set(href, text.length > MAX_LINK_TEXT ? `${text.slice(0, MAX_LINK_TEXT - 1)}…` : text)
        }
      }
    }
    return out.map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${escAttr(v)}"`)).join('')
  }

  const body = write(root, 0)
  if (over) return null
  const html =
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${escAttr(ORIGINAL_CSP)}">` +
    '<meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light">' +
    `<style>${BASE_CSS}</style>${css.map((t) => `<style>${t}</style>`).join('')}</head><body>${body}</body></html>`
  if (html.length > MAX_FRAME_DOC) return null
  return { html, links: [...links].map(([href, text]) => ({ href, text })), assets }
}
