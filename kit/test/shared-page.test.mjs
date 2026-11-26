// The kit's host side (host/shared-page.js) against a fake overlay handle and ctx.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { makePage, urlsIn, CHUNK_CHARS, MESSAGE_CHARS } = require('../host/shared-page.js')

/** A perView overlay handle: connect/disconnect/message driven by the test, every post recorded per copy. */
function fakeHandle() {
  const on = { connect: new Set(), disconnect: new Set(), message: new Set() }
  const sub = (set) => (fn) => {
    set.add(fn)
    return () => set.delete(fn)
  }
  const posts = []
  return {
    posts,
    sent: (copy) => posts.filter((p) => p.copy === copy).map((p) => p.message),
    onConnect: sub(on.connect),
    onDisconnect: sub(on.disconnect),
    onMessage: sub(on.message),
    post(message, opts) {
      // The app's cap: a page message is JSON of at most 1,040,384 chars.
      if (JSON.stringify(message).length > 1040384) throw new Error('message too large')
      posts.push({ copy: opts && opts.copy, message })
    },
    connect: (from) => on.connect.forEach((fn) => fn(from)),
    disconnect: (from) => on.disconnect.forEach((fn) => fn(from)),
    message: (m, from) => on.message.forEach((fn) => fn(m, from)),
  }
}

function fakeCtx(stored = {}) {
  const opened = []
  const writes = []
  const logs = []
  return {
    opened,
    writes,
    logs,
    log: { warn: (t) => logs.push(t) },
    openExternal: async (url, opts) => {
      opened.push([url, opts])
    },
    appStorage: {
      get: async (k) => stored[k],
      set: async (k, v) => {
        writes.push([k, v])
        stored[k] = v
      },
    },
  }
}

const OWNER = { access: 'owner', view: 'desktop:1', copy: 'c-owner' }
const WRITER = { access: 'write', view: 'web:2', copy: 'c-write', person: 'Ann' }
const READER = { access: 'read', view: 'web:3', copy: 'c-read', person: 'Bob' }
const tick = () => new Promise((r) => setTimeout(r, 0))
/** A control character: JSON writes it as six characters, the worst case for a chunk's size. */
const CONTROL = String.fromCharCode(1)

test('shared-page opens only http(s) URLs present in its document', async () => {
  const handle = fakeHandle()
  const ctx = fakeCtx()
  const page = makePage(handle, { ctx })
  handle.connect(OWNER)
  handle.connect(READER)
  await tick()
  page.set({ html: 'x' }, { document: '<p><a href="https://jira.example/browse/A-1?x=1&amp;y=2">A-1</a> see https://docs.example/page). mailto:a@b.c javascript:alert(1)</p>' })
  const click = (url, from = OWNER) => handle.message({ type: 'cc-kit.link', url }, from)
  click('https://jira.example/browse/A-1?x=1&y=2')
  click('https://docs.example/page', READER) // any access: the link is the document's own
  click('https://evil.example/')
  click('https://jira.example/browse/A-2')
  click('mailto:a@b.c')
  click('javascript:alert(1)')
  click(42)
  await tick()
  assert.deepEqual(ctx.opened, [
    ['https://jira.example/browse/A-1?x=1&y=2', { view: 'desktop:1' }],
    ['https://docs.example/page', { view: 'web:3' }],
  ])
  // Fail closed: before any document, nothing opens; a copy main never announced is not heard.
  const ctx2 = fakeCtx()
  const h2 = fakeHandle()
  makePage(h2, { ctx: ctx2 })
  h2.connect(OWNER)
  h2.message({ type: 'cc-kit.link', url: 'https://jira.example/' }, OWNER)
  h2.message({ type: 'cc-kit.link', url: 'https://jira.example/' }, { ...OWNER, copy: 'unknown' })
  await tick()
  assert.deepEqual(ctx2.opened, [])
  assert.ok(urlsIn('a https://x.test/a&amp;b b').has('https://x.test/a&b'))
})

