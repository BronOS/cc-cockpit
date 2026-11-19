// ElectronRemoteWindowFactory (main/remote/electron-remote-window.ts) with `electron` stubbed: the
// wiring of a remote server's window and partition, asserted without launching Electron. Checked
// here: the window's webPreferences (no bridge script, sandbox, isolation, DevTools only unpacked,
// the server's own persist partition), the user agent suffix, the partition locked down with
// downloads handed to the logic (cancelled unless it saves them), the progress bar, the Downloads
// folder, the loopback rule and the session-path trigger on its requests, the page
// hardening (window.open denied and handed on, main-frame navigation and redirects asked, unload,
// login, certificates, WebRTC), the cookie jar, main's own requests, and isRemoteWindow.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteSessionHooks, RemoteWindowHooks } from '../../src/main/remote/remote-windows'

type Listener = (...args: unknown[]) => unknown

class FakeEmitter {
  readonly listeners = new Map<string, Listener[]>()
  on(name: string, fn: Listener): this {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn])
    return this
  }
  once(name: string, fn: Listener): this {
    return this.on(name, fn)
  }
  emit(name: string, ...args: unknown[]): void {
    for (const fn of this.listeners.get(name) ?? []) fn(...args)
  }
}

class FakeSession extends FakeEmitter {
  readonly handlers: Record<string, Listener> = {}
  userAgent = 'Mozilla/5.0 Chrome/140 Electron/45'
  readonly cookieSets: unknown[] = []
  readonly cookies = Object.assign(new FakeEmitter(), {
    set: async (details: unknown) => void this.cookieSets.push(details)
  })
  readonly webRequest = {
    onBeforeRequest: (fn: Listener) => void (this.handlers.before = fn),
    onCompleted: (fn: Listener) => void (this.handlers.completed = fn)
  }
  readonly fetches: Array<{ url: string; init: Record<string, unknown> }> = []
  answer: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: { mode: 'link', device: null } }
  cleared: string[] = []
  getUserAgent(): string {
    return this.userAgent
  }
  setUserAgent(ua: string): void {
    this.userAgent = ua
  }
  async fetch(url: string, init: Record<string, unknown>) {
    this.fetches.push({ url, init })
    const a = this.answer
    return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body), { status: a.status })
  }
  async clearStorageData(): Promise<void> {
    this.cleared.push('storage')
  }
  async clearCache(): Promise<void> {
    this.cleared.push('cache')
  }
  setPermissionRequestHandler(fn: Listener): void {
    this.handlers.request = fn
  }
  setPermissionCheckHandler(fn: Listener): void {
    this.handlers.check = fn
  }
  setDevicePermissionHandler(fn: Listener): void {
    this.handlers.device = fn
  }
  setDisplayMediaRequestHandler(fn: Listener): void {
    this.handlers.display = fn
  }
  /** Every proc set, in order (clearSession sets it again). */
  readonly verifyProcs: Listener[] = []
  setCertificateVerifyProc(fn: Listener): void {
    this.verifyProcs.push(fn)
  }
}

let nextId = 10

