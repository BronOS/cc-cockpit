'use strict'
// The editor host's LSP client (dist/lib/lsp): framing, the server table and PATH lookup, and the
// manager against a fake server (test/fixtures/fake-lsp.mjs, run with node through a spawn of
// ctx.processes' shape): initialize once, the host's own ids, documents refcounted per URI with one
// syncing owner, URIs checked against the project, the ask allow-list, the server's own requests
// answered by the host, the restart backoff, the idle stop, a missing server, watched files.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { encode, Decoder } = require('../dist/lib/lsp/framing.js')
const servers = require('../dist/lib/lsp/servers.js')
const { LspManager, fitResult, applyChanges, ANSWER_BUDGET } = require('../dist/lib/lsp/manager.js')
const { serveLsp } = require('../dist/lib/lsp/serve.js')
const { FolderWatcher } = require('../dist/lib/files.js')

const FAKE = path.join(__dirname, 'fixtures', 'fake-lsp.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Waits until `fn()` is truthy (polling), or fails after `ms`. */
async function until(fn, ms = 5000, what = 'condition') {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

/**
 * ctx.processes.spawn's shape over node's spawn (argv only); `spawned` records every argv, `sent`
 * every message the host wrote (decoded here: what a server killed right after a write never logs).
 */
function nodeSpawn() {
  const spawned = []
  const children = []
  const sent = []
  const spawn = (argv, { cwd }) => {
    const c = cp.spawn(argv[0], argv.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    c.on('error', () => {})
    c.stdin.on('error', () => {})
    if (c.pid === undefined) throw new Error(`processes: cannot run ${argv[0]}`)
    spawned.push({ argv, cwd })
    children.push(c)
    const decoder = new Decoder((m) => sent.push(m), () => {})
    return {
      pid: c.pid,
      write: (b) => (decoder.push(b), c.stdin.write(b)),
      end: () => c.stdin.end(),
      onData: (fn) => c.stdout.on('data', fn),
      onStderr: (fn) => c.stderr.on('data', fn),
      onExit: (fn) => c.on('close', (code, signal) => fn({ code, signal })),
      kill: () => c.kill('SIGKILL'),
    }
  }
  return { spawn, spawned, children, sent }
}

/** Every temp folder of this file (a project's .log and .starts beside it too) goes after the last test. */
const made = []
test.after(() => {
  for (const root of made) for (const p of [root, `${root}.log`, `${root}.starts`]) fs.rmSync(p, { recursive: true, force: true })
})

/** A temp folder removed with the projects. */
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  made.push(dir)
  return dir
}

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edlsp-')))
  made.push(root)
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'const a = 1\n')
  fs.writeFileSync(path.join(root, 'src/b.ts'), 'const b = 2\n')
  fs.writeFileSync(path.join(root, 'notes.md'), '# notes\n')
  return root
}

/** A manager whose `typescript` server is the fake (a setting row), with its log file. */
function setup({ flags = [], timing = {}, root = project() } = {}) {
  const log = path.join(root, '..', `${path.basename(root)}.log`)
  const starts = path.join(root, '..', `${path.basename(root)}.starts`)
  const s = nodeSpawn()
  const warnings = []
  const m = new LspManager({
    root,
    spawn: s.spawn,
    log: { info() {}, warn: (w) => warnings.push(w) },
    servers: [{ language: 'typescript', argv: [process.execPath, FAKE, '--log', log, '--starts', starts, ...flags] }],
    timing: { restartDelaysMs: [20, 20, 20], watchFlushMs: 20, ...timing },
  })
  // The fake appends while the test reads: a last line still being written is skipped.
  const parse = (l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  }
  const read = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(parse).filter(Boolean) : [])
  const got = (method) => read().filter((e) => e.in && e.in.method === method)
  const startCount = () => (fs.existsSync(starts) ? fs.readFileSync(starts, 'utf8').split('\n').filter(Boolean).length : 0)
  return { m, root, s, read, got, startCount, warnings, done: () => m.dispose() }
}

/** A page line: records what the host posts to it. */
function holder(name) {
  const posts = []
  return { name, posts, post: (msg) => posts.push(msg), last: (t) => [...posts].reverse().find((p) => p.t === t) }
}

// ---- framing ----

test('framing: Content-Length counts bytes; a frame split anywhere, multi-byte text included, decodes whole', () => {
  const msgs = [{ jsonrpc: '2.0', id: 1, result: { text: 'héllo – 世界 🙂' } }, { jsonrpc: '2.0', method: 'x', params: {} }]
  const bytes = Buffer.concat(msgs.map(encode))
  assert.match(encode(msgs[0]).toString('latin1'), new RegExp(`^Content-Length: ${Buffer.byteLength(JSON.stringify(msgs[0]))}\r\n\r\n`))
  for (let step = 1; step <= 7; step++) {
    const out = []
    const d = new Decoder((m) => out.push(m), (e) => assert.fail(e))
    for (let i = 0; i < bytes.length; i += step) d.push(bytes.subarray(i, i + step))
    assert.deepEqual(out, msgs)
  }
})

test('framing: not LSP on stdout, a bad or huge Content-Length, a body that is not an object: one error, then nothing', () => {
  const cases = [
    Buffer.from('Starting server...\n'.repeat(1000)),
    Buffer.from('Content-Length: abc\r\n\r\n{}'),
    Buffer.from('Content-Type: x\r\n\r\n{}'),
    Buffer.from('Content-Length: 4\r\n\r\n[1,]'),
    Buffer.from('Content-Length: 2\r\n\r\n42'),
  ]
  for (const c of cases) {
    const errors = []
    const out = []
    const d = new Decoder((m) => out.push(m), (e) => errors.push(e))
    d.push(c)
    d.push(encode({ jsonrpc: '2.0', id: 1 }))
    assert.equal(errors.length, 1, c.toString().slice(0, 30))
    assert.equal(out.length, 0)
  }
  const errors = []
  new Decoder(() => {}, (e) => errors.push(e), { maxBody: 100 }).push(Buffer.from('Content-Length: 101\r\n\r\n'))
  assert.match(errors[0].message, /over the 100 byte limit/)
})

