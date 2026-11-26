// QA hand run (run 003 Verify; not for merge, runs only with QA_JIRA=<dir> and QA_FAKE_JIRA=<fake-jira dir>): Jira
// 0.9.0 against a fake Jira Cloud (a local https server, its CA through NODE_EXTRA_CA_CERTS), on this build or on
// 0.27.0's. `ccc jira update` drafts open the issue window on Reply; a person selects, notes, asks, posts; a write
// and a read guest look on. Every step is logged to <dir>/<label>-steps.log with screenshots; a failed step is logged
// and the run goes on.
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { FrameLocator, Page } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { CockpitApi } from '../../src/shared/ipc'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { inviteGuest } from './guest-fixtures'
import { enableWebAccess, openBrowser, type WebBrowser } from './web-fixtures'

const DIR = process.env.QA_JIRA ?? ''
const FAKE = process.env.QA_FAKE_JIRA ?? ''
const LABEL = process.env.QA_LABEL ?? 'build'
const JIRA = join(homedir(), 'Projects/cc-cockpit-jira/.claude/worktrees/of-08-jira')
const log = (line: string): void => appendFileSync(join(DIR, `${LABEL}-steps.log`), line + '\n')
const invoke = (page: Page, ch: string, p?: unknown): Promise<unknown> =>
  page.evaluate(async ([a, b]) => ((window as unknown as { cockpit: CockpitApi }).cockpit.invoke as unknown as (x: string, y?: unknown) => Promise<unknown>)(a, b), [ch, p] as const)

async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const r = await fn()
    const shown = r === undefined || Buffer.isBuffer(r) ? '' : ' -> ' + JSON.stringify(r).slice(0, 600)
    log(`ok   ${name}${shown}`)
  } catch (err) {
    log(`FAIL ${name}: ${String(err).split('\n').slice(0, 3).join(' | ')}`)
  }
}
const shot = (page: Page, name: string): Promise<unknown> => page.screenshot({ path: join(DIR, `${LABEL}-${name}.png`) })

function ccc(c: Cockpit, args: string[], stdin = ''): Promise<{ status: number | null; out: string; err: string }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('CC_COCKPIT_') || k.startsWith('APP_TAB_') || k.startsWith('ELECTRON_')) continue
    env[k] = v
  }
  env.HOME = c.dataDir
  return new Promise((resolve) => {
    const child = spawn(join(c.dataDir, 'bin', 'ccc'), ['--project', c.projectDir, ...args], { env })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.stdin.end(stdin)
    child.on('close', (status) => resolve({ status, out, err }))
  })
}

const selectIn = (frame: FrameLocator, text: string): Promise<boolean> =>
  frame.locator('body').evaluate((body, t) => {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = (n.textContent ?? '').indexOf(t)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(n, at)
      range.setEnd(n, at + t.length)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
      const r = range.getBoundingClientRect()
      n.parentElement!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.right, clientY: r.bottom }))
      document.dispatchEvent(new Event('selectionchange'))
      return true
    }
    return false
  }, text)

