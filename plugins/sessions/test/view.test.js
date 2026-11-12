'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const view = require('../dist/lib/view')

const session = (over = {}) => ({ tabId: 't1', status: 'idle', cwd: '/p', notes: [], files: [], ...over })
const files = (n) => Array.from({ length: n }, (_, i) => `/p/src/f${i}.js`)

test('card: name over title over "Claude N"', () => {
  assert.equal(view.cardView(session({ name: 'Mine', title: 'Topic' })).label, 'Mine')
  assert.equal(view.cardView(session({ title: 'Topic' })).label, 'Topic')
  const bare = view.cardView(session(), { index: 3 })
  assert.equal(bare.label, 'Claude 3')
  assert.equal(bare.tooltip, 'Go to this tab')
  assert.equal(view.cardView(session({ title: 'Topic' })).tooltip, 'Topic\nGo to this tab')
})

test('card: the gist stands in for the last prompt, which stays the tooltip', () => {
  const g = view.cardView(session({ gist: 'Fixing the parser', lastPrompt: 'please fix the parser' }))
  assert.deepEqual(g.summary, { text: 'Fixing the parser', title: 'please fix the parser', gist: true })
  const p = view.cardView(session({ lastPrompt: 'hello' }))
  assert.deepEqual(p.summary, { text: 'hello', title: 'hello', gist: false })
  assert.equal(view.cardView(session()).summary, undefined)
})

test('card: status text, dialog tools and steps', () => {
  assert.equal(view.cardView(session({ status: 'working', tool: 'Bash' })).statusText, 'working · Bash')
  assert.equal(view.cardView(session({ status: 'needs-permission', tool: 'AskUserQuestion' })).statusText, 'needs you · question')
  assert.equal(view.cardView(session({ status: 'needs-permission', tool: 'ExitPlanMode' })).statusText, 'needs you · plan approval')
  assert.equal(view.cardView(session({ status: 'needs-permission', tool: 'Edit' })).statusText, 'needs permission · Edit')
  assert.equal(view.cardView(session({ status: 'waiting' })).statusText, 'waiting for input')
  assert.deepEqual(view.cardView(session({ steps: { done: 1, total: 4 } })).steps, { text: '1/4', percent: 25 })
  assert.equal(view.cardView(session({ steps: { done: 3, total: 0 } })).steps.percent, 0)
  assert.equal(view.cardView(session({ steps: { done: 9, total: 4 } })).steps.percent, 100)
  assert.equal(view.cardView(session()).steps, undefined)
})

test('card: notes and the active tab', () => {
  const c = view.cardView(session({ notes: ['one', 'two'], active: true }))
  assert.deepEqual(c.notes, ['one', 'two'])
  assert.equal(c.active, true)
  assert.equal(view.cardView(session()).active, false)
})

test('card: the file list is capped at filesShown until Show all', () => {
  const s = session({ files: files(14) })
  const capped = view.cardView(s, { filesShown: 10 })
  assert.equal(capped.files.length, 10)
  assert.deepEqual(capped.files, files(10))
  assert.equal(capped.fileCount, 14)
  assert.equal(capped.hiddenFiles, 4)
  const open = view.cardView(s, { filesShown: 10, showAll: true })
  assert.equal(open.files.length, 14)
  assert.equal(open.hiddenFiles, 4)
  // Under the cap: nothing hidden.
  assert.equal(view.cardView(session({ files: files(3) }), { filesShown: 10 }).hiddenFiles, 0)
  assert.equal(view.cardView(s, { filesShown: 2 }).files.length, 2)
})

test('filesShown: integers 1-500, else the default 10', () => {
  assert.equal(view.filesShownOf(1), 1)
  assert.equal(view.filesShownOf(500), 500)
  for (const bad of [0, 501, 2.5, '10', null, undefined, -1]) assert.equal(view.filesShownOf(bad), 10)
  assert.equal(view.cardView(session({ files: files(14) }), { filesShown: 0 }).files.length, 10)
})

test('splitPath and the header meta', () => {
  assert.deepEqual(view.splitPath('/a/b/c.js'), { dir: '/a/b/', name: 'c.js' })
  assert.deepEqual(view.splitPath('c.js'), { dir: '', name: 'c.js' })
  assert.equal(view.metaText(0), undefined)
  assert.equal(view.metaText(2), '2 in this window')
})

const summary = (tabId, status, over = {}) => ({ tabId, own: false, project: { name: 'app' }, status, ...over })

test('strip: other windows only, needs-you first, stable within a status', () => {
  const entries = view.stripView([
    summary('a', 'idle'),
    summary('mine', 'needs-permission', { own: true }),
    summary('b', 'working'),
    summary('c', 'needs-permission'),
    summary('d', 'ended'),
    summary('e', 'waiting'),
    summary('f', 'starting'),
    summary('g', 'working'),
  ])
  assert.deepEqual(
    entries.map((e) => e.tabId),
    ['c', 'e', 'b', 'g', 'a', 'f', 'd'],
  )
})

