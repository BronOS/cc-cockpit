'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { microArgv, relativePath } = require('../dist/host.js')

test('microArgv: options, file, line', () => {
  assert.deepEqual(microArgv({}, 'src/a.ts', 12), ['micro', '-autosave', '5', 'src/a.ts', '+12'])
  assert.deepEqual(microArgv({ autosaveSeconds: 0, colorscheme: 'gruvbox-tc', microPath: '/opt/micro' }, 'a', undefined), ['/opt/micro', '-autosave', '0', '-colorscheme', 'gruvbox-tc', 'a'])
  assert.deepEqual(microArgv({ colorscheme: 'bad name;rm' }, '-x.txt', 0), ['micro', '-autosave', '5', './-x.txt'])
})

test('relativePath refuses escapes', () => {
  assert.equal(relativePath('./a//b.txt'), 'a/b.txt')
  for (const bad of ['/etc/passwd', '../x', 'a/../../x', '', '.']) assert.throws(() => relativePath(bad))
})

// A fake ctx: records what the host provides and starts.
function fakeCtx({ execResult }) {
  const provided = {}
  const cli = {}
  const started = []
  const ctx = {
    projectDir: '/proj',
    settings: { app: {} },
    exec: async () => {
      if (execResult instanceof Error) throw execResult
      return execResult
    },
    services: { provide: (n, impl) => (provided[n] = impl) },
    cli: { register: (n, fn) => (cli[n] = fn) },
    overlay: { start: (spec) => (started.push(spec), { result: new Promise(() => {}) }) },
    log: { info() {}, warn() {} },
  }
  return { ctx, provided, cli, started }
}

test('a missing micro names the install commands and the microPath setting', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: new Error('spawn micro ENOENT') })
  host.activate(f.ctx)
  await assert.rejects(f.provided.editor.open('a.txt'), (e) => {
    for (const w of ['brew install micro', 'sudo pacman -S micro', 'sudo apt install micro', 'https://micro-editor.github.io', 'microPath']) assert.ok(e.message.includes(w), w)
    return true
  })
  assert.equal(f.started.length, 0)
})

test('ccc edit resolves against ctx.projectDir', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  host.activate(f.ctx)
  const r = await f.cli.edit(['src/a.ts', '7'], { cwd: '/proj' })
  assert.equal(r.stdout, 'editing src/a.ts\n')
  assert.deepEqual(f.started[0].argv.slice(-2), ['src/a.ts', '+7'])
})

test('a refused overlay fails editor.open and ccc edit instead of reporting success', async () => {
  // start() returns a handle even when main refuses the overlay (3 open, 10 a minute, a failed
  // spawn); the refusal only rejects `result`. The reviewer closed itself on a false success.
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.overlay.start = (spec) => (f.started.push(spec), { result: Promise.reject(new Error('overlay: at most 3 open')) })
  host.activate(f.ctx)
  await assert.rejects(f.provided.editor.open('a.txt'), /editor: the editor overlay did not open: overlay: at most 3 open/)
  const r = await f.cli.edit(['a.txt'], { cwd: '/proj' })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /did not open/)
})

test('micro exiting at once with a nonzero code fails editor.open and ccc edit', async () => {
  // micro failing right after spawning resolves `result` with { kind: 'exit', code: 1 }; counting
  // every resolved result as shown made `ccc edit` report success and closed the reviewer.
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.overlay.start = (spec) => (f.started.push(spec), { result: Promise.resolve({ kind: 'exit', code: 1 }) })
  host.activate(f.ctx)
  await assert.rejects(f.provided.editor.open('a.txt'), /editor: micro exited at once with code 1/)
  const r = await f.cli.edit(['a.txt'], { cwd: '/proj' })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /exited at once with code 1/)
})

test('a backslash stays part of the file name off Windows', { skip: require('node:path').sep === '\\' }, () => {
  // `a\b.js` is one valid file name on macOS and Linux; turning it into `a/b.js` opened another file.
  assert.equal(relativePath('a\\b.js'), 'a\\b.js')
})

