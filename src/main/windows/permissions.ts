// What a session answers a page that asks for a browser permission or a device. Kept apart from
// main/index.ts and electron-url-view.ts, which install it, and free of Electron runtime imports
// (types only, the session is passed in) so vitest can pin the rule (test/unit/permissions.test.ts).
//
// Deny by default. Electron answers yes to every permission when a session has no handler, so
// before this rule every page of the default session could get the camera, microphone,
// geolocation, notifications, clipboard read, MIDI, pointer lock, openExternal... The default
// session holds the shell page AND the plugin panels and html overlays it embeds (cc-plugin:,
// cc-overlay: iframes); URL overlays (`ccc overlay --url`) have their own partitions
// (overlays/electron-url-view.ts), which get the same lock-down with no page granted anything.
//
// The shell page's own needs, inventoried (APP_PAGE_PERMISSIONS):
// - 'local-fonts' (window.queryLocalFonts, the font list of Settings › Terminal).
// - Nothing else. Terminal copy and paste are the Edit menu's roles (webContents.copy/paste, the
//   native editing commands; xterm only answers the DOM copy/paste events), which never consult
//   the permission handler; nothing in the renderer or xterm calls navigator.clipboard. Links
//   leave through the `app.openExternal` IPC (main's shell.openExternal), not the 'openExternal'
//   permission. Notifications are main's (ctx.notify, `ccc notify`), not the web API. The window
//   is not fullscreenable from the page. A new need is added to the set, never a wider rule.
//
// Only the shell page's own top frame is granted, as `isAppPage` (router.ts appPageMatcher, which
// pins IPC senders) recognises it: the dev server's origin, or the built index.html file. Both the
// URL and isMainFrame must hold: an iframe of the app page (a plugin panel that navigated to an
// app-looking URL, a frame Electron reports without a URL) is refused. Plugin panels and html
// overlays have no use for any permission: they are `sandbox="allow-scripts"` (an opaque origin)
// with no `allow=` delegation, and privileged things go through main (ctx APIs), which checks who
// asks. Blink's permissions policy already refuses most of them there; this is the main-side half.
import type { Session, WebContents } from 'electron'

/** What the shell page's own top frame may be granted; see the header for why each, and why only these. */
export const APP_PAGE_PERMISSIONS: ReadonlySet<string> = new Set(['local-fonts'])

export interface PermissionAsker {
  /** The asking frame is the window's top frame (not an iframe). */
  isMainFrame: boolean
  /** The URL of the asking frame; undefined when Electron does not say (cross-origin subframes). */
  url: string | undefined
}

/** A matcher that recognises no page: a session where nothing is the app page (url overlays). */
export const NO_APP_PAGE = (): boolean => false

/**
 * Whether to grant `permission` to `asker`. The request handler (a page asks) and the check handler
 * (Chromium reads a permission's state: navigator.permissions.query, and the first step of e.g.
 * queryLocalFonts) both answer with this, so a state the page reads matches what a request gets.
 */
export function allowPermission(permission: string, asker: PermissionAsker, isAppPage: (url: string) => boolean): boolean {
  if (!APP_PAGE_PERMISSIONS.has(permission)) return false
  return asker.isMainFrame && asker.url !== undefined && isAppPage(asker.url)
}

/** The parts of a Session the lock-down touches (a fake stands in for it in unit tests). */
export type LockableSession = Pick<
  Session,
  'setPermissionRequestHandler' | 'setPermissionCheckHandler' | 'setDevicePermissionHandler' | 'setDisplayMediaRequestHandler' | 'on'
>

/** Sessions whose device-chooser listeners are already attached (`on` adds, it does not replace). */
const chooserListened = new WeakSet<object>()

/**
 * Install the deny-by-default rule on `session`: permissions through allowPermission, and every
 * device path that does not go through the permission handler refused. Safe to call again (the
 * set* handlers replace; the listeners are attached once).
 *
 * Device access (WebHID, Web Serial, WebUSB) has its own gates besides the 'hid' / 'serial' /
 * 'usb' permissions: a device permission handler (a previously granted device, which Electron
 * otherwise lets the page keep) and a chooser event, where an app without a listener lets Chromium
 * pick or a later listener select. Both refuse here. Screen capture (getDisplayMedia) has its own
 * handler too; the app does not capture, so it is refused. Bluetooth's chooser is a WebContents
 * event, not a session one: lockDownWebContents.
 */
export function lockDownSession(session: LockableSession, isAppPage: (url: string) => boolean): void {
  session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowPermission(permission, { isMainFrame: details.isMainFrame, url: details.requestingUrl }, isAppPage))
  })
  session.setPermissionCheckHandler((_wc, permission, _origin, details) =>
    allowPermission(permission, { isMainFrame: details.isMainFrame, url: details.requestingUrl }, isAppPage)
  )
  session.setDevicePermissionHandler(() => false)
  session.setDisplayMediaRequestHandler((_request, callback) => callback(null))
  if (chooserListened.has(session)) return
  chooserListened.add(session)
  // preventDefault takes the choice from Chromium; the callback's empty answer cancels it (HID and
  // USB cancel with no id, serial with an empty string; Electron's typings).
  session.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault()
    callback()
  })
  session.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault()
    callback()
  })
  session.on('select-serial-port', (event, _ports, _wc, callback) => {
    event.preventDefault()
    callback('')
  })
}

/** The part of a WebContents the lock-down touches. */
export type LockableWebContents = Pick<WebContents, 'on'>

/**
 * Cancel Web Bluetooth's device chooser on `wc`: without a listener Electron picks the first
 * device it finds for the page. Call once per WebContents (main does it on 'web-contents-created').
 */
export function lockDownWebContents(wc: LockableWebContents): void {
  wc.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault()
    callback('')
  })
}
