'use strict'
// The right-click menu's host side: lib/ops.js (New file, New folder, Rename, confined to the
// project by real path, never replacing an entry) and the host's menu messages against a fake ctx
// (what reaches ctx.files.*, ctx.sessions.open and the page). Temp dirs only.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ops = require('../dist/lib/ops')

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'files-menu-')))
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'files-out-')))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'a\n')
  fs.writeFileSync(path.join(root, 'notes.txt'), 'n\n')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's\n')
  fs.symlinkSync(outside, path.join(root, 'out'))
  return { root, outside }
}

test('checkName: one segment, not . or .., no NUL, at most 255 bytes', () => {
  for (const ok of ['a', 'a b', '.env', 'ü.txt', 'x'.repeat(255)]) assert.equal(ops.checkName(ok), ok)
  const bad = [['', /Type a name/], ['   ', /Type a name/], ['.', /cannot be a name/], ['..', /cannot be a name/], ['a/b', /"\/"/], ['a\0b', /NUL/], ['x'.repeat(256), /255 bytes/], ['ü'.repeat(128), /255 bytes/], [7, /Type a name/]]
  for (const [name, why] of bad) assert.throws(() => ops.checkName(name), why, String(name))
})

test('createFile / createFolder: inside the project, refusing an existing name', async () => {
  const { root } = project()
  assert.equal(await ops.createFile(root, 'src', 'b.js'), 'src/b.js')
  assert.equal(fs.readFileSync(path.join(root, 'src', 'b.js'), 'utf8'), '')
  assert.equal(await ops.createFolder(root, '', 'lib'), 'lib')
  assert.ok(fs.statSync(path.join(root, 'lib')).isDirectory())
  await assert.rejects(ops.createFile(root, 'src', 'a.js'), /already exists/)
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8'), 'a\n') // never truncated
  await assert.rejects(ops.createFolder(root, '', 'src'), /already exists/)
  await assert.rejects(ops.createFile(root, '', 'src'), /already exists/)
  // A dangling link of that name is an existing name too (O_EXCL does not follow it).
  fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dangle'))
  await assert.rejects(ops.createFile(root, '', 'dangle'), /already exists/)
  assert.equal(fs.existsSync(path.join(root, 'nowhere')), false)
})

test('createFile / createFolder: never through a link out of the project, nor with a path for a name', async () => {
  const { root, outside } = project()
  await assert.rejects(ops.createFile(root, 'out', 'x.txt'), /outside the project/)
  await assert.rejects(ops.createFolder(root, 'out', 'x'), /outside the project/)
  await assert.rejects(ops.createFile(root, '../' + path.basename(outside), 'x.txt'), /outside the project/)
  await assert.rejects(ops.createFile(root, '', '../x.txt'), /"\/"/)
  await assert.rejects(ops.createFile(root, '', '..'), /cannot be a name/)
  await assert.rejects(ops.createFile(root, 'notes.txt', 'x'), /not a folder/)
  await assert.rejects(ops.createFile(root, 'gone', 'x'), /is gone/)
  assert.deepEqual(fs.readdirSync(outside), ['secret.txt'])
})

test('renameEntry: in place, refusing an existing name, the project folder and a link out', async () => {
  const { root, outside } = project()
  assert.equal(await ops.renameEntry(root, 'src/a.js', 'b.js'), 'src/b.js')
  assert.ok(fs.existsSync(path.join(root, 'src', 'b.js')))
  assert.equal(await ops.renameEntry(root, 'src', 'lib'), 'lib')
  assert.ok(fs.existsSync(path.join(root, 'lib', 'b.js')))
  await assert.rejects(ops.renameEntry(root, 'notes.txt', 'lib'), /already exists/)
  assert.ok(fs.existsSync(path.join(root, 'notes.txt')))
  assert.equal(await ops.renameEntry(root, 'notes.txt', 'notes.txt'), 'notes.txt')
  await assert.rejects(ops.renameEntry(root, '', 'x'), /project folder/)
  await assert.rejects(ops.renameEntry(root, 'out/secret.txt', 'x.txt'), /outside the project/)
  await assert.rejects(ops.renameEntry(root, 'gone.txt', 'x.txt'), /is gone/)
  await assert.rejects(ops.renameEntry(root, 'notes.txt', 'a/b'), /"\/"/)
  // The link itself is renamed, never its target.
  assert.equal(await ops.renameEntry(root, 'out', 'elsewhere'), 'elsewhere')
  assert.ok(fs.lstatSync(path.join(root, 'elsewhere')).isSymbolicLink())
  assert.deepEqual(fs.readdirSync(outside), ['secret.txt'])
})

