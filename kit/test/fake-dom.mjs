// A small fake DOM for the kit's tests (no jsdom): elements, text nodes, fragments, events, and a record of every
// markup write. Setting innerHTML, outerHTML or calling insertAdjacentHTML / document.write records it in
// `doc.markupWrites` and throws, so a component that tried would fail its test.

class Node {
  constructor(doc) {
    this.ownerDocument = doc
    this.parentNode = null
    this.childNodes = []
    this.listeners = new Map()
  }
  get firstChild() {
    return this.childNodes[0] || null
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null
  }
  appendChild(c) {
    return this.insertBefore(c, null)
  }
  insertBefore(c, ref) {
    if (c.nodeType === 11) {
      for (const k of [...c.childNodes]) this.insertBefore(k, ref)
      return c
    }
    if (c.parentNode) c.parentNode.removeChild(c)
    const at = ref ? this.childNodes.indexOf(ref) : -1
    if (at < 0) this.childNodes.push(c)
    else this.childNodes.splice(at, 0, c)
    c.parentNode = this
    return c
  }
  removeChild(c) {
    const at = this.childNodes.indexOf(c)
    if (at >= 0) this.childNodes.splice(at, 1)
    c.parentNode = null
    return c
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }
  replaceChildren(...nodes) {
    for (const c of [...this.childNodes]) this.removeChild(c)
    for (const n of nodes) this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n)
  }
  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true
    return false
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(fn)
  }
  removeEventListener(type, fn) {
    if (this.listeners.has(type)) this.listeners.get(type).delete(fn)
  }
  /** Fires `type` here and up the tree (bubbling), as a person's action would. */
  dispatch(type, init = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, ...init }
    for (let n = this; n; n = n.parentNode) for (const fn of [...(n.listeners.get(type) || [])]) fn(event)
    return event
  }
  get textContent() {
    if (this.nodeType === 3) return this.nodeValue
    return this.childNodes.map((c) => c.textContent).join('')
  }
  set textContent(v) {
    this.replaceChildren()
    if (v !== '' && v !== null && v !== undefined) this.appendChild(this.ownerDocument.createTextNode(String(v)))
  }
  normalize() {
    const kids = this.childNodes
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i]
      if (c.nodeType === 3) {
        while (kids[i + 1] && kids[i + 1].nodeType === 3) c.nodeValue += this.removeChild(kids[i + 1]).nodeValue
        if (c.nodeValue === '') {
          this.removeChild(c)
          i--
        }
      } else c.normalize()
    }
  }
}

class Text extends Node {
  constructor(doc, value) {
    super(doc)
    this.nodeType = 3
    this.nodeName = '#text'
    this.nodeValue = String(value)
  }
  get data() {
    return this.nodeValue
  }
  splitText(offset) {
    const rest = new Text(this.ownerDocument, this.nodeValue.slice(offset))
    this.nodeValue = this.nodeValue.slice(0, offset)
    if (this.parentNode) {
      const at = this.parentNode.childNodes.indexOf(this)
      this.parentNode.childNodes.splice(at + 1, 0, rest)
      rest.parentNode = this.parentNode
    }
    return rest
  }
}

class Fragment extends Node {
  constructor(doc) {
    super(doc)
    this.nodeType = 11
    this.nodeName = '#document-fragment'
  }
}

class Element extends Node {
  constructor(doc, tag) {
    super(doc)
    this.nodeType = 1
    this.nodeName = String(tag).toUpperCase()
    this.tagName = this.nodeName
    this.namespaceURI = 'http://www.w3.org/1999/xhtml'
    this.attrs = new Map()
    this.style = {}
    this.value = ''
    this.scrollTop = 0
    this.scrollHeight = 0
    this.focused = 0
  }
  get attributes() {
    return [...this.attrs].map(([name, value]) => ({ name, value }))
  }
  setAttribute(k, v) {
    this.attrs.set(String(k).toLowerCase(), String(v))
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null
  }
  hasAttribute(k) {
    return this.attrs.has(k)
  }
  removeAttribute(k) {
    this.attrs.delete(k)
  }
  get hidden() {
    return this.attrs.has('hidden')
  }
  set hidden(v) {
    if (v) this.attrs.set('hidden', '')
    else this.attrs.delete('hidden')
  }
  focus() {
    this.focused++
  }
  scrollIntoView() {}
  get innerHTML() {
    return ''
  }
  set innerHTML(v) {
    this.ownerDocument.markupWrites.push(['innerHTML', v])
    throw new Error('innerHTML written')
  }
  set outerHTML(v) {
    this.ownerDocument.markupWrites.push(['outerHTML', v])
    throw new Error('outerHTML written')
  }
  insertAdjacentHTML(_where, v) {
    this.ownerDocument.markupWrites.push(['insertAdjacentHTML', v])
    throw new Error('insertAdjacentHTML called')
  }
  click() {
    return this.dispatch('click')
  }
}

