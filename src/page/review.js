// The review overlay page, bundled by scripts/build.mjs into overlay/review.bundle.js (one IIFE:
// the page CSP allows only the plugin's own files, and a sandboxed frame with an opaque origin is
// no place to count on module chunks, so no code splitting and no dynamic import).
//
// The host owns everything that leaves the page: it saves drafts and formats and sends the review.
// The page shows the two sides, collects notes and the global comment, and posts
//   { type: 'draft', draft }                          on every change (debounced);
//   { result: { action: 'discuss'|'new'|'close', tabId?, draft } }   from the buttons.
// Esc closes the overlay without asking the page, so drafts are posted as they change.

import { EditorState, StateField, StateEffect, RangeSetBuilder, Compartment } from '@codemirror/state'
import { EditorView, Decoration, lineNumbers, highlightActiveLine, keymap, drawSelection } from '@codemirror/view'
import { syntaxHighlighting, defaultHighlightStyle, foldGutter, StreamLanguage } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { MergeView, unifiedMergeView, goToNextChunk, goToPreviousChunk, getChunks, getOriginalDoc } from '@codemirror/merge'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import { go } from '@codemirror/lang-go'
import { rust } from '@codemirror/lang-rust'
import { php } from '@codemirror/lang-php'
import { java } from '@codemirror/lang-java'
import { cpp } from '@codemirror/lang-cpp'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { lua } from '@codemirror/legacy-modes/mode/lua'

/* global ccPanel */

const QUOTE_MAX = 500
const DRAFT_DEBOUNCE_MS = 300

// ---- language by file name ----

function languageFor(path) {
  const name = path.split('/').pop().toLowerCase()
  const ext = name.includes('.') ? name.split('.').pop() : ''
  if (name === 'dockerfile' || name.endsWith('.dockerfile')) return StreamLanguage.define(dockerFile)
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': return javascript()
    case 'jsx': return javascript({ jsx: true })
    case 'ts': case 'mts': case 'cts': return javascript({ typescript: true })
    case 'tsx': return javascript({ typescript: true, jsx: true })
    case 'py': return python()
    case 'json': case 'jsonc': return json()
    case 'css': case 'scss': case 'less': return css()
    case 'html': case 'htm': case 'vue': case 'svelte': return html()
    case 'md': case 'markdown': return markdown()
    case 'go': return go()
    case 'rs': return rust()
    case 'php': return php()
    case 'java': case 'kt': return java()
    case 'c': case 'h': case 'cc': case 'cpp': case 'hpp': case 'cxx': return cpp()
    case 'sql': return sql()
    case 'xml': case 'svg': case 'plist': return xml()
    case 'yml': case 'yaml': return yaml()
    case 'sh': case 'bash': case 'zsh': return StreamLanguage.define(shell)
    case 'toml': return StreamLanguage.define(toml)
    case 'lua': return StreamLanguage.define(lua)
    default: return []
  }
}

// ---- theme ----

const themeCompartment = new Compartment()
const isDark = () => ((ccPanel.theme && ccPanel.theme.current && ccPanel.theme.current.kind) || 'dark') === 'dark'

