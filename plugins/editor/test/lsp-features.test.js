'use strict'
// The language features' host side (dist/lib/lsp/edits.js, manager.js asks, serve.js lsp-edit,
// files.js readOutside, host.js outside tabs) against the fake server (test/fixtures/fake-lsp.mjs)
// answering in typescript-language-server's shapes: a rename's WorkspaceEdit applied to the open
// file through its page and to an unopened one by compare-and-swap; stale versions, resource
// operations and files outside the project refused as a whole; definitions and references mapped
// to project paths, an outside location opening read-only only once a server returned it; code
// actions kept in the host (ids to the page), their commands run by the host, a server's applyEdit
// taken only while one runs; format through the owner page.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { LspManager } = require('../dist/lib/lsp/manager.js')
const { applyWorkspaceEdit, applyTextEdits, planEdit } = require('../dist/lib/lsp/edits.js')
const { serveLsp } = require('../dist/lib/lsp/serve.js')
const files = require('../dist/lib/files.js')

const FAKE = path.join(__dirname, 'fixtures', 'fake-lsp.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(fn, ms = 5000, what = 'condition') {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

/** ctx.processes.spawn's shape over node's spawn (argv only). */
function spawn(argv, { cwd }) {
  const c = cp.spawn(argv[0], argv.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  c.on('error', () => {})
  c.stdin.on('error', () => {})
  return {
    pid: c.pid,
    write: (b) => c.stdin.write(b),
    end: () => c.stdin.end(),
    onData: (fn) => c.stdout.on('data', fn),
    onStderr: (fn) => c.stderr.on('data', fn),
    onExit: (fn) => c.on('close', (code, signal) => fn({ code, signal })),
    kill: () => c.kill('SIGKILL'),
  }
}

/** A project with src/a.ts and src/b.ts, and a file outside it. */
function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edfeat-')))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'const a = 1\n')
  fs.writeFileSync(path.join(root, 'src/b.ts'), 'const b = 2\n')
  const outDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edfeat-out-')))
  const outside = path.join(outDir, 'lib.d.ts')
  fs.writeFileSync(outside, 'declare const x: number\n\nexport function lib(): void\n')
  return { root, outside }
}

const serverRow = (log, flags) => [{ language: 'typescript', argv: [process.execPath, FAKE, '--log', log, ...flags] }]

function setup(flags = [], timing = {}) {
  const { root, outside } = project()
  const log = path.join(root, '..', `${path.basename(root)}.log`)
  const all = [...flags.map((f) => (f === '--outside' ? ['--outside', outside] : [f])).flat()]
  const m = new LspManager({ root, spawn, servers: serverRow(log, all), timing: { watchFlushMs: 20, ...timing } })
  const parse = (l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  }
  const read = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(parse).filter(Boolean) : [])
  const got = (method) => read().filter((e) => e.in && e.in.method === method)
  const answers = (method) => read().filter((e) => e.answer && e.answer.method === method).map((e) => e.answer)
  const disk = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
  const done = async () => {
    await m.dispose()
    cleanup(root, outside, log)
  }
  return { m, root, outside, got, answers, disk, done }
}

/** The temp project, the outside folder and the server's log go after each test. */
function cleanup(root, outside, log) {
  for (const p of [root, path.dirname(outside), log]) if (p) fs.rmSync(p, { recursive: true, force: true })
}

/**
 * A page line holding `rel` the way lsp/client.mjs does: it counts what it sent (`seq`), applies an
 * `lsp-edit` only when the host's seq is its own, and sends the result as its next change.
 */
function page(m, rel, text) {
  const p = {
    posts: [],
    text,
    seq: 0,
    edits: [],
    refuse: null,
    post: (msg) => p.posts.push(msg),
    last: (t) => [...p.posts].reverse().find((x) => x.t === t),
    applyEdits: async (r, edits, seq) => {
      p.edits.push({ rel: r, edits, seq })
      if (p.refuse) return { applied: false, reason: p.refuse }
      if (seq !== p.seq) return { applied: false, reason: 'the file changed while the language server worked; try again' }
      p.text = applyTextEdits(p.text, edits)
      p.seq++
      m.change(p, rel, [{ text: p.text }], p.seq)
      return { applied: true }
    },
    open: () => {
      p.seq++
      return m.open(p, rel, p.text, p.seq)
    },
  }
  return p
}

const ready = (f) => until(() => f.m.slots.get('typescript') && f.m.slots.get('typescript').state === 'ready', 5000, 'ready')
const pos = (line, character) => ({ position: { line, character } })

// ---- edits.js on its own ----

test('applyTextEdits: ranges of the original text, applied from the end; inserts at one point keep their order; an overlap or a range past the end refused', () => {
  const text = 'const a = 1\nconst b = a + a\n'
  const edits = [
    { range: { start: { line: 1, character: 14 }, end: { line: 1, character: 15 } }, newText: 'z' },
    { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: 'z' },
    { range: { start: { line: 1, character: 10 }, end: { line: 1, character: 11 } }, newText: 'z' },
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '// 1\n' },
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '// 2\n' },
  ]
  assert.equal(applyTextEdits(text, edits), '// 1\n// 2\nconst z = 1\nconst b = z + z\n')
  // UTF-16 positions: the emoji is two units.
  assert.equal(applyTextEdits('a😀b\n', [{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 4 } }, newText: 'B' }]), 'a😀B\n')
  assert.throws(() => applyTextEdits(text, [edits[0], { range: { start: { line: 1, character: 13 }, end: { line: 1, character: 15 } }, newText: '' }]), /overlap/)
  assert.throws(() => applyTextEdits(text, [{ range: { start: { line: 9, character: 0 }, end: { line: 9, character: 0 } }, newText: 'x' }]), /outside the file/)
})

test('planEdit: create, rename and delete refused (none declared); a file twice, a non-file URI, a bad edit refused; `changes` and `documentChanges` both read', () => {
  const root = '/proj'
  const where = (uri) => {
    if (!uri.startsWith('file:')) return null
    const p = new URL(uri).pathname
    return p.startsWith(root + '/') ? { rel: p.slice(root.length + 1) } : { outside: p }
  }
  const e = (newText) => [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText }]
  for (const kind of ['create', 'rename', 'delete']) {
    assert.throws(() => planEdit({ documentChanges: [{ kind, uri: 'file:///proj/x.ts' }] }, where), new RegExp(`would ${kind} a file`))
  }
  assert.throws(() => planEdit({ changes: { 'file:///etc/passwd': e('x') } }, where), /outside the project/)
  assert.throws(() => planEdit({ changes: { 'untitled:1': e('x') } }, where), /not a file/)
  assert.throws(() => planEdit({ documentChanges: [{ textDocument: { uri: 'file:///proj/a.ts', version: 1 }, edits: e('x') }, { textDocument: { uri: 'file:///proj/a.ts', version: 1 }, edits: e('y') }] }, where), /twice/)
  assert.throws(() => planEdit({ changes: { 'file:///proj/a.ts': [{ range: { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } }, newText: '' }] } }, where), /bad position/)
  assert.throws(() => planEdit({ changes: { 'file:///proj/a.ts': [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }] } }, where), /not a text edit/)
  assert.deepEqual(planEdit({ changes: { 'file:///proj/a.ts': e('x') } }, where).map((p) => [p.rel, p.version]), [['a.ts', null]])
  assert.deepEqual(planEdit({ documentChanges: [{ textDocument: { uri: 'file:///proj/a.ts', version: 4 }, edits: e('x') }] }, where).map((p) => [p.rel, p.version]), [['a.ts', 4]])
  assert.deepEqual(planEdit({}, where), [])
})

