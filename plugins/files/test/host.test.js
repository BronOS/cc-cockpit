'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')

/** Every temp folder of this file goes after its last test: /tmp is often RAM, and runs add up. */
const made = []
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})

/** A new temp folder named `prefix` plus a random suffix, removed after the last test. */
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  made.push(dir)
  return dir
}

// The host against a fake ctx over a temp folder: only what the per-page replies need. `posts`
// records every ctx.panels.post (panel, message, options); `listeners` holds the panel's onMessage.
function fakeCtx(root) {
  const posts = []
  const listeners = []
  const ctx = {
    projectDir: root,
    settings: { app: {} },
    log: { info() {}, warn() {}, error() {} },
    storage: { get: async () => undefined, set: async () => {} },
    services: { use: () => ({ open: async () => {} }) },
    exec: (argv, opts) =>
      new Promise((resolve) => {
        execFile(argv[0], argv.slice(1), { cwd: opts && opts.cwd ? opts.cwd : root }, (err, stdout, stderr) => {
          resolve({ kind: 'exit', code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })
        })
      }),
    panels: {
      post: (panel, m, options) => posts.push([panel, m, options]),
      onMessage: (panel, fn) => {
        listeners.push(fn)
        return () => {}
      },
    },
    onSettingsChange: () => () => {},
    files: {},
    sessions: {},
    overlay: {},
  }
  return { ctx, posts, listeners }
}

function load() {
  delete require.cache[require.resolve('../dist/host')]
  return require('../dist/host')
}

test('a search answers only the page that asked; the error goes to it too', async () => {
  const root = fs.realpathSync(tempDir('files-host-'))
  fs.writeFileSync(path.join(root, 'needle.txt'), 'x\n')
  const host = load()
  const { ctx, posts, listeners } = fakeCtx(root)
  host.activate(ctx)
  await listeners[0]({ type: 'search', query: 'needle' }, { view: 'web:7' })
  const results = posts.filter((p) => p[1].type === 'results')
  assert.equal(results.length, 1)
  assert.deepEqual(results[0][2], { view: 'web:7' })
  assert.ok(results[0][1].paths.includes('needle.txt'))
  // The desktop page is a view too.
  await listeners[0]({ type: 'search', query: 'needle' }, { view: 'desktop' })
  assert.deepEqual(posts.filter((p) => p[1].type === 'results').at(-1)[2], { view: 'desktop' })
  // A failure of the request is shown on the page that made it only.
  await listeners[0]({ type: 'create', kind: 'file', dir: '..', name: 'x' }, { view: 'web:7' }).catch(() => {})
  const errors = posts.filter((p) => p[1].type === 'error')
  for (const e of errors) assert.deepEqual(e[2], { view: 'web:7' })
  host.deactivate()
})

test('tree state stays a broadcast, and an old caller with no second argument still works', async () => {
  const root = fs.realpathSync(tempDir('files-host-'))
  fs.writeFileSync(path.join(root, 'a.txt'), 'x\n')
  const host = load()
  const { ctx, posts, listeners } = fakeCtx(root)
  host.activate(ctx)
  await listeners[0]({ type: 'hello' }, { view: 'web:7' })
  const dirs = posts.filter((p) => p[1].type === 'dir')
  assert.ok(dirs.length > 0)
  for (const d of dirs) assert.equal(d[2], undefined)
  await listeners[0]({ type: 'search', query: 'a' })
  assert.equal(posts.filter((p) => p[1].type === 'results').at(-1)[2], undefined)
  host.deactivate()
})

