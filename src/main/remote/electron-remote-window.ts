// Electron adapter for remote desktop windows (design-remote-desktop.md §4, §7): the only code that
// makes a remote server's window and its session partition. Thin on purpose: every decision (which
// requests and navigations, which project, when to re-pair) is remote-windows.ts's, and this file
// only wires the page's events to it (test/unit/electron-remote-window.test.ts, electron stubbed).
//
// The page is the server's web client, so it is treated as a browser tab on an untrusted site:
// - no bridge script, no Node, sandboxed and context-isolated (`webviewPreferences`, the webview
//   panels' own): the page reaches no IPC, no local file, no local Claude tab; DevTools only in an
//   unpacked build;
// - its own `persist:remote-<id>` partition per server, made only here (the grep test
//   no-remote-preload.test.ts keeps that name off every other file): no cookie or storage shared
//   with the shell, a webview panel or another server. Cookies ignore ports, so two servers
//   tunnelled to 127.0.0.1:L1 and :L2 would otherwise share one jar. `persist:` keeps the web
//   client's localStorage (zone sizes); the device cookie is kept out of its database
//   (remote-cookie.ts);
// - the partition locked down like every non-default session (windows/permissions.ts: every
//   permission, device and screen capture denied, notifications included; main's
//   `web-contents-created` handler does the same, this makes it independent of that), downloads
//   cancelled, every loopback request but the server's own origin cancelled (`onBeforeRequest`);
// - the webview panels' page hardening (webview-hardening.ts `hardenWebContents`): window.open
//   denied (an http(s) link to the person's browser under the open budget), main-frame navigation
//   and redirects pinned to the server's origin, `beforeunload` never holds a close, HTTP auth
//   cancelled, a bad certificate refused (no "proceed anyway"), WebRTC kept off non-proxied UDP;
// - the user agent carries `cc-cockpit-desktop/<version> (<hostname>)` (shared/remote-agent.ts):
//   the web client then keeps the desktop's key table and names the device after this machine.
//   Set on the session too, so main's own requests (`fetchJson`) say the same;
// - main's own requests carry the server's origin key (DEVICE_KEY_HEADER) besides the partition's
//   cookie: a cookie alone is signed out (design-web.md §4.1). The key is the page's, read by
//   `readKey` in main's own isolated world (remote-key.ts) and kept by remote-windows.ts; this file only
//   reads it and puts it on a request, never stores or logs it.
import { app, BrowserWindow, nativeTheme, session as electronSession, type Session } from 'electron'
import { hostname } from 'node:os'
import { desktopAgentSuffix } from '../../shared/remote-agent'
import { DEVICE_KEY_HEADER, SESSION_PATH } from '../../shared/web-protocol'
import { BUILTIN_THEMES } from '../themes/theme-service'
import { hardenWebContents, webviewPreferences } from '../webview/webview-hardening'
import { lockDownSession, NO_APP_PAGE } from '../windows/permissions'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH } from '../windows/window-bounds'
import { warnLog } from '../warn-log'
import type { RemoteCookieJar } from './remote-cookie'
import { KEY_READ_TIMEOUT_MS, READ_KEY_SCRIPT, REMOTE_KEY_WORLD_ID } from './remote-key'
import { RemoteHttpError, type RemoteSessionHooks, type RemoteSessionView, type RemoteWindowFactory, type RemoteWindowHooks, type RemoteWindowView } from './remote-windows'

/** The partition of server `serverId`'s windows. The prefix is named in this file only (grep test). */
export function remotePartition(serverId: string): string {
  return `persist:remote-${serverId}`
}

/** How long main's own request to the server (the session check, the project list, a reopen) may take. */
export const REMOTE_FETCH_TIMEOUT_MS = 10_000

/**
 * A response body as text, read as a stream and refused past `maxBytes` (main's own reads of the
 * server's answers: a server that streams without end must not fill main's memory). A
 * `Content-Length` over the cap refuses before reading; the stream is cancelled when it runs over.
 */
export async function readCappedText(res: Pick<Response, 'body' | 'headers'>, maxBytes: number): Promise<string> {
  const tooBig = (): Error => new Error(`the server's answer is larger than ${maxBytes} bytes`)
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined)
    throw tooBig()
  }
  if (res.body === null) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw tooBig()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** `readCappedText` parsed as JSON (a parse error rejects). */
