import { describe, expect, it } from 'vitest'
import type { SessionDetail, TabInfo } from '../../src/shared/ipc'
import { DELIVER_ANYWAY_LABEL, deliverHeldText, heldBadge, MARK_LABEL, roomMarker, roomMenuItems, ROOM_VIEW_LABEL } from '../../src/renderer/tabs/tab-room'
import type { DeliverHeldWhy } from '../../src/shared/tab-room'

const ROOM_ID = '0b0f7c1e-3c59-4f0e-9b7e-2f6f3d8a1c42'

function tab(over: Partial<TabInfo> = {}): TabInfo {
  return { id: 't1', kind: 'claude', cwd: '/w', gen: 1, ...over } as TabInfo
}

function member(over: { mark?: boolean; coordinator?: boolean } = {}): TabInfo {
  return tab({ room: { id: ROOM_ID, name: 'bob', coordinator: over.coordinator ?? false, mark: over.mark ?? false } })
}

function detail(over: Partial<SessionDetail> = {}): SessionDetail {
  return { tabId: 't1', status: 'waiting', notes: [], files: [], queue: [], ...over }
}

const inRoom = (over: Partial<SessionDetail> = {}): SessionDetail =>
  detail({ room: { title: 'Release prep', name: 'bob', coordinator: false }, ...over })

describe('roomMarker', () => {
  it('shows the name, with the room title and role in the tooltip', () => {
    expect(roomMarker(member(), inRoom())).toEqual({ name: 'bob', tooltip: 'Room "Release prep" as bob' })
    expect(roomMarker(member({ coordinator: true }), inRoom())?.tooltip).toBe('Room "Release prep" as bob, coordinator')
  })

  it('says when the mark is on, and works before the snapshot has the title', () => {
    expect(roomMarker(member({ mark: true }), inRoom())?.tooltip).toBe(
      'Room "Release prep" as bob\nRoom messages are delivered automatically'
    )
    expect(roomMarker(member(), undefined)).toEqual({ name: 'bob', tooltip: 'In a room as bob' })
  })

  it('is absent for a tab in no room (by its tab record, whatever a late snapshot says) and for other kinds', () => {
    expect(roomMarker(tab(), inRoom())).toBeUndefined()
    expect(roomMarker({ ...member(), kind: 'shell' }, inRoom())).toBeUndefined()
  })
})

describe('heldBadge', () => {
  it('counts what waits and says a click delivers', () => {
    const badge = heldBadge(member(), inRoom({ held: 3 }))
    expect(badge?.text).toBe('3')
    expect(badge?.label).toBe('3 room messages waiting: deliver now')
    expect(badge?.tooltip).toContain('Click to have Claude read them now.')
    expect(heldBadge(member(), inRoom({ held: 1 }))?.label).toBe('1 room message waiting: deliver now')
  })

  it('caps the drawn count at 99+', () => {
    expect(heldBadge(member(), inRoom({ held: 99 }))?.text).toBe('99')
    expect(heldBadge(member(), inRoom({ held: 100 }))?.text).toBe('99+')
  })

  it('says why a typed tab without the mark waits for the person, and names the menu entry', () => {
    const typed = heldBadge(member(), inRoom({ held: 2, typed: true }))?.tooltip
    expect(typed).toContain('you typed in this tab')
    expect(typed).toContain(MARK_LABEL)
    // Untyped: the pointer comes on its own at the next chance.
    const untyped = heldBadge(member(), inRoom({ held: 2 }))
    expect(untyped?.tooltip).toContain('when it next stops or waits for input')
    expect(untyped?.tooltip).not.toContain('you typed')
    // Marked and typed: the Stop pointer always, the gate's only with nothing the person typed unsent (the draft bit).
    const marked = heldBadge(member({ mark: true }), inRoom({ held: 2, typed: true }))
    expect(marked?.tooltip).toContain('when it next stops, or when it waits for input with nothing you typed unsent')
    expect(marked?.tooltip).not.toContain('Held: you typed')
  })

  it('is absent with nothing held, a junk count, no room or another kind', () => {
    expect(heldBadge(member(), inRoom())).toBeUndefined()
    expect(heldBadge(member(), inRoom({ held: 0 }))).toBeUndefined()
    expect(heldBadge(member(), inRoom({ held: 1.5 }))).toBeUndefined()
    expect(heldBadge(member(), undefined)).toBeUndefined()
    expect(heldBadge(tab(), inRoom({ held: 2 }))).toBeUndefined()
    expect(heldBadge({ ...member(), kind: 'command' }, inRoom({ held: 2 }))).toBeUndefined()
  })
})

describe('roomMenuItems', () => {
  it('offers the mark (checked as stored) and the room view for a member tab', () => {
    expect(roomMenuItems(member(), { roomView: true })).toEqual([
      { id: 'mark', label: MARK_LABEL, checked: false, description: expect.stringContaining('wait behind its badge') },
      { id: 'room', label: ROOM_VIEW_LABEL }
    ])
    expect(roomMenuItems(member({ mark: true }), { roomView: true })[0]).toMatchObject({ id: 'mark', checked: true })
  })

  it('leaves out "Room..." when the view cannot open it, and everything for a tab in no room', () => {
    expect(roomMenuItems(member(), { roomView: false }).map((i) => i.id)).toEqual(['mark'])
    expect(roomMenuItems(tab(), { roomView: true })).toEqual([])
    expect(roomMenuItems({ ...member(), kind: 'shell' }, { roomView: true })).toEqual([])
  })
})

describe('deliverHeldText', () => {
  it('names every reason a badge click put nothing in', () => {
    const whys: DeliverHeldWhy[] = ['no-room', 'nothing-held', 'paused', 'draft', 'ended', 'permission', 'busy']
    const texts = whys.map(deliverHeldText)
    expect(new Set(texts).size).toBe(whys.length)
    expect(deliverHeldText('paused')).toMatch(/paused/)
    // A draft: main cannot see the box, so the text names the way out instead of "clear it".
    expect(deliverHeldText('draft')).toMatch(/may hold unsent text/)
    expect(deliverHeldText('draft')).toContain(`"${DELIVER_ANYWAY_LABEL}"`)
    expect(deliverHeldText('draft')).not.toMatch(/clear it/)
    // Not waiting has three distinct reasons: only "busy" says Claude is busy.
    expect(deliverHeldText('busy')).toMatch(/busy/)
    expect(deliverHeldText('ended')).toMatch(/not running/)
    expect(deliverHeldText('permission')).toMatch(/answer/)
    for (const why of ['ended', 'permission'] as const) expect(deliverHeldText(why)).not.toMatch(/busy/)
  })
})
