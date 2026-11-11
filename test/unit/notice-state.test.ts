import { describe, expect, it } from 'vitest'
import {
  addSharedAsk,
  addSignIn,
  MAX_SIGN_IN_NOTICES,
  oauthSignInOf,
  canAllowLink,
  dropSharedAsk,
  dropUnseen,
  endSignIn,
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

// design-web.md §9.9: a plugin's OAuth sign-in in a server's browser is a link notice with a paste box.
describe('oauthSignInOf / addSignIn', () => {
  const id = (n: number): string => `sign-in-id-${String(n).padStart(11, '0')}`
  it('takes an http(s) link with a well-formed sign-in id only; else the plain link notice', () => {
    expect(oauthSignInOf({ url: 'https://idp.example/auth?x=1', signIn: id(1) })).toEqual({ url: 'https://idp.example/auth?x=1', signIn: id(1) })
    expect(oauthSignInOf({ url: 'https://idp.example/auth' })).toBeUndefined()
    for (const signIn of [42, '', 'short', 'x'.repeat(65), 'has spaces in it 12345', '<b>not-an-id</b>xxxx']) {
      expect(oauthSignInOf({ url: 'https://idp.example/auth', signIn })).toBeUndefined()
    }
    expect(oauthSignInOf({ url: 'javascript:alert(1)', signIn: id(1) })).toBeUndefined()
    expect(oauthSignInOf(undefined)).toBeUndefined()
  })
  it('joins once by id; past the cap the oldest ended ones go', () => {
    const one = addSignIn([], { url: 'https://a.example', signIn: id(1) })
    expect(addSignIn(one, { url: 'https://a.example', signIn: id(1) })).toBe(one)
    let list = one
    for (let n = 2; n <= MAX_SIGN_IN_NOTICES; n++) list = endSignIn(addSignIn(list, { url: 'https://b.example', signIn: id(n) }), id(n), false)
    // One pending (1) and three ended (2..4): the next two push out the oldest ended, 2 and 3.
    list = addSignIn(list, { url: 'https://b.example', signIn: id(5) })
    list = addSignIn(list, { url: 'https://b.example', signIn: id(6) })
    expect(list.map((x) => x.signIn)).toEqual([id(1), id(4), id(5), id(6)])
  })
  // External review round 2: another plugin's failed attempts (each one replacing the last, which
  // ends it) evicted a pending sign-in's paste box while main still waited for it.
  it('never drops a pending sign-in, however many ended ones come after it', () => {
    let list = addSignIn([], { url: 'https://a.example', signIn: id(1) })
    for (let n = 2; n < 20; n++) {
      list = addSignIn(list, { url: 'https://b.example', signIn: id(n) })
      list = endSignIn(list, id(n), false)
    }
    expect(list[0]).toEqual({ url: 'https://a.example', signIn: id(1) })
    expect(list.length).toBeLessThanOrEqual(MAX_SIGN_IN_NOTICES)
    // Pending ones only, past the cap: all kept (main bounds them, one per plugin and window).
    let pending: readonly { url: string; signIn: string }[] = []
    for (let n = 1; n <= MAX_SIGN_IN_NOTICES + 2; n++) pending = addSignIn(pending, { url: 'https://c.example', signIn: id(n) })
    expect(pending.map((x) => x.signIn)).toEqual(Array.from({ length: MAX_SIGN_IN_NOTICES + 2 }, (_, i) => id(i + 1)))
  })
  it('a sign-in that ended with a code loses its notice; one that ended otherwise is marked over', () => {
    const list = [
      { url: 'https://a.example', signIn: id(1) },
      { url: 'https://b.example', signIn: id(2) }
    ]
    expect(endSignIn(list, id(1), true)).toEqual([list[1]])
    const over = endSignIn(list, id(2), false)
    expect(over).toEqual([list[0], { url: 'https://b.example', signIn: id(2), ended: true }])
    expect(list[1]).not.toHaveProperty('ended')
    // Already marked, or no such notice in this view: the same array.
    expect(endSignIn(over, id(2), false)).toBe(over)
    expect(endSignIn(list, id(9), true)).toBe(list)
    expect(endSignIn(list, id(9), false)).toBe(list)
    // A code after the mark (a paste answered late in another view) still takes it down.
    expect(endSignIn(over, id(2), true)).toEqual([list[0]])
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
    const one = addSharedAsk([], ask(1))
    expect(addSharedAsk(one, { ...ask(1), name: 'other' })).toBe(one)
    const two = addSharedAsk(one, ask(2))
    expect(two.map((a) => a.requestId)).toEqual(['link-1', 'link-2'])
    expect(dropSharedAsk(two, 'link-1').map((a) => a.requestId)).toEqual(['link-2'])
    expect(dropSharedAsk(two, 'link-9')).toEqual(two)
  })
})

describe('canAllowLink', () => {
  it('offers Allow on the desktop only', () => {
    expect(canAllowLink(false)).toBe(true)
    expect(canAllowLink(true)).toBe(false)
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
