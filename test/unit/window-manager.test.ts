import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as nodeFs from 'node:fs'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectFile } from '../../src/main/paths'
import { ProjectRegistry } from '../../src/main/projects/registry'
import {
  asSecondInstanceData,
  projectPathFromArgv,
  PAGE_RELOAD_FIRST_MS,
  PAGE_RELOAD_MAX_MS,
  PAGE_RELOAD_RESET_MS,
  WindowManager,
  type Rect,
  type WindowCallbacks,
  type WindowFactory,
  type WindowHandle
} from '../../src/main/windows/window-manager'
import type { ProjectWindowLook } from '../../src/main/windows/window-chrome'
import type { CloseChoice } from '../../src/main/windows/close-dialog'
import { ViewRegistry } from '../../src/main/views/view-registry'
import { handleSecondInstance, IGNORED_LINE } from '../../src/main/second-launch'
import { openHandler } from '../../src/main/socket/handlers'
import { openProjectFromWeb } from '../../src/main/web/open-project'
import type { ProjectView, WindowBounds } from '../../src/shared/types'

/** A window the fake factory made; `userClose()` simulates the user (or quit) closing it. */
interface FakeWindow extends WindowHandle {
  kind: 'picker' | 'project'
  projectId?: string
  createdWith?: WindowBounds
  focused: number
  closed: boolean
  minimized: boolean
  fullScreen: boolean
  /** Off screen (kept running for a browser); `focus` shows it again, as BrowserWindow.show. */
  hidden: boolean
  /** How many times `hide` was called. */
  hides: number
  /** How many times its page was loaded again (`reload`). */
  reloads: number
  /** The project window id this picker was created as a modal child of. */
  parentId?: number
  bounds: WindowBounds
  callbacks: Partial<WindowCallbacks>
  /** The look a project window was created with (none for a picker: it is never asked for one). */
  look?: ProjectWindowLook
  /** Every setBlur call, in order. */
  blurCalls: boolean[]
  /** Every event its page was sent through its view sink. */
  sent: Array<{ channel: string; payload: unknown }>
  userClose(): void
}

class FakeFactory implements WindowFactory {
  windows: FakeWindow[] = []
  displays: Rect[] = [{ x: 0, y: 0, width: 1920, height: 1080 }]
  private nextId = 1

  createProjectWindow(
    project: ProjectView,
    bounds: WindowBounds | undefined,
    callbacks: WindowCallbacks,
    look: ProjectWindowLook
  ): WindowHandle {
    const win = this.make('project', callbacks, project.id, bounds)
    win.look = look
    return win
  }

  createPickerWindow(callbacks: Pick<WindowCallbacks, 'onClosed'>, parentId?: number): WindowHandle {
    const win = this.make('picker', callbacks)
    win.parentId = parentId
    return win
  }

  workAreas(): Rect[] {
    return this.displays
  }

  open(kind: 'picker' | 'project'): FakeWindow[] {
    return this.windows.filter((w) => w.kind === kind && !w.closed)
  }

  private make(
    kind: 'picker' | 'project',
    callbacks: Partial<WindowCallbacks>,
    projectId?: string,
    createdWith?: WindowBounds
  ): FakeWindow {
    const id = this.nextId++
    const win: FakeWindow = {
      id,
      // A webContents id distinct from the window id, as in Electron.
      senderId: id + 100,
      kind,
      projectId,
      createdWith,
      focused: 0,
      closed: false,
      minimized: false,
      fullScreen: false,
      hidden: false,
      hides: 0,
      reloads: 0,
      bounds: createdWith ?? { x: 10, y: 10, width: 800, height: 600 },
      callbacks,
      blurCalls: [],
      sent: [],
      sink: {
        send: (channel, payload) => win.sent.push({ channel, payload }),
        isClosed: () => win.closed
      },
      setBlur(on) {
        win.blurCalls.push(on)
      },
      focus() {
        win.focused++
        win.hidden = false
      },
      hide() {
        win.hides++
        win.hidden = true
      },
      reload() {
        win.reloads++
      },
      // Programmatic close and a user close look the same to the manager: `close` is asked
      // (onCloseRequested, which may keep the window open, as preventDefault does), then `closed`.
      close() {
        win.userClose()
      },
      getBounds() {
        return win.bounds
      },
      isMinimized() {
        return win.minimized
      },
      isFullScreen() {
        return win.fullScreen
      },
      userClose() {
        if (win.closed) return
        if (callbacks.onCloseRequested?.()) return
        win.closed = true
        callbacks.onClosed?.()
      }
    }
    this.windows.push(win)
    return win
  }
}

let root: string
let work: string
let registry: ProjectRegistry
let factory: FakeFactory
let quits: number

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-windows-')))
  work = join(root, 'work')
  mkdirSync(work)
  registry = new ProjectRegistry({ dataDir: join(root, 'data'), log: () => {} })
  factory = new FakeFactory()
  quits = 0
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function manager(platform: NodeJS.Platform = 'darwin'): WindowManager {
  return new WindowManager({ factory, registry, platform, quit: () => quits++ })
}

function folder(name: string): string {
  const p = join(work, name)
  mkdirSync(p)
  return p
}

describe('open or focus', () => {
  it('opens one window per project and focuses it on a second open', () => {
    const wm = manager()
    const a = folder('a')
    const first = wm.openPath(a)
    // Same folder again, through a trailing slash: same project, no second window.
    const again = wm.openPath(`${a}/`)
    expect(again.id).toBe(first.id)
    const wins = factory.open('project')
    expect(wins).toHaveLength(1)
    expect(wins[0]!.focused).toBe(1)
    expect(wm.windowIdOf(first.id)).toBe(wins[0]!.id)
  })

  it('opens a separate window for a different project', () => {
    const wm = manager()
    wm.openPath(folder('a'))
    wm.openPath(folder('b'))
    expect(factory.open('project')).toHaveLength(2)
  })

  it('records the open project for restore', () => {
    const wm = manager()
    const view = wm.openPath(folder('a'))
    expect(registry.openIds()).toEqual([view.id])
  })

  it('refuses a known project whose folder is gone, without a window', () => {
    const wm = manager()
    const a = folder('a')
    const view = wm.openPath(a)
    factory.open('project')[0]!.userClose()
    rmSync(a, { recursive: true })
    expect(() => wm.openPath(a)).toThrow(/missing/)
    expect(factory.open('project')).toHaveLength(0)
    expect(registry.get(view.id)?.missing).toBe(true)
  })

  it('throws for a path that is not a directory', () => {
    expect(() => manager().openPath(join(work, 'nope'))).toThrow(/not a directory/)
    expect(factory.windows).toHaveLength(0)
  })

  it('openRecent opens only ids from the recent list', () => {
    const wm = manager()
    const view = wm.openPath(folder('a'))
    factory.open('project')[0]!.userClose()
    expect(() => wm.openRecent('0123456789abcdef')).toThrow(/not a recent project/)
    wm.openRecent(view.id)
    expect(factory.open('project').map((w) => w.projectId)).toEqual([view.id])
  })
})

