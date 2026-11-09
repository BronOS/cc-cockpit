'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { Share, LEASE_MS } = require('../dist/lib/share')

/** ctx.appStorage as main keeps it: one store for every host, each call applied whole, values copied. */
function fakeAppStorage() {
  const m = new Map()
  const calls = []
  return {
    m,
    calls,
    get: async (k) => (calls.push(['get', k]), m.has(k) ? structuredClone(m.get(k)) : undefined),
    set: async (k, v) => {
      calls.push(['set', k])
      m.set(k, structuredClone(v))
    },
    delete: async (k) => {
      calls.push(['delete', k])
      m.delete(k)
    },
    keys: async () => [...m.keys()],
    increment: async (k, by = 1) => {
      calls.push(['increment', k])
      const v = m.has(k) ? m.get(k) : 0
      if (typeof v !== 'number') throw new TypeError('not a number')
      m.set(k, v + by)
      return v + by
    }
  }
}

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

test('of several hosts ticking together exactly one takes the lease, and keeps it', async () => {
  const kv = fakeAppStorage()
  const c = clock()
  const hosts = ['a', 'b', 'c'].map((id) => new Share(kv, { hostId: id, now: c.now }))
  const first = await Promise.all(hosts.map((h) => h.tick()))
  assert.equal(first.filter(Boolean).length, 1)
  const leader = hosts[first.indexOf(true)]
  c.advance(LEASE_MS / 2 + 1)
  const again = await Promise.all(hosts.map((h) => h.tick()))
  assert.deepEqual(again, first, 'the leader renews; nobody else claims')
  assert.equal(kv.m.get('lease').owner, leader.hostId)
  // Only the live claim counter is left.
  assert.equal([...kv.m.keys()].filter((k) => k.startsWith('claim:')).length, 1)
})

test('a leader that stops ticking loses the lease once it runs out; one that releases loses it at once', async () => {
  const kv = fakeAppStorage()
  const c = clock()
  const a = new Share(kv, { hostId: 'a', now: c.now })
  const b = new Share(kv, { hostId: 'b', now: c.now })
  assert.equal(await a.tick(), true)
  assert.equal(await b.tick(), false)
  c.advance(LEASE_MS + 1)
  assert.equal(await b.tick(), true, 'taken over after the lease ran out')
  assert.equal(await a.tick(), false, 'the old leader steps down')
  await b.release()
  assert.equal(await a.tick(), true, 'a released lease is free at the next tick')
})

test('a claim a dead host won without writing the lease blocks for one slot only', async () => {
  const kv = fakeAppStorage()
  const c = clock(LEASE_MS * 10)
  // The dead host got claim 1 of this slot and never wrote the lease.
  await kv.increment(`claim:1:${Math.floor(c.now() / LEASE_MS)}`)
  const b = new Share(kv, { hostId: 'b', now: c.now })
  assert.equal(await b.tick(), false)
  c.advance(LEASE_MS)
  assert.equal(await b.tick(), true)
})

test('followers read the published aggregate only when its version moves; pokes reach the leader', async () => {
  const kv = fakeAppStorage()
  const a = new Share(kv, { hostId: 'a' })
  const b = new Share(kv, { hostId: 'b' })
  assert.equal(await b.readIfNew(), null)
  await a.publish({ v: 1, at: 1, days: {} })
  assert.deepEqual(await b.readIfNew(), { v: 1, at: 1, days: {} })
  kv.calls.length = 0
  assert.equal(await b.readIfNew(), null)
  assert.deepEqual(kv.calls, [['get', 'aggVersion']], 'an unchanged version costs one small read')
  assert.equal(await a.readIfNew(), null, 'the publisher knows its own version')

  assert.equal(await a.poked(), false, 'the first look only learns the count')
  await b.poke()
  assert.equal(await a.poked(), true)
  assert.equal(await a.poked(), false)
})
