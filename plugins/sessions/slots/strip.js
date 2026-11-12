'use strict'
// The `sessions-strip` slot page in the app's top bar: the other windows' Claude tabs, most urgent
// first (ccSessionsView.stripView, dist/lib/view.js). The host sends `strip`; the page sends `hello`
// and `focus`. With no entry the page draws nothing, so the bar keeps only its "+". Texts are other
// projects' names and Claude's status words: textContent only.
//
// The page reports the entries' width (ccStripWidth, dist/lib/strip-width.js): the bar sizes the
// frame to it, so the rest of the bar still drags the window (macOS) and zooms it on a double-click.

const row = document.getElementById('row')
const width = ccStripWidth.watchWidth(row, () => ccPanel.slot, typeof ResizeObserver === 'function' ? ResizeObserver : undefined)

function entryEl(entry) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'cc-btn cc-ghost entry'
  b.dataset.status = entry.status
  b.dataset.tabId = entry.tabId
  b.title = entry.flag ? `${entry.tooltip}\nFlagged` : entry.tooltip
  b.setAttribute('aria-label', entry.flag ? `${entry.text}, flagged` : entry.text)
  if (entry.flag && ccSessionsView.flagOf(entry.flag)) {
    b.dataset.flag = entry.flag.color
    b.style.setProperty('--flag', ccSessionsView.flagOf(entry.flag).css)
  }
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

// A connected server (ccSessionsView.machineView): its name and the waiting / working marks drawn
// with the session dots' classes and colours, dimmed when unreachable. The name is the server's own
// text: textContent only.
function machineEl(machine) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'cc-btn cc-ghost entry machine'
  b.dataset.machineId = machine.id
  if (!machine.reachable) b.dataset.unreachable = ''
  b.title = machine.tooltip
  b.setAttribute('aria-label', machine.tooltip)
  const name = document.createElement('span')
  name.className = 'project'
  name.textContent = machine.name
  b.appendChild(name)
  for (const mark of machine.marks) {
    const dot = document.createElement('span')
    dot.className = 'dot'
    dot.dataset.status = mark.status
    dot.setAttribute('aria-hidden', 'true')
    b.appendChild(dot)
    b.appendChild(document.createTextNode(String(mark.count)))
  }
  b.addEventListener('click', () => ccPanel.post({ type: 'focusMachine', id: machine.id }))
  return b
}

ccPanel.onMessage((m) => {
  if (!m || typeof m !== 'object' || m.type !== 'strip' || !Array.isArray(m.entries)) return
  const machines = Array.isArray(m.machines) ? m.machines : []
  row.replaceChildren(...m.entries.map(entryEl), ...machines.map(machineEl))
  // The first strip comes after the shell said this is a slot (`ccPanel.slot` is set by then), and
  // an empty strip changes no size the observer would see: report on every strip, repeats are dropped.
  width.report()
})

ccPanel.post({ type: 'hello' })
