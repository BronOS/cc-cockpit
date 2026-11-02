// Task 16: Claude status in the UI. Tab dots, the top strip across windows (fed by the per-window
// snapshot) and the queued chip, all driven by the fake `claude`'s scripted hook lines.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test, type Cockpit } from './fixtures'

interface Entry {
  tabId: string
  status: string
  queue: Array<{ id: string; text: string }>
}

const entries = (c: Cockpit, dir: string): Promise<Entry[]> => c.hook<Entry[]>('sessions', dir)

async function expectStatus(c: Cockpit, dir: string, index: number, status: string): Promise<void> {
  await expect
    .poll(async () => (await entries(c, dir))[index]?.status, { timeout: 15_000 })
    .toBe(status)
}

/** A new Claude tab in the given window (the fixture's helpers drive the first window only). */
async function newClaudeTab(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New tab' }).click()
  await page.getByRole('menuitem', { name: 'Claude' }).click()
}

/** Type a line into the active terminal of the given window. */
async function typeIn(page: Page, line: string): Promise<void> {
  await page.locator('.terminal-view:not([hidden]) .xterm').click()
  await page.keyboard.type(line)
  await page.keyboard.press('Enter')
}

test('a tab needing permission in window B leads window A’s strip, and a click focuses B on that tab', async ({
  cockpit
}) => {
  const dirB = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-e2e-strip-b-')))
  try {
    const pageA = cockpit.page
    // What window A is told, to check that project B's private data never reaches it.
    await pageA.evaluate(() => {
      const w = globalThis as unknown as {
        __snaps: unknown[]
        cockpit: { on(c: string, cb: (p: unknown) => void): void }
      }
      w.__snaps = []
      w.cockpit.on('sessions.snapshot', (p) => w.__snaps.push(p))
    })

    await cockpit.hook('openProject', dirB)
    await expect.poll(() => cockpit.app.windows().length).toBe(2)
    const pageB = cockpit.app.windows().find((p) => p !== pageA)!
    await pageB.locator('.tabs-pane').waitFor()
    const nameB = basename(dirB)

    // Window A: one working tab. Window B: two tabs, the first one needing permission.
    await cockpit.newTab('claude')
    await expectStatus(cockpit, cockpit.projectDir, 0, 'idle')
    await cockpit.typeLine('/prompt work in a')
    await expectStatus(cockpit, cockpit.projectDir, 0, 'working')

    await newClaudeTab(pageB)
    await expectStatus(cockpit, dirB, 0, 'idle')
    await typeIn(pageB, '/prompt secret-b-prompt')
    await expectStatus(cockpit, dirB, 0, 'working')
    await typeIn(pageB, '/permission')
    await expectStatus(cockpit, dirB, 0, 'needs-permission')
    const [tabB1] = await entries(cockpit, dirB)

    await newClaudeTab(pageB)
    await expectStatus(cockpit, dirB, 1, 'idle')
    // The new tab is the selected one in B.
    await expect(pageB.getByRole('tab', { selected: true })).toContainText('Claude')
    const selectedBefore = await pageB.getByRole('tab').evaluateAll((tabs) =>
      tabs.map((t) => t.getAttribute('aria-selected'))
    )
    expect(selectedBefore).toEqual(['false', 'true'])

    // Window A's strip lists only the OTHER window's tabs (its own working tab is in its tab bar
    // and Sessions panel): B's permission tab first, then B's idle tab.
    const strip = pageA.locator('.top-strip .strip-entry')
    await expect(strip).toHaveCount(2)
    await expect(strip.nth(0)).toHaveAttribute('data-status', 'needs-permission')
    await expect(strip.nth(0)).toContainText(`${nameB} · needs permission`)
    await expect(strip.nth(1)).toHaveAttribute('data-status', 'idle')
    await expect(strip.filter({ hasText: 'working' })).toHaveCount(0)
    // The status dot of A's own tab.
    await expect(pageA.locator('.tab .status-dot')).toHaveAttribute('data-status', 'working')

    // B's prompt was never sent to window A.
    const snaps = await pageA.evaluate(() => (globalThis as unknown as { __snaps: unknown[] }).__snaps)
    expect(snaps.length).toBeGreaterThan(0)
    expect(JSON.stringify(snaps)).not.toContain('secret-b-prompt')
    expect(JSON.stringify(snaps)).toContain('work in a') // its own prompt does arrive

    // Click: window B comes to the front with the permission tab selected.
    await strip.nth(0).click()
    await expect
      .poll(() =>
        pageB.getByRole('tab').evaluateAll((tabs) => tabs.map((t) => t.getAttribute('aria-selected')))
      )
      .toEqual(['true', 'false'])
    await expect
      .poll(() =>
        cockpit.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .filter((w) => w.isFocused())
            .map((w) => w.getTitle())
        )
      )
      .toEqual([nameB])
    expect(tabB1?.tabId).toBeTruthy()

    // The other direction: B's own strip lists A's tab only, and its click selects it in A.
    const stripB = pageB.locator('.top-strip .strip-entry')
    await expect(stripB).toHaveCount(1)
    await stripB.filter({ hasText: 'working' }).click()
    await expect
      .poll(() =>
        cockpit.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .filter((w) => w.isFocused())
            .map((w) => w.getTitle())
        )
      )
      .toEqual([basename(cockpit.projectDir)])
  } finally {
    rmSync(dirB, { recursive: true, force: true })
  }
})

