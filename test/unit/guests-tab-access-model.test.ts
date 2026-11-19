import { describe, expect, it } from 'vitest'
import type { GuestView } from '../../src/shared/guests'
import type { TabInfo } from '../../src/shared/ipc'
import { shareItems, tabControls } from '../../src/renderer/guests/tab-access-model'
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
      { guestId: 'g-sel', label: 'Share with Sel', checked: true },
      { guestId: 'g-other', label: 'Share with Other', checked: false },
      { guestId: 'g-pending', label: 'Share with Pending', checked: false }
    ])
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
  it('names the guest that opened a tab, nothing otherwise', () => {
    expect(openedByGuestLine(tab({ openedByGuest: 'Ada' }))).toBe('Opened by guest Ada')
    expect(openedByGuestLine(tab())).toBeUndefined()
    expect(openedByGuestLine(tab({ openedByGuest: '' }))).toBeUndefined()
  })
})
