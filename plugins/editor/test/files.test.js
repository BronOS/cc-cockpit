'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const files = require('../dist/lib/files.js')

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-editor-files-'))
  return root
}

/** Replaces fs[name] for one call: `before(...args)` runs first, then the original. */
function onceBefore(name, before) {
  const orig = fs[name]
  fs[name] = function (...args) {
    fs[name] = orig
    before(...args)
    return orig.apply(this, args)
  }
  return () => (fs[name] = orig)
}

test('read gives the text, its hash and an editable file', () => {
  const root = project()
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n')
  const r = files.readFile(root, 'a.txt')
  assert.equal(r.exists, true)
  assert.equal(r.text, 'hello\n')
  assert.equal(r.hash, sha('hello\n'))
  assert.equal(r.readOnly, false)
  assert.deepEqual(files.readFile(root, 'gone.txt'), { rel: 'gone.txt', exists: false })
})

test('paths: escapes, absolute paths and links out of the project are refused', () => {
  const root = project()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-editor-out-'))
  fs.writeFileSync(path.join(outside, 'secret'), 'x')
  fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'link'))
  fs.symlinkSync(path.join(root, 'missing'), path.join(root, 'dangling'))
  for (const bad of ['../x', '/etc/passwd', 'a/../../x', '', '.', 'link', 'dangling']) {
    assert.throws(() => files.readFile(root, bad), undefined, bad)
    assert.throws(() => files.saveFile(root, bad, 'x', null), undefined, bad)
  }
  assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'x')
})

test('save: compare and swap succeeds on the base and moves the base on', () => {
  const root = project()
  const f = path.join(root, 'a.txt')
  fs.writeFileSync(f, 'one\n')
  const r = files.saveFile(root, 'a.txt', 'two\n', sha('one\n'))
  assert.deepEqual(r, { result: 'saved', hash: sha('two\n') })
  assert.equal(fs.readFileSync(f, 'utf8'), 'two\n')
  // No temp file left behind.
  assert.deepEqual(fs.readdirSync(root), ['a.txt'])
})

test('save: a base that is not on disk answers changed with theirs and writes nothing', () => {
  const root = project()
  const f = path.join(root, 'a.txt')
  fs.writeFileSync(f, 'claude wrote this\n')
  const r = files.saveFile(root, 'a.txt', 'mine\n', sha('old\n'))
  assert.equal(r.result, 'changed')
  assert.equal(r.text, 'claude wrote this\n')
  assert.equal(r.hash, sha('claude wrote this\n'))
  assert.equal(r.written, undefined)
  assert.equal(fs.readFileSync(f, 'utf8'), 'claude wrote this\n')
  assert.deepEqual(fs.readdirSync(root), ['a.txt'])
})

test('save: a write into the old file between the check and the rename comes back as changed {written}', () => {
  const root = project()
  const f = path.join(root, 'a.txt')
  fs.writeFileSync(f, 'base\n')
  // Claude's write lands in place (same inode) just before our rename: lost from disk, handed to the page.
  const undo = onceBefore('renameSync', () => fs.writeFileSync(f, 'theirs\n'))
  let r
  try {
    r = files.saveFile(root, 'a.txt', 'mine\n', sha('base\n'))
  } finally {
    undo()
  }
  assert.equal(r.result, 'changed')
  assert.equal(r.written, true)
  assert.equal(r.text, 'theirs\n')
  assert.equal(r.theirsHash, sha('theirs\n'))
  assert.equal(r.hash, sha('mine\n'))
  assert.equal(fs.readFileSync(f, 'utf8'), 'mine\n')
})

test('save: a rename-replace before the swap is caught by the inode check', () => {
  const root = project()
  const f = path.join(root, 'a.txt')
  fs.writeFileSync(f, 'base\n')
  // While our temp file is synced, another writer renames a new file over the name (same bytes even:
  // the inode is what tells).
  const undo = onceBefore('fsyncSync', () => {
    fs.writeFileSync(path.join(root, 'other.tmp'), 'replaced\n')
    fs.renameSync(path.join(root, 'other.tmp'), f)
  })
  let r
  try {
    r = files.saveFile(root, 'a.txt', 'mine\n', sha('base\n'))
  } finally {
    undo()
  }
  assert.equal(r.result, 'changed')
  assert.equal(r.text, 'replaced\n')
  assert.equal(r.written, undefined)
  assert.equal(fs.readFileSync(f, 'utf8'), 'replaced\n')
  assert.deepEqual(fs.readdirSync(root), ['a.txt'])
})