class FakeWebContents extends FakeEmitter {
  readonly id = ++nextId
  destroyed = false
  webrtcPolicy = ''
  userAgent = ''
  url = ''
  readonly loads: string[] = []
  reloads = 0
  openHandler: ((d: { url: string }) => { action: string }) | undefined
  constructor(readonly session: FakeSession) {
    super()
  }
  setWebRTCIPHandlingPolicy(p: string): void {
    this.webrtcPolicy = p
  }
  setWindowOpenHandler(fn: (d: { url: string }) => { action: string }): void {
    this.openHandler = fn
  }
  setUserAgent(ua: string): void {
    this.userAgent = ua
  }
  loadURL(url: string): Promise<void> {
    this.loads.push(url)
    this.url = url
    return Promise.resolve()
  }
  reload(): void {
    this.reloads++
  }
  getURL(): string {
    return this.url
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  readonly scripts: Array<{ world: number; code: string }> = []
  scriptAnswer: () => Promise<unknown> = () => Promise.resolve(null)
  executeJavaScriptInIsolatedWorld(world: number, sources: Array<{ code: string }>): Promise<unknown> {
    for (const s of sources) this.scripts.push({ world, code: s.code })
    return this.scriptAnswer()
  }
}

const state = {
  packaged: false,
  sessions: new Map<string, FakeSession>(),
  windows: [] as FakeWindow[]
}

class FakeWindow extends FakeEmitter {
  readonly id = ++nextId
  readonly webContents: FakeWebContents
  title: string
  menuBar = true
  destroyed = false
  readonly calls: string[] = []
  constructor(readonly options: { title: string; webPreferences: Record<string, unknown> }) {
    super()
    this.title = options.title
    const partition = options.webPreferences.partition as string
    this.webContents = new FakeWebContents(state.sessions.get(partition) ?? new FakeSession())
    state.windows.push(this)
  }
  setMenuBarVisibility(v: boolean): void {
    this.menuBar = v
  }
  setTitle(t: string): void {
    this.title = t
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isMinimized(): boolean {
    return true
  }
  restore(): void {
    this.calls.push('restore')
  }
  show(): void {
    this.calls.push('show')
  }
  focus(): void {
    this.calls.push('focus')
  }
  close(): void {
    this.calls.push('close')
  }
  setProgressBar(value: number): void {
    this.calls.push(`progress ${value}`)
  }
}

/** Electron's DownloadItem, as far as the adapter's wrapper reads it. */
class FakeDownloadItem extends FakeEmitter {
  savePath = ''
  cancelled = 0
  getURL(): string {
    return 'http://127.0.0.1:4100/d/x'
  }
  getURLChain(): string[] {
    return ['http://127.0.0.1:4100/d/x']
  }
  getFilename(): string {
    return 'report.pdf'
  }
  getTotalBytes(): number {
    return 10
  }
  getReceivedBytes(): number {
    return 4
  }
  setSavePath(path: string): void {
    this.savePath = path
  }
  cancel(): void {
    this.cancelled++
  }
}

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.packaged
    },
    getPath: (name: string) => `/home/me/${name}`
  },
  nativeTheme: { shouldUseDarkColors: true },
  BrowserWindow: FakeWindow,
  session: {
    fromPartition: (p: string) => {
      if (!state.sessions.has(p)) state.sessions.set(p, new FakeSession())
      return state.sessions.get(p)
    }
  }
}))

const {
  CERT_ACCEPT,
  CERT_CHROMIUM_VERDICT,
  CERT_REFUSE,
  certificateSha256,
  certificateVerdict,
  ElectronRemoteWindowFactory,
  HOLDS_UNLOAD_SCRIPT,
  isRemoteWindow,
  progressBarValue,
  readCappedText,
  remotePartition,
  UNLOAD_PROBE_TIMEOUT_MS,
  pageNoticeScript,
  PAGE_NOTICE_MS,
  MAX_PAGE_NOTICES
} = await import('../../src/main/remote/electron-remote-window')
const { createHash } = await import('node:crypto')
const { KEY_READ_TIMEOUT_MS, READ_KEY_SCRIPT, REMOTE_KEY_WORLD_ID } = await import('../../src/main/remote/remote-key')
const { WEBVIEW_WORLD_ID } = await import('../../src/main/webview/webview-input')
const { DEVICE_KEY_STORAGE } = await import('../../src/shared/web-protocol')

type Prevented = { defaultPrevented: boolean; preventDefault(): void }
function prevented<T extends object>(fields: T = {} as T): Prevented & T {
  const e: Prevented & T = { ...fields, defaultPrevented: false, preventDefault: () => void (e.defaultPrevented = true) }
  return e
}

function sessionHooks(
  log: string[],
  allow = (url: string) => url.startsWith('http://127.0.0.1:4100'),
  download: RemoteSessionHooks['download'] = () => false
): RemoteSessionHooks {
  return {
    allowRequest: (url) => (log.push(`req ${url}`), allow(url)),
    sessionRequestCompleted: (id) => void log.push(`session-done ${id}`),
    download
  }
}

function windowHooks(log: string[], hold = false): RemoteWindowHooks {
  return {
    closeRequested: () => (log.push('close requested'), hold),
    allowNavigation: (url) => (log.push(`nav ${url}`), url.startsWith('http://127.0.0.1:4100')),
    openWindow: (url) => void log.push(`open ${url}`),
    navigated: (url) => void log.push(`navigated ${url}`),
    loaded: () => void log.push('loaded'),
    focused: () => void log.push('focused'),
    input: (kind) => void log.push(`input ${kind}`),
    downloadClick: () => void log.push('download click'),
    closed: () => void log.push('closed')
  }
}

function make(serverId = 's1', holdClose = false) {
  const log: string[] = []
  const factory = new ElectronRemoteWindowFactory({ version: '0.17.0', log: (m) => void log.push(`log ${m}`) })
  const sessionView = factory.session(serverId, sessionHooks(log))
  const view = factory.create(serverId, 'devbox', windowHooks(log, holdClose))
  const win = state.windows.at(-1) as FakeWindow
  const ses = state.sessions.get(remotePartition(serverId)) as FakeSession
  return { log, factory, sessionView, view, win, wc: win.webContents, ses }
}

