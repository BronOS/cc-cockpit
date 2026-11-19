import { describe, expect, it } from 'vitest'
import type { GuestView, PresenceSnapshot } from '../../src/shared/guests'
import type { TabInfo } from '../../src/shared/ipc'
import { guestNameOf, shareItems, shareRefusedText, tabControls } from '../../src/renderer/guests/tab-access-model'
import { openedByGuestLine } from '../../src/renderer/tabs/tab-label'

const tab = (over: Partial<TabInfo> = {}): TabInfo => ({ id: 't1', kind: 'shell', cwd: '/p', ...over }) as TabInfo

const guest = (over: Partial<GuestView> & { id: string }): GuestView => ({
  name: over.id,
  role: 'read',
  projectId: 'p1',
  scope: 'all',
  state: 'live',
  until: null,
  ...over
})

describe('tabControls', () => {
  it('gives the owner every control', () => {
    const c = tabControls('owner')
    expect(c.newTab).toBe('all')
    expect([...c.menu]).toEqual(['move', 'rename', 'split', 'room', 'share', 'flag', 'close'])
    expect(c).toMatchObject({ closeButton: true, drag: true, groupMenu: true, roomControls: true })
  })

  it('gives a write guest New tab with Claude and Shell only and Close, nothing else (spec-review 24)', () => {
    const c = tabControls('write')
    expect(c.newTab).toBe('core')
    expect([...c.menu]).toEqual(['close'])
    expect(c).toMatchObject({ closeButton: true, drag: false, groupMenu: false, roomControls: false })
  })

  it('gives a read guest no new tab, no tab menu, no drag, no close', () => {
    const c = tabControls('read')
    expect(c.newTab).toBe('none')
    expect(c.menu.size).toBe(0)
    expect(c).toMatchObject({ closeButton: false, drag: false, groupMenu: false, roomControls: false })
  })
})

describe('shareItems', () => {
  const list = [
    guest({ id: 'g-all', name: 'All', scope: 'all' }),
    guest({ id: 'g-sel', name: 'Sel', scope: ['t1', 't9'] }),
    guest({ id: 'g-other', name: 'Other', scope: ['t2'] }),
    guest({ id: 'g-elsewhere', name: 'Elsewhere', projectId: 'p2', scope: ['t1'] }),
    guest({ id: 'g-pending', name: 'Pending', scope: [], state: 'pending', inviteId: 'i1' })
  ]

  it('lists the selected-tabs guests of this project, checked by their scope', () => {
    expect(shareItems(list, 'p1', tab())).toEqual([
      { guestId: 'g-sel', name: 'Sel', label: 'Share with Sel', checked: true },
      { guestId: 'g-other', name: 'Other', label: 'Share with Other', checked: false },
      { guestId: 'g-pending', name: 'Pending', label: 'Share with Pending', checked: false }
    ])
  })

  it('offers a pending invite like a joined guest, checked by the invite scope main edits (02b)', () => {
    const pending = [guest({ id: 'g-pending', name: 'Pending', scope: ['t1'], state: 'pending', inviteId: 'i1' })]
    expect(shareItems(pending, 'p1', tab())).toEqual([{ guestId: 'g-pending', name: 'Pending', label: 'Share with Pending', checked: true }])
    // Where this view may only narrow, the checked one stays (an untick), an unchecked one goes.
    expect(shareItems(pending, 'p1', tab({ id: 't2' }), false)).toEqual([])
    expect(shareItems(pending, 'p1', tab(), false)).toHaveLength(1)
  })

  it('says in one line that a refused toggle changed nothing, either way', () => {
    expect(shareRefusedText('Ada', true)).toBe('This tab was not shared with Ada: the guest or the invite is gone.')
    expect(shareRefusedText('Ada', false)).toBe('Ada still sees this tab: the guest or the invite is gone.')
  })

  it('reads the scope, not a lagging sharedWith', () => {
    expect(shareItems(list, 'p1', tab({ sharedWith: ['g-other'] })).find((i) => i.guestId === 'g-other')?.checked).toBe(false)
  })

  it('lists nothing before the list or the project is known', () => {
    expect(shareItems(null, 'p1', tab())).toEqual([])
    expect(shareItems(list, undefined, tab())).toEqual([])
  })
})

describe('openedByGuestLine', () => {
  it('names the guest that opened a tab by its id, "a guest" when no list knows it, never the raw id', () => {
    const names = new Map([['g-ada', 'Ada']])
    const nameOf = (id: string): string | undefined => names.get(id)
    expect(openedByGuestLine(tab({ openedByGuest: 'g-ada' }), nameOf)).toBe('Opened by guest Ada')
    expect(openedByGuestLine(tab({ openedByGuest: 'g-gone' }), nameOf)).toBe('Opened by a guest')
    expect(openedByGuestLine(tab({ openedByGuest: 'g-ada' }))).toBe('Opened by a guest')
    expect(openedByGuestLine(tab(), nameOf)).toBeUndefined()
    expect(openedByGuestLine(tab({ openedByGuest: '' }), nameOf)).toBeUndefined()
  })
})

describe('guestNameOf', () => {
  const presence: PresenceSnapshot = {
    seq: 1,
    people: [{ id: 'g-bo', name: 'Bo', role: 'write', color: 1, state: 'live', tabId: null, typing: false }],
    lastTyped: {}
  }
  it('reads the guest list, then presence, then the view own hint', () => {
    expect(guestNameOf('g-ada', [guest({ id: 'g-ada', name: 'Ada' })], presence)).toBe('Ada')
    // A guest view has no guest list: presence names the others.
    expect(guestNameOf('g-bo', null, presence)).toBe('Bo')
    // ...and its own hint names itself (presence may not list it yet).
    expect(guestNameOf('g-me', null, null, { id: 'g-me', name: 'Me' })).toBe('Me')
    expect(guestNameOf('g-gone', [], presence, { id: 'g-me', name: 'Me' })).toBeUndefined()
  })
})