test('qa hand jira', async () => {
  test.skip(!DIR || !FAKE, 'set QA_JIRA and QA_FAKE_JIRA')
  test.setTimeout(10 * 60_000)
  writeFileSync(join(DIR, `${LABEL}-steps.log`), '')
  const port = String(20_000 + Math.floor(Math.random() * 20_000))
  const server: ChildProcess = spawn(process.execPath, [join(FAKE, 'server.mjs'), port], { cwd: FAKE, stdio: 'ignore' })
  const writesLog = join(FAKE, 'writes.log')
  if (existsSync(writesLog)) writeFileSync(writesLog, '')
  const { cockpit: c, close } = await launchCockpit({ env: { NODE_EXTRA_CA_CERTS: join(FAKE, 'ca.pem') } })
  const opened: WebBrowser[] = []
  try {
    writeFileSync(join(c.root, 'home', '.claude.json'), JSON.stringify({ projects: { [c.projectDir]: { hasTrustDialogAccepted: true } } }))
    await c.hook('linkPlugin', JIRA)
    await c.hook('enablePlugin', c.projectDir, 'bronos.jira')
    await expect.poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.find((p) => p.id === 'bronos.jira')?.state, { timeout: 20_000 }).toBe('active')
    await step('save settings', () =>
      invoke(c.page, 'settings.projectPluginSettingsSave', {
        pluginId: 'bronos.jira',
        values: { site: `https://127.0.0.1:${port}`, email: 'qa@example.com', tokenKind: 'classic', lanes: { backlog: true, inProgress: true, mentioned: true, onHold: false, done: true } },
        secrets: { apiToken: 'qa-token' },
      })
    )
    await c.page.waitForTimeout(3_000)
    await step('ccc jira status', () => ccc(c, ['jira', 'status']))
    await step('ccc jira list', () => ccc(c, ['jira', 'list']))
    await c.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 950))
    await step('shot 00-panel', () => shot(c.page, '00-panel'))

    const web = await enableWebAccess(c)
    await step('show jira to guests', () => invoke(c.page, 'settings.pluginGuestAccessSet', { pluginId: 'bronos.jira', target: 'app', value: 'shown' }))
    const wes = await openBrowser((await inviteGuest(c, { name: 'Wes', role: 'write' })).link)
    opened.push(wes)
    const rae = await openBrowser((await inviteGuest(c, { name: 'Rae', role: 'read' })).link)
    opened.push(rae)
    for (const b of opened) await b.page.setViewportSize({ width: 1440, height: 950 })
    expect(web.link).toBeTruthy()

    // Claude drafts a reply: the issue window opens on Reply, filled.
    await step('ccc jira update QA-1 draft', () => ccc(c, ['jira', 'update', 'QA-1', '--status', 'In Progress', '-'], 'Looked into it: the fox is fine.\n'))
    await c.page.waitForTimeout(4_000)
    const overlays = await c.hook<Array<{ id: string; title: string }>>('overlays', c.projectDir).catch(() => [])
    log(`overlays ${JSON.stringify(overlays)}`)
    const title = overlays[0]?.title ?? ''
    const frame = (p: Page): FrameLocator => p.frameLocator(`iframe[title="${title}"]`)
    for (const [n, p] of [['desk', c.page], ['wes', wes.page], ['rae', rae.page]] as const) await step(`shot 01-${n}`, () => shot(p, `01-draft-${n}`))
    for (const [n, p] of [['desk', c.page], ['wes', wes.page], ['rae', rae.page]] as const) {
      await step(`${n}: tabs and buttons`, async () => (await frame(p).locator('[role=tab], button').allTextContents()).map((s) => s.trim()).filter(Boolean))
      await step(`${n}: reply textarea value`, async () => frame(p).locator('textarea').evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value)))
      await step(`${n}: draft mark`, async () => (await frame(p).locator('body').innerText()).includes('Draft from Claude'))
    }

    await step('desk selects "fox"', () => selectIn(frame(c.page), 'fox'))
    await c.page.waitForTimeout(500)
    await step('shot 02-desk-selection', () => shot(c.page, '02-desk-selection'))
    await step('desk Ask tab', () => frame(c.page).getByRole('tab', { name: 'Ask' }).click({ timeout: 5_000 }))
    await step('desk asks', async () => {
      const box = frame(c.page).getByPlaceholder(/Ask/).first()
      await box.fill('Summarise this issue')
      await box.press('Enter')
    })
    await c.page.waitForTimeout(3_000)
    await step('shot 03-desk-ask', () => shot(c.page, '03-desk-ask'))
    await step('desk Reply tab', () => frame(c.page).getByRole('tab', { name: 'Reply' }).click({ timeout: 5_000 }))
    await step('reply still filled after Ask', async () => frame(c.page).locator('textarea').evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value)))
    await step('shot 04-desk-reply', () => shot(c.page, '04-desk-reply'))
    await step('rae: Post buttons', () => frame(rae.page).getByRole('button', { name: /Post/ }).count())
    await step('wes: Post button', () => frame(wes.page).getByRole('button', { name: /Post/ }).count())
    await step('desk Post', () => frame(c.page).getByRole('button', { name: /Post/ }).first().click({ timeout: 5_000 }))
    await c.page.waitForTimeout(3_000)
    await step('fake jira writes', async () => (existsSync(writesLog) ? readFileSync(writesLog, 'utf8').trim().split('\n') : []))
    await step('shot 05-desk-posted', () => shot(c.page, '05-desk-posted'))
    await step('shot 05-wes-posted', () => shot(wes.page, '05-wes-posted'))
    await step('claude print runs', async () => c.claudeRuns().filter((a) => a[0] === '-p').map((a) => a.filter((x) => x.startsWith('--')).join(' ')))
  } finally {
    for (const b of opened) await b.close().catch(() => {})
    await close()
    server.kill()
  }
})