beforeEach(() => {
  state.packaged = false
  state.sessions.clear()
  state.windows = []
})

describe('ElectronRemoteWindowFactory: the window', () => {
  it('has no bridge script, is sandboxed and isolated, on the server persist partition', () => {
    const { win } = make()
    const prefs = win.options.webPreferences
    expect(prefs).not.toHaveProperty('preload')
    expect(prefs).toMatchObject({
      partition: 'persist:remote-s1',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      devTools: true
    })
    expect(win.title).toBe('devbox')
    expect(win.menuBar).toBe(false)
  })

  it('has no DevTools when packaged', () => {
    state.packaged = true
    expect(make().win.options.webPreferences.devTools).toBe(false)
  })

  it('carries the desktop agent in the page and the session user agent', () => {
    const { wc, ses } = make()
    expect(wc.userAgent).toMatch(/^Mozilla\/5\.0 Chrome\/140 Electron\/45 cc-cockpit-desktop\/0\.17\.0 \([^)]+\)$/)
    expect(ses.userAgent).toBe(wc.userAgent)
  })

  it('refuses a window before its server session is prepared', () => {
    const factory = new ElectronRemoteWindowFactory({ version: '1' })
    expect(() => factory.create('zz', 't', windowHooks([]))).toThrow('not prepared')
  })

  it('denies page-opened windows and hands the URL on', () => {
    const { wc, log } = make()
    expect(wc.openHandler?.({ url: 'https://example.com/' })).toEqual({ action: 'deny' })
    expect(log).toContain('open https://example.com/')
  })

  it('asks before main-frame navigations and redirects, lets sub-frames be', () => {
    const { wc, log } = make()
    const away = prevented({ url: 'https://evil.example/', isMainFrame: true })
    wc.emit('will-frame-navigate', away)
    expect(away.defaultPrevented).toBe(true)
    const home = prevented({ url: 'http://127.0.0.1:4100/?project=p', isMainFrame: true })
    wc.emit('will-frame-navigate', home)
    expect(home.defaultPrevented).toBe(false)
    const redirect = prevented({ url: 'http://127.0.0.1:3000/', isMainFrame: true })
    wc.emit('will-redirect', redirect)
    expect(redirect.defaultPrevented).toBe(true)
    const sub = prevented({ url: 'https://elsewhere.example/', isMainFrame: false })
    wc.emit('will-frame-navigate', sub)
    expect(sub.defaultPrevented).toBe(false)
    expect(log.filter((l) => l.startsWith('nav '))).toEqual(['nav https://evil.example/', 'nav http://127.0.0.1:4100/?project=p', 'nav http://127.0.0.1:3000/'])
  })

  it('never lets beforeunload hold a close, cancels HTTP auth, refuses bad certificates, keeps WebRTC off UDP', () => {
    const { wc } = make()
    const unload = prevented()
    wc.emit('will-prevent-unload', unload)
    expect(unload.defaultPrevented).toBe(true)
    const login = prevented()
    const loginCb = vi.fn()
    wc.emit('login', login, {}, {}, loginCb)
    expect(login.defaultPrevented).toBe(true)
    expect(loginCb).toHaveBeenCalledWith()
    const cert = prevented()
    const certCb = vi.fn()
    wc.emit('certificate-error', cert, 'https://x/', 'ERR', {}, certCb)
    expect(cert.defaultPrevented).toBe(true)
    expect(certCb).toHaveBeenCalledWith(false)
    expect(wc.webrtcPolicy).toBe('disable_non_proxied_udp')
  })

  it('reports navigations, finished loads, focus and the close; keeps the page title out', () => {
    const { wc, win, log } = make()
    wc.url = 'http://127.0.0.1:4100/?project=p'
    wc.emit('did-navigate', {}, wc.url)
    wc.emit('did-navigate-in-page', {}, 'http://127.0.0.1:4100/?project=q', false)
    wc.emit('did-finish-load')
    const title = prevented()
    win.emit('page-title-updated', title)
    expect(title.defaultPrevented).toBe(true)
    win.emit('focus')
    win.emit('closed')
    expect(log).toEqual(['navigated http://127.0.0.1:4100/?project=p', 'loaded', 'focused', 'closed'])
  })

  it("reports the person's clicks and key presses to the page, nothing else", () => {
    const { wc, log } = make()
    for (const type of ['mouseDown', 'mouseMove', 'mouseUp', 'gestureTap', 'mouseWheel', 'rawKeyDown', 'keyDown', 'char', 'keyUp']) {
      wc.emit('input-event', {}, { type })
    }
    expect(log.filter((l) => l.startsWith('input'))).toEqual(['input click', 'input click', 'input key', 'input key', 'input key'])
  })

  it("a click in a plugin's panel (an out-of-process frame) counts for a download, never as the focus moves' click", () => {
    // The reported "Files › Download does nothing": Electron 45 puts a sandboxed plugin frame in a
    // process of its own, and a click there reaches `before-mouse-event` (emitted at the root) but
    // never `input-event` (the main frame's widget only; checked against Electron 45 with a sandboxed
    // frame and a DevTools-dispatched click). Before the fix nothing heard it, so the download gate
    // saw no click and refused every Download from the Files panel.
    const { wc, log } = make()
    for (const type of ['mouseDown', 'mouseMove', 'mouseUp', 'mouseWheel', 'mouseEnter', 'mouseLeave', 'contextMenu']) {
      wc.emit('before-mouse-event', prevented(), { type, x: 10, y: 10 })
    }
    expect(log.filter((l) => l.startsWith('input') || l === 'download click')).toEqual(['download click'])
  })

  it("shows main's notice in the page in its own isolated world, as text only, nothing when closed", () => {
    const { view, wc, win } = make()
    const text = 'a"b</div><img src=x onerror=alert(1)>.txt was not saved: click Download again'
    view.showNotice(text)
    expect(wc.scripts).toEqual([{ world: REMOTE_KEY_WORLD_ID, code: pageNoticeScript(text) }])
    const code = pageNoticeScript(text)
    // The text is one JSON string literal set as textContent, never markup.
    expect(code).toContain(`const text = ${JSON.stringify(text)};`)
    expect(code).toContain('row.textContent = text;')
    expect(code).not.toContain('innerHTML')
    expect(code).toContain(`setTimeout(drop, ${PAGE_NOTICE_MS})`)
    expect(code).toContain(`> ${MAX_PAGE_NOTICES})`)
    // It parses as a script.
    expect(() => new Function(code)).not.toThrow()
    win.destroyed = true
    view.showNotice(text)
    expect(wc.scripts).toHaveLength(1)
  })

  it('drives the window: load, reload, focus, title, plain-text error, close', () => {
    const { view, wc, win } = make()
    view.load('http://127.0.0.1:4100/')
    view.reload()
    view.focus()
    view.setTitle('devbox — Api')
    expect(view.url()).toBe('http://127.0.0.1:4100/')
    view.showError('<b>no</b> & more')
    view.close()
    expect(wc.loads).toEqual(['http://127.0.0.1:4100/', 'data:text/plain;charset=utf-8,%3Cb%3Eno%3C%2Fb%3E%20%26%20more'])
    expect(wc.reloads).toBe(1)
    expect(win.calls).toEqual(['restore', 'show', 'focus', 'close'])
    expect(win.title).toBe('devbox — Api')
    expect(view.id).toBe(win.id)
    expect(view.webContentsId).toBe(wc.id)
    // Gone: every call is a no-op.
    win.destroyed = true
    view.load('http://127.0.0.1:4100/x')
    view.focus()
    expect(wc.loads).toHaveLength(2)
    expect(view.url()).toBe('')
  })

  it('isRemoteWindow knows its windows by their partition', () => {
    const { win } = make()
    expect(isRemoteWindow(win as never)).toBe(true)
    const other = new FakeWindow({ title: 'x', webPreferences: { partition: 'persist:other' } })
    expect(isRemoteWindow(other as never)).toBe(false)
    win.destroyed = true
    expect(isRemoteWindow(win as never)).toBe(false)
  })
})

