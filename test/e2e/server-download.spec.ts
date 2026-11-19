// Downloads in server mode (design-download.md §2.2, §7; plan 20261114-download Task 13): a Files
// download in a browser of a headless server, and an offer made while no browser shows the project,
// which waits and is shown (armed) when a browser connects. Linux and macOS, like every server spec.
//
// The offer is made by a Claude tab's own delayed `/ccc download` (the fake claude's `/later`), so it
// runs after the only browser has left: nothing else can type into a tab of a server with no browser.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { filesTree, pluginActive, savedDownload, treeRow, zipNames } from './download-fixtures'
import { expectMainAlive, launchServer, type Server } from './server-fixtures'
import { openBrowser, openProjectInBrowser } from './web-fixtures'

test.skip(process.platform === 'win32', 'server mode does not run on Windows')

const BYTES = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 11 + 5) % 256))

let server: Server | undefined
test.afterEach(async () => {
  await server?.close()
  server = undefined
})

test('server mode: a Files download in a browser, and a held offer shown when a browser connects', async () => {
  test.setTimeout(150_000)
  server = await launchServer({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  const { cockpit } = server
  const { projectDir } = cockpit
  writeFileSync(join(projectDir, 'served.bin'), BYTES)
  mkdirSync(join(projectDir, 'pkg', 'node_modules'), { recursive: true })
  writeFileSync(join(projectDir, 'pkg', 'main.txt'), 'main\n')
  writeFileSync(join(projectDir, 'pkg', 'node_modules', 'skip.txt'), 'skipped\n')
  await pluginActive(cockpit, 'cockpit.files')

  const first = await openBrowser(`${server.origin}/`)
  try {
    await openProjectInBrowser(first, server.origin, server.projectId)
    const tree = await filesTree(first.page)
    await expect(treeRow(tree, 'served.bin')).toBeVisible()
    const menu = tree.getByRole('menu')

    // A file and a folder's zip, saved by the browser with no dialog.
    await treeRow(tree, 'served.bin').click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Download', exact: true }).click()
    const file = await savedDownload(first, 0)
    expect(file.name).toBe('served.bin')
    expect(readFileSync(file.path).equals(BYTES)).toBe(true)
    await treeRow(tree, 'pkg').click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Download as .zip', exact: true }).click()
    const zip = await savedDownload(first, 1)
    expect(zipNames(zip).filter((n) => !n.endsWith('/'))).toEqual(['pkg/main.txt'])
    await expect(first.page.getByTestId('download-offer')).toHaveCount(0)

    // A Claude tab that offers a file in a few seconds, then the only browser leaves.
    await first.page.getByRole('button', { name: 'New tab' }).click()
    await first.page.getByRole('menuitem', { name: 'Claude' }).click()
    await first.waitForTerminalText('FAKE-CLAUDE banner')
    await first.page.locator('.terminal-view:not([hidden]) .xterm').click()
    await first.page.keyboard.type(`/later 6000 /ccc download ${join(projectDir, 'served.bin')}`)
    await first.page.keyboard.press('Enter')
    await first.waitForTerminalText('/later 6000')
  } finally {
    await first.close()
  }

  // The offer is made with no browser attached: held, not refused (the server has no screen of its own).
  await new Promise((r) => setTimeout(r, 9_000))
  const second = await openBrowser(`${server.origin}/`)
  try {
    await openProjectInBrowser(second, server.origin, server.projectId)
    const dialog = second.page.getByTestId('download-offer')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(dialog.getByTestId('download-offer-path')).toHaveText(join(projectDir, 'served.bin'))
    // Shown armed after about a second, and answered by a click.
    await expect(dialog.getByTestId('download-offer-accept')).toBeEnabled({ timeout: 5_000 })
    await dialog.getByTestId('download-offer-accept').click()
    const ready = second.page.getByTestId('download-ready')
    await expect
      .poll(
        async () => {
          if ((await second.downloads()).length > 0) return true
          if ((await ready.count()) > 0) await ready.getByRole('link').click()
          return false
        },
        { timeout: 20_000 }
      )
      .toBe(true)
    const held = await savedDownload(second, 0)
    expect(readFileSync(held.path).equals(BYTES)).toBe(true)
    await expectMainAlive(server)
  } finally {
    await second.close()
  }
})
