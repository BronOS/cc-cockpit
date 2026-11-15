'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const files = require('../dist/lib/files.js')

/** Every temp folder of this file goes after its last test: /tmp is often RAM, and runs add up. */
const made = []
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})

/** A new temp folder named `prefix` plus a random suffix, removed after the last test. */
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  made.push(dir)
  return dir
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

/** A temp project folder; with the test's `t`, removed after it, else after the last test. */
function project(t) {
  const root = tempDir('cc-editor-files-')
  if (t) t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

/** Makes a FIFO at `p`; false where there is no mkfifo (the caller skips). */
function mkfifo(p) {
  try {
    require('node:child_process').execFileSync('mkfifo', [p])
    return true
  } catch {
    return false
  }
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
  const outside = tempDir('cc-editor-out-')
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

test('save: a rename-replace before the swap is caught by the inode check, with other bytes or the same', (t) => {
  const root = project(t)
  const f = path.join(root, 'a.txt')
  // While our temp file is synced, another writer renames a new file over the name. With the base's
  // own bytes the held inode still hashes to the base, so only the inode compare can tell: without
  // it our rename would overwrite a file we never read (its owner, mode or a later write into it).
  for (const theirs of ['replaced\n', 'base\n']) {
    fs.writeFileSync(f, 'base\n')
    const undo = onceBefore('fsyncSync', () => {
      fs.writeFileSync(path.join(root, 'other.tmp'), theirs)
      fs.renameSync(path.join(root, 'other.tmp'), f)
    })
    let r
    try {
      r = files.saveFile(root, 'a.txt', 'mine\n', sha('base\n'))
    } finally {
      undo()
    }
    assert.equal(r.result, 'changed', theirs)
    assert.equal(r.text, theirs)
    assert.equal(r.hash, sha(theirs))
    assert.equal(r.written, undefined)
    assert.equal(fs.readFileSync(f, 'utf8'), theirs)
    assert.deepEqual(fs.readdirSync(root), ['a.txt'])
  }
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
    // Size 1 included: a pair at the cut is taken whole there (stepping back would loop forever).
    const parts = files.chunkText(text, size)
    assert.equal(parts.join(''), text)
    for (const p of parts) assert.ok(p.length <= Math.max(size, 2))
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

/**
 * Runs `action` until `cond` holds, up to `ms`: a folder watch on macOS is FSEvents, which starts reporting a
 * moment after fs.watch returns and can miss a change made before that (the release run failed twice on
 * macos-15 waiting 3 s for the first rename). Only for actions that are safe to repeat: a replace with the same
 * text leaves the same file and the same expected hash.
 */
async function eventually(action, cond, ms = 10000) {
  const start = Date.now()
  for (;;) {
    action()
    try {
      return await waitFor(cond, 500)
    } catch (err) {
      if (Date.now() - start > ms) throw err
    }
  }
}

/** Counts the watcher's checks of a file from now on (`.n`): what a "no event" assertion waits for. */
function countChecks(watcher) {
  const count = { n: 0 }
  const check = watcher.check.bind(watcher)
  watcher.check = (real) => {
    check(real)
    count.n++
  }
  return count
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
    await eventually(() => replace('two\n'), () => events.length >= 1)
    assert.deepEqual(events[0], { real, change: 'changed', hash: sha('two\n') })
    // A file watch would have ended with the first rename; the folder watch sees the second.
    await eventually(() => replace('three\n'), () => events.length >= 2)
    assert.equal(events[1].hash, sha('three\n'))
    // Our own save, recorded with seen(), is no event. Waited for by the check the rename starts, not
    // a fixed sleep (on a slow machine one could end before the check ran and pass with nothing
    // tested): check() notifies synchronously, and any check after the replace reads 'four'.
    const checks = countChecks(w)
    stop.seen(sha('four\n'))
    await eventually(() => replace('four\n'), () => checks.n >= 1)
    assert.equal(events.length, 2)
    fs.unlinkSync(f)
    await waitFor(() => events.length >= 3, 10000)
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

test('serveFileTab: a path that moves away right after a save still answers saved with the new hash', (t) => {
  const root = project()
  fs.writeFileSync(path.join(root, 'a.txt'), 'base\n')
  const shared = files.makeFiles(root, { debounceMs: 20 })
  const tab = fakeTab({ path: 'a.txt' })
  files.serveFileTab(shared, tab.tab)
  t.after(() => tab.close())
  tab.send({ t: 'open', req: 1 })
  tab.posted.length = 0
  // The file is gone (or re-pointed outside) the moment the write lands: every later realpath fails.
  let moved = false
  const rename = fs.renameSync
  const realpath = fs.realpathSync
  t.mock.method(fs, 'renameSync', (...a) => {
    rename(...a)
    moved = true
  })
  t.mock.method(fs, 'realpathSync', (...a) => {
    if (moved) throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    return realpath(...a)
  })
  tab.send({ t: 'save', req: 2, path: 'a.txt', baseHash: sha('base\n'), part: 0, parts: 1, text: 'mine\n' })
  assert.deepEqual(tab.posted.shift(), { t: 'saved', req: 2, path: 'a.txt', hash: sha('mine\n') })
})

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
    const checks = countChecks(shared.watcher)
    t.send({ t: 'save', req: 2, path: 'src.txt', baseHash: sha('base\n'), part: 0, parts: 2, text: 'mi' })
    assert.equal(t.posted.length, 0)
    t.send({ t: 'save', req: 2, path: 'src.txt', baseHash: sha('base\n'), part: 1, parts: 2, text: 'ne\n' })
    assert.deepEqual(t.posted.shift(), { t: 'saved', req: 2, path: 'src.txt', hash: sha('mine\n') })
    assert.equal(fs.readFileSync(f, 'utf8'), 'mine\n')

    // Our own save is no disk event (once the check our rename starts has run, a missed seen() would
    // have posted one); Claude's write is.
    await waitFor(() => checks.n >= 1)
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
  // A reconnect's open is head-only: one message, the hash and flags, no text (a page that holds its
  // base does not get the whole file again on every relay resync).
  t.posted.length = 0
  t.send({ t: 'open', req: 'again', headOnly: true })
  assert.equal(t.posted.length, 1)
  assert.equal(t.posted[0].text, undefined)
  assert.equal(t.posted[0].parts, 1)
  assert.equal(t.posted[0].hash, sha(text))
  t.close()
  shared.watcher.close()
})

test('serveFileTab: a head-only read, a no-op save, a written answer that is no event for its own line, and unwatch', async (t) => {
  const root = project(t)
  const f = path.join(root, 'a.txt')
  fs.writeFileSync(f, 'base\n')
  const real = fs.realpathSync(f)
  const shared = files.makeFiles(root, { debounceMs: 20 })
  const tab = fakeTab({ path: 'a.txt' })
  files.serveFileTab(shared, tab.tab)
  t.after(() => {
    tab.close()
    shared.watcher.close()
  })
  tab.send({ t: 'open', req: 1 })
  assert.equal(tab.posted.shift().text, 'base\n')

  // The page's re-check on focus: the hash and flags in one message, no text.
  tab.send({ t: 'read', req: 2, path: 'a.txt', headOnly: true })
  assert.deepEqual(tab.posted, [{ t: 'file', req: 2, path: 'a.txt', exists: true, hash: sha('base\n'), readOnly: false, eol: '\n', bom: false, size: 5, part: 0, parts: 1 }])
  tab.posted.length = 0

  // A save of the base's own text writes nothing: same inode, same mtime, no temp file.
  const before = fs.statSync(f, { bigint: true })
  tab.send({ t: 'save', req: 3, path: 'a.txt', baseHash: sha('base\n'), part: 0, parts: 1, text: 'base\n' })
  assert.deepEqual(tab.posted.shift(), { t: 'saved', req: 3, path: 'a.txt', hash: sha('base\n') })
  const after = fs.statSync(f, { bigint: true })
  assert.equal(after.ino, before.ino)
  assert.equal(after.mtimeNs, before.mtimeNs)
  assert.deepEqual(fs.readdirSync(root), ['a.txt'])

  // A write into the old inode lands between the check and our rename: `changed {written}`, and what
  // is on disk now is our own text, recorded as this line's seen hash. check() is synchronous: a
  // missed seen() would post a `disk` for our own write right here.
  const undo = onceBefore('renameSync', () => fs.writeFileSync(f, 'theirs\n'))
  try {
    tab.send({ t: 'save', req: 4, path: 'a.txt', baseHash: sha('base\n'), part: 0, parts: 1, text: 'mine\n' })
  } finally {
    undo()
  }
  const c = tab.posted.shift()
  assert.equal(c.t, 'changed')
  assert.equal(c.written, true)
  assert.equal(c.hash, sha('mine\n'))
  assert.equal(c.theirsHash, sha('theirs\n'))
  assert.equal(c.text, 'theirs\n')
  assert.equal(fs.readFileSync(f, 'utf8'), 'mine\n')
  shared.watcher.check(real)
  assert.deepEqual(tab.posted, [])
  // The watch is still live: a real write after it is told.
  fs.writeFileSync(f, 'claude\n')
  await waitFor(() => tab.posted.some((m) => m.t === 'disk'))
  assert.deepEqual(tab.posted.filter((m) => m.t === 'disk'), [{ t: 'disk', path: 'a.txt', change: 'changed', hash: sha('claude\n') }])
  tab.posted.length = 0

  // The page closed the file: its watch goes (the folder's too), a malformed path is ignored, and a
  // later re-read does not watch it again.
  tab.send({ t: 'unwatch', path: '../x' })
  assert.equal(shared.watcher.files.has(real), true)
  tab.send({ t: 'unwatch', path: 'a.txt' })
  assert.equal(shared.watcher.files.size, 0)
  assert.equal(shared.watcher.folders.size, 0)
  tab.send({ t: 'read', req: 5, path: 'a.txt', headOnly: true })
  assert.equal(tab.posted.shift().hash, sha('claude\n'))
  assert.equal(shared.watcher.files.size, 0)
  assert.deepEqual(tab.posted, [])
})

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

test('two lines on one file: one line saving or reading never mutes the other', async () => {
  const root = project()
  const f = path.join(root, 'a.txt')
  fs.writeFileSync(f, 'one\n')
  const shared = files.makeFiles(root, { debounceMs: 20 })
  const a = fakeTab({ path: 'a.txt' })
  const b = fakeTab({ path: 'a.txt' })
  files.serveFileTab(shared, a.tab)
  files.serveFileTab(shared, b.tab)
  try {
    a.send({ t: 'open', req: 1 })
    b.send({ t: 'open', req: 1 })
    a.posted.length = 0
    b.posted.length = 0
    a.send({ t: 'save', req: 2, path: 'a.txt', baseHash: sha('one\n'), part: 0, parts: 1, text: 'two\n' })
    assert.equal(a.posted.shift().t, 'saved')
    await waitFor(() => b.posted.length >= 1)
    assert.deepEqual(b.posted.shift(), { t: 'disk', path: 'a.txt', change: 'changed', hash: sha('two\n') })
    // The saver is not told about its own write: B's event came from a check, and that one check()
    // walks every line's subscription synchronously, so A's (missing) event is settled already.
    assert.equal(a.posted.length, 0)
    // A re-read by A inside the debounce after an outside write does not hide it from B.
    fs.writeFileSync(f, 'claude\n')
    await new Promise((r) => setTimeout(r, 5))
    a.send({ t: 'read', req: 3, path: 'a.txt' })
    await waitFor(() => b.posted.some((m) => m.t === 'disk'))
    assert.equal(b.posted.find((m) => m.t === 'disk').hash, sha('claude\n'))
  } finally {
    a.close()
    b.close()
    shared.watcher.close()
  }
})

test('a FIFO and a folder are not opened as files', (t) => {
  const root = project(t)
  fs.mkdirSync(path.join(root, 'dir'))
  assert.throws(() => files.readFile(root, 'dir'), /regular file|folder/)
  // Said as a skip, not a silent pass: the FIFO half (a read that would block the host) is untested.
  if (!mkfifo(path.join(root, 'pipe'))) return t.skip('no mkfifo here')
  assert.throws(() => files.readFile(root, 'pipe'), /regular file/)
})

/**
 * A temp tree for readOutside with HOME pointed into it (os.homedir() reads HOME on every call), so
 * the home denylist (`.ssh` and the rest) matches a folder the test made, never the real home.
 * `{ out, home, lib }`: `lib` is a library folder outside any project (a node_modules package).
 */
function outsideTree(t) {
  const out = fs.realpathSync(tempDir('cc-editor-outside-'))
  const savedHome = process.env.HOME
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    fs.rmSync(out, { recursive: true, force: true })
  })
  const home = path.join(out, 'home')
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY\n')
  process.env.HOME = home
  assert.equal(os.homedir(), home)
  const lib = path.join(out, 'lib', 'node_modules', 'pkg')
  fs.mkdirSync(lib, { recursive: true })
  fs.writeFileSync(path.join(lib, 'index.d.ts'), 'export declare const x: number\n')
  return { out, home, lib }
}

test('readOutside: a link in node_modules to a refused tree is refused by its realpath; malformed and missing paths', (t) => {
  const { home, lib } = outsideTree(t)
  // A plain library file opens read-only (the control: the tree itself is not refused).
  const ok = files.readOutside(path.join(lib, 'index.d.ts'))
  assert.equal(ok.exists, true)
  assert.equal(ok.readOnly, true)
  assert.equal(ok.why, 'outside')
  assert.equal(ok.text, 'export declare const x: number\n')
  // The named path is an innocent .d.ts in node_modules, so only the second check, on the realpath,
  // stands between a server's answer (which a page's text decides) and the private key.
  const link = path.join(lib, 'key.d.ts')
  fs.symlinkSync(path.join(home, '.ssh', 'id_ed25519'), link)
  assert.equal(files.outsideRefused(link), false)
  assert.throws(() => files.readOutside(link), /not shown outside the project/)
  // The same through a linked folder (a package symlinked by a workspace tool).
  fs.symlinkSync(path.join(home, '.ssh'), path.join(lib, 'linked'))
  assert.throws(() => files.readOutside(path.join(lib, 'linked', 'id_ed25519')), /not shown outside the project/)
  // Named directly, the first check refuses it.
  assert.throws(() => files.readOutside(path.join(home, '.ssh', 'id_ed25519')), /not shown outside the project/)
  // Only an absolute path with no NUL is looked at.
  for (const bad of ['node_modules/pkg/index.d.ts', 'index.d.ts', `${lib}/index.d.ts\0x`, '', 3, null]) {
    assert.throws(() => files.readOutside(bad), /not an absolute path/, String(bad))
  }
  // A file that is not there is the tab's "deleted on disk", not an error.
  assert.deepEqual(files.readOutside(path.join(lib, 'gone.d.ts')), { rel: path.join(lib, 'gone.d.ts'), exists: false })
})

test('readOutside: a folder and a FIFO are not opened; binary, large and non-UTF-8 files keep their own why', (t) => {
  const { out, lib } = outsideTree(t)
  // A binary file: no text, and its reason, not the generic `outside`.
  fs.writeFileSync(path.join(lib, 'a.node'), Buffer.from([1, 0, 2]))
  const b = files.readOutside(path.join(lib, 'a.node'))
  assert.equal(b.readOnly, true)
  assert.equal(b.why, 'binary')
  assert.equal(b.text, undefined)
  fs.writeFileSync(path.join(lib, 'big.js'), 'x'.repeat(files.MAX_EDIT_BYTES + 1))
  const g = files.readOutside(path.join(lib, 'big.js'))
  assert.equal(g.why, 'large')
  assert.equal(g.text.length, files.MAX_EDIT_BYTES + 1)
  fs.writeFileSync(path.join(lib, 'latin1.js'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  assert.equal(files.readOutside(path.join(lib, 'latin1.js')).why, 'encoding')
  assert.throws(() => files.readOutside(lib), /regular file|folder/)
  if (!mkfifo(path.join(out, 'pipe'))) return t.skip('no mkfifo here')
  // A FIFO would block the read, and with it the whole plugin host.
  assert.throws(() => files.readOutside(path.join(out, 'pipe')), /regular file/)
})

test('a file over the view cap is not hashed to the end: a cheap size-and-mtime stamp, read-only, large', () => {
  const root = project()
  const f = path.join(root, 'huge.log')
  fs.writeFileSync(f, 'x'.repeat(files.MAX_VIEW_BYTES + 1))
  const r = files.readFile(root, 'huge.log')
  assert.equal(r.readOnly, true)
  assert.equal(r.why, 'large')
  assert.equal(r.text, undefined)
  assert.match(r.hash, /^big:/)
  assert.equal(r.size, files.MAX_VIEW_BYTES + 1)
  assert.throws(() => files.saveFile(root, 'huge.log', 'x', r.hash), /read-only/)
})

test('a file with another hard link is read-only: a rename-replace would cut it off', () => {
  const root = project()
  fs.writeFileSync(path.join(root, 'a.txt'), 'x\n')
  fs.linkSync(path.join(root, 'a.txt'), path.join(root, 'b.txt'))
  const r = files.readFile(root, 'a.txt')
  assert.equal(r.readOnly, true)
  assert.equal(r.why, 'linked')
  assert.equal(r.text, 'x\n')
  assert.throws(() => files.saveFile(root, 'a.txt', 'y\n', r.hash), /read-only/)
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'x\n')
})

test('a file without write permission is read-only, not replaced by rename', { skip: isRoot }, () => {
  const root = project()
  const f = path.join(root, 'ro.txt')
  fs.writeFileSync(f, 'x\n')
  fs.chmodSync(f, 0o444)
  const r = files.readFile(root, 'ro.txt')
  assert.equal(r.why, 'permission')
  assert.throws(() => files.saveFile(root, 'ro.txt', 'y\n', r.hash), /read-only/)
  assert.equal(fs.readFileSync(f, 'utf8'), 'x\n')
})

test('a parent folder swapped for a link while the file opens is refused', () => {
  const root = project()
  const outside = tempDir('cc-editor-out-')
  fs.writeFileSync(path.join(outside, 'a.txt'), 'secret\n')
  fs.mkdirSync(path.join(root, 'sub'))
  fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'mine\n')
  const undo = onceBefore('openSync', () => {
    fs.renameSync(path.join(root, 'sub'), path.join(root, 'sub.old'))
    fs.symlinkSync(outside, path.join(root, 'sub'))
  })
  try {
    assert.throws(() => files.readFile(root, 'sub/a.txt'), /changed while/)
  } finally {
    undo()
  }
  // And a link to a folder outside is refused up front.
  fs.symlinkSync(outside, path.join(root, 'out'))
  assert.throws(() => files.readFile(root, 'out/a.txt'), /outside/)
  assert.throws(() => files.saveFile(root, 'out/a.txt', 'x', null), /outside/)
})

test('save: the temp file goes when the rename or the link fails, and `changed` returns leave none', () => {
  const root = project()
  const f = path.join(root, 'a.txt')
  fs.writeFileSync(f, 'base\n')
  const orig = fs.renameSync
  fs.renameSync = () => {
    throw new Error('boom')
  }
  try {
    assert.throws(() => files.saveFile(root, 'a.txt', 'mine\n', sha('base\n')), /boom/)
  } finally {
    fs.renameSync = orig
  }
  assert.deepEqual(fs.readdirSync(root), ['a.txt'])
  const origLink = fs.linkSync
  fs.linkSync = () => {
    throw Object.assign(new Error('nope'), { code: 'EIO' })
  }
  try {
    assert.throws(() => files.saveFile(root, 'new.txt', 'x', null), /nope/)
  } finally {
    fs.linkSync = origLink
  }
  assert.deepEqual(fs.readdirSync(root), ['a.txt'])
  // changed paths: the bytes differ at the first check, then at the re-check before the rename.
  const r1 = files.saveFile(root, 'a.txt', 'mine\n', sha('other\n'))
  assert.equal(r1.result, 'changed')
  const undo = onceBefore('fsyncSync', () => fs.writeFileSync(f, 'theirs\n'))
  let r2
  try {
    r2 = files.saveFile(root, 'a.txt', 'mine\n', sha('base\n'))
  } finally {
    undo()
  }
  assert.equal(r2.result, 'changed')
  assert.equal(r2.text, 'theirs\n')
  assert.equal(fs.readFileSync(f, 'utf8'), 'theirs\n')
  assert.deepEqual(fs.readdirSync(root), ['a.txt'])
})

test('save with baseHash null: the old eol and BOM come back, no hard links is a plain exclusive create, a missing folder is an error', () => {
  const root = project()
  const s = files.saveFile(root, 'w.txt', 'a\nb\n', null, { eol: '\r\n', bom: true })
  assert.deepEqual(fs.readFileSync(path.join(root, 'w.txt')), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n')]))
  assert.equal(s.hash, sha(fs.readFileSync(path.join(root, 'w.txt'))))

  const origLink = fs.linkSync
  fs.linkSync = () => {
    throw Object.assign(new Error('no links'), { code: 'EPERM' })
  }
  try {
    assert.equal(files.saveFile(root, 'x.txt', 'hi\n', null).result, 'saved')
    assert.equal(files.saveFile(root, 'x.txt', 'again\n', null).result, 'changed')
  } finally {
    fs.linkSync = origLink
  }
  assert.equal(fs.readFileSync(path.join(root, 'x.txt'), 'utf8'), 'hi\n')
  assert.deepEqual(fs.readdirSync(root).sort(), ['w.txt', 'x.txt'])

  assert.throws(() => files.saveFile(root, 'gone/a.txt', 'x', null), (e) => e.code === 'ENOENT')
})

test('stale temp files of an interrupted save are swept on open, fresh ones are left', () => {
  const root = project()
  const f = path.join(root, 'a.txt')
  fs.writeFileSync(f, 'x\n')
  const stale = path.join(root, '.a.txt.cc-editor-aabbccddeeff.tmp')
  const fresh = path.join(root, '.a.txt.cc-editor-112233445566.tmp')
  const other = path.join(root, '.b.txt.cc-editor-aabbccddeeff.tmp')
  for (const p of [stale, fresh, other]) fs.writeFileSync(p, 'half')
  const old = new Date(Date.now() - 10 * 60 * 1000)
  fs.utimesSync(stale, old, old)
  fs.utimesSync(other, old, old)
  const shared = files.makeFiles(root)
  const t = fakeTab({ path: 'a.txt' })
  files.serveFileTab(shared, t.tab)
  t.send({ t: 'open', req: 1 })
  t.close()
  shared.watcher.close()
  assert.deepEqual(fs.readdirSync(root).sort(), ['.a.txt.cc-editor-112233445566.tmp', '.b.txt.cc-editor-aabbccddeeff.tmp', 'a.txt'])
})

test('the sweep reads a file\'s folder at most once in a while, not on every open', (t) => {
  const root = project()
  fs.writeFileSync(path.join(root, 'a.txt'), 'x\n')
  const shared = files.makeFiles(root)
  t.after(() => shared.watcher.close())
  const readdir = fs.readdirSync
  let reads = 0
  t.mock.method(fs, 'readdirSync', (...a) => {
    if (String(a[0]) === fs.realpathSync(root)) reads++
    return readdir(...a)
  })
  for (let i = 0; i < 3; i++) {
    const tab = fakeTab({ path: 'a.txt' })
    files.serveFileTab(shared, tab.tab)
    tab.send({ t: 'open', req: 1 })
    tab.close()
  }
  assert.equal(reads, 1)
})

test('serveFileTab: save bounds, a part for another path, a deleted file and errors with no absolute path', () => {
  const root = project()
  fs.writeFileSync(path.join(root, 'a.txt'), 'x\n')
  const shared = files.makeFiles(root, { debounceMs: 20 })
  const t = fakeTab({ path: 'a.txt' })
  files.serveFileTab(shared, t.tab)
  try {
    // Too many saves in flight.
    for (let i = 0; i < 4; i++) t.send({ t: 'save', req: `s${i}`, path: 'a.txt', baseHash: 'h', part: 0, parts: 2, text: 'x' })
    assert.equal(t.posted.length, 0)
    t.send({ t: 'save', req: 's4', path: 'a.txt', baseHash: 'h', part: 0, parts: 2, text: 'x' })
    assert.match(t.posted.shift().message, /too many saves/)
    // A part for another path drops that save.
    t.send({ t: 'save', req: 's0', path: 'b.txt', baseHash: 'h', part: 1, parts: 2, text: 'x' })
    assert.match(t.posted.shift().message, /out of order/)
    // Too many announced parts (after the pending ones are gone), too long a text.
    t.close()
    shared.watcher.close()
  } finally {
    t.close()
    shared.watcher.close()
  }
  const s2 = files.makeFiles(root, { debounceMs: 20 })
  const u = fakeTab({ path: 'a.txt' })
  files.serveFileTab(s2, u.tab)
  try {
    u.send({ t: 'save', req: 'p', path: 'a.txt', baseHash: 'h', part: 0, parts: 1e6, text: 'x' })
    assert.match(u.posted.shift().message, /too many save parts/)
    u.send({ t: 'save', req: 'l', path: 'a.txt', baseHash: sha('x\n'), part: 0, parts: 1, text: 'y'.repeat(files.MAX_EDIT_BYTES + 1) })
    assert.match(u.posted.shift().message, /too large/)
    // A string base for a file that is gone: changed {deleted}.
    fs.unlinkSync(path.join(root, 'a.txt'))
    u.send({ t: 'save', req: 'd', path: 'a.txt', baseHash: sha('x\n'), part: 0, parts: 1, text: 'z' })
    const d = u.posted.find((m) => m.req === 'd')
    assert.equal(d.t, 'changed')
    assert.equal(d.deleted, true)
    // Errors carry no absolute path.
    u.posted.length = 0
    u.send({ t: 'save', req: 'e', path: 'nodir/a.txt', baseHash: null, part: 0, parts: 1, text: 'z' })
    u.send({ t: 'read', req: 'f', path: '../x' })
    assert.equal(u.posted.length, 2)
    for (const m of u.posted) {
      assert.equal(m.t, 'error')
      assert.ok(!m.message.includes(root), m.message)
      assert.ok(!m.message.includes(fs.realpathSync(root)), m.message)
    }
    assert.match(u.posted[0].message, /nodir\/a\.txt/)
  } finally {
    u.close()
    s2.watcher.close()
  }
})

test('serveFileTab: a line may watch only so many files, and a save whose last part never comes is dropped', () => {
  const root = project()
  for (let i = 0; i < 33; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x')
  const shared = files.makeFiles(root)
  const t = fakeTab({ path: 'f0.txt' })
  files.serveFileTab(shared, t.tab)
  try {
    for (let i = 0; i < 32; i++) t.send({ t: 'open', req: i, path: `f${i}.txt` })
    t.posted.length = 0
    t.send({ t: 'open', req: 'over', path: 'f32.txt' })
    assert.match(t.posted.shift().message, /too many files/)
  } finally {
    t.close()
    shared.watcher.close()
  }
  const orig = global.setTimeout
  const timers = []
  const s2 = files.makeFiles(root)
  const t2 = fakeTab({ path: 'f0.txt' })
  files.serveFileTab(s2, t2.tab)
  try {
    global.setTimeout = (fn, ms) => {
      timers.push({ fn, ms })
      return { unref() {} }
    }
    t2.send({ t: 'save', req: 'slow', path: 'f0.txt', baseHash: 'h', part: 0, parts: 2, text: 'x' })
    global.setTimeout = orig
    assert.equal(timers.length, 1)
    timers[0].fn()
    assert.match(t2.posted.shift().message, /timed out/)
    // The save is gone: its next part is out of order, not a late save.
    t2.send({ t: 'save', req: 'slow', path: 'f0.txt', baseHash: 'h', part: 1, parts: 2, text: 'y' })
    assert.match(t2.posted.shift().message, /out of order/)
  } finally {
    global.setTimeout = orig
    t2.close()
    s2.watcher.close()
  }
})

test('the folder watch is armed again after its folder is deleted and recreated, and checks the files then', async () => {
  const root = project()
  const dir = path.join(root, 'd')
  fs.mkdirSync(dir)
  const f = path.join(dir, 'a.txt')
  fs.writeFileSync(f, 'one\n')
  const real = fs.realpathSync(f)
  const calls = []
  const watchImpl = (d, opts, cb) => {
    const w = {
      cb,
      closed: false,
      handlers: {},
      on(ev, h) {
        this.handlers[ev] = h
      },
      close() {
        this.closed = true
      },
    }
    calls.push(w)
    return w
  }
  const events = []
  const w = new files.FolderWatcher((r, ev) => events.push(ev), { watchImpl, debounceMs: 10, rearmMs: 20 })
  const stop = w.add(real, sha('one\n'))
  try {
    assert.equal(calls.length, 1)
    // The OS watch dies with the folder.
    calls[0].handlers.error(new Error('gone'))
    assert.equal(calls[0].closed, true)
    fs.writeFileSync(f, 'two\n') // the folder came back with other content
    await waitFor(() => calls.length >= 2)
    await waitFor(() => events.length >= 1)
    assert.deepEqual(events[0], { change: 'changed', hash: sha('two\n') })
    // The folder's own deletion, reported by inotify as `rename` with its name, drops the watch too.
    calls[1].cb('rename', 'd')
    assert.equal(calls[1].closed, true)
    await waitFor(() => calls.length >= 3)
    // A burst of events shares one check (it is not pushed back by each event).
    fs.writeFileSync(f, 'three\n')
    for (let i = 0; i < 5; i++) calls[2].cb('change', 'a.txt')
    await waitFor(() => events.length >= 2)
    assert.equal(events[1].hash, sha('three\n'))
  } finally {
    stop()
    w.close()
  }
})

test('a big watched file appended to all the time is checked less often (each check hashes all of it)', (t) => {
  const root = project()
  const f = fs.realpathSync(root) + '/big.log'
  fs.writeFileSync(f, Buffer.alloc(4 * 1024 * 1024, 'a'))
  const calls = []
  const w = new files.FolderWatcher(() => {}, { watchImpl: (dir, opts, cb) => (calls.push({ dir, cb }), { close() {} }), debounceMs: 10 })
  const stop = w.add(f, null)
  t.after(() => (stop(), w.close()))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const checks = countChecks(w)
  // Its size is not known yet: the first check waits the debounce only.
  calls[0].cb('change', 'big.log')
  t.mock.timers.tick(10)
  assert.equal(checks.n, 1)
  // 4 MiB now: 10 ms + 4 x 50 ms before the next one.
  fs.appendFileSync(f, 'more\n')
  calls[0].cb('change', 'big.log')
  t.mock.timers.tick(10)
  assert.equal(checks.n, 1)
  t.mock.timers.tick(200)
  assert.equal(checks.n, 2)
})

test('a big file watched with the size its read had backs off from the first check; a deleted one goes back to the plain debounce', (t) => {
  const root = project()
  const f = fs.realpathSync(root) + '/big.log'
  fs.writeFileSync(f, Buffer.alloc(4 * 1024 * 1024, 'a'))
  const calls = []
  const w = new files.FolderWatcher(() => {}, { watchImpl: (dir, opts, cb) => (calls.push({ dir, cb }), { close() {} }), debounceMs: 10 })
  const stop = w.add(f, null, undefined, 4 * 1024 * 1024)
  t.after(() => (stop(), w.close()))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const checks = countChecks(w)
  // 4 MiB known at the start: 10 ms + 4 x 50 ms before the first check.
  calls[0].cb('change', 'big.log')
  t.mock.timers.tick(10)
  assert.equal(checks.n, 0)
  t.mock.timers.tick(200)
  assert.equal(checks.n, 1)
  // Gone: nothing to hash, so the next check waits the debounce only.
  fs.rmSync(f)
  calls[0].cb('rename', 'big.log')
  t.mock.timers.tick(210)
  assert.equal(checks.n, 2)
  calls[0].cb('rename', 'big.log')
  t.mock.timers.tick(10)
  assert.equal(checks.n, 3)
})

test('serveFileTab: a file opened in a tab is watched with its size, so its first disk event already backs off', (t) => {
  const root = project()
  fs.writeFileSync(path.join(root, 'big.log'), Buffer.alloc(2 * 1024 * 1024, 'a'))
  const shared = files.makeFiles(root, { debounceMs: 10 })
  const tab = fakeTab({ path: 'big.log' })
  files.serveFileTab(shared, tab.tab)
  t.after(() => (tab.close(), shared.watcher.close()))
  tab.send({ t: 'open', req: 1 })
  const f = shared.watcher.files.get(fs.realpathSync(path.join(root, 'big.log')))
  assert.equal(f.size, 2 * 1024 * 1024)
  assert.equal(shared.watcher.delayOf(f), 10 + 100)
})

test('folders watched are capped for the whole plugin; a folder left out gets the slot another one frees', () => {
  const calls = []
  const w = new files.FolderWatcher(null, { watchImpl: (dir) => (calls.push(dir), { close() {} }), maxFolders: 2, debounceMs: 5 })
  const checked = []
  w.check = (real) => checked.push(real)
  const stops = ['/a/x', '/b/x', '/c/x', '/d/x'].map((p) => w.add(p, null))
  assert.deepEqual(calls, ['/a', '/b'])
  assert.equal(w.armedCount(), 2)
  // /a closes: the first folder left out (/c) is watched now, and its file is looked at once.
  stops[0]()
  assert.deepEqual(calls, ['/a', '/b', '/c'])
  assert.equal(w.armedCount(), 2)
  return new Promise((resolve) => setTimeout(resolve, 50)).then(() => {
    assert.deepEqual(checked, ['/c/x'])
    // A folder that was never armed frees no slot: /d still waits for one.
    stops[3]()
    stops[2]()
    assert.deepEqual(calls, ['/a', '/b', '/c'])
    stops[1]()
    w.close()
  })
})

test('safeMessage: an fs error is its code and the relative path, a project path in a message is cut out', () => {
  const e = Object.assign(new Error("EACCES: permission denied, open '/home/u/proj/a.txt'"), { code: 'EACCES' })
  assert.equal(files.safeMessage(e, '/home/u/proj', 'a.txt'), 'permission denied: a.txt')
  assert.equal(files.safeMessage(new Error('bad /home/u/proj/x'), '/home/u/proj', 'x'), 'bad <project>/x')
})

test('redactPaths: the project, then the home folder, cut out of a message or a stderr tail', () => {
  const home = require('node:os').homedir()
  assert.equal(files.redactPaths(`cwd ${home}/proj/sub is not an existing directory; see ${home}/.claude/x`, `${home}/proj`), 'cwd <project>/sub is not an existing directory; see ~/.claude/x')
  assert.equal(files.redactPaths('plain', undefined), 'plain')
})
