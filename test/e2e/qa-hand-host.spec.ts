// qa-chloe hand run host (not for merge, run only with QA_HAND=<dir>): keeps a host app up with web access,
// Files and Editor shown, a hidden test plugin, writes a read invite link to <dir>/link.txt and acts on
// files a person drops in <dir>: `upgrade` (role write), `kick`, `done` (quit).
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CockpitApi } from '../../src/shared/ipc'
import { pluginActive } from './download-fixtures'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { enableWebAccess } from './web-fixtures'

const DIR = process.env.QA_HAND ?? ''
const invoke = (c: Cockpit, ch: string, p?: unknown): Promise<unknown> =>
  c.page.evaluate(async ([a, b]) => ((window as unknown as { cockpit: CockpitApi }).cockpit.invoke as unknown as (x: string, y?: unknown) => Promise<unknown>)(a, b), [ch, p] as const)

test('qa hand host', async () => {
  test.skip(!DIR, 'set QA_HAND')
  test.setTimeout(20 * 60_000)
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  try {
    writeFileSync(join(c.projectDir, 'readme.txt'), 'hello guest\n')
    await c.hook('linkPlugin', join(__dirname, '..', 'fixtures', 'plugins', 'qa-leak'))
    await c.hook('enablePlugin', c.projectDir, 'test.qaleakzq')
    await c.newTab('claude')
    await pluginActive(c, 'cockpit.files')
    await enableWebAccess(c)
    for (const pluginId of ['cockpit.files', 'cockpit.editor']) await invoke(c, 'settings.pluginGuestAccessSet', { pluginId, target: 'app', value: 'shown' })
    const a = (await c.hook('guestInvite', c.projectDir, { name: 'Chloe', role: 'read', scope: 'all', lifetime: '1d' })) as { link: string; guestId: string }
    writeFileSync(join(DIR, 'link.txt'), a.link)
    for (;;) {
      await expect.poll(() => ['upgrade', 'kick', 'done'].some((f) => existsSync(join(DIR, f))), { timeout: 19 * 60_000, intervals: [500] }).toBe(true)
      if (existsSync(join(DIR, 'upgrade'))) {
        rmSync(join(DIR, 'upgrade'))
        writeFileSync(join(DIR, 'log.txt'), `upgrade ${JSON.stringify(await invoke(c, 'guests.setRole', { guestId: a.guestId, role: 'write' }))}\n`, { flag: 'a' })
      }
      if (existsSync(join(DIR, 'kick'))) {
        rmSync(join(DIR, 'kick'))
        writeFileSync(join(DIR, 'log.txt'), `kick ${JSON.stringify(await invoke(c, 'guests.kick', { guestId: a.guestId }))}\n`, { flag: 'a' })
      }
      if (existsSync(join(DIR, 'done'))) break
    }
  } finally {
    await close()
  }
})
