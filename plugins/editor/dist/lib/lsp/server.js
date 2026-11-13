'use strict'
// One running language server and the host's side of its JSON-RPC (design-editor.md §3 "The host is
// the only LSP client"). The host owns everything a page must never decide: `initialize` (the
// capabilities it declares, `processId`, the root, `initializationOptions`), the configuration, the
// request ids (one id space per server: every request comes from here, so two pages' asks can
// never collide or answer each other), and the answers to the server's own requests
// (`workspace/configuration`, `client/registerCapability`, progress, `workspace/applyEdit`).
//
// The process runs through ctx.processes.spawn (bytes, argv only, killed with its group when the
// plugin stops). It is rooted at the project folder (cwd and rootUri). A server that exits, breaks
// the framing or does not answer `initialize` in time is gone: `onExit` tells the manager, which
// decides about a restart (lib/lsp/manager.js).

const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { encode, Decoder } = require('./framing.js')
const { messageOf } = require('../files.js')

/** `initialize` may take a while (gopls loads the module graph), but not forever. */
const INITIALIZE_TIMEOUT_MS = 60 * 1000
/** A request with no deadline of its own. */
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 1000
/** `shutdown` gets this long before `exit` and the kill. */
const SHUTDOWN_TIMEOUT_MS = 2000
/** After `exit`, a server that is still there this long later is killed. */
const EXIT_GRACE_MS = 2000
/** The last this-many characters of stderr are kept for the "crashed" bar and the log. */
const STDERR_TAIL_CHARS = 2000
/** Requests waiting at once per server: a page cannot pile up thousands of asks. */
const MAX_PENDING = 64

// JSON-RPC and LSP error codes the host answers with.
const METHOD_NOT_FOUND = -32601
const REQUEST_CANCELLED = -32800

/**
 * What the host tells the server it can do. Deliberately what the page's features use, and no more:
 * no `workspace.workspaceEdit.resourceOperations` (design §3: rename and code actions never create,
 * rename or delete files), `applyEdit` true (the host applies an edit itself, lib/lsp/edits.js, and
 * only while a command it ran is working), `executeCommand` (the host runs a code action's own
 * command, never one a page names), no semantic tokens, inlay hints or code lens (not in v1).
 * Snippets in completion are on (the page expands them); a code action's edit may be left out and
 * resolved when it is picked.
 */
const CLIENT_CAPABILITIES = Object.freeze({
  general: { positionEncodings: ['utf-16'] },
  workspace: {
    applyEdit: true,
    workspaceEdit: { documentChanges: true, resourceOperations: [], failureHandling: 'abort' },
    didChangeConfiguration: { dynamicRegistration: false },
    // Dynamic: servers register the globs they care about (gopls only listens when it may register).
    didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: false },
    configuration: true,
    workspaceFolders: true,
    executeCommand: { dynamicRegistration: false },
  },
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false, willSave: false, willSaveWaitUntil: false },
    publishDiagnostics: { relatedInformation: false, versionSupport: true, tagSupport: { valueSet: [1, 2] } },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    completion: {
      completionItem: {
        snippetSupport: true,
        documentationFormat: ['markdown', 'plaintext'],
        deprecatedSupport: true,
        insertReplaceSupport: false,
        resolveSupport: { properties: ['documentation', 'detail'] },
      },
      contextSupport: true,
    },
    signatureHelp: {
      signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true } },
      contextSupport: false,
    },
    definition: { linkSupport: false },
    references: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    formatting: {},
    rename: { prepareSupport: true },
    codeAction: {
      codeActionLiteralSupport: {
        codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports'] },
      },
      isPreferredSupport: true,
      disabledSupport: true,
      dataSupport: true,
      resolveSupport: { properties: ['edit'] },
    },
  },
  window: { workDoneProgress: true, showMessage: {}, showDocument: { support: false } },
})

