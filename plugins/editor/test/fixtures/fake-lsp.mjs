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

function send(m) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...m }), 'utf8')
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
}

if (flag('--banner')) process.stdout.write('Starting fake server v1.0\n\n\n')

let nextId = 1000
const mine = new Map() // id -> method of the requests this server sent

function handle(m) {
  log({ in: m })
  if (m.method === undefined && m.id !== undefined) {
    // An answer to one of our own requests.
    log({ answer: { method: mine.get(m.id), result: m.result, error: m.error } })
    return
  }
  switch (m.method) {
    case 'initialize': {
      const capabilities = {
        textDocumentSync: 2,
        completionProvider: { resolveProvider: true, triggerCharacters: ['.'] },
        signatureHelpProvider: { triggerCharacters: ['('] },
        definitionProvider: true,
        referencesProvider: true,
        documentSymbolProvider: true,
        documentFormattingProvider: true,
        renameProvider: { prepareProvider: true },
        codeActionProvider: true,
      }
      if (!flag('--no-hover')) capabilities.hoverProvider = true
      return send({ id: m.id, result: { capabilities, serverInfo: { name: 'fake' } } })
    }
    case 'initialized': {
      const ask = (method, params) => {
        const id = nextId++
        mine.set(id, method)
        send({ id, method, params })
      }
      ask('workspace/configuration', { items: [{ section: 'fake' }, { section: 'fake.inner' }, {}] })
      ask('client/registerCapability', { registrations: [{ id: 'w1', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: '**/*' }] } }] })
      ask('workspace/notAThing', {})
      return
    }
    case 'textDocument/didOpen':
      if (flag('--crash-on-open')) process.exit(4)
      return diagnose(m.params.textDocument.uri, m.params.textDocument.version, m.params.textDocument.text.length)
    case 'textDocument/didChange':
      return diagnose(m.params.textDocument.uri, m.params.textDocument.version, -1)
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
