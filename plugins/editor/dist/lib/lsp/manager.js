'use strict'
// The project's language servers and the documents they know (design-editor.md §3). One manager per
// plugin host, so per project: one server per language, rooted at the project folder, started on
// the first file of that language, stopped a minute after its last document closed, restarted after
// a crash with a backoff (at most 3 restarts in 5 minutes), then left `failed` with a Restart bar.
//
// Documents are refcounted per URI: every file tab instance (a page line, one per view) that shows
// a file holds it, and the server sees ONE `didOpen` and ONE `didClose` for it. One holder is the
// syncing owner: only its edits reach the server; the other views read (their asks are answered
// against the owner's text). When the owner leaves, the next holder becomes the owner and is asked
// for its whole text (`lsp-resync`: two views may hold different unsaved buffers). The host keeps
// each document's text, the owner's edits applied, so a restarted server gets its documents back
// without asking any page.
//
// Every path comes from a page and is checked by realpath inside the project (files.js
// resolveInProject) before it becomes a URI; every URI from a server is mapped back to a project
// path or dropped. Pages ask in editor terms (`hover`, `complete`...); the allow-list ASKS is the
// only way a page's message becomes an LSP request, and the host builds every request's params
// itself from checked numbers and strings (no `workspace/executeCommand`, no method a page names).

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL, fileURLToPath } = require('node:url')
const files = require('../files.js')
const servers = require('./servers.js')
const { LspServer } = require('./server.js')
const { applyWorkspaceEdit } = require('./edits.js')

/** A document over this many UTF-16 units gets no language server (highlighting only). */
const MAX_DOC_CHARS = 2 * 1024 * 1024
/** Documents one page line may hold, and the whole project. */
const MAX_HOLDER_DOCS = 16
const MAX_DOCS = 256
/** A server whose last document closed stops this long later (a tab closed and reopened keeps it). */
const IDLE_STOP_MS = 60 * 1000
/** Crash restarts: at most RESTART_LIMIT within RESTART_WINDOW_MS, after these delays; then `failed`. */
const RESTART_LIMIT = 3
const RESTART_WINDOW_MS = 5 * 60 * 1000
const RESTART_DELAYS_MS = [1000, 3000, 10000]
/** An answer's JSON (the envelope included) is kept under this many characters: the port's cap is 1 MiB. */
const ANSWER_BUDGET = 900 * 1024
/** Diagnostics per document, and characters per diagnostic message. */
const MAX_DIAGNOSTICS = 1000
const MAX_DIAGNOSTIC_CHARS = 2000
/** A diagnostic's opaque `data` (handed back with a code action) is kept only this small. */
const MAX_DIAGNOSTIC_DATA_CHARS = 4096
/** Watched-file changes are gathered this long, then sent in one notification. */
const WATCH_FLUSH_MS = 300
/** At most this many changes per notification; the paths it remembers to tell Created from Changed. */
const MAX_WATCH_BATCH = 1000
const MAX_KNOWN_FILES = 20000
/** The asks' deadlines: completion is typed against, the rest a person waits on. */
const ASK_TIMEOUT_MS = 10 * 1000
const COMPLETE_TIMEOUT_MS = 5 * 1000
/** A rename or a command may make the server read the whole project. */
const EDIT_TIMEOUT_MS = 30 * 1000
/** Locations one definition or references answer keeps; the files read for their line text. */
const MAX_LOCATIONS = 2000
const MAX_LINE_TEXT_FILES = 50
const MAX_LINE_TEXT_CHARS = 200
const MAX_LINE_TEXT_FILE_BYTES = 1024 * 1024
/** Outside-the-project files a server named (definition, references): the only ones a tab may show. */
const MAX_OUTSIDE = 1000
/** Code actions offered per ask (the page picks one by id). */
const MAX_ACTIONS = 100
/** A command's arguments (the server's own, handed back to it) are no bigger than this. */
const MAX_COMMAND_CHARS = 64 * 1024

// FileChangeType of workspace/didChangeWatchedFiles.
const CREATED = 1
const CHANGED = 2
const DELETED = 3

const MAX_LINE = 10_000_000
const MAX_CHARACTER = 1_000_000
const isIndex = (v, max) => Number.isInteger(v) && v >= 0 && v <= max
/** A page's change counter (`seq`), or undefined. */
const seqOf = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : undefined)

/** A `{ line, character }` from a page, or a thrown Error. */
function position(v) {
  if (!v || typeof v !== 'object' || !isIndex(v.line, MAX_LINE) || !isIndex(v.character, MAX_CHARACTER)) {
    throw new Error('a position is { line, character }, both whole numbers from 0')
  }
  return { line: v.line, character: v.character }
}

/** A `{ start, end }` range from a page, or a thrown Error. */
function range(v) {
  if (!v || typeof v !== 'object') throw new Error('a range is { start, end }')
  const start = position(v.start)
  const end = position(v.end)
  if (end.line < start.line || (end.line === start.line && end.character < start.character)) throw new Error('a range ends before it starts')
  return { start, end }
}

/** The UTF-16 offset of `pos` in `text`, or -1 when it is past the end (a character past a line's end is its end, as LSP says). */
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

/** `text` with LSP content changes applied in order; throws on a range that is not in it. */
function applyChanges(text, changes) {
  let out = text
  for (const c of changes) {
    if (!c || typeof c !== 'object' || typeof c.text !== 'string') throw new Error('a change is { range?, text }')
    if (c.range === undefined) {
      out = c.text
      if (out.length > MAX_DOC_CHARS) throw new Error('the document is too large for its language server')
      continue
    }
    const r = range(c.range)
    const from = offsetAt(out, r.start)
    const to = offsetAt(out, r.end)
    if (from < 0 || to < 0) throw new Error('a change is outside the document')
    out = out.slice(0, from) + c.text + out.slice(to)
    if (out.length > MAX_DOC_CHARS) throw new Error('the document is too large for its language server')
  }
  return out
}

const jsonLength = (v) => {
  try {
    return JSON.stringify(v === undefined ? null : v).length
  } catch {
    return Infinity
  }
}

