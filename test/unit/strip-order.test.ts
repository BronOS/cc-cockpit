import { describe, expect, it } from 'vitest'
import type { SessionStripEntry, TabStatus } from '../../src/shared/ipc'
import { orderStrip, otherWindowsEntries, topStripClass, statusLabel, statusText, stripText } from '../../src/renderer/status/strip-order'

// The strip components themselves need a DOM; they are covered end to end in
// test/e2e/top-strip.spec.ts.

const entry = (tabId: string, status: TabStatus, extra: Partial<SessionStripEntry> = {}): SessionStripEntry => ({
  tabId,
  projectName: 'p',
  status,
  ...extra
})

const ids = (entries: SessionStripEntry[]): string[] => entries.map((e) => e.tabId)

describe('orderStrip', () => {
  it('sorts needs-permission, then waiting, then working, then idle, then ended', () => {
    const sorted = orderStrip([
      entry('ended', 'ended'),
      entry('idle', 'idle'),
      entry('working', 'working'),
      entry('waiting', 'waiting'),
      entry('perm', 'needs-permission')
    ])
    expect(ids(sorted)).toEqual(['perm', 'waiting', 'working', 'idle', 'ended'])
  })

  it('is stable by the input (tab) order inside one status', () => {
    const sorted = orderStrip([
      entry('w1', 'working'),
      entry('p1', 'needs-permission'),
      entry('w2', 'working'),
      entry('p2', 'needs-permission'),
      entry('w3', 'working')
    ])
    expect(ids(sorted)).toEqual(['p1', 'p2', 'w1', 'w2', 'w3'])
  })

  it('ranks starting with idle, by tab order', () => {
    expect(ids(orderStrip([entry('i', 'idle'), entry('s', 'starting'), entry('w', 'working')]))).toEqual([
      'w',
      'i',
      's'
    ])
    expect(ids(orderStrip([entry('s', 'starting'), entry('i', 'idle')]))).toEqual(['s', 'i'])
  })

  it('does not mutate its input, and handles an empty list', () => {
    const input = [entry('a', 'ended'), entry('b', 'waiting')]
    const copy = [...input]
    orderStrip(input)
    expect(input).toEqual(copy)
    expect(orderStrip([])).toEqual([])
  })

  it('ranks every status', () => {
    const all: TabStatus[] = ['starting', 'idle', 'working', 'needs-permission', 'waiting', 'ended']
    for (const status of all) expect(orderStrip([entry('x', status)])).toHaveLength(1)
  })
})

describe('stripText', () => {
  it('is `project · status · tool`, without the tool when there is none', () => {
    expect(stripText(entry('a', 'working', { projectName: 'alpha', tool: 'Bash' }))).toBe(
      'alpha · working · Bash'
    )
    expect(stripText(entry('a', 'needs-permission', { projectName: 'alpha' }))).toBe(
      'alpha · needs permission'
    )
    expect(statusLabel('waiting')).toBe('waiting for input')
  })

  it('a dialog tool in needs-permission reads as needing you, not as a permission', () => {
    expect(stripText(entry('a', 'needs-permission', { projectName: 'alpha', tool: 'AskUserQuestion' }))).toBe(
      'alpha · needs you · question'
    )
    expect(statusText('needs-permission', 'ExitPlanMode')).toBe('needs you · plan approval')
    expect(statusText('needs-permission', 'Bash')).toBe('needs permission · Bash')
    // Only a needs-permission tab: a stale tool name on another status is shown as it is.
    expect(statusText('working', 'AskUserQuestion')).toBe('working · AskUserQuestion')
    expect(statusText('idle')).toBe('idle')
  })
})

describe('otherWindowsEntries', () => {
  it('drops the entries of this window\'s own tabs and keeps the others', () => {
    const strip = [entry('mine1', 'idle'), entry('theirs', 'working'), entry('mine2', 'waiting')]
    expect(ids(otherWindowsEntries(strip, [{ tabId: 'mine1' }, { tabId: 'mine2' }]))).toEqual(['theirs'])
  })

  it('keeps everything when the window has no sessions of its own', () => {
    const strip = [entry('a', 'idle'), entry('b', 'ended')]
    expect(ids(otherWindowsEntries(strip, []))).toEqual(['a', 'b'])
  })

  it('is empty when only this window has sessions, or none exist', () => {
    expect(otherWindowsEntries([entry('mine', 'idle')], [{ tabId: 'mine' }])).toEqual([])
    expect(otherWindowsEntries([], [])).toEqual([])
  })
})

describe('topStripClass', () => {
  it('reserves the traffic lights room on the macOS bar and collapses it in full screen', () => {
    expect(topStripClass(true, false)).toBe('top-strip title-bar')
    expect(topStripClass(true, true)).toBe('top-strip title-bar full-screen')
  })

  it('ignores full screen where the native title bar stays', () => {
    expect(topStripClass(false, true)).toBe('top-strip')
    expect(topStripClass(false, false)).toBe('top-strip')
  })
})
