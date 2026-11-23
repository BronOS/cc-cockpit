'use strict'
// The Files panel's drop rules (dist/lib/drop.js): where a drop of device files goes, and which drags
// the page takes. The page's listeners and highlight run in a real browser only (the upload e2e).
const test = require('node:test')
const assert = require('node:assert/strict')
const drop = require('../dist/lib/drop')

test('dropFolder: the project folder, a folder row, a file row’s folder', () => {
  assert.equal(drop.dropFolder(null), '')
  assert.equal(drop.dropFolder({ rel: 'src', kind: 'dir' }), 'src')
  assert.equal(drop.dropFolder({ rel: 'src/lib/deep', kind: 'dir' }), 'src/lib/deep')
  assert.equal(drop.dropFolder({ rel: 'README.md', kind: 'file' }), '')
  assert.equal(drop.dropFolder({ rel: 'src/lib/a.js', kind: 'file' }), 'src/lib')
  // 'other' (a socket, a dangling link) is not a folder: its folder takes the drop.
  assert.equal(drop.dropFolder({ rel: 'run/sock', kind: 'other' }), 'run')
})

test('dropFolder: names with spaces and unicode stay whole', () => {
  assert.equal(drop.dropFolder({ rel: 'my docs/Отчёт 2026', kind: 'dir' }), 'my docs/Отчёт 2026')
  assert.equal(drop.dropFolder({ rel: 'my docs/Отчёт 2026/план v2.txt', kind: 'file' }), 'my docs/Отчёт 2026')
  assert.equal(drop.dropFolder({ rel: 'café 🎉.md', kind: 'file' }), '')
})

test('takesDrag: device files, with the upload API, from a viewer who may write', () => {
  assert.equal(drop.takesDrag({ types: ['Files'], upload: true }), true)
  assert.equal(drop.takesDrag({ types: ['text/uri-list', 'Files'], upload: true, access: 'write' }), true)
  assert.equal(drop.takesDrag({ types: ['Files'], upload: true, access: 'read' }), false)
  assert.equal(drop.takesDrag({ types: ['Files'], upload: false }), false)
  assert.equal(drop.takesDrag({ types: ['text/plain'], upload: true }), false)
  assert.equal(drop.takesDrag({ types: undefined, upload: true }), false)
  // DataTransfer.types is a frozen array in browsers, a DOMStringList in older ones: any iterable.
  assert.equal(drop.takesDrag({ types: new Set(['Files']), upload: true }), true)
})
