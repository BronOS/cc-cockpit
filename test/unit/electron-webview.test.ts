// ElectronWebviewFactory (electron-webview.ts) with `electron` stubbed: the security settings of a
// webview panel's view, asserted without launching Electron (e2e/webview-panel.spec.ts covers the
// real thing). The adapter decides nothing itself; what is checked here is that every Electron
// hook is wired to the manager's decision and that the hardening is in place: no preload, sandbox,
// a session of its own that is locked down, WebRTC off non-proxied UDP, window.open denied,
// downloads cancelled, cc-preview answered on that session only, HTTP auth cancelled and a bad
// certificate refused (webview-hardening.ts, shared with the off-screen adapter, whose own test
// checks that both adapters wire the same hooks).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebviewEvents } from '../../src/main/webview/webview-manager'

type Listener = (...args: unknown[]) => unknown

class FakeEmitter {
  readonly listeners = new Map<string, Listener[]>()
  on(name: string, fn: Listener): this {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn])
    return this
  }
  emit(name: string, ...args: unknown[]): void {
    for (const fn of this.listeners.get(name) ?? []) fn(...args)
  }
}

class FakeSession extends FakeEmitter {
  readonly handlers: Record<string, Listener> = {}
  readonly protocols = new Map<string, Listener>()
  readonly protocol = { handle: (scheme: string, fn: Listener) => void this.protocols.set(scheme, fn) }
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

class FakeWebContents extends FakeEmitter {
  webrtcPolicy = ''
  openHandler: ((d: { url: string }) => { action: string }) | undefined
  setWebRTCIPHandlingPolicy(p: string): void {
    this.webrtcPolicy = p
  }
  setWindowOpenHandler(fn: (d: { url: string }) => { action: string }): void {
    this.openHandler = fn
  }
  focused = false
  /** The page's DevTools protocol: the desktop never attaches it (its pickers and print stay). */
  readonly debugger = { attached: false, attach: () => void (this.debugger.attached = true) }
  /** What the next loadURL returns (Electron's promise: resolves on finish, rejects on a failure). */
  nextLoad: Promise<void> = Promise.resolve()
  loadURL(): Promise<void> {
    return this.nextLoad
  }
  isDestroyed(): boolean {
    return false
  }
  isFocused(): boolean {
    return this.focused
  }
}

const state = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(),
  views: [] as Array<{ options: { webPreferences: Record<string, unknown> }; webContents: unknown; visible?: boolean }>,
  windowGone: false
}))

vi.mock('electron', () => {
  class WebContentsView {
    readonly webContents = new FakeWebContents()
    visible: boolean | undefined
    constructor(readonly options: { webPreferences: Record<string, unknown> }) {
      state.views.push(this)
    }
    setBounds(): void {}
    setVisible(v: boolean): void {
      this.visible = v
    }
  }
  return {
    WebContentsView,
    BrowserWindow: {
      fromId: () =>
        state.windowGone ? null : { isDestroyed: () => false, contentView: { addChildView: () => {}, removeChildView: () => {} } }
    },
    session: {
      fromPartition: (p: string) => {
        if (!state.sessions.has(p)) state.sessions.set(p, new FakeSession())
        return state.sessions.get(p)
      }
    }
  }
})

const { ElectronWebviewFactory } = await import('../../src/main/webview/electron-webview')

function events(over: Partial<WebviewEvents> = {}): WebviewEvents & { log: string[] } {
  const log: string[] = []
  return {
    log,
    allowNavigation: (url, main) => (log.push(`nav ${main ? 'main' : 'sub'} ${url}`), url.startsWith('https://ok')),
    openWindow: (url) => void log.push(`open ${url}`),
    navigated: (commit) => void log.push(commit ? 'navigated' : 'title'),
    loadFailed: (url, error) => void log.push(`failed ${url} ${error}`),
    chord: (c) => (log.push(`chord ${c}`), c === 'meta+t'),
    gone: () => void log.push('gone'),
    ...over
  }
}

type Prevented = { defaultPrevented: boolean; preventDefault(): void }
/** An Electron event (extra fields: a navigation's url and frame kind) that records preventDefault. */
function prevented<T extends object>(fields: T = {} as T): Prevented & T {
  const e: Prevented & T = { ...fields, defaultPrevented: false, preventDefault: () => void (e.defaultPrevented = true) }
  return e
}

beforeEach(() => {
  state.sessions.clear()
  state.views.length = 0
  state.windowGone = false
})