/** The longest prefix of `list` whose JSON fits `budget` (binary search on the count). */
function fitList(list, budget) {
  if (jsonLength(list) <= budget) return { value: list, truncated: false }
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (jsonLength(list.slice(0, mid)) <= budget) lo = mid
    else hi = mid - 1
  }
  return { value: list.slice(0, lo), truncated: true }
}

/**
 * A server's result made to fit the port's message cap (design §3: "trims results to stay under the
 * port's message cap"): a list keeps its first items (completion, references, symbols, edits of a
 * format), a CompletionList keeps its first items and says it is incomplete (the page asks again as
 * the person types), a hover's text is cut. What cannot be cut (one huge item, a WorkspaceEdit) is
 * refused as too large rather than sent broken. `{ value, truncated }`; throws when nothing fits.
 */
function fitResult(result, budget = ANSWER_BUDGET) {
  if (jsonLength(result) <= budget) return { value: result === undefined ? null : result, truncated: false }
  if (Array.isArray(result)) return fitList(result, budget)
  if (result && typeof result === 'object') {
    if (Array.isArray(result.items)) {
      const rest = { ...result, items: [], isIncomplete: true }
      const fit = fitList(result.items, budget - jsonLength(rest))
      return { value: { ...rest, items: fit.value }, truncated: true }
    }
    if (result.contents !== undefined) {
      const cut = (s) => (typeof s === 'string' && s.length > budget / 2 ? s.slice(0, Math.floor(budget / 2)) + '\n…' : s)
      const c = result.contents
      const contents = typeof c === 'string' ? cut(c) : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? cut(x) : x && typeof x === 'object' ? { ...x, value: cut(x.value) } : x)) : c && typeof c === 'object' ? { ...c, value: cut(c.value) } : c
      const value = { ...result, contents }
      if (jsonLength(value) <= budget) return { value, truncated: true }
    }
  }
  throw new Error('the language server answered with more than a page can be sent')
}

/** A server's diagnostics, cut to what a page needs and can be sent. */
function cleanDiagnostics(list) {
  const out = []
  for (const d of Array.isArray(list) ? list : []) {
    if (out.length >= MAX_DIAGNOSTICS) break
    if (!d || typeof d !== 'object' || !d.range || typeof d.message !== 'string') continue
    const c = { range: d.range, message: d.message.length > MAX_DIAGNOSTIC_CHARS ? d.message.slice(0, MAX_DIAGNOSTIC_CHARS) + '…' : d.message }
    if (Number.isInteger(d.severity)) c.severity = d.severity
    if (typeof d.code === 'string' || typeof d.code === 'number') c.code = d.code
    if (typeof d.source === 'string') c.source = d.source.slice(0, 100)
    if (Array.isArray(d.tags)) c.tags = d.tags.filter((t) => t === 1 || t === 2)
    if (d.data !== undefined && jsonLength(d.data) <= MAX_DIAGNOSTIC_DATA_CHARS) c.data = d.data
    out.push(c)
  }
  return out
}

/** A one-line string from a page, at most `max` characters, or a thrown Error. */
function oneLine(v, max, what) {
  if (typeof v !== 'string' || v === '' || v.length > max || /[\n\r\0]/.test(v)) throw new Error(`${what} must be one line of at most ${max} characters`)
  return v
}

/**
 * The allow-list: what a page may ask, the one LSP method each becomes, the server capability it
 * needs (an ask the server does not offer answers null, unsupported), and the params the HOST builds
 * from the page's checked fields. Nothing else a page sends reaches a server: not a method name, not
 * raw params, not `workspace/executeCommand` (a code action's command is the host's to run: the page
 * picks an action the host offered it by id, `runCodeAction`, and the host runs that action's own
 * edit and command). `post` says what the host does with a result before the page sees it.
 */
/** A completion item (and the ones kept per page line for resolve) is no bigger than this. */
const MAX_ITEM_CHARS = 64 * 1024
const MAX_GIVEN_ITEMS = 1000

const ASKS = {
  hover: { method: 'textDocument/hover', cap: 'hoverProvider', params: (doc, a) => ({ ...at(doc, a) }) },
  complete: {
    method: 'textDocument/completion',
    cap: 'completionProvider',
    timeoutMs: COMPLETE_TIMEOUT_MS,
    params: (doc, a) => {
      const p = at(doc, a)
      if (a.triggerCharacter !== undefined) {
        if (typeof a.triggerCharacter !== 'string' || a.triggerCharacter.length < 1 || a.triggerCharacter.length > 2) throw new Error('triggerCharacter must be one character')
        p.context = { triggerKind: 2, triggerCharacter: a.triggerCharacter }
      } else {
        p.context = { triggerKind: a.incomplete === true ? 3 : 1 }
      }
      return p
    },
  },
  resolveCompletion: {
    method: 'completionItem/resolve',
    cap: (c) => !!(c.completionProvider && c.completionProvider.resolveProvider),
    params: (_doc, a, holder, mgr) => {
      // An item this server gave the page, handed back to the same server for its details: only an
      // item the host itself sent to this holder (a page could else hand a server arbitrary `data`).
      if (!a.item || typeof a.item !== 'object' || Array.isArray(a.item) || jsonLength(a.item) > MAX_ITEM_CHARS) throw new Error('item must be a completion item')
      if (!mgr.gaveItem(holder, a.item)) throw new Error('item must be a completion item this server gave')
      return a.item
    },
  },
  signature: { method: 'textDocument/signatureHelp', cap: 'signatureHelpProvider', params: (doc, a) => at(doc, a) },
  // Locations come back as project paths, or outside paths the host then lets a read-only tab show.
  definition: { method: 'textDocument/definition', cap: 'definitionProvider', params: (doc, a) => at(doc, a), post: 'locations' },
  references: {
    method: 'textDocument/references',
    cap: 'referencesProvider',
    params: (doc, a) => ({ ...at(doc, a), context: { includeDeclaration: a.includeDeclaration !== false } }),
    post: 'locations',
  },
  symbols: { method: 'textDocument/documentSymbol', cap: 'documentSymbolProvider', params: (doc) => ({ textDocument: { uri: doc.uri } }) },
  format: {
    method: 'textDocument/formatting',
    cap: 'documentFormattingProvider',
    params: (doc, a) => {
      const tabSize = Number.isInteger(a.tabSize) && a.tabSize >= 1 && a.tabSize <= 16 ? a.tabSize : 2
      return { textDocument: { uri: doc.uri }, options: { tabSize, insertSpaces: a.insertSpaces !== false } }
    },
    // The host applies the edits (through the document's owner page); the page hears the counts.
    post: 'textEdits',
  },
  prepareRename: {
    method: 'textDocument/prepareRename',
    cap: (c) => !!(c.renameProvider && typeof c.renameProvider === 'object' && c.renameProvider.prepareProvider),
    params: (doc, a) => at(doc, a),
  },
  rename: {
    method: 'textDocument/rename',
    cap: 'renameProvider',
    params: (doc, a) => ({ ...at(doc, a), newName: oneLine(a.newName, 200, 'newName') }),
    timeoutMs: EDIT_TIMEOUT_MS,
    post: 'workspaceEdit',
  },
  codeActions: {
    method: 'textDocument/codeAction',
    cap: 'codeActionProvider',
    params: (doc, a) => {
      const r = range(a.range)
      // The diagnostics are the server's own (kept by the host) that touch the range, never the page's.
      const touches = (d) => {
        const s = d.range && d.range.start
        const e = d.range && d.range.end
        if (!s || !e) return false
        return !(e.line < r.start.line || s.line > r.end.line)
      }
      const context = { diagnostics: (doc.diagnostics || []).filter(touches).slice(0, 50), triggerKind: 1 }
      if (Array.isArray(a.only)) {
        const only = a.only.filter((k) => typeof k === 'string' && /^[a-zA-Z.]{1,60}$/.test(k)).slice(0, 10)
        if (only.length) context.only = only
      }
      return { textDocument: { uri: doc.uri }, range: r, context }
    },
    // The page gets titles and ids; the actions themselves (edits, commands) stay in the host.
    post: 'actions',
  },
}