export class FakeDocument extends Node {
  constructor() {
    super(null)
    this.ownerDocument = this
    this.nodeType = 9
    this.markupWrites = []
    this.body = new Element(this, 'body')
  }
  createElement(tag) {
    return new Element(this, tag)
  }
  createTextNode(v) {
    return new Text(this, v)
  }
  createDocumentFragment() {
    return new Fragment(this)
  }
  getSelection() {
    return null
  }
  write(v) {
    this.markupWrites.push(['write', v])
    throw new Error('document.write called')
  }
}

/** Every element under `root` (itself included). */
export function* all(root) {
  if (root.nodeType === 1) yield root
  for (const c of root.childNodes) yield* all(c)
}

/** The elements under `root` with tag `tag`. */
export const byTag = (root, tag) => [...all(root)].filter((e) => e.nodeName === tag.toUpperCase())

/** The buttons under `root` whose text is `label`. */
export const button = (root, label) => byTag(root, 'button').find((b) => b.textContent === label)

/** A fake parsed document (what DOMParser gives): `body` with children from h(). */
export function parsed(doc, ...children) {
  const body = doc.createElement('body')
  for (const c of children) body.appendChild(c)
  return { body }
}

/** Element shorthand for parsed input: el(doc, 'p', { class: 'x' }, 'text', el(...)). */
export function el(doc, tag, attrs = {}, ...children) {
  const e = doc.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  for (const c of children) e.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c)
  return e
}

/** A panel SDK that records every call; `notes` and `ask` push through `pushNotes` / `pushAsk`. */
export function fakePanel({ notes = true, ask = true, discuss = true, state = { global: '', notes: [], rev: 0 } } = {}) {
  const calls = []
  const rec = (name, value) => (...args) => {
    calls.push([name, ...args])
    return Promise.resolve(typeof value === 'function' ? value(...args) : value)
  }
  const listeners = { message: new Set(), notes: new Set(), ask: new Set() }
  const sub = (set) => (fn) => {
    set.add(fn)
    return () => set.delete(fn)
  }
  const panel = {
    calls,
    post: (m) => {
      calls.push(['post', m])
    },
    onMessage: sub(listeners.message),
    pushMessage: (m) => {
      for (const fn of [...listeners.message]) fn(m)
    },
    pushNotes: (s) => {
      for (const fn of [...listeners.notes]) fn(s)
    },
    pushAsk: (ev) => {
      for (const fn of [...listeners.ask]) fn(ev)
    },
  }
  if (notes) {
    panel.notes = {
      list: rec('notes.list', () => state),
      add: rec('notes.add', { seq: 1 }),
      change: rec('notes.change', { seq: 1 }),
      remove: rec('notes.remove', { seq: 1 }),
      setGlobal: rec('notes.setGlobal', { seq: 1 }),
      onChange: sub(listeners.notes),
    }
  }
  if (ask) {
    panel.ask = {
      start: rec('ask.start', null),
      say: rec('ask.say', null),
      close: rec('ask.close', null),
      pick: rec('ask.pick', { models: ['sonnet', 'opus'], efforts: ['low', 'high'] }),
      continue: rec('ask.continue', { tabId: 't1' }),
      on: sub(listeners.ask),
    }
  }
  if (discuss) panel.overlay = { discuss: rec('overlay.discuss', null) }
  return panel
}

/** Lets pending promise callbacks run. */
export const flush = () => new Promise((r) => setTimeout(r, 0))
