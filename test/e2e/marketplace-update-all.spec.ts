// "Update all" on Settings › Plugins (design-next §6.4), end to end against a local file:/// index and two
// bare repos, so nothing leaves the machine. Two marketplace-installed plugins get newer listings; one
// listing pins a commit its tag is not at (a moved tag), so main's real clone + `rev-parse HEAD` check
// refuses it. The prompt lists both with versions, repo and commit; on Confirm the good one is updated,
// the failure is listed with its reason, and the success is not rolled back. The unit tests
// (settings-marketplace.test.ts) cover the exclusions (linked, git-URL, revoked) and the list checks.
//
// Same git isolation as settings-marketplace.spec.ts: no developer git config is read.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, launchCockpit, test } from './fixtures'

const FIXTURE = join(__dirname, '..', 'fixtures', 'plugins', 'good')
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
  id: string
  name: string
  repo: string
  version: string
  tag: string
  commit: string
}

/** A bare repo for `id` and a publish function that commits the fixture at a version, tags and pushes it. */
function repoFor(root: string, id: string, name: string): (version: string) => Release {
  const bare = join(root, `${id}.git`)
  const work = join(root, `${id}-work`)
  mkdirSync(bare)
  mkdirSync(work)
  git(bare, 'init', '-q', '--bare')
  git(work, 'init', '-q')
  git(work, 'remote', 'add', 'origin', bare)
  cpSync(join(FIXTURE, 'host.js'), join(work, 'host.js'))
  const repo = pathToFileURL(bare).href
  return (version) => {
    // Its own manifest, without the fixture's theme: two plugins, no shared contribution ids.
    writeFileSync(join(work, 'plugin.json'), JSON.stringify({ id, name, version, api: 1, main: 'host.js' }, null, 2))
    git(work, 'add', '-A')
    git(work, 'commit', '-q', '-m', version)
    git(work, 'tag', `v${version}`)
    git(work, 'push', '-q', 'origin', 'main', `v${version}`)
    return { id, name, repo, version, tag: `v${version}`, commit: git(work, 'rev-parse', 'HEAD') }
  }
}

test('marketplace: Update all updates each listed plugin, lists the failure with its reason and keeps the success', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-e2e-update-all-')))
  const xdg = join(root, 'xdg')
  mkdirSync(xdg)
  const indexFile = join(root, 'index.json')
  const indexUrl = pathToFileURL(indexFile).href
  const list = (releases: Release[]): void =>
    writeFileSync(
      indexFile,
      JSON.stringify({
        schema: 1,
        plugins: releases.map((r) => ({
          id: r.id,
          name: r.name,
          description: 'A fixture plugin',
          author: 'Test Author',
          repo: r.repo,
          version: r.version,
          tag: r.tag,
          commit: r.commit,
          api: 1
        })),
        revoked: []
      })
    )
  const alpha = repoFor(root, 'test.alpha', 'Alpha plugin')
  const beta = repoFor(root, 'test.beta', 'Beta plugin')
  const a1 = alpha('1.0.0')
  const b1 = beta('1.0.0')
  list([a1, b1])

  const { cockpit, close } = await launchCockpit({
    env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: xdg, CC_COCKPIT_MARKETPLACE_URLS: indexUrl }
  })
  try {
    const { page, dataDir } = cockpit
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await page.keyboard.press('ControlOrMeta+,')
    await settings.getByRole('button', { name: 'Plugins' }).click()
    await settings.getByRole('button', { name: 'Refresh' }).click()
    for (const id of [a1.id, b1.id]) {
      const card = settings.locator(`[data-plugin="${id}"]`)
      await card.getByRole('button', { name: 'Install' }).click()
      await card.getByRole('button', { name: 'Yes, install' }).click()
      await expect(card.getByRole('button', { name: 'Uninstall' })).toBeVisible()
    }
    // Nothing newer is listed yet: no Update all.
    await expect(settings.getByRole('button', { name: /^Update all/ })).toHaveCount(0)

    // --- Both get a newer listing; Beta's pins a commit its tag is not at. ---
    const a2 = alpha('1.1.0')
    const b2 = beta('1.1.0')
    const wrong = 'b'.repeat(40)
    list([a2, { ...b2, commit: wrong }])
    await settings.getByRole('button', { name: 'Refresh' }).click()
    const updateAll = settings.getByRole('button', { name: 'Update all (2)' })
    await expect(updateAll).toBeVisible()

    // --- One confirmation lists each plugin with current and new version, repo and commit; Cancel is focused. ---
    await updateAll.click()
    const confirm = settings.getByRole('group', { name: 'Confirm update of all plugins' })
    await expect(confirm.getByTestId('update-all-item')).toHaveCount(2)
    await expect(confirm).toContainText('Alpha plugin')
    await expect(confirm).toContainText('Beta plugin')
    await expect(confirm).toContainText('1.0.0 → 1.1.0')
    await expect(confirm).toContainText(a2.repo)
    await expect(confirm).toContainText(b2.repo)
    await expect(confirm).toContainText(a2.commit)
    await expect(confirm).toContainText(wrong)
    await expect(confirm).toContainText('not that anyone reviewed the code')
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()

    // --- Esc closes the prompt only; nothing is updated. ---
    await page.keyboard.press('Escape')
    await expect(confirm).toHaveCount(0)
    await expect(settings).toBeVisible()
    expect(existsSync(join(dataDir, 'plugins', `${a1.id}@1.1.0`))).toBe(false)

    // --- Confirm: Alpha is updated, Beta is refused with the pin mismatch, Alpha stays updated. ---
    await updateAll.click()
    await confirm.getByRole('button', { name: 'Yes, update all 2' }).click()
    const outcome = settings.getByTestId('update-all-outcome')
    await expect(outcome).toContainText('Updated 1 plugin. 1 could not be updated:', { timeout: 20_000 })
    await expect(outcome.getByRole('alert')).toContainText('Beta plugin')
    await expect(outcome.getByRole('alert')).toContainText(`the tag is at commit ${b2.commit}, but the marketplace index pins ${wrong}`)
    expect(existsSync(join(dataDir, 'plugins', `${a1.id}@1.1.0`, 'plugin.json'))).toBe(true)
    expect(existsSync(join(dataDir, 'plugins', `${b1.id}@1.0.0`, 'plugin.json'))).toBe(true)
    const stored = JSON.parse(readFileSync(join(dataDir, 'plugins.json'), 'utf8')) as { plugins: { id: string; version: string; commit?: string }[] }
    expect(stored.plugins.find((p) => p.id === a1.id)).toMatchObject({ version: '1.1.0', commit: a2.commit })
    expect(stored.plugins.find((p) => p.id === b1.id)).toMatchObject({ version: '1.0.0', commit: b1.commit })

    // Beta is still offered (its listing is unchanged); Alpha no longer is.
    await expect(settings.getByRole('button', { name: 'Update all (1)' })).toBeVisible()
    await outcome.getByRole('button', { name: 'Dismiss' }).click()
    await expect(outcome).toHaveCount(0)
  } finally {
    await close()
    rmSync(root, { recursive: true, force: true })
  }
})
