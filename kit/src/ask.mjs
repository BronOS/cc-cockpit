// The Ask chat on the app's Ask API (ccPanel.ask: Claude runs in the app, never in the page or the plugin).
// Answers render as Markdown with no raw HTML (chat-markdown.mjs's tree, built with createElement and text
// nodes); a link shows its full address as text and is not clickable. Nothing goes out without the person's
// click or Enter: Ask, Close and Continue in a tab are buttons. An answer never fills anything by itself.
import { markdownTree } from './chat-markdown.mjs'
import { clear, env, errorText, h, listen, setText, show } from './dom.mjs'

/** An answer's DOM: allow-listed tags, text nodes only. */
export function renderMarkdown(text, doc = globalThis.document) {
  const frag = doc.createDocumentFragment()
  const build = (children, into) => {
    for (const c of children) {
      if (typeof c === 'string') {
        into.appendChild(doc.createTextNode(c))
        continue
      }
      if (c.tag === 'code') {
        into.appendChild(h(doc, 'code', {}, c.text))
      } else if (c.tag === 'pre') {
        into.appendChild(h(doc, 'pre', {}, h(doc, 'code', {}, c.text)))
      } else if (c.tag === 'br' || c.tag === 'hr') {
        into.appendChild(doc.createElement(c.tag))
      } else if (c.tag === 'a') {
        // Not a link: its text, then its address in full, so the person sees where it goes before copying it.
        const span = h(doc, 'span', { class: 'cc-kit-md-link' })
        build(c.children || [], span)
        if (typeof c.title === 'string' && c.title && span.textContent !== c.title) {
          span.appendChild(h(doc, 'span', { class: 'cc-kit-md-url' }, ` <${c.title}>`))
        }
        into.appendChild(span)
      } else {
        const e = doc.createElement(c.tag === 'root' ? 'div' : c.tag)
        build(c.children || [], e)
        into.appendChild(e)
      }
    }
  }
  build(markdownTree(typeof text === 'string' ? text : '').children, frag)
  return frag
}

const PHASES = { starting: 'Starting…', thinking: 'Thinking…', ready: 'Ready' }

/** The Ask push types (shared/overlay-envelope.ts AskPush), each heard with ccPanel.ask.on(type, fn). */
const ASK_PUSHES = ['history', 'state', 'delta', 'tool', 'answer', 'end']

/**
 * `fn()` as a promise: a synchronous throw (an SDK member missing or refusing its arguments) becomes a rejection, so
 * every click's error reaches the same catch and shows, never escaping the handler silently.
 */
function attempt(fn) {
  try {
    return Promise.resolve(fn())
  } catch (err) {
    return Promise.reject(err)
  }
}

