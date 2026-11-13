// The editor's file tab page (design-editor.md §1, §2, §5 "Editing"), bundled by
// scripts/build-editor.mjs into dist/pages/file.bundle.js: one classic IIFE script, since the page CSP
// allows only the plugin's own files and a sandboxed frame with an opaque origin is no place for module
// chunks (the reviewer's page is built the same way).
//
// CodeMirror 6 draws the buffer; session.mjs keeps the file's state (the base, saves, what to re-send
// on a new line to the host) and this file wires the two to the DOM and the panel SDK:
// - Ask Claude (Ctrl+L, the context menu): ask.mjs reads the selection, lib/ask.js (host) turns it into Discuss's context;
// - languages by file name (languages.mjs); search and replace (Ctrl+F, Ctrl+H), multi-cursor
//   (Alt+click, Ctrl+D, Ctrl+Shift+L), folding, bracket matching and auto-close, comment toggle
//   (Ctrl+/), indent guides (indent-guides.mjs), VS Code's line moves and copies (Alt+Up/Down, Shift+Alt+Up/Down), Tab indents;
// - colours from the app's theme variables, the font from the terminal font settings when the app
//   says one (`--cc-terminal-font-family`, `--cc-terminal-font-size`, page tabs only);
// - autosave after the idle time and on focus loss (the host's settings), Ctrl+S at once; the dirty
//   state goes to the app (ccPanel.tab.setDirty), which keeps it per view and asks before a close.
// The app's own chords (Ctrl+Tab, Ctrl+W, ...) never reach the page: the app runs them.
//
// Claude changing the file (design-editor.md §2; the decisions are session.mjs's, the merge is
// merge.mjs's): a reload or a clean merge is applied as line edits (lineChanges), so the cursor, the
// selections and the scroll position map through it as through typing, and the changed lines flash.
// A merge with conflicts keeps MY version of each region in the text (so the buffer is always plain
// text: no marker lines a save could write) and draws Claude's version above it as a block with Keep
// mine, Take Claude's and Keep both; the regions are tracked through edits (conflictField) and the
// session hears how many are left.
//
// Claude's changes in the gutter (design-editor.md §4): changes.mjs asks the host for the file at git
// HEAD and diffs it against the buffer; changes-editor.js draws the bars, the hover and the click that
// opens the Reviewer's diff.
//
// The Reviewer's notes in the gutter (design-editor.md §4): notes.mjs holds the notes the host reads through
// the `reviewer` service, notes-editor.js draws a mark per noted line with the text on hover, and the context
// menu's "Add review note" (shown only while a Reviewer answers) writes one to the Reviewer's own store.
//
// Language servers (design-editor.md §3): lsp/client.mjs tells the host the buffer and asks it in
// editor terms; lsp/editor.js draws the answers (diagnostics, hover, completion, signature help) and
// runs the commands (F12, Shift+F12, F2, Mod+., Shift+Alt+F, Mod+Shift+O). Lists and the rename
// prompt use the quick-open palette; the server's state (missing, failed) is the language bar.

import { basicSetup } from 'codemirror'
import { EditorState, Compartment, StateEffect, StateField, Transaction } from '@codemirror/state'
import { EditorView, keymap, Decoration, WidgetType } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle, StreamLanguage, indentUnit } from '@codemirror/language'
import { openSearchPanel } from '@codemirror/search'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import { go } from '@codemirror/lang-go'
import { php } from '@codemirror/lang-php'
import { yaml } from '@codemirror/lang-yaml'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { languageOfText } from './languages.mjs'
import { createSession } from './session.mjs'
import { lineChanges, keepBothText } from './merge.mjs'
import { createSearch, fuzzyFilter, fuzzyMatch, highlightPieces } from './quick-open.mjs'
import { indentGuides, detectIndentUnit } from './indent-guides.mjs'
import { createLspClient } from './lsp/client.mjs'
import { lspFeatures, lspChangesOf, applyEditsTo, showDiagnostics } from './lsp/editor.js'
import { createChanges } from './changes.mjs'
import { createChangesGutter } from './changes-editor.js'
import { createNotes } from './notes.mjs'
import { createNoteFlow } from './note-flow.mjs'
import { createNotesGutter } from './notes-editor.js'
import { selectionContext } from './ask.mjs'
import { keepLineBreaks } from './line-breaks.mjs'
import { createQuickChat } from './chat-editor.js'

/* global ccPanel */

const $ = (id) => document.getElementById(id)

function languageExtension(key) {
  switch (key) {
    case 'js': return javascript()
    case 'jsx': return javascript({ jsx: true })
    case 'ts': return javascript({ typescript: true })
    case 'tsx': return javascript({ typescript: true, jsx: true })
    case 'go': return go()
    case 'php': return php()
    case 'python': return python()
    case 'json': return json()
    case 'yaml': return yaml()
    case 'markdown': return markdown()
    case 'html': return html()
    case 'css': return css()
    case 'shell': return StreamLanguage.define(shell)
    default: return []
  }
}

// ---- theme ----

const isDark = () => ((ccPanel.theme && ccPanel.theme.current && ccPanel.theme.current.kind) || 'dark') === 'dark'
const syntaxFor = () => syntaxHighlighting(isDark() ? oneDarkHighlightStyle : defaultHighlightStyle)