// Colours come from the app's theme variables (`ccc guide panels`, "Theme variables"); the diff
// tints mix the status colours into the background so they work in light and dark.
const baseTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--cc-bg)', color: 'var(--cc-fg)', fontSize: '12.5px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.5' },
  '.cm-gutters': { backgroundColor: 'var(--cc-bg-bar)', color: 'var(--cc-fg-subtle)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--cc-fg) 4%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--cc-fg)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--cc-accent-soft) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--cc-fg)' },
  '.cm-noted': { backgroundColor: 'color-mix(in srgb, var(--cc-status-needs-permission) 18%, transparent)' },
  '.cm-noted-first': { boxShadow: 'inset 3px 0 0 var(--cc-status-needs-permission)' },
  '.cm-changedLine': { backgroundColor: 'color-mix(in srgb, var(--cc-status-waiting) 12%, transparent) !important' },
  '.cm-deletedChunk, .cm-merge-a .cm-changedLine': { backgroundColor: 'color-mix(in srgb, var(--cc-status-ended) 12%, transparent) !important' },
  '.cm-changedText': { background: 'color-mix(in srgb, var(--cc-status-waiting) 35%, transparent) !important' },
  '.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText': { background: 'color-mix(in srgb, var(--cc-status-ended) 35%, transparent) !important' },
  // The default collapsed-lines bar is a light gradient image, glaring in a dark theme: replace the
  // whole background, not only its colour.
  '.cm-collapsedLines': {
    background: 'var(--cc-surface-1)',
    color: 'var(--cc-fg-muted)',
    borderTop: '1px solid var(--cc-border)',
    borderBottom: '1px solid var(--cc-border)',
    padding: '2px 8px',
    cursor: 'pointer',
  },
  '.cm-deletedChunk': { cursor: 'pointer' },
  '.cm-deletedChunk.picked': { boxShadow: 'inset 3px 0 0 var(--cc-status-needs-permission)', outline: '1px solid var(--cc-status-needs-permission)' },
  '.cm-collapsedLines:hover': { background: 'var(--cc-surface-2)', color: 'var(--cc-fg)' },
})

const syntaxFor = () => syntaxHighlighting(isDark() ? oneDarkHighlightStyle : defaultHighlightStyle, { fallback: true })

// ---- note highlights ----

const setNoted = StateEffect.define()
const notedField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setNoted)) return e.value
    return deco.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})

function notedDecorations(doc, notes) {
  const lines = new Map() // line number -> 'first' | 'rest'
  for (const n of notes) {
    for (let l = n.from; l <= Math.min(n.to, doc.lines); l++) {
      if (l === n.from) lines.set(l, 'first')
      else if (!lines.has(l)) lines.set(l, 'rest')
    }
  }
  const b = new RangeSetBuilder()
  for (const l of [...lines.keys()].sort((x, y) => x - y)) {
    const cls = lines.get(l) === 'first' ? 'cm-noted cm-noted-first' : 'cm-noted'
    b.add(doc.line(l).from, doc.line(l).from, Decoration.line({ class: cls }))
  }
  return b.finish()
}

// ---- state ----

const state = {
  sides: null,
  draft: { global: '', notes: [] },
  tabs: [],
  tabId: null,
  layout: 'split', // 'split' | 'unified'
  views: { old: null, new: null }, // EditorViews by side
  merge: null,
  lastSide: null, // the side whose selection "Add note" uses
  // Unified view: removed lines are a widget the editor does not treat as text, so its selection
  // never sees them. A click or selection inside one picks it here instead (pickDeleted).
  oldPick: null, // { from, to, quote, el }
}

const $ = (id) => document.getElementById(id)
function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

let draftTimer = null
function postDraft() {
  clearTimeout(draftTimer)
  draftTimer = setTimeout(() => ccPanel.post({ type: 'draft', draft: state.draft }), DRAFT_DEBOUNCE_MS)
}

function refreshHighlights() {
  for (const side of ['old', 'new']) {
    const v = state.views[side]
    if (!v) continue
    const notes = state.draft.notes.filter((n) => n.side === side)
    v.dispatch({ effects: setNoted.of(notedDecorations(v.state.doc, notes)) })
  }
}

// ---- editors ----

function extensionsFor(side, path) {
  return [
    lineNumbers(),
    foldGutter(),
    highlightActiveLine(),
    drawSelection(),
    highlightSelectionMatches(),
    EditorState.readOnly.of(true), // the reviewer only reads; Edit opens the editor
    keymap.of([...searchKeymap, { key: 'a', run: () => (addNote(side), true) }, { key: 'e', run: () => (edit(), true) }, { key: 'j', run: goToNextChunk }, { key: 'k', run: goToPreviousChunk }]),
    languageFor(path),
    baseTheme,
    themeCompartment.of(syntaxFor()),
    notedField,
    EditorView.updateListener.of((u) => {
      if (u.selectionSet || u.focusChanged) {
        if (u.view.hasFocus) state.lastSide = side
        updateAddButton()
      }
    }),
  ]
}

