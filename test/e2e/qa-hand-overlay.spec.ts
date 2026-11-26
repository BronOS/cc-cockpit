// QA hand run (run 003 Verify; not for merge, runs only with QA_SHOTS=<dir>): the kit demo and the parts fixtures seen
// by the owner's desktop, the owner's browser view, a write guest and a read guest, each step screenshotted. Each
// step logs what it saw to <dir>/steps.log and goes on after a failure (a person keeps clicking).
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FrameLocator, Page } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { CockpitApi } from '../../src/shared/ipc'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { inviteGuest } from './guest-fixtures'
import { enableWebAccess, openBrowser, type WebBrowser } from './web-fixtures'

const DIR = process.env.QA_SHOTS ?? ''
const FIXTURES = join(__dirname, '..', 'fixtures', 'plugins')
const log = (line: string): void => appendFileSync(join(DIR, 'steps.log'), line + '\n')
const invoke = (page: Page, ch: string, p?: unknown): Promise<unknown> =>
  page.evaluate(async ([a, b]) => ((window as unknown as { cockpit: CockpitApi }).cockpit.invoke as unknown as (x: string, y?: unknown) => Promise<unknown>)(a, b), [ch, p] as const)

async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const r = await fn()
    log(`ok   ${name}${r === undefined ? '' : ' -> ' + JSON.stringify(r).slice(0, 400)}`)
  } catch (err) {
    log(`FAIL ${name}: ${String(err).split('\n').slice(0, 3).join(' | ')}`)
  }
}
const shot = (page: Page, name: string): Promise<unknown> => page.screenshot({ path: join(DIR, `${name}.png`) })

async function link(c: Cockpit, dir: string, id: string): Promise<void> {
  await c.hook('linkPlugin', join(FIXTURES, dir))
  await c.hook('enablePlugin', c.projectDir, id)
  await expect.poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.some((p) => p.id === id && p.state === 'active'), { timeout: 20_000 }).toBe(true)
}

/** Selects `text` inside the frame's document as a person's drag would, ending with a mouseup. */
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

