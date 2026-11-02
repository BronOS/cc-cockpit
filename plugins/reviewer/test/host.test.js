'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const host = require('../dist/host.js')

// A project folder with one changed file, and a fake ctx around it.
function setup({ editorAvailable }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'revhost-')))
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  fs.writeFileSync(path.join(root, 'a.js'), 'one\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  fs.writeFileSync(path.join(root, 'a.js'), 'two\n')
  const provided = {}
  const handles = []
  const execs = []
  const ctx = {
    projectDir: root,
    exec: async (argv) => {
      execs.push(argv)
      try {
        return { code: 0, stdout: execFileSync(argv[0], argv.slice(1), { cwd: root, stdio: 'pipe' }).toString(), stderr: '' }
      } catch (e) {
        return { code: e.status ?? 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }
      }
    },
    services: { use: () => ({ open: async () => ({}) }), provide: (n, impl) => (provided[n] = impl), available: (n) => n === 'editor' && editorAvailable },
    sessions: { list: async () => [] },
    storage: { get: async () => null, set: async () => {}, delete: async () => {} },
    appStorage: { get: async () => null, set: async () => {} },
    files: { onOpen: () => () => {} },
    cli: { register() {} },
    overlay: {
      start: () => {
        const h = { posts: [], focused: 0, post: (m) => h.posts.push(m), focus: () => h.focused++, onMessage() {}, close() {}, result: new Promise(() => {}) }
        handles.push(h)
        return h
      },
    },
    log: { info() {}, warn() {}, error() {} },
    notify() {},
  }
  return { ctx, provided, handles, execs }
}

test('no pwd: the folder is ctx.projectDir; Edit follows services.available', async () => {
  for (const editorAvailable of [true, false]) {
    const f = setup({ editorAvailable })
    host.activate(f.ctx)
    await f.provided.reviewer.open('a.js')
    assert.equal(f.handles[0].posts[0].canEdit, editorAvailable)
    assert.ok(!f.execs.some((a) => a[0] === 'pwd'))
    host.deactivate()
  }
})

test('a second open of the same file focuses the first overlay', async () => {
  const f = setup({ editorAvailable: true })
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  await f.provided.reviewer.open('a.js')
  assert.equal(f.handles.length, 1)
  assert.equal(f.handles[0].focused, 1)
  host.deactivate()
})

test('two concurrent opens of the same file still make one overlay', async () => {
  // Both calls pass the first open.has check while the other is awaiting (git, storage, tabs).
  const f = setup({ editorAvailable: true })
  host.activate(f.ctx)
  await Promise.all([f.provided.reviewer.open('a.js'), f.provided.reviewer.open('a.js')])
  assert.equal(f.handles.length, 1)
  assert.equal(f.handles[0].focused, 1)
  host.deactivate()
})

test('a file too large for one init message is refused before an overlay starts, and stays openable', async () => {
  // 300 KiB of quotes is under MAX_SIDE_BYTES per side, but JSON doubles every quote: both sides
  // together pass the overlay message limit. Posting it after start left a blank overlay cached.
  const f = setup({ editorAvailable: true })
  const quotes = '"'.repeat(300 * 1024)
  const git = (...a) => execFileSync('git', a, { cwd: f.ctx.projectDir, stdio: 'pipe' })
  fs.writeFileSync(path.join(f.ctx.projectDir, 'big.txt'), quotes)
  git('add', 'big.txt')
  git('commit', '-qm', 'big')
  fs.writeFileSync(path.join(f.ctx.projectDir, 'big.txt'), quotes + 'x')
  host.activate(f.ctx)
  for (let i = 0; i < 2; i++) {
    await assert.rejects(f.provided.reviewer.open('big.txt'), /too large to review/)
  }
  assert.equal(f.handles.length, 0)
  host.deactivate()
})

