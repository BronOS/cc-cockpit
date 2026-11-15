// Downloads in a browser view (design-download.md §2, §8; plan 20261114-download Task 13): the Files
// panel's Download items save the exact bytes with no dialog, the zips leave `.git` and
// `node_modules` out unless asked, the desktop page has no Download item, and `ccc download` from a
// Claude tab shows an armed dialog in every browser view of the window (the first answer wins).
//
// The browsers are test/fixtures/web-browser/main.cjs windows (Electron's Chromium, a profile each);
// it saves what the page downloads under its profile and records it (`WebBrowser.downloads`).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readZip } from '../fakes/zip-reader'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { filesTree, joinProject, pluginActive, savedDownload, treeRow, zipNames } from './download-fixtures'
import { enableWebAccess, type WebBrowser } from './web-fixtures'

/** Bytes with every value, so a text re-encoding or a trimmed tail shows. */
const BYTES = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7 + 3) % 256))

test('Files in a browser view: Download saves the exact bytes, the zips drop .git and node_modules unless included; the desktop has no Download', async () => {
  test.setTimeout(150_000)
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  let browser: WebBrowser | undefined
  try {
    const { projectDir } = c
    writeFileSync(join(projectDir, 'blob.bin'), BYTES)
    mkdirSync(join(projectDir, 'app', 'src'), { recursive: true })
    mkdirSync(join(projectDir, 'app', '.git'))
    mkdirSync(join(projectDir, 'app', 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(projectDir, 'app', 'src', 'a.txt'), 'alpha\n')
    writeFileSync(join(projectDir, 'app', 'top.txt'), 'top\n')
    writeFileSync(join(projectDir, 'app', '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(projectDir, 'app', 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
    const web = await enableWebAccess(c)
    await pluginActive(c, 'cockpit.files')

    // The desktop page's menus: the file is already on this screen, so no Download item at all.
    const deskTree = await filesTree(c.page)
    await expect(treeRow(deskTree, 'blob.bin')).toBeVisible()
    for (const name of ['blob.bin', 'app']) {
      await treeRow(deskTree, name).click({ button: 'right' })
      const menu = deskTree.getByRole('menu')
      await expect(menu).toBeVisible()
      expect(await menu.getByRole('menuitem').allInnerTexts()).not.toContainEqual(expect.stringMatching(/^Download/))
      await c.page.keyboard.press('Escape')
      await expect(menu).toBeHidden()
    }

    browser = await joinProject(web)
    const { page } = browser
    const tree = await filesTree(page)
    await expect(treeRow(tree, 'blob.bin')).toBeVisible()

    // A file: the click is the gesture, no dialog, the bytes are the file's.
    await treeRow(tree, 'blob.bin').click({ button: 'right' })
    const menu = tree.getByRole('menu')
    await expect(menu.getByRole('menuitem', { name: 'Download', exact: true })).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Download', exact: true }).click()
    const file = await savedDownload(browser, 0)
    expect(file.name).toBe('blob.bin')
    expect(readFileSync(file.path).equals(BYTES)).toBe(true)
    await expect(page.getByTestId('download-offer')).toHaveCount(0)

    // A folder as a .zip: the tree without .git and node_modules.
    await treeRow(tree, 'app').click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Download as .zip', exact: true }).click()
    const plain = await savedDownload(browser, 1)
    expect(plain.name).toBe('app.zip')
    expect(zipNames(plain).filter((n) => !n.endsWith('/')).sort()).toEqual(['app/src/a.txt', 'app/top.txt'])
    const a = readZip(readFileSync(plain.path)).find((e) => e.name === 'app/src/a.txt')!
    expect(a.data.toString()).toBe('alpha\n')

    // The include item: the same folder with them.
    await treeRow(tree, 'app').click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Download as .zip with .git and node_modules' }).click()
    const all = await savedDownload(browser, 2)
    expect(zipNames(all).filter((n) => !n.endsWith('/')).sort()).toEqual([
      'app/.git/HEAD',
      'app/node_modules/dep/index.js',
      'app/src/a.txt',
      'app/top.txt'
    ])
    // Nothing of the three needed a dialog.
    await expect(page.getByTestId('download-offer')).toHaveCount(0)
    expect(await browser.downloads()).toHaveLength(3)
  } finally {
    await browser?.close()
    await close()
  }
})

/** The line the fake Claude prints for a finished `/ccc` (its exit code, then the CLI's out and err). */
const CCC_EXIT = /FAKE-CLAUDE ccc exit=(\d+)/g

/** Runs `/ccc download <path>` in the Claude tab (`done` earlier ones already ran) and returns its exit code. */
async function offer(c: Cockpit, path: string, done: number): Promise<number> {
  await c.typeLine(`/ccc download ${path}`)
  let code = -1
  await expect
    .poll(
      async () => {
        const text = (await c.terminalText()).replaceAll('\n', '')
        const all = [...text.matchAll(CCC_EXIT)]
        if (all.length <= done) return false
        code = Number(all[done]![1])
        return true
      },
      { timeout: 15_000 }
    )
    .toBe(true)
  return code
}

test('ccc download from a Claude tab: an armed dialog in both browser views, a cancel in one closes both, an accept downloads in that view only', async () => {
  test.setTimeout(180_000)
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  const browsers: WebBrowser[] = []
  const outside = mkdtempSync(join(tmpdir(), 'ccc-e2e-outside-'))
  try {
    const { projectDir } = c
    writeFileSync(join(projectDir, 'report.bin'), BYTES)
    writeFileSync(join(outside, 'elsewhere.txt'), 'not in the project\n')
    mkdirSync(join(c.root, 'home', '.ssh'), { recursive: true })
    writeFileSync(join(c.root, 'home', '.ssh', 'x'), 'secret\n')
    const web = await enableWebAccess(c)
    const first = await joinProject(web)
    browsers.push(first)
    const second = await joinProject(web)
    browsers.push(second)
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')

    // An offer: the dialog in both views with the full path; Download is inert at first (armed after
    // about a second of being seen, and only in a page that has the focus).
    await second.page.bringToFront()
    await first.page.bringToFront()
    const path = join(projectDir, 'report.bin')
    expect(await offer(c, path, 0)).toBe(0)
    const dialogs = [first, second].map((b) => b.page.getByTestId('download-offer'))
    // Inert is checked at the first visible frame, before the arming timer can run out on a slow machine.
    await expect(dialogs[0]!).toBeVisible()
    await expect(dialogs[0]!.getByTestId('download-offer-accept')).toBeDisabled()
    for (const d of dialogs) {
      await expect(d).toBeVisible()
      await expect(d.getByTestId('download-offer-path')).toHaveText(path)
    }
    await expect(dialogs[0]!.getByTestId('download-offer-accept')).toBeEnabled({ timeout: 5_000 })

    // Cancel in the second view closes both, and nothing downloads.
    await second.page.bringToFront()
    await dialogs[1]!.getByTestId('download-offer-cancel').click()
    for (const d of dialogs) await expect(d).toHaveCount(0)
    await new Promise((r) => setTimeout(r, 1_000))
    expect(await first.downloads()).toEqual([])
    expect(await second.downloads()).toEqual([])

    // A second offer, accepted in the first view: it downloads there and the other view's dialog goes.
    expect(await offer(c, path, 1)).toBe(0)
    for (const d of dialogs) await expect(d).toBeVisible()
    await first.page.bringToFront()
    const accept = dialogs[0]!.getByTestId('download-offer-accept')
    await expect(accept).toBeEnabled({ timeout: 5_000 })
    await accept.click()
    await expect(dialogs[1]!).toHaveCount(0)
    // The start reaches the accepting view: the link is clicked at once, or shown as "ready" when the
    // click no longer counted as the person's; either way one saved file with the exact bytes.
    const ready = first.page.getByTestId('download-ready')
    await expect
      .poll(
        async () => {
          if ((await first.downloads()).length > 0) return true
          if ((await ready.count()) > 0) await ready.getByRole('link').click()
          return false
        },
        { timeout: 20_000 }
      )
      .toBe(true)
    const saved = await savedDownload(first, 0)
    expect(saved.name).toBe('report.bin')
    expect(readFileSync(saved.path).equals(BYTES)).toBe(true)
    expect(await second.downloads()).toEqual([])

    // A file outside the project is offered with the outside mark; Cancel it.
    expect(await offer(c, join(outside, 'elsewhere.txt'), 2)).toBe(0)
    await expect(dialogs[0]!).toContainText('This is outside the project.')
    await expect(dialogs[0]!.getByTestId('download-offer-path')).toHaveText(join(outside, 'elsewhere.txt'))
    await dialogs[0]!.getByTestId('download-offer-cancel').click()
    for (const d of dialogs) await expect(d).toHaveCount(0)

    // A hidden folder of the home is refused outright: exit 1, no dialog.
    expect(await offer(c, join(c.root, 'home', '.ssh', 'x'), 3)).toBe(1)
    await new Promise((r) => setTimeout(r, 500))
    for (const d of dialogs) await expect(d).toHaveCount(0)
    // The refusals left nothing on disk: only the one accepted download exists, in the first view.
    expect(await first.downloads()).toHaveLength(1)
    expect(await second.downloads()).toEqual([])
  } finally {
    for (const b of browsers) await b.close()
    await close()
    rmSync(outside, { recursive: true, force: true })
  }
})