export async function readCappedJson(res: Pick<Response, 'body' | 'headers'>, maxBytes: number): Promise<unknown> {
  return JSON.parse(await readCappedText(res, maxBytes)) as unknown
}

/** `key` as the request header, or no header when there is none (the server then answers signed out). */
function keyHeaders(key: string | undefined): Record<string, string> {
  return key === undefined ? {} : { [DEVICE_KEY_HEADER]: key }
}

/** `promise`, or a rejection after `ms` (the page's script may never answer: a navigation dropped it). */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the page did not answer')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    )
  })
}

/** The partitions this adapter prepared (isRemoteWindow). */
const remoteSessions = new WeakSet<Session>()

/**
 * Whether `win` is a remote server's window. main's app-wide window events
 * (`browser-window-created`, `browser-window-focus`) see these too and must leave them alone: one
 * is never a project window or the picker. Read from the page's session, prepared before the
 * window exists, since `browser-window-created` fires inside the BrowserWindow constructor.
 */
export function isRemoteWindow(win: BrowserWindow): boolean {
  return !win.isDestroyed() && remoteSessions.has(win.webContents.session)
}

/** The built-in theme's background for the OS appearance, painted before the server's page. */
function background(): string {
  const kind = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  return BUILTIN_THEMES.find((t) => t.kind === kind)?.vars['--cc-bg'] ?? (kind === 'dark' ? '#1a1817' : '#faf8f6')
}

/** `url`'s path, or '' when it does not parse. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

export interface ElectronRemoteWindowOptions {
  /** This app's version, for the user agent. */
  version: string
  log?: (message: string) => void
}

export class ElectronRemoteWindowFactory implements RemoteWindowFactory {
  private readonly log: (message: string) => void
  private readonly sessions = new Map<string, { ses: Session; view: RemoteSessionView; userAgent: string }>()

  constructor(private readonly options: ElectronRemoteWindowOptions) {
    this.log = options.log ?? warnLog
  }

