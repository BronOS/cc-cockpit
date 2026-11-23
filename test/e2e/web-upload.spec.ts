// Uploads in a browser view (design-upload.md §2-§5, §9; plan 20261122-upload Task 14): the Files panel's
// Upload here writes the exact bytes (a 20 MiB file and an empty one), a name clash asks Replace / Keep both
// / Cancel in an armed dialog, a drop of real paths (DevTools `Input.dispatchDragEvent`) on a folder row
// uploads there and names a dropped folder as skipped, a drop on a fake-`claude` tab in `waiting` opens the
// folder chooser and ends with the escaped path typed into the tab, a busy tab holds the paste (Paste path
// then types it), a file-only paste becomes an upload while a paste with text stays text, and a drop
// outside every target is cancelled and does nothing.
//
// The "device" is a temp folder outside the project; the browsers are test/fixtures/web-browser/main.cjs
// windows (Electron's Chromium, a profile each), driven by Playwright like any page.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { filesTree, joinProject, pluginActive, treeRow } from './download-fixtures'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { centreOf, chooseAndGo, dropPaths, entriesOf, escapePath, patternBytes, resultNotice, UPLOAD_TEMP, uploadHere } from './upload-fixtures'
import { enableWebAccess, type WebBrowser } from './web-fixtures'

const BIG = patternBytes(20 * 1024 * 1024, 3)

/** The files of `dir` that are not the uploader's temps (every upload must leave none). */
function noTemps(dir: string): string[] {
  const names = entriesOf(dir)
  expect(names.filter((n) => UPLOAD_TEMP.test(n))).toEqual([])
  return names
}

test('Files in a browser view: Upload here writes the exact bytes, a clash asks Replace / Keep both / Cancel, a drop on a folder row uploads there and names a dropped folder', async () => {
  test.setTimeout(180_000)
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  let browser: WebBrowser | undefined
  const device = mkdtempSync(join(tmpdir(), 'ccc-e2e-device-'))
  try {
    const { projectDir } = c
    mkdirSync(join(projectDir, 'dest'))
    mkdirSync(join(projectDir, 'other'))
    writeFileSync(join(device, 'big.bin'), BIG)
    writeFileSync(join(device, 'empty.txt'), '')
    const web = await enableWebAccess(c)
    await pluginActive(c, 'cockpit.files')
    browser = await joinProject(web)
    const { page } = browser
    const tree = await filesTree(page)
    await expect(treeRow(tree, 'dest')).toBeVisible()

    // The desktop page is not a browser view: no Upload here item at all (remote only, like Download).
    const deskTree = await filesTree(c.page)
    await expect(treeRow(deskTree, 'dest')).toBeVisible()
    await treeRow(deskTree, 'dest').click({ button: 'right' })
    const deskMenu = deskTree.getByRole('menu')
    await expect(deskMenu).toBeVisible()
    expect(await deskMenu.getByRole('menuitem').allInnerTexts()).not.toContainEqual(expect.stringMatching(/^Upload/))
    await c.page.keyboard.press('Escape')
    await expect(deskMenu).toBeHidden()

    // Upload here with a 20 MiB file and an empty one: the exact bytes, no temp left.
    await uploadHere(page, tree, 'dest', [join(device, 'big.bin'), join(device, 'empty.txt')])
    await expect(resultNotice(page, /^Uploaded .* to dest/)).toBeVisible({ timeout: 60_000 })
    expect(readFileSync(join(projectDir, 'dest', 'big.bin')).equals(BIG)).toBe(true)
    expect(readFileSync(join(projectDir, 'dest', 'empty.txt')).length).toBe(0)
    expect(noTemps(join(projectDir, 'dest'))).toEqual(['big.bin', 'empty.txt'])

    // A clash. Cancel first: nothing changes. The dialog is armed after about a second.
    const second = join(device, 'v2')
    mkdirSync(second)
    writeFileSync(join(second, 'big.bin'), 'second version\n')
    await uploadHere(page, tree, 'dest', [join(second, 'big.bin')])
    const clash = page.getByTestId('upload-clash')
    await expect(clash).toBeVisible()
    await expect(clash).toContainText('1 file already exists in dest: big.bin')
    await expect(clash.getByTestId('upload-clash-replace')).toBeDisabled()
    await expect(clash.getByTestId('upload-clash-replace')).toBeEnabled({ timeout: 5_000 })
    await clash.getByTestId('upload-clash-cancel').click()
    await expect(clash).toHaveCount(0)
    await new Promise((r) => setTimeout(r, 1_000))
    expect(readFileSync(join(projectDir, 'dest', 'big.bin')).equals(BIG)).toBe(true)
    expect(noTemps(join(projectDir, 'dest'))).toEqual(['big.bin', 'empty.txt'])

    // Replace: the file at the name is the new one.
    await uploadHere(page, tree, 'dest', [join(second, 'big.bin')])
    await expect(clash).toBeVisible()
    await expect(clash.getByTestId('upload-clash-replace')).toBeEnabled({ timeout: 5_000 })
    await clash.getByTestId('upload-clash-replace').click()
    await expect(resultNotice(page, /^Uploaded big\.bin to dest/)).toBeVisible({ timeout: 30_000 })
    expect(readFileSync(join(projectDir, 'dest', 'big.bin'), 'utf8')).toBe('second version\n')
    expect(noTemps(join(projectDir, 'dest'))).toEqual(['big.bin', 'empty.txt'])

    // Keep both: the old file stays, the new one comes numbered.
    const third = join(device, 'v3')
    mkdirSync(third)
    writeFileSync(join(third, 'big.bin'), 'third version\n')
    await uploadHere(page, tree, 'dest', [join(third, 'big.bin')])
    await expect(clash).toBeVisible()
    await expect(clash.getByTestId('upload-clash-keep-both')).toBeEnabled({ timeout: 5_000 })
    await clash.getByTestId('upload-clash-keep-both').click()
    await expect(resultNotice(page, /^Uploaded big \(1\)\.bin to dest/)).toBeVisible({ timeout: 30_000 })
    expect(readFileSync(join(projectDir, 'dest', 'big.bin'), 'utf8')).toBe('second version\n')
    expect(readFileSync(join(projectDir, 'dest', 'big (1).bin'), 'utf8')).toBe('third version\n')
    expect(noTemps(join(projectDir, 'dest'))).toEqual(['big (1).bin', 'big.bin', 'empty.txt'])

    // A drop of real paths on the folder row `other`: a file and a folder; the file lands, the folder is named and skipped.
    writeFileSync(join(device, 'dropped.txt'), 'dropped bytes\n')
    mkdirSync(join(device, 'photos'))
    writeFileSync(join(device, 'photos', 'in.txt'), 'inside\n')
    await dropPaths(page, await centreOf(treeRow(tree, 'other')), [join(device, 'dropped.txt'), join(device, 'photos')])
    await expect(resultNotice(page, /dropped\.txt to other/)).toBeVisible({ timeout: 30_000 })
    await expect(resultNotice(page, 'photos')).toBeVisible()
    expect(readFileSync(join(projectDir, 'other', 'dropped.txt'), 'utf8')).toBe('dropped bytes\n')
    expect(noTemps(join(projectDir, 'other'))).toEqual(['dropped.txt'])
    expect(existsSync(join(projectDir, 'other', 'photos'))).toBe(false)
    expect(existsSync(join(projectDir, 'photos'))).toBe(false)
  } finally {
    await browser?.close()
    await close()
    rmSync(device, { recursive: true, force: true })
  }
})