// ---- the server table ----

test('servers: the built-in table, fallbacks in order, the setting adds and overrides, broken rows reported', () => {
  const t = servers.serverTable(undefined)
  assert.deepEqual(servers.languageOf('src/a.tsx', t), { entry: t.table.get('typescript'), languageId: 'typescriptreact' })
  assert.equal(servers.languageOf('x.mjs', t).languageId, 'javascript')
  assert.equal(servers.languageOf('main.go', t).entry.language, 'go')
  assert.deepEqual(t.table.get('php').candidates.map((c) => c[0]), ['intelephense', 'phpactor'])
  assert.deepEqual(t.table.get('python').candidates.map((c) => c[0]), ['basedpyright-langserver', 'pyright-langserver'])
  assert.equal(servers.languageOf('README.md', t), null)
  assert.equal(servers.languageOf('Makefile', t), null)

  const s = servers.serverTable([
    { language: 'rust', extensions: 'rs, .RON', argv: ['rust-analyzer'] },
    { language: 'go', argv: ['/opt/gopls', '-remote=auto'] },
    { language: 'markdown', extensions: 'md ts', argv: ['marksman', 'server'] },
    { language: 'Bad Name', extensions: 'x', argv: ['x'] },
    { language: 'nimble', argv: ['nimlsp'] },
    { language: 'empty', extensions: 'e', argv: [] },
    { language: 'nul', extensions: 'n', argv: ['a\0b'] },
    null,
  ])
  assert.equal(servers.languageOf('lib.rs', s).languageId, 'rust')
  assert.equal(servers.languageOf('a.ron', s).entry.language, 'rust')
  // A built-in's command replaced, no fallback; its extensions kept.
  assert.deepEqual(s.table.get('go').candidates, [['/opt/gopls', '-remote=auto']])
  assert.equal(servers.languageOf('main.go', s).languageId, 'go')
  // An extension claimed by a later row is that row's.
  assert.equal(servers.languageOf('a.ts', s).entry.language, 'markdown')
  assert.equal(servers.languageOf('a.tsx', s).entry.language, 'typescript')
  assert.equal(s.problems.length, 5)
  assert.ok(s.problems.some((p) => p.includes('needs extensions')))
})

test('servers: looked up on PATH (the host env: the login-shell PATH); the first candidate found wins; missing names the install command', () => {
  const dir = tempDir('edlsp-path-')
  const bin = path.join(dir, 'phpactor')
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'intelephense'), 'not executable', { mode: 0o644 })
  const env = { PATH: `/nonexistent${path.delimiter}${dir}` }
  const php = servers.serverTable().table.get('php')
  assert.deepEqual(servers.resolveServer(php, { env }), { argv: [bin, 'language-server'] })
  const go = servers.serverTable().table.get('go')
  const r = servers.resolveServer(go, { env })
  assert.equal(r.missing, true)
  assert.match(r.install, /go install golang.org\/x\/tools\/gopls@latest/)
  assert.equal(servers.findOnPath('phpactor', { PATH: '' }), null)
  assert.equal(servers.findOnPath(bin, {}), bin)
})

// ---- the manager against the fake server ----

test('initialize once per language, the host owns its params; documents refcounted per URI; didClose after the last holder', async (t) => {
  const f = setup()
  t.after(f.done)
  const a = holder('a')
  const b = holder('b')
  const r1 = f.m.open(a, 'src/a.ts', 'const a = 1\n')
  assert.deepEqual({ language: r1.language, owner: r1.owner }, { language: 'typescript', owner: true })
  f.m.open(b, 'src/a.ts', 'const a = 1\n')
  f.m.open(b, './src/b.ts', 'const b = 2\n')
  await until(() => a.last('lsp-status')?.state === 'ready', 5000, 'ready')
  await until(() => f.got('textDocument/didOpen').length === 2, 5000, 'didOpens')
  assert.equal(f.got('initialize').length, 1)
  assert.equal(f.s.spawned.length, 1)
  assert.equal(f.s.spawned[0].cwd, f.root)
  const init = f.got('initialize')[0].in.params
  assert.equal(init.processId, process.pid)
  assert.equal(init.rootUri, pathToFileURL(f.root).href)
  assert.deepEqual(init.workspaceFolders, [{ uri: pathToFileURL(f.root).href, name: path.basename(f.root) }])
  assert.deepEqual(init.capabilities.workspace.workspaceEdit.resourceOperations, [])
  assert.equal(f.got('initialized').length, 1)
  const uris = f.got('textDocument/didOpen').map((e) => e.in.params.textDocument.uri)
  assert.deepEqual(uris.sort(), [pathToFileURL(path.join(f.root, 'src/a.ts')).href, pathToFileURL(path.join(f.root, 'src/b.ts')).href])
  assert.equal(f.got('textDocument/didOpen')[0].in.params.textDocument.languageId, 'typescript')
  // b only reads a.ts: its open was not the owner's.
  assert.equal(b.posts.length > 0, true)

  f.m.close(a, 'src/a.ts')
  await sleep(100)
  assert.equal(f.got('textDocument/didClose').length, 0, 'b still holds a.ts')
  f.m.closeHolder(b)
  await until(() => f.got('textDocument/didClose').length === 2, 5000, 'didCloses')
})

test('the server\'s own requests are answered by the host: configuration (null: no page setting), registration, an unknown method refused', async (t) => {
  const f = setup()
  t.after(f.done)
  const a = holder('a')
  f.m.open(a, 'src/a.ts', 'x')
  await until(() => f.read().filter((e) => e.answer).length === 3, 5000, 'answers')
  const answers = Object.fromEntries(f.read().filter((e) => e.answer).map((e) => [e.answer.method, e.answer]))
  assert.deepEqual(answers['workspace/configuration'].result, [null, null, null])
  assert.equal(answers['client/registerCapability'].result, null)
  assert.equal(answers['workspace/notAThing'].error.code, -32601)
  await until(() => f.m.slots.get('typescript').server.watchesFiles(), 2000, 'registration kept')
})

