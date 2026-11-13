// The file tab page's state (src/page/session.mjs): base, saves, autosave, and what it re-sends on a
// new line to the host (a host restart, a browser reconnect). The first part fakes the host; the
// second runs the page session against the real host line (dist/lib/files.js serveFileTab) on a temp
// folder, over an asynchronous fake port, and "restarts the host" by giving the page a new line.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createSession, chunkText, CHUNK_CHARS } from '../src/page/session.mjs'

const require = createRequire(import.meta.url)
const files = require('../dist/lib/files.js')

function fakeTimers() {
  let next = 1
  const pending = new Map()
  return {
    set: (fn, ms) => (pending.set(next, { fn, ms }), next++),
    clear: (h) => pending.delete(h),
    /** Run every pending timer of at most `ms` (the ones armed meanwhile wait for the next call). */
    run(ms = Infinity) {
      for (const [h, t] of [...pending]) {
        if (t.ms <= ms && pending.has(h)) {
          pending.delete(h)
          t.fn()
        }
      }
    },
    delays: () => [...pending.values()].map((t) => t.ms),
  }
}

function fakeUi() {
  const ui = {
    posted: [],
    text: '',
    loads: [],
    replaced: [],
    gotos: [],
    dirty: [],
    last: null,
    post: (m) => ui.posted.push(m),
    load: (t, info) => {
      ui.text = t
      ui.loads.push(info)
    },
    replace: (t) => {
      ui.text = t
      ui.replaced.push(t)
    },
    getText: () => ui.text,
    goto: (l, c) => ui.gotos.push([l, c]),
    setDirty: (d) => ui.dirty.push(d),
    render: (v) => (ui.last = v),
  }
  return ui
}

const head = (over) => ({ t: 'file', path: 'a.txt', exists: true, hash: 'h1', readOnly: false, eol: '\n', bom: false, size: 4, part: 0, parts: 1, ...over })

function loaded(text = 'one\n', over = {}) {
  const ui = fakeUi()
  const timers = fakeTimers()
  const s = createSession(ui, timers)
  s.connect()
  assert.deepEqual(ui.posted[0], { t: 'open', first: true, req: 1 })
  s.receive(head({ req: 1, text, ...over }))
  ui.posted.length = 0
  return { ui, timers, s }
}

test('first connect opens the file; parts are joined; a goto before the text waits for it', () => {
  const ui = fakeUi()
  const s = createSession(ui, fakeTimers())
  s.connect()
  s.receive({ t: 'goto', line: 2 })
  s.receive(head({ req: 1, part: 1, parts: 2, text: 'two\n' }))
  assert.equal(ui.loads.length, 0)
  s.receive(head({ req: 1, part: 0, parts: 2, text: 'one\n' }))
  assert.equal(ui.text, 'one\ntwo\n')
  assert.deepEqual(ui.gotos, [[2, 1]])
  assert.equal(ui.last.status, 'saved')
  // A stale answer (another req) is ignored.
  s.receive(head({ req: 99, text: 'other' }))
  assert.equal(ui.text, 'one\ntwo\n')
})

test('typing makes the tab dirty at once; the idle timer saves with the base hash; saved moves the base', () => {
  const { ui, timers, s } = loaded()
  ui.text = 'one\nmore\n'
  s.edited()
  assert.deepEqual(ui.dirty, [true])
  assert.equal(ui.last.status, 'unsaved')
  assert.ok(timers.delays().includes(3000))
  timers.run()
  const save = ui.posted.find((m) => m.t === 'save')
  assert.deepEqual(save, { t: 'save', req: 2, path: 'a.txt', baseHash: 'h1', eol: '\n', bom: false, part: 0, parts: 1, text: 'one\nmore\n' })
  assert.equal(ui.last.status, 'saving')
  s.receive({ t: 'saved', req: 2, path: 'a.txt', hash: 'h2' })
  assert.deepEqual(ui.dirty, [true, false])
  assert.equal(s._state.base.hash, 'h2')
  assert.equal(ui.last.status, 'saved')
})