test('a refused overlay fails the open, so a click falls back and the service and ccc review report it', async () => {
  // start() returns a handle even when main refuses the overlay (3 open, 10 a minute); the refusal
  // only rejects `result`. That rejection was swallowed by `done`, so a click counted as handled.
  const f = setup({ editorAvailable: false })
  let onOpen
  let review
  f.ctx.files.onOpen = (fn) => ((onOpen = fn), () => {})
  f.ctx.cli.register = (n, fn) => (review = fn)
  f.ctx.overlay.start = () => {
    const h = { posts: [], post: (m) => h.posts.push(m), focus() {}, onMessage() {}, close() {}, result: Promise.reject(new Error('overlay: at most 3 open')) }
    f.handles.push(h)
    return h
  }
  host.activate(f.ctx)
  await assert.rejects(onOpen({ path: 'a.js' }), /review overlay did not open: overlay: at most 3 open/)
  await assert.rejects(f.provided.reviewer.open('a.js'), /reviewer: the review overlay did not open/)
  const r = await review(['a.js'], { cwd: f.ctx.projectDir })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /did not open/)
  // Not cached as open: each try started its own overlay instead of focusing a dead one.
  assert.equal(f.handles.length, 3)
  host.deactivate()
})

test('concurrent opens share a refusal: the second does not report success for a refused overlay', async () => {
  const f = setup({ editorAvailable: false })
  f.ctx.overlay.start = () => {
    const h = { posts: [], post: (m) => h.posts.push(m), focus() {}, onMessage() {}, close() {}, result: Promise.reject(new Error('overlay: at most 3 open')) }
    f.handles.push(h)
    return h
  }
  host.activate(f.ctx)
  const results = await Promise.allSettled([f.provided.reviewer.open('a.js'), f.provided.reviewer.open('a.js')])
  assert.equal(f.handles.length, 1)
  for (const r of results) {
    assert.equal(r.status, 'rejected')
    assert.match(r.reason.message, /review overlay did not open: overlay: at most 3 open/)
  }
  host.deactivate()
})

test('a review cut for length is sent but its full draft is kept, and the person is told', async () => {
  const f = setup({ editorAvailable: false })
  const store = new Map()
  const notices = []
  const sent = []
  f.ctx.storage = { get: async (k) => store.get(k) ?? null, set: async (k, v) => store.set(k, v), delete: async (k) => store.delete(k) }
  f.ctx.notify = (m) => notices.push(m)
  f.ctx.sessions.open = async (o) => sent.push(o.prompt)
  let finish
  f.ctx.overlay.start = () => {
    const h = { posts: [], post: (m) => h.posts.push(m), focus() {}, onMessage() {}, close() {}, result: new Promise((r) => (finish = r)) }
    f.handles.push(h)
    return h
  }
  let onOpen
  f.ctx.files.onOpen = (fn) => ((onOpen = fn), () => {})
  host.activate(f.ctx)
  const notes = Array.from({ length: 10 }, (_, i) => ({ id: String(i), from: 1, to: 1, text: 'x'.repeat(4000), quote: '' }))
  const clicked = onOpen({ path: 'a.js' })
  await new Promise((r) => setTimeout(r, 600)) // past the open wait
  finish({ kind: 'value', value: { action: 'new', draft: { global: '', notes } } })
  await clicked
  assert.equal(sent.length, 1)
  assert.match(sent[0], /\(review cut: too long\)$/)
  const kept = [...store.values()][0]
  assert.equal(kept.notes.length, 10)
  assert.equal(kept.notes[9].text.length, 4000)
  assert.ok(notices.some((m) => /too long and was cut/.test(m)))

  // A review that fits still clears the draft once sent.
  const clicked2 = onOpen({ path: 'a.js' })
  await new Promise((r) => setTimeout(r, 600))
  finish({ kind: 'value', value: { action: 'new', draft: { global: 'short', notes: [] } } })
  await clicked2
  assert.equal(store.size, 0)
  host.deactivate()
})

test('a page message sent right after init is handled, not lost to the open wait', async () => {
  // The listener was registered after the 500 ms "did it open" wait, so a draft or an Edit click
  // the page sent as soon as it loaded was dropped.
  const f = setup({ editorAvailable: true })
  const saved = []
  f.ctx.storage.set = async (k, v) => saved.push([k, v])
  f.ctx.overlay.start = () => {
    const h = {
      listeners: [],
      posts: [],
      onMessage: (l) => (h.listeners.push(l), () => {}),
      post: (m) => {
        h.posts.push(m)
        // The page answers init at once with a draft.
        if (m.type === 'init') for (const l of h.listeners) l({ type: 'draft', draft: { global: 'early note', notes: [] } })
      },
      focus() {},
      close() {},
      result: new Promise(() => {}),
    }
    f.handles.push(h)
    return h
  }
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  assert.equal(f.handles[0].listeners.length, 1)
  assert.equal(saved.length, 1)
  assert.equal(saved[0][1].global, 'early note')
  host.deactivate()
})

