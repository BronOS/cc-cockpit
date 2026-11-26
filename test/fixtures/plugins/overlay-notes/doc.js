/* global document, window, ccPanel */
// The fixture's page: the document (textContent only), and the notes, Ask and Discuss parts when the app gives them
// (ccPanel.notes, ccPanel.ask, ccPanel.overlay are undefined on an app or an overlay without them). #features lists
// which, for the e2e to read. A note names its author from main's record (`author`, never the page's word): the
// owner's none, a write guest's "(note by guest <name>)". A refused write or Continue says why in #note-error and
// #continue-result; the Ask chat's stored turns (the `history` push, on every connect) go to #history.
//
// ccPanel.notes, .ask and .overlay appear with the copy's connection (the app's intro comes before the port), not at
// load: the parts are set up in the first ccPanel.onConnect, which runs as the port starts and before any of its
// messages (Ask's `history` push comes on connect, and a listener added later misses it).
// Ask: one kind of push per listener (`ask.on(type, fn)`), Continue is `ask.continue()` (src/sdk/panel-overlay.ts).
const $ = (id) => document.getElementById(id)
const features = []
let setUp = false
ccPanel.onMessage((m) => {
  if (typeof m.doc === 'string') {
    const p = document.createElement('p')
    p.textContent = m.doc
    $('doc').replaceChildren(p)
  }
})
ccPanel.onConnect(() => {
  if (setUp) return
  setUp = true
  try {
    setUpParts()
  } catch (err) {
    $('features').dataset.setupError = String(err && err.message)
  }
})
const ASK_TYPES = ['history', 'state', 'delta', 'tool', 'answer', 'end']
/** Every Ask push to `handler` as `{ type, ... }`. */
const listenAsk = (handler) => {
  for (const type of ASK_TYPES) ccPanel.ask.on(type, (data) => handler({ ...data, type }))
}
const byline = (author) => {
  if (!author || author.access !== 'write') return ''
  return typeof author.person === 'string' && author.person ? ' (note by guest ' + author.person + ')' : ' (note by a guest)'
}
const drawNotes = (state) => {
  $('note-list').replaceChildren(
    ...state.notes.map((n) => {
      const li = document.createElement('li')
      li.textContent = '«' + n.quote + '» ' + n.text + byline(n.author)
      return li
    })
  )
}
function setUpParts() {
  if (ccPanel.notes) {
    features.push('notes')
    $('notes').hidden = false
    ccPanel.notes.onChange(drawNotes)
    ccPanel.notes.list().then(drawNotes, (err) => ($('features').dataset.notesError = err.message))
    $('add-note').addEventListener('click', () => {
      const quote = String(window.getSelection() || '') || 'the quick brown fox'
      const text = $('note-text').value || 'a note'
      ccPanel.notes.add({ quote, text }).then(
        () => ($('note-error').textContent = ''),
        (err) => ($('note-error').textContent = 'refused: ' + err.message)
      )
    })
  }
  if (ccPanel.ask) {
    features.push('ask')
    $('ask').hidden = false
    // A chat that answered in this page load goes on with say; the first question of a load (a new chat, or one after
    // Esc or a restart) is start, which resumes the stored chat.
    let live = false
    listenAsk((ev) => {
      if (ev.type === 'state') {
        // D15: main's notice (the owner's chat isolated in a folder Claude Code has not trusted), as text.
        $('ask-notice').textContent = typeof ev.notice === 'string' ? ev.notice : ''
      } else if (ev.type === 'history') {
        $('history').replaceChildren(
          ...ev.turns.map((t) => {
            const li = document.createElement('li')
            li.textContent = 'Q: ' + t.question + ' A: ' + t.answer
            return li
          })
        )
      } else if (ev.type === 'delta') {
        $('answer').textContent += ev.text
      } else if (ev.type === 'answer') {
        $('answer').textContent = ev.error ? 'error: ' + ev.error : ev.text
        if (!ev.error) live = true
      } else if (ev.type === 'end') {
        live = false
        if (ev.error) $('answer').textContent = 'ended: ' + ev.message
      }
    })
    $('ask-send').addEventListener('click', () => {
      $('answer').textContent = ''
      const q = { question: $('question').value }
      const call = live ? ccPanel.ask.say(q) : ccPanel.ask.start(q)
      call.catch((err) => ($('answer').textContent = 'refused: ' + err.message))
    })
    $('ask-continue').addEventListener('click', () => {
      ccPanel.ask.continue().then(
        (r) => ($('continue-result').textContent = 'tab ' + r.tabId),
        (err) => ($('continue-result').textContent = 'refused: ' + err.message)
      )
    })
  }
  if (ccPanel.overlay && typeof ccPanel.overlay.discuss === 'function') {
    features.push('discuss')
    $('discuss').hidden = false
    $('discuss').addEventListener('click', () => ccPanel.overlay.discuss())
  }
  $('features').textContent = features.join(' ')
}