function at(doc, a) {
  return { textDocument: { uri: doc.uri }, position: position(a.position) }
}

function hasCap(caps, cap) {
  if (typeof cap === 'function') return cap(caps || {})
  const v = caps && caps[cap]
  return v !== undefined && v !== null && v !== false
}

/**
 * What a ready server offers, for the page: which asks make sense (a key a server lacks gets no
 * menu entry) and the characters that start a completion or a signature help as they are typed.
 * Plain booleans and short strings only: nothing of the server's own capability object travels.
 */
function featuresOf(caps) {
  const chars = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.length >= 1 && x.length <= 2).slice(0, 20) : [])
  const sig = caps.signatureHelpProvider && typeof caps.signatureHelpProvider === 'object' ? caps.signatureHelpProvider : {}
  const comp = caps.completionProvider && typeof caps.completionProvider === 'object' ? caps.completionProvider : {}
  const f = {}
  for (const [what, spec] of Object.entries(ASKS)) f[what] = hasCap(caps, spec.cap)
  f.completeTriggers = chars(comp.triggerCharacters)
  f.signatureTriggers = chars(sig.triggerCharacters)
  f.signatureRetriggers = chars(sig.retriggerCharacters)
  return f
}

class LspManager {
  /**
   * @param {object} o
   * @param {string} o.root the project folder (ctx.projectDir)
   * @param {Function} o.spawn ctx.processes.spawn
   * @param {object} [o.log]
   * @param {object} [o.env] whose PATH finds the servers (default process.env: the login-shell env)
   * @param {unknown} [o.servers] the `servers` app setting
   * @param {object} [o.timing] tests shorten the timers: { idleStopMs, restartDelaysMs, restartLimit, restartWindowMs, watchFlushMs }
   */
  constructor(o) {
    this.root = fs.realpathSync(o.root)
    this.spawn = o.spawn
    this.log = o.log || { info() {}, warn() {} }
    this.env = o.env || process.env
    this.timing = {
      idleStopMs: IDLE_STOP_MS,
      restartDelaysMs: RESTART_DELAYS_MS,
      restartLimit: RESTART_LIMIT,
      restartWindowMs: RESTART_WINDOW_MS,
      watchFlushMs: WATCH_FLUSH_MS,
      ...(o.timing || {}),
    }
    this.setServers(o.servers)
    /** language -> slot { language, entry, state, server, message, install, crashes, idleTimer, restartTimer, opened } */
    this.slots = new Map()
    /** uri -> doc { uri, rel, real, language, languageId, version, text, holders: Map holder -> its own rel, owner, diagnostics } */
    this.docs = new Map()
    /** Watched-file changes waiting for the flush: real -> true. */
    this.pendingWatch = new Set()
    this.watchTimer = null
    /** real -> 'mtime:size' last told (Created vs Changed, and a repeat with nothing new skipped). */
    this.known = new Map()
    /** holder -> the completion items answered to it (JSON), the only ones `resolveCompletion` takes. */
    this.given = new WeakMap()
    /** holder -> the code actions last offered to it: { uri, srv, versions, kept: Map id -> action }. */
    this.actions = new WeakMap()
    this.nextAction = 0
    /** Outside-the-project files a server returned as a location (abs path -> true, oldest first). */
    this.outside = new Map()
    this.disposed = false
  }

  /** The `servers` setting changed (or was read at start): servers whose argv changed restart. */
  setServers(setting) {
    const t = servers.serverTable(setting)
    for (const p of t.problems) this.log.warn(`language servers setting: ${p}`)
    const before = this.table
    this.table = t
    if (!before || !this.slots) return
    for (const slot of this.slots.values()) {
      const entry = t.table.get(slot.language)
      const same = entry && JSON.stringify(entry.candidates) === JSON.stringify(slot.entry.candidates)
      if (same) continue
      if (!entry) {
        // The language left the table: its server stops; its documents stay open without one.
        slot.entry = { ...slot.entry, candidates: [] }
        this.stopSlot(slot, 'stopped')
        continue
      }
      slot.entry = entry
      slot.crashes = []
      if (this.docsOf(slot.language).length === 0) {
        this.stopSlot(slot, 'stopped')
        continue
      }
      this.stopSlot(slot, 'stopped').then(() => this.startSlot(slot))
    }
  }

