'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { watchWidth } = require('../dist/lib/strip-width')

/** A row whose width and entry count the test sets, and an observer the test fires by hand. */
function setup() {
  const row = { childElementCount: 0, w: 0, getBoundingClientRect: () => ({ width: row.w }) }
  const observers = []
  class FakeObserver {
    constructor(cb) {
      this.cb = cb
      this.observed = []
      this.disconnected = false
      observers.push(this)
    }
    observe(el) {
      this.observed.push(el)
    }
    disconnect() {
      this.disconnected = true
    }
  }
  const sent = []
  let slot
  const watch = watchWidth(row, () => slot, FakeObserver)
  return {
    row,
    observers,
    sent,
    watch,
    becomeSlot: () => {
      slot = { type: 'sessions-strip', setWidth: (px) => sent.push(px) }
    }
  }
}

test('strip width: nothing is sent before the page is a slot, then the row, rounded up', () => {
  const s = setup()
  assert.equal(s.observers.length, 1)
  assert.deepEqual(s.observers[0].observed, [s.row])
  s.row.childElementCount = 2
  s.row.w = 180.2
  // The observer's first call comes before the shell's slot message: no ccPanel.slot yet.
  s.observers[0].cb()
  assert.deepEqual(s.sent, [])
  s.becomeSlot()
  s.watch.report()
  assert.deepEqual(s.sent, [181])
})

test('strip width: an empty row is 0, a repeat is not sent, a change from the observer is', () => {
  const s = setup()
  s.becomeSlot()
  s.row.w = 8 // padding only; an empty row takes no room whatever its box says
  s.watch.report()
  assert.deepEqual(s.sent, [0])
  s.watch.report()
  assert.deepEqual(s.sent, [0])
  s.row.childElementCount = 1
  s.row.w = 120
  s.observers[0].cb()
  s.observers[0].cb()
  s.row.childElementCount = 0
  s.observers[0].cb()
  assert.deepEqual(s.sent, [0, 120, 0])
})

test('strip width: an app without setWidth or without ResizeObserver does not break the page', () => {
  const row = { childElementCount: 1, getBoundingClientRect: () => ({ width: 50 }) }
  const w = watchWidth(row, () => ({ type: 'sessions-strip' }), undefined)
  assert.doesNotThrow(() => w.report())
  assert.doesNotThrow(() => w.stop())
})

test('strip width: stop disconnects the observer', () => {
  const s = setup()
  s.watch.stop()
  assert.equal(s.observers[0].disconnected, true)
})