class LspServer {
  /**
   * @param {object} o
   * @param {(argv: string[], opts: { cwd: string }) => object} o.spawn ctx.processes.spawn
   * @param {string[]} o.argv the resolved argv (servers.js resolveServer)
   * @param {string} o.root the project's realpath: cwd, rootUri and the one workspace folder
   * @param {string} o.language the table's key, for the log
   * @param {object} [o.initializationOptions] the host's, from the table
   * @param {(section: string|undefined) => unknown} [o.configuration] `workspace/configuration` answers
   * @param {(msg: object) => void} [o.onNotification] the server's notifications (diagnostics...)
   * @param {(edit: object) => Promise<object>|object} [o.onApplyEdit] answers `workspace/applyEdit`
   * @param {(info: { code, signal, error?, stderr, requested }) => void} [o.onExit]
   * @param {number} [o.processId] whose death the server watches (the plugin host's pid)
   * @param {number} [o.initializeTimeoutMs] tests shorten INITIALIZE_TIMEOUT_MS (a hung server's test)
   */
  constructor(o) {
    this.o = o
    this.language = o.language
    this.root = o.root
    this.rootUri = pathToFileURL(o.root).href
    this.child = null
    this.nextId = 1
    /** id -> { resolve, reject, timer, method, onDone } */
    this.pending = new Map()
    /**
     * id -> onDone of a request the host gave up on (its cancel, its deadline) while the server may
     * still be working on it: the server answers every request, a cancelled one too (LSP), and that
     * late answer, or the server's exit, is when it is done. Only requests that asked (`opts.onDone`:
     * a command, at most one per server at a time, manager.js) are kept.
     */
    this.abandoned = new Map()
    this.capabilities = null
    this.ready = null
    this.exited = false
    this.stopping = false
    this.stderr = ''
    this.error = null
    /** What the server registered dynamically: id -> method (`workspace/didChangeWatchedFiles`...). */
    this.registrations = new Map()
    this.log = o.log || { info() {}, warn() {} }
  }

  /** Spawns and initializes; resolves the server's capabilities. Throws (sync) when it cannot be spawned. */
  start() {
    const child = this.o.spawn(this.o.argv, { cwd: this.root })
    this.child = child
    const decoder = new Decoder(
      (m) => this.receive(m),
      (err) => {
        // A broken stream cannot be resynced: the server is stopped and counts as a crash.
        this.error = err
        this.log.warn(`${this.language} server: ${err.message}`)
        this.kill()
      },
    )
    child.onData((bytes) => decoder.push(bytes))
    child.onStderr((bytes) => {
      this.stderr = (this.stderr + Buffer.from(bytes).toString('utf8')).slice(-STDERR_TAIL_CHARS)
    })
    child.onExit(({ code, signal }) => this.exit(code, signal))
    this.ready = this.request(
      'initialize',
      {
        processId: this.o.processId === undefined ? process.pid : this.o.processId,
        clientInfo: { name: 'cc-cockpit editor' },
        rootUri: this.rootUri,
        rootPath: this.root,
        workspaceFolders: [{ uri: this.rootUri, name: path.basename(this.root) }],
        capabilities: CLIENT_CAPABILITIES,
        initializationOptions: this.o.initializationOptions || {},
        trace: 'off',
      },
      { timeoutMs: this.o.initializeTimeoutMs || INITIALIZE_TIMEOUT_MS },
    ).then((result) => {
      this.capabilities = (result && typeof result === 'object' && result.capabilities) || {}
      this.notify('initialized', {})
      return this.capabilities
    })
    // A failed initialize leaves a server that cannot be used: stop it (the exit tells the manager).
    this.ready.catch((e) => {
      if (this.exited) return
      this.error = this.error || e
      this.log.warn(`${this.language} server: initialize failed: ${e.message}`)
      this.kill()
    })
    return this.ready
  }

  write(message) {
    if (!this.child || this.exited) return false
    try {
      this.child.write(encode(message))
      return true
    } catch (e) {
      // Over ctx.processes' unread-stdin cap: the server stopped reading.
      this.error = e
      this.kill()
      return false
    }
  }

