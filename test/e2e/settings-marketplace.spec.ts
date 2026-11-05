// Settings › Plugins with the marketplace merged in (design-next §6.3), end to end against a local index: a file:/// index.json and a bare repo, so
// nothing leaves the machine (the official default index is an authority, but main never fetches it
// in a test run: testFetcher in main/index.ts). The unit tests
// (marketplace-*.test.ts, settings-marketplace.test.ts)
// cover validation, status and the pin; this covers the page, the confirmation and main's real git.
//
// The index is rewritten between steps and fetched again with the page's Refresh button, which is
// also how a user would see a new version, a revocation, or a moved tag.
//
// Same git isolation as settings-plugin-install.spec.ts: no developer git config is read, neither
// by this file's git nor by the app's clone.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test as base } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { DEFAULT_MARKETPLACE_URL } from '../../src/shared/marketplace'
import { expect, launchCockpit, type Cockpit } from './fixtures'

const FIXTURE = join(__dirname, '..', 'fixtures', 'plugins', 'good')
const PLUGIN_ID = 'test.good'
const GIT_ENV: Record<string, string | undefined> = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
delete GIT_ENV.XDG_CONFIG_HOME

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
    { cwd, env: GIT_ENV, stdio: 'pipe', encoding: 'utf8' }
  ).trim()
}

interface Release {
  version: string
  tag: string
  commit: string
}

interface Market {
  repoUrl: string
  indexUrl: string
  /** Commit the fixture as `version`, tag it `v<version>`, push. */
  publish(version: string): Release
  /** Write index.json: one listing (or none) and the revocations. */
  list(release: Release | null, revoked?: { release: Release; reason: string }[], overrides?: Record<string, unknown>): void
  /** Write index.json as given. */
  raw(index: unknown): void
  /** A second bare repo holding the same tags, as the URL a listing can name. */
  mirror(): string
}

