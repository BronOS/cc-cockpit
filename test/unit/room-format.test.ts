// `ccc room` output (src/cli/room-format.ts) over a hostile reply: main's reply is trusted in shape, but a title or a
// name comes from other sessions and a reply of the wrong shape must print as little as it can, never throw.
import { describe, expect, it } from 'vitest'
import { formatRoomDocs, formatRoomJoin, formatRoomSend, formatRoomStatus } from '../../src/cli/room-format'

// The caller's `plain`: control characters become spaces (here only the one the tests use).
const plain = (value: unknown): string => String(value).replaceAll('\n', ' ')

describe('formatRoomSend', () => {
  it('words each held reason, and prints an unknown one through plain', () => {
    const held = (why: unknown): string => formatRoomSend({ delivery: [{ to: 'bob', path: 'held', why }] }, plain)
    expect(held('paused')).toBe('bob: held (the room is paused); it reads the message with ccc room read\n')
    expect(held('capped')).toContain('it had 5 room pointers in a row')
    expect(held('not-waiting')).toContain('it is busy')
    expect(held('idle')).toContain('will not take it by itself')
    expect(held('idle')).toContain('ccc room read')
    expect(held('a\nb')).toContain('(a b)')
    expect(held(undefined)).toBe('bob: held; it reads the message with ccc room read\n')
  })

  it('prints an unknown path value as it is and skips entries that are not objects', () => {
    expect(formatRoomSend({ delivery: ['x', null, { to: 'bob', path: 'later\nnow' }] }, plain)).toBe('bob: later now\n')
  })

  it('says nobody is there for an empty or malformed reply', () => {
    for (const bad of [{ delivery: [] }, {}, null, 'x']) expect(formatRoomSend(bad, plain)).toBe('nobody else is in the room; nothing sent\n')
  })

  it('flattens control characters in a name', () => {
    expect(formatRoomSend({ delivery: [{ to: 'a\nb', path: 'delivered' }] }, plain)).toBe('a b: delivered\n')
  })
})

describe('formatRoomStatus', () => {
  it('is "not in a room" for anything that is not a room reply', () => {
    for (const bad of [null, 'x', {}, { room: 'x' }]) expect(formatRoomStatus(bad, plain)).toBe('not in a room\n')
  })

  it('skips a member that is not an object and counts a non-finite held as none', () => {
    const out = formatRoomStatus(
      { room: { title: 'T\nU', paused: true }, name: 'me', held: Number.POSITIVE_INFINITY, members: ['x', null, { name: 'bob\nx', status: 'waiting', held: Number.NaN }] },
      plain
    )
    expect(out).toBe('room "T U" (paused)\nyou: me, 0 message(s) held for you\nmembers:\n  bob x: waiting\n')
  })
})

describe('formatRoomDocs and formatRoomJoin', () => {
  it('prints no docs for a wrong shape and zero for a bad size', () => {
    expect(formatRoomDocs({ docs: 'x' }, plain)).toBe('no docs\n')
    expect(formatRoomDocs({ docs: [1, { path: 'shared/a.md', size: 'big' }] }, plain)).toBe('shared/a.md\t0\n')
  })

  it('prints a join line with empty words for a wrong reply', () => {
    expect(formatRoomJoin(null, plain)).toBe('joined room "" as \n')
    expect(formatRoomJoin({ name: 'bob\nx', title: 'T', coordinator: true }, plain)).toBe('joined room "T" as bob x (coordinator)\n')
  })
})
