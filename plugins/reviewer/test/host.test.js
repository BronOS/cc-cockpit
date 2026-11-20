'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const host = require('../dist/host.js')
const review = require('../dist/lib/review')

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

// A project folder with one changed file, and a fake ctx around it.
function setup({ editorAvailable }) {
  const root = fs.realpathSync(tempDir('revhost-'))
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
      start: () => fakeHandle({ handles }, { result: new Promise(() => {}) }),
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
    return fakeHandle(f, { result: Promise.reject(new Error('overlay: at most 3 open')), owner: false })
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
    return fakeHandle(f, { result: Promise.reject(new Error('overlay: at most 3 open')), owner: false })
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
    const h = fakeHandle(f, { result: new Promise(() => {}) })
    const post = h.post
    h.post = (m, o) => {
      post(m, o)
      // The page answers init at once with a draft.
      if (m.type === 'init') h.sayAs(OWNER, { type: 'draft', draft: { global: 'early note', notes: [] } })
    }
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

// The owner's desktop copy, as main announces it once the page is up (`from` of onConnect and onMessage).
const OWNER = Object.freeze({ view: 'desktop', access: 'owner', copy: 'c-owner' })

/**
 * An overlay handle of a perView plugin as the app's host gives it. Copies connect (`connect(from)` runs the
 * onConnect listeners) and go (`disconnect(copy)`), each with its own inbox (`inboxOf(copy)`); main's join
 * rule is kept: a post with `{ copy }` reaches that live copy only and joins it to broadcasts, a post without
 * reaches only the joined copies, so a host that broadcast to a copy it never addressed would be caught.
 * `owner: true` (the default) connects the owner's desktop copy right after the host listens (a microtask,
 * as main's connect is an event after start), and `posts` is that copy's inbox. `sayAs(from, m)` posts as
 * a copy's page; `sources` records addSources calls, `hides` the copies hidden.
 */
function fakeHandle(f, { result, owner = true } = {}) {
  let end
  const h = {
    inbox: new Map(),
    joined: new Set(),
    live: new Map(),
    listeners: [],
    connectListeners: [],
    disconnectListeners: [],
    sources: [],
    hides: [],
    closed: 0,
    focused: 0,
    discussFn: null,
    result: result || new Promise((r) => (end = r)),
    end: (r) => end(r),
    inboxOf: (copy) => {
      if (!h.inbox.has(copy)) h.inbox.set(copy, [])
      return h.inbox.get(copy)
    },
    events: [],
    post: (m, o) => {
      h.events.push(['post', o && o.copy, m.type])
      if (o && o.copy !== undefined) {
        if (!h.live.has(o.copy)) return // a gone copy: dropped
        h.joined.add(o.copy)
        h.inboxOf(o.copy).push(structuredClone(m))
        return
      }
      for (const c of h.joined) h.inboxOf(c).push(structuredClone(m))
    },
    onMessage: (l) => (h.listeners.push(l), () => {}),
    onConnect: (l) => (h.connectListeners.push(l), () => {}),
    onDisconnect: (l) => (h.disconnectListeners.push(l), () => {}),
    onDiscuss: (fn) => ((h.discussFn = fn), () => {}),
    addSources: (ids) => (h.sources.push([...ids]), h.events.push(['sources', [...ids]])),
    hide: (o) => h.hides.push(o.copy),
    focus: () => h.focused++,
    close: () => h.closed++,
    connect: (from) => {
      h.live.set(from.copy, from)
      const inbox = h.inboxOf(from.copy)
      h.connectListeners.forEach((l) => l({ ...from }))
      return inbox
    },
    disconnect: (copy) => {
      const from = h.live.get(copy)
      h.live.delete(copy)
      h.joined.delete(copy)
      h.disconnectListeners.forEach((l) => l({ ...from }))
    },
    sayAs: (from, m) => h.listeners.forEach((l) => l(m, { ...from })),
  }
  h.posts = h.inboxOf(OWNER.copy)
  if (owner) queueMicrotask(() => h.connect(OWNER))
  f.handles.push(h)
  return h
}

// A handle whose page we drive: `say` posts as the owner's page, `end` settles result. The page answers a
// draft request (Discuss) with the draft it last said, or `draft-unsaved` once `pageDraft` is null;
// with `answers` false it stays silent. `discussFn` is the host's onDiscuss handler.
function pageHandle(f, options) {
  const h = fakeHandle(f, options)
  h.answers = true
  h.pageDraft = { global: '', notes: [] }
  const post = h.post
  h.post = (m, o) => {
    post(m, o)
    if (m.type === 'draft-request' && h.answers && (!o || o.copy === OWNER.copy)) {
      setTimeout(() => h.say(h.pageDraft ? { type: 'draft', draft: h.pageDraft } : { type: 'draft-unsaved' }), 0)
    }
  }
  h.say = (m) => {
    if (m.type === 'draft') h.pageDraft = m.draft
    h.sayAs(OWNER, m)
  }
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

test('Discuss is the primary button once there is a note, plain again when the last goes', async () => {
  const f = setup({ editorAvailable: true })
  storeFake(f)
  f.ctx.overlay.start = () => {
    const h = pageHandle(f)
    h.primary = []
    h.setDiscussPrimary = (on) => h.primary.push(on)
    return h
  }
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  const h = f.handles[0]
  assert.deepEqual(h.primary, [false]) // no draft: plain from the start
  h.say({ type: 'draft', draft: { global: 'just a comment', notes: [] } })
  h.say({ type: 'draft', draft: { global: '', notes: [note('one')] } })
  h.say({ type: 'draft', draft: { global: '', notes: [note('one'), note('two', 1)] } })
  h.say({ type: 'draft', draft: { global: '', notes: [] } })
  assert.deepEqual(h.primary, [false, true, false]) // told on a change only
  h.end({ kind: 'dismissed' })
  await wait(50)
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
  const all = ['companion', 'prepare', 'type', 'mail', 'actions', 'update', 'original', 'fail', 'notes', 'removeNotes']
  assert.deepEqual(await f.provided.reviewer.features(), all)
  assert.deepEqual(host.FEATURES, all)
  // A copy: a caller changing the answer changes nothing here.
  ;(await f.provided.reviewer.features()).push('x')
  assert.deepEqual(await f.provided.reviewer.features(), all)
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
  assert.match(text, /^Review: changes since the last commit [0-9a-f]{12}\n\nDiscuss these changes with me: read the file and its diff/)
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

test('prepare: a refused loading overlay rejects, so a source never counts it as shown', async () => {
  // start() returns a handle even when main refuses the overlay (3 open, 10 a minute); prepare
  // answered { opened: true } at once, and the source's act open then reported success.
  const f = setup({ editorAvailable: false })
  f.ctx.overlay.start = () => {
    return fakeHandle(f, { result: Promise.reject(new Error('overlay: at most 3 open')), owner: false })
  }
  host.activate(f.ctx)
  await assert.rejects(f.provided.reviewer.prepare({ key: 'gmail:9', title: 'Lunch' }), /^Error: reviewer: the loading overlay did not open: overlay: at most 3 open/)
  // Nothing is left prepared: the annotate starts its own overlay (and reports that one's refusal).
  assert.deepEqual(await f.provided.reviewer.cancel({ key: 'gmail:9' }), { closed: false })
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

// The service's caller and emit, as the app's host gives them: `caller` is the plugin of the call running now.
function withServices(f, caller) {
  const emits = []
  f.ctx.services.caller = () => caller.id
  f.ctx.services.emit = (name, event, data) => emits.push({ name, event, data: structuredClone(data) })
  return emits
}

// A source cancelled its loader when the fetch failed: a network outage made the overlay flash open
// and shut with no reason on screen. fail() turns the loader into an error page instead.
test('fail: the caller\'s loader shows the error (text, one line, capped) with Close; the key is released', async () => {
  const f = setup({ editorAvailable: false })
  f.ctx.overlay.start = () => pageHandle(f)
  const caller = { id: 'bronos.chat' }
  withServices(f, caller)
  host.activate(f.ctx)
  await f.provided.reviewer.prepare({ key: 'chat:1', title: 'Ann' })
  const long = `Can't reach Google Chat: <b>fetch</b>\nfailed ${'x'.repeat(400)}`
  assert.deepEqual(await f.provided.reviewer.fail({ key: 'chat:1', message: long }), { failed: true })
  const h = f.handles[0]
  const m = h.posts[0]
  assert.equal(m.type, 'failed')
  assert.equal(m.retry, false)
  assert.ok(m.message.startsWith("Can't reach Google Chat: <b>fetch</b> failed"), 'one line, the markup as text (the page sets textContent)')
  assert.ok(m.message.length <= review.MAX_FAIL_MESSAGE)
  // Released: no longer prepared (cancel closes nothing, fail again answers false) and an annotate
  // without prepare opens its own overlay, as for a key not open.
  assert.deepEqual(await f.provided.reviewer.cancel({ key: 'chat:1' }), { closed: false })
  assert.deepEqual(await f.provided.reviewer.fail({ key: 'chat:1', message: 'again' }), { failed: false })
  assert.equal(h.closed, 0, 'the error page stays until the person closes it')
  assert.deepEqual(await f.provided.reviewer.annotate({ title: 'Ann', text: 'hi', key: 'chat:1' }), { opened: true })
  assert.equal(f.handles.length, 2)
  assert.equal(f.handles[1].posts[0].type, 'init')
  // Its Close button: the page asks, the host closes.
  h.say({ type: 'close' })
  assert.equal(h.closed, 1)
  host.deactivate()
})

test('fail: refused (as cancel answers) for a filled key, a key never prepared, another plugin\'s loader; bad input rejects', async () => {
  const f = setup({ editorAvailable: false })
  f.ctx.overlay.start = () => pageHandle(f)
  const caller = { id: 'bronos.chat' }
  withServices(f, caller)
  host.activate(f.ctx)
  await f.provided.reviewer.prepare({ key: 'chat:1', title: 'Ann' })
  await f.provided.reviewer.annotate({ title: 'Ann', text: 'hi', key: 'chat:1' })
  assert.deepEqual(await f.provided.reviewer.fail({ key: 'chat:1', message: 'x' }), { failed: false })
  assert.equal(f.handles[0].posts.filter((m) => m.type === 'failed').length, 0, 'a review is never replaced by an error')
  assert.deepEqual(await f.provided.reviewer.fail({ key: 'chat:never', message: 'x' }), { failed: false })
  await f.provided.reviewer.prepare({ key: 'gmail:1', title: 'Lunch' })
  const other = f.handles[1]
  caller.id = 'someone.else'
  assert.deepEqual(await f.provided.reviewer.fail({ key: 'gmail:1', message: 'x' }), { failed: false })
  assert.deepEqual(other.posts, [])
  // No caller known (an app without ctx.services.caller): refused too.
  caller.id = null
  assert.deepEqual(await f.provided.reviewer.fail({ key: 'gmail:1', message: 'x' }), { failed: false })
  await assert.rejects(f.provided.reviewer.fail('k'), /^Error: reviewer: fail takes \{ key, message, retry\? \}/)
  await assert.rejects(f.provided.reviewer.fail({ key: 'k', message: '  ' }), /^Error: reviewer: message must not be empty/)
  await assert.rejects(f.provided.reviewer.fail({ key: 'k', message: 'x', retry: 'yes' }), /^Error: reviewer: retry must be true or false/)
  host.deactivate()
})

test('fail with retry: Try again is the event action { key, id: retry, caller }; the next prepare reuses the page, then its annotate fills it', async () => {
  const f = setup({ editorAvailable: false })
  const starts = []
  f.ctx.overlay.start = (spec) => (starts.push(spec), pageHandle(f))
  const caller = { id: 'bronos.chat' }
  const emits = withServices(f, caller)
  host.activate(f.ctx)
  await f.provided.reviewer.prepare({ key: 'chat:1', title: 'Ann' })
  assert.deepEqual(await f.provided.reviewer.fail({ key: 'chat:1', message: "Can't reach Google Chat", retry: true }), { failed: true })
  const h = f.handles[0]
  assert.deepEqual(h.posts, [{ type: 'failed', message: "Can't reach Google Chat", retry: true }])
  h.say({ type: 'retry' })
  assert.deepEqual(emits, [{ name: 'reviewer', event: 'action', data: { key: 'chat:1', id: 'retry', caller: 'bronos.chat' } }])
  // The caller opens again: the same overlay goes back to the loader (no second one), and fails or fills.
  h.focused = 0
  h.focus = () => h.focused++
  assert.deepEqual(await f.provided.reviewer.prepare({ key: 'chat:1', title: 'Ann' }), { opened: true })
  assert.equal(starts.length, 1)
  assert.deepEqual(h.posts.at(-1), { type: 'loading' })
  assert.equal(h.focused, 1)
  // A loader again: a retry message now is no longer the error page's, and nothing is emitted.
  h.say({ type: 'retry' })
  assert.equal(emits.length, 1)
  assert.deepEqual(await f.provided.reviewer.fail({ key: 'chat:1', message: 'Still down', retry: true }), { failed: true })
  assert.deepEqual(h.posts.at(-1), { type: 'failed', message: 'Still down', retry: true })
  await f.provided.reviewer.prepare({ key: 'chat:1', title: 'Ann' })
  assert.deepEqual(await f.provided.reviewer.annotate({ title: 'Ann', text: 'hello', key: 'chat:1' }), { opened: true })
  assert.equal(starts.length, 1, 'filled in place')
  assert.equal(h.posts.at(-1).type, 'init')
  // Filled: the error page's messages mean nothing now (no close, no event).
  h.say({ type: 'close' })
  h.say({ type: 'retry' })
  assert.equal(h.closed, 0)
  assert.equal(emits.length, 1)
  host.deactivate()
})

test('fail: another plugin\'s prepare of the key does not take the error page; a closed error page is forgotten', async () => {
  const f = setup({ editorAvailable: false })
  f.ctx.overlay.start = () => pageHandle(f)
  const caller = { id: 'bronos.chat' }
  withServices(f, caller)
  host.activate(f.ctx)
  await f.provided.reviewer.prepare({ key: 'chat:1', title: 'Ann' })
  await f.provided.reviewer.fail({ key: 'chat:1', message: 'down', retry: true })
  caller.id = 'someone.else'
  await f.provided.reviewer.prepare({ key: 'chat:1', title: 'Ann' })
  assert.equal(f.handles.length, 2, 'its own overlay')
  assert.deepEqual(await f.provided.reviewer.cancel({ key: 'chat:1' }), { closed: true })
  // The person closes the error page: the caller's next prepare opens a new loader.
  caller.id = 'bronos.chat'
  f.handles[0].end({ kind: 'dismissed' })
  await wait(10)
  await f.provided.reviewer.prepare({ key: 'chat:1', title: 'Ann' })
  assert.equal(f.handles.length, 3)
  // ...and closing an error page marks nothing dismissed: the annotate fills the new loader.
  assert.deepEqual(await f.provided.reviewer.annotate({ title: 'Ann', text: 'x', key: 'chat:1' }), { opened: true })
  assert.equal(f.handles[2].posts[0].type, 'init')
  host.deactivate()
})

test("annotate kind 'mail': the init carries it for the page's mail layout; html only, one value only", async () => {
  const f = setup({ editorAvailable: false })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.annotate({ title: 'Lunch', html: '<h1>Lunch</h1><p>x</p>', kind: 'mail', key: 'gmail:1' })
  assert.equal(f.handles[0].posts[0].sides.kind, 'mail')
  await f.provided.reviewer.annotate({ title: 'Other', html: '<p>x</p>', key: 'k2' })
  assert.equal('kind' in f.handles[1].posts[0].sides, false)
  await assert.rejects(f.provided.reviewer.annotate({ title: 'T', text: 'x', kind: 'mail' }), /reviewer: kind goes with html/)
  await assert.rejects(f.provided.reviewer.annotate({ title: 'T', html: '<p>x</p>', kind: 'newsletter' }), /reviewer: kind must be 'mail'/)
  host.deactivate()
})

test('annotate actions: a click on a button of the caller emits `action` with key, id and caller; any other id is dropped', async () => {
  const f = setup({ editorAvailable: false })
  const caller = { id: 'example.mail' }
  const emits = withServices(f, caller)
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  const html = '<div data-part="images-bar">2 images <span data-action="show-images">Show images</span> <span data-action=always-sender>Always</span></div>'
  await f.provided.reviewer.annotate({ title: 'Mail', html, key: 'gmail:t1', aside: '<span data-action="from-aside">x</span>' })
  caller.id = 'example.other' // the event names who annotated, not who calls later
  const h = f.handles[0]
  for (const id of ['show-images', 'always-sender', 'from-aside', 'made-up', 42]) h.say({ type: 'action', id })
  assert.deepEqual(emits, [
    { name: 'reviewer', event: 'action', data: { key: 'gmail:t1', id: 'show-images', caller: 'example.mail' } },
    { name: 'reviewer', event: 'action', data: { key: 'gmail:t1', id: 'always-sender', caller: 'example.mail' } },
    { name: 'reviewer', event: 'action', data: { key: 'gmail:t1', id: 'from-aside', caller: 'example.mail' } },
  ])
  // A text annotation has no actions.
  await f.provided.reviewer.annotate({ title: 'T', text: '<span data-action="go">x</span>', key: 'txt' })
  f.handles[1].say({ type: 'action', id: 'go' })
  assert.equal(emits.length, 3)
  host.deactivate()
})

test('update: more images, hidden parts and a status for an open annotation of the same caller, within the asset budget', async () => {
  const f = setup({ editorAvailable: false })
  const caller = { id: 'example.mail' }
  withServices(f, caller)
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  const own = [{ id: 'cid1', mime: 'image/png', dataUrl: PNG }]
  await f.provided.reviewer.annotate({ title: 'Mail', html: '<p><img data-asset="r1" alt="Hero"></p>', assets: own, key: 'gmail:t1', kind: 'mail' })
  const h = f.handles[0]
  // Live updates go to a copy whose content went out (a copy that has not asked yet gets them after it).
  h.say({ type: 'content' })
  const before = h.posts.length
  assert.deepEqual(await f.provided.reviewer.update({ key: 'gmail:t1', assets: [{ id: 'r1', name: 'hero.png', mime: 'image/png', dataUrl: PNG }], hide: ['images-bar'], status: 'Images\nloaded' }), { updated: true })
  assert.deepEqual(h.posts.slice(before), [
    { type: 'update', assets: [{ id: 'r1', name: 'hero.png', mime: 'image/png' }], hide: ['images-bar'], status: 'Images loaded' },
    { type: 'asset', id: 'r1', dataUrl: PNG },
  ])
  // The ids are one namespace with the annotate's (and the earlier update's).
  await assert.rejects(f.provided.reviewer.update({ key: 'gmail:t1', assets: [{ id: 'cid1', mime: 'image/png', dataUrl: PNG }] }), /reviewer: update\.assets\[0\]\.id cid1 is used twice/)
  await assert.rejects(f.provided.reviewer.update({ key: 'gmail:t1', assets: [{ id: 'r1', mime: 'image/png', dataUrl: PNG }] }), /used twice/)
  // An SVG is no image here either.
  await assert.rejects(f.provided.reviewer.update({ key: 'gmail:t1', assets: [{ id: 's', mime: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }] }), /mime must be one of/)
  // 30 in all: two are used, so 28 more fit and 29 do not; a refused update spends nothing.
  const many = (n, p) => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, mime: 'image/png', dataUrl: PNG }))
  await assert.rejects(f.provided.reviewer.update({ key: 'gmail:t1', assets: many(29, 'a') }), /at most 30 assets \(with the assets the document already has\)/)
  await f.provided.reviewer.update({ key: 'gmail:t1', assets: many(28, 'b') })
  // Another plugin, an unknown key, a text annotation: the same refusal, nothing posted.
  const n = h.posts.length
  caller.id = 'example.other'
  await assert.rejects(f.provided.reviewer.update({ key: 'gmail:t1', status: 'x' }), /reviewer: no open HTML annotation with the key gmail:t1/)
  caller.id = 'example.mail'
  await assert.rejects(f.provided.reviewer.update({ key: 'gmail:none', status: 'x' }), /no open HTML annotation/)
  await f.provided.reviewer.annotate({ title: 'T', text: 'x', key: 'txt' })
  await assert.rejects(f.provided.reviewer.update({ key: 'txt', status: 'x' }), /no open HTML annotation/)
  assert.equal(h.posts.length, n)
  // Bad input.
  await assert.rejects(f.provided.reviewer.update({ key: 'gmail:t1' }), /update needs assets, hide or status/)
  await assert.rejects(f.provided.reviewer.update({ key: 'gmail:t1', hide: ['Bad Name'] }), /hide name/)
  await assert.rejects(f.provided.reviewer.update('x'), /update takes/)
  // Closed: the key is free again.
  h.end({ kind: 'dismissed' })
  await wait(10)
  await assert.rejects(f.provided.reviewer.update({ key: 'gmail:t1', status: 'x' }), /no open HTML annotation/)
  host.deactivate()
})

test('update: an app without ctx.services.caller cannot update (no caller to match)', async () => {
  const f = setup({ editorAvailable: false })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.annotate({ title: 'Mail', html: '<p>x</p>', key: 'gmail:t1' })
  await assert.rejects(f.provided.reviewer.update({ key: 'gmail:t1', status: 'x' }), /no open HTML annotation/)
  host.deactivate()
})

test('annotate originals: the init names them with the view, their parts follow the documents, before the pictures; links count', async () => {
  const f = setup({ editorAvailable: false })
  const opened = []
  f.ctx.openExternal = async (u) => opened.push(u)
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  const big = '<table><tr><td style="background:#e3fcef">' + 'x'.repeat(400000) + '</td></tr></table>'
  await f.provided.reviewer.annotate({
    title: 'Mail',
    kind: 'mail',
    html: '<div data-reader="m1"><p>Reader</p></div><div data-original="m1"></div>',
    originals: [{ id: 'm1', html: `<p>Original <a href="https://jira.example/browse/PROJ-1">PROJ-1</a></p>${big}` }],
    assets: [{ id: 'r1', mime: 'image/png', dataUrl: PNG }],
    key: 'gmail:t1',
  })
  const h = f.handles[0]
  assert.deepEqual(h.posts[0].sides.originals, [{ id: 'm1', parts: 3 }])
  assert.equal(h.posts[0].sides.view, 'original')
  h.say({ type: 'content' })
  await wait(10)
  const types = h.posts.slice(1).map((m) => (m.type === 'original' ? `original:${m.id}:${m.index}` : m.type))
  assert.deepEqual(types, ['html', 'original:m1:0', 'original:m1:1', 'original:m1:2', 'asset', 'assets-done'])
  const parts = h.posts.filter((m) => m.type === 'original')
  assert.ok(parts.every((m) => JSON.stringify(m).length <= 1040384))
  assert.equal(parts.map((m) => m.part).join(''), `<p>Original <a href="https://jira.example/browse/PROJ-1">PROJ-1</a></p>${big}`)
  // A link of the original is one of the caller's: the page's Links list opens it.
  h.say({ type: 'open-link', href: 'https://jira.example/browse/PROJ-1' })
  await wait(10)
  assert.deepEqual(opened, ['https://jira.example/browse/PROJ-1'])
  // view: 'reader' opens the Reader view; without originals there is no view at all.
  await f.provided.reviewer.annotate({ title: 'Mail 2', html: '<p>x</p>', originals: [{ id: 'm1', html: '<p>o</p>' }], view: 'reader', key: 'gmail:t2' })
  assert.equal(f.handles[1].posts[0].sides.view, 'reader')
  await f.provided.reviewer.annotate({ title: 'Mail 3', html: '<p>x</p>', key: 'gmail:t3' })
  assert.equal('originals' in f.handles[2].posts[0].sides, false)
  assert.equal('view' in f.handles[2].posts[0].sides, false)
  host.deactivate()
})

test('annotate originals: checked (ids, size, html only, view)', async () => {
  const { annotateInput, MAX_ORIGINALS, MAX_ANNOTATE_HTML } = require('../dist/lib/review')
  const base = { title: 'T', html: '<p>x</p>' }
  assert.equal(annotateInput({ ...base, originals: [] }).originals, null)
  assert.equal(annotateInput({ ...base, originals: [] }).view, null)
  assert.deepEqual(annotateInput({ ...base, originals: [{ id: 'm1', html: '<p>o</p>', extra: 1 }] }).originals, [{ id: 'm1', html: '<p>o</p>' }])
  assert.throws(() => annotateInput({ title: 'T', text: 'x', originals: [{ id: 'm1', html: '' }] }), /originals go with html/)
  assert.throws(() => annotateInput({ ...base, originals: 'x' }), /originals must be an array/)
  assert.throws(() => annotateInput({ ...base, originals: [{ id: 'M1', html: '' }] }), /originals\[0\]\.id is 1-40/)
  assert.throws(() => annotateInput({ ...base, originals: [{ id: 'm1', html: '' }, { id: 'm1', html: '' }] }), /used twice/)
  assert.throws(() => annotateInput({ ...base, originals: [{ id: 'm1', html: 1 }] }), /html must be a string/)
  assert.throws(() => annotateInput({ ...base, originals: [{ id: 'm1', html: 'a\0b' }] }), /NUL/)
  const many = Array.from({ length: MAX_ORIGINALS + 1 }, (_, i) => ({ id: `m${i}`, html: '' }))
  assert.throws(() => annotateInput({ ...base, originals: many }), /at most 50 originals/)
  const half = 'é'.repeat(MAX_ANNOTATE_HTML / 4 + 1) // two UTF-8 bytes each: just over half the budget
  assert.throws(() => annotateInput({ ...base, originals: [{ id: 'a', html: half }, { id: 'b', html: half }] }), /originals are larger than 2 MiB in all/)
  assert.throws(() => annotateInput({ ...base, originals: [{ id: 'm1', html: '' }], view: 'raw' }), /view must be 'original' or 'reader'/)
})

test('annotate originals: the page\'s Original | Reader switch is the event `view` with key and caller, only for a document with originals', async () => {
  const f = setup({ editorAvailable: false })
  const caller = { id: 'example.mail' }
  const emits = withServices(f, caller)
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.annotate({ title: 'Mail', html: '<div data-original="m1"></div>', originals: [{ id: 'm1', html: '<p>o</p>' }], key: 'gmail:t1' })
  const h = f.handles[0]
  for (const view of ['reader', 'original', 'raw', 42]) h.say({ type: 'view', view })
  assert.deepEqual(emits, [
    { name: 'reviewer', event: 'view', data: { key: 'gmail:t1', view: 'reader', caller: 'example.mail' } },
    { name: 'reviewer', event: 'view', data: { key: 'gmail:t1', view: 'original', caller: 'example.mail' } },
  ])
  await f.provided.reviewer.annotate({ title: 'Plain', html: '<p>x</p>', key: 'k2' })
  f.handles[1].say({ type: 'view', view: 'reader' })
  assert.equal(emits.length, 2)
  host.deactivate()
})

test('an image or a PDF opens as a preview: the init has no bytes; they come once, after the page asks', async () => {
  const f = setup({ editorAvailable: false })
  const starts = []
  f.ctx.overlay.start = (spec) => (starts.push(spec), pageHandle(f))
  host.activate(f.ctx)
  const pdf = Buffer.alloc(review.PREVIEW_CHUNK_BYTES + 10, 1)
  fs.writeFileSync(path.join(f.ctx.projectDir, 'spec.pdf'), pdf)
  await f.provided.reviewer.open('spec.pdf')
  const h = f.handles[0]
  assert.equal(h.posts.length, 1)
  const init = h.posts[0]
  assert.equal(init.sides.mode, 'preview')
  assert.deepEqual([init.sides.kind, init.sides.mime, init.sides.size], ['pdf', 'application/pdf', pdf.length])
  assert.ok(JSON.stringify(init).length < 10000)
  assert.equal(starts[0].title, 'PDF: spec.pdf')
  assert.deepEqual(starts[0].type, { name: 'file', data: { path: 'spec.pdf' } })
  h.say({ type: 'content' })
  const rest = h.posts.slice(1)
  assert.deepEqual(rest.map((m) => m.type), ['bytes-begin', 'bytes', 'bytes', 'bytes-end'])
  assert.deepEqual(Buffer.concat(rest.filter((m) => m.type === 'bytes').map((m) => Buffer.from(m.b64, 'base64'))), pdf)
  for (const m of rest) assert.ok(JSON.stringify(m).length <= PAGE_MESSAGE_MAX)
  h.say({ type: 'content' })
  assert.equal(h.posts.length, 1 + rest.length) // once
  // Another copy gets the same bytes, chunked again from the kept Buffer (not kept as base64).
  const other = h.connect(OWNER_WEB)
  h.sayAs(OWNER_WEB, { type: 'content' })
  assert.deepEqual(other.slice(1), rest)
  // No diff for a preview: git only says whether the path is in the last commit (the head line).
  for (const a of f.execs.filter((a) => a[0] === 'git')) assert.match(a.slice(1).join(' '), /^(rev-parse --is-inside-work-tree|rev-parse --verify --quiet HEAD|cat-file -e HEAD:\.\/.*)$/)
  host.deactivate()
})

test('a markdown file is a review with format markdown; an over-cap image is refused for the built-in viewer', async () => {
  const f = setup({ editorAvailable: false })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  const opened = []
  f.ctx.openExternal = async (u) => opened.push(u)
  fs.writeFileSync(path.join(f.ctx.projectDir, 'README.md'), '# Hi\n\n[docs](https://example.com/d)\n')
  await f.provided.reviewer.open('README.md')
  const h = f.handles[0]
  assert.equal(h.posts[0].sides.format, 'markdown')
  assert.equal(h.posts[0].sides.mode, 'diff')
  assert.equal(h.posts[0].canOpenLinks, true)
  // Only a URL written in the file opens.
  h.say({ type: 'open-link', href: 'https://example.com/d' })
  h.say({ type: 'open-link', href: 'https://evil.example/' })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(opened, ['https://example.com/d'])
  assert.ok(h.posts.some((m) => m.type === 'error' && /not a link of this document/.test(m.message)))
  await f.provided.reviewer.open('a.js')
  assert.equal(f.handles[1].posts[0].sides.format, undefined)
  assert.equal(f.handles[1].posts[0].canOpenLinks, false)
  fs.writeFileSync(path.join(f.ctx.projectDir, 'big.png'), '')
  fs.truncateSync(path.join(f.ctx.projectDir, 'big.png'), 10 * 1024 * 1024 + 1)
  await assert.rejects(f.provided.reviewer.open('big.png'), /larger than 10 MiB/)
  assert.equal(f.handles.length, 2)
  host.deactivate()
})

// ---- notes(path), addNote and the event notesChange (feature 'notes', the editor's gutter) ----

/** A fake ctx whose storage and service events are real enough to read back. */
function notesSetup() {
  const f = setup({ editorAvailable: false })
  const store = new Map()
  f.ctx.storage = { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v), delete: async (k) => void store.delete(k) }
  fs.writeFileSync(path.join(f.ctx.projectDir, 'b.js'), 'x\n') // addNote takes only a file that exists
  const events = []
  f.ctx.services.emit = (name, event, data) => events.push([name, event, data])
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  return { f, store, events, svc: f.provided.reviewer }
}

test('addNote writes the stored draft the overlay reads, notes() reads it back, and notesChange is told', async () => {
  const { f, store, events, svc } = notesSetup()
  const r = await svc.addNote('a.js', { from: 2, to: 3, text: 'why?', quote: 'two' })
  assert.match(r.id, /^e/)
  assert.deepEqual(store.get('draft:a.js').notes, [{ id: r.id, side: 'new', from: 2, to: 3, quote: 'two', text: 'why?' }])
  assert.deepEqual(await svc.notes('./a.js'), [{ id: r.id, from: 2, to: 3, text: 'why?', quote: 'two' }])
  assert.deepEqual(events, [['reviewer', 'notesChange', { path: 'a.js' }]])
  // The same draft the overlay opens with.
  await svc.open('a.js')
  assert.deepEqual(f.handles[0].posts[0].draft.notes.map((n) => n.id), [r.id])
  host.deactivate()
})

test('addNote keeps earlier notes; notes() is in line order', async () => {
  const { svc } = notesSetup()
  const r = await svc.addNote('a.js', { from: 2, to: 3, text: 'why?' })
  const r2 = await svc.addNote('a.js', { from: 1, text: 'and this' })
  assert.notEqual(r2.id, r.id)
  assert.deepEqual((await svc.notes('a.js')).map((n) => [n.from, n.to, n.text]), [[1, 1, 'and this'], [2, 3, 'why?']])
  host.deactivate()
})

test("notes(): only the working-tree line notes with text; the open overlay's own draft wins over storage", async () => {
  const { f, store, svc } = notesSetup()
  const anchor = { prefix: '', suffix: '', occurrence: 0, length: 1, at: 0 }
  store.set('draft:a.js', {
    global: 'g',
    notes: [
      { id: '1', side: 'old', from: 1, to: 1, quote: '', text: 'old side' },
      { id: '2', side: 'new', from: 1, to: 1, quote: 'x', text: '   ' },
      { id: '3', page: 2, quote: '', text: 'pdf page' },
      { id: '4', quote: 'q', anchor, text: 'html no lines' },
      { id: '5', quote: 'q', anchor, lines: { from: 4, to: 5 }, text: 'rendered' },
      { id: '6', side: 'new', from: 1, to: 1, quote: 'x', text: 'kept' },
    ],
  })
  assert.deepEqual((await svc.notes('a.js')).map((n) => [n.id, n.from, n.to]), [['6', 1, 1], ['5', 4, 5]])
  await svc.open('a.js')
  f.handles[0].say({ type: 'draft', draft: { global: '', notes: [{ id: 'n1', side: 'new', from: 3, to: 3, quote: '', text: 'live' }] } })
  assert.deepEqual((await svc.notes('a.js')).map((n) => n.id), ['n1'])
  host.deactivate()
})

test("addNote is refused while the file's review is open, and for a bad path or note", async () => {
  const { store, svc } = notesSetup()
  await svc.open('a.js')
  await assert.rejects(svc.addNote('a.js', { from: 1, text: 'x' }), /review of a\.js is open/)
  assert.equal(store.size, 0)
  for (const bad of ['../x', '/etc/passwd', '', 'a\0b', 5, null]) {
    await assert.rejects(svc.addNote(bad, { from: 1, text: 'x' }), /reviewer:/, String(bad))
    await assert.rejects(svc.notes(bad), /reviewer:/, String(bad))
  }
  const badNotes = [null, 'x', {}, { from: 0, text: 'x' }, { from: 1.5, text: 'x' }, { from: 1e9, text: 'x' }, { from: 3, to: 2, text: 'x' }, { from: 1, text: '' }, { from: 1, text: '  ' }, { from: 1, text: 5 }, { from: 1, text: 'x'.repeat(4001) }, { from: 1, text: 'x', quote: 5 }]
  for (const bad of badNotes) await assert.rejects(svc.addNote('b.js', bad), /reviewer:/, JSON.stringify(bad))
  assert.equal(store.size, 0)
  // A long quote is cut, not refused; a note at the cap of 4000 characters is taken.
  await svc.addNote('b.js', { from: 1, text: 'x'.repeat(4000), quote: 'q'.repeat(900) })
  const n = (await svc.notes('b.js'))[0]
  assert.equal(n.text.length, 4000)
  assert.equal(n.quote.length, review.MAX_QUOTE)
  host.deactivate()
})

test('addNote refuses a path that leaves the project through a symlink, and a full draft', async () => {
  const { f, store, svc } = notesSetup()
  const outside = tempDir('revout-')
  fs.symlinkSync(outside, path.join(f.ctx.projectDir, 'link'))
  await assert.rejects(svc.addNote('link/x.js', { from: 1, text: 'x' }), /through a symlink/)
  await assert.rejects(svc.notes('link/x.js'), /through a symlink/)
  store.set('draft:a.js', { global: '', notes: Array.from({ length: review.MAX_NOTES }, (_, i) => ({ id: `n${i}`, side: 'new', from: 1, to: 1, quote: '', text: 'x' })) })
  await assert.rejects(svc.addNote('a.js', { from: 1, text: 'one more' }), /more than 200 notes/)
  assert.equal(store.get('draft:a.js').notes.length, review.MAX_NOTES)
  host.deactivate()
})

test('removeNotes deletes only the notes whose id and text still match, keeps the comment, and tells notesChange', async () => {
  const { store, events, svc } = notesSetup()
  store.set('draft:a.js', {
    global: 'whole file',
    notes: [
      { id: '1', side: 'new', from: 1, to: 1, quote: '', text: 'sent' },
      { id: '2', side: 'new', from: 2, to: 2, quote: '', text: 'edited since' },
      { id: '3', side: 'new', from: 3, to: 3, quote: '', text: 'added since' },
    ],
  })
  const r = await svc.removeNotes('a.js', [
    { id: '1', text: 'sent' },
    { id: '2', text: 'what was sent' },
    { id: 'gone', text: 'x' },
  ])
  assert.deepEqual(r, { removed: 1 })
  assert.deepEqual(store.get('draft:a.js').global, 'whole file')
  assert.deepEqual(store.get('draft:a.js').notes.map((n) => n.id), ['2', '3'])
  assert.deepEqual(events, [NOTES_A])
  // Nothing matching: no write, no event.
  assert.deepEqual(await svc.removeNotes('a.js', [{ id: '1', text: 'sent' }]), { removed: 0 })
  assert.deepEqual(await svc.removeNotes('b.js', []), { removed: 0 })
  assert.equal(events.length, 1)
  host.deactivate()
})

test('removeNotes deletes a draft left empty; it is refused while the review is open and for bad input', async () => {
  const { store, svc } = notesSetup()
  store.set('draft:a.js', { global: '', notes: [{ id: '1', side: 'new', from: 1, to: 1, quote: '', text: 'only' }, { id: '2', side: 'new', from: 2, to: 2, quote: 'q', text: '  ' }] })
  assert.deepEqual(await svc.removeNotes('a.js', [{ id: '1', text: 'only' }]), { removed: 1 })
  // The one note left has no words: nothing the person wrote is left, so the draft goes.
  assert.equal(store.has('draft:a.js'), false)
  store.set('draft:a.js', { global: '', notes: [{ id: '1', side: 'new', from: 1, to: 1, quote: '', text: 'only' }] })
  await svc.open('a.js')
  await assert.rejects(svc.removeNotes('a.js', [{ id: '1', text: 'only' }]), /review of a\.js is open/)
  assert.equal(store.get('draft:a.js').notes.length, 1)
  for (const bad of [null, 'x', {}, [null], [{ id: 1, text: 'x' }], [{ id: '', text: 'x' }], [{ id: 'x'.repeat(41), text: 'x' }], [{ id: 'a' }], [{ id: 'a', text: 'x'.repeat(4001) }], Array.from({ length: 201 }, (_, i) => ({ id: `n${i}`, text: 'x' }))]) {
    await assert.rejects(svc.removeNotes('b.js', bad), /reviewer:/, JSON.stringify(bad).slice(0, 60))
  }
  await assert.rejects(svc.removeNotes('../x', []), /reviewer:/)
  host.deactivate()
})

test('concurrent addNote calls keep every note', async () => {
  const { svc } = notesSetup()
  await Promise.all(Array.from({ length: 8 }, (_, i) => svc.addNote('a.js', { from: i + 1, text: `n${i}` })))
  assert.equal((await svc.notes('a.js')).length, 8)
  host.deactivate()
})

/** Polls `cond` until it holds (a condition, never a fixed sleep, decides a test). */
async function until(cond, what, ms = 3000) {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await wait(10)
  }
}

const NOTES_A = ['reviewer', 'notesChange', { path: 'a.js' }]

test("notesChange follows the overlay's draft writes and a sent review; a text annotation tells nothing", async () => {
  const { f, store, events, svc } = notesSetup()
  await svc.open('a.js')
  const h = f.handles[0]
  h.say({ type: 'draft', draft: { global: '', notes: [{ id: 'n1', side: 'new', from: 1, to: 1, quote: '', text: 'hi' }] } })
  // Told once the coalesced write lands, not before.
  await until(() => store.has('draft:a.js'), 'the draft write')
  await until(() => events.length === 1, 'the first notesChange')
  assert.deepEqual(events, [NOTES_A])
  assert.equal(store.get('draft:a.js').notes.length, 1)
  await h.discussFn()
  h.end({ kind: 'discussed', tabId: 't1', queued: false })
  await until(() => store.size === 0, 'the sent draft deleted')
  // The draft written again for Discuss (its newest copy), then deleted once sent: one event each.
  await until(() => events.length === 3, 'the write and delete events')
  assert.deepEqual(events, [NOTES_A, NOTES_A, NOTES_A])
  events.length = 0
  await svc.annotate({ title: 'Ticket', text: 'body' })
  f.handles[1].say({ type: 'draft', draft: { global: 'g', notes: [] } })
  // The annotation's draft is written (the known later event) and no notesChange came with it: it is
  // not a file's review. The event would follow the write in the same then, before this poll sees it.
  await until(() => [...store.keys()].some((k) => k.startsWith('annotate:')), "the annotation's draft write")
  assert.deepEqual(events, [])
  host.deactivate()
})

test('addNote racing an open: a note already writing lands in what the overlay opens with; one still queued, or after, is refused', async () => {
  const { f, store, svc } = notesSetup()
  // A gate on the first draft read: the first addNote is inside its read-modify-write when the open
  // starts, the second waits its turn behind it (forced, not left to timer offsets).
  const realGet = f.ctx.storage.get
  let release
  const gate = new Promise((r) => (release = r))
  let gated = false
  let reading = null
  const read = new Promise((r) => (reading = r))
  f.ctx.storage.get = async (k) => {
    if (!gated && k === 'draft:a.js') {
      gated = true
      reading()
      await gate
    }
    return realGet(k)
  }
  const settle = (p) => p.then((r) => ({ ok: r }), (e) => ({ err: e.message }))
  const first = settle(svc.addNote('a.js', { from: 1, text: 'first' }))
  const second = settle(svc.addNote('a.js', { from: 2, text: 'second' }))
  await read
  const opened = svc.open('a.js')
  const third = settle(svc.addNote('a.js', { from: 3, text: 'third' }))
  release()
  const [r1, r2, r3] = await Promise.all([first, second, third])
  await opened
  assert.ok(r1.ok, 'the note already writing lands')
  assert.match(r2.err, /review of a\.js is open/)
  assert.match(r3.err, /review of a\.js is open/)
  // The overlay opened with the note that landed: nothing written behind its back, nothing lost.
  assert.deepEqual(f.handles[0].posts[0].draft.notes.map((n) => n.id), [r1.ok.id])
  f.handles[0].end({ kind: 'dismissed' })
  assert.deepEqual(store.get('draft:a.js').notes.map((n) => n.id), [r1.ok.id])
  host.deactivate()
})

test('addNote refuses a path that is not a file of the project, so no stray drafts pile up', async () => {
  const { f, store, svc } = notesSetup()
  fs.mkdirSync(path.join(f.ctx.projectDir, 'dir'))
  for (const bad of ['nope.js', 'dir', 'x/y.js']) await assert.rejects(svc.addNote(bad, { from: 1, text: 'x' }), /not a file of this project/, bad)
  assert.equal(store.size, 0)
  host.deactivate()
})

test('a queued Discuss deletes only the notes it sent: one added since stays', async () => {
  const f = setup({ editorAvailable: false })
  const { store } = storeFake(f)
  const tab = { tabId: 't1', status: 'working', lastPrompt: 'earlier work' }
  const changes = []
  f.ctx.sessions.list = async () => [tab]
  f.ctx.sessions.onChange = (l) => (changes.push(l), () => {})
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  const svc = f.provided.reviewer
  await svc.open('a.js')
  const h = f.handles[0]
  h.say({ type: 'draft', draft: { global: '', notes: [{ id: 'n1', side: 'new', from: 1, to: 1, quote: '', text: 'sent' }] } })
  const { text } = await h.discussFn()
  h.end({ kind: 'discussed', tabId: 't1', queued: true })
  await wait(50)
  const added = await svc.addNote('a.js', { from: 1, text: 'later' })
  const sentText = `About: Review: a.js\nFile: a.js\n\n${text}\n\nA note.`
  changes[0]([{ ...tab, lastPrompt: sentText.replace(/\n/g, '\r\n').slice(0, 2048) }])
  await wait(30)
  assert.deepEqual(store.get('draft:a.js').notes.map((n) => n.id), [added.id])
  host.deactivate()
})

// ---- one copy per view (design-overlay-views §6): replayable state, guest-safe payloads, access by viewer ----

const OWNER_WEB = Object.freeze({ view: 'web:1', access: 'owner', copy: 'c-owner-web' })
const WRITER = Object.freeze({ view: 'web:2', access: 'write', person: 'Ann', copy: 'c-write' })
const READER = Object.freeze({ view: 'web:3', access: 'read', person: 'Bob', copy: 'c-read' })
const GUESTS = [WRITER, READER]

/** Every string in `v`, but the base64 payloads (a preview's bytes, an image), which may start with a `/`. */
function stringsOf(v, out = []) {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out)
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'b64' && k !== 'dataUrl') stringsOf(x, out)
  return out
}

