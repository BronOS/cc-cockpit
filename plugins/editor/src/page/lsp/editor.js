// Language features in the file tab's CodeMirror (design-editor.md §3 "v1 features"): diagnostics
// (underlined in the text, marked in the gutter), hover, completion with snippets, signature help,
// go-to-definition, find references, rename, format, code actions and document symbols. Every one
// is an ask to the host through lsp/client.mjs; nothing here waits on a server while the person
// types (completion and hover are CodeMirror's async sources, aborted when they are no longer
// wanted; signature help runs beside typing and drops a stale answer).
//
// What edits text (rename, format, a code action) is applied by the HOST: it sends the edits to the
// document's syncing page (`lsp-edit`, client.mjs), which applies them here as one undoable change
// (`applyEdits`), and writes files no page holds by compare-and-swap. The page only learns how many
// files and edits that was.
//
// Keys (VS Code's): F12 go to definition, Shift+F12 references, F2 rename, Mod+. code actions,
// Shift+Alt+F format, Mod+Shift+O symbols, Mod+Shift+Space signature help, Ctrl+Space completion
// (CodeMirror's own).

import { StateField, StateEffect, Prec, EditorState } from '@codemirror/state'
import { EditorView, keymap, hoverTooltip, showTooltip } from '@codemirror/view'
import { snippet, pickedCompletion } from '@codemirror/autocomplete'
import { setDiagnostics, lintGutter } from '@codemirror/lint'
import { indentUnit, getIndentUnit } from '@codemirror/language'
import { offsetOf, positionOf, contentChanges, editsToChanges, snippetToTemplate, docBlocks, completionType, severityOf, signatureParts, flattenSymbols } from './convert.mjs'

/** The blocks of a hover or a documentation as DOM: code in <pre>, text as text (never markup). */
export function blocksDom(blocks, cls = 'cc-doc') {
  const box = document.createElement('div')
  box.className = cls
  for (const b of blocks) {
    const el = document.createElement(b.code ? 'pre' : 'div')
    el.className = b.code ? 'cc-doc-code' : 'cc-doc-text'
    el.textContent = b.text
    box.append(el)
  }
  return box
}

/** One change of a transaction for the host: LSP changes, or nothing while the page itself loads. */
export function lspChangesOf(update) {
  return contentChanges(update.startState.doc, update.changes)
}

/**
 * The host's TextEdits applied to the buffer as one change the person can undo (dirty, saved like
 * typing). True, or a string saying why not.
 */
export function applyEditsTo(view, edits) {
  if (!view) return 'the file is not shown'
  if (view.state.readOnly) return 'the file is read-only here'
  const changes = editsToChanges(view.state.doc, edits)
  if (typeof changes === 'string') return changes
  if (changes.length) view.dispatch({ changes, userEvent: 'input.lsp', scrollIntoView: false })
  return true
}

/** The server's diagnostics on the buffer (CodeMirror lint: underlines, the gutter, the tooltip). */
export function showDiagnostics(view, list) {
  if (!view) return
  const doc = view.state.doc
  const out = []
  for (const d of list) {
    if (!d || !d.range || typeof d.message !== 'string') continue
    let from = offsetOf(doc, d.range.start)
    let to = Math.max(from, offsetOf(doc, d.range.end))
    // A zero-width diagnostic (an expected token at a line's end) still needs a character to mark.
    if (to === from) {
      const line = doc.lineAt(from)
      if (from < line.to) to = from + 1
      else if (from > line.from) from = from - 1
    }
    const source = typeof d.source === 'string' && d.source ? d.source : undefined
    const code = d.code !== undefined ? ` (${d.code})` : ''
    out.push({ from, to, severity: severityOf(d.severity), message: d.message + code, ...(source ? { source } : {}) })
  }
  view.dispatch(setDiagnostics(view.state, out))
}

// ---- signature help ----

const setSignature = StateEffect.define()

