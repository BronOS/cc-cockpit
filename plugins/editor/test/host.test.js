'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { microArgv, relativePath, autosaveOf } = require('../dist/host.js')
const fs = require('node:fs')
const path = require('node:path')

/** Waits until `fn()` is truthy (polling), or fails after `ms`: no fixed sleep decides a test here. */
async function until(fn, ms = 5000, what = 'condition') {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/**
 * Resolves after every promise chain already started has run to its end: the fake ctx.tabs,
 * services and setTitle below answer with plain resolved promises (no I/O, no timer), so what a
 * message to the host caused is all done by the next macrotask. For "nothing happened" checks.
 */
const drained = () => new Promise((r) => setImmediate(r))

/** Every temp folder of this file goes after the last test. */
const made = []
test.after(() => {
  for (const dir of made) require('node:fs').rmSync(dir, { recursive: true, force: true })
})

// micro is looked up in the absolute PATH entries (host.js microProgram): a stand-in there, so these
// tests do not depend on the machine having micro (ctx.exec is faked; it never runs).
const fakeMicroDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'edhost-micro-'))
made.push(fakeMicroDir)
fs.writeFileSync(path.join(fakeMicroDir, 'micro'), '#!/bin/sh\n', { mode: 0o755 })
process.env.PATH = `${fakeMicroDir}${path.delimiter}${process.env.PATH || ''}`

test('microProgram: a bare name from the absolute PATH entries only (never the project\'s own); a path as given', () => {
  const { microProgram } = require('../dist/host.js')
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'edhost-rel-'))
  made.push(root)
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'micro'), '#!/bin/sh\n', { mode: 0o755 })
  const rel = path.join('node_modules', '.bin')
  assert.equal(microProgram({}, { PATH: `.${path.delimiter}${rel}` }), null)
  assert.equal(microProgram({}, { PATH: `${rel}${path.delimiter}${fakeMicroDir}` }), path.join(fakeMicroDir, 'micro'))
  assert.equal(microProgram({ microPath: '/opt/micro' }, { PATH: '' }), '/opt/micro')
  assert.equal(microProgram({ microPath: 'micro' }, { PATH: fakeMicroDir }), path.join(fakeMicroDir, 'micro'))
})

test('microArgv: options, file, line', () => {
  assert.deepEqual(microArgv({}, 'src/a.ts', 12), ['micro', '-autosave', '3', 'src/a.ts', '+12'])
  assert.deepEqual(microArgv({ autosaveIdleSeconds: 0, colorscheme: 'gruvbox-tc', microPath: '/opt/micro' }, 'a', undefined), ['/opt/micro', '-autosave', '0', '-colorscheme', 'gruvbox-tc', 'a'])
  assert.deepEqual(microArgv({ colorscheme: 'bad name;rm' }, '-x.txt', 0), ['micro', '-autosave', '3', './-x.txt'])
})