/** No host path anywhere in what a guest's copy got (design-guests D-33): not the project folder, nothing absolute. */
function assertNoHostPath(msgs, root) {
  assert.ok(msgs.length > 0, 'the guest got something')
  const json = JSON.stringify(msgs)
  assert.ok(!json.includes(root) && !json.includes(path.dirname(root)), `a host path in ${json.slice(0, 300)}`)
  for (const s of stringsOf(msgs)) assert.ok(!path.isAbsolute(s), `an absolute path: ${s}`)
}

const types = (msgs) => msgs.map((m) => m.type)
// Past the host's "did the overlay open" wait (OPEN_SETTLE_MS) for an open that does not return it.
const OPEN_WAIT = 700

/** An html annotation with everything a page message can act on: a url, a link, a button, originals, a companion. */
async function richAnnotation(f, extra = {}) {
  const r = await f.provided.reviewer.annotate({
    title: 'Mail',
    html: '<p>Hi <a href="https://example.com/a">a</a> <span data-action="archive">Archive</span></p><div data-original="m1"></div>',
    originals: [{ id: 'm1', html: '<p>o</p>' }],
    assets: [{ id: 'cid1', mime: 'image/png', dataUrl: PNG }],
    url: 'https://mail.example/t1',
    key: 'gmail:t1',
    companion: { title: 'PROJ-1', html: '<p>issue</p>', url: 'https://x/PROJ-1' },
    ...extra,
  })
  await wait(0)
  return r
}