// Colours only from the theme variables (`ccc guide panels`); the code font is the terminal font when
// the app gives one a page can load, else the app's monospace list.
const baseTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--cc-terminal-bg, var(--cc-bg))', color: 'var(--cc-fg)' },
  '.cm-scroller': {
    fontFamily: 'var(--cc-terminal-font-family, var(--cc-font-mono))',
    fontSize: 'var(--cc-terminal-font-size, 13px)',
    lineHeight: '1.5',
  },
  '.cm-content': { caretColor: 'var(--cc-fg)' },
  '.cm-gutters': { backgroundColor: 'var(--cc-terminal-bg, var(--cc-bg))', color: 'var(--cc-fg-subtle)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--cc-fg) 5%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--cc-fg)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--cc-accent-soft) !important' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--cc-fg)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--cc-accent) 18%, transparent)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--cc-accent) 28%, transparent)', outline: 'none' },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'color-mix(in srgb, var(--cc-status-ended) 30%, transparent)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--cc-status-needs-permission) 30%, transparent)', outline: 'none' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--cc-status-needs-permission) 55%, transparent)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--cc-surface-2)', color: 'var(--cc-fg-muted)', border: '1px solid var(--cc-border)' },
  '.cm-tooltip': { backgroundColor: 'var(--cc-bg-menu)', color: 'var(--cc-fg)', border: '1px solid var(--cc-border)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--cc-accent)', color: 'var(--cc-accent-fg)' },
  '.cm-panels': { backgroundColor: 'var(--cc-bg-bar)', color: 'var(--cc-fg)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--cc-border)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--cc-border)' },
  '.cm-panel.cm-search': { fontFamily: 'var(--cc-font-ui)', fontSize: 'var(--cc-text-m, 13px)', padding: '6px 8px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontFamily: 'inherit', fontSize: 'inherit' },
  '.cm-panel.cm-search label': { color: 'var(--cc-fg-muted)' },
  '.cm-textfield': { backgroundColor: 'var(--cc-surface-1)', color: 'var(--cc-fg)', border: '1px solid var(--cc-border)', borderRadius: 'var(--cc-radius-s, 4px)' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--cc-surface-2)', color: 'var(--cc-fg)', border: '1px solid var(--cc-border)', borderRadius: 'var(--cc-radius-s, 4px)' },
  // A conflict: Claude's version as a block above the region, mine marked in the text below it.
  '.cm-conflict': {
    margin: '4px 0 0',
    border: '1px solid var(--cc-border)',
    borderLeft: '3px solid var(--cc-accent)',
    backgroundColor: 'color-mix(in srgb, var(--cc-accent) 8%, transparent)',
  },
  '.cm-conflict-head': {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '2px 6px',
    fontFamily: 'var(--cc-font-ui)',
    fontSize: 'var(--cc-text-s, 11px)',
    color: 'var(--cc-fg-muted)',
    borderBottom: '1px solid var(--cc-border)',
  },
  '.cm-conflict-head .cm-conflict-label': { flex: '1', minWidth: '0' },
  '.cm-conflict-head button': {
    fontFamily: 'inherit',
    fontSize: 'inherit',
    color: 'var(--cc-fg)',
    backgroundColor: 'var(--cc-surface-2)',
    border: '1px solid var(--cc-border)',
    borderRadius: 'var(--cc-radius-s, 4px)',
    padding: '0 6px',
    cursor: 'pointer',
  },
  '.cm-conflict-theirs': { margin: '0', padding: '0 6px 0 4px', whiteSpace: 'pre', overflowX: 'auto', font: 'inherit' },
  '.cm-conflict-none': { padding: '0 6px', fontStyle: 'italic', color: 'var(--cc-fg-subtle)', fontFamily: 'var(--cc-font-ui)' },
  '.cm-line.cm-conflict-mine': {
    backgroundColor: 'color-mix(in srgb, var(--cc-status-needs-permission) 12%, transparent)',
    boxShadow: 'inset 3px 0 0 var(--cc-status-needs-permission)',
  },
})

// ---- Claude's changes: flashed lines and inline conflicts ----

/** How long a reloaded or merged line stays marked (file.css animates the fade). */
const FLASH_MS = 1600
const flashLines = StateEffect.define()
const clearFlash = StateEffect.define()
const flashMark = Decoration.line({ class: 'cc-flash' })

/** The lines a reload or a merge changed, marked for FLASH_MS. */
const flashField = StateField.define({
  create: () => Decoration.none,
  update(set, tr) {
    set = set.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(clearFlash)) set = Decoration.none
      else if (e.is(flashLines)) set = e.value
    }
    return set
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** Line marks for the new-document ranges of `changes` (a pure deletion marks the line it closed up on). */
function flashOf(state, changes) {
  const marks = []
  const seen = new Set()
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const doc = state.doc
    const last = doc.lineAt(Math.max(fromB, toB > fromB ? toB - 1 : fromB)).number
    for (let n = doc.lineAt(fromB).number; n <= last; n++) {
      if (seen.has(n)) continue
      seen.add(n)
      marks.push(flashMark.range(doc.line(n).from))
    }
  })
  return Decoration.set(marks, true)
}

let flashTimer = null
function flash(set) {
  view.dispatch({ effects: flashLines.of(set) })
  if (flashTimer !== null) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    flashTimer = null
    if (view) view.dispatch({ effects: clearFlash.of(null) })
  }, FLASH_MS)
}

/** The merge's conflicts, [{ id, from, to, theirs }], replaced as a whole. */
const setConflicts = StateEffect.define()
/** One conflict resolved (its id). */
const dropConflict = StateEffect.define()
let nextConflictId = 0

/**
 * The open conflicts, mapped through every edit: text typed at either edge of a region joins it
 * (from maps backward, to forward), so a region never loses the person's typing.
 */
const conflictField = StateField.define({
  create: () => ({ list: [], deco: Decoration.none }),
  update(value, tr) {
    let list = value.list
    if (tr.docChanged && list.length) {
      // A region ending at a line start (its text ends with a newline) must not take in what is typed
      // at the start of the next line: Take Claude's would delete it. Other ends grow with typing.
      const old = tr.startState.doc
      list = list.map((c) => ({
        ...c,
        from: tr.changes.mapPos(c.from, -1),
        to: tr.changes.mapPos(c.to, c.to > c.from && old.sliceString(c.to - 1, c.to) === '\n' ? -1 : 1),
      }))
    }
    for (const e of tr.effects) {
      if (e.is(setConflicts)) list = e.value
      else if (e.is(dropConflict)) list = list.filter((c) => c.id !== e.value)
    }
    if (list === value.list) return value
    return { list, deco: conflictDecorations(list, tr.state.doc) }
  },
  // A DecorationSet given directly, never a function of the view: only those may hold block widgets.
  provide: (f) => EditorView.decorations.from(f, (value) => value.deco),
})

const conflictsOf = (state) => state.field(conflictField).list
const mineMark = Decoration.line({ class: 'cm-conflict-mine' })

