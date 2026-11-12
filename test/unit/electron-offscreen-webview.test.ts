// OffscreenWebviewFactory (electron-offscreen-webview.ts) with `electron` stubbed: server mode's
// webview page, asserted without launching Electron (the crash cases themselves were spiked
// against real Electron under the headless switches, design-web-browser.md §2). Checked here: the
// shared hardening is the desktop's (both adapters made in this file, their hooks compared), the
// window is off-screen with dialogs disabled, sized at once and never shown or focused, the
// off-screen cancels (file choosers, print) are sent, no key chords are forwarded, painting follows
// visibility, paints and cursor reach the sink, and the error paths (a failed or superseded load,
// a gone window, a closed project window, destroy twice) do what the manager expects.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebviewEvents } from '../../src/main/webview/webview-manager'
import { WEBVIEW_WORLD_ID } from '../../src/main/webview/webview-input'

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
  removeListener(name: string, fn: Listener): this {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((l) => l !== fn))
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

class FakeDebugger extends FakeEmitter {
  attachedWith: string | undefined
  readonly commands: Array<{ method: string; params: unknown }> = []
  attach(version: string): void {
    this.attachedWith = version
  }
  isAttached(): boolean {
    return this.attachedWith !== undefined
  }
  sendCommand(method: string, params?: unknown): Promise<unknown> {
    this.commands.push({ method, params })
    // A refusal: the protocol said no, or the page closed under the command.
    return state.refuse ? Promise.reject(new Error(`${method} refused`)) : Promise.resolve({})
  }
}

