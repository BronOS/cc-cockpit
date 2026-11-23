// Uploads in server mode (design-upload.md §7; plan 20261122-upload Task 14): a Files "Upload here" in a
// browser of a headless server writes the exact bytes (several chunks: the file is larger than the first
// slice) and leaves no temp; main stays up. Linux and macOS, like every server spec.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { filesTree, pluginActive, treeRow } from './download-fixtures'
import { expectMainAlive, launchServer, type Server } from './server-fixtures'
import { patternBytes, resultNotice, uploadHere } from './upload-fixtures'
import { openBrowser, openProjectInBrowser } from './web-fixtures'

test.skip(process.platform === 'win32', 'server mode does not run on Windows')

let server: Server | undefined
test.afterEach(async () => {
  await server?.close()
  server = undefined
})

test('server mode: an Upload here from a browser writes the exact bytes and leaves no temp', async () => {
  test.setTimeout(150_000)
  server = await launchServer({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  const { cockpit } = server
  const { projectDir } = cockpit
  const bytes = patternBytes(3 * 1024 * 1024 + 17, 5)
  mkdirSync(join(projectDir, 'inbox'))
  // Made inside the try with everything that can fail (the plugin poll, the browser launch): the temp dir never leaks.
  let device: string | undefined
  let browser: Awaited<ReturnType<typeof openBrowser>> | undefined
  try {
    device = mkdtempSync(join(tmpdir(), 'ccc-e2e-device-'))
    writeFileSync(join(device, 'phone.bin'), bytes)
    writeFileSync(join(device, 'note.txt'), 'from the device\n')
    await pluginActive(cockpit, 'cockpit.files')
    browser = await openBrowser(`${server.origin}/`)
    await openProjectInBrowser(browser, server.origin, server.projectId)
    const tree = await filesTree(browser.page)
    await expect(treeRow(tree, 'inbox')).toBeVisible()
    await uploadHere(browser.page, tree, 'inbox', [join(device, 'phone.bin'), join(device, 'note.txt')])
    await expect(resultNotice(browser.page, /^Uploaded .* to inbox/)).toBeVisible({ timeout: 60_000 })
    expect(readFileSync(join(projectDir, 'inbox', 'phone.bin')).equals(bytes)).toBe(true)
    expect(readFileSync(join(projectDir, 'inbox', 'note.txt'), 'utf8')).toBe('from the device\n')
    expect(readdirSync(join(projectDir, 'inbox')).sort()).toEqual(['note.txt', 'phone.bin'])
    await expectMainAlive(server)
  } finally {
    await browser?.close()
    if (device !== undefined) rmSync(device, { recursive: true, force: true })
  }
})