test('a queued text shows as a chip on its tab and can be cancelled', async ({ cockpit }) => {
  await cockpit.newTab('claude')
  await expectStatus(cockpit, cockpit.projectDir, 0, 'idle')
  const [first] = await entries(cockpit, cockpit.projectDir)
  const tabId = first!.tabId

  // Idle is not sendable: the text waits in the queue.
  const sent = await cockpit.hook<{ id: string; delivered: boolean }>('send', tabId, 'queue me please')
  expect(sent.delivered).toBe(false)
  const chip = cockpit.page.locator('.queued-chip-button')
  await expect(chip).toHaveText('queued 1')

  await chip.click()
  await expect(cockpit.page.locator('.queued-item')).toHaveCount(1)
  await expect(cockpit.page.locator('.queued-text')).toHaveText('queue me please')

  await cockpit.page.getByRole('menuitem', { name: /Cancel queued text/ }).click()
  await expect(chip).toHaveCount(0)
  await expect.poll(async () => (await entries(cockpit, cockpit.projectDir))[0]?.queue).toEqual([])
  // Cancelled means never typed.
  await cockpit.typeLine('/stop')
  await expectStatus(cockpit, cockpit.projectDir, 0, 'waiting')
  expect(cockpit.pastes()).toEqual([])
})

test('the gear at the right end of the strip opens settings', async ({ cockpit }) => {
  const gear = cockpit.page.locator('.top-strip').getByRole('button', { name: 'Settings' })
  await expect(gear).toHaveAttribute('title', 'Settings')
  await gear.click()
  await expect(cockpit.page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
})

test('the bar leads with the project; on macOS it is the title bar (lights inset, drag region)', async ({ cockpit }) => {
  const { page, app, projectDir } = cockpit
  const bar = page.locator('.top-strip')
  await expect(bar.locator('.titlebar-project-name')).toHaveText('project')
  await expect(bar.locator('.titlebar-project')).toHaveAttribute('title', projectDir)
  // The window keeps the project's name as its title (Window menu, Mission Control) either way.
  const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle())
  expect(title).toBe('project')
  if (process.platform === 'darwin') {
    await expect(bar).toHaveClass(/title-bar/)
    await expect(bar).toHaveCSS('-webkit-app-region', 'drag')
    await expect(bar.getByRole('button', { name: 'Settings' })).toHaveCSS('-webkit-app-region', 'no-drag')
    // Room for the traffic lights before the project's name.
    await expect(bar).toHaveCSS('padding-left', '86px')
  } else {
    await expect(bar).not.toHaveClass(/title-bar/)
  }
})

test('full screen hides the traffic lights, so the bar collapses their gap until it is left', async ({ cockpit }) => {
  test.skip(process.platform !== 'darwin', 'only macOS has an in-page title bar with traffic lights')
  const { page, app } = cockpit
  const bar = page.locator('.top-strip')
  await expect(bar).toHaveCSS('padding-left', '86px')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setFullScreen(true))
  await expect(bar).toHaveClass(/full-screen/, { timeout: 15_000 })
  await expect(bar).toHaveCSS('padding-left', '12px')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setFullScreen(false))
  await expect(bar).not.toHaveClass(/full-screen/, { timeout: 15_000 })
  await expect(bar).toHaveCSS('padding-left', '86px')
})