test('download: the host calls ctx.files.download in the click, with the include flag, and shows a rejection', async () => {
  const root = fs.realpathSync(tempDir('files-host-'))
  const host = load()
  const { ctx, posts, listeners } = fakeCtx(root)
  const calls = []
  let fail = null
  ctx.files.download = async (...args) => {
    calls.push(args)
    if (fail) throw fail
  }
  host.activate(ctx)
  await listeners[0]({ type: 'hello' }, { view: 'web:7' })
  assert.equal(posts.find((p) => p[1].type === 'reset')[1].env.download, true)
  await listeners[0]({ type: 'download', path: 'a/b.txt' }, { view: 'web:7' })
  await listeners[0]({ type: 'download', path: 'a', all: true }, { view: 'web:7' })
  await listeners[0]({ type: 'download', path: '' }, { view: 'web:7' })
  assert.deepEqual(calls, [['a/b.txt', undefined], ['a', { includeGitAndNodeModules: true }], ['', undefined]])
  // A refusal reaches the page that clicked.
  fail = new Error('Too big to download.')
  await listeners[0]({ type: 'download', path: 'a' }, { view: 'web:7' })
  const err = posts.filter((p) => p[1].type === 'error').at(-1)
  assert.equal(err[1].message, 'Too big to download.')
  assert.deepEqual(err[2], { view: 'web:7' })
  host.deactivate()
})

test('download: an app without ctx.files.download says so in the env', async () => {
  const root = fs.realpathSync(tempDir('files-host-'))
  const host = load()
  const { ctx, posts, listeners } = fakeCtx(root)
  host.activate(ctx)
  await listeners[0]({ type: 'hello' }, { view: 'web:7' })
  assert.equal(posts.find((p) => p[1].type === 'reset')[1].env.download, false)
  host.deactivate()
})

// Guests (design-guests §6): the host checks main's `from.access`, never the page's word.
test('a read-only guest reads the tree and searches, and is refused everything that changes state or opens a tab', async () => {
  const root = fs.realpathSync(tempDir('files-guest-'))
  fs.writeFileSync(path.join(root, 'a.txt'), 'x\n')
  fs.mkdirSync(path.join(root, 'sub'))
  const host = load()
  const { ctx, posts, listeners } = fakeCtx(root)
  const called = []
  ctx.files = {
    open: async (p) => void called.push(['open', p]),
    trash: async (p) => void called.push(['trash', p]),
    download: async (p) => void called.push(['download', p]),
    reveal: async (p) => void called.push(['reveal', p]),
    openWithSystem: async (p) => void called.push(['system', p]),
  }
  ctx.sessions = { open: async () => void called.push(['ask']), openShell: async () => void called.push(['terminal']) }
  ctx.services = { use: () => ({ open: async (p) => void called.push(['edit', p]) }) }
  host.activate(ctx)
  const guest = { view: 'web:5', access: 'read' }
  await listeners[0]({ type: 'expand', path: 'sub' }, guest)
  await listeners[0]({ type: 'search', query: 'a' }, guest)
  assert.ok(posts.some((p) => p[1].type === 'dir' && p[1].path === 'sub'))
  assert.ok(posts.some((p) => p[1].type === 'results'))
  for (const m of [
    { type: 'open', path: 'a.txt' },
    { type: 'edit', path: 'a.txt' },
    { type: 'download', path: 'a.txt' },
    { type: 'trash', path: 'a.txt' },
    { type: 'ask', path: 'a.txt' },
    { type: 'terminal', path: '' },
    { type: 'create', kind: 'file', dir: '', name: 'new.txt' },
    { type: 'rename', path: 'a.txt', name: 'b.txt' },
    { type: 'reveal', path: 'a.txt' },
  ]) {
    const before = posts.length
    await listeners[0](m, guest)
    const answer = posts.slice(before)
    assert.equal(answer.length, 1, m.type)
    assert.equal(answer[0][1].type, 'error', m.type)
    assert.deepEqual(answer[0][2], { view: 'web:5' }, m.type)
  }
  assert.deepEqual(called, [])
  assert.ok(fs.existsSync(path.join(root, 'a.txt')))
  assert.ok(!fs.existsSync(path.join(root, 'new.txt')))
  host.deactivate()
})

