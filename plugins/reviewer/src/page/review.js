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
// `new` the one read-only pane, with no diff and no layout toggle. 'html' is annotate's
// HTML mode: no pane at all but the caller's HTML, sanitized (sanitize.mjs) and rendered as a
// document; it comes after the init in `htmlParts` { type: 'html', index, part } messages the page
// asks for with { type: 'content' }, followed by one { type: 'asset', id, dataUrl } per image and
// { type: 'assets-done' }. With `sides.aside` (annotate's details column, text or html) the page asks
// too, and { type: 'aside', html } comes first: sanitized the same way, shown in a column at the right. Its notes anchor on the selected text (anchor.mjs), not on lines.
// A plain click on a link in either (or Enter on it, or a middle click) posts { type: 'open-link', href }
// when the init says `canOpenLinks`; the host opens it only when the caller's own html or aside has it.
// With `sides.companion` ({ title, url, htmlParts, facts, label, urlLabel }, annotate's companion)
// the page shows two documents side by side, the main one left and the companion right, each scrolling
// on its own, with a divider between them (dragged: { type: 'split', split } for the host to remember).
// Above them, one grid row of two header cells (so both get the height of the taller): each a bar with
// the column's label (`sides.label`, `sides.companion.label`) and an "Open in <urlLabel> ↗" button, and
// its details block (the main one's `aside`, the companion's facts, { type: 'aside', doc: 'companion',
// html }); the right-hand details column and the icons after the h1s are not shown then. The
// companion's html comes in { type: 'html', doc: 'companion', index, part } messages; the assets are
// one set for both. A note on the companion has `doc: 'companion'`; its button posts { type:
// 'open-url', doc: 'companion' }.
// The page shows the two sides, collects notes and the global comment, and posts
//   { type: 'draft', draft }                          on every change, and when the host asks
//                                                     ({ type: 'draft-request' }: Discuss with Claude);
//   { type: 'draft-unsaved' }                         for a request while the draft is too large;
// Discuss with Claude, New session and Edit are the app's overlay toolbar now (the host answers
// Discuss with the review text; the editor adds "Edit" for the overlay's `file` type), so the page
// has no tab picker, no send buttons and no Close: the toolbar's ✕ and Esc close it (one action
// bar per overlay, guide style.md). The status line sits at the right end of the header row.
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
import { makeAnchor, locate, tailOf } from './anchor.mjs'
import { isPlainClick, selectionKey } from './links.mjs'
import { clampSplit, splitAt, splitKey, selectionDoc, openLabel, SPLIT_DEFAULT } from './split.mjs'
import { originalDocument, FRAME_SANDBOX, FRAME_COLOR_SCHEME } from './original.mjs'
import { markdownHtml, initialMarkdownView, markdownText } from './markdown.mjs'
import { markHtmlLines, mdRangeLines, htmlRangeLines } from './html-lines.mjs'
import { startBytes, formatSize } from './bytes.mjs'
import { showPdfIn, pdfSelection, scrollToPage } from './pdf.js'

/* global ccPanel */

// A rendered HTML file's marks carry this key (html-lines.mjs): a mark without it is the file's own.
const htmlLineKey = String(1e8 + Math.floor(Math.random() * 9e8))

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
  layout: 'split', // 'split' | 'unified'
  views: { old: null, new: null }, // EditorViews by side
  merge: null,
  lastSide: null, // the side whose selection "Add note" uses
  // Unified view: removed lines are a widget the editor does not treat as text, so its selection
  // never sees them. A click or selection inside one picks it here instead (pickDeleted).
  oldPick: null, // { from, to, quote, el }
  canOpenLinks: false, // the host opens links of the caller's content (it has ctx.openExternal)
  split: SPLIT_DEFAULT, // with a companion: the share of the width the main document takes
  // A markdown file (`sides.format: 'markdown'`): 'rendered' shows it like annotate's HTML mode
  // (notes anchor on the selected text), 'source' the usual editors and diff (line notes). One
  // draft holds both kinds of note; each is shown in its own view (scrollTo switches). null: not
  // a markdown file.
  md: null,
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
// isHtml: the document view (rendered HTML, text-anchored notes) is showing: annotate's HTML mode,
// or a markdown file in its Rendered view. isAnnotHtml: annotate's HTML mode only (the caller's
// parts, assets, companion, originals, the bare header).
const isAnnotHtml = () => !!state.sides && state.sides.mode === 'html'
const isHtml = () => isAnnotHtml() || state.md === 'rendered'

