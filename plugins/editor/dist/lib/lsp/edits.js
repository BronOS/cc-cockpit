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
//   rather than overwrite it, and only when it was not written since the host asked (its mtime: a
//   file Claude wrote while the server worked is not the text the server computed against). The
//   servers hear about it as a watched-file change.
// Files are named by realpath (two spellings of one file are one file) and looked up as documents
// the same way. Everything is checked before anything is applied; then the open files are applied
// first (a page refusing, the person typed, is the likely failure, and a page's edit can be undone)
// and the disk files after them, and the first failure stops the rest (`failureHandling: 'abort'`,
// as declared), reported with its index in the server's edit. A cancel (the page gave up, its
// deadline) is the same kind of stop: checked before each file, so one that comes while a page is
// applying its part lets that part finish and changes nothing after it; the answer names the files
// that did change (the all-or-refuse checks above cannot undo a file already written).

const { pathToFileURL } = require('node:url')
const fs = require('node:fs')
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

/** A `{ line, character }` checked and rebuilt, or a thrown Error with `message` (the manager's page-facing text differs). */
function position(v, message = 'an edit has a bad position') {
  if (!v || typeof v !== 'object' || !isIndex(v.line, MAX_LINE) || !isIndex(v.character, MAX_CHARACTER)) throw new Error(message)
  return { line: v.line, character: v.character }
}

/** A server's TextEdit, checked and rebuilt (nothing but range and newText goes on). */
function textEdit(e) {
  if (!e || typeof e !== 'object' || typeof e.newText !== 'string' || !e.range || typeof e.range !== 'object') throw new Error('an edit is not a text edit')
  if (e.newText.length > MAX_NEW_TEXT) throw new Error('an edit inserts too much text')
  const start = position(e.range.start)
  const end = position(e.range.end)
  if (before(end, start)) throw new Error('an edit ends before it starts')
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

/** Where the line starting at `at` ends: its first `\r` or `\n`, or the text's end. */
function lineEnd(text, at) {
  for (let i = at; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 10 || c === 13) return i
  }
  return text.length
}

/**
 * The UTF-16 offset of an LSP position in `text`, or -1 past the last line. LSP counts `\n`, `\r\n`
 * and a lone `\r` as line breaks (a disk file may hold any of them: decodeBytes keeps the CRLFs of a
 * mixed file), and a character past a line's end is that end, before its break (never between the
 * `\r` and the `\n` of a CRLF).
 */
function offsetAt(text, pos) {
  let at = 0
  for (let l = 0; l < pos.line; l++) {
    const br = lineEnd(text, at)
    if (br >= text.length) return -1
    at = br + (text.charCodeAt(br) === 13 && text.charCodeAt(br + 1) === 10 ? 2 : 1)
  }
  return Math.min(at + pos.character, lineEnd(text, at))
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
  for (const [index, en] of entries.entries()) {
    if (typeof en.uri !== 'string') throw new Error('a change names no file')
    const where = pathOfUri(en.uri)
    if (!where) throw new Error('the edit names something that is not a file')
    if (where.outside !== undefined) throw new Error(`the edit would change ${where.outside}, outside the project`)
    if (seen.has(where.rel)) throw new Error(`the edit changes ${where.rel} twice`)
    seen.add(where.rel)
    if (en.edits.length > MAX_FILE_EDITS) throw new Error(`the edit makes more than ${MAX_FILE_EDITS} changes to ${where.rel}`)
    const edits = en.edits.map(textEdit)
    sortEdits(edits) // the overlap check, before anything is applied
    if (edits.length) plan.push({ index, uri: en.uri, rel: where.rel, version: en.version, edits })
  }
  return plan
}