test('settings migration: an autosaveSeconds set for micro is the default of autosaveIdleSeconds', () => {
  // Nothing set: the manifest's described default (the schema has none, so an unset field stays unset).
  assert.deepEqual(autosaveOf({}), { idleSeconds: 3, onBlur: true })
  assert.deepEqual(autosaveOf(undefined), { idleSeconds: 3, onBlur: true })
  // The old micro setting, still in the stored values though no longer in the schema, carries over...
  assert.deepEqual(autosaveOf({ autosaveSeconds: 10 }), { idleSeconds: 10, onBlur: true })
  assert.deepEqual(autosaveOf({ autosaveSeconds: 0 }), { idleSeconds: 0, onBlur: true })
  // ...until the new one is set, which wins, 0 (off) included.
  assert.deepEqual(autosaveOf({ autosaveSeconds: 10, autosaveIdleSeconds: 2, autosaveOnBlur: false }), { idleSeconds: 2, onBlur: false })
  assert.deepEqual(autosaveOf({ autosaveSeconds: 10, autosaveIdleSeconds: 0 }), { idleSeconds: 0, onBlur: true })
  // 5 was the old default, stored by every settings save: it cannot be told from a choice, so it is unset.
  assert.deepEqual(autosaveOf({ autosaveSeconds: 5 }), { idleSeconds: 3, onBlur: true })
  // A damaged value is ignored.
  assert.deepEqual(autosaveOf({ autosaveSeconds: -1, autosaveIdleSeconds: 1.5 }), { idleSeconds: 3, onBlur: true })
  assert.deepEqual(autosaveOf({ autosaveSeconds: 99999 }), { idleSeconds: 3, onBlur: true })
  // micro follows the same value.
  assert.deepEqual(microArgv({ autosaveSeconds: 7 }, 'a', 0).slice(1, 3), ['-autosave', '7'])
  // The manifest no longer declares the old field, and the new one has no default to hide an unset value.
  const props = require('../plugin.json').contributes.settings.app.properties
  assert.equal(props.autosaveSeconds, undefined)
  assert.equal('default' in props.autosaveIdleSeconds, false)
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
  made.push(root, outside)
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

test('"Edit" on a file overlay: only for an editable file; on an app without page tabs, run opens micro on top', async () => {
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

test('file tabs: activate serves type `file` through ctx.tabs, and deactivate closes the watches', () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  const opened = []
  f.ctx.tabs = { onOpen: (type, fn) => (opened.push({ type, fn }), () => {}) }
  host.activate(f.ctx)
  assert.deepEqual(opened.map((o) => o.type), ['file'])
  host.deactivate()
})

test('file tabs: deactivate closes the watch of an open file tab (no disk event after it)', async (t) => {
  const fs = require('node:fs')
  const path = require('node:path')
  const host = require('../dist/host.js')
  // Every OS watch the host starts is recorded with whether it was closed: a closed watch cannot
  // deliver an event, which a write and a wait could only suggest (the watch debounces, so no wait
  // length proves that nothing comes).
  const watch = fs.watch
  const watches = []
  t.mock.method(fs, 'watch', (...args) => {
    const w = watch(...args)
    const rec = { dir: args[0], closed: false }
    watches.push(rec)
    const close = w.close.bind(w)
    w.close = () => ((rec.closed = true), close())
    return w
  })
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.projectDir = project()
  fs.writeFileSync(path.join(f.ctx.projectDir, 'a.txt'), 'one\n')
  const opened = []
  f.ctx.tabs = { onOpen: (type, fn) => (opened.push({ type, fn }), () => {}) }
  host.activate(f.ctx)
  const posted = []
  const listeners = []
  opened[0].fn({ id: 't', type: 'file', params: { path: 'a.txt' }, post: (m) => posted.push(m), onMessage: (fn) => listeners.push(fn), onClose: () => {} })
  for (const l of listeners) l({ t: 'open', req: 1 })
  assert.deepEqual(posted.map((m) => m.t), ['settings', 'file'])
  // The open tab's folder is watched...
  assert.deepEqual(watches.map((w) => [w.dir, w.closed]), [[f.ctx.projectDir, false]])
  host.deactivate()
  // ...and no longer once the host is gone.
  assert.deepEqual(watches.map((w) => [w.dir, w.closed]), [[f.ctx.projectDir, true]])
  fs.writeFileSync(path.join(f.ctx.projectDir, 'a.txt'), 'two\n')
  await drained()
  // Quick chat's pickers (sent once its async read settled) are not a disk event.
  assert.deepEqual(posted.map((m) => m.t).filter((t) => t !== 'chat-defaults'), ['settings', 'file'])
})

// A fake ctx.tabs over a list of open tabs, recording what the host asks.
function fakeTabs(f) {
  const calls = []
  const open = []
  const openers = []
  f.ctx.tabs = {
    onOpen: (type, fn) => (openers.push({ type, fn }), () => {}),
    list: async (type) => (calls.push(['list', type]), open.map((t) => ({ ...t }))),
    openPage: async (type, params, options) => {
      calls.push(['openPage', type, params, options])
      const id = `00000000-0000-4000-8000-${String(open.length + 1).padStart(12, '0')}`
      open.push({ id, type, params, title: options.title })
      return id
    },
    focus: async (id) => void calls.push(['focus', id]),
    markUnseen: async (id) => (calls.push(['markUnseen', id]), { marked: true }),
    close: async (id) => (calls.push(['close', id]), { closed: true }),
  }
  // A frame of tab `id` connecting in `view` (undefined: the desktop): the instance the host serves.
  const connect = (id, view) => {
    const t = open.find((x) => x.id === id)
    const posted = []
    const listeners = []
    const closers = []
    const discussers = []
    const setTitle = async (title, icon) => {
      calls.push(['setTitle', id, title, icon])
      if (t.failTitle) throw new Error('the request timed out')
      t.title = title
    }
    const tab = { id, type: 'file', params: t.params, view, post: (m) => posted.push(m), onMessage: (fn) => listeners.push(fn), onClose: (fn) => closers.push(fn), onDiscuss: (fn) => discussers.push(fn), setTitle }
    for (const o of openers) o.fn(tab)
    return { posted, send: (m) => listeners.forEach((l) => l(m)), close: () => closers.forEach((c) => c()), discuss: () => discussers[0]() }
  }
  return { calls, open, connect }
}

test('open routing: editor.open opens a file tab at the line, focused; a second open focuses it and moves the line', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.projectDir = project()
  const t = fakeTabs(f)
  host.activate(f.ctx)
  assert.deepEqual(await f.provided.editor.open('./src//a.ts', { line: 4 }), { opened: true })
  assert.deepEqual(t.calls.at(-1), ['openPage', 'file', { path: 'src/a.ts', line: 4 }, { title: 'a.ts', icon: 'file', focus: true }])
  assert.equal(t.open.length, 1)
  const view = t.connect(t.open[0].id)
  // Again, spelled differently: no second tab.
  assert.deepEqual(await f.provided.editor.open('src/a.ts', { line: 9, col: 2 }), { opened: true })
  assert.equal(t.open.length, 1)
  assert.deepEqual(t.calls.at(-1), ['focus', t.open[0].id])
  assert.deepEqual(view.posted.at(-1), { t: 'goto', line: 9, col: 2 })
  // No line: focus only, the cursor stays.
  const n = view.posted.length
  await f.provided.editor.open('src/a.ts')
  assert.equal(view.posted.length, n)
  // A missing file inside the project opens a tab too (a new file, made by its first save).
  await f.provided.editor.open('src/new.ts')
  assert.deepEqual(t.calls.at(-1), ['openPage', 'file', { path: 'src/new.ts' }, { title: 'new.ts', icon: 'file', focus: true }])
  host.deactivate()
})

test('open routing: outside the project refused, a binary file goes to the project file opener', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.projectDir = project()
  const t = fakeTabs(f)
  const viewed = []
  f.ctx.files = { open: async (p) => (viewed.push(p), { via: 'builtin' }) }
  host.activate(f.ctx)
  for (const bad of ['../x', '/etc/hosts', 'link.txt']) {
    await assert.rejects(f.provided.editor.open(bad), /^Error: editor: /, bad)
  }
  assert.deepEqual(await f.provided.editor.open('img.png'), { opened: true })
  assert.deepEqual(viewed, ['img.png'])
  assert.equal(t.open.length, 0)
  // An app with no ctx.files.open: a binary file is refused, never put in a tab.
  delete f.ctx.files
  await assert.rejects(f.provided.editor.open('img.png'), /binary/)
  host.deactivate()
})

test('service compatibility: an app without page tabs keeps micro for editor.open', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  host.activate(f.ctx)
  assert.deepEqual(await f.provided.editor.open('src/a.ts', { line: 3 }), { opened: true })
  assert.equal(f.started[0].kind, 'terminal')
  assert.deepEqual(f.started[0].argv.slice(-2), ['src/a.ts', '+3'])
})