function extensionsFor(side, path) {
  return [
    lineNumbers(),
    foldGutter(),
    highlightActiveLine(),
    drawSelection(),
    highlightSelectionMatches(),
    EditorState.readOnly.of(true), // the reviewer only reads; the toolbar's Edit opens the editor
    keymap.of([...searchKeymap, { key: 'a', run: () => (addNote(side), true) }, { key: 'j', run: goToNextChunk }, { key: 'k', run: goToPreviousChunk }]),
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
  // The editors of a markdown file's Source view go when it switches to Rendered (and are built
  // afresh on the way back); annotate never has any.
  if (state.merge) state.merge.destroy()
  for (const v of Object.values(state.views)) if (v && v !== state.merge?.a && v !== state.merge?.b) v.destroy()
  state.merge = null
  state.views = { old: null, new: null }
  if (isPreview()) {
    $('layout').hidden = true
    host.append(preview.el)
    return
  }
  if (isHtml()) {
    $('layout').hidden = true
    if (hasCompanion()) buildSplit(host, initMsg)
    else host.append(htmlView.scroller)
    // Rendered once: the text does not change while the overlay is open, and a second render
    // would only move the notes' located ranges.
    // An HTML file is its own markup (the sanitizer keeps what is safe, as for annotate's HTML).
    if (state.md === 'rendered' && !htmlView.rendered) {
      const text = markdownText(state.sides)
      renderHtml(htmlView, state.sides.format === 'html' ? markHtmlLines(text, htmlLineKey) : markdownHtml(text))
    }
    return
  }

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
 * always when the overlay has no url to open, and beside a companion (the header bars have buttons).
 */
function placeOpenUrl() {
  const b = $('open-url')
  dropBlanks(b)
  b.classList.remove('in-title', 'float', 'corner')
  // Beside a companion each column's header bar has the open button: no icon in the document then.
  if (!b.dataset.show || (isHtml() && !htmlView.rendered) || hasCompanion()) {
    b.hidden = true
  } else if (isHtml()) {
    const h1 = htmlView.body.querySelector('h1')
    if (h1) {
      b.classList.add('in-title')
      h1.append(b)
    } else {
      b.classList.add('float')
      htmlView.body.prepend(b)
    }
    b.hidden = false
  } else {
    b.classList.add('corner')
    $('editors').append(b)
    b.hidden = false
  }
}

/**
 * The markup's indentation left whitespace text nodes in an icon. Inside the HTML document they
 * would count in a selection's offsets (Range.toString) but not in `full`, shifting every note.
 */
function dropBlanks(b) {
  const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT)
  const blanks = []
  for (let n = w.nextNode(); n; n = w.nextNode()) blanks.push(n)
  for (const n of blanks) n.remove()
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
  if (isPreview()) return isPdf() && pdfSelection(preview.el) ? 'new' : null
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
    return r ? lastRect(r.range) : null
  }
  if (isPdf()) {
    const p = pdfSelection(preview.el)
    return p ? lastRect(p.range) : null
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
  // With a companion, each column scrolls on its own: the area is the selection's own column.
  const hs = at && isHtml() ? htmlSelectionRange() : null
  const area = (hs ? hs.view.scroller : $('editors')).getBoundingClientRect()
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
  if (isHtml() || isPreview()) {
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
  if (isPreview()) return isPdf() ? addPdfNote() : undefined
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
  if (note.page) return scrollToPage(preview.el, note.page)
  // A markdown file: a note is shown in the view it was taken in.
  if (state.md === 'source' && note.anchor) setMdView('rendered')
  else if (state.md === 'rendered' && !note.anchor) setMdView('source')
  if (isHtml()) return scrollToHtml(note)
  const v = state.views[note.side]
  if (!v) return
  const line = v.state.doc.line(Math.min(note.from, v.state.doc.lines))
  v.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'center' }) })
}

const QUOTE_SHOWN = 90 // a note row shows this much of its quote, made one line