/** The sessions the app knows in this project, by tab id and status. */
const statusOf = async (c: Cockpit): Promise<string | undefined> => (await c.hook<Array<{ status: string }>>('sessions', c.projectDir))[0]?.status

/** Opens a Claude tab in the browser view and waits until it is at the prompt. */
async function claudeTab(c: Cockpit, browser: WebBrowser): Promise<void> {
  await browser.page.getByRole('button', { name: 'New tab' }).click()
  await browser.page.getByRole('menuitem', { name: 'Claude' }).click()
  await browser.waitForTerminalText('FAKE-CLAUDE banner')
  await expect.poll(() => statusOf(c), { timeout: 15_000 }).toBe('waiting')
}

/** The visible terminal's pane in the page (what a drop or a paste aims at). */
const terminalPane = (page: Page) => page.locator('.terminal-view:not([hidden])')

test('a Files drop on a Claude tab: the folder chooser, the upload, the escaped path typed in at the prompt; a busy tab holds the paste; a file-only paste uploads, a paste with text stays text; a drop outside every target does nothing', async () => {
  test.setTimeout(240_000)
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  let browser: WebBrowser | undefined
  const device = mkdtempSync(join(tmpdir(), 'ccc-e2e-device-'))
  try {
    const { projectDir } = c
    const web = await enableWebAccess(c)
    await pluginActive(c, 'cockpit.files')
    browser = await joinProject(web)
    const { page } = browser
    await claudeTab(c, browser)
    const pane = terminalPane(page)

    // A drop outside every target first (the shell's window-level cancel, design §3.6): the dragover is
    // cancelled with no drop effect (so the browser does not take the drop at all, and it cannot open the
    // file in the tab), the page stays where it is and nothing is asked or written.
    const before = readdirSync(projectDir).sort()
    type Seen = Array<{ type: string; prevented: boolean; effect: string }>
    await page.evaluate(() => {
      const seen: Seen = []
      ;(window as unknown as { __seen: Seen }).__seen = seen
      // Registered after the shell's listeners on the same target, so it sees the result of theirs.
      for (const type of ['dragover', 'drop']) {
        window.addEventListener(type, (e) => seen.push({ type, prevented: e.defaultPrevented, effect: (e as DragEvent).dataTransfer?.dropEffect ?? '' }))
      }
    })
    const url = page.url()
    writeFileSync(join(device, 'stray.txt'), 'stray\n')
    await dropPaths(page, await centreOf(page.locator('.zone-left').getByRole('button').first()), [join(device, 'stray.txt')])
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __seen: Seen }).__seen.length))
      .toBeGreaterThan(0)
    await page.waitForTimeout(500)
    const seen = await page.evaluate(() => (window as unknown as { __seen: Seen }).__seen)
    expect(seen.filter((e) => e.type === 'dragover').every((e) => e.prevented && e.effect === 'none')).toBe(true)
    // A drop that is delivered anyway is cancelled too: nothing may reach the browser's default.
    expect(seen.filter((e) => e.type === 'drop').every((e) => e.prevented)).toBe(true)
    expect(page.url()).toBe(url)
    await expect(page.locator('.tabs-pane')).toBeVisible()
    await expect(page.getByTestId('upload-dialog')).toHaveCount(0)
    await expect(page.getByTestId('upload-progress')).toHaveCount(0)
    await expect(resultNotice(page)).toHaveCount(0)
    expect(readdirSync(projectDir).sort()).toEqual(before)

    // The drop on the tab, at the prompt: chooser (project folder preset), upload, path typed.
    const named = 'my shot (1).png'
    writeFileSync(join(device, named), patternBytes(300_000, 9))
    await dropPaths(page, await centreOf(pane), [join(device, named)])
    await chooseAndGo(page)
    await expect(resultNotice(page, `Uploaded ${named} to the project folder`)).toBeVisible({ timeout: 30_000 })
    expect(readFileSync(join(projectDir, named)).equals(patternBytes(300_000, 9))).toBe(true)
    const typed = `${escapePath(join(projectDir, named))} `
    // Typed into the line and not submitted: Enter (the person's) makes the fake echo the line.
    await browser.waitForTerminalText(typed.trimEnd())
    await page.keyboard.press('Enter')
    await browser.waitForTerminalText(`FAKE-CLAUDE echo: ${typed}`)
    // The notice is clean and hides itself: the paste was not held.
    await expect(page.getByTestId('upload-paste')).toHaveCount(0)

    // A busy tab: the files upload, the paste is held with Paste path; at the prompt again it types.
    await page.locator('.terminal-view:not([hidden]) .xterm').click()
    await page.keyboard.type('/prompt busy now')
    await page.keyboard.press('Enter')
    await expect.poll(() => statusOf(c), { timeout: 15_000 }).toBe('working')
    writeFileSync(join(device, 'held.txt'), 'held\n')
    await dropPaths(page, await centreOf(pane), [join(device, 'held.txt')])
    await chooseAndGo(page)
    const held = resultNotice(page, 'held.txt')
    await expect(held).toBeVisible({ timeout: 30_000 })
    await expect(held.getByTestId('upload-paste')).toBeVisible()
    expect(readFileSync(join(projectDir, 'held.txt'), 'utf8')).toBe('held\n')
    expect(await browser.terminalText()).not.toContain('held.txt')
    await page.locator('.terminal-view:not([hidden]) .xterm').click()
    await page.keyboard.type('/stop')
    await page.keyboard.press('Enter')
    await expect.poll(() => statusOf(c), { timeout: 15_000 }).toBe('waiting')
    await held.getByTestId('upload-paste').click()
    await browser.waitForTerminalText(join(projectDir, 'held.txt'))
    // The button keeps the focus (an Enter there would press it again): back to the terminal for the Enter.
    await page.locator('.terminal-view:not([hidden]) .xterm').click()
    await page.keyboard.press('Enter')
    await browser.waitForTerminalText(`FAKE-CLAUDE echo: ${escapePath(join(projectDir, 'held.txt'))} `)

    // A paste whose clipboard holds a file and text stays a text paste: no chooser, the text arrives.
    const paste = (withText: boolean) =>
      page.evaluate((text) => {
        const data = new DataTransfer()
        data.items.add(new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], 'image.png', { type: 'image/png' }))
        if (text) data.setData('text/plain', 'plain words')
        const target = document.querySelector('.terminal-view:not([hidden]) textarea') as HTMLElement
        target.focus()
        target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      }, withText)
    await paste(true)
    await browser.waitForTerminalText('plain words')
    await expect(page.getByTestId('upload-dialog')).toHaveCount(0)
    await page.keyboard.press('Enter')

    // A paste of a file alone is an upload named pasted-<date>-<time>.png; the path types in.
    await paste(false)
    await chooseAndGo(page)
    await expect.poll(() => readdirSync(projectDir).find((n) => /^pasted-\d{8}-\d{6}\.png$/.test(n)), { timeout: 30_000 }).toBeDefined()
    const pasted = readdirSync(projectDir).find((n) => /^pasted-\d{8}-\d{6}\.png$/.test(n))!
    expect([...readFileSync(join(projectDir, pasted))]).toEqual([137, 80, 78, 71, 1, 2, 3])
    await browser.waitForTerminalText(join(projectDir, pasted))
    expect(readdirSync(projectDir)).not.toContain('stray.txt')
  } finally {
    await browser?.close()
    await close()
    rmSync(device, { recursive: true, force: true })
  }
})
