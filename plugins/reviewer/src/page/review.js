// The review overlay page, bundled by scripts/build.mjs into overlay/review.bundle.js (one IIFE:
// the page CSP allows only the plugin's own files, and a sandboxed frame with an opaque origin is
// no place to count on module chunks, so no code splitting and no dynamic import).
//
// The host owns everything that leaves the page: it saves drafts and formats and sends the review.
// `sides.mode` is 'diff' or 'plain' for a file, or 'text' for an annotated text (the service's
// annotate): then `path` is the caller's title (the overlay's own title bar shows it, so the page has
// no header row), `url` an optional link (an "Open in browser" icon in the document, when the init
// says `canOpenUrl`; the click posts { type: 'open-url' } and the host opens the URL its caller gave,
// never one from here), and
// `new` the one read-only pane, with no diff, no layout toggle and no Edit. 'html' is annotate's
// HTML mode: no pane at all but the caller's HTML, sanitized (sanitize.mjs) and rendered as a
// document; it comes after the init in `htmlParts` { type: 'html', index, part } messages the page
// asks for with { type: 'content' }, followed by one { type: 'asset', id, dataUrl } per image and
// { type: 'assets-done' }. With `sides.aside` (annotate's details column, text or html) the page asks
// too, and { type: 'aside', html } comes first: sanitized the same way, shown in a column at the right. Its notes anchor on the selected text (anchor.mjs), not on lines.
// A plain click on a link in either (or Enter on it, or a middle click) posts { type: 'open-link', href }
// when the init says `canOpenLinks`; the host opens it only when the caller's own html or aside has it.
// The page shows the two sides, collects notes and the global comment, and posts
//   { type: 'draft', draft }                          on every change;
//   { result: { action: 'discuss'|'new'|'close', tabId?, draft } }   from the buttons.
// Esc closes the overlay without asking the page, so drafts are posted as they change, at once (a
// debounce here lost the last keystrokes to an Esc pressed within it; the host coalesces writes).
// The host answers { type: 'draft-error', message } when a draft could not be stored and
// { type: 'draft-saved' } once a later one was: the page shows the failure while it is open.

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
import { sanitizeTree, render, isImageDataUrl } from './sanitize.mjs'
import { makeAnchor, locate } from './anchor.mjs'
import { isPlainClick, selectionKey } from './links.mjs'

/* global ccPanel */

const QUOTE_MAX = 500
// The host's cleanDraft caps (dist/lib/review.js MAX_NOTE_TEXT, MAX_GLOBAL; a test compares them).
// The inputs carry them as maxlength: past them the host cut the text silently, and the next open
// showed the shortened draft as if that were all the person wrote.
const NOTE_MAX = 4000
const GLOBAL_MAX = 20000
// The host's MAX_NOTES and MAX_DRAFT_JSON (same test). Past MAX_NOTES the host dropped the later
// notes silently, so "Add note" stops there and says why. A draft past DRAFT_JSON_MAX would not fit
// the store or a page message (core drops a big one with only a console warning): the page does not
// post it, shows why, and the host keeps the last draft that fit.
const NOTES_MAX = 200
const DRAFT_JSON_MAX = 400000
const LIMIT_HINT_AT = 0.9 // show "n / max" once the text reaches this share of its cap

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
  canOpenLinks: false, // the host opens links of the caller's content (it has ctx.openExternal)
}

const $ = (id) => document.getElementById(id)
function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** Sets maxlength on a textarea and keeps `hint` showing "n / max" near the cap. */
function limitInput(input, hint, max) {
  input.maxLength = max
  const update = () => {
    const n = input.value.length
    hint.hidden = n < max * LIMIT_HINT_AT
    hint.textContent = n >= max ? `${n} / ${max}: limit reached` : `${n} / ${max}`
  }
  input.addEventListener('input', update)
  update()
}

// Why the draft is not saved: `tooLarge` from the page's own check, `hostError` from the host.
const saveState = { tooLarge: '', hostError: '' }
function showSaveState() {
  const msg = saveState.tooLarge || saveState.hostError
  $('draft-error').textContent = msg
  $('draft-error').hidden = !msg
}

