'use strict'
// Workspace edits (design-editor.md §3 "Rename and code actions"): a server's `WorkspaceEdit` (a
// rename, a code action, a format, a `workspace/applyEdit` while a command the host ran is working)
// is applied by the HOST, never handed to a page to apply wherever it likes:
// - the host declared no resource operations (lib/lsp/server.js CLIENT_CAPABILITIES), so an edit
//   that creates, renames or deletes a file is refused as a whole;
// - every URI must be a file of the project (realpath inside it, lib/files.js resolveInProject): an
//   edit to `node_modules`, the module cache or anything outside is refused as a whole;
// - a file a page holds as a document goes to that document's syncing owner (its page applies the
//   edits to its buffer like typing: undoable, dirty, autosaved), and only when the page's text is
//   still the one the server computed against (its `seq`, and the document version the host
//   recorded when it asked);
// - a file no page holds is written by the compare-and-swap save (lib/files.js saveFile) against
//   the bytes the edits were applied to, so a write that lands in between makes the edit fail
//   rather than overwrite it. The servers hear about it as a watched-file change.
// Everything is checked before anything is applied; then files are applied in order and the first
// failure stops the rest (`failureHandling: 'abort'`, as declared), reported with its index.

const files = require('../files.js')

/** Files one edit may touch, text edits per file, and the characters of one edit's new text. */
const MAX_EDIT_FILES = 500
const MAX_FILE_EDITS = 10000
const MAX_NEW_TEXT = 1024 * 1024
/** How long a page has to apply its part of an edit (a page that is gone never answers). */
const PAGE_EDIT_TIMEOUT_MS = 5000

const MAX_LINE = 10_000_000
const MAX_CHARACTER = 1_000_000
const isIndex = (v, max) => Number.isInteger(v) && v >= 0 && v <= max

function position(v) {
  if (!v || typeof v !== 'object' || !isIndex(v.line, MAX_LINE) || !isIndex(v.character, MAX_CHARACTER)) throw new Error('an edit has a bad position')
  return { line: v.line, character: v.character }
}

/** A server's TextEdit, checked and rebuilt (nothing but range and newText goes on). */
function textEdit(e) {
  if (!e || typeof e !== 'object' || typeof e.newText !== 'string' || !e.range || typeof e.range !== 'object') throw new Error('an edit is not a text edit')
  if (e.newText.length > MAX_NEW_TEXT) throw new Error('an edit inserts too much text')
  const start = position(e.range.start)
  const end = position(e.range.end)
  if (end.line < start.line || (end.line === start.line && end.character < start.character)) throw new Error('an edit ends before it starts')
  return { range: { start, end }, newText: e.newText }
}

const before = (a, b) => a.line < b.line || (a.line === b.line && a.character < b.character)
const cmp = (a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0)

/**
 * `edits` sorted by start, checked not to overlap (LSP: all ranges refer to the original text and
 * never overlap; two inserts at one position keep their order). Throws on an overlap.
 */
function sortEdits(edits) {
  const list = edits.map((e, i) => ({ e, i }))
  list.sort((a, b) => cmp(a.e.range.start, b.e.range.start) || cmp(a.e.range.end, b.e.range.end) || a.i - b.i)
  for (let k = 1; k < list.length; k++) {
    if (before(list[k].e.range.start, list[k - 1].e.range.end)) throw new Error('the edits of one file overlap')
  }
  return list.map((x) => x.e)
}

/** The UTF-16 offset of an LSP position in `text` (a character past a line's end is its end), or -1 past the last line. */
function offsetAt(text, pos) {
  let at = 0
  for (let l = 0; l < pos.line; l++) {
    const nl = text.indexOf('\n', at)
    if (nl < 0) return -1
    at = nl + 1
  }
  let end = text.indexOf('\n', at)
  if (end < 0) end = text.length
  return Math.min(at + pos.character, end)
}

/** `text` with the (checked) text edits applied; throws on a range that is not in it. */
function applyTextEdits(text, edits) {
  const sorted = sortEdits(edits)
  const spans = sorted.map((e) => {
    const from = offsetAt(text, e.range.start)
    const to = offsetAt(text, e.range.end)
    if (from < 0 || to < 0) throw new Error('an edit is outside the file')
    return { from, to, text: e.newText }
  })
  let out = ''
  let at = 0
  for (const s of spans) {
    out += text.slice(at, s.from) + s.text
    at = s.to
  }
  return out + text.slice(at)
}

/**
 * A server's WorkspaceEdit as `[{ uri, rel, version, edits }]`, one entry per file, or a thrown
 * Error that refuses all of it: a resource operation (create, rename, delete: none was declared),
 * a URI that is not a file of the project, a file edited twice, too many files or edits.
 * `pathOfUri(uri)` is the manager's mapping (`{ rel }`, `{ outside }` or null).
 */
