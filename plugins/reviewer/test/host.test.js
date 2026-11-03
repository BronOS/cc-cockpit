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

test('defaultTab: the caller\'s live tab, else the tab the window shows, else none', () => {
  const tabs = [
    { tabId: 't1', active: false },
    { tabId: 't2', active: true },
  ]
  assert.equal(host.defaultTab(tabs, 't1'), 't1')
  // A gone, foreign or mistyped id is only a wish: the shown tab wins over it.
  assert.equal(host.defaultTab(tabs, 'gone'), 't2')
  assert.equal(host.defaultTab(tabs, 5), 't2')
  assert.equal(host.defaultTab(tabs, undefined), 't2')
  assert.equal(host.defaultTab([{ tabId: 't1', active: false }], undefined), null)
  assert.equal(host.defaultTab([], 't1'), null)
})

test('a file review starts its picker on the shown tab when the caller names none', async () => {
  const f = setup({ editorAvailable: true })
  f.ctx.sessions.list = async () => [
    { tabId: 't1', status: 'waiting', lastPrompt: 'a' },
    { tabId: 't2', status: 'working', lastPrompt: 'b', active: true },
    { tabId: 't3', status: 'ended', lastPrompt: 'c' },
  ]
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  const init = f.handles[0].posts[0]
  assert.equal(init.tabId, 't2')
  assert.deepEqual(init.tabs.map((t) => [t.tabId, t.active]), [['t1', false], ['t2', true]])
  host.deactivate()
})

test('annotate: a text overlay with no file and no Edit, one per key, its own draft namespace', async () => {
  const f = setup({ editorAvailable: true })
  const { store } = storeFake(f)
  f.ctx.sessions.list = async () => [
    { tabId: 't1', status: 'waiting', lastPrompt: 'a' },
    { tabId: 't2', status: 'waiting', lastPrompt: 'b', active: true },
  ]
  const starts = []
  f.ctx.overlay.start = (spec) => (starts.push(spec), pageHandle(f))
  host.activate(f.ctx)
  const opts = { title: 'PROJ-1 Fix login', text: 'line one\nline two', url: 'https://x.atlassian.net/browse/PROJ-1', key: 'jira:PROJ-1', tabId: 't1' }
  assert.deepEqual(await f.provided.reviewer.annotate(opts), { opened: true })
  const h = f.handles[0]
  const init = h.posts[0]
  assert.equal(init.sides.mode, 'text')
  assert.equal(init.sides.path, 'PROJ-1 Fix login')
  assert.equal(init.sides.new, 'line one\nline two')
  assert.equal(init.sides.url, opts.url)
  assert.equal(init.canEdit, false)
  assert.equal(init.canOpenUrl, false) // this fake ctx has no openExternal: no button
  assert.equal(init.tabId, 't1')
  assert.equal(starts[0].title, 'Notes: PROJ-1 Fix login')
  // No git ran: it is not a file.
  assert.ok(!f.execs.some((a) => a[0] === 'git'))
  // The same key focuses the open overlay; another key opens its own.
  await f.provided.reviewer.annotate({ ...opts, text: 'changed' })
  assert.equal(f.handles.length, 1)
  await f.provided.reviewer.annotate({ ...opts, key: 'jira:PROJ-2', tabId: undefined })
  assert.equal(f.handles.length, 2)
  assert.equal(f.handles[1].posts[0].tabId, 't2') // no tab named: the shown one
  // Edit is ignored for a text; the draft goes under annotate:<key>.
  h.say({ type: 'edit', line: 1 })
  h.say({ type: 'draft', draft: { global: 'g', notes: [note('n')] } })
  await wait(SAVE_WAIT)
  assert.deepEqual([...store.keys()], ['annotate:jira:PROJ-1'])
  assert.equal(h.closed, 0)
  host.deactivate()
})

