/* global document, ccPanel */
// The part's page: the refs and title its host heard (textContent only). #features lists what the app gave this copy:
// a part's intro has nothing on, so it stays empty (the e2e reads it).
const $ = (id) => document.getElementById(id)
ccPanel.onMessage((m) => {
  if (!Array.isArray(m.refs)) return
  const p = document.createElement('p')
  p.textContent = `${m.title}: ${m.refs.join(', ')}`
  $('part').replaceChildren(p)
})
const features = []
if (ccPanel.notes) features.push('notes')
if (ccPanel.ask) features.push('ask')
if (ccPanel.overlay && typeof ccPanel.overlay.discuss === 'function') features.push('discuss')
$('features').textContent = features.join(',')