const test = base.extend<{ market: Market; cockpit: Cockpit; withBroken: boolean; noOverride: boolean }>({
  // A second configured index whose file does not exist (an unreachable one).
  withBroken: [false, { option: true }],
  // The app's real list (`app.json` › `marketplaces`, else the default index) instead of the test
  // override. Still no network: a test run never fetches the default index (testFetcher).
  noOverride: [false, { option: true }],
  // eslint-disable-next-line no-empty-pattern
  market: async ({}, use) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-e2e-market-')))
    const bare = join(root, 'good.git')
    const work = join(root, 'work')
    const indexFile = join(root, 'index.json')
    mkdirSync(bare)
    mkdirSync(work)
    try {
      git(bare, 'init', '-q', '--bare')
      git(work, 'init', '-q')
      git(work, 'remote', 'add', 'origin', bare)
      const repoUrl = pathToFileURL(bare).href
      await use({
        repoUrl,
        indexUrl: pathToFileURL(indexFile).href,
        publish: (version) => {
          for (const name of readdirSync(work)) if (name !== '.git') rmSync(join(work, name), { recursive: true, force: true })
          cpSync(FIXTURE, work, { recursive: true })
          const manifest = JSON.parse(readFileSync(join(work, 'plugin.json'), 'utf8')) as Record<string, unknown>
          writeFileSync(join(work, 'plugin.json'), JSON.stringify({ ...manifest, version }, null, 2))
          git(work, 'add', '-A')
          git(work, 'commit', '-q', '-m', version)
          git(work, 'tag', `v${version}`)
          git(work, 'push', '-q', 'origin', 'main', `v${version}`)
          return { version, tag: `v${version}`, commit: git(work, 'rev-parse', 'HEAD') }
        },
        raw: (index) => writeFileSync(indexFile, JSON.stringify(index)),
        mirror: () => {
          git(root, 'clone', '-q', '--bare', bare, 'mirror.git')
          return pathToFileURL(join(root, 'mirror.git')).href
        },
        list: (release, revoked = [], overrides = {}) => {
          const plugins = release
            ? [
                {
                  id: PLUGIN_ID,
                  name: 'Good plugin',
                  description: 'A <b>fixture</b> plugin',
                  author: 'Test Author',
                  repo: repoUrl,
                  version: release.version,
                  tag: release.tag,
                  commit: release.commit,
                  api: 1,
                  ...overrides
                }
              ]
            : []
          writeFileSync(
            indexFile,
            JSON.stringify({ schema: 1, plugins, revoked: revoked.map((r) => ({ id: PLUGIN_ID, commit: r.release.commit, reason: r.reason })) })
          )
        }
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  cockpit: async ({ market, withBroken, noOverride }, use) => {
    const xdg = mkdtempSync(join(tmpdir(), 'ccc-e2e-xdg-'))
    // The index must exist before the app starts: its startup fetch is the first one.
    market.list(null)
    const { cockpit, close } = await launchCockpit({
      env: {
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        XDG_CONFIG_HOME: xdg,
        CC_COCKPIT_MARKETPLACE_URLS: noOverride ? undefined : withBroken ? `${market.indexUrl},${brokenUrl(market)}` : market.indexUrl
      }
    })
    try {
      await use(cockpit)
    } finally {
      await close()
      rmSync(xdg, { recursive: true, force: true })
    }
  }
})

/** An index URL with nothing behind it, next to the real index file. */
const brokenUrl = (m: Market): string => new URL('no-such-index.json', m.indexUrl).href

const installedFolders = (c: Cockpit): string[] => {
  try {
    return readdirSync(join(c.dataDir, 'plugins'))
  } catch {
    return []
  }
}

test('marketplace: a pin mismatch is refused, Cancel installs nothing, then install and enable', async ({ cockpit, market }) => {
  const { page } = cockpit
  const v1 = market.publish('1.0.0')
  // The index pins a commit the tag is not at (a moved tag): the refusal names both sides.
  market.list(v1, [], { commit: 'a'.repeat(40) })

  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.keyboard.press('ControlOrMeta+,')
  await settings.getByRole('button', { name: 'Plugins' }).click()
  // The index was written after the app's startup fetch: fetch it again.
  await settings.getByRole('button', { name: 'Refresh' }).click()
  const entry = settings.locator(`[data-plugin="${PLUGIN_ID}"]`)
  await expect(entry).toContainText('Good plugin')
  // Index text is shown as text, never as HTML.
  await expect(entry).toContainText('A <b>fixture</b> plugin')
  await expect(entry.locator('b')).toHaveCount(0)
  await expect(entry).toContainText('by Test Author')
  await expect(entry).toContainText(market.indexUrl)

  // The filter narrows the list.
  await settings.getByLabel('Search plugins').fill('no such plugin')
  await expect(entry).toHaveCount(0)
  await expect(settings.getByText('No plugin matches the filter.')).toBeVisible()
  await settings.getByLabel('Search plugins').fill('good')
  await expect(entry).toHaveCount(1)

  // --- The confirmation says what the plugin is and what listed means; Cancel is focused. ---
  await entry.getByRole('button', { name: 'Install' }).click()
  const confirm = entry.getByRole('group', { name: `Confirm install of ${PLUGIN_ID}` })
  await expect(confirm).toContainText('full access to this computer')
  await expect(confirm).toContainText('does not mean anyone reviewed the code for safety')
  await expect(confirm).toContainText('Test Author')
  await expect(confirm).toContainText(market.repoUrl)
  await expect(confirm).toContainText(v1.tag)
  await expect(confirm).toContainText('a'.repeat(40))
  await expect(confirm).toContainText(market.indexUrl)
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()

  // --- Enter on the open prompt presses Cancel (the default): nothing is installed, focus returns to the row. ---
  await page.keyboard.press('Enter')
  await expect(confirm).toHaveCount(0)
  await expect(entry.getByRole('button', { name: 'Install' })).toBeFocused()
  expect(installedFolders(cockpit)).toEqual([])

  // --- Esc dismisses the prompt only; Settings stays open. ---
  await entry.getByRole('button', { name: 'Install' }).click()
  await expect(confirm).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(confirm).toHaveCount(0)
  await expect(settings).toBeVisible()
  expect(installedFolders(cockpit)).toEqual([])

  // --- Cancel: nothing happens. ---
  await entry.getByRole('button', { name: 'Install' }).click()
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toHaveCount(0)
  expect(installedFolders(cockpit)).toEqual([])

  // --- Confirm with the wrong pin: refused, nothing reaches the plugins folder. ---
  await entry.getByRole('button', { name: 'Install' }).click()
  await confirm.getByRole('button', { name: 'Yes, install' }).click()
  await expect(settings.getByRole('alert')).toContainText(`the tag is at commit ${v1.commit}, but the marketplace index pins ${'a'.repeat(40)}`)
  expect(installedFolders(cockpit)).toEqual([])

  // --- The index is fixed and fetched again: install, then enable in the project. ---
  market.list(v1)
  await settings.getByRole('button', { name: 'Refresh' }).click()
  await entry.getByRole('button', { name: 'Install' }).click()
  await confirm.getByRole('button', { name: 'Yes, install' }).click()
  // The listing became the installed plugin's card: its own buttons now, and no install prompt.
  await expect(entry.getByRole('button', { name: 'Uninstall' })).toBeVisible()
  await expect(entry.getByTestId('marketplace-done')).toBeVisible()
  await expect(settings.getByRole('alert')).toHaveCount(0)
  expect(existsSync(join(cockpit.dataDir, 'plugins', `${PLUGIN_ID}@1.0.0`, 'plugin.json'))).toBe(true)
  const stored = JSON.parse(readFileSync(join(cockpit.dataDir, 'plugins.json'), 'utf8')) as {
    plugins: { id: string; commit?: string; marketplace?: string }[]
  }
  expect(stored.plugins.find((p) => p.id === PLUGIN_ID)).toMatchObject({ commit: v1.commit, marketplace: market.indexUrl })
  // On disk already, through the real wiring: the debounced write it used to be could still be waiting.
  const appJson = JSON.parse(readFileSync(join(cockpit.dataDir, 'app.json'), 'utf8')) as { pluginRepos?: Record<string, string> }
  expect(appJson.pluginRepos?.[PLUGIN_ID]).toBeDefined()

  await entry.getByRole('button', { name: 'Enable in This Project' }).click()
  const projectPage = settings.getByRole('region', { name: 'This Project' })
  const enable = projectPage.getByRole('checkbox', { name: /^Enable / })
  await enable.click()
  await expect(enable).toBeChecked()
  await expect
    .poll(async () => (await cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir))?.plugins, { timeout: 15_000 })
    .toEqual([{ id: PLUGIN_ID, state: 'active' }])
})

test('marketplace: an update is offered and applied, a revoked plugin stops and shows why, then moves to a safe version', async ({ cockpit, market }) => {
  const { page } = cockpit
  const v1 = market.publish('1.0.0')
  market.list(v1)

  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.keyboard.press('ControlOrMeta+,')
  await settings.getByRole('button', { name: 'Plugins' }).click()
  await settings.getByRole('button', { name: 'Refresh' }).click()
  const entry = settings.locator(`[data-plugin="${PLUGIN_ID}"]`)
  await entry.getByRole('button', { name: 'Install' }).click()
  await entry.getByRole('button', { name: 'Yes, install' }).click()
  await expect(entry.getByRole('button', { name: 'Uninstall' })).toBeVisible()
  await cockpit.hook('enablePlugin', cockpit.projectDir, PLUGIN_ID)
  const plugins = async (): Promise<unknown> => (await cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir))?.plugins
  await expect.poll(plugins, { timeout: 15_000 }).toEqual([{ id: PLUGIN_ID, state: 'active' }])

  // --- A newer version is listed: Refresh shows an Update, the Plugins page notes it. ---
  const v2 = market.publish('1.1.0')
  market.list(v2)
  await settings.getByRole('button', { name: 'Refresh' }).click()
  await expect(entry).toContainText('update available')
  await expect(entry).toContainText(`${PLUGIN_ID} · 1.0.0 · by Test Author · listed 1.1.0`)
  // The Updates filter shows it; the card is the installed plugin and its listing in one.
  await settings.getByRole('button', { name: 'Updates' }).click()
  await expect(entry).toHaveCount(1)
  await settings.getByRole('button', { name: 'All', exact: true }).click()
  await entry.locator('.settings-item-actions').getByRole('button', { name: 'Update', exact: true }).click()
  await entry.getByRole('button', { name: 'Yes, update' }).click()
  await expect(entry.getByRole('button', { name: 'Uninstall' })).toBeVisible()
  await expect(entry).toContainText('by Test Author')
  await expect.poll(() => existsSync(join(cockpit.dataDir, 'plugins', `${PLUGIN_ID}@1.1.0`, 'plugin.json')), { timeout: 10_000 }).toBe(true)
  await expect.poll(() => existsSync(join(cockpit.dataDir, 'plugins', `${PLUGIN_ID}@1.0.0`)), { timeout: 10_000 }).toBe(false)
  await expect.poll(plugins, { timeout: 15_000 }).toEqual([{ id: PLUGIN_ID, state: 'active' }])

  // --- The index revokes 1.1.0: the plugin stops, and the Plugins page says why. ---
  market.list(v2, [{ release: v2, reason: 'steals tokens' }])
  await settings.getByRole('button', { name: 'Refresh' }).click()
  await expect.poll(plugins, { timeout: 15_000 }).toEqual([])
  await expect(entry.locator('.settings-badge')).toHaveText('revoked')
  await expect(entry.getByRole('alert')).toContainText('steals tokens')
  await expect(entry.getByRole('button', { name: 'Uninstall' })).toBeEnabled()

  // --- A safe version is listed: the revoked plugin moves to it from the Marketplace. ---
  const v3 = market.publish('1.2.0')
  market.list(v3, [{ release: v2, reason: 'steals tokens' }])
  await settings.getByRole('button', { name: 'Refresh' }).click()
  await entry.getByRole('button', { name: 'Move to safe version' }).click()
  await entry.getByRole('button', { name: 'Yes, move to safe version' }).click()
  await expect(entry.getByRole('button', { name: 'Uninstall' })).toBeVisible()
  await expect.poll(plugins, { timeout: 15_000 }).toEqual([{ id: PLUGIN_ID, state: 'active' }])
})

test('marketplace: a revocation from an index with no authority over a plugin is a warning, not a stop', async ({ cockpit, market }) => {
  const { page } = cockpit
  const v1 = market.publish('1.0.0')
  market.list(null)
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.keyboard.press('ControlOrMeta+,')
  // Installed from a git URL: no index is recorded on it, and this one is not the default index.
  await settings.getByRole('button', { name: 'Plugins' }).click()
  await settings.getByRole('button', { name: 'Add plugin…' }).click()
  const form = settings.getByRole('form', { name: 'Install a plugin' })
  await form.getByLabel('Git URL').fill(market.repoUrl)
  await form.getByLabel('Tag').fill(v1.tag)
  await form.getByRole('button', { name: 'Install' }).click()
  await expect(settings.locator(`[data-plugin="${PLUGIN_ID}"]`)).toContainText(`${PLUGIN_ID} · 1.0.0`)
  await cockpit.hook('enablePlugin', cockpit.projectDir, PLUGIN_ID)
  const plugins = async (): Promise<unknown> => (await cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir))?.plugins
  await expect.poll(plugins, { timeout: 15_000 }).toEqual([{ id: PLUGIN_ID, state: 'active' }])

  market.list(null, [{ release: v1, reason: 'a griefer says so' }])
  await settings.getByRole('button', { name: 'Refresh' }).click()
  const warning = settings.getByTestId('marketplace-warning')
  await expect(warning).toContainText(market.indexUrl)
  await expect(warning).toContainText('a griefer says so')
  await expect(warning).toContainText('does not stop it')
  // Not stopped, not marked.
  await settings.getByRole('button', { name: 'Plugins' }).click()
  // The row has loaded (it shows its version) before "no badge" means anything.
  const row = settings.locator(`[data-plugin="${PLUGIN_ID}"]`)
  await expect(row).toContainText(`${PLUGIN_ID} · 1.0.0`)
  await expect(row.locator('.settings-badge')).toHaveCount(0)
  // A wrongly enforced revocation stops the host asynchronously: hold the check for a while.
  await expect.poll(plugins, { timeout: 5_000, intervals: [500] }).toEqual([{ id: PLUGIN_ID, state: 'active' }])
  await page.waitForTimeout(3_000)
  expect(await plugins()).toEqual([{ id: PLUGIN_ID, state: 'active' }])
})