/** The signature tooltip: `{ pos, parts }` (convert.mjs signatureParts) or null; closed when the cursor leaves its line. */
const signatureField = StateField.define({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSignature)) return e.value
    if (!value) return value
    if (tr.docChanged) value = { ...value, pos: tr.changes.mapPos(value.pos) }
    const head = tr.state.selection.main.head
    if (tr.state.doc.lineAt(head).number !== tr.state.doc.lineAt(Math.min(value.pos, tr.state.doc.length)).number) return null
    return value
  },
  provide: (f) =>
    showTooltip.from(f, (v) =>
      v
        ? {
            pos: v.pos,
            above: true,
            arrow: false,
            create: () => {
              const dom = document.createElement('div')
              dom.className = 'cc-signature'
              const line = document.createElement('div')
              line.className = 'cc-signature-label'
              const p = v.parts
              if (p.count > 1) {
                const n = document.createElement('span')
                n.className = 'cc-signature-count'
                n.textContent = `${p.index + 1}/${p.count} `
                line.append(n)
              }
              line.append(document.createTextNode(p.before))
              if (p.param) {
                const b = document.createElement('strong')
                b.textContent = p.param
                line.append(b)
              }
              line.append(document.createTextNode(p.after))
              dom.append(line)
              if (p.doc.length) dom.append(blocksDom(p.doc.slice(0, 2)))
              return { dom }
            },
          }
        : null
    ),
})

/**
 * The language features as CodeMirror extensions. `deps`:
 *   client                 lsp/client.mjs
 *   path()                 this tab's file (project-relative)
 *   goto(line, col)        move the cursor here (1-based)
 *   openLocation(loc)      a location in another file: { path } or { outside }, with a range
 *   showList(spec)         the palette as a list: { placeholder, items: [{ label, detail?, group?, target }], onPick(target), empty }
 *   prompt(spec)           the palette as a one-line prompt: { placeholder, value, hint, onSubmit(value) }
 *   message(text, error?)  a passing line in the language bar
 */