test('ids are the host\'s: concurrent asks from two pages each get their own answer', async (t) => {
  const f = setup()
  t.after(f.done)
  const a = holder('a')
  const b = holder('b')
  f.m.open(a, 'src/a.ts', 'const a = 1\n')
  f.m.open(b, 'src/a.ts', 'const a = 1\n')
  const asks = []
  for (let i = 0; i < 5; i++) {
    asks.push(f.m.ask(a, 'hover', 'src/a.ts', { position: { line: i, character: 1 } }))
    asks.push(f.m.ask(b, 'hover', 'src/a.ts', { position: { line: i, character: 2 } }))
  }
  const out = await Promise.all(asks)
  out.forEach((r, i) => assert.equal(r.result.contents.value, `hover ${Math.floor(i / 2)}:${(i % 2) + 1}`))
  const ids = f.got('textDocument/hover').map((e) => e.in.id)
  assert.equal(new Set(ids).size, 10)
  assert.ok(ids.every((id) => Number.isInteger(id)))
})

test('the allow-list: only editor-term asks become requests, with params the host builds', async (t) => {
  const f = setup()
  t.after(f.done)
  const a = holder('a')
  f.m.open(a, 'src/a.ts', 'x')
  for (const what of ['workspace/executeCommand', 'executeCommand', 'textDocument/hover', '__proto__', 'constructor', 'toString', 'shutdown']) {
    await assert.rejects(f.m.ask(a, what, 'src/a.ts', { position: { line: 0, character: 0 } }), /not something a page may ask/, what)
  }
  // Bad fields are refused before anything is sent.
  await assert.rejects(f.m.ask(a, 'hover', 'src/a.ts', { position: { line: -1, character: 0 } }), /position/)
  await assert.rejects(f.m.ask(a, 'rename', 'src/a.ts', { position: { line: 0, character: 0 }, newName: 'a\nb' }), /newName/)
  // A page's extra fields never reach the server: the params are rebuilt.
  await f.m.ask(a, 'definition', 'src/a.ts', { position: { line: 0, character: 1 }, textDocument: { uri: 'file:///etc/passwd' }, method: 'workspace/executeCommand' })
  const def = f.got('textDocument/definition')[0].in.params
  assert.deepEqual(def, { textDocument: { uri: pathToFileURL(path.join(f.root, 'src/a.ts')).href }, position: { line: 0, character: 1 } })
  assert.equal(f.got('workspace/executeCommand').length, 0)
  // A document this page does not hold cannot be asked about.
  await assert.rejects(f.m.ask(a, 'hover', 'src/b.ts', { position: { line: 0, character: 0 } }), /not open/)
  await assert.rejects(f.m.ask(holder('c'), 'hover', 'src/a.ts', { position: { line: 0, character: 0 } }), /not open/)
})

test('an ask the server does not offer answers unsupported; codeActions get the server\'s own diagnostics', async (t) => {
  const f = setup({ flags: ['--no-hover'] })
  t.after(f.done)
  const a = holder('a')
  f.m.open(a, 'src/a.ts', 'x')
  assert.deepEqual(await f.m.ask(a, 'hover', 'src/a.ts', { position: { line: 0, character: 0 } }), { result: null, unsupported: true })
  await until(() => a.last('lsp-diagnostics'), 5000, 'diagnostics')
  await f.m.ask(a, 'codeActions', 'src/a.ts', { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, diagnostics: [{ message: 'forged' }] })
  const ctx = f.got('textDocument/codeAction')[0].in.params.context
  assert.equal(ctx.diagnostics.length, 1)
  assert.equal(ctx.diagnostics[0].source, 'fake')
})

test('URIs: a path outside the project, a link out of it, an absolute path are refused; a file with no server gets none', async (t) => {
  const f = setup()
  t.after(f.done)
  const outside = tempDir('edlsp-out-')
  fs.writeFileSync(path.join(outside, 'x.ts'), 'secret')
  fs.symlinkSync(path.join(outside, 'x.ts'), path.join(f.root, 'src/link.ts'))
  const a = holder('a')
  assert.throws(() => f.m.open(a, '../x.ts', 'x'), /leaves the project/)
  assert.throws(() => f.m.open(a, path.join(outside, 'x.ts'), 'x'), /relative to the project/)
  assert.throws(() => f.m.open(a, 'src/link.ts', 'x'), /outside the project/)
  assert.deepEqual(f.m.open(a, 'notes.md', '# notes'), { language: null })
  assert.equal(f.s.spawned.length, 0)
  // A diagnostic for a URI no page holds is dropped (looked up, never resolved into a path).
  f.m.open(a, 'src/a.ts', 'x')
  await until(() => f.m.slots.get('typescript').state === 'ready', 5000, 'ready')
  f.m.notification(f.m.slots.get('typescript'), f.m.slots.get('typescript').server, { method: 'textDocument/publishDiagnostics', params: { uri: pathToFileURL(path.join(outside, 'x.ts')).href, diagnostics: [{ range: {}, message: 'x' }] } })
  assert.ok(a.posts.filter((p) => p.t === 'lsp-diagnostics').every((p) => p.path === 'src/a.ts'))
  assert.deepEqual(f.m.pathOfUri(pathToFileURL(path.join(f.root, 'src/a.ts')).href), { rel: 'src/a.ts' })
  assert.deepEqual(f.m.pathOfUri(pathToFileURL(path.join(outside, 'x.ts')).href), { outside: path.join(outside, 'x.ts') })
  assert.equal(f.m.pathOfUri('http://x/a.ts'), null)
})

