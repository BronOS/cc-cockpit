// Task 16: Claude status in the UI. Tab dots, the top strip across windows and the queued chip, all
// driven by the fake `claude`'s scripted hook lines. The strip of the other windows' tabs is the
// bundled cockpit.sessions plugin's (design-next §4): its `sessions-strip` slot page in the top bar,
// fed by ctx.sessions scope 'all', so that test runs with the bundled plugins on.
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'

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

/** The harness with the bundled plugins on (it turns them off by default): cockpit.sessions draws the strip. */
const withSessions = test.extend<{ cockpit: Cockpit }>({
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

/** A window's `sessions-strip` slot page (the cockpit.sessions strip in its top bar). */
const stripOf = (page: Page) => page.frameLocator('.top-strip iframe[title="sessions-strip slot"]').locator('.entry')

withSessions('a tab needing permission in window B leads window A’s strip, and a click focuses B on that tab', async ({
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
    await expectStatus(cockpit, cockpit.projectDir, 0, 'waiting')
    await cockpit.typeLine('/prompt work in a')
    await expectStatus(cockpit, cockpit.projectDir, 0, 'working')

    await newClaudeTab(pageB)
    await expectStatus(cockpit, dirB, 0, 'waiting')
    await typeIn(pageB, '/prompt secret-b-prompt')
    await expectStatus(cockpit, dirB, 0, 'working')
    await typeIn(pageB, '/permission')
    await expectStatus(cockpit, dirB, 0, 'needs-permission')
    const [tabB1] = await entries(cockpit, dirB)

    await newClaudeTab(pageB)
    await expectStatus(cockpit, dirB, 1, 'waiting')
    // The new tab is the selected one in B.
    await expect(pageB.getByRole('tab', { selected: true })).toContainText('Claude')
    const selectedBefore = await pageB.getByRole('tab').evaluateAll((tabs) =>
      tabs.map((t) => t.getAttribute('aria-selected'))
    )
    expect(selectedBefore).toEqual(['false', 'true'])

    // Window A's strip lists only the OTHER window's tabs (its own working tab is in its tab bar
    // and Sessions panel): B's permission tab first, then B's new tab, waiting for input.
    await expect(pageA.locator('.top-strip [data-slot-frame][data-slot-plugin="cockpit.sessions"]')).toHaveCount(1, { timeout: 15_000 })
    const strip = stripOf(pageA)
    await expect(strip).toHaveCount(2, { timeout: 15_000 })
    await expect(strip.nth(0)).toHaveAttribute('data-status', 'needs-permission')
    await expect(strip.nth(0)).toContainText(`${nameB} · needs permission`)
    await expect(strip.nth(1)).toHaveAttribute('data-status', 'waiting')
    await expect(strip.filter({ hasText: 'working' })).toHaveCount(0)
    // The strip reports its entries' width (ccPanel.slot.setWidth) and the frame takes it, so the
    // rest of the bar is left to drag the window on macOS (rounded up; the bar may cap it lower).
    const stripFrame = pageA.locator('.top-strip [data-slot-frame][data-slot-plugin="cockpit.sessions"]')
    const rowWidth = await pageA
      .frameLocator('.top-strip iframe[title="sessions-strip slot"]')
      .locator('#row')
      .evaluate((el) => Math.ceil(el.getBoundingClientRect().width))
    expect(rowWidth).toBeGreaterThan(0)
    await expect(stripFrame).toHaveAttribute('data-page-width', String(rowWidth))
    expect((await stripFrame.boundingBox())!.width).toBeLessThanOrEqual(rowWidth + 1)
    // The status dot of A's own tab.
    await expect(pageA.locator('.tab .status-dot')).toHaveAttribute('data-status', 'working')

    // B's prompt was never sent to window A, nor drawn in its strip.
    const snaps = await pageA.evaluate(() => (globalThis as unknown as { __snaps: unknown[] }).__snaps)
    expect(snaps.length).toBeGreaterThan(0)
    expect(JSON.stringify(snaps)).not.toContain('secret-b-prompt')
    expect(JSON.stringify(snaps)).toContain('work in a') // its own prompt does arrive
    expect(JSON.stringify(snaps)).not.toContain(tabB1!.tabId) // other windows' tabs are not in the window's snapshot
    await expect(pageA.frameLocator('.top-strip iframe[title="sessions-strip slot"]').locator('body')).not.toContainText('secret-b-prompt')

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
    const stripB = stripOf(pageB)
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

/** `<data>/bin/ccc` as a user's terminal runs it (no tab token), the same way cli.spec.ts does. */
function ccc(c: Cockpit, args: string[]): Promise<{ status: number | null; out: string; err: string }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('CC_COCKPIT_') || k.startsWith('APP_TAB_') || k.startsWith('ELECTRON_')) continue
    env[k] = v
  }
  env.HOME = c.dataDir
  return new Promise((resolve, reject) => {
    const child = spawn(join(c.dataDir, 'bin', 'ccc'), args, { env })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`ccc ${args.join(' ')} did not finish; out=${out} err=${err}`))
    }, 20_000)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, out, err })
    })
  })
}

