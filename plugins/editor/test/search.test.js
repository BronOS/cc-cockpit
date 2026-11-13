'use strict'
// Quick open and find in files in the host (dist/lib/search.js): the argv a query cannot turn into
// an option, rg's JSON parsed into matches, the caps, and the per-line protocol. The rg runs use the
// real ripgrep when it is installed (skipped otherwise) through a spawn with ctx.processes' shape.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const search = require('../dist/lib/search.js')

const hasRg = cp.spawnSync('rg', ['--version']).status === 0

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

/** A spawn the test drives: `children` records each run, `emit` feeds stdout, `exit` ends it. */
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
      stderr: (s) => l.err.forEach((f) => f(Buffer.from(s))),
      exit: (code) => l.exit.forEach((f) => f({ code, signal: null })),
    }
    children.push(child)
    return child
  }
  return { spawn, children }
}

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edsearch-')))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'const needle = 1\nconst other = 2 // Needle again\n')
  fs.writeFileSync(path.join(root, 'b.md'), 'run with --pre=evil here\nand -f too\n')
  fs.writeFileSync(path.join(root, 'ignored.log'), 'needle in an ignored file\n')
  fs.writeFileSync(path.join(root, '.gitignore'), '*.log\n')
  // rg reads .gitignore only inside a git repository (or with --no-require-git): make one.
  fs.mkdirSync(path.join(root, '.git'))
  return root
}

const matchLine = (p, line, text, subs) =>
  JSON.stringify({ type: 'match', data: { path: { text: p }, lines: { text }, line_number: line, absolute_offset: 0, submatches: subs } }) + '\n'

test('grepArgv: the query only ever follows -e, the paths come after --', () => {
  for (const q of ['-f', '--pre=sh', '--files', '-e', '--', '-', '--no-config']) {
    const argv = search.grepArgv(q)
    const i = argv.indexOf('-e')
    assert.equal(argv[i + 1], q, q)
    assert.deepEqual(argv.slice(i + 2), ['--', '.'])
    // The query nowhere else in the argv (beyond the fixed flag it may spell).
    const fixed = ['-e', '--', '--no-config'].includes(q) ? 1 : 0
    assert.equal(argv.filter((a) => a === q).length, 1 + fixed)
  }
  const base = search.grepArgv('x')
  assert.deepEqual(base.slice(0, 4), ['rg', '--no-config', '--json', '--no-messages'])
  assert.ok(base.includes('--fixed-strings') && base.includes('--ignore-case') && !base.includes('--word-regexp'))
  const all = search.grepArgv('x', { regex: true, caseSensitive: true, word: true })
  assert.ok(!all.includes('--fixed-strings') && all.includes('--case-sensitive') && all.includes('--word-regexp'))
  // Only strict trues count: a page sending 'yes' gets the safe defaults.
  assert.ok(search.grepArgv('x', { regex: 'yes' }).includes('--fixed-strings'))
  assert.deepEqual(search.filesArgv(), ['rg', '--no-config', '--files', '--null', '--no-messages', '--', '.'])
})

test('grepArgv refuses an empty, multi-line or overlong query', () => {
  for (const bad of ['', 'a\nb', 'a\rb', 'a\0b', 'x'.repeat(search.MAX_QUERY_CHARS + 1), 3, null]) {
    assert.throws(() => search.grepArgv(bad), undefined, String(bad).slice(0, 20))
  }
})

test('parseMatch: path, line, UTF-16 columns from byte offsets, only matches', () => {
  // 'é' is two bytes: the match 'needle' at byte 7 is at character 6.
  const m = search.parseMatch(matchLine('./src/é.ts', 3, 'const é needle\n', [{ match: { text: 'needle' }, start: 9, end: 15 }]))
  assert.deepEqual(m, { path: 'src/é.ts', line: 3, col: 9, text: 'const é needle', cut: 0, ranges: [[8, 14]] })
  assert.equal(m.text.slice(...m.ranges[0]), 'needle')
  assert.equal(search.parseMatch(JSON.stringify({ type: 'begin', data: { path: { text: 'a' } } })), null)
  assert.equal(search.parseMatch('not json'), null)
  // A path or a line that is not UTF-8 comes as `bytes`: skipped, no tab could open it.
  assert.equal(search.parseMatch(JSON.stringify({ type: 'match', data: { path: { bytes: 'AAA=' }, lines: { text: 'x' }, line_number: 1, submatches: [] } })), null)
  assert.equal(search.parseMatch(JSON.stringify({ type: 'match', data: { path: { text: 'a' }, lines: { bytes: 'AAA=' }, line_number: 1, submatches: [] } })), null)
  // CRLF line ends are dropped too.
  assert.equal(search.parseMatch(matchLine('a', 1, 'x\r\n', [{ start: 0, end: 1 }])).text, 'x')
})