// ---- the host's menu messages, against a fake ctx ----

/** Activate the host with a fake ctx; `send` is the page's message, `posts` what the host posted. */
async function host(root, { trash, openWith, openCommand = true, overlayResult } = {}) {
  delete require.cache[require.resolve('../dist/host')]
  const hostMod = require('../dist/host')
  const calls = []
  const posts = []
  let onMessage
  const store = new Map()
  const ctx = {
    projectDir: root,
    settings: { app: openWith ? { openWith } : {} },
    exec: async () => ({ code: 1, stdout: '', stderr: 'no git here' }),
    services: { use: () => ({ open: async () => {} }) },
    storage: { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) },
    log: { info() {}, warn() {}, error() {} },
    panels: {
      post: (_panel, m) => void posts.push(m),
      onMessage: (_panel, fn) => {
        onMessage = fn
        return () => {}
      }
    },
    onSettingsChange: () => () => {},
    files: {
      open: async (p) => void calls.push(['open', p]),
      reveal: async (p) => void calls.push(['reveal', p]),
      openWithSystem: async (p) => void calls.push(['openWithSystem', p]),
      trash:
        trash ??
        (async (p) => {
          calls.push(['trash', p])
          fs.rmSync(path.join(root, p), { recursive: true })
        })
    },
    sessions: {
      open: async (o) => void calls.push(['sessions.open', o]),
      openShell: async (o) => void calls.push(['sessions.openShell', o]),
      ...(openCommand ? { openCommand: async (o) => void calls.push(['sessions.openCommand', o]) } : {})
    },
    overlay: {
      start: (spec) => {
        calls.push(['overlay.start', spec])
        return { result: overlayResult ? overlayResult() : new Promise(() => {}) }
      }
    }
  }
  hostMod.activate(ctx)
  const send = async (m) => {
    await onMessage(m)
  }
  return { send, calls, posts, done: () => hostMod.deactivate() }
}

test('host: reveal, open with default app and trash go to ctx.files with the checked path', async () => {
  const { root } = project()
  const h = await host(root)
  try {
    await h.send({ type: 'reveal', path: './src' })
    await h.send({ type: 'open-system', path: 'notes.txt' })
    await h.send({ type: 'trash', path: 'src/a.js' })
    assert.deepEqual(h.calls, [['reveal', 'src'], ['openWithSystem', 'notes.txt'], ['trash', 'src/a.js']])
    assert.ok(h.posts.some((m) => m.type === 'gone' && m.path === 'src/a.js'))
    // A path the page should never send is refused before ctx sees it, and shown as an error.
    await h.send({ type: 'trash', path: '../x' })
    assert.equal(h.calls.length, 3)
    assert.match(h.posts.at(-1).message, /outside the project/)
  } finally {
    h.done()
  }
})

test("host: the person's no to the Trash dialog shows nothing; another failure is an error", async () => {
  const { root } = project()
  let fail
  const h = await host(root, {
    trash: async () => {
      throw fail
    }
  })
  try {
    fail = Object.assign(new Error('files.trash: cancelled; nothing was moved'), { name: 'AbortError' })
    const before = h.posts.length
    await h.send({ type: 'trash', path: 'notes.txt' })
    assert.equal(h.posts.length, before)
    fail = new Error('files.trash: notes.txt resolves outside the project folder')
    await h.send({ type: 'trash', path: 'notes.txt' })
    assert.deepEqual(h.posts.at(-1), { type: 'error', message: 'files.trash: notes.txt resolves outside the project folder' })
  } finally {
    h.done()
  }
})