  notify(method, params) {
    this.write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  /**
   * Sends a request with the host's own id; resolves its result, rejects its error (an Error with
   * `code`), on timeout (after `$/cancelRequest`) and when the server exits. `opts.signal` is an
   * AbortSignal-like { aborted, addEventListener } whose abort cancels it. `opts.onDone` is called
   * once the server is done with the request, which after a cancel or a timeout is later than the
   * promise: when its own answer still comes, or when it exits (never sent: at once).
   */
  request(method, params, opts = {}) {
    const onDone = typeof opts.onDone === 'function' ? opts.onDone : null
    const never = (e) => {
      if (onDone) onDone()
      return Promise.reject(e)
    }
    if (this.exited) return never(Object.assign(new Error(`the ${this.language} server is not running`), { code: 'exited' }))
    if (this.pending.size >= MAX_PENDING) return never(new Error(`the ${this.language} server has too many requests waiting`))
    if (opts.signal && opts.signal.aborted) return never(Object.assign(new Error('cancelled'), { code: REQUEST_CANCELLED }))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeoutMs = opts.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS
      const p = { method, resolve, reject, timer: null, onDone }
      p.timer = setTimeout(() => this.cancel(id, `the ${this.language} server did not answer ${method} in ${Math.round(timeoutMs / 1000)} s`), timeoutMs)
      if (typeof p.timer.unref === 'function') p.timer.unref()
      this.pending.set(id, p)
      if (!this.write({ jsonrpc: '2.0', id, method, params })) return this.settle(id, new Error(`the ${this.language} server is not running`))
      if (opts.signal) opts.signal.addEventListener('abort', () => this.cancel(id, 'cancelled'), { once: true })
    })
  }

  /** Gives up on request `id`: tells the server (it may stop working on it) and rejects the caller. */
  cancel(id, why) {
    const p = this.pending.get(id)
    if (!p) return
    // Still working, perhaps (a cancel is only a hint to a server): done when its answer comes.
    const kept = !this.exited && p.onDone !== null
    if (kept) this.abandoned.set(id, p.onDone)
    if (!this.exited) this.notify('$/cancelRequest', { id })
    this.settle(id, Object.assign(new Error(why), { code: REQUEST_CANCELLED }), undefined, kept)
  }

  /** Settles request `id` for its caller; `kept`: its onDone waits in `abandoned` instead. */
  settle(id, err, result, kept = false) {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    if (p.onDone && !kept) p.onDone()
    if (err) p.reject(err)
    else p.resolve(result)
  }

  receive(m) {
    const hasId = typeof m.id === 'number' || typeof m.id === 'string'
    if (typeof m.method === 'string') {
      if (hasId) return this.answerServerRequest(m)
      if (this.o.onNotification) {
        try {
          this.o.onNotification(m)
        } catch (e) {
          this.log.warn(`${this.language} server: ${m.method}: ${e.message}`)
        }
      }
      return
    }
    // A response: only to an id this host sent (a stray or repeated id is ignored); the late answer
    // to one it gave up on says the server is done with it.
    if (hasId && this.abandoned.has(m.id)) {
      const done = this.abandoned.get(m.id)
      this.abandoned.delete(m.id)
      return done()
    }
    if (!hasId || !this.pending.has(m.id)) return
    if (m.error && typeof m.error === 'object') {
      const msg = typeof m.error.message === 'string' ? m.error.message.slice(0, 500) : 'error'
      return this.settle(m.id, Object.assign(new Error(msg), { code: m.error.code }))
    }
    this.settle(m.id, null, m.result === undefined ? null : m.result)
  }

  /** The server asks the client: the host answers, never a page (design §3). */
  answerServerRequest(m) {
    const reply = (result) => this.write({ jsonrpc: '2.0', id: m.id, result })
    const replyError = (code, message) => this.write({ jsonrpc: '2.0', id: m.id, error: { code, message } })
    const params = m.params && typeof m.params === 'object' ? m.params : {}
    switch (m.method) {
      case 'workspace/configuration': {
        const items = Array.isArray(params.items) ? params.items : []
        const conf = this.o.configuration || (() => null)
        return reply(items.map((it) => {
          const v = conf(it && typeof it.section === 'string' ? it.section : undefined)
          return v === undefined ? null : v
        }))
      }
      case 'workspace/workspaceFolders':
        return reply([{ uri: this.rootUri, name: path.basename(this.root) }])
      case 'client/registerCapability': {
        const regs = Array.isArray(params.registrations) ? params.registrations : []
        for (const r of regs.slice(0, 100)) if (r && typeof r.id === 'string' && typeof r.method === 'string') this.registrations.set(r.id, r.method)
        return reply(null)
      }
      case 'client/unregisterCapability': {
        // The spec's own misspelling: `unregisterations`.
        const regs = Array.isArray(params.unregisterations) ? params.unregisterations : Array.isArray(params.unregistrations) ? params.unregistrations : []
        for (const r of regs) if (r && typeof r.id === 'string') this.registrations.delete(r.id)
        return reply(null)
      }
      case 'window/workDoneProgress/create':
      case 'workspace/semanticTokens/refresh':
      case 'workspace/inlayHint/refresh':
      case 'workspace/codeLens/refresh':
      case 'workspace/diagnostic/refresh':
      case 'workspace/inlineValue/refresh':
        return reply(null)
      case 'window/showMessageRequest':
        // No buttons are offered for a server's question: nothing chosen.
        return reply(null)
      case 'window/showDocument':
        return reply({ success: false })
      case 'workspace/applyEdit': {
        if (!this.o.onApplyEdit) return reply({ applied: false, failureReason: 'this editor does not apply edits from the server yet' })
        // Called now, not on a later tick: messages are handled in the order the server sent them,
        // and the response to the command this edit belongs to may sit in the same stdout chunk
        // right behind it; deferred, that response would settle the command first and the edit be
        // refused while the command reported success. A throw is still an answer, not a crash.
        let done
        try {
          done = Promise.resolve(this.o.onApplyEdit(params.edit, params.label))
        } catch (e) {
          done = Promise.reject(e)
        }
        done.then(
          (r) => reply(r && typeof r === 'object' ? r : { applied: false }),
          (e) => reply({ applied: false, failureReason: messageOf(e).slice(0, 500) }),
        )
        return undefined
      }
      default:
        return replyError(METHOD_NOT_FOUND, `${m.method} is not supported by this client`)
    }
  }

  /** Whether the server registered for `workspace/didChangeWatchedFiles`. */
  watchesFiles() {
    for (const method of this.registrations.values()) if (method === 'workspace/didChangeWatchedFiles') return true
    return false
  }

  exit(code, signal) {
    if (this.exited) return
    this.exited = true
    for (const id of [...this.pending.keys()]) {
      this.settle(id, Object.assign(new Error(`the ${this.language} server stopped`), { code: 'exited' }))
    }
    const abandoned = [...this.abandoned.values()]
    this.abandoned.clear()
    for (const done of abandoned) done()
    if (this.exitTimer) clearTimeout(this.exitTimer)
    if (this.o.onExit) this.o.onExit({ code, signal, error: this.error, stderr: this.stderr.trim(), requested: this.stopping })
  }

  kill() {
    if (!this.child || this.exited) return
    try {
      this.child.kill()
    } catch {
      // Already gone.
    }
  }

  /** `shutdown`, `exit`, then the kill when it lingers. Resolves once it has exited. */
  stop() {
    this.stopping = true
    if (!this.child || this.exited) return Promise.resolve()
    const gone = new Promise((resolve) => {
      const prev = this.o.onExit
      this.o.onExit = (info) => {
        if (prev) prev(info)
        resolve()
      }
    })
    this.request('shutdown', undefined, { timeoutMs: SHUTDOWN_TIMEOUT_MS })
      .catch(() => {})
      .then(() => {
        this.notify('exit')
        try {
          if (this.child && typeof this.child.end === 'function') this.child.end()
        } catch {
          // gone
        }
        this.exitTimer = setTimeout(() => this.kill(), EXIT_GRACE_MS)
        if (typeof this.exitTimer.unref === 'function') this.exitTimer.unref()
      })
    return gone
  }
}

module.exports = { LspServer, CLIENT_CAPABILITIES }