/**
 * Applies `edit` (a server's WorkspaceEdit) for the manager `mgr` (an LspManager: its root, its
 * documents and their owners). Options, all taken when the host asked the server:
 * - `versions`: the document versions then (uri -> version; versions are unique across documents,
 *   manager.js `nextVersion`, so a file closed and opened again never matches its old one). An open
 *   file whose document moved on since, or that was not open then, is not edited; nor is one that
 *   was open then and is closed now (the server's positions are for the page's buffer, not the disk).
 * - `since`: the time (ms) then: a disk file written after it is not edited.
 * - `written`: real path -> the mtime (ms) an earlier edit of the same action left a disk file at
 *   (a code action's edit before its command): such a file is checked against that, not `since`.
 * - `produced`: filled in as files change, for a command run after this edit (manager.js
 *   runCodeAction): `{ versions: Map uri -> the document's version right after its page applied
 *   the edit, written: Map real -> the mtime the save left }`. Only the files this edit changed.
 * - `signal`: an AbortSignal; aborted before anything is applied, nothing is; aborted part way, the
 *   files after the one being applied are not touched and the answer says which ones changed.
 * Resolves the LSP ApplyWorkspaceEditResult plus counts: `{ applied, failureReason?, failedChange?, files, edits }`.
 */
async function applyWorkspaceEdit(mgr, edit, { versions, since, written, produced, signal } = {}) {
  let plan
  try {
    plan = planEdit(edit, (uri) => mgr.pathOfUri(uri))
  } catch (e) {
    return { applied: false, failureReason: e.message, files: 0, edits: 0 }
  }
  const refuse = (p, why) => ({ applied: false, failureReason: `${p.rel} ${why}`, failedChange: p.index, files: 0, edits: 0 })
  // Each file: open (a page's document) or on disk only. Checked for all before any is applied.
  const pages = []
  const disk = []
  const seen = new Set()
  for (const p of plan) {
    // By realpath: a server may name one file by two spellings (a symlinked folder of the project),
    // and the documents are keyed by the realpath's URI.
    let where
    try {
      where = files.resolveInProject(mgr.root, p.rel)
    } catch (e) {
      return { ...refuse(p, ''), failureReason: String(e.message).slice(0, 300) }
    }
    if (seen.has(where.real)) return refuse(p, 'is changed twice by the edit (under two names)')
    seen.add(where.real)
    const uri = pathToFileURL(where.real).href
    const doc = mgr.docs.get(uri)
    if (doc) {
      const known = versions && versions.get(doc.uri)
      if (p.version !== null ? p.version !== doc.version : versions ? known !== doc.version : false) return refuse(p, 'changed while the language server worked; try again')
      if (!doc.owner || typeof doc.owner.applyEdits !== 'function') return refuse(p, 'is open in a view that cannot take edits')
      // What the document must still be when its turn comes (earlier files wait on their pages).
      pages.push({ ...p, uri, doc, owner: doc.owner, version: doc.version, seq: doc.seq })
    } else {
      // The server thinks the file is open with a version, or the host saw it open when it asked:
      // it was closed since, and the disk is not the buffer the server saw.
      if (p.version !== null || (versions && versions.has(uri))) return refuse(p, 'was closed while the language server worked; try again')
      if (writtenSince(where.real, since, written)) return refuse(p, 'changed on disk while the language server worked; try again')
      disk.push({ ...p, uri, real: where.real })
    }
  }
  let done = 0
  let count = 0
  const changed = []
  const steps = [...pages, ...disk]
  for (const st of steps) {
    // Rechecked before every file: the await on a page's part is where a cancel usually lands.
    if (signal && signal.aborted) return cancelled(st, changed, steps.length, count)
    let r
    try {
      r = st.doc ? await applyToPage(mgr, st, produced) : applyToDisk(mgr, st, since, written, produced)
    } catch (e) {
      return { applied: false, failureReason: `${st.rel}: ${e.message}`, failedChange: st.index, files: done, edits: count }
    }
    done++
    count += st.edits.length
    changed.push(st.rel)
    if (r && r.lost) {
      // The edit is on disk, but a write another program made into the old file during the swap is
      // not: said as it is, and nothing more is changed.
      return { applied: false, failureReason: `${st.rel}: the edit was written, but another program wrote the file during the save and its change was lost`, failedChange: st.index, files: done, edits: count }
    }
  }
  return { applied: true, files: done, edits: count }
}

/** Names listed in a partial cancel's reason; the rest are counted (the page shows ~300 characters). */
const MAX_NAMED_FILES = 5