// ---- workspace edits through the manager ----

test('a recorded rename (documentChanges, the open file versioned, the other null) edits the open file through its page and the unopened one by compare-and-swap', async (t) => {
  const f = setup()
  t.after(f.done)
  const a = page(f.m, 'src/a.ts', 'const a = 1\n')
  a.open()
  await ready(f)
  const r = await f.m.ask(a, 'rename', 'src/a.ts', { ...pos(0, 6), newName: 'z' })
  assert.deepEqual(r.result, { applied: true, files: 2, edits: 3 })
  // The open file changed in the page (which saves it like typing); the disk still has the old text.
  assert.equal(a.text, 'const z = 1\n')
  assert.equal(a.edits[0].seq, 1)
  assert.equal(f.disk('src/a.ts'), 'const a = 1\n')
  // The unopened file was written, and the servers hear it as a watched-file change.
  assert.equal(f.disk('src/b.ts'), 'const z = 3\n')
  const bUri = pathToFileURL(path.join(f.root, 'src/b.ts')).href
  await until(() => f.got('workspace/didChangeWatchedFiles').some((e) => e.in.params.changes.some((c) => c.uri === bUri)), 5000, 'watched change')
})

test('a stale document version, an open file whose page typed since, or a closed one refuses the edit before anything is written', async (t) => {
  const f = setup()
  t.after(f.done)
  const a = page(f.m, 'src/a.ts', 'const a = 1\n')
  a.open()
  await ready(f)
  const aUri = pathToFileURL(path.join(f.root, 'src/a.ts')).href
  const bUri = pathToFileURL(path.join(f.root, 'src/b.ts')).href
  const one = [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: 'z' }]
  // The server's version is not the document's.
  let r = await applyWorkspaceEdit(f.m, { documentChanges: [{ textDocument: { uri: bUri, version: null }, edits: one }, { textDocument: { uri: aUri, version: 99 }, edits: one }] })
  assert.equal(r.applied, false)
  assert.match(r.failureReason, /changed while the language server worked/)
  assert.equal(f.disk('src/b.ts'), 'const b = 2\n')
  assert.equal(a.edits.length, 0)
  // `changes` (no versions): the versions the host recorded when it asked.
  const asked = f.m.versions()
  f.m.change(a, 'src/a.ts', [{ text: 'const a = 10\n' }], ++a.seq)
  a.text = 'const a = 10\n'
  r = await applyWorkspaceEdit(f.m, { changes: { [aUri]: one } }, { versions: asked })
  assert.equal(r.applied, false)
  // A version for a file no page holds: the server thought it open; it closed since.
  r = await applyWorkspaceEdit(f.m, { documentChanges: [{ textDocument: { uri: bUri, version: 3 }, edits: one }] })
  assert.match(r.failureReason, /closed while/)
  // The page refuses (it typed after the host's seq): the edit stops there, the next file untouched.
  a.refuse = 'the file changed while the language server worked; try again'
  r = await applyWorkspaceEdit(f.m, { documentChanges: [{ textDocument: { uri: aUri, version: null }, edits: one }, { textDocument: { uri: bUri, version: null }, edits: one }] })
  assert.deepEqual([r.applied, r.failedChange, r.files], [false, 0, 0])
  assert.equal(f.disk('src/b.ts'), 'const b = 2\n')
})

test('a rename that would create a file, or edit one outside the project, is refused as a whole', async (t) => {
  for (const flags of [['--rename-create'], ['--rename-outside', '--outside']]) {
    const f = setup(flags)
    t.after(f.done)
    const a = page(f.m, 'src/a.ts', 'const a = 1\n')
    a.open()
    await ready(f)
    const r = await f.m.ask(a, 'rename', 'src/a.ts', { ...pos(0, 6), newName: 'z' })
    assert.equal(r.result.applied, false, flags.join(' '))
    assert.match(r.result.failureReason, flags[0] === '--rename-create' ? /would create a file/ : /outside the project/)
    assert.equal(a.text, 'const a = 1\n')
    assert.equal(f.disk('src/b.ts'), 'const b = 2\n')
    assert.equal(fs.readFileSync(f.outside, 'utf8').startsWith('declare'), true)
  }
})

test('a file no page holds that cannot be saved here (read-only, gone) fails the edit, nothing written', async (t) => {
  const f = setup()
  t.after(f.done)
  const bUri = pathToFileURL(path.join(f.root, 'src/b.ts')).href
  const one = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'x' }]
  fs.linkSync(path.join(f.root, 'src/b.ts'), path.join(f.root, 'b-link.ts'))
  let r = await applyWorkspaceEdit(f.m, { changes: { [bUri]: one } })
  assert.equal(r.applied, false)
  assert.match(r.failureReason, /cannot be edited here \(linked\)/)
  fs.unlinkSync(path.join(f.root, 'b-link.ts'))
  fs.unlinkSync(path.join(f.root, 'src/b.ts'))
  r = await applyWorkspaceEdit(f.m, { changes: { [bUri]: one } })
  assert.match(r.failureReason, /gone/)
})

// ---- locations ----

test('definition and references: project paths and line text; an outside location is allowed only once a server returned it; non-file URIs dropped', async (t) => {
  const f = setup(['--outside'])
  t.after(f.done)
  const a = page(f.m, 'src/a.ts', 'const a = 1\n')
  a.open()
  await ready(f)
  assert.equal(f.m.allowsOutside(f.outside), false)
  const def = await f.m.ask(a, 'definition', 'src/a.ts', pos(0, 6))
  assert.deepEqual(def.result, [
    { path: 'src/b.ts', range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } } },
    { outside: f.outside, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } } },
  ])
  assert.equal(f.m.allowsOutside(f.outside), true)
  assert.equal(f.m.allowsOutside('/etc/passwd'), false)
  const refs = await f.m.ask(a, 'references', 'src/a.ts', pos(0, 6))
  assert.deepEqual(
    refs.result.map((l) => [l.path, l.text]),
    [
      ['src/a.ts', 'const a = 1'],
      ['src/b.ts', 'const b = 2'],
    ],
  )
})

test('an outside file tab: read-only (why outside), only the path in its params; a page naming another absolute path is refused', (t) => {
  const { root, outside } = project()
  const shared = files.makeFiles(root)
  // In t.after: a failed assertion would otherwise leave the watch open and the temp folders behind.
  t.after(() => {
    shared.watcher.close()
    cleanup(root, outside)
  })
  const posted = []
  let onMessage = null
  const tab = { id: 't1', type: 'file', params: { outside }, view: undefined, post: (m) => posted.push(m), onMessage: (fn) => (onMessage = fn), onClose: () => {} }
  files.serveFileTab(shared, tab)
  onMessage({ t: 'open', req: 1, first: true })
  const file = posted.find((m) => m.t === 'file')
  assert.equal(file.path, outside)
  assert.equal(file.readOnly, true)
  assert.equal(file.why, 'outside')
  assert.match(file.text, /export function lib/)
  onMessage({ t: 'read', req: 2, path: '/etc/hostname' })
  assert.equal(posted.at(-1).t, 'error')
  onMessage({ t: 'save', req: 3, path: outside, baseHash: file.hash, part: 0, parts: 1, text: 'x' })
  assert.equal(posted.at(-1).t, 'error')
  assert.match(fs.readFileSync(outside, 'utf8'), /^declare/)
})