describe('ElectronRemoteWindowFactory: downloads', () => {
  function withDownload(download: RemoteSessionHooks['download']) {
    const factory = new ElectronRemoteWindowFactory({ version: '1', log: () => undefined })
    factory.session('s1', sessionHooks([], undefined, download))
    const view = factory.create('s1', 'devbox', windowHooks([]))
    const win = state.windows.at(-1) as FakeWindow
    const ses = state.sessions.get(remotePartition('s1')) as FakeSession
    return { factory, view, win, ses }
  }

  it('hands the item and its page to the logic, and cancels what it does not save (or a throw)', () => {
    const seen: Array<{ chain: string[]; name: string; total: number; received: number; id: number | undefined }> = []
    let answer = true
    const { ses, win } = withDownload((item, id) => {
      seen.push({ chain: item.urlChain(), name: item.filename(), total: item.totalBytes(), received: item.receivedBytes(), id })
      item.setSavePath('/dl/.cc-download-x')
      return answer
    })
    const item = new FakeDownloadItem()
    const saved = prevented()
    ses.emit('will-download', saved, item, win.webContents)
    expect(saved.defaultPrevented).toBe(false)
    expect(item.savePath).toBe('/dl/.cc-download-x')
    expect(seen).toEqual([{ chain: ['http://127.0.0.1:4100/d/x'], name: 'report.pdf', total: 10, received: 4, id: win.webContents.id }])
    answer = false
    const refused = prevented()
    ses.emit('will-download', refused, new FakeDownloadItem(), win.webContents)
    expect(refused.defaultPrevented).toBe(true)
    // A page that is gone is no page.
    win.webContents.destroyed = true
    ses.emit('will-download', prevented(), new FakeDownloadItem(), win.webContents)
    expect(seen.at(-1)?.id).toBeUndefined()
    const throws = withDownload(() => {
      throw new Error('boom')
    })
    const thrown = prevented()
    throws.ses.emit('will-download', thrown, new FakeDownloadItem(), throws.win.webContents)
    expect(thrown.defaultPrevented).toBe(true)
  })

  it('wraps the item: updates, the end once, cancel', () => {
    let wrapped: Parameters<RemoteSessionHooks['download']>[0] | undefined
    const { ses, win } = withDownload((item) => {
      wrapped = item
      return true
    })
    const item = new FakeDownloadItem()
    ses.emit('will-download', prevented(), item, win.webContents)
    const log: string[] = []
    wrapped?.onUpdated((s) => log.push(`updated ${s}`))
    wrapped?.onDone((s) => log.push(`done ${s}`))
    item.emit('updated', {}, 'progressing')
    item.emit('updated', {}, 'interrupted')
    item.emit('done', {}, 'completed')
    wrapped?.cancel()
    expect(log).toEqual(['updated progressing', 'updated interrupted', 'done completed'])
    expect(item.cancelled).toBe(1)
  })

  it('shows progress on the window bar, and saves to Downloads or the given folder', () => {
    const { view, win, factory } = withDownload(() => false)
    view.setProgress(0.5)
    view.setProgress('indeterminate')
    view.setProgress(undefined)
    expect(win.calls).toEqual(['progress 0.5', 'progress 2', 'progress -1'])
    expect(progressBarValue(7)).toBe(1)
    expect(progressBarValue(-3)).toBe(0)
    expect(factory.downloadsDir()).toBe('/home/me/downloads')
    expect(new ElectronRemoteWindowFactory({ version: '1', downloadsDir: '/data/Downloads' }).downloadsDir()).toBe('/data/Downloads')
  })
})