test("a write guest works like the owner, but never Reveal or the system's default app", async () => {
  const root = fs.realpathSync(tempDir('files-guest-'))
  fs.writeFileSync(path.join(root, 'a.txt'), 'x\n')
  const host = load()
  const { ctx, posts, listeners } = fakeCtx(root)
  const called = []
  ctx.files = {
    open: async (p) => void called.push(['open', p]),
    reveal: async (p) => void called.push(['reveal', p]),
    openWithSystem: async (p) => void called.push(['system', p]),
  }
  ctx.settings = { app: { openWith: [{ extensions: 'md', action: 'system' }] } }
  fs.writeFileSync(path.join(root, 'r.md'), '# x\n')
  host.activate(ctx)
  const guest = { view: 'web:6', access: 'write' }
  await listeners[0]({ type: 'open', path: 'a.txt' }, guest)
  await listeners[0]({ type: 'create', kind: 'file', dir: '', name: 'new.txt' }, guest)
  await listeners[0]({ type: 'reveal', path: 'a.txt' }, guest)
  await listeners[0]({ type: 'open-system', path: 'a.txt' }, guest)
  await listeners[0]({ type: 'open', path: 'r.md' }, guest)
  assert.deepEqual(called, [['open', 'a.txt']])
  assert.ok(fs.existsSync(path.join(root, 'new.txt')))
  assert.equal(posts.filter((p) => p[1].type === 'error').length, 3)
  // The owner's page (main tags it 'owner'; an older app tags nothing) still reveals.
  await listeners[0]({ type: 'reveal', path: 'a.txt' }, { view: 'desktop', access: 'owner' })
  await listeners[0]({ type: 'reveal', path: 'a.txt' })
  assert.deepEqual(called.slice(1), [['reveal', 'a.txt'], ['reveal', 'a.txt']])
  host.deactivate()
})

test("a guest's reset leaves out the project's absolute path; the owner's keeps it", async () => {
  const root = fs.realpathSync(tempDir('files-guest-'))
  const host = load()
  const { ctx, posts, listeners } = fakeCtx(root)
  let onViews
  ctx.views = { access: () => undefined, onChange: (fn) => ((onViews = fn), () => {}) }
  host.activate(ctx)
  // Only the owner looks: one broadcast, as before.
  onViews({ view: 'desktop', access: 'owner' })
  await listeners[0]({ type: 'hello' }, { view: 'desktop', access: 'owner' })
  const first = posts.filter((p) => p[1].type === 'reset')
  assert.equal(first.length, 1)
  assert.equal(first[0][2], undefined)
  assert.equal(first[0][1].env.root, root)
  // A guest joins: one reset per view, the guest's without the path.
  onViews({ view: 'web:2', access: 'read' })
  posts.length = 0
  await listeners[0]({ type: 'hello' }, { view: 'web:2', access: 'read' })
  const resets = posts.filter((p) => p[1].type === 'reset')
  assert.deepEqual(resets.map((p) => [p[2].view, p[1].env.root]), [['desktop', root], ['web:2', '']])
  host.deactivate()
})

test("a guest's tree stays inside the project's real path: a folder link out and a .. path are refused", async () => {
  const root = fs.realpathSync(tempDir('files-guest-'))
  const outside = fs.realpathSync(tempDir('files-outside-'))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x\n')
  fs.symlinkSync(outside, path.join(root, 'out'))
  const host = load()
  const { ctx, posts, listeners } = fakeCtx(root)
  host.activate(ctx)
  for (const access of ['read', 'write']) {
    for (const p of ['out', '../' + path.basename(outside)]) {
      const before = posts.length
      await listeners[0]({ type: 'expand', path: p }, { view: 'web:3', access })
      const answer = posts.slice(before)
      // The refusal is the folder's row with an error and no entries (the page shows the error under it).
      for (const x of answer.filter((y) => y[1].type === 'dir')) {
        assert.deepEqual(x[1].entries, [], `${access} ${p}`)
        assert.match(x[1].error, /outside the project/, `${access} ${p}`)
      }
      assert.ok(!JSON.stringify(answer).includes('secret.txt'), `${access} ${p}`)
    }
  }
  // The listing of the project marks the link as blocked, never expandable.
  await listeners[0]({ type: 'hello' }, { view: 'web:3', access: 'read' })
  const top = posts.filter((x) => x[1].type === 'dir' && x[1].path === '').at(-1)[1]
  assert.equal(top.entries.find((e) => e.name === 'out').blocked, true)
  host.deactivate()
})
