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
  WindowManager,
  type Rect,
  type WindowCallbacks,
  type WindowFactory,
  type WindowHandle
} from '../../src/main/windows/window-manager'
import type { ProjectWindowLook } from '../../src/main/windows/window-chrome'
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
  /** The project window id this picker was created as a modal child of. */
  parentId?: number
  bounds: WindowBounds
  callbacks: Partial<WindowCallbacks>
  /** The look a project window was created with (none for a picker: it is never asked for one). */
  look?: ProjectWindowLook
  /** Every setBlur call, in order. */
  blurCalls: boolean[]
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
      bounds: createdWith ?? { x: 10, y: 10, width: 800, height: 600 },
      callbacks,
      blurCalls: [],
      setBlur(on) {
        win.blurCalls.push(on)
      },
      focus() {
        win.focused++
      },
      // Programmatic close and a user close look the same to the manager: `closed` fires.
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
