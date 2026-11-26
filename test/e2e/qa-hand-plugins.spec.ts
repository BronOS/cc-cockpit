// QA hand run (run 003 Verify; not for merge, runs only with QA_PLUGINS=<dir>): links the four plugin branches
// (Jira 0.9.0, Gmail 0.7.0, Calendar 0.4.0, Chat 0.4.0) from their worktrees into this build and records whether each
// loads and activates, with its host status line, to <dir>/<app version>.json. Run from this worktree's build and
// from 0.27.0's (master) to check the old-app path (S10: they open on an app without Notes, Ask and parts).
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expect, launchCockpit, test } from './fixtures'

const DIR = process.env.QA_PLUGINS ?? ''
const PLUGINS: Array<[string, string]> = [
  ['bronos.jira', join(homedir(), 'Projects/cc-cockpit-jira/.claude/worktrees/of-08-jira')],
  ['bronos.gmail', join(homedir(), 'Projects/cc-cockpit-gmail/.claude/worktrees/of-gmail')],
  ['bronos.calendar', join(homedir(), 'Projects/cc-cockpit-calendar/.claude/worktrees/of-calendar')],
  ['bronos.chat', join(homedir(), 'Projects/cc-cockpit-chat/.claude/worktrees/of-chat')],
]

test('qa hand plugins', async () => {
  test.skip(!DIR, 'set QA_PLUGINS')
  test.setTimeout(5 * 60_000)
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  const out: Record<string, unknown> = {}
  try {
    out.app = process.env.QA_LABEL ?? 'build'
    for (const [id, dir] of PLUGINS) {
      try {
        await c.hook('linkPlugin', dir)
        await c.hook('enablePlugin', c.projectDir, id)
        await expect
          .poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.find((p) => p.id === id)?.state, { timeout: 20_000 })
          .toMatch(/active|failed|error|off/)
      } catch (err) {
        out[`${id}.link`] = String(err).split('\n')[0]
      }
    }
    await c.page.waitForTimeout(3_000)
    out.status = (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.filter((p) => p.id.startsWith('bronos.'))
    out.notifications = await c.hook<string[]>('notifications')
    // M1: which provider each user of a service gets, and any problem (the Plugins page's own view).
    out.services = await c.page
      .evaluate(async () => ((window as unknown as { cockpit: { invoke(c: string): Promise<unknown> } }).cockpit.invoke('settings.pluginServices')))
      .catch((e: unknown) => `error: ${String(e)}`)
    await c.page.screenshot({ path: join(DIR, `plugins-${String(out.app)}.png`) })
  } finally {
    writeFileSync(join(DIR, `plugins-${String(out.app)}.json`), JSON.stringify(out, null, 2))
    await close()
  }
})