test('"Edit" on a file overlay opens the file tab and closes the overlay', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.projectDir = project()
  const t = fakeTabs(f)
  let provider
  f.ctx.overlay.buttons = (_t, fn) => ((provider = fn), () => {})
  host.activate(f.ctx)
  const info = { type: { name: 'file', data: { path: 'src/a.ts' } }, title: 'Review: src/a.ts', opener: 'cockpit.reviewer' }
  const [b] = provider(info)
  assert.deepEqual(await b.run(info), { close: true })
  assert.deepEqual(t.calls.at(-1), ['openPage', 'file', { path: 'src/a.ts' }, { title: 'a.ts', icon: 'file', focus: true }])
  assert.equal(f.started.length, 0)
  host.deactivate()
})

test('a file tab instance: settings at connect and on change, the line on the first load only, micro on the tab file', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.projectDir = project()
  let settingsListener
  f.ctx.onSettingsChange = (fn) => ((settingsListener = fn), () => {})
  f.ctx.settings = { app: { autosaveSeconds: 8, autosaveOnBlur: false, quickChatModel: 'opus', quickChatEffort: 'high' } }
  // Quick chat's last pick, remembered app-wide under the settings above.
  const stored = new Map([['quickChatPick', { model: 'haiku', effort: 'max', settings: { model: 'opus', effort: 'high' } }]])
  f.ctx.appStorage = { get: async (k) => stored.get(k), set: async (k, v) => void stored.set(k, v) }
  const t = fakeTabs(f)
  host.activate(f.ctx)
  await f.provided.editor.open('src/a.ts', { line: 1 })
  const view = t.connect(t.open[0].id)
  assert.deepEqual(view.posted[0], { t: 'settings', idleSeconds: 8, onBlur: false })
  // Quick chat's pickers (after the store's read): the remembered pick preselected, the lists the host accepts.
  const efforts = ['default', 'low', 'medium', 'high', 'xhigh', 'max']
  const models = ['haiku', 'sonnet', 'opus', 'fable']
  const pickers = () => view.posted.filter((m) => m.t === 'chat-defaults')
  await until(() => pickers().length === 1, 5000, 'chat-defaults')
  assert.deepEqual(pickers()[0], { t: 'chat-defaults', model: 'haiku', effort: 'max', models, efforts })
  const kinds = () => view.posted.map((m) => m.t).filter((k) => k !== 'chat-defaults')
  view.send({ t: 'open', req: 1, first: true })
  assert.deepEqual(kinds(), ['settings', 'file', 'goto'])
  assert.deepEqual(view.posted.at(-1), { t: 'goto', line: 1 })
  // A reconnect's open keeps the person's cursor: no goto.
  view.send({ t: 'open', req: 2 })
  assert.deepEqual(kinds(), ['settings', 'file', 'goto', 'file'])
  // Settings saved: every connected instance hears the new autosave and quick chat defaults, where
  // the changed setting outranks the remembered pick.
  f.ctx.settings = { app: { autosaveIdleSeconds: 1 } }
  settingsListener(f.ctx.settings)
  assert.deepEqual(view.posted.filter((m) => m.t === 'settings').at(-1), { t: 'settings', idleSeconds: 1, onBlur: true })
  await until(() => pickers().length === 2, 5000, 'chat-defaults again')
  assert.deepEqual(pickers()[1], { t: 'chat-defaults', model: 'sonnet', effort: 'default', models, efforts })
  // Open in micro: the tab's own file, whatever path the page sends.
  view.send({ t: 'micro', path: 'img.png' })
  // The overlay starts once micro is found (ctx.exec); the OPEN_SETTLE_MS race after it decides nothing here.
  await until(() => f.started.length === 1, 5000, 'micro overlay')
  assert.deepEqual(f.started[0].argv.slice(-1), ['src/a.ts'])
  // A closed instance hears nothing more.
  view.close()
  const n = view.posted.length
  settingsListener(f.ctx.settings)
  assert.equal(view.posted.length, n)
  host.deactivate()
})

test('Open in micro that fails is told on the tab', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: new Error('spawn micro ENOENT') })
  f.ctx.projectDir = project()
  const t = fakeTabs(f)
  host.activate(f.ctx)
  await f.provided.editor.open('src/a.ts')
  const view = t.connect(t.open[0].id)
  view.send({ t: 'micro' })
  const err = await until(() => view.posted.find((m) => m.t === 'error'), 5000, 'the error')
  assert.match(err.message, /^Open in micro: micro is not installed/)
  host.deactivate()
})

