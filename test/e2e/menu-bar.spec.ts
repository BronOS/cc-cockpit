// The application menu's bar stays hidden off macOS (create-window.ts), and hiding it must not cost
// its accelerators. Off macOS only: there the menu is in the system's bar, whatever a window says.
import { expect, test } from './fixtures'

test.skip(process.platform === 'darwin', 'macOS has no in-window menu bar')

test('the menu bar is hidden, and stays so after the menu is rebuilt on a focus change', async ({ cockpit }) => {
  const visible = (): Promise<boolean[]> =>
    cockpit.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isMenuBarVisible()))
  expect(await visible()).toEqual([false])
  // Installing a menu can show the bar again in Electron, and main reinstalls it per focused project.
  await cockpit.app.evaluate(({ BrowserWindow, Menu }) => {
    Menu.setApplicationMenu(Menu.getApplicationMenu())
    BrowserWindow.getAllWindows()[0]!.focus()
  })
  expect(await visible()).toEqual([false])
  // A lone Alt must not bring it up: Alt belongs to the terminal.
  await cockpit.page.keyboard.press('Alt')
  expect(await visible()).toEqual([false])
})

test('a hidden menu keeps its accelerators: Ctrl+Q quits', async ({ cockpit }) => {
  // sendInputEvent, not page.keyboard: Playwright's synthetic keys never reach menu accelerators,
  // even with the bar visible. Off the terminal, which would take the key itself.
  await cockpit.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const closed = cockpit.app.waitForEvent('close')
  await cockpit.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!
    win.focus()
    win.webContents.focus()
    setTimeout(() => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Q', modifiers: ['control'] })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Q', modifiers: ['control'] })
    }, 300)
  })
  await closed
})