test('strip: needs-you is tinted, text and tooltip', () => {
  const [c, b] = view.stripView([summary('b', 'working', { tool: 'Bash', title: 'Topic' }), summary('c', 'needs-permission', { name: 'Named' })])
  assert.equal(c.needsYou, true)
  assert.equal(b.needsYou, false)
  assert.equal(b.text, 'app · working · Bash')
  assert.equal(b.tooltip, 'app · Topic\nworking · Bash')
  assert.equal(c.tooltip, 'app · Named\nneeds permission')
})

test('strip: the project colour, only as a token or #rrggbb', () => {
  const [a, b, c] = view.stripView([
    summary('a', 'idle', { project: { name: 'x', color: 'var(--cc-project-blue)' } }),
    summary('b', 'idle', { project: { name: 'y', color: '#12abef' } }),
    summary('c', 'idle', { project: { name: 'z', color: 'red; background: url(x)' } }),
  ])
  assert.equal(a.color, 'var(--cc-project-blue)')
  assert.equal(b.color, '#12abef')
  assert.equal(c.color, undefined)
})

test('strip: empty when no other window has a session', () => {
  assert.deepEqual(view.stripView([]), [])
  assert.deepEqual(view.stripView([summary('mine', 'idle', { own: true })]), [])
  assert.deepEqual(view.stripView(undefined), [])
})

test('flag: only the six colours, drawn through their token; the note only when it is text', () => {
  assert.deepEqual(view.flagOf({ color: 'red', note: 'come back' }), { color: 'red', css: 'var(--cc-flag-red)', note: 'come back' })
  assert.deepEqual(view.flagOf({ color: 'purple' }), { color: 'purple', css: 'var(--cc-flag-purple)' })
  assert.deepEqual(view.flagOf({ color: 'blue', note: '' }), { color: 'blue', css: 'var(--cc-flag-blue)' })
  for (const bad of [undefined, null, 'red', {}, { color: 'teal' }, { color: 'red); background: url(x' }]) {
    assert.equal(view.flagOf(bad), undefined, JSON.stringify(bad))
  }
  assert.deepEqual(view.cardView(session({ flag: { color: 'green', note: 'n' } })).flag, { color: 'green', css: 'var(--cc-flag-green)', note: 'n' })
  assert.equal(view.cardView(session()).flag, undefined)
})

test('groups: flagged first, then the rest, each in list order, with each tab\'s place in the whole list', () => {
  const g = view.groupSessions([
    session({ tabId: 'a' }),
    session({ tabId: 'b', flag: { color: 'red' } }),
    session({ tabId: 'c' }),
    session({ tabId: 'd', flag: { color: 'blue', note: 'n' } }),
    session({ tabId: 'e', flag: { color: 'teal' } }),
  ])
  assert.deepEqual(g.flagged.map((x) => [x.session.tabId, x.index]), [['b', 2], ['d', 4]])
  assert.deepEqual(g.rest.map((x) => [x.session.tabId, x.index]), [['a', 1], ['c', 3], ['e', 5]])
  assert.deepEqual(view.groupSessions([]), { flagged: [], rest: [] })
  assert.deepEqual(view.groupSessions(undefined), { flagged: [], rest: [] })
})

test('strip: a flagged tab of another window carries its colour, never a note', () => {
  const [a, b] = view.stripView([summary('a', 'idle', { flag: { color: 'orange', note: 'x' } }), summary('b', 'idle', { flag: { color: 'grey' } })])
  assert.deepEqual(a.flag, { color: 'orange', css: 'var(--cc-flag-orange)' })
  assert.equal(b.flag, undefined)
})

test('machines: name, marks for waiting / working only, tooltip with the counts', () => {
  const [a, b, c, d] = view.machineView([
    { id: 'm-a', name: 'devbox', reachable: true, waiting: 1, working: 2, idle: 3 },
    { id: 'm-b', name: 'down', reachable: false, waiting: 4 },
    { id: 'm-c', name: 'fresh', reachable: true },
    { id: 'm-d', name: 'quiet', reachable: true, waiting: 0, working: 0, idle: 1 },
  ])
  assert.deepEqual(a, {
    id: 'm-a', name: 'devbox', reachable: true,
    marks: [{ status: 'waiting', count: 1 }, { status: 'working', count: 2 }],
    tooltip: 'devbox: 1 waiting, 2 working, 3 idle',
  })
  assert.equal(b.tooltip, 'down: not reachable')
  assert.equal(b.reachable, false)
  assert.deepEqual(b.marks, [])
  assert.equal(c.tooltip, 'fresh')
  assert.deepEqual(c.marks, [])
  assert.deepEqual(d.marks, [])
  assert.equal(d.tooltip, 'quiet: 0 waiting, 0 working, 1 idle')
})

test('machines: junk is dropped', () => {
  assert.deepEqual(view.machineView(undefined), [])
  assert.deepEqual(view.machineView([null, { id: 1, name: 'x' }, { id: 'm', name: 'ok', waiting: -1 }]).map((m) => m.tooltip), ['ok'])
})