describe('picker as a modal of the calling window', () => {
  it('opens as a modal child of the project window that asked', () => {
    const wm = manager()
    wm.openPath(folder('a'))
    const parent = factory.open('project')[0]!
    wm.showPicker(parent.id)
    expect(factory.open('picker')[0]!.parentId).toBe(parent.id)
  })

  it('is standalone with no caller, or a caller that is not a project window of the manager', () => {
    const wm = manager()
    wm.showPicker()
    expect(factory.open('picker')[0]!.parentId).toBeUndefined()
    wm.openPath(folder('a'))
    wm.showPicker(9999)
    expect(factory.open('picker')[0]!.parentId).toBeUndefined()
    // The picker's own window id is no caller either.
    const picker = factory.open('picker')[0]!
    picker.userClose()
    wm.showPicker(picker.id)
    expect(factory.open('picker')[0]!.parentId).toBeUndefined()
  })

  it('asked again from another window it focuses the existing picker instead of making a second', () => {
    const wm = manager()
    wm.openPath(folder('a'))
    wm.openPath(folder('b'))
    const [a, b] = factory.open('project')
    wm.showPicker(a!.id)
    wm.showPicker(b!.id)
    const pickers = factory.open('picker')
    expect(pickers).toHaveLength(1)
    expect(pickers[0]!.parentId).toBe(a!.id)
    expect(pickers[0]!.focused).toBe(1)
  })

  it('closing it (Esc / Cancel) returns focus to the parent and keeps the app alive', () => {
    const wm = manager('linux')
    wm.openPath(folder('a'))
    const parent = factory.open('project')[0]!
    wm.showPicker(parent.id)
    const before = parent.focused
    factory.open('picker')[0]!.userClose()
    expect(parent.focused).toBe(before + 1)
    expect(wm.pickerOpen).toBe(false)
    expect(quits).toBe(0)
  })

  it('dismissPicker closes a modal picker and refocuses the parent, but never a standalone one', () => {
    const wm = manager('linux')
    wm.showPicker()
    expect(wm.pickerModal).toBe(false)
    wm.dismissPicker()
    expect(wm.pickerOpen).toBe(true)
    expect(quits).toBe(0)
    wm.openPath(folder('a'))
    const parent = factory.open('project')[0]!
    wm.showPicker(parent.id)
    expect(wm.pickerModal).toBe(true)
    const before = parent.focused
    wm.dismissPicker()
    expect(wm.pickerOpen).toBe(false)
    expect(parent.focused).toBe(before + 1)
  })

  it('picking a project ends the modal without stealing focus back to the parent', () => {
    const wm = manager()
    wm.openPath(folder('a'))
    const parent = factory.open('project')[0]!
    wm.showPicker(parent.id)
    const before = parent.focused
    wm.openPath(folder('b'))
    expect(factory.open('picker')).toHaveLength(0)
    expect(parent.focused).toBe(before)
  })

  it('when the parent closes, its sheet goes with it and a standalone picker replaces it (no quit)', () => {
    const wm = manager('linux')
    wm.openPath(folder('a'))
    const parent = factory.open('project')[0]!
    wm.showPicker(parent.id)
    parent.userClose()
    const pickers = factory.open('picker')
    expect(pickers).toHaveLength(1)
    expect(pickers[0]!.parentId).toBeUndefined()
    expect(quits).toBe(0)
    expect(wm.pickerOpen).toBe(true)
  })
})

describe('full screen', () => {
  it('reports the state to the app and through isFullScreen', () => {
    const events: Array<[number, boolean]> = []
    const wm = new WindowManager({
      factory,
      registry,
      platform: 'darwin',
      quit: () => {},
      onFullScreenChanged: (id, fs) => events.push([id, fs])
    })
    wm.openPath(folder('a'))
    const win = factory.open('project')[0]!
    expect(wm.isFullScreen(win.id)).toBe(false)
    win.fullScreen = true
    win.callbacks.onFullScreenChanged?.(true)
    expect(events).toEqual([[win.id, true]])
    expect(wm.isFullScreen(win.id)).toBe(true)
    expect(wm.isFullScreen(12345)).toBe(false)
  })
})

describe('transparent windows', () => {
  function lookManager(look: { current: ProjectWindowLook }): WindowManager {
    return new WindowManager({ factory, registry, platform: 'darwin', quit: () => quits++, projectWindowLook: () => look.current })
  }

  it('creates opaque project windows when no look is given', () => {
    const wm = manager()
    wm.openPath(folder('a'))
    const win = factory.open('project')[0]!
    expect(win.look).toEqual({ transparent: false, blur: false })
    expect(wm.isTransparent(win.id)).toBe(false)
  })

  it('reads the setting at each creation; an open window keeps what it was made as', () => {
    const look = { current: { transparent: false, blur: true } }
    const wm = lookManager(look)
    wm.openPath(folder('a'))
    look.current = { transparent: true, blur: true }
    wm.openPath(folder('b'))
    const [a, b] = factory.open('project')
    expect(a!.look).toEqual({ transparent: false, blur: true })
    expect(b!.look).toEqual({ transparent: true, blur: true })
    expect(wm.isTransparent(a!.id)).toBe(false)
    expect(wm.isTransparent(b!.id)).toBe(true)
    // Turning it off again leaves the transparent window as it is (it is never recreated).
    look.current = { transparent: false, blur: true }
    expect(wm.isTransparent(b!.id)).toBe(true)
    expect(factory.windows).toHaveLength(2)
  })

  it('never makes the picker transparent', () => {
    const look = { current: { transparent: true, blur: true } }
    const wm = lookManager(look)
    wm.showPicker()
    const picker = factory.open('picker')[0]!
    expect(picker.look).toBeUndefined()
    expect(wm.isTransparent(picker.id)).toBe(false)
    wm.setBlur(false)
    expect(picker.blurCalls).toEqual([])
  })

  it('applies a blur change to the transparent windows only, and forgets closed ones', () => {
    const look = { current: { transparent: true, blur: true } }
    const wm = lookManager(look)
    wm.openPath(folder('a'))
    look.current = { transparent: false, blur: true }
    wm.openPath(folder('b'))
    look.current = { transparent: true, blur: true }
    wm.openPath(folder('c'))
    const [a, b, c] = factory.open('project')
    wm.setBlur(false)
    expect(a!.blurCalls).toEqual([false])
    expect(b!.blurCalls).toEqual([])
    expect(c!.blurCalls).toEqual([false])
    c!.userClose()
    expect(wm.isTransparent(c!.id)).toBe(false)
    wm.setBlur(true)
    expect(a!.blurCalls).toEqual([false, true])
    expect(c!.blurCalls).toEqual([false])
  })
})

