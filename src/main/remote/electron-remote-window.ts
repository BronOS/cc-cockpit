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
//   `web-contents-created` handler does the same, this makes it independent of that), every loopback
//   request but the server's own origin cancelled (`onBeforeRequest`), by name and by the address main
//   resolves the host to (`checkRemoteRequest`: the callback may come after a lookup);
// - downloads (design-download.md §3.3): `will-download` hands each item to remote-windows.ts, which
//   decides inside the call (its save path must be set there, or Electron shows its own save dialog)
//   and saves the server's own `/d/` downloads after the person's click to the desktop's Downloads
//   folder; anything it refuses, or a throw, is cancelled as every download was before. Downloads is
//   `app.getPath('downloads')`, or the folder a test run passes (`downloadsDir`, never the
//   developer's own). The window's progress bar shows a save's progress (`setProgressBar`);
// - the webview panels' page hardening (webview-hardening.ts `hardenWebContents`): window.open
//   denied (an http(s) link to the person's browser under the open budget), main-frame navigation
//   and redirects pinned to the server's origin, `beforeunload` never holds a close, HTTP auth
//   cancelled, a bad certificate refused (no "proceed anyway"), WebRTC kept off non-proxied UDP. So
//   the web client's own unsaved-text hold never shows; instead the person's close (never main's) is
//   reported (`closeRequested`) and held while remote-windows.ts asks the page (`holdsUnload`) and
//   then the person ("Unsaved page tabs" there);
// - a guest's pinned host certificate (design-guests §11, D-29): the partition's certificate verify
//   proc accepts the one certificate whose SHA-256 is the record's pin, for the record origin's host
//   only (`certificateVerdict`, the pin read through `certificatePin` on every verification, so a
//   forgotten record pins nothing). On the pinned host any other certificate is refused outright
//   (CERT_REFUSE), even one Chromium would trust: the guest joined that certificate (D-29). Other hosts,
//   and servers with no pin, get Chromium's own verdict (the page hardening's `certificate-error` refusal
//   stays). Never a question: Forget then a new invite fixes it;
// - the user agent carries `cc-cockpit-desktop/<version> (<hostname>)` (shared/remote-agent.ts):
//   the web client then keeps the desktop's key table and names the device after this machine.
//   Set on the session too, so main's own requests (`fetchJson`) say the same;
// - main's own requests carry the server's origin key (DEVICE_KEY_HEADER) besides the partition's
//   cookie: a cookie alone is signed out (design-web.md §4.1). The key is the page's, read by
//   `readKey` in main's own isolated world (remote-key.ts) and kept by remote-windows.ts; this file only
//   reads it and puts it on a request, never stores or logs it.
import { app, BrowserWindow, nativeTheme, session as electronSession, type DownloadItem, type Session } from 'electron'
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { desktopAgentSuffix } from '../../shared/remote-agent'
import { DEVICE_KEY_HEADER, SESSION_PATH } from '../../shared/web-protocol'
import { BUILTIN_THEMES } from '../themes/theme-service'
import { hardenWebContents, webviewPreferences } from '../webview/webview-hardening'
import { lockDownSession, NO_APP_PAGE } from '../windows/permissions'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH } from '../windows/window-bounds'
import { warnLog } from '../warn-log'
import type { RemoteCookieJar } from './remote-cookie'
import type { RemoteDownloadItem } from './remote-downloads'
import { KEY_READ_TIMEOUT_MS, READ_KEY_SCRIPT, REMOTE_KEY_WORLD_ID } from './remote-key'
import {
  RemoteHttpError,
  type RemoteCertificatePin,
  type RemoteSessionHooks,
  type RemoteSessionView,
  type RemoteWindowFactory,
  type RemoteWindowHooks,
  type RemoteWindowView
} from './remote-windows'

/** The partition of server `serverId`'s windows. The prefix is named in this file only (grep test). */
export function remotePartition(serverId: string): string {
  return `persist:remote-${serverId}`
}

/** A certificate verify proc's answers (Electron `setCertificateVerifyProc`): accept it, or Chromium's own verdict. */
export const CERT_ACCEPT = 0
export const CERT_REFUSE = -2
export const CERT_CHROMIUM_VERDICT = -3