const TITLE_SHOWN = 32 // a companion note's tag shows this much of the companion's title
const companionTitle = () => (state.sides && state.sides.companion && state.sides.companion.title) || 'the document beside it'
const companionLabel = () => (state.sides && state.sides.companion && state.sides.companion.label) || companionTitle()
const shortTitle = (t) => (t.length > TITLE_SHOWN ? `${t.slice(0, TITLE_SHOWN)}…` : t)

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
  // Source view: line notes by line, then a markdown file's text notes (taken in Rendered).
  // A PDF's notes are page notes: by page.
  const lineOrder = (a, b) => (a.anchor ? 1 : 0) - (b.anchor ? 1 : 0) || (a.anchor ? 0 : (a.page || a.from) - (b.page || b.from) || (a.side === 'old' ? -1 : 1))
  const notes = isHtml() ? htmlNotesInOrder() : [...state.draft.notes].sort(lineOrder)
  list.hidden = !notes.length
  for (const n of notes) {
    const row = el('li', 'note')
    const body = el('div', 'note-body')
    const where = n.anchor || (isHtml() && !state.md)
      ? htmlNoteLabel(n)
      : n.page
        ? el('button', 'link', `Page ${n.page}`)
        : el('button', 'link', `${n.from === n.to ? `Line ${n.from}` : `Lines ${n.from}-${n.to}`}${state.sides.mode === 'diff' ? (n.side === 'old' ? ' · old' : ' · new') : ''}`)
    where.type = 'button'
    where.title = where.title || (isText() || isHtml() ? 'Show in the text' : 'Show in the diff')
    where.addEventListener('click', () => scrollTo(n))
    // A note on the companion says so in front of its quote: the list holds the notes of both.
    if (isHtml() && n.doc === 'companion') {
      const tag = el('span', 'doc-tag', shortTitle(companionLabel()))
      tag.title = `In ${companionTitle()}`
      body.append(tag)
    }
    body.append(where)
    // In HTML mode the label is the quote itself; a line note shows it after the line range.
    if (!n.anchor && !(isHtml() && !state.md) && n.quote) body.append(el('span', 'quote', shortQuote(n.quote)))
    const text = el('textarea', 'note-text')
    text.placeholder = 'Your note'
    text.rows = 1
    text.value = n.text
    text.setAttribute('aria-label', `Note on ${n.anchor || (isHtml() && !state.md) ? shortQuote(n.quote) : where.textContent}`)
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

// ---- previews: an image, a PDF (sides.mode 'preview') ----
//
// No text and no diff: the init names the kind, the type and the size, and the bytes come after the
// page asks ({ type: 'content' }) as bytes-begin / bytes / bytes-end (bytes.mjs checks them). The
// global comment still works (Discuss sends it with the path); there are no notes on an image.

const isPreview = () => !!state.sides && state.sides.mode === 'preview'
const preview = { el: el('div', 'preview'), transfer: null }

function startPreview(s) {
  preview.el.dataset.kind = s.kind
  preview.el.replaceChildren(el('p', 'muted', s.kind === 'pdf' ? 'Loading the PDF…' : 'Loading the image…'))
}

function previewFailed(why) {
  preview.transfer = null
  preview.el.replaceChildren(el('p', 'preview-error', `Cannot show ${state.sides.path}: ${why}.`))
}

function previewBegin(m) {
  if (!isPreview()) return
  const t = startBytes(m)
  if (t.error) return previewFailed(t.error)
  if (t.kind !== state.sides.kind) return previewFailed('the data is not what the file is')
  preview.transfer = t
}

function previewChunk(m) {
  const t = preview.transfer
  if (!t) return
  const err = t.add(m)
  if (err) previewFailed(err)
}

function previewEnd() {
  const t = preview.transfer
  preview.transfer = null
  if (!t) return
  const r = t.end()
  if (r.error) return previewFailed(r.error)
  if (r.kind === 'image') showImage(r)
  else showPdf(r)
}

/** The image, fitted to the overlay; a click shows it at its own size (and back). */
function showImage(r) {
  const img = document.createElement('img')
  img.className = 'preview-img fit'
  img.alt = state.sides.path
  img.title = 'Click: actual size / fit'
  img.addEventListener('load', () => {
    $('base').textContent = `${img.naturalWidth} × ${img.naturalHeight} · ${formatSize(r.size)}`
  })
  img.addEventListener('error', () => previewFailed('the image could not be decoded'))
  img.addEventListener('click', () => img.classList.toggle('fit'))
  // A data: URL (the page CSP allows data: images and nothing else); an svg in an <img> runs no
  // script and loads nothing.
  img.src = `data:${r.mime};base64,${r.b64}`
  preview.el.replaceChildren(img)
}

const isPdf = () => isPreview() && state.sides.kind === 'pdf'

/** The PDF (pdf.js, loaded now); a note is taken on a selection in a page's text. */
function showPdf(r) {
  preview.el.replaceChildren(el('p', 'muted', 'Opening the PDF…'))
  showPdfIn(preview.el, r.b64)
    .then(({ pages }) => {
      $('base').textContent = `${pages} ${pages === 1 ? 'page' : 'pages'} · ${formatSize(r.size)}`
      renderNotes()
    })
    .catch((e) => previewFailed(e.message))
}

function addPdfNote() {
  const sel = pdfSelection(preview.el)
  if (!sel) return
  const long = sel.quote.length > QUOTE_MAX
  const quote = long ? sel.quote.slice(0, QUOTE_MAX) : sel.quote
  const note = { id: `n${Date.now().toString(36)}${noteSeq++}`, page: sel.page, quote, text: '' }
  // A long selection keeps its end too, so the message shows where it stops (as for markdown).
  if (long) {
    const tail = tailOf(sel.quote, QUOTE_MAX)
    if (tail) note.tail = tail
  }
  collapseSelection()
  state.draft.notes.push(note)
  renderNotes(note.id)
  updateAddButton()
  postDraft()
}

// ---- HTML mode (annotate with html) ----

// A rendered document and what the notes need of it: the main one (`htmlView`) and annotate's
// companion (`companionView`). `full` is the concatenation of its text nodes (anchor.mjs offsets
// point into it); `texts` maps offsets back to nodes, for ranges. `facts` is the details block in its
// column's header cell, outside `body`, so its text is never in `full`: used with a companion only
// (buildSplit); without one the main `aside` is the column at the right, as before.
function docView(name) {
  const v = {
    name, // 'main' | 'companion'
    scroller: el('div', 'doc'), // the scrolling block (in #editors, or a column of the split)
    facts: el('div', 'doc-body col-facts'),
    body: el('article', 'doc-body'), // the rendered document inside it
    parts: [], // the html parts received so far
    rendered: false,
    full: '',
    texts: [], // [{ node, start }] in document order
  }
  v.scroller.tabIndex = 0
  v.facts.hidden = true
  v.scroller.append(v.body)
  return v
}
const htmlView = docView('main')
const companionView = docView('companion')

const hasCompanion = () => isHtml() && !!state.sides.companion
/** The documents shown, in column order. */
const docViews = () => (hasCompanion() ? [htmlView, companionView] : [htmlView])
/** The document a note is on: the companion's notes have `doc: 'companion'` (null: no companion shown now). */
const viewOf = (n) => (n.doc === 'companion' ? (hasCompanion() ? companionView : null) : htmlView)

// The images of both documents: one set, as the init declared them (the host checked the ids).
const assetStore = {
  declared: new Map(), // id -> { mime, name } as the init declared them
  data: new Map(), // id -> dataUrl, once it came
  done: false,
}
// Where each note is in its document now: note id -> { view, start, end }, for the notes found.
let located = new Map()

function startHtml(s) {
  const parts = (n) => new Array(Math.max(1, Number.isInteger(n) ? n : 1)).fill(null)
  htmlView.parts = parts(s.htmlParts)
  assetStore.declared = new Map((Array.isArray(s.assets) ? s.assets : []).filter((a) => a && typeof a.id === 'string').map((a) => [a.id, a]))
  htmlView.body.replaceChildren(el('p', 'muted', 'Loading…'))
  startOriginals(s)
  if (s.companion) {
    companionView.parts = parts(s.companion.htmlParts)
    companionView.body.replaceChildren(el('p', 'muted', 'Loading…'))
  }
}

function htmlPart(m) {
  const view = m.doc === 'companion' ? (hasCompanion() ? companionView : null) : isHtml() ? htmlView : null
  if (!view || view.rendered || !Number.isInteger(m.index) || m.index < 0 || m.index >= view.parts.length) return
  if (typeof m.part !== 'string') return
  view.parts[m.index] = m.part
  if (view.parts.every((p) => p !== null)) renderHtml(view, view.parts.join(''))
}

/** Parses (inert), sanitizes and renders a document of the caller's; then finds the draft's notes in it. */
function renderHtml(view, source) {
  view.rendered = true
  view.parts = []
  const parsed = new DOMParser().parseFromString(source, 'text/html')
  view.body.replaceChildren(render(sanitizeTree(parsed.body), document))
  const texts = []
  let full = ''
  const walker = document.createTreeWalker(view.body, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    texts.push({ node: n, start: full.length })
    full += n.data
  }
  view.full = full
  view.texts = texts
  showAssets(view.body)
  prepareLinks(view.body)
  hideParts(view.body)
  placeOpenUrl() // after the text walk: the button holds no text, so the offsets would not move anyway
  if (view === htmlView) for (const id of originals.list.keys()) attachOriginal(id)
  if (view === htmlView && state.sides && state.sides.start === 'end') stickToEnd(view)
  refreshHighlights() // finds the draft's notes first: the list says which were not found
  renderNotes()
  updateAddButton()
}

/**
 * Opens `view` at its end (annotate's `start: 'end'`) and keeps it there while pictures above load
 * and push the end down, until the person scrolls, clicks or types in it: from then on the place is
 * theirs. Only the main document: a companion beside it opens at its top.
 */
function stickToEnd(view) {
  const toEnd = () => {
    view.scroller.scrollTop = view.scroller.scrollHeight
  }
  toEnd()
  requestAnimationFrame(toEnd)
  if (typeof ResizeObserver !== 'function') return
  const keep = new ResizeObserver(toEnd)
  keep.observe(view.body)
  const release = () => {
    keep.disconnect()
    for (const t of ['wheel', 'pointerdown', 'keydown', 'touchstart']) view.scroller.removeEventListener(t, release)
  }
  for (const t of ['wheel', 'pointerdown', 'keydown', 'touchstart']) view.scroller.addEventListener(t, release, { passive: true })
}

/** The images under `root` (a document or a details block): loaded, failed, or left pending. */
function showAssets(root) {
  for (const img of root.querySelectorAll('img[data-asset]')) {
    if (!assetStore.declared.has(img.dataset.asset)) assetFailed(img) // named by the HTML, never sent
    else if (assetStore.data.has(img.dataset.asset)) assetLoaded(img, assetStore.data.get(img.dataset.asset))
  }
  if (assetStore.done) htmlAssetsDone()
}

const assetRoots = () => [htmlView.body, $('details-body'), htmlView.facts, companionView.body, companionView.facts]

function assetLoaded(img, dataUrl) {
  img.src = dataUrl
  img.parentElement.classList.remove('pending', 'failed')
  if (!img.alt) img.alt = (assetStore.declared.get(img.dataset.asset) || {}).name || ''
}

function assetFailed(img) {
  img.parentElement.classList.remove('pending')
  img.parentElement.classList.add('failed')
}

function htmlAsset(m) {
  const want = assetStore.declared.get(m.id)
  // Only an asset the init declared, of its declared type, as a base64 image data: URL (the host
  // checked it; the page does not take an image src on trust either).
  if (!want || !isImageDataUrl(m.dataUrl) || !m.dataUrl.startsWith(`data:${want.mime};base64,`)) return
  assetStore.data.set(m.id, m.dataUrl)
  for (const root of assetRoots()) for (const img of root.querySelectorAll('img[data-asset]')) if (img.dataset.asset === m.id) assetLoaded(img, m.dataUrl)
  originalAssetCame(m.id)
}

function htmlAssetsDone() {
  assetStore.done = true
  rebuildOriginals()
  for (const root of assetRoots()) for (const img of root.querySelectorAll('.asset-box.pending > img')) assetFailed(img)
}

/** The offset in `view.full` of a DOM boundary point inside the document. */
function offsetOf(view, container, offset) {
  const r = document.createRange()
  r.selectNodeContents(view.body)
  r.setEnd(container, offset)
  return r.toString().length
}

/**
 * The selection as { view, range }: the document it is in (with a companion, the one it starts in,
 * else the first it touches: selectionDoc) and the range cut to that document; or null.
 */
function htmlSelectionRange() {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null
  const raw = sel.getRangeAt(0)
  const views = docViews().filter((v) => v.rendered)
  const i = selectionDoc(views.map((v) => ({ touches: raw.intersectsNode(v.body), starts: v.body.contains(raw.startContainer) })))
  if (i === -1) return null
  const view = views[i]
  const r = raw.cloneRange()
  // A drag that ran past the document's edge (into the other column, too) keeps the part inside it.
  if (!view.body.contains(r.startContainer)) r.setStart(view.body, 0)
  if (!view.body.contains(r.endContainer)) r.setEnd(view.body, view.body.childNodes.length)
  return { view, range: r }
}

/** The selection inside a rendered document, as { view, start, end } offsets in its `full`, or null. */
function htmlSelection() {
  const hs = htmlSelectionRange()
  if (!hs) return null
  const { view, range: r } = hs
  const start = offsetOf(view, r.startContainer, r.startOffset)
  const end = offsetOf(view, r.endContainer, r.endOffset)
  if (end <= start || !view.full.slice(start, end).trim()) return null
  return { view, start, end }
}

/** A DOM Range over [start, end) of `view.full`. */
function rangeOf(view, start, end) {
  const point = (off, isEnd) => {
    // The last text node starting at or before `off` (for an end, strictly before, so a range
    // ending at a node's start ends in the node before it).
    let lo = 0
    let hi = view.texts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (isEnd ? view.texts[mid].start < off : view.texts[mid].start <= off) lo = mid
      else hi = mid - 1
    }
    const t = view.texts[lo]
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
  const { quote, anchor } = makeAnchor(sel.view.full, sel.start, sel.end)
  const note = { id: `n${Date.now().toString(36)}${noteSeq++}`, quote, anchor, text: '' }
  // The quote keeps the selection's first chars (it is also what finds the note again); a longer
  // selection keeps its end too, so the message can show where it stops.
  if (anchor.length > quote.length) {
    const tail = tailOf(sel.view.full.slice(sel.start, sel.end), quote.length)
    if (tail) note.tail = tail
  }
  // Source lines for a rendered markdown or HTML file, read from the marked block that holds each
  // end of the selection (markdown.mjs, html-lines.mjs), never by looking the quote up in the source:
  // a phrase that is in two paragraphs gets the line of the one selected. Annotate's HTML has none.
  if (state.md === 'rendered' && sel.view === htmlView) {
    const r = htmlSelectionRange()
    const lines = r && (state.sides.format === 'markdown' ? mdRangeLines(r.range, htmlView.body) : state.sides.format === 'html' ? htmlRangeLines(r.range, htmlView.body, markdownText(state.sides), htmlLineKey) : null)
    if (lines) note.lines = lines
  }
  if (sel.view === companionView) note.doc = 'companion'
  located.set(note.id, { view: sel.view, start: sel.start, end: sel.end })
  collapseSelection()
  state.draft.notes.push(note)
  renderNotes(note.id)
  refreshHighlights()
  updateAddButton()
  postDraft()
}

/** HTML notes where they are in the text (the main document's, then the companion's), then the ones not found in this version (and old line notes). */
function htmlNotesInOrder() {
  const pos = (n) => {
    const at = located.get(n.id)
    return at ? [at.view === companionView ? 1 : 0, at.start] : [2, 0]
  }
  return [...state.draft.notes].sort((a, b) => {
    const [x, y] = [pos(a), pos(b)]
    return x[0] - y[0] || x[1] - y[1]
  })
}

function htmlNoteLabel(n) {
  const where = n.lines ? `${n.lines.from === n.lines.to ? `Line ${n.lines.from}` : `Lines ${n.lines.from}-${n.lines.to}`} · ` : ''
  const shown = `${where}«${shortQuote(n.quote)}»`
  // Before its document is rendered nothing is located yet: no "not found" for that moment.
  const view = viewOf(n)
  const found = located.has(n.id) || (view !== null && !view.rendered)
  const b = el('button', found ? 'link quote' : 'link quote outdated', found ? shown : `${shown} · not found in this version`)
  if (!found) b.title = 'The quoted text is not in the document any more: the note is kept, not highlighted'
  return b
}

let focusedNote = null
function refreshHtmlHighlights() {
  located = new Map()
  for (const n of state.draft.notes) {
    const view = n.anchor ? viewOf(n) : null
    if (!view || !view.rendered) continue
    const at = locate(view.full, n)
    if (at) located.set(n.id, { view, ...at })
  }
  // The CSS Custom Highlight API paints the ranges without touching the DOM, so offsets stay true.
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return
  const all = []
  for (const at of located.values()) all.push(rangeOf(at.view, at.start, at.end))
  CSS.highlights.set('rv-note', new Highlight(...all))
  const f = focusedNote && located.get(focusedNote)
  if (f) CSS.highlights.set('rv-note-focus', new Highlight(rangeOf(f.view, f.start, f.end)))
  else CSS.highlights.delete('rv-note-focus')
}

function scrollToHtml(note) {
  const at = located.get(note.id)
  if (!at) return
  focusedNote = note.id
  refreshHtmlHighlights()
  const r = rangeOf(at.view, at.start, at.end)
  const target = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement
  // A note on the mail's text is on the Reader rendering, which the Original view hides: show it.
  if (target && originals.view === 'original' && target.closest('.rv-has-original')) setView('reader', true)
  if (target) target.scrollIntoView({ block: 'center' })
}

// ---- the companion's columns ----

/**
 * A column's header cell: a bar with its label and, when the host can open its url, the open button
 * (posting { type: 'open-url', doc? }), then its details block.
 */
function columnHead(view, { label, url, urlLabel, canOpen, doc }) {
  const head = el('div', `col-head col-head-${view.name}`)
  const bar = el('div', 'col-bar')
  const name = el('strong', 'col-label', label || '')
  name.title = label || ''
  bar.append(name)
  if (url && canOpen) {
    const b = el('button', 'col-open', openLabel(urlLabel))
    b.type = 'button'
    b.title = `${openLabel(urlLabel, false)}: ${url}`
    b.addEventListener('click', () => {
      setStatus('')
      ccPanel.post(doc ? { type: 'open-url', doc } : { type: 'open-url' })
    })
    bar.append(b)
  }
  head.append(bar, view.facts)
  return head
}

/**
 * The two columns in #editors, one grid: a row of the two header cells (label, open button, facts;
 * the row takes the taller one, so both are the same height, and it stays put while the documents
 * scroll), a row of the two documents, and the divider spanning both. The divider drags (and arrow
 * keys move) the split. Stacked when narrow (CSS): each header above its own document.
 */
function buildSplit(host, m) {
  const s = state.sides
  const row = el('div', 'split')
  const divider = el('div', 'divider')
  divider.tabIndex = 0
  divider.setAttribute('role', 'separator')
  divider.setAttribute('aria-orientation', 'vertical')
  divider.setAttribute('aria-label', 'Resize the two documents')
  divider.title = 'Drag to resize; double-click for half and half'
  const mainHead = columnHead(htmlView, { label: s.label, url: s.url, urlLabel: s.urlLabel, canOpen: m.canOpenUrl === true })
  const sideHead = columnHead(companionView, { label: s.companion.label, url: s.companion.url, urlLabel: s.companion.urlLabel, canOpen: m.canOpenCompanionUrl === true, doc: 'companion' })
  const left = el('div', 'col col-main')
  const right = el('div', 'col col-companion')
  left.append(htmlView.scroller)
  right.append(companionView.scroller)
  row.append(mainHead, divider, sideHead, left, right)
  host.append(row)
  const apply = (v, save) => {
    state.split = clampSplit(v)
    row.style.setProperty('--split', `${state.split * 100}%`)
    divider.setAttribute('aria-valuenow', String(Math.round(state.split * 100)))
    if (save) ccPanel.post({ type: 'split', split: state.split }) // remembered for the next one
    updateAddButton()
  }
  apply(state.split, false)
  divider.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    divider.setPointerCapture(e.pointerId)
    row.classList.add('dragging')
    const move = (ev) => {
      const b = row.getBoundingClientRect()
      apply(splitAt(ev.clientX, b.left, b.width), false)
    }
    const up = () => {
      divider.removeEventListener('pointermove', move)
      divider.removeEventListener('pointerup', up)
      divider.removeEventListener('pointercancel', up)
      row.classList.remove('dragging')
      apply(state.split, true)
    }
    divider.addEventListener('pointermove', move)
    divider.addEventListener('pointerup', up)
    divider.addEventListener('pointercancel', up)
  })
  divider.addEventListener('dblclick', () => apply(SPLIT_DEFAULT, true))
  divider.addEventListener('keydown', (e) => {
    const v = splitKey(state.split, e.key)
    if (v === null) return
    e.preventDefault()
    apply(v, true)
  })
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
    setStatus(`Link (not opened from here): ${href}`)
    return
  }
  setStatus('')
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
    const action = e.target.closest && e.target.closest('button.doc-action[data-action]')
    if (action) {
      e.preventDefault()
      onAction(action)
      return
    }
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
// rendered once. It has no notes: a selection there is not in the document's text. With a companion
// the main `aside` is the details block at the top of the main column instead, and the companion's
// facts ({ doc: 'companion' }) the one at the top of its column.
const asideRendered = new Set()
function renderAside(m) {
  const companion = m.doc === 'companion'
  if (!state.sides || typeof m.html !== 'string') return
  if (companion ? !hasCompanion() || !state.sides.companion.facts : !state.sides.aside) return
  const key = companion ? 'companion' : 'main'
  if (asideRendered.has(key)) return
  asideRendered.add(key)
  const target = companion ? companionView.facts : hasCompanion() ? htmlView.facts : $('details-body')
  const parsed = new DOMParser().parseFromString(m.html, 'text/html')
  target.replaceChildren(render(sanitizeTree(parsed.body), document))
  target.hidden = false
  showAssets(target)
  prepareLinks(target)
  hideParts(target)
}

