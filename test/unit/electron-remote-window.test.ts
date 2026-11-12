// ElectronRemoteWindowFactory (main/remote/electron-remote-window.ts) with `electron` stubbed: the
// wiring of a remote server's window and partition, asserted without launching Electron. Checked
// here: the window's webPreferences (no bridge script, sandbox, isolation, DevTools only unpacked,
// the server's own persist partition), the user agent suffix, the partition locked down with
// downloads cancelled, the loopback rule and the session-path trigger on its requests, the page
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
}

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.packaged
    }
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

const { ElectronRemoteWindowFactory, isRemoteWindow, readCappedText, remotePartition } = await import('../../src/main/remote/electron-remote-window')

type Prevented = { defaultPrevented: boolean; preventDefault(): void }
function prevented<T extends object>(fields: T = {} as T): Prevented & T {
  const e: Prevented & T = { ...fields, defaultPrevented: false, preventDefault: () => void (e.defaultPrevented = true) }
  return e
}

function sessionHooks(log: string[], allow = (url: string) => url.startsWith('http://127.0.0.1:4100')): RemoteSessionHooks {
  return {
    allowRequest: (url) => (log.push(`req ${url}`), allow(url)),
    sessionRequestCompleted: (id) => void log.push(`session-done ${id}`)
  }
}

function windowHooks(log: string[]): RemoteWindowHooks {
  return {
    allowNavigation: (url) => (log.push(`nav ${url}`), url.startsWith('http://127.0.0.1:4100')),
    openWindow: (url) => void log.push(`open ${url}`),
    navigated: (url) => void log.push(`navigated ${url}`),
    loaded: () => void log.push('loaded'),
    focused: () => void log.push('focused'),
    input: (kind) => void log.push(`input ${kind}`),
    closed: () => void log.push('closed')
  }
}

function make(serverId = 's1') {
  const log: string[] = []
  const factory = new ElectronRemoteWindowFactory({ version: '0.17.0', log: (m) => void log.push(`log ${m}`) })
  const sessionView = factory.session(serverId, sessionHooks(log))
  const view = factory.create(serverId, 'devbox', windowHooks(log))
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

describe('ElectronRemoteWindowFactory: the partition', () => {
  it('is locked down, cancels downloads, and is prepared once', () => {
    const { ses, factory } = make()
    expect(ses.handlers.request).toBeTypeOf('function')
    const granted = vi.fn()
    ses.handlers.request?.({}, 'notifications', granted, { isMainFrame: true, requestingUrl: 'http://127.0.0.1:4100/' })
    expect(granted).toHaveBeenCalledWith(false)
    expect(ses.handlers.check?.({}, 'clipboard-read', 'x', { isMainFrame: true, requestingUrl: 'http://127.0.0.1:4100/' })).toBe(false)
    const download = prevented()
    ses.emit('will-download', download)
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
    await expect(sessionView.fetchJson('http://127.0.0.1:4100/auth/session', 4096)).resolves.toEqual({ mode: 'link', device: null })
    expect(ses.fetches[0]?.init).toMatchObject({ credentials: 'include', cache: 'no-store', redirect: 'error' })
    expect(ses.fetches[0]?.init.signal).toBeInstanceOf(AbortSignal)
    ses.answer = { ok: false, status: 401, body: {} }
    await expect(sessionView.fetchJson('http://127.0.0.1:4100/api/projects', 4096)).rejects.toThrow('401')
    // With its status, for the machine poller (a 404 is an older server, machine-status.ts).
    await expect(sessionView.fetchJson('http://127.0.0.1:4100/api/projects', 4096)).rejects.toMatchObject({ status: 401 })
  })

  it("reads the server's answers up to the cap only, and errors past it", async () => {
    const { ses, sessionView } = make()
    ses.answer = { ok: true, status: 200, body: { pad: 'x'.repeat(100) } }
    await expect(sessionView.fetchJson('http://127.0.0.1:4100/api/sessions', 50)).rejects.toThrow('larger than 50 bytes')
    await expect(sessionView.fetchJson('http://127.0.0.1:4100/api/sessions', 4096)).resolves.toEqual({ pad: 'x'.repeat(100) })
    await expect(sessionView.postJson('http://127.0.0.1:4100/api/projects', {}, 'http://127.0.0.1:4100', 50)).rejects.toThrow('larger than 50 bytes')
    // A body that is not JSON: GET rejects, POST answers undefined.
    ses.answer = { ok: true, status: 200, body: 'not json' }
    await expect(sessionView.fetchJson('http://127.0.0.1:4100/api/sessions', 4096)).rejects.toThrow()
    await expect(sessionView.postJson('http://127.0.0.1:4100/api/projects', {}, 'http://127.0.0.1:4100', 4096)).resolves.toEqual({ status: 200, body: undefined })
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
    await expect(sessionView.postJson('http://127.0.0.1:4100/api/projects', { reopen: 'p1' }, 'http://127.0.0.1:4100', 4096)).resolves.toEqual({
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

  it('clears a forgotten server partition', async () => {
    const { ses, factory } = make()
    await factory.clearSession('s1')
    expect(ses.cleared).toEqual(['storage', 'cache'])
  })
})
