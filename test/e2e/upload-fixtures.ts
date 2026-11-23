// Helpers the upload e2e specs share (web-upload, guest-upload, server-upload, remote-desktop): the
// Files panel's Upload here item and a drop of real paths through the DevTools protocol, which is
// the nearest a driver gets to a drop from Finder (Task 1 / design-upload.md §11: the frame's `drop`
// gets disk-backed `File`s, `webkitGetAsEntry()` tells a folder from a file).
import { expect, type Locator, type Page, type FrameLocator } from '@playwright/test'
import { readdirSync } from 'node:fs'
import { treeRow } from './download-fixtures'

/** The uploader's own temps (`.cc-upload-<16 hex>`, main/files/upload-writer.ts): none may outlive an upload. */
export const UPLOAD_TEMP = /^\.cc-upload-/

/** The names in a folder, sorted: a leftover temp shows in this listing. */
export const entriesOf = (dir: string): string[] => readdirSync(dir).sort()

/** The page's `upload-result` notices, or the one holding `text` (a clean result stays about 6 s, so two can be up at once). */
export const resultNotice = (page: Page, text?: string | RegExp): Locator =>
  text === undefined ? page.getByTestId('upload-result') : page.getByTestId('upload-result').filter({ hasText: text })

/**
 * Right-click on a tree row and choose Upload here…, answer the file chooser with `files`. The click
 * is the person's gesture (a real input event), which Chromium needs before it opens a chooser.
 */
export async function uploadHere(page: Page, tree: FrameLocator, rowName: string, files: string[]): Promise<void> {
  await treeRow(tree, rowName).click({ button: 'right' })
  const item = tree.getByRole('menu').getByRole('menuitem', { name: 'Upload here…', exact: true })
  await expect(item).toBeVisible()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10_000 }), item.click()])
  await chooser.setFiles(files)
}

/** The centre of `target` in the page's own coordinates (a frame's element too), for a pointer-level driver. */
export async function centreOf(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox()
  if (box === null) throw new Error('nothing to aim at: the element has no box')
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
}

/**
 * A drop of real paths over `at`: DevTools `Input.dispatchDragEvent` (enter, over, drop), as Finder
 * would deliver it. `files` may name folders (their `File`s are directory entries).
 */
export async function dropPaths(page: Page, at: { x: number; y: number }, files: string[]): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  try {
    const data = { items: [], files, dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) await cdp.send('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data })
  } finally {
    await cdp.detach().catch(() => {})
  }
}

/** The backslash escape of design §4.3 (ASCII space and the shell's characters), for an expected path. */
export const escapePath = (path: string): string => path.replace(/[\\'"`$&*()[\]{};|<>?!#~ ]/g, '\\$&')

/** A byte pattern with every value in it, so a re-encoding, a trimmed tail or a swapped chunk shows. */
export function patternBytes(length: number, seed: number): Buffer {
  const out = Buffer.allocUnsafe(length)
  for (let i = 0; i < length; i++) out[i] = (i * 31 + (i >>> 8) * 7 + seed) & 0xff
  return out
}

/** Chooses the project folder in the folder chooser and uploads (it opens at the preset: the project folder). */
export async function chooseAndGo(page: Page): Promise<void> {
  const dialog = page.getByTestId('upload-dialog')
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  const go = dialog.getByTestId('upload-go')
  await expect(go).toBeEnabled({ timeout: 10_000 })
  await go.click()
  await expect(dialog).toHaveCount(0)
}
