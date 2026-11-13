'use strict'
// The file tab page's side of the language servers (design-editor.md §3): one page line (a file
// tab's page in one view) speaks editor terms to the host, never LSP to a server. Beside
// lib/files.js's and lib/search.js's messages on the same line:
//
//   page -> host
//   { t: 'lsp-open', path, part, parts, text, seq? }
//                                                 the document's whole text (in parts under the 1 MiB
//                                                 message cap): its first open, or a resync
//   { t: 'lsp-change', path, changes, seq? }      LSP content changes ({ range?, text }), the owner's;
//                                                 `seq` counts the page's opens and changes, so an
//                                                 edit the host sends back names the text it fits
//   { t: 'lsp-close', path }                      the page no longer shows it
//   { t: 'lsp-ask', req, what, path, ... }        `what` one of manager.js's ASKS (hover, complete,
//                                                 resolveCompletion, signature, definition, references,
//                                                 symbols, format, prepareRename, rename, codeActions)
//                                                 or runCodeAction ({ id } of a codeActions answer),
//                                                 with its fields (position, range, newName, ...)
//   { t: 'lsp-edit-done', id, applied, reason? }  the page applied (or refused) an `lsp-edit`
//   { t: 'lsp-cancel', req }                      the page no longer wants that answer
//   { t: 'lsp-restart', language }                the bar's Restart (or Retry once installed)
//
//   host -> page
//   { t: 'lsp-doc', path, language, name?, owner, state? }   language null: no server for this file
//   { t: 'lsp-status', language, name, state, install?, message? }
//                                                 state: starting, ready, missing (install: the
//                                                 command), restarting, failed (Restart), stopped
//   { t: 'lsp-diagnostics', path, version?, diagnostics }
//   { t: 'lsp-resync', path, owner?, why? }       send `lsp-open` with the whole text again
//   { t: 'lsp-answer', req, result, truncated?, unsupported?, unavailable? } | { t: 'lsp-answer', req, error }
//                                                 format, rename, runCodeAction: result is what the
//                                                 host applied { applied, files, edits, failureReason? };
//                                                 definition, references: [{ path, range, text? } |
//                                                 { outside, range }]; codeActions: [{ id, title, ... }]
//   { t: 'lsp-edit', id, path, seq, edits }       apply these TextEdits (a rename, a format, a code
//                                                 action) to the buffer, only when the page's last
//                                                 sent `seq` is this one; answer `lsp-edit-done`
//   { t: 'lsp-error', path?, message }

const files = require('../files.js')
const { MAX_DOC_CHARS, ANSWER_BUDGET } = require('./manager.js')

/** Whole texts assembling at once per line, and how long one waits for its next part. */
const MAX_PENDING_OPENS = 4
const OPEN_PART_TIMEOUT_MS = 10 * 1000
/** Asks waiting at once per line (each server has its own cap too). */
const MAX_LINE_ASKS = 32

/**
 * Serves `tab` (a PageTabInstance) against `manager` (an LspManager, or null on an app without
 * ctx.processes). Returns `handle(m)`: true when the message was an `lsp-*` one.
 */
