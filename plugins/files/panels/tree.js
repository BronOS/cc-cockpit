'use strict'
// The Files panel page. It only draws: the host reads folders, asks git and watches for changes,
// and sends `dir`, `marks`, `results` messages; the page sends `expand`, `collapse`, `open`, `edit`,
// `search`, `refresh`. Paths are relative to the project folder, '' being the folder itself.
//
// The right-click menu (also the context-menu key and Shift+F10) is drawn here with the SDK's
// `.cc-menu`; each item is one message to the host (`reveal`, `open-system`, `trash`, `ask`,
// `create`, `rename`) except the two copies, which write the clipboard from the page inside the
// click, the only place a sandboxed frame may (document.execCommand('copy') needs the click's user
// activation; navigator.clipboard is refused to the frame's opaque origin).

const list = document.getElementById('list')
const filter = document.getElementById('filter')
const errorBox = document.getElementById('error')

const dirs = new Map() // rel -> { entries, more, error }
let expanded = new Set([''])
let marks = { files: {}, dirs: new Set(), untracked: [] }
let results = null // { query, paths, total } while the filter has text
let selected = null // rel of the selected row
let rows = [] // the visible rows, in order: { rel, kind, el }
/** From the host's `reset`: the project folder's absolute path and separator, the OS, and whether ctx.files.reveal exists. */
let env = { root: '', sep: '/', platform: '', system: false }

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
  el.className = `cc-row row ${kind === 'dir' ? 'dir' : 'file'}`
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
    edit.className = 'cc-btn cc-ghost edit'
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
  // The context-menu key and Shift+F10 open the menu of the selected row (the project folder's when
  // none is), placed under the row. Chromium may also send a `contextmenu` event for them;
  // preventDefault here stops it, and openMenu is idempotent anyway.
  if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) {
    ev.preventDefault()
    if (cur) openMenu(cur, null)
    else openMenu({ rel: '', kind: 'root' }, null)
    return
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
    case 'F2':
      if (cur) askName({ action: 'rename', rel: cur.rel, kind: cur.kind })
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
    if (m.env && typeof m.env === 'object') env = { ...env, ...m.env }
  } else if (m.type === 'dir') {
    dirs.set(m.path, { entries: m.entries || [], more: m.more || 0, error: m.error })
  } else if (m.type === 'gone') {
    dirs.delete(m.path)
    for (const p of [...expanded]) if (p === m.path || p.startsWith(m.path + '/')) expanded.delete(p)
    if (selected !== null && (selected === m.path || selected.startsWith(m.path + '/'))) selected = parentOf(m.path) || null
  } else if (m.type === 'select') {
    // A new or renamed entry: selected once its folder's listing (sent just before) is drawn. The
    // write worked, so an earlier refusal (a name that existed) is no longer the news.
    showError('')
    selected = m.path
    render()
    select(m.path)
    return
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

// ---- the right-click menu ----

const menuState = { el: null, restore: null }

/** The reveal item's name in the person's system. */
function revealLabel() {
  if (env.platform === 'darwin') return 'Reveal in Finder'
  if (env.platform === 'win32') return 'Show in Explorer'
  return 'Open in file manager'
}

/** The absolute path of `rel` with the system's separator (Copy path). */
function absolutePath(rel) {
  if (rel === '') return env.root
  return env.root + env.sep + (env.sep === '/' ? rel : rel.split('/').join(env.sep))
}

/**
 * Write `text` to the clipboard from inside a click or key press: a hidden textarea, selected, and
 * the copy command, which Chromium allows a frame with user activation. False when it was refused.
 */
function copyText(text) {
  const back = document.activeElement
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  ta.style.left = '-1000px'
  document.body.appendChild(ta)
  ta.select()
  let ok
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  if (back instanceof HTMLElement) back.focus()
  return ok
}

function copy(text) {
  if (!copyText(text)) showError('Could not copy: the clipboard refused it.')
}

/** The items for a row (`file`, `dir`) or the project folder (`root`): [label, run, danger?] or 'sep'. */
function menuItems(target) {
  const { rel, kind } = target
  const post = (type, extra = {}) => () => ccPanel.post({ type, path: rel, ...extra })
  const items = []
  if (kind === 'file') {
    items.push(['Open', () => activate(rel, 'file', target.entry)])
    if (env.system) items.push(['Open with default app', post('open-system')])
    if (env.system) items.push([revealLabel(), post('reveal')])
    items.push(['Ask Claude about this file', post('ask')])
  } else {
    if (env.system) items.push([revealLabel(), post('reveal')])
    items.push(['New file…', () => askName({ action: 'create', kind: 'file', rel })])
    items.push(['New folder…', () => askName({ action: 'create', kind: 'dir', rel })])
  }
  items.push('sep')
  items.push(['Copy path', () => copy(absolutePath(rel))])
  if (kind !== 'root') {
    items.push(['Copy relative path', () => copy(rel)])
    items.push('sep')
    items.push(['Rename…', () => askName({ action: 'rename', rel, kind })])
    if (env.system) items.push(['Move to Trash', post('trash'), true])
  }
  return items
}

function closeMenu(focusBack = true) {
  const { el, restore } = menuState
  if (!el) return
  // State first: removing the focused menu fires its focusout, which calls back in here, and a
  // second remove() of a node in the middle of its removal throws.
  menuState.el = null
  menuState.restore = null
  el.remove()
  if (focusBack && restore && document.contains(restore)) restore.focus()
}

/**
 * Open the menu for `target` ({ rel, kind, entry? }) at the pointer (`at`: { x, y }) or, from the
 * keyboard (`at` null), under the target's row. Focus goes to the first item and comes back to the
 * tree (or wherever it was) when the menu closes.
 */
function openMenu(target, at) {
  closeMenu(false)
  menuState.restore = document.activeElement instanceof HTMLElement ? document.activeElement : list
  const menu = document.createElement('div')
  menu.className = 'cc-menu'
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', target.rel === '' ? 'Project folder' : baseOf(target.rel))
  for (const item of menuItems(target)) {
    if (item === 'sep') {
      const sep = document.createElement('div')
      sep.className = 'cc-menu-separator'
      sep.setAttribute('role', 'separator')
      menu.appendChild(sep)
      continue
    }
    const [label, run, danger] = item
    const b = document.createElement('button')
    b.type = 'button'
    b.setAttribute('role', 'menuitem')
    b.tabIndex = -1
    if (danger) b.classList.add('cc-danger')
    b.textContent = label
    // The copies must run inside this click (user activation); everything else could wait, but one
    // order for all: run, then close (a name bar the run opened keeps the focus).
    b.addEventListener('click', () => {
      closeMenu(!label.endsWith('…'))
      run()
    })
    menu.appendChild(b)
  }
  menu.addEventListener('keydown', (ev) => {
    const items = [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')]
    const at = items.indexOf(document.activeElement)
    const go = (i) => items[(i + items.length) % items.length]?.focus()
    if (ev.key === 'ArrowDown') go(at + 1)
    else if (ev.key === 'ArrowUp') go(at < 0 ? -1 : at - 1)
    else if (ev.key === 'Home') go(0)
    else if (ev.key === 'End') go(-1)
    else if (ev.key === 'Escape' || (ev.key === 'F10' && ev.shiftKey) || ev.key === 'ContextMenu') closeMenu()
    else if (ev.key === 'Tab') closeMenu()
    else return
    ev.preventDefault()
    ev.stopPropagation()
  })
  // Leaving the menu (a click elsewhere, the window losing focus) closes it, without stealing the
  // focus back from where it went.
  menu.addEventListener('focusout', (ev) => {
    if (menuState.el === menu && !menu.contains(ev.relatedTarget)) closeMenu(false)
  })
  document.body.appendChild(menu)
  menuState.el = menu
  // Place it, then keep it inside the frame (a panel is narrow, and a row near the bottom is common).
  let x
  let y
  if (at) {
    x = at.x
    y = at.y
  } else {
    const row = rows.find((r) => r.rel === target.rel)
    const box = row ? row.el.getBoundingClientRect() : list.getBoundingClientRect()
    x = box.left + 16
    y = row ? box.bottom : box.top
  }
  const { width, height } = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`
  menu.style.top = `${Math.max(4, y + height > window.innerHeight - 4 ? y - height : y)}px`
  menu.querySelector('[role="menuitem"]')?.focus()
}

list.addEventListener('contextmenu', (ev) => {
  ev.preventDefault()
  const rowEl = ev.target instanceof Element ? ev.target.closest('.row') : null
  const row = rowEl ? rows.find((r) => r.el === rowEl) : null
  // A keyboard-made event (the key on some systems) has no pointer position: place it under the row.
  const fromKeys = ev.button !== 2 && ev.clientX === 0 && ev.clientY === 0
  if (row) {
    select(row.rel)
    openMenu(row, fromKeys ? null : { x: ev.clientX, y: ev.clientY })
  } else if (fromKeys && selected !== null && rows.some((r) => r.rel === selected)) {
    openMenu(rows.find((r) => r.rel === selected), null)
  } else {
    openMenu({ rel: '', kind: 'root' }, fromKeys ? null : { x: ev.clientX, y: ev.clientY })
  }
})
list.addEventListener('scroll', () => closeMenu(false))
window.addEventListener('blur', () => closeMenu(false))

// ---- the name bar: Rename…, New file…, New folder… ----

const namebar = document.getElementById('namebar')
const nameLabel = document.getElementById('namebar-label')
const nameInput = document.getElementById('namebar-input')
const nameOk = document.getElementById('namebar-ok')
let naming = null // { action: 'create' | 'rename', kind, rel }

/** The same rules the host applies (lib/ops.js checkName), so a mistake shows before a round trip. */
function nameProblem(name) {
  if (name.trim() === '') return 'Type a name.'
  if (name === '.' || name === '..') return `"${name}" cannot be a name.`
  if (name.includes('/')) return 'A name cannot contain "/".'
  if (name.includes('\0')) return 'A name cannot contain a NUL character.'
  return null
}

function askName(req) {
  naming = req
  const where = req.rel === '' ? 'the project folder' : req.rel
  if (req.action === 'rename') {
    nameLabel.textContent = `Rename ${req.rel} to`
    nameOk.textContent = 'Rename'
    nameInput.value = baseOf(req.rel)
  } else {
    nameLabel.textContent = req.kind === 'dir' ? `New folder in ${where}` : `New file in ${where}`
    nameOk.textContent = 'Create'
    nameInput.value = ''
  }
  namebar.hidden = false
  nameInput.focus()
  if (req.action === 'rename') {
    // The name without its extension selected, as file managers do: typing replaces the stem.
    const dot = nameInput.value.lastIndexOf('.')
    nameInput.setSelectionRange(0, req.kind === 'file' && dot > 0 ? dot : nameInput.value.length)
  }
}

function endNaming() {
  naming = null
  namebar.hidden = true
  list.focus()
}

function submitName() {
  if (!naming) return
  const name = nameInput.value
  const problem = nameProblem(name)
  if (problem) return showError(problem)
  if (naming.action === 'rename') {
    ccPanel.post({ type: 'rename', path: naming.rel, name })
  } else {
    // Open the folder first, so the new entry shows where it was made (the host follows).
    if (naming.rel !== '') expand(naming.rel)
    ccPanel.post({ type: 'create', dir: naming.rel, kind: naming.kind, name })
  }
  endNaming()
}

nameOk.addEventListener('click', submitName)
document.getElementById('namebar-cancel').addEventListener('click', endNaming)
nameInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault()
    submitName()
  } else if (ev.key === 'Escape') {
    ev.preventDefault()
    ev.stopPropagation()
    endNaming()
  }
})

render()
ccPanel.post({ type: 'hello' })