/** Posts the draft, unless it is too large to store: then it says so and posts nothing. True when posted. */
function postDraft() {
  const size = JSON.stringify(state.draft).length
  saveState.tooLarge =
    size > DRAFT_JSON_MAX ? `Draft not saved: it is too large (${size} of ${DRAFT_JSON_MAX} characters). Shorten or delete a note; the last saved draft is kept.` : ''
  showSaveState()
  if (saveState.tooLarge) return false
  ccPanel.post({ type: 'draft', draft: state.draft })
  return true
}

function refreshHighlights() {
  if (isHtml()) return refreshHtmlHighlights()
  for (const side of ['old', 'new']) {
    const v = state.views[side]
    if (!v) continue
    const notes = state.draft.notes.filter((n) => n.side === side)
    v.dispatch({ effects: setNoted.of(notedDecorations(v.state.doc, notes)) })
  }
}

// ---- editors ----

// An annotated text: markdown-ish colouring at most (what a source plugin is likely to hand over),
// and wrapped lines, since a ticket or a mail is prose, not code.
const isText = () => !!state.sides && state.sides.mode === 'text'
const isHtml = () => !!state.sides && state.sides.mode === 'html'

function extensionsFor(side, path) {
  return [
    lineNumbers(),
    foldGutter(),
    highlightActiveLine(),
    drawSelection(),
    highlightSelectionMatches(),
    EditorState.readOnly.of(true), // the reviewer only reads; Edit opens the editor
    keymap.of([...searchKeymap, { key: 'a', run: () => (addNote(side), true) }, { key: 'e', run: () => (edit(), true) }, { key: 'j', run: goToNextChunk }, { key: 'k', run: goToPreviousChunk }]),
    isText() ? [markdown(), EditorView.lineWrapping] : languageFor(path),
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
  if (isHtml()) {
    $('layout').hidden = true
    host.append(htmlView.scroller)
    return
  }
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
  placeOpenUrl()
}

/**
 * Puts annotate's "Open in browser" icon (#open-url, the page's own element) next to the title in
 * the document: at the end of the HTML's first h1, else floated to the top right of the HTML
 * document, or in the top right corner of the text pane. Hidden until the HTML is rendered, and
 * always when the overlay has no url to open.
 */
function placeOpenUrl() {
  const b = $('open-url')
  // The markup's indentation left whitespace text nodes in the icon. Inside the HTML document they
  // would count in a selection's offsets (Range.toString) but not in `full`, shifting every note.
  const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT)
  const blanks = []
  for (let n = w.nextNode(); n; n = w.nextNode()) blanks.push(n)
  for (const n of blanks) n.remove()
  b.classList.remove('in-title', 'float', 'corner')
  if (!b.dataset.show || (isHtml() && !htmlView.rendered)) {
    b.hidden = true
    return
  }
  if (isHtml()) {
    const h1 = htmlView.body.querySelector('h1')
    if (h1) {
      b.classList.add('in-title')
      h1.append(b)
    } else {
      b.classList.add('float')
      htmlView.body.prepend(b)
    }
  } else {
    b.classList.add('corner')
    $('editors').append(b)
  }
  b.hidden = false
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
  if (isHtml()) return htmlSelection() ? 'new' : null
  if (state.lastSide && selectionOf(state.lastSide)) return state.lastSide
  return ['new', 'old'].find((s) => selectionOf(s)) || null
}

const atNoteLimit = () => state.draft.notes.length >= NOTES_MAX

/** Where the selection ends, as a client rect ({ left, right, top, bottom }), or null. */
function selectionEndRect() {
  const lastRect = (r) => {
    const rects = [...r.getClientRects()].filter((x) => x.width || x.height)
    return rects.length ? rects[rects.length - 1] : r.getBoundingClientRect()
  }
  if (isHtml()) {
    const r = htmlSelection() && htmlSelectionRange()
    return r ? lastRect(r) : null
  }
  const side = currentSelectionSide()
  if (!side) return null
  if (side === 'old' && !state.views.old && state.oldPick) {
    // A removed block of the unified view: under the selection inside it, else under its start
    // (a click picks the whole block, which may be wider than the screen).
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed && sel.rangeCount && state.oldPick.el.contains(sel.anchorNode)) return lastRect(sel.getRangeAt(0))
    const b = state.oldPick.el.getBoundingClientRect()
    return { left: b.left + 24, right: b.left + 24, top: b.top, bottom: b.bottom }
  }
  const v = state.views[side]
  return v ? v.coordsAtPos(v.state.selection.main.to, -1) : null
}

