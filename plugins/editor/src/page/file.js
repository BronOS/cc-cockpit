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

import { basicSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
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
})

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
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !replacing) session.edited()
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

/** Shows `text` instead of the buffer, as one undoable change; the cursor stays on its line where it can. */
function replace(text, info) {
  if (!view || (info && info.noText)) return load(text, { path: session.view().path, ...info })
  const sel = view.state.selection.main
  const line = view.state.doc.lineAt(sel.head)
  const col = sel.head - line.from
  replacing = true
  try {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(!!(info && info.readOnly))),
    })
    const doc = view.state.doc
    const l = doc.line(Math.min(line.number, doc.lines))
    view.dispatch({ selection: { anchor: Math.min(l.from + col, l.to) }, scrollIntoView: false })
  } finally {
    replacing = false
  }
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
  if (v.conflict && v.conflict.kind === 'changed') {
    bar.classList.add('warn')
    if (v.conflict.final) {
      // Theirs is read-only, binary or too large: saving over it is refused, so only Reload is offered.
      text.textContent = 'This file changed on disk and can no longer be saved here.'
      actions.append(button('Reload', () => session.takeTheirs()))
    } else {
      text.textContent = 'This file changed on disk while you were editing it.'
      actions.append(button('Reload', () => session.takeTheirs(), 'cc-ghost'), button('Keep mine', () => session.keepMine()))
    }
  } else if (v.conflict && v.conflict.kind === 'deleted') {
    bar.classList.add('warn')
    text.textContent = 'This file was deleted on disk. Your text is still here.'
    actions.append(button('Save', () => session.saveNow()))
  } else if (v.error) {
    bar.classList.add('error')
    text.textContent = v.error
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
