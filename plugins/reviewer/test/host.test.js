'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const host = require('../dist/host.js')

// A project folder with one changed file, and a fake ctx around it.
function setup({ editorAvailable }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'revhost-')))
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  fs.writeFileSync(path.join(root, 'a.js'), 'one\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  fs.writeFileSync(path.join(root, 'a.js'), 'two\n')
  const provided = {}
  const handles = []
  const execs = []
  const ctx = {
    projectDir: root,
    exec: async (argv) => {
      execs.push(argv)
      try {
        return { code: 0, stdout: execFileSync(argv[0], argv.slice(1), { cwd: root, stdio: 'pipe' }).toString(), stderr: '' }
      } catch (e) {
        return { code: e.status ?? 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }
      }
    },
    services: { use: () => ({ open: async () => ({}) }), provide: (n, impl) => (provided[n] = impl), available: (n) => n === 'editor' && editorAvailable },
    sessions: { list: async () => [] },
    storage: { get: async () => null, set: async () => {}, delete: async () => {} },
    appStorage: { get: async () => null, set: async () => {} },
    files: { onOpen: () => () => {} },
    cli: { register() {} },
    overlay: {
      start: () => {
        const h = { posts: [], focused: 0, post: (m) => h.posts.push(m), focus: () => h.focused++, onMessage() {}, close() {}, result: new Promise(() => {}) }
        handles.push(h)
        return h
      },
    },
    log: { info() {}, warn() {}, error() {} },
    notify() {},
  }
  return { ctx, provided, handles, execs }
}

test('no pwd: the folder is ctx.projectDir; Edit follows services.available', async () => {
  for (const editorAvailable of [true, false]) {
    const f = setup({ editorAvailable })
    host.activate(f.ctx)
    await f.provided.reviewer.open('a.js')
    assert.equal(f.handles[0].posts[0].canEdit, editorAvailable)
    assert.ok(!f.execs.some((a) => a[0] === 'pwd'))
    host.deactivate()
  }
})

test('a second open of the same file focuses the first overlay', async () => {
  const f = setup({ editorAvailable: true })
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  await f.provided.reviewer.open('a.js')
  assert.equal(f.handles.length, 1)
  assert.equal(f.handles[0].focused, 1)
  host.deactivate()
})

test('two concurrent opens of the same file still make one overlay', async () => {
  // Both calls pass the first open.has check while the other is awaiting (git, storage, tabs).
  const f = setup({ editorAvailable: true })
  host.activate(f.ctx)
  await Promise.all([f.provided.reviewer.open('a.js'), f.provided.reviewer.open('a.js')])
  assert.equal(f.handles.length, 1)
  assert.equal(f.handles[0].focused, 1)
  host.deactivate()
})

test('a file too large for one init message is refused before an overlay starts, and stays openable', async () => {
  // 300 KiB of quotes is under MAX_SIDE_BYTES per side, but JSON doubles every quote: both sides
  // together pass the overlay message limit. Posting it after start left a blank overlay cached.
  const f = setup({ editorAvailable: true })
  const quotes = '"'.repeat(300 * 1024)
  const git = (...a) => execFileSync('git', a, { cwd: f.ctx.projectDir, stdio: 'pipe' })
  fs.writeFileSync(path.join(f.ctx.projectDir, 'big.txt'), quotes)
  git('add', 'big.txt')
  git('commit', '-qm', 'big')
  fs.writeFileSync(path.join(f.ctx.projectDir, 'big.txt'), quotes + 'x')
  host.activate(f.ctx)
  for (let i = 0; i < 2; i++) {
    await assert.rejects(f.provided.reviewer.open('big.txt'), /too large to review/)
  }
  assert.equal(f.handles.length, 0)
  host.deactivate()
})

test('a refused overlay fails the open, so a click falls back and the service and ccc review report it', async () => {
  // start() returns a handle even when main refuses the overlay (3 open, 10 a minute); the refusal
  // only rejects `result`. That rejection was swallowed by `done`, so a click counted as handled.
  const f = setup({ editorAvailable: false })
  let onOpen
  let review
  f.ctx.files.onOpen = (fn) => ((onOpen = fn), () => {})
  f.ctx.cli.register = (n, fn) => (review = fn)
  f.ctx.overlay.start = () => {
    const h = { posts: [], post: (m) => h.posts.push(m), focus() {}, onMessage() {}, close() {}, result: Promise.reject(new Error('overlay: at most 3 open')) }
    f.handles.push(h)
    return h
  }
  host.activate(f.ctx)
  await assert.rejects(onOpen({ path: 'a.js' }), /review overlay did not open: overlay: at most 3 open/)
  await assert.rejects(f.provided.reviewer.open('a.js'), /reviewer: the review overlay did not open/)
  const r = await review(['a.js'], { cwd: f.ctx.projectDir })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /did not open/)
  // Not cached as open: each try started its own overlay instead of focusing a dead one.
  assert.equal(f.handles.length, 3)
  host.deactivate()
})

test('a page message sent right after init is handled, not lost to the open wait', async () => {
  // The listener was registered after the 500 ms "did it open" wait, so a draft or an Edit click
  // the page sent as soon as it loaded was dropped.
  const f = setup({ editorAvailable: true })
  const saved = []
  f.ctx.storage.set = async (k, v) => saved.push([k, v])
  f.ctx.overlay.start = () => {
    const h = {
      listeners: [],
      posts: [],
      onMessage: (l) => (h.listeners.push(l), () => {}),
      post: (m) => {
        h.posts.push(m)
        // The page answers init at once with a draft.
        if (m.type === 'init') for (const l of h.listeners) l({ type: 'draft', draft: { global: 'early note', notes: [] } })
      },
      focus() {},
      close() {},
      result: new Promise(() => {}),
    }
    f.handles.push(h)
    return h
  }
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  assert.equal(f.handles[0].listeners.length, 1)
  assert.equal(saved.length, 1)
  assert.equal(saved[0][1].global, 'early note')
  host.deactivate()
})

test('a long path is cut from the left to fit the overlay title limit', async () => {
  // main refuses a title over 200 chars, so a path over 192 chars could never be reviewed.
  assert.equal(host.overlayTitle('Review: ', 'a.js'), 'Review: a.js')
  const long = 'd/'.repeat(150) + 'file.js'
  const t = host.overlayTitle('Review: ', long)
  assert.equal(t.length, 200)
  assert.ok(t.startsWith('Review: …') && t.endsWith('/file.js'))
})
