import { describe, expect, it } from 'vitest'
import { sameOrigin } from '../../src/main/windows/frame-origin'

describe('sameOrigin (subframe self-navigation guard)', () => {
  it.each([
    ['its own pages and a reload', 'cc-plugin://a.one/panels/x.html', 'cc-plugin://a.one/panels/y.html?z', true],
    ['an overlay page of the same id', 'cc-overlay://abc/page', 'cc-overlay://abc/other', true],
    ["another plugin's page", 'cc-plugin://a.one/x.html', 'cc-plugin://evil.two/x.html', false],
    ['another scheme, same host text', 'cc-plugin://a.one/x.html', 'cc-overlay://a.one/x.html', false],
    ['the network', 'cc-plugin://a.one/x.html', 'https://a.one/x.html', false],
    ['a frame whose url is unknown', undefined, 'cc-plugin://a.one/x.html', false],
    ['an unparsable source', 'not a url', 'cc-plugin://a.one/x.html', false],
    ['an unparsable target', 'cc-plugin://a.one/x.html', '::::', false],
    ['an opaque source (about:blank)', 'about:blank', 'about:blank', false],
    ['data: to data:', 'data:text/html,a', 'data:text/html,b', false],
    ['an empty host on both sides', 'cc-plugin:///x.html', 'cc-plugin:///y.html', false]
  ])('%s', (_name, from, to, expected) => {
    expect(sameOrigin(from, to)).toBe(expected)
  })
})