describe('picker', () => {
  it('closes when a project opens', () => {
    const wm = manager('linux')
    wm.showPicker()
    expect(factory.open('picker')).toHaveLength(1)
    wm.openPath(folder('a'))
    expect(factory.open('picker')).toHaveLength(0)
    expect(wm.pickerOpen).toBe(false)
    // Closing the picker because a project opened is not "the last window closed".
    expect(quits).toBe(0)
  })

  it('a second showPicker focuses the existing one', () => {
    const wm = manager()
    wm.showPicker()
    wm.showPicker()
    expect(factory.open('picker')).toHaveLength(1)
    expect(factory.open('picker')[0]!.focused).toBe(1)
  })

  it('can be shown over open projects (the top strip\'s "+"): one picker, focused when asked again', () => {
    const wm = manager('linux')
    wm.openPath(folder('a'))
    wm.showPicker()
    expect(factory.open('picker')).toHaveLength(1)
    expect(wm.pickerOpen).toBe(true)
    const picker = factory.open('picker')[0]!
    expect(wm.resolveSender(picker.senderId)).toEqual({ kind: 'picker', windowId: picker.id })
    wm.showPicker()
    expect(factory.open('picker')).toHaveLength(1)
    expect(picker.focused).toBe(1)
    // Closing it by hand with a project open is not the last window closing: no quit.
    picker.userClose()
    expect(wm.pickerOpen).toBe(false)
    expect(quits).toBe(0)
    expect(factory.open('project')).toHaveLength(1)
  })

  it('picking a project from it opens that project and closes the picker', () => {
    const wm = manager('linux')
    const a = folder('a')
    const b = folder('b')
    wm.openPath(b)
    factory.open('project')[0]!.userClose()
    wm.openPath(a)
    // The picker the last close left is gone again (a opened); the user asks for it.
    expect(factory.open('picker')).toHaveLength(0)
    wm.showPicker()
    const recentB = registry.recent().find((p) => p.path === b)!
    wm.openRecent(recentB.id)
    expect(factory.open('project').map((w) => w.projectId)).toHaveLength(2)
    expect(factory.open('picker')).toHaveLength(0)
    expect(wm.pickerOpen).toBe(false)
    expect(quits).toBe(0)
  })

  it('picking an already open project from it focuses that window and closes the picker', () => {
    const wm = manager('linux')
    const a = folder('a')
    wm.openPath(a)
    wm.openPath(folder('b'))
    const [winA] = factory.open('project')
    wm.showPicker()
    const picker = factory.open('picker')[0]!
    wm.openRecent(registry.recent().find((p) => p.path === a)!.id)
    expect(factory.open('project')).toHaveLength(2)
    expect(winA!.focused).toBe(1)
    expect(picker.closed).toBe(true)
    expect(wm.pickerOpen).toBe(false)
    expect(wm.resolveSender(picker.senderId)).toBeUndefined()
    expect(quits).toBe(0)
  })

  for (const platform of ['darwin', 'linux'] as const) {
    it(`appears when the last project window closes (${platform})`, () => {
      const wm = manager(platform)
      wm.openPath(folder('a'))
      wm.openPath(folder('b'))
      const [a, b] = factory.open('project')
      a!.userClose()
      expect(factory.open('picker')).toHaveLength(0)
      b!.userClose()
      expect(factory.open('picker')).toHaveLength(1)
      expect(registry.openIds()).toEqual([])
      expect(quits).toBe(0)
    })
  }

  it('closing the picker with no project open quits on Linux', () => {
    const wm = manager('linux')
    wm.showPicker()
    factory.open('picker')[0]!.userClose()
    expect(quits).toBe(1)
  })

  it('closing the picker on macOS keeps the app alive; a dock click shows it again', () => {
    const wm = manager('darwin')
    wm.showPicker()
    factory.open('picker')[0]!.userClose()
    expect(quits).toBe(0)
    expect(wm.pickerOpen).toBe(false)
    wm.activate()
    expect(factory.open('picker')).toHaveLength(1)
  })

  it('activate does nothing while a project window is open', () => {
    const wm = manager('darwin')
    wm.openPath(folder('a'))
    wm.activate()
    expect(factory.open('picker')).toHaveLength(0)
  })

  it('focusAny focuses a project window through its handle (which un-minimises it)', () => {
    const wm = manager('darwin')
    wm.openPath(folder('a'))
    wm.openPath(folder('b'))
    const [a, b] = factory.open('project')
    wm.focusAny()
    // The most recently opened one; never a raw window, never a picker.
    expect(b!.focused).toBe(1)
    expect(a!.focused).toBe(0)
    b!.userClose()
    wm.focusAny()
    expect(a!.focused).toBe(1)
    expect(factory.open('picker')).toHaveLength(0)
  })

  it('focusProject focuses exactly that project window and says false for one that is not open', () => {
    const wm = manager('darwin')
    const a = wm.openPath(folder('a'))
    const b = wm.openPath(folder('b'))
    const [winA, winB] = factory.open('project')
    // openPath of a project that is already open focuses too; start the count from here.
    const before = winA!.focused
    expect(wm.focusProject(a.id)).toBe(true)
    expect(winA!.focused).toBe(before + 1)
    expect(winB!.focused).toBe(0)
    expect(wm.focusProject('0123456789abcdef')).toBe(false)
    winB!.userClose()
    expect(wm.focusProject(b.id)).toBe(false)
  })

  it('projectWindows lists the open project windows with their window ids', () => {
    const wm = manager('darwin')
    const a = wm.openPath(folder('a'))
    const b = wm.openPath(folder('b'))
    const [winA, winB] = factory.open('project')
    expect(wm.projectWindows()).toEqual([
      { projectId: a.id, windowId: winA!.id },
      { projectId: b.id, windowId: winB!.id }
    ])
    winA!.userClose()
    expect(wm.projectWindows()).toEqual([{ projectId: b.id, windowId: winB!.id }])
  })

  it('focusAny shows (or focuses) the picker when no project window is open', () => {
    const wm = manager('darwin')
    wm.focusAny()
    expect(factory.open('picker')).toHaveLength(1)
    wm.focusAny()
    expect(factory.open('picker')).toHaveLength(1)
    expect(factory.open('picker')[0]!.focused).toBe(1)
  })
})

describe('quitting', () => {
  it('closing windows during quit shows no picker and keeps the open list', () => {
    const wm = manager('linux')
    const a = wm.openPath(folder('a'))
    const b = wm.openPath(folder('b'))
    wm.beginQuit()
    for (const w of factory.open('project')) w.userClose()
    expect(factory.open('picker')).toHaveLength(0)
    expect(quits).toBe(0)
    // Task 22 restores these at the next start.
    expect(registry.openIds().sort()).toEqual([a.id, b.id].sort())
    wm.showPicker()
    expect(factory.open('picker')).toHaveLength(0)
  })
})

describe('onProjectClosed', () => {
  function withHook(): { wm: WindowManager; closed: string[] } {
    const closed: string[] = []
    const wm = new WindowManager({
      factory,
      registry,
      platform: 'darwin',
      quit: () => quits++,
      onProjectClosed: (id) => closed.push(id)
    })
    return { wm, closed }
  }

  it('fires when a project window closes, so its terminals can be killed', () => {
    const { wm, closed } = withHook()
    const a = wm.openPath(folder('a'))
    const b = wm.openPath(folder('b'))
    factory.open('project')[0]!.userClose()
    expect(closed).toEqual([a.id])
    factory.open('project')[0]!.userClose()
    expect(closed).toEqual([a.id, b.id])
  })

  it('names the closed window too, which windowIdOf no longer knows (its overlays go)', () => {
    const windows: number[] = []
    const wm = new WindowManager({
      factory,
      registry,
      platform: 'darwin',
      quit: () => quits++,
      onProjectClosed: (projectId, windowId) => {
        windows.push(windowId)
        expect(wm.windowIdOf(projectId)).toBeUndefined()
      }
    })
    wm.openPath(folder('a'))
    const win = factory.open('project')[0]!
    win.userClose()
    expect(windows).toEqual([win.id])
  })

  it('fires for windows closed while quitting too', () => {
    const { wm, closed } = withHook()
    const a = wm.openPath(folder('a'))
    wm.beginQuit()
    factory.open('project')[0]!.userClose()
    expect(closed).toEqual([a.id])
  })

  it('does not fire when the picker closes', () => {
    const { wm, closed } = withHook()
    wm.showPicker()
    factory.open('picker')[0]!.userClose()
    expect(closed).toEqual([])
  })
})

describe('onProjectOpened', () => {
  it('fires once per created project window (with its id), not when an open one is focused', () => {
    const opened: Array<[string, number]> = []
    const wm = new WindowManager({
      factory,
      registry,
      platform: 'darwin',
      quit: () => quits++,
      onProjectOpened: (projectId, windowId) => {
        // Already registered: a host started here can resolve the window from the manager.
        expect(wm.windowIdOf(projectId)).toBe(windowId)
        opened.push([projectId, windowId])
      }
    })
    const path = folder('a')
    const a = wm.openPath(path)
    wm.openPath(path)
    const win = factory.open('project')[0]!
    expect(opened).toEqual([[a.id, win.id]])
    // Closed and opened again: a new window, a new host.
    win.userClose()
    wm.openPath(path)
    expect(opened).toHaveLength(2)
  })
})

