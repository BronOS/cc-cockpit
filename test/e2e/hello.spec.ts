// Task 34: the `hello` reference plugin, linked from plugins/hello (its built dist/host.js), driven
// through the real app. Design §7's scenarios: open a project, open a Claude tab, the status
// reaches the strip, the hello panel sends text, text is queued while the tab works and delivered
// on `/stop`, and an overlay opened by the plugin returns a result to its panel. The rest of the
// plugin's contribution points (badge schedule, exec, storage, command, theme) ride along.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FrameLocator } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { LayoutView } from '../../src/shared/ipc'
import { expect, test, type Cockpit } from './fixtures'

const HELLO = join(__dirname, '..', '..', 'plugins', 'hello')
const ID = 'example.hello'
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

// A string expression: the e2e tsconfig has no DOM lib, and the code runs in the page anyway.
const cssVar = (c: Cockpit, name: string): Promise<string> =>
  c.page.evaluate<string>(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`)

async function enableHello(c: Cockpit): Promise<void> {
  await c.hook('enablePlugin', c.projectDir, ID)
  await expect
    .poll(() => c.hook<HostStatus>('hostStatus', c.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: ID, state: 'active' }] })
}

/** Open the panel from its icon in the left strip and return its page. */
async function openPanel(c: Cockpit): Promise<FrameLocator> {
  const icon = c.page.locator('.zone-left').getByRole('button', { name: /^Hello/ })
  // The manifest's icon file, loaded from cc-plugin:// (the shell CSP allows it) and drawn as a mask.
  await expect(icon.locator('.panel-icon-img')).toHaveCSS('mask-image', `url("cc-plugin://${ID}/icons/hello.svg")`)
  await icon.click()
  await expect(c.page.locator('section.panel[aria-label="Hello"] iframe')).toHaveAttribute(
    'src',
    `cc-plugin://${ID}/panels/hello.html`
  )
  return c.page.frameLocator('section.panel[aria-label="Hello"] iframe')
}

const badge = async (c: Cockpit): Promise<unknown> =>
  (await c.hook<LayoutView>('layout', c.projectDir)).panels.find((p) => p.panelKey === `${ID}/hello`)?.badge