test('goto for a tab with no mounted frame waits for its next first open; a remount never jumps back to params.line', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.projectDir = project()
  const t = fakeTabs(f)
  host.activate(f.ctx)
  await f.provided.editor.open('src/a.ts', { line: 4 })
  const id = t.open[0].id
  // Opened again at a line before its frame ever mounted: that line, not the stale params.line.
  await f.provided.editor.open('src/a.ts', { line: 9 })
  let view = t.connect(id)
  view.send({ t: 'open', first: true, req: 1 })
  assert.deepEqual(view.posted.filter((m) => m.t === 'goto'), [{ t: 'goto', line: 9 }])
  // The frame goes (LRU) and comes back: no jump at all.
  view.close()
  view = t.connect(id)
  view.send({ t: 'open', first: true, req: 1 })
  assert.deepEqual(view.posted.filter((m) => m.t === 'goto'), [])
  // Unmounted again, opened at a line: it waits for the next mount.
  view.close()
  await f.provided.editor.open('src/a.ts', { line: 2, col: 3 })
  view = t.connect(id)
  view.send({ t: 'open', first: true, req: 1 })
  assert.deepEqual(view.posted.filter((m) => m.t === 'goto'), [{ t: 'goto', line: 2, col: 3 }])
  host.deactivate()
})

test('what the host keeps per tab id goes once the tab is closed (the next open looks at the list)', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.projectDir = project()
  const t = fakeTabs(f)
  host.activate(f.ctx)
  await f.provided.editor.open('src/a.ts', { line: 4 })
  const id = t.open[0].id
  const view = t.connect(id)
  view.send({ t: 'open', first: true, req: 1 })
  assert.deepEqual(view.posted.filter((m) => m.t === 'goto'), [{ t: 'goto', line: 4 }])
  // The tab is closed (gone from main's list). The fake hands the next tab the same id: were the
  // closed tab's "first open done" still kept, the new tab's first mount would not go to its line.
  view.close()
  t.open.splice(0)
  await f.provided.editor.open('src/b.ts', { line: 7 })
  assert.equal(t.open[0].id, id)
  const next = t.connect(id)
  next.send({ t: 'open', first: true, req: 1 })
  assert.deepEqual(next.posted.filter((m) => m.t === 'goto'), [{ t: 'goto', line: 7 }])
  host.deactivate()
})

test('conflict marker: in the title while any view reports a conflict; a stale one from before is cleared', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.projectDir = project()
  const t = fakeTabs(f)
  host.activate(f.ctx)
  await f.provided.editor.open('src/a.ts')
  const id = t.open[0].id
  // updateMarker's chain is the fake ctx.tabs.list and setTitle only: all of it has run once drained.
  const tick = drained
  const titles = () => t.calls.filter((c) => c[0] === 'setTitle').map((c) => c[2])
  const desk = t.connect(id)
  const web = t.connect(id, 'view-1')
  // A page with no conflict on its first line: the title is already plain, nothing set.
  desk.send({ t: 'conflict', on: false })
  await tick()
  assert.deepEqual(titles(), [])
  desk.send({ t: 'conflict', on: true })
  await tick()
  web.send({ t: 'conflict', on: true })
  await tick()
  assert.deepEqual(titles(), ['⚠ a.ts'])
  assert.equal(t.calls.find((c) => c[0] === 'setTitle')[3], 'file')
  // One view resolved: still marked while the other holds one.
  desk.send({ t: 'conflict', on: false })
  await tick()
  assert.deepEqual(titles(), ['⚠ a.ts'])
  web.send({ t: 'conflict', on: false })
  await tick()
  assert.deepEqual(titles(), ['⚠ a.ts', 'a.ts'])
  // A setTitle that fails (a timeout): the next report of the same state sets the marker again,
  // never taking the one that did not land for shown.
  t.open[0].failTitle = true
  desk.send({ t: 'conflict', on: true })
  await tick()
  assert.equal(t.open[0].title, 'a.ts')
  t.open[0].failTitle = false
  desk.send({ t: 'conflict', on: true })
  await tick()
  assert.equal(t.open[0].title, '⚠ a.ts')
  host.deactivate()

  // A new host (a restart) with a title saved marked: the first report clears it.
  const f2 = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f2.ctx.projectDir = f.ctx.projectDir
  const t2 = fakeTabs(f2)
  host.activate(f2.ctx)
  await f2.provided.editor.open('src/a.ts')
  t2.open[0].title = '⚠ a.ts'
  const again = t2.connect(t2.open[0].id)
  again.send({ t: 'conflict', on: false })
  await tick()
  assert.deepEqual(
    t2.calls.filter((c) => c[0] === 'setTitle').map((c) => c[2]),
    ['a.ts']
  )
  host.deactivate()
})