test('the manifest declares one copy per view and checks access itself', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'))
  assert.deepEqual(m.overlays, { perView: true })
  assert.deepEqual(m.guests, { aware: true })
})

test('every copy gets its own init by a post addressed to it; a guest\'s has no host path and draws no buttons', async () => {
  const f = setup({ editorAvailable: false })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  const h = f.handles[0]
  // The owner's init is the init as it always was: root included, no canAct.
  assert.equal(h.posts[0].type, 'init')
  assert.equal(h.posts[0].sides.root, f.ctx.projectDir)
  assert.equal('canAct' in h.posts[0], false)
  for (const g of GUESTS) {
    const inbox = h.connect(g)
    assert.deepEqual(types(inbox), ['init'])
    assert.equal('root' in inbox[0].sides, false)
    assert.equal(inbox[0].sides.path, 'a.js')
    assert.equal(inbox[0].sides.new, 'two\n')
    assert.equal(inbox[0].canAct, false)
    assertNoHostPath(inbox, f.ctx.projectDir)
  }
  // Every post was addressed: nothing relied on a broadcast.
  assert.ok(h.events.filter((e) => e[0] === 'post').every((e) => typeof e[1] === 'string'))
  host.deactivate()
})

test('a preview\'s guest copy has no host path either, and gets the bytes after it asks', async () => {
  const f = setup({ editorAvailable: false })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  fs.writeFileSync(path.join(f.ctx.projectDir, 'pic.png'), Buffer.from(PNG.split(',')[1], 'base64'))
  await f.provided.reviewer.open('pic.png')
  const h = f.handles[0]
  assert.equal(h.posts[0].sides.root, f.ctx.projectDir)
  const inbox = h.connect(READER)
  h.sayAs(READER, { type: 'content' })
  assert.deepEqual(types(inbox), ['init', 'bytes-begin', 'bytes', 'bytes-end'])
  assertNoHostPath(inbox, f.ctx.projectDir)
  host.deactivate()
})