test('undo back to the base clears dirty after the check; settings change the idle time and blur saves', () => {
  const { ui, timers, s } = loaded()
  s.receive({ t: 'settings', idleSeconds: 0, onBlur: true })
  ui.text = 'x'
  s.edited()
  ui.text = 'one\n'
  s.edited()
  timers.run(200)
  assert.deepEqual(ui.dirty, [true, false])
  // Idle off: no save timer; focus loss saves.
  ui.text = 'two\n'
  s.edited()
  timers.run(200)
  assert.equal(ui.posted.length, 0)
  s.blur()
  assert.equal(ui.posted.at(-1).t, 'save')
  // onBlur off: leaving does not save.
  s.receive({ t: 'saved', req: ui.posted.at(-1).req, hash: 'h2' })
  s.receive({ t: 'settings', idleSeconds: 0, onBlur: false })
  ui.text = 'three\n'
  s.edited()
  const n = ui.posted.length
  s.blur()
  assert.equal(ui.posted.length, n)
  // Ctrl+S still saves.
  assert.equal(s.saveNow(), true)
})

test('a save asked while one is in flight runs after it; a big text goes in parts', () => {
  const { ui, s } = loaded()
  ui.text = 'a'.repeat(CHUNK_CHARS + 10)
  s.edited()
  s.saveNow()
  const parts = ui.posted.filter((m) => m.t === 'save')
  assert.equal(parts.length, 2)
  assert.deepEqual(parts.map((p) => [p.part, p.parts, p.text.length]), [[0, 2, CHUNK_CHARS], [1, 2, 10]])
  ui.text += 'b'
  s.edited()
  assert.equal(s.saveNow(), false)
  s.receive({ t: 'saved', req: parts[0].req, hash: 'h2' })
  const again = ui.posted.filter((m) => m.t === 'save' && m.req !== parts[0].req)
  assert.equal(again.length, 2)
  assert.equal(again[0].baseHash, 'h2')
})

test('chunkText never splits a surrogate pair', () => {
  const parts = chunkText('ab😀cd', 3)
  assert.deepEqual(parts, ['ab', '😀c', 'd'])
  assert.deepEqual(chunkText(''), [''])
})

test('a changed answer is a conflict: no autosave until Reload or Keep mine', () => {
  const { ui, timers, s } = loaded()
  ui.text = 'mine\n'
  s.edited()
  s.saveNow()
  const req = ui.posted.at(-1).req
  s.receive({ t: 'changed', req, path: 'a.txt', hash: 'h9', readOnly: false, part: 0, parts: 1, text: 'theirs\n' })
  assert.deepEqual(ui.last.conflict, { kind: 'changed' })
  ui.text = 'mine2\n'
  s.edited()
  timers.run()
  assert.equal(ui.posted.filter((m) => m.t === 'save').length, 1)
  assert.equal(s.saveNow(), false)
  // Keep mine: theirs is the base now, so the save overwrites it by compare-and-swap.
  s.keepMine()
  const save = ui.posted.at(-1)
  assert.equal(save.t, 'save')
  assert.equal(save.baseHash, 'h9')
  assert.equal(save.text, 'mine2\n')
  assert.equal(ui.last.conflict, null)
})

test('Reload takes theirs into the buffer and the base', () => {
  const { ui, s } = loaded()
  ui.text = 'mine\n'
  s.edited()
  s.saveNow()
  s.receive({ t: 'changed', req: ui.posted.at(-1).req, path: 'a.txt', hash: 'h9', part: 0, parts: 1, text: 'theirs\n' })
  s.takeTheirs()
  assert.equal(ui.text, 'theirs\n')
  assert.deepEqual(s._state.base, { text: 'theirs\n', hash: 'h9' })
  assert.equal(ui.last.dirty, false)
})

