import { describe, expect, it } from 'vitest'
import { isRoomId } from '../../src/shared/room-names'
import { sameTabRoom, tabRoomOf } from '../../src/shared/tab-room'

const ROOM = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed'

describe('tabRoomOf', () => {
  it('reads a saved membership and keeps only the four fields', () => {
    expect(tabRoomOf({ id: ROOM, name: 'alice', coordinator: true, mark: true, extra: 'x' })).toEqual({
      id: ROOM,
      name: 'alice',
      coordinator: true,
      mark: true
    })
  })

  it('reads a missing or damaged mark as no mark: only an explicit true lets messages into a typed tab', () => {
    for (const mark of [undefined, 'true', 1, null]) {
      expect(tabRoomOf({ id: ROOM, name: 'alice', coordinator: false, mark })?.mark, String(mark)).toBe(false)
    }
  })

  it('loses the membership for anything else off', () => {
    const bad: unknown[] = [
      undefined,
      null,
      'room',
      [ROOM],
      { name: 'alice', coordinator: false },
      { id: ROOM.toUpperCase(), name: 'alice', coordinator: false },
      { id: `${ROOM}x`, name: 'alice', coordinator: false },
      { id: ROOM, name: 'Alice', coordinator: false },
      { id: ROOM, name: 'all', coordinator: false },
      { id: ROOM, name: 'system', coordinator: false },
      { id: ROOM, name: 'a'.repeat(32), coordinator: false },
      { id: ROOM, name: 'alice' },
      { id: ROOM, name: 'alice', coordinator: 'yes' }
    ]
    for (const raw of bad) expect(tabRoomOf(raw), JSON.stringify(raw)).toBeUndefined()
  })
})

describe('sameTabRoom', () => {
  it('compares every field, and none with none', () => {
    const a = { id: ROOM, name: 'alice', coordinator: false, mark: false }
    expect(sameTabRoom(a, { ...a })).toBe(true)
    expect(sameTabRoom(undefined, undefined)).toBe(true)
    expect(sameTabRoom(a, undefined)).toBe(false)
    expect(sameTabRoom(a, { ...a, mark: true })).toBe(false)
    expect(sameTabRoom(a, { ...a, coordinator: true })).toBe(false)
    expect(sameTabRoom(a, { ...a, name: 'bob' })).toBe(false)
  })
})

describe('isRoomId', () => {
  it('takes a lower-case UUID only', () => {
    expect(isRoomId(ROOM)).toBe(true)
    for (const bad of [ROOM.toUpperCase(), ROOM.replace(/-/g, '_'), ROOM.slice(1), `../${ROOM.slice(3)}`, 42, undefined]) {
      expect(isRoomId(bad), String(bad)).toBe(false)
    }
  })
})