test('a late copy is rebuilt: the newest draft and layout in its init, then its content and every update after it asks', async () => {
  const f = setup({ editorAvailable: false })
  storeFake(f)
  const caller = { id: 'example.mail' }
  withServices(f, caller)
  f.ctx.openExternal = async () => {}
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await richAnnotation(f)
  const h = f.handles[0]
  h.say({ type: 'content' })
  const draft = { global: 'later', notes: [] }
  h.say({ type: 'draft', draft })
  h.say({ type: 'layout', layout: 'unified' })
  h.say({ type: 'split', split: 0.3 })
  await f.provided.reviewer.update({ key: 'gmail:t1', assets: [{ id: 'r1', mime: 'image/png', dataUrl: PNG }], hide: ['images-bar'], status: 'Loaded' })
  const owned = h.posts.slice()
  // The owner's other screen (D-1) and a guest connect late: the same page, in the same order.
  for (const from of [OWNER_WEB, READER]) {
    const inbox = h.connect(from)
    assert.deepEqual(types(inbox), ['init'], 'nothing before the page asks for its content')
    assert.deepEqual(inbox[0].draft, draft)
    assert.equal(inbox[0].layout, 'unified')
    assert.equal(inbox[0].split, 0.3)
    h.sayAs(from, { type: 'content' })
    h.sayAs(from, { type: 'content' }) // once per copy
    const content = owned.slice(1).filter((m) => !['draft-error', 'draft-saved'].includes(m.type))
    assert.deepEqual(inbox.slice(1), content)
    assert.deepEqual(types(inbox.slice(-3)), ['assets-done', 'update', 'asset'])
    assert.equal(inbox.at(-2).status, 'Loaded')
  }
  assertNoHostPath(h.inboxOf(READER.copy), f.ctx.projectDir)
  // A live update reaches every copy whose content went out, and a copy that has not asked yet only after it.
  const late = h.connect(WRITER)
  await f.provided.reviewer.update({ key: 'gmail:t1', status: 'Again' })
  assert.equal(h.posts.at(-1).status, 'Again')
  assert.equal(h.inboxOf(OWNER_WEB.copy).at(-1).status, 'Again')
  assert.equal(h.inboxOf(READER.copy).at(-1).status, 'Again')
  assert.deepEqual(types(late), ['init'])
  h.sayAs(WRITER, { type: 'content' })
  // Folded: one update with the sum so far (the last status), then its assets.
  assert.deepEqual(late.slice(-3).map((m) => m.type + (m.status ? `:${m.status}` : '')), ['assets-done', 'update:Again', 'asset'])
  // A copy that went is sent nothing more.
  h.disconnect(READER.copy)
  const ev = h.events.length
  await f.provided.reviewer.update({ key: 'gmail:t1', status: 'Third' })
  assert.ok(!h.events.slice(ev).some((e) => e[0] === 'post' && e[1] === READER.copy))
  assert.equal(h.posts.at(-1).status, 'Third')
  host.deactivate()
})