test.describe('with an unreachable index', () => {
  test.use({ withBroken: true })

  test('marketplace: each index shows its own fetch error, and a refused URL is explained', async ({ cockpit, market }) => {
    const { page } = cockpit
    market.list(market.publish('1.0.0'))
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await page.keyboard.press('ControlOrMeta+,')
    await settings.getByRole('button', { name: 'Plugins' }).click()
    await settings.getByRole('button', { name: 'Refresh' }).click()
    // Index management is folded at the bottom; its heading counts the failing index.
    await expect(settings.getByText('2 configured, 1 could not be fetched')).toBeVisible()
    await settings.getByRole('button', { name: 'Manage' }).click()
    const good = settings.getByRole('list', { name: 'Marketplace indexes' }).locator(`[data-index="${market.indexUrl}"]`)
    const broken = settings.getByRole('list', { name: 'Marketplace indexes' }).locator(`[data-index="${brokenUrl(market)}"]`)
    await expect(good).toContainText('last fetched')
    await expect(good.locator('.settings-error')).toHaveCount(0)
    await expect(broken).toContainText('never fetched')
    await expect(broken.locator('.settings-error')).toBeVisible()
    // One index still works, so this is not the offline state, and its plugin is listed.
    await expect(settings.getByTestId('marketplace-offline')).toHaveCount(0)
    await expect(settings.locator(`li[data-plugin="${PLUGIN_ID}"]`)).toBeVisible()

    // A URL main refuses shows its reason and changes nothing. The warning about added indexes is there.
    const form = settings.getByRole('form', { name: 'Add a marketplace' })
    await expect(settings.getByText('an index can offer any plugin')).toBeVisible()
    await form.getByLabel('Marketplace URL').fill('http://example.com/index.json')
    await form.getByRole('button', { name: 'Add' }).click()
    await expect(settings.getByRole('alert')).toContainText('https:')
    await expect(form.getByLabel('Marketplace URL')).toHaveValue('http://example.com/index.json')
    await expect(settings.getByRole('list', { name: 'Marketplace indexes' }).locator('li')).toHaveCount(2)
  })
})