test('a long path is cut from the left to fit the overlay title limit', async () => {
  // main refuses a title over 200 chars, so a path over 192 chars could never be reviewed.
  assert.equal(host.overlayTitle('Review: ', 'a.js'), 'Review: a.js')
  const long = 'd/'.repeat(150) + 'file.js'
  const t = host.overlayTitle('Review: ', long)
  assert.equal(t.length, 200)
  assert.ok(t.startsWith('Review: …') && t.endsWith('/file.js'))
})

// A handle whose page we drive: `say` posts as the page, `end` settles result.
function pageHandle(f) {
  let end
  const h = {
    listeners: [],
    posts: [],
    closed: 0,
    onMessage: (l) => (h.listeners.push(l), () => {}),
    post: (m) => h.posts.push(m),
    say: (m) => h.listeners.forEach((l) => l(m)),
    focus() {},
    close: () => h.closed++,
    result: new Promise((r) => (end = r)),
    end: (r) => end(r),
  }
  f.handles.push(h)
  return h
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const SAVE_WAIT = 400 // past the host's draft write coalescing

function storeFake(f, { failSet } = {}) {
  const store = new Map()
  const notices = []
  f.ctx.storage = {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => {
      if (failSet && failSet(v)) throw new RangeError('storage: the store is full')
      store.set(k, structuredClone(v))
    },
    delete: async (k) => store.delete(k),
  }
  f.ctx.notify = (m) => notices.push(m)
  return { store, notices }
}

const note = (text, i = 0) => ({ id: `n${i}`, side: 'new', from: 1, to: 1, quote: 'two', text })

test('a failed draft write is shown in the page, cleared by a later write, and reported at close', async () => {
  const f = setup({ editorAvailable: true })
  let full = true
  const { store, notices } = storeFake(f, { failSet: () => full })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  const h = f.handles[0]
  h.say({ type: 'draft', draft: { global: 'first', notes: [] } })
  await wait(SAVE_WAIT)
  const err = h.posts.find((m) => m.type === 'draft-error')
  assert.ok(err, 'the page hears about the failed write')
  assert.match(err.message, /Draft not saved: storage: the store is full/)

  full = false
  h.say({ type: 'draft', draft: { global: 'second', notes: [] } })
  await wait(SAVE_WAIT)
  assert.ok(h.posts.some((m) => m.type === 'draft-saved'))
  assert.equal(store.get('draft:a.js').global, 'second')

  // Fails again, then Esc: the person is told, and the stored draft is the last good one.
  full = true
  h.say({ type: 'draft', draft: { global: 'third', notes: [] } })
  h.end({ kind: 'dismissed' })
  await wait(50)
  assert.equal(store.get('draft:a.js').global, 'second')
  assert.ok(notices.some((m) => /review draft of a\.js was not saved: storage: the store is full/.test(m)))
  host.deactivate()
})

test('Esc right after a change still stores it: the coalesced write is flushed at close', async () => {
  const f = setup({ editorAvailable: false })
  const { store, notices } = storeFake(f)
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  const h = f.handles[0]
  h.say({ type: 'draft', draft: { global: 'typed just now', notes: [] } })
  h.end({ kind: 'dismissed' })
  await wait(50)
  assert.equal(store.get('draft:a.js').global, 'typed just now')
  assert.equal(notices.length, 0)
  host.deactivate()
})

test('Edit does not close the review while the draft is unsaved', async () => {
  const f = setup({ editorAvailable: true })
  storeFake(f, { failSet: () => true })
  const opened = []
  f.ctx.services.use = () => ({ open: async (p) => opened.push(p) })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  const h = f.handles[0]
  h.say({ type: 'draft', draft: { global: 'unsaved', notes: [] } })
  h.say({ type: 'edit', line: 1 })
  await wait(50)
  assert.equal(opened.length, 0)
  assert.equal(h.closed, 0)
  assert.ok(h.posts.some((m) => m.type === 'error' && /draft is not saved/.test(m.message)))
  host.deactivate()
})

test('a draft cleanDraft would cut is neither stored nor sent; the last good draft stays', async () => {
  const f = setup({ editorAvailable: false })
  const { store, notices } = storeFake(f)
  const sent = []
  f.ctx.sessions.open = async (o) => sent.push(o.prompt)
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  const h = f.handles[0]
  h.say({ type: 'draft', draft: { global: '', notes: [note('kept')] } })
  await wait(SAVE_WAIT)
  // 201 notes: cleanDraft keeps 200, and a send would then delete the draft with one note unsent.
  const tooMany = { global: '', notes: Array.from({ length: 201 }, (_, i) => note(`n${i}`, i)) }
  h.say({ type: 'draft', draft: tooMany })
  await wait(SAVE_WAIT)
  assert.deepEqual(store.get('draft:a.js').notes.map((n) => n.text), ['kept'])
  assert.ok(h.posts.some((m) => m.type === 'draft-error' && /more than 200 notes/.test(m.message)))
  h.end({ kind: 'value', value: { action: 'new', draft: tooMany } })
  await wait(50)
  assert.equal(sent.length, 0)
  assert.ok(store.has('draft:a.js'))
  assert.ok(notices.some((m) => /not sent: there are more than 200 notes/.test(m)))
  host.deactivate()
})

test('a send that fails with the store failing too says the draft was not saved', async () => {
  const f = setup({ editorAvailable: false })
  const { notices } = storeFake(f, { failSet: () => true })
  f.ctx.sessions.open = async () => {
    throw new Error('sessions: too many tabs')
  }
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  f.handles[0].end({ kind: 'value', value: { action: 'new', draft: { global: 'g', notes: [] } } })
  await wait(50)
  assert.equal(notices.length, 1)
  assert.match(notices[0], /not sent: sessions: too many tabs\. The draft could not be saved: storage: the store is full/)
  assert.doesNotMatch(notices[0], /draft is kept/)
  host.deactivate()
})

test('a queued review keeps its draft until the tab takes it, and says so when the tab ends first', async () => {
  for (const outcome of ['delivered', 'ended']) {
    const f = setup({ editorAvailable: false })
    const { store, notices } = storeFake(f)
    let tab = { tabId: 't1', status: 'working', lastPrompt: 'earlier work' }
    const changes = []
    let sentText
    f.ctx.sessions.list = async () => [tab]
    f.ctx.sessions.onChange = (l) => (changes.push(l), () => changes.splice(changes.indexOf(l), 1))
    f.ctx.sessions.send = async (id, text) => ((sentText = text), { queued: true, itemId: 'q1' })
    f.ctx.overlay.start = () => pageHandle(f)
    host.activate(f.ctx)
    await f.provided.reviewer.open('a.js')
    f.handles[0].end({ kind: 'value', value: { action: 'discuss', tabId: 't1', draft: { global: 'please check', notes: [] } } })
    await wait(50)
    assert.equal(store.get('draft:a.js').global, 'please check', 'kept while queued')
    assert.ok(notices.some((m) => /queued.*kept until Claude gets it/.test(m)))
    assert.equal(changes.length, 1)

    // Another prompt first (not ours): still queued.
    tab = { ...tab, lastPrompt: 'something else' }
    changes[0]([tab])
    await wait(20)
    assert.ok(store.has('draft:a.js'))

    if (outcome === 'delivered') {
      tab = { ...tab, lastPrompt: sentText.replace(/\n/g, '\r\n').slice(0, 2048) }
      changes[0]([tab])
      await wait(20)
      assert.equal(store.has('draft:a.js'), false)
    } else {
      changes[0]([{ ...tab, status: 'ended' }])
      await wait(20)
      assert.ok(store.has('draft:a.js'))
      assert.ok(notices.some((m) => /may not have reached Claude: its tab ended/.test(m)))
    }
    assert.equal(changes.length, 0, 'the watch stops')
    host.deactivate()
  }
})

test('a review delivered at once clears its draft', async () => {
  const f = setup({ editorAvailable: false })
  const { store } = storeFake(f)
  store.set('draft:a.js', { global: 'old', notes: [] })
  f.ctx.sessions.list = async () => [{ tabId: 't1', status: 'waiting', lastPrompt: '' }]
  f.ctx.sessions.send = async () => ({ delivered: true })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  f.handles[0].end({ kind: 'value', value: { action: 'discuss', tabId: 't1', draft: { global: 'go', notes: [] } } })
  await wait(50)
  assert.equal(store.has('draft:a.js'), false)
  host.deactivate()
})