// "Add note" floats just under the end of the selection, in every mode: one place to look, next to
// the text it is about. Positioned in a microtask, never inside a CodeMirror update listener (which
// may not read layout), and coalesced, since selectionchange and scroll fire in bursts.
let floatQueued = false
function updateAddButton() {
  $('notes-limit').hidden = !atNoteLimit()
  $('add-note').disabled = atNoteLimit() // shown, but off: the hint above the notes says why
  if (floatQueued) return
  floatQueued = true
  queueMicrotask(placeAddButton)
}

function placeAddButton() {
  floatQueued = false
  const btn = $('add-note')
  // Typing in a note or the comment: the selection left behind in the document is not what the
  // person is working on now.
  const t = document.activeElement
  const typing = !!t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT')
  const at = !typing && $('lightbox').hidden ? selectionEndRect() : null
  const area = $('editors').getBoundingClientRect()
  // Scrolled out of the document area: hidden, not pinned to its edge.
  if (!at || at.bottom < area.top || at.top > area.bottom || at.right < area.left || at.left > area.right) {
    btn.hidden = true
    return
  }
  btn.hidden = false
  const gap = 4
  const w = btn.offsetWidth
  const h = btn.offsetHeight
  let top = at.bottom + gap
  if (top + h > Math.min(area.bottom, window.innerHeight) - gap) top = at.top - h - gap // no room under it: above
  const left = Math.min(Math.max(gap, at.right - w / 2), window.innerWidth - w - gap)
  btn.style.left = `${Math.round(left)}px`
  btn.style.top = `${Math.round(Math.max(gap, top))}px`
}

/** Collapses the selection a note was just made from, so the floating button goes with it. */
function collapseSelection(side) {
  if (isHtml()) {
    const sel = window.getSelection()
    if (sel) sel.removeAllRanges()
    return
  }
  const v = state.views[side]
  if (v && !v.state.selection.main.empty) v.dispatch({ selection: { anchor: v.state.selection.main.to } })
}

let noteSeq = 0
function addNote(sideHint) {
  if (atNoteLimit()) return updateAddButton() // the hint says why
  if (isHtml()) return addHtmlNote()
  const side = sideHint && selectionOf(sideHint) ? sideHint : currentSelectionSide()
  if (!side) return
  const sel = selectionOf(side)
  const note = { id: `n${Date.now().toString(36)}${noteSeq++}`, side, from: sel.from, to: sel.to, quote: sel.quote, text: '' }
  if (side === 'old') clearPick()
  collapseSelection(side)
  state.draft.notes.push(note)
  renderNotes(note.id)
  refreshHighlights()
  updateAddButton()
  postDraft()
}

function scrollTo(note) {
  if (isHtml()) return scrollToHtml(note)
  const v = state.views[note.side]
  if (!v) return
  const line = v.state.doc.line(Math.min(note.from, v.state.doc.lines))
  v.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'center' }) })
}

const QUOTE_SHOWN = 90 // a note row shows this much of its quote, made one line

/** A quote as one line of at most QUOTE_SHOWN chars. */
function shortQuote(q) {
  const one = (q || '').replace(/\s+/g, ' ').trim()
  return one.length > QUOTE_SHOWN ? `${one.slice(0, QUOTE_SHOWN)}…` : one
}

/** Grows a note's textarea with its text, up to the CSS max-height (then it scrolls). */
function fitText(t) {
  t.style.height = 'auto'
  t.style.height = `${t.scrollHeight + 2}px`
}