// ---- code actions ----

test('code actions: the page gets ids and titles only; the host applies an edit, runs a declared command (its applyEdit taken while it runs), refuses an undeclared one, resolves one with no edit', async (t) => {
  const f = setup()
  t.after(f.done)
  const a = page(f.m, 'src/a.ts', 'const a = 1\n')
  a.open()
  await ready(f)
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }
  const offer = async () => (await f.m.ask(a, 'codeActions', 'src/a.ts', { range })).result
  let list = await offer()
  assert.deepEqual(list.map((x) => [x.title, x.kind, x.preferred === true]), [
    ['Insert header', 'quickfix', true],
    ['Run fake.apply', 'source', false],
    ['Run undeclared', undefined, false],
    ['Resolve me', 'refactor', false],
  ])
  for (const x of list) assert.deepEqual(Object.keys(x).filter((k) => !['id', 'title', 'kind', 'preferred'].includes(k)), [])
  // A forged id, or one of an older list, is refused.
  await assert.rejects(f.m.ask(a, 'runCodeAction', 'src/a.ts', { id: 99999 }), /no longer offered/)
  // An edit: applied through the page.
  let r = await f.m.ask(a, 'runCodeAction', 'src/a.ts', { id: list[0].id })
  assert.deepEqual(r.result, { applied: true, files: 1, edits: 1 })
  assert.equal(a.text, '// header\nconst a = 1\n')
  await assert.rejects(f.m.ask(a, 'runCodeAction', 'src/a.ts', { id: list[1].id }), /no longer offered/)
  // A declared command: the host runs it; the server's applyEdit while it runs writes src/b.ts.
  list = await offer()
  r = await f.m.ask(a, 'runCodeAction', 'src/a.ts', { id: list[1].id })
  assert.equal(r.result.applied, true)
  assert.equal(f.disk('src/b.ts'), '// applied\nconst b = 2\n')
  assert.deepEqual(f.got('workspace/executeCommand').map((e) => e.in.params), [{ command: 'fake.apply', arguments: [pathToFileURL(path.join(f.root, 'src/b.ts')).href] }])
  await until(() => f.answers('workspace/applyEdit').length === 1, 5000, 'applyEdit answer')
  assert.equal(f.answers('workspace/applyEdit')[0].result.applied, true)
  // A command the server did not declare is never sent.
  list = await offer()
  await assert.rejects(f.m.ask(a, 'runCodeAction', 'src/a.ts', { id: list[2].id }), /did not declare/)
  assert.equal(f.got('workspace/executeCommand').length, 1)
  // No edit and no command: resolved first (codeAction/resolve), then its edit applied.
  list = await offer()
  r = await f.m.ask(a, 'runCodeAction', 'src/a.ts', { id: list[3].id })
  assert.equal(r.result.applied, true)
  assert.equal(f.disk('src/b.ts'), '// resolved\n// applied\nconst b = 2\n')
  assert.equal(f.got('codeAction/resolve').length, 1)
})

test('workspace/applyEdit with no command of the host running is refused; the file stays', async (t) => {
  const f = setup(['--apply-unasked'])
  t.after(f.done)
  const a = page(f.m, 'src/a.ts', 'const a = 1\n')
  a.open()
  await until(() => f.answers('workspace/applyEdit').length === 1, 5000, 'applyEdit answer')
  const ans = f.answers('workspace/applyEdit')[0].result
  assert.equal(ans.applied, false)
  assert.match(ans.failureReason, /only while a command it ran is working/)
  assert.equal(f.disk('src/b.ts'), 'const b = 2\n')
})

test('format: the server edits applied through the owner page, also when another view asks', async (t) => {
  const f = setup()
  t.after(f.done)
  const a = page(f.m, 'src/a.ts', 'const a = 1\n')
  const b = page(f.m, 'src/a.ts', 'const a = 1\n')
  a.open()
  b.open()
  await ready(f)
  const r = await f.m.ask(b, 'format', 'src/a.ts', { tabSize: 4, insertSpaces: true })
  assert.deepEqual(r.result, { applied: true, files: 1, edits: 1 })
  assert.equal(a.text, '// formatted\nconst a = 1\n')
  assert.equal(b.edits.length, 0)
  assert.deepEqual(f.got('textDocument/formatting')[0].in.params.options, { tabSize: 4, insertSpaces: true })
})

test('features: a ready server tells the page what it offers and its trigger characters', async (t) => {
  const f = setup()
  t.after(f.done)
  const a = page(f.m, 'src/a.ts', 'x')
  a.open()
  await ready(f)
  const st = await until(() => [...a.posts].reverse().find((p) => p.t === 'lsp-status' && p.state === 'ready'), 5000, 'ready status')
  assert.equal(st.features.hover, true)
  assert.equal(st.features.rename, true)
  assert.equal(st.features.codeActions, true)
  assert.deepEqual(st.features.completeTriggers, ['.'])
  assert.deepEqual(st.features.signatureTriggers, ['('])
})

// ---- the page line (serve.js) ----

function fakeTab() {
  const posts = []
  const closers = []
  return {
    id: 't1',
    view: undefined,
    posts,
    post: (m) => posts.push(m),
    onClose: (fn) => closers.push(fn),
    close: () => closers.forEach((fn) => fn()),
    last: (t) => [...posts].reverse().find((p) => p.t === t),
  }
}

test('serveLsp: the page\'s seq reaches the document; lsp-edit carries it and lsp-edit-done answers; a silent page times out; a closed one refuses', async (t) => {
  const f = setup()
  t.after(f.done)
  const tab = fakeTab()
  const handle = serveLsp(tab, f.m)
  handle({ t: 'lsp-open', path: 'src/a.ts', part: 0, parts: 1, text: 'const a = 1\n', seq: 1 })
  const doc = [...f.m.docs.values()][0]
  assert.equal(doc.seq, 1)
  handle({ t: 'lsp-change', path: 'src/a.ts', changes: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, text: 'b' }], seq: 2 })
  assert.equal(doc.seq, 2)
  assert.equal(doc.text, 'const b = 1\n')
  const edits = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '// x\n' }]
  const p = doc.owner.applyEdits('src/a.ts', edits, doc.seq, 2000)
  const sent = tab.last('lsp-edit')
  assert.deepEqual({ ...sent, id: 0 }, { t: 'lsp-edit', id: 0, path: 'src/a.ts', seq: 2, edits })
  handle({ t: 'lsp-edit-done', id: sent.id, applied: true })
  assert.deepEqual(await p, { applied: true })
  // An answer for an id nobody waits for is ignored.
  handle({ t: 'lsp-edit-done', id: 12345, applied: true })
  const slow = await doc.owner.applyEdits('src/a.ts', edits, 2, 30)
  assert.equal(slow.applied, false)
  assert.match(slow.reason, /did not answer in time \(it may still apply its part/)
  // Its late "applied" is told to the page: its buffer holds a part the rest of the edit lacks.
  handle({ t: 'lsp-edit-done', id: tab.last('lsp-edit').id, applied: true })
  assert.match(tab.last('lsp-error').message, /applied here after the editor stopped waiting/)
  const late = doc.owner.applyEdits('src/a.ts', edits, 2, 2000)
  const holder = doc.owner
  tab.close()
  assert.deepEqual(await late, { applied: false, reason: 'the page is gone' })
  assert.deepEqual(await holder.applyEdits('src/a.ts', edits, 2, 2000), { applied: false, reason: 'the page is gone' })
})

