// A fake language server for the LSP host tests (test/lsp-host.test.js): speaks LSP's base protocol
// on stdio and logs every message it gets, one JSON line each, to the file after `--log`, so a test
// can assert what the host sent (initialize once, ids, didOpen/didClose counts, cancels).
//
// Flags:
//   --log <file>          where to log ({ in: message } or { answer: { id, result } } for its own requests)
//   --items <n>           completion answers n items (each with a long label: the trim test)
//   --slow-hover          never answers hover (the timeout and cancel tests)
//   --no-hover            declares no hoverProvider
//   --crash-on-open       exits with code 4 on the first didOpen
//   --banner              prints a non-LSP line on stdout first (a protocol error)
//   --starts <file>       appends "started" to it at start (counts the starts)
//   --outside <path>      definition also answers this file (outside the project) as a LocationLink
//   --rename-outside      rename also edits the --outside file
//   --rename-create       rename answers a documentChanges with a file create in it
//   --apply-unasked       after `initialized`, asks workspace/applyEdit on src/b.ts with no command running
//   --fail-init           answers `initialize` with an error (code -32603, "fake init failure")
//   --hang-init           never answers `initialize` (the host's initialize timeout)
//   --exit-before-init    exits with code 3 on `initialize`, before any answer
//   --stderr <text>       writes <text> and a newline to stderr at start (the crash message's tail)
//   --sync <json>         declares this textDocumentSync (`1`, `{"change":1}`...; `omit` leaves it out)
//   --apply-delay <ms>    fake.apply waits this long before it asks workspace/applyEdit (a command
//                         still running: the concurrency and cancel tests)
//   --action-with-command code actions also offer one with an edit to the file and a fake.apply command
// The language features (test/lsp-features.test.js) answer in the shapes typescript-language-server
// sends: rename as `documentChanges` with the open document's version (null for src/b.ts, not
// open), code actions with an edit, a declared command (`fake.apply`, which asks
// workspace/applyEdit while it runs, one insert in each file its arguments name, and answers the
// command once that is answered, even when the host cancelled it), an undeclared one and one to resolve.
// With no arguments it exits at once: `node --test plugins/*/test/` runs every .mjs under a test
// folder as a test file, this one included.
import fs from 'node:fs'

const args = process.argv.slice(2)
if (args.length === 0) process.exit(0)
const flag = (name) => args.includes(name)
const value = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const logFile = value('--log')
const log = (o) => {
  if (logFile) fs.appendFileSync(logFile, JSON.stringify(o) + '\n')
}
const startsFile = value('--starts')
if (startsFile) fs.appendFileSync(startsFile, 'started\n')
if (value('--stderr') !== undefined) process.stderr.write(`${value('--stderr')}\n`)

function send(m) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...m }), 'utf8')
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
}

if (flag('--banner')) process.stdout.write('Starting fake server v1.0\n\n\n')

let nextId = 1000
const mine = new Map() // id -> method of the requests this server sent
const waiting = new Map() // id of our applyEdit -> the executeCommand request to answer after it
const versions = new Map() // uri -> the version last opened or changed
let rootUri = ''
const range = (l1, c1, l2, c2) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } })
const bUri = () => `${rootUri}/src/b.ts`
const outsideUri = () => {
  const p = value('--outside')
  return p ? `file://${p.split('/').map(encodeURIComponent).join('/')}` : null
}
function ask(method, params) {
  const id = nextId++
  mine.set(id, method)
  send({ id, method, params })
  return id
}