function buildEditors() {
  const host = $('editors')
  host.replaceChildren()
  if (state.merge) state.merge.destroy()
  for (const v of Object.values(state.views)) if (v && v !== state.merge?.a && v !== state.merge?.b) v.destroy()
  state.merge = null
  state.views = { old: null, new: null }

  const s = state.sides
  // An unchanged file has nothing to diff: a merge view would fold all of it into one bar. Show
  // the file instead, with notes on the new side.
  const diff = s.mode === 'diff' && !(s.old === s.new && !s.oldMissing && !s.newMissing)
  $('layout').hidden = !diff
  if (diff && state.layout === 'split' && !s.oldMissing && !s.newMissing) {
    state.merge = new MergeView({
      a: { doc: s.old, extensions: extensionsFor('old', s.path) },
      b: { doc: s.new, extensions: extensionsFor('new', s.path) },
      parent: host,
      collapseUnchanged: { margin: 3, minSize: 6 },
      gutter: true,
    })
    state.views = { old: state.merge.a, new: state.merge.b }
  } else if (diff && s.newMissing) {
    // Deleted: only the old side exists.
    state.views.old = new EditorView({ parent: host, state: EditorState.create({ doc: s.old, extensions: extensionsFor('old', s.path) }) })
  } else {
    // Unified diff (or a new file, or no git): one editor on the new text, the removed lines shown
    // inline. Removed lines cannot be selected here, so notes go on the new side only.
    const ext = extensionsFor('new', s.path)
    if (diff && !s.oldMissing) ext.push(unifiedMergeView({ original: s.old, mergeControls: false, collapseUnchanged: { margin: 3, minSize: 6 } }))
    state.views.new = new EditorView({ parent: host, state: EditorState.create({ doc: s.new, extensions: ext }) })
    if (diff && !s.oldMissing) {
      const view = state.views.new
      view.dom.addEventListener('mouseup', (e) => setTimeout(() => pickDeleted(view, e.target), 0))
    }
  }
  clearPick()
  refreshHighlights()
  updateAddButton()
}

// ---- removed lines in the unified view ----

function clearPick() {
  if (state.oldPick && state.oldPick.el) state.oldPick.el.classList.remove('picked')
  state.oldPick = null
}

/** The old-side line range and quote of the removed block under `target`, or null. */
function pickDeleted(view, target) {
  clearPick()
  const chunkEl = target && target.closest ? target.closest('.cm-deletedChunk') : null
  if (chunkEl) {
    const pos = view.posAtDOM(chunkEl)
    const info = getChunks(view.state)
    const orig = getOriginalDoc(view.state)
    // The widget sits at the start of its chunk in the new text.
    const chunk = info && info.chunks.find((c) => c.fromB === pos) || (info && info.chunks.find((c) => c.fromB <= pos && pos <= c.toB))
    if (chunk && chunk.toA > chunk.fromA) {
      const from = orig.lineAt(chunk.fromA).number
      const to = orig.lineAt(Math.max(chunk.fromA, chunk.toA - 1)).number
      const sel = window.getSelection()
      const selected = sel && !sel.isCollapsed && chunkEl.contains(sel.anchorNode) ? sel.toString() : ''
      let quote = selected || orig.sliceString(chunk.fromA, chunk.toA)
      if (quote.length > QUOTE_MAX) quote = quote.slice(0, QUOTE_MAX - 2).replace(/\n[^\n]*$/, '') + '\n…'
      state.oldPick = { from, to, quote, el: chunkEl }
      chunkEl.classList.add('picked')
      state.lastSide = 'old'
    }
  }
  updateAddButton()
}

// ---- notes ----

