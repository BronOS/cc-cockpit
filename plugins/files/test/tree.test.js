'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const tree = require('../dist/lib/tree')

// A temp project (a git repo when `git` is true), and an exec that runs argv there like ctx.exec.
function project({ git = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'files-')))
  const run = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' })
  const write = (rel, text = 'x\n') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  if (git) {
    run('init', '-q')
    run('config', 'user.email', 't@t')
    run('config', 'user.name', 't')
  }
  const exec = async (argv, opts = {}) => {
    try {
      const out = execFileSync(argv[0], argv.slice(1), { cwd: root, stdio: 'pipe', input: opts.stdin })
      return { code: 0, stdout: out.toString(), stderr: '' }
    } catch (e) {
      return { code: e.status ?? 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }
    }
  }
  return { root, run, write, exec }
}

const names = (listing) => listing.entries.map((e) => e.name)

test('normalizeRelative', () => {
  assert.equal(tree.normalizeRelative(''), '')
  assert.equal(tree.normalizeRelative('./src//a.js'), 'src/a.js')
  for (const bad of ['/etc', '../x', 'a/../../x', 'a\\b', 'a\0b', 7]) assert.throws(() => tree.normalizeRelative(bad))
})

test('listDir: folders first, natural order, .git never listed, dotfiles shown', async () => {
  const p = project()
  for (const f of ['b.txt', 'file10', 'file2', 'A.md', '.env', 'src/x.js', 'Lib/y.js']) p.write(f)
  const l = await tree.listDir(p.root, '', { exec: p.exec })
  assert.deepEqual(names(l), ['Lib', 'src', '.env', 'A.md', 'b.txt', 'file2', 'file10'])
  assert.equal(l.entries[0].kind, 'dir')
  assert.equal(l.more, 0)
})

test('listDir: hideHidden drops dot names', async () => {
  const p = project()
  p.write('.env')
  p.write('.github/w.yml')
  p.write('a')
  const l = await tree.listDir(p.root, '', { exec: p.exec, hideHidden: true })
  assert.deepEqual(names(l), ['a'])
})

test('listDir: ignored entries are marked, or left out with hideIgnored', async () => {
  const p = project()
  p.write('.gitignore', 'dist/\n*.log\n')
  p.write('dist/out.js')
  p.write('a.log')
  p.write('src/b.log')
  p.write('src/c.js')
  const l = await tree.listDir(p.root, '', { exec: p.exec })
  const byName = Object.fromEntries(l.entries.map((e) => [e.name, e]))
  assert.equal(byName.dist.ignored, true)
  assert.equal(byName['a.log'].ignored, true)
  assert.equal(byName.src.ignored, undefined)
  const sub = await tree.listDir(p.root, 'src', { exec: p.exec, hideIgnored: true })
  assert.deepEqual(names(sub), ['c.js'])
  // Inside an ignored folder, everything is ignored.
  const inDist = await tree.listDir(p.root, 'dist', { exec: p.exec })
  assert.equal(inDist.entries[0].ignored, true)
})

test('listDir: outside git nothing is ignored', async () => {
  const p = project({ git: false })
  p.write('.gitignore', 'a\n')
  p.write('a')
  const l = await tree.listDir(p.root, '', { exec: p.exec })
  assert.equal(l.entries.find((e) => e.name === 'a').ignored, undefined)
})

test('listDir: links are marked, a folder link leaving the project is blocked', async () => {
  const p = project()
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'out-')))
  p.write('real/f')
  fs.symlinkSync(path.join(p.root, 'real'), path.join(p.root, 'inner'))
  fs.symlinkSync(outside, path.join(p.root, 'outer'))
  fs.symlinkSync(path.join(p.root, 'nope'), path.join(p.root, 'dangling'))
  const l = await tree.listDir(p.root, '', { exec: p.exec })
  const by = Object.fromEntries(l.entries.map((e) => [e.name, e]))
  assert.deepEqual([by.inner.kind, by.inner.link, by.inner.blocked], ['dir', true, undefined])
  assert.deepEqual([by.outer.kind, by.outer.blocked], ['dir', true])
  assert.equal(by.dangling.kind, 'other')
  // Listing through the outer link is refused.
  await assert.rejects(tree.listDir(p.root, 'outer', { exec: p.exec }), /outside the project/)
})