test('qa hand overlay', async () => {
  test.skip(!DIR, 'set QA_SHOTS')
  test.setTimeout(10 * 60_000)
  writeFileSync(join(DIR, 'steps.log'), '')
  const { cockpit: c, close } = await launchCockpit()
  const opened: WebBrowser[] = []
  try {
    writeFileSync(join(c.root, 'home', '.claude.json'), JSON.stringify({ projects: { [c.projectDir]: { hasTrustDialogAccepted: true } } }))
    await link(c, 'kit-demo', 'test.kitdemo')
    const web = await enableWebAccess(c)
    await invoke(c.page, 'settings.pluginGuestAccessSet', { pluginId: 'test.kitdemo', target: 'app', value: 'shown' })
    const owner = await openBrowser(web.link)
    opened.push(owner)
    await owner.page.getByRole('list', { name: 'Open projects' }).getByRole('link').click()
    const wes = await openBrowser((await inviteGuest(c, { name: 'Wes', role: 'write' })).link)
    opened.push(wes)
    const rae = await openBrowser((await inviteGuest(c, { name: 'Rae', role: 'read' })).link)
    opened.push(rae)
    await c.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 950))
    for (const b of opened) await b.page.setViewportSize({ width: 1440, height: 950 })
    const screens: Array<[string, Page]> = [['desk', c.page], ['owner', owner.page], ['wes', wes.page], ['rae', rae.page]]

    await step('open kit demo', () => c.hook('runPluginCommand', c.projectDir, 'test.kitdemo/open'))
    await c.page.waitForTimeout(3_000)
    for (const [n, p] of screens) await step(`shot 01-${n}`, () => shot(p, `01-open-${n}`))
    const frame = (p: Page): FrameLocator => p.frameLocator('iframe[title="Kit demo"]')
    for (const [n, p] of screens) {
      await step(`${n}: side tabs and buttons`, async () =>
        (await frame(p).locator('[role=tab], button, a').allTextContents()).map((s) => s.trim()).filter(Boolean)
      )
    }

    await step('wes selects "lazy dog"', () => selectIn(frame(wes.page), 'lazy dog'))
    await wes.page.waitForTimeout(500)
    await step('shot 02-wes-selection', () => shot(wes.page, '02-wes-selection'))
    await step('wes clicks Note', () => frame(wes.page).getByRole('button', { name: 'Note', exact: true }).click({ timeout: 5_000 }))
    await wes.page.waitForTimeout(500)
    await step('shot 03-wes-compose', () => shot(wes.page, '03-wes-compose'))
    await step('wes types the note', async () => {
      const box = frame(wes.page).locator('textarea').first()
      await box.fill('Is this the dog from QA-1?')
      await box.press('Enter')
    })
    await step('wes saves (button)', () => frame(wes.page).getByRole('button', { name: /^(Add|Save|Add note)$/ }).first().click({ timeout: 3_000 }))
    await c.page.waitForTimeout(1_500)
    for (const [n, p] of screens) await step(`shot 04-${n}`, () => shot(p, `04-after-wes-note-${n}`))
    await step('desk sees wes note', () => frame(c.page).locator('body').innerText().then((t) => t.includes('dog from QA-1') && t.match(/guest Wes/) !== null))

    await step('rae selects "quick brown"', () => selectIn(frame(rae.page), 'quick brown'))
    await rae.page.waitForTimeout(500)
    await step('shot 05-rae-selection', () => shot(rae.page, '05-rae-selection'))
    await step('rae selection menu buttons', async () => (await frame(rae.page).locator('button').allTextContents()).map((s) => s.trim()).filter(Boolean))

    await step('desk opens Ask tab', () => frame(c.page).getByRole('tab', { name: 'Ask' }).click({ timeout: 5_000 }))
    await step('desk asks', async () => {
      const box = frame(c.page).locator('textarea, input[type=text]').last()
      await box.fill('What is this about?')
      await box.press('Enter')
    })
    await c.page.waitForTimeout(3_000)
    for (const [n, p] of screens) await step(`shot 06-${n}`, () => shot(p, `06-after-owner-ask-${n}`))

    await step('wes Ask tab + ask', async () => {
      await frame(wes.page).getByRole('tab', { name: 'Ask' }).click({ timeout: 5_000 })
      const box = frame(wes.page).locator('textarea, input[type=text]').last()
      await box.fill('Guest question')
      await box.press('Enter')
    })
    await wes.page.waitForTimeout(3_000)
    await step('shot 07-wes-ask', () => shot(wes.page, '07-wes-ask'))
    await step('claude runs', async () => c.claudeRuns().filter((a) => a[0] === '-p').map((a) => a.filter((x) => x.startsWith('--')).join(' ')))

    await step('desk clicks page Discuss', () => frame(c.page).getByRole('button', { name: /Discuss/ }).first().click({ timeout: 5_000 }))
    await c.page.waitForTimeout(600)
    await step('shot 08-desk-discuss-popover', () => shot(c.page, '08-desk-discuss-popover'))
    await step('popover focus', () => c.page.evaluate(() => (document.activeElement as HTMLElement | null)?.outerHTML.slice(0, 160)))
    await c.page.keyboard.press('Escape')
    await c.page.waitForTimeout(500)

    await step('reopen', () => c.hook('runPluginCommand', c.projectDir, 'test.kitdemo/open'))
    await c.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(600, 900))
    await owner.page.setViewportSize({ width: 390, height: 844 })
    await c.page.waitForTimeout(2_000)
    await step('shot 09-desk-narrow', () => shot(c.page, '09-desk-narrow'))
    await step('shot 09-owner-phone', () => shot(owner.page, '09-owner-phone'))
    await step('phone input font size', () => frame(owner.page).locator('textarea, input').evaluateAll((els) => els.map((e) => getComputedStyle(e).fontSize)))
  } finally {
    for (const b of opened) await b.close().catch(() => {})
    await close()
  }
})
