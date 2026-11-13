// The file tab page's side of the language servers (design-editor.md §3), with no DOM and no
// CodeMirror (file.js and lsp/editor.js draw it; node:test drives it with fakes). The page never
// speaks LSP to a server: it tells the host its text (`lsp-open`, then the owner's `lsp-change`s) and
// asks in editor terms (`lsp-ask`, lib/lsp/serve.js has the protocol); the host answers.
//
// Typing never waits for a server (design §5 "A language server timing out never blocks typing"):
// changes are fire-and-forget, every ask is a promise with its own deadline here (the host has its
// own too) and an AbortSignal, and a deadline or an abort tells the host (`lsp-cancel`), which
// cancels the request at the server. A new line to the host (a host restart, a reconnect) fails
// what was waiting: those answers never come.
//
// Edits the host applies through this page (a rename, a format, a code action: `lsp-edit`) are
// taken only when they fit the text: the host names the `seq` of the last change it got from this
// page, and a page that sent more since (it typed while the server worked) refuses.

import { chunkText } from '../parts.mjs'

/** The asks' deadlines here: a little longer than the host's, so the host's own answer comes first. */
export const ASK_TIMEOUT_MS = 12 * 1000
export const COMPLETE_TIMEOUT_MS = 6 * 1000
/** Rename and code actions: the host may wait 30 s on the server, then on the pages. */
export const EDIT_TIMEOUT_MS = 45 * 1000

const EDIT_ASKS = new Set(['rename', 'format', 'runCodeAction'])

/**
 * `ui`:
 *   post(message)           to the host (ccPanel.post)
 *   getText()               the buffer now
 *   applyEdits(edits)       apply the host's TextEdits to the buffer: true, or a string saying why not
 *   onStatus(status)        the server's state changed: { language, name, state, install?, message?, features? }
 *   onDiagnostics(list)     the server's diagnostics for this file (LSP's), replaced as a whole
 * `timers` { set(fn, ms) -> handle, clear(handle) } (tests pass fakes).
 */