// ---- the host: outside tabs ----

test('host: a definition outside the project opens a read-only tab; a path no server returned is refused', async (t) => {
  const host = require('../dist/host.js')
  const { root, outside } = project()
  const log = path.join(root, '..', `${path.basename(root)}.hostlog`)
  const open = []
  const openers = []
  const provided = {}
  const ctx = {
    projectDir: root,
    settings: { app: { servers: serverRow(log, ['--outside', outside]) } },
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    processes: { spawn },
    services: { provide: (n, impl) => (provided[n] = impl) },
    cli: { register() {} },
    overlay: { start: () => ({ result: new Promise(() => {}) }) },
    log: { info() {}, warn() {} },
    tabs: {
      onOpen: (type, fn) => openers.push(fn),
      list: async () => open.map((x) => ({ ...x })),
      openPage: async (type, params, options) => {
        const id = `tab-${open.length + 1}`
        open.push({ id, type, params, title: options.title })
        return id
      },
      focus: async () => {},
    },
  }
  host.activate(ctx)
  t.after(async () => {
    await host.deactivate()
    cleanup(root, outside, log)
  })
  await provided.editor.open('src/a.ts')
  const posted = []
  const listeners = []
  const tab = { id: open[0].id, type: 'file', params: open[0].params, view: undefined, post: (m) => posted.push(m), onMessage: (fn) => listeners.push(fn), onClose: () => {}, setTitle: async () => {} }
  for (const o of openers) o(tab)
  const send = (m) => listeners.forEach((l) => l(m))
  // A path no server named: refused, no tab.
  send({ t: 'openFile', outside, line: 3 })
  await until(() => posted.find((m) => m.t === 'search-error'), 2000, 'refusal')
  assert.match(posted.find((m) => m.t === 'search-error').message, /only a location a language server returned/)
  assert.equal(open.length, 1)
  // The server returns it as a definition: then it opens, read-only, at the line.
  send({ t: 'lsp-open', path: 'src/a.ts', part: 0, parts: 1, text: 'const a = 1\n', seq: 1 })
  await until(() => posted.find((m) => m.t === 'lsp-status' && m.state === 'ready'), 5000, 'ready')
  send({ t: 'lsp-ask', req: 1, what: 'definition', path: 'src/a.ts', position: { line: 0, character: 6 } })
  const ans = await until(() => posted.find((m) => m.t === 'lsp-answer' && m.req === 1), 5000, 'definition')
  assert.equal(ans.result[1].outside, outside)
  send({ t: 'openFile', outside, line: 3, col: 1 })
  await until(() => open.length === 2, 2000, 'outside tab')
  assert.deepEqual(open[1].params, { outside, line: 3, col: 1 })
  assert.equal(open[1].title, 'lib.d.ts')
})

/**
 * The host (dist/host.js) over a fake ctx whose ctx.processes runs the fake server, as the
 * lsp-features host test above, plus the ctx.sessions and ctx.onSettingsChange a test drives
 * (`sessions(list)`, `settingsChanged()`). `spawned` records every argv the host ran; `connect(rel)`
 * opens a file tab through the editor service and mounts one page frame on it. Deactivated and its
 * temp folders removed after the test.
 */
async function hostSetup(t, flagsFor = () => []) {
  const host = require('../dist/host.js')
  const { root, outside } = project()
  const log = path.join(root, '..', `${path.basename(root)}.hostlog`)
  const open = []
  const openers = []
  const provided = {}
  const spawned = []
  let sessionsListener = null
  let settingsListener = null
  const ctx = {
    projectDir: root,
    settings: { app: { servers: serverRow(log, flagsFor(outside)) } },
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    processes: { spawn: (argv, o) => (spawned.push(argv), spawn(argv, o)) },
    services: { provide: (n, impl) => (provided[n] = impl) },
    cli: { register() {} },
    overlay: { start: () => ({ result: new Promise(() => {}) }) },
    log: { info() {}, warn() {} },
    sessions: { onChange: (fn) => ((sessionsListener = fn), () => {}) },
    onSettingsChange: (fn) => ((settingsListener = fn), () => {}),
    tabs: {
      onOpen: (type, fn) => openers.push(fn),
      list: async () => open.map((x) => ({ ...x })),
      openPage: async (type, params, options) => {
        const id = `tab-${open.length + 1}`
        open.push({ id, type, params, title: options.title })
        return id
      },
      focus: async () => {},
    },
  }
  host.activate(ctx)
  t.after(async () => {
    await host.deactivate()
    cleanup(root, outside, log)
  })
  const parse = (l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  }
  const read = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(parse).filter(Boolean) : [])
  const got = (method) => read().filter((e) => e.in && e.in.method === method)
  const connect = async (rel) => {
    await provided.editor.open(rel)
    const o = open.find((x) => x.params.path === rel)
    const posted = []
    const listeners = []
    const tab = { id: o.id, type: 'file', params: o.params, view: undefined, post: (m) => posted.push(m), onMessage: (fn) => listeners.push(fn), onClose: () => {}, setTitle: async () => {} }
    for (const fn of openers) fn(tab)
    return { posted, send: (m) => listeners.forEach((l) => l(m)) }
  }
  return {
    ctx,
    root,
    outside,
    open,
    spawned,
    read,
    got,
    connect,
    sessions: (list) => sessionsListener(list),
    settingsChanged: () => settingsListener(ctx.settings),
  }
}

/** A mounted page frame showing `rel` whose language server is ready (and has registered its file watch). */
async function readyPage(h, rel) {
  const view = await h.connect(rel)
  // The page's first load: serveFileTab reads the file and watches its folder (the folder events below).
  view.send({ t: 'open', req: 1, first: true })
  view.send({ t: 'lsp-open', path: rel, part: 0, parts: 1, text: fs.readFileSync(path.join(h.root, rel), 'utf8'), seq: 1 })
  await until(() => view.posted.find((m) => m.t === 'lsp-status' && m.state === 'ready'), 5000, 'ready')
  // The fake registers workspace/didChangeWatchedFiles right after `initialized`; without that
  // registration the manager sends it nothing. The fake logs the host's answer once it has it.
  await until(() => h.read().some((e) => e.answer && e.answer.method === 'client/registerCapability'), 5000, 'registration answered')
  return view
}