test("conflict marker: a reconnect's new line keeps it without a blink; an unmounted page drops it after the grace", async (tt) => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.projectDir = project()
  const t = fakeTabs(f)
  host.activate(f.ctx)
  await f.provided.editor.open('src/a.ts')
  const id = t.open[0].id
  tt.mock.timers.enable({ apis: ['setTimeout'] })
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  const titles = () => t.calls.filter((c) => c[0] === 'setTitle').map((c) => c[2])
  let view = t.connect(id)
  view.send({ t: 'conflict', on: true })
  await flush()
  assert.deepEqual(titles(), ['⚠ a.ts'])
  // Reconnect: the old line closes, the new one reports within the grace.
  view.close()
  view = t.connect(id)
  view.send({ t: 'conflict', on: true })
  await flush()
  tt.mock.timers.tick(5000)
  await flush()
  assert.deepEqual(titles(), ['⚠ a.ts'])
  // Unmounted for good: dropped after the grace.
  view.close()
  tt.mock.timers.tick(2000)
  await flush()
  assert.deepEqual(titles(), ['⚠ a.ts'])
  tt.mock.timers.tick(1500)
  await flush()
  assert.deepEqual(titles(), ['⚠ a.ts', 'a.ts'])
  host.deactivate()
})

test("the deleted bar's Close closes this tab through ctx.tabs.close; a refusal is told on the tab", async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.projectDir = project()
  const t = fakeTabs(f)
  host.activate(f.ctx)
  await f.provided.editor.open('src/a.ts')
  const id = t.open[0].id
  const view = t.connect(id)
  // A page that reported no conflict (no deleted bar) cannot close the tab.
  view.send({ t: 'close' })
  await drained()
  assert.deepEqual(t.calls.filter((c) => c[0] === 'close'), [])
  view.send({ t: 'conflict', on: true })
  // Always this tab (main's id), whatever the page names.
  view.send({ t: 'close', id: 'someone-else' })
  await until(() => t.calls.some((c) => c[0] === 'close'), 5000, 'close')
  await drained()
  assert.deepEqual(
    t.calls.filter((c) => c[0] === 'close'),
    [['close', id]]
  )
  f.ctx.tabs.close = async () => {
    throw new Error('tabs.close: more than 10 closes in 60 s')
  }
  view.send({ t: 'close' })
  const refused = await until(() => view.posted.find((m) => m.t === 'error'), 5000, 'the refusal')
  assert.equal(refused.message, 'Close: tabs.close: more than 10 closes in 60 s')
  host.deactivate()
})

test('parseTarget: path[:line[:col]], the old `path line` form, colons in names, bad positions', () => {
  const { parseTarget } = require('../dist/host.js')
  assert.deepEqual(parseTarget(['a.ts']), { file: 'a.ts', line: undefined, col: undefined })
  assert.deepEqual(parseTarget(['a.ts:12']), { file: 'a.ts', line: 12, col: undefined })
  assert.deepEqual(parseTarget(['src/a.ts:12:5']), { file: 'src/a.ts', line: 12, col: 5 })
  assert.deepEqual(parseTarget(['a.ts', '7']), { file: 'a.ts', line: 7, col: undefined })
  // Only digit tails are a position; at most two of them.
  assert.deepEqual(parseTarget(['a:b.txt:3']), { file: 'a:b.txt', line: 3, col: undefined })
  assert.deepEqual(parseTarget(['a:b.txt']), { file: 'a:b.txt', line: undefined, col: undefined })
  assert.deepEqual(parseTarget(['a:1:2:3']), { file: 'a:1', line: 2, col: 3 })
  assert.deepEqual(parseTarget(['./a:12']), { file: './a', line: 12, col: undefined })
  // A name ending in `:<digits>` needs a full position after it; a range is no position at all.
  assert.deepEqual(parseTarget(['a:12:1:1']), { file: 'a:12', line: 1, col: 1 })
  assert.deepEqual(parseTarget(['a.ts:12-20']), { file: 'a.ts:12-20', line: undefined, col: undefined })
  for (const bad of [['a.ts:0'], ['a.ts:3:0'], ['a.ts', 'x'], ['a.ts:3', '4'], [], ['a', '1', '2']]) assert.throws(() => parseTarget(bad), bad.join(' '))
})

test('ccc edit on file tabs: opens unfocused at the position, reuses an open tab without focusing, refuses outside paths', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.projectDir = project()
  const t = fakeTabs(f)
  host.activate(f.ctx)
  const r = await f.cli.edit(['src/a.ts:4:2'], { cwd: f.ctx.projectDir })
  assert.equal(r.code, undefined)
  assert.match(r.stdout, /src\/a\.ts:4:2 is open in the editor/)
  assert.deepEqual(t.calls.at(-1), ['openPage', 'file', { path: 'src/a.ts', line: 4, col: 2 }, { title: 'a.ts', icon: 'file', focus: false }])
  const view = t.connect(t.open[0].id)
  // A relative path resolves against the caller's cwd. The open tab is pointed at, never selected:
  // the unseen dot again (main skips a shown tab) and a goto that leaves the keyboard alone.
  await f.cli.edit(['a.ts:9'], { cwd: `${f.ctx.projectDir}/src` })
  assert.equal(t.open.length, 1)
  assert.equal(t.calls.some((c) => c[0] === 'focus'), false)
  assert.deepEqual(t.calls.at(-1), ['markUnseen', t.open[0].id])
  assert.deepEqual(view.posted.at(-1), { t: 'goto', line: 9, focus: false })
  // An absolute path inside the project is the same file.
  const abs = await f.cli.edit([`${f.ctx.projectDir}/src/a.ts:3:1`], { cwd: '/' })
  assert.equal(abs.code, undefined)
  assert.equal(t.open.length, 1)
  assert.deepEqual(view.posted.at(-1), { t: 'goto', line: 3, col: 1, focus: false })
  // Outside the project, a bad position: refused, nothing opened.
  for (const bad of [['../x:1'], ['/etc/hosts:1'], ['link.txt'], ['a.ts:0']]) {
    const e = await f.cli.edit(bad, { cwd: f.ctx.projectDir })
    assert.equal(e.code, 1, bad.join())
    assert.match(e.stderr, /^edit: /)
  }
  assert.equal(t.open.length, 1)
  assert.equal(f.started.length, 0)
  host.deactivate()
})