test('hello: panel, git status, badge ticks, command, overlays and theme', async ({ cockpit }) => {
  test.setTimeout(90_000)
  const { page } = cockpit
  // A repository with one untracked file for `git status --short`. No developer config: HOME alone
  // is not enough (git also reads $XDG_CONFIG_HOME/git/config, and GIT_CONFIG_GLOBAL wins over
  // both), so the global file is /dev/null, the system one is off and XDG_CONFIG_HOME is dropped.
  const gitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: cockpit.projectDir,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1'
  }
  delete gitEnv.XDG_CONFIG_HOME
  execFileSync('git', ['init', '-q'], { cwd: cockpit.projectDir, env: gitEnv })
  writeFileSync(join(cockpit.projectDir, 'untracked.txt'), 'x\n')

  await cockpit.hook('linkPlugin', HELLO)
  await enableHello(cockpit)

  const hello = await openPanel(cockpit)
  await expect(hello.locator('#greeting')).toHaveText('Hello')
  // ctx.storage: the first start of the plugin in this project.
  await expect(hello.locator('#visits')).toHaveText('1')
  // ctx.exec: argv-only `git status --short`.
  await expect(hello.locator('#git')).toHaveText('?? untracked.txt')

  // ctx.schedule + ctx.badge: the first tick comes one interval (10 s) after activation.
  // At least one: on a slow run the poll may only start after the second tick.
  await expect
    .poll(async () => ((await badge(cockpit)) as { count?: number } | null)?.count ?? 0, { timeout: 25_000 })
    .toBeGreaterThanOrEqual(1)
  await expect(hello.locator('#ticks')).toHaveText(/^[1-9]/)
  await hello.getByRole('button', { name: 'Reset badge' }).click()
  await expect(hello.locator('#ticks')).toHaveText('0')
  await expect.poll(() => badge(cockpit)).toBeFalsy()

  // The git view follows the folder on Refresh.
  writeFileSync(join(cockpit.projectDir, 'second.txt'), 'y\n')
  await hello.getByRole('button', { name: 'Refresh' }).click()
  await expect(hello.locator('#git')).toContainText('?? second.txt')

  // Overlay, html: the page answers with post({ result }) and the plugin shows it in the panel.
  await hello.getByRole('button', { name: 'HTML overlay' }).click()
  const picker = page.frameLocator('iframe[title="Pick a colour"]')
  await picker.getByRole('button', { name: 'Green' }).click()
  await expect(hello.locator('#overlay-result')).toHaveText('html overlay answered {"colour":"green"}')
  await expect(page.locator('iframe[title="Pick a colour"]')).toHaveCount(0)

  // Overlay, terminal: runs `git status` and waits for Enter; the exit code comes back.
  await hello.getByRole('button', { name: 'Terminal overlay' }).click()
  const overlay = page.locator('.overlay[data-kind="terminal"]')
  await expect(overlay.locator('.xterm-rows')).toContainText('Press Enter to close', { timeout: 15_000 })
  await overlay.locator('.xterm').click()
  await page.keyboard.press('Enter')
  await expect(hello.locator('#overlay-result')).toHaveText('terminal overlay exited with 0')
  await expect(overlay).toHaveCount(0)

  // Command with a key: notifies with the greeting.
  await page.keyboard.press(`${MOD}+Shift+H`)
  await expect.poll(() => cockpit.hook<string[]>('notifications')).toContain(`Hello from ${ID}`)

  // Theme contribution: it is in the picker and reaches the page.
  await page.keyboard.press(`${MOD}+,`)
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Appearance', exact: true }).click()
  await settings.getByLabel('Theme', { exact: true }).selectOption({ label: 'Hello Dusk (dark)' })
  await expect.poll(() => cssVar(cockpit, '--cc-bg')).toBe('#1b1a2e')
  // ...and the panel follows (the SDK applies the theme variables to the page's :root).
  await expect(hello.locator('body')).toHaveCSS('background-color', 'rgb(27, 26, 46)')
})

test('hello: send text to a Claude tab; queued while it works, dropped when the person types', async ({ cockpit }) => {
  test.setTimeout(60_000)
  const { page } = cockpit
  await cockpit.hook('linkPlugin', HELLO)
  await enableHello(cockpit)
  const hello = await openPanel(cockpit)
  await expect(hello.locator('#send')).toBeDisabled()

  await cockpit.newTab('claude')
  // The status reaches the strip...
  await expect(page.getByRole('tab').first()).toBeVisible()
  // Busy without a keystroke (a typed key would take the tab over, SessionInfo.typed): a core text
  // through the test hook goes in as a paste and the fake submits it.
  await expect.poll(async () => (await cockpit.hook<Array<{ status: string }>>('sessions', cockpit.projectDir))[0]?.status, { timeout: 15_000 }).toBe('waiting')
  const tabId = (await cockpit.hook<Array<{ tabId: string }>>('sessions', cockpit.projectDir))[0]!.tabId
  await cockpit.hook('send', tabId, 'first task')
  await expect(page.locator('.tab .status-dot[data-status="working"]')).toBeVisible({ timeout: 15_000 })
  // ...and the panel's session list.
  const option = hello.locator('#sessions option')
  await expect(option).toHaveCount(1)
  await expect(option).toHaveText('working: first task')

  // Working: the text is queued, nothing more is typed.
  await hello.locator('#text').fill('do the thing')
  await hello.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(hello.locator('#send-result')).toHaveText('queued')
  expect(cockpit.pastes()).toEqual(['\x1b[200~first task\x1b[201~'])

  // The person types: the plugin's queued text is dropped and never delivered at the Stop.
  await cockpit.typeLine('/stop')
  await expect(option).toHaveText(/^waiting:/)
  await cockpit.page.waitForTimeout(500)
  expect(cockpit.pastes()).toEqual(['\x1b[200~first task\x1b[201~'])

  // ...and a send to the taken-over tab is refused with the reason.
  await hello.locator('#text').fill('second')
  await hello.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(hello.locator('#send-result')).toHaveText('refused: the person is typing in this tab')
})