test('annotate: Discuss sends "About <title> (<url>)" with notes as a file review has them, then clears the draft', async () => {
  const f = setup({ editorAvailable: false })
  const { store } = storeFake(f)
  const sent = []
  f.ctx.sessions.list = async () => [{ tabId: 't1', status: 'waiting', lastPrompt: 'a' }]
  f.ctx.sessions.send = async (tabId, text) => (sent.push([tabId, text]), { delivered: true })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.annotate({ title: 'PROJ-1 Fix login', text: 'a\nb\nc', url: 'https://x/browse/PROJ-1', key: 'jira:PROJ-1' })
  const h = f.handles[0]
  const draft = { global: 'Start here.', notes: [{ id: 'n1', side: 'new', from: 2, to: 3, quote: 'b\nc', text: 'Unclear.' }] }
  h.say({ type: 'draft', draft })
  await wait(SAVE_WAIT)
  assert.ok(store.has('annotate:jira:PROJ-1'))
  h.end({ kind: 'value', value: { action: 'discuss', tabId: 't1', draft } })
  await wait(50)
  assert.deepEqual(sent, [['t1', 'About PROJ-1 Fix login (https://x/browse/PROJ-1)\n\nStart here.\n\n1. Lines 2-3:\n   > b\n   > c\n   Unclear.']])
  assert.equal(store.size, 0)
  host.deactivate()
})

test('annotate: "Open in browser" opens the URL the caller gave, never one from the page, and shows a refusal', async () => {
  const f = setup({ editorAvailable: false })
  const opened = []
  let refuse = null
  f.ctx.openExternal = async (url) => {
    opened.push(url)
    if (refuse) throw refuse
  }
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  const url = 'https://x.atlassian.net/browse/PROJ-1'
  await f.provided.reviewer.annotate({ title: 'PROJ-1', text: 'a', url, key: 'jira:PROJ-1' })
  const h = f.handles[0]
  assert.equal(h.posts[0].canOpenUrl, true)
  // A URL in the message is ignored: the page only says "open".
  h.say({ type: 'open-url', url: 'https://evil.example/' })
  await wait(10)
  assert.deepEqual(opened, [url])
  refuse = new Error('openExternal: more than 3 links in 10 s; try again in a moment')
  h.say({ type: 'open-url' })
  await wait(10)
  assert.deepEqual(h.posts.at(-1), { type: 'error', message: 'Not opened in the browser: more than 3 links in 10 s; try again in a moment' })
  // No url: no button, and an open-url message opens nothing.
  await f.provided.reviewer.annotate({ title: 'PROJ-2', text: 'a', key: 'jira:PROJ-2' })
  const h2 = f.handles[1]
  assert.equal(h2.posts[0].canOpenUrl, false)
  h2.say({ type: 'open-url' })
  // A file review has no url either.
  await f.provided.reviewer.open('a.js')
  const h3 = f.handles[2]
  assert.equal(h3.posts[0].canOpenUrl, false)
  h3.say({ type: 'open-url' })
  await wait(10)
  assert.equal(opened.length, 2)
  host.deactivate()
})

test('annotate: bad input is refused before any overlay, with the reviewer prefix', async () => {
  const f = setup({ editorAvailable: false })
  host.activate(f.ctx)
  await assert.rejects(f.provided.reviewer.annotate({ title: '', text: 'x' }), /^Error: reviewer: title must not be empty/)
  await assert.rejects(f.provided.reviewer.annotate({ title: 't', text: 'x', url: 'javascript:alert(1)' }), /reviewer: url must be http or https/)
  await assert.rejects(f.provided.reviewer.annotate(null), /reviewer: annotate takes/)
  await assert.rejects(f.provided.reviewer.annotate({ title: 't', text: 'x', aside: 'a'.repeat(100001) }), /^Error: reviewer: aside is over 100000 characters/)
  await assert.rejects(f.provided.reviewer.annotate({ title: 't', text: 'x', aside: ['<p>'] }), /reviewer: aside must be a string/)
  assert.equal(f.handles.length, 0)
  host.deactivate()
})

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PAGE_MESSAGE_MAX = 1040384 // OverlayHandle.post's limit (`ccc guide api`)