test('a prepared overlay is replayed: a copy up while loading gets the fill, a late one the error page, Try again only for the owner', async () => {
  const f = setup({ editorAvailable: false })
  const caller = { id: 'bronos.chat' }
  const emits = withServices(f, caller)
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.prepare({ key: 'chat:1', title: 'Ann' })
  const h = f.handles[0]
  // Loading: the page starts on its loader, so a copy up now is sent nothing yet.
  const early = h.connect(READER)
  assert.deepEqual(early, [])
  assert.deepEqual(h.posts, [])
  await f.provided.reviewer.fail({ key: 'chat:1', message: 'down', retry: true })
  assert.deepEqual(h.posts, [{ type: 'failed', message: 'down', retry: true }])
  assert.deepEqual(early, [{ type: 'failed', message: 'down', retry: false }])
  // After the failure a late copy gets the error page too, as its viewer may see it.
  assert.deepEqual(h.connect(OWNER_WEB), [{ type: 'failed', message: 'down', retry: true }])
  assert.deepEqual(h.connect(WRITER), [{ type: 'failed', message: 'down', retry: false }])
  // Try again: the owner's only (from any of the owner's screens).
  h.sayAs(READER, { type: 'retry' })
  h.sayAs(WRITER, { type: 'retry' })
  assert.equal(emits.length, 0)
  h.sayAs(OWNER_WEB, { type: 'retry' })
  assert.deepEqual(emits.map((e) => e.data), [{ key: 'chat:1', id: 'retry', caller: 'bronos.chat' }])
  // The caller's next prepare: every copy back to the loader, then the annotate fills every copy.
  await f.provided.reviewer.prepare({ key: 'chat:1', title: 'Ann' })
  for (const c of [OWNER.copy, OWNER_WEB.copy, WRITER.copy, READER.copy]) assert.deepEqual(h.inboxOf(c).at(-1), { type: 'loading' })
  await f.provided.reviewer.annotate({ title: 'Ann', text: 'hello', key: 'chat:1' })
  for (const c of [OWNER.copy, OWNER_WEB.copy, WRITER.copy, READER.copy]) {
    const init = h.inboxOf(c).at(-1)
    assert.equal(init.type, 'init')
    assert.equal(init.sides.new, 'hello')
  }
  assert.equal(f.handles.length, 1)
  for (const g of GUESTS) assertNoHostPath(h.inboxOf(g.copy), f.ctx.projectDir)
  host.deactivate()
})

