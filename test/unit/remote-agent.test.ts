// The remote desktop window's user agent suffix (design-remote-desktop.md §5.2, plan Task 2).
import { describe, expect, it } from 'vitest'
import { DESKTOP_UA_TOKEN, desktopAgentSuffix, parseDesktopAgent } from '../../src/shared/remote-agent'

const BASE = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

describe('parseDesktopAgent', () => {
  it('reads the version and the hostname from the suffix', () => {
    expect(parseDesktopAgent(`${BASE} cc-cockpit-desktop/0.17.0 (laptop)`)).toEqual({ version: '0.17.0', hostname: 'laptop' })
    expect(parseDesktopAgent(`cc-cockpit-desktop/1.2.3 (my-box.local) Safari/1`)).toEqual({ version: '1.2.3', hostname: 'my-box.local' })
  })

  it('is undefined without the token, the parentheses or the pieces', () => {
    expect(parseDesktopAgent(BASE)).toBeUndefined()
    expect(parseDesktopAgent('')).toBeUndefined()
    expect(parseDesktopAgent(`${DESKTOP_UA_TOKEN}1.0`)).toBeUndefined()
    expect(parseDesktopAgent(`${DESKTOP_UA_TOKEN}1.0 laptop`)).toBeUndefined()
    expect(parseDesktopAgent(`${DESKTOP_UA_TOKEN}1.0 (laptop`)).toBeUndefined()
    expect(parseDesktopAgent(`${DESKTOP_UA_TOKEN}1.0 ()`)).toBeUndefined()
    expect(parseDesktopAgent(`${DESKTOP_UA_TOKEN} (laptop)`)).toBeUndefined()
  })

  it('refuses an oversize version or hostname', () => {
    expect(parseDesktopAgent(`${DESKTOP_UA_TOKEN}${'1'.repeat(32)} (h)`)?.version).toHaveLength(32)
    expect(parseDesktopAgent(`${DESKTOP_UA_TOKEN}${'1'.repeat(33)} (h)`)).toBeUndefined()
    expect(parseDesktopAgent(`${DESKTOP_UA_TOKEN}1.0 (${'h'.repeat(64)})`)?.hostname).toHaveLength(64)
    expect(parseDesktopAgent(`${DESKTOP_UA_TOKEN}1.0 (${'h'.repeat(65)})`)).toBeUndefined()
  })

  it('refuses control characters and non-ASCII text', () => {
    expect(parseDesktopAgent(`${DESKTOP_UA_TOKEN}1.0 (lap\u0007top)`)).toBeUndefined()
    expect(parseDesktopAgent(`${DESKTOP_UA_TOKEN}1.0 (lap\ntop)`)).toBeUndefined()
    expect(parseDesktopAgent(`${DESKTOP_UA_TOKEN}1.\u00000 (laptop)`)).toBeUndefined()
    expect(parseDesktopAgent(`${DESKTOP_UA_TOKEN}1.0 (lap‮top)`)).toBeUndefined()
    expect(parseDesktopAgent(`${DESKTOP_UA_TOKEN}1.0 (lap\u007ftop)`)).toBeUndefined()
  })

  it('refuses an opening parenthesis inside the hostname', () => {
    expect(parseDesktopAgent(`${DESKTOP_UA_TOKEN}1.0 (a(b)c)`)).toBeUndefined()
  })
})

describe('desktopAgentSuffix', () => {
  it('round-trips a plain version and hostname', () => {
    expect(parseDesktopAgent(desktopAgentSuffix('0.17.0', 'laptop'))).toEqual({ version: '0.17.0', hostname: 'laptop' })
  })

  it('drops parentheses, spaces, control characters and non-ASCII text, and caps the lengths', () => {
    const suffix = desktopAgentSuffix('1.0 (x)\n', 'my (work)\u0007 laptopé'.padEnd(200, 'z'))
    const parsed = parseDesktopAgent(suffix)
    expect(parsed?.version).toBe('1.0x')
    expect(parsed?.hostname).toHaveLength(64)
    expect(parsed?.hostname.startsWith('mywork')).toBe(true)
    expect(desktopAgentSuffix('v'.repeat(100), 'h')).toBe(`${DESKTOP_UA_TOKEN}${'v'.repeat(32)} (h)`)
  })
})
