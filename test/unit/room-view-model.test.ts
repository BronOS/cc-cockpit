import { describe, expect, it } from 'vitest'
import type { RoomView } from '../../src/shared/room-view'
import {
  docRows,
  LOG_TEXT_MAX,
  logRows,
  logText,
  memberRows,
  roomControls,
  sizeText,
  timeText
} from '../../src/renderer/rooms/room-view-model'

const AT = new Date(2026, 10, 15, 9, 5, 7).getTime()

function view(over: Partial<RoomView> = {}): RoomView {
  return {
    id: 'r1',
    title: 'Team',
    pluginId: 'test.rooms',
    createdAt: AT,
    paused: false,
    members: [],
    docs: [],
    log: [],
    logMore: false,
    ...over
  }
}

const desktop = { webShell: false, serverView: false }
const browser = { webShell: true, serverView: false }
const serverBrowser = { webShell: true, serverView: true }

describe('memberRows', () => {
  it('puts coordinators first, then sorts by name', () => {
    const rows = memberRows(
      view({
        members: [
          { name: 'zed', coordinator: false, status: 'working', held: 0, tabId: 't3' },
          { name: 'bob', coordinator: false, status: 'waiting', held: 2, tabId: 't2' },
          { name: 'mia', coordinator: true, status: 'idle', held: 0, tabId: 't1' },
          { name: 'amy', coordinator: true, status: 'no-tab', held: 1 }
        ]
      })
    )
    expect(rows.map((r) => r.name)).toEqual(['amy', 'mia', 'bob', 'zed'])
    expect(rows.map((r) => r.statusText)).toEqual(['No tab', 'Idle', 'Waiting for input', 'Working'])
    expect(rows.map((r) => r.heldText)).toEqual(['1 held', '', '2 held', ''])
    expect(rows[0]).not.toHaveProperty('tabId')
  })

  it('takes the newer status from the sessions snapshot for a member with a tab', () => {
    const v = view({
      members: [
        { name: 'bob', coordinator: false, status: 'waiting', held: 0, tabId: 't2' },
        { name: 'amy', coordinator: false, status: 'no-tab', held: 0 }
      ]
    })
    const live = new Map([
      ['t2', { status: 'needs-permission' as const }],
      ['t9', { status: 'working' as const }]
    ])
    const rows = memberRows(v, live)
    expect(rows.find((r) => r.name === 'bob')).toMatchObject({ status: 'needs-permission', statusText: 'Needs permission' })
    expect(rows.find((r) => r.name === 'amy')).toMatchObject({ status: 'no-tab' })
    // A tab missing from the snapshot keeps the view's status.
    expect(memberRows(v, new Map())[1]).toMatchObject({ name: 'bob', status: 'waiting' })
  })

  it('treats a bad held count as none', () => {
    const rows = memberRows(view({ members: [{ name: 'bob', coordinator: false, status: 'idle', held: -3 }] }))
    expect(rows[0]).toMatchObject({ held: 0, heldText: '' })
  })
})

describe('docRows and sizes', () => {
  it('sorts by path with a readable size', () => {
    const rows = docRows(
      view({
        docs: [
          { path: 'shared/b.md', size: 2048 },
          { path: 'members/bob/notes.md', size: 12 },
          { path: 'shared/a.md', size: 3 * 1024 * 1024 }
        ]
      })
    )
    expect(rows).toEqual([
      { path: 'members/bob/notes.md', sizeText: '12 B' },
      { path: 'shared/a.md', sizeText: '3.0 MiB' },
      { path: 'shared/b.md', sizeText: '2.0 KiB' }
    ])
    expect(sizeText(-1)).toBe('')
  })
})