test('ccc edit refuses a missing or binary file and opens nothing, no overlay, no file opener', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.projectDir = project()
  const opened = []
  f.ctx.files = { open: async (p) => (opened.push(p), { via: 'viewer' }) }
  const t = fakeTabs(f)
  host.activate(f.ctx)
  const missing = await f.cli.edit(['src/nope.ts:3'], { cwd: f.ctx.projectDir })
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /^edit: no such file: src\/nope\.ts/)
  // A range is not a position: a file of that name, which does not exist.
  const range = await f.cli.edit(['src/a.ts:12-20'], { cwd: f.ctx.projectDir })
  assert.equal(range.code, 1)
  assert.match(range.stderr, /no such file: src\/a\.ts:12-20 \(the forms are/)
  const binary = await f.cli.edit(['img.png'], { cwd: f.ctx.projectDir })
  assert.equal(binary.code, 1)
  assert.match(binary.stderr, /^edit: img\.png is not a text file/)
  const dir = await f.cli.edit(['src'], { cwd: f.ctx.projectDir })
  assert.equal(dir.code, 1)
  assert.deepEqual(t.open, [])
  assert.deepEqual(opened, [])
  assert.deepEqual(f.started, [])
  host.deactivate()
})

test('ccc edit from a realpath cwd reaches a project opened through a symlinked folder; a cwd outside is refused', async () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  const real = project()
  const aliasDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edalias-')))
  made.push(aliasDir)
  const alias = path.join(aliasDir, 'proj')
  fs.symlinkSync(real, alias)
  f.ctx.projectDir = alias
  const t = fakeTabs(f)
  host.activate(f.ctx)
  // A shell's cwd is a realpath (getcwd), never the alias.
  const r = await f.cli.edit(['a.ts:2'], { cwd: path.join(real, 'src') })
  assert.equal(r.code, undefined, r.stderr)
  assert.deepEqual(t.calls.at(-1), ['openPage', 'file', { path: 'src/a.ts', line: 2 }, { title: 'a.ts', icon: 'file', focus: false }])
  // The link target's folder is outside: a relative path from there is refused.
  const outside = path.dirname(fs.realpathSync(path.join(real, 'link.txt')))
  const e = await f.cli.edit(['secret.txt'], { cwd: outside })
  assert.equal(e.code, 1)
  assert.match(e.stderr, /^edit: /)
  assert.equal(t.open.length, 1)
  host.deactivate()
})

test('ccc edit help, and the micro fallback (no ctx.tabs) gets the parsed line', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.projectDir = project()
  host.activate(f.ctx)
  for (const argv of [[], ['help'], ['--help'], ['a.ts', '--help']]) {
    const h = await f.cli.edit(argv, { cwd: f.ctx.projectDir })
    assert.match(h.stdout, /^usage: ccc edit <file>\[:line\[:col\]\]/, argv.join(' '))
    assert.equal(h.code, undefined)
  }
  assert.equal(f.started.length, 0)
  const r = await f.cli.edit(['src/a.ts:7:3'], { cwd: f.ctx.projectDir })
  assert.equal(r.stdout, 'editing src/a.ts\n')
  assert.deepEqual(f.started[0].argv.slice(-2), ['src/a.ts', '+7'])
  host.deactivate()
})

test('quick open and find in files: a page pick opens its file tab; a bad path is told, never opened', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.projectDir = project()
  const t = fakeTabs(f)
  host.activate(f.ctx)
  await f.provided.editor.open('empty.txt')
  const view = t.connect(t.open[0].id)
  view.send({ t: 'openFile', path: 'src/a.ts', line: 3, col: 2 })
  await until(() => t.open.length === 2, 5000, 'the pick opened')
  assert.deepEqual(t.calls.at(-1), ['openPage', 'file', { path: 'src/a.ts', line: 3, col: 2 }, { title: 'a.ts', icon: 'file', focus: true }])
  const told = () => view.posted.filter((m) => m.t === 'search-error')
  for (const bad of ['../x', '/etc/hosts', 'link.txt']) {
    const n = told().length
    view.send({ t: 'openFile', path: bad })
    await until(() => told().length === n + 1, 5000, bad)
    assert.equal(told().at(-1).kind, 'open')
  }
  // An fs error (an unreadable folder: realpath's EACCES) never carries the absolute path to the page.
  const locked = path.join(f.ctx.projectDir, 'locked')
  fs.mkdirSync(locked)
  fs.writeFileSync(path.join(locked, 'a.txt'), 'x')
  fs.chmodSync(locked, 0o000)
  try {
    const n = told().length
    view.send({ t: 'openFile', path: 'locked/a.txt' })
    await until(() => told().length === n + 1, 5000, 'locked')
    if (process.getuid && process.getuid() !== 0) assert.equal(told().at(-1).message, 'permission denied: locked/a.txt')
    assert.ok(!told().at(-1).message.includes(f.ctx.projectDir), told().at(-1).message)
  } finally {
    fs.chmodSync(locked, 0o755)
  }
  await drained()
  assert.equal(t.open.length, 2)
  // Search messages go to lib/search.js: no ctx.processes here (an older app), so it is said on the tab.
  view.send({ t: 'files', req: 7 })
  assert.deepEqual(view.posted.at(-1), { t: 'search-error', kind: 'files', req: 7, message: 'quick open needs a newer cockpit (ctx.processes)' })
  host.deactivate()
})