// ---- the Original view (feature 'original') ----
//
// annotate's `originals` [{ id, html }] are the caller's documents as their sender made them (a
// designed mail), each shown in a sandboxed srcdoc frame (original.mjs says why that frame holds even
// if every sanitizer misses something) at the caller's `div[data-original=id]`, in place of the
// allow-list rendering `div[data-reader=id]`. Both stay in the DOM: the view is a class on the
// document, so switching re-renders nothing and the notes keep their anchors (they are on the Reader
// text, which the Original view only hides). The html of each original comes in parts after the main
// document's, as { type: 'original', id, index, part }.
//
// Height: the frame has no script and an opaque origin, so nothing can read its content height (no
// message from inside, no contentDocument from here; CSS `frame-sizing: content-height` parses in
// Chromium 156 but did not size a frame in Electron 45, with or without the ResponsiveIframes flag).
// So each frame is as tall as the visible document area (--rv-frame-h, kept by a ResizeObserver) and
// scrolls on its own; at its end the wheel goes on to the document around it (scroll chaining).
//
// A frame is built again (its srcdoc replaced, so it reloads at its top) when a picture it names
// comes: the first ones together at `assets-done`, a Show images' together after a short wait.
// An original over a limit (originalDocument answers null) leaves the Reader rendering in its place.