withSessions('with cockpit.sessions off there is no strip and no Sessions panel; tabs, dots, ccc sessions and notify still work', async ({
  cockpit
}) => {
  const { page, projectDir } = cockpit
  // On by default: its panel icon and its strip frame are there.
  const icon = page.getByRole('button', { name: /^Sessions/ })
  await expect(icon).toHaveCount(1, { timeout: 15_000 })
  // Two frames: the sessions strip and bundled cockpit.usage's usage-meter.
  await expect(page.locator('.top-strip [data-slot-frame]')).toHaveCount(2)

  // Off app-wide (Settings › Plugins, a bundled plugin's switch): the host restarts without it.
  await page.evaluate<void>("window.cockpit.invoke('settings.pluginBundledOff', { id: 'cockpit.sessions', off: true })")
  await expect(icon).toHaveCount(0, { timeout: 15_000 })
  // Only the sessions strip goes; cockpit.usage's meter stays.
  await expect(page.locator('.top-strip [data-slot-frame][data-slot-plugin="cockpit.sessions"]')).toHaveCount(0)
  await expect(page.locator('.top-strip [data-slot-frame]')).toHaveCount(1)
  await expect(page.locator('section.panel[aria-label="Sessions"]')).toHaveCount(0)
  // The bar is the project, the "+" and the gear.
  await expect(page.locator('.top-strip .strip-open-project')).toBeVisible()
  await expect(page.locator('.top-strip').getByRole('button', { name: 'Settings' })).toBeVisible()

  // A Claude tab works as before: its dot follows the hooks, the registry and the CLI list it.
  await cockpit.newTab('claude')
  await expectStatus(cockpit, projectDir, 0, 'waiting')
  await cockpit.typeLine('/prompt work without the plugin')
  await expectStatus(cockpit, projectDir, 0, 'working')
  await expect(page.locator('.tab .status-dot')).toHaveAttribute('data-status', 'working')
  const listed = await ccc(cockpit, ['sessions', '--json'])
  expect(listed).toMatchObject({ status: 0, err: '' })
  expect(JSON.parse(listed.out)).toMatchObject([{ projectPath: projectDir, status: 'working' }])
  // Notifications go out as ever.
  expect(await ccc(cockpit, ['notify', 'still', 'here'])).toEqual({ status: 0, out: '', err: '' })
  await expect.poll(() => cockpit.hook<string[]>('notifications')).toContain('still here')
})

test('a queued text shows as a chip on its tab and can be cancelled', async ({ cockpit }) => {
  await cockpit.newTab('claude')
  await expectStatus(cockpit, cockpit.projectDir, 0, 'waiting')
  await cockpit.typeLine('/prompt busy')
  await expectStatus(cockpit, cockpit.projectDir, 0, 'working')
  const [first] = await entries(cockpit, cockpit.projectDir)
  const tabId = first!.tabId

  // Working is not sendable: the text waits in the queue.
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
