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

test('neither argv follows symlinks: a link out of the project is never listed or searched', () => {
  for (const argv of [search.filesArgv(), search.grepArgv('x'), search.grepArgv('x', { regex: true, caseSensitive: true, word: true })]) {
    const flags = argv.slice(0, argv.indexOf('--'))
    assert.ok(!flags.includes('--follow') && !flags.includes('-L'), argv.join(' '))
    // Nor folded into a short-flag cluster like -uL.
    assert.ok(!flags.some((f) => /^-[^-]*L/.test(f)), argv.join(' '))
  }
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

test('parseMatch walks a long line with many submatches once (no per-match decode from byte 0)', () => {
  // A minified line: 'é' (two bytes) between hits, so byte and UTF-16 offsets differ throughout.
  const unit = 'é;'
  const text = unit.repeat(1_000_000) // 3 MB of UTF-8, a million submatches
  const subs = []
  for (let i = 0; i < 1_000_000; i++) subs.push({ start: i * 3 + 2, end: i * 3 + 3 })
  const line = matchLine('min.js', 1, text, subs)
  const t0 = performance.now()
  const m = search.parseMatch(line)
  const ms = performance.now() - t0
  // O(submatches x line) took seconds for 65k hits; one pass is well under this.
  assert.ok(ms < 1500, `${ms} ms`)
  assert.equal(m.col, 2)
  assert.equal(m.cut, 0)
  assert.equal(m.text.length, search.MAX_LINE_CHARS)
  // Every drawn range is a ';', and only those in the shown part are kept.
  assert.equal(m.ranges.length, search.MAX_LINE_CHARS / 2)
  for (const [a, b] of m.ranges) assert.equal(m.text.slice(a, b), ';')
  // A first match deep in the line: the cut and the ranges follow it.
  const deep = search.parseMatch(matchLine('min.js', 1, 'é'.repeat(5000) + 'NEEDLE;😀;', [{ start: 10000, end: 10006 }, { start: 10006, end: 10007 }, { start: 10011, end: 10012 }]))
  assert.equal(deep.col, 5001)
  assert.deepEqual(deep.ranges.map(([a, b]) => deep.text.slice(a, b)), ['NEEDLE', ';', ';'])
  // Out of order or overlapping submatches are skipped, not walked backwards.
  const odd = search.parseMatch(matchLine('a', 1, 'abcabc', [{ start: 3, end: 4 }, { start: 0, end: 1 }, { start: 5, end: 6 }]))
  assert.deepEqual(odd.ranges, [[3, 4], [5, 6]])
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

  // Any other refusal (the per-plugin process cap, a cwd that is not a directory) is said as it is.
  for (const text of ['processes: this plugin already runs 16 processes', 'processes: cwd /p is not an existing directory']) {
    const other = search.grep(() => {
      throw new RangeError(text)
    }, '/p', 'x')
    await assert.rejects(other.result, (e) => e.missing !== true && e.message === text)
  }
})

test('rg slots are shared by every tab of the plugin; a killed rg holds one until it exits', async () => {
  const f = fakeSpawn()
  const slots = { used: 0, max: 2 }
  const posted = []
  const tab = () => search.serveSearch({ post: (m) => posted.push(m), onClose() {} }, { spawn: f.spawn, root: '/p', bin: 'rg', slots })
  const a = tab()
  const b = tab()
  a({ t: 'files', req: 1 })
  b({ t: 'grep', req: 2, query: 'x' })
  assert.equal(slots.used, 2)
  // A third, from either tab: refused without spawning, said to the page (not as a missing rg).
  a({ t: 'grep', req: 3, query: 'y' })
  await new Promise((r) => setImmediate(r))
  assert.equal(f.children.length, 2)
  const refused = posted.find((m) => m.req === 3)
  assert.equal(refused.t, 'search-error')
  assert.equal(refused.missing, undefined)
  assert.match(refused.message, /too many searches/)
  // The killed one gives its slot back on exit (once, even if exit is told twice).
  b({ t: 'grep-cancel' })
  assert.equal(slots.used, 2)
  await new Promise((r) => setImmediate(r))
  f.children[1].exit(null)
  assert.equal(slots.used, 1)
  a({ t: 'grep', req: 4, query: 'z' })
  assert.equal(f.children.length, 3)
  assert.equal(search.MAX_SEARCH_PROCESSES <= 4, true)
})

test('serveSearch: quick open parts are sized by their JSON; a refused post is said, not a stuck page', async () => {
  const f = fakeSpawn()
  const posted = []
  const MAX = 1024 * 1024 // MAX_PANEL_MESSAGE_LENGTH
  const tab = {
    post(m) {
      const n = JSON.stringify(m).length
      if (n > MAX) throw new RangeError(`message of ${n} characters is over the cap`)
      posted.push(m)
    },
    onClose() {},
  }
  const handle = search.serveSearch(tab, { spawn: f.spawn, root: '/p', bin: 'rg', slots: { used: 0, max: 4 } })
  handle({ t: 'files', req: 1 })
  // Names made of control characters: each becomes six characters in JSON.
  const name = '\u0001'.repeat(200)
  f.children[0].emit(Array.from({ length: 3000 }, (_, i) => `./${name}${i}`).join('\0') + '\0')
  f.children[0].exit(0)
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.ok(posted.length > 1)
  assert.ok(posted.every((m) => m.t === 'files' && JSON.stringify(m).length < MAX))
  assert.equal(posted.reduce((n, m) => n + m.paths.length, 0), 3000)

  // A post that throws anyway: the page gets a search-error, and no unhandled rejection.
  const errors = []
  const tab2 = {
    post(m) {
      if (m.t === 'files') throw new RangeError('over the cap')
      errors.push(m)
    },
    onClose() {},
  }
  const h2 = search.serveSearch(tab2, { spawn: f.spawn, root: '/p', bin: 'rg', slots: { used: 0, max: 4 } })
  h2({ t: 'files', req: 7 })
  f.children[1].emit('./a\0')
  f.children[1].exit(0)
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(errors, [{ t: 'search-error', kind: 'files', req: 7, message: 'over the cap' }])
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

test('an rg that never ends is killed at the timeout: what it found so far is the answer, said truncated', async () => {
  // The fake rg never exits by itself: only the timer can end it (a network mount that hangs a read).
  const f = fakeSpawn()
  const slots = { used: 0, max: 1 }
  const job = search.grep(f.spawn, '/p', 'x', { timeoutMs: 20, slots })
  f.children[0].emit(matchLine('a', 1, 'x', [{ start: 0, end: 1 }]))
  const r = await job.result
  assert.equal(f.children[0].killed, true)
  assert.deepEqual(r.matches.map((m) => `${m.path}:${m.line}`), ['a:1'])
  assert.equal(r.truncated, true)
  // The killed rg gave its slot back.
  assert.equal(slots.used, 0)
  const list = search.listFiles(f.spawn, '/p', { timeoutMs: 20, slots })
  f.children[1].emit('./a\0./b\0')
  assert.deepEqual(await list.result, { paths: ['a', 'b'], truncated: true })
  assert.equal(f.children[1].killed, true)

  // Through serveSearch, with the real 20 s default: its timer is taken and fired by hand.
  const timers = []
  const orig = global.setTimeout
  const posted = []
  const handle = search.serveSearch({ post: (m) => posted.push(m), onClose() {} }, { spawn: f.spawn, root: '/p', bin: 'rg', slots: { used: 0, max: 1 } })
  try {
    global.setTimeout = (fn, ms) => (timers.push({ fn, ms }), { unref() {} })
    handle({ t: 'grep', req: 1, query: 'x' })
  } finally {
    global.setTimeout = orig
  }
  assert.deepEqual(timers.map((x) => x.ms), [20 * 1000])
  f.children[2].emit(matchLine('b', 2, 'x', [{ start: 0, end: 1 }]))
  timers[0].fn()
  assert.equal(f.children[2].killed, true)
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(posted.map((m) => [m.t, m.req, m.truncated, m.matches.length]), [['grep', 1, true, 1]])
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
  const handle = search.serveSearch({ post: (m) => posted.push(m), onClose: (fn) => closers.push(fn) }, { spawn: f.spawn, root: '/p', bin: 'rg' })
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

test('serveSearch runs rg by its absolute path from absolute PATH entries only: a project\'s own rg is never run', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edsearch-path-'))
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'edsearch-bin-'))
  const savedPath = process.env.PATH
  t.after(() => {
    process.env.PATH = savedPath
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(bin, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'rg'), '#!/bin/sh\n', { mode: 0o755 })
  const argvs = []
  const spawn = (argv) => {
    argvs.push(argv)
    throw new Error('processes: cannot run (test)')
  }
  const posted = []
  const handle = search.serveSearch({ post: (m) => posted.push(m), onClose() {} }, { spawn, root })
  // Only the relative entry has an rg: not installed, said with the install hint; nothing spawned.
  process.env.PATH = 'node_modules/.bin'
  handle({ t: 'files', req: 1 })
  handle({ t: 'grep', req: 2, query: 'x' })
  assert.deepEqual(argvs, [])
  assert.deepEqual(posted.map((m) => [m.t, m.kind, m.missing]), [['search-error', 'files', true], ['search-error', 'grep', true]])
  // An absolute entry's rg is run by its full path.
  fs.writeFileSync(path.join(bin, 'rg'), '#!/bin/sh\n', { mode: 0o755 })
  process.env.PATH = `node_modules/.bin${path.delimiter}${bin}`
  handle({ t: 'files', req: 3 })
  assert.equal(argvs[0][0], path.join(bin, 'rg'))
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

test('real rg: a symlink to a folder or file outside the project is neither listed nor searched', { skip: !hasRg && 'rg not installed' }, async () => {
  const root = project()
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edsearch-out-')))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'needle outside\n')
  fs.symlinkSync(outside, path.join(root, 'linkdir'))
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'))
  const files = await search.listFiles(nodeSpawn, root).result
  assert.deepEqual(files.paths.sort(), ['b.md', 'src/a.ts'])
  const r = await search.grep(nodeSpawn, root, 'needle').result
  assert.deepEqual([...new Set(r.matches.map((m) => m.path))], ['src/a.ts'])
})
