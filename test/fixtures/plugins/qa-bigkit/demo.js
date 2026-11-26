/* global document, ccKit */
// Every kit component on one page (task 06's demo): the renderer with a selection menu and note marks, the notes
// list and the note for Claude, the Original frame, the Discuss button, side tabs (Details · Ask) with the Ask chat,
// and the error state. The host's makePage sends the state; nothing here posts without a click.
const main = document.getElementById('main')
const side = document.getElementById('side')
let mounted = []
const reset = () => {
  for (const m of mounted) m.destroy()
  mounted = []
  main.replaceChildren()
  side.replaceChildren()
}
let init = { access: 'read', tab: 'details', features: ccKit.features() }

ccKit.connect({
  init(info) {
    init = info
  },
  loading() {
    reset()
    main.appendChild(document.createTextNode('Loading…'))
  },
  failed(f) {
    reset()
    mounted.push(ccKit.mountError(main, { message: f.message, retry: f.retry }))
  },
  state(s) {
    reset()
    const canWrite = init.access !== 'read'
    const doc = ccKit.renderDocument(main, { html: s.html })
    mounted.push(doc)
    mounted.push(ccKit.mountDiscussButton(main))
    const notes = ccKit.mountNotes(main, { canWrite, rendered: doc })
    mounted.push(notes, ccKit.mountGlobalNote(main, { canWrite }))
    if (s.original) mounted.push(ccKit.mountOriginal(main, { html: s.original, title: 'Original' }))

    const details = document.createElement('div')
    details.appendChild(document.createTextNode('Details: DEMO-1, Done.'))
    const askPane = document.createElement('div')
    const ask = ccKit.mountAsk(askPane, { about: s.about, canContinue: init.access === 'owner' && init.features.ask })
    mounted.push(ask)
    const tabs = [{ id: 'details', label: 'Details', panel: details }]
    if (ask.el) tabs.push({ id: 'ask', label: 'Ask', panel: askPane })
    mounted.push(ccKit.mountSideTabs(side, { tabs, selected: init.tab }))

    const actions = []
    if (canWrite && notes.el) actions.push({ id: 'note', label: 'Note', run: (sel) => notes.compose(sel) })
    if (ask.el) actions.push({ id: 'ask', label: 'Ask about this', run: (sel) => (ask.setQuote(sel.text), ask.focus()) })
    if (actions.length) mounted.push(ccKit.mountSelectionMenu(doc, { actions }))
  },
})