test('parseMatch cuts a long line around its first match and moves the ranges with it', () => {
  const text = 'a'.repeat(5000) + 'NEEDLE' + 'b'.repeat(5000)
  const m = search.parseMatch(matchLine('min.js', 1, text, [{ start: 5000, end: 5006 }, { start: 9990, end: 9995 }]))
  assert.equal(m.text.length, search.MAX_LINE_CHARS)
  assert.equal(m.col, 5001)
  assert.equal(m.text.slice(m.ranges[0][0], m.ranges[0][1]), 'NEEDLE')
  assert.equal(m.cut, 5000 - 60)
  // The second match is far past the cut: dropped, not drawn at a wrong place.
  assert.equal(m.ranges.length, 1)
})

test('splitter joins items across chunks and drops an item over the limit whole', () => {
  const got = []
  const s = search.splitter(10, (b) => got.push(b.toString()), 8)
  s.push(Buffer.from('ab'))
  s.push(Buffer.from('c\nde\n0123456789'))
  s.push(Buffer.from('xx\nlast'))
  s.end()
  assert.deepEqual(got, ['abc', 'de', 'last'])
})

test('grep: the match cap kills rg and says truncated; the file cap too', async () => {
  const f = fakeSpawn()
  const job = search.grep(f.spawn, '/p', 'x', { maxMatches: 3 })
  const c = f.children[0]
  assert.equal(c.opts.cwd, '/p')
  c.emit(matchLine('a', 1, 'x', [{ start: 0, end: 1 }]) + matchLine('a', 2, 'x', [{ start: 0, end: 1 }]))
  c.emit(matchLine('b', 1, 'x', [{ start: 0, end: 1 }]) + matchLine('b', 2, 'x', [{ start: 0, end: 1 }]))
  assert.equal(c.killed, true)
  const r = await job.result
  assert.equal(r.matches.length, 3)
  assert.equal(r.truncated, true)
  assert.equal(r.files, 2)

  const g = fakeSpawn()
  const job2 = search.grep(g.spawn, '/p', 'x', { maxMatchFiles: 1 })
  g.children[0].emit(matchLine('a', 1, 'x', []) + matchLine('a', 2, 'x', []) + matchLine('b', 1, 'x', []))
  const r2 = await job2.result
  assert.deepEqual(r2.matches.map((m) => `${m.path}:${m.line}`), ['a:1', 'a:2'])
  assert.equal(r2.truncated, true)
})

test('grep: a bad regex is rg error text; no match is an empty answer; missing rg is the install hint', async () => {
  const f = fakeSpawn()
  const job = search.grep(f.spawn, '/p', '(', { regex: true })
  f.children[0].stderr('regex parse error:\n    (\n    ^\nerror: unclosed group\n')
  f.children[0].exit(2)
  await assert.rejects(job.result, /unclosed group/)

  const none = search.grep(f.spawn, '/p', 'zzz')
  f.children[1].exit(1)
  assert.deepEqual(await none.result, { matches: [], files: 0, truncated: false })

  const missing = search.grep(() => {
    throw new Error('processes: cannot run rg: ENOENT')
  }, '/p', 'x')
  await assert.rejects(missing.result, (e) => e.missing === true && /brew install ripgrep/.test(e.message))
})