  // ---- documents ----

  /**
   * `holder` (a page line: { post(message) }) shows `rel` with `text`: refcounted per URI. Resolves
   * `{ language, name, owner, state }`, or `{ language: null }` when no server serves the file. The
   * owner sending its text again (a resync) replaces the server's copy with it.
   */
  open(holder, rel, text, seq) {
    if (this.disposed) return { language: null }
    if (typeof text !== 'string') throw new Error('text must be a string')
    const r = files.resolveInProject(this.root, rel)
    const lang = servers.languageOf(r.rel, this.table)
    if (!lang) return { language: null }
    const uri = pathToFileURL(r.real).href
    if (text.length > MAX_DOC_CHARS) {
      // A document that grew past the cap (its owner's resync): the server no longer has it.
      const held = this.docOf(holder, r.rel)
      if (held) this.release(holder, held)
      return { language: null, why: 'the file is too large for a language server' }
    }
    let doc = this.docs.get(uri)
    if (!doc) {
      if (this.docs.size >= MAX_DOCS) throw new Error('too many documents are open for the language servers')
      if (this.heldBy(holder).length >= MAX_HOLDER_DOCS) throw new Error('too many documents in one tab')
      doc = { uri, rel: r.rel, real: r.real, language: lang.entry.language, languageId: lang.languageId, version: 1, text, holders: new Map([[holder, r.rel]]), owner: holder, diagnostics: null, seq: seqOf(seq) }
      this.docs.set(uri, doc)
      const slot = this.slotFor(doc.language)
      if (slot.idleTimer) {
        clearTimeout(slot.idleTimer)
        slot.idleTimer = null
      }
      if (slot.server && slot.state === 'ready') this.didOpen(slot, doc)
      else if (!slot.server && !slot.restartTimer && slot.state !== 'failed') this.startSlot(slot)
    } else if (doc.owner === holder) {
      // The owner's whole text again: after an ownership change, a resync, its own reconnect.
      doc.seq = seqOf(seq)
      this.replaceText(doc, text)
    } else {
      if (!doc.holders.has(holder) && this.heldBy(holder).length >= MAX_HOLDER_DOCS) throw new Error('too many documents in one tab')
      // Each holder's own spelling of the path (a symlink alias may reach the same file): every
      // message to it and every ask from it uses that one.
      if (!doc.holders.has(holder)) doc.holders.set(holder, r.rel)
      if (!doc.owner) {
        doc.owner = holder
        doc.seq = seqOf(seq)
        this.replaceText(doc, text)
      }
    }
    const slot = this.slotFor(doc.language)
    // A late joiner gets what the others already have: the server's state and the diagnostics.
    this.postTo(holder, this.statusMessage(slot))
    if (doc.diagnostics) this.postTo(holder, { t: 'lsp-diagnostics', path: doc.holders.get(holder), diagnostics: doc.diagnostics })
    return { language: doc.language, name: slot.entry.name, owner: doc.owner === holder, state: slot.state }
  }