test('plain click (ctx.files.onOpen, the project picked the editor): a text file opens its tab; a binary one is refused for the built-in viewer', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.projectDir = project()
  const t = fakeTabs(f)
  const listeners = []
  const viewed = []
  f.ctx.files = { onOpen: (fn) => (listeners.push(fn), () => {}), open: async (p) => (viewed.push(p), { via: 'builtin' }) }
  host.activate(f.ctx)
  assert.equal(listeners.length, 1)
  await listeners[0]({ path: 'src/a.ts', tabId: 'x' })
  assert.deepEqual(t.calls.at(-1), ['openPage', 'file', { path: 'src/a.ts' }, { title: 'a.ts', icon: 'file', focus: true }])
  // Again: the open tab is focused, no second one.
  await listeners[0]({ path: 'src/a.ts' })
  assert.deepEqual(t.calls.at(-1), ['focus', t.open[0].id])
  // A binary file: the listener throws (main then opens its built-in viewer) and never calls
  // ctx.files.open, which would route back to this same listener.
  await assert.rejects(listeners[0]({ path: 'img.png' }), /binary/)
  assert.deepEqual(viewed, [])
  assert.equal(t.open.length, 1)
  host.deactivate()
  // The manifest: a general openFile declaration, offered only when picked.
  assert.deepEqual(require('../plugin.json').contributes.openFile, { title: 'Editor (a file tab)', whenPicked: true })
  // An app without page tabs registers no listener.
  const g = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  const none = []
  g.ctx.files = { onOpen: (fn) => none.push(fn) }
  host.activate(g.ctx)
  assert.equal(none.length, 0)
})

test("Claude's changes: a file tab answers git-base from its own path and git-review through the reviewer service", async () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const cp = require('node:child_process')
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.projectDir = project()
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  const run = (...a) => cp.execFileSync('git', a, { cwd: f.ctx.projectDir, env, stdio: 'pipe' })
  fs.writeFileSync(path.join(f.ctx.projectDir, 'a.txt'), 'one\n')
  run('init', '-q')
  run('add', '-A')
  run('commit', '-q', '-m', 'x')
  fs.writeFileSync(path.join(f.ctx.projectDir, 'a.txt'), 'two\n')
  const used = []
  f.ctx.services.use = (name) => ({ open: async (p) => void used.push([name, p]) })
  f.ctx.processes = {
    spawn: (argv, { cwd }) => {
      const c = cp.spawn(argv[0], argv.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
      return {
        pid: c.pid,
        onData: (fn) => c.stdout.on('data', fn),
        onStderr: (fn) => c.stderr.on('data', fn),
        onExit: (fn) => c.on('close', (code, signal) => fn({ code, signal })),
        end: () => c.stdin.end(),
        kill: () => c.kill(),
      }
    },
  }
  const t = fakeTabs(f)
  host.activate(f.ctx)
  await f.provided.editor.open('a.txt')
  const view = t.connect(t.open[0].id)
  // The page names no path: the tab's own is used, whatever a message says.
  view.send({ t: 'git-base', req: 5, path: 'other.txt' })
  await until(() => view.posted.some((m) => m.t === 'git-base'), 5000, 'git-base')
  assert.deepEqual(view.posted.filter((m) => m.t === 'git-base'), [{ t: 'git-base', req: 5, has: true, part: 0, parts: 1, text: 'one\n' }])
  view.send({ t: 'git-review', path: 'other.txt' })
  await until(() => used.length > 0, 5000, 'the review')
  await drained()
  assert.deepEqual(used, [['reviewer', 'a.txt']])
  // The manifest declares the reviewer service this click needs.
  assert.deepEqual(require('../plugin.json').services.uses, { reviewer: 1 })
  await host.deactivate()
})

test('Ask Claude: a file tab answers core\'s Discuss with its own path, the page\'s lines and the fenced selection', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.projectDir = project()
  const t = fakeTabs(f)
  host.activate(f.ctx)
  await f.provided.editor.open('a.txt')
  const view = t.connect(t.open[0].id)
  const answer = view.discuss()
  assert.deepEqual(view.posted.filter((m) => m.t === 'ask-context'), [{ t: 'ask-context', req: 1 }])
  // A path in the page's message is ignored: the header is the tab's own.
  view.send({ t: 'ask-context', req: 1, path: 'other.txt', startLine: 2, endLine: 3, text: 'a\n```\nb' })
  assert.deepEqual(await answer, { text: 'a.txt:2-3\n````\na\n```\nb\n````' })
  await host.deactivate()
})