// The notes: a compact numbered list right under the comment (no sidebar: the document gets the
// width). Each row: where the note is (a click shows it in the text), the quote, the note's text
// (beside the quote when both fit on one line, else under it) and a delete button. The list takes
// no room while there is no note; the comment's placeholder says how to make one.
function renderNotes(focusId) {
  const list = $('notes')
  list.replaceChildren()
  const notes = isHtml() ? htmlNotesInOrder() : [...state.draft.notes].sort((a, b) => a.from - b.from || (a.side === 'old' ? -1 : 1))
  list.hidden = !notes.length
  for (const n of notes) {
    const row = el('li', 'note')
    const body = el('div', 'note-body')
    const where = isHtml()
      ? htmlNoteLabel(n)
      : el('button', 'link', `${n.from === n.to ? `Line ${n.from}` : `Lines ${n.from}-${n.to}`}${state.sides.mode === 'diff' ? (n.side === 'old' ? ' · old' : ' · new') : ''}`)
    where.type = 'button'
    where.title = where.title || (isText() || isHtml() ? 'Show in the text' : 'Show in the diff')
    where.addEventListener('click', () => scrollTo(n))
    body.append(where)
    // In HTML mode the label is the quote itself; a line note shows it after the line range.
    if (!isHtml() && n.quote) body.append(el('span', 'quote', shortQuote(n.quote)))
    const text = el('textarea', 'note-text')
    text.placeholder = 'Your note'
    text.rows = 1
    text.value = n.text
    text.setAttribute('aria-label', `Note on ${isHtml() ? shortQuote(n.quote) : where.textContent}`)
    text.addEventListener('input', () => {
      n.text = text.value
      fitText(text)
      postDraft()
    })
    const hint = el('div', 'limit')
    limitInput(text, hint, NOTE_MAX)
    body.append(text, hint)
    const del = el('button', 'note-del', '✕')
    del.type = 'button'
    del.title = 'Delete this note'
    del.setAttribute('aria-label', 'Delete note')
    del.addEventListener('click', () => {
      state.draft.notes = state.draft.notes.filter((x) => x.id !== n.id)
      renderNotes()
      refreshHighlights()
      updateAddButton()
      postDraft()
    })
    row.append(body, del)
    list.append(row)
    setTimeout(() => fitText(text), 0) // once laid out: scrollHeight is 0 before
    if (n.id === focusId) {
      setTimeout(() => {
        row.scrollIntoView({ block: 'nearest' })
        text.focus()
      }, 0)
    }
  }
}

// ---- HTML mode (annotate with html) ----

// The rendered document and what the notes need of it. `full` is the concatenation of its text
// nodes (anchor.mjs offsets point into it); `texts` maps offsets back to nodes, for ranges.
const htmlView = {
  scroller: null, // the scrolling block in #editors
  body: null, // the rendered document inside it
  parts: [], // the html parts received so far
  rendered: false,
  full: '',
  texts: [], // [{ node, start }] in document order
  assets: new Map(), // id -> { mime, name } as the init declared them
  data: new Map(), // id -> dataUrl, once it came
  assetsDone: false,
  located: new Map(), // note id -> { start, end } in `full`, for the notes found in this version
}

{
  htmlView.scroller = el('div', 'doc')
  htmlView.scroller.tabIndex = 0
  htmlView.body = el('article', 'doc-body')
  htmlView.scroller.append(htmlView.body)
}

function startHtml(s) {
  htmlView.parts = new Array(Math.max(1, Number.isInteger(s.htmlParts) ? s.htmlParts : 1)).fill(null)
  htmlView.assets = new Map((Array.isArray(s.assets) ? s.assets : []).filter((a) => a && typeof a.id === 'string').map((a) => [a.id, a]))
  htmlView.body.replaceChildren(el('p', 'muted', 'Loading…'))
}

function htmlPart(m) {
  if (!isHtml() || htmlView.rendered || !Number.isInteger(m.index) || m.index < 0 || m.index >= htmlView.parts.length) return
  if (typeof m.part !== 'string') return
  htmlView.parts[m.index] = m.part
  if (htmlView.parts.every((p) => p !== null)) renderHtml(htmlView.parts.join(''))
}