test('host: folder events and the Claude tabs\' files (ctx.sessions) reach the server; new tabs, a status move, growth, vanished tabs', async (t) => {
  const h = await hostSetup(t)
  // Claude's files sit in lib/, which no file tab shows: no folder watch there, so every change the
  // server hears about a lib/ file came through ctx.sessions.
  const lib = path.join(h.root, 'lib')
  fs.mkdirSync(lib)
  const L = (n) => path.join(lib, `l${n}.ts`)
  const libUri = pathToFileURL(lib).href + '/'
  /** The lib/ files of each didChangeWatchedFiles the server got (folder-event-only ones left out). */
  const libBatches = () =>
    h
      .got('workspace/didChangeWatchedFiles')
      .map((e) => e.in.params.changes.map((c) => c.uri).filter((u) => u.startsWith(libUri)).map((u) => u.slice(libUri.length)).sort())
      .filter((b) => b.length > 0)
  let rounds = 0
  let size = 0
  /**
   * Every lib/ file is rewritten (a new size) before each ctx.sessions change: the manager skips a
   * file unchanged since it last told the server, so a file the host wrongly passes on is always
   * sent, and shows up in this round's or the next round's batch. A round expecting nothing is
   * checked by the next one: its batch must be exactly that round's files.
   */
  const round = async (list, expect) => {
    size++
    for (let n = 0; n <= 4; n++) fs.writeFileSync(L(n), 'x'.repeat(size))
    h.sessions(list)
    if (!expect) return
    rounds++
    await until(() => libBatches().length >= rounds, 5000, `batch ${rounds}`)
    assert.deepEqual(libBatches()[rounds - 1], expect, `round ${rounds}`)
  }
  const s = (tabId, status, ...ns) => ({ tabId, status, files: ns.map(L) })

  // No server yet (no document of its language open): nothing sent, but the tab's count is kept.
  await round([s('T0', 'busy', 0)])
  const view = await readyPage(h, 'src/a.ts')

  // A folder event of a watched folder (src/, the open tab's): a new file reaches the server.
  fs.writeFileSync(path.join(h.root, 'src/w.ts'), 'export const w = 1\n')
  const wUri = pathToFileURL(path.join(h.root, 'src/w.ts')).href
  await until(() => h.got('workspace/didChangeWatchedFiles').some((e) => e.in.params.changes.some((c) => c.uri === wUri)), 5000, 'folder event')

  // T0 grew (its first file, listed while no server ran, is not sent now); T1 is new: all of it.
  await round([s('T0', 'busy', 0, 4), s('T1', 'busy', 1)], ['l1.ts', 'l4.ts'])
  // T1 grew by one: only the new file (an off-by-one in the slice sends l1 again, or nothing).
  await round([s('T0', 'busy', 0, 4), s('T1', 'busy', 1, 2)], ['l2.ts'])
  // T1's status moved (a turn ended): all its files again, whatever the count.
  await round([s('T0', 'busy', 0, 4), s('T1', 'waiting', 1, 2)], ['l1.ts', 'l2.ts'])
  // Nothing moved for T0 and T1: nothing of theirs; T2 is new; malformed entries are skipped.
  await round([s('T0', 'busy', 0, 4), s('T1', 'waiting', 1, 2), s('T2', 'busy', 3), { tabId: 'T9', status: 'busy' }, null], ['l3.ts'])
  // T0 and T1 are gone: forgotten (T2 the same: nothing).
  await round([s('T2', 'busy', 3)])
  // Back with the same id: a new tab again, all its files; T2 still nothing.
  await round([s('T0', 'busy', 0), s('T1', 'waiting', 1), s('T2', 'busy', 3)], ['l0.ts', 'l1.ts'])
  assert.ok(view.posted.some((m) => m.t === 'lsp-status' && m.state === 'ready'))
})

test('host: a settings change hands the servers setting to the language servers; a changed argv restarts the server', async (t) => {
  const h = await hostSetup(t)
  const view = await readyPage(h, 'src/a.ts')
  assert.equal(h.spawned.length, 1)
  assert.equal(view.posted.findLast((m) => m.t === 'lsp-status').features.hover, true)
  // The same setting saved again: nothing restarts.
  h.settingsChanged()
  // A new argv (no hover): the server restarts with it and gets its document back.
  h.ctx.settings = { app: { ...h.ctx.settings.app, servers: [{ ...h.ctx.settings.app.servers[0], argv: [...h.ctx.settings.app.servers[0].argv, '--no-hover'] }] } }
  h.settingsChanged()
  const st = await until(() => {
    const last = view.posted.findLast((m) => m.t === 'lsp-status')
    return last && last.state === 'ready' && last.features.hover === false ? last : null
  }, 5000, 'ready again without hover')
  assert.equal(st.features.rename, true)
  assert.equal(h.spawned.length, 2)
  assert.equal(h.spawned[1].at(-1), '--no-hover')
  await until(() => h.got('textDocument/didOpen').length === 2, 5000, 'document reopened')
  assert.equal(h.got('initialize').length, 2)
})

test('host: an outside location whose path is over 3000 characters is refused with its own error, no tab', async (t) => {
  // main caps a tab's params at 4 KiB; the server returned the path, so only the length refuses it.
  let long = ''
  const h = await hostSetup(t, (outside) => {
    long = path.join(path.dirname(outside), ...Array(15).fill('d'.repeat(200)), 'lib.d.ts')
    return ['--outside', long]
  })
  assert.ok(long.length > 3000)
  const view = await readyPage(h, 'src/a.ts')
  view.send({ t: 'lsp-ask', req: 1, what: 'definition', path: 'src/a.ts', position: { line: 0, character: 6 } })
  const ans = await until(() => view.posted.find((m) => m.t === 'lsp-answer' && m.req === 1), 5000, 'definition')
  assert.equal(ans.result[1].outside, long)
  view.send({ t: 'openFile', outside: long, line: 3 })
  const err = await until(() => view.posted.find((m) => m.t === 'search-error'), 5000, 'refusal')
  assert.deepEqual(err, { t: 'search-error', kind: 'open', message: 'the path is too long to open in a tab' })
  assert.equal(h.open.length, 1)
})

// ---- review round: edits against moving documents, disk and names ----

const one = (l1 = 0, c1 = 6, l2 = 0, c2 = 7, newText = 'z') => [{ range: { start: { line: l1, character: c1 }, end: { line: l2, character: c2 } }, newText }]
const uriOf = (f, rel) => pathToFileURL(path.join(f.root, rel)).href

test('applyTextEdits: \\r, \\n and \\r\\n are all line breaks; a character past the end stops before the break', () => {
  const text = 'a\rbb\r\nc\nd'
  assert.equal(applyTextEdits(text, one(1, 9, 1, 9, '!')), 'a\rbb!\r\nc\nd')
  assert.equal(applyTextEdits(text, one(2, 0, 2, 1, 'C')), 'a\rbb\r\nC\nd')
  assert.equal(applyTextEdits(text, one(3, 0, 3, 1, 'D')), 'a\rbb\r\nc\nD')
  assert.throws(() => applyTextEdits(text, one(4, 0, 4, 0, 'x')), /outside the file/)
})

test('a second open file whose page typed while the first page applied its part is refused, its stale seq never sent', async (t) => {
  const f = setup()
  t.after(f.done)
  const a = page(f.m, 'src/a.ts', 'const a = 1\n')
  const b = page(f.m, 'src/b.ts', 'const b = 2\n')
  a.open()
  b.open()
  await ready(f)
  const asked = f.m.versions()
  const applyA = a.applyEdits
  // While the host waits for a's page, b's page types (its change reaches the host).
  a.applyEdits = async (...args) => {
    b.text = 'const b = 20\n'
    f.m.change(b, 'src/b.ts', [{ text: b.text }], ++b.seq)
    return applyA(...args)
  }
  const r = await applyWorkspaceEdit(f.m, { changes: { [uriOf(f, 'src/a.ts')]: one(), [uriOf(f, 'src/b.ts')]: one() } }, { versions: asked })
  assert.equal(r.applied, false)
  assert.match(r.failureReason, /src\/b\.ts: changed while the edit was applied/)
  assert.deepEqual([r.failedChange, r.files], [1, 1])
  assert.equal(b.edits.length, 0)
  assert.equal(b.text, 'const b = 20\n')
})

test('a file open when the host asked and closed since is refused, not written from disk', async (t) => {
  const f = setup()
  t.after(f.done)
  const b = page(f.m, 'src/b.ts', 'const bb = 2\n')
  b.open()
  await ready(f)
  const asked = f.m.versions()
  f.m.close(b, 'src/b.ts')
  const r = await applyWorkspaceEdit(f.m, { changes: { [uriOf(f, 'src/b.ts')]: one() } }, { versions: asked })
  assert.match(r.failureReason, /src\/b\.ts was closed while the language server worked/)
  assert.equal(f.disk('src/b.ts'), 'const b = 2\n')
})

