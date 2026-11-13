'use strict'
// Placeholder file tab (a read-only view): the CodeMirror page replaces it (plan Task 7). It speaks
// the host's file protocol (dist/lib/files.js serveFileTab): `open`, then the `file` parts,
// assembled by req.
const status = document.getElementById('status')
const pre = document.getElementById('text')
let parts = []
let got = 0
let req = 0
ccPanel.onMessage((m) => {
  if (!m || typeof m !== 'object') return
  if (m.t === 'file' && m.req === req) {
    if (!m.exists) {
      status.textContent = m.path + ': deleted on disk'
      pre.textContent = ''
      return
    }
    if (parts[m.part] === undefined) got++
    parts[m.part] = m.text || ''
    if (got === m.parts) {
      pre.textContent = parts.join('')
      status.textContent = m.path + (m.readOnly ? ' (read-only: ' + m.why + ')' : '')
    }
  } else if (m.t === 'disk') {
    load()
  } else if (m.t === 'error') {
    status.textContent = m.message
  }
})
function load() {
  parts = []
  got = 0
  req += 1
  ccPanel.post({ t: 'open', req })
}
// Every new line (the first, a host restart, a reconnect) asks again.
ccPanel.onConnect(load)
