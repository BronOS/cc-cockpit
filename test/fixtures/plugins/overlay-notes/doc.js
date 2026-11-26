/* global document, window, ccPanel */
// The fixture's page: the document (textContent only), and the notes, Ask and Discuss parts when the app gives them
// (ccPanel.notes, ccPanel.ask, ccPanel.overlay are undefined on an app or an overlay without them). #features lists
// which, for the e2e to read. The parts are set up once the page is connected (ccPanel.onConnect, or the first host
// message, whichever comes first): the shell's cc-plugin.overlay intro, which makes ccPanel.notes / ask / overlay,
// comes just before the port, after this deferred script has run, so at load they are not there yet.
const $ = (id) => document.getElementById(id)
const features = []
let setUp = false
const setUpOnce = () => {
  if (setUp) return
  setUp = true
  try {
    setup()
  } catch (err) {
    $('features').dataset.setupError = String(err && err.message)
  }
}
ccPanel.onConnect(setUpOnce)
ccPanel.onMessage((m) => {
  setUpOnce()
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
function setup() {
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
    // One kind of push per listener (ask.on(type, fn)).
    ccPanel.ask.on('delta', (event) => ($('answer').textContent += event.text))
    ccPanel.ask.on('answer', (event) => ($('answer').textContent = event.text))
    $('ask-send').addEventListener('click', () => void ccPanel.ask.start({ question: $('question').value }))
  }
  if (ccPanel.overlay && typeof ccPanel.overlay.discuss === 'function') {
    features.push('discuss')
    $('discuss').hidden = false
    $('discuss').addEventListener('click', () => ccPanel.overlay.discuss())
  }
  $('features').textContent = features.join(' ')
}