test('annotate: a link click opens only an http(s) link of the caller\'s own html or aside, and shows a refusal', async () => {
  const f = setup({ editorAvailable: false })
  const opened = []
  let refuse = null
  f.ctx.openExternal = async (url) => {
    opened.push(url)
    if (refuse) throw refuse
  }
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  const html = [
    '<p><a title="a > b" href="https://x.atlassian.net/browse/PROJ-1">issue</a>',
    // Entity-encoded, as an HTML serializer writes a query: the page's DOM has the decoded href.
    "<A class=x HREF='https://x.example/att?id=1&amp;name=a&#x20;b&#39;s'>file</A>",
    '<a href="javascript:alert(1)">js</a> <a href="data:text/html,hi">data</a>',
    '<a href="mailto:ann@example.com">Ann</a></p>',
  ].join('')
  await f.provided.reviewer.annotate({ title: 'PROJ-1', html, aside: '<a href=https://x.example/side>side</a>', key: 'jira:PROJ-1' })
  const h = f.handles[0]
  assert.equal(h.posts[0].canOpenLinks, true)
  const errors = () => h.posts.filter((m) => m.type === 'error').map((m) => m.message)
  // What the page's DOM has: safeHref's normalized href.
  h.say({ type: 'open-link', href: 'https://x.atlassian.net/browse/PROJ-1' })
  h.say({ type: 'open-link', href: new URL("https://x.example/att?id=1&name=a b's").href })
  h.say({ type: 'open-link', href: 'https://x.example/side' })
  await wait(10)
  assert.deepEqual(opened, ['https://x.atlassian.net/browse/PROJ-1', "https://x.example/att?id=1&name=a%20b%27s", 'https://x.example/side'])
  assert.deepEqual(errors(), [])
  // Not in what the caller sent, not http(s), or not a string: refused with a reason, nothing opened.
  for (const href of ['https://evil.example/', 'javascript:alert(1)', 'data:text/html,hi', 'https://x.example/att?id=1&amp;name=a', 42, undefined]) {
    h.say({ type: 'open-link', href })
  }
  h.say({ type: 'open-link', href: 'mailto:ann@example.com' })
  await wait(10)
  assert.equal(opened.length, 3)
  assert.deepEqual(errors(), [...new Array(6).fill('Not opened: not a link of this document'), 'mailto links are not opened: ann@example.com'])
  // The app's refusal (3 links per 10 s) is shown as the "Open in browser" button shows it.
  refuse = new Error('openExternal: more than 3 links in 10 s; try again in a moment')
  h.say({ type: 'open-link', href: 'https://x.atlassian.net/browse/PROJ-1' })
  await wait(10)
  assert.equal(errors().at(-1), 'Not opened in the browser: more than 3 links in 10 s; try again in a moment')
  // A file review has no links of a caller: an open-link there opens nothing and says nothing.
  await f.provided.reviewer.open('a.js')
  const h2 = f.handles[1]
  assert.equal(h2.posts[0].canOpenLinks, false)
  h2.say({ type: 'open-link', href: 'https://x.atlassian.net/browse/PROJ-1' })
  await wait(10)
  assert.equal(opened.length, 4)
  assert.equal(h2.posts.filter((m) => m.type === 'error').length, 0)
  host.deactivate()
})

test('annotate: no ctx.openExternal, no link opening', async () => {
  const f = setup({ editorAvailable: false })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.annotate({ title: 'P', html: '<a href="https://x.example/">x</a>', key: 'k' })
  const h = f.handles[0]
  assert.equal(h.posts[0].canOpenLinks, false)
  h.say({ type: 'open-link', href: 'https://x.example/' })
  await wait(10)
  assert.equal(h.posts.filter((m) => m.type === 'error').length, 0)
  host.deactivate()
})

test('annotate html: the init names the parts and assets; the page asks, then gets parts, each asset, assets-done', async () => {
  const f = setup({ editorAvailable: true })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  // Past one page message: escaped quotes double the JSON, so this needs several parts.
  const html = '<p class="new">' + '"'.repeat(900000) + '</p>'
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(999000)
  const assets = [
    { id: 'shot-1', name: 'shot.png', mime: 'image/png', dataUrl: PNG },
    { id: 'photo', mime: 'image/jpeg', dataUrl: big },
  ]
  assert.deepEqual(await f.provided.reviewer.annotate({ title: 'PROJ-1', html, assets, key: 'jira:PROJ-1' }), { opened: true })
  const h = f.handles[0]
  assert.equal(h.posts.length, 1) // only the init until the page has loaded and asks
  const init = h.posts[0]
  assert.equal(init.sides.mode, 'html')
  assert.equal(init.canEdit, false)
  assert.ok(init.sides.htmlParts >= 2)
  assert.deepEqual(init.sides.assets, [{ id: 'shot-1', name: 'shot.png', mime: 'image/png' }, { id: 'photo', name: null, mime: 'image/jpeg' }])
  assert.ok(JSON.stringify(init).length < 10000) // no HTML and no image data in it
  h.say({ type: 'content' })
  const rest = h.posts.slice(1)
  const parts = rest.filter((m) => m.type === 'html')
  assert.equal(parts.length, init.sides.htmlParts)
  assert.deepEqual(parts.map((m) => m.index), [...parts.keys()])
  assert.equal(parts.map((m) => m.part).join(''), html)
  assert.deepEqual(rest.slice(parts.length), [{ type: 'asset', id: 'shot-1', dataUrl: PNG }, { type: 'asset', id: 'photo', dataUrl: big }, { type: 'assets-done' }])
  for (const m of rest) assert.ok(JSON.stringify(m).length <= PAGE_MESSAGE_MAX)
  // Once: a second ask sends nothing (the content was let go).
  h.say({ type: 'content' })
  assert.equal(h.posts.length, 1 + rest.length)
  host.deactivate()
})