function conflictDecorations(list, doc) {
  const marks = []
  for (const c of list) {
    const first = doc.lineAt(c.from)
    // A block widget sits at a line start: above the region's first line.
    marks.push(Decoration.widget({ widget: new ConflictWidget(c.id, c.theirs, c.to === c.from), block: true, side: -1 }).range(first.from))
    if (c.to > c.from) {
      const last = doc.lineAt(c.to - 1).number
      for (let n = first.number; n <= last; n++) marks.push(mineMark.range(doc.line(n).from))
    }
  }
  return Decoration.set(marks, true)
}

/** Resolve conflict `id` (or every one, id null): 'mine', 'theirs' or 'both'. */
function resolveConflicts(id, how) {
  if (!view) return
  const list = conflictsOf(view.state)
  const targets = id === null ? list : list.filter((c) => c.id === id)
  if (!targets.length) return
  const changes = []
  for (const c of targets) {
    const mine = view.state.doc.sliceString(c.from, c.to)
    if (how === 'theirs') changes.push({ from: c.from, to: c.to, insert: c.theirs })
    else if (how === 'both') changes.push({ from: c.to, insert: keepBothText(mine, c.theirs).slice(mine.length) })
  }
  const effects = id === null ? setConflicts.of([]) : dropConflict.of(id)
  // The person's own choice: an edit like typing (dirty, undoable), never `replacing`.
  view.dispatch({ changes, effects, userEvent: 'input.resolve' })
  view.focus()
}

class ConflictWidget extends WidgetType {
  constructor(id, theirs, mineEmpty) {
    super()
    this.id = id
    this.theirs = theirs
    this.mineEmpty = mineEmpty
  }

  eq(other) {
    return other.id === this.id && other.theirs === this.theirs && other.mineEmpty === this.mineEmpty
  }

  toDOM() {
    const box = document.createElement('div')
    box.className = 'cm-conflict'
    const head = document.createElement('div')
    head.className = 'cm-conflict-head'
    const label = document.createElement('span')
    label.className = 'cm-conflict-label'
    label.textContent = this.mineEmpty ? "Claude's version (you removed these lines)" : "Claude's version; yours is marked below"
    head.append(
      label,
      conflictButton('Keep mine', () => resolveConflicts(this.id, 'mine')),
      conflictButton("Take Claude's", () => resolveConflicts(this.id, 'theirs')),
      conflictButton('Keep both', () => resolveConflicts(this.id, 'both'))
    )
    box.append(head)
    if (this.theirs === '') {
      const none = document.createElement('div')
      none.className = 'cm-conflict-none'
      none.textContent = 'Claude removed these lines.'
      box.append(none)
    } else {
      const pre = document.createElement('pre')
      pre.className = 'cm-conflict-theirs'
      // textContent: the file's text is never markup.
      pre.textContent = this.theirs.endsWith('\n') ? this.theirs.slice(0, -1) : this.theirs
      box.append(pre)
    }
    return box
  }

  // The buttons take their own clicks; the editor does not move the cursor for them.
  ignoreEvent() {
    return true
  }
}

function conflictButton(label, run) {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  b.addEventListener('mousedown', (e) => e.preventDefault())
  b.addEventListener('click', run)
  return b
}

// ---- the editor ----

/** CodeMirror's Mod: Cmd on macOS, Ctrl elsewhere (the page's chords and the click that adds a cursor). */
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform)
const themeCompartment = new Compartment()
const languageCompartment = new Compartment()
const readOnlyCompartment = new Compartment()
let view = null
/** Set while the page itself replaces the buffer (a load, a reload): not the person's edit. */
let replacing = false

function extensions(info, text) {
  const firstLine = text.slice(0, Math.min(text.length, 200)).split('\n', 1)[0]
  return [
    // First, so a language's own indent unit does not win: the file's indentation decides what Tab
    // inserts and where the indent guides fall (a Go file indents with tabs, a Python one with 4 spaces).
    ...indentUnitFor(text),
    basicSetup,
    indentGuides,
    // VS Code's Alt+click for another cursor, besides CodeMirror's own Mod+click (Cmd on macOS, Ctrl
    // elsewhere; never both: Super+click is the window manager's on Linux, Ctrl+click the context menu
    // on macOS). basicSetup's rectangularSelection takes every Alt+left press (its mouse style wins over
    // the plain one), but its style honours this flag: an Alt+click puts a one-point rectangle, a cursor,
    // beside the ranges already there, and an Alt+drag adds the dragged rectangle to them (click first
    // to start from one cursor). Checked in the editor e2e.
    EditorView.clickAddsSelectionRange.of((e) => e.altKey || (IS_MAC ? e.metaKey : e.ctrlKey)),
    // After the line numbers and the fold marks: the bar sits between them and the text.
    changesUi.extension,
    notesUi.extension,
    keymap.of([
      indentWithTab,
      // Ctrl+S saves now; Ctrl+H opens search with its replace field (VS Code's keys; on macOS Cmd+H
      // is the system's Hide, and VS Code's replace there is Cmd+Alt+F).
      { key: 'Mod-s', run: () => (session.saveNow(), true), preventDefault: true },
      { key: 'Ctrl-h', mac: 'Mod-Alt-f', run: openSearchPanel, preventDefault: true },
    ]),
    baseTheme,
    themeCompartment.of(syntaxFor()),
    languageCompartment.of(languageExtension(languageOfText(info.path, firstLine))),
    readOnlyCompartment.of(EditorState.readOnly.of(info.readOnly === true)),
    // `\n` the only line break: a `\r` the host left in (a mixed or lone-CR file) stays in the text.
    keepLineBreaks,
    flashField,
    conflictField,
    lspUi.extensions,
    chat.extension,
    EditorView.updateListener.of((u) => {
      // Every change reaches the language server, a reload's and a merge's too: it must see the buffer.
      if (u.docChanged) lsp.changed(lspChangesOf(u))
      if (u.docChanged) changesUi.schedule(u.view)
      if (u.docChanged && !replacing) session.edited()
      const left = conflictsOf(u.state).length
      if (left !== conflictsOf(u.startState).length) session.conflictsLeft(left)
    }),
  ]
}

/** The indent unit the file itself uses, or nothing (CodeMirror's default) when it does not say. */
function indentUnitFor(text) {
  const unit = detectIndentUnit(text)
  return unit === null ? [] : [indentUnit.of(unit)]
}