test("shared-page replays each copy's state on connect, a guest's projected; replays chunked under the cap", async () => {
  const handle = fakeHandle()
  const ctx = fakeCtx()
  const project = (state, from) => (from.access === 'owner' ? state : { ...state, secret: undefined, path: undefined })
  const page = makePage(handle, { ctx, project })
  handle.connect(OWNER)
  await tick()
  assert.deepEqual(handle.sent('c-owner'), [{ type: 'cc-kit.init', access: 'owner', tab: 'ask' }, { type: 'cc-kit.loading' }])
  page.set({ title: 'T', secret: 's', path: '/home/x' })
  // A late copy gets the state on its connect; each guest's is projected.
  handle.connect(WRITER)
  handle.connect(READER)
  await tick()
  assert.deepEqual(handle.sent('c-owner').at(-1), { type: 'cc-kit.state', state: { title: 'T', secret: 's', path: '/home/x' } })
  for (const copy of ['c-write', 'c-read']) {
    const msgs = handle.sent(copy)
    assert.equal(msgs[0].type, 'cc-kit.init')
    assert.deepEqual(JSON.parse(JSON.stringify(msgs[1])), { type: 'cc-kit.state', state: { title: 'T' } })
  }
  // Every post names one copy: never a broadcast.
  assert.ok(handle.posts.every((p) => typeof p.copy === 'string'))
  // A failure: the owner gets the message and Try again, a guest the fixed text.
  page.fail('ENOENT /home/x/.token', { retry: () => {} })
  assert.deepEqual(handle.sent('c-owner').at(-1), { type: 'cc-kit.failed', message: 'ENOENT /home/x/.token', retry: true })
  assert.deepEqual(handle.sent('c-read').at(-1), { type: 'cc-kit.failed', message: 'This could not be loaded.', retry: false })
  // A projection that throws sends that copy nothing of the state.
  const h2 = fakeHandle()
  const p2 = makePage(h2, {
    ctx: fakeCtx(),
    project: (s, from) => {
      if (from.access !== 'owner') throw new Error('no')
      return s
    },
  })
  h2.connect(READER)
  await tick()
  p2.set({ secret: 'TOPSECRET' })
  assert.ok(!JSON.stringify(h2.sent('c-read')).includes('TOPSECRET'))

  // Chunked: a state past the cap goes in pieces, each under it, and they join to the state.
  const big = { body: ('é"' + CONTROL).repeat(Math.ceil((MESSAGE_CHARS * 1.5) / 3)) }
  page.set(big)
  const chunks = handle.sent('c-owner').filter((m) => m.type === 'cc-kit.chunk')
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((c, i) => c.i === i && c.n === chunks.length && c.text.length <= CHUNK_CHARS))
  assert.deepEqual(JSON.parse(chunks.map((c) => c.text).join('')), big)
  // And a copy that connects later gets the same chunks.
  handle.connect({ ...OWNER, copy: 'c-owner-2', view: 'web:9' })
  await tick()
  const late = handle.sent('c-owner-2').filter((m) => m.type === 'cc-kit.chunk')
  assert.deepEqual(JSON.parse(late.map((c) => c.text).join('')), big)
})

test('the last used tab is written by owner views only', async () => {
  const handle = fakeHandle()
  const ctx = fakeCtx({ 'cc-kit.tab': 'details' })
  makePage(handle, { ctx, tabs: { ids: ['details', 'ask', 'reply'], first: 'ask' } })
  handle.connect(OWNER)
  handle.connect(WRITER)
  handle.connect(READER)
  await tick()
  // The owner starts where the owner left off; a write guest on Ask, a read guest on Details (D7).
  assert.equal(handle.sent('c-owner')[0].tab, 'details')
  assert.equal(handle.sent('c-write')[0].tab, 'ask')
  assert.equal(handle.sent('c-read')[0].tab, 'details')
  handle.message({ type: 'cc-kit.tab', tab: 'reply' }, WRITER)
  handle.message({ type: 'cc-kit.tab', tab: 'reply' }, READER)
  handle.message({ type: 'cc-kit.tab', tab: 'nope' }, OWNER)
  await tick()
  assert.deepEqual(ctx.writes, [])
  handle.message({ type: 'cc-kit.tab', tab: 'reply' }, OWNER)
  await tick()
  assert.deepEqual(ctx.writes, [['cc-kit.tab', 'reply']])
  // A later owner copy starts there.
  handle.connect({ ...OWNER, copy: 'c-owner-2' })
  await tick()
  assert.equal(handle.sent('c-owner-2')[0].tab, 'reply')
})

test("Try again runs for the owner only, and the page's own messages reach onMessage", async () => {
  const handle = fakeHandle()
  const page = makePage(handle, { ctx: fakeCtx() })
  let retries = 0
  const heard = []
  page.onMessage((m, from) => heard.push([m, from.access]))
  handle.connect(OWNER)
  handle.connect(READER)
  await tick()
  page.fail('boom', { retry: () => retries++ })
  handle.message({ type: 'cc-kit.retry' }, READER)
  assert.equal(retries, 0)
  handle.message({ type: 'cc-kit.retry' }, OWNER)
  assert.equal(retries, 1)
  handle.message({ type: 'reply', text: 'hi' }, READER)
  assert.deepEqual(heard, [[{ type: 'reply', text: 'hi' }, 'read']])
  // Gone copies are not heard; dispose stops everything.
  handle.disconnect(READER)
  handle.message({ type: 'reply' }, READER)
  page.dispose()
  handle.message({ type: 'reply' }, OWNER)
  assert.equal(heard.length, 1)
})
