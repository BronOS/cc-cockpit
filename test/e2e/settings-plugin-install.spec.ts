// Settings › Plugins with a git source, end to end: install from a repository URL at a tag, update
// to a newer tag pushed later, uninstall. The installer's unit tests (installer.test.ts) cover the
// clone, validation and folder moves; this covers the PluginsPage wiring and main's real `git`.
//
// The remote is a bare repository in a temp dir, reached as file:///abs/path: one of the three URL
// forms the installer accepts (gitUrlProblem; cloneArgs opens protocol.file only for such a URL),
// so nothing leaves the machine. Its content is test/fixtures/plugins/good, committed as v1.0.0 and
// then, with the manifest's version bumped (update refuses a tag at the installed version), v1.1.0.
//
// No developer git config is read, neither by this file's git nor by the app's clone (which runs
// with the app's env): GIT_CONFIG_GLOBAL=/dev/null and GIT_CONFIG_NOSYSTEM=1 everywhere, and
// XDG_CONFIG_HOME dropped here and pointed at an empty folder for the app (a user's
// `url.<base>.insteadOf` or hooksPath must not change what the clone does).
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as base } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expect, launchCockpit, type Cockpit } from './fixtures'

const FIXTURE = join(__dirname, '..', 'fixtures', 'plugins', 'good')
const PLUGIN_ID = 'test.good'

const GIT_ENV: Record<string, string | undefined> = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1'
}
delete GIT_ENV.XDG_CONFIG_HOME

/** git in `cwd` with a fixed identity and no signing (there is no user config to supply them). */
function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c', 'user.name=Test',
      '-c', 'user.email=test@example.com',
      '-c', 'commit.gpgsign=false',
      '-c', 'tag.gpgsign=false',
      '-c', 'init.defaultBranch=main',
      ...args
    ],
    { cwd, env: GIT_ENV, stdio: 'pipe' }
  )
}

interface Repo {
  /** file:///… of the bare repository the app clones from. */
  url: string
  /** Commit the fixture as the whole tree with `version` in its manifest, tag it, push both. */
  publish(tag: string, version: string): void
}