/**
 * The SHA-256 (64 lower-case hex) of the first certificate in `pem` (Electron's `Certificate.data`):
 * the base64 between its BEGIN and END lines decoded to DER, as `openssl x509 -outform der | sha256sum`
 * and the host's invite (`c=`) count it. Undefined for text with no whole certificate block.
 */
export function certificateSha256(pem: string): string | undefined {
  if (typeof pem !== 'string') return undefined
  const lines = pem.split('\n').map((line) => line.trim())
  const begin = lines.indexOf('-----BEGIN CERTIFICATE-----')
  const end = lines.indexOf('-----END CERTIFICATE-----', begin + 1)
  if (begin < 0 || end < 0) return undefined
  const der = Buffer.from(lines.slice(begin + 1, end).join(''), 'base64')
  if (der.length === 0) return undefined
  return createHash('sha256').update(der).digest('hex')
}

/** A host name as compared: lower case, IPv6 brackets and a trailing dot dropped (Chromium may give either form). */
function bareHost(host: string): string {
  let bare = host.toLowerCase()
  if (bare.startsWith('[') && bare.endsWith(']')) bare = bare.slice(1, -1)
  return bare.endsWith('.') ? bare.slice(0, -1) : bare
}

/**
 * The verify proc's answer for a certificate of `hostname` (D-29): on the pin's own host, CERT_ACCEPT when
 * the certificate hashes to the pin and CERT_REFUSE for anything else (another certificate, one that does
 * not parse), even one Chromium would trust; CERT_CHROMIUM_VERDICT where there is no pin or for another host
 * the page reaches. Never CERT_ACCEPT on a guess.
 */
