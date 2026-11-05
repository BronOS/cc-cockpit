'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

// A fake ctx with only what the host uses; every call is recorded.
function fakeCtx({ own = [], all = [], app = {} } = {}) {
  const calls = []
  const listeners = { window: [], all: [], panel: [], settings: [], slot: [] }
  const ctx = {
    settings: { app },
    log: { info() {}, warn: (m) => calls.push(['warn', m]), error() {} },
    panels: {
      post: (panel, m) => calls.push(['post', panel, m]),
      header: (panel, h) => calls.push(['header', panel, h]),
      onMessage: (panel, fn) => {
        listeners.panel.push(fn)
        return () => {}
      },
    },
    sessions: {
      list: async (o) => (o && o.scope === 'all' ? all : own),
      onChange: (fn, o) => {
        listeners[o && o.scope === 'all' ? 'all' : 'window'].push(fn)
        return () => {}
      },
      focus: async (tabId) => {
        calls.push(['focus', tabId])
        return true
      },
      openFile: async (tabId, path) => {
        calls.push(['openFile', tabId, path])
        if (path.endsWith('gone.js')) throw new Error('not recorded')
      },
    },
    slots: {
      onOpen: (type, fn) => {
        assert.equal(type, 'sessions-strip')
        listeners.slot.push(fn)
        return () => {}
      },
    },
    onSettingsChange: (fn) => {
      listeners.settings.push(fn)
      return () => {}
    },
  }
  return { ctx, calls, listeners }
}

function fakeSlot() {
  const posts = []
  let onMessage = null
  let onClose = null
  return {
    posts,
    send: (m) => onMessage(m),
    close: () => onClose(),
    slot: {
      id: 's1',
      type: 'sessions-strip',
      host: { kind: 'app', place: 'top-bar' },
      params: undefined,
      post: (m) => posts.push(m),
      onMessage: (fn) => {
        onMessage = fn
        return () => {}
      },
      onClose: (fn) => {
        onClose = fn
        return () => {}
      },
    },
  }
}

const tick = () => new Promise((r) => setImmediate(r))

function load() {
  delete require.cache[require.resolve('../dist/host')]
  return require('../dist/host')
}

test('panel: sends the window list with filesShown, and the header meta once per count', async () => {
  const host = load()
  const own = [{ tabId: 't1', status: 'idle', notes: [], files: ['/p/a.js'] }]
  const { ctx, calls, listeners } = fakeCtx({ own, app: { filesShown: 3 } })
  host.activate(ctx)
  await tick()
  const posts = calls.filter((c) => c[0] === 'post')
  assert.deepEqual(posts.at(-1), ['post', 'sessions', { type: 'sessions', sessions: own, filesShown: 3 }])
  assert.deepEqual(calls.filter((c) => c[0] === 'header'), [['header', 'sessions', { meta: '1 in this window' }]])
  // The same count again: no new header call. None left: the header is cleared.
  listeners.window[0](own)
  listeners.window[0]([])
  assert.deepEqual(calls.filter((c) => c[0] === 'header').at(-1), ['header', 'sessions', null])
  assert.equal(calls.filter((c) => c[0] === 'header').length, 2)
  host.deactivate()
})

test('panel: focus and openFile only for ids and files of the list', async () => {
  const host = load()
  const own = [{ tabId: 't1', status: 'idle', notes: [], files: ['/p/a.js', '/p/gone.js'] }]
  const { ctx, calls, listeners } = fakeCtx({ own })
  host.activate(ctx)
  await tick()
  const send = listeners.panel[0]
  await send({ type: 'focus', tabId: 't1' })
  await send({ type: 'focus', tabId: 'other' })
  assert.deepEqual(calls.filter((c) => c[0] === 'focus'), [['focus', 't1']])
  await send({ type: 'openFile', tabId: 't1', path: '/p/a.js' })
  await send({ type: 'openFile', tabId: 't1', path: '/etc/passwd' })
  await send({ type: 'openFile', tabId: 't1', path: '/p/gone.js' })
  assert.deepEqual(calls.filter((c) => c[0] === 'openFile'), [['openFile', 't1', '/p/a.js'], ['openFile', 't1', '/p/gone.js']])
  const refused = calls.filter((c) => c[0] === 'post' && c[2].type === 'refused').map((c) => c[2].path)
  assert.deepEqual(refused, ['/etc/passwd', '/p/gone.js'])
  host.deactivate()
})

test('panel: a settings change re-sends with the new cap', async () => {
  const host = load()
  const app = { filesShown: 5 }
  const { ctx, calls, listeners } = fakeCtx({ app })
  host.activate(ctx)
  await tick()
  app.filesShown = 900 // out of range: the default
  listeners.settings[0]()
  assert.equal(calls.filter((c) => c[0] === 'post').at(-1)[2].filesShown, 10)
  host.deactivate()
})

test('strip: other windows ordered, refreshed on change, focus only for drawn ids', async () => {
  const host = load()
  const all = [
    { tabId: 'mine', own: true, project: { name: 'here' }, status: 'needs-permission' },
    { tabId: 'x', own: false, project: { name: 'api' }, status: 'idle' },
    { tabId: 'y', own: false, project: { name: 'web' }, status: 'needs-permission' },
  ]
  const { ctx, calls, listeners } = fakeCtx({ all })
  host.activate(ctx)
  await tick()
  const f = fakeSlot()
  listeners.slot[0](f.slot)
  assert.deepEqual(f.posts.at(-1).entries.map((e) => e.tabId), ['y', 'x'])
  assert.equal(f.posts.at(-1).entries[0].needsYou, true)
  // A change in another window reaches the open strip.
  listeners.all[0]([all[0]])
  assert.deepEqual(f.posts.at(-1), { type: 'strip', entries: [] })
  listeners.all[0](all)
  await f.send({ type: 'focus', tabId: 'x' })
  await f.send({ type: 'focus', tabId: 'mine' })
  await f.send({ type: 'focus', tabId: 'nope' })
  assert.deepEqual(calls.filter((c) => c[0] === 'focus'), [['focus', 'x']])
  // A closed frame hears nothing more.
  f.close()
  const n = f.posts.length
  listeners.all[0](all)
  assert.equal(f.posts.length, n)
  host.deactivate()
})