function handle(m) {
  log({ in: m })
  if (m.method === undefined && m.id !== undefined) {
    // An answer to one of our own requests.
    log({ answer: { method: mine.get(m.id), result: m.result, error: m.error } })
    const cmd = waiting.get(m.id)
    if (cmd !== undefined) {
      waiting.delete(m.id)
      send({ id: cmd, result: null })
    }
    return
  }
  switch (m.method) {
    case 'textDocument/rename': {
      const uri = m.params.textDocument.uri
      const name = m.params.newName
      if (flag('--rename-create')) {
        return send({ id: m.id, result: { documentChanges: [{ kind: 'create', uri: `${rootUri}/src/new.ts` }, { textDocument: { uri, version: versions.get(uri) ?? null }, edits: [{ range: range(0, 6, 0, 7), newText: name }] }] } })
      }
      const documentChanges = [
        { textDocument: { uri, version: versions.get(uri) ?? null }, edits: [{ range: range(0, 6, 0, 7), newText: name }] },
        { textDocument: { uri: bUri(), version: null }, edits: [{ range: range(0, 6, 0, 7), newText: name }, { range: range(0, 10, 0, 11), newText: '3' }] },
      ]
      if (flag('--rename-outside') && outsideUri()) documentChanges.push({ textDocument: { uri: outsideUri(), version: null }, edits: [{ range: range(0, 0, 0, 0), newText: 'x' }] })
      return send({ id: m.id, result: { documentChanges } })
    }
    case 'textDocument/definition': {
      const out = [{ targetUri: bUri(), targetRange: range(0, 0, 0, 11), targetSelectionRange: range(0, 6, 0, 7) }]
      if (outsideUri()) out.push({ targetUri: outsideUri(), targetRange: range(2, 0, 2, 5), targetSelectionRange: range(2, 0, 2, 5) })
      return send({ id: m.id, result: out })
    }
    case 'textDocument/references':
      return send({ id: m.id, result: [{ uri: m.params.textDocument.uri, range: range(0, 6, 0, 7) }, { uri: bUri(), range: range(0, 6, 0, 7) }, { uri: 'untitled:Untitled-1', range: range(0, 0, 0, 1) }] })
    case 'textDocument/formatting':
      return send({ id: m.id, result: [{ range: range(0, 0, 0, 0), newText: '// formatted\n' }] })
    case 'textDocument/codeAction': {
      const uri = m.params.textDocument.uri
      return send({
        id: m.id,
        result: [
          { title: 'Insert header', kind: 'quickfix', isPreferred: true, edit: { changes: { [uri]: [{ range: range(0, 0, 0, 0), newText: '// header\n' }] } } },
          { title: 'Run fake.apply', kind: 'source', command: { title: 'apply', command: 'fake.apply', arguments: [bUri()] } },
          { title: 'Run undeclared', command: { title: 'x', command: 'fake.undeclared' } },
          { title: 'Resolve me', kind: 'refactor', data: { n: 1 } },
          ...(flag('--action-with-command')
            ? [{ title: 'Header then apply', edit: { changes: { [uri]: [{ range: range(0, 0, 0, 0), newText: '// header\n' }] } }, command: { title: 'apply', command: 'fake.apply', arguments: [bUri()] } }]
            : []),
        ],
      })
    }
    case 'codeAction/resolve':
      return send({ id: m.id, result: { ...m.params, edit: { changes: { [bUri()]: [{ range: range(0, 0, 0, 0), newText: '// resolved\n' }] } } } })
    case 'workspace/executeCommand': {
      if (m.params.command !== 'fake.apply') return send({ id: m.id, error: { code: -32601, message: 'no such command' } })
      const changes = {}
      for (const target of m.params.arguments.filter((x) => typeof x === 'string')) changes[target] = [{ range: range(0, 0, 0, 0), newText: '// applied\n' }]
      const go = () => waiting.set(ask('workspace/applyEdit', { label: 'apply', edit: { changes } }), m.id)
      const delay = Number(value('--apply-delay') || 0)
      if (delay > 0) setTimeout(go, delay)
      else go()
      return
    }
    case 'initialize': {
      if (flag('--hang-init')) return
      if (flag('--exit-before-init')) process.exit(3)
      if (flag('--fail-init')) return send({ id: m.id, error: { code: -32603, message: 'fake init failure' } })
      rootUri = m.params.rootUri
      const capabilities = {
        textDocumentSync: 2,
        completionProvider: { resolveProvider: true, triggerCharacters: ['.'] },
        signatureHelpProvider: { triggerCharacters: ['('] },
        definitionProvider: true,
        referencesProvider: true,
        documentSymbolProvider: true,
        documentFormattingProvider: true,
        renameProvider: { prepareProvider: true },
        codeActionProvider: { resolveProvider: true },
        executeCommandProvider: { commands: ['fake.apply', 'fake.other'] },
      }
      if (!flag('--no-hover')) capabilities.hoverProvider = true
      const sync = value('--sync')
      if (sync === 'omit') delete capabilities.textDocumentSync
      else if (sync !== undefined) capabilities.textDocumentSync = JSON.parse(sync)
      return send({ id: m.id, result: { capabilities, serverInfo: { name: 'fake' } } })
    }
    case 'initialized': {
      ask('workspace/configuration', { items: [{ section: 'fake' }, { section: 'fake.inner' }, {}] })
      ask('client/registerCapability', { registrations: [{ id: 'w1', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: '**/*' }] } }] })
      ask('workspace/notAThing', {})
      if (flag('--apply-unasked')) ask('workspace/applyEdit', { edit: { changes: { [bUri()]: [{ range: range(0, 0, 0, 0), newText: '// unasked\n' }] } } })
      return
    }
    case 'textDocument/didOpen':
      if (flag('--crash-on-open')) process.exit(4)
      versions.set(m.params.textDocument.uri, m.params.textDocument.version)
      return diagnose(m.params.textDocument.uri, m.params.textDocument.version, m.params.textDocument.text.length)
    case 'textDocument/didChange':
      versions.set(m.params.textDocument.uri, m.params.textDocument.version)
      return diagnose(m.params.textDocument.uri, m.params.textDocument.version, -1)
    case 'textDocument/didClose':
      versions.delete(m.params.textDocument.uri)
      return
    case 'textDocument/hover':
      if (flag('--slow-hover')) return
      return send({ id: m.id, result: { contents: { kind: 'markdown', value: `hover ${m.params.position.line}:${m.params.position.character}` } } })
    case 'textDocument/completion': {
      const n = Number(value('--items') || 3)
      const items = []
      for (let i = 0; i < n; i++) items.push({ label: `item${i}-${'x'.repeat(200)}`, kind: 6 })
      return send({ id: m.id, result: { isIncomplete: false, items } })
    }
    case 'textDocument/documentSymbol':
      return send({ id: m.id, result: [{ name: 'a', kind: 13, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] })
    case 'shutdown':
      return send({ id: m.id, result: null })
    case 'exit':
      process.exit(0)
      return
    default:
      if (m.id !== undefined) send({ id: m.id, result: null })
  }
}

function diagnose(uri, version, length) {
  if (flag('--reencode')) uri = uri.replace(/\+/g, '%2B').replace(/@/g, '%40')
  send({ method: 'textDocument/publishDiagnostics', params: { uri, version, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: `v${version} len${length}`, source: 'fake' }] } })
}

let buf = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const end = buf.indexOf('\r\n\r\n')
    if (end < 0) return
    const m = /Content-Length: (\d+)/i.exec(buf.subarray(0, end).toString())
    const len = Number(m[1])
    if (buf.length < end + 4 + len) return
    const body = buf.subarray(end + 4, end + 4 + len).toString('utf8')
    buf = buf.subarray(end + 4 + len)
    handle(JSON.parse(body))
  }
})
// LSP servers exit on EOF (a crashed client): so does this one.
process.stdin.on('end', () => process.exit(0))