export function createLspClient(ui, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) }) {
  const s = {
    path: null,
    connected: false,
    /** lsp-open sent on this line (the host holds the document for us). */
    opened: false,
    /** null: not known yet; the host's lsp-doc says (a language name, or null: no server). */
    language: undefined,
    owner: false,
    /** Every lsp-open and lsp-change this page sent, counted: an edit back from the host names one. */
    seq: 0,
    /**
     * The buffer changed since the last text sent while this page was not (yet) the owner: those
     * changes never reached the host. Typing between lsp-open and the host's lsp-doc is the case: the
     * host holds the opened text at this seq, so once ownership is confirmed the page sends all of it
     * again (a new seq) rather than incremental changes on top of a text the host never had.
     */
    unsent: false,
    status: null,
  }
  let nextReq = 0
  /** req -> { resolve, reject, timer, off } */
  const asks = new Map()

  function settle(req, err, value) {
    const a = asks.get(req)
    if (!a) return
    asks.delete(req)
    if (a.timer !== null) timers.clear(a.timer)
    if (a.off) a.off()
    if (err) a.reject(err)
    else a.resolve(value)
  }

  function failAll(why) {
    for (const req of [...asks.keys()]) settle(req, new Error(why))
  }

  /** The whole text to the host (a first open, a resync, a new line), in parts under the message cap. */
  function sendText() {
    const parts = chunkText(ui.getText())
    s.seq++
    parts.forEach((text, part) => ui.post({ t: 'lsp-open', path: s.path, part, parts: parts.length, text, seq: s.seq }))
    s.opened = true
    s.unsent = false
  }

  /** A path the host can give a server: project-relative (an outside file's tab has an absolute one). */
  const serverable = (p) => typeof p === 'string' && p !== '' && !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p)

  return {
    state: s,
    /** Whether asks can be made now: a server holds the document. */
    ready() {
      return s.opened && typeof s.language === 'string' && !!s.status && s.status.state === 'ready'
    },
    /** What the ready server offers (lib/lsp/manager.js featuresOf), {} before. */
    features() {
      return (s.status && s.status.state === 'ready' && s.status.features) || {}
    },
    /** A new line to the host: what waited is lost; the document is told again once loaded (`open`). */
    connect() {
      s.connected = true
      s.opened = false
      s.language = undefined
      s.owner = false
      failAll('the connection to the editor host was renewed')
    },
    /**
     * The file is shown (loaded, or loaded again on a new line): the host gets its text. Not for a
     * file with no text, nor one outside the project (no server is ever started for it).
     */
    open(path, hasText) {
      if (!s.connected || !hasText || !serverable(path)) return
      if (s.opened && s.path === path) return
      s.path = path
      // A new document (another path, or open again after a close): who syncs it is the host's
      // lsp-doc to say, never the previous document's answer.
      s.language = undefined
      s.owner = false
      sendText()
    },
    /** The page shows no text any more (binary now, a deleted file reloaded as nothing). */
    close() {
      if (!s.opened) return
      ui.post({ t: 'lsp-close', path: s.path })
      s.opened = false
      s.language = undefined
      s.owner = false
      ui.onDiagnostics([])
      failAll('the file is no longer open for its language server')
    },
    /** The buffer changed: `changes` are LSP content changes (convert.mjs contentChanges). Only the owner's reach the server. */
    changed(changes) {
      if (!s.opened || !Array.isArray(changes) || changes.length === 0) return
      if (!s.owner || !s.language) {
        // Not sent (not the owner, or the host has not said yet): the host's copy is now behind.
        s.unsent = true
        return
      }
      s.seq++
      ui.post({ t: 'lsp-change', path: s.path, changes, seq: s.seq })
    },
    /**
     * Asks the host (`what` one of the host's asks, `fields` its position, range...). Resolves the
     * host's answer `{ result, truncated?, unsupported?, unavailable? }`; rejects on an error, the
     * deadline, an abort (`opts.signal`) or a new line. Never waits for a server that is not there.
     */
    ask(what, fields = {}, opts = {}) {
      if (!s.opened || !s.language) return Promise.reject(new Error('no language server for this file'))
      if (opts.signal && opts.signal.aborted) return Promise.reject(new Error('cancelled'))
      const req = ++nextReq
      const timeoutMs = opts.timeoutMs || (what === 'complete' ? COMPLETE_TIMEOUT_MS : EDIT_ASKS.has(what) ? EDIT_TIMEOUT_MS : ASK_TIMEOUT_MS)
      return new Promise((resolve, reject) => {
        const a = { resolve, reject, timer: null, off: null }
        asks.set(req, a)
        a.timer = timers.set(() => {
          a.timer = null
          ui.post({ t: 'lsp-cancel', req })
          settle(req, new Error('the language server did not answer in time'))
        }, timeoutMs)
        if (opts.signal) {
          const onAbort = () => {
            ui.post({ t: 'lsp-cancel', req })
            settle(req, new Error('cancelled'))
          }
          opts.signal.addEventListener('abort', onAbort)
          a.off = () => opts.signal.removeEventListener('abort', onAbort)
        }
        ui.post({ ...fields, t: 'lsp-ask', req, what, path: s.path })
      })
    },
    /** A message from the host: true when it was a language server one (taken here). */
    receive(m) {
      if (!m || typeof m !== 'object' || typeof m.t !== 'string' || !m.t.startsWith('lsp-')) return false
      switch (m.t) {
        case 'lsp-doc':
          if (m.path !== s.path) return true
          s.language = typeof m.language === 'string' ? m.language : null
          s.owner = m.owner === true
          if (!s.language) {
            // No server for this file (or it is too large): highlighting only, nothing held.
            s.opened = false
            failAll('no language server for this file')
          }
          // The owner now, with typing the host never got (before this answer came): all of the text
          // again, so the host never holds a text that differs from the buffer while it takes changes
          // and sends edits that name a seq this page still has.
          if (s.language && s.owner && s.unsent) sendText()
          if (typeof m.state === 'string') {
            s.status = { ...(s.status && s.status.language === s.language ? s.status : {}), language: s.language, name: m.name, state: m.state }
            ui.onStatus(s.status)
          } else if (!s.language) {
            s.status = null
            ui.onStatus(null)
          }
          return true
        case 'lsp-status':
          // A late `lsp-status` for another language (a file renamed meanwhile) is not ours.
          if (s.language && m.language !== s.language) return true
          s.status = { language: m.language, name: m.name, state: m.state, install: m.install, message: m.message, features: m.features }
          ui.onStatus(s.status)
          return true
        case 'lsp-diagnostics':
          if (m.path === s.path) ui.onDiagnostics(Array.isArray(m.diagnostics) ? m.diagnostics : [])
          return true
        case 'lsp-resync':
          // The host's text and ours differ, or we became the syncing owner: all of it again.
          if (m.path !== s.path || !s.opened) return true
          if (m.owner === true) s.owner = true
          sendText()
          return true
        case 'lsp-answer':
          if (typeof m.error === 'string') settle(m.req, new Error(m.error))
          else settle(m.req, null, m)
          return true
        case 'lsp-edit': {
          let r
          if (m.path !== s.path || !s.opened) r = 'the file is not open here'
          else if (!s.owner) r = 'this view does not sync the file'
          else if (m.seq !== s.seq) r = 'the file changed while the language server worked; try again'
          else {
            try {
              r = ui.applyEdits(m.edits)
            } catch (e) {
              r = String((e && e.message) || e)
            }
          }
          ui.post(r === true ? { t: 'lsp-edit-done', id: m.id, applied: true } : { t: 'lsp-edit-done', id: m.id, applied: false, reason: typeof r === 'string' ? r : 'not applied' })
          return true
        }
        case 'lsp-error': {
          if (m.path !== undefined && m.path !== s.path) return true
          const message = typeof m.message === 'string' ? m.message.slice(0, 300) : 'error'
          if (s.language === undefined && s.opened) {
            // The open itself was refused (too many documents, a path the host would not take): no
            // server for this view; asks are refused here rather than left to time out.
            s.opened = false
            s.status = { language: null, name: undefined, state: 'failed', message }
          } else {
            // A refused change or ask: the server goes on; the message is shown with its state.
            s.status = { ...(s.status || { language: s.language, state: 'failed' }), message }
          }
          ui.onStatus(s.status)
          return true
        }
        default:
          return true // a newer host's message
      }
    },
    /** The bar's Restart (or Retry once installed). */
    restart() {
      if (s.status && s.status.language) ui.post({ t: 'lsp-restart', language: s.status.language })
    },
  }
}
