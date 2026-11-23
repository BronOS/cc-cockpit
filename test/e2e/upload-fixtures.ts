// Helpers the upload e2e specs share (web-upload, guest-upload, server-upload, remote-desktop): the
// Files panel's Upload here item and a drop of real paths through the DevTools protocol, which is
// the nearest a driver gets to a drop from Finder (Task 1 / design-upload.md §11: the frame's `drop`
// gets disk-backed `File`s, `webkitGetAsEntry()` tells a folder from a file).
import { expect, type Locator, type Page, type FrameLocator } from '@playwright/test'
import { readdirSync } from 'node:fs'
import { treeRow } from './download-fixtures'
import type { Cockpit } from './fixtures'
import type { WebBrowser } from './web-fixtures'

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

const ECHO = 'FAKE-CLAUDE echo:'

/** The terminal's rows glued (a long line can be soft-wrapped at this view's width, as `waitForTerminalText` reads it too). */
const gluedText = async (b: Pick<WebBrowser, 'terminalText'>): Promise<string> => (await b.terminalText()).replaceAll('\n', '')

/** How many lines the fake `claude` has echoed so far (each submitted line prints one `FAKE-CLAUDE echo:`). */
export async function echoCount(b: Pick<WebBrowser, 'terminalText'>): Promise<number> {
  return (await gluedText(b)).split(ECHO).length - 1
}

/**
 * After the person's Enter: exactly one echo more than `before` (so the paste carried no Enter of its own and
 * nothing was delivered twice) and the last one holds `line` and nothing else (the path once, no extra text).
 * Take `before` ahead of the step, read the result after the Enter.
 */
export async function expectOneEcho(b: Pick<WebBrowser, 'terminalText'>, before: number, line: string): Promise<void> {
  await expect.poll(() => echoCount(b), { timeout: 10_000, message: `no new ${ECHO} line` }).toBeGreaterThanOrEqual(before + 1)
  // A second, late echo would be a second delivery: give it a moment to show up.
  await new Promise((r) => setTimeout(r, 750))
  expect(await echoCount(b)).toBe(before + 1)
  const text = await gluedText(b)
  expect(text.slice(text.lastIndexOf(ECHO) + ECHO.length).trim()).toBe(line)
}

/** The status of the project's first Claude session (`waiting`, `working`, ...), from main's registry. */
export const statusOf = async (c: Cockpit): Promise<string | undefined> => (await c.hook<Array<{ status: string }>>('sessions', c.projectDir))[0]?.status
