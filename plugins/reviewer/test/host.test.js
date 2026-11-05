'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const host = require('../dist/host.js')
const review = require('../dist/lib/review')

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
        const h = { posts: [], focused: 0, post: (m) => h.posts.push(m), focus: () => h.focused++, onMessage() {}, onDiscuss() {}, close() {}, result: new Promise(() => {}) }
        handles.push(h)
        return h
      },
    },
    log: { info() {}, warn() {}, error() {} },
    notify() {},
  }
  return { ctx, provided, handles, execs }
}

test('no pwd: the folder is ctx.projectDir; a file review is the `file` type with no page buttons of its own', async () => {
  const f = setup({ editorAvailable: true })
  const starts = []
  const start = f.ctx.overlay.start
  f.ctx.overlay.start = (spec) => (starts.push(spec), start(spec))
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  // The editor's "Edit" comes by this type (ctx.overlay.buttons), not from the page.
  assert.deepEqual(starts[0].type, { name: 'file', data: { path: 'a.js' } })
  assert.equal(starts[0].discuss, undefined) // no tab named: the app preselects the active one
  const init = f.handles[0].posts[0]
  for (const k of ['canEdit', 'tabs', 'tabId']) assert.equal(k in init, false, k)
  assert.ok(!f.execs.some((a) => a[0] === 'pwd'))
  host.deactivate()
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
    const h = { posts: [], post: (m) => h.posts.push(m), focus() {}, onMessage() {}, onDiscuss() {}, close() {}, result: Promise.reject(new Error('overlay: at most 3 open')) }
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
    const h = { posts: [], post: (m) => h.posts.push(m), focus() {}, onMessage() {}, onDiscuss() {}, close() {}, result: Promise.reject(new Error('overlay: at most 3 open')) }
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
  const { store, notices } = storeFake(f)
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  const h = f.handles[0]
  const notes = Array.from({ length: 10 }, (_, i) => ({ id: String(i), from: 1, to: 1, text: 'x'.repeat(4000), quote: '' }))
  h.say({ type: 'draft', draft: { global: '', notes } })
  const { text } = await h.discussFn()
  // Under what the app's Discuss leaves for the context, so the app never cuts it again.
  assert.ok(text.length <= review.MAX_CONTEXT)
  assert.match(text, /\(review cut: too long\)$/)
  h.end({ kind: 'discussed', tabId: 'new', queued: false })
  await wait(50)
  const kept = store.get('draft:a.js')
  assert.equal(kept.notes.length, 10)
  assert.equal(kept.notes[9].text.length, 4000)
  assert.ok(notices.some((m) => /too long and was cut at 15000 characters\. The full draft is kept/.test(m)))

  // A review that fits clears the draft once sent.
  await f.provided.reviewer.open('a.js')
  const h2 = f.handles[1]
  h2.say({ type: 'draft', draft: { global: 'short', notes: [] } })
  await h2.discussFn()
  h2.end({ kind: 'discussed', tabId: 'new', queued: false })
  await wait(50)
  assert.equal(store.size, 0)
  host.deactivate()
})

