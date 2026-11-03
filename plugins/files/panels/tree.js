'use strict'
// The Files panel page. It only draws: the host reads folders, asks git and watches for changes,
// and sends `dir`, `marks`, `results` messages; the page sends `expand`, `collapse`, `open`, `edit`,
// `search`, `refresh`. Paths are relative to the project folder, '' being the folder itself.

const list = document.getElementById('list')
const filter = document.getElementById('filter')
const errorBox = document.getElementById('error')

const dirs = new Map() // rel -> { entries, more, error }
let expanded = new Set([''])
let marks = { files: {}, dirs: new Set(), untracked: [] }
let results = null // { query, paths, total } while the filter has text
let selected = null // rel of the selected row
let rows = [] // the visible rows, in order: { rel, kind, el }

const joinRel = (dir, name) => (dir === '' ? name : `${dir}/${name}`)
const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
const baseOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1)

function showError(message) {
  errorBox.textContent = message || ''
  errorBox.classList.toggle('on', Boolean(message))
  clearTimeout(showError.timer)
  if (message) showError.timer = setTimeout(() => showError(''), 8000)
}

/** The git mark of a row: a letter for a file, a dot for a folder holding a change. */
function markOf(rel, kind) {
  const inUntracked = marks.untracked.some((u) => rel === u || rel.startsWith(u + '/'))
  if (kind === 'dir') {
    if (inUntracked) return { cls: 'q', text: '?' }
    return marks.dirs.has(rel) ? { cls: 'dot', text: '' } : null
  }
  const code = marks.files[rel] || (inUntracked ? '?' : null)
  if (!code) return null
  return { cls: code === '?' ? 'q' : code, text: code }
}

function rowEl({ rel, kind, depth, label, sub, entry }) {
  const el = document.createElement('div')
  el.className = `row ${kind === 'dir' ? 'dir' : 'file'}`
  if (entry && entry.ignored) el.classList.add('ignored')
  if (entry && entry.link) el.classList.add('link')
  if (entry && entry.blocked) el.classList.add('blocked')
  el.setAttribute('role', 'treeitem')
  el.style.paddingLeft = `${4 + depth * 12}px`
  const tw = document.createElement('span')
  tw.className = 'twisty'
  if (kind === 'dir' && !(entry && entry.blocked)) {
    tw.textContent = expanded.has(rel) ? '▼' : '▶'
    el.setAttribute('aria-expanded', String(expanded.has(rel)))
  }
  el.appendChild(tw)
  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = label
  if (sub) {
    const p = document.createElement('span')
    p.className = 'path'
    p.textContent = sub
    name.appendChild(p)
  }
  name.title = rel
  el.appendChild(name)
  if (kind === 'file') {
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'edit'
    edit.textContent = 'Edit'
    edit.title = 'Edit in the editor (e)'
    edit.addEventListener('click', (ev) => {
      ev.stopPropagation()
      ccPanel.post({ type: 'edit', path: rel })
    })
    el.appendChild(edit)
  }
  const m = markOf(rel, kind)
  const mk = document.createElement('span')
  mk.className = `mark${m ? ' ' + m.cls : ''}`
  mk.textContent = m ? m.text : ''
  el.appendChild(mk)
  if (rel === selected) el.classList.add('sel')
  el.addEventListener('click', () => {
    select(rel)
    activate(rel, kind, entry)
  })
  return el
}

function note(text, depth) {
  const el = document.createElement('div')
  el.className = 'note'
  el.style.paddingLeft = `${24 + depth * 12}px`
  el.textContent = text
  return el
}

function render() {
  const frag = document.createDocumentFragment()
  rows = []
  const add = (r) => {
    const el = rowEl(r)
    rows.push({ rel: r.rel, kind: r.kind, entry: r.entry, el })
    frag.appendChild(el)
  }
  if (results) {
    for (const p of results.paths) add({ rel: p, kind: 'file', depth: 0, label: baseOf(p), sub: parentOf(p) })
    if (results.paths.length === 0) frag.appendChild(note('No matching files (ignored files are not searched).', 0))
    else if (results.total > results.paths.length) frag.appendChild(note(`${results.total - results.paths.length} more: type more of the name`, 0))
  } else {
    const walk = (dir, depth) => {
      const d = dirs.get(dir)
      if (!d) {
        frag.appendChild(note('loading…', depth))
        return
      }
      if (d.error) frag.appendChild(note(d.error, depth))
      if (dir === '' && d.entries.length === 0 && !d.error) frag.appendChild(note('This folder is empty.', 0))
      for (const e of d.entries) {
        const rel = joinRel(dir, e.name)
        add({ rel, kind: e.kind === 'dir' ? 'dir' : 'file', depth, label: e.name, entry: e })
        if (e.kind === 'dir' && !e.blocked && expanded.has(rel)) walk(rel, depth + 1)
      }
      if (d.more) frag.appendChild(note(`${d.more} more not shown`, depth))
    }
    walk('', 0)
  }
  list.replaceChildren(frag)
}