export function lspFeatures(deps) {
  const { client } = deps
  const feature = (name) => client.ready() && client.features()[name] === true
  const posOf = (state, at) => positionOf(state.doc, at)

  // ---- hover ----
  const hover = hoverTooltip(
    async (view, pos) => {
      if (!feature('hover')) return null
      let r
      try {
        r = await client.ask('hover', { position: posOf(view.state, pos) })
      } catch {
        return null
      }
      const res = r && r.result
      if (!res || res.contents === undefined) return null
      const blocks = docBlocks(res.contents)
      if (!blocks.length) return null
      let from = pos
      let to = pos
      if (res.range && res.range.start && res.range.end) {
        from = offsetOf(view.state.doc, res.range.start)
        to = offsetOf(view.state.doc, res.range.end)
      }
      return { pos: from, end: to, above: true, create: () => ({ dom: blocksDom(blocks, 'cc-doc cc-hover') }) }
    },
    { hoverTime: 350 }
  )

  // ---- completion ----
  /** The source CodeMirror's autocompletion runs beside the language's own (languageData). */
  async function complete(context) {
    if (!feature('complete')) return null
    const f = client.features()
    const word = context.matchBefore(/[\w$]+/)
    const before = context.pos > 0 ? context.state.sliceDoc(context.pos - 1, context.pos) : ''
    const trigger = (f.completeTriggers || []).includes(before) ? before : undefined
    if (!context.explicit && !word && !trigger) return null
    const ctl = new AbortController()
    context.addEventListener('abort', () => ctl.abort())
    let r
    try {
      r = await client.ask('complete', { position: posOf(context.state, context.pos), ...(trigger && !word ? { triggerCharacter: trigger } : {}) }, { signal: ctl.signal })
    } catch {
      return null
    }
    const res = r && r.result
    const items = Array.isArray(res) ? res : res && Array.isArray(res.items) ? res.items : []
    const incomplete = !!(res && !Array.isArray(res) && res.isIncomplete)
    const reqPos = context.pos
    const from = word ? word.from : context.pos
    const options = []
    for (const item of items) {
      if (!item || typeof item.label !== 'string') continue
      options.push(completionOption(item, reqPos, f))
    }
    return { from, options, ...(incomplete ? {} : { validFor: /^[\w$]*$/ }) }
  }

  function completionOption(item, reqPos, f) {
    const label = typeof item.filterText === 'string' && item.filterText ? item.filterText : item.label
    const o = { label, type: completionType(item.kind) }
    if (label !== item.label) o.displayLabel = item.label
    if (typeof item.detail === 'string' && item.detail) o.detail = item.detail.length > 80 ? item.detail.slice(0, 80) + '…' : item.detail
    if (item.preselect === true) o.boost = 1
    if (item.deprecated === true || (Array.isArray(item.tags) && item.tags.includes(1))) o.boost = -1
    // Documentation now, or asked for when the item is selected (the host passes back only an item it gave).
    if (item.documentation !== undefined) {
      const blocks = docBlocks(item.documentation)
      if (blocks.length) o.info = () => blocksDom(blocks)
    } else if (f.resolveCompletion) {
      o.info = async () => {
        try {
          const r = await client.ask('resolveCompletion', { item })
          const it = r && r.result
          const blocks = it ? [...(typeof it.detail === 'string' && it.detail && it.detail !== item.detail ? [{ code: true, text: it.detail }] : []), ...(it.documentation !== undefined ? docBlocks(it.documentation) : [])] : []
          return blocks.length ? blocksDom(blocks) : null
        } catch {
          return null
        }
      }
    }
    const te = item.textEdit && item.textEdit.range ? item.textEdit : item.textEdit && item.textEdit.insert ? { range: item.textEdit.insert, newText: item.textEdit.newText } : null
    const text = te && typeof te.newText === 'string' ? te.newText : typeof item.insertText === 'string' ? item.insertText : item.label
    const isSnippet = item.insertTextFormat === 2
    const extra = Array.isArray(item.additionalTextEdits) ? item.additionalTextEdits : []
    if (!te && !isSnippet && !extra.length) {
      o.apply = text
      return o
    }
    o.apply = (view, completion, from, to) => {
      const doc = view.state.doc
      // The edit's range was given for the text at the ask; what was typed since moved its end.
      let rFrom = from
      let rTo = to
      if (te) {
        const s = offsetOf(doc, te.range.start)
        const e = offsetOf(doc, te.range.end)
        const shift = to - reqPos
        rFrom = Math.min(s, from)
        rTo = Math.max(to, e >= reqPos ? e + shift : e)
      }
      // Auto-imports and the like first (they lie elsewhere, mostly at the top), then the item.
      const more = editsToChanges(doc, extra)
      if (Array.isArray(more)) {
        const outside = more.filter((c) => c.to <= rFrom || c.from >= rTo)
        if (outside.length) {
          const tr = view.state.update({ changes: outside, userEvent: 'input.complete' })
          view.dispatch(tr)
          rFrom = tr.changes.mapPos(rFrom, -1)
          rTo = tr.changes.mapPos(rTo, 1)
        }
      }
      if (isSnippet) return snippet(snippetToTemplate(text))(view, completion, rFrom, rTo)
      view.dispatch({
        changes: { from: rFrom, to: rTo, insert: text },
        selection: { anchor: rFrom + text.length },
        userEvent: 'input.complete',
        annotations: pickedCompletion.of(completion),
        scrollIntoView: true,
      })
    }
    return o
  }

  // ---- signature help ----
  let sigToken = 0
  async function askSignature(view, explicit) {
    if (!feature('signature')) return false
    const token = ++sigToken
    const pos = view.state.selection.main.head
    let r
    try {
      r = await client.ask('signature', { position: posOf(view.state, pos) })
    } catch {
      return false
    }
    // Stale: the person moved on, or asked again.
    if (token !== sigToken || !view.dom.isConnected) return false
    const parts = signatureParts(r && r.result)
    view.dispatch({ effects: setSignature.of(parts ? { pos: view.state.selection.main.head, parts } : null) })
    if (!parts && explicit) deps.message('No signature here.')
    return true
  }

  const signatureTyping = EditorView.updateListener.of((u) => {
    if (!u.docChanged || !feature('signature')) return
    const typed = u.transactions.some((tr) => tr.isUserEvent('input.type'))
    if (!typed) return
    const f = client.features()
    const head = u.state.selection.main.head
    const ch = head > 0 ? u.state.sliceDoc(head - 1, head) : ''
    const open = u.state.field(signatureField, false)
    if ((f.signatureTriggers || []).includes(ch) || (open && ((f.signatureRetriggers || []).includes(ch) || ch === ')'))) askSignature(u.view, false)
  })

  // ---- navigation ----
  async function goToDefinition(view) {
    if (!feature('definition')) return deps.message('The language server offers no definitions here.'), true
    const pos = view.state.selection.main.head
    let r
    try {
      r = await client.ask('definition', { position: posOf(view.state, pos) })
    } catch (e) {
      deps.message(`Go to definition: ${e.message}`, true)
      return true
    }
    const locs = Array.isArray(r && r.result) ? r.result : []
    if (locs.length === 0) deps.message('No definition found.')
    else if (locs.length === 1) go(locs[0])
    else showLocations('Definitions', locs)
    return true
  }

  async function findReferences(view) {
    if (!feature('references')) return deps.message('The language server offers no references here.'), true
    const pos = view.state.selection.main.head
    let r
    try {
      r = await client.ask('references', { position: posOf(view.state, pos), includeDeclaration: true })
    } catch (e) {
      deps.message(`References: ${e.message}`, true)
      return true
    }
    const locs = Array.isArray(r && r.result) ? r.result : []
    if (locs.length === 0) deps.message('No references found.')
    else showLocations(`${locs.length} reference${locs.length === 1 ? '' : 's'}${r.truncated ? ' (the first ones)' : ''}`, locs)
    return true
  }

  function go(loc) {
    const line = loc.range.start.line + 1
    const col = loc.range.start.character + 1
    if (loc.path !== undefined && loc.path === deps.path()) deps.goto(line, col)
    else deps.openLocation({ ...loc, line, col })
  }

  function showLocations(title, locs) {
    deps.showList({
      placeholder: `${title}: type to filter`,
      items: locs.map((l) => {
        const where = l.path !== undefined ? l.path : l.outside
        return {
          group: where,
          label: typeof l.text === 'string' ? l.text.trim() || `line ${l.range.start.line + 1}` : `line ${l.range.start.line + 1}`,
          num: String(l.range.start.line + 1),
          filter: `${where} ${l.text || ''}`,
          target: l,
        }
      }),
      onPick: go,
      empty: 'Nothing matches.',
    })
  }

  // ---- edits through the host ----
  function told(what, r) {
    const res = r && r.result
    if (!res) return deps.message(`${what}: nothing to do.`)
    if (res.applied !== true) return deps.message(`${what}: ${res.failureReason || 'not applied'}`, true)
    if (!res.edits) return deps.message(`${what}: nothing to change.`)
    deps.message(`${what}: ${res.edits} change${res.edits === 1 ? '' : 's'} in ${res.files} file${res.files === 1 ? '' : 's'}.`)
  }

  async function formatDocument(view) {
    if (!feature('format')) return deps.message('The language server cannot format this file.'), true
    if (view.state.readOnly) return true
    const unit = getIndentUnit(view.state)
    const insertSpaces = !/^\t/.test(view.state.facet(indentUnit))
    try {
      const r = await client.ask('format', { tabSize: insertSpaces ? unit : view.state.tabSize, insertSpaces })
      const res = r && r.result
      if (res && res.applied !== true) deps.message(`Format: ${res.failureReason || 'not applied'}`, true)
    } catch (e) {
      deps.message(`Format: ${e.message}`, true)
    }
    return true
  }

  async function renameSymbol(view) {
    if (!feature('rename')) return deps.message('The language server cannot rename here.'), true
    if (view.state.readOnly) return true
    const pos = view.state.selection.main.head
    const position = posOf(view.state, pos)
    // The position is the symbol's in THIS text (CodeMirror's documents are immutable, so identity
    // says whether it changed): typing, or Claude's change merged in while the prompt is up, would
    // make the host ask the server about whatever sits at that position then.
    const startDoc = view.state.doc
    const moved = () => view.state.doc !== startDoc && (deps.message('Rename: the file changed since F2; press F2 again.', true), true)
    let value = view.state.wordAt(pos) ? view.state.sliceDoc(view.state.wordAt(pos).from, view.state.wordAt(pos).to) : ''
    if (feature('prepareRename')) {
      try {
        const r = await client.ask('prepareRename', { position })
        if (moved()) return true
        const res = r && r.result
        if (r && !r.unsupported && !res) return deps.message('Nothing to rename here.'), true
        if (res && typeof res.placeholder === 'string') value = res.placeholder
        else if (res && res.start && res.end) value = view.state.sliceDoc(offsetOf(view.state.doc, res.start), offsetOf(view.state.doc, res.end))
        else if (res && res.range) value = view.state.sliceDoc(offsetOf(view.state.doc, res.range.start), offsetOf(view.state.doc, res.range.end))
      } catch (e) {
        return deps.message(`Rename: ${e.message}`, true), true
      }
    }
    deps.prompt({
      placeholder: 'New name',
      value,
      hint: `Enter renames ${value ? `“${value}”` : 'it'} in every file of the project; Escape cancels.`,
      onSubmit: async (newName) => {
        if (!newName || newName === value || /[\n\r]/.test(newName)) return
        if (moved()) return
        try {
          told('Rename', await client.ask('rename', { position, newName }))
        } catch (e) {
          deps.message(`Rename: ${e.message}`, true)
        }
      },
    })
    return true
  }

  async function codeActions(view) {
    if (!feature('codeActions')) return deps.message('The language server offers no code actions here.'), true
    const sel = view.state.selection.main
    const range = { start: posOf(view.state, sel.from), end: posOf(view.state, sel.to) }
    let r
    try {
      r = await client.ask('codeActions', { range })
    } catch (e) {
      deps.message(`Code actions: ${e.message}`, true)
      return true
    }
    const list = Array.isArray(r && r.result) ? r.result : []
    if (!list.length) return deps.message('No code actions here.'), true
    const ordered = [...list.filter((a) => a.preferred && !a.disabled), ...list.filter((a) => !a.preferred && !a.disabled), ...list.filter((a) => a.disabled)]
    deps.showList({
      placeholder: 'Code actions: type to filter',
      items: ordered.map((a) => ({ label: a.title, detail: a.disabled ? `not available: ${a.disabled}` : a.kind || '', target: a })),
      onPick: async (a) => {
        if (a.disabled) return deps.message(`${a.title}: not available (${a.disabled})`, true)
        try {
          told(a.title, await client.ask('runCodeAction', { id: a.id }))
        } catch (e) {
          deps.message(`${a.title}: ${e.message}`, true)
        }
      },
      empty: 'Nothing matches.',
    })
    return true
  }

  async function documentSymbols() {
    if (!feature('symbols')) return deps.message('The language server lists no symbols for this file.'), true
    let r
    try {
      r = await client.ask('symbols', {})
    } catch (e) {
      deps.message(`Symbols: ${e.message}`, true)
      return true
    }
    const rows = flattenSymbols(r && r.result)
    if (!rows.length) return deps.message('No symbols in this file.'), true
    deps.showList({
      placeholder: 'Go to a symbol in this file',
      items: rows.map((s) => ({ label: s.name, indent: s.depth, detail: [s.kind, s.detail].filter(Boolean).join(' · '), filter: s.name, target: s })),
      onPick: (s) => deps.goto(s.line + 1, s.character + 1),
      empty: 'No symbol matches.',
    })
    return true
  }

  const run = (fn) => (view) => {
    fn(view)
    return true
  }

  const keys = Prec.high(
    keymap.of([
      { key: 'F12', run: run(goToDefinition), preventDefault: true },
      { key: 'Shift-F12', run: run(findReferences), preventDefault: true },
      { key: 'F2', run: run(renameSymbol), preventDefault: true },
      { key: 'Mod-.', run: run(codeActions), preventDefault: true },
      { key: 'Shift-Alt-f', run: run(formatDocument), preventDefault: true },
      { key: 'Mod-Shift-o', run: run(documentSymbols), preventDefault: true },
      { key: 'Mod-Shift-Space', run: run((v) => askSignature(v, true)), preventDefault: true },
      {
        key: 'Escape',
        run: (view) => {
          if (!view.state.field(signatureField, false)) return false
          sigToken++
          view.dispatch({ effects: setSignature.of(null) })
          return true
        },
      },
    ])
  )

  return {
    extensions: [lintGutter(), hover, EditorState.languageData.of(() => [{ autocomplete: complete }]), signatureField, signatureTyping, keys],
    goToDefinition,
    findReferences,
    renameSymbol,
    codeActions,
    formatDocument,
    documentSymbols,
  }
}