export function mountAsk(container, opts = {}) {
  const { doc, panel } = env(opts)
  const api = panel && panel.ask
  if (!api) return { el: null, destroy() {}, setQuote() {}, focus() {} }
  const offs = []
  let turns = []
  let open = null // { question, quote?, answer, tools: [], error? } while a turn runs
  let running = false // a chat process is up (a state push came, no end since)
  let phase = null
  let quote = null

  const button = (label, onClick, extra = {}) => {
    const b = h(doc, 'button', { type: 'button', ...extra }, label)
    listen(b, 'click', onClick, offs)
    return b
  }
  const about = h(doc, 'p', { class: 'cc-kit-ask-about' }, typeof opts.about === 'string' ? opts.about : '')
  show(about, typeof opts.about === 'string' && opts.about !== '')
  const log = h(doc, 'div', { class: 'cc-kit-ask-log', role: 'log', 'aria-live': 'polite' })
  const status = h(doc, 'p', { class: 'cc-kit-ask-status' })
  const model = h(doc, 'select', { 'aria-label': 'Model' })
  const effort = h(doc, 'select', { 'aria-label': 'Effort' })
  const picks = h(doc, 'div', { class: 'cc-kit-row cc-kit-ask-picks', hidden: true }, model, effort)
  const quoteText = h(doc, 'span', { class: 'cc-kit-quote' })
  const quoteBox = h(doc, 'div', { class: 'cc-kit-ask-quote', hidden: true }, h(doc, 'span', {}, 'About this: '), quoteText)
  const input = h(doc, 'textarea', { class: 'cc-kit-input', rows: '2', 'aria-label': 'Ask', placeholder: 'Ask about this…' })
  const error = h(doc, 'p', { class: 'cc-kit-error-line', role: 'alert', hidden: true })
  const submit = () => {
    const question = input.value.trim()
    if (!question) return
    const q = quote ? { question, quote } : { question }
    open = { question, ...(quote ? { quote } : {}), answer: '', tools: [] }
    input.value = ''
    setQuote(null)
    show(error, false)
    draw()
    attempt(() => (running && phase === 'ready' ? api.say(q) : api.start(q))).catch((err) => {
      if (open) {
        open.error = errorText(err, 'Not asked.')
        turns.push(open)
        open = null
        draw()
      }
    })
  }
  const askButton = button('Ask', submit, { class: 'cc-kit-primary' })
  quoteBox.appendChild(button('✕', () => setQuote(null), { 'aria-label': 'Ask about the whole document', title: 'Ask about the whole document' }))
  listen(
    input,
    'keydown',
    (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        if (typeof e.preventDefault === 'function') e.preventDefault()
        submit()
      }
    },
    offs
  )
  const close = button('Close chat', () => attempt(() => api.close()).catch(() => {}))
  const cont = button('Continue in a tab', () => {
    // The SDK's name (ccPanel.ask.continue, the owner's; the app refuses anyone else).
    attempt(() => api.continue()).catch((err) => {
      setText(error, errorText(err, 'Not continued.'))
      show(error, true)
    })
  })
  show(cont, opts.canContinue === true)
  const el = h(
    doc,
    'section',
    { class: 'cc-kit-ask', 'aria-label': 'Ask' },
    about,
    log,
    status,
    error,
    quoteBox,
    h(doc, 'div', { class: 'cc-kit-ask-form' }, input, askButton),
    h(doc, 'div', { class: 'cc-kit-row cc-kit-ask-foot' }, picks, close, cont)
  )

  const turnEl = (t, live) => {
    const box = h(doc, 'div', { class: live ? 'cc-kit-turn cc-kit-turn-live' : 'cc-kit-turn' })
    if (t.question) box.appendChild(h(doc, 'p', { class: 'cc-kit-turn-q' }, t.question))
    if (t.quote) box.appendChild(h(doc, 'blockquote', { class: 'cc-kit-quote' }, t.quote))
    for (const tool of t.tools || []) box.appendChild(h(doc, 'p', { class: 'cc-kit-turn-tool' }, tool))
    const answer = h(doc, 'div', { class: 'cc-kit-turn-a' })
    answer.appendChild(renderMarkdown(t.answer || '', doc))
    box.appendChild(answer)
    if (t.error) box.appendChild(h(doc, 'p', { class: 'cc-kit-error-line', role: 'alert' }, `⚠ ${t.error}`))
    return box
  }
  const draw = () => {
    clear(log)
    for (const t of turns) log.appendChild(turnEl(t, false))
    if (open) log.appendChild(turnEl(open, true))
    log.scrollTop = log.scrollHeight
  }
  const fillSelect = (select, values, picked, label) => {
    clear(select)
    select.appendChild(h(doc, 'option', { value: '' }, `${label}: default`))
    for (const v of values) select.appendChild(h(doc, 'option', { value: v }, v))
    select.value = typeof picked === 'string' && values.includes(picked) ? picked : ''
  }
  const applyPick = (p) => {
    if (!p || !Array.isArray(p.models) || !Array.isArray(p.efforts)) return
    const strs = (a) => a.filter((v) => typeof v === 'string')
    fillSelect(model, strs(p.models), p.model, 'Model')
    fillSelect(effort, strs(p.efforts), p.effort, 'Effort')
    show(picks, true)
  }
  const pick = () => {
    const choice = {}
    if (model.value) choice.model = model.value
    if (effort.value) choice.effort = effort.value
    attempt(() => api.pick(choice)).then(applyPick, (err) => {
      setText(error, errorText(err, 'Not changed.'))
      show(error, true)
    })
  }
  listen(model, 'change', pick, offs)
  listen(effort, 'change', pick, offs)

  const onEvent = (ev) => {
    if (!ev || typeof ev !== 'object') return
    switch (ev.type) {
      case 'history':
        turns = Array.isArray(ev.turns)
          ? ev.turns.filter((t) => t && typeof t.question === 'string').map((t) => ({ question: t.question, quote: typeof t.quote === 'string' ? t.quote : undefined, answer: typeof t.answer === 'string' ? t.answer : '', error: typeof t.error === 'string' ? t.error : undefined }))
          : []
        applyPick(ev.pick)
        if (typeof ev.continuedIn === 'string') setText(status, 'Continued in a Claude tab.')
        draw()
        return
      case 'state':
        running = true
        phase = ev.phase
        setText(status, PHASES[ev.phase] || '')
        return
      case 'delta':
        if (typeof ev.text !== 'string') return
        // Another view's question (the owner's chat shows in every owner view): its answer streams here too.
        if (!open) open = { question: '', answer: '', tools: [] }
        open.answer += ev.text
        draw()
        return
      case 'tool':
        if (typeof ev.name !== 'string') return
        if (!open) open = { question: '', answer: '', tools: [] }
        open.tools.push(typeof ev.detail === 'string' && ev.detail ? `Used ${ev.name}: ${ev.detail}` : `Used ${ev.name}`)
        draw()
        return
      case 'answer':
        if (!open) open = { question: '', answer: '', tools: [] }
        if (typeof ev.text === 'string') open.answer = ev.text
        if (typeof ev.error === 'string') open.error = ev.error
        turns.push(open)
        open = null
        draw()
        return
      case 'end':
        running = false
        phase = null
        if (open) {
          open.error = typeof ev.message === 'string' && ev.message ? ev.message : 'The chat ended.'
          turns.push(open)
          open = null
          draw()
        }
        setText(status, typeof ev.message === 'string' ? ev.message : '')
        return
      default:
    }
  }
  // One listener per push type: the SDK's ccPanel.ask.on(type, fn) (it throws on any other form). Each push carries
  // its type, so onEvent stays one switch.
  for (const type of ASK_PUSHES) {
    const off = api.on(type, onEvent)
    if (typeof off === 'function') offs.push(off)
  }
  // Reads the lists and the remembered pick; picks nothing.
  Promise.resolve()
    .then(() => api.pick({}))
    .then(applyPick, () => {})

  function setQuote(text) {
    quote = typeof text === 'string' && text.trim() ? text : null
    setText(quoteText, quote ? `«${quote.length > 200 ? `${quote.slice(0, 199)}…` : quote}»` : '')
    show(quoteBox, !!quote)
  }
  container.appendChild(el)
  draw()
  return {
    el,
    setQuote,
    focus() {
      if (typeof input.focus === 'function') input.focus()
    },
    destroy() {
      for (const o of offs.splice(0)) o()
      if (el.parentNode) el.parentNode.removeChild(el)
    },
  }
}