test('marketplace: installing an id from another repo warns, and it stays off in every project', async ({ cockpit, market }) => {
  const { page } = cockpit
  const v1 = market.publish('1.0.0')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.keyboard.press('ControlOrMeta+,')
  // Installed by git URL (which records the repo), on in this project, then uninstalled: the switch stays on.
  await settings.getByRole('button', { name: 'Plugins' }).click()
  await settings.getByRole('button', { name: 'Add plugin…' }).click()
  const form = settings.getByRole('form', { name: 'Install a plugin' })
  await form.getByLabel('Git URL').fill(market.repoUrl)
  await form.getByLabel('Tag').fill(v1.tag)
  await form.getByRole('button', { name: 'Install' }).click()
  const row = settings.locator(`[data-plugin="${PLUGIN_ID}"]`)
  await expect(row).toContainText(`${PLUGIN_ID} · 1.0.0`)
  await cockpit.hook('enablePlugin', cockpit.projectDir, PLUGIN_ID)
  const plugins = async (): Promise<unknown> => (await cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir))?.plugins
  await expect.poll(plugins, { timeout: 15_000 }).toEqual([{ id: PLUGIN_ID, state: 'active' }])
  await row.getByRole('button', { name: 'Uninstall' }).click()
  await row.getByRole('button', { name: /^Yes/ }).click()
  await expect.poll(plugins, { timeout: 15_000 }).toEqual([])

  // The index lists that id from a different repository.
  const other = market.mirror()
  market.list(v1, [], { repo: other })
  await settings.getByRole('button', { name: 'Refresh' }).click()
  const entry = settings.locator(`li[data-plugin="${PLUGIN_ID}"]`)
  await expect(entry).toContainText('last installed from')
  await entry.getByRole('button', { name: 'Install' }).click()
  const warning = entry.getByTestId('marketplace-repo-warning')
  await expect(warning).toContainText(market.repoUrl)
  await expect(warning).toContainText('stay off in every project')
  await expect(entry.getByRole('group', { name: `Confirm install of ${PLUGIN_ID}` })).toContainText(other)

  await entry.getByRole('button', { name: 'Yes, install' }).click()
  await expect(entry.getByRole('button', { name: 'Uninstall' })).toBeVisible()
  // Installed, recorded from the new repo, and not started in the project that had it on.
  const stored = JSON.parse(readFileSync(join(cockpit.dataDir, 'plugins.json'), 'utf8')) as { plugins: { id: string; source: { url?: string } }[] }
  expect(stored.plugins.find((p) => p.id === PLUGIN_ID)?.source.url).toBe(other)
  await expect.poll(plugins, { timeout: 5_000, intervals: [500] }).toEqual([])
  await page.waitForTimeout(2_000)
  expect(await plugins()).toEqual([])
})

