'use strict'
// Claude's changes in the gutter, the host's half (dist/lib/git.js): the argv a path cannot turn into
// an option, the blob read from a real repository (tracked, untracked, no repository, a path starting
// with `-`, a subfolder project, CRLF), the caps, and the per-line protocol. The reads use the real
// git when it is installed (skipped otherwise) through a spawn with ctx.processes' shape.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const git = require('../dist/lib/git.js')

const hasGit = cp.spawnSync('git', ['--version']).status === 0

/** ctx.processes.spawn's shape over node's spawn (argv only, never a shell). */
function nodeSpawn(argv, { cwd }) {
  const c = cp.spawn(argv[0], argv.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  c.on('error', () => {})
  if (c.pid === undefined) throw new Error(`processes: cannot run ${argv[0]}`)
  return {
    pid: c.pid,
    onData: (fn) => c.stdout.on('data', fn),
    onStderr: (fn) => c.stderr.on('data', fn),
    onExit: (fn) => c.on('close', (code, signal) => fn({ code, signal })),
    end: () => c.stdin.end(),
    kill: () => c.kill(),
  }
}

/** A spawn the test drives: `children` records each run. */
function fakeSpawn() {
  const children = []
  const spawn = (argv, opts) => {
    const l = { data: [], err: [], exit: [] }
    const child = {
      argv,
      opts,
      killed: false,
      onData: (fn) => l.data.push(fn),
      onStderr: (fn) => l.err.push(fn),
      onExit: (fn) => l.exit.push(fn),
      end() {},
      kill() {
        if (child.killed) return
        child.killed = true
        setImmediate(() => l.exit.forEach((f) => f({ code: null, signal: 'SIGTERM' })))
      },
      emit: (s) => l.data.forEach((f) => f(Buffer.from(s))),
      exit: (code) => l.exit.forEach((f) => f({ code, signal: null })),
    }
    children.push(child)
    return child
  }
  return { spawn, children }
}

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const run = (cwd, ...args) => cp.execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, stdio: 'pipe' })

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edgit-')))
}

/** A repository with one commit of `files` ({ rel: text }). */
function repo(files) {
  const root = tmp()
  run(root, 'init', '-q')
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  run(root, 'add', '-A')
  run(root, 'commit', '-q', '-m', 'one')
  return root
}

const read = (root, rel, opts) => git.readBase(nodeSpawn, root, rel, opts).result

test('blobArgv: one argument HEAD:./path, so no path is an option; escapes are refused', () => {
  assert.deepEqual(git.blobArgv('src/a.ts'), ['git', 'cat-file', 'blob', 'HEAD:./src/a.ts'])
  assert.deepEqual(git.blobArgv('-rf'), ['git', 'cat-file', 'blob', 'HEAD:./-rf'])
  assert.deepEqual(git.blobArgv('--batch'), ['git', 'cat-file', 'blob', 'HEAD:./--batch'])
  assert.deepEqual(git.blobArgv('a b:c\nd'), ['git', 'cat-file', 'blob', 'HEAD:./a b:c\nd'])
  for (const bad of ['', undefined, '/etc/passwd', '../x', 'a/../../x', 'a\0b']) assert.throws(() => git.blobArgv(bad), bad)
})

test('a tracked file: its text at HEAD, whatever the working file says now', { skip: !hasGit }, async () => {
  const root = repo({ 'a.txt': 'one\ntwo\n' })
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\nthree\n')
  assert.deepEqual(await read(root, 'a.txt'), { text: 'one\ntwo\n' })
})

test('a path starting with - is a file, never an option', { skip: !hasGit }, async () => {
  const root = repo({ '-p': 'dash\n', '--batch': 'batch\n' })
  assert.deepEqual(await read(root, '-p'), { text: 'dash\n' })
  assert.deepEqual(await read(root, '--batch'), { text: 'batch\n' })
  // Untracked with an option-looking name: no marks, and git was never given the name as an option.
  fs.writeFileSync(path.join(root, '--help'), 'x\n')
  assert.deepEqual(await read(root, '--help'), { text: null })
})

test('untracked, added but not committed, deleted from HEAD: no base', { skip: !hasGit }, async () => {
  const root = repo({ 'a.txt': 'a\n' })
  fs.writeFileSync(path.join(root, 'new.txt'), 'n\n')
  assert.deepEqual(await read(root, 'new.txt'), { text: null })
  run(root, 'add', 'new.txt')
  assert.deepEqual(await read(root, 'new.txt'), { text: null })
  assert.deepEqual(await read(root, 'gone.txt'), { text: null })
})

test('not a repository, a repository with no commit: no base', { skip: !hasGit }, async () => {
  const plain = tmp()
  fs.writeFileSync(path.join(plain, 'a.txt'), 'a\n')
  assert.deepEqual(await read(plain, 'a.txt'), { text: null })
  const empty = tmp()
  run(empty, 'init', '-q')
  fs.writeFileSync(path.join(empty, 'a.txt'), 'a\n')
  assert.deepEqual(await read(empty, 'a.txt'), { text: null })
})