/** Parses (inert), sanitizes and renders the caller's HTML; then finds the draft's notes in it. */
function renderHtml(source) {
  htmlView.rendered = true
  htmlView.parts = []
  const parsed = new DOMParser().parseFromString(source, 'text/html')
  htmlView.body.replaceChildren(render(sanitizeTree(parsed.body), document))
  const texts = []
  let full = ''
  const walker = document.createTreeWalker(htmlView.body, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    texts.push({ node: n, start: full.length })
    full += n.data
  }
  htmlView.full = full
  htmlView.texts = texts
  showAssets(htmlView.body)
  prepareLinks(htmlView.body)
  placeOpenUrl() // after the text walk: the button holds no text, so the offsets would not move anyway
  refreshHighlights() // finds the draft's notes first: the list says which were not found
  renderNotes()
  updateAddButton()
}

/** The images under `root` (the document or the details column): loaded, failed, or left pending. */
function showAssets(root) {
  for (const img of root.querySelectorAll('img[data-asset]')) {
    if (!htmlView.assets.has(img.dataset.asset)) assetFailed(img) // named by the HTML, never sent
    else if (htmlView.data.has(img.dataset.asset)) assetLoaded(img, htmlView.data.get(img.dataset.asset))
  }
  if (htmlView.assetsDone) htmlAssetsDone()
}

const assetRoots = () => [htmlView.body, $('details-body')]

function assetLoaded(img, dataUrl) {
  img.src = dataUrl
  img.parentElement.classList.remove('pending', 'failed')
  if (!img.alt) img.alt = (htmlView.assets.get(img.dataset.asset) || {}).name || ''
}

function assetFailed(img) {
  img.parentElement.classList.remove('pending')
  img.parentElement.classList.add('failed')
}

function htmlAsset(m) {
  const want = htmlView.assets.get(m.id)
  // Only an asset the init declared, of its declared type, as a base64 image data: URL (the host
  // checked it; the page does not take an image src on trust either).
  if (!want || !isImageDataUrl(m.dataUrl) || !m.dataUrl.startsWith(`data:${want.mime};base64,`)) return
  htmlView.data.set(m.id, m.dataUrl)
  for (const root of assetRoots()) for (const img of root.querySelectorAll('img[data-asset]')) if (img.dataset.asset === m.id) assetLoaded(img, m.dataUrl)
}

function htmlAssetsDone() {
  htmlView.assetsDone = true
  for (const root of assetRoots()) for (const img of root.querySelectorAll('.asset-box.pending > img')) assetFailed(img)
}

/** The offset in `full` of a DOM boundary point inside the document. */
function offsetOf(container, offset) {
  const r = document.createRange()
  r.selectNodeContents(htmlView.body)
  r.setEnd(container, offset)
  return r.toString().length
}

/** The selection as a Range cut to the rendered document, or null. */
function htmlSelectionRange() {
  if (!htmlView.rendered) return null
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null
  const r = sel.getRangeAt(0).cloneRange()
  if (!r.intersectsNode(htmlView.body)) return null
  // A drag that ran past the document's edge keeps the part inside it.
  if (!htmlView.body.contains(r.startContainer)) r.setStart(htmlView.body, 0)
  if (!htmlView.body.contains(r.endContainer)) r.setEnd(htmlView.body, htmlView.body.childNodes.length)
  return r
}

/** The selection inside the rendered document, as { start, end } offsets in `full`, or null. */
function htmlSelection() {
  const r = htmlSelectionRange()
  if (!r) return null
  const start = offsetOf(r.startContainer, r.startOffset)
  const end = offsetOf(r.endContainer, r.endOffset)
  if (end <= start || !htmlView.full.slice(start, end).trim()) return null
  return { start, end }
}

/** A DOM Range over [start, end) of `full`. */
function rangeOf(start, end) {
  const point = (off, isEnd) => {
    // The last text node starting at or before `off` (for an end, strictly before, so a range
    // ending at a node's start ends in the node before it).
    let lo = 0
    let hi = htmlView.texts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (isEnd ? htmlView.texts[mid].start < off : htmlView.texts[mid].start <= off) lo = mid
      else hi = mid - 1
    }
    const t = htmlView.texts[lo]
    return [t.node, Math.min(off - t.start, t.node.data.length)]
  }
  const r = document.createRange()
  r.setStart(...point(start, false))
  r.setEnd(...point(end, true))
  return r
}