test('the error page\'s Close: the owner and a write guest close for everyone, a read guest hides only its copy', async () => {
  const f = setup({ editorAvailable: false })
  withServices(f, { id: 'bronos.chat' })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  for (const [i, from] of [OWNER, WRITER, READER].entries()) {
    await f.provided.reviewer.prepare({ key: `chat:${i}`, title: 'Ann' })
    await f.provided.reviewer.fail({ key: `chat:${i}`, message: 'down' })
    const h = f.handles[i]
    if (from !== OWNER) h.connect(from)
    h.sayAs(from, { type: 'close' })
    assert.equal(h.closed, from === READER ? 0 : 1, from.access)
    assert.deepEqual(h.hides, from === READER ? [READER.copy] : [], from.access)
  }
  host.deactivate()
})

test('the access table: each page message by owner, write guest and read guest', async () => {
  const f = setup({ editorAvailable: false })
  const { store } = storeFake(f)
  const caller = { id: 'example.mail' }
  const emits = withServices(f, caller)
  const opened = []
  let refuse = null
  f.ctx.openExternal = async (url, options) => {
    opened.push([url, options])
    if (refuse) throw refuse
  }
  const prefs = []
  f.ctx.appStorage = { get: async () => null, set: async (k, v) => prefs.push([k, v]) }
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await richAnnotation(f)
  const h = f.handles[0]
  for (const g of GUESTS) h.connect(g)
  const say = (from, m) => (from === OWNER ? h.say(m) : h.sayAs(from, m))

  // content: everyone, each copy its own, the same content (no host path in it).
  for (const from of [OWNER, WRITER, READER]) say(from, { type: 'content' })
  const content = h.posts.slice(1)
  for (const g of GUESTS) {
    assert.deepEqual(h.inboxOf(g.copy).slice(1), content)
    assertNoHostPath(h.inboxOf(g.copy), f.ctx.projectDir)
  }

  // note edits (the whole draft, until Task 11): the owner's saved; a guest's dropped.
  for (const from of GUESTS) say(from, { type: 'draft', draft: { global: `by ${from.person}`, notes: [] } })
  await wait(SAVE_WAIT)
  assert.equal(store.size, 0)
  say(OWNER, { type: 'draft', draft: { global: 'mine', notes: [] } })
  await wait(SAVE_WAIT)
  assert.equal(store.get('annotate:gmail:t1').global, 'mine')

  // layout, split: the owner's app-wide prefs; a guest's switch stays in its copy.
  for (const from of GUESTS) {
    say(from, { type: 'layout', layout: 'unified' })
    say(from, { type: 'split', split: 0.3 })
  }
  assert.deepEqual(prefs, [])
  say(OWNER, { type: 'layout', layout: 'unified' })
  say(OWNER, { type: 'split', split: 0.3 })
  assert.deepEqual(prefs, [['layout', 'unified'], ['companionSplit', 0.3]])

  // action: the owner's only; a guest's copy was told to draw none.
  for (const g of GUESTS) assert.equal(h.inboxOf(g.copy)[0].canAct, false)
  for (const from of GUESTS) say(from, { type: 'action', id: 'archive' })
  assert.equal(emits.length, 0)
  say(OWNER, { type: 'action', id: 'archive' })
  assert.deepEqual(emits.map((e) => [e.event, e.data.id]), [['action', 'archive']])

  // view: re-emitted for the owner only.
  for (const from of GUESTS) say(from, { type: 'view', view: 'original' })
  assert.equal(emits.length, 1)
  say(OWNER, { type: 'view', view: 'original' })
  assert.deepEqual(emits.map((e) => e.event), ['action', 'view'])

  // open-url, open-link: everyone, on the device of the view that asked; a refusal to that copy only.
  for (const from of [OWNER, WRITER, READER]) {
    say(from, { type: 'open-url' })
    say(from, { type: 'open-url', doc: 'companion' })
    say(from, { type: 'open-link', href: 'https://example.com/a' })
  }
  await wait(10)
  assert.deepEqual(
    opened,
    [OWNER, WRITER, READER].flatMap((from) => [
      ['https://mail.example/t1', { view: from.view }],
      ['https://x/PROJ-1', { view: from.view }],
      ['https://example.com/a', { view: from.view }],
    ]),
  )
  assert.equal(opened[0][1].view, 'desktop')
  refuse = new Error('openExternal: refused')
  const counts = () => [OWNER, WRITER, READER].map((x) => h.inboxOf(x.copy).length)
  const before = counts()
  say(READER, { type: 'open-url' })
  say(READER, { type: 'open-link', href: 'https://elsewhere.example/' })
  await wait(10)
  assert.deepEqual(counts(), [before[0], before[1], before[2] + 2])
  assert.deepEqual(types(h.inboxOf(READER.copy).slice(-2)), ['error', 'error'])

  // close of a filled review: the page has no Close of its own; a stale one from the error page means nothing.
  for (const from of [OWNER, WRITER, READER]) say(from, { type: 'close' })
  assert.equal(h.closed, 0)
  assert.deepEqual(h.hides, [])

  // A message from a copy the host never greeted, or with no from at all, is nobody's.
  h.listeners.forEach((l) => l({ type: 'action', id: 'archive' }))
  h.sayAs({ view: 'web:9', access: 'owner', copy: 'c-unknown' }, { type: 'action', id: 'archive' })
  assert.equal(emits.length, 2)
  host.deactivate()
})