test('save: a symlink in the project is followed, its target written and the link kept', () => {
  const root = project()
  fs.mkdirSync(path.join(root, 'real'))
  const target = path.join(root, 'real', 't.txt')
  fs.writeFileSync(target, 'old\n')
  fs.symlinkSync('real/t.txt', path.join(root, 'link.txt'))
  const r = files.saveFile(root, 'link.txt', 'new\n', sha('old\n'))
  assert.equal(r.result, 'saved')
  assert.equal(fs.lstatSync(path.join(root, 'link.txt')).isSymbolicLink(), true)
  assert.equal(fs.readFileSync(target, 'utf8'), 'new\n')
})

test('read-only: not valid UTF-8, binary and large files; a save of one is refused', () => {
  const root = project()
  fs.writeFileSync(path.join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  const l = files.readFile(root, 'latin1.txt')
  assert.equal(l.readOnly, true)
  assert.equal(l.why, 'encoding')
  assert.equal(l.text, 'caf�\n')
  assert.throws(() => files.saveFile(root, 'latin1.txt', 'café\n', l.hash), /read-only/)
  assert.deepEqual(fs.readFileSync(path.join(root, 'latin1.txt')), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))

  fs.writeFileSync(path.join(root, 'b.bin'), Buffer.from([1, 0, 2]))
  const b = files.readFile(root, 'b.bin')
  assert.equal(b.readOnly, true)
  assert.equal(b.why, 'binary')
  assert.equal(b.text, undefined)

  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(files.MAX_EDIT_BYTES + 1))
  const g = files.readFile(root, 'big.txt')
  assert.equal(g.readOnly, true)
  assert.equal(g.why, 'large')
  assert.equal(g.text.length, files.MAX_EDIT_BYTES + 1)
})

test('save keeps CRLF, the BOM, the final newline (or its absence) and the mode', () => {
  const root = project()
  const f = path.join(root, 'w.sh')
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n')]))
  fs.chmodSync(f, 0o751)
  const r = files.readFile(root, 'w.sh')
  assert.equal(r.text, 'a\nb\n')
  assert.equal(r.eol, '\r\n')
  assert.equal(r.bom, true)
  const s = files.saveFile(root, 'w.sh', 'a\nb\nc', r.hash)
  assert.equal(s.result, 'saved')
  const bytes = fs.readFileSync(f)
  assert.deepEqual(bytes, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\nc')]))
  assert.equal(s.hash, sha(bytes))
  assert.equal(fs.statSync(f).mode & 0o7777, 0o751)
  // A mixed file is left as it is: no line ending is rewritten.
  fs.writeFileSync(path.join(root, 'm.txt'), 'a\r\nb\n')
  const m = files.readFile(root, 'm.txt')
  assert.equal(m.text, 'a\r\nb\n')
  files.saveFile(root, 'm.txt', 'a\r\nb\nc\n', m.hash)
  assert.equal(fs.readFileSync(path.join(root, 'm.txt'), 'utf8'), 'a\r\nb\nc\n')
})

test('save with baseHash null recreates a deleted file, but never over one that came back', () => {
  const root = project()
  const s = files.saveFile(root, 'new.txt', 'hi\n', null)
  assert.deepEqual(s, { result: 'saved', hash: sha('hi\n') })
  assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'hi\n')
  const again = files.saveFile(root, 'new.txt', 'other\n', null)
  assert.equal(again.result, 'changed')
  assert.equal(again.text, 'hi\n')
  // A base for a file that is gone: changed {deleted}.
  fs.unlinkSync(path.join(root, 'new.txt'))
  assert.deepEqual(files.saveFile(root, 'new.txt', 'x', sha('hi\n')), { result: 'changed', deleted: true, hash: null })
})

test('chunkText never splits a surrogate pair and keeps every unit', () => {
  const text = 'ab😀cd😀'
  for (const size of [1, 2, 3, 4]) {
    const parts = files.chunkText(text, Math.max(size, 2))
    assert.equal(parts.join(''), text)
    for (const p of parts) assert.equal(p, Buffer.from(p, 'utf8').toString('utf8'))
  }
  assert.deepEqual(files.chunkText(''), [''])
})