test('a page message sent right after init is handled, not lost to the open wait', async () => {
  // The listener was registered after the 500 ms "did it open" wait, so a draft the page sent as
  // soon as it loaded was dropped.
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
      onDiscuss() {},
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

// A handle whose page we drive: `say` posts as the page, `end` settles result. The page answers a
// draft request (Discuss) with the draft it last said, or `draft-unsaved` once `pageDraft` is null;
// with `answers` false it stays silent. `discussFn` is the host's onDiscuss handler.
function pageHandle(f) {
  let end
  const h = {
    listeners: [],
    posts: [],
    closed: 0,
    answers: true,
    pageDraft: { global: '', notes: [] },
    discussFn: null,
    onMessage: (l) => (h.listeners.push(l), () => {}),
    onDiscuss: (fn) => ((h.discussFn = fn), () => {}),
    post: (m) => {
      h.posts.push(m)
      if (m.type === 'draft-request' && h.answers) {
        setTimeout(() => h.say(h.pageDraft ? { type: 'draft', draft: h.pageDraft } : { type: 'draft-unsaved' }), 0)
      }
    },
    say: (m) => {
      if (m.type === 'draft') h.pageDraft = m.draft
      h.listeners.forEach((l) => l(m))
    },
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

test('Discuss sends nothing while the page cannot post its draft (too large to store)', async () => {
  const f = setup({ editorAvailable: false })
  const { store } = storeFake(f)
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  const h = f.handles[0]
  h.say({ type: 'draft', draft: { global: 'older', notes: [] } })
  await wait(SAVE_WAIT)
  h.pageDraft = null // the page's own size check refuses the newest draft
  await assert.rejects(h.discussFn(), /the draft is too large to send/)
  assert.ok(h.posts.some((m) => m.type === 'draft-request'))
  assert.equal(store.get('draft:a.js').global, 'older')
  host.deactivate()
})

test('a draft cleanDraft would cut is neither stored nor sent; the last good draft stays', async () => {
  const f = setup({ editorAvailable: false })
  const { store, notices } = storeFake(f)
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
  // Discuss refuses it (the popover shows why) and nothing is sent.
  await assert.rejects(h.discussFn(), /not sent: there are more than 200 notes/)
  assert.ok(store.has('draft:a.js'))
  assert.equal(notices.length, 0)
  host.deactivate()
})

test('a cut review whose draft cannot be stored says so, never "the draft is kept"', async () => {
  const f = setup({ editorAvailable: false })
  const { notices } = storeFake(f, { failSet: () => true })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  const h = f.handles[0]
  h.say({ type: 'draft', draft: { global: '', notes: Array.from({ length: 10 }, (_, i) => note('x'.repeat(4000), i)) } })
  await h.discussFn()
  h.end({ kind: 'discussed', tabId: 't1', queued: false })
  await wait(50)
  const n = notices.find((m) => /was too long/.test(m))
  assert.match(n, /The draft could not be saved: storage: the store is full/)
  assert.doesNotMatch(n, /draft is kept/)
  host.deactivate()
})

test('a page that does not answer the draft request: Discuss uses the host\'s newest draft', async () => {
  const f = setup({ editorAvailable: false })
  storeFake(f)
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  const h = f.handles[0]
  h.say({ type: 'draft', draft: { global: 'last posted', notes: [] } })
  h.answers = false
  const { text } = await h.discussFn()
  assert.match(text, /\n\nlast posted$/)
  host.deactivate()
})

test('a discussed result with no context asked keeps the draft; a dismissal keeps it too', async () => {
  const f = setup({ editorAvailable: false })
  const { store } = storeFake(f)
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  for (const result of [{ kind: 'discussed', tabId: 't1', queued: false }, { kind: 'dismissed' }]) {
    await f.provided.reviewer.open('a.js')
    const h = f.handles[f.handles.length - 1]
    h.say({ type: 'draft', draft: { global: 'mine', notes: [] } })
    h.end(result)
    await wait(50)
    assert.equal(store.get('draft:a.js').global, 'mine')
  }
  host.deactivate()
})

test('a queued review keeps its draft until the tab takes it, and says so when the tab ends first', async () => {
  for (const outcome of ['delivered', 'ended']) {
    const f = setup({ editorAvailable: false })
    const { store, notices } = storeFake(f)
    let tab = { tabId: 't1', status: 'working', lastPrompt: 'earlier work' }
    const changes = []
    f.ctx.sessions.list = async () => [tab]
    f.ctx.sessions.onChange = (l) => (changes.push(l), () => changes.splice(changes.indexOf(l), 1))
    f.ctx.overlay.start = () => pageHandle(f)
    host.activate(f.ctx)
    await f.provided.reviewer.open('a.js')
    const h = f.handles[0]
    h.say({ type: 'draft', draft: { global: 'please check', notes: [] } })
    const { text } = await h.discussFn()
    // The app's own message: its About and type lines, the review, the person's note.
    const sentText = `About: Review: a.js\nFile: a.js\n\n${text}\n\nA note.`
    h.end({ kind: 'discussed', tabId: 't1', queued: true })
    await wait(50)
    assert.equal(store.get('draft:a.js').global, 'please check', 'kept while queued')
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
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  f.handles[0].say({ type: 'draft', draft: { global: 'go', notes: [] } })
  await f.handles[0].discussFn()
  f.handles[0].end({ kind: 'discussed', tabId: 't1', queued: false })
  await wait(50)
  assert.equal(store.has('draft:a.js'), false)
  host.deactivate()
})

test('overlayExtras: the type, and the caller\'s tab as Discuss\'s preselection when main would take it', () => {
  const t = { name: 'file', data: { path: 'a.js' } }
  assert.deepEqual(host.overlayExtras(t, 't1'), { type: t, discuss: { tabId: 't1' } })
  assert.deepEqual(host.overlayExtras(null, undefined), {})
  // main refuses an empty or a long tab id, or a non-string: dropped here, not a refused overlay.
  for (const bad of ['', 'x'.repeat(101), 5]) assert.deepEqual(host.overlayExtras(null, bad), {})
})

test('a click\'s tab goes to the overlay as Discuss\'s preselected tab', async () => {
  const f = setup({ editorAvailable: true })
  const starts = []
  let onOpen
  f.ctx.files.onOpen = (fn) => ((onOpen = fn), () => {})
  f.ctx.overlay.start = (spec) => (starts.push(spec), pageHandle(f))
  host.activate(f.ctx)
  onOpen({ path: 'a.js', tabId: 't2' })
  await wait(50)
  assert.deepEqual(starts[0].discuss, { tabId: 't2' })
  assert.deepEqual(starts[0].type, { name: 'file', data: { path: 'a.js' } })
  host.deactivate()
})

test('annotate: a text overlay with no file and no Edit, one per key, its own draft namespace', async () => {
  const f = setup({ editorAvailable: true })
  const { store } = storeFake(f)
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
  assert.equal(init.canOpenUrl, false) // this fake ctx has no openExternal: no button
  assert.deepEqual(starts[0].discuss, { tabId: 't1' })
  assert.equal(starts[0].type, undefined) // no type given: none (Discuss still shows, by onDiscuss)
  assert.equal(typeof h.discussFn, 'function')
  assert.equal(starts[0].title, 'Notes: PROJ-1 Fix login')
  // No git ran: it is not a file.
  assert.ok(!f.execs.some((a) => a[0] === 'git'))
  // The same key focuses the open overlay; another key opens its own.
  await f.provided.reviewer.annotate({ ...opts, text: 'changed' })
  assert.equal(f.handles.length, 1)
  await f.provided.reviewer.annotate({ ...opts, key: 'jira:PROJ-2', tabId: undefined })
  assert.equal(f.handles.length, 2)
  assert.equal(starts[1].discuss, undefined) // no tab named: the app preselects the active one
  // The draft goes under annotate:<key>.
  h.say({ type: 'draft', draft: { global: 'g', notes: [note('n')] } })
  await wait(SAVE_WAIT)
  assert.deepEqual([...store.keys()], ['annotate:jira:PROJ-1'])
  assert.equal(h.closed, 0)
  host.deactivate()
})

test('annotate: Discuss sends "About <title> (<url>)" with notes as a file review has them, then clears the draft', async () => {
  const f = setup({ editorAvailable: false })
  const { store } = storeFake(f)
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.annotate({ title: 'PROJ-1 Fix login', text: 'a\nb\nc', url: 'https://x/browse/PROJ-1', key: 'jira:PROJ-1' })
  const h = f.handles[0]
  const draft = { global: 'Start here.', notes: [{ id: 'n1', side: 'new', from: 2, to: 3, quote: 'b\nc', text: 'Unclear.' }] }
  h.say({ type: 'draft', draft })
  await wait(SAVE_WAIT)
  assert.ok(store.has('annotate:jira:PROJ-1'))
  assert.deepEqual(await h.discussFn(), { text: 'About PROJ-1 Fix login (https://x/browse/PROJ-1)\n\nStart here.\n\n1. Lines 2-3:\n   > b\n   > c\n   Unclear.' })
  h.end({ kind: 'discussed', tabId: 't1', queued: false })
  await wait(50)
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
  assert.deepEqual(await h.discussFn(), { text: 'About PROJ-1 Fix login (https://x/browse/PROJ-1)\n\nStart here.\n\n1. On «Redirect to /home»: Which home?' })
  h.end({ kind: 'discussed', tabId: 't1', queued: false })
  await wait(50)
  assert.equal(store.size, 0)
  host.deactivate()
})

test('features(): the optional annotate features, so a caller can tell this reviewer from an older one', async () => {
  const f = setup({ editorAvailable: false })
  host.activate(f.ctx)
  assert.deepEqual(await f.provided.reviewer.features(), ['companion', 'prepare', 'type'])
  assert.deepEqual(host.FEATURES, ['companion', 'prepare', 'type'])
  // A copy: a caller changing the answer changes nothing here.
  ;(await f.provided.reviewer.features()).push('x')
  assert.deepEqual(await f.provided.reviewer.features(), ['companion', 'prepare', 'type'])
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
  assert.deepEqual(await h.discussFn(), { text: 'About Re: login, with PROJ-1: Fix login (https://x.example/browse/PROJ-1) beside it\n\n1. On «fixed»: Not yet.\n\n2. In PROJ-1: Fix login, on «Redirect»: Which one?' })
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

// Real-work feedback 9: Discuss and New session refused without a note or a comment.
test('annotate: Discuss with no note and no comment sends the text and asks Claude to discuss it', async () => {
  const f = setup({ editorAvailable: false })
  storeFake(f)
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.annotate({
    title: 'Lunch on Friday',
    html: '<h1>Lunch on Friday</h1><p>Can we move it to <b>1 pm</b>?<br>Thanks</p><script>x()</script>',
    aside: '<dl class="facts"><dt>From</dt><dd>Sam &lt;sam@example.com&gt;</dd></dl>',
    url: 'https://mail.example.com/t/1',
    key: 'gmail:1',
  })
  f.handles[0].say({ type: 'draft', draft: { global: '  ', notes: [] } })
  const { text } = await f.handles[0].discussFn()
  assert.equal(
    text,
    'About Lunch on Friday (https://mail.example.com/t/1)\n\nDiscuss this with me: what it is about, what matters in it, and what I should do about it, if anything. Its text follows.\n\nFrom: Sam <sam@example.com>\n\nLunch on Friday\n\nCan we move it to 1 pm?\nThanks',
  )
  host.deactivate()
})

test('an empty draft on a long text: the discuss request with the text cut to what Discuss leaves', async () => {
  const f = setup({ editorAvailable: false })
  storeFake(f)
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.annotate({ title: 'Long', text: 'word '.repeat(10000), key: 'k:1' })
  const { text } = await f.handles[0].discussFn()
  assert.ok(text.startsWith('About Long\n\nDiscuss this with me'))
  assert.ok(text.endsWith('(text cut: too long)'))
  assert.ok(text.length <= review.MAX_CONTEXT)
  host.deactivate()
})

test('a file review with an empty draft asks Claude to read the file and its diff', async () => {
  const f = setup({ editorAvailable: false })
  storeFake(f)
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  const { text } = await f.handles[0].discussFn()
  assert.match(text, /^Review of a\.js \(changes since the last commit [0-9a-f]{12}\)\n\nDiscuss these changes with me: read the file and its diff/)
  host.deactivate()
})

test('annotate and prepare pass a caller\'s overlay type through; a bad one is refused before any overlay', async () => {
  const f = setup({ editorAvailable: false })
  const starts = []
  f.ctx.overlay.start = (spec) => (starts.push(spec), pageHandle(f))
  host.activate(f.ctx)
  const type = { name: 'inbox-item', data: { source: 'example.mail', id: 't-1' } }
  await f.provided.reviewer.annotate({ title: 'Lunch', text: 'x', key: 'mail:1', type })
  assert.deepEqual(starts[0].type, type)
  // prepare fixes the type (and the Discuss tab) when the overlay starts; its annotate fills it.
  await f.provided.reviewer.prepare({ key: 'mail:2', title: 'Other', type, tabId: 't1' })
  assert.deepEqual(starts[1].type, type)
  assert.deepEqual(starts[1].discuss, { tabId: 't1' })
  await f.provided.reviewer.annotate({ title: 'Other', text: 'y', key: 'mail:2', type: { name: 'other', data: null } })
  assert.equal(starts.length, 2)
  await assert.rejects(f.provided.reviewer.annotate({ title: 't', text: 'x', type: { name: 'Bad Name', data: {} } }), /^Error: reviewer: type\.name must be/)
  await assert.rejects(f.provided.reviewer.annotate({ title: 't', text: 'x', type: { name: 'big', data: 'x'.repeat(5000) } }), /^Error: reviewer: type\.data is over 4096/)
  await assert.rejects(f.provided.reviewer.prepare({ key: 'k', title: 't', type: 'file' }), /^Error: reviewer: type must be \{ name, data \}/)
  assert.equal(starts.length, 2)
  host.deactivate()
})

// Real-work feedback 8: an Inbox item opened after its source fetched it, with nothing on screen meanwhile.
test('prepare: the overlay opens at once; the annotate with the same key fills it, no second overlay', async () => {
  const f = setup({ editorAvailable: false })
  const starts = []
  f.ctx.overlay.start = (spec) => (starts.push(spec), pageHandle(f))
  host.activate(f.ctx)
  assert.deepEqual(await f.provided.reviewer.prepare({ key: 'gmail:1', title: 'Lunch' }), { opened: true })
  assert.equal(f.handles.length, 1)
  assert.equal(starts[0].title, 'Notes: Lunch')
  assert.equal(starts[0].file, 'overlay/review.html')
  assert.deepEqual(f.handles[0].posts, []) // the page shows its loader until the init
  // A second prepare of the same key brings it to the front.
  await f.provided.reviewer.prepare({ key: 'gmail:1', title: 'Lunch' })
  assert.equal(f.handles.length, 1)
  assert.deepEqual(await f.provided.reviewer.annotate({ title: 'Lunch (2)', text: 'body', key: 'gmail:1' }), { opened: true })
  assert.equal(f.handles.length, 1)
  assert.equal(f.handles[0].posts[0].type, 'init')
  assert.equal(f.handles[0].posts[0].sides.new, 'body')
  // Filled: cancel closes nothing, and the same key now focuses the open review.
  assert.deepEqual(await f.provided.reviewer.cancel({ key: 'gmail:1' }), { closed: false })
  assert.equal(f.handles[0].closed, 0)
  // Another key prepared and never filled: cancel closes it.
  await f.provided.reviewer.prepare({ key: 'gmail:2', title: 'Other' })
  assert.deepEqual(await f.provided.reviewer.cancel({ key: 'gmail:2' }), { closed: true })
  assert.equal(f.handles[1].closed, 1)
  // After a cancel the annotate opens its own overlay.
  await f.provided.reviewer.annotate({ title: 'Other', text: 'x', key: 'gmail:2' })
  assert.equal(f.handles.length, 3)
  host.deactivate()
})

test('prepare: a loading overlay the person closed is not reopened by its annotate; bad input is refused', async () => {
  const f = setup({ editorAvailable: false })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.prepare({ key: 'jira:PROJ-1', title: 'PROJ-1' })
  f.handles[0].end({ kind: 'dismissed' })
  await wait(10)
  assert.deepEqual(await f.provided.reviewer.annotate({ title: 'PROJ-1', text: 'x', key: 'jira:PROJ-1' }), { opened: false })
  assert.equal(f.handles.length, 1)
  // Only that one annotate: the next open shows it.
  assert.deepEqual(await f.provided.reviewer.annotate({ title: 'PROJ-1', text: 'x', key: 'jira:PROJ-1' }), { opened: true })
  assert.equal(f.handles.length, 2)
  await assert.rejects(f.provided.reviewer.prepare({ title: 'no key' }), /^Error: reviewer: key must be a string/)
  await assert.rejects(f.provided.reviewer.prepare({ key: 'k', title: '' }), /^Error: reviewer: title must not be empty/)
  await assert.rejects(f.provided.reviewer.cancel('k'), /^Error: reviewer: cancel takes \{ key \}/)
  assert.equal(f.handles.length, 2)
  host.deactivate()
})