test('Discuss asks only the owner\'s copies for the draft: a guest\'s answer is never sent; no owner copy up, the host\'s at once', async () => {
  const f = setup({ editorAvailable: false })
  storeFake(f)
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.annotate({ title: 'T', text: 'body', key: 'k1' })
  const h = f.handles[0]
  h.connect(WRITER)
  h.say({ type: 'draft', draft: { global: 'owner text', notes: [] } })
  h.answers = false
  const asked = h.discussFn()
  await wait(0)
  assert.equal(h.posts.at(-1).type, 'draft-request')
  assert.ok(!h.inboxOf(WRITER.copy).some((m) => m.type === 'draft-request'))
  h.sayAs(WRITER, { type: 'draft', draft: { global: 'guest text', notes: [] } })
  // A guest's "too large to post" does not fail the owner's Discuss either.
  h.sayAs(WRITER, { type: 'draft-unsaved' })
  h.sayAs(READER, { type: 'draft-unsaved' })
  const { text } = await asked
  assert.match(text, /owner text/)
  assert.doesNotMatch(text, /guest text/)
  // Only a guest's copy up: answered at once with the host's draft, nothing asked of the guest.
  h.disconnect(OWNER.copy)
  const t0 = Date.now()
  assert.match((await h.discussFn()).text, /owner text/)
  assert.ok(Date.now() - t0 < 500)
  assert.ok(!h.inboxOf(WRITER.copy).some((m) => m.type === 'draft-request'))
  host.deactivate()
})

test('draft errors go to the owner\'s copies, and an owner copy that connects later is told too', async () => {
  const f = setup({ editorAvailable: false })
  storeFake(f, { failSet: () => true })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  const h = f.handles[0]
  h.connect(READER)
  h.say({ type: 'draft', draft: { global: 'x', notes: [] } })
  await wait(SAVE_WAIT)
  assert.equal(h.posts.at(-1).type, 'draft-error')
  assert.ok(!h.inboxOf(READER.copy).some((m) => m.type.startsWith('draft')))
  assert.deepEqual(types(h.connect(OWNER_WEB)), ['init', 'draft-error'])
  host.deactivate()
})