describe('reopen', () => {
  function reopenManager(
    platform: NodeJS.Platform = 'darwin',
    look: { current: ProjectWindowLook } = { current: { transparent: false, blur: false } }
  ): {
    wm: WindowManager
    events: string[]
    failed: string[]
  } {
    const events: string[] = []
    const failed: string[] = []
    const wm = new WindowManager({
      factory,
      registry,
      platform,
      quit: () => quits++,
      projectWindowLook: () => look.current,
      onProjectClosed: (id, windowId, reopening) => events.push(`closed ${windowId} reopening=${reopening}`),
      onProjectOpened: (id, windowId) => events.push(`opened ${windowId}`),
      onReopenFailed: (id) => failed.push(id),
      log: () => {}
    })
    return { wm, events, failed }
  }

  it('closes the window and opens a new one made from the current look, the project staying open', () => {
    const look = { current: { transparent: false, blur: false } }
    const { wm, events } = reopenManager('linux', look)
    const a = wm.openPath(folder('a'))
    const old = factory.open('project')[0]!
    look.current = { transparent: true, blur: false }
    wm.reopen(a.id)
    const [fresh] = factory.open('project')
    expect(old.closed).toBe(true)
    expect(fresh!.id).not.toBe(old.id)
    expect(fresh!.look).toEqual({ transparent: true, blur: false })
    expect(wm.isTransparent(fresh!.id)).toBe(true)
    expect(wm.windowIdOf(a.id)).toBe(fresh!.id)
    // Closed (flagged as a reopen, so its tabs are queued, not ended) before the new one opens.
    expect(events).toEqual([`opened ${old.id}`, `closed ${old.id} reopening=true`, `opened ${fresh!.id}`])
    // Never seen as closed: still in the open list, no picker, no quit (Linux quits when the
    // last window goes and the picker is closed).
    expect(registry.openIds()).toEqual([a.id])
    expect(factory.open('picker')).toHaveLength(0)
    expect(quits).toBe(0)
    // The old renderer is gone, the new one is the project's.
    expect(wm.resolveSender(old.senderId)).toBeUndefined()
    expect(wm.resolveSender(fresh!.senderId)).toEqual({ kind: 'project', windowId: fresh!.id, projectId: a.id })
  })

  it('opens the new window where the old one was (bounds saved as it closed)', () => {
    const { wm } = reopenManager()
    const a = wm.openPath(folder('a'))
    const old = factory.open('project')[0]!
    old.bounds = { x: 50, y: 60, width: 900, height: 700, maximized: true }
    // The Electron adapter reports bounds on `close`, before `closed`.
    old.close = () => {
      old.callbacks.onBoundsChanged?.()
      old.userClose()
    }
    wm.reopen(a.id)
    expect(factory.open('project')[0]!.createdWith).toEqual({ x: 50, y: 60, width: 900, height: 700, maximized: true })
  })

  it('leaves other project windows alone', () => {
    const { wm } = reopenManager()
    const a = wm.openPath(folder('a'))
    wm.openPath(folder('b'))
    const [oldA, b] = factory.open('project')
    wm.reopen(a.id)
    expect(b!.closed).toBe(false)
    expect(oldA!.closed).toBe(true)
    expect(factory.open('project')).toHaveLength(2)
  })

  it('closes a modal picker over the window first, and keeps one over another window', () => {
    const { wm } = reopenManager()
    const a = wm.openPath(folder('a'))
    wm.openPath(folder('b'))
    const [winA, winB] = factory.open('project')
    wm.showPicker(winA!.id)
    const overA = factory.open('picker')[0]!
    wm.reopen(a.id)
    expect(overA.closed).toBe(true)
    expect(wm.pickerOpen).toBe(false)

    wm.showPicker(winB!.id)
    const overB = factory.open('picker')[0]!
    wm.reopen(a.id)
    // Not a pick: the picker the user opened over B stays.
    expect(overB.closed).toBe(false)
    expect(wm.pickerOpen).toBe(true)
  })

  it('refuses a project without a window, and does nothing while quitting', () => {
    const { wm, events } = reopenManager()
    expect(() => wm.reopen('nope')).toThrow(/no open window/)
    const a = wm.openPath(folder('a'))
    wm.beginQuit()
    wm.reopen(a.id)
    expect(factory.open('project')).toHaveLength(1)
    expect(events).toHaveLength(1)
  })

  it('a folder gone by then: the project closes after all, and the picker shows', () => {
    const { wm, events, failed } = reopenManager()
    const path = folder('a')
    const a = wm.openPath(path)
    rmSync(path, { recursive: true })
    wm.reopen(a.id)
    expect(factory.open('project')).toHaveLength(0)
    expect(failed).toEqual([a.id])
    expect(events.at(-1)).toMatch(/reopening=true/)
    expect(registry.openIds()).toEqual([])
    expect(factory.open('picker')).toHaveLength(1)
  })
})

describe('sender resolution', () => {
  it('maps a project window renderer to its project and a picker to no project', () => {
    const wm = manager()
    wm.showPicker()
    const picker = factory.open('picker')[0]!
    expect(wm.resolveSender(picker.senderId)).toEqual({ kind: 'picker', windowId: picker.id })
    const view = wm.openPath(folder('a'))
    const win = factory.open('project')[0]!
    expect(wm.resolveSender(win.senderId)).toEqual({
      kind: 'project',
      windowId: win.id,
      projectId: view.id
    })
    // The window id is not a sender id.
    expect(wm.resolveSender(win.id)).toBeUndefined()
  })

  it('forgets closed windows and unknown senders', () => {
    const wm = manager()
    wm.showPicker()
    const picker = factory.open('picker')[0]!
    wm.openPath(folder('a'))
    expect(wm.resolveSender(picker.senderId)).toBeUndefined()
    const win = factory.open('project')[0]!
    win.userClose()
    expect(wm.resolveSender(win.senderId)).toBeUndefined()
    expect(wm.resolveSender(9999)).toBeUndefined()
  })
})

describe('views', () => {
  it('registers every window as its desktop view and drops it on close', () => {
    let wm: WindowManager | undefined = undefined
    const views = new ViewRegistry({ windowIdOf: (projectId) => wm?.windowIdOf(projectId) })
    wm = new WindowManager({ factory, registry, platform: 'darwin', quit: () => quits++, views })
    wm.showPicker()
    const picker = factory.open('picker')[0]!
    expect(views.viewsOf(picker.id)).toEqual([`desktop:${picker.id}`])
    const view = wm.openPath(folder('a'))
    const win = factory.open('project')[0]!
    // The picker closed on the open: its view went with it.
    expect(views.viewsOf(picker.id)).toEqual([])
    views.toProject(view.id, 'tabs.select', { tabId: 't1' })
    views.toAll('prefs.changed', {})
    expect(win.sent.map((e) => e.channel)).toEqual(['tabs.select', 'prefs.changed'])
    expect(picker.sent).toEqual([])
    win.userClose()
    expect(views.viewsOf(win.id)).toEqual([])
    expect(views.toWindow(win.id, 'tabs.select', { tabId: 't1' })).toBe(false)
  })
})