function load(text, info) {
  const host = $('editor')
  if (info.noText) {
    // Binary, or too large to show at all: no editor, only the reason (the bar says it).
    if (view) {
      view.destroy()
      view = null
    }
    host.hidden = true
    lsp.close()
    return
  }
  host.hidden = false
  const state = EditorState.create({ doc: text, extensions: extensions(info, text) })
  replacing = true
  try {
    if (view) view.setState(state)
    else view = new EditorView({ state, parent: host })
  } finally {
    replacing = false
  }
  view.focus()
  changesUi.recompute(view)
  notesUi.recompute(view)
  // A whole new buffer (no changes to send): the language server gets all of it again.
  lsp.close()
  lsp.open(info.path, true)
}

/**
 * Turns the buffer into `text` by the line edits between them (one undoable change), so the cursor,
 * the selections and the scroll position map through it, and flashes the lines it changed.
 * `effects` ride along (the read-only flag, a merge's conflicts).
 */
function applyText(text, effects) {
  const changes = view.state.changes(lineChanges(view.state.doc.toString(), text))
  replacing = true
  try {
    // Not in the undo history: Ctrl+Z past a reload would bring the older text back, mark the buffer
    // dirty and let autosave write it over Claude's change.
    view.dispatch({ changes, effects, annotations: Transaction.addToHistory.of(false) })
  } finally {
    replacing = false
  }
  if (!changes.empty) flash(flashOf(view.state, changes))
}

/** A reload or a clean merge: `text` instead of the buffer, applied as line edits (applyText). */
function replace(text, info) {
  // A disk change may be a checkout or a revert: HEAD's text is read again too.
  changes.refresh()
  if (!view || (info && info.noText)) return load(text, { path: session.view().path, ...info })
  applyText(text, readOnlyCompartment.reconfigure(EditorState.readOnly.of(!!(info && info.readOnly))))
}

/**
 * A merge with conflicts (merge.mjs conflictLayout): the merged text with my version in each region,
 * Claude's drawn above it; the first region is scrolled into view, since nothing saves until each
 * is resolved.
 */
function merge(layout) {
  if (!view) return
  const conflicts = layout.conflicts.map((c) => ({ id: ++nextConflictId, from: c.from, to: c.to, theirs: c.theirs }))
  applyText(layout.text, [readOnlyCompartment.reconfigure(EditorState.readOnly.of(false)), setConflicts.of(conflicts)])
  if (conflicts.length) view.dispatch({ effects: EditorView.scrollIntoView(conflicts[0].from, { y: 'center' }) })
}

function gotoLine(line, col, focus = true) {
  if (!view) return
  const doc = view.state.doc
  const l = doc.line(Math.min(Math.max(1, line), doc.lines))
  const pos = Math.min(l.from + Math.max(0, col - 1), l.to)
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
  // `ccc edit` says focus: false (session.mjs): it must not take the keyboard from a terminal.
  if (focus !== false) view.focus()
}

// ---- header and bar ----

const WHY = {
  binary: 'a binary file',
  large: 'too large to edit here',
  encoding: 'not UTF-8 text',
  permission: 'you cannot write it',
  nlink: 'it has other hard links',
}

const STATUS = { loading: 'Loading…', saving: 'Saving…', unsaved: 'Unsaved', saved: 'Saved' }

function button(label, run, cls) {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  if (cls) b.className = cls
  b.addEventListener('click', run)
  return b
}

function render(v) {
  $('path').textContent = v.path || ''
  $('path').title = v.path || ''
  const state = $('state')
  state.textContent = v.readOnly ? `Read-only: ${WHY[v.why] || v.why || 'read-only'}` : v.loaded && !v.exists && !v.conflict ? 'New file' : STATUS[v.status] || ''
  state.dataset.status = v.readOnly ? 'readonly' : v.status
  document.body.classList.toggle('loading', !v.loaded)

  const bar = $('bar')
  const text = $('bar-text')
  const actions = $('bar-actions')
  actions.replaceChildren()
  bar.className = 'bar'
  if (v.conflict && v.conflict.kind === 'merge') {
    bar.classList.add('warn')
    const n = v.conflict.count
    text.textContent = `${n === 1 ? 'One conflict' : `${n} conflicts`} with Claude's changes: pick a version in the text. Nothing is saved until all are resolved.`
    actions.append(
      button('Keep all mine', () => resolveConflicts(null, 'mine'), 'cc-ghost'),
      button("Take all Claude's", () => resolveConflicts(null, 'theirs'), 'cc-ghost')
    )
  } else if (v.conflict && v.conflict.kind === 'changed') {
    // Theirs is read-only, binary or too large: saving over it is refused, so only Reload is offered.
    bar.classList.add('warn')
    text.textContent = 'This file changed on disk and can no longer be saved here.'
    actions.append(button('Reload', () => session.takeTheirs()))
  } else if (v.conflict && v.conflict.kind === 'deleted') {
    bar.classList.add('warn')
    text.textContent = 'This file was deleted on disk. Your text is still here.'
    actions.append(button('Save', () => session.saveNow()), button('Close', () => session.closeTab(), 'cc-ghost'))
  } else if (v.error) {
    bar.classList.add('error')
    text.textContent = v.error
  } else if (v.notice) {
    bar.classList.add('info')
    text.textContent = v.notice
  } else if (v.noText) {
    text.textContent = v.why === 'binary' ? 'This is a binary file: it is not shown here.' : 'This file is too large to show here.'
  } else {
    text.textContent = ''
  }
  bar.hidden = text.textContent === ''
  // A file outside the project (a definition in node_modules): read-only, no micro (it opens project files).
  $('micro').hidden = isOutside(v.path)
  microIfSaved(v)
  noteFlow.onView(v)
}

const isOutside = (p) => typeof p === 'string' && (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p))

// ---- wiring ----

const session = createSession({
  post: (m) => ccPanel.post(m),
  load,
  replace,
  merge,
  getText: () => (view ? view.state.doc.toString() : ''),
  goto: gotoLine,
  setDirty: (dirty) => {
    // ccPanel.tab appears once the app said what the page is (before the first line to the host).
    if (ccPanel.tab && typeof ccPanel.tab.setDirty === 'function') ccPanel.tab.setDirty(dirty)
  },
  render,
})