test('one syncing owner: another view\'s edits are ignored; when the owner leaves the next view resyncs', async (t) => {
  const f = setup()
  t.after(f.done)
  const a = holder('a')
  const b = holder('b')
  f.m.open(a, 'src/a.ts', 'const a = 1\n')
  f.m.open(b, 'src/a.ts', 'const a = 1\n')
  await until(() => f.got('textDocument/didOpen').length === 1, 5000, 'didOpen')
  assert.equal(f.m.change(b, 'src/a.ts', [{ text: 'b wrote this' }]), false)
  assert.equal(f.m.change(a, 'src/a.ts', [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, text: 'z' }]), true)
  await until(() => f.got('textDocument/didChange').length === 1, 5000, 'didChange')
  const ch = f.got('textDocument/didChange')[0].in.params
  assert.equal(ch.textDocument.version, 2)
  assert.deepEqual(ch.contentChanges, [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, text: 'z' }])
  assert.equal([...f.m.docs.values()][0].text, 'const z = 1\n')
  // A change the host cannot place: the owner is asked for its whole text.
  assert.equal(f.m.change(a, 'src/a.ts', [{ range: { start: { line: 9, character: 0 }, end: { line: 9, character: 0 } }, text: 'x' }]), false)
  assert.equal(a.last('lsp-resync').path, 'src/a.ts')
  f.m.close(a, 'src/a.ts')
  assert.deepEqual(b.last('lsp-resync'), { t: 'lsp-resync', path: 'src/a.ts', owner: true })
  f.m.open(b, 'src/a.ts', 'b text')
  await until(() => f.got('textDocument/didChange').length === 2, 5000, 'resync didChange')
  assert.deepEqual(f.got('textDocument/didChange')[1].in.params.contentChanges, [{ text: 'b text' }])
  assert.equal(f.got('textDocument/didClose').length, 0)
})

test('diagnostics reach every view holding the document, as project paths', async (t) => {
  const f = setup()
  t.after(f.done)
  const a = holder('a')
  const b = holder('b')
  f.m.open(a, 'src/a.ts', 'abc')
  await until(() => a.last('lsp-diagnostics'), 5000, 'diagnostics')
  assert.equal(a.last('lsp-diagnostics').path, 'src/a.ts')
  assert.equal(a.last('lsp-diagnostics').diagnostics[0].message, 'v1 len3')
  // A view joining later gets the ones already published.
  f.m.open(b, 'src/a.ts', 'abc')
  assert.equal(b.last('lsp-diagnostics').diagnostics[0].message, 'v1 len3')
})

test('a timed-out or cancelled ask sends $/cancelRequest and never blocks the next one', async (t) => {
  const f = setup({ flags: ['--slow-hover'] })
  t.after(f.done)
  const a = holder('a')
  f.m.open(a, 'src/a.ts', 'x')
  const ctl = new AbortController()
  const p = f.m.ask(a, 'hover', 'src/a.ts', { position: { line: 0, character: 0 } }, ctl.signal)
  await until(() => f.got('textDocument/hover').length === 1, 5000, 'hover sent')
  ctl.abort()
  await assert.rejects(p, /cancelled/)
  await until(() => f.got('$/cancelRequest').length === 1, 5000, 'cancel')
  assert.equal(f.got('$/cancelRequest')[0].in.params.id, f.got('textDocument/hover')[0].in.id)
  const sym = await f.m.ask(a, 'symbols', 'src/a.ts', {})
  assert.equal(sym.result[0].name, 'a')
})

test('a crash restarts with backoff (3 in the window), then failed with Restart; Restart from a holder only', async (t) => {
  const f = setup({ flags: ['--crash-on-open'] })
  t.after(f.done)
  const a = holder('a')
  f.m.open(a, 'src/a.ts', 'x')
  await until(() => a.last('lsp-status')?.state === 'failed', 10000, 'failed')
  assert.equal(f.startCount(), 4) // the first start and 3 restarts
  const failed = a.last('lsp-status')
  assert.match(failed.message, /exited with code 4/)
  assert.ok(a.posts.some((p) => p.t === 'lsp-status' && p.state === 'restarting'))
  // Opening another file of the language does not start it again: the bar's Restart does.
  f.m.open(a, 'src/b.ts', 'y')
  await sleep(100)
  assert.equal(f.startCount(), 4)
  assert.equal(f.m.restart(holder('stranger'), 'typescript'), false)
  assert.equal(f.m.restart(a, 'go'), false)
  assert.equal(f.m.restart(a, 'typescript'), true)
  await until(() => f.startCount() === 5, 5000, 'restarted')
  // A running (or restarting) server cannot be churned from a page.
  assert.equal(f.m.restart(a, 'typescript'), false)
})

test('a server that breaks the framing is stopped and counts as a crash', async (t) => {
  const f = setup({ flags: ['--banner'], timing: { restartLimit: 0 } })
  t.after(f.done)
  const a = holder('a')
  f.m.open(a, 'src/a.ts', 'x')
  await until(() => a.last('lsp-status')?.state === 'failed', 5000, 'failed')
  assert.match(a.last('lsp-status').message, /malformed header|not LSP/)
})

// ---- a server that never gets through `initialize` ----
// server.js kills a server whose `initialize` failed (an error answer, the timeout); one that exits
// first is gone on its own. Either way the manager's `exited` decides as for any crash: a restart
// with backoff, then `failed`, its message carrying why and the last lines of the server's stderr
// (the bar is all the person sees of a server that cannot start: "cannot find tsconfig", a missing
// runtime). Nothing reaches a server that never initialized: no `initialized`, no didOpen.

/** Every child the test spawned has closed, killed by the host (SIGKILL) unless it exited itself. */
const allClosed = (f) => f.s.children.every((c) => c.exitCode !== null || c.signalCode !== null)

test('initialize answered with an error: killed, restarted with backoff, then failed with the error and the stderr tail', async (t) => {
  const f = setup({ flags: ['--fail-init', '--stderr', 'one\ntwo\n\nthree\nfour'], timing: { restartLimit: 1 } })
  t.after(f.done)
  const a = holder('a')
  f.m.open(a, 'src/a.ts', 'x')
  const failed = await until(() => (a.last('lsp-status')?.state === 'failed' ? a.last('lsp-status') : null), 5000, 'failed')
  assert.equal(f.startCount(), 2) // the first start and the one restart the limit allows
  assert.ok(a.posts.some((p) => p.t === 'lsp-status' && p.state === 'restarting'))
  assert.equal(a.posts.some((p) => p.t === 'lsp-status' && p.state === 'ready'), false)
  // The server's own words, then its last three non-empty stderr lines (an empty line skipped).
  assert.match(failed.message, /stopped \(fake init failure\): two \| three \| four$/)
  // It did not exit on its own: the host killed both starts.
  await until(() => allClosed(f), 5000, 'children closed')
  assert.deepEqual(f.s.children.map((c) => c.signalCode), ['SIGKILL', 'SIGKILL'])
  assert.equal(f.got('initialize').length, 2)
  assert.equal(f.got('initialized').length, 0)
  assert.equal(f.got('textDocument/didOpen').length, 0)
  assert.equal(f.m.running(), false)
})