  /**
   * Server `serverId`'s partition, prepared once: a session outlives its windows, and `on` adds a
   * listener per call. A second call answers the first one's view (its hooks stay).
   */
  session(serverId: string, hooks: RemoteSessionHooks): RemoteSessionView {
    const known = this.sessions.get(serverId)
    if (known !== undefined) return known.view
    const ses = electronSession.fromPartition(remotePartition(serverId))
    remoteSessions.add(ses)
    lockDownSession(ses, NO_APP_PAGE)
    ses.on('will-download', (event) => event.preventDefault())
    const userAgent = `${ses.getUserAgent()} ${desktopAgentSuffix(this.options.version, hostname())}`
    ses.setUserAgent(userAgent)
    // One listener per session (a second `onBeforeRequest` would replace it): the loopback rule.
    ses.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !hooks.allowRequest(details.url) })
    })
    // The page's own sign-in check finished: a re-pair trigger. Only a page's request (main's own
    // fetchJson has no WebContents, so its check cannot trigger itself).
    ses.webRequest.onCompleted((details) => {
      if (details.webContentsId === undefined || details.method !== 'GET') return
      if (pathOf(details.url) === SESSION_PATH) hooks.sessionRequestCompleted(details.webContentsId)
    })
    const jar: RemoteCookieJar = {
      set: (cookie) => ses.cookies.set(cookie),
      onChanged: (listener) => {
        ses.cookies.on('changed', (_event, cookie, cause, removed) => listener(cookie, cause, removed))
      }
    }
    const view: RemoteSessionView = {
      jar,
      fetchJson: async (url, maxBytes, key) => {
        // The partition's cookies (`include`) and the origin key, never a cached answer, no redirect
        // followed (the gateway sends none; one would be somewhere else), bounded in time and size.
        const res = await ses.fetch(url, {
          credentials: 'include',
          cache: 'no-store',
          redirect: 'error',
          headers: keyHeaders(key),
          signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS)
        })
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined)
          throw new RemoteHttpError(res.status)
        }
        return readCappedJson(res, maxBytes)
      },
      postJson: async (url, body, origin, maxBytes, key) => {
        // As fetchJson, plus what the gateway asks of every POST: the server's own Origin (set
        // explicitly: a request with no page behind it has none to send) and a JSON content type.
        const res = await ses.fetch(url, {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json', Origin: origin, ...keyHeaders(key) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS)
        })
        // Past the cap rejects (the caller loads the page as is); a body that is not JSON is undefined.
        const text = await readCappedText(res, maxBytes)
        let parsed: unknown
        try {
          parsed = JSON.parse(text) as unknown
        } catch {
          parsed = undefined
        }
        return { status: res.status, body: parsed }
      }
    }
    this.sessions.set(serverId, { ses, view, userAgent })
    return view
  }

  create(serverId: string, title: string, hooks: RemoteWindowHooks): RemoteWindowView {
    const prepared = this.sessions.get(serverId)
    // The partition must be locked down and hold the cookie before the window exists.
    if (prepared === undefined) throw new Error('remote: the server\'s session is not prepared')
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      title,
      backgroundColor: background(),
      webPreferences: {
        ...webviewPreferences(remotePartition(serverId)),
        devTools: !app.isPackaged
      }
    })
    const wc = win.webContents
    // As project windows: the menu bar hidden, its accelerators kept (create-window.ts).
    win.setMenuBarVisibility(false)
    // The title is main's (`<server> — <project>`); the web shell's static one would replace it.
    win.on('page-title-updated', (event) => event.preventDefault())
    wc.setUserAgent(prepared.userAgent)
    hardenWebContents(wc, {
      // Sub-frames are the page's own (plugin pages under /p/, overlays under /o/); their requests
      // still pass the loopback rule.
      allowNavigation: (url, isMainFrame) => !isMainFrame || hooks.allowNavigation(url),
      openWindow: (url) => hooks.openWindow(url),
      navigated: (commit) => {
        if (commit && !wc.isDestroyed()) hooks.navigated(wc.getURL())
      },
      loadFailed: (_url, error) => this.log(`remote ${serverId}: the page did not load: ${error}`),
      chord: () => false,
      // A crashed page stays in its window until the person reloads or closes it.
      gone: () => undefined
    })
    wc.on('did-finish-load', () => hooks.loaded())
    // The person's own input, for the page-driven focus moves (remote-windows.ts "Page-driven
    // actions"): a released mouse button or a tap is a click; a key pressed takes a click back.
    // `input-event` sees what the person sends to the page, never what a script does in it.
    wc.on('input-event', (_event, input) => {
      const type = input.type
      if (type === 'mouseUp' || type === 'gestureTap') hooks.input('click')
      else if (type === 'rawKeyDown' || type === 'keyDown' || type === 'char') hooks.input('key')
    })
    win.on('focus', () => hooks.focused())
    win.on('closed', () => hooks.closed())
    const id = win.id
    const webContentsId = wc.id
    return {
      id,
      webContentsId,
      load: (url) => {
        if (win.isDestroyed()) return
        wc.loadURL(url).catch(() => {
          // A failed or superseded load: reported by did-fail-load (loadFailed above), or replaced.
        })
      },
      reload: () => {
        if (!win.isDestroyed()) wc.reload()
      },
      focus: () => {
        if (win.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      },
      setTitle: (text) => {
        if (!win.isDestroyed()) win.setTitle(text)
      },
      url: () => (win.isDestroyed() ? '' : wc.getURL()),
      // Main's own isolated world, never the page's: the page cannot see or wrap the read. The value
      // is checked by the caller (remote-windows.ts, `isOriginKey`).
      readKey: () => {
        if (win.isDestroyed() || wc.isDestroyed()) return Promise.reject(new Error('the window is closed'))
        return within(wc.executeJavaScriptInIsolatedWorld(REMOTE_KEY_WORLD_ID, [{ code: READ_KEY_SCRIPT }]) as Promise<unknown>, KEY_READ_TIMEOUT_MS)
      },
      showError: (text) => {
        if (win.isDestroyed()) return
        // text/plain: the server's words in it can never be markup.
        wc.loadURL(`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`).catch(() => undefined)
      },
      close: () => {
        if (!win.isDestroyed()) win.close()
      }
    }
  }

  /** Forget: the server's partition emptied (cookies, storage, cache). Its windows are closed first. */
  async clearSession(serverId: string): Promise<void> {
    const ses = this.sessions.get(serverId)?.ses ?? electronSession.fromPartition(remotePartition(serverId))
    await ses.clearStorageData()
    await ses.clearCache()
  }
}
