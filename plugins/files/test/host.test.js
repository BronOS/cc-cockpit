'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')

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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'files-host-')))
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'files-host-')))
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