class FakeWebContents extends FakeEmitter {
  destroyed = false
  webrtcPolicy = ''
  openHandler: ((d: { url: string }) => { action: string }) | undefined
  readonly calls: string[] = []
  readonly debugger = new FakeDebugger()
  focused = true
  url = 'https://ok/'
  title = 'ok'
  canBack = true
  nextLoad: () => Promise<void> = () => Promise.resolve()
  readonly navigationHistory = {
    canGoBack: () => this.canBack,
    goBack: () => void this.calls.push('back'),
    canGoForward: () => false,
    goForward: () => void this.calls.push('forward')
  }
  setWebRTCIPHandlingPolicy(p: string): void {
    this.webrtcPolicy = p
  }
  setWindowOpenHandler(fn: (d: { url: string }) => { action: string }): void {
    this.openHandler = fn
  }
  setFrameRate(n: number): void {
    this.calls.push(`frameRate ${n}`)
  }
  startPainting(): void {
    this.calls.push('start')
  }
  stopPainting(): void {
    this.calls.push('stop')
  }
  invalidate(): void {
    this.calls.push('invalidate')
  }
  sendInputEvent(event: { type: string }): void {
    this.calls.push(`input ${event.type}`)
  }
  insertText(text: string): Promise<void> {
    this.calls.push(`text ${text}`)
    return Promise.resolve()
  }
  selection: unknown = 'picked'
  executeJavaScriptInIsolatedWorld(world: number, scripts: Array<{ code: string }>): Promise<unknown> {
    this.calls.push(`world ${world} ${scripts.length}`)
    return Promise.resolve(this.selection)
  }
  reload(): void {
    this.calls.push('reload')
  }
  loadURL(url: string): Promise<void> {
    this.calls.push(`load ${url}`)
    return this.nextLoad()
  }
  getURL(): string {
    return this.url
  }
  getTitle(): string {
    return this.title
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isFocused(): boolean {
    return this.focused
  }
  /** Set from the window's `webPreferences.offscreen`, as Electron does. */
  offscreen = false
  readonly id = ++nextId
  isOffscreen(): boolean {
    return this.offscreen
  }
}

let nextId = 100

const state = {
  refuse: false,
  sessions: new Map<string, FakeSession>(),
  owner: undefined as FakeOwner | undefined,
  windows: [] as FakeOffscreenWindow[],
  views: [] as Array<{ webContents: FakeWebContents }>
}

class FakeOwner extends FakeEmitter {
  destroyed = false
  readonly contentView = { addChildView: () => {}, removeChildView: () => {} }
  isDestroyed(): boolean {
    return this.destroyed
  }
}

class FakeOffscreenWindow extends FakeEmitter {
  readonly webContents = new FakeWebContents()
  readonly sizes: Array<[number, number]> = []
  readonly forbidden: string[] = []
  destroyCount = 0
  readonly id = ++nextId
  constructor(readonly options: { show?: boolean; webPreferences: Record<string, unknown> }) {
    super()
    this.webContents.offscreen = options.webPreferences?.offscreen === true
  }
  isVisible(): boolean {
    return false
  }
  isFocused(): boolean {
    return false
  }
  setContentSize(w: number, h: number): void {
    this.sizes.push([w, h])
  }
  destroy(): void {
    this.destroyCount++
    this.webContents.destroyed = true
    this.webContents.emit('destroyed')
  }
  isDestroyed(): boolean {
    return this.destroyCount > 0
  }
  // Never to be called on an off-screen view's window (it has no screen).
  show(): void {
    this.forbidden.push('show')
  }
  focus(): void {
    this.forbidden.push('focus')
  }
  setBounds(): void {
    this.forbidden.push('setBounds')
  }
}

vi.mock('electron', () => ({
  BrowserWindow: class extends FakeOffscreenWindow {
    static fromId(): FakeOwner | null {
      return state.owner ?? null
    }
    constructor(options: { webPreferences: Record<string, unknown> }) {
      super(options)
      state.windows.push(this)
    }
  },
  WebContentsView: class {
    readonly webContents = new FakeWebContents()
    constructor(readonly options: unknown) {
      state.views.push(this)
    }
    setBounds(): void {}
    setVisible(): void {}
  },
  session: {
    fromPartition: (p: string) => {
      if (!state.sessions.has(p)) state.sessions.set(p, new FakeSession())
      return state.sessions.get(p)
    }
  }
}))

// vi.mock is hoisted above the fakes it names; its factory runs at the first import of
// 'electron' (below), when they exist.
const { isOffscreenWindow, OffscreenWebviewFactory, OFFSCREEN_INITIAL_SIZE, OFFSCREEN_MAX_SIDE } = await import(
  '../../src/main/webview/electron-offscreen-webview'
)
const { ElectronWebviewFactory } = await import('../../src/main/webview/electron-webview')
const { PRINT_DISABLED_SOURCE } = await import('../../src/main/webview/webview-hardening')

function events(over: Partial<WebviewEvents> = {}): WebviewEvents & { log: string[] } {
  const log: string[] = []
  return {
    log,
    allowNavigation: (url, main) => (log.push(`nav ${main ? 'main' : 'sub'} ${url}`), url.startsWith('https://ok')),
    openWindow: (url) => void log.push(`open ${url}`),
    navigated: (commit) => void log.push(commit ? 'navigated' : 'title'),
    loadFailed: (url, error) => void log.push(`failed ${url} ${error}`),
    chord: (c) => (log.push(`chord ${c}`), true),
    gone: () => void log.push('gone'),
    ...over
  }
}

type Prevented = { defaultPrevented: boolean; preventDefault(): void }
function prevented<T extends object>(fields: T = {} as T): Prevented & T {
  const e: Prevented & T = { ...fields, defaultPrevented: false, preventDefault: () => void (e.defaultPrevented = true) }
  return e
}

const serve = async (): Promise<Response> => new Response('')

function make(ev = events(), logs: string[] = []) {
  const view = new OffscreenWebviewFactory(serve, (m) => void logs.push(m)).create(1, 'webview-P1-a.one', ev)
  const win = state.windows.at(-1) as FakeOffscreenWindow
  return { view, win, wc: win.webContents, ev, logs }
}

/** Let the sendCommand rejections settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  state.sessions.clear()
  state.windows.length = 0
  state.views.length = 0
  state.owner = new FakeOwner()
  state.refuse = false
})

describe('OffscreenWebviewFactory', () => {
  it('makes an off-screen window with dialogs disabled and the desktop\'s hardened preferences', () => {
    const { win } = make()
    const prefs = win.options.webPreferences
    expect(win.options.show).toBe(false)
    expect(prefs).toMatchObject({
      offscreen: true,
      disableDialogs: true,
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
  })

  // Spike: under the headless platform the window starts 1x1 whatever width/height say.
  it('sizes the page right after creation, paints at most 30 fps, starts hidden and is never shown or focused', () => {
    const { view, win, wc } = make()
    expect(win.sizes).toEqual([[OFFSCREEN_INITIAL_SIZE.width, OFFSCREEN_INITIAL_SIZE.height]])
    expect(view.size()).toEqual(OFFSCREEN_INITIAL_SIZE)
    expect(wc.calls).toEqual(['frameRate 30', 'stop'])
    view.setVisible(true)
    view.setBounds({ x: 10, y: 20, width: 640, height: 480 })
    expect(win.forbidden).toEqual([])
    // Nothing here ever has the keyboard, whatever the WebContents says.
    expect(view.isFocused()).toBe(false)
  })

  it('applies the same hardening as the desktop adapter: the same hooks, minus the chords, plus paint and cursor', () => {
    make()
    new ElectronWebviewFactory(serve).create(1, 'webview-P1-b.two', events())
    const offscreen = [...(state.windows[0]?.webContents.listeners.keys() ?? [])].sort()
    const desktop = [...(state.views[0]?.webContents.listeners.keys() ?? [])].sort()
    expect(desktop).toContain('before-input-event')
    expect(offscreen).not.toContain('before-input-event')
    expect(offscreen.filter((n) => n !== 'paint' && n !== 'cursor-changed')).toEqual(desktop.filter((n) => n !== 'before-input-event'))
    for (const hook of ['will-frame-navigate', 'will-redirect', 'will-prevent-unload', 'login', 'certificate-error', 'select-client-certificate', 'did-fail-load', 'render-process-gone', 'destroyed']) {
      expect(offscreen).toContain(hook)
    }
  })

  it('locks the session down once and answers cc-preview on it', async () => {
    const asked: string[] = []
    const factory = new OffscreenWebviewFactory(async (partition, url, method) => {
      asked.push(`${partition} ${method} ${url}`)
      return new Response('ok')
    }, () => {})
    factory.create(1, 'webview-P1-a.one', events())
    factory.create(1, 'webview-P1-a.one', events())
    const ses = state.sessions.get('webview-P1-a.one') as FakeSession
    let granted: boolean | undefined
    ses.handlers.request?.(null, 'notifications', (g: boolean) => (granted = g), { isMainFrame: true, requestingUrl: 'https://x/' })
    expect(granted).toBe(false)
    const download = prevented()
    ses.emit('will-download', download)
    expect(download.defaultPrevented).toBe(true)
    expect(ses.listeners.get('will-download')).toHaveLength(1)
    await ses.protocols.get('cc-preview')?.({ url: 'cc-preview://t1/a.html', method: 'GET' })
    expect(asked).toEqual(['webview-P1-a.one GET cc-preview://t1/a.html'])
  })

  it('forwards no key chord: a key typed into the page is the page\'s', () => {
    const { wc, ev } = make()
    expect(wc.listeners.has('before-input-event')).toBe(false)
    expect(ev.log).toEqual([])
  })

  it('hands navigation, window.open, unload, auth and certificates to the shared rules', () => {
    const { wc, ev } = make()
    expect(wc.webrtcPolicy).toBe('disable_non_proxied_udp')
    expect(wc.openHandler?.({ url: 'https://pop.up/' })).toEqual({ action: 'deny' })
    const sub = prevented({ url: 'mailto:someone@example.com', isMainFrame: false })
    wc.emit('will-frame-navigate', sub)
    const unload = prevented()
    wc.emit('will-prevent-unload', unload)
    const login = prevented()
    const credentials: unknown[][] = []
    wc.emit('login', login, {}, {}, (...a: unknown[]) => credentials.push(a))
    const cert = prevented()
    const trusted: unknown[] = []
    wc.emit('certificate-error', cert, 'https://x/', 'net::ERR_CERT_AUTHORITY_INVALID', {}, (t: boolean) => trusted.push(t))
    expect([sub.defaultPrevented, unload.defaultPrevented, login.defaultPrevented, cert.defaultPrevented]).toEqual([true, true, true, true])
    expect(credentials).toEqual([[]])
    expect(trusted).toEqual([false])
    expect(ev.log).toEqual(['open https://pop.up/', 'nav sub mailto:someone@example.com'])
  })

  // Spike: with a desktop portal on the session bus, print() blocked the page and the pickers
  // opened the portal's dialogs on the host's desktop.
  it('cancels the page\'s file choosers, pickers and print through its protocol, before the first load', () => {
    const { wc } = make()
    expect(wc.debugger.attachedWith).toBe('1.3')
    expect(wc.debugger.commands).toEqual([
      { method: 'Page.enable', params: undefined },
      { method: 'Page.setInterceptFileChooserDialog', params: { enabled: true, cancel: true } },
      { method: 'Page.addScriptToEvaluateOnNewDocument', params: { source: PRINT_DISABLED_SOURCE, runImmediately: true } }
    ])
    expect(wc.calls.some((c) => c.startsWith('load'))).toBe(false)
  })

  it('disables print for good: a no-op the page can neither overwrite nor delete', () => {
    let printed = 0
    const page: { print?: () => void } = { print: () => void printed++ }
    // The script as Chromium runs it, with `window` the page's global.
    new Function('window', PRINT_DISABLED_SOURCE)(page)
    page.print?.()
    expect(printed).toBe(0)
    expect(Object.getOwnPropertyDescriptor(page, 'print')).toMatchObject({ writable: false, configurable: false })
    // A module is strict code, where a failed delete throws (sloppy page code gets false).
    expect(() => delete page.print).toThrow(TypeError)
  })

  it('still makes the view when the protocol cannot be attached, and says so', () => {
    const logs: string[] = []
    const factory = new OffscreenWebviewFactory(serve, (m) => void logs.push(m))
    const original = FakeDebugger.prototype.attach
    FakeDebugger.prototype.attach = () => {
      throw new Error('Another debugger is already attached')
    }
    try {
      const view = factory.create(1, 'p', events())
      expect(view.current()).toEqual({ url: 'https://ok/', title: 'ok' })
    } finally {
      FakeDebugger.prototype.attach = original
    }
    expect(logs).toEqual(["webview: attaching the page's protocol for its cancels failed: Another debugger is already attached"])
    expect(state.windows[0]?.webContents.debugger.commands).toEqual([])
  })

  it('logs a refused cancel command, but not one the closing page cut short', async () => {
    const logs: string[] = []
    const factory = new OffscreenWebviewFactory(serve, (m) => void logs.push(m))
    try {
      // Every command refused: each one is logged, and the view is still made.
      state.refuse = true
      factory.create(1, 'p', events())
      await settle()
      expect(logs).toEqual([
        'webview: Page.enable failed: Page.enable refused',
        'webview: Page.setInterceptFileChooserDialog failed: Page.setInterceptFileChooserDialog refused',
        'webview: Page.addScriptToEvaluateOnNewDocument failed: Page.addScriptToEvaluateOnNewDocument refused'
      ])
      // Refused because the page closed under them: nothing to say.
      logs.length = 0
      factory.create(1, 'p', events())
      ;(state.windows.at(-1) as FakeOffscreenWindow).webContents.destroyed = true
      await settle()
      expect(logs).toEqual([])
    } finally {
      state.refuse = false
    }
  })

  it('reports the protocol detaching for any reason but the page closing', () => {
    const { wc, view, logs } = make()
    wc.debugger.emit('detach', {}, 'target closed')
    wc.debugger.emit('detach', {}, 'canceled_by_user')
    expect(logs).toEqual(["webview: the page's protocol detached (canceled_by_user); its pickers and print are no longer cancelled"])
    logs.length = 0
    view.destroy()
    wc.debugger.emit('detach', {}, 'Render process gone.')
    expect(logs).toEqual([])
  })

  it('resizes the page from setBounds: whole pixels, capped, zero or broken sizes kept out, repeats skipped', () => {
    const { view, win } = make()
    win.sizes.length = 0
    view.setBounds({ x: 5, y: 5, width: 900.4, height: 499.6 })
    view.setBounds({ x: 50, y: 50, width: 900, height: 500 }) // same size elsewhere: no reflow
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 }) // the manager's "no placement yet"
    view.setBounds({ x: 0, y: 0, width: Number.NaN, height: 300 })
    view.setBounds({ x: 0, y: 0, width: -5, height: 300 })
    view.setBounds({ x: 0, y: 0, width: 100_000, height: 1e9 })
    expect(win.sizes).toEqual([
      [900, 500],
      [OFFSCREEN_MAX_SIDE, OFFSCREEN_MAX_SIDE]
    ])
    expect(view.size()).toEqual({ width: OFFSCREEN_MAX_SIDE, height: OFFSCREEN_MAX_SIDE })
  })

  it('paints only while visible: start plus a full frame when shown, stop when hidden, repeats ignored', () => {
    const { view, wc } = make()
    wc.calls.length = 0
    view.setVisible(true)
    view.setVisible(true)
    view.setVisible(false)
    view.setVisible(false)
    view.setVisible(true)
    expect(wc.calls).toEqual(['start', 'invalidate', 'stop', 'start', 'invalidate'])
    view.invalidate()
    expect(wc.calls.at(-1)).toBe('invalidate')
  })

  it('hands paints and cursor changes to the sink, and drops them with none', () => {
    const { view, wc } = make()
    const got: string[] = []
    wc.emit('paint', {}, { x: 0, y: 0, width: 1, height: 1 }, 'image-0') // no sink yet: dropped
    view.setSink({ paint: (dirty, image) => void got.push(`paint ${dirty.width} ${String(image)}`), cursor: (t) => void got.push(`cursor ${t}`) })
    wc.emit('paint', {}, { x: 0, y: 0, width: 10, height: 10 }, 'image-1')
    wc.emit('cursor-changed', {}, 'hand')
    view.setSink(undefined)
    wc.emit('paint', {}, { x: 0, y: 0, width: 10, height: 10 }, 'image-2')
    expect(got).toEqual(['paint 10 image-1', 'cursor hand'])
  })

  // Task 7: a browser's checked input (webview-input.ts) goes to the page as trusted input, and
  // never focuses or shows the window to get there.
  it('sends input with sendInputEvent, in order, and nothing once the page is gone', () => {
    const { view, wc, win } = make()
    wc.calls.length = 0
    view.sendInput([
      { type: 'mouseDown', x: 1, y: 1, button: 'left', clickCount: 1, modifiers: [] },
      { type: 'keyDown', keyCode: 'a', modifiers: [] },
      { type: 'char', keyCode: 'a', modifiers: [] }
    ])
    expect(wc.calls).toEqual(['input mouseDown', 'input keyDown', 'input char'])
    expect(win.forbidden).toEqual([])
    view.destroy()
    wc.calls.length = 0
    view.sendInput([{ type: 'mouseMove', x: 1, y: 1, modifiers: [] }])
    expect(wc.calls).toEqual([])
  })

  // Task 8: committed text goes in as an IME commit; the selection is read in main's isolated world.
  it('inserts text and reads the selection in its own isolated world, and neither once the page is gone', async () => {
    const { view, wc, win } = make()
    wc.calls.length = 0
    const commands = wc.debugger.commands.length
    // Through the page's protocol (the input pipe, in order with sendInputEvent), settled once the
    // page has it; not webContents.insertText (an IPC a key can overtake).
    await expect(view.insertText?.('héllo')).resolves.toBeDefined()
    expect(wc.debugger.commands.slice(commands)).toEqual([{ method: 'Input.insertText', params: { text: 'héllo' } }])
    await expect(view.readSelection?.()).resolves.toBe('picked')
    expect(wc.calls).toEqual([`world ${WEBVIEW_WORLD_ID} 1`])
    // A protocol that detached: webContents.insertText is the fallback.
    wc.debugger.attachedWith = undefined
    await view.insertText?.('ü')
    expect(wc.calls).toEqual([`world ${WEBVIEW_WORLD_ID} 1`, 'text ü'])
    wc.calls.length = 0
    expect(WEBVIEW_WORLD_ID).not.toBe(0)
    expect(WEBVIEW_WORLD_ID).not.toBe(999)
    expect(win.forbidden).toEqual([])
    view.destroy()
    wc.calls.length = 0
    view.insertText?.('x')
    await expect(view.readSelection?.()).resolves.toBeUndefined()
    expect(wc.calls).toEqual([])
  })

  // Task 9: a select's hit-test and the browser's answer run in the same isolated world.
  it('hit-tests and answers selects in its own isolated world, and neither once the page is gone', async () => {
    const { view, wc } = make()
    const id = 'c'.repeat(32)
    wc.calls.length = 0
    wc.selection = null
    await expect(view.hitSelect?.(3, 4, id)).resolves.toBeNull()
    await view.chooseSelect?.(id, 1)
    expect(wc.calls).toEqual([`world ${WEBVIEW_WORLD_ID} 1`, `world ${WEBVIEW_WORLD_ID} 1`])
    view.destroy()
    wc.calls.length = 0
    await expect(view.hitSelect?.(3, 4, id)).resolves.toBeUndefined()
    await expect(view.chooseSelect?.(id, 1)).resolves.toBe(false)
    expect(wc.calls).toEqual([])
  })

  it('reports a main-frame load failure and rejects load with it; a superseded load resolves', async () => {
    const { view, wc, ev } = make()
    wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:5173/', true)
    wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:9/frame', false)
    wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://127.0.0.1:5173/old', true)
    expect(ev.log).toEqual(['failed http://127.0.0.1:5173/ ERR_CONNECTION_REFUSED (-102)'])
    wc.nextLoad = () => Promise.reject(Object.assign(new Error('ERR_CERT_AUTHORITY_INVALID (-202) loading ...'), { code: 'ERR_CERT_AUTHORITY_INVALID', errno: -202 }))
    await expect(view.load('https://self.signed/')).rejects.toThrow(/^ERR_CERT_AUTHORITY_INVALID \(-202\)$/)
    wc.nextLoad = () => Promise.reject(Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 }))
    await expect(view.load('https://ok/b')).resolves.toBeUndefined()
    wc.nextLoad = () => Promise.reject(new Error('something else'))
    await expect(view.load('https://ok/c')).rejects.toThrow('something else')
    wc.nextLoad = () => Promise.resolve()
    await expect(view.load('https://ok/')).resolves.toBeUndefined()
  })

  it('steps through history and reloads like the desktop view', () => {
    const { view, wc } = make()
    wc.calls.length = 0
    view.back()
    wc.canBack = false
    view.back()
    view.forward() // nothing ahead
    view.reload()
    expect(wc.calls).toEqual(['back', 'reload'])
  })

  it('refuses to make a view for a window that is gone', () => {
    state.owner = undefined
    expect(() => make()).toThrow('the window is gone')
    state.owner = new FakeOwner()
    state.owner.destroyed = true
    expect(() => make()).toThrow('the window is gone')
    expect(state.windows).toEqual([])
  })

  it('destroys its window once, tells the manager the page went, and is a no-op afterwards', async () => {
    const { view, win, wc, ev } = make()
    const owner = state.owner as FakeOwner
    view.setSink({ paint: () => void ev.log.push('late paint'), cursor: () => {} })
    view.destroy()
    view.destroy()
    expect(win.destroyCount).toBe(1)
    expect(ev.log).toEqual(['gone'])
    expect(owner.listeners.get('closed')).toEqual([])
    // After destroy nothing reaches the page or the sink.
    wc.calls.length = 0
    view.setBounds({ x: 0, y: 0, width: 300, height: 300 })
    view.setVisible(true)
    view.invalidate()
    view.back()
    view.reload()
    view.setSink({ paint: () => void ev.log.push('late paint'), cursor: () => {} })
    wc.emit('paint', {}, { x: 0, y: 0, width: 1, height: 1 }, 'img')
    expect(wc.calls).toEqual([])
    expect(win.sizes).toHaveLength(1)
    expect(view.current()).toEqual({ url: '', title: '' })
    await expect(view.load('https://ok/')).resolves.toBeUndefined()
    expect(ev.log).toEqual(['gone'])
  })

  it('goes with its project window, which is not its parent', () => {
    const { view, win, ev } = make()
    ;(state.owner as FakeOwner).emit('closed')
    expect(win.destroyCount).toBe(1)
    expect(ev.log).toEqual(['gone'])
    view.destroy()
    expect(win.destroyCount).toBe(1)
  })

  it('reports a crashed page as gone', () => {
    const { wc, ev } = make()
    wc.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(ev.log).toEqual(['gone'])
  })

  // main's app-wide window events see these windows too (plan Task 2): index.ts skips them by this.
  it('tells its own windows from every other window, a destroyed one included', () => {
    const { win } = make()
    expect(isOffscreenWindow(win as never)).toBe(true)
    // A project window, the picker or the hidden page: an ordinary BrowserWindow.
    const ordinary = new FakeOffscreenWindow({ webPreferences: {} })
    expect(isOffscreenWindow(ordinary as never)).toBe(false)
    win.destroy()
    expect(isOffscreenWindow(win as never)).toBe(false)
  })

  it('lists its live windows (never shown or focused) and forgets each one that goes', () => {
    const factory = new OffscreenWebviewFactory(serve, () => {})
    const a = factory.create(1, 'webview-P1-a.one', events())
    const winA = state.windows.at(-1) as FakeOffscreenWindow
    factory.create(1, 'webview-P1-a.two', events())
    const winB = state.windows.at(-1) as FakeOffscreenWindow
    a.setVisible(true)
    expect(factory.describe()).toEqual([
      {
        windowId: winA.id,
        webContentsId: winA.webContents.id,
        ownerWindowId: 1,
        visible: false,
        focused: false,
        painting: true,
        ...OFFSCREEN_INITIAL_SIZE
      },
      {
        windowId: winB.id,
        webContentsId: winB.webContents.id,
        ownerWindowId: 1,
        visible: false,
        focused: false,
        painting: false,
        ...OFFSCREEN_INITIAL_SIZE
      }
    ])
    a.destroy()
    expect(factory.describe().map((v) => v.windowId)).toEqual([winB.id])
    winB.destroy()
    expect(factory.describe()).toEqual([])
  })

  it('destroyAll (main\'s before-quit) destroys every live window, without a close, and each tells the manager', () => {
    const factory = new OffscreenWebviewFactory(serve, () => {})
    const evA = events()
    const evB = events()
    factory.create(1, 'webview-P1-a.one', evA)
    const winA = state.windows.at(-1) as FakeOffscreenWindow
    const b = factory.create(1, 'webview-P1-a.two', evB)
    const winB = state.windows.at(-1) as FakeOffscreenWindow
    factory.destroyAll()
    expect([winA.destroyCount, winB.destroyCount]).toEqual([1, 1])
    expect([evA.log, evB.log]).toEqual([['gone'], ['gone']])
    expect(factory.describe()).toEqual([])
    expect((state.owner as FakeOwner).listeners.get('closed')).toEqual([])
    // The view's own destroy afterwards, and a second destroyAll, are no-ops.
    b.destroy()
    factory.destroyAll()
    expect(winB.destroyCount).toBe(1)
  })
})