test('disk events: a clean tab reloads, a dirty one gets a conflict, a deletion keeps the text', () => {
  const { ui, s } = loaded()
  // Our own hash: nothing.
  s.receive({ t: 'disk', path: 'a.txt', change: 'changed', hash: 'h1' })
  assert.equal(ui.posted.length, 0)
  s.receive({ t: 'disk', path: 'a.txt', change: 'changed', hash: 'h2' })
  const read = ui.posted.at(-1)
  assert.deepEqual(read, { t: 'read', path: 'a.txt', req: read.req })
  s.receive(head({ req: read.req, hash: 'h2', text: 'two\n' }))
  assert.deepEqual(ui.replaced, ['two\n'])
  assert.equal(s._state.base.hash, 'h2')
  // Dirty: a conflict, the buffer untouched.
  ui.text = 'mine\n'
  s.edited()
  s.receive({ t: 'disk', path: 'a.txt', change: 'changed', hash: 'h3' })
  s.receive(head({ req: ui.posted.at(-1).req, hash: 'h3', text: 'three\n' }))
  assert.equal(ui.text, 'mine\n')
  assert.deepEqual(ui.last.conflict, { kind: 'changed' })
  // Deleted: the tab keeps the text; Save recreates (baseHash null).
  s.keepMine()
  s.receive({ t: 'saved', req: ui.posted.at(-1).req, hash: 'h4' })
  s.receive({ t: 'disk', path: 'a.txt', change: 'deleted' })
  assert.deepEqual(ui.last.conflict, { kind: 'deleted' })
  assert.equal(ui.last.dirty, true)
  s.saveNow()
  assert.equal(ui.posted.at(-1).baseHash, null)
})

test('state re-send on a new line: the file is opened again, the buffer kept, a lost save sent again', () => {
  const { ui, s } = loaded()
  ui.text = 'mine\n'
  s.edited()
  s.saveNow()
  const lost = ui.posted.at(-1).req
  // The host restarts: the old line's answer never comes.
  s.connect()
  const reopen = ui.posted.at(-1)
  assert.deepEqual(reopen, { t: 'open', req: reopen.req })
  // A late answer of the old line is ignored.
  s.receive({ t: 'saved', req: lost, hash: 'stale' })
  assert.equal(s._state.base.hash, 'h1')
  // Disk still holds the base: the page keeps its buffer and saves again.
  s.receive(head({ req: reopen.req, text: 'one\n' }))
  assert.equal(ui.loads.length, 1)
  assert.equal(ui.text, 'mine\n')
  const resend = ui.posted.at(-1)
  assert.equal(resend.t, 'save')
  assert.equal(resend.baseHash, 'h1')
  assert.equal(resend.text, 'mine\n')
})

test('state re-send: the lost save had landed (disk holds the buffer), so only the hash moves', () => {
  const { ui, s } = loaded()
  ui.text = 'mine\n'
  s.edited()
  s.saveNow()
  s.connect()
  s.receive(head({ req: ui.posted.at(-1).req, hash: 'h2', text: 'mine\n' }))
  assert.deepEqual(s._state.base, { text: 'mine\n', hash: 'h2' })
  assert.equal(ui.last.conflict, null)
  assert.equal(ui.last.dirty, false)
  assert.deepEqual(ui.replaced, [])
})

test('read-only and binary files: no saves, never dirty', () => {
  const ro = loaded('x\n', { readOnly: true, why: 'encoding' })
  ro.ui.text = 'y\n'
  ro.s.edited()
  assert.equal(ro.s.saveNow(), false)
  assert.deepEqual(ro.ui.dirty, [])
  assert.equal(ro.ui.last.readOnly, true)
  const bin = createSession(fakeUi(), fakeTimers())
  bin.connect()
  bin.receive(head({ req: 1, readOnly: true, why: 'binary', text: undefined }))
  assert.equal(bin.view().noText, true)
  assert.equal(bin.saveNow(), false)
})