const test = base.extend<{ repo: Repo; cockpit: Cockpit }>({
  // eslint-disable-next-line no-empty-pattern
  repo: async ({}, use) => {
    // Real path: the URL is stored and shown verbatim, and /var is a symlink on macOS.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-e2e-repo-')))
    const bare = join(root, 'good.git')
    const work = join(root, 'work')
    mkdirSync(bare)
    mkdirSync(work)
    try {
      git(bare, 'init', '-q', '--bare')
      git(work, 'init', '-q')
      git(work, 'remote', 'add', 'origin', bare)
      await use({
        url: `file://${bare}`,
        publish: (tag, version) => {
          for (const name of readdirSync(work)) if (name !== '.git') rmSync(join(work, name), { recursive: true, force: true })
          cpSync(FIXTURE, work, { recursive: true })
          const manifest = JSON.parse(readFileSync(join(work, 'plugin.json'), 'utf8')) as Record<string, unknown>
          writeFileSync(join(work, 'plugin.json'), JSON.stringify({ ...manifest, version }, null, 2))
          git(work, 'add', '-A')
          git(work, 'commit', '-q', '-m', tag)
          git(work, 'tag', tag)
          git(work, 'push', '-q', 'origin', 'main', tag)
        }
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  // eslint-disable-next-line no-empty-pattern
  cockpit: async ({}, use) => {
    const xdg = mkdtempSync(join(tmpdir(), 'ccc-e2e-xdg-'))
    const { cockpit, close } = await launchCockpit({
      env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: xdg }
    })
    try {
      await use(cockpit)
    } finally {
      await close()
      rmSync(xdg, { recursive: true, force: true })
    }
  }
})

test('settings: install a plugin from a git URL, update it to a new tag, uninstall it, reinstall it', async ({ cockpit, repo }) => {
  const { page } = cockpit
  repo.publish('v1.0.0', '1.0.0')

  const installDir = (version: string): string => join(cockpit.dataDir, 'plugins', `${PLUGIN_ID}@${version}`)
  const indexText = (): string => {
    try {
      return readFileSync(join(cockpit.dataDir, 'plugins.json'), 'utf8')
    } catch {
      return '' // not written yet
    }
  }

  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.keyboard.press('ControlOrMeta+,')
  await expect(settings).toBeVisible()
  await settings.getByRole('button', { name: 'Plugins' }).click()
  await expect(settings.getByText('No plugins installed.')).toBeVisible()

  // --- Install at v1.0.0, from "Add plugin…". ---
  await settings.getByRole('button', { name: 'Add plugin…' }).click()
  const form = settings.getByRole('form', { name: 'Install a plugin' })
  const install = form.getByRole('button', { name: 'Install' })
  await form.getByLabel('Git URL').fill(repo.url)
  // Both fields are required before the button does anything.
  await expect(install).toBeDisabled()
  await form.getByLabel('Tag').fill('v1.0.0')
  await install.click()
  const plugin = settings.locator(`[data-plugin="${PLUGIN_ID}"]`)
  await expect(plugin).toContainText('Good')
  await expect(plugin).toContainText(`${PLUGIN_ID} · 1.0.0`)
  await expect(plugin).toContainText(`git ${repo.url} @ v1.0.0`)
  await expect(plugin.locator('.settings-badge')).toHaveCount(0) // not disabled
  // A successful install empties the form.
  await expect(form.getByLabel('Git URL')).toHaveValue('')
  await expect(form.getByLabel('Tag')).toHaveValue('')
  expect(existsSync(join(installDir('1.0.0'), 'plugin.json'))).toBe(true)
  await expect.poll(indexText, { timeout: 5_000 }).toContain(repo.url)
  // Enabled in the open project: its host runs it (the reinstall below relies on this choice).
  const hostStatus = (): Promise<HostStatus | undefined> => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir)
  await cockpit.hook('enablePlugin', cockpit.projectDir, PLUGIN_ID)
  await expect.poll(async () => (await hostStatus())?.plugins, { timeout: 15_000 }).toEqual([{ id: PLUGIN_ID, state: 'active' }])

  // The row points at where a plugin is enabled (per project): This project, with its switch on.
  await plugin.getByRole('button', { name: 'Enable in This Project' }).click()
  const projectPage = settings.getByRole('region', { name: 'This Project' })
  await expect(projectPage).toBeVisible()
  await expect(projectPage.getByRole('checkbox', { name: /^Enable / })).toBeChecked()
  await settings.getByRole('button', { name: 'Plugins' }).click()
  // A new visit starts with "Add plugin…" folded.
  await settings.getByRole('button', { name: 'Add plugin…' }).click()

  // Installing the same id again is refused with the reason (and the form keeps what was typed).
  await form.getByLabel('Git URL').fill(repo.url)
  await form.getByLabel('Tag').fill('v1.0.0')
  await install.click()
  await expect(settings.getByRole('alert')).toContainText('already installed (version 1.0.0); update it instead')
  await expect(form.getByLabel('Tag')).toHaveValue('v1.0.0')
  await expect(settings.locator('[data-plugin]')).toHaveCount(1)
  await form.getByLabel('Git URL').fill('')
  await form.getByLabel('Tag').fill('')

  // --- Update: a newer commit is pushed and tagged, then the row's Update takes the tag. ---
  repo.publish('v1.1.0', '1.1.0')
  const update = plugin.getByRole('form', { name: `Update ${PLUGIN_ID}` })
  await expect(update.getByRole('button', { name: 'Update' })).toBeDisabled()
  await update.getByLabel(`New tag for ${PLUGIN_ID}`).fill('v1.1.0')
  await update.getByRole('button', { name: 'Update' }).click()
  await expect(plugin).toContainText(`${PLUGIN_ID} · 1.1.0`)
  await expect(plugin).toContainText(`git ${repo.url} @ v1.1.0`)
  await expect(update.getByLabel(`New tag for ${PLUGIN_ID}`)).toHaveValue('')
  await expect(settings.getByRole('alert')).toHaveCount(0)
  // The new version sits in its own folder; the old one goes once the hosts have reloaded.
  expect(existsSync(join(installDir('1.1.0'), 'plugin.json'))).toBe(true)
  await expect.poll(() => existsSync(installDir('1.0.0')), { timeout: 10_000 }).toBe(false)
  await expect.poll(indexText, { timeout: 5_000 }).toContain('v1.1.0')

  // --- Uninstall: confirm, the row and the folder go, plugins.json forgets it. ---
  await plugin.getByRole('button', { name: 'Uninstall' }).click()
  await plugin.getByRole('button', { name: 'Yes, uninstall' }).click()
  await expect(plugin).toHaveCount(0)
  await expect(settings.getByText('No plugins installed.')).toBeVisible()
  await expect.poll(() => existsSync(installDir('1.1.0')), { timeout: 10_000 }).toBe(false)
  await expect.poll(indexText, { timeout: 5_000 }).not.toContain(PLUGIN_ID)
  // Nothing left behind in plugins/ (no staging folder, no orphan).
  expect(readdirSync(join(cockpit.dataDir, 'plugins'))).toEqual([])
  // The host dropped it, though the project's enabled list keeps it.
  await expect.poll(async () => (await hostStatus())?.plugins, { timeout: 15_000 }).toEqual([])

  // --- Reinstall: the project still has it enabled, so its open host starts it again at once,
  // without a toggle or a window reopen. ---
  await form.getByLabel('Git URL').fill(repo.url)
  await form.getByLabel('Tag').fill('v1.1.0')
  await install.click()
  await expect(plugin).toContainText(`${PLUGIN_ID} · 1.1.0`)
  await expect.poll(async () => (await hostStatus())?.plugins, { timeout: 15_000 }).toEqual([{ id: PLUGIN_ID, state: 'active' }])
})
