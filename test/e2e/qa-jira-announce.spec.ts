// QA, run 003 Verify (the lead's question): Jira's part beside a mail opened before Jira's first poll. Needs the fake
// Jira Cloud of the QA hand run (QA_FAKE_JIRA=<dir with server.mjs and ca.pem>; skipped otherwise) and the Jira 0.9.0
// worktree. The qa-mail fixture announces kind `mail` with the ref QA-1, as Gmail does.
//  - Positive control: a mail opened after Jira's poll gets the Jira part.
//  - The question: a mail opened before the poll, left open; does the part come once Jira knows the project?
import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { CockpitApi, OverlayInfo } from '../../src/shared/ipc'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'

const FAKE = process.env.QA_FAKE_JIRA ?? ''
const JIRA = join(homedir(), 'Projects/cc-cockpit-jira/.claude/worktrees/of-08-jira')
const MAIL = 'test.qamail'

const invoke = (page: Page, ch: string, p?: unknown): Promise<unknown> =>
  page.evaluate(async ([a, b]) => ((window as unknown as { cockpit: CockpitApi }).cockpit.invoke as unknown as (x: string, y?: unknown) => Promise<unknown>)(a, b), [ch, p] as const)
const overlays = (c: Cockpit): Promise<OverlayInfo[]> => c.hook<OverlayInfo[]>('overlays', c.projectDir)
const parts = async (c: Cockpit): Promise<string[]> => (await overlays(c)).filter((o) => o.partOf).map((o) => o.title)

async function link(c: Cockpit, dir: string, id: string): Promise<void> {
  await c.hook('linkPlugin', dir)
  await c.hook('enablePlugin', c.projectDir, id)
  await expect.poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.some((p) => p.id === id && p.state === 'active'), { timeout: 20_000 }).toBe(true)
}
const openMail = (c: Cockpit): Promise<unknown> => c.hook('runPluginCommand', c.projectDir, `${MAIL}/open`)
const configure = (c: Cockpit, port: string): Promise<unknown> =>
  invoke(c.page, 'settings.projectPluginSettingsSave', {
    pluginId: 'bronos.jira',
    values: { site: `https://127.0.0.1:${port}`, email: 'qa@example.com', tokenKind: 'classic' },
    secrets: { apiToken: 'qa-token' },
  })

test('Jira part beside a mail: after the first poll (control), and for a mail opened before it', async () => {
  test.skip(!FAKE, 'set QA_FAKE_JIRA')
  test.setTimeout(240_000)
  const port = String(20_000 + Math.floor(Math.random() * 20_000))
  const server: ChildProcess = spawn(process.execPath, [join(FAKE, 'server.mjs'), port], { cwd: FAKE, stdio: 'ignore' })
  const { cockpit: c, close } = await launchCockpit({ env: { NODE_EXTRA_CA_CERTS: join(FAKE, 'ca.pem') } })
  try {
    await c.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 1000))
    await link(c, join(__dirname, '..', 'fixtures', 'plugins', 'qa-mail'), MAIL)
    await link(c, JIRA, 'bronos.jira')

    // Before Jira knows anything (not configured, never polled): the mail opens and stays open.
    await openMail(c)
    await expect.poll(async () => (await overlays(c)).map((o) => o.title)).toContain('QA mail about QA-1')
    await configure(c, port)
    // Jira polls: the lanes it answers with name project QA (its panel's own list fills). Give it 30 s.
    const early = await expect
      .poll(() => parts(c), { timeout: 30_000 })
      .toEqual(['Jira QA-1'])
      .then(() => ['Jira QA-1'], async () => parts(c))

    // Positive control: the same mail opened again after the poll.
    await c.hook('closeOverlays', c.projectDir).catch(() => undefined)
    for (const o of await overlays(c)) await invoke(c.page, 'overlays.close', { overlayId: o.id }).catch(() => undefined)
    await expect.poll(async () => (await overlays(c)).length, { timeout: 10_000 }).toBe(0)
    await openMail(c)
    await expect.poll(() => parts(c), { timeout: 20_000 }).toEqual(['Jira QA-1'])
    test.info().annotations.push({ type: 'qa', description: JSON.stringify({ partsForMailOpenedBeforePoll: early }) })
    expect(early, 'a mail opened before the first poll gets its part once Jira knows the project').toEqual(['Jira QA-1'])
  } finally {
    await close()
    server.kill()
  }
})