test('a file closed and opened again gets a new version: an edit computed before the close does not match it', async (t) => {
  const f = setup()
  t.after(f.done)
  const a = page(f.m, 'src/a.ts', 'const a = 1\n')
  a.open()
  await ready(f)
  const asked = f.m.versions()
  f.m.close(a, 'src/a.ts')
  a.text = 'let other = 1\n'
  a.open()
  assert.notEqual([...f.m.docs.values()][0].version, asked.get(uriOf(f, 'src/a.ts')))
  const r = await applyWorkspaceEdit(f.m, { changes: { [uriOf(f, 'src/a.ts')]: one() } }, { versions: asked })
  assert.match(r.failureReason, /changed while the language server worked/)
  assert.equal(a.text, 'let other = 1\n')
})

test("an ownership handoff clears the seq: an edit before the new owner's text lands names none", async (t) => {
  const f = setup()
  t.after(f.done)
  const a = page(f.m, 'src/a.ts', 'const a = 1\n')
  const b = page(f.m, 'src/a.ts', 'const a = 1\n')
  a.open()
  b.open()
  const doc = [...f.m.docs.values()][0]
  assert.equal(doc.seq, 1)
  f.m.close(a, 'src/a.ts')
  assert.equal(doc.owner, b)
  assert.equal(doc.seq, undefined)
  b.open() // its lsp-open after the resync
  assert.equal(doc.seq, 2)
})

test('a disk file written after the host asked is refused; a lost concurrent write is reported with the file counted', async (t) => {
  const f = setup()
  t.after(f.done)
  const since = Date.now()
  await sleep(30)
  fs.writeFileSync(path.join(f.root, 'src/b.ts'), 'const bb = 2\n')
  let r = await applyWorkspaceEdit(f.m, { changes: { [uriOf(f, 'src/b.ts')]: one() } }, { since })
  assert.match(r.failureReason, /changed on disk while the language server worked/)
  assert.equal(f.disk('src/b.ts'), 'const bb = 2\n')
  // saveFile's `written` answer: the edit IS on disk, another write into the old file is lost.
  const save = files.saveFile
  files.saveFile = (...args) => ({ ...save(...args), result: 'changed', written: true })
  t.after(() => (files.saveFile = save))
  r = await applyWorkspaceEdit(f.m, { changes: { [uriOf(f, 'src/b.ts')]: one(), [uriOf(f, 'src/a.ts')]: one() } }, { since: Date.now() })
  files.saveFile = save
  assert.deepEqual([r.applied, r.files, r.edits, r.failedChange], [false, 1, 1, 0])
  assert.match(r.failureReason, /the edit was written, but another program wrote the file/)
  assert.equal(f.disk('src/b.ts'), 'const zb = 2\n')
  assert.equal(f.disk('src/a.ts'), 'const a = 1\n')
})

test("open files are applied before disk files: a page refusing leaves the disk untouched, the index is the server's", async (t) => {
  const f = setup()
  t.after(f.done)
  const a = page(f.m, 'src/a.ts', 'const a = 1\n')
  a.open()
  await ready(f)
  a.refuse = 'the file changed while the language server worked; try again'
  const r = await applyWorkspaceEdit(f.m, { documentChanges: [{ textDocument: { uri: uriOf(f, 'src/b.ts'), version: null }, edits: one() }, { textDocument: { uri: uriOf(f, 'src/a.ts'), version: null }, edits: one() }] })
  assert.deepEqual([r.applied, r.failedChange, r.files], [false, 1, 0])
  assert.equal(f.disk('src/b.ts'), 'const b = 2\n')
})

test("one file under two names (a symlinked folder) is one file: twice refused, and the open document takes the alias's edit", async (t) => {
  const f = setup()
  t.after(f.done)
  fs.symlinkSync(path.join(f.root, 'src'), path.join(f.root, 'alias'))
  let r = await applyWorkspaceEdit(f.m, { changes: { [uriOf(f, 'src/b.ts')]: one(), [uriOf(f, 'alias/b.ts')]: one(0, 10, 0, 11, '3') } })
  assert.match(r.failureReason, /changed twice/)
  assert.equal(f.disk('src/b.ts'), 'const b = 2\n')
  const a = page(f.m, 'src/a.ts', 'const a = 1\n')
  a.open()
  await ready(f)
  r = await applyWorkspaceEdit(f.m, { changes: { [uriOf(f, 'alias/a.ts')]: one() } })
  assert.equal(r.applied, true)
  assert.equal(a.text, 'const z = 1\n')
  assert.equal(f.disk('src/a.ts'), 'const a = 1\n')
})

test('runCodeAction: a page that gave up (its signal aborted) gets nothing applied', async (t) => {
  const f = setup()
  t.after(f.done)
  const a = page(f.m, 'src/a.ts', 'const a = 1\n')
  a.open()
  await ready(f)
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }
  const list = (await f.m.ask(a, 'codeActions', 'src/a.ts', { range })).result
  const ctl = new AbortController()
  ctl.abort()
  await assert.rejects(f.m.ask(a, 'runCodeAction', 'src/a.ts', { id: list[0].id }, ctl.signal), /cancelled/)
  assert.equal(a.text, 'const a = 1\n')
  assert.equal(a.edits.length, 0)
})

test('a cancel while a page applies its part: that part finishes, no later file is touched, the answer names what changed', async (t) => {
  const f = setup()
  t.after(f.done)
  const a = page(f.m, 'src/a.ts', 'const a = 1\n')
  const b = page(f.m, 'src/b.ts', 'const b = 2\n')
  a.open()
  b.open()
  await ready(f)
  fs.writeFileSync(path.join(f.root, 'src/c.ts'), 'const c = 3\n')
  const ctl = new AbortController()
  const applyA = a.applyEdits
  // The page gives up (its deadline, Esc) while the host waits for a's part.
  a.applyEdits = async (...args) => {
    ctl.abort()
    return applyA(...args)
  }
  const edit = { changes: { [uriOf(f, 'src/a.ts')]: one(), [uriOf(f, 'src/b.ts')]: one(), [uriOf(f, 'src/c.ts')]: one() } }
  const r = await applyWorkspaceEdit(f.m, edit, { signal: ctl.signal })
  assert.deepEqual([r.applied, r.files, r.edits, r.failedChange], [false, 1, 1, 1])
  assert.equal(r.failureReason, 'cancelled part way: changed src/a.ts; the other 2 files were not changed')
  assert.equal(a.text, 'const z = 1\n')
  assert.equal(b.edits.length, 0)
  assert.equal(b.text, 'const b = 2\n')
  assert.equal(f.disk('src/c.ts'), 'const c = 3\n')
  // Aborted before anything: plain `cancelled`, nothing counted.
  const r2 = await applyWorkspaceEdit(f.m, edit, { signal: ctl.signal })
  assert.deepEqual(r2, { applied: false, failureReason: 'cancelled', files: 0, edits: 0 })
})