test('host: Ask Claude opens a focused Claude tab with a prompt naming the path, never the content', async () => {
  const { root } = project()
  const h = await host(root)
  try {
    await h.send({ type: 'ask', path: 'src/a.js' })
    assert.equal(h.calls.length, 1)
    const [what, opts] = h.calls[0]
    assert.equal(what, 'sessions.open')
    assert.equal(opts.focus, true)
    assert.match(opts.prompt, /^Have a look at src\/a\.js in this project/)
    assert.equal(opts.prompt.includes('a\n'), false)
    await h.send({ type: 'ask', path: '' })
    assert.equal(h.calls.length, 1)
  } finally {
    h.done()
  }
})

test('host: Open terminal here opens a focused shell tab in that folder, checked inside the project', async () => {
  const { root } = project()
  const h = await host(root)
  try {
    await h.send({ type: 'terminal', path: './src' })
    await h.send({ type: 'terminal', path: '' })
    // Only a cwd and focus: never a command, argv or env.
    assert.deepEqual(h.calls, [['sessions.openShell', { cwd: 'src', focus: true }], ['sessions.openShell', { cwd: undefined, focus: true }]])
    // A path the page should never send is refused before ctx sees it, and shown as an error.
    await h.send({ type: 'terminal', path: '../x' })
    assert.equal(h.calls.length, 2)
    assert.match(h.posts.at(-1).message, /outside the project/)
  } finally {
    h.done()
  }
})

test('host: create and rename write inside the project, refresh the folder and select the result', async () => {
  const { root, outside } = project()
  const h = await host(root)
  try {
    await h.send({ type: 'create', dir: 'src', kind: 'file', name: 'new.js' })
    assert.ok(fs.existsSync(path.join(root, 'src', 'new.js')))
    const dir = h.posts.filter((m) => m.type === 'dir' && m.path === 'src').at(-1)
    assert.ok(dir.entries.some((e) => e.name === 'new.js'))
    assert.deepEqual(h.posts.at(-1), { type: 'select', path: 'src/new.js' })

    await h.send({ type: 'create', dir: '', kind: 'dir', name: 'docs' })
    assert.ok(fs.statSync(path.join(root, 'docs')).isDirectory())

    await h.send({ type: 'rename', path: 'src/new.js', name: 'renamed.js' })
    assert.ok(fs.existsSync(path.join(root, 'src', 'renamed.js')))
    assert.deepEqual(h.posts.at(-1), { type: 'select', path: 'src/renamed.js' })

    // An open folder renamed stays open under its new name.
    await h.send({ type: 'expand', path: 'src' })
    await h.send({ type: 'rename', path: 'src', name: 'lib' })
    const reset = h.posts.filter((m) => m.type === 'reset').at(-1)
    assert.ok(reset.expanded.includes('lib'))
    assert.equal(reset.expanded.includes('src'), false)
    assert.deepEqual(h.posts.at(-1), { type: 'select', path: 'lib' })

    // Refusals reach the page as errors, and nothing is written.
    for (const m of [
      { type: 'create', dir: 'out', kind: 'file', name: 'x' },
      { type: 'create', dir: '', kind: 'file', name: 'notes.txt' },
      { type: 'rename', path: 'notes.txt', name: '../x' },
      { type: 'rename', path: 'lib', name: 'docs' }
    ]) {
      await h.send(m)
      assert.equal(h.posts.at(-1).type, 'error', JSON.stringify(m))
    }
    assert.deepEqual(fs.readdirSync(outside), ['secret.txt'])
  } finally {
    h.done()
  }
})

test('host: the reset tells the page the root, separator, platform and that the system and shell calls exist', async () => {
  const { root } = project()
  const h = await host(root)
  try {
    await h.send({ type: 'hello' })
    const reset = h.posts.find((m) => m.type === 'reset')
    assert.deepEqual(reset.env, { root, sep: path.sep, platform: process.platform, system: true, shell: true })
    assert.deepEqual(reset.openWith, [])
  } finally {
    h.done()
  }
})