const originals = {
  list: new Map(), // id -> { parts, source, frame, links, assets }
  view: 'reader', // 'original' | 'reader': the class on the main document
  bar: null, // the Original | Reader switch and the Links list, above the document
  hinted: false, // the status line said once that notes need the Reader view (hintOriginal)
  pending: new Set(), // ids whose frame waits to be built again with new pictures
  timer: 0,
}

function startOriginals(s) {
  originals.list = new Map()
  for (const o of Array.isArray(s.originals) ? s.originals : []) {
    if (!o || typeof o.id !== 'string' || !Number.isInteger(o.parts) || o.parts < 1 || originals.list.has(o.id)) continue
    originals.list.set(o.id, { parts: new Array(o.parts).fill(null), source: null, frame: null, links: [], assets: new Set() })
  }
  originals.view = s.view === 'reader' ? 'reader' : 'original'
  htmlView.body.classList.toggle('view-original', originals.view === 'original')
}

function originalPart(m) {
  const o = typeof m.id === 'string' ? originals.list.get(m.id) : undefined
  if (!o || o.source !== null || !Number.isInteger(m.index) || m.index < 0 || m.index >= o.parts.length || typeof m.part !== 'string') return
  o.parts[m.index] = m.part
  if (!o.parts.every((p) => p !== null)) return
  o.source = o.parts.join('')
  o.parts = []
  attachOriginal(m.id)
}