test('serveLsp: an edit ask the page stopped waiting for still tells the page what it changed', async () => {
  const tab = fakeTab()
  const answers = []
  const manager = { ask: () => new Promise((resolve) => answers.push(resolve)), closeHolder() {} }
  const handle = serveLsp(tab, manager)
  // Part way: cancelled after a's part.
  handle({ t: 'lsp-ask', req: 1, what: 'rename', path: 'src/a.ts' })
  handle({ t: 'lsp-cancel', req: 1 })
  answers[0]({ result: { applied: false, failureReason: 'cancelled part way: changed src/a.ts; the other 2 files were not changed', files: 1, edits: 1 } })
  await sleep(0)
  assert.equal(tab.posts.filter((p) => p.t === 'lsp-answer').length, 0)
  assert.deepEqual(tab.last('lsp-error'), { t: 'lsp-error', path: 'src/a.ts', message: 'rename: cancelled part way: changed src/a.ts; the other 2 files were not changed' })
  // All of it landed just after the page gave up.
  handle({ t: 'lsp-ask', req: 2, what: 'format', path: 'src/a.ts' })
  handle({ t: 'lsp-cancel', req: 2 })
  answers[1]({ result: { applied: true, files: 1, edits: 3 } })
  await sleep(0)
  assert.match(tab.last('lsp-error').message, /^format: applied after the editor stopped waiting \(3 changes in 1 file\)/)
  // Nothing changed (a hover, a refused edit): nothing to tell.
  const before = tab.posts.length
  handle({ t: 'lsp-ask', req: 3, what: 'rename', path: 'src/a.ts' })
  handle({ t: 'lsp-cancel', req: 3 })
  answers[2]({ result: { applied: false, failureReason: 'cancelled', files: 0, edits: 0 } })
  handle({ t: 'lsp-ask', req: 4, what: 'hover', path: 'src/a.ts' })
  handle({ t: 'lsp-cancel', req: 4 })
  answers[3]({ result: { contents: 'x' } })
  await sleep(0)
  assert.equal(tab.posts.length, before)
})

// ---- a server's commands: one at a time, each with its own snapshot and stop ----

/** The ready slot, its server and a fake.apply command editing `rels` (fake-lsp.mjs). */
function commands(f) {
  const slot = f.m.slots.get('typescript')
  const run = (rels, signal) => f.m.executeCommand(slot, slot.server, { command: 'fake.apply', arguments: rels.map((r) => uriOf(f, r)) }, signal)
  return { slot, run }
}

test("commands: a second one on the server is refused while one runs; the first's applyEdit is checked against its own snapshot", async (t) => {
  const f = setup(['--apply-delay', '300'])
  t.after(f.done)
  const a = page(f.m, 'src/a.ts', 'const a = 1\n')
  a.open()
  await ready(f)
  const c = commands(f)
  const first = c.run(['src/a.ts'])
  await until(() => f.got('workspace/executeCommand').length === 1, 5000, 'command sent')
  // The page types while the first command works: its applyEdit (computed on the old text) must not land.
  a.text = 'const a = 10\n'
  a.seq++
  f.m.change(a, 'src/a.ts', [{ text: a.text }], a.seq)
  // A second command would take a newer snapshot, and the server's applyEdit names no command: refused.
  await assert.rejects(c.run(['src/b.ts']), /another command of this language server is still running/)
  assert.equal(f.got('workspace/executeCommand').length, 1)
  assert.deepEqual(await first, { files: 0, edits: 0 })
  const ans = f.answers('workspace/applyEdit')
  assert.equal(ans.length, 1)
  assert.equal(ans[0].result.applied, false)
  assert.match(ans[0].result.failureReason, /changed while the language server worked/)
  assert.equal(a.text, 'const a = 10\n')
  assert.equal(a.edits.length, 0)
  // The first answered: the next one runs, against the text as it is now.
  assert.equal(c.slot.command, null)
  assert.deepEqual(await c.run(['src/a.ts']), { files: 1, edits: 1 })
  assert.equal(a.text, '// applied\nconst a = 10\n')
})

test("commands: a cancel stops the server's edits before their next file and counts what changed; a stopped command holds the server until it answers", async (t) => {
  const f = setup(['--apply-delay', '300'])
  t.after(f.done)
  const a = page(f.m, 'src/a.ts', 'const a = 1\n')
  a.open()
  await ready(f)
  fs.writeFileSync(path.join(f.root, 'src/c.ts'), 'const c = 3\n')
  const c = commands(f)
  // The page gives up while a's part of the server's edit is applied: b and c are not touched.
  const ctl = new AbortController()
  const applyA = a.applyEdits
  a.applyEdits = async (...args) => {
    ctl.abort()
    return applyA(...args)
  }
  const e = await c.run(['src/a.ts', 'src/b.ts', 'src/c.ts'], ctl.signal).then(
    () => null,
    (x) => x,
  )
  assert.match(e.message, /cancelled/)
  assert.deepEqual(e.changed, { files: 1, edits: 1 })
  assert.equal(a.text, '// applied\nconst a = 1\n')
  assert.equal(f.disk('src/b.ts'), 'const b = 2\n')
  assert.equal(f.disk('src/c.ts'), 'const c = 3\n')
  await until(() => f.answers('workspace/applyEdit').length === 1, 5000, 'applyEdit answer')
  assert.match(f.answers('workspace/applyEdit')[0].result.failureReason, /^cancelled part way: changed src\/a\.ts/)
  a.applyEdits = applyA
  await until(() => c.slot.command === null, 5000, 'the late answer')
  // Cancelled before the server asked: it still works on it, so the server is held until it
  // answers; its late applyEdit is refused.
  const ctl2 = new AbortController()
  const stopped = c.run(['src/b.ts'], ctl2.signal)
  await until(() => f.got('workspace/executeCommand').length === 2, 5000, 'second command sent')
  ctl2.abort()
  await assert.rejects(stopped, /cancelled/)
  await assert.rejects(c.run(['src/b.ts']), /has not finished a command it was asked to stop/)
  await until(() => f.answers('workspace/applyEdit').length === 2, 5000, 'late applyEdit answer')
  assert.deepEqual(f.answers('workspace/applyEdit')[1].result, { applied: false, failureReason: 'the command this edit belongs to was stopped' })
  assert.equal(f.disk('src/b.ts'), 'const b = 2\n')
  await until(() => c.slot.command === null, 5000, 'the late answer')
  assert.deepEqual(await c.run(['src/b.ts']), { files: 1, edits: 1 })
  assert.equal(f.disk('src/b.ts'), '// applied\nconst b = 2\n')
})

test('runCodeAction: an edit applied and then its command stopped is an answer counting the files (told to a page that gave up); a busy server refuses before the edit', async (t) => {
  const f = setup(['--apply-delay', '300', '--action-with-command'])
  t.after(f.done)
  const a = page(f.m, 'src/a.ts', 'const a = 1\n')
  a.open()
  await ready(f)
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }
  const offer = async () => (await f.m.ask(a, 'codeActions', 'src/a.ts', { range })).result.find((x) => x.title === 'Header then apply')
  const ctl = new AbortController()
  const running = f.m.ask(a, 'runCodeAction', 'src/a.ts', { id: (await offer()).id }, ctl.signal)
  await until(() => f.got('workspace/executeCommand').length === 1, 5000, 'command sent')
  // Another view's code action with a command while this one runs: refused, its edit not applied.
  const other = page(f.m, 'src/b.ts', 'const b = 2\n')
  other.open()
  const otherId = (await f.m.ask(other, 'codeActions', 'src/b.ts', { range })).result.find((x) => x.title === 'Header then apply').id
  await assert.rejects(f.m.ask(other, 'runCodeAction', 'src/b.ts', { id: otherId }), /still running/)
  assert.equal(other.edits.length, 0)
  ctl.abort()
  const r = await running
  assert.deepEqual([r.result.applied, r.result.files, r.result.edits], [false, 1, 1])
  assert.equal(r.result.failureReason, 'the action changed 1 file (1 change), but its command did not finish: cancelled')
  assert.equal(a.text, '// header\nconst a = 1\n')
  // serve.js tells a page that stopped waiting about an answer like this one (lateEdit).
  const tab = fakeTab()
  const handle = serveLsp(tab, { ask: async () => r, closeHolder() {} })
  handle({ t: 'lsp-ask', req: 1, what: 'runCodeAction', path: 'src/a.ts' })
  handle({ t: 'lsp-cancel', req: 1 })
  await sleep(0)
  assert.equal(tab.last('lsp-error').message, 'runCodeAction: the action changed 1 file (1 change), but its command did not finish: cancelled')
})

