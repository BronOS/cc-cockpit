// The editor's file tab page (design-editor.md §1, §2, §5 "Editing"), bundled by
// scripts/build-editor.mjs into dist/pages/file.bundle.js: one classic IIFE script, since the page CSP
// allows only the plugin's own files and a sandboxed frame with an opaque origin is no place for module
// chunks (the reviewer's page is built the same way).
//
// CodeMirror 6 draws the buffer; session.mjs keeps the file's state (the base, saves, what to re-send
// on a new line to the host) and this file wires the two to the DOM and the panel SDK:
// - languages by file name (languages.mjs); search and replace (Ctrl+F, Ctrl+H), multi-cursor
//   (Alt+click, Ctrl+D, Ctrl+Shift+L), folding, bracket matching and auto-close, comment toggle
//   (Ctrl+/), VS Code's line moves and copies (Alt+Up/Down, Shift+Alt+Up/Down), Tab indents;
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

import { basicSetup } from 'codemirror'
import { EditorState, Compartment, StateEffect, StateField, Transaction } from '@codemirror/state'
import { EditorView, keymap, Decoration, WidgetType } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle, StreamLanguage } from '@codemirror/language'
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

const themeCompartment = new Compartment()
const languageCompartment = new Compartment()
const readOnlyCompartment = new Compartment()
let view = null
/** Set while the page itself replaces the buffer (a load, a reload): not the person's edit. */
let replacing = false

function extensions(info, text) {
  const firstLine = text.slice(0, Math.min(text.length, 200)).split('\n', 1)[0]
  return [
    basicSetup,
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
    flashField,
    conflictField,
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !replacing) session.edited()
      const left = conflictsOf(u.state).length
      if (left !== conflictsOf(u.startState).length) session.conflictsLeft(left)
    }),
  ]
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

function gotoLine(line, col) {
  if (!view) return
  const doc = view.state.doc
  const l = doc.line(Math.min(Math.max(1, line), doc.lines))
  const pos = Math.min(l.from + Math.max(0, col - 1), l.to)
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
  view.focus()
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
  microIfSaved(v)
}

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

ccPanel.onMessage((m) => session.receive(m))
// Every new line: the first, a host restart, a browser view's reconnect, a relay resync. The page
// is never reloaded for these, so the buffer survives and the session re-sends what it holds.
ccPanel.onConnect(() => session.connect())

// micro opens what is on disk, so the buffer is saved first and micro opens once the host confirmed it
// (render sees `saved`); a conflict or an error cancels it, nothing is opened over unsaved text.
let microPending = false
function microIfSaved(v) {
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
window.addEventListener('focus', () => session.focus())
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') session.blur()
})

if (ccPanel.theme && ccPanel.theme.onChange) {
  ccPanel.theme.onChange(() => {
    if (view) view.dispatch({ effects: themeCompartment.reconfigure(syntaxFor()) })
  })
}