function planEdit(edit, pathOfUri) {
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) throw new Error('the server sent no workspace edit')
  const entries = []
  if (Array.isArray(edit.documentChanges)) {
    for (const dc of edit.documentChanges) {
      if (!dc || typeof dc !== 'object') throw new Error('a change is not a text document edit')
      if (typeof dc.kind === 'string') throw new Error(`the edit would ${dc.kind} a file; this editor applies text edits only`)
      const td = dc.textDocument
      if (!td || typeof td !== 'object' || !Array.isArray(dc.edits)) throw new Error('a change is not a text document edit')
      const version = Number.isInteger(td.version) ? td.version : null
      entries.push({ uri: td.uri, version, edits: dc.edits })
    }
  } else if (edit.changes && typeof edit.changes === 'object' && !Array.isArray(edit.changes)) {
    for (const uri of Object.keys(edit.changes)) {
      if (!Array.isArray(edit.changes[uri])) throw new Error('a change is not a list of text edits')
      entries.push({ uri, version: null, edits: edit.changes[uri] })
    }
  } else if (edit.documentChanges === undefined && edit.changes === undefined) {
    return []
  } else {
    throw new Error('the server sent no workspace edit')
  }
  if (entries.length > MAX_EDIT_FILES) throw new Error(`the edit touches more than ${MAX_EDIT_FILES} files`)
  const seen = new Set()
  const plan = []
  for (const en of entries) {
    if (typeof en.uri !== 'string') throw new Error('a change names no file')
    const where = pathOfUri(en.uri)
    if (!where) throw new Error('the edit names something that is not a file')
    if (where.outside !== undefined) throw new Error(`the edit would change ${where.outside}, outside the project`)
    if (seen.has(where.rel)) throw new Error(`the edit changes ${where.rel} twice`)
    seen.add(where.rel)
    if (en.edits.length > MAX_FILE_EDITS) throw new Error(`the edit makes more than ${MAX_FILE_EDITS} changes to ${where.rel}`)
    const edits = en.edits.map(textEdit)
    sortEdits(edits) // the overlap check, before anything is applied
    if (edits.length) plan.push({ uri: en.uri, rel: where.rel, version: en.version, edits })
  }
  return plan
}

/**
 * Applies `edit` (a server's WorkspaceEdit) for the manager `mgr` (an LspManager: its root, its
 * documents and their owners). `versions` is the document versions the host recorded when it asked
 * the server (uri -> version): an open file whose document moved on since, or that was not open
 * then, is not edited (the server's positions are for a text the page no longer has). Resolves the
 * LSP ApplyWorkspaceEditResult plus counts: `{ applied, failureReason?, failedChange?, files, edits }`.
 */
async function applyWorkspaceEdit(mgr, edit, { versions } = {}) {
  let plan
  try {
    plan = planEdit(edit, (uri) => mgr.pathOfUri(uri))
  } catch (e) {
    return { applied: false, failureReason: e.message, files: 0, edits: 0 }
  }
  // Each file: open (a page's document) or on disk only. Checked for all before any is applied.
  const steps = []
  for (const p of plan) {
    const doc = mgr.docByUri(p.uri)
    if (doc) {
      const known = versions && versions.get(doc.uri)
      if (p.version !== null ? p.version !== doc.version : versions ? known !== doc.version : false) {
        return { applied: false, failureReason: `${p.rel} changed while the language server worked; try again`, failedChange: steps.length, files: 0, edits: 0 }
      }
      if (!doc.owner || typeof doc.owner.applyEdits !== 'function') {
        return { applied: false, failureReason: `${p.rel} is open in a view that cannot take edits`, failedChange: steps.length, files: 0, edits: 0 }
      }
      steps.push({ ...p, doc })
    } else {
      if (p.version !== null) {
        // The server thinks the file is open with a version: it was closed since, and the disk may not be what it saw.
        return { applied: false, failureReason: `${p.rel} was closed while the language server worked; try again`, failedChange: steps.length, files: 0, edits: 0 }
      }
      steps.push(p)
    }
  }
  let done = 0
  let count = 0
  for (const st of steps) {
    try {
      if (st.doc) await applyToPage(mgr, st)
      else applyToDisk(mgr, st)
    } catch (e) {
      return { applied: false, failureReason: `${st.rel}: ${e.message}`, failedChange: done, files: done, edits: count }
    }
    done++
    count += st.edits.length
  }
  return { applied: true, files: done, edits: count }
}

/** An open file: its document's syncing owner applies the edits to its buffer (lib/lsp/serve.js `lsp-edit`). */
async function applyToPage(mgr, st) {
  const doc = st.doc
  const owner = doc.owner
  const rel = doc.holders.get(owner)
  // The page's own text is checked against `seq` (the last change it sent); the text the host has
  // must also still be the one the edits fit, which the page cannot see.
  applyTextEdits(doc.text, st.edits)
  const r = await owner.applyEdits(rel, st.edits, doc.seq, PAGE_EDIT_TIMEOUT_MS)
  if (!r || r.applied !== true) throw new Error((r && typeof r.reason === 'string' && r.reason.slice(0, 300)) || 'the page did not apply the edit')
}

/** A file no page holds: read, edited, and written by compare-and-swap against what was read. */
function applyToDisk(mgr, st) {
  const now = files.readFile(mgr.root, st.rel)
  if (!now.exists) throw new Error('the file is gone')
  if (now.readOnly || typeof now.text !== 'string') throw new Error(`the file cannot be edited here (${now.why || 'read-only'})`)
  const text = applyTextEdits(now.text, st.edits)
  const r = files.saveFile(mgr.root, st.rel, text, now.hash)
  if (r.result !== 'saved') throw new Error(r.written ? 'another write landed during the save' : 'the file changed on disk meanwhile; try again')
  // The servers learn it like any project change (gopls and tsserver read unopened files from disk).
  mgr.noteChanged(now.real)
}

module.exports = { applyWorkspaceEdit, applyTextEdits, planEdit, sortEdits, textEdit, PAGE_EDIT_TIMEOUT_MS }
