// ctx.secrets in the real plugin host (plan "accounts to plugins" Task 3): a fixture plugin stores
// a secret through main, which encrypts it into <data>/secrets.json, and reads it back after the
// app is quit and started again over the same data dir. The harness sets CC_COCKPIT_FAKE_SECRETS=1
// with CC_COCKPIT_TEST=1, so main uses the marked fake store, never the developer's keychain.
// The fixture's project secret settings field rides along: saved in the first launch, it must be
// in ctx.settings at the second launch's activate, which only holds when main decrypts the stored
// value before the host starts (index.ts hostPlugins -> loadSettings), the cache being empty then.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { FAKE_PREFIX } from '../../src/main/secrets/secret-store'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'

const FIXTURE = join(__dirname, '..', 'fixtures', 'plugins', 'host-secrets')
const PLAIN = 'e2e-secret-plaintext'
const SETTING_PLAIN = 'e2e-secret-setting-plaintext'

interface Seen {
  before: string | null
  after: string | null
  keys: string[]
  settingToken: string | null
  reservedError?: string
  error?: string
}

/** What the fixture recorded at its activate (it writes the file once per launch). */
async function seenBy(c: Cockpit): Promise<Seen> {
  const file = join(c.root, 'home', 'host-secrets.json')
  await expect
    .poll(() => c.hook<HostStatus>('hostStatus', c.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: 'test.hostsecrets', state: 'active' }] })
  await expect.poll(() => existsSync(file), { timeout: 15_000 }).toBe(true)
  return JSON.parse(readFileSync(file, 'utf8')) as Seen
}

test('a plugin stores a secret and reads it back after an app restart; only ciphertext is on disk', async () => {
  // Own launches: this test starts the app twice over one data dir.
  const first = await launchCockpit()
  const root = first.cockpit.root
  try {
    const c = first.cockpit
    await c.hook('linkPlugin', FIXTURE)
    await c.hook('enablePlugin', c.projectDir, 'test.hostsecrets')
    const seen = await seenBy(c)
    expect(seen.error).toBeUndefined()
    expect(seen).toMatchObject({ before: null, after: PLAIN, keys: ['note'], settingToken: null })
    // The reserved prefix of the secret settings fields is refused through ctx.secrets.
    expect(seen.reservedError).toMatch(/reserved/)

    const saved = await c.hook<{ ok: boolean }>('savePluginProjectSettings', c.projectDir, 'test.hostsecrets', {}, { token: SETTING_PLAIN })
    expect(saved).toMatchObject({ ok: true })

    const secretsFile = join(c.dataDir, 'secrets.json')
    const text = readFileSync(secretsFile, 'utf8')
    expect(text).toContain(FAKE_PREFIX)
    expect(text).toContain('setting:project:')
    expect(text).not.toContain(PLAIN)
    expect(text).not.toContain(SETTING_PLAIN)
    expect(Object.keys(JSON.parse(text).plugins)).toEqual(['test.hostsecrets'])
    // The relaunch must show what the second activate saw, not this run's record.
    rmSync(join(root, 'home', 'host-secrets.json'))
  } finally {
    await first.close({ keepFiles: true })
  }

  const second = await launchCockpit({ root })
  try {
    const seen = await seenBy(second.cockpit)
    expect(seen.error).toBeUndefined()
    expect(seen).toMatchObject({ before: PLAIN, after: PLAIN, keys: ['note'], settingToken: SETTING_PLAIN })
  } finally {
    await second.close()
  }
})