test('listDir: a missing folder rejects with ENOENT', async () => {
  const p = project()
  await assert.rejects(tree.listDir(p.root, 'gone', { exec: p.exec }), (e) => e.code === 'ENOENT')
})

test('parseStatus: codes, renames, untracked folders, prefix', () => {
  const out = [' M src/a.js', 'A  new.js', 'R  moved.js', 'old.js', '?? notes/', '?? x.txt', 'UU c.js', ' D gone.js', ''].join('\0')
  const s = tree.parseStatus(out)
  assert.deepEqual(s.files, { 'src/a.js': 'M', 'new.js': 'A', 'moved.js': 'R', 'x.txt': '?', 'c.js': 'U', 'gone.js': 'D' })
  assert.deepEqual(s.untracked, ['notes'])
  assert.deepEqual(s.dirs, ['notes', 'src'])
  const sub = tree.parseStatus([' M app/src/a.js', ' M other/b.js', ''].join('\0'), 'app/')
  assert.deepEqual(sub.files, { 'src/a.js': 'M' })
})

test('gitMarks on a real repo, and outside one', async () => {
  const p = project()
  p.write('a.js')
  p.run('add', '.')
  p.run('commit', '-qm', 'init')
  p.write('a.js', 'changed\n')
  p.write('n/new.txt')
  const m = await tree.gitMarks(p.exec)
  assert.equal(m.git, true)
  assert.equal(m.files['a.js'], 'M')
  assert.deepEqual(m.untracked, ['n'])
  const q = project({ git: false })
  assert.deepEqual(await tree.gitMarks(q.exec), { files: {}, dirs: [], untracked: [], git: false })
})

test('rankMatches: all words, name hits first, hidden filter, cap', () => {
  const paths = ['src/review/host.js', 'docs/host-notes.md', 'host.js', '.github/host.yml', 'lib/other.js']
  const r = tree.rankMatches(paths, 'host')
  // All four hit in the file name, so shorter paths first.
  assert.deepEqual(r.paths, ['host.js', '.github/host.yml', 'docs/host-notes.md', 'src/review/host.js'])
  // A hit only in the folders comes after a hit in the name.
  assert.deepEqual(tree.rankMatches(['review/a.js', 'x/review.js'], 'review').paths, ['x/review.js', 'review/a.js'])
  assert.deepEqual(tree.rankMatches(paths, 'review host').paths, ['src/review/host.js'])
  assert.deepEqual(tree.rankMatches(paths, 'HOST', { hideHidden: true }).paths.includes('.github/host.yml'), false)
  assert.deepEqual(tree.rankMatches(paths, '  '), { paths: [], total: 0 })
  const many = Array.from({ length: 300 }, (_, i) => `f${i}.js`)
  const big = tree.rankMatches(many, 'f')
  assert.equal(big.paths.length, tree.MAX_RESULTS)
  assert.equal(big.total, 300)
})

test('searchablePaths: git files without ignored ones, walk outside git', async () => {
  const p = project()
  p.write('.gitignore', 'node_modules/\n')
  p.write('node_modules/x/index.js')
  p.write('src/a.js')
  const got = (await tree.searchablePaths(p.exec, p.root)).sort()
  assert.deepEqual(got, ['.gitignore', 'src/a.js'])
  const q = project({ git: false })
  q.write('a/b.txt')
  q.write('c.txt')
  assert.deepEqual((await tree.searchablePaths(q.exec, q.root)).sort(), ['a/b.txt', 'c.txt'])
})
