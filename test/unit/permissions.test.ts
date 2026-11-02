// The deny-by-default permission rule (main/windows/permissions.ts): the shell page's own top frame
// gets the inventoried permissions ('local-fonts') and nothing else; every other page and frame
// (plugin panels, html overlays, url overlays, anything unknown) gets nothing, and the device and
// screen-capture paths that bypass the permission handler are refused.
import { describe, expect, it, vi } from 'vitest'
import { appPageMatcher } from '../../src/main/ipc/router'
import {
  allowPermission,
  APP_PAGE_PERMISSIONS,
  lockDownSession,
  lockDownWebContents,
  NO_APP_PAGE,
  type LockableSession,
  type LockableWebContents
} from '../../src/main/windows/permissions'

const built = appPageMatcher({ kind: 'file', path: '/Applications/cc.app/out/renderer/index.html' })
const dev = appPageMatcher({ kind: 'url', url: 'http://localhost:5173/' })
const BUILT_PAGE = 'file:///Applications/cc.app/out/renderer/index.html'

// Everything Electron 45 can ask a handler about, less the one the app page uses.
const OTHERS = [
  'clipboard-read',
  'clipboard-sanitized-write',
  'deprecated-sync-clipboard-read',
  'display-capture',
  'fileSystem',
  'fullscreen',
  'geolocation',
  'hid',
  'idle-detection',
  'keyboardLock',
  'local-network-access',
  'media',
  'mediaKeySystem',
  'midi',
  'midiSysex',
  'notifications',
  'openExternal',
  'persistent-storage',
  'pointerLock',
  'screen-wake-lock',
  'serial',
  'storage-access',
  'usb',
  'window-management',
  'unknown'
]

describe('allowPermission', () => {
  it('inventories local-fonts only', () => {
    expect([...APP_PAGE_PERMISSIONS]).toEqual(['local-fonts'])
  })

  it.each([
    ['the built shell page', built, BUILT_PAGE, true, true],
    ['the built page with a hash', built, `${BUILT_PAGE}#x`, true, true],
    ['the dev server page', dev, 'http://localhost:5173/', true, true],
    ['an iframe even on the app page', built, BUILT_PAGE, false, false],
    ['a plugin panel', built, 'cc-plugin://a.one/panels/x.html', false, false],
    ['a plugin panel claiming the top frame', built, 'cc-plugin://a.one/panels/x.html', true, false],
    ['an html overlay', built, 'cc-overlay://abc/', false, false],
    ['a web page', dev, 'https://example.com/', true, false],
    ['another file', built, 'file:///tmp/evil.html', true, false],
    ['another dev-server port', dev, 'http://localhost:5174/', true, false],
    ['a frame whose url is unknown', built, undefined, true, false]
  ])('local-fonts: %s', (_name, isAppPage, url, isMainFrame, expected) => {
    expect(allowPermission('local-fonts', { isMainFrame, url }, isAppPage)).toBe(expected)
  })

  it.each(OTHERS)('denies %s even to the shell page itself', (permission) => {
    expect(allowPermission(permission, { isMainFrame: true, url: BUILT_PAGE }, built)).toBe(false)
    expect(allowPermission(permission, { isMainFrame: true, url: 'http://localhost:5173/' }, dev)).toBe(false)
  })

  it.each([
    ['a plugin panel', 'cc-plugin://a.one/panels/x.html', false],
    ['a plugin panel claiming the top frame', 'cc-plugin://a.one/panels/x.html', true],
    ['an html overlay', 'cc-overlay://abc/', false],
    ['an https url overlay', 'https://example.com/', true],
    ['an http url overlay', 'http://127.0.0.1:8080/', true],
    ['an unknown frame', undefined, false]
  ])('denies everything to %s', (_name, url, isMainFrame) => {
    for (const permission of ['local-fonts', ...OTHERS]) {
      expect(allowPermission(permission, { isMainFrame, url }, built)).toBe(false)
    }
  })

  it('grants nothing where no page is the app page (url overlay partitions), even its own url', () => {
    expect(allowPermission('local-fonts', { isMainFrame: true, url: BUILT_PAGE }, NO_APP_PAGE)).toBe(false)
    expect(allowPermission('local-fonts', { isMainFrame: true, url: 'http://localhost:5173/' }, NO_APP_PAGE)).toBe(false)
  })
})

