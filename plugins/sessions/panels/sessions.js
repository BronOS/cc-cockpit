'use strict'
// The Sessions panel page. It only draws: the host sends `sessions` (this window's Claude tabs and
// the filesShown setting) and `refused` (a file it could not open); the page sends `hello`, `focus`
// and `openFile`. What a card shows is ccSessionsView.cardView's (dist/lib/view.js), so the rules
// are tested once, under node. Every text is put in as textContent: it comes from hooks and Claude.

const list = document.getElementById('list')
const empty = document.getElementById('empty')
const flaggedBox = document.getElementById('flagged-box')
const flaggedList = document.getElementById('flagged')
const restHeading = document.getElementById('rest-h')

let sessions = []
let filesShown = ccSessionsView.FILES_SHOWN.default
/** Cards whose Show all is pressed, by tab id: kept while the page lives, not stored (a glance). */
const showAll = new Set()
/** The file whose last click was refused, per tab id, so a click never just does nothing. */
const refused = new Map()

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function focusTab(tabId) {
  ccPanel.post({ type: 'focus', tabId })
}

function cardEl(session, index) {
  const card = ccSessionsView.cardView(session, { index, filesShown, showAll: showAll.has(session.tabId) })
  const li = el('li', 'cc-card card')
  li.dataset.tabId = card.tabId
  li.dataset.status = card.status
  if (card.active) li.dataset.active = ''
  if (card.flag) {
    // Only a token view.js built from one of the six names (flagOf), never the raw value.
    li.dataset.flag = card.flag.color
    li.style.setProperty('--flag', card.flag.css)
  }
  // A click anywhere on the card (not on one of its own buttons) goes to the tab.
  li.addEventListener('click', (ev) => {
    if (ev.target instanceof Element && ev.target.closest('button')) return
    focusTab(card.tabId)
  })

  const head = el('div', 'head')
  const dot = el('span', 'dot')
  dot.dataset.status = card.status
  dot.title = card.statusText
  dot.setAttribute('aria-hidden', 'true')
  head.appendChild(dot)
  const title = el('button', 'title', card.label)
  title.type = 'button'
  title.title = card.tooltip
  title.addEventListener('click', () => focusTab(card.tabId))
  head.appendChild(title)
  head.appendChild(el('span', 'status', card.statusText))
  if (card.steps) {
    const steps = el('span', 'steps', card.steps.text)
    steps.title = 'Steps done'
    const bar = el('span', 'bar')
    bar.setAttribute('aria-hidden', 'true')
    const fill = el('span')
    fill.style.width = `${card.steps.percent}%`
    bar.appendChild(fill)
    steps.appendChild(bar)
    head.appendChild(steps)
  }
  li.appendChild(head)

  if (card.flag) {
    // The person's reminder (or just "Flagged" without one), with the colour as a dot.
    const flag = el('p', 'flag')
    const fdot = el('span', 'fdot')
    fdot.setAttribute('aria-hidden', 'true')
    flag.appendChild(fdot)
    flag.appendChild(el('span', '', card.flag.note || 'Flagged'))
    flag.setAttribute('aria-label', card.flag.note ? `Flag: ${card.flag.note}` : 'Flagged')
    li.appendChild(flag)
  }

  if (card.summary) {
    const p = el('p', card.summary.gist ? 'summary gist' : 'summary', card.summary.text)
    p.title = card.summary.title
    li.appendChild(p)
  }
  if (card.notes.length > 0) {
    const ul = el('ul', 'notes')
    ul.setAttribute('aria-label', 'Notes')
    for (const note of card.notes) ul.appendChild(el('li', '', note))
    li.appendChild(ul)
  }
  if (card.fileCount > 0) {
    const box = el('div', 'files')
    const caption = el('div', 'caption', `${card.fileCount} changed ${card.fileCount === 1 ? 'file' : 'files'}`)
    caption.setAttribute('aria-hidden', 'true')
    box.appendChild(caption)
    const ul = el('ul')
    ul.setAttribute('aria-label', 'Changed files')
    for (const file of card.files) {
      const item = el('li')
      const b = el('button', 'file')
      b.type = 'button'
      b.title = file
      // The name is the file string exactly: the folder and the name sit in two spans.
      b.setAttribute('aria-label', file)
      const parts = ccSessionsView.splitPath(file)
      b.appendChild(el('span', 'dir', parts.dir))
      b.appendChild(el('span', 'name', parts.name))
      b.addEventListener('click', () => {
        refused.delete(card.tabId)
        render()
        ccPanel.post({ type: 'openFile', tabId: card.tabId, path: file })
      })
      item.appendChild(b)
      ul.appendChild(item)
    }
    box.appendChild(ul)
    if (card.hiddenFiles > 0) {
      const open = showAll.has(card.tabId)
      const more = el('button', 'cc-btn cc-ghost more', open ? `Hide (${card.hiddenFiles})` : `Show all (${card.hiddenFiles} more)`)
      more.type = 'button'
      more.setAttribute('aria-expanded', String(open))
      more.addEventListener('click', () => {
        if (open) showAll.delete(card.tabId)
        else showAll.add(card.tabId)
        render()
      })
      box.appendChild(more)
    }
    li.appendChild(box)
  }
  if (refused.has(card.tabId)) {
    const line = el('div', 'cc-error-line refused', `Could not open ${refused.get(card.tabId)}`)
    line.setAttribute('role', 'status')
    li.appendChild(line)
  }
  return li
}

function render() {
  empty.hidden = sessions.length > 0
  // Flagged tabs first, in a group of their own (ccSessionsView.groupSessions); each card keeps its
  // place in the whole list for its "Claude N".
  const { flagged, rest } = ccSessionsView.groupSessions(sessions)
  flaggedBox.hidden = flagged.length === 0
  restHeading.hidden = flagged.length === 0 || rest.length === 0
  flaggedList.replaceChildren(...flagged.map(({ session, index }) => cardEl(session, index)))
  list.replaceChildren(...rest.map(({ session, index }) => cardEl(session, index)))
}

ccPanel.onMessage((m) => {
  if (!m || typeof m !== 'object') return
  if (m.type === 'sessions' && Array.isArray(m.sessions)) {
    sessions = m.sessions
    filesShown = ccSessionsView.filesShownOf(m.filesShown)
    const ids = new Set(sessions.map((s) => s.tabId))
    for (const id of [...showAll]) if (!ids.has(id)) showAll.delete(id)
    for (const id of [...refused.keys()]) if (!ids.has(id)) refused.delete(id)
    render()
  } else if (m.type === 'refused' && typeof m.tabId === 'string' && typeof m.path === 'string') {
    refused.set(m.tabId, m.path)
    render()
  }
})

render()
ccPanel.post({ type: 'hello' })