test('annotate aside: not in the init; the first message after the page asks, with text or html', async () => {
  const f = setup({ editorAvailable: false })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  const aside = '<dl class="facts"><dt>Status</dt><dd>' + '"'.repeat(99000) + '</dd></dl>'
  await f.provided.reviewer.annotate({ title: 'T', text: 'x'.repeat(400 * 1024), aside })
  const h = f.handles[0]
  assert.equal(h.posts.length, 1)
  assert.equal(h.posts[0].sides.aside, true)
  assert.ok(!JSON.stringify(h.posts[0]).includes('facts'))
  h.say({ type: 'content' })
  assert.deepEqual(h.posts.slice(1), [{ type: 'aside', html: aside }])
  await f.provided.reviewer.annotate({ title: 'H', html: '<p>x</p>', aside: '<p>side</p>' })
  const h2 = f.handles[1]
  h2.say({ type: 'content' })
  assert.deepEqual(h2.posts.slice(1).map((m) => m.type), ['aside', 'html', 'assets-done'])
  // No aside: the init says nothing of one.
  await f.provided.reviewer.annotate({ title: 'N', text: 'x' })
  assert.equal(f.handles[2].posts[0].sides.aside, undefined)
  host.deactivate()
})

test('annotate html: a text annotation never answers a content request; bad assets are refused before any overlay', async () => {
  const f = setup({ editorAvailable: false })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.annotate({ title: 'T', text: 'plain' })
  f.handles[0].say({ type: 'content' })
  assert.equal(f.handles[0].posts.length, 1)
  await assert.rejects(
    f.provided.reviewer.annotate({ title: 'U', html: '<p>x</p>', assets: [{ id: 'a', mime: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }] }),
    /^Error: reviewer: assets\[0\]\.mime must be one of/,
  )
  await assert.rejects(f.provided.reviewer.annotate({ title: 'U', html: '<p>x</p>', text: 'x' }), /reviewer: pass text or html, not both/)
  assert.equal(f.handles.length, 1)
  host.deactivate()
})

test('annotate html: Discuss sends "About <title> (<url>)" with "On «quote»: note" notes', async () => {
  const f = setup({ editorAvailable: false })
  const { store } = storeFake(f)
  const sent = []
  f.ctx.sessions.list = async () => [{ tabId: 't1', status: 'waiting', lastPrompt: 'a' }]
  f.ctx.sessions.send = async (tabId, text) => (sent.push([tabId, text]), { delivered: true })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.annotate({ title: 'PROJ-1 Fix login', html: '<p>Redirect to /home after login.</p>', url: 'https://x/browse/PROJ-1', key: 'jira:PROJ-1' })
  const h = f.handles[0]
  const draft = {
    global: 'Start here.',
    notes: [{ id: 'n1', quote: 'Redirect to /home', anchor: { prefix: '', suffix: ' after login.', occurrence: 0, length: 17, at: 0 }, text: 'Which home?' }],
  }
  h.say({ type: 'draft', draft })
  await wait(SAVE_WAIT)
  assert.deepEqual(store.get('annotate:jira:PROJ-1').notes[0].anchor, draft.notes[0].anchor)
  h.end({ kind: 'value', value: { action: 'discuss', tabId: 't1', draft } })
  await wait(50)
  assert.deepEqual(sent, [['t1', 'About PROJ-1 Fix login (https://x/browse/PROJ-1)\n\nStart here.\n\n1. On «Redirect to /home»: Which home?']])
  assert.equal(store.size, 0)
  host.deactivate()
})

test('features(): the optional annotate features, so a caller can tell this reviewer from an older one', async () => {
  const f = setup({ editorAvailable: false })
  host.activate(f.ctx)
  assert.deepEqual(await f.provided.reviewer.features(), ['companion'])
  assert.deepEqual(host.FEATURES, ['companion'])
  // A copy: a caller changing the answer changes nothing here.
  ;(await f.provided.reviewer.features()).push('x')
  assert.deepEqual(await f.provided.reviewer.features(), ['companion'])
  host.deactivate()
})