describe('window lifetime with remote views (design-web.md §5.6)', () => {
  interface Lifetime {
    wm: WindowManager
    /** Device names per window id, as index.ts reads them from the view registry. */
    devices: Map<number, string[]>
    asks: Array<{ windowId: number; devices: readonly string[]; answer(choice: CloseChoice): void; fail(err: Error): void }>
    closed: string[]
    visibility: Array<[number, boolean]>
    logs: string[]
  }

  function lifetime(platform: NodeJS.Platform = 'linux', withAsk = true): Lifetime {
    const l: Lifetime = { devices: new Map(), asks: [], closed: [], visibility: [], logs: [] } as unknown as Lifetime
    l.wm = new WindowManager({
      factory,
      registry,
      platform,
      quit: () => quits++,
      onProjectClosed: (projectId) => l.closed.push(projectId),
      remoteDevices: (windowId) => l.devices.get(windowId) ?? [],
      ...(withAsk
        ? {
            askClose: (windowId: number, devices: readonly string[]) =>
              new Promise<CloseChoice>((resolve, reject) => {
                l.asks.push({ windowId, devices, answer: resolve, fail: reject })
              })
          }
        : {}),
      onWindowVisibility: (windowId, visible) => l.visibility.push([windowId, visible]),
      log: (m) => l.logs.push(m)
    })
    return l
  }

  /** Lets the ask's promise settle (the manager acts on the answer a microtask later). */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('with no remote view a close closes at once, as before: no ask', () => {
    const l = lifetime()
    const a = l.wm.openPath(folder('a'))
    factory.open('project')[0]!.userClose()
    expect(l.asks).toHaveLength(0)
    expect(l.closed).toEqual([a.id])
  })

  it('with no askClose wired (web access never set up) every close goes ahead', () => {
    const l = lifetime('linux', false)
    const a = l.wm.openPath(folder('a'))
    const win = factory.open('project')[0]!
    l.devices.set(win.id, ['Pixel'])
    win.userClose()
    expect(l.closed).toEqual([a.id])
  })

  it('with a browser attached it asks, naming the devices, and keeps the window open meanwhile', async () => {
    const l = lifetime()
    l.wm.openPath(folder('a'))
    const win = factory.open('project')[0]!
    l.devices.set(win.id, ['Pixel', 'iPad'])
    win.userClose()
    expect(l.asks.map((a) => [a.windowId, a.devices])).toEqual([[win.id, ['Pixel', 'iPad']]])
    expect(win.closed).toBe(false)
    // A second click on the close button while the dialog is up: the same ask, not a second one.
    win.userClose()
    expect(l.asks).toHaveLength(1)
    await settle()
    expect(win.closed).toBe(false)
  })

  it('"Close for everyone" closes the window as before: the project and its tabs end', async () => {
    const l = lifetime()
    const a = l.wm.openPath(folder('a'))
    const win = factory.open('project')[0]!
    l.devices.set(win.id, ['Pixel'])
    win.userClose()
    l.asks[0]!.answer('everyone')
    await settle()
    expect(win.closed).toBe(true)
    expect(l.closed).toEqual([a.id])
    expect(l.wm.windowIdOf(a.id)).toBeUndefined()
    expect(registry.openIds()).toEqual([])
    // Asked once: the close the answer starts is not asked again.
    expect(l.asks).toHaveLength(1)
    // The last window went: the picker, as for any close.
    expect(factory.open('picker')).toHaveLength(1)
  })

  it('"Keep running" hides the window: the project stays open, its view is marked hidden, no picker', async () => {
    const l = lifetime()
    const a = l.wm.openPath(folder('a'))
    const win = factory.open('project')[0]!
    l.devices.set(win.id, ['Pixel'])
    win.userClose()
    l.asks[0]!.answer('keep')
    await settle()
    expect(win.closed).toBe(false)
    expect(win.hidden).toBe(true)
    expect(l.wm.isHidden(win.id)).toBe(true)
    expect(l.closed).toEqual([])
    expect(l.wm.windowIdOf(a.id)).toBe(win.id)
    expect(registry.openIds()).toEqual([a.id])
    expect(l.visibility).toEqual([[win.id, false]])
    expect(factory.open('picker')).toHaveLength(0)
    expect(quits).toBe(0)
  })

  it('"Keep running" after the last browser left while the dialog was up keeps the window on screen', async () => {
    const l = lifetime()
    const a = l.wm.openPath(folder('a'))
    const win = factory.open('project')[0]!
    l.devices.set(win.id, ['Pixel'])
    win.userClose()
    // The browser disconnects with the dialog up: nothing is hidden yet, so there is nothing to show.
    l.devices.set(win.id, [])
    l.wm.remoteViewGone(win.id)
    l.asks[0]!.answer('keep')
    await settle()
    expect(win.closed).toBe(false)
    expect(win.hidden).toBe(false)
    expect(l.wm.isHidden(win.id)).toBe(false)
    expect(l.visibility).toEqual([])
    expect(l.wm.windowIdOf(a.id)).toBe(win.id)
    expect(l.logs.join('\n')).toMatch(/no browser is attached/)
  })

  it('Cancel leaves the window as it was', async () => {
    const l = lifetime()
    l.wm.openPath(folder('a'))
    const win = factory.open('project')[0]!
    l.devices.set(win.id, ['Pixel'])
    win.userClose()
    l.asks[0]!.answer('cancel')
    await settle()
    expect(win.closed).toBe(false)
    expect(win.hidden).toBe(false)
    expect(l.visibility).toEqual([])
    // Asked again on the next close.
    win.userClose()
    expect(l.asks).toHaveLength(2)
  })

  it('a dialog that fails closes for everyone: a window must never be impossible to close', async () => {
    const l = lifetime()
    const a = l.wm.openPath(folder('a'))
    const win = factory.open('project')[0]!
    l.devices.set(win.id, ['Pixel'])
    win.userClose()
    l.asks[0]!.fail(new Error('no dialog'))
    await settle()
    expect(win.closed).toBe(true)
    expect(l.closed).toEqual([a.id])
    expect(l.logs.join('\n')).toMatch(/no dialog/)
  })

  async function keptRunning(l: Lifetime, name = 'a'): Promise<{ id: string; win: FakeWindow }> {
    const view = l.wm.openPath(folder(name))
    const win = factory.open('project').find((w) => w.projectId === view.id)!
    l.devices.set(win.id, ['Pixel'])
    win.userClose()
    l.asks.at(-1)!.answer('keep')
    await settle()
    expect(win.hidden).toBe(true)
    return { id: view.id, win }
  }

  it('the last remote view leaving shows the hidden window again; one left keeps it hidden', async () => {
    const l = lifetime()
    const { win } = await keptRunning(l)
    l.devices.set(win.id, ['Pixel', 'Laptop'])
    l.wm.remoteViewGone(win.id)
    expect(l.wm.isHidden(win.id)).toBe(true)
    l.devices.set(win.id, [])
    l.wm.remoteViewGone(win.id)
    expect(win.hidden).toBe(false)
    expect(l.wm.isHidden(win.id)).toBe(false)
    expect(l.visibility.at(-1)).toEqual([win.id, true])
  })

  it('opening the project again (the picker, ccc open) shows the hidden window, no second window', async () => {
    const l = lifetime()
    const { id, win } = await keptRunning(l)
    const focused = win.focused
    l.wm.openPath(registry.get(id)!.path)
    expect(win.hidden).toBe(false)
    expect(win.focused).toBe(focused + 1)
    expect(l.wm.isHidden(win.id)).toBe(false)
    expect(l.visibility).toEqual([
      [win.id, false],
      [win.id, true]
    ])
    expect(factory.open('project')).toHaveLength(1)
    // From the picker's recent list too (a hidden window again first).
    win.userClose()
    l.asks.at(-1)!.answer('keep')
    await settle()
    expect(win.hidden).toBe(true)
    l.wm.showPicker()
    l.wm.openRecent(id)
    expect(win.hidden).toBe(false)
    expect(factory.open('picker')).toHaveLength(0)
  })

  it('the dock (activate) shows the hidden window; a bare relaunch (focusAny) does too', async () => {
    const l = lifetime('darwin')
    const { win } = await keptRunning(l)
    l.wm.activate()
    expect(win.hidden).toBe(false)
    expect(factory.open('picker')).toHaveLength(0)
    win.userClose()
    l.asks.at(-1)!.answer('keep')
    await settle()
    l.wm.focusAny()
    expect(win.hidden).toBe(false)
  })

  it('focusAny prefers a window on screen over a hidden one; activate leaves a visible one alone', async () => {
    const l = lifetime('darwin')
    const { win: hidden } = await keptRunning(l, 'a')
    l.wm.openPath(folder('b'))
    const shown = factory.open('project').find((w) => w !== hidden)!
    l.wm.focusAny()
    expect(hidden.hidden).toBe(true)
    expect(shown.focused).toBeGreaterThan(0)
    l.wm.activate()
    expect(hidden.hidden).toBe(true)
  })

  it('a plugin or another view raising the project (focusProject) never shows a hidden window', async () => {
    const l = lifetime()
    const { id, win } = await keptRunning(l)
    expect(l.wm.focusProject(id)).toBe(true)
    expect(win.hidden).toBe(true)
  })

  it('hiding closes a modal picker over the window; a picker asked for from a hidden window is standalone', async () => {
    const l = lifetime()
    l.wm.openPath(folder('a'))
    const win = factory.open('project')[0]!
    l.wm.showPicker(win.id)
    const sheet = factory.open('picker')[0]!
    l.devices.set(win.id, ['Pixel'])
    win.userClose()
    l.asks[0]!.answer('keep')
    await settle()
    expect(sheet.closed).toBe(true)
    expect(win.hidden).toBe(true)
    l.wm.showPicker(win.id)
    expect(factory.open('picker')[0]!.parentId).toBeUndefined()
  })

  it('never asks while quitting or for a reopen; an answer arriving after the quit is ignored', async () => {
    const l = lifetime()
    const a = l.wm.openPath(folder('a'))
    const win = factory.open('project')[0]!
    l.devices.set(win.id, ['Pixel'])
    // Reopen: the window comes straight back, nothing to ask.
    l.wm.reopen(a.id)
    expect(l.asks).toHaveLength(0)
    const next = factory.open('project')[0]!
    l.devices.set(next.id, ['Pixel'])
    next.userClose()
    expect(l.asks).toHaveLength(1)
    l.wm.beginQuit()
    next.userClose()
    expect(next.closed).toBe(true)
    l.asks[0]!.answer('keep')
    await settle()
    expect(next.hidden).toBe(false)
  })

  it('a hidden window closes with the rest on quit, and its hidden mark goes with it', async () => {
    const l = lifetime()
    const { id, win } = await keptRunning(l)
    l.wm.beginQuit()
    win.userClose()
    expect(win.closed).toBe(true)
    expect(l.closed).toEqual([id])
    expect(l.wm.isHidden(win.id)).toBe(false)
  })
})