test('initialize never answered: cancelled and killed at the timeout (60 s by default, here 150 ms), then failed', async (t) => {
  const f = setup({ flags: ['--hang-init'], timing: { initializeTimeoutMs: 150, restartLimit: 0 } })
  t.after(f.done)
  const a = holder('a')
  f.m.open(a, 'src/a.ts', 'x')
  const failed = await until(() => (a.last('lsp-status')?.state === 'failed' ? a.last('lsp-status') : null), 5000, 'failed')
  assert.match(failed.message, /did not answer initialize in/)
  // The host told the server it gave up on that very request before the kill (read from what the
  // host wrote: the kill follows at once, so the fake may never log it).
  const init = f.s.sent.find((m) => m.method === 'initialize')
  assert.deepEqual(f.s.sent.filter((m) => m.method === '$/cancelRequest').map((m) => m.params.id), [init.id])
  await until(() => allClosed(f), 5000, 'child closed')
  assert.equal(f.s.children[0].signalCode, 'SIGKILL')
  assert.equal(f.startCount(), 1)
  assert.equal(f.got('initialized').length, 0)

  // The seam changes nothing outside tests: a server given no timeout waits INITIALIZE_TIMEOUT_MS.
  const { LspServer } = require('../dist/lib/lsp/server.js')
  const child = { onData() {}, onStderr() {}, onExit() {}, write() {}, kill() {} }
  const srv = new LspServer({ spawn: () => child, argv: ['x'], root: f.root, language: 'x' })
  let opts = null
  srv.request = (_method, _params, o) => ((opts = o), new Promise(() => {}))
  srv.start()
  assert.equal(opts.timeoutMs, 60 * 1000)
})

test('a server that exits before answering initialize: a crash like any other, its exit code and stderr in the message', async (t) => {
  const f = setup({ flags: ['--exit-before-init', '--stderr', 'boom: cannot load module'], timing: { restartLimit: 1 } })
  t.after(f.done)
  const a = holder('a')
  f.m.open(a, 'src/a.ts', 'x')
  const failed = await until(() => (a.last('lsp-status')?.state === 'failed' ? a.last('lsp-status') : null), 5000, 'failed')
  assert.match(failed.message, /stopped \(exited with code 3\): boom: cannot load module$/)
  assert.ok(a.posts.some((p) => p.t === 'lsp-status' && p.state === 'restarting'))
  assert.equal(f.startCount(), 2)
  assert.deepEqual(f.s.children.map((c) => c.exitCode), [3, 3])
  assert.equal(f.got('initialized').length, 0)
  // Restart (the bar) after the backoff is spent starts it again.
  assert.equal(f.m.restart(a, 'typescript'), true)
  await until(() => f.startCount() === 3, 5000, 'restarted')
})

test('idle stop: a minute (here 50 ms) after the last document closes, shutdown and exit; a reopen in between keeps it', async (t) => {
  const f = setup({ timing: { idleStopMs: 50 } })
  t.after(f.done)
  const a = holder('a')
  f.m.open(a, 'src/a.ts', 'x')
  await until(() => f.m.slots.get('typescript').state === 'ready', 5000, 'ready')
  f.m.close(a, 'src/a.ts')
  f.m.open(a, 'src/a.ts', 'x')
  await sleep(120)
  assert.equal(f.got('shutdown').length, 0)
  assert.equal(f.startCount(), 1)
  f.m.closeHolder(a)
  await until(() => f.got('exit').length === 1, 5000, 'exit')
  assert.equal(f.got('shutdown').length, 1)
  await until(() => f.m.slots.get('typescript').server === null && f.m.slots.get('typescript').state === 'stopped', 5000, 'stopped')
  // The next file starts a new one.
  f.m.open(a, 'src/b.ts', 'y')
  await until(() => f.startCount() === 2, 5000, 'second start')
})