test('a copy whose init no longer fits gets its own error page, whose Close follows the access rule; the others live', async () => {
  const f = setup({ editorAvailable: false })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.annotate({ title: 'T', text: 'x', key: 'k1' })
  const h = f.handles[0]
  // main's post limit, as OverlayHandle.post throws it, hit only by these two copies' inits.
  const post = h.post
  h.post = (m, o) => {
    if (m.type === 'init' && o && (o.copy === READER.copy || o.copy === WRITER.copy)) throw new RangeError('overlay post: message too large')
    post(m, o)
  }
  for (const g of GUESTS) {
    assert.deepEqual(h.connect(g), [{ type: 'failed', message: 'T is too large to show here (with its draft).', retry: false }])
  }
  h.sayAs(READER, { type: 'close' })
  assert.deepEqual(h.hides, [READER.copy])
  assert.equal(h.closed, 0)
  h.sayAs(WRITER, { type: 'close' })
  assert.equal(h.closed, 1)
  // The owner's copy, whose init went out, has no Close of its own to send.
  h.say({ type: 'close' })
  assert.equal(h.closed, 1)
  host.deactivate()
})

test('provenance: prepare and annotate attribute their caller chains before the content leaves, and a late copy re-asserts them', async () => {
  const f = setup({ editorAvailable: false })
  const caller = { id: 'example.mail' }
  withServices(f, caller)
  let chain = ['example.inbox', 'example.mail']
  f.ctx.services.callers = () => chain
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.prepare({ key: 'gmail:t1', title: 'Mail' })
  const h = f.handles[0]
  assert.deepEqual(h.sources, [['example.inbox', 'example.mail']])
  // The fill comes through another chain (the call is over by the time a copy asks): both are kept.
  chain = ['example.other', 'example.mail']
  await f.provided.reviewer.annotate({ title: 'Mail', html: '<p>x</p>', key: 'gmail:t1' })
  const all = ['example.inbox', 'example.mail', 'example.other']
  assert.deepEqual(h.sources.at(-1), all)
  const firstInit = h.events.findIndex((e) => e[0] === 'post' && e[2] === 'init')
  const filled = h.events.findIndex((e) => e[0] === 'sources' && e[1].includes('example.other'))
  assert.ok(filled >= 0 && filled < firstInit, 'attributed before the init went out')
  // Outside any call: a late copy's starting state and its content re-assert the whole set first.
  chain = []
  h.events.length = 0
  h.connect(WRITER)
  h.sayAs(WRITER, { type: 'content' })
  assert.deepEqual(h.events[0], ['sources', all])
  assert.equal(h.events[1][2], 'init')
  const contentAt = h.events.findIndex((e) => e[0] === 'post' && e[2] === 'html')
  assert.deepEqual(h.events[contentAt - 1], ['sources', all])
  // update() and fail() bring content too.
  chain = ['example.late', 'example.mail']
  await f.provided.reviewer.update({ key: 'gmail:t1', status: 'x' })
  assert.deepEqual(h.sources.at(-1), [...all, 'example.late'])
  host.deactivate()
})

test('provenance: fail() attributes its caller chain before the error page goes out, a late copy re-asserts it', async () => {
  const f = setup({ editorAvailable: false })
  const caller = { id: 'example.mail' }
  withServices(f, caller)
  let chain = ['example.inbox', 'example.mail']
  f.ctx.services.callers = () => chain
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.prepare({ key: 'gmail:t1', title: 'Mail' })
  await wait(0) // the owner's copy is up, on the loader
  const h = f.handles[0]
  h.events.length = 0
  chain = ['example.failer', 'example.mail']
  assert.deepEqual(await f.provided.reviewer.fail({ key: 'gmail:t1', message: 'offline' }), { failed: true })
  const all = ['example.inbox', 'example.mail', 'example.failer']
  const attributed = h.events.findIndex((e) => e[0] === 'sources' && e[1].includes('example.failer'))
  const failed = h.events.findIndex((e) => e[0] === 'post' && e[2] === 'failed')
  assert.ok(attributed >= 0 && attributed < failed, 'attributed before the error page went out')
  chain = []
  h.events.length = 0
  h.connect(WRITER)
  assert.deepEqual(h.events[0], ['sources', all])
  assert.equal(h.events[1][2], 'failed')
  host.deactivate()
})

test('provenance: the open service attributes its caller chain before the file\'s content leaves', async () => {
  const f = setup({ editorAvailable: false })
  f.ctx.services.callers = () => ['example.tree']
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.open('a.js')
  const h = f.handles[0]
  assert.deepEqual(h.sources[0], ['example.tree'])
  const attributed = h.events.findIndex((e) => e[0] === 'sources')
  assert.ok(attributed >= 0 && attributed < h.events.findIndex((e) => e[2] === 'init'))
  host.deactivate()
})

test('update replay is folded: a late copy gets one update (every hidden part, the last status) and the assets, however many calls came', async () => {
  const f = setup({ editorAvailable: false })
  withServices(f, { id: 'example.mail' })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.annotate({ title: 'Mail', html: '<p><img data-asset="r1" alt="Hero"></p>', key: 'gmail:t1', kind: 'mail' })
  const h = f.handles[0]
  h.say({ type: 'content' })
  await f.provided.reviewer.update({ key: 'gmail:t1', assets: [{ id: 'r1', name: 'hero.png', mime: 'image/png', dataUrl: PNG }], hide: ['images-bar'] })
  for (let i = 0; i < 50; i++) await f.provided.reviewer.update({ key: 'gmail:t1', status: `Synced ${i}` })
  await f.provided.reviewer.update({ key: 'gmail:t1', hide: ['quoted'] })
  // The live copy got every one as it came.
  assert.equal(h.posts.filter((m) => m.type === 'update').length, 52)
  const late = h.connect(OWNER_WEB)
  h.sayAs(OWNER_WEB, { type: 'content' })
  const after = late.slice(late.findIndex((m) => m.type === 'assets-done') + 1)
  assert.deepEqual(after, [
    { type: 'update', assets: [{ id: 'r1', name: 'hero.png', mime: 'image/png' }], hide: ['images-bar', 'quoted'], status: 'Synced 49' },
    { type: 'asset', id: 'r1', dataUrl: PNG },
  ])
  // A status cleared ('') is kept as cleared.
  await f.provided.reviewer.update({ key: 'gmail:t1', status: '' })
  const late2 = h.connect(WRITER)
  h.sayAs(WRITER, { type: 'content' })
  assert.equal(late2.find((m) => m.type === 'update').status, '')
  host.deactivate()
})

test('the owner\'s Original | Reader choice is kept: a reload or another copy starts on it; a guest\'s switch is its copy\'s only', async () => {
  const f = setup({ editorAvailable: false })
  withServices(f, { id: 'example.mail' })
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  await f.provided.reviewer.annotate({ title: 'Mail', html: '<div data-original="m1"></div>', originals: [{ id: 'm1', html: '<p>o</p>' }], view: 'original', key: 'gmail:t1' })
  const h = f.handles[0]
  assert.equal(h.posts[0].sides.view, 'original')
  h.connect(READER)
  h.sayAs(READER, { type: 'view', view: 'reader' })
  assert.equal(h.connect(OWNER_WEB)[0].sides.view, 'original', 'a guest\'s switch is not the overlay\'s')
  h.say({ type: 'view', view: 'reader' })
  for (const from of [WRITER, READER]) {
    if (from === READER) h.disconnect(READER.copy)
    const init = h.connect(from).at(-1) // a reconnected copy's inbox keeps what it had before
    assert.equal(init.type, 'init')
    assert.equal(init.sides.view, 'reader')
    assertNoHostPath([init], f.ctx.projectDir)
  }
  host.deactivate()
})

test('provenance: a file opened for another plugin (requestedBy) is attributed to it; a click of the person\'s is not', async () => {
  const f = setup({ editorAvailable: false })
  let onOpen
  f.ctx.files.onOpen = (fn) => ((onOpen = fn), () => {})
  f.ctx.overlay.start = () => pageHandle(f)
  host.activate(f.ctx)
  const opened = onOpen({ path: 'a.js', requestedBy: 'example.tree' })
  await wait(OPEN_WAIT)
  const h = f.handles[0]
  assert.deepEqual(h.sources, [['example.tree'], ['example.tree']], 'at the fill and again for the owner copy')
  assert.ok(h.events.findIndex((e) => e[0] === 'sources') < h.events.findIndex((e) => e[2] === 'init'))
  h.end({ kind: 'dismissed' })
  await opened
  onOpen({ path: 'a.js', tabId: 't1' })
  await wait(OPEN_WAIT)
  assert.deepEqual(f.handles[1].sources, [])
  host.deactivate()
})
