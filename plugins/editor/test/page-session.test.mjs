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
import { createSession, chunkText, CHUNK_CHARS, NOTICE_MS, LOST_NOT_TEXT } from '../src/page/session.mjs'

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
    // The conflict marker reports ({ t: 'conflict', on }), apart from the file traffic.
    markers: [],
    text: '',
    loads: [],
    replaced: [],
    merges: [],
    gotos: [],
    dirty: [],
    last: null,
    post: (m) => (m.t === 'conflict' ? ui.markers.push(m.on) : ui.posted.push(m)),
    load: (t, info) => {
      ui.text = t
      ui.loads.push(info)
    },
    replace: (t) => {
      ui.text = t
      ui.replaced.push(t)
    },
    merge: (layout) => {
      ui.text = layout.text
      ui.merges.push(layout)
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

test('a changed answer merges: a clean merge is applied and saved on theirs, with the notice', () => {
  const { ui, timers, s } = loaded('one\ntwo\nthree\n')
  ui.text = 'one\ntwo\nthree\nmine\n'
  s.edited()
  s.saveNow()
  const req = ui.posted.at(-1).req
  s.receive({ t: 'changed', req, path: 'a.txt', hash: 'h9', readOnly: false, part: 0, parts: 1, text: 'ONE\ntwo\nthree\n' })
  assert.equal(ui.text, 'ONE\ntwo\nthree\nmine\n')
  assert.deepEqual(ui.replaced, ['ONE\ntwo\nthree\nmine\n'])
  assert.deepEqual(s._state.base, { text: 'ONE\ntwo\nthree\n', hash: 'h9' })
  assert.equal(ui.last.conflict, null)
  assert.equal(ui.last.notice, "Merged Claude's changes.")
  const save = ui.posted.at(-1)
  assert.equal(save.t, 'save')
  assert.equal(save.baseHash, 'h9')
  assert.equal(save.text, 'ONE\ntwo\nthree\nmine\n')
  // The notice goes after a while; no marker was ever raised.
  timers.run(NOTICE_MS)
  assert.equal(ui.last.notice, null)
  assert.deepEqual(ui.markers, [false])
})

test('an overlapping change: conflicts inline, no save until each is resolved, then saved on theirs', () => {
  const { ui, timers, s } = loaded('a\nb\nc\nd\ne\n')
  ui.text = 'a\nB-mine\nc\nd\nE-mine\n'
  s.edited()
  s.saveNow()
  s.receive({ t: 'changed', req: ui.posted.at(-1).req, path: 'a.txt', hash: 'h9', part: 0, parts: 1, text: 'a\nB-theirs\nc\nd\nE-theirs\n' })
  // My version stays in the text; theirs rides beside each region.
  assert.equal(ui.merges.length, 1)
  assert.equal(ui.text, 'a\nB-mine\nc\nd\nE-mine\n')
  assert.deepEqual(
    ui.merges[0].conflicts.map((c) => [ui.text.slice(c.from, c.to), c.theirs]),
    [
      ['B-mine\n', 'B-theirs\n'],
      ['E-mine\n', 'E-theirs\n'],
    ]
  )
  assert.deepEqual(ui.last.conflict, { kind: 'merge', final: false, count: 2 })
  assert.deepEqual(ui.markers, [false, true])
  assert.deepEqual(s._state.base, { text: 'a\nB-theirs\nc\nd\nE-theirs\n', hash: 'h9' })
  // Nothing saves meanwhile: not Ctrl+S, not idle, not blur.
  const saves = () => ui.posted.filter((m) => m.t === 'save').length
  assert.equal(s.saveNow(), false)
  ui.text = 'a\nB-mine!\nc\nd\nE-mine\n'
  s.edited()
  timers.run()
  s.blur()
  assert.equal(saves(), 1)
  // The page resolves one (Take Claude's), then the other (Keep both).
  ui.text = 'a\nB-theirs\nc\nd\nE-mine\n'
  s.edited()
  s.conflictsLeft(1)
  assert.deepEqual(ui.last.conflict, { kind: 'merge', final: false, count: 1 })
  assert.equal(saves(), 1)
  ui.text = 'a\nB-theirs\nc\nd\nE-mine\nE-theirs\n'
  s.edited()
  s.conflictsLeft(0)
  assert.equal(ui.last.conflict, null)
  assert.deepEqual(ui.markers, [false, true, false])
  timers.run()
  const save = ui.posted.at(-1)
  assert.equal(save.t, 'save')
  assert.equal(save.baseHash, 'h9')
  assert.equal(save.text, 'a\nB-theirs\nc\nd\nE-mine\nE-theirs\n')
})

test('the same change made on both sides is no conflict; a change while conflicts are open waits for them', () => {
  const { ui, s } = loaded('a\nb\nc\n')
  // Claude made my edit too, and I made one more: merged clean, nothing asked.
  ui.text = 'a\nB\nc\nmine\n'
  s.edited()
  s.receive({ t: 'disk', path: 'a.txt', change: 'changed', hash: 'h2' })
  s.receive(head({ req: ui.posted.at(-1).req, hash: 'h2', text: 'a\nB\nc\n' }))
  assert.equal(ui.text, 'a\nB\nc\nmine\n')
  assert.equal(ui.last.conflict, null)
  assert.deepEqual(ui.merges, [])
  const save = ui.posted.at(-1)
  assert.equal(save.baseHash, 'h2')
  s.receive({ t: 'saved', req: save.req, hash: 'h3' })
  // Now an overlapping one: conflicts open. A newer disk change meanwhile is not merged on top.
  ui.text = 'a\nB\nc\nmine2\n'
  s.edited()
  s.receive({ t: 'disk', path: 'a.txt', change: 'changed', hash: 'h4' })
  s.receive(head({ req: ui.posted.at(-1).req, hash: 'h4', text: 'a\nB\nc\ntheirs\n' }))
  assert.equal(ui.merges.length, 1)
  s.receive({ t: 'disk', path: 'a.txt', change: 'changed', hash: 'h5' })
  s.receive(head({ req: ui.posted.at(-1).req, hash: 'h5', text: 'a\nB\nc\ntheirs2\n' }))
  assert.equal(ui.merges.length, 1)
  assert.equal(s._state.base.hash, 'h4')
  assert.equal(ui.last.conflict.kind, 'merge')
  // A deletion meanwhile keeps the conflicts; the deleted bar comes once they are resolved.
  s.receive({ t: 'disk', path: 'a.txt', change: 'deleted' })
  assert.equal(ui.last.conflict.kind, 'merge')
  s.conflictsLeft(0)
  assert.deepEqual(ui.last.conflict, { kind: 'deleted', final: false })
})

test('disk events: a clean tab reloads, a dirty one merges, a deletion keeps the text', () => {
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
  // Dirty: merged (one line each side: a conflict), the buffer keeps my text.
  ui.text = 'mine\n'
  s.edited()
  s.receive({ t: 'disk', path: 'a.txt', change: 'changed', hash: 'h3' })
  s.receive(head({ req: ui.posted.at(-1).req, hash: 'h3', text: 'three\n' }))
  assert.equal(ui.text, 'mine\n')
  assert.deepEqual(ui.last.conflict, { kind: 'merge', final: false, count: 1 })
  // Keep mine: the page drops the region; the save goes on theirs' hash.
  s.conflictsLeft(0)
  s.saveNow()
  assert.equal(ui.posted.at(-1).baseHash, 'h3')
  s.receive({ t: 'saved', req: ui.posted.at(-1).req, hash: 'h4' })
  // Deleted: the tab keeps the text; Save recreates (baseHash null), Close asks the host.
  s.receive({ t: 'disk', path: 'a.txt', change: 'deleted' })
  assert.deepEqual(ui.last.conflict, { kind: 'deleted', final: false })
  assert.equal(ui.last.dirty, true)
  s.closeTab()
  assert.deepEqual(ui.posted.at(-1), { t: 'close' })
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

test('real host: a write while the line was down is merged on reconnect; an overlapping one waits for the person', async () => {
  const root = project()
  const mine = files.makeFiles(root)
  const ui = fakeUi()
  let line
  ui.post = (m) => (m.t === 'conflict' ? ui.markers.push(m.on) : line.send(m))
  const timers = fakeTimers()
  const s = createSession(ui, timers)
  line = hostLine(mine, s)
  s.connect()
  await settle()
  ui.text = 'one\ntwo\nmine\n'
  s.edited()
  line.close() // no watch events: the reconnect's open must find the change
  line = hostLine(mine, s)
  fs.writeFileSync(path.join(root, 'a.txt'), 'ONE\r\ntwo\r\n')
  s.connect()
  await settle()
  // Merged clean and saved at once, line endings kept: nothing of either side lost.
  const onDisk = () => fs.readFileSync(path.join(root, 'a.txt'), 'utf8')
  assert.equal(ui.text, 'ONE\ntwo\nmine\n')
  assert.equal(onDisk(), 'ONE\r\ntwo\r\nmine\r\n')
  assert.equal(ui.last.notice, "Merged Claude's changes.")
  assert.equal(ui.last.dirty, false)

  // Claude rewrites the line I am editing: a conflict, and the disk keeps Claude's text meanwhile.
  ui.text = 'ONE\ntwo\nmine, edited\n'
  s.edited()
  fs.writeFileSync(path.join(root, 'a.txt'), 'ONE\r\ntwo\r\nclaude\r\n')
  for (let i = 0; i < 40 && !ui.last.conflict; i++) await settle()
  assert.deepEqual(ui.last.conflict, { kind: 'merge', final: false, count: 1 })
  assert.deepEqual(
    ui.merges.at(-1).conflicts.map((c) => c.theirs),
    ['claude\n']
  )
  timers.run()
  s.blur()
  await settle()
  assert.equal(onDisk(), 'ONE\r\ntwo\r\nclaude\r\n')
  // Keep both: mine then Claude's; autosave writes it on Claude's hash.
  ui.text = 'ONE\ntwo\nmine, edited\nclaude\n'
  s.edited()
  s.conflictsLeft(0)
  timers.run()
  for (let i = 0; i < 20 && onDisk() !== 'ONE\r\ntwo\r\nmine, edited\r\nclaude\r\n'; i++) await settle()
  assert.equal(onDisk(), 'ONE\r\ntwo\r\nmine, edited\r\nclaude\r\n')
  assert.equal(ui.last.conflict, null)
  assert.equal(ui.last.dirty, false)
  line.close()
  mine.watcher.close()
})

test('real host, two views: A saves, B (dirty on the old base) merges onto A and loses nothing', async () => {
  const root = project()
  fs.writeFileSync(path.join(root, 'a.txt'), 'head\none\ntwo\nthree\ntail\n')
  // One host (one `files`, one watcher) and a line per view, as main gives a tab shown in two views.
  const host = files.makeFiles(root)
  const views = ['A', 'B'].map(() => {
    const ui = fakeUi()
    const v = { ui, timers: fakeTimers() }
    ui.post = (m) => (m.t === 'conflict' ? ui.markers.push(m.on) : v.line.send(m))
    v.s = createSession(ui, v.timers)
    v.line = hostLine(host, v.s)
    v.s.connect()
    return v
  })
  await settle()
  const [a, b] = views
  const onDisk = () => fs.readFileSync(path.join(root, 'a.txt'), 'utf8')
  // Both edit different lines of the same base; A saves first.
  a.ui.text = 'head\nONE (A)\ntwo\nthree\ntail\n'
  a.s.edited()
  b.ui.text = 'head\none\ntwo\nTHREE (B)\ntail\n'
  b.s.edited()
  a.s.saveNow()
  await settle()
  assert.equal(onDisk(), 'head\nONE (A)\ntwo\nthree\ntail\n')
  // B hears the change (its own watch report), merges A's line with its own and saves on A's hash.
  const both = 'head\nONE (A)\ntwo\nTHREE (B)\ntail\n'
  for (let i = 0; i < 40 && onDisk() !== both; i++) await settle()
  assert.equal(b.ui.text, both)
  assert.equal(onDisk(), both)
  assert.equal(b.ui.last.conflict, null)
  // A, clean now, reloads B's save: both views show both edits.
  for (let i = 0; i < 40 && a.ui.text !== both; i++) await settle()
  assert.equal(a.ui.text, both)
  assert.equal(a.ui.last.dirty, false)
  assert.equal(b.ui.last.dirty, false)

  // The other way round with no disk event reaching B: B saves on a stale base and the host's
  // compare-and-swap answers `changed`, which B merges the same way.
  b.line.close()
  a.ui.text = `${both}A2\n`
  a.s.edited()
  a.s.saveNow()
  await settle()
  b.line = hostLine(host, b.s)
  b.ui.text = `B2\n${both}`
  b.s.edited()
  // A new line with no reconnect open (connected stays true): the save is the first to meet A2.
  b.s.saveNow()
  const all = `B2\n${both}A2\n`
  for (let i = 0; i < 40 && onDisk() !== all; i++) await settle()
  assert.equal(onDisk(), all)
  assert.equal(b.ui.text, all)
  for (const v of views) v.line.close()
  host.watcher.close()
})

// ---- review fixes ----

test('state re-send: the lost save landed and more was typed after it: its text is the base, the buffer stays and is saved', () => {
  const { ui, s } = loaded()
  ui.text = 'mine\n'
  s.edited()
  s.saveNow()
  s.connect() // the line goes, the save's answer never comes
  ui.text = 'mine2\n' // typed after the save
  s.edited()
  s.receive(head({ req: ui.posted.at(-1).req, hash: 'h2', text: 'mine\n' }))
  assert.equal(ui.last.conflict, null)
  assert.equal(ui.text, 'mine2\n')
  assert.deepEqual(s._state.base, { text: 'mine\n', hash: 'h2' })
  const save = ui.posted.at(-1)
  assert.equal(save.t, 'save')
  assert.equal(save.baseHash, 'h2')
  assert.equal(save.text, 'mine2\n')
})

test('a file deleted and recreated by someone else: merged on the text it had, saved over the new one once', () => {
  const { ui, s } = loaded('one\ntwo\n')
  s.receive({ t: 'disk', path: 'a.txt', change: 'deleted' })
  ui.text = 'one\ntwo\nmine\n'
  s.edited()
  s.receive({ t: 'disk', path: 'a.txt', change: 'changed', hash: 'h7' })
  s.receive(head({ req: ui.posted.at(-1).req, hash: 'h7', text: 'ONE\ntwo\n' }))
  assert.equal(ui.last.conflict, null)
  assert.equal(ui.last.exists, true)
  assert.equal(ui.text, 'ONE\ntwo\nmine\n')
  const save = ui.posted.at(-1)
  assert.equal(save.baseHash, 'h7')
  assert.equal(save.text, 'ONE\ntwo\nmine\n')
})

test('a clean tab whose re-check finds the file missing keeps its text and shows the deleted bar', () => {
  const { ui, s } = loaded()
  s.focus()
  const check = ui.posted.at(-1)
  assert.deepEqual(check, { t: 'read', path: 'a.txt', headOnly: true, req: check.req })
  s.receive({ t: 'file', req: check.req, path: 'a.txt', exists: false, part: 0, parts: 1 })
  assert.deepEqual(ui.last.conflict, { kind: 'deleted', final: false })
  assert.equal(ui.text, 'one\n')
  assert.deepEqual(ui.replaced, [])
  assert.equal(ui.last.dirty, true)
})

test('a focus re-check is head-only: the same hash costs no text, a different one reads the file', () => {
  const { ui, s } = loaded()
  s.focus()
  s.receive(head({ req: ui.posted.at(-1).req, hash: 'h1' }))
  assert.equal(ui.posted.length, 1)
  s.focus()
  s.receive(head({ req: ui.posted.at(-1).req, hash: 'h2' }))
  const full = ui.posted.at(-1)
  assert.deepEqual(full, { t: 'read', path: 'a.txt', req: full.req })
  s.receive(head({ req: full.req, hash: 'h2', text: 'two\n' }))
  assert.deepEqual(ui.replaced, ['two\n'])
  assert.equal(s._state.base.hash, 'h2')
})

test('a changed answer for a file that became binary: only Reload, which adopts the flags', () => {
  const { ui, s } = loaded()
  ui.text = 'mine\n'
  s.edited()
  s.saveNow()
  s.receive({ t: 'changed', req: ui.posted.at(-1).req, path: 'a.txt', hash: 'h9', readOnly: true, why: 'binary', part: 0, parts: 1 })
  assert.deepEqual(ui.last.conflict, { kind: 'changed', final: true })
  assert.deepEqual(ui.merges, [])
  assert.equal(s.saveNow(), false)
  s.takeTheirs()
  assert.equal(ui.last.noText, true)
  assert.equal(ui.last.readOnly, true)
  assert.equal(ui.last.conflict, null)
})

test('the same hash but now read-only: the flags move, the buffer stays', () => {
  const { ui, s } = loaded()
  s.focus()
  s.receive(head({ req: ui.posted.at(-1).req, hash: 'h1', readOnly: true, why: 'permission' }))
  assert.equal(ui.last.readOnly, true)
  assert.equal(ui.last.conflict, null)
})

test('an error answer to a save: not saving, still dirty, the next edit re-arms the idle timer', () => {
  const { ui, timers, s } = loaded()
  ui.text = 'mine\n'
  s.edited()
  s.saveNow()
  s.receive({ t: 'error', req: ui.posted.at(-1).req, message: 'disk full' })
  assert.equal(ui.last.status, 'unsaved')
  assert.equal(ui.last.error, 'disk full')
  assert.equal(ui.last.dirty, true)
  timers.run(0)
  ui.text = 'mine!\n'
  s.edited()
  assert.ok(timers.delays().includes(3000))
})

test('a changed answer with written: the write lost from disk is merged into the buffer and saved back', () => {
  const { ui, s } = loaded('one\ntwo\nthree\n')
  ui.text = 'one\ntwo\nthree\nmine\n'
  s.edited()
  s.saveNow()
  // Our save is on disk (h5); a write into the old file landed in between: `text` is that write.
  s.receive({ t: 'changed', req: ui.posted.at(-1).req, path: 'a.txt', hash: 'h5', written: true, readOnly: false, part: 0, parts: 1, text: 'ONE\ntwo\nthree\n' })
  assert.deepEqual(s._state.base, { text: 'one\ntwo\nthree\nmine\n', hash: 'h5' })
  assert.equal(ui.last.conflict, null)
  assert.equal(ui.text, 'ONE\ntwo\nthree\nmine\n')
  const save = ui.posted.at(-1)
  assert.equal(save.t, 'save')
  assert.equal(save.baseHash, 'h5')
  assert.equal(save.text, 'ONE\ntwo\nthree\nmine\n')
  // One that was not text: nothing to merge, said in the bar; our text stays the base.
  const other = loaded('one\n')
  other.ui.text = 'mine\n'
  other.s.edited()
  other.s.saveNow()
  other.s.receive({ t: 'changed', req: other.ui.posted.at(-1).req, path: 'a.txt', hash: 'h6', written: true, part: 0, parts: 1 })
  assert.equal(other.ui.last.error, LOST_NOT_TEXT)
  assert.deepEqual(other.s._state.base, { text: 'mine\n', hash: 'h6' })
  assert.equal(other.ui.last.dirty, false)
})

test('conflict marker: told on every new line, on each change, and only then', () => {
  const { ui, s } = loaded('a\n')
  assert.deepEqual(ui.markers, [false])
  ui.text = 'mine\n'
  s.edited()
  s.receive({ t: 'disk', path: 'a.txt', change: 'changed', hash: 'h2' })
  s.receive(head({ req: ui.posted.at(-1).req, hash: 'h2', text: 'theirs\n' }))
  assert.deepEqual(ui.markers, [false, true])
  s.edited()
  assert.deepEqual(ui.markers, [false, true])
  // A host restart: the new line hears the marker again.
  s.connect()
  assert.deepEqual(ui.markers, [false, true, true])
  s.conflictsLeft(0)
  assert.deepEqual(ui.markers, [false, true, true, false])
})

test('Save in the deleted bar creates the file (baseHash null) and `saved` clears it', () => {
  const { ui, s } = loaded()
  s.receive({ t: 'disk', path: 'a.txt', change: 'deleted' })
  s.saveNow()
  const save = ui.posted.at(-1)
  assert.equal(save.baseHash, null)
  s.receive({ t: 'saved', req: save.req, hash: 'h8' })
  assert.equal(ui.last.conflict, null)
  assert.equal(ui.last.dirty, false)
  assert.equal(ui.last.exists, true)
})

test('real host: Ctrl+S while an autosave is in flight saves again after it, nothing lost', async () => {
  const root = project()
  const mine = files.makeFiles(root)
  const ui = fakeUi()
  let line
  ui.post = (m) => line.send(m)
  const timers = fakeTimers()
  const s = createSession(ui, timers)
  line = hostLine(mine, s)
  s.connect()
  await settle()
  ui.text = 'a\n'
  s.edited()
  timers.run()
  ui.text = 'ab\n'
  s.edited()
  assert.equal(s.saveNow(), false)
  const onDisk = () => fs.readFileSync(path.join(root, 'a.txt'), 'utf8').replace(/\r/g, '')
  for (let i = 0; i < 20 && onDisk() !== 'ab\n'; i++) await settle()
  assert.equal(onDisk(), 'ab\n')
  assert.equal(ui.last.conflict, null)
  assert.equal(ui.last.dirty, false)
  line.close()
  mine.watcher.close()
})