test('a missing server: highlighting only, a bar with the install command, nothing spawned; looked up again on the next file', async () => {
  const root = project()
  const s = nodeSpawn()
  const m = new LspManager({ root, spawn: s.spawn, env: { PATH: '/nonexistent' } })
  const a = holder('a')
  const r = m.open(a, 'src/a.ts', 'x')
  assert.equal(r.language, 'typescript')
  assert.equal(r.state, 'missing')
  const st = a.last('lsp-status')
  assert.equal(st.state, 'missing')
  assert.match(st.install, /npm install -g typescript-language-server typescript/)
  assert.equal(s.spawned.length, 0)
  assert.deepEqual(await m.ask(a, 'hover', 'src/a.ts', { position: { line: 0, character: 0 } }), { result: null, unavailable: 'missing' })
  // Installed meanwhile: the next file finds it.
  const dir = tempDir('edlsp-bin-')
  fs.writeFileSync(path.join(dir, 'typescript-language-server'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" --log /dev/null\n`, { mode: 0o755 })
  m.env = { PATH: dir }
  m.open(a, 'src/b.ts', 'y')
  assert.equal(s.spawned.length, 1)
  assert.deepEqual(s.spawned[0].argv, [path.join(dir, 'typescript-language-server'), '--stdio'])
  await m.dispose()
})

test('watched files: folder events and Claude\'s files become didChangeWatchedFiles (Created, Changed, Deleted); .git and save temps left out', async (t) => {
  const f = setup()
  t.after(f.done)
  const a = holder('a')
  f.m.open(a, 'src/a.ts', 'x')
  await until(() => f.m.slots.get('typescript').state === 'ready', 5000, 'ready')
  const c = path.join(f.root, 'src/c.ts')
  fs.writeFileSync(c, 'new')
  f.m.noteChanged(c)
  f.m.noteChanged(path.join(f.root, '.git', 'index'))
  f.m.noteChanged(path.join(f.root, 'src', '.a.ts.cc-editor-abcdef012345.tmp'))
  f.m.noteChanged('/etc/passwd')
  await until(() => f.got('workspace/didChangeWatchedFiles').length === 1, 5000, 'first batch')
  assert.deepEqual(f.got('workspace/didChangeWatchedFiles')[0].in.params.changes, [{ uri: pathToFileURL(c).href, type: 1 }])
  // The same file again with nothing new: not sent. Changed: Changed.
  f.m.noteChanged(c)
  await sleep(60)
  assert.equal(f.got('workspace/didChangeWatchedFiles').length, 1)
  fs.writeFileSync(c, 'newer, longer')
  f.m.noteSessionFiles([c])
  await until(() => f.got('workspace/didChangeWatchedFiles').length === 2, 5000, 'changed')
  assert.equal(f.got('workspace/didChangeWatchedFiles')[1].in.params.changes[0].type, 2)
  fs.unlinkSync(c)
  f.m.noteChanged(c)
  await until(() => f.got('workspace/didChangeWatchedFiles').length === 3, 5000, 'deleted')
  assert.equal(f.got('workspace/didChangeWatchedFiles')[2].in.params.changes[0].type, 3)

  // The file tabs' folder watcher feeds it: a sibling file of an open one.
  const events = []
  const w = new FolderWatcher(null, {
    watchImpl: (dir, _o, cb) => {
      events.push({ dir, cb })
      return { close() {}, on() {} }
    },
  })
  const seen = []
  w.onFolderEvent((real) => seen.push(real))
  w.add(path.join(f.root, 'src/a.ts'), null, () => {})
  events[0].cb('rename', 'd.ts')
  assert.deepEqual(seen, [path.join(f.root, 'src/d.ts')])
  w.close()
})

test('results are trimmed under the message cap: a long completion list keeps its head and says incomplete', async (t) => {
  const f = setup({ flags: ['--items', '20000'] })
  t.after(f.done)
  const a = holder('a')
  f.m.open(a, 'src/a.ts', 'x')
  const r = await f.m.ask(a, 'complete', 'src/a.ts', { position: { line: 0, character: 0 }, triggerCharacter: '.' })
  assert.equal(r.truncated, true)
  assert.equal(r.result.isIncomplete, true)
  assert.ok(r.result.items.length > 100 && r.result.items.length < 20000)
  assert.ok(JSON.stringify(r).length <= ANSWER_BUDGET)
  assert.deepEqual(f.got('textDocument/completion')[0].in.params.context, { triggerKind: 2, triggerCharacter: '.' })
  // A hover's text is cut; one thing too big to cut is refused, never sent broken.
  const hover = fitResult({ contents: { kind: 'markdown', value: 'h'.repeat(2 * ANSWER_BUDGET) } })
  assert.equal(hover.truncated, true)
  assert.ok(JSON.stringify(hover.value).length <= ANSWER_BUDGET)
  assert.throws(() => fitResult({ changes: { a: 'x'.repeat(2 * ANSWER_BUDGET) } }), /more than a page can be sent/)
})

test('applyChanges: LSP positions in UTF-16, a character past the line end is its end, outside refused', () => {
  assert.equal(applyChanges('a🙂b\ncd', [{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 4 } }, text: 'X' }]), 'a🙂X\ncd')
  assert.equal(applyChanges('ab\ncd', [{ range: { start: { line: 0, character: 99 }, end: { line: 1, character: 0 } }, text: '' }]), 'abcd')
  assert.equal(applyChanges('ab', [{ text: 'whole' }, { range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } }, text: '!' }]), 'whole!')
  assert.throws(() => applyChanges('ab', [{ range: { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } }, text: 'x' }]), /outside/)
  assert.throws(() => applyChanges('ab', [{ range: { start: { line: 0, character: 2 }, end: { line: 0, character: 1 } }, text: 'x' }]), /ends before/)
})

// ---- the page protocol ----

/** A PageTabInstance stand-in: `send` delivers a page message, `posts` what the host posted. */
function fakeTab(id = 't1', view) {
  const posts = []
  const closers = []
  return {
    id,
    view,
    posts,
    post: (m) => posts.push(m),
    onClose: (fn) => closers.push(fn),
    close: () => closers.forEach((fn) => fn()),
    last: (t) => [...posts].reverse().find((p) => p.t === t),
  }
}

test('serveLsp: whole text in parts, asks answered by req, cancel, close releases the documents', async (t) => {
  const f = setup({ flags: ['--slow-hover'] })
  t.after(f.done)
  const tab = fakeTab()
  const handle = serveLsp(tab, f.m)
  assert.equal(handle({ t: 'open', req: 1 }), false)
  handle({ t: 'lsp-open', path: 'src/a.ts', part: 0, parts: 2, text: 'const ' })
  assert.equal(tab.last('lsp-doc'), undefined)
  handle({ t: 'lsp-open', path: 'src/a.ts', part: 1, parts: 2, text: 'a = 1\n' })
  assert.deepEqual(tab.last('lsp-doc'), { t: 'lsp-doc', path: 'src/a.ts', language: 'typescript', name: 'TypeScript / JavaScript', owner: true, state: 'starting' })
  await until(() => f.got('textDocument/didOpen').length === 1, 5000, 'didOpen')
  assert.equal(f.got('textDocument/didOpen')[0].in.params.textDocument.text, 'const a = 1\n')

  handle({ t: 'lsp-ask', req: 'r1', what: 'symbols', path: 'src/a.ts' })
  await until(() => tab.last('lsp-answer'), 5000, 'answer')
  assert.equal(tab.last('lsp-answer').req, 'r1')
  assert.equal(tab.last('lsp-answer').result[0].name, 'a')
  handle({ t: 'lsp-ask', req: 'r2', what: 'workspace/executeCommand', path: 'src/a.ts' })
  await until(() => tab.posts.filter((p) => p.t === 'lsp-answer').length === 2, 5000, 'refusal')
  assert.match(tab.last('lsp-answer').error, /not something a page may ask/)
  handle({ t: 'lsp-ask', req: 'r3', what: 'hover', path: 'src/a.ts', position: { line: 0, character: 0 } })
  await until(() => f.got('textDocument/hover').length === 1, 5000, 'hover')
  handle({ t: 'lsp-cancel', req: 'r3' })
  await until(() => f.got('$/cancelRequest').length === 1, 5000, 'cancel')
  handle({ t: 'lsp-open', path: '../x.ts', part: 0, parts: 1, text: 'x' })
  assert.match(tab.last('lsp-error').message, /leaves the project/)

  tab.close()
  await until(() => f.got('textDocument/didClose').length === 1, 5000, 'didClose')
  assert.equal(f.m.docs.size, 0)
})

