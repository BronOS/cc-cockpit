// Small DOM helpers every component uses. Text only ever goes in as text nodes (h's string children,
// setText): no component sets innerHTML, outerHTML or insertAdjacentHTML (kit/test/no-inner-html.test.mjs).

/** The document and the panel SDK a component works with: the options' (tests), else the page's globals. */
export function env(opts = {}) {
  return { doc: opts.doc || globalThis.document, panel: opts.panel || globalThis.ccPanel }
}

/**
 * An element: `attrs` set as attributes (true = present, false/null/undefined = left out), children appended,
 * a string child as a text node.
 */
export function h(doc, tag, attrs = {}, ...children) {
  const e = doc.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    e.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue
    e.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c)
  }
  return e
}

/** Removes every child of `e`. */
export function clear(e) {
  while (e.firstChild) e.removeChild(e.firstChild)
}

/** Replaces `e`'s children with one text node of `text`. */
export function setText(e, text) {
  clear(e)
  e.appendChild(e.ownerDocument.createTextNode(String(text)))
}

/** Shows or hides `e` (the `hidden` attribute). */
export function show(e, on) {
  if (on) e.removeAttribute('hidden')
  else e.setAttribute('hidden', '')
}

/** Adds or removes one class name in `e`'s class attribute. */
export function toggleClass(e, name, on) {
  const names = (e.getAttribute('class') || '').split(/\s+/).filter((c) => c && c !== name)
  if (on) names.push(name)
  e.setAttribute('class', names.join(' '))
}

/** addEventListener that records its removal in `offs` (a component's destroy runs them). */
export function listen(target, type, fn, offs) {
  target.addEventListener(type, fn)
  offs.push(() => target.removeEventListener(type, fn))
}

/** The elements under `root` (itself included), depth first, in document order. */
export function* elementsOf(root) {
  if (root.nodeType === 1) yield root
  for (const c of [...(root.childNodes || [])]) if (c.nodeType === 1 || c.nodeType === 11) yield* elementsOf(c)
}

/** The text nodes under `root`, in document order. */
export function* textNodesOf(root) {
  for (const c of [...(root.childNodes || [])]) {
    if (c.nodeType === 3) yield c
    else if (c.nodeType === 1) yield* textNodesOf(c)
  }
}

/** An error's text for the page (a rejection's message, else a fixed text). */
export const errorText = (err, fallback = 'That did not work.') =>
  err && typeof err.message === 'string' && err.message ? err.message : fallback
