/* global document, window, ccPanel */
// The fixture's page: the document (textContent only), and the notes, Ask and Discuss parts when the app gives them
// (ccPanel.notes, ccPanel.ask, ccPanel.overlay are undefined on an app or an overlay without them). #features lists
// which, for the e2e to read.
const $ = (id) => document.getElementById(id)
const features = []
ccPanel.onMessage((m) => {
  if (typeof m.doc === 'string') {
    const p = document.createElement('p')
    p.textContent = m.doc
    $('doc').replaceChildren(p)
  }
})
const drawNotes = (state) => {
  $('note-list').replaceChildren(
    ...state.notes.map((n) => {
      const li = document.createElement('li')
      li.textContent = `«${n.quote}» ${n.text}`
      return li
    })
  )
}
if (ccPanel.notes) {
  features.push('notes')
  $('notes').hidden = false
  ccPanel.notes.onChange(drawNotes)
  ccPanel.notes.list().then(drawNotes, (err) => ($('features').dataset.notesError = err.message))
  $('add-note').addEventListener('click', () => {
    const quote = String(window.getSelection() || '') || 'the quick brown fox'
    void ccPanel.notes.add({ quote, text: 'a note' })
  })
}
if (ccPanel.ask) {
  features.push('ask')
  $('ask').hidden = false
  ccPanel.ask.on((event) => {
    if (event.type === 'delta') $('answer').textContent += event.text
    if (event.type === 'answer') $('answer').textContent = event.text
  })
  $('ask-send').addEventListener('click', () => void ccPanel.ask.start({ question: $('question').value }))
}
if (ccPanel.overlay && typeof ccPanel.overlay.discuss === 'function') {
  features.push('discuss')
  $('discuss').hidden = false
  $('discuss').addEventListener('click', () => ccPanel.overlay.discuss())
}
$('features').textContent = features.join(' ')