function addHtmlNote() {
  const sel = htmlSelection()
  if (!sel) return
  const { quote, anchor } = makeAnchor(htmlView.full, sel.start, sel.end)
  const note = { id: `n${Date.now().toString(36)}${noteSeq++}`, quote, anchor, text: '' }
  htmlView.located.set(note.id, { start: sel.start, end: sel.end })
  collapseSelection()
  state.draft.notes.push(note)
  renderNotes(note.id)
  refreshHighlights()
  updateAddButton()
  postDraft()
}

/** HTML notes where they are in the text, then the ones not found in this version (and old line notes). */
function htmlNotesInOrder() {
  const pos = (n) => (htmlView.located.has(n.id) ? htmlView.located.get(n.id).start : Infinity)
  return [...state.draft.notes].sort((a, b) => pos(a) - pos(b))
}

function htmlNoteLabel(n) {
  const shown = `«${shortQuote(n.quote)}»`
  // Before the document is rendered nothing is located yet: no "not found" for that moment.
  const found = htmlView.located.has(n.id) || !htmlView.rendered
  const b = el('button', found ? 'link quote' : 'link quote outdated', found ? shown : `${shown} · not found in this version`)
  if (!found) b.title = 'The quoted text is not in the document any more: the note is kept, not highlighted'
  return b
}

let focusedNote = null
function refreshHtmlHighlights() {
  if (!htmlView.rendered) return
  htmlView.located = new Map()
  for (const n of state.draft.notes) {
    const at = n.anchor ? locate(htmlView.full, n) : null
    if (at) htmlView.located.set(n.id, at)
  }
  // The CSS Custom Highlight API paints the ranges without touching the DOM, so offsets stay true.
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return
  const all = []
  for (const at of htmlView.located.values()) all.push(rangeOf(at.start, at.end))
  CSS.highlights.set('rv-note', new Highlight(...all))
  const f = focusedNote && htmlView.located.get(focusedNote)
  if (f) CSS.highlights.set('rv-note-focus', new Highlight(rangeOf(f.start, f.end)))
  else CSS.highlights.delete('rv-note-focus')
}

function scrollToHtml(note) {
  const at = htmlView.located.get(note.id)
  if (!at) return
  focusedNote = note.id
  refreshHtmlHighlights()
  const r = rangeOf(at.start, at.end)
  const target = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement
  if (target) target.scrollIntoView({ block: 'center' })
}

// Links: the frame may not navigate, so a link of the caller's content opens through the host: a
// plain click, Enter on a focused link or a middle click posts { type: 'open-link', href } with the
// href of the sanitized DOM, and the host opens it in the browser only when the caller's own html or
// aside has that link, and only http(s); it answers with the reason otherwise. The same in the
// document and in the details column. A click that ends a drag-select is the end of a selection for
// a note, not a request to leave (isPlainClick). Without ctx.openExternal the click only shows where
// the link goes.

/** Each link shows its URL as a tooltip unless it has a title of its own. */
function prepareLinks(root) {
  for (const a of root.querySelectorAll('a[href]')) if (!a.title) a.title = a.getAttribute('href')
}

function openLink(a) {
  const href = a.getAttribute('href')
  if (!state.canOpenLinks) {
    $('status').textContent = `Link (not opened from here): ${href}`
    return
  }
  $('status').textContent = ''
  ccPanel.post({ type: 'open-link', href })
}

let linkDown = null // { x, y, sel } at the last mousedown in the document or the details column
const selectionNow = () => selectionKey(document.getSelection())
function plainClick(e) {
  const sel = document.getSelection()
  return isPlainClick(linkDown, { x: e.clientX, y: e.clientY, detail: e.detail, collapsed: !sel || sel.isCollapsed, sel: selectionNow() })
}