export function certificateVerdict(hostname: string, pem: string, pinned: RemoteCertificatePin | undefined): number {
  if (pinned === undefined || typeof hostname !== 'string' || hostname === '') return CERT_CHROMIUM_VERDICT
  if (bareHost(hostname) !== bareHost(pinned.hostname)) return CERT_CHROMIUM_VERDICT
  const sha256 = certificateSha256(pem)
  return sha256 !== undefined && sha256 === pinned.pin ? CERT_ACCEPT : CERT_REFUSE
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

/**
 * Whether the page would hold an unload now, as source text: a cancelable `beforeunload` dispatched
 * at the page's window (its own listeners run; the web client's holds while a page tab is dirty,
 * renderer/web/main.tsx). Run in main's isolated world (REMOTE_KEY_WORLD_ID), as the key read: the
 * page cannot see or replace the dispatch. Anything but a held event is false.
 */
export const HOLDS_UNLOAD_SCRIPT =
  "(() => { try { const ev = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(ev); return ev.defaultPrevented === true } catch { return false } })()"

/** How long that answer may take before the close goes ahead (a hung or crashed page answers nothing). */
export const UNLOAD_PROBE_TIMEOUT_MS = 1_000

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

/** Electron's DownloadItem as remote-windows.ts reads it (remote-downloads.ts `RemoteDownloadItem`). */
export function downloadItemView(item: DownloadItem): RemoteDownloadItem {
  return {
    url: () => item.getURL(),
    urlChain: () => item.getURLChain(),
    filename: () => item.getFilename(),
    totalBytes: () => item.getTotalBytes(),
    receivedBytes: () => item.getReceivedBytes(),
    setSavePath: (path) => item.setSavePath(path),
    cancel: () => item.cancel(),
    onUpdated: (listener) => {
      item.on('updated', (_event, state) => listener(state))
    },
    onDone: (listener) => {
      item.once('done', (_event, state) => listener(state))
    }
  }
}

/** A progress value as `setProgressBar` takes it: -1 removes the bar, above 1 is indeterminate. */
export function progressBarValue(value: number | 'indeterminate' | undefined): number {
  if (value === undefined) return -1
  if (value === 'indeterminate') return 2
  return Math.min(1, Math.max(0, value))
}

export interface ElectronRemoteWindowOptions {
  /** This app's version, for the user agent. */
  version: string
  /** The folder remote windows save downloads to instead of the desktop's Downloads (a test run's). */
  downloadsDir?: string
  log?: (message: string) => void
}

export class ElectronRemoteWindowFactory implements RemoteWindowFactory {
  private readonly log: (message: string) => void
  private readonly sessions = new Map<string, { ses: Session; view: RemoteSessionView; userAgent: string; verify: () => void }>()

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
    ses.on('will-download', (event, item, webContents) => {
      let saves = false
      try {
        const id = webContents === undefined || webContents.isDestroyed() ? undefined : webContents.id
        saves = hooks.download(downloadItemView(item), id)
      } catch (err) {
        this.log(`remote ${serverId}: a download was cancelled: ${String(err)}`)
      }
      if (!saves) event.preventDefault()
    })
    // Every remote partition gets the proc (a pin can come after the session was made: a guest joined
    // on a server id whose session exists); with no pin it is Chromium's verdict, as with none. The
    // network service caches the proc's answers (Electron's docs), so clearSession (Forget) sets it
    // again, meant to start that cache afresh; not checked against Electron's source.
    const verify = (): void =>
      ses.setCertificateVerifyProc((request, callback) => {
        let verdict = CERT_CHROMIUM_VERDICT
        try {
          verdict = certificateVerdict(request.hostname, request.certificate.data, hooks.certificatePin?.())
        } catch (err) {
          this.log(`remote ${serverId}: checking a certificate failed: ${String(err)}`)
        }
        callback(verdict)
      })
    verify()
    const userAgent = `${ses.getUserAgent()} ${desktopAgentSuffix(this.options.version, hostname())}`
    ses.setUserAgent(userAgent)
    // One listener per session (a second `onBeforeRequest` would replace it): the loopback rule. Its
    // answer may wait on a DNS lookup (the request is held meanwhile); the callback runs exactly once,
    // and anything but a plain `true` (a throw, a rejection) cancels.
    ses.webRequest.onBeforeRequest((details, callback) => {
      let verdict: boolean | Promise<boolean>
      try {
        verdict = hooks.allowRequest(details.url)
      } catch (err) {
        this.log(`remote ${serverId}: a request was cancelled: ${String(err)}`)
        callback({ cancel: true })
        return
      }
      if (typeof verdict === 'boolean') {
        callback({ cancel: !verdict })
        return
      }
      verdict.then(
        (ok) => callback({ cancel: ok !== true }),
        (err: unknown) => {
          this.log(`remote ${serverId}: a request was cancelled: ${String(err)}`)
          callback({ cancel: true })
        }
      )
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
    this.sessions.set(serverId, { ses, view, userAgent, verify })
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
    // Main's own close (`close` below: Forget, quit, a project the server closed) is final and never
    // reported; it stays made, since Electron's quit closes the window again after closeAll did. Any
    // other close is the person's, held when remote-windows.ts says so (it closes the window later).
    let mainClose = false
    win.on('close', (event) => {
      if (!mainClose && hooks.closeRequested()) event.preventDefault()
    })
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
      holdsUnload: () => {
        if (win.isDestroyed() || wc.isDestroyed()) return Promise.resolve(false)
        return within(wc.executeJavaScriptInIsolatedWorld(REMOTE_KEY_WORLD_ID, [{ code: HOLDS_UNLOAD_SCRIPT }]) as Promise<unknown>, UNLOAD_PROBE_TIMEOUT_MS).then(
          (held) => held === true,
          () => false
        )
      },
      setProgress: (value) => {
        if (!win.isDestroyed()) win.setProgressBar(progressBarValue(value))
      },
      close: () => {
        if (win.isDestroyed()) return
        mainClose = true
        win.close()
      }
    }
  }

  /** Where remote windows save downloads: the desktop's Downloads folder, or the test run's. */
  downloadsDir(): string {
    return this.options.downloadsDir ?? app.getPath('downloads')
  }

  /** Forget: the server's partition emptied (cookies, storage, cache). Its windows are closed first. */
  async clearSession(serverId: string): Promise<void> {
    const known = this.sessions.get(serverId)
    const ses = known?.ses ?? electronSession.fromPartition(remotePartition(serverId))
    await ses.clearStorageData()
    await ses.clearCache()
    // The verify proc's cached answers go too (a pin the record no longer has).
    known?.verify()
  }
}