test("runCodeAction: a command-only action checks the server's edits against the text it was offered on, not the text at its run", async (t) => {
  const f = setup()
  t.after(f.done)
  const a = page(f.m, 'src/a.ts', 'const a = 1\n')
  a.open()
  const b = page(f.m, 'src/b.ts', 'const b = 2\n')
  b.open()
  await ready(f)
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }
  // Offered on "const b = 2"; the person types in b before running it (fake.apply edits b).
  const id = (await f.m.ask(a, 'codeActions', 'src/a.ts', { range })).result.find((x) => x.title === 'Run fake.apply').id
  b.text = 'X' + b.text
  b.seq++
  f.m.change(b, 'src/b.ts', [{ text: b.text }], b.seq)
  const r = await f.m.ask(a, 'runCodeAction', 'src/a.ts', { id })
  assert.deepEqual([r.result.files, r.result.edits], [0, 0])
  const ans = f.answers('workspace/applyEdit')
  assert.equal(ans.length, 1)
  assert.equal(ans[0].result.applied, false)
  assert.match(ans[0].result.failureReason, /changed while the language server worked/)
  assert.equal(b.text, 'Xconst b = 2\n')
  assert.equal(b.edits.length, 0)
  // Offered again on the text as it is now: it applies.
  const again = (await f.m.ask(a, 'codeActions', 'src/a.ts', { range })).result.find((x) => x.title === 'Run fake.apply').id
  const ok = await f.m.ask(a, 'runCodeAction', 'src/a.ts', { id: again })
  assert.deepEqual([ok.result.applied, ok.result.files], [true, 1])
  assert.equal(b.text, '// applied\nXconst b = 2\n')
})

test('commands: a stopped command the server never answers is told to the page (held) and Restart frees the server', async (t) => {
  const f = setup(['--hang-command'], { heldNoticeMs: 50 })
  t.after(f.done)
  const a = page(f.m, 'src/a.ts', 'const a = 1\n')
  a.open()
  await ready(f)
  const slot = f.m.slots.get('typescript')
  const first = slot.server
  // A live server with no stuck command: Restart refused (a page cannot churn a working server).
  assert.equal(f.m.restart(a, 'typescript'), false)
  const ctl = new AbortController()
  const hung = f.m.executeCommand(slot, first, { command: 'fake.other' }, ctl.signal)
  await until(() => f.got('workspace/executeCommand').length === 1, 5000, 'command sent')
  ctl.abort()
  await assert.rejects(hung, /cancelled/)
  await assert.rejects(f.m.executeCommand(slot, first, { command: 'fake.apply', arguments: [] }), /has not finished a command it was asked to stop/)
  await until(() => a.posts.some((p) => p.t === 'lsp-status' && p.held), 5000, 'held status')
  const held = a.last('lsp-status')
  assert.equal(held.state, 'ready')
  assert.match(held.held, /has not answered a command it was asked to stop/)
  // Restart: the held server stops and a new one starts with the document; commands run again.
  assert.equal(f.m.restart(a, 'typescript'), true)
  await until(() => slot.server && slot.server !== first && slot.state === 'ready', 5000, 'restarted')
  assert.equal(slot.command, null)
  assert.equal(a.last('lsp-status').held, undefined)
  assert.equal(f.m.restart(a, 'typescript'), false)
  assert.deepEqual(await f.m.executeCommand(slot, slot.server, { command: 'fake.apply', arguments: [uriOf(f, 'src/a.ts')] }), { files: 1, edits: 1 })
  assert.equal(a.text, '// applied\nconst a = 1\n')
})

test('outside paths: system trees and credential folders never open, whoever names them', () => {
  const home = (rel) => path.join(os.homedir(), rel)
  for (const p of [
    '/proc/self/environ', '/sys/kernel', '/dev/null', home('.ssh/id_ed25519'), home('.config/cc-cockpit/app.json'),
    home('.npmrc'), home('.git-credentials'), home('.pypirc'), home('.cargo/credentials.toml'), home('.cargo/credentials'),
    home('.bash_history'), home('.zsh_history'), home('.pgpass'),
    // No list names these: every hidden folder and file of the home is refused unless a toolchain's.
    home('.claude/.credentials.json'), home('.codex/auth.json'), home('.config/composer/auth.json'), home('.config/gh/hosts.yml'),
    home('.some-new-tool/token'), home('Projects/other/.env'), home('.local/share/keyrings/login.keyring'),
    home('.config/x/node_modules/pkg/index.d.ts'), home('.local/libfoo/x.py'), home('Library/Application Support/x/y.json'),
  ]) {
    assert.equal(files.outsideRefused(p), true, p)
  }
  // Where the supported servers return definitions: library and toolchain folders, node_modules anywhere
  // not behind another dot folder (a package's own .pnpm or .bin included), plain folders of the home.
  for (const p of [
    '/usr/lib/node_modules/x/index.d.ts', '/usr/lib/go/src/fmt/print.go', '/usr/lib/python3.12/os.py',
    home('.nvm/versions/node/v22.1.0/lib/node_modules/typescript/lib/lib.es5.d.ts'), home('.cache/typescript/5.6/node_modules/@types/node/fs.d.ts'),
    home('go/pkg/mod/github.com/x/y@v1.2.3/y.go'), home('.go/pkg/mod/golang.org/x/net@v0.1.0/a.go'), home('sdk/go1.23/src/fmt/print.go'),
    home('.composer/vendor/x/y/src/A.php'), home('.config/composer/vendor/jetbrains/phpstorm-stubs/standard/standard_0.php'),
    home('.local/lib/python3.12/site-packages/requests/api.py'), home('.pyenv/versions/3.12.1/lib/python3.12/os.py'),
    home('.local/share/uv/python/cpython-3.12/lib/python3.12/os.py'), home('.virtualenvs/app/lib/python3.12/site-packages/x.py'),
    home('.cargo/registry/src/index.crates.io-6f17d22bba15001f/serde-1.0.0/src/lib.rs'), home('.rustup/toolchains/stable/lib/rustlib/src/rust/library/std/src/lib.rs'),
    home('Projects/other/node_modules/.pnpm/x@1.0.0/node_modules/x/index.d.ts'), home('Projects/other/src/shared.ts'),
  ]) {
    assert.equal(files.outsideRefused(p), false, p)
  }
  assert.throws(() => files.readOutside('/proc/self/environ'), /not shown outside the project/)
  const m = Object.create(LspManager.prototype)
  m.outside = new Map()
  m.allowOutside('/proc/self/environ')
  assert.equal(m.allowsOutside('/proc/self/environ'), false)
})