for (const root of assetRoots()) {
  root.addEventListener('mousedown', (e) => {
    linkDown = { x: e.clientX, y: e.clientY, sel: selectionNow() }
  })
  root.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a')
    if (a) {
      e.preventDefault()
      if (a.hasAttribute('href') && plainClick(e)) openLink(a)
      return
    }
    const img = e.target.closest && e.target.closest('.asset-box:not(.pending):not(.failed) > img')
    if (img) openLightbox(img)
  })
  root.addEventListener('auxclick', (e) => {
    const a = e.target.closest && e.target.closest('a')
    if (!a) return
    e.preventDefault()
    if (e.button === 1 && a.hasAttribute('href') && plainClick(e)) openLink(a)
  })
  // Enter on the focused link itself (not on the "Open in browser" icon inside a linked h1). Taken in
  // keydown, so the browser's own activation click does not follow.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || !(e.target instanceof Element) || !e.target.matches('a[href]')) return
    e.preventDefault()
    openLink(e.target)
  })
}

// annotate's `aside`: the caller's details column (key fields), sanitized like the document and
// rendered once. It has no notes: a selection there is not in the document's text.
let asideRendered = false
function renderAside(m) {
  if (asideRendered || !state.sides || !state.sides.aside || typeof m.html !== 'string') return
  asideRendered = true
  const parsed = new DOMParser().parseFromString(m.html, 'text/html')
  $('details-body').replaceChildren(render(sanitizeTree(parsed.body), document))
  showAssets($('details-body'))
  prepareLinks($('details-body'))
}

// The lightbox: an image shown larger above the review. A click or a key closes it; Esc is not
// the page's to take (main closes the whole overlay on Esc, the draft kept), so it closes both.
function openLightbox(img) {
  const box = $('lightbox')
  const big = $('lightbox-img')
  big.src = img.src
  big.alt = img.alt
  box.hidden = false
  box.focus()
  updateAddButton()
}
function closeLightbox() {
  $('lightbox').hidden = true
  $('lightbox-img').removeAttribute('src')
  updateAddButton()
}
$('lightbox').addEventListener('click', closeLightbox)
$('lightbox').addEventListener('keydown', (e) => {
  e.preventDefault()
  e.stopPropagation()
  closeLightbox()
  htmlView.scroller.focus()
})

// The floating "Add note" follows the selection: CodeMirror's update listener covers its panes, these
// the HTML document, the unified view's removed blocks, scrolling (capture: the scrollers are
// elements, not the window), a resize and focus moving into a note or the comment.
document.addEventListener('selectionchange', () => updateAddButton())
document.addEventListener('scroll', () => updateAddButton(), true)
window.addEventListener('resize', () => updateAddButton())
document.addEventListener('focusin', () => updateAddButton())
document.addEventListener('focusout', () => updateAddButton())
// `a` adds a note on the selection, as in a file review (where CodeMirror's keymap handles it).
document.addEventListener('keydown', (e) => {
  if (!isHtml() || e.key !== 'a' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
  const t = e.target
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return
  e.preventDefault()
  addNote()
})

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
  // An annotated text is no file: there is nothing to edit (the button is hidden; this is the `e` key).
  if (state.sides.newMissing || isText() || isHtml()) return
  const v = state.views.new
  const line = v ? v.state.doc.lineAt(v.state.selection.main.head).number : 1
  // Edit closes the review: not while the draft is unsaved, or the unsaved part is gone.
  if (!postDraft()) {
    $('status').textContent = 'Not opening the editor: the draft is not saved.'
    return
  }
  $('status').textContent = 'Opening the editor…'
  ccPanel.post({ type: 'edit', line })
}

function finish(action) {
  // Post the draft before any check below can return: a refusal (no tab chosen) that skipped the
  // save let a following Esc or ✕ lose the text.
  const posted = postDraft()
  if (action === 'close') {
    // No draft in the result: the host has the last one that fit, and a draft too large for a
    // message would be dropped with the result, leaving Close doing nothing.
    ccPanel.post({ result: { action } })
    return
  }
  if (!posted) {
    $('status').textContent = 'Not sent: the draft is too large. Shorten or delete a note first.'
    return
  }
  const empty = !state.draft.global.trim() && state.draft.notes.every((n) => !n.text.trim())
  if (empty) {
    $('status').textContent = 'Nothing to send yet: write a comment or a note.'
    return
  }
  if (action === 'discuss' && !state.tabId) {
    $('status').textContent = 'Choose the Claude tab to send the review to.'
    $('target').focus()
    return
  }
  ccPanel.post({ result: { action, tabId: state.tabId, draft: state.draft } })
}