function select(rel) {
  selected = rel
  for (const r of rows) r.el.classList.toggle('sel', r.rel === rel)
  const r = rows.find((x) => x.rel === rel)
  if (r) r.el.scrollIntoView({ block: 'nearest' })
}

function expand(rel) {
  if (expanded.has(rel)) return
  expanded.add(rel)
  ccPanel.post({ type: 'expand', path: rel })
  render()
}

function collapse(rel) {
  if (rel === '' || !expanded.has(rel)) return
  for (const p of [...expanded]) if (p === rel || p.startsWith(rel + '/')) expanded.delete(p)
  ccPanel.post({ type: 'collapse', path: rel })
  render()
}

function activate(rel, kind, entry) {
  if (kind === 'dir') {
    if (entry && entry.blocked) return showError(`${rel} links to a folder outside the project.`)
    if (expanded.has(rel)) collapse(rel)
    else expand(rel)
  } else if (entry && entry.kind === 'other') {
    showError(`${rel} is not a regular file.`)
  } else {
    ccPanel.post({ type: 'open', path: rel })
  }
}

// ---- keyboard ----

list.addEventListener('keydown', (ev) => {
  const i = rows.findIndex((r) => r.rel === selected)
  const cur = rows[i]
  const go = (k) => {
    const r = rows[Math.max(0, Math.min(rows.length - 1, k))]
    if (r) select(r.rel)
  }
  switch (ev.key) {
    case 'ArrowDown':
      go(i < 0 ? 0 : i + 1)
      break
    case 'ArrowUp':
      go(i < 0 ? 0 : i - 1)
      break
    case 'Home':
      go(0)
      break
    case 'End':
      go(rows.length - 1)
      break
    case 'ArrowRight':
      if (cur && cur.kind === 'dir' && !(cur.entry && cur.entry.blocked)) {
        if (!expanded.has(cur.rel)) expand(cur.rel)
        else go(i + 1)
      }
      break
    case 'ArrowLeft':
      if (!cur) break
      if (cur.kind === 'dir' && expanded.has(cur.rel)) collapse(cur.rel)
      else if (!results && parentOf(cur.rel) !== '') select(parentOf(cur.rel))
      break
    case 'Enter':
      if (cur) activate(cur.rel, cur.kind, cur.entry)
      break
    case 'e':
      if (cur && cur.kind === 'file') ccPanel.post({ type: 'edit', path: cur.rel })
      break
    case '/':
      filter.focus()
      break
    default:
      return
  }
  ev.preventDefault()
})

document.addEventListener('keydown', (ev) => {
  if (ev.key === '/' && document.activeElement !== filter) {
    ev.preventDefault()
    filter.focus()
  }
})

// ---- filter ----

let searchTimer = null
filter.addEventListener('input', () => {
  clearTimeout(searchTimer)
  const q = filter.value.trim()
  if (!q) {
    results = null
    render()
    return
  }
  searchTimer = setTimeout(() => ccPanel.post({ type: 'search', query: q }), 150)
})
filter.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && filter.value) {
    ev.preventDefault()
    ev.stopPropagation()
    filter.value = ''
    results = null
    render()
  } else if (ev.key === 'ArrowDown' || ev.key === 'Enter') {
    ev.preventDefault()
    if (ev.key === 'Enter' && results && results.paths[0]) ccPanel.post({ type: 'open', path: results.paths[0] })
    if (rows[0]) select(rows[0].rel)
    list.focus()
  }
})

document.getElementById('refresh').addEventListener('click', () => ccPanel.post({ type: 'refresh' }))
document.getElementById('collapse').addEventListener('click', () => {
  for (const p of [...expanded]) if (p !== '' && !p.includes('/')) collapse(p)
})

// ---- host messages ----

ccPanel.onMessage((m) => {
  if (!m || typeof m !== 'object') return
  if (m.type === 'reset') {
    expanded = new Set(['', ...(m.expanded || [])])
  } else if (m.type === 'dir') {
    dirs.set(m.path, { entries: m.entries || [], more: m.more || 0, error: m.error })
  } else if (m.type === 'gone') {
    dirs.delete(m.path)
    for (const p of [...expanded]) if (p === m.path || p.startsWith(m.path + '/')) expanded.delete(p)
  } else if (m.type === 'marks') {
    marks = { files: m.files || {}, dirs: new Set(m.dirs || []), untracked: m.untracked || [] }
  } else if (m.type === 'results') {
    // A late answer for a query the person has since changed is dropped.
    if (filter.value.trim() !== m.query) return
    results = { query: m.query, paths: m.paths || [], total: m.total || 0 }
  } else if (m.type === 'error') {
    showError(m.message)
    return
  } else {
    return
  }
  render()
})

render()
ccPanel.post({ type: 'hello' })