test('a missing file opens as a new one: clean until typed in, created by its first save', () => {
  const ui = fakeUi()
  const s = createSession(ui, fakeTimers())
  s.connect()
  s.receive({ t: 'file', req: 1, path: 'new.txt', exists: false, part: 0, parts: 1 })
  assert.equal(ui.last.exists, false)
  assert.equal(ui.last.dirty, false)
  s.blur()
  assert.equal(ui.posted.length, 1)
  ui.text = 'hello\n'
  s.edited()
  s.saveNow()
  assert.equal(ui.posted.at(-1).baseHash, null)
})

// ---- against the real host line ----

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edpage-')))
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\r\ntwo\r\n')
  return root
}

/** A host line (serveFileTab) for the page session, both ways asynchronous like a MessagePort. */
function hostLine(mine, session, params = { path: 'a.txt' }) {
  const listeners = []
  const closers = []
  let open = true
  const tab = {
    id: 't1',
    params,
    post: (m) => {
      const copy = structuredClone(m)
      queueMicrotask(() => open && session.receive(copy))
    },
    onMessage: (fn) => listeners.push(fn),
    onClose: (fn) => closers.push(fn),
  }
  files.serveFileTab(mine, tab, null)
  return {
    send: (m) => {
      const copy = structuredClone(m)
      queueMicrotask(() => open && listeners.forEach((l) => l(copy)))
    },
    close: () => {
      open = false
      closers.forEach((c) => c())
    },
  }
}

const settle = () => new Promise((r) => setTimeout(r, 30))

test('real host: load, edit, save keeps CRLF; a host restart keeps the dirty buffer and saves it on the new line', async () => {
  const root = project()
  const mine = files.makeFiles(root)
  const ui = fakeUi()
  let line
  ui.post = (m) => line.send(m)
  const s = createSession(ui, fakeTimers())
  line = hostLine(mine, s)
  s.connect()
  await settle()
  assert.equal(ui.text, 'one\ntwo\n')
  ui.text = 'one\ntwo\nthree\n'
  s.edited()
  s.saveNow()
  await settle()
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\r\ntwo\r\nthree\r\n')
  assert.equal(ui.last.dirty, false)

  // Edit, then the host goes away before the save reaches it: a new host, a new line.
  ui.text = 'one\ntwo\nthree\nfour\n'
  s.edited()
  line.close()
  s.saveNow() // sent into the dead line: lost
  await settle()
  const fresh = files.makeFiles(root)
  line = hostLine(fresh, s)
  s.connect()
  await settle()
  assert.equal(ui.text, 'one\ntwo\nthree\nfour\n')
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\r\ntwo\r\nthree\r\nfour\r\n')
  assert.equal(ui.last.dirty, false)

  // Claude writes the file while the tab is clean: the new line's watch tells, the page reloads.
  fs.writeFileSync(path.join(root, 'a.txt'), 'claude\r\n')
  for (let i = 0; i < 40 && ui.text !== 'claude\n'; i++) await settle()
  assert.equal(ui.text, 'claude\n')
  line.close()
  mine.watcher.close()
  fresh.watcher.close()
})

test('real host: a write between load and save comes back as a conflict, nothing overwritten', async () => {
  const root = project()
  const mine = files.makeFiles(root)
  const ui = fakeUi()
  let line
  ui.post = (m) => line.send(m)
  const s = createSession(ui, fakeTimers())
  line = hostLine(mine, s)
  s.connect()
  await settle()
  ui.text = 'mine\n'
  s.edited()
  line.close() // no watch events: the save itself must find the change
  line = hostLine(mine, s)
  fs.writeFileSync(path.join(root, 'a.txt'), 'theirs\n')
  s.connect()
  await settle()
  // The reconnect's open saw disk differ from the base while dirty: a conflict.
  assert.deepEqual(ui.last.conflict, { kind: 'changed' })
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'theirs\n')
  s.keepMine()
  await settle()
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'mine\n')
  line.close()
  mine.watcher.close()
})
