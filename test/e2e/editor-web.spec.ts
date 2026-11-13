// The bundled editor in a browser view (design-editor.md §1 "Two views", design-web.md): a file tab
// is the same tab on the desktop and in a plain browser (test/e2e/web-fixtures.ts), each with its
// own page and its own buffer. The browser edits, its socket drops while the buffer has unsaved
// text (a relay resync: the frame takes a new port, no reload), the text is still there, a save
// lands on disk, and the desktop's page, which had no edits, shows the new content.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { enableWebAccess, openBrowser, type WebAccessOn, type WebBrowser } from './web-fixtures'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

const editorFrame = (page: Page) => page.frameLocator('iframe.page-tab-frame:not([hidden])')
const stateOf = (page: Page) => editorFrame(page).locator('#state')

async function pluginActive(c: Cockpit, id: string): Promise<void> {
  await expect
    .poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.find((p) => p.id === id)?.state, { timeout: 15_000 })
    .toBe('active')
}

/** Opens the access link in a fresh browser and joins the cockpit's project from the web picker. */
async function joinProject(web: WebAccessOn): Promise<WebBrowser> {
  const browser = await openBrowser(web.link)
  try {
    const projects = browser.page.getByRole('list', { name: 'Open projects' }).getByRole('link')
    await expect(projects).toHaveCount(1)
    await projects.click()
    await expect(browser.page).toHaveURL(`${web.origin}/?project=${encodeURIComponent(web.projectId)}`)
    await expect(browser.page.locator('.tabs-pane')).toBeVisible()
    return browser
  } catch (err) {
    await browser.close()
    throw err
  }
}

declare global {
  interface Window {
    __sockets?: WebSocket[]
  }
}

/** Whether the web shell's `beforeunload` holds the unload now (run in the browser's page). */
function unloadHeld(): boolean {
  const ev = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(ev)
  return ev.defaultPrevented
}

test('a file tab in a browser view: edit (the unload is held), the socket drops with a dirty buffer, the text stays, save; the desktop shows it', async () => {
  test.setTimeout(120_000)
  const { cockpit: c, close } = await launchCockpit({
    env: { CC_COCKPIT_NO_BUNDLED: '' },
    // No autosave: the browser's edits stay unsaved across the drop, and Ctrl+S is the only save.
    settings: { pluginSettings: { 'cockpit.editor': { autosaveIdleSeconds: 0, autosaveOnBlur: false } } }
  })
  let browser: WebBrowser | undefined
  try {
    const { page, projectDir } = c
    const file = join(projectDir, 'shared.txt')
    writeFileSync(file, 'alpha\nbeta\ngamma\n')
    const web = await enableWebAccess(c)
    await pluginActive(c, 'cockpit.editor')
    await pluginActive(c, 'cockpit.files')

    // The desktop opens the file from the Files panel and shows it.
    await page.locator('.zone-left').getByRole('button', { name: /^Files/ }).click()
    const tree = page.frameLocator('section.panel[aria-label="Files"] iframe')
    const row = tree.locator('.row', { has: tree.locator('.name', { hasText: /^shared\.txt$/ }) })
    await row.hover()
    await row.getByRole('button', { name: 'Edit' }).click()
    await expect(editorFrame(page).locator('.cm-content')).toContainText('gamma')
    await expect(stateOf(page)).toHaveText('Saved')

    // The browser joins; remember every WebSocket the page makes so the test can drop the live one.
    browser = await joinProject(web)
    const web1 = browser.page
    await web1.addInitScript(() => {
      const Native = window.WebSocket
      window.__sockets = []
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols)
          window.__sockets!.push(this)
        }
      } as typeof WebSocket
    })
    await web1.reload()
    await expect(web1.locator('.tabs-pane')).toBeVisible()
    const tab = web1.getByRole('tab', { name: /shared\.txt/ })
    await expect(tab).toBeVisible({ timeout: 15_000 })
    await tab.click()
    const webFrame = editorFrame(web1)
    await expect(webFrame.locator('#path')).toHaveText('shared.txt', { timeout: 15_000 })
    await expect(webFrame.locator('.cm-content')).toContainText('gamma')
    await expect(stateOf(web1)).toHaveText('Saved')

    // Type in the browser: unsaved there; the desktop page has no edits and the file is untouched.
    await webFrame.locator('.cm-content').click()
    await web1.keyboard.press(`${MOD}+Home`)
    await web1.keyboard.type('from the browser ')
    await expect(stateOf(web1)).toHaveText('Unsaved')
    expect(readFileSync(file, 'utf8')).toBe('alpha\nbeta\ngamma\n')
    // Closing, reloading or leaving this browser tab would end the buffer: the web shell holds the
    // unload (the browser's own "Leave site?"). A dispatched event shows the listener's answer.
    await expect.poll(() => web1.evaluate(unloadHeld)).toBe(true)

    // The connection drops with the unsaved text in the buffer; the shell reconnects, the page takes
    // a new port and keeps its text and its unsaved state.
    const before = await web1.evaluate(() => window.__sockets!.length)
    expect(before).toBeGreaterThan(0)
    await web1.evaluate(() => {
      for (const s of window.__sockets!) s.close()
    })
    await expect
      .poll(() => web1.evaluate(() => window.__sockets!.length > 0 && window.__sockets![window.__sockets!.length - 1]!.readyState === 1 && window.__sockets!.length), { timeout: 30_000 })
      .toBeGreaterThan(before)
    await expect(webFrame.locator('.cm-content')).toContainText('from the browser alpha')
    await expect(stateOf(web1)).toHaveText('Unsaved')
    // A reconnect is not a save (autosave is off). The wrong save the old session.mjs made came only
    // after the page's reopen round trip was answered, which the open socket alone does not prove, and
    // nothing on the page marks that answer. So the disk is watched for a while (the round trip is
    // loopback, milliseconds) instead of read once, and read again just before Ctrl+S.
    const settleUntil = Date.now() + 2_000
    while (Date.now() < settleUntil) {
      expect(readFileSync(file, 'utf8')).toBe('alpha\nbeta\ngamma\n')
      await web1.waitForTimeout(100)
    }
    await expect(stateOf(web1)).toHaveText('Unsaved')

    // Save over the new connection: on disk, and the desktop's page (no edits of its own) shows it.
    await webFrame.locator('.cm-content').click()
    expect(readFileSync(file, 'utf8')).toBe('alpha\nbeta\ngamma\n')
    await web1.keyboard.press(`${MOD}+s`)
    await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 20_000 }).toBe('from the browser alpha\nbeta\ngamma\n')
    await expect(stateOf(web1)).toHaveText('Saved', { timeout: 20_000 })
    // Saved: nothing to lose, so nothing holds the unload (the browser closes below without a question).
    await expect.poll(() => web1.evaluate(unloadHeld)).toBe(false)
    await expect(editorFrame(page).locator('.cm-content')).toContainText('from the browser alpha', { timeout: 15_000 })
    await expect(stateOf(page)).toHaveText('Saved')

    // And the other way: an edit on the desktop reaches the browser's clean page through the file.
    await editorFrame(page).locator('.cm-content').click()
    await page.keyboard.press(`${MOD}+End`)
    await page.keyboard.type('from the desktop')
    await page.keyboard.press(`${MOD}+s`)
    await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 10_000 }).toBe('from the browser alpha\nbeta\ngamma\nfrom the desktop')
    await expect(webFrame.locator('.cm-content')).toContainText('from the desktop', { timeout: 15_000 })
  } finally {
    await browser?.close()
    await close()
  }
})