test('annotate companion: the init names it, its parts and facts follow the main ones, assets are one set', async () => {
  const f = setup({ editorAvailable: false })
  f.ctx.openExternal = async () => {}
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  const big = '<p>' + '"'.repeat(900000) + '</p>'
  const PNG2 = PNG.replace('AAAA', 'AAAB')
  await f.provided.reviewer.annotate({
    title: 'Re: login',
    html: '<h1>Re: login</h1>',
    aside: '<dl class="facts"><dt>From</dt><dd>Ann</dd></dl>',
    assets: [{ id: 'm1', mime: 'image/png', dataUrl: PNG }],
    url: 'https://mail.example/1',
    key: 'mail:1',
    label: 'Mail',
    urlLabel: 'Example Mail',
    companion: { title: 'PROJ-1: Fix login', label: 'Jira · PROJ-1', urlLabel: 'Jira', html: big, facts: '<dl class="facts"><dt>Status</dt><dd>Open</dd></dl>', url: 'https://x.example/browse/PROJ-1', assets: [{ id: 'j1', name: 'j.png', mime: 'image/png', dataUrl: PNG2 }] },
  })
  const h = f.handles[0]
  const init = h.posts[0]
  assert.deepEqual(init.sides.companion, { title: 'PROJ-1: Fix login', url: 'https://x.example/browse/PROJ-1', htmlParts: init.sides.companion.htmlParts, facts: true, label: 'Jira · PROJ-1', urlLabel: 'Jira' })
  assert.equal(init.sides.label, 'Mail')
  assert.equal(init.sides.urlLabel, 'Example Mail')
  assert.equal(init.sides.start, 'top')
  assert.ok(init.sides.companion.htmlParts >= 2)
  assert.deepEqual(init.sides.assets, [{ id: 'm1', name: null, mime: 'image/png' }, { id: 'j1', name: 'j.png', mime: 'image/png' }])
  assert.equal(init.split, 0.5) // nothing stored yet
  assert.equal(init.canOpenCompanionUrl, true)
  assert.equal(init.sides.aside, true)
  assert.ok(JSON.stringify(init).length < 10000)
  h.say({ type: 'content' })
  const rest = h.posts.slice(1)
  assert.deepEqual(rest.slice(0, 3), [
    { type: 'aside', html: '<dl class="facts"><dt>From</dt><dd>Ann</dd></dl>' },
    { type: 'aside', doc: 'companion', html: '<dl class="facts"><dt>Status</dt><dd>Open</dd></dl>' },
    { type: 'html', index: 0, part: '<h1>Re: login</h1>' },
  ])
  const cParts = rest.filter((m) => m.type === 'html' && m.doc === 'companion')
  assert.equal(cParts.length, init.sides.companion.htmlParts)
  assert.deepEqual(cParts.map((m) => m.index), [...cParts.keys()])
  assert.equal(cParts.map((m) => m.part).join(''), big)
  assert.deepEqual(rest.slice(3 + cParts.length), [{ type: 'asset', id: 'm1', dataUrl: PNG }, { type: 'asset', id: 'j1', dataUrl: PNG2 }, { type: 'assets-done' }])
  for (const m of rest) assert.ok(JSON.stringify(m).length <= PAGE_MESSAGE_MAX)
  // Without a companion the init says nothing of one (today's layout, no divider).
  await f.provided.reviewer.annotate({ title: 'Plain', html: '<p>x</p>' })
  const plain = f.handles[1].posts[0]
  assert.equal(plain.sides.companion, undefined)
  assert.equal(plain.split, undefined)
  assert.equal(plain.canOpenCompanionUrl, undefined)
  assert.equal(plain.sides.label, undefined) // no header bars without a companion
  host.deactivate()
})