test('listFiles: NUL-separated paths, ./ dropped, capped (rg killed)', async () => {
  const f = fakeSpawn()
  const job = search.listFiles(f.spawn, '/p', { maxFiles: 3 })
  assert.deepEqual(f.children[0].argv, search.filesArgv())
  f.children[0].emit('./a\0./line\nbreak\0./b')
  f.children[0].emit('c\0./d\0./e\0')
  const r = await job.result
  assert.deepEqual(r.paths, ['a', 'line\nbreak', 'bc'])
  assert.equal(r.truncated, true)
  assert.equal(f.children[0].killed, true)
})

test('partsOf keeps each part near the budget and never empty', () => {
  const parts = search.partsOf(['aaaa', 'bbbb', 'cccc'], (s) => s.length, 25)
  assert.deepEqual(parts, [['aaaa'], ['bbbb'], ['cccc']])
  assert.deepEqual(search.partsOf([], (s) => s.length), [[]])
})

test('serveSearch: answers by req, a new search kills the old one and only the newest is posted', async () => {
  const f = fakeSpawn()
  const posted = []
  const closers = []
  const handle = search.serveSearch({ post: (m) => posted.push(m), onClose: (fn) => closers.push(fn) }, { spawn: f.spawn, root: '/p' })
  assert.equal(handle({ t: 'open' }), false)
  assert.equal(handle({ t: 'grep', req: 1, query: 'a' }), true)
  assert.equal(handle({ t: 'grep', req: 2, query: 'ab' }), true)
  assert.equal(f.children[0].killed, true)
  f.children[1].emit(matchLine('x.ts', 4, 'ab', [{ start: 0, end: 2 }]))
  f.children[1].exit(0)
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(posted.map((m) => [m.t, m.req]), [['grep', 2]])
  assert.equal(posted[0].matches[0].path, 'x.ts')
  // A bad query is said at once, no rg started.
  handle({ t: 'grep', req: 3, query: '' })
  assert.deepEqual(posted.at(-1), { t: 'search-error', kind: 'grep', req: 3, message: 'the search text is empty' })
  assert.equal(f.children.length, 2)
  // Cancel: rg killed, nothing posted.
  handle({ t: 'grep', req: 4, query: 'q' })
  handle({ t: 'grep-cancel' })
  assert.equal(f.children[2].killed, true)
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(posted.at(-1).req, 3)
  // A closed line kills what runs.
  handle({ t: 'files', req: 5 })
  closers.forEach((c) => c())
  assert.equal(f.children[3].killed, true)
  // No ctx.processes (an older app): said, not thrown.
  const old = []
  const h2 = search.serveSearch({ post: (m) => old.push(m), onClose() {} }, { spawn: undefined, root: '/p' })
  h2({ t: 'files', req: 1 })
  assert.equal(old[0].t, 'search-error')
})

test('real rg: a query that looks like an option stays a pattern; ignore rules hold', { skip: !hasRg && 'rg not installed' }, async () => {
  const root = project()
  for (const q of ['--pre=evil', '-f']) {
    const r = await search.grep(nodeSpawn, root, q).result
    assert.deepEqual(r.matches.map((m) => `${m.path}:${m.line}`), [q === '-f' ? 'b.md:2' : 'b.md:1'], q)
  }
  const r = await search.grep(nodeSpawn, root, 'needle').result
  // Case-insensitive by default; the .gitignored log is not searched.
  assert.deepEqual(r.matches.map((m) => `${m.path}:${m.line}:${m.col}`).sort(), ['src/a.ts:1:7', 'src/a.ts:2:20'])
  const cs = await search.grep(nodeSpawn, root, 'Needle', { caseSensitive: true }).result
  assert.deepEqual(cs.matches.map((m) => m.line), [2])
  // A regex only when asked: '.' is literal otherwise.
  assert.equal((await search.grep(nodeSpawn, root, 'n..dle').result).matches.length, 0)
  assert.equal((await search.grep(nodeSpawn, root, 'n..dle', { regex: true }).result).matches.length, 2)
  await assert.rejects(search.grep(nodeSpawn, root, '(', { regex: true }).result, /regex/i)
  const files = await search.listFiles(nodeSpawn, root).result
  assert.deepEqual(files.paths.sort(), ['b.md', 'src/a.ts'])
  assert.equal(files.truncated, false)
})