/** The frame document of `o` with the pictures that came so far, or null (over a limit, or unparsable). */
function buildOriginal(o) {
  let r = null
  try {
    r = originalDocument(new DOMParser().parseFromString(o.source, 'text/html'), { asset: (id) => assetStore.data.get(id) || null })
  } catch {
    r = null
  }
  if (!r) return null
  o.links = r.links
  o.assets = r.assets
  return r
}

/** Puts original `id`'s frame at its marker once both the main document and the original are in. */
function attachOriginal(id) {
  const o = originals.list.get(id)
  if (!o || o.source === null || o.frame || !htmlView.rendered) return
  const slot = [...htmlView.body.querySelectorAll('div[data-original]')].find((d) => d.dataset.original === id)
  if (!slot) return
  const built = buildOriginal(o)
  if (!built) return // the Reader rendering stays (rv-has-original is never set for it)
  const frame = document.createElement('iframe')
  // Every sandbox restriction but popups (original.mjs). Set before srcdoc, so the document never
  // loads in a less restricted frame.
  frame.setAttribute('sandbox', FRAME_SANDBOX)
  frame.setAttribute('referrerpolicy', 'no-referrer')
  // A light page whatever the app's theme: the element's color-scheme is what the frame's
  // prefers-color-scheme follows (original.mjs BASE_CSS), so a mail's dark-mode CSS stays off.
  frame.style.colorScheme = FRAME_COLOR_SCHEME
  frame.setAttribute('title', 'Original message')
  frame.className = 'original-frame'
  frame.srcdoc = built.html
  slot.replaceChildren(frame)
  slot.classList.add('rv-original')
  for (const r of htmlView.body.querySelectorAll('div[data-reader]')) if (r.dataset.reader === id) r.classList.add('rv-has-original')
  o.frame = frame
  showViewBar()
}

/** A picture came: the frames that name it are built again (batched: Show images sends several). */
function originalAssetCame(id) {
  for (const [key, o] of originals.list) if (o.frame && o.assets.has(id)) originals.pending.add(key)
  if (!originals.pending.size || !assetStore.done) return // the first pictures: all at assets-done
  clearTimeout(originals.timer)
  originals.timer = setTimeout(rebuildOriginals, 150)
}

function rebuildOriginals() {
  clearTimeout(originals.timer)
  for (const key of originals.pending) {
    const o = originals.list.get(key)
    const built = o && o.frame ? buildOriginal(o) : null
    if (built) o.frame.srcdoc = built.html
  }
  originals.pending.clear()
  renderOriginalLinks()
}

/** The links of the frames shown, once each, in document order. */
function originalLinks() {
  const seen = new Map()
  for (const o of originals.list.values()) if (o.frame) for (const l of o.links) if (!seen.has(l.href)) seen.set(l.href, l)
  return [...seen.values()]
}

function showViewBar() {
  if (originals.bar) return renderOriginalLinks()
  const bar = el('div', 'view-bar')
  const group = el('div', 'view-switch')
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', 'View')
  for (const [v, label, title] of [
    ['original', 'Original', 'The message as its sender made it (no script, nothing loaded from the web)'],
    ['reader', 'Reader', 'A plain reading layout: notes go on its text'],
  ]) {
    const b = el('button', 'view-opt', label)
    b.type = 'button'
    b.dataset.view = v
    b.title = title
    b.addEventListener('click', () => setView(v, true))
    group.append(b)
  }
  const linksBtn = el('button', 'view-links-btn', 'Links')
  linksBtn.type = 'button'
  linksBtn.title = 'The links of the original message, in one list (a click on one in the message opens it too)'
  linksBtn.setAttribute('aria-expanded', 'false')
  const list = el('ul', 'view-links')
  list.hidden = true
  linksBtn.addEventListener('click', () => {
    list.hidden = !list.hidden
    linksBtn.setAttribute('aria-expanded', String(!list.hidden))
  })
  bar.append(group, linksBtn, list)
  originals.bar = { bar, linksBtn, list, group }
  // Outside the article: its text is not in a note's offsets.
  htmlView.scroller.insertBefore(bar, htmlView.body)
  // Each frame is as tall as the visible document area (see the section's header).
  if (typeof ResizeObserver === 'function') {
    const fit = () => htmlView.scroller.style.setProperty('--rv-frame-h', `${Math.max(240, htmlView.scroller.clientHeight - 32)}px`)
    new ResizeObserver(fit).observe(htmlView.scroller)
    fit()
  }
  setView(originals.view, false)
  renderOriginalLinks()
  hintOriginal()
}

