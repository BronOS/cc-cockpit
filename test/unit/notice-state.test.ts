import { describe, expect, it } from 'vitest'
import {
  addLinkAsk,
  canAllowLink,
  dropLinkAsk,
  dropUnseen,
  linkNoticeAction,
  linkNoticeUrl,
  noteUnseen,
  nextTitleMark,
  titleWithMark,
  type LinkAsk
} from '../../src/renderer/notices/notice-state'

const ask = (n: number): LinkAsk => ({ requestId: `link-${n}`, id: 'x.p', name: 'P', path: '/p', caller: 'tab' })

describe('linkNoticeUrl', () => {
  it('keeps an http(s) address only', () => {
    expect(linkNoticeUrl({ url: 'https://example.com/x' })).toBe('https://example.com/x')
    expect(linkNoticeUrl({ url: 'HTTP://localhost:3000' })).toBe('HTTP://localhost:3000')
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', ' https://x', '', 42, undefined]) {
      expect(linkNoticeUrl({ url })).toBeUndefined()
    }
    expect(linkNoticeUrl(undefined)).toBeUndefined()
    expect(linkNoticeUrl(null)).toBeUndefined()
  })
})

describe('linkNoticeAction', () => {
  const url = 'https://example.com/x'
  it('opens at once in a browser view while the click still counts, else shows the notice', () => {
    expect(linkNoticeAction({ url }, { webShell: true, activationActive: true })).toEqual({ kind: 'open', url })
    expect(linkNoticeAction({ url }, { webShell: true, activationActive: false })).toEqual({ kind: 'notice', url })
  })
  it('never opens on the desktop', () => {
    expect(linkNoticeAction({ url }, { webShell: false, activationActive: true })).toEqual({ kind: 'notice', url })
  })
  it('neither opens nor shows an address linkNoticeUrl refuses', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', '', 42, undefined]) {
      for (const activationActive of [true, false]) {
        expect(linkNoticeAction({ url: bad }, { webShell: true, activationActive })).toEqual({ kind: 'none' })
      }
    }
    expect(linkNoticeAction(null, { webShell: true, activationActive: true })).toEqual({ kind: 'none' })
  })
})

describe('link ask queue', () => {
  it('adds an ask once (same array on a repeat) and drops it by id', () => {
    const one = addLinkAsk([], ask(1))
    expect(addLinkAsk(one, { ...ask(1), name: 'other' })).toBe(one)
    const two = addLinkAsk(one, ask(2))
    expect(two.map((a) => a.requestId)).toEqual(['link-1', 'link-2'])
    expect(dropLinkAsk(two, 'link-1').map((a) => a.requestId)).toEqual(['link-2'])
    expect(dropLinkAsk(two, 'link-9')).toEqual(two)
  })
})

describe('canAllowLink', () => {
  it('offers Allow on the desktop only', () => {
    expect(canAllowLink(false)).toBe(true)
    expect(canAllowLink(true)).toBe(false)
    // A server's browser view is the owner (design-web.md §9.6); the hint never matters on the desktop.
    expect(canAllowLink(true, true)).toBe(true)
    expect(canAllowLink(false, false)).toBe(true)
  })
})

// design-web.md §9.9: a notice that came while the browser tab was in the background is counted in
// the tab's title until the tab is shown.
describe('the title mark of unseen in-page notices', () => {
  it('counts unseen notices in front of the page title, and leaves it alone with none', () => {
    expect(titleWithMark('cc-cockpit', 0)).toBe('cc-cockpit')
    expect(titleWithMark('cc-cockpit', 2)).toBe('(2) cc-cockpit')
  })

  // Review finding (task 21): the base was read once at mount, so a later title change was overwritten
  // by the mark and reverted at unmount.
  it('puts the mark around the current title, adopting one written by someone else meanwhile', () => {
    const first = nextTitleMark('cc-cockpit', undefined, 1)
    expect(first).toEqual({ base: 'cc-cockpit', set: '(1) cc-cockpit' })
    // The title is still the marked one: the old base stays.
    expect(nextTitleMark('(1) cc-cockpit', first, 2)).toEqual({ base: 'cc-cockpit', set: '(2) cc-cockpit' })
    expect(nextTitleMark('(1) cc-cockpit', first, 0)).toEqual({ base: 'cc-cockpit', set: 'cc-cockpit' })
    // Someone renamed the page: that is the new base, never overwritten with the old one.
    expect(nextTitleMark('alpha · cc-cockpit', first, 1)).toEqual({ base: 'alpha · cc-cockpit', set: '(1) alpha · cc-cockpit' })
    // Nothing unseen and no mark yet: the title as it is.
    expect(nextTitleMark('cc-cockpit', undefined, 0)).toEqual({ base: 'cc-cockpit', set: 'cc-cockpit' })
  })

  it('a notice counts only when it came while the page was hidden, once, until it ends', () => {
    const none: ReadonlySet<string> = new Set()
    expect(noteUnseen(none, 'n1', false)).toBe(none)
    const one = noteUnseen(none, 'n1', true)
    expect([...one]).toEqual(['n1'])
    // The bridge's replay and a live event may both carry it: the same set.
    expect(noteUnseen(one, 'n1', true)).toBe(one)
    const two = noteUnseen(one, 'n2', true)
    expect(two.size).toBe(2)
    expect([...dropUnseen(two, 'n1')]).toEqual(['n2'])
    expect(dropUnseen(two, 'nope')).toBe(two)
  })
})
