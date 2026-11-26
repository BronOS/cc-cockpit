// The notes list and the note for Claude, on the app's Notes API (ccPanel.notes: main keeps them, every view
// sees the same). Writes are the person's: Save and ✕ are clicks; the note for Claude saves as it is typed (a write,
// not a send), so Esc loses nothing. A read guest's list has no controls. All text goes in as text nodes.
import { markNotes, focusNote } from './document.mjs'
import { clear, env, errorText, h, listen, setText, show } from './dom.mjs'

/** "by guest Ann" and the like: who wrote a note, from main's record (never the page's word). */
export function authorLabel(author) {
  if (!author || typeof author !== 'object') return ''
  if (author.plugin === true) return 'added by the plugin'
  if (author.access === 'owner') return 'by the owner'
  if (author.access === 'write') return typeof author.person === 'string' && author.person ? `by guest ${author.person}` : 'by a guest'
  return ''
}

const QUOTE_SHOWN = 200
const shortQuote = (q) => (q.length > QUOTE_SHOWN ? `${q.slice(0, QUOTE_SHOWN - 1)}…` : q)

const NONE = { el: null, destroy() {}, compose() {}, state: () => null }

export function mountNotes(container, opts = {}) {
  const { doc, panel } = env(opts)
  const api = panel && panel.notes
  if (!api) return NONE
  const canWrite = opts.canWrite === true
  const offs = []
  let state = null
  let editing = null // note id being edited
  let draft = null // the selection a new note is for

  const head = h(doc, 'h3', { class: 'cc-kit-notes-head' }, 'Notes')
  const list = h(doc, 'ol', { class: 'cc-kit-notes-list' })
  const error = h(doc, 'p', { class: 'cc-kit-error-line', role: 'alert', hidden: true })
  const draftBox = h(doc, 'div', { class: 'cc-kit-note-draft', hidden: true })
  const el = h(doc, 'section', { class: 'cc-kit-notes', 'aria-label': 'Notes' }, head, draftBox, list, error)

  const fail = (err) => {
    setText(error, errorText(err, 'The note was not saved.'))
    show(error, true)
  }
  const ok = () => show(error, false)
  const run = (p) => Promise.resolve(p).then(ok, fail)

  const button = (label, onClick, extra = {}) => {
    const b = h(doc, 'button', { type: 'button', ...extra }, label)
    listen(b, 'click', onClick, offs)
    return b
  }

  const drawDraft = () => {
    clear(draftBox)
    show(draftBox, !!draft)
    if (!draft) return
    const input = h(doc, 'textarea', { class: 'cc-kit-input', rows: '3', 'aria-label': 'Note', placeholder: 'Your note' })
    const sel = draft
    draftBox.appendChild(h(doc, 'blockquote', { class: 'cc-kit-quote' }, `«${shortQuote(sel.quote)}»`))
    draftBox.appendChild(input)
    draftBox.appendChild(
      h(
        doc,
        'div',
        { class: 'cc-kit-row' },
        button(
          'Save',
          () => {
            const text = input.value.trim()
            if (!text) return
            draft = null
            drawDraft()
            run(api.add({ quote: sel.quote, anchor: sel.anchor, text }))
          },
          { class: 'cc-kit-primary' }
        ),
        button('Cancel', () => {
          draft = null
          drawDraft()
        })
      )
    )
    if (typeof input.focus === 'function') input.focus()
  }

  const draw = () => {
    clear(list)
    const notes = state ? state.notes : []
    setText(head, notes.length ? `Notes ${notes.length}` : 'Notes')
    notes.forEach((note, i) => {
      const quote = button(`«${shortQuote(note.quote)}»`, () => {
        if (opts.rendered) focusNote(opts.rendered, note.id)
        if (typeof opts.onFocus === 'function') opts.onFocus(note)
      }, { class: 'cc-kit-quote-link' })
      const by = authorLabel(note.author)
      const li = h(doc, 'li', { class: 'cc-kit-note', 'data-note': note.id }, h(doc, 'span', { class: 'cc-kit-note-n' }, `${i + 1}.`), quote)
      if (editing === note.id && canWrite) {
        const input = h(doc, 'textarea', { class: 'cc-kit-input', rows: '3', 'aria-label': 'Note' })
        input.value = note.text
        li.appendChild(input)
        li.appendChild(
          h(
            doc,
            'div',
            { class: 'cc-kit-row' },
            button(
              'Save',
              () => {
                const text = input.value.trim()
                editing = null
                if (text && text !== note.text) run(api.change(note.id, { text }))
                draw()
              },
              { class: 'cc-kit-primary' }
            ),
            button('Cancel', () => {
              editing = null
              draw()
            })
          )
        )
      } else {
        li.appendChild(h(doc, 'p', { class: 'cc-kit-note-text' }, note.text))
        if (by) li.appendChild(h(doc, 'span', { class: 'cc-kit-note-by' }, by))
        if (canWrite) {
          li.appendChild(
            h(
              doc,
              'div',
              { class: 'cc-kit-row' },
              button('Edit', () => {
                editing = note.id
                draw()
              }),
              button('✕', () => run(api.remove(note.id)), { 'aria-label': 'Remove note', title: 'Remove note' })
            )
          )
        }
      }
      list.appendChild(li)
    })
    if (opts.rendered) markNotes(opts.rendered, notes)
  }

  const apply = (s) => {
    if (!s || typeof s !== 'object' || !Array.isArray(s.notes)) return
    state = s
    if (editing && !s.notes.some((n) => n.id === editing)) editing = null
    draw()
  }
  const off = api.onChange(apply)
  if (typeof off === 'function') offs.push(off)
  Promise.resolve()
    .then(() => api.list())
    .then(apply, fail)
  container.appendChild(el)
  draw()

  return {
    el,
    compose(sel) {
      if (!canWrite || !sel || typeof sel.quote !== 'string') return
      draft = sel
      drawDraft()
    },
    state: () => state,
    destroy() {
      for (const o of offs.splice(0)) o()
      if (el.parentNode) el.parentNode.removeChild(el)
    },
  }
}