describe('ElectronWebviewFactory', () => {
  it('makes a sandboxed view with no preload on the plugin\'s own partition', () => {
    new ElectronWebviewFactory(async () => new Response('')).create(1, 'webview-P1-a.one', events())
    const prefs = state.views[0]?.options.webPreferences
    expect(prefs).toMatchObject({
      partition: 'webview-P1-a.one',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    })
    expect(prefs).not.toHaveProperty('preload')
    expect(state.views[0]?.visible).toBe(false)
  })

  it('locks the session down once: permissions, devices and screen capture denied, downloads cancelled', () => {
    const factory = new ElectronWebviewFactory(async () => new Response(''))
    factory.create(1, 'webview-P1-a.one', events())
    factory.create(1, 'webview-P1-a.one', events())
    const ses = state.sessions.get('webview-P1-a.one') as FakeSession
    let granted: boolean | undefined
    ses.handlers.request?.(null, 'notifications', (g: boolean) => (granted = g), { isMainFrame: true, requestingUrl: 'https://x/' })
    expect(granted).toBe(false)
    expect(ses.handlers.check?.(null, 'clipboard-read', '', { isMainFrame: true, requestingUrl: 'https://x/' })).toBe(false)
    expect(ses.handlers.device?.()).toBe(false)
    let display: unknown = 'unset'
    ses.handlers.display?.({}, (d: unknown) => (display = d))
    expect(display).toBeNull()
    const download = prevented()
    ses.emit('will-download', download)
    expect(download.defaultPrevented).toBe(true)
    // Prepared once per session: one listener, not one per view.
    expect(ses.listeners.get('will-download')).toHaveLength(1)
  })

  it('answers cc-preview on the view\'s own session, with its own partition', async () => {
    const asked: string[] = []
    const factory = new ElectronWebviewFactory(async (partition, url, method) => {
      asked.push(`${partition} ${method} ${url}`)
      return new Response('ok')
    })
    factory.create(1, 'webview-P1-a.one', events())
    factory.create(1, 'webview-P2-a.one', events())
    const one = state.sessions.get('webview-P1-a.one') as FakeSession
    await one.protocols.get('cc-preview')?.({ url: 'cc-preview://t1/a.html', method: 'GET' })
    const two = state.sessions.get('webview-P2-a.one') as FakeSession
    await two.protocols.get('cc-preview')?.({ url: 'cc-preview://t2/b.html', method: 'GET' })
    expect(asked).toEqual(['webview-P1-a.one GET cc-preview://t1/a.html', 'webview-P2-a.one GET cc-preview://t2/b.html'])
  })

  it('keeps WebRTC off non-proxied UDP and denies window.open, handing the URL to the manager', () => {
    const ev = events()
    new ElectronWebviewFactory(async () => new Response('')).create(1, 'p', ev)
    const wc = state.views[0]?.webContents as FakeWebContents
    expect(wc.webrtcPolicy).toBe('disable_non_proxied_udp')
    expect(wc.openHandler?.({ url: 'https://pop.up/' })).toEqual({ action: 'deny' })
    expect(ev.log).toEqual(['open https://pop.up/'])
  })

  it('asks the manager about every frame navigation and redirect, and blocks what it refuses', () => {
    const ev = events()
    new ElectronWebviewFactory(async () => new Response('')).create(1, 'p', ev)
    const wc = state.views[0]?.webContents as FakeWebContents
    const refused = prevented({ url: 'file:///etc/passwd', isMainFrame: false })
    wc.emit('will-frame-navigate', refused)
    const allowed = prevented({ url: 'https://ok/', isMainFrame: true })
    wc.emit('will-frame-navigate', allowed)
    const redirect = prevented({ url: 'https://elsewhere/', isMainFrame: true })
    wc.emit('will-redirect', redirect)
    expect([refused.defaultPrevented, allowed.defaultPrevented, redirect.defaultPrevented]).toEqual([true, false, true])
    expect(ev.log).toEqual(['nav sub file:///etc/passwd', 'nav main https://ok/', 'nav main https://elsewhere/'])
  })

  it('sends every key chord to main and stops the ones it takes; reports navigation and a gone page', () => {
    const ev = events()
    new ElectronWebviewFactory(async () => new Response('')).create(1, 'p', ev)
    const wc = state.views[0]?.webContents as FakeWebContents
    const key = (k: string, meta: boolean) => ({ type: 'keyDown', key: k, code: `Key${k.toUpperCase()}`, meta, control: false, alt: false, shift: false })
    const taken = prevented()
    wc.emit('before-input-event', taken, key('t', true))
    const typed = prevented()
    wc.emit('before-input-event', typed, key('k', false))
    expect([taken.defaultPrevented, typed.defaultPrevented]).toEqual([true, false])
    wc.emit('did-navigate-in-page', {}, 'https://ok/#a', false) // a sub-frame: not reported
    wc.emit('did-navigate-in-page', {}, 'https://ok/#b', true)
    wc.emit('render-process-gone')
    expect(ev.log).toEqual(['chord meta+t', 'chord k', 'navigated', 'gone'])
  })

  // Review finding (ext round 10): a failed load only reached console.warn, so `ccc browser open`
  // printed `ok` with the dev server down and the toolbar never showed the failed URL.
  it('reports a main-frame load failure (not a superseded one) and rejects load with it', async () => {
    const ev = events()
    const view = new ElectronWebviewFactory(async () => new Response('')).create(1, 'p', ev)
    const wc = state.views[0]?.webContents as FakeWebContents
    wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:5173/', true)
    wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:9/frame', false) // a sub-frame
    wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://127.0.0.1:5173/old', true) // superseded
    wc.emit('page-title-updated', {}, '127.0.0.1:5173')
    expect(ev.log).toEqual(['failed http://127.0.0.1:5173/ ERR_CONNECTION_REFUSED (-102)', 'title'])

    wc.nextLoad = Promise.reject(Object.assign(new Error('ERR_CONNECTION_REFUSED (-102) loading ...'), { code: 'ERR_CONNECTION_REFUSED', errno: -102 }))
    await expect(view.load('http://127.0.0.1:5173/')).rejects.toThrow(/^ERR_CONNECTION_REFUSED \(-102\)$/)
    wc.nextLoad = Promise.reject(Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 }))
    await expect(view.load('http://127.0.0.1:5173/')).resolves.toBeUndefined()
    wc.nextLoad = Promise.resolve()
    await expect(view.load('https://ok/')).resolves.toBeUndefined()
  })

  // Review finding (ext round 9): a page's beforeunload silently cancelled `ccc browser open` and
  // reload once the user had touched it.
  it('never lets a page\'s beforeunload hold the view', () => {
    new ElectronWebviewFactory(async () => new Response('')).create(1, 'p', events())
    const wc = state.views[0]?.webContents as FakeWebContents
    const unload = prevented()
    wc.emit('will-prevent-unload', unload)
    expect(unload.defaultPrevented).toBe(true)
  })

  // Spike (2026-11-11): Electron already cancels both with no listener; the explicit cancel pins
  // it against an upgrade or an app-level listener. Same behaviour on the desktop as before.
  it('cancels HTTP auth and refuses a bad certificate, taking both from Electron\'s default', () => {
    new ElectronWebviewFactory(async () => new Response('')).create(1, 'p', events())
    const wc = state.views[0]?.webContents as FakeWebContents
    const login = prevented()
    const credentials: unknown[][] = []
    wc.emit('login', login, { url: 'http://127.0.0.1:1/auth' }, { scheme: 'basic' }, (...args: unknown[]) => credentials.push(args))
    expect(login.defaultPrevented).toBe(true)
    expect(credentials).toEqual([[]])
    const cert = prevented()
    const trusted: unknown[] = []
    wc.emit('certificate-error', cert, 'https://self.signed/', 'net::ERR_CERT_AUTHORITY_INVALID', {}, (t: boolean) => trusted.push(t))
    expect(cert.defaultPrevented).toBe(true)
    expect(trusted).toEqual([false])
  })

  // The off-screen cancels (file choosers, print) are server mode's: the desktop keeps uploads,
  // printing and the page's own dialogs.
  it('keeps the desktop page\'s pickers, print and dialogs: no protocol attached, dialogs not disabled', () => {
    new ElectronWebviewFactory(async () => new Response('')).create(1, 'p', events())
    const wc = state.views[0]?.webContents as FakeWebContents
    expect(wc.debugger.attached).toBe(false)
    expect(state.views[0]?.options.webPreferences).not.toHaveProperty('disableDialogs')
    expect(state.views[0]?.options.webPreferences).not.toHaveProperty('offscreen')
  })

  it('reports whether the page has the keyboard', () => {
    const view = new ElectronWebviewFactory(async () => new Response('')).create(1, 'p', events())
    const wc = state.views[0]?.webContents as FakeWebContents
    expect(view.isFocused()).toBe(false)
    wc.focused = true
    expect(view.isFocused()).toBe(true)
  })

  it('refuses to make a view for a window that is gone', () => {
    state.windowGone = true
    expect(() => new ElectronWebviewFactory(async () => new Response('')).create(1, 'p', events())).toThrow('the window is gone')
  })
})