const RULES = [
  { extensions: 'pdf', action: 'system' },
  { extensions: 'json', action: 'terminal', command: 'jq -C . {file}' },
  { extensions: 'log', action: 'terminal', command: 'less {file}', where: 'tab', waitForKey: false },
  { extensions: 'md', action: 'default' },
  { extensions: 'csv', action: 'terminal', command: 'sh -c "column {file}"' },
  { extensions: 'json', action: 'system' },
]

test('host: Open with: a click takes the first matching rule; no rule opens the file viewer', async () => {
  const { root } = project()
  const h = await host(root, { openWith: RULES })
  try {
    await h.send({ type: 'open', path: 'docs/a.pdf' })
    await h.send({ type: 'open', path: 'data/x y.json' })
    await h.send({ type: 'open', path: 'app.log' })
    await h.send({ type: 'open', path: 'README.md' })
    await h.send({ type: 'open', path: 'src/a.js' })
    const ow = require('../dist/lib/open-with')
    assert.deepEqual(h.calls, [
      ['openWithSystem', 'docs/a.pdf'],
      ['overlay.start', { kind: 'terminal', argv: ['sh', '-c', ow.WAIT_SCRIPT, 'sh', 'jq', '-C', '.', 'data/x y.json'], title: 'jq: data/x y.json', size: 'large' }],
      ['sessions.openCommand', { argv: ['less', 'app.log'], title: 'less: app.log', focus: true }],
      ['open', 'README.md'],
      ['open', 'src/a.js'],
    ])
    assert.equal(h.posts.filter((m) => m.type === 'error').length, 0)
  } finally {
    h.done()
  }
})

test('host: Open with from the menu: a rule by index, -1 for the viewer, a stale index refused; a broken rule says why', async () => {
  const { root } = project()
  const h = await host(root, { openWith: RULES })
  try {
    await h.send({ type: 'open', path: 'x.json', rule: 5 })
    await h.send({ type: 'open', path: 'x.json', rule: -1 })
    await h.send({ type: 'open', path: 'x.json', rule: 0 }) // the pdf rule: not this file's
    await h.send({ type: 'open', path: 't.csv' })
    assert.deepEqual(h.calls, [['openWithSystem', 'x.json'], ['open', 'x.json']])
    const errors = h.posts.filter((m) => m.type === 'error').map((m) => m.message)
    assert.match(errors[0], /does not match this file any more/)
    assert.match(errors[1], /^Open with rule 5 \(csv\): \{file\} must be a word of its own/)
    await h.send({ type: 'hello' })
    const reset = h.posts.find((m) => m.type === 'reset')
    assert.deepEqual(reset.openWith.map((r) => [r.index, r.label, r.error !== undefined]), [
      [0, 'System app', false], [1, 'jq (terminal)', false], [2, 'less (new tab)', false], [3, 'Default opener', false], [4, 'Terminal command', true], [5, 'System app', false],
    ])
    assert.ok(!JSON.stringify(reset.openWith).includes('jq -C'), 'the commands stay in the host')
  } finally {
    h.done()
  }
})

test('host: Open with a tab on an app without openCommand uses an overlay; a refused overlay or a missing program is shown', async () => {
  const { root } = project()
  let n = 0
  const h = await host(root, {
    openWith: RULES,
    openCommand: false,
    overlayResult: () => (n++ === 0 ? Promise.reject(new Error('overlay: 3 are open already')) : Promise.resolve({ kind: 'exit', code: 127 })),
  })
  try {
    await h.send({ type: 'open', path: 'app.log' })
    await h.send({ type: 'open', path: 'b.json' })
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(h.calls.map((c) => [c[0], c[1].argv]), [['overlay.start', ['less', 'app.log']], ['overlay.start', h.calls[1][1].argv]])
    const errors = h.posts.filter((m) => m.type === 'error').map((m) => m.message)
    assert.deepEqual(errors, ['Open with rule 3 (log): overlay: 3 are open already', 'Open with rule 2 (json): jq was not found (exit 127).'])
  } finally {
    h.done()
  }
})