// ---- language servers ----

const lsp = createLspClient({
  post: (m) => ccPanel.post(m),
  getText: () => (view ? view.state.doc.toString() : ''),
  applyEdits: (edits) => applyEditsTo(view, edits),
  onStatus: drawLsp,
  onDiagnostics: (list) => showDiagnostics(view, list),
})

// ---- Claude's changes in the gutter ----

const changesUi = createChangesGutter({ getBase: () => changes.base(), review: () => reviewIfSaved(true) })
const changes = createChanges({
  post: (m) => ccPanel.post(m),
  onBase: () => changesUi.recompute(view),
  onError: (message) => lspMessage(message, true),
})

// ---- the Reviewer's notes in the gutter ----

const notesUi = createNotesGutter({ getNotes: () => notes.list() })
const notes = createNotes({
  post: (m) => ccPanel.post(m),
  onNotes: () => notesUi.recompute(view),
  onAdded: (ok, message) => noteFlow.added(ok, message),
})
const noteFlow = createNoteFlow({
  view: () => session.view(),
  saveNow: () => session.saveNow(),
  getDoc: () => (view ? view.state.doc : null),
  add: (n) => notes.add({ from: n.from, to: n.to, text: n.text, quote: n.quote }),
  settle: (ok, message) => noteSettled(ok, message),
})

/** Set while an `openFile` the language features sent is on its way: a refusal is said in the language bar. */
let lspOpening = false

const lspUi = lspFeatures({
  client: lsp,
  path: () => session.view().path,
  goto: (line, col) => gotoLine(line, col),
  openLocation: (loc) => {
    lspOpening = true
    ccPanel.post({ t: 'openFile', ...(loc.path !== undefined ? { path: loc.path } : { outside: loc.outside }), line: loc.line, col: loc.col })
  },
  showList: (spec) => showPalette('list', true, spec),
  prompt: (spec) => showPalette('prompt', true, spec),
  message: lspMessage,
})

/** The language bar: a server missing (its install command), failed (Restart), and passing messages. */
const lspBar = { status: null, dismissed: null, message: null, error: false, timer: null }

function drawLsp(status) {
  lspBar.status = status
  const ind = $('lsp')
  if (!status || !status.language || status.state === 'stopped') {
    ind.hidden = true
  } else {
    ind.hidden = false
    const busy = status.state === 'starting' || status.state === 'restarting'
    ind.textContent = `${status.name || status.language}${busy ? '…' : status.state === 'ready' ? '' : ` (${status.state})`}`
    ind.dataset.state = status.state
    ind.title = `Language server: ${status.state}${status.message ? ` (${status.message})` : ''}`
  }
  drawLspBar()
}

function drawLspBar() {
  const bar = $('lsp-bar')
  const text = $('lsp-text')
  const actions = $('lsp-actions')
  actions.replaceChildren()
  bar.className = 'bar'
  const st = lspBar.status
  const key = st ? `${st.language}:${st.state}:${st.message || ''}` : null
  if (lspBar.message) {
    bar.classList.add(lspBar.error ? 'error' : 'info')
    text.textContent = lspBar.message
  } else if (st && st.state === 'missing' && lspBar.dismissed !== key) {
    bar.classList.add('warn')
    text.textContent = `No ${st.name || st.language} language server: highlighting only.${st.install ? ` Install it with: ${st.install}` : ''}`
    actions.append(button('Retry', () => lsp.restart(), 'cc-ghost'), button('Dismiss', () => ((lspBar.dismissed = key), drawLspBar()), 'cc-ghost'))
  } else if (st && st.state === 'failed' && lspBar.dismissed !== key) {
    bar.classList.add('error')
    text.textContent = st.message || `The ${st.name || st.language} language server stopped.`
    if (st.language) actions.append(button('Restart', () => lsp.restart()))
    actions.append(button('Dismiss', () => ((lspBar.dismissed = key), drawLspBar()), 'cc-ghost'))
  } else if (st && st.state === 'restarting' && st.message) {
    bar.classList.add('warn')
    text.textContent = `${st.message}; restarting…`
  } else {
    text.textContent = ''
  }
  bar.hidden = text.textContent === ''
}

function lspMessage(message, error = false) {
  lspBar.message = message
  lspBar.error = error
  if (lspBar.timer !== null) clearTimeout(lspBar.timer)
  lspBar.timer = setTimeout(() => {
    lspBar.timer = null
    lspBar.message = null
    drawLspBar()
  }, error ? 8000 : 4000)
  drawLspBar()
}

// ---- quick chat (Ctrl+K, design-editor.md §4) ----
// A read-only headless Claude the host runs (dist/lib/quick-chat.js), docked under the editor;
// proposals are inline diffs the person accepts into the buffer (chat-editor.js).

const chat = createQuickChat({ post: (m) => ccPanel.post(m), getView: () => view, message: lspMessage })

// ---- quick open (Ctrl+P) and find in files (Ctrl+Shift+H) ----
// One palette over the editor in two modes. The host runs rg (dist/lib/search.js); quick-open.mjs
// keeps the requests and filters. A pick in this tab's own file moves the cursor here; any other
// file goes to the host (`openFile`), which opens or focuses its tab (checked inside the project).

const palette = { mode: null, lastMode: 'files', rows: [], index: 0, files: null, grep: null, opts: { caseSensitive: false, word: false, regex: false } }

const search = createSearch({
  post: (m) => ccPanel.post(m),
  now: () => Date.now(),
  onFiles: (st) => {
    palette.files = st
    if (palette.mode === 'files') drawPalette()
  },
  onGrep: (st) => {
    palette.grep = st
    if (palette.mode === 'grep') drawPalette()
  },
  // An open the host refused (a file gone meanwhile, the tab cap): said where it was picked.
  onOpenError: (message) => {
    if (lspOpening) {
      lspOpening = false
      return lspMessage(message, true)
    }
    if (palette.mode === null) showPalette(palette.lastMode, false)
    $('palette-status').textContent = message
    $('palette-status').classList.add('error')
  },
})