function renderOriginalLinks() {
  const b = originals.bar
  if (!b) return
  const links = originalLinks()
  b.linksBtn.textContent = `Links (${links.length})`
  b.linksBtn.hidden = originals.view !== 'original' || !links.length
  if (b.linksBtn.hidden) b.list.hidden = true
  b.list.replaceChildren(
    ...links.map((l) => {
      const li = el('li')
      const btn = el('button', 'link', l.text || l.href)
      btn.type = 'button'
      btn.title = l.href
      btn.addEventListener('click', () => {
        b.list.hidden = true
        b.linksBtn.setAttribute('aria-expanded', 'false')
        // The same path as a link click in the Reader view: the host opens only a link of the caller's.
        if (!state.canOpenLinks) return setStatus(`Link (not opened from here): ${l.href}`)
        setStatus('')
        ccPanel.post({ type: 'open-link', href: l.href })
      })
      let host = ''
      try {
        host = new URL(l.href).host
      } catch {}
      li.append(btn)
      if (host && l.text) li.append(el('span', 'muted', ` ${host}`))
      return li
    }),
  )
}

/** Shows the Original or the Reader view; `tell`: the person chose it (the host passes it on, to be remembered). */
function setView(v, tell) {
  originals.view = v === 'reader' ? 'reader' : 'original'
  htmlView.body.classList.toggle('view-original', originals.view === 'original')
  if (originals.bar) for (const b of originals.bar.group.children) b.setAttribute('aria-pressed', String(b.dataset.view === originals.view))
  renderOriginalLinks()
  if (tell) ccPanel.post({ type: 'view', view: originals.view })
  updateAddButton()
}

// Said once, when the Original view first shows (showViewBar): a note needs the Reader view (a selection
// in the frame is out of this page's reach). Not on the first click into a frame, as it once was (the
// window's blur): in annotate the status row is hidden while empty, so showing it at mousedown moved the
// frame down under the pointer, the mouseup landed elsewhere, and the first click on a link in the mail
// opened nothing. A link there opens through main (original.mjs, Links); the page never learns of it.
function hintOriginal() {
  if (originals.hinted || originals.view !== 'original') return
  originals.hinted = true
  setStatus('Original view: notes go on the Reader view')
}

// ---- actions and update (features 'actions' and 'update') ----
//
// A caller's button (`data-action`, drawn by sanitize.mjs) posts { type: 'action', id } and stays
// disabled until the caller's update() answers (or the overlay closes): a second click while the
// caller works would only ask twice. update() adds images (declared here, then one `asset` message
// each, as the init's), hides `data-part` regions and sets the status line. The rendered document is
// not touched otherwise, so the notes keep their anchors; an image that was a placeholder (an asset
// the init did not declare) turns into the picture when its asset comes.

const hiddenParts = new Set()

/** Hides the `data-part` regions update() named, under `root` (also for a document rendered later). */
function hideParts(root) {
  if (!hiddenParts.size) return
  for (const e of root.querySelectorAll('[data-part]')) if (hiddenParts.has(e.dataset.part)) e.hidden = true
}

function onUpdate(m) {
  if (!isHtml()) return
  for (const a of Array.isArray(m.assets) ? m.assets : []) {
    if (a && typeof a.id === 'string' && !assetStore.declared.has(a.id)) assetStore.declared.set(a.id, a)
  }
  for (const name of Array.isArray(m.hide) ? m.hide : []) if (typeof name === 'string') hiddenParts.add(name)
  for (const root of assetRoots()) {
    hideParts(root)
    for (const b of root.querySelectorAll('button.doc-action')) {
      b.disabled = false
      b.classList.remove('busy')
    }
  }
  if (typeof m.status === 'string') setStatus(m.status)
}

function onAction(button) {
  if (button.disabled) return
  button.disabled = true
  button.classList.add('busy')
  setStatus('')
  ccPanel.post({ type: 'action', id: button.dataset.action })
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
  if (!(isHtml() || isPdf()) || e.key !== 'a' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
  const t = e.target
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return
  e.preventDefault()
  addNote()
})

// ---- buttons ----

/**
 * The status line, at the right of the header row. An annotate review has no header row of its own
 * (`data-bare`: title and layout toggle hidden), so there the row shows only while it has a status.
 */
function setStatus(text) {
  $('status').textContent = text
  const header = document.querySelector('header')
  if (header.dataset.bare === 'true') header.hidden = !text
}

/** Discuss with Claude asks for the newest draft: posted, or `draft-unsaved` when it is too large to store. */
function answerDraftRequest() {
  if (!postDraft()) ccPanel.post({ type: 'draft-unsaved' })
}

// ---- init ----