function serveLsp(tab, manager, log) {
  let closed = false
  const holder = {
    tabId: tab.id,
    view: tab.view,
    post: (m) => {
      if (!closed) tab.post(m)
    },
  }
  const opens = new Map() // path -> { parts, got, length, timer, seq }
  const asks = new Map() // req -> AbortController
  const edits = new Map() // id -> { resolve, timer }: lsp-edit messages waiting for the page
  let nextEdit = 0

  /**
   * Hands `list` (checked TextEdits for `rel`, lib/lsp/edits.js) to this page to apply to its buffer.
   * Resolves `{ applied, reason? }`: the page's answer, or a refusal when it is gone, too slow or the
   * edits do not fit in one message.
   */
  holder.applyEdits = (rel, list, seq, timeoutMs) =>
    new Promise((resolve) => {
      if (closed) return resolve({ applied: false, reason: 'the page is gone' })
      const m = { t: 'lsp-edit', id: ++nextEdit, path: rel, seq: seq === undefined ? null : seq, edits: list }
      if (JSON.stringify(m).length > ANSWER_BUDGET) return resolve({ applied: false, reason: 'the edit is too large to send to the page' })
      const timer = setTimeout(() => {
        edits.delete(m.id)
        resolve({ applied: false, reason: 'the page did not apply the edit in time' })
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      edits.set(m.id, { resolve, timer })
      holder.post(m)
    })

  const fail = (p, e) => holder.post({ t: 'lsp-error', ...(typeof p === 'string' ? { path: p } : {}), message: String((e && e.message) || e) })

  function dropOpen(p) {
    const o = opens.get(p)
    if (o && o.timer) clearTimeout(o.timer)
    opens.delete(p)
  }

  function open(m) {
    let rel
    try {
      rel = files.relativePath(m.path)
    } catch (e) {
      return fail(undefined, e)
    }
    let o = opens.get(rel)
    if (!o) {
      if (m.part !== 0) return fail(rel, new Error('lsp-open parts out of order'))
      if (opens.size >= MAX_PENDING_OPENS) return fail(rel, new Error('too many documents opening at once'))
      const parts = Number.isInteger(m.parts) && m.parts >= 1 ? m.parts : 1
      if (parts > Math.ceil(MAX_DOC_CHARS / 1024) + 1) return fail(rel, new Error('too many parts'))
      o = { parts, got: [], length: 0, timer: null, seq: m.seq }
      opens.set(rel, o)
    } else if (m.part !== o.got.length) {
      dropOpen(rel)
      return fail(rel, new Error('lsp-open parts out of order'))
    }
    if (typeof m.text !== 'string') {
      dropOpen(rel)
      return fail(rel, new Error('text must be a string'))
    }
    o.got.push(m.text)
    o.length += m.text.length
    if (o.timer) clearTimeout(o.timer)
    o.timer = null
    if (o.length > MAX_DOC_CHARS) {
      // Too large for a server: highlighting only, said as "no server" (not an error bar).
      dropOpen(rel)
      // A resync of a document that grew past the cap: the server's copy goes.
      try {
        manager.close(holder, rel)
      } catch {}
      return holder.post({ t: 'lsp-doc', path: rel, language: null, why: 'the file is too large for a language server' })
    }
    if (o.got.length < o.parts) {
      o.timer = setTimeout(() => {
        if (opens.get(rel) === o) opens.delete(rel)
      }, OPEN_PART_TIMEOUT_MS)
      if (typeof o.timer.unref === 'function') o.timer.unref()
      return
    }
    opens.delete(rel)
    let r
    try {
      r = manager.open(holder, rel, o.got.join(''), o.seq)
    } catch (e) {
      return fail(rel, e)
    }
    holder.post({ t: 'lsp-doc', path: rel, ...r })
  }

  function ask(m) {
    const req = m.req
    if (typeof req !== 'string' && typeof req !== 'number') return fail(m.path, new Error('an ask needs a req'))
    const answer = (body) => holder.post({ t: 'lsp-answer', req, ...body })
    if (asks.has(req)) return answer({ error: 'an ask with this req is already waiting' })
    if (asks.size >= MAX_LINE_ASKS) return answer({ error: 'too many asks are waiting' })
    const ctl = new AbortController()
    asks.set(req, ctl)
    let p
    try {
      p = manager.ask(holder, m.what, m.path, m, ctl.signal)
    } catch (e) {
      p = Promise.reject(e)
    }
    Promise.resolve(p).then(
      (r) => {
        if (asks.get(req) !== ctl) return
        asks.delete(req)
        answer(r)
      },
      (e) => {
        if (asks.get(req) !== ctl) return
        asks.delete(req)
        answer({ error: String((e && e.message) || e).slice(0, 1000) })
      },
    )
  }

  tab.onClose(() => {
    closed = true
    for (const o of opens.values()) if (o.timer) clearTimeout(o.timer)
    opens.clear()
    for (const ctl of asks.values()) ctl.abort()
    asks.clear()
    for (const e of edits.values()) {
      clearTimeout(e.timer)
      e.resolve({ applied: false, reason: 'the page is gone' })
    }
    edits.clear()
    if (manager) manager.closeHolder(holder)
  })

  return function handle(m) {
    if (!m || typeof m !== 'object' || typeof m.t !== 'string' || !m.t.startsWith('lsp-')) return false
    if (closed) return true
    if (!manager) {
      // An app with no ctx.processes: no servers, highlighting only.
      if (m.t === 'lsp-open' && typeof m.path === 'string') holder.post({ t: 'lsp-doc', path: m.path, language: null, why: 'this app cannot run language servers' })
      else if (m.t === 'lsp-ask' && (typeof m.req === 'string' || typeof m.req === 'number')) holder.post({ t: 'lsp-answer', req: m.req, result: null, unavailable: 'stopped' })
      return true
    }
    try {
      switch (m.t) {
        case 'lsp-open':
          open(m)
          break
        case 'lsp-change':
          manager.change(holder, m.path, m.changes, m.seq)
          break
        case 'lsp-close':
          try {
            dropOpen(files.relativePath(m.path))
          } catch {
            // not a path: nothing of it is pending
          }
          manager.close(holder, m.path)
          break
        case 'lsp-ask':
          ask(m)
          break
        case 'lsp-cancel': {
          const ctl = asks.get(m.req)
          if (ctl) {
            asks.delete(m.req)
            ctl.abort()
          }
          break
        }
        case 'lsp-edit-done': {
          const e = edits.get(m.id)
          if (e) {
            edits.delete(m.id)
            clearTimeout(e.timer)
            e.resolve({ applied: m.applied === true, ...(typeof m.reason === 'string' ? { reason: m.reason.slice(0, 300) } : {}) })
          }
          break
        }
        case 'lsp-restart':
          if (typeof m.language === 'string') manager.restart(holder, m.language)
          break
        default:
          break // a newer page's message: ignored
      }
    } catch (e) {
      if (log) log.warn(`file tab ${tab.id}: ${m.t}: ${e.message}`)
      fail(typeof m.path === 'string' ? m.path : undefined, e)
    }
    return true
  }
}

module.exports = { serveLsp }