/**
 * Opens the palette in `mode`: `files` (quick open), `grep` (find in files), or for the language
 * features `list` (`spec`: { placeholder, items: [{ label, detail?, group?, num?, indent?, filter?,
 * target }], onPick(target), empty }: definitions, references, symbols, code actions) and `prompt`
 * (`spec`: { placeholder, value, hint, onSubmit(value) }: rename).
 */
function showPalette(mode, fresh = true, spec = null) {
  palette.mode = mode
  if (mode === 'files' || mode === 'grep') palette.lastMode = mode
  else palette.spec = spec
  palette.index = 0
  $('palette').hidden = false
  $('palette').dataset.mode = mode
  $('palette-toggles').hidden = mode !== 'grep'
  const input = $('palette-query')
  input.placeholder = mode === 'files' ? 'Go to a file of this project' : mode === 'grep' ? 'Find in the project’s files' : spec.placeholder || ''
  if (mode === 'list' || mode === 'prompt') input.value = mode === 'prompt' ? spec.value || '' : ''
  if (fresh) {
    if (mode === 'files') {
      input.value = ''
      search.loadFiles()
    } else if (mode === 'grep') {
      // The selection, when it is one short line, is the usual thing to look for.
      const main = view ? view.state.selection.main : null
      const sel = main && !main.empty ? view.state.sliceDoc(main.from, main.to) : ''
      if (sel && !sel.includes('\n') && sel.length <= 200) input.value = sel
      search.setGrep(input.value, palette.opts, true)
    }
  }
  input.focus()
  input.select()
  drawPalette()
}

function hidePalette(focusEditor = true) {
  if (palette.mode === 'grep') search.stopGrep()
  palette.mode = null
  palette.spec = null
  $('palette').hidden = true
  if (focusEditor && view) view.focus()
}

/** `text` into `parent`, the `ranges` as <mark> (textContent only: file names and lines are never markup). */
function pieces(parent, text, ranges) {
  for (const p of highlightPieces(text, ranges)) {
    if (p.hit) {
      const b = document.createElement('mark')
      b.textContent = p.text
      parent.append(b)
    } else parent.append(document.createTextNode(p.text))
  }
}

/** Matched positions (one character each) as ranges for highlightPieces. */
const rangesOf = (positions) => positions.map((i) => [i, i + 1])

function drawPalette() {
  const list = $('palette-list')
  const status = $('palette-status')
  status.classList.remove('error')
  list.replaceChildren()
  palette.rows = []
  const query = $('palette-query').value
  if (palette.mode === 'files') {
    const st = palette.files || { loading: true, paths: [] }
    const hits = fuzzyFilter(query, st.paths)
    for (const h of hits) {
      const li = document.createElement('li')
      li.className = 'row'
      const cut = h.path.lastIndexOf('/') + 1
      const file = document.createElement('span')
      file.className = 'name'
      pieces(file, h.path.slice(cut), rangesOf(h.positions.filter((i) => i >= cut).map((i) => i - cut)))
      const dir = document.createElement('span')
      dir.className = 'dir'
      pieces(dir, h.path.slice(0, cut), rangesOf(h.positions.filter((i) => i < cut)))
      li.append(file, dir)
      addRow(li, { path: h.path })
    }
    if (st.error) {
      status.textContent = st.error
      status.classList.add('error')
    } else if (st.loading && !st.paths.length) status.textContent = 'Listing files…'
    else if (!hits.length) status.textContent = 'No file matches.'
    else status.textContent = st.truncated ? `Only the first ${st.paths.length} files are listed.` : ''
  } else if (palette.mode === 'grep') {
    const st = palette.grep || { loading: false, groups: [], count: 0, files: 0 }
    for (const g of st.groups) {
      const head = document.createElement('li')
      head.className = 'group'
      head.textContent = g.path
      list.append(head)
      for (const m of g.matches) {
        const li = document.createElement('li')
        li.className = 'row match'
        const num = document.createElement('span')
        num.className = 'num'
        num.textContent = String(m.line)
        const text = document.createElement('span')
        text.className = 'text'
        if (m.cut) text.append(document.createTextNode('…'))
        pieces(text, typeof m.text === 'string' ? m.text : '', Array.isArray(m.ranges) ? m.ranges : [])
        li.append(num, text)
        addRow(li, { path: m.path, line: m.line, col: m.col })
      }
    }
    if (st.error) {
      status.textContent = st.error
      status.classList.add('error')
    } else if (st.loading) status.textContent = 'Searching…'
    else if (!query) status.textContent = 'Type to search: plain text unless .* is on, any case unless Aa is on.'
    else if (!st.count) status.textContent = 'No results.'
    else {
      const n = `${st.count} ${st.count === 1 ? 'result' : 'results'} in ${st.files} ${st.files === 1 ? 'file' : 'files'}`
      status.textContent = st.truncated ? `${n} (stopped there: narrow the search)` : n
    }
  } else if (palette.mode === 'list') {
    // In the language server's order (document order, the server's ranking), filtered by the query.
    const spec = palette.spec
    const q = query.trim()
    let group
    for (const it of spec.items) {
      if (palette.rows.length >= 500) break
      let positions = []
      if (q) {
        const m = fuzzyMatch(q, it.filter || it.label)
        if (!m) continue
        if (!it.filter || it.filter === it.label) positions = m.positions
      }
      if (it.group !== undefined && it.group !== group) {
        group = it.group
        const head = document.createElement('li')
        head.className = 'group'
        head.textContent = it.group
        list.append(head)
      }
      const li = document.createElement('li')
      li.className = it.num !== undefined ? 'row match' : 'row'
      if (it.num !== undefined) {
        const num = document.createElement('span')
        num.className = 'num'
        num.textContent = it.num
        li.append(num)
      }
      const name = document.createElement('span')
      name.className = it.num !== undefined ? 'text' : 'name'
      if (it.indent) name.style.paddingLeft = `${Math.min(it.indent, 8)}em`
      pieces(name, it.label, rangesOf(positions))
      li.append(name)
      if (it.detail) {
        const d = document.createElement('span')
        d.className = 'dir'
        d.textContent = it.detail
        li.append(d)
      }
      addRow(li, { list: it.target })
    }
    status.textContent = palette.rows.length ? '' : spec.empty || 'Nothing.'
  } else if (palette.mode === 'prompt') {
    status.textContent = palette.spec.hint || ''
  }
  palette.index = Math.min(palette.index, Math.max(0, palette.rows.length - 1))
  markRow()
}