/** A recording stand-in for the Session parts lockDownSession touches. */
function fakeSession() {
  const h: {
    request?: (wc: unknown, permission: string, callback: (granted: boolean) => void, details: unknown) => void
    check?: (wc: unknown, permission: string, origin: string, details: unknown) => boolean
    device?: (details: unknown) => boolean
    display?: (request: unknown, callback: (streams: unknown) => void) => void
    events: Map<string, ((...args: unknown[]) => void)[]>
  } = { events: new Map() }
  const session = {
    setPermissionRequestHandler: (fn: typeof h.request) => (h.request = fn),
    setPermissionCheckHandler: (fn: typeof h.check) => (h.check = fn),
    setDevicePermissionHandler: (fn: typeof h.device) => (h.device = fn),
    setDisplayMediaRequestHandler: (fn: typeof h.display) => (h.display = fn),
    on: (event: string, fn: (...args: unknown[]) => void) => {
      h.events.set(event, [...(h.events.get(event) ?? []), fn])
      return session
    }
  }
  return { session: session as unknown as LockableSession, h }
}

/** What the request handler answers, through its callback. */
function requested(h: ReturnType<typeof fakeSession>['h'], permission: string, isMainFrame: boolean, url: string | undefined) {
  let granted: boolean | undefined
  h.request!(null, permission, (g) => (granted = g), { isMainFrame, requestingUrl: url })
  return granted
}

describe('lockDownSession', () => {
  it('request and check handlers answer as allowPermission, the check mirroring the request', () => {
    const { session, h } = fakeSession()
    lockDownSession(session, built)
    const cases: [string, boolean, string | undefined][] = [
      ['local-fonts', true, BUILT_PAGE],
      ['local-fonts', false, BUILT_PAGE],
      ['local-fonts', true, 'cc-plugin://a.one/x.html'],
      ['local-fonts', true, undefined],
      ['notifications', true, BUILT_PAGE],
      ['geolocation', false, 'cc-overlay://abc/'],
      ['clipboard-read', true, 'https://example.com/']
    ]
    for (const [permission, isMainFrame, url] of cases) {
      const expected = allowPermission(permission, { isMainFrame, url }, built)
      expect(requested(h, permission, isMainFrame, url)).toBe(expected)
      expect(h.check!(null, permission, '', { isMainFrame, requestingUrl: url })).toBe(expected)
    }
    expect(requested(h, 'local-fonts', true, BUILT_PAGE)).toBe(true)
  })

  it('refuses devices and screen capture and cancels every device chooser', () => {
    const { session, h } = fakeSession()
    lockDownSession(session, built)
    expect(h.device!({ deviceType: 'hid', origin: 'file://' })).toBe(false)
    const display = vi.fn()
    h.display!({}, display)
    expect(display).toHaveBeenCalledWith(null)

    for (const [event, args, cancel] of [
      ['select-hid-device', [{ deviceList: [{ deviceId: 'd1' }] }], []],
      ['select-usb-device', [{ deviceList: [{ deviceId: 'd1' }] }], []],
      ['select-serial-port', [[{ portId: 'p1' }], null], ['']]
    ] as const) {
      const listeners = h.events.get(event) ?? []
      expect(listeners, event).toHaveLength(1)
      const preventDefault = vi.fn()
      const callback = vi.fn()
      listeners[0]!({ preventDefault }, ...args, callback)
      expect(preventDefault, event).toHaveBeenCalled()
      expect(callback, event).toHaveBeenCalledWith(...cancel)
    }
  })

  it('attaches the chooser listeners once when called again, and the later rule wins', () => {
    const { session, h } = fakeSession()
    lockDownSession(session, built)
    lockDownSession(session, NO_APP_PAGE)
    expect(h.events.get('select-hid-device')).toHaveLength(1)
    expect(requested(h, 'local-fonts', true, BUILT_PAGE)).toBe(false)
  })
})

describe('lockDownWebContents', () => {
  it('cancels the Web Bluetooth chooser instead of letting Electron pick the first device', () => {
    const listeners: ((...args: unknown[]) => void)[] = []
    const wc = { on: (event: string, fn: (...args: unknown[]) => void) => (event === 'select-bluetooth-device' && listeners.push(fn), wc) }
    lockDownWebContents(wc as unknown as LockableWebContents)
    expect(listeners).toHaveLength(1)
    const preventDefault = vi.fn()
    const callback = vi.fn()
    listeners[0]!({ preventDefault }, [{ deviceId: 'b1', deviceName: 'x' }], callback)
    expect(preventDefault).toHaveBeenCalled()
    expect(callback).toHaveBeenCalledWith('')
  })
})