test('annotate companion: its icon opens its own url, its links join the allow-set, the divider is remembered app-wide', async () => {
  const f = setup({ editorAvailable: false })
  const opened = []
  f.ctx.openExternal = async (url) => opened.push(url)
  const app = new Map([['companionSplit', 0.7]])
  f.ctx.appStorage = { get: async (k) => app.get(k) ?? null, set: async (k, v) => app.set(k, v) }
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.annotate({
    title: 'Re: login',
    html: '<a href="https://mail.example/a">a</a>',
    url: 'https://mail.example/1',
    key: 'mail:1',
    companion: { title: 'PROJ-1', html: '<a href="https://x.example/browse/PROJ-2">PROJ-2</a>', facts: '<a href=https://x.example/people/ann>Ann</a>', url: 'https://x.example/browse/PROJ-1' },
  })
  const h = f.handles[0]
  assert.equal(h.posts[0].split, 0.7)
  const errors = () => h.posts.filter((m) => m.type === 'error').map((m) => m.message)
  h.say({ type: 'open-url' })
  h.say({ type: 'open-url', doc: 'companion', url: 'https://evil.example/' })
  for (const href of ['https://mail.example/a', 'https://x.example/browse/PROJ-2', 'https://x.example/people/ann', 'https://evil.example/']) h.say({ type: 'open-link', href })
  await wait(10)
  assert.deepEqual(opened, ['https://mail.example/1', 'https://x.example/browse/PROJ-1', 'https://mail.example/a', 'https://x.example/browse/PROJ-2', 'https://x.example/people/ann'])
  assert.deepEqual(errors(), ['Not opened: not a link of this document'])
  // The divider: a value within the bounds is stored; anything else is not.
  for (const split of [0.35, 0.1, 0.9, '0.5', NaN, null]) h.say({ type: 'split', split })
  await wait(10)
  assert.equal(app.get('companionSplit'), 0.35)
  // A stored value out of bounds (an older copy, a hand edit) opens at half and half.
  app.set('companionSplit', 3)
  await f.provided.reviewer.annotate({ title: 'B', html: '<p>b</p>', companion: { title: 'C', html: '<p>c</p>' } })
  const h2 = f.handles[1]
  assert.equal(h2.posts[0].split, 0.5)
  assert.equal(h2.posts[0].canOpenCompanionUrl, false) // no url: no icon, and an open-url opens nothing
  assert.equal(h2.posts[0].sides.companion.facts, false)
  h2.say({ type: 'open-url', doc: 'companion' })
  // No companion: a split message is not stored.
  await f.provided.reviewer.annotate({ title: 'D', html: '<p>d</p>' })
  f.handles[2].say({ type: 'split', split: 0.4 })
  await wait(10)
  assert.equal(opened.length, 5)
  assert.equal(app.get('companionSplit'), 3)
  host.deactivate()
})

test('annotate companion: Discuss names the companion and says which notes are in it', async () => {
  const f = setup({ editorAvailable: false })
  const { store } = storeFake(f)
  const sent = []
  f.ctx.sessions.list = async () => [{ tabId: 't1', status: 'waiting', lastPrompt: 'a' }]
  f.ctx.sessions.send = async (tabId, text) => (sent.push([tabId, text]), { delivered: true })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.annotate({ title: 'Re: login', html: '<p>Is it fixed?</p>', key: 'mail:1', companion: { title: 'PROJ-1: Fix login', html: '<p>Redirect to /home.</p>', url: 'https://x.example/browse/PROJ-1' } })
  const h = f.handles[0]
  const draft = {
    global: '',
    notes: [
      { id: 'n2', quote: 'Redirect', anchor: { prefix: '', suffix: ' to /home.', occurrence: 0, length: 8, at: 0 }, text: 'Which one?', doc: 'companion' },
      { id: 'n1', quote: 'fixed', anchor: { prefix: 'Is it ', suffix: '?', occurrence: 0, length: 5, at: 6 }, text: 'Not yet.' },
    ],
  }
  h.say({ type: 'draft', draft })
  await wait(SAVE_WAIT)
  assert.equal(store.get('annotate:mail:1').notes[0].doc, 'companion')
  h.end({ kind: 'value', value: { action: 'discuss', tabId: 't1', draft } })
  await wait(50)
  assert.deepEqual(sent, [['t1', 'About Re: login, with PROJ-1: Fix login (https://x.example/browse/PROJ-1) beside it\n\n1. On «fixed»: Not yet.\n\n2. In PROJ-1: Fix login, on «Redirect»: Which one?']])
  host.deactivate()
})

test('annotate companion: bad input is refused before any overlay', async () => {
  const f = setup({ editorAvailable: false })
  host.activate(f.ctx)
  await assert.rejects(f.provided.reviewer.annotate({ title: 't', text: 'x', companion: { title: 'C', html: '' } }), /^Error: reviewer: companion goes with html, not text/)
  await assert.rejects(f.provided.reviewer.annotate({ title: 't', html: 'x', companion: { title: 'C', html: '', url: 'ftp://x/' } }), /^Error: reviewer: companion\.url must be http or https/)
  assert.equal(f.handles.length, 0)
  host.deactivate()
})