let initMsg = null // the init message, for buildSplit's header buttons
function init(m) {
  initMsg = m
  document.body.classList.remove('loading', 'failed')
  state.sides = m.sides
  state.draft = m.draft || { global: '', notes: [] }
  state.layout = m.layout === 'unified' ? 'unified' : 'split'
  state.canOpenLinks = m.canOpenLinks === true
  state.split = clampSplit(m.split)
  $('layout').textContent = state.layout === 'split' ? 'Unified' : 'Side by side'
  const s = state.sides
  $('path').textContent = s.path
  $('base').textContent = s.mode === 'diff' ? `vs last commit ${s.head ? s.head.slice(0, 8) : ''}` : ''
  // annotate: the overlay's title bar already names the text, and the document usually does too, so
  // no header row (a third copy of the title). The file review keeps it: path, base, layout toggle.
  const header = document.querySelector('header')
  header.dataset.bare = String(isText() || isAnnotHtml())
  header.hidden = header.dataset.bare === 'true' && !$('status').textContent
  // annotate's url as an icon button, not the long URL as text: the page cannot navigate (a sandboxed
  // frame), so the click asks the host, which opens the URL it was given. The URL is only shown in
  // the tooltip. Off when the host cannot open links (no ctx.openExternal); placeOpenUrl puts it in
  // the document.
  const openUrl = $('open-url')
  openUrl.dataset.show = (isText() || isAnnotHtml()) && s.url && m.canOpenUrl ? '1' : ''
  openUrl.title = openUrl.dataset.show ? `Open in browser: ${s.url}` : 'Open in browser'
  const c = isAnnotHtml() && s.companion ? s.companion : null
  // The hint on making a note lives here: the notes list takes no room while it is empty.
  const how = 'for a note on a part, select it, then press a or "Add note"'
  $('global').placeholder = isText() || isAnnotHtml() ? `Comment on the whole text (optional); ${how}` : `Comment on the whole file (optional); ${how}`
  // With a companion the main `aside` is the details block at the top of the main column.
  $('details').hidden = !s.aside || !!c
  $('note').textContent = s.note || ''
  $('note').hidden = !s.note
  $('global').value = state.draft.global
  limitInput($('global'), $('global-limit'), GLOBAL_MAX)
  // annotate's `kind: 'mail'`: the main document in the mail reading layout (review.css `.doc-body.mail`).
  htmlView.body.classList.toggle('mail', isAnnotHtml() && s.kind === 'mail')
  if (isAnnotHtml()) startHtml(s)
  if (isPreview()) {
    startPreview(s)
    $('base').textContent = formatSize(Number(s.size) || 0)
    $('global').placeholder = s.kind === 'pdf' ? `Comment on the PDF (optional); ${how}` : 'Comment on the image (optional)'
  }
  // A markdown or HTML file (state.md: its Rendered / Source view).
  state.md = (s.format === 'markdown' || s.format === 'html') && s.mode !== 'html' && s.mode !== 'text' ? initialMarkdownView(s) : null
  htmlView.body.classList.toggle('markdown', state.md !== null)
  showMdToggle()
  buildEditors()
  renderNotes()
  if (isHtml()) htmlView.scroller.focus()
  else (state.views.new || state.views.old)?.focus()
  // The host sends the details column, the HTML parts and the images now.
  if (isAnnotHtml() || s.aside || isPreview()) ccPanel.post({ type: 'content' })
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
// A markdown file's Rendered / Source switch. The button names the view it switches to, like the
// layout button does.
function showMdToggle() {
  const b = $('mdview')
  b.hidden = state.md === null
  b.textContent = state.md === 'rendered' ? 'Source' : 'Rendered'
  const what = state.sides && state.sides.format === 'html' ? 'HTML' : 'markdown'
  b.title = state.md === 'rendered' ? `Show the ${what} source (and its diff, when it has one)` : `Show the ${what} rendered (no scripts, nothing loaded from outside)`
}
function setMdView(view) {
  if (state.md === null || state.md === view) return
  collapseSelection()
  clearPick()
  state.md = view
  showMdToggle()
  buildEditors()
  refreshHighlights()
  renderNotes()
  updateAddButton()
}
$('mdview').addEventListener('click', () => {
  setMdView(state.md === 'rendered' ? 'source' : 'rendered')
  if (isHtml()) htmlView.scroller.focus()
  else (state.views.new || state.views.old)?.focus()
})
$('open-url').addEventListener('click', (e) => {
  // Inside the document: not a link click of the document's (an h1 inside an <a>) as well.
  e.stopPropagation()
  setStatus('')
  ccPanel.post({ type: 'open-url' })
})


// ---- the loader's error page (the service's fail) ----
//
// Before the init only: the caller's fetch failed, so the loader shows its message (as text: it often
// carries a server's words) with Close and, when the caller can answer one, Try again. A click on Try
// again goes back to the host (the event `action` { id: 'retry' }) and waits for the caller's next
// prepare, which turns the page back into the loader (`loading`), then fills it as usual.

function showFailed(m) {
  if (initMsg) return // filled: a review is never replaced by an error
  document.body.classList.remove('loading')
  document.body.classList.add('failed')
  $('failed-message').textContent = typeof m.message === 'string' ? m.message : 'Could not load this.'
  const retry = $('failed-retry')
  retry.hidden = m.retry !== true
  retry.disabled = false
  ;(retry.hidden ? $('failed-close') : retry).focus()
}

function showLoading() {
  if (initMsg) return
  document.body.classList.remove('failed')
  document.body.classList.add('loading')
}

$('failed-retry').addEventListener('click', (e) => {
  if (e.currentTarget.disabled) return
  e.currentTarget.disabled = true
  ccPanel.post({ type: 'retry' })
})
$('failed-close').addEventListener('click', () => ccPanel.post({ type: 'close' }))

ccPanel.onMessage((m) => {
  if (!m || typeof m !== 'object') return
  if (m.type === 'init') init(m)
  else if (m.type === 'failed') showFailed(m)
  else if (m.type === 'loading') showLoading()
  else if (m.type === 'error') setStatus(m.message)
  else if (m.type === 'draft-error') {
    saveState.hostError = typeof m.message === 'string' ? m.message : 'Draft not saved.'
    showSaveState()
  } else if (m.type === 'draft-saved') {
    saveState.hostError = ''
    showSaveState()
  }
  else if (m.type === 'draft-request') answerDraftRequest()
  else if (m.type === 'html') htmlPart(m)
  else if (m.type === 'aside') renderAside(m)
  else if (m.type === 'asset') htmlAsset(m)
  else if (m.type === 'assets-done') htmlAssetsDone()
  else if (m.type === 'update') onUpdate(m)
  else if (m.type === 'original') originalPart(m)
  else if (m.type === 'bytes-begin') previewBegin(m)
  else if (m.type === 'bytes') previewChunk(m)
  else if (m.type === 'bytes-end') previewEnd()
})

// The theme arrives in a message after load (`ccc guide panels`): swap the syntax colours then.
if (ccPanel.theme && ccPanel.theme.onChange) {
  ccPanel.theme.onChange(() => {
    for (const v of Object.values(state.views)) if (v) v.dispatch({ effects: themeCompartment.reconfigure(syntaxFor()) })
  })
}
