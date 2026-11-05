// Task 15: a plugin's html settings page (design-next §5.4), with hello's sample page
// (plugins/hello/settings/index.html). Not enabled in the project, the page says so and the app
// form still shows; enabled, the page loads in a sandboxed iframe under the form on both pages
// (Plugins = app scope, This project = project scope) and talks to hello's backend
// (ctx.settingsPage.onOpen), which keeps a note per scope (ctx.appStorage / ctx.storage).
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expect, test } from './fixtures'

const HELLO = join(__dirname, '..', '..', 'plugins', 'hello')
const ID = 'example.hello'

test('settings page: not-enabled note, then a message round trip per scope', async ({ cockpit }) => {
  test.setTimeout(60_000)
  const { page } = cockpit
  const settings = page.getByRole('dialog', { name: 'Settings' })
  const nav = (name: string): Promise<void> => settings.getByRole('navigation').getByRole('button', { name, exact: true }).click()
  /** Unfold a plugin row's settings (its Settings button toggles; a page change folds it again). */
  const unfold = async (row: ReturnType<typeof settings.locator>): Promise<void> => {
    const button = row.getByRole('button', { name: 'Settings', exact: true })
    if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
  }
  await cockpit.hook('linkPlugin', HELLO)

  await page.keyboard.press('ControlOrMeta+,')
  await expect(settings).toBeVisible()

  // Plugins, not enabled here: the app form works, the page is not loaded and says why.
  await nav('Plugins')
  const appRow = settings.locator(`li[data-plugin="${ID}"]`)
  await unfold(appRow)
  await expect(appRow.getByLabel('Shout the greeting')).toBeVisible()
  await expect(appRow.getByTestId('settings-page-not-enabled')).toHaveText('Enable Hello in this project to edit this page.')
  await expect(appRow.locator('iframe')).toHaveCount(0)

  // This project: the row offers Settings for the page alone (no form while off), with the same note.
  await nav('This project')
  const projectRow = settings.locator(`li[data-plugin="${ID}"]`)
  await unfold(projectRow)
  await expect(projectRow.getByTestId('settings-page-not-enabled')).toBeVisible()

  // Enable it: once the host runs it, the page loads (panels.reload) under the project form.
  await settings.getByLabel('Enable Hello').click()
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 20_000 })
    .toMatchObject({ running: true, plugins: [{ id: ID, state: 'active' }] })
  await unfold(projectRow)
  const projectFrame = projectRow.locator(`[data-settings-page="${ID}"][data-settings-scope="project"] iframe`)
  await expect(projectFrame).toHaveAttribute('src', `cc-plugin://${ID}/settings/index.html`, { timeout: 20_000 })
  await expect(projectFrame).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(projectRow.getByLabel('Greeting')).toBeVisible()
  const project = projectRow.frameLocator('iframe')
  await expect(project.locator('#scope')).toHaveText('project', { timeout: 15_000 })
  await expect(project.getByLabel('Note')).toHaveValue('')
  await project.getByLabel('Note').fill('for this project')
  await project.getByRole('button', { name: 'Save note' }).click()
  await expect(project.locator('#status')).toHaveText('Saved')

  // Plugins: the app-scope page of the same plugin, with its own (app-wide) note. Leaving This
  // project unmounted the project page (one page per plugin at a time).
  await nav('Plugins')
  await unfold(appRow)
  await expect(appRow.getByTestId('settings-page-not-enabled')).toHaveCount(0)
  const app = appRow.frameLocator(`[data-settings-page="${ID}"][data-settings-scope="app"] iframe`)
  await expect(app.locator('#scope')).toHaveText('app', { timeout: 15_000 })
  await expect(app.getByLabel('Note')).toHaveValue('')
  await app.getByLabel('Note').fill('for every project')
  await app.getByRole('button', { name: 'Save note' }).click()
  await expect(app.locator('#status')).toHaveText('Saved')

  // Back on This project: the backend answers the project's note again (a new page, a new port).
  await nav('This project')
  await unfold(projectRow)
  const again = projectRow.frameLocator('iframe')
  await expect(again.locator('#scope')).toHaveText('project', { timeout: 15_000 })
  await expect(again.getByLabel('Note')).toHaveValue('for this project')
})
