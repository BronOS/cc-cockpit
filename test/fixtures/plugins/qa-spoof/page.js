/* global document, ccPanel */
// Logs every message and every notes or Ask push the page gets; the spec reads #log.
const log = (line) => (document.getElementById('log').textContent += line + '\n')
ccPanel.onMessage((m) => log('message ' + JSON.stringify(m)))
let setUp = false
ccPanel.onConnect(() => {
  if (setUp) return
  setUp = true
  if (ccPanel.notes) {
    ccPanel.notes.onChange((s) => log('notes ' + JSON.stringify(s)))
    ccPanel.notes.list().then((s) => log('list ' + JSON.stringify(s)))
  }
  if (ccPanel.ask) for (const t of ['answer', 'delta', 'state', 'history']) ccPanel.ask.on(t, (d) => log('ask ' + JSON.stringify(d)))
  log('ready')
})
