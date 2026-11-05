'use strict'
// The `sessions-strip` slot page in the app's top bar: the other windows' Claude tabs, most urgent
// first (ccSessionsView.stripView, dist/lib/view.js). The host sends `strip`; the page sends `hello`
// and `focus`. With no entry the page draws nothing, so the bar keeps only its "+". Texts are other
// projects' names and Claude's status words: textContent only.

const list = document.getElementById('list')

function entryEl(entry) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'cc-btn cc-ghost entry'
  b.dataset.status = entry.status
  b.dataset.tabId = entry.tabId
  b.title = entry.tooltip
  b.setAttribute('aria-label', entry.text)
  const dot = document.createElement('span')
  dot.className = 'dot'
  dot.dataset.status = entry.status
  dot.setAttribute('aria-hidden', 'true')
  b.appendChild(dot)
  if (entry.color && ccSessionsView.isColor(entry.color)) {
    const pdot = document.createElement('span')
    pdot.className = 'pdot'
    pdot.style.background = entry.color
    pdot.setAttribute('aria-hidden', 'true')
    b.appendChild(pdot)
  }
  const project = document.createElement('span')
  project.className = 'project'
  project.textContent = entry.project
  b.appendChild(project)
  b.appendChild(document.createTextNode(entry.text.slice(entry.project.length)))
  b.addEventListener('click', () => ccPanel.post({ type: 'focus', tabId: entry.tabId }))
  return b
}

ccPanel.onMessage((m) => {
  if (!m || typeof m !== 'object' || m.type !== 'strip' || !Array.isArray(m.entries)) return
  list.replaceChildren(...m.entries.map(entryEl))
})

ccPanel.post({ type: 'hello' })
