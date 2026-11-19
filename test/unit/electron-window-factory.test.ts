// createWindow and ElectronWindowFactory (main/windows/) with `electron` stubbed, for server mode's hidden
// page (docs/plans/20261119-server-mode-mac.md decision 1, both server platforms): given `server` at
// construction, no window is ever shown (not on ready-to-show, not by a saved maximised or full-screen
// state, not by the handle's focus) and its page gets `backgroundThrottling: false`, which no caller can
// turn back on. The desktop keeps showing its windows on ready-to-show with the default throttling.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectView } from '../../src/shared/types'
import type { WindowCallbacks } from '../../src/main/windows/window-manager'

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

let nextId = 1

class FakeWindow extends FakeEmitter {
  readonly id = nextId++
  readonly calls: string[] = []
  readonly webContents = Object.assign(new FakeEmitter(), {
    id: nextId++,
    focusedFrame: null,
    setWindowOpenHandler: () => {}
  })
  constructor(readonly options: Record<string, unknown>) {
    super()
    state.windows.push(this)
  }
  show(): void {
    this.calls.push('show')
  }
  focus(): void {
    this.calls.push('focus')
  }
  maximize(): void {
    this.calls.push('maximize')
  }
  setFullScreen(on: boolean): void {
    this.calls.push(`fullScreen:${on}`)
  }
  restore(): void {
    this.calls.push('restore')
  }
  isMinimized(): boolean {
    return false
  }
  isDestroyed(): boolean {
    return false
  }
  setMenuBarVisibility(): void {}
  async loadFile(): Promise<void> {}
  async loadURL(): Promise<void> {}
  static fromId(): null {
    return null
  }
}

const state = { windows: [] as FakeWindow[] }

vi.mock('electron', () => ({
  BrowserWindow: FakeWindow,
  nativeTheme: { shouldUseDarkColors: false },
  screen: { getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }), getAllDisplays: () => [] }
}))

const { createWindow } = await import('../../src/main/windows/create-window')
const { ElectronWindowFactory } = await import('../../src/main/windows/electron-window-factory')

const project = { id: 'p1', name: 'proj', path: '/tmp/proj' } as unknown as ProjectView
const callbacks: WindowCallbacks = {
  onBoundsChanged: () => {},
  onFullScreenChanged: () => {},
  onClosed: () => {}
} as unknown as WindowCallbacks
const look = { transparent: false, blur: false } as never
const openLink = async (): Promise<void> => {}

function only(): FakeWindow {
  expect(state.windows).toHaveLength(1)
  return state.windows[0]!
}

function prefs(win: FakeWindow): Record<string, unknown> {
  return win.options.webPreferences as Record<string, unknown>
}

beforeEach(() => {
  state.windows.length = 0
})

describe('createWindow', () => {
  it('desktop: shown on ready-to-show, default throttling', () => {
    const win = createWindow({}, openLink) as unknown as FakeWindow
    expect(win.options.show).toBe(false)
    expect('backgroundThrottling' in prefs(win)).toBe(false)
    win.emit('ready-to-show')
    expect(win.calls).toEqual(['show'])
  })

  it('server: never shown, backgroundThrottling false even when the caller asks for it', () => {
    const win = createWindow(
      { show: true, webPreferences: { backgroundThrottling: true } },
      openLink,
      { server: true }
    ) as unknown as FakeWindow
    expect(prefs(win).backgroundThrottling).toBe(false)
    expect(win.listeners.get('ready-to-show') ?? []).toEqual([])
    win.emit('ready-to-show')
    expect(win.calls).toEqual([])
    // The security flags are still forced.
    expect(prefs(win)).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false })
  })
})

describe('ElectronWindowFactory', () => {
  it('desktop: a maximised project window is shown, then maximised; focus shows it', () => {
    const handle = new ElectronWindowFactory(openLink).createProjectWindow(
      project,
      { x: 0, y: 0, width: 1000, height: 700, maximized: true },
      callbacks,
      look
    )
    const win = only()
    win.emit('ready-to-show')
    expect(win.calls).toEqual(['show', 'maximize'])
    handle.focus()
    expect(win.calls).toEqual(['show', 'maximize', 'show', 'focus'])
  })

  it.each(['darwin', 'linux'] as const)('server (%s): a project window with saved flags is never shown, maximised or focused', (platform) => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: platform })
    try {
      const factory = new ElectronWindowFactory(openLink, true)
      const handle = factory.createProjectWindow(
        project,
        { x: 0, y: 0, width: 1000, height: 700, maximized: true, fullScreen: true },
        callbacks,
        look
      )
      const win = only()
      expect(prefs(win).backgroundThrottling).toBe(false)
      win.emit('ready-to-show')
      handle.focus()
      expect(win.calls).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', { value: original })
    }
  })

  it('server: a picker window (never asked for there) is not shown either', () => {
    new ElectronWindowFactory(openLink, true).createPickerWindow({ onClosed: () => {} })
    const win = only()
    win.emit('ready-to-show')
    expect(win.calls).toEqual([])
    expect(prefs(win).backgroundThrottling).toBe(false)
  })
})