function addRow(li, target) {
  const i = palette.rows.length
  li.setAttribute('role', 'option')
  // The input keeps the focus (and the keys) while a row is clicked.
  li.addEventListener('mousedown', (e) => e.preventDefault())
  li.addEventListener('click', () => pick(i))
  palette.rows.push({ li, target })
  $('palette-list').append(li)
}

function markRow() {
  palette.rows.forEach((r, i) => r.li.setAttribute('aria-selected', i === palette.index ? 'true' : 'false'))
  const r = palette.rows[palette.index]
  if (r) r.li.scrollIntoView({ block: 'nearest' })
}

function pick(i) {
  const r = palette.rows[i]
  if (!r) return
  const t = r.target
  if (t.list !== undefined) {
    // A language feature's row: the editor takes the keyboard back, then the pick runs.
    const spec = palette.spec
    hidePalette(true)
    spec.onPick(t.list)
    return
  }
  hidePalette(false)
  lspOpening = false
  if (t.path === session.view().path) {
    if (t.line) gotoLine(t.line, t.col || 1)
    else if (view) view.focus()
    return
  }
  ccPanel.post({ t: 'openFile', path: t.path, ...(t.line ? { line: t.line } : {}), ...(t.col ? { col: t.col } : {}) })
}

$('palette-query').addEventListener('input', () => {
  palette.index = 0
  if (palette.mode === 'grep') search.setGrep($('palette-query').value, palette.opts)
  else drawPalette()
})
$('palette-query').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    hidePalette()
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (!palette.rows.length) return
    const d = e.key === 'ArrowDown' ? 1 : -1
    palette.index = (palette.index + d + palette.rows.length) % palette.rows.length
    markRow()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (palette.mode === 'prompt') {
      const spec = palette.spec
      const value = $('palette-query').value
      hidePalette(true)
      spec.onSubmit(value)
      return
    }
    // Enter in find with no results yet: search now rather than after the pause.
    if (palette.mode === 'grep' && !palette.rows.length) search.setGrep($('palette-query').value, palette.opts, true)
    else pick(palette.index)
  }
})
for (const [id, key] of [
  ['t-case', 'caseSensitive'],
  ['t-word', 'word'],
  ['t-regex', 'regex'],
]) {
  const b = $(id)
  b.addEventListener('mousedown', (e) => e.preventDefault())
  b.addEventListener('click', () => {
    palette.opts[key] = !palette.opts[key]
    b.setAttribute('aria-pressed', String(palette.opts[key]))
    search.setGrep($('palette-query').value, palette.opts, true)
  })
}
// ---- Ask Claude (design-editor.md §4) ----
// Ctrl+L (Cmd+L on macOS) and the context menu ask core's Discuss for this tab: the app draws the
// question box, then the host asks this page for the selection (`ask-context`) and sends it with the
// question to the Claude tab the person picks.

const ASK_LABEL = 'Ask Claude about this'
const IS_MAC_ASK = /Mac|iPhone|iPad/.test(navigator.platform)
$('ctx-ask-key').textContent = IS_MAC_ASK ? '⌘L' : 'Ctrl+L'

function askClaude() {
  hideContextMenu()
  if (!view) return
  if (!ccPanel.tab || typeof ccPanel.tab.discuss !== 'function') {
    lspMessage('Ask Claude needs a newer cc-cockpit', true)
    return
  }
  ccPanel.tab.discuss()
}

function hideContextMenu() {
  $('ctxmenu').hidden = true
}