function selectionOf(side) {
  if (side === 'old' && !state.views.old && state.oldPick) return state.oldPick
  const v = state.views[side]
  if (!v) return null
  const r = v.state.selection.main
  if (r.empty) return null
  const doc = v.state.doc
  let quote = doc.sliceString(r.from, r.to)
  // Cut a long quote at a line end and say so, never mid-word without a mark.
  if (quote.length > QUOTE_MAX) quote = quote.slice(0, QUOTE_MAX - 2).replace(/\n[^\n]*$/, '') + '\n…'
  return { from: doc.lineAt(r.from).number, to: doc.lineAt(r.to).number, quote }
}

function currentSelectionSide() {
  if (state.lastSide && selectionOf(state.lastSide)) return state.lastSide
  return ['new', 'old'].find((s) => selectionOf(s)) || null
}

function updateAddButton() {
  $('add-note').disabled = !currentSelectionSide()
}

let noteSeq = 0
function addNote(sideHint) {
  const side = sideHint && selectionOf(sideHint) ? sideHint : currentSelectionSide()
  if (!side) return
  const sel = selectionOf(side)
  const note = { id: `n${Date.now().toString(36)}${noteSeq++}`, side, from: sel.from, to: sel.to, quote: sel.quote, text: '' }
  if (side === 'old') clearPick()
  state.draft.notes.push(note)
  renderNotes(note.id)
  refreshHighlights()
  postDraft()
}

function scrollTo(note) {
  const v = state.views[note.side]
  if (!v) return
  const line = v.state.doc.line(Math.min(note.from, v.state.doc.lines))
  v.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'center' }) })
}

function renderNotes(focusId) {
  const list = $('notes')
  list.replaceChildren()
  const notes = [...state.draft.notes].sort((a, b) => a.from - b.from || (a.side === 'old' ? -1 : 1))
  $('notes-count').textContent = notes.length ? `(${notes.length})` : ''
  if (!notes.length) list.append(el('div', 'empty', 'Select text in the diff, then press a or "Add note".'))
  for (const n of notes) {
    const box = el('div', 'note')
    const head = el('div', 'note-head')
    const where = el('button', 'link', `${n.from === n.to ? `Line ${n.from}` : `Lines ${n.from}-${n.to}`}${state.sides.mode === 'diff' ? (n.side === 'old' ? ' · old' : ' · new') : ''}`)
    where.type = 'button'
    where.title = 'Show in the diff'
    where.addEventListener('click', () => scrollTo(n))
    const del = el('button', 'link danger', 'Delete')
    del.type = 'button'
    del.addEventListener('click', () => {
      state.draft.notes = state.draft.notes.filter((x) => x.id !== n.id)
      renderNotes()
      refreshHighlights()
      postDraft()
    })
    head.append(where, del)
    const quote = el('pre', 'quote', n.quote.length > 160 ? n.quote.slice(0, 160) + ' …' : n.quote)
    const text = el('textarea', 'note-text')
    text.placeholder = 'Your note'
    text.rows = 3
    text.value = n.text
    text.addEventListener('input', () => {
      n.text = text.value
      postDraft()
    })
    box.append(head, quote, text)
    list.append(box)
    if (n.id === focusId) setTimeout(() => text.focus(), 0)
  }
}

// ---- tabs and buttons ----

const STATUS = { waiting: 'waiting', working: 'working', 'needs-permission': 'needs you', idle: 'idle', starting: 'starting' }

function renderTabs() {
  const sel = $('target')
  sel.replaceChildren()
  if (!state.tabs.length) {
    sel.append(el('option', null, 'No Claude tab in this window'))
    sel.disabled = true
    $('discuss').disabled = true
    return
  }
  sel.disabled = false
  $('discuss').disabled = false
  if (!state.tabId || !state.tabs.some((t) => t.tabId === state.tabId)) {
    state.tabId = state.tabs.length === 1 ? state.tabs[0].tabId : null
  }
  if (!state.tabId) {
    const o = el('option', null, 'Choose a Claude tab…')
    o.value = ''
    sel.append(o)
  }
  for (const t of state.tabs) {
    const o = el('option', null, `${STATUS[t.status] || t.status} · ${t.lastPrompt || t.tabId}`)
    o.value = t.tabId
    sel.append(o)
  }
  sel.value = state.tabId || ''
  updateQueuedHint()
}