/**
 * The answer to a cancel that came before `next` was applied: `changed` (rels) were, the others
 * were not. Nothing changed: plain `cancelled`, as before the loop. Else not `applied` (the server's
 * edit is not all there), with the changed files named so the person can undo them.
 */
function cancelled(next, changed, total, edits) {
  if (changed.length === 0) return { applied: false, failureReason: 'cancelled', files: 0, edits: 0 }
  const named = changed.slice(0, MAX_NAMED_FILES).join(', ')
  const more = changed.length > MAX_NAMED_FILES ? ` and ${changed.length - MAX_NAMED_FILES} more` : ''
  const left = total - changed.length
  return {
    applied: false,
    failureReason: `cancelled part way: changed ${named}${more}; the other ${left} file${left === 1 ? ' was' : 's were'} not changed`,
    failedChange: next.index,
    files: changed.length,
    edits,
  }
}

/**
 * Whether the file at `real` was modified after `since` (ms), or, when `written` holds it (an
 * earlier edit of the same action saved it), since that save: its mtime is no longer the one the
 * save left. No `since` and not in `written`: not checked. A file that is gone is not (its read says so).
 */
function writtenSince(real, since, written) {
  const mine = written instanceof Map ? written.get(real) : undefined
  if (mine === undefined && since === undefined) return false
  try {
    const m = fs.statSync(real).mtimeMs
    return mine !== undefined ? m !== mine : m > since
  } catch {
    return false
  }
}

/** An open file: its document's syncing owner applies the edits to its buffer (lib/lsp/serve.js `lsp-edit`). */
async function applyToPage(mgr, st, produced) {
  const doc = st.doc
  // Earlier files waited on their pages: this document may have moved on meanwhile (its page typed,
  // a resync, another owner). The seq sent is the one checked, never the document's current one.
  if (mgr.docs.get(st.uri) !== doc || doc.version !== st.version || doc.owner !== st.owner) throw new Error('changed while the edit was applied; try again')
  const rel = doc.holders.get(st.owner)
  // The page's own text is checked against `seq` (the last change it sent); the text the host has
  // must also still be the one the edits fit, which the page cannot see.
  applyTextEdits(doc.text, st.edits)
  const r = await st.owner.applyEdits(rel, st.edits, st.seq, PAGE_EDIT_TIMEOUT_MS)
  if (!r || r.applied !== true) throw new Error((r && typeof r.reason === 'string' && r.reason.slice(0, 300)) || 'the page did not apply the edit')
  // The page posts its `lsp-change` for the edit before its `lsp-edit-done`, on one port, and this
  // runs in the microtasks of that answer: the version now is the one the edit produced, before
  // anything the person types next. Not recorded when the document went (a close, another owner):
  // the snapshot keeps the old version, which no longer matches, and a command's edit is refused.
  if (produced && produced.versions instanceof Map && mgr.docs.get(st.uri) === doc && doc.owner === st.owner) produced.versions.set(st.uri, doc.version)
  return null
}

/**
 * A file no page holds: read, edited, and written by compare-and-swap against what was read.
 * Returns `{ lost: true }` when the edit was written but another write into the old file was lost.
 */
function applyToDisk(mgr, st, since, written, produced) {
  if (writtenSince(st.real, since, written)) throw new Error('the file changed on disk while the language server worked; try again')
  const now = files.readFile(mgr.root, st.rel)
  if (!now.exists) throw new Error('the file is gone')
  if (now.readOnly || typeof now.text !== 'string') throw new Error(`the file cannot be edited here (${now.why || 'read-only'})`)
  const text = applyTextEdits(now.text, st.edits)
  const r = files.saveFile(mgr.root, st.rel, text, now.hash)
  if (r.result !== 'saved' && !r.written) throw new Error('the file changed on disk meanwhile; try again')
  // The servers learn it like any project change (gopls and tsserver read unopened files from disk).
  mgr.noteChanged(now.real)
  if (produced && produced.written instanceof Map && !r.written) {
    try {
      produced.written.set(st.real, fs.statSync(st.real).mtimeMs)
    } catch {}
  }
  return r.written ? { lost: true } : null
}

module.exports = { before, position, offsetAt, applyWorkspaceEdit, applyTextEdits, planEdit, sortEdits, textEdit }