test('Quick chat: a file tab routes chat-* messages to lib/quick-chat.js (refused here before anything runs)', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.projectDir = project()
  const t = fakeTabs(f)
  host.activate(f.ctx)
  await f.provided.editor.open('a.txt')
  const view = t.connect(t.open[0].id)
  // No ctx.processes in this fake (an older app): said on the tab, nothing spawned.
  view.send({ t: 'chat-start', id: 3, question: 'why?', sel: { startLine: 1, text: 'x' } })
  await until(() => view.posted.some((m) => m.t === 'chat-end'), 5000, 'chat-end')
  assert.deepEqual(view.posted.filter((m) => m.t === 'chat-end'), [{ t: 'chat-end', id: 3, message: 'Quick chat: quick chat needs a newer cockpit (ctx.processes)', error: true }])
  await host.deactivate()
})

test('Review notes: a file tab reads and adds notes through the reviewer service on its own path; no provider is has: false', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.projectDir = project()
  const t = fakeTabs(f)
  const calls = []
  let listener = null
  let available = false
  f.ctx.services.available = (n) => n === 'reviewer' && available
  f.ctx.services.use = (n) => ({
    notes: async (p) => (calls.push(['notes', n, p]), [{ id: 'a', from: 1, to: 1, text: 'look', quote: 'x' }]),
    addNote: async (p, note) => (calls.push(['addNote', p, note]), { id: 'e1' }),
    on: (event, fn) => ((listener = { event, fn }), () => (listener = null)),
  })
  host.activate(f.ctx)
  await f.provided.editor.open('a.txt')
  const view = t.connect(t.open[0].id)
  // Each answer is waited for by its req; the fake service answers with resolved promises only.
  const answer = (t, req) => until(() => view.posted.some((m) => m.t === t && m.req === req), 5000, `${t} ${req}`)
  // No provider: no marks, nothing asked, nothing added.
  view.send({ t: 'notes-get', req: 1, connect: true })
  await answer('notes', 1)
  assert.deepEqual(view.posted.filter((m) => m.t === 'notes'), [{ t: 'notes', req: 1, has: false }])
  view.send({ t: 'notes-add', req: 2, from: 1, text: 'x' })
  await answer('notes-added', 2)
  assert.deepEqual(view.posted.filter((m) => m.t === 'notes-added'), [{ t: 'notes-added', req: 2, ok: false, message: 'no Reviewer plugin is available' }])
  assert.deepEqual(calls, [])
  // A provider (resolved again on the next ask): the tab's own path, whatever the page says.
  available = true
  view.send({ t: 'notes-get', req: 3, path: 'other.txt' })
  await answer('notes', 3)
  assert.deepEqual(calls, [['notes', 'reviewer', 'a.txt']])
  assert.deepEqual(view.posted.filter((m) => m.t === 'notes').at(-1), { t: 'notes', req: 3, has: true, notes: [{ id: 'a', from: 1, to: 1, text: 'look' }] })
  view.send({ t: 'notes-add', req: 4, path: 'other.txt', from: 2, to: 2, text: 'why', quote: 'q' })
  await answer('notes-added', 4)
  // The fresh `notes` an add is followed by (req 0) lands before the count below.
  await drained()
  assert.deepEqual(calls.filter((c) => c[0] === 'addNote'), [['addNote', 'a.txt', { from: 2, to: 2, text: 'why', quote: 'q' }]])
  assert.deepEqual(view.posted.filter((m) => m.t === 'notes-added').at(-1), { t: 'notes-added', req: 4, ok: true })
  // The Reviewer's event for this file pushes the notes again; the tab closing stops listening.
  assert.equal(listener.event, 'notesChange')
  const before = view.posted.length
  listener.fn({ path: 'a.txt' })
  await until(() => view.posted.length > before, 5000, 'pushed notes')
  await drained()
  assert.deepEqual(view.posted.slice(before).map((m) => [m.t, m.req]), [['notes', 0]])
  view.close()
  assert.equal(listener, null)
  // The manifest declares the service these calls need.
  assert.deepEqual(require('../plugin.json').services.uses, { reviewer: 1 })
  await host.deactivate()
})

test('open routing: two opens of one file at once make one tab; the second focuses it and moves its line', async () => {
  const host = require('../dist/host.js')
  const f = fakeCtx({ execResult: { code: 0, stdout: 'micro version 2', stderr: '' } })
  f.ctx.projectDir = project()
  const t = fakeTabs(f)
  // Main's answers take a while: both opens read the list before either tab exists.
  const { list, openPage } = f.ctx.tabs
  const later = () => new Promise((resolve) => setTimeout(resolve, 5))
  f.ctx.tabs.list = async (type) => (await later(), list(type))
  f.ctx.tabs.openPage = async (...a) => (await later(), openPage(...a))
  host.activate(f.ctx)
  const both = await Promise.all([f.provided.editor.open('src/a.ts'), f.provided.editor.open('./src/a.ts', { line: 3 }), f.provided.editor.open('src/a.ts')])
  assert.deepEqual(both, [{ opened: true }, { opened: true }, { opened: true }])
  assert.equal(t.open.length, 1)
  assert.equal(t.calls.filter((c) => c[0] === 'openPage').length, 1)
  assert.equal(t.calls.filter((c) => c[0] === 'focus').length, 2)
  // The second open's line waits for the page (no frame connected yet).
  const view = t.connect(t.open[0].id)
  view.send({ t: 'open', first: true, req: 1 })
  assert.deepEqual(view.posted.filter((m) => m.t === 'goto'), [{ t: 'goto', line: 3 }])
  // Another file at the same time is not held up by it.
  await Promise.all([f.provided.editor.open('src/b.ts'), f.provided.editor.open('src/c.ts')])
  assert.equal(t.open.length, 3)
  host.deactivate()
})