describe('bounds', () => {
  it('saves moved/resized bounds into the project record', () => {
    const wm = manager()
    const view = wm.openPath(folder('a'))
    const win = factory.open('project')[0]!
    win.bounds = { x: 50, y: 60, width: 1000, height: 700 }
    win.callbacks.onBoundsChanged?.()
    expect(registry.get(view.id)?.bounds).toEqual({ x: 50, y: 60, width: 1000, height: 700 })
  })

  it('reopens with the saved bounds', () => {
    const wm = manager()
    const a = folder('a')
    const view = wm.openPath(a)
    registry.update(view.id, (r) => {
      r.bounds = { x: 100, y: 100, width: 900, height: 650 }
    })
    factory.open('project')[0]!.userClose()
    wm.openPath(a)
    expect(factory.open('project')[0]!.createdWith).toEqual({
      x: 100,
      y: 100,
      width: 900,
      height: 650
    })
  })

  it('moves a saved position that is off every display onto the nearest one', () => {
    const wm = manager()
    const a = folder('a')
    const view = wm.openPath(a)
    // Saved on an external monitor (right of the 1920x1080 one) that is no longer connected.
    registry.update(view.id, (r) => {
      r.bounds = { x: 3000, y: 200, width: 900, height: 650 }
    })
    factory.open('project')[0]!.userClose()
    wm.openPath(a)
    expect(factory.open('project')[0]!.createdWith).toEqual({ x: 1020, y: 200, width: 900, height: 650 })
  })

  it('saves and restores the maximised / full-screen state with the normal bounds', () => {
    const wm = manager()
    const a = folder('a')
    const view = wm.openPath(a)
    const win = factory.open('project')[0]!
    win.bounds = { x: 50, y: 60, width: 1000, height: 700, maximized: true }
    win.callbacks.onBoundsChanged?.()
    expect(registry.get(view.id)?.bounds).toEqual({ x: 50, y: 60, width: 1000, height: 700, maximized: true })
    win.userClose()
    wm.openPath(a)
    // The window is built at the normal bounds, flagged: the factory maximises it once shown.
    expect(factory.open('project')[0]!.createdWith).toEqual({
      x: 50,
      y: 60,
      width: 1000,
      height: 700,
      maximized: true
    })
  })

  it('does not save while minimised: the bounds from before stay', () => {
    const wm = manager()
    const view = wm.openPath(folder('a'))
    const win = factory.open('project')[0]!
    win.bounds = { x: 50, y: 60, width: 1000, height: 700 }
    win.callbacks.onBoundsChanged?.()
    win.minimized = true
    // Windows parks a minimised window at -32000; a 'move' then must not overwrite the record.
    win.bounds = { x: -32000, y: -32000, width: 160, height: 28 }
    win.callbacks.onBoundsChanged?.()
    expect(registry.get(view.id)?.bounds).toEqual({ x: 50, y: 60, width: 1000, height: 700 })
  })

  it('damaged saved bounds fall back to the default size', () => {
    const wm = manager()
    const a = folder('a')
    const view = wm.openPath(a)
    registry.update(view.id, (r) => {
      // The record is user-writable: a hand edit or an old bug can leave anything here.
      ;(r as { bounds: unknown }).bounds = { x: 10, y: 10, width: 'wide', height: null }
    })
    factory.open('project')[0]!.userClose()
    wm.openPath(a)
    expect(factory.open('project')[0]!.createdWith).toBeUndefined()
  })

  it('a new project gets no saved bounds (the default size)', () => {
    manager().openPath(folder('a'))
    expect(factory.open('project')[0]!.createdWith).toBeUndefined()
  })

  it('a burst of move/resize events is one debounced write of the last bounds', () => {
    vi.useFakeTimers()
    try {
      let renames = 0
      const fs = {
        ...nodeFs,
        renameSync: (from: string, to: string) => {
          renames++
          nodeFs.renameSync(from, to)
        }
      }
      const reg = new ProjectRegistry({ dataDir: join(root, 'data2'), debounceMs: 300, fs, log: () => {} })
      const wm = new WindowManager({ factory, registry: reg, platform: 'darwin', quit: () => {} })
      const view = wm.openPath(folder('a'))
      vi.runAllTimers()
      renames = 0
      const win = factory.open('project')[0]!
      // A drag: dozens of events inside one debounce window.
      for (let i = 0; i < 50; i++) {
        win.bounds = { x: 100 + i, y: 100, width: 900, height: 650 }
        win.callbacks.onBoundsChanged?.()
      }
      expect(renames).toBe(0)
      vi.advanceTimersByTime(300)
      expect(renames).toBe(1)
      const onDisk = JSON.parse(
        nodeFs.readFileSync(projectFile(join(root, 'data2'), view.id), 'utf8')
      ) as { bounds: WindowBounds }
      expect(onDisk.bounds).toEqual({ x: 149, y: 100, width: 900, height: 650 })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('projectPathFromArgv', () => {
  const dirs = new Set(['/repo', '/home/me/src/foo', '/app'])
  const isDir = (p: string): boolean => dirs.has(p)

  it('takes a folder argument, resolved against the caller cwd', () => {
    expect(projectPathFromArgv(['/bin/cc-cockpit', 'src/foo'], '/home/me', false, isDir)).toBe(
      '/home/me/src/foo'
    )
    expect(projectPathFromArgv(['/bin/cc-cockpit', '/repo'], '/tmp', false, isDir)).toBe('/repo')
  })

  it('skips Chromium switches and non-directories', () => {
    const argv = ['/bin/cc-cockpit', '/repo', '--allow-file-access-from-files', 'README.md']
    expect(projectPathFromArgv(argv, '/', false, isDir)).toBe('/repo')
  })

  it('does not take the app path under `electron .` for a project', () => {
    expect(projectPathFromArgv(['/bin/electron', '/app'], '/', true, isDir)).toBeUndefined()
    expect(projectPathFromArgv(['/bin/electron', '/app', '/repo'], '/', true, isDir)).toBe('/repo')
    // A packaged app has no app path argument.
    expect(projectPathFromArgv(['/bin/cc-cockpit', '/app'], '/', false, isDir)).toBe('/app')
  })

  it('finds the app path behind switches, not at a fixed index', () => {
    // `electron --inspect=9229 .` at startup, and a `second-instance` argv whose switches
    // Chromium moved in front: the app path must still be dropped.
    expect(
      projectPathFromArgv(['/bin/electron', '--inspect=9229', '/app'], '/', true, isDir)
    ).toBeUndefined()
    expect(
      projectPathFromArgv(['/bin/electron', '--x', '--y=1', '/app', '/repo'], '/', true, isDir)
    ).toBe('/repo')
    expect(
      projectPathFromArgv(['/bin/electron', '--x', '/app', '--y', '/repo', '--z'], '/', true, isDir)
    ).toBe('/repo')
    // Only the first non-switch argument is the app path; a later `.` is a project folder.
    expect(projectPathFromArgv(['/bin/electron', '--x', '/app', '.'], '/repo', true, isDir)).toBe(
      '/repo'
    )
  })

  it("skips server mode's flag, the switches the re-exec adds and the fallback's marker", () => {
    // What the re-executed image (and the fallback's child) sees: the person's argv, then the
    // switches (server-mode.ts). None of them may be taken for a folder, nor shift the app path.
    const server = ['--server', '--ozone-platform=headless', '--disable-gpu', '--password-store=basic']
    expect(projectPathFromArgv(['/bin/cc-cockpit', '/repo', ...server], '/', false, isDir)).toBe('/repo')
    expect(projectPathFromArgv(['/bin/cc-cockpit', ...server, '--server-parent=4242'], '/', false, isDir)).toBeUndefined()
    expect(projectPathFromArgv(['/bin/electron', '/app', ...server, '--server-parent=4242'], '/', true, isDir)).toBeUndefined()
    expect(projectPathFromArgv(['/bin/electron', ...server, '/app', '/repo'], '/', true, isDir)).toBe('/repo')
  })

  it('returns undefined with no folder argument', () => {
    expect(projectPathFromArgv(['/bin/cc-cockpit'], '/', false, isDir)).toBeUndefined()
    expect(projectPathFromArgv(['/bin/cc-cockpit', '--x'], '/', false, isDir)).toBeUndefined()
  })

  it('checks the real file system by default', () => {
    const a = folder('a')
    expect(projectPathFromArgv(['/bin/cc-cockpit', a], '/', false)).toBe(a)
    expect(projectPathFromArgv(['/bin/cc-cockpit', join(work, 'nope')], '/', false)).toBeUndefined()
  })
})

describe('asSecondInstanceData', () => {
  it('accepts the shape the app sends', () => {
    const data = { argv: ['/bin/electron', '/app', 'foo'], cwd: '/home/me' }
    expect(asSecondInstanceData(data)).toEqual(data)
  })

  it('carries whether the launch has a display; data without it (another build) reads as before', () => {
    const base = { argv: ['/bin/cc-cockpit', '/work'], cwd: '/home/me' }
    expect(asSecondInstanceData({ ...base, display: true })).toEqual({ ...base, display: true })
    expect(asSecondInstanceData({ ...base, display: false })).toEqual({ ...base, display: false })
    expect(asSecondInstanceData(base)).toEqual(base)
    expect(asSecondInstanceData(base)?.display).toBeUndefined()
    // A non-boolean is taken as absent, never as "has a display".
    expect(asSecondInstanceData({ ...base, display: 'yes' })).toEqual(base)
  })

  it('rejects anything else, so the caller falls back to Electron argv', () => {
    for (const bad of [
      undefined,
      null,
      'x',
      {},
      { argv: ['/bin/x'] },
      { argv: '/bin/x', cwd: '/' },
      { argv: ['/bin/x', 3], cwd: '/' },
      { argv: ['/bin/x'], cwd: '' },
      { argv: ['/bin/x'], cwd: 7 }
    ]) {
      expect(asSecondInstanceData(bad)).toBeUndefined()
    }
  })
})

describe('server mode: the hidden page (design-web.md §9.8)', () => {
  interface Server {
    wm: WindowManager
    asks: number
    closed: string[]
    logs: string[]
    /** Pending timers, fired by hand. */
    timers: Array<{ fn: () => void; ms: number; cancelled: boolean }>
    now: number
    devices: Map<number, string[]>
  }

  function server(platform: NodeJS.Platform = 'linux', on = true): Server {
    const s = { asks: 0, closed: [], logs: [], timers: [], now: 1_000_000, devices: new Map() } as unknown as Server
    s.wm = new WindowManager({
      factory,
      registry,
      platform,
      quit: () => quits++,
      server: on,
      onProjectClosed: (projectId) => s.closed.push(projectId),
      remoteDevices: (windowId) => s.devices.get(windowId) ?? [],
      // Wired here on purpose: server mode must not ask even when an askClose exists.
      askClose: () => {
        s.asks++
        return Promise.resolve('everyone' as CloseChoice)
      },
      setTimer: (fn, ms) => {
        const t = { fn, ms, cancelled: false }
        s.timers.push(t)
        return () => {
          t.cancelled = true
        }
      },
      now: () => s.now,
      log: (m) => s.logs.push(m)
    })
    return s
  }

  /** Fires every pending, uncancelled timer once. */
  function fire(s: Server): void {
    const due = s.timers.filter((t) => !t.cancelled)
    s.timers = []
    for (const t of due) t.fn()
  }

  /** No focus (show), no hide, no picker window made: the four calls server mode never makes. */
  function untouched(): void {
    for (const w of factory.windows) {
      expect(w.focused).toBe(0)
      expect(w.hides).toBe(0)
    }
    expect(factory.windows.filter((w) => w.kind === 'picker')).toHaveLength(0)
  }

  it('never focuses, shows, hides or makes a picker on any path', () => {
    const s = server()
    const a = folder('a')
    const view = s.wm.openPath(a)
    const win = factory.open('project')[0]!
    // Opening it again (`ccc open`, a second launch with the folder), a plugin's focus, a bare second
    // launch, the dock, the last browser leaving, the menu's or the shell's picker.
    s.wm.openPath(a)
    expect(s.wm.focusProject(view.id)).toBe(true)
    s.wm.focusAny()
    s.wm.activate()
    s.devices.set(win.id, [])
    s.wm.remoteViewGone(win.id)
    s.wm.showPicker(win.id)
    s.wm.showPicker()
    untouched()
    expect(s.wm.isHidden(win.id)).toBe(false)
    expect(s.wm.pickerOpen).toBe(false)
  })

  it('a second launch: no display opens its path showing and focusing nothing; a display opens nothing', () => {
    const s = server()
    const a = folder('a')
    const b = folder('b')
    const second = (display: boolean | undefined, path: string): void =>
      handleSecondInstance(
        { server: true, display, argv: ['/bin/cc-cockpit', path], cwd: '/' },
        {
          open: (argv, cwd) => {
            const found = projectPathFromArgv(argv, cwd, false)
            if (!found) return false
            s.wm.openPath(found)
            return true
          },
          focusAny: () => s.wm.focusAny(),
          log: (m) => s.logs.push(m)
        }
      )
    // `cc-cockpit <path>` from a server shell: opened, as any second launch.
    second(false, a)
    expect(factory.open('project')).toHaveLength(1)
    // Again with the same folder, and from another build (no `display`): still nothing shown.
    second(false, a)
    second(undefined, b)
    expect(factory.open('project')).toHaveLength(2)
    // A launch from a desktop screen: ignored, with a line.
    second(true, folder('c'))
    expect(factory.open('project')).toHaveLength(2)
    expect(s.logs).toContain(IGNORED_LINE)
    untouched()
  })

  it('`ccc open <path>` from a server shell opens the project, showing and focusing nothing', () => {
    const s = server()
    const open = openHandler({ openPath: (path) => void s.wm.openPath(path) })
    const a = folder('a')
    // A tokenless caller naming the folder, as `ccc open` outside a tab sends it (client.ts callerOf).
    expect(open({ path: a }, { kind: 'project', path: a, projectId: undefined })).toBeNull()
    expect(factory.open('project')).toHaveLength(1)
    // Again: the open window is found, still nothing shown or focused.
    open({ path: a }, { kind: 'project', path: a, projectId: registry.findByPath(a)?.id })
    expect(factory.open('project')).toHaveLength(1)
    untouched()
  })

  it('a browser opens a folder by path and reopens a recent one, showing nothing; a missing one is an error', async () => {
    const s = server()
    const deps = { openPath: (path: string) => s.wm.openPath(path), openRecent: (id: string) => s.wm.openRecent(id) }
    const a = folder('a')
    const b = folder('b')
    const opened = await openProjectFromWeb({ open: a }, deps)
    expect(opened).toEqual({ id: registry.findByPath(a)?.id })
    // Closed again: it stays in the recent list, from which the browser reopens it by id.
    factory.open('project')[0]!.userClose()
    expect(factory.open('project')).toHaveLength(0)
    expect(await openProjectFromWeb({ reopen: (opened as { id: string }).id }, deps)).toEqual(opened)
    expect(factory.open('project')).toHaveLength(1)
    // An id that is not in the recent list opens nothing, whatever record it may name.
    expect(await openProjectFromWeb({ reopen: 'not-a-project' }, deps)).toEqual({ error: 'not a recent project' })
    // A recent project whose folder is gone: the error, no window.
    const gone = (await openProjectFromWeb({ open: b }, deps)) as { id: string }
    factory.open('project').at(-1)!.userClose()
    rmSync(b, { recursive: true })
    expect(await openProjectFromWeb({ reopen: gone.id }, deps)).toEqual({ error: `project folder is missing: ${b}` })
    expect(factory.open('project')).toHaveLength(1)
    untouched()
  })

  it('makes no picker and does not quit when the last project closes; nothing open stays nothing', () => {
    const s = server('linux')
    const view = s.wm.openPath(folder('a'))
    factory.open('project')[0]!.userClose()
    expect(s.closed).toEqual([view.id])
    expect(quits).toBe(0)
    expect(s.wm.pickerOpen).toBe(false)
    // With no project open: a bare second launch and the dock make nothing either.
    s.wm.focusAny()
    s.wm.activate()
    untouched()
    expect(quits).toBe(0)
  })

  it("never writes the hidden page's bounds, so a later desktop start finds the person's own", () => {
    const a = folder('a')
    const desktop = manager()
    const view = desktop.openPath(a)
    const first = factory.open('project')[0]!
    first.bounds = { x: 50, y: 60, width: 1000, height: 700 }
    first.callbacks.onBoundsChanged?.()
    first.close()
    const s = server()
    s.wm.openPath(a)
    const win = factory.open('project').at(-1)!
    // The 1x1 screen clamps the window (480x320); moves and resizes, and its close.
    win.bounds = { x: 0, y: 0, width: 480, height: 320 }
    win.callbacks.onBoundsChanged?.()
    win.close()
    expect(registry.get(view.id)?.bounds).toEqual({ x: 50, y: 60, width: 1000, height: 700 })
  })

  it('asks no close, even with browsers attached: the close goes ahead', () => {
    const s = server()
    const view = s.wm.openPath(folder('a'))
    const win = factory.open('project')[0]!
    s.devices.set(win.id, ['Pixel'])
    win.userClose()
    expect(s.asks).toBe(0)
    expect(win.closed).toBe(true)
    expect(s.closed).toEqual([view.id])
  })

  it("closeForEveryone (a browser's Close project) closes only that window, its views and tabs; the others stay", () => {
    const added: number[] = []
    const removed: number[] = []
    const s = { closed: [] as string[] }
    const wm = new WindowManager({
      factory,
      registry,
      platform: 'linux',
      quit: () => quits++,
      server: true,
      views: {
        addDesktop: (windowId) => {
          added.push(windowId)
          return `desktop:${windowId}`
        },
        removeWindow: (windowId) => {
          removed.push(windowId)
        }
      },
      onProjectClosed: (projectId) => s.closed.push(projectId)
    })
    const a = wm.openPath(folder('a'))
    const b = wm.openPath(folder('b'))
    const [winA, winB] = factory.open('project')
    expect(wm.closeForEveryone(winA!.id)).toBe(true)
    expect(winA!.closed).toBe(true)
    expect(s.closed).toEqual([a.id])
    expect(removed).toEqual([winA!.id])
    expect(wm.windowIdOf(a.id)).toBeUndefined()
    // It leaves the open list and stays recent: the browser picker offers it to reopen.
    expect(registry.openIds()).toEqual([b.id])
    expect(registry.recent().map((p) => p.id)).toContain(a.id)
    // The other window and its views are untouched; nothing shown, no picker, no quit.
    expect(winB!.closed).toBe(false)
    expect(wm.windowIdOf(b.id)).toBe(winB!.id)
    expect(added).toEqual([winA!.id, winB!.id])
    expect(factory.windows.every((w) => w.focused === 0 && w.hides === 0)).toBe(true)
    expect(wm.pickerOpen).toBe(false)
    expect(quits).toBe(0)
    // A window that is gone, or never was, closes nothing.
    expect(wm.closeForEveryone(winA!.id)).toBe(false)
    expect(wm.closeForEveryone(999)).toBe(false)
    expect(s.closed).toEqual([a.id])
    // Nothing closes while quitting (quit closes every window itself).
    wm.beginQuit()
    expect(wm.closeForEveryone(winB!.id)).toBe(false)
    expect(winB!.closed).toBe(false)
  })

  it('a crash reloads the page after a pause, with a log line, and the window stays', () => {
    const s = server()
    s.wm.openPath(folder('a'))
    const win = factory.open('project')[0]!
    expect(win.callbacks.onPageGone?.('crashed (crashed, exit code 133)')).toBe(true)
    // Not at once: the pause comes first.
    expect(win.reloads).toBe(0)
    expect(s.timers.map((t) => t.ms)).toEqual([PAGE_RELOAD_FIRST_MS])
    expect(s.logs).toEqual(['the hidden page of a crashed (crashed, exit code 133): reloading in 1 s'])
    fire(s)
    expect(win.reloads).toBe(1)
    expect(win.closed).toBe(false)
    expect(s.closed).toEqual([])
  })

  it('a failed load reloads too, never closing the window; the crash and failure of one try are one reload', () => {
    const s = server()
    s.wm.openPath(folder('a'))
    const win = factory.open('project')[0]!
    expect(win.callbacks.onPageGone?.('failed to load (ERR_FILE_NOT_FOUND)')).toBe(true)
    expect(win.callbacks.onPageGone?.('crashed (crashed, exit code 1)')).toBe(true)
    expect(s.timers).toHaveLength(1)
    fire(s)
    expect(win.reloads).toBe(1)
    expect(win.closed).toBe(false)
  })

  it('the pause doubles while the page keeps dying soon after each reload, up to the cap, and resets after a quiet minute', () => {
    const s = server()
    s.wm.openPath(folder('a'))
    const win = factory.open('project')[0]!
    const pauses: number[] = []
    for (let i = 0; i < 8; i++) {
      win.callbacks.onPageGone?.('crashed (crashed, exit code 1)')
      pauses.push(s.timers[0]!.ms)
      s.now += s.timers[0]!.ms
      fire(s)
      s.now += 100
    }
    expect(pauses).toEqual([1000, 2000, 4000, 8000, 16000, PAGE_RELOAD_MAX_MS, PAGE_RELOAD_MAX_MS, PAGE_RELOAD_MAX_MS])
    expect(win.reloads).toBe(8)
    // Up for longer than the reset since the last reload: the first pause again.
    s.now += PAGE_RELOAD_RESET_MS
    win.callbacks.onPageGone?.('crashed (crashed, exit code 1)')
    expect(s.timers[0]!.ms).toBe(PAGE_RELOAD_FIRST_MS)
  })

  it('a window closed during the pause is not reloaded; neither is one while quitting', () => {
    const s = server()
    s.wm.openPath(folder('a'))
    s.wm.openPath(folder('b'))
    const [a, b] = factory.open('project')
    a!.callbacks.onPageGone?.('crashed (crashed, exit code 1)')
    a!.userClose()
    expect(s.timers[0]!.cancelled).toBe(true)
    fire(s)
    expect(a!.reloads).toBe(0)
    b!.callbacks.onPageGone?.('crashed (crashed, exit code 1)')
    s.wm.beginQuit()
    fire(s)
    expect(b!.reloads).toBe(0)
    // Quitting: a crash then schedules nothing, but still never closes the window.
    expect(b!.callbacks.onPageGone?.('crashed (crashed, exit code 1)')).toBe(true)
    expect(s.timers).toHaveLength(0)
  })

  it('the desktop keeps today\'s behaviour: no page-gone handling (a failed load closes), focus, picker, ask', async () => {
    const s = server('linux', false)
    const a = folder('a')
    s.wm.openPath(a)
    const win = factory.open('project')[0]!
    expect(win.callbacks.onPageGone).toBeUndefined()
    s.wm.openPath(a)
    expect(win.focused).toBe(1)
    s.wm.focusAny()
    expect(win.focused).toBe(2)
    s.devices.set(win.id, ['Pixel'])
    win.userClose()
    expect(s.asks).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(win.closed).toBe(true)
    // The last project closed: the picker, as before.
    expect(s.wm.pickerOpen).toBe(true)
  })
})
