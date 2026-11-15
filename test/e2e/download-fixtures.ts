// Helpers the download e2e specs share (web-download, server-download, remote-desktop): the Files
// panel's rows and menu in a page (the desktop's, a browser's or a remote window's), a browser that
// joins a project, and a download read back from the fixture's record.
import { expect, type Locator, type Page, type FrameLocator } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { readZip } from '../fakes/zip-reader'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { Cockpit } from './fixtures'
import { openBrowser, type BrowserDownload, type WebAccessOn, type WebBrowser } from './web-fixtures'

/** The plugin is running in the project the cockpit shows (the host is up before its panel works). */
export async function pluginActive(c: Cockpit, id: string): Promise<void> {
  await expect
    .poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.find((p) => p.id === id)?.state, { timeout: 15_000 })
    .toBe('active')
}

/** Opens the Files panel in `page` (the left zone's button) and returns its tree frame. */
export async function filesTree(page: Page): Promise<FrameLocator> {
  const section = page.locator('section.panel[aria-label="Files"]')
  if (!(await section.isVisible())) await page.locator('.zone-left').getByRole('button', { name: /^Files/ }).click()
  await expect(section).toBeVisible()
  return page.frameLocator('section.panel[aria-label="Files"] iframe')
}

/** The row named exactly `name` in the tree (a name shown at the top level or in an open folder). */
export const treeRow = (tree: FrameLocator, name: string): Locator =>
  tree.locator('.row', { has: tree.locator('.name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })

/** A fresh browser on `url` (default the access link) that joins the cockpit's project from the web picker. */
export async function joinProject(web: WebAccessOn, url: string = web.link): Promise<WebBrowser> {
  const browser = await openBrowser(url)
  try {
    await browser.page.getByRole('list', { name: 'Open projects' }).locator(`a[href="?project=${encodeURIComponent(web.projectId)}"]`).click()
    await expect(browser.page).toHaveURL(`${web.origin}/?project=${encodeURIComponent(web.projectId)}`)
    await expect(browser.page.locator('.tabs-pane')).toBeVisible()
    return browser
  } catch (err) {
    await browser.close()
    throw err
  }
}

/** The browser's `n`th download once it has ended (`completed`); fails when it ends any other way. */
export async function savedDownload(browser: WebBrowser, n: number): Promise<BrowserDownload> {
  await expect.poll(async () => (await browser.downloads())[n]?.state, { timeout: 20_000 }).toBe('completed')
  return (await browser.downloads())[n]!
}

/** A saved zip's entry names, read with the strict test reader (it checks the layout too). */
export function zipNames(download: BrowserDownload): string[] {
  return readZip(readFileSync(download.path)).map((e) => e.name)
}
