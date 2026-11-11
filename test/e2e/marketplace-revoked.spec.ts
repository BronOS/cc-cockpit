// A revocation already in the marketplace cache applies at startup, before anything activates: the
// cache is read synchronously before plugins.load(), and `index.ts` has no unit seam for that order.
//
// The plugin is installed and running in a first launch (so "never activates" below means something:
// the same project starts it without the revocation), then the data dir is seeded with a cached index
// revoking its commit and the app starts again. The index URL points at a file that does not exist:
// the fetch fails, as it would offline, and must not clear what the cache says.
//
// Same git isolation as settings-plugin-install.spec.ts: a bare repo over file:///, no developer config.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { WebCliStatus } from '../../src/shared/web-access'
import { expect, launchCockpit, test } from './fixtures'
import { ccc, launchServer } from './server-fixtures'

const FIXTURES = join(__dirname, '..', 'fixtures', 'plugins')
const PLUGIN_ID = 'test.good'
const CONTROL_ID = 'test.hostok'
const GIT_ENV: Record<string, string | undefined> = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
delete GIT_ENV.XDG_CONFIG_HOME

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
    { cwd, env: GIT_ENV, stdio: 'pipe' }
  )
}

test('a revocation in the cache keeps a plugin from activating at startup, with the fetch failing', async () => {
  test.setTimeout(90_000)
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-e2e-revoked-')))
  const work = join(temp, 'work')
  const bare = join(temp, 'good.git')
  const xdg = join(temp, 'xdg')
  mkdirSync(xdg)
  cpSync(join(FIXTURES, 'good'), work, { recursive: true })
  git(work, 'init', '-q')
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'v1.0.0')
  git(work, 'tag', 'v1.0.0')
  git(temp, 'clone', '-q', '--bare', work, bare)
  const repoUrl = pathToFileURL(bare).href
  const indexUrl = pathToFileURL(join(temp, 'no-such-index.json')).href
  const gitEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: xdg }

  const first = await launchCockpit({ env: gitEnv })
  const { root, dataDir } = first.cockpit
  try {
    try {
      const settings = first.cockpit.page.getByRole('dialog', { name: 'Settings' })
      await first.cockpit.page.keyboard.press('ControlOrMeta+,')
      await settings.getByRole('button', { name: 'Plugins' }).click()
      await settings.getByRole('button', { name: 'Add plugin…' }).click()
      const form = settings.getByRole('form', { name: 'Install a plugin' })
      await form.getByLabel('Git URL').fill(repoUrl)
      await form.getByLabel('Tag').fill('v1.0.0')
      await form.getByRole('button', { name: 'Install' }).click()
      await expect(settings.locator(`[data-plugin="${PLUGIN_ID}"]`)).toContainText(`${PLUGIN_ID} · 1.0.0`)
      await first.cockpit.hook('linkPlugin', join(FIXTURES, 'host-ok'))
      await first.cockpit.hook('enablePlugin', first.cockpit.projectDir, PLUGIN_ID)
      await first.cockpit.hook('enablePlugin', first.cockpit.projectDir, CONTROL_ID)
      await expect
        .poll(async () => (await first.cockpit.hook<HostStatus>('hostStatus', first.cockpit.projectDir))?.plugins.map((p) => `${p.id}:${p.state}`).sort(), { timeout: 15_000 })
        .toEqual([`${PLUGIN_ID}:active`, `${CONTROL_ID}:active`].sort())
    } finally {
      await first.close({ keepFiles: true })
    }

    // Seed: the plugin came from this index, and the index's cached copy revokes its commit.
    const pluginsJson = join(dataDir, 'plugins.json')
    const stored = JSON.parse(readFileSync(pluginsJson, 'utf8')) as { plugins: { id: string; commit?: string; marketplace?: string }[] }
    const record = stored.plugins.find((p) => p.id === PLUGIN_ID)!
    const commit = record.commit!
    expect(commit).toMatch(/^[0-9a-f]{40}$/)
    record.marketplace = indexUrl
    writeFileSync(pluginsJson, JSON.stringify(stored))
    const seeded = readFileSync(pluginsJson, 'utf8')
    const text = JSON.stringify({ schema: 1, plugins: [], revoked: [{ id: PLUGIN_ID, commit, reason: 'steals tokens' }] })
    mkdirSync(join(dataDir, 'marketplaces'), { recursive: true })
    writeFileSync(
      join(dataDir, 'marketplaces', `${createHash('sha256').update(indexUrl).digest('hex')}.json`),
      JSON.stringify({ url: indexUrl, fetchedAt: Date.now(), text })
    )

    const second = await launchCockpit({ root, env: { ...gitEnv, CC_COCKPIT_MARKETPLACE_URLS: indexUrl } })
    try {
      const { cockpit } = second
      // The control is up, so the host has settled on its list: the revoked plugin is not on it.
      await expect
        .poll(async () => (await cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir))?.plugins, { timeout: 15_000 })
        .toEqual([{ id: CONTROL_ID, state: 'active' }])
      await expect.poll(() => cockpit.hook<string[]>('notifications')).toEqual([
        `Plugin ${PLUGIN_ID} was stopped: steals tokens (revoked by ${indexUrl})`
      ])
      const after = JSON.parse(readFileSync(pluginsJson, 'utf8')) as { plugins: { id: string; state: unknown }[] }
      expect(after.plugins.find((p) => p.id === PLUGIN_ID)?.state).toEqual({
        ok: false,
        reason: `revoked by ${indexUrl}: steals tokens`,
        revoked: { reason: 'steals tokens', source: indexUrl }
      })

      // The user sees why.
      const settings = cockpit.page.getByRole('dialog', { name: 'Settings' })
      await cockpit.page.keyboard.press('ControlOrMeta+,')
      await settings.getByRole('button', { name: 'Plugins' }).click()
      const row = settings.locator(`[data-plugin="${PLUGIN_ID}"]`)
      await expect(row.locator('.settings-badge')).toContainText('revoked')
      await expect(row).toContainText('steals tokens')
    } finally {
      await second.close({ keepFiles: true })
    }

    // The same cached revocation in server mode (design-web.md §9.9): the notice is a stdout line with
    // the plugin id only, none of the index's text, and `ccc web status` lists it; no OS notification
    // (nothing is recorded) and the plugin is stopped all the same. The line itself is printed at
    // start, before a spec can listen, so the status is what is checked here (core-notices.test.ts has
    // the line). app.json gets web access on a random loopback port, as launchServer writes it.
    // The desktop run above recorded the plugin as revoked, and only a plugin that just became revoked is
    // announced: put the seeded record back.
    writeFileSync(pluginsJson, seeded)
    const port = 20000 + Math.floor(Math.random() * 20000)
    const appJson = join(dataDir, 'app.json')
    const app = existsSync(appJson) ? (JSON.parse(readFileSync(appJson, 'utf8')) as Record<string, unknown>) : { schemaVersion: 1 }
    writeFileSync(appJson, JSON.stringify({ ...app, updateCheck: false, webAccess: { enabled: true, bind: '127.0.0.1', port, mode: 'none', hosts: [] } }))
    const server = await launchServer({ root, port, env: { ...gitEnv, CC_COCKPIT_MARKETPLACE_URLS: indexUrl } })
    try {
      await expect
        .poll(async () => ((JSON.parse((await ccc(server, ['web', 'status', '--json'])).stdout) as WebCliStatus).notices))
        .toEqual([
          { kind: 'revoked', text: `Plugin ${PLUGIN_ID} was stopped: the marketplace index revoked it (the reason is on the Plugins page)`, at: expect.any(Number) }
        ])
      const text = (await ccc(server, ['web', 'status'])).stdout
      expect(text).toContain('plugin revoked')
      expect(text).not.toContain('steals tokens')
      expect(text).not.toContain(indexUrl)
      expect(await server.cockpit.hook<string[]>('notifications')).toEqual([])
    } finally {
      await server.close({ keepFiles: true })
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