$('editor').addEventListener('contextmenu', (e) => {
  if (!view) return
  e.preventDefault()
  const menu = $('ctxmenu')
  // "Add review note" only while a Reviewer answers (no Reviewer, an older one: the host said has: false).
  $('ctx-note').hidden = !notes.available()
  menu.hidden = false
  // Kept inside the frame: the menu opens up and left when the pointer is near the edge.
  const x = Math.max(0, Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 4))
  const y = Math.max(0, Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 4))
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`
  $('ctx-ask').focus()
})
$('ctx-ask').addEventListener('click', askClaude)
$('ctx-note').addEventListener('click', openNoteBox)
$('ctx-grep').addEventListener('click', () => {
  hideContextMenu()
  showPalette('grep')
})
$('ctx-ask').title = ASK_LABEL
// Mod+Shift+H: Mod+Shift+F is core's Toggle Tab Flag by default, and the app's table wins a chord it holds.
$('ctx-grep-key').textContent = IS_MAC_ASK ? '⇧⌘H' : 'Ctrl+Shift+H'
document.addEventListener('mousedown', (e) => {
  if (!$('ctxmenu').hidden && !$('ctxmenu').contains(e.target)) hideContextMenu()
})
window.addEventListener('blur', hideContextMenu)
$('ctxmenu').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  e.preventDefault()
  hideContextMenu()
  if (view) view.focus()
})

// ---- Add review note (design-editor.md §4 "Review notes in place") ----
// The selection's lines (the cursor's line with none) and its text as the note's quote; the text goes to
// the Reviewer's own store through the host. The Reviewer numbers the lines of the file on disk, so an
// unsaved buffer is saved first (as a click on a change bar does) and the note is sent once the host
// confirmed the save.

const NOTE_MAX_CHARS = 4000
const NOTE_QUOTE_CHARS = 500
/** The lines and quote the open box is about, and the note waiting for the save: { from, to, quote, text, waiting }. */
let noteTarget = null

function openNoteBox() {
  hideContextMenu()
  if (!view || !notes.available()) return
  const sel = selectionContext(view.state)
  const quote = (sel.text || view.state.doc.line(sel.startLine).text).slice(0, NOTE_QUOTE_CHARS)
  noteTarget = { from: sel.startLine, to: sel.endLine, quote }
  $('notebox-about').textContent = sel.endLine > sel.startLine ? `Review note on lines ${sel.startLine}-${sel.endLine}` : `Review note on line ${sel.startLine}`
  $('notebox-text').value = ''
  $('notebox-error').textContent = ''
  $('notebox').hidden = false
  $('notebox-text').focus()
}

function closeNoteBox(refocus) {
  noteTarget = null
  $('notebox').hidden = true
  if (refocus && view) view.focus()
}

function submitNote() {
  if (!noteTarget) return
  const text = $('notebox-text').value
  if (!text.trim()) {
    $('notebox-error').textContent = 'Write the note first.'
    return
  }
  // The box stays open with the text until the add's outcome: every failure leaves it to try again.
  const refused = noteFlow.submit({ ...noteTarget, text: text.slice(0, NOTE_MAX_CHARS) })
  $('notebox-error').textContent = refused || 'Adding the note...'
}

/** The note's outcome: closed on success; on a failure the box keeps the text and says why. */
function noteSettled(ok, message) {
  lspMessage(ok ? 'Review note added: it is in the Reviewer too.' : `Review note not added: ${message || 'unknown error'}`, !ok)
  if ($('notebox').hidden) return
  if (ok) closeNoteBox(true)
  else $('notebox-error').textContent = `Not added: ${message || 'unknown error'}`
}

$('notebox-add').addEventListener('click', submitNote)
$('notebox-cancel').addEventListener('click', () => {
  noteFlow.cancel()
  closeNoteBox(true)
})
$('notebox-text').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    noteFlow.cancel()
    closeNoteBox(true)
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    submitNote()
  }
})

/** The host asked for the selection (onDiscuss): the main selection's lines and text, or nothing without an editor. */
function answerAskContext(req) {
  ccPanel.post({ t: 'ask-context', req, ...(view ? selectionContext(view.state) : {}) })
}

// A click outside the palette closes it (the editor takes the click).
document.addEventListener('mousedown', (e) => {
  if (palette.mode !== null && !$('palette').contains(e.target)) hidePalette(false)
})
// The page's chords (declared as page-tab keys in plugin.json, so the app lets them through while
// the page has focus): Mod+P quick open, Mod+Shift+H or Mod+Shift+F find in files, Mod+K quick chat,
// Mod+L Ask Claude, Mod being CodeMirror's (Cmd on macOS, Ctrl elsewhere). Mod+Shift+F is core's
// Toggle Tab Flag in the default keybindings, and the app's table wins every chord it holds, so it
// reaches the page only once the person rebinds the flag; Mod+Shift+H (VS Code's Replace in Files,
// the same search view there) is free in the app's table and in CodeMirror's keymaps. Caught before CodeMirror, so only the platform's own Mod: on macOS Ctrl+P is
// the standard keymap's cursorLineUp and must stay with the editor.
window.addEventListener(
  'keydown',
  (e) => {
    const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
    // The note box keeps its own keys (Ctrl+Enter adds, Esc cancels): no palette or chat behind it.
    if (!mod || e.altKey || !$('notebox').hidden) return
    const k = e.key.toLowerCase()
    if (k === 'p' && !e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      if (palette.mode === 'files') hidePalette()
      else showPalette('files')
    } else if ((k === 'h' || k === 'f') && e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      showPalette('grep')
    } else if (k === 'k' && !e.shiftKey) {
      // Quick chat on the selection; not while the palette is open (as Mod+L). Mod+Shift+K stays CodeMirror's delete line.
      if (palette.mode !== null) return
      e.preventDefault()
      e.stopPropagation()
      chat.open()
    } else if (k === 'l' && !e.shiftKey) {
      // Not while the palette is open: its query box keeps its own keys and the selection is hidden behind it.
      if (palette.mode !== null) return
      e.preventDefault()
      e.stopPropagation()
      askClaude()
    }
  },
  true
)

ccPanel.onMessage((m) => {
  if (m && m.t === 'ask-context') return answerAskContext(m.req)
  if (search.receive(m)) return
  if (chat.receive(m)) return
  if (lsp.receive(m)) return
  if (changes.receive(m)) return
  if (notes.receive(m)) return
  session.receive(m)
})
// Every new line: the first, a host restart, a browser view's reconnect, a relay resync. The page
// is never reloaded for these, so the buffer survives and the session re-sends what it holds (and
// a search still waiting for its answer is asked again, and the language server gets the buffer).
ccPanel.onConnect(() => {
  lsp.connect()
  changes.connect()
  notes.connect()
  chat.connect()
  session.connect()
  search.connect()
  const v = session.view()
  if (view && v.loaded && !v.noText) lsp.open(v.path, true)
})

// micro opens what is on disk, so the buffer is saved first and micro opens once the host confirmed it
// (render sees `saved`); a conflict or an error cancels it, nothing is opened over unsaved text.
let microPending = false
// A bar's click opens the Reviewer's diff of the file on disk, but the bars come from the buffer: an
// unsaved change is saved first (as micro's click does) and the diff opens once the host confirmed it.
let reviewPending = false
function reviewIfSaved(click, v = session.view()) {
  if (click) {
    reviewPending = true
    if (v.dirty) session.saveNow()
  }
  if (!reviewPending) return
  if (v.conflict || v.error || v.readOnly) reviewPending = false
  else if (v.status === 'saved' || (click && !v.dirty)) {
    reviewPending = false
    changes.review()
  }
}
function microIfSaved(v) {
  reviewIfSaved(false, v)
  if (!microPending) return
  if (v.conflict || v.error || v.readOnly) microPending = false
  else if (v.status === 'saved') {
    microPending = false
    ccPanel.post({ t: 'micro' })
  }
}
$('micro').addEventListener('click', () => {
  microPending = true
  if (session.view().dirty) session.saveNow()
  microIfSaved(session.view())
})

// Focus leaving the frame (another tab, another window, the shell) is the autosave's "focus loss".
window.addEventListener('blur', () => session.blur())
window.addEventListener('focus', () => {
  session.focus()
  changes.focus()
  notes.focus()
})
setInterval(() => {
  if (document.visibilityState === 'hidden') return
  changes.poll()
  notes.poll()
}, 5000)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') session.blur()
  else {
    changes.focus()
    notes.focus()
  }
})

if (ccPanel.theme && ccPanel.theme.onChange) {
  ccPanel.theme.onChange(() => {
    if (view) view.dispatch({ effects: themeCompartment.reconfigure(syntaxFor()) })
  })
}