function waitFor(cond, ms = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (cond()) return resolve()
      if (Date.now() - start > ms) return reject(new Error('timed out'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

test('the folder watch sees a rename-replace, again after it, and a delete', async () => {
  const root = project()
  const f = path.join(root, 'a.txt')
  fs.writeFileSync(f, 'one\n')
  const events = []
  const w = new files.FolderWatcher((real, ev) => events.push({ real, ...ev }), { debounceMs: 20 })
  const real = fs.realpathSync(f)
  const stop = w.add(real, sha('one\n'))
  try {
    const replace = (text) => {
      const tmp = path.join(root, '.a.txt.tmp')
      fs.writeFileSync(tmp, text)
      fs.renameSync(tmp, f)
    }
    replace('two\n')
    await waitFor(() => events.length >= 1)
    assert.deepEqual(events[0], { real, change: 'changed', hash: sha('two\n') })
    // A file watch would have ended with the first rename; the folder watch sees the second.
    replace('three\n')
    await waitFor(() => events.length >= 2)
    assert.equal(events[1].hash, sha('three\n'))
    // Our own save, recorded with seen(), is no event.
    w.seen(real, sha('four\n'))
    replace('four\n')
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(events.length, 2)
    fs.unlinkSync(f)
    await waitFor(() => events.length >= 3)
    assert.deepEqual(events[2], { real, change: 'deleted', hash: null })
  } finally {
    stop()
    w.close()
  }
  assert.equal(w.folders.size, 0)
})

/** A fake PageTabInstance: what the host posts, and a way to send it the page's messages. */
function fakeTab(params) {
  const posted = []
  let onMessage = null
  let onClose = null
  return {
    tab: {
      id: 't1',
      type: 'file',
      params,
      view: undefined,
      post: (m) => posted.push(JSON.parse(JSON.stringify(m))),
      onMessage: (fn) => ((onMessage = fn), () => {}),
      onClose: (fn) => ((onClose = fn), () => {}),
    },
    posted,
    send: (m) => onMessage(m),
    close: () => onClose(),
  }
}

test('serveFileTab: open, a save in parts, a mismatch, a disk event and close', async () => {
  const root = project()
  const f = path.join(root, 'src.txt')
  fs.writeFileSync(f, 'base\n')
  const shared = files.makeFiles(root, { debounceMs: 20 })
  const t = fakeTab({ path: 'src.txt' })
  files.serveFileTab(shared, t.tab)
  try {
    t.send({ t: 'open', req: 1 })
    assert.deepEqual(t.posted.shift(), { t: 'file', req: 1, path: 'src.txt', exists: true, hash: sha('base\n'), readOnly: false, eol: '\n', bom: false, size: 5, part: 0, parts: 1, text: 'base\n' })

    // A save split by the page in two parts.
    t.send({ t: 'save', req: 2, path: 'src.txt', baseHash: sha('base\n'), part: 0, parts: 2, text: 'mi' })
    assert.equal(t.posted.length, 0)
    t.send({ t: 'save', req: 2, path: 'src.txt', baseHash: sha('base\n'), part: 1, parts: 2, text: 'ne\n' })
    assert.deepEqual(t.posted.shift(), { t: 'saved', req: 2, path: 'src.txt', hash: sha('mine\n') })
    assert.equal(fs.readFileSync(f, 'utf8'), 'mine\n')

    // Our own save is no disk event; Claude's write is.
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(t.posted.length, 0)
    fs.writeFileSync(f, 'claude\n')
    await waitFor(() => t.posted.length >= 1)
    assert.deepEqual(t.posted.shift(), { t: 'disk', path: 'src.txt', change: 'changed', hash: sha('claude\n') })

    // A save on the old base: changed, theirs in parts.
    t.send({ t: 'save', req: 3, path: 'src.txt', baseHash: sha('mine\n'), part: 0, parts: 1, text: 'mine2\n' })
    const c = t.posted.shift()
    assert.equal(c.t, 'changed')
    assert.equal(c.req, 3)
    assert.equal(c.text, 'claude\n')
    assert.equal(c.hash, sha('claude\n'))
    assert.equal(fs.readFileSync(f, 'utf8'), 'claude\n')

    // Paths from the page are checked; out-of-order parts are refused.
    t.send({ t: 'read', req: 4, path: '../etc/passwd' })
    assert.equal(t.posted.shift().t, 'error')
    t.send({ t: 'save', req: 5, path: 'src.txt', baseHash: sha('claude\n'), part: 1, parts: 2, text: 'x' })
    assert.match(t.posted.shift().message, /out of order/)
    t.send({ t: 'nonsense' })
    assert.equal(t.posted.length, 0)
  } finally {
    t.close()
  }
  assert.equal(shared.watcher.files.size, 0)
  assert.equal(shared.lines.size, 0)
  shared.watcher.close()
})

test('serveFileTab: a big file arrives in parts under the message cap', () => {
  const root = project()
  const text = 'é'.repeat(files.CHUNK_CHARS * 2 + 10)
  fs.writeFileSync(path.join(root, 'big.txt'), text)
  const shared = files.makeFiles(root)
  const t = fakeTab({ path: 'big.txt' })
  files.serveFileTab(shared, t.tab)
  t.send({ t: 'open', req: 'r' })
  assert.equal(t.posted.length, 3)
  for (const m of t.posted) {
    assert.equal(m.parts, 3)
    assert.ok(Buffer.byteLength(JSON.stringify(m)) < 1024 * 1024)
  }
  assert.equal(t.posted.map((m) => m.text).join(''), text)
  t.close()
  shared.watcher.close()
})