test('a project that is a subfolder of the repository: the path is relative to the project', { skip: !hasGit }, async () => {
  const root = repo({ 'sub/a.txt': 'inner\n', 'a.txt': 'outer\n' })
  assert.deepEqual(await read(path.join(root, 'sub'), 'a.txt'), { text: 'inner\n' })
})

test('CRLF and a BOM come back as the page sees the file; binary and non-UTF-8 blobs have no base', { skip: !hasGit }, async () => {
  const root = tmp()
  run(root, 'init', '-q')
  fs.writeFileSync(path.join(root, 'crlf.txt'), 'a\r\nb\r\n')
  fs.writeFileSync(path.join(root, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x\n')]))
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3]))
  fs.writeFileSync(path.join(root, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  run(root, 'add', '-A')
  run(root, 'commit', '-q', '-m', 'x')
  assert.deepEqual(await read(root, 'crlf.txt'), { text: 'a\nb\n' })
  assert.deepEqual(await read(root, 'bom.txt'), { text: 'x\n' })
  assert.deepEqual(await read(root, 'bin.dat'), { text: null })
  assert.deepEqual(await read(root, 'latin.txt'), { text: null })
})

test('a tracked link has no base (HEAD holds the target path, the page shows the target)', { skip: !hasGit }, async () => {
  const root = repo({ 'real.txt': 'r\n' })
  fs.symlinkSync('real.txt', path.join(root, 'link.txt'))
  run(root, 'add', '-A')
  run(root, 'commit', '-q', '-m', 'link')
  assert.deepEqual(await read(root, 'link.txt'), { text: null })
})

test('git missing: no base, not an error; any other spawn failure is an error', async () => {
  const missing = () => {
    throw new Error('processes: cannot run git')
  }
  assert.deepEqual(await git.readBase(missing, '/p', 'a.txt').result, { text: null })
  const capped = () => {
    throw new Error('processes: too many processes')
  }
  await assert.rejects(git.readBase(capped, '/p', 'a.txt').result, /too many/)
})

test('the argv and cwd of a read; a blob over the cap is killed and has no base', async () => {
  const f = fakeSpawn()
  const slots = { used: 0, max: 2 }
  const job = git.readBase(f.spawn, '/proj', 'src/-a.ts', { maxBytes: 10, slots })
  assert.deepEqual(f.children[0].argv, ['git', 'cat-file', 'blob', 'HEAD:./src/-a.ts'])
  assert.equal(f.children[0].opts.cwd, '/proj')
  // lstat of a path that is not there: not a link, the read goes on.
  assert.equal(slots.used, 1)
  f.children[0].emit('0123456789')
  assert.equal(f.children[0].killed, false)
  f.children[0].emit('x')
  assert.equal(f.children[0].killed, true)
  assert.deepEqual(await job.result, { text: null })
  assert.equal(slots.used, 0)
})

test('the plugin-wide cap: a third read waits for a slot, not refused; a finished one gives its slot back', async () => {
  const f = fakeSpawn()
  const slots = { used: 0, max: 2, queue: [] }
  const a = git.readBase(f.spawn, '/p', 'a', { slots })
  const b = git.readBase(f.spawn, '/p', 'b', { slots })
  const c = git.readBase(f.spawn, '/p', 'c', { slots })
  assert.equal(f.children.length, 2)
  f.children[0].emit('x\n')
  f.children[0].exit(0)
  assert.deepEqual(await a.result, { text: 'x\n' })
  // The slot a read gave back runs the waiting one.
  assert.equal(f.children.length, 3)
  assert.deepEqual(f.children[2].argv.slice(-1), ['HEAD:./c'])
  f.children[2].emit('c\n')
  f.children[2].exit(0)
  assert.deepEqual(await c.result, { text: 'c\n' })
  f.children[1].exit(128)
  assert.deepEqual(await b.result, { text: null })
  assert.equal(slots.used, 0)
  // Exit reported twice gives the slot back once.
  f.children[1].exit(128)
  assert.equal(slots.used, 0)
})

test('a read cancelled while it waits for a slot never spawns', async () => {
  const f = fakeSpawn()
  const slots = { used: 0, max: 1, queue: [] }
  git.readBase(f.spawn, '/p', 'a', { slots })
  const w = git.readBase(f.spawn, '/p', 'w', { slots })
  w.cancel()
  assert.deepEqual(await w.result, { text: null })
  f.children[0].exit(0)
  assert.equal(f.children.length, 1)
  assert.equal(slots.used, 0)
})

test('a file in a nested repository is read from its own repository', async () => {
  const outer = tmp()
  const inner = path.join(outer, 'sub')
  fs.mkdirSync(inner)
  run(inner, 'init', '-q')
  fs.writeFileSync(path.join(inner, 'a.txt'), 'inner\n')
  run(inner, 'add', '-A')
  run(inner, 'commit', '-q', '-m', 'one')
  fs.writeFileSync(path.join(inner, 'a.txt'), 'changed\n')
  assert.deepEqual(await read(outer, 'sub/a.txt'), { text: 'inner\n' })
})

test('a read that outlives its timeout is killed and has no base', async () => {
  const f = fakeSpawn()
  const job = git.readBase(f.spawn, '/p', 'a', { timeoutMs: 5, slots: { used: 0, max: 2 } })
  const r = await job.result
  assert.deepEqual(r, { text: null })
  assert.equal(f.children[0].killed, true)
})

/** A tab's line: what the host posted, the handlers it registered. */
function fakeTab() {
  const posted = []
  const closers = []
  return { posted, tab: { post: (m) => posted.push(m), onClose: (fn) => closers.push(fn) }, close: () => closers.forEach((f) => f()) }
}
const tick = () => new Promise((r) => setImmediate(r))

test('serveGit: git-base answers in parts; no file path or no spawn is has:false; other messages are not taken', async () => {
  const f = fakeSpawn()
  const t = fakeTab()
  const handle = git.serveGit(t.tab, { spawn: f.spawn, root: '/p', rel: 'a.txt', slots: { used: 0, max: 2 } })
  assert.equal(handle({ t: 'save' }), false)
  assert.equal(handle(null), false)
  assert.equal(handle({ t: 'git-base', req: 7 }), true)
  f.children[0].emit('x'.repeat(300 * 1024))
  f.children[0].exit(0)
  await tick()
  assert.ok(t.posted.length >= 3)
  assert.ok(t.posted.every((m) => m.t === 'git-base' && m.req === 7 && m.has === true && m.parts === t.posted.length))
  assert.equal(t.posted.map((m) => m.text).join('').length, 300 * 1024)

  const outside = fakeTab()
  const h2 = git.serveGit(outside.tab, { spawn: f.spawn, root: '/p', rel: undefined })
  h2({ t: 'git-base', req: 1 })
  assert.deepEqual(outside.posted, [{ t: 'git-base', req: 1, has: false }])
  const old = fakeTab()
  git.serveGit(old.tab, { spawn: undefined, root: '/p', rel: 'a.txt' })({ t: 'git-base', req: 2 })
  assert.deepEqual(old.posted, [{ t: 'git-base', req: 2, has: false }])
  assert.equal(f.children.length, 1)
})

test('serveGit: a newer ask kills the older and only the newest answers; a closed line posts nothing', async () => {
  const f = fakeSpawn()
  const t = fakeTab()
  const handle = git.serveGit(t.tab, { spawn: f.spawn, root: '/p', rel: 'a.txt', slots: { used: 0, max: 4 } })
  handle({ t: 'git-base', req: 1 })
  handle({ t: 'git-base', req: 2 })
  assert.equal(f.children[0].killed, true)
  f.children[1].emit('new\n')
  f.children[1].exit(0)
  await tick()
  assert.deepEqual(t.posted.map((m) => [m.req, m.text]), [[2, 'new\n']])
  handle({ t: 'git-base', req: 3 })
  t.close()
  f.children[2].emit('late\n')
  f.children[2].exit(0)
  await tick()
  assert.equal(t.posted.length, 1)
  assert.equal(f.children[2].killed, true)
})

test('serveGit: a rejected read sends nothing, so the page keeps the marks it has', async () => {
  const t = fakeTab()
  const warns = []
  const spawn = () => {
    throw new Error('processes: too many processes')
  }
  const handle = git.serveGit(t.tab, { spawn, root: '/p', rel: 'a.txt', log: { warn: (m) => warns.push(m) }, slots: { used: 0, max: 2 } })
  handle({ t: 'git-base', req: 1 })
  await tick()
  assert.deepEqual(t.posted, [])
  assert.equal(warns.length, 1)
})

test('serveGit: git-review goes to the Reviewer with the tab path only; a failure is told to the page', async () => {
  const f = fakeSpawn()
  const t = fakeTab()
  const calls = []
  const handle = git.serveGit(t.tab, {
    spawn: f.spawn,
    root: '/p',
    rel: 'src/a.ts',
    review: async (rel) => {
      calls.push(rel)
      if (calls.length === 2) throw new Error('reviewer: no provider')
    },
  })
  assert.equal(handle({ t: 'git-review', path: '../../etc/passwd' }), true)
  await tick()
  assert.deepEqual(calls, ['src/a.ts'])
  assert.deepEqual(t.posted, [])
  handle({ t: 'git-review' })
  await tick()
  await tick()
  assert.deepEqual(t.posted, [{ t: 'git-review-error', message: 'Could not open the diff: reviewer: no provider' }])
  // A tab with no project path (outside the project) has nothing to review.
  const o = fakeTab()
  git.serveGit(o.tab, { spawn: f.spawn, root: '/p', rel: undefined, review: async () => assert.fail('no') })({ t: 'git-review' })
  await tick()
  assert.deepEqual(o.posted, [])
})