export function mountGlobalNote(container, opts = {}) {
  const { doc, panel } = env(opts)
  const api = panel && panel.notes
  if (!api) return { el: null, destroy() {} }
  const canWrite = opts.canWrite === true
  const saveMs = Number.isFinite(opts.saveMs) && opts.saveMs >= 0 ? opts.saveMs : 500
  const offs = []
  const el = h(doc, 'section', { class: 'cc-kit-global', 'aria-label': 'Note for Claude' })
  const error = h(doc, 'p', { class: 'cc-kit-error-line', role: 'alert', hidden: true })
  let value = ''
  let timer = null
  let typing = false

  if (!canWrite) {
    // Read only: the text, or nothing at all while there is none.
    const p = h(doc, 'p', { class: 'cc-kit-global-text' })
    el.appendChild(h(doc, 'h3', {}, 'Note for Claude'))
    el.appendChild(p)
    const apply = (s) => {
      if (!s || typeof s.global !== 'string') return
      setText(p, s.global)
      show(el, s.global !== '')
    }
    const off = api.onChange(apply)
    if (typeof off === 'function') offs.push(off)
    show(el, false)
    Promise.resolve()
      .then(() => api.list())
      .then(apply, () => {})
  } else {
    const open = h(doc, 'button', { type: 'button', class: 'cc-kit-global-open' }, '+ Note for Claude (optional)')
    const input = h(doc, 'textarea', { class: 'cc-kit-input', rows: '3', 'aria-label': 'Note for Claude', placeholder: 'What should Claude know?', hidden: true })
    el.appendChild(open)
    el.appendChild(input)
    el.appendChild(error)
    const unfold = (on) => {
      show(open, !on)
      show(input, on)
    }
    const save = () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      if (input.value === value) return
      value = input.value
      Promise.resolve(api.setGlobal(value)).then(
        () => show(error, false),
        (err) => {
          setText(error, errorText(err, 'The note was not saved.'))
          show(error, true)
        }
      )
    }
    listen(open, 'click', () => {
      unfold(true)
      if (typeof input.focus === 'function') input.focus()
    }, offs)
    listen(input, 'input', () => {
      typing = true
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(save, saveMs)
    }, offs)
    listen(input, 'blur', () => {
      typing = false
      save()
    }, offs)
    const apply = (s) => {
      if (!s || typeof s.global !== 'string') return
      // Another view's text, unless this one is being typed in (its own save comes after and wins).
      if (typing && timer !== null) return
      value = s.global
      input.value = s.global
      unfold(s.global !== '' || typing)
    }
    const off = api.onChange(apply)
    if (typeof off === 'function') offs.push(off)
    Promise.resolve()
      .then(() => api.list())
      .then(apply, () => {})
    offs.push(() => {
      if (timer !== null) save()
    })
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