describe('ElectronRemoteWindowFactory: the partition', () => {
  it('is locked down, cancels downloads the logic does not save, and is prepared once', () => {
    const { ses, factory } = make()
    expect(ses.handlers.request).toBeTypeOf('function')
    const granted = vi.fn()
    ses.handlers.request?.({}, 'notifications', granted, { isMainFrame: true, requestingUrl: 'http://127.0.0.1:4100/' })
    expect(granted).toHaveBeenCalledWith(false)
    expect(ses.handlers.check?.({}, 'clipboard-read', 'x', { isMainFrame: true, requestingUrl: 'http://127.0.0.1:4100/' })).toBe(false)
    const download = prevented()
    ses.emit('will-download', download, new FakeDownloadItem(), undefined)
    expect(download.defaultPrevented).toBe(true)
    const ua = ses.userAgent
    const again = factory.session('s1', sessionHooks([]))
    expect(ses.userAgent).toBe(ua)
    expect(ses.listeners.get('will-download')).toHaveLength(1)
    expect(again).toBeDefined()
  })

  it('cancels the requests the rule refuses', () => {
    const { ses, log } = make()
    const answers: unknown[] = []
    ses.handlers.before?.({ url: 'http://127.0.0.1:3000/' }, (r: unknown) => answers.push(r))
    ses.handlers.before?.({ url: 'http://127.0.0.1:4100/ws' }, (r: unknown) => answers.push(r))
    expect(answers).toEqual([{ cancel: true }, { cancel: false }])
    expect(log).toContain('req http://127.0.0.1:3000/')
  })

  it('reports a page own completed session check, not main own nor other paths', () => {
    const { ses, log } = make()
    ses.handlers.completed?.({ url: 'http://127.0.0.1:4100/auth/session', method: 'GET', webContentsId: 42 })
    ses.handlers.completed?.({ url: 'http://127.0.0.1:4100/auth/session', method: 'GET' })
    ses.handlers.completed?.({ url: 'http://127.0.0.1:4100/api/projects', method: 'GET', webContentsId: 42 })
    ses.handlers.completed?.({ url: 'http://127.0.0.1:4100/auth/session', method: 'POST', webContentsId: 42 })
    expect(log.filter((l) => l.startsWith('session-done'))).toEqual(['session-done 42'])
  })

  it('adapts the cookie jar', async () => {
    const { ses, sessionView } = make()
    const seen: unknown[] = []
    sessionView.jar.onChanged((cookie, cause, removed) => void seen.push([cookie, cause, removed]))
    ses.cookies.emit('changed', {}, { name: 'ccc_device', value: 'v' }, 'explicit', true)
    expect(seen).toEqual([[{ name: 'ccc_device', value: 'v' }, 'explicit', true]])
    const details = { url: 'http://127.0.0.1:4100/', name: 'ccc_device', value: 'v', path: '/', httpOnly: true, secure: false, sameSite: 'strict' as const }
    await sessionView.jar.set(details)
    expect(ses.cookieSets).toEqual([details])
  })

  it('fetches with the partition cookies, no cache, no redirect; a non-2xx rejects', async () => {
    const { ses, sessionView } = make()
    await expect(sessionView.fetchJson('http://127.0.0.1:4100/auth/session', 4096, undefined)).resolves.toEqual({ mode: 'link', device: null })
    expect(ses.fetches[0]?.init).toMatchObject({ credentials: 'include', cache: 'no-store', redirect: 'error' })
    expect(ses.fetches[0]?.init.signal).toBeInstanceOf(AbortSignal)
    ses.answer = { ok: false, status: 401, body: {} }
    await expect(sessionView.fetchJson('http://127.0.0.1:4100/api/projects', 4096, undefined)).rejects.toThrow('401')
    // With its status, for the machine poller (a 404 is an older server, machine-status.ts).
    await expect(sessionView.fetchJson('http://127.0.0.1:4100/api/projects', 4096, undefined)).rejects.toMatchObject({ status: 401 })
  })

  it("reads the server's answers up to the cap only, and errors past it", async () => {
    const { ses, sessionView } = make()
    ses.answer = { ok: true, status: 200, body: { pad: 'x'.repeat(100) } }
    await expect(sessionView.fetchJson('http://127.0.0.1:4100/api/sessions', 50, undefined)).rejects.toThrow('larger than 50 bytes')
    await expect(sessionView.fetchJson('http://127.0.0.1:4100/api/sessions', 4096, undefined)).resolves.toEqual({ pad: 'x'.repeat(100) })
    await expect(sessionView.postJson('http://127.0.0.1:4100/api/projects', {}, 'http://127.0.0.1:4100', 50, undefined)).rejects.toThrow('larger than 50 bytes')
    // A body that is not JSON: GET rejects, POST answers undefined.
    ses.answer = { ok: true, status: 200, body: 'not json' }
    await expect(sessionView.fetchJson('http://127.0.0.1:4100/api/sessions', 4096, undefined)).rejects.toThrow()
    await expect(sessionView.postJson('http://127.0.0.1:4100/api/projects', {}, 'http://127.0.0.1:4100', 4096, undefined)).resolves.toEqual({ status: 200, body: undefined })
  })

  it('readCappedText stops a stream that runs on without end, and refuses a declared length over the cap unread', async () => {
    let pulled = 0
    let cancelled = false
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(1024))
      },
      cancel() {
        cancelled = true
      }
    })
    await expect(readCappedText(new Response(endless), 10 * 1024)).rejects.toThrow('larger than 10240 bytes')
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThan(20)
    const declared = new Response('{}', { headers: { 'content-length': '999999' } })
    await expect(readCappedText(declared, 1024)).rejects.toThrow('larger than 1024 bytes')
    await expect(readCappedText(new Response('héllo'), 1024)).resolves.toBe('héllo')
    await expect(readCappedText(new Response(null), 1024)).resolves.toBe('')
  })

  it('posts JSON with the server Origin and answers any status with its body', async () => {
    const { ses, sessionView } = make()
    ses.answer = { ok: false, status: 400, body: { error: 'missing' } }
    await expect(sessionView.postJson('http://127.0.0.1:4100/api/projects', { reopen: 'p1' }, 'http://127.0.0.1:4100', 4096, undefined)).resolves.toEqual({
      status: 400,
      body: { error: 'missing' }
    })
    expect(ses.fetches[0]?.init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:4100' },
      body: '{"reopen":"p1"}'
    })
    expect(ses.fetches[0]?.init.signal).toBeInstanceOf(AbortSignal)
  })

  it("sends the origin key as the device key header on main's own requests, and none when there is no key", async () => {
    const { ses, sessionView } = make()
    const key = 'k'.repeat(43)
    await sessionView.fetchJson('http://127.0.0.1:4100/auth/session', 4096, key)
    await sessionView.fetchJson('http://127.0.0.1:4100/auth/session', 4096, undefined)
    await sessionView.postJson('http://127.0.0.1:4100/api/projects', { reopen: 'p1' }, 'http://127.0.0.1:4100', 4096, key)
    expect(ses.fetches[0]?.init.headers).toEqual({ 'x-cc-device-key': key })
    expect(ses.fetches[1]?.init.headers).toEqual({})
    expect(ses.fetches[2]?.init.headers).toEqual({ 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:4100', 'x-cc-device-key': key })
  })

  it("reports the person's close and holds it when main says so; main's own close is never reported, also when Electron closes again", () => {
    const held = make('s1', true)
    const first = prevented()
    held.win.emit('close', first)
    expect(first.defaultPrevented).toBe(true)
    expect(held.log.filter((l) => l === 'close requested')).toHaveLength(1)
    const free = make('s2', false)
    const second = prevented()
    free.win.emit('close', second)
    expect(second.defaultPrevented).toBe(false)
    // Main's close (Forget, quit): never reported, and the quit's own second close is not either.
    held.view.close()
    for (let i = 0; i < 2; i++) {
      const again = prevented()
      held.win.emit('close', again)
      expect(again.defaultPrevented).toBe(false)
    }
    expect(held.log.filter((l) => l === 'close requested')).toHaveLength(1)
    expect(held.win.calls).toEqual(['close'])
  })

  it("asks the page whether it holds an unload in main's isolated world: only a held event counts, bounded, false when closed", async () => {
    vi.useFakeTimers()
    try {
      const { view, wc } = make()
      wc.scriptAnswer = () => Promise.resolve(true)
      await expect(view.holdsUnload()).resolves.toBe(true)
      expect(wc.scripts).toEqual([{ world: REMOTE_KEY_WORLD_ID, code: HOLDS_UNLOAD_SCRIPT }])
      expect(HOLDS_UNLOAD_SCRIPT).toContain("new Event('beforeunload', { cancelable: true })")
      for (const answer of ['true', 1, null, undefined]) {
        wc.scriptAnswer = () => Promise.resolve(answer)
        await expect(view.holdsUnload()).resolves.toBe(false)
      }
      wc.scriptAnswer = () => Promise.reject(new Error('script failed'))
      await expect(view.holdsUnload()).resolves.toBe(false)
      // A hung or crashed page: false after the bound, so the close goes ahead.
      wc.scriptAnswer = () => new Promise(() => undefined)
      const pending = view.holdsUnload()
      await vi.advanceTimersByTimeAsync(UNLOAD_PROBE_TIMEOUT_MS)
      await expect(pending).resolves.toBe(false)
      const runs = wc.scripts.length
      wc.destroyed = true
      await expect(view.holdsUnload()).resolves.toBe(false)
      expect(wc.scripts).toHaveLength(runs)
    } finally {
      vi.useRealTimers()
    }
  })

  it("reads the page's key entry in main's own isolated world, bounded in time, never from a closed window", async () => {
    vi.useFakeTimers()
    try {
      const { view, wc } = make()
      wc.scriptAnswer = () => Promise.resolve('stored')
      await expect(view.readKey()).resolves.toBe('stored')
      expect(wc.scripts).toEqual([{ world: REMOTE_KEY_WORLD_ID, code: READ_KEY_SCRIPT }])
      expect(REMOTE_KEY_WORLD_ID).not.toBe(WEBVIEW_WORLD_ID)
      expect(READ_KEY_SCRIPT).toContain(JSON.stringify(DEVICE_KEY_STORAGE))
      // A page that never answers (a navigation dropped the script): rejected after the bound.
      wc.scriptAnswer = () => new Promise(() => undefined)
      const pending = view.readKey()
      const settled = expect(pending).rejects.toThrow('did not answer')
      await vi.advanceTimersByTimeAsync(KEY_READ_TIMEOUT_MS)
      await settled
      wc.destroyed = true
      await expect(view.readKey()).rejects.toThrow('closed')
      expect(wc.scripts).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears a forgotten server partition', async () => {
    const { ses, factory } = make()
    await factory.clearSession('s1')
    expect(ses.cleared).toEqual(['storage', 'cache'])
  })
})


// A guest's pinned host certificate (design-guests §11, D-29): the partition's verify proc accepts
// the one certificate whose DER hashes to the record's pin, for the pin's host only; everything else
// is Chromium's own verdict (which refuses a self-signed certificate, as the page hardening does).
describe('the certificate pin', () => {
  /** A PEM block around `der` as Electron's Certificate.data gives it (64-character lines). */
  function pem(der: Buffer, eol = '\n'): string {
    const b64 = der.toString('base64')
    const lines: string[] = []
    for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64))
    return ['-----BEGIN CERTIFICATE-----', ...lines, '-----END CERTIFICATE-----', ''].join(eol)
  }
  const der = Buffer.from(Array.from({ length: 700 }, (_, i) => (i * 37) % 256))
  const other = Buffer.from(Array.from({ length: 700 }, (_, i) => (i * 11) % 256))
  const pin = createHash('sha256').update(der).digest('hex')

  it("hashes the first certificate's DER, whatever the line ends", () => {
    expect(certificateSha256(pem(der))).toBe(pin)
    expect(certificateSha256(pem(der, '\r\n'))).toBe(pin)
    expect(certificateSha256(pem(der) + pem(other))).toBe(pin)
    expect(certificateSha256('not a certificate')).toBeUndefined()
    expect(certificateSha256('-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n')).toBeUndefined()
  })

  it('accepts the pinned certificate for its host only, refuses any other there; other hosts get Chromium\'s verdict', () => {
    const pinned = { hostname: 'host.example', pin }
    expect(certificateVerdict('host.example', pem(der), pinned)).toBe(CERT_ACCEPT)
    expect(certificateVerdict('HOST.example.', pem(der), pinned)).toBe(CERT_ACCEPT)
    // Another certificate for the pinned host: refused outright, even one Chromium would trust (D-29), never a question.
    expect(certificateVerdict('host.example', pem(other), pinned)).toBe(CERT_REFUSE)
    // The pinned certificate on another host (a redirect, a sub-resource): not the pin's.
    expect(certificateVerdict('evil.example', pem(der), pinned)).toBe(CERT_CHROMIUM_VERDICT)
    expect(certificateVerdict('', pem(der), pinned)).toBe(CERT_CHROMIUM_VERDICT)
    // No pin: Chromium's verdict for everything.
    expect(certificateVerdict('host.example', pem(der), undefined)).toBe(CERT_CHROMIUM_VERDICT)
    expect(certificateVerdict('host.example', 'garbage', pinned)).toBe(CERT_REFUSE)
    // IPv6: Chromium's host name and URL's bracketed one are the same host.
    expect(certificateVerdict('::1', pem(der), { hostname: '[::1]', pin })).toBe(CERT_ACCEPT)
    expect(certificateVerdict('[::1]', pem(der), { hostname: '[::1]', pin })).toBe(CERT_ACCEPT)
  })

  it("sets the partition's verify proc, reading the pin on each call, and sets it again when the partition is cleared", async () => {
    const log: string[] = []
    let current: { hostname: string; pin: string } | undefined = { hostname: 'host.example', pin }
    const factory = new ElectronRemoteWindowFactory({ version: '0.17.0', log: (m) => void log.push(m) })
    factory.session('g1', { ...sessionHooks(log), certificatePin: () => current })
    const ses = state.sessions.get(remotePartition('g1')) as FakeSession
    expect(ses.verifyProcs).toHaveLength(1)
    const verdicts: unknown[] = []
    const verify = (host: string, data: string): void => void ses.verifyProcs.at(-1)?.({ hostname: host, certificate: { data } }, (v: unknown) => verdicts.push(v))
    verify('host.example', pem(der))
    verify('host.example', pem(other))
    current = undefined
    verify('host.example', pem(der))
    expect(verdicts).toEqual([CERT_ACCEPT, CERT_REFUSE, CERT_CHROMIUM_VERDICT])
    // A hook that throws is Chromium's verdict, logged without the pin.
    factory.session('g2', { ...sessionHooks(log), certificatePin: () => {
      throw new Error('store gone')
    } })
    const ses2 = state.sessions.get(remotePartition('g2')) as FakeSession
    ses2.verifyProcs[0]?.({ hostname: 'host.example', certificate: { data: pem(der) } }, (v: unknown) => verdicts.push(v))
    expect(verdicts.at(-1)).toBe(CERT_CHROMIUM_VERDICT)
    expect(log.some((l) => l.includes('checking a certificate failed') && !l.includes(pin))).toBe(true)
    await factory.clearSession('g1')
    expect(ses.verifyProcs).toHaveLength(2)
  })

  it('every remote partition gets the proc, with no pin hook too (Chromium\'s verdict)', () => {
    const { ses } = make('plain')
    const verdicts: unknown[] = []
    ses.verifyProcs[0]?.({ hostname: 'host.example', certificate: { data: pem(der) } }, (v: unknown) => verdicts.push(v))
    expect(verdicts).toEqual([CERT_CHROMIUM_VERDICT])
  })
})
