'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const files = require('../dist/lib/files')

// A real git repo in a temp dir, and an exec that runs argv there (like ctx.exec, no shell).
function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rev-')))
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src/a.js'), 'one\ntwo\n')
  fs.writeFileSync(path.join(root, 'gone.txt'), 'bye\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  const exec = async (argv) => {
    try {
      return { code: 0, stdout: execFileSync(argv[0], argv.slice(1), { cwd: root, stdio: 'pipe' }).toString(), stderr: '' }
    } catch (e) {
      return { code: e.status ?? 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }
    }
  }
  return { root, exec, git }
}

test('normalizeRelative refuses escapes', () => {
  assert.equal(files.normalizeRelative('./src//a.js'), 'src/a.js')
  for (const bad of ['/etc/passwd', '../x', 'a/../../x', '..', '', 'C:\\x']) assert.throws(() => files.normalizeRelative(bad))
})

test('relativeFromCwd', () => {
  assert.equal(files.relativeFromCwd('/p', '/p/src', 'a.js'), 'src/a.js')
  assert.throws(() => files.relativeFromCwd('/p', '/p', '../q/a.js'), /not inside/)
  // A name that merely begins with two dots is inside the project.
  assert.equal(files.relativeFromCwd('/p', '/p', '..hidden/x'), '..hidden/x')
})

test('readSides: changed, new, deleted, unchanged', async () => {
  const { root, exec } = repo()
  fs.writeFileSync(path.join(root, 'src/a.js'), 'one\nTWO\n')
  let s = await files.readSides(exec, root, 'src/a.js')
  assert.equal(s.mode, 'diff')
  assert.equal(s.old, 'one\ntwo\n')
  assert.equal(s.new, 'one\nTWO\n')
  assert.match(s.head, /^[0-9a-f]{40}$/)
  assert.equal(s.note, null)

  fs.writeFileSync(path.join(root, 'new.md'), '# hi\n')
  s = await files.readSides(exec, root, 'new.md')
  assert.equal(s.oldMissing, true)
  assert.match(s.note, /New file/)

  fs.unlinkSync(path.join(root, 'gone.txt'))
  s = await files.readSides(exec, root, 'gone.txt')
  assert.equal(s.newMissing, true)
  assert.equal(s.old, 'bye\n')

  fs.writeFileSync(path.join(root, 'src/a.js'), 'one\ntwo\n')
  assert.match((await files.readSides(exec, root, 'src/a.js')).note, /No changes/)
  await assert.rejects(files.readSides(exec, root, 'nope.txt'), /does not exist/)
})

test('readSides: binary, too big and symlink escapes', async () => {
  const { root, exec } = repo()
  fs.writeFileSync(path.join(root, 'b.bin'), Buffer.from([1, 0, 2]))
  await assert.rejects(files.readSides(exec, root, 'b.bin'), (e) => e.fallback && /binary/.test(e.message))
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(files.MAX_SIDE_BYTES + 1))
  await assert.rejects(files.readSides(exec, root, 'big.txt'), (e) => e.fallback && /larger/.test(e.message))
  fs.symlinkSync('/etc', path.join(root, 'etc'))
  await assert.rejects(files.readSides(exec, root, 'etc/hostname'), /symlink/)
})

test('readSides: no git, and a project inside a bigger repo', async () => {
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rev-plain-')))
  fs.writeFileSync(path.join(plain, 'x.txt'), 'x\n')
  const exec = async (argv) => {
    try {
      return { code: 0, stdout: execFileSync(argv[0], argv.slice(1), { cwd: plain, stdio: 'pipe', env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(plain) } }).toString(), stderr: '' }
    } catch (e) {
      return { code: e.status ?? 1, stdout: '', stderr: String(e.stderr || '') }
    }
  }
  const s = await files.readSides(exec, plain, 'x.txt')
  assert.equal(s.mode, 'plain')
  assert.match(s.note, /Not a git repository/)

  // Project = a subfolder of the repo: HEAD:./<path> is relative to it.
  const { root } = repo()
  const sub = path.join(root, 'src')
  fs.writeFileSync(path.join(sub, 'a.js'), 'changed\n')
  const subExec = async (argv) => ({ code: 0, stdout: execFileSync(argv[0], argv.slice(1), { cwd: sub, stdio: 'pipe' }).toString(), stderr: '' })
  const t = await files.readSides(subExec, sub, 'a.js')
  assert.equal(t.old, 'one\ntwo\n')
  assert.equal(t.new, 'changed\n')
})

test('a FIFO is refused without reading it', { skip: process.platform === 'win32' }, async () => {
  // readFileSync on a FIFO blocks until a writer appears, and with it the whole plugin host.
  const { root, exec } = repo()
  execFileSync('mkfifo', [path.join(root, 'pipe')])
  await assert.rejects(files.readSides(exec, root, 'pipe'), (e) => e.fallback && /not a regular file/.test(e.message))
})

test('a backslash stays part of the file name off Windows', { skip: path.sep === '\\' }, async () => {
  // `a\b.js` is one valid file name on macOS and Linux; reading it as `a/b.js` reviewed another file.
  assert.equal(files.normalizeRelative('a\\b.js'), 'a\\b.js')
  const { root, exec } = repo()
  fs.mkdirSync(path.join(root, 'a'))
  fs.writeFileSync(path.join(root, 'a', 'b.js'), 'wrong file\n')
  fs.writeFileSync(path.join(root, 'a\\b.js'), 'right file\n')
  const s = await files.readSides(exec, root, 'a\\b.js')
  assert.equal(s.path, 'a\\b.js')
  assert.equal(s.new, 'right file\n')
})
