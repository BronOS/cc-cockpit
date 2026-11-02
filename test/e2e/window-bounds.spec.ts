// A project window reopens at the size and place it had: moved/resized bounds are saved into the
// project record (debounced, and again on close) and applied when the window is created at the
// next start. The off-screen, damaged-data and minimised cases are unit tests
// (test/unit/window-bounds.test.ts, window-manager.test.ts): e2e cannot unplug a display.
import { readFileSync } from 'node:fs'
import type { ElectronApplication } from '@playwright/test'
import { projectFile, projectId } from '../../src/main/paths'
import type { WindowBounds } from '../../src/shared/types'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'

/** The `bounds` saved in the project's record on disk (what the next start reads). */
function savedBounds(c: Cockpit): WindowBounds | undefined {
  try {
    const record = JSON.parse(readFileSync(projectFile(c.dataDir, projectId(c.projectDir)), 'utf8')) as {
      bounds?: WindowBounds
    }
    return record.bounds
  } catch {
    return undefined // the debounced writer has not written the record yet
  }
}

interface WindowState {
  normal: { x: number; y: number; width: number; height: number }
  maximized: boolean
}

/** The project window's normal bounds and state (it is the only window: the picker is closed). */
function windowState(app: ElectronApplication): Promise<WindowState> {
  return app.evaluate(({ BrowserWindow }) => {
    const [win] = BrowserWindow.getAllWindows()
    if (!win) throw new Error('no window')
    return { normal: win.getNormalBounds(), maximized: win.isMaximized() }
  })
}

// Small enough for any display the suite runs on, and clear of the macOS menu bar.
const PLACED = { x: 120, y: 140, width: 900, height: 650 }

test('a moved and resized window reopens at the same bounds after a relaunch', async () => {
  const first = await launchCockpit()
  const root = first.cockpit.root
  try {
    const c = first.cockpit
    await c.app.evaluate(({ BrowserWindow }, bounds) => {
      BrowserWindow.getAllWindows()[0]!.setBounds(bounds)
    }, PLACED)
    // Saved while the app runs (the resize/move events), not only on close.
    await expect.poll(() => savedBounds(c)).toEqual(PLACED)
  } finally {
    await first.close({ keepFiles: true })
  }

  const second = await launchCockpit({ root, folderArg: false })
  try {
    await expect.poll(() => windowState(second.cockpit.app)).toEqual({ normal: PLACED, maximized: false })
  } finally {
    await second.close()
  }
})

test('a maximised window reopens maximised and un-maximises to its saved bounds', async () => {
  const first = await launchCockpit()
  const root = first.cockpit.root
  try {
    const c = first.cockpit
    await c.app.evaluate(({ BrowserWindow }, bounds) => {
      BrowserWindow.getAllWindows()[0]!.setBounds(bounds)
    }, PLACED)
    await expect.poll(() => savedBounds(c)).toEqual(PLACED)
    await c.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.maximize()
    })
    // The record keeps the normal bounds and adds the flag.
    await expect.poll(() => savedBounds(c)).toEqual({ ...PLACED, maximized: true })
  } finally {
    await first.close({ keepFiles: true })
  }

  const second = await launchCockpit({ root, folderArg: false })
  try {
    const { app } = second.cockpit
    await expect.poll(() => windowState(app)).toEqual({ normal: PLACED, maximized: true })
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.unmaximize()
    })
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds()))
      .toEqual(PLACED)
  } finally {
    await second.close()
  }
})