test('marketplace: a folder linked under an id ends its repository history', async ({ cockpit, market }) => {
  const { page } = cockpit
  const v1 = market.publish('1.0.0')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.keyboard.press('ControlOrMeta+,')
  await settings.getByRole('button', { name: 'Plugins' }).click()
  await settings.getByRole('button', { name: 'Add plugin…' }).click()
  const form = settings.getByRole('form', { name: 'Install a plugin' })
  await form.getByLabel('Git URL').fill(market.repoUrl)
  await form.getByLabel('Tag').fill(v1.tag)
  await form.getByRole('button', { name: 'Install' }).click()
  const row = settings.locator(`[data-plugin="${PLUGIN_ID}"]`)
  await expect(row).toContainText(`${PLUGIN_ID} · 1.0.0`)
  await row.getByRole('button', { name: 'Uninstall' }).click()
  await row.getByRole('button', { name: /^Yes/ }).click()
  await expect(row).toHaveCount(0)
  const repos = (): Record<string, string> | undefined =>
    (JSON.parse(readFileSync(join(cockpit.dataDir, 'app.json'), 'utf8')) as { pluginRepos?: Record<string, string> }).pluginRepos
  expect(repos()?.[PLUGIN_ID]).toBe(market.repoUrl)

  await cockpit.hook('linkPlugin', FIXTURE)
  // main's real wiring, on disk when the link returns (ProjectRegistry.forgetPluginRepo).
  expect(repos()?.[PLUGIN_ID]).toBeUndefined()
})