describe('logRows', () => {
  it('is newest first, each entry one line of text', () => {
    const rows = logRows(
      view({
        log: [
          { seq: 1, at: AT, type: 'create', title: 'Team', pluginId: 'test.rooms' },
          { seq: 2, at: AT, type: 'join', member: 'bob', coordinator: true, via: 'open' },
          { seq: 3, at: AT, type: 'send', from: 'plugin', to: 'bob', text: 'hello' }
        ]
      })
    )
    expect(rows.map((r) => r.seq)).toEqual([3, 2, 1])
    expect(rows.map((r) => r.text)).toEqual(['plugin → bob: hello', 'bob joined as coordinator', 'Room created: Team'])
    expect(rows[0]?.time).toBe('09:05:07')
  })

  it('words every type main writes', () => {
    const e = (type: string, fields: Record<string, unknown> = {}): string => logText({ seq: 1, at: AT, type, ...fields })
    expect(e('invite', { member: 'amy' })).toBe('Invite for amy')
    expect(e('leave', { member: 'bob', why: 'removed' })).toBe('bob left (removed)')
    expect(e('end', { why: 'plugin' })).toBe('Room ended (plugin)')
    expect(e('pause')).toBe('Paused')
    expect(e('auto-pause')).toMatch(/^Paused automatically/)
    expect(e('resume')).toBe('Resumed')
    expect(e('doc-read', { by: 'person', path: 'shared/a.md' })).toBe('person read shared/a.md')
    expect(e('doc-write', { by: 'bob', path: 'shared/a.md' })).toBe('bob wrote shared/a.md')
    expect(e('doc-refused', { by: 'bob', op: 'put', path: 'x', reason: 'bad path' })).toBe('bob: put of x refused (bad path)')
    expect(e('trimmed', { dropped: 40 })).toBe('Older events dropped (40)')
  })

  it('shows unknown and odd fields as text, never as anything else', () => {
    expect(logText({ seq: 1, at: AT, type: 'future', a: 1 })).toBe('future {"a":1}')
    expect(logText({ seq: 1, at: AT, type: 'send', from: 'bob', to: ['a', 'b'], text: { html: '<b>x</b>' } })).toBe(
      'bob → ["a","b"]: {"html":"<b>x</b>"}'
    )
    expect(logText({ seq: 1, at: AT, type: 'join' })).toBe('? joined')
    const long = logText({ seq: 1, at: AT, type: 'send', from: 'bob', to: 'amy', text: 'x'.repeat(5000) })
    expect(long.length).toBe('bob → amy: '.length + LOG_TEXT_MAX + 1)
    expect(long.endsWith('…')).toBe(true)
    expect(timeText(Number.NaN)).toBe('')
  })
})

describe('roomControls', () => {
  it('offers Pause in an active room, Resume in a paused one, nothing to change in an ended one', () => {
    expect(roomControls(view(), desktop)).toMatchObject({ state: 'active', canPause: true, canResume: false, canRemove: true })
    expect(roomControls(view({ paused: true }), desktop)).toMatchObject({ state: 'paused', canPause: false, canResume: true, canRemove: true })
    expect(roomControls(view({ paused: true, endedAt: AT }), desktop)).toMatchObject({
      state: 'ended',
      canPause: false,
      canResume: false,
      canRemove: false
    })
    expect(roomControls(view(), desktop).stateText).toBe('Active · by test.rooms')
  })

  it('reveals and confirms on screen on the desktop only; a server browser acts through main\'s ask', () => {
    expect(roomControls(view(), desktop)).toMatchObject({ canReveal: true, confirmRemove: true })
    expect(roomControls(view(), desktop)).not.toHaveProperty('readOnlyNote')
    expect(roomControls(view(), serverBrowser)).toMatchObject({ canReveal: false, confirmRemove: false, canPause: true, canRemove: true })
  })

  it('is read only in a browser outside server mode', () => {
    const c = roomControls(view({ paused: true }), browser)
    expect(c).toMatchObject({ canPause: false, canResume: false, canRemove: false, canReveal: false })
    expect(c.readOnlyNote).toMatch(/Read only here/)
  })

  it('an empty room has no rows', () => {
    const v = view()
    expect(memberRows(v)).toEqual([])
    expect(docRows(v)).toEqual([])
    expect(logRows(v)).toEqual([])
    expect(roomControls(v, desktop).canRemove).toBe(true)
  })
})