// ---- init ----

function init(m) {
  state.sides = m.sides
  state.draft = m.draft || { global: '', notes: [] }
  state.tabs = m.tabs || []
  state.tabId = m.tabId || null
  state.layout = m.layout === 'unified' ? 'unified' : 'split'
  state.canOpenLinks = m.canOpenLinks === true
  $('layout').textContent = state.layout === 'split' ? 'Unified' : 'Side by side'
  const s = state.sides
  $('path').textContent = s.path
  $('base').textContent = s.mode === 'diff' ? `vs last commit ${s.head ? s.head.slice(0, 8) : ''}` : ''
  // annotate: the overlay's title bar already names the text, and the document usually does too, so
  // no header row (a third copy of the title). The file review keeps it: path, base, layout toggle.
  document.querySelector('header').hidden = isText() || isHtml()
  // annotate's url as an icon button, not the long URL as text: the page cannot navigate (a sandboxed
  // frame), so the click asks the host, which opens the URL it was given. The URL is only shown in
  // the tooltip. Off when the host cannot open links (no ctx.openExternal); placeOpenUrl puts it in
  // the document.
  const openUrl = $('open-url')
  openUrl.dataset.show = (isText() || isHtml()) && s.url && m.canOpenUrl ? '1' : ''
  openUrl.title = openUrl.dataset.show ? `Open in browser: ${s.url}` : 'Open in browser'
  // The hint on making a note lives here: the notes list takes no room while it is empty.
  const how = 'for a note on a part, select it, then press a or "Add note"'
  $('global').placeholder = isText() || isHtml() ? `Comment on the whole text (optional); ${how}` : `Comment on the whole file (optional); ${how}`
  $('details').hidden = !s.aside
  $('note').textContent = s.note || ''
  $('note').hidden = !s.note
  $('global').value = state.draft.global
  limitInput($('global'), $('global-limit'), GLOBAL_MAX)
  $('edit').hidden = m.canEdit === false || isText() || isHtml() // no plugin provides the editor service, or no file
  if (isHtml()) startHtml(s)
  $('edit').disabled = !!s.newMissing
  $('edit').title = s.newMissing ? 'The file is deleted: nothing to edit' : $('edit').title
  buildEditors()
  renderNotes()
  renderTabs()
  if (isHtml()) htmlView.scroller.focus()
  else (state.views.new || state.views.old).focus()
  // The host sends the details column, the HTML parts and the images now.
  if (isHtml() || s.aside) ccPanel.post({ type: 'content' })
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
$('open-url').addEventListener('click', (e) => {
  // Inside the document: not a link click of the document's (an h1 inside an <a>) as well.
  e.stopPropagation()
  $('status').textContent = ''
  ccPanel.post({ type: 'open-url' })
})

ccPanel.onMessage((m) => {
  if (!m || typeof m !== 'object') return
  if (m.type === 'init') init(m)
  else if (m.type === 'error') $('status').textContent = m.message
  else if (m.type === 'draft-error') {
    saveState.hostError = typeof m.message === 'string' ? m.message : 'Draft not saved.'
    showSaveState()
  } else if (m.type === 'draft-saved') {
    saveState.hostError = ''
    showSaveState()
  }
  else if (m.type === 'tabs') {
    state.tabs = m.tabs || []
    renderTabs()
  } else if (m.type === 'html') htmlPart(m)
  else if (m.type === 'aside') renderAside(m)
  else if (m.type === 'asset') htmlAsset(m)
  else if (m.type === 'assets-done') htmlAssetsDone()
})

// The theme arrives in a message after load (`ccc guide panels`): swap the syntax colours then.
if (ccPanel.theme && ccPanel.theme.onChange) {
  ccPanel.theme.onChange(() => {
    for (const v of Object.values(state.views)) if (v) v.dispatch({ effects: themeCompartment.reconfigure(syntaxFor()) })
  })
}