test('serveLsp with no manager (an app without ctx.processes): no server, never an error', () => {
  const tab = fakeTab()
  const handle = serveLsp(tab, null)
  handle({ t: 'lsp-open', path: 'src/a.ts', part: 0, parts: 1, text: 'x' })
  handle({ t: 'lsp-ask', req: 1, what: 'hover', path: 'src/a.ts' })
  assert.equal(tab.last('lsp-doc').language, null)
  assert.deepEqual(tab.last('lsp-answer'), { t: 'lsp-answer', req: 1, result: null, unavailable: 'stopped' })
})

test('the manifest declares the servers app setting with no regex', () => {
  const props = require('../plugin.json').contributes.settings.app.properties
  assert.equal(props.servers.type, 'array')
  assert.deepEqual(props.servers.items.required, ['language', 'argv'])
  assert.equal(JSON.stringify(props.servers).includes('pattern'), false)
})

// ---- review round: URI re-encoding, aliases, setServers, dispose, caps ----

test('diagnostics: a server that re-encodes the URI (+ and @ percent-encoded) still reaches the document', async (t) => {
  const root = project()
  fs.mkdirSync(path.join(root, 'src/routes/@modal'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src/routes/@modal/+page.ts'), 'x')
  const f = setup({ root, flags: ['--reencode'] })
  t.after(f.done)
  const a = holder('a')
  f.m.open(a, 'src/routes/@modal/+page.ts', 'x')
  await until(() => a.last('lsp-diagnostics'), 5000, 'diagnostics')
  assert.equal(a.last('lsp-diagnostics').path, 'src/routes/@modal/+page.ts')
  assert.ok(f.got('textDocument/didOpen')[0].in.params.textDocument.uri.includes('+page.ts'), 'the client sent it unencoded')
})

test('two in-project paths to one file: each holder keeps its own spelling for asks, resync and close', async (t) => {
  const f = setup()
  t.after(f.done)
  fs.symlinkSync(path.join(f.root, 'src'), path.join(f.root, 'alias'))
  const a = holder('a')
  const b = holder('b')
  f.m.open(a, 'src/a.ts', 'const a = 1\n')
  f.m.open(b, 'alias/a.ts', 'const a = 1\n')
  await until(() => f.m.slots.get('typescript').state === 'ready', 5000, 'ready')
  assert.equal(f.m.docs.size, 1)
  const r = await f.m.ask(b, 'symbols', 'alias/a.ts', {})
  assert.equal(r.result[0].name, 'a')
  await until(() => b.last('lsp-diagnostics') && a.last('lsp-diagnostics'), 5000, 'diagnostics')
  assert.equal(b.last('lsp-diagnostics').path, 'alias/a.ts')
  assert.equal(a.last('lsp-diagnostics').path, 'src/a.ts')
  f.m.close(a, 'src/a.ts')
  assert.deepEqual(b.last('lsp-resync'), { t: 'lsp-resync', path: 'alias/a.ts', owner: true })
  assert.equal(f.m.change(b, 'alias/a.ts', [{ text: 'const b = 1\n' }]), true)
  await until(() => f.got('textDocument/didChange').length === 1, 5000, 'didChange')
  f.m.close(b, 'alias/a.ts')
  await until(() => f.got('textDocument/didClose').length === 1, 5000, 'didClose')
  assert.equal(f.m.docs.size, 0)
})

test('setServers: a changed argv restarts the server with its documents; a removed language stops it; an open in the stop window is not lost', async (t) => {
  const f = setup()
  t.after(f.done)
  const log = path.join(f.root, '..', `${path.basename(f.root)}.log`)
  const starts = path.join(f.root, '..', `${path.basename(f.root)}.starts`)
  const fake = (...flags) => [{ language: 'typescript', argv: [process.execPath, FAKE, '--log', log, '--starts', starts, ...flags] }]
  const a = holder('a')
  f.m.open(a, 'src/a.ts', 'const a = 1\n')
  await until(() => f.m.slots.get('typescript').state === 'ready', 5000, 'ready')
  f.m.setServers(fake('--no-hover'))
  f.m.open(a, 'src/b.ts', 'const b = 2\n')
  await until(() => f.startCount() === 2, 5000, 'second start')
  await until(() => f.m.slots.get('typescript').state === 'ready', 5000, 'ready again')
  await sleep(60)
  assert.equal(f.startCount(), 2)
  assert.equal(f.got('shutdown').length, 1)
  const uris = () => f.got('textDocument/didOpen').map((e) => e.in.params.textDocument.uri)
  await until(() => uris().filter((u) => u.endsWith('a.ts')).length === 2 && uris().filter((u) => u.endsWith('b.ts')).length >= 1, 5000, 'documents on the new server')
  f.m.setServers(fake('--no-hover'))
  await sleep(60)
  assert.equal(f.startCount(), 2)
  f.m.setServers([{ language: 'typescript', extensions: 'ts', argv: [] }])
  await until(() => f.m.slots.get('typescript').server === null, 5000, 'stopped')
  assert.equal(f.m.docs.size, 2)
})

test('dispose sends shutdown and exit to every server and resolves after they are gone', async () => {
  const f = setup()
  const a = holder('a')
  f.m.open(a, 'src/a.ts', 'x')
  await until(() => f.m.slots.get('typescript').state === 'ready', 5000, 'ready')
  await f.m.dispose()
  assert.equal(f.got('shutdown').length, 1)
  assert.equal(f.got('exit').length, 1)
})

test('a full-text change or a resync past the size cap releases the document from the server', async (t) => {
  const f = setup()
  t.after(f.done)
  const a = holder('a')
  f.m.open(a, 'src/a.ts', 'x')
  await until(() => f.got('textDocument/didOpen').length === 1, 5000, 'didOpen')
  const big = 'y'.repeat(2 * 1024 * 1024 + 1)
  assert.throws(() => applyChanges('x', [{ text: big }]), /too large/)
  assert.equal(f.m.change(a, 'src/a.ts', [{ text: big }]), false)
  assert.equal(a.last('lsp-resync').path, 'src/a.ts')
  assert.equal(f.got('textDocument/didChange').length, 0)
  assert.equal(f.m.open(a, 'src/a.ts', big).language, null)
  await until(() => f.got('textDocument/didClose').length === 1, 5000, 'didClose')
  assert.equal(f.m.docs.size, 0)
})

test('watched files: more than one batch is sent in several notifications; a server that did not register gets none', async (t) => {
  const f = setup()
  t.after(f.done)
  const a = holder('a')
  f.m.open(a, 'src/a.ts', 'x')
  await until(() => f.m.slots.get('typescript').state === 'ready', 5000, 'ready')
  await until(() => f.m.slots.get('typescript').server.watchesFiles(), 5000, 'registered')
  const dir = path.join(f.root, 'many')
  fs.mkdirSync(dir)
  for (let i = 0; i < 1500; i++) {
    const p = path.join(dir, `f${i}.ts`)
    fs.writeFileSync(p, String(i))
    f.m.noteChanged(p)
  }
  await until(() => f.got('workspace/didChangeWatchedFiles').length === 2, 5000, 'two batches')
  assert.deepEqual(f.got('workspace/didChangeWatchedFiles').map((e) => e.in.params.changes.length), [1000, 500])
  f.m.slots.get('typescript').server.registrations.clear()
  const p = path.join(dir, 'late.ts')
  fs.writeFileSync(p, 'x')
  f.m.noteChanged(p)
  await sleep(80)
  assert.equal(f.got('workspace/didChangeWatchedFiles').length, 2)
})

test('resolveCompletion takes only an item the host answered to that page', async (t) => {
  const f = setup()
  t.after(f.done)
  const a = holder('a')
  const b = holder('b')
  f.m.open(a, 'src/a.ts', 'x')
  f.m.open(b, 'src/a.ts', 'x')
  const r = await f.m.ask(a, 'complete', 'src/a.ts', { position: { line: 0, character: 0 } })
  const item = JSON.parse(JSON.stringify(r.result.items[0]))
  await f.m.ask(a, 'resolveCompletion', 'src/a.ts', { item })
  assert.equal(f.got('completionItem/resolve').length, 1)
  await assert.rejects(f.m.ask(a, 'resolveCompletion', 'src/a.ts', { item: { label: 'x', data: { file: '/etc/passwd' } } }), /this server gave/)
  await assert.rejects(f.m.ask(b, 'resolveCompletion', 'src/a.ts', { item }), /this server gave/)
  assert.equal(f.got('completionItem/resolve').length, 1)
})

test('servers: a relative PATH entry is never searched (a cloned project could ship the program); absolute ones are', (t) => {
  const root = tempDir('edlsp-rel-')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'bin'))
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true })
  const bin = path.join(root, 'bin', 'rls')
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'rls'), '#!/bin/sh\n', { mode: 0o755 })
  for (const PATH of ['bin', 'node_modules/.bin', '.', `.${path.delimiter}bin`]) {
    assert.equal(servers.findOnPath('rls', { PATH }, root), null, PATH)
    assert.deepEqual(servers.resolveServer({ candidates: [['rls']], install: 'x' }, { env: { PATH }, cwd: root }).missing, true, PATH)
  }
  assert.equal(servers.findOnPath('rls', { PATH: `bin${path.delimiter}${path.join(root, 'bin')}` }, os.tmpdir()), bin)
  assert.equal(servers.programPath('rls', { PATH: `node_modules/.bin${path.delimiter}${path.join(root, 'bin')}` }), bin)
  // A path with a slash (the person's own `servers` setting) is still taken as given, against the project.
  assert.equal(servers.findOnPath('bin/rls', { PATH: '' }, root), bin)
})

