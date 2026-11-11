import { describe, expect, it } from 'vitest'
import { addLinkAsk, canAllowLink, dropLinkAsk, linkNoticeAction, linkNoticeUrl, type LinkAsk } from '../../src/renderer/notices/notice-state'

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
