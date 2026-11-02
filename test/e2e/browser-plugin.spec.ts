// Plan B, Task 10: the built-in browser plugin, end to end. It is bundled and on by default (this
// spec opts out of CC_COCKPIT_NO_BUNDLED, which the harness sets for every other spec). From a
// Claude-tab shell, `ccc browser open ./mock.html` shows the panel with the page; `ccc browser url`
// prints it; the tab's argv carries the plugin's skill folder; turning the browser off in the
// project hides the view and drops the skill from new tabs.
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expect, launchCockpit, test as base, type Cockpit } from './fixtures'

const ID = 'cockpit.browser'

const test = base.extend<{ cockpit: Cockpit }>({
  // eslint-disable-next-line no-empty-pattern
  cockpit: async ({}, use) => {
    const { cockpit, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
    try {
      await use(cockpit)
    } finally {
      await close()
    }
  }
})

/** The browser panel's native view (the one WebContentsView on a cc-preview: page): url and visibility, or null. */
function viewState(c: Cockpit): Promise<{ url: string; visible: boolean } | null> {
  return c.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      for (const child of win.contentView.children) {
        if (!(child instanceof WebContentsView)) continue
        const wc = child.webContents
        if (wc.isDestroyed() || !wc.getURL().startsWith('cc-preview://')) continue
        return { url: wc.getURL(), visible: child.getVisible() }
      }
    }
    return null
  })
}

test('ccc browser open shows a local page in the built-in panel; turning it off removes it and its skill', async ({ cockpit }) => {
  const { page } = cockpit
  mkdirSync(join(cockpit.projectDir, 'mock'))
  writeFileSync(join(cockpit.projectDir, 'mock', 'index.html'), '<!doctype html><title>Mock page</title><p>hello mock</p>')

  // On by default: the host starts without any enabling.
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: ID, state: 'active' }] })

  const core = join(cockpit.dataDir, 'claude-plugins', 'core')
  const skill = join(cockpit.dataDir, 'claude-plugins', ID)
  const hooks = join(cockpit.dataDir, 'hooks.json')
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  await expect.poll(() => cockpit.claudeRuns()).toEqual([['--settings', hooks, '--plugin-dir', core, '--plugin-dir', skill]])

  // Nothing shown yet.
  await cockpit.typeLine('/ccc browser url')
  await cockpit.waitForTerminalText('FAKE-CLAUDE ccc exit=0 out="blank\\n" err=""')

  await cockpit.typeLine('/ccc browser open mock/index.html')
  await cockpit.waitForTerminalText('FAKE-CLAUDE ccc exit=0 out="ok\\n" err=""')
  // The panel is in sight (its section is mounted and the native view is visible).
  await expect(page.locator('section.panel[aria-label="Browser"]')).toBeVisible()
  await expect.poll(async () => (await viewState(cockpit))?.visible).toBe(true)
  expect((await viewState(cockpit))?.url).toMatch(/^cc-preview:\/\/t[0-9a-f]+\/index\.html$/)

  await cockpit.typeLine('/ccc browser url')
  await cockpit.waitForTerminalText(/FAKE-CLAUDE ccc exit=0 out="cc-preview:\/\/t[0-9a-f]+\/index\.html\\tMock page\\n" err=""/)

  // Reload keeps the same page.
  await cockpit.typeLine('/ccc browser reload')
  await cockpit.waitForTerminalText('FAKE-CLAUDE ccc exit=0 out="ok\\n" err=""')

  // A scheme that is not http(s) is refused by the plugin, the page stays.
  await cockpit.typeLine('/ccc browser open file:///etc/passwd')
  await cockpit.waitForTerminalText(/FAKE-CLAUDE ccc exit=2 out="" err="only http\(s\) URLs and file paths/)

  // Off in this project: the view goes, and a new tab starts without the skill.
  await page.evaluate<void>(`window.cockpit.invoke('settings.projectPluginEnable', { pluginId: '${ID}', enabled: false })`)
  await expect.poll(() => viewState(cockpit)).toBeNull()
  await expect(page.locator('section.panel[aria-label="Browser"]')).toHaveCount(0)
  await cockpit.newTab('claude')
  await expect.poll(() => cockpit.claudeRuns().length).toBe(2)
  expect(cockpit.claudeRuns()[1]).toEqual(['--settings', hooks, '--plugin-dir', core])
})

/** A localhost port nothing listens on: bound by the OS, then closed again. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

// Review finding (ext round 10): a failed load reached only main's log, so `ccc browser open` said
// `ok` with the dev server down, `ccc browser url` could not tell, and the toolbar stayed on
// "No page" with Reload disabled (Electron fires no did-navigate for it and has no error page).
test('ccc browser open of a closed localhost port reports the error; url and the toolbar show it', async ({ cockpit }) => {
  const { page } = cockpit
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: ID, state: 'active' }] })
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')

  const url = `http://127.0.0.1:${await closedPort()}/`
  await cockpit.typeLine(`/ccc browser open ${url}`)
  await cockpit.waitForTerminalText(
    `FAKE-CLAUDE ccc exit=1 out="" err="webview.navigate: ${url} did not load: ERR_CONNECTION_REFUSED (-102)\\n"`
  )
  await cockpit.typeLine('/ccc browser url')
  await cockpit.waitForTerminalText(`FAKE-CLAUDE ccc exit=0 out="${url}\\tfailed to load: ERR_CONNECTION_REFUSED (-102)\\n" err=""`)

  // The panel is shown anyway, with the failed URL, the error and Reload enabled.
  const panel = page.locator('section.panel[aria-label="Browser"]')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.webview-url')).toHaveAttribute('data-url', url)
  await expect(panel.locator('.webview-load-error')).toContainText('ERR_CONNECTION_REFUSED')
  await expect(panel.getByRole('button', { name: 'Reload' })).toBeEnabled()
})
