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

test('viewKindOf: by the last extension, any case; .mdx and dot files stay text', () => {
  assert.equal(files.viewKindOf('README.md'), 'markdown')
  assert.equal(files.viewKindOf('docs/Guide.MARKDOWN'), 'markdown')
  assert.equal(files.viewKindOf('site/Index.HTML'), 'html')
  assert.equal(files.viewKindOf('a.htm'), 'html')
  assert.equal(files.viewKindOf('a.xhtml'), 'text')
  assert.equal(files.viewKindOf('page.mdx'), 'text')
  assert.equal(files.viewKindOf('.md'), 'text')
  assert.equal(files.viewKindOf('Makefile'), 'text')
  assert.equal(files.viewKindOf('a/b.c/notes'), 'text')
  for (const f of ['x.png', 'x.JPG', 'x.jpeg', 'x.gif', 'x.webp', 'icons/x.svg']) assert.equal(files.viewKindOf(f), 'image', f)
  assert.equal(files.viewKindOf('spec.v2.PDF'), 'pdf')
  assert.equal(files.viewKindOf('archive.pdf.gz'), 'text')
})

test('readPreview: bytes and mime; caps, folders, missing files and escapes', () => {
  const { root } = repo()
  fs.writeFileSync(path.join(root, 'logo.PNG'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
  const p = files.readPreview(root, './logo.PNG')
  assert.deepEqual({ ...p, bytes: [...p.bytes] }, { path: 'logo.PNG', kind: 'image', mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0, 1, 2] })
  fs.writeFileSync(path.join(root, 'doc.pdf'), '%PDF-1.4\n')
  assert.equal(files.readPreview(root, 'doc.pdf').mime, 'application/pdf')
  fs.writeFileSync(path.join(root, 'v.svg'), '<svg/>')
  assert.equal(files.readPreview(root, 'v.svg').mime, 'image/svg+xml')
  // Over the cap (sparse file: no 10 MiB written): the built-in viewer.
  fs.truncateSync(path.join(root, 'logo.PNG'), files.MAX_IMAGE_BYTES + 1)
  assert.throws(() => files.readPreview(root, 'logo.PNG'), (e) => e.fallback === true && /larger than 10 MiB/.test(e.message))
  fs.truncateSync(path.join(root, 'doc.pdf'), files.MAX_IMAGE_BYTES + 1) // a PDF has the larger cap
  assert.equal(files.readPreview(root, 'doc.pdf').bytes.length, files.MAX_IMAGE_BYTES + 1)
  assert.throws(() => files.readPreview(root, 'gone.png'), (e) => e.fallback === true && /not in the working tree/.test(e.message))
  fs.mkdirSync(path.join(root, 'dir.png'))
  assert.throws(() => files.readPreview(root, 'dir.png'), (e) => e.fallback === true)
  assert.throws(() => files.readPreview(root, 'src/a.js'), /has no preview/)
  assert.throws(() => files.readPreview(root, '../x.png'), /leaves the project/)
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rev-out-')))
  fs.writeFileSync(path.join(outside, 'o.png'), 'x')
  fs.symlinkSync(path.join(outside, 'o.png'), path.join(root, 'link.png'))
  assert.throws(() => files.readPreview(root, 'link.png'), /through a symlink/)
})

test('previewGit: a PDF not in the last commit is added; a committed one is not; no repo is neither', async () => {
  const { root, exec, git } = repo()
  fs.writeFileSync(path.join(root, 'new.pdf'), '%PDF-1.4\n')
  fs.writeFileSync(path.join(root, 'old.pdf'), '%PDF-1.4\n')
  git('add', 'old.pdf')
  git('commit', '-qm', 'pdf')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim()
  assert.deepEqual(await files.previewGit(exec, 'new.pdf'), { head, added: true })
  assert.deepEqual(await files.previewGit(exec, 'old.pdf'), { head, added: false })
  // Staged but not committed: still new.
  git('add', 'new.pdf')
  assert.deepEqual(await files.previewGit(exec, 'new.pdf'), { head, added: true })
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rev-plain-')))
  const execPlain = async () => ({ code: 128, stdout: '', stderr: 'not a git repository' })
  assert.deepEqual(await files.previewGit(execPlain, 'x.pdf'), { head: null, added: false })
  fs.rmSync(plain, { recursive: true })
})