test('hello: a secret setting shows only as set / not set, and ctx.secrets keeps a counter', async ({ cockpit }) => {
  test.setTimeout(60_000)
  const { page } = cockpit
  const TOKEN = 'e2e-hello-token-0123456789'
  await cockpit.hook('linkPlugin', HELLO)
  await enableHello(cockpit)
  const hello = await openPanel(cockpit)

  // Nothing yet: no token, no counter, no keys.
  await expect(hello.locator('#token-state')).toHaveText('not set')
  await expect(hello.locator('#bumps')).toHaveText('not set')
  await expect(hello.locator('#secret-keys')).toHaveText('(none)')

  // ctx.secrets: set, get and keys (the host re-reads after every change).
  await hello.getByRole('button', { name: 'Bump' }).click()
  await expect(hello.locator('#bumps')).toHaveText('1')
  await hello.getByRole('button', { name: 'Bump' }).click()
  await expect(hello.locator('#bumps')).toHaveText('2')
  await expect(hello.locator('#secret-keys')).toHaveText('bumps')
  await expect(hello.locator('#secret-error')).toHaveText('')

  // The secret setting, through the same form a user gets: Settings > Plugins > Hello.
  // The gear in the strip, not Cmd+,: keystrokes in the panel's iframe never reach the shell page.
  await page.locator('.top-strip').getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Plugins' }).click()
  const plugin = settings.locator(`[data-plugin="${ID}"]`)
  await plugin.getByRole('button', { name: 'Settings' }).click()
  await expect(plugin.locator('[data-secret-state]')).toHaveText('Not set')
  await plugin.getByRole('button', { name: 'Add API token' }).click()
  await plugin.locator('input[type="password"]').fill(TOKEN)
  await plugin.getByRole('button', { name: 'Save settings' }).click()
  await expect(plugin.getByRole('status')).toHaveText('Saved.')

  // The plugin host heard of the change; the panel only learns that the token is set.
  await expect(hello.locator('#token-state')).toHaveText('set')
  expect(await hello.locator('body').innerHTML()).not.toContain(TOKEN)
  // Rendered HTML only; the posted state itself is checked by the unit test in hello-dist.test.ts.
  // The value is in the encrypted store, not in the settings file or the page.
  expect(readFileSync(join(cockpit.dataDir, 'app.json'), 'utf8')).not.toContain(TOKEN)
  expect(readFileSync(join(cockpit.dataDir, 'secrets.json'), 'utf8')).not.toContain(TOKEN)
  expect(await page.content()).not.toContain(TOKEN)
  // The setting's own `setting:app:apiToken` key is hidden from keys().
  await expect(hello.locator('#secret-keys')).toHaveText('bumps')

  // Clear it again: the panel goes back to "not set".
  await plugin.getByRole('button', { name: 'Clear API token' }).click()
  await plugin.getByRole('button', { name: 'Save settings' }).click()
  await expect(plugin.getByRole('status')).toHaveText('Saved.')
  await expect(hello.locator('#token-state')).toHaveText('not set')

  // Forget the counter: delete, and the list of keys follows.
  await page.keyboard.press(`${MOD}+Shift+W`)
  await expect(settings).toBeHidden()
  await hello.getByRole('button', { name: 'Forget counter' }).click()
  await expect(hello.locator('#bumps')).toHaveText('not set')
  await expect(hello.locator('#secret-keys')).toHaveText('(none)')
})