function updateQueuedHint() {
  const t = state.tabs.find((x) => x.tabId === state.tabId)
  $('queued').textContent = t && t.status !== 'waiting' ? 'Claude is busy: the review is queued until it waits for input.' : ''
}

/** Asks the host to open the editor at the new side's cursor line (the old side has no file). */
function edit() {
  if (state.sides.newMissing) return
  const v = state.views.new
  const line = v ? v.state.doc.lineAt(v.state.selection.main.head).number : 1
  clearTimeout(draftTimer)
  ccPanel.post({ type: 'draft', draft: state.draft })
  $('status').textContent = 'Opening the editor…'
  ccPanel.post({ type: 'edit', line })
}

function finish(action) {
  clearTimeout(draftTimer)
  const empty = !state.draft.global.trim() && state.draft.notes.every((n) => !n.text.trim())
  if (action !== 'close' && empty) {
    $('status').textContent = 'Nothing to send yet: write a comment or a note.'
    return
  }
  if (action === 'discuss' && !state.tabId) {
    $('status').textContent = 'Choose the Claude tab to send the review to.'
    $('target').focus()
    return
  }
  ccPanel.post({ type: 'draft', draft: state.draft })
  ccPanel.post({ result: { action, tabId: state.tabId, draft: state.draft } })
}

// ---- init ----

function init(m) {
  state.sides = m.sides
  state.draft = m.draft || { global: '', notes: [] }
  state.tabs = m.tabs || []
  state.tabId = m.tabId || null
  state.layout = m.layout === 'unified' ? 'unified' : 'split'
  $('layout').textContent = state.layout === 'split' ? 'Unified' : 'Side by side'
  const s = state.sides
  $('path').textContent = s.path
  $('base').textContent = s.mode === 'diff' ? `vs last commit ${s.head ? s.head.slice(0, 8) : ''}` : ''
  $('note').textContent = s.note || ''
  $('note').hidden = !s.note
  $('global').value = state.draft.global
  $('edit').disabled = !!s.newMissing
  $('edit').title = s.newMissing ? 'The file is deleted: nothing to edit' : $('edit').title
  buildEditors()
  renderNotes()
  renderTabs()
  ;(state.views.new || state.views.old).focus()
}

$('global').addEventListener('input', (e) => {
  state.draft.global = e.target.value
  postDraft()
})
$('add-note').addEventListener('click', () => addNote())
// Keep the removed-block pick when the click goes to the button itself.
$('add-note').addEventListener('mousedown', (e) => e.preventDefault())
$('layout').addEventListener('click', () => {
  state.layout = state.layout === 'split' ? 'unified' : 'split'
  $('layout').textContent = state.layout === 'split' ? 'Unified' : 'Side by side'
  ccPanel.post({ type: 'layout', layout: state.layout }) // remembered for the next review
  buildEditors()
})
$('target').addEventListener('change', (e) => {
  state.tabId = e.target.value || null
  updateQueuedHint()
})
$('target').addEventListener('focus', () => ccPanel.post({ type: 'tabs' }))
$('discuss').addEventListener('click', () => finish('discuss'))
$('new-session').addEventListener('click', () => finish('new'))
$('edit').addEventListener('click', () => edit())
$('close').addEventListener('click', () => finish('close'))

ccPanel.onMessage((m) => {
  if (!m || typeof m !== 'object') return
  if (m.type === 'init') init(m)
  else if (m.type === 'error') $('status').textContent = m.message
  else if (m.type === 'tabs') {
    state.tabs = m.tabs || []
    renderTabs()
  }
})

// The theme arrives in a message after load (`ccc guide panels`): swap the syntax colours then.
if (ccPanel.theme && ccPanel.theme.onChange) {
  ccPanel.theme.onChange(() => {
    for (const v of Object.values(state.views)) if (v) v.dispatch({ effects: themeCompartment.reconfigure(syntaxFor()) })
  })
}