  /**
   * The owner's edits (LSP content changes); another holder's are ignored (it reads). `seq` is the
   * page's count of what it sent: an edit the host routes to the page names the seq its positions
   * fit (lib/lsp/edits.js), so a page that typed since refuses it.
   */
  change(holder, rel, changes, seq) {
    const doc = this.docOf(holder, rel)
    if (!doc || doc.owner !== holder) return false
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 1000) throw new Error('changes must be a non-empty list')
    let text
    try {
      text = applyChanges(doc.text, changes)
    } catch (e) {
      // The page and the host disagree about the text: the page sends all of it again.
      this.postTo(holder, { t: 'lsp-resync', path: doc.holders.get(holder), why: e.message })
      return false
    }
    doc.text = text
    doc.version++
    doc.seq = seqOf(seq)
    const slot = this.slots.get(doc.language)
    if (slot && slot.server && slot.opened.has(doc.uri)) {
      // The page's changes as they came (checked above), so the server sees a small edit, not the file.
      const contentChanges = changes.map((c) => (c.range === undefined ? { text: c.text } : { range: range(c.range), text: c.text }))
      slot.server.notify('textDocument/didChange', { textDocument: { uri: doc.uri, version: doc.version }, contentChanges })
    }
    return true
  }

  replaceText(doc, text) {
    doc.text = text
    doc.version++
    const slot = this.slots.get(doc.language)
    if (slot && slot.server && slot.opened.has(doc.uri)) {
      slot.server.notify('textDocument/didChange', { textDocument: { uri: doc.uri, version: doc.version }, contentChanges: [{ text }] })
    }
  }

  /** `holder` no longer shows `rel`. The last holder's close is the server's `didClose`. */
  close(holder, rel) {
    const doc = this.docOf(holder, rel)
    if (doc) this.release(holder, doc)
  }

  /** The page line is gone (its tab closed, its view unmounted, a reconnect): every document it held. */
  closeHolder(holder) {
    for (const doc of this.heldBy(holder)) this.release(holder, doc)
  }

  release(holder, doc) {
    doc.holders.delete(holder)
    if (doc.holders.size > 0) {
      if (doc.owner === holder) {
        // The next view syncs: its buffer may differ from the one that left, so it sends its text.
        doc.owner = doc.holders.keys().next().value
        this.postTo(doc.owner, { t: 'lsp-resync', path: doc.holders.get(doc.owner), owner: true })
      }
      return
    }
    this.docs.delete(doc.uri)
    const slot = this.slots.get(doc.language)
    if (!slot) return
    if (slot.server && slot.opened.has(doc.uri)) {
      slot.opened.delete(doc.uri)
      slot.server.notify('textDocument/didClose', { textDocument: { uri: doc.uri } })
    }
    if (this.docsOf(slot.language).length === 0) {
      if (slot.restartTimer) {
        clearTimeout(slot.restartTimer)
        slot.restartTimer = null
        if (!slot.server) slot.state = 'stopped'
      }
      if (slot.server && !slot.idleTimer) {
        slot.idleTimer = setTimeout(() => {
          slot.idleTimer = null
          if (this.docsOf(slot.language).length === 0) this.stopSlot(slot, 'stopped')
        }, this.timing.idleStopMs)
        if (typeof slot.idleTimer.unref === 'function') slot.idleTimer.unref()
      }
    }
  }

  docOf(holder, rel) {
    let clean
    try {
      clean = files.relativePath(rel)
    } catch {
      return null
    }
    for (const doc of this.docs.values()) if (doc.holders.get(holder) === clean) return doc
    return null
  }

  /**
   * The document a server's URI names. Servers re-serialize the URI they were sent (vscode-uri
   * percent-encodes `+`, `@`, `$`, `&`...: `src/routes/+page.ts`), so the exact string is tried first,
   * then the URI normalized the way ours are made (decoded to a path and encoded again).
   */
  docByUri(uri) {
    const direct = this.docs.get(uri)
    if (direct) return direct
    if (typeof uri !== 'string' || !uri.startsWith('file:')) return undefined
    try {
      return this.docs.get(pathToFileURL(fileURLToPath(uri)).href)
    } catch {
      return undefined
    }
  }

  heldBy(holder) {
    return [...this.docs.values()].filter((d) => d.holders.has(holder))
  }

  docsOf(language) {
    return [...this.docs.values()].filter((d) => d.language === language)
  }

  // ---- asks ----

  /**
   * A page's ask about a document it holds, in editor terms (`what` a key of ASKS). Resolves
   * `{ result, truncated }` (result null and `unsupported` when the server offers no such thing),
   * rejects with a message for the page. `signal` (an AbortController's) cancels it.
   */
  async ask(holder, what, rel, args, signal) {
    if (what === 'runCodeAction') return this.runCodeAction(holder, rel, args)
    if (!Object.prototype.hasOwnProperty.call(ASKS, what)) throw new Error(`${String(what).slice(0, 60)} is not something a page may ask`)
    const spec = ASKS[what]
    const doc = this.docOf(holder, rel)
    if (!doc) throw new Error('the document is not open for its language server')
    const a = args && typeof args === 'object' ? args : {}
    const params = spec.params(doc, a, holder, this)
    const slot = this.slots.get(doc.language)
    if (!slot || !slot.server) return { result: null, unavailable: slot ? slot.state : 'stopped' }
    const srv = slot.server
    const caps = await srv.ready
    if (slot.server !== srv) throw new Error('the language server restarted')
    // Given up while the server was starting (the page's deadline): nothing is sent for it.
    if (signal && signal.aborted) throw new Error('cancelled')
    if (!hasCap(caps, spec.cap)) return { result: null, unsupported: true }
    // What every open document was when the server was asked: an edit it answers is applied only to
    // documents that did not move on meanwhile (edits.js).
    const versions = this.versions()
    const result = await srv.request(spec.method, params, { timeoutMs: spec.timeoutMs || ASK_TIMEOUT_MS, signal })
    if (spec.post === 'textEdits') {
      if (!Array.isArray(result) || result.length === 0) return { result: { applied: true, files: 0, edits: 0 } }
      return { result: await applyWorkspaceEdit(this, { changes: { [doc.uri]: result } }, { versions }) }
    }
    if (spec.post === 'workspaceEdit') {
      if (!result) return { result: { applied: false, failureReason: 'the language server found nothing to change here', files: 0, edits: 0 } }
      return { result: await applyWorkspaceEdit(this, result, { versions }) }
    }
    if (spec.post === 'actions') return this.offerActions(holder, doc, srv, versions, result)
    if (spec.post === 'locations') return this.locations(result, what === 'references')
    const fit = fitResult(result)
    if (what === 'complete') this.giveItems(holder, fit.value)
    return { result: fit.value, truncated: fit.truncated }
  }

  /** Remembers the completion items answered to `holder` (a list or a CompletionList), for resolve. */
  giveItems(holder, result) {
    const items = Array.isArray(result) ? result : result && Array.isArray(result.items) ? result.items : []
    let set = this.given.get(holder)
    if (!set) {
      set = new Set()
      this.given.set(holder, set)
    }
    for (const it of items) {
      if (!it || typeof it !== 'object') continue
      let j
      try {
        j = JSON.stringify(it)
      } catch {
        continue
      }
      if (j.length > MAX_ITEM_CHARS) continue
      set.delete(j)
      set.add(j)
      if (set.size > MAX_GIVEN_ITEMS) set.delete(set.values().next().value)
    }
  }

  /** Whether `item` is, as sent, one the host answered to `holder`. */
  gaveItem(holder, item) {
    const set = this.given.get(holder)
    if (!set) return false
    try {
      return set.has(JSON.stringify(item))
    } catch {
      return false
    }
  }

  /** uri -> version of every open document now. */
  versions() {
    return new Map([...this.docs.values()].map((d) => [d.uri, d.version]))
  }

  /**
   * A definition or references answer (Location, Location[] or LocationLink[]) as
   * `[{ path, range, text? } | { outside, range }]`: a URI in the project becomes its path, one
   * outside it (node_modules, the module cache, vendor) its absolute path, which the host from then
   * on lets a read-only tab show (`allowsOutside`): only a location a server returned. Anything that
   * is not a file is dropped. References get their line's text (an open document's own, else the
   * file's, for the first MAX_LINE_TEXT_FILES files).
   */
  locations(result, withText) {
    const list = result === null || result === undefined ? [] : Array.isArray(result) ? result : [result]
    const out = []
    const texts = new Map()
    for (const l of list.slice(0, MAX_LOCATIONS)) {
      if (!l || typeof l !== 'object') continue
      const uri = typeof l.targetUri === 'string' ? l.targetUri : l.uri
      let r
      try {
        r = range(l.targetSelectionRange || l.range || l.targetRange)
      } catch {
        continue
      }
      const where = this.pathOfUri(uri)
      if (!where) continue
      if (where.outside !== undefined) {
        this.allowOutside(where.outside)
        out.push({ outside: where.outside, range: r })
        continue
      }
      const loc = { path: where.rel, range: r }
      if (withText) {
        const t = this.lineText(texts, uri, where.rel, r.start.line)
        if (t !== undefined) loc.text = t
      }
      out.push(loc)
    }
    const fit = fitList(out, ANSWER_BUDGET)
    return { result: fit.value, truncated: fit.truncated }
  }

  /** Line `line` of project file `rel` (an open document's own text), or undefined. `texts` caches per answer. */
  lineText(texts, uri, rel, line) {
    let text = texts.get(rel)
    if (text === undefined) {
      const doc = this.docByUri(uri)
      text = null
      if (doc) text = doc.text
      else if (texts.size < MAX_LINE_TEXT_FILES) {
        try {
          // Read in the host's one thread for a list: a big file (a bundle, generated code) is left without text.
          if (fs.statSync(path.join(this.root, rel)).size > MAX_LINE_TEXT_FILE_BYTES) throw new Error('large')
          const f = files.readFile(this.root, rel)
          if (f.exists && typeof f.text === 'string' && f.why !== 'binary') text = f.text
        } catch {
          // unreadable, or a link out of the project: no text
        }
      }
      texts.set(rel, text)
    }
    if (typeof text !== 'string') return undefined
    let at = 0
    for (let i = 0; i < line; i++) {
      const nl = text.indexOf('\n', at)
      if (nl < 0) return undefined
      at = nl + 1
    }
    let end = text.indexOf('\n', at)
    if (end < 0) end = text.length
    return text.slice(at, Math.min(end, at + MAX_LINE_TEXT_CHARS))
  }

  allowOutside(abs) {
    this.outside.delete(abs)
    this.outside.set(abs, true)
    if (this.outside.size > MAX_OUTSIDE) this.outside.delete(this.outside.keys().next().value)
  }

  /** Whether a server returned `abs` (an absolute path outside the project) as a location. */
  allowsOutside(abs) {
    return typeof abs === 'string' && this.outside.has(abs)
  }

  /**
   * A codeAction answer kept in the host (holder -> its last list) and told to the page as
   * `[{ id, title, kind?, preferred?, disabled? }]`: the page never sees, so never hands back, an
   * edit or a command.
   */
  offerActions(holder, doc, srv, versions, result) {
    const kept = new Map()
    const out = []
    for (const a of Array.isArray(result) ? result.slice(0, MAX_ACTIONS) : []) {
      if (!a || typeof a !== 'object' || typeof a.title !== 'string' || !a.title) continue
      const id = ++this.nextAction
      kept.set(id, a)
      const o = { id, title: a.title.slice(0, 200) }
      if (typeof a.kind === 'string') o.kind = a.kind.slice(0, 60)
      if (a.isPreferred === true) o.preferred = true
      if (a.disabled && typeof a.disabled === 'object') o.disabled = typeof a.disabled.reason === 'string' ? a.disabled.reason.slice(0, 200) : 'not available'
      out.push(o)
    }
    this.actions.set(holder, { uri: doc.uri, srv, versions, kept })
    return { result: out }
  }

  /**
   * Runs code action `args.id` of the list last offered to `holder` for this document: resolved
   * first when the server left its edit out, then its edit applied (edits.js) and its command run by
   * the host (`workspace/executeCommand`, only a command the server declared). One use: the list is
   * gone after it.
   */
  async runCodeAction(holder, rel, args) {
    const doc = this.docOf(holder, rel)
    if (!doc) throw new Error('the document is not open for its language server')
    const entry = this.actions.get(holder)
    const id = args && args.id
    if (!entry || entry.uri !== doc.uri || !Number.isInteger(id) || !entry.kept.has(id)) throw new Error('that code action is no longer offered; ask again')
    this.actions.delete(holder)
    const slot = this.slots.get(doc.language)
    const srv = slot && slot.server
    if (!srv || srv !== entry.srv) throw new Error('the language server restarted; ask again')
    let action = entry.kept.get(id)
    if (action.disabled) throw new Error(`not available: ${String(action.disabled.reason || '').slice(0, 200)}`)
    // A bare Command (an older server's answer) runs as it is.
    if (typeof action.command === 'string') {
      await this.executeCommand(slot, srv, action)
      return { result: { applied: true, files: 0, edits: 0 } }
    }
    const caps = srv.capabilities || {}
    if (!action.edit && !action.command && caps.codeActionProvider && caps.codeActionProvider.resolveProvider) {
      const resolved = await srv.request('codeAction/resolve', action, { timeoutMs: EDIT_TIMEOUT_MS })
      if (resolved && typeof resolved === 'object') action = resolved
    }
    let applied = { applied: true, files: 0, edits: 0 }
    if (action.edit) {
      applied = await applyWorkspaceEdit(this, action.edit, { versions: entry.versions })
      if (!applied.applied) return { result: applied }
    }
    if (action.command && typeof action.command === 'object') await this.executeCommand(slot, srv, action.command)
    return { result: applied }
  }

  /**
   * Runs a server's own command (from its code action) on that server: only a command its
   * `executeCommandProvider` lists. A `workspace/applyEdit` it makes while this runs is applied
   * (serverApplyEdit); any other time it is refused.
   */
  async executeCommand(slot, srv, cmd) {
    const caps = srv.capabilities || {}
    const listed = caps.executeCommandProvider && Array.isArray(caps.executeCommandProvider.commands) ? caps.executeCommandProvider.commands : []
    if (typeof cmd.command !== 'string' || !listed.includes(cmd.command)) throw new Error('the language server did not declare the command of that action')
    const args = cmd.arguments
    if (args !== undefined && (!Array.isArray(args) || jsonLength(args) > MAX_COMMAND_CHARS)) throw new Error("the action's command is too large")
    slot.commands = (slot.commands || 0) + 1
    slot.commandVersions = this.versions()
    try {
      await srv.request('workspace/executeCommand', args === undefined ? { command: cmd.command } : { command: cmd.command, arguments: args }, { timeoutMs: EDIT_TIMEOUT_MS })
    } finally {
      slot.commands--
    }
  }

  /**
   * The server's `workspace/applyEdit`: applied only while a command the host ran on that server is
   * working (a server cannot rewrite project files whenever it likes), against the documents as
   * they were when the command started.
   */
  async serverApplyEdit(slot, srv, edit) {
    if (slot.server !== srv || !(slot.commands > 0)) {
      return { applied: false, failureReason: "this editor applies a server's edit only while a command it ran is working" }
    }
    const r = await applyWorkspaceEdit(this, edit, { versions: slot.commandVersions })
    const out = { applied: r.applied }
    if (r.failureReason) out.failureReason = r.failureReason
    if (Number.isInteger(r.failedChange)) out.failedChange = r.failedChange
    return out
  }

  // ---- servers ----

  slotFor(language) {
    let slot = this.slots.get(language)
    if (!slot) {
      slot = { language, entry: this.table.table.get(language), state: 'stopped', server: null, message: undefined, install: undefined, crashes: [], idleTimer: null, restartTimer: null, opened: new Set() }
      this.slots.set(language, slot)
    }
    return slot
  }

  statusMessage(slot) {
    const m = { t: 'lsp-status', language: slot.language, name: slot.entry ? slot.entry.name : slot.language, state: slot.state }
    if (slot.install) m.install = slot.install
    if (slot.message) m.message = slot.message
    if (slot.state === 'ready' && slot.server && slot.server.capabilities) m.features = featuresOf(slot.server.capabilities)
    return m
  }

  postStatus(slot) {
    const m = this.statusMessage(slot)
    const told = new Set()
    for (const doc of this.docsOf(slot.language)) {
      for (const h of doc.holders.keys()) {
        if (told.has(h)) continue
        told.add(h)
        this.postTo(h, m)
      }
    }
  }

  postTo(holder, m) {
    try {
      holder.post(m)
    } catch (e) {
      this.log.warn(`language servers: ${e.message}`)
    }
  }

  setState(slot, state, extra = {}) {
    slot.state = state
    slot.message = extra.message
    slot.install = extra.install
    this.postStatus(slot)
  }

  startSlot(slot) {
    if (this.disposed || slot.server) return
    if (!slot.entry || slot.entry.candidates.length === 0) return this.setState(slot, 'stopped')
    // Looked up again on every start: the person may have installed it since the bar said "missing".
    const found = servers.resolveServer(slot.entry, { env: this.env, cwd: this.root })
    if (found.missing) return this.setState(slot, 'missing', { install: found.install })
    if (typeof this.spawn !== 'function') return this.setState(slot, 'failed', { message: 'this app cannot run language servers (update cc-cockpit)' })
    const srv = new LspServer({
      spawn: this.spawn,
      argv: found.argv,
      root: this.root,
      language: slot.language,
      log: this.log,
      initializationOptions: slot.entry.initializationOptions,
      // The host's configuration only (design §3: app settings, never a page): the table has none
      // for the built-ins, so every section is null, the server's own defaults.
      configuration: (section) => {
        const s = slot.entry.settings
        if (!s || typeof s !== 'object') return null
        if (section === undefined) return s
        return section.split('.').reduce((o, k) => (o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined), s) ?? null
      },
      onNotification: (m) => this.notification(slot, srv, m),
      onApplyEdit: (edit) => this.serverApplyEdit(slot, srv, edit),
      onExit: (info) => this.exited(slot, srv, info),
    })
    slot.server = srv
    slot.opened = new Set()
    this.setState(slot, 'starting')
    try {
      srv.start()
    } catch (e) {
      slot.server = null
      const msg = String((e && e.message) || e)
      // "cannot run" is ctx.processes' word for a program that is not there (or not executable).
      if (msg.includes('cannot run')) return this.setState(slot, 'missing', { install: slot.entry.install })
      return this.setState(slot, 'failed', { message: msg })
    }
    srv.ready.then(
      () => {
        if (slot.server !== srv) return
        for (const doc of this.docsOf(slot.language)) this.didOpen(slot, doc)
        this.setState(slot, 'ready')
      },
      () => {
        // initialize failed: the server is killed and `exited` decides.
      },
    )
  }

  didOpen(slot, doc) {
    if (slot.opened.has(doc.uri)) return
    slot.opened.add(doc.uri)
    slot.server.notify('textDocument/didOpen', { textDocument: { uri: doc.uri, languageId: doc.languageId, version: doc.version, text: doc.text } })
  }

  /** Stops the slot's server on purpose (idle, settings, plugin stop): no restart. */
  stopSlot(slot, state) {
    if (slot.idleTimer) clearTimeout(slot.idleTimer)
    if (slot.restartTimer) clearTimeout(slot.restartTimer)
    slot.idleTimer = null
    slot.restartTimer = null
    const srv = slot.server
    slot.server = null
    slot.opened = new Set()
    if (!this.disposed) this.setState(slot, state)
    return srv ? srv.stop() : Promise.resolve()
  }

  exited(slot, srv, info) {
    if (slot.server !== srv) return // stopped on purpose (stopSlot cleared it) or replaced
    slot.server = null
    slot.opened = new Set()
    if (this.disposed) return
    const why = info.error ? info.error.message : info.signal ? `killed by ${info.signal}` : `exited with code ${info.code}`
    const tail = info.stderr ? info.stderr.split('\n').filter(Boolean).slice(-3).join(' | ') : ''
    const message = `the ${slot.entry.name} language server stopped (${why})${tail ? `: ${tail.slice(0, 400)}` : ''}`
    this.log.warn(message)
    if (this.docsOf(slot.language).length === 0) return this.setState(slot, 'stopped')
    const now = Date.now()
    slot.crashes = slot.crashes.filter((t) => now - t < this.timing.restartWindowMs)
    if (slot.crashes.length >= this.timing.restartLimit) {
      // Backoff spent: the page shows a bar with Restart (`restart`).
      return this.setState(slot, 'failed', { message })
    }
    const delay = this.timing.restartDelaysMs[Math.min(slot.crashes.length, this.timing.restartDelaysMs.length - 1)]
    slot.crashes.push(now)
    this.setState(slot, 'restarting', { message })
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = null
      if (this.docsOf(slot.language).length > 0) this.startSlot(slot)
      else this.setState(slot, 'stopped')
    }, delay)
    if (typeof slot.restartTimer.unref === 'function') slot.restartTimer.unref()
  }

  /**
   * The bar's Restart (or Retry after installing a missing server): only for a language a document
   * of `holder` uses, and only when its server is not running (a page cannot churn a live server).
   */
  restart(holder, language) {
    const slot = this.slots.get(language)
    if (!slot || !this.heldBy(holder).some((d) => d.language === language)) return false
    if (slot.server || slot.restartTimer) return false
    slot.crashes = []
    this.startSlot(slot)
    return true
  }

  notification(slot, srv, m) {
    if (slot.server !== srv) return
    if (m.method === 'textDocument/publishDiagnostics') {
      const p = m.params && typeof m.params === 'object' ? m.params : {}
      if (typeof p.uri !== 'string') return
      // Only for a document a page holds: a URI the server names is looked up, never resolved into a path.
      const doc = this.docByUri(p.uri)
      if (!doc || doc.language !== slot.language) return
      const fit = fitList(cleanDiagnostics(p.diagnostics), ANSWER_BUDGET)
      doc.diagnostics = fit.value
      for (const [h, rel] of doc.holders) {
        const msg = { t: 'lsp-diagnostics', path: rel, diagnostics: fit.value }
        if (Number.isInteger(p.version)) msg.version = p.version
        this.postTo(h, msg)
      }
    } else if (m.method === 'window/showMessage') {
      const p = m.params || {}
      if (p.type === 1 && typeof p.message === 'string') this.log.warn(`${slot.language} server: ${p.message.slice(0, 500)}`)
    }
    // logMessage, progress, telemetry: not shown in v1.
  }

  // ---- watched files ----

  /**
   * A file of the project may have changed (a folder watch's event, a file a Claude tab wrote):
   * gathered for WATCH_FLUSH_MS, then each is stat'ed and the running servers get one
   * `workspace/didChangeWatchedFiles` (Created, Changed or Deleted) for what really changed. Paths
   * outside the project, in `.git`, and the editor's own save temp files are left out.
   */
  noteChanged(real) {
    if (this.disposed || typeof real !== 'string' || !path.isAbsolute(real)) return
    const rel = path.relative(this.root, real)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return
    if (rel.split(path.sep).includes('.git')) return
    if (/\.cc-editor-[0-9a-f]+\.tmp$/.test(rel)) return
    if (this.pendingWatch.size >= MAX_WATCH_BATCH * 4) return
    this.pendingWatch.add(real)
    if (this.watchTimer) return
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null
      this.flushWatched()
    }, this.timing.watchFlushMs)
    if (typeof this.watchTimer.unref === 'function') this.watchTimer.unref()
  }

  flushWatched() {
    const list = [...this.pendingWatch]
    this.pendingWatch.clear()
    // Only servers that registered for it (their globs are not matched: a server filters what it gets).
    const running = [...this.slots.values()].filter((s) => s.server && s.state === 'ready' && s.server.watchesFiles())
    if (running.length === 0) return
    const changes = []
    for (const real of list) {
      let sig = null
      // A file this host never saw is Created only when it was born just now (birthtime, where the
      // file system keeps one); an older one that changed is Changed.
      let born = false
      try {
        const st = fs.statSync(real)
        if (!st.isFile()) continue
        sig = `${st.mtimeMs}:${st.size}`
        born = st.birthtimeMs > 0 && Date.now() - st.birthtimeMs < 10 * 1000
      } catch {
        sig = null
      }
      const before = this.known.get(real)
      if (sig === null) {
        if (before === null) continue
        this.remember(real, null)
        changes.push({ uri: pathToFileURL(real).href, type: DELETED })
        continue
      }
      if (before === sig) continue
      this.remember(real, sig)
      changes.push({ uri: pathToFileURL(real).href, type: before === null || (before === undefined && born) ? CREATED : CHANGED })
    }
    if (changes.length === 0) return
    // Several notifications when a big checkout changed more than one batch holds.
    for (let i = 0; i < changes.length; i += MAX_WATCH_BATCH) {
      const batch = changes.slice(i, i + MAX_WATCH_BATCH)
      for (const slot of running) slot.server.notify('workspace/didChangeWatchedFiles', { changes: batch })
    }
  }

  remember(real, sig) {
    this.known.delete(real)
    this.known.set(real, sig)
    if (this.known.size > MAX_KNOWN_FILES) this.known.delete(this.known.keys().next().value)
  }

  /**
   * A Claude tab's `files` (ctx.sessions: absolute paths it wrote): every one inside the project is
   * checked, so a file Claude edits that no tab shows still reaches gopls and tsserver.
   */
  noteSessionFiles(paths) {
    if (!Array.isArray(paths)) return
    for (const p of paths.slice(0, 5000)) {
      if (typeof p !== 'string' || !path.isAbsolute(p)) continue
      // A project opened through a symlinked folder: Claude's path may use either spelling.
      let real = p
      try {
        real = fs.realpathSync(p)
      } catch {
        try {
          real = path.join(fs.realpathSync(path.dirname(p)), path.basename(p))
        } catch {
          continue
        }
      }
      this.noteChanged(real)
    }
  }

  /** The URI of a server's location as a project path (`{ rel }`), or `{ outside: absPath }`, or null. */
  pathOfUri(uri) {
    if (typeof uri !== 'string' || !uri.startsWith('file:')) return null
    let abs
    try {
      abs = fileURLToPath(uri)
    } catch {
      return null
    }
    const rel = path.relative(this.root, abs)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return { rel: rel.split(path.sep).join('/') }
    return { outside: abs }
  }

  /** Whether any server is up (project changes are worth looking at only then). */
  running() {
    for (const s of this.slots.values()) if (s.server) return true
    return false
  }

  /** The plugin stops: every server is shut down. */
  dispose() {
    this.disposed = true
    if (this.watchTimer) clearTimeout(this.watchTimer)
    const stops = [...this.slots.values()].map((s) => this.stopSlot(s, 'stopped'))
    this.docs.clear()
    return Promise.all(stops)
  }
}

module.exports = {
  LspManager,
  ASKS,
  fitResult,
  applyChanges,
  cleanDiagnostics,
  MAX_DOC_CHARS,
  ANSWER_BUDGET,
}