test('marketplace: a project record this app cannot read refuses an install that may be a repo change',async ({ cockpit, market }) => {
  const { page } = cockpit
  const v1 = market.publish('1.0.0')
  market.list(v1)
  // Written by a newer app: read-only here, and it may list this id. No repo history to go by, so only
  // the record can say whether the switch is left over, and once readable it would start the plugin.
  const record = join(cockpit.dataDir, 'projects', '0123456789abcdef.json')
  const text = JSON.stringify({ schemaVersion: 99, enabledPlugins: [PLUGIN_ID] })
  // The window's own record may still wait for its debounce, and with it the folder.
  mkdirSync(dirname(record), { recursive: true })
  writeFileSync(record, text)

  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.keyboard.press('ControlOrMeta+,')
  await settings.getByRole('button', { name: 'Plugins' }).click()
  await settings.getByRole('button', { name: 'Refresh' }).click()
  const entry = settings.locator(`li[data-plugin="${PLUGIN_ID}"]`)
  await expect(entry).toContainText('last installed from')
  await entry.getByRole('button', { name: 'Install' }).click()
  await entry.getByRole('button', { name: 'Yes, install' }).click()
  await expect(settings.getByRole('alert')).toContainText(`cannot turn ${PLUGIN_ID} off`)
  expect(installedFolders(cockpit)).toEqual([])
  expect(readFileSync(record, 'utf8')).toBe(text)
})