test('a long path is cut from the left to fit the overlay title limit', async () => {
  // main refuses a title over 200 chars, so a path over 194 chars could never be edited.
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  host.activate(f.ctx)
  const long = 'd/'.repeat(150) + 'file.js'
  await f.provided.editor.open(long)
  const t = f.started[0].title
  assert.equal(t.length, 200)
  assert.ok(t.startsWith('Edit: …') && t.endsWith('/file.js'))
  assert.equal(host.overlayTitle('Edit: ', 'a.js'), 'Edit: a.js')
})

// A project folder for the Edit button's file checks.
function project() {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edhost-')))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'const a = 1\n')
  fs.writeFileSync(path.join(root, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]))
  fs.writeFileSync(path.join(root, 'empty.txt'), '')
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edout-')))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x\n')
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'))
  fs.symlinkSync(path.join(root, 'src/a.ts'), path.join(root, 'inside-link.ts'))
  return root
}

test('editableFile: only a text file inside the project, never an escape', () => {
  const { editableFile } = require('../dist/host.js')
  const root = project()
  assert.equal(editableFile(root, { path: 'src/a.ts' }), 'src/a.ts')
  assert.equal(editableFile(root, { path: './src//a.ts', mime: 'text/plain' }), 'src/a.ts')
  assert.equal(editableFile(root, { path: 'empty.txt' }), 'empty.txt')
  assert.equal(editableFile(root, { path: 'inside-link.ts' }), 'inside-link.ts')
  for (const data of [
    { path: '../x' },
    { path: 'src/../../x' },
    { path: '/etc/hosts' },
    { path: root + '/src/a.ts' },
    { path: 'link.txt' }, // a symlink out of the project
    { path: 'img.png' }, // binary
    { path: 'src' }, // a folder
    { path: 'missing.txt' },
    { path: 5 },
    null,
    'src/a.ts',
  ]) {
    assert.equal(editableFile(root, data), null, JSON.stringify(data))
  }
})

test('"Edit" on a file overlay: only for an editable file; run opens micro on top', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.projectDir = project()
  const providers = {}
  f.ctx.overlay.buttons = (type, fn) => ((providers[type] = fn), () => {})
  host.activate(f.ctx)
  assert.deepEqual(Object.keys(providers), ['file'])
  const info = (p) => ({ type: { name: 'file', data: { path: p } }, title: `Review: ${p}`, opener: 'cockpit.reviewer' })
  for (const p of ['../x', '/etc/hosts', 'img.png', 'link.txt']) assert.deepEqual(providers.file(info(p)), [], p)
  const [b, ...rest] = providers.file(info('src/a.ts'))
  assert.equal(rest.length, 0)
  assert.equal(b.id, 'edit')
  assert.equal(b.label, 'Edit')
  await b.run(info('src/a.ts'))
  assert.equal(f.started.length, 1)
  assert.equal(f.started[0].kind, 'terminal')
  assert.deepEqual(f.started[0].argv.slice(-1), ['src/a.ts'])
  assert.equal(f.started[0].title, 'Edit: src/a.ts')
})

test('"Edit" run that fails tells the person; an app without overlay.buttons registers nothing', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: new Error('spawn micro ENOENT') })
  f.ctx.projectDir = project()
  const notices = []
  f.ctx.notify = (m) => notices.push(m)
  let provider
  f.ctx.overlay.buttons = (_t, fn) => ((provider = fn), () => {})
  host.activate(f.ctx)
  const [b] = provider({ type: { name: 'file', data: { path: 'src/a.ts' } }, title: 't', opener: 'core' })
  await b.run()
  assert.equal(f.started.length, 0)
  assert.match(notices[0], /^Edit src\/a\.ts: micro is not installed/)

  // An older app: no ctx.overlay.buttons, and activate still works.
  const g = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  host.activate(g.ctx)
  assert.equal(typeof g.provided.editor.open, 'function')
})