test('serveLsp: a close with an unnormalized path drops the pending parts', async (t) => {
  const f = setup()
  t.after(f.done)
  const tab = fakeTab()
  const handle = serveLsp(tab, f.m)
  handle({ t: 'lsp-open', path: 'src/a.ts', part: 0, parts: 2, text: 'const ' })
  handle({ t: 'lsp-close', path: './src/a.ts' })
  handle({ t: 'lsp-open', path: 'src/a.ts', part: 1, parts: 2, text: 'a' })
  assert.match(tab.last('lsp-error').message, /out of order/)
  assert.equal(f.m.docs.size, 0)
})

test('serveLsp: an open whose parts stop coming is dropped and told to the page', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = setup()
  t.after(f.done)
  const tab = fakeTab()
  const handle = serveLsp(tab, f.m)
  handle({ t: 'lsp-open', path: 'src/a.ts', part: 0, parts: 2, text: 'const ' })
  assert.equal(tab.last('lsp-error'), undefined)
  t.mock.timers.tick(10 * 1000)
  assert.match(tab.last('lsp-error').message, /did not all reach/)
  assert.equal(tab.last('lsp-error').path, 'src/a.ts')
  assert.equal(f.m.docs.size, 0)
  // The late part is out of order now, not the end of a document.
  handle({ t: 'lsp-open', path: 'src/a.ts', part: 1, parts: 2, text: 'a' })
  assert.match(tab.last('lsp-error').message, /out of order/)
  assert.equal(f.m.docs.size, 0)
})