test('marketplace: an index row counts what it skipped and what this app cannot run', async ({ cockpit, market }) => {
  const { page } = cockpit
  const v1 = market.publish('1.0.0')
  const listing = { name: 'Good plugin', description: '', author: 'Test Author', repo: market.repoUrl, version: v1.version, tag: v1.tag, commit: v1.commit }
  market.raw({
    schema: 1,
    plugins: [
      { ...listing, id: PLUGIN_ID, api: 1 },
      { ...listing, id: 'test.future', api: 99 },
      { ...listing, id: 'test.broken', api: 1, commit: 'nope' },
      { ...listing, id: 'test.broken2', api: 1, commit: 'nope' }
    ],
    revoked: [{ id: 'test.x', commit: 'nope', reason: 'bad' }]
  })
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.keyboard.press('ControlOrMeta+,')
  await settings.getByRole('button', { name: 'Plugins' }).click()
  await settings.getByRole('button', { name: 'Refresh' }).click()
  await settings.getByRole('button', { name: 'Manage' }).click()
  const row = settings.getByRole('list', { name: 'Marketplace indexes' }).locator(`[data-index="${market.indexUrl}"]`)
  await expect(row).toContainText('2 entries skipped')
  await expect(row).toContainText('1 revocation skipped')
  await expect(row).toContainText('1 incompatible with this app')
  // Only the usable one is listed.
  await expect(settings.getByRole('list', { name: 'Plugin list' }).locator('li')).toHaveCount(1)
  await expect(settings.locator(`li[data-plugin="${PLUGIN_ID}"]`)).toBeVisible()
})

test.describe('with the real index list', () => {
  test.use({ noOverride: true })

  test('marketplace: an index is added, stored and listed, and removing every one leaves none', async ({ cockpit, market }) => {
    const { page } = cockpit
    market.list(market.publish('1.0.0'))
    const stored = (): unknown => (JSON.parse(readFileSync(join(cockpit.dataDir, 'app.json'), 'utf8')) as { marketplaces?: unknown }).marketplaces
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await page.keyboard.press('ControlOrMeta+,')
    await settings.getByRole('button', { name: 'Plugins' }).click()
    await settings.getByRole('button', { name: 'Manage' }).click()
    const indexes = settings.getByRole('list', { name: 'Marketplace indexes' })
    const entry = settings.locator(`li[data-plugin="${PLUGIN_ID}"]`)
    // Out of the box: the official index, not fetched in a test run, so it shows an error.
    const official = indexes.locator(`[data-index="${DEFAULT_MARKETPLACE_URL}"]`)
    await expect(official.locator('.settings-error')).toBeVisible()

    const form = settings.getByRole('form', { name: 'Add a marketplace' })
    await form.getByLabel('Marketplace URL').fill(market.indexUrl)
    await form.getByRole('button', { name: 'Add' }).click()
    await expect(entry).toContainText('Good plugin')
    await expect(form.getByLabel('Marketplace URL')).toHaveValue('')
    await expect.poll(stored).toEqual([DEFAULT_MARKETPLACE_URL, market.indexUrl])

    await indexes.getByRole('button', { name: `Remove ${DEFAULT_MARKETPLACE_URL}` }).click()
    await expect(official).toHaveCount(0)
    await expect.poll(stored).toEqual([market.indexUrl])
    await expect(entry).toContainText('Good plugin')

    await indexes.getByRole('button', { name: `Remove ${market.indexUrl}` }).click()
    await expect(settings.getByText('No marketplace is configured.')).toBeVisible()
    await expect(entry).toHaveCount(0)
    await expect.poll(stored).toEqual([])
  })
})
