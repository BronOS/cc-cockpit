// QA, run 003 Verify: the lead's six questions from the blind review's "not traced" list, each as a check with a
// positive control (fixtures qa-bigkit, qa-part; the fake claude wrapper test/fixtures/qa-bin/claude).
//  1. A very large kit state to a browser view: one connect per view, no socket close, no reload loop.
//  2. A failure text naming a host path: the owner sees it, a guest's copy and socket never do (kit and Ask).
//  3. A part hidden from a guest: its onAsk text never reaches the guest's Ask (shown, it does).
//  4. Middle-click or target=_blank on a document or Original-frame link in a browser view opens no tab directly.
//  5. Space on the page Discuss popover: held across arming, or on Send once armed, sends nothing.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import type { FrameLocator, Page } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { CockpitApi, OverlayInfo, TabInfo } from '../../src/shared/ipc'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { inviteGuest } from './guest-fixtures'
import { enableWebAccess, openBrowser, type WebAccessOn, type WebBrowser } from './web-fixtures'

const FIXTURES = join(__dirname, '..', 'fixtures')
const NOTES = 'test.overlaynotes'
const BIG = 'test.qabigkit'

function invokeIn<T>(page: Page, channel: string, payload?: unknown): Promise<T> {
  return page.evaluate(
    async ([ch, p]) => ((window as unknown as { cockpit: CockpitApi }).cockpit.invoke as unknown as (c: string, q?: unknown) => Promise<unknown>)(ch, p),
    [channel, payload] as const
  ) as Promise<T>
}
const stack = (c: Cockpit): Promise<OverlayInfo[]> => c.hook<OverlayInfo[]>('overlays', c.projectDir)
const notifications = (c: Cockpit): Promise<string[]> => c.hook<string[]>('notifications')

async function link(c: Cockpit, dir: string, id: string): Promise<void> {
  await c.hook('linkPlugin', join(FIXTURES, 'plugins', dir))
  await c.hook('enablePlugin', c.projectDir, id)
  await expect.poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.some((p) => p.id === id && p.state === 'active'), { timeout: 20_000 }).toBe(true)
}
async function run(c: Cockpit, command: string): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          await c.hook('runPluginCommand', c.projectDir, command)
          return true
        } catch {
          return false
        }
      },
      { timeout: 15_000 }
    )
    .toBe(true)
}
async function ownerBrowser(web: WebAccessOn): Promise<WebBrowser> {
  const browser = await openBrowser(web.link)
  await browser.page.getByRole('list', { name: 'Open projects' }).getByRole('link').click()
  await expect(browser.page.locator('.tabs-pane')).toBeVisible()
  return browser
}
async function guest(c: Cockpit, name: string, role: 'read' | 'write'): Promise<WebBrowser> {
  const b = await openBrowser((await inviteGuest(c, { name, role })).link)
  await expect(b.page.getByTestId('guest-banner')).toHaveAttribute('data-role', role, { timeout: 20_000 })
  return b
}
/** Every websocket frame text the page gets, and how many sockets it opened, from now on (a reload first). */
async function wiretap(b: WebBrowser): Promise<{ frames: string[]; sockets(): number }> {
  const frames: string[] = []
  let sockets = 0
  b.page.on('websocket', (ws) => {
    sockets++
    ws.on('framereceived', (f) => frames.push(typeof f.payload === 'string' ? f.payload : f.payload.toString('utf8')))
  })
  await b.page.reload()
  await expect(b.page.locator('.tabs-pane')).toBeVisible({ timeout: 20_000 })
  return { frames, sockets: () => sockets }
}
const bigFrame = (p: Page): FrameLocator => p.frameLocator('iframe[title="QA big kit"]')
const trust = (c: Cockpit): void =>
  writeFileSync(join(c.root, 'home', '.claude.json'), JSON.stringify({ projects: { [c.projectDir]: { hasTrustDialogAccepted: true } } }))
const qaPath = (env: Record<string, string>): Record<string, string> => ({
  PATH: [join(FIXTURES, 'qa-bin'), join(FIXTURES, 'bin'), dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
  ...env,
})

for (const [cmd, mb] of [['open10', 10], ['open36', 36]] as const) {
  test(`a ${mb} MB kit state reaches a browser view once: no socket close, no reload loop`, async () => {
    test.setTimeout(240_000)
    const { cockpit: c, close } = await launchCockpit()
    let owner: WebBrowser | undefined
    try {
      await link(c, 'qa-bigkit', BIG)
      const web = await enableWebAccess(c)
      owner = await ownerBrowser(web)
      const tap = await wiretap(owner)
      let frameLoads = 0
      owner.page.on('framenavigated', (f) => {
        if (f.url().includes('demo.html')) frameLoads++
      })
      await run(c, `${BIG}/${cmd}`)
      // Positive control: the desktop copy draws it.
      await expect(bigFrame(c.page).locator('#main')).toContainText('BIG-1: links', { timeout: 60_000 })
      const browserShows = await expect(bigFrame(owner.page).locator('#main'))
        .toContainText(/BIG-1: links|too large/, { timeout: 60_000 })
        .then(() => 'shown', (e: unknown) => `not shown: ${String(e).split('\n')[0]}`)
      await c.page.waitForTimeout(15_000)
      const connects = (await notifications(c)).filter((n) => n.startsWith('connect '))
      const info = { browserShows, connects, sockets: tap.sockets(), frameLoads, mainText: (await bigFrame(owner.page).locator('#main').innerText().catch(() => '')).slice(0, 80) }
      test.info().annotations.push({ type: 'qa', description: JSON.stringify(info) })
      expect(browserShows, JSON.stringify(info)).toBe('shown')
      expect(tap.sockets(), JSON.stringify(info)).toBe(1)
      expect(frameLoads, JSON.stringify(info)).toBe(1)
      expect(connects, JSON.stringify(info)).toHaveLength(2)
    } finally {
      await owner?.close().catch(() => {})
      await close()
    }
  })
}

test('a kit failure naming a host path: the owner sees it, a guest copy and socket never do', async () => {
  test.setTimeout(240_000)
  const { cockpit: c, close } = await launchCockpit()
  const opened: WebBrowser[] = []
  try {
    await link(c, 'qa-bigkit', BIG)
    await enableWebAccess(c)
    await invokeIn(c.page, 'settings.pluginGuestAccessSet', { pluginId: BIG, target: 'app', value: 'shown' })
    const wes = await guest(c, 'Wes', 'write')
    opened.push(wes)
    const rae = await guest(c, 'Rae', 'read')
    opened.push(rae)
    const taps = [await wiretap(wes), await wiretap(rae)]
    await run(c, `${BIG}/failpath`)
    await expect(bigFrame(c.page).locator('body')).toContainText('/home/owner/private/project/.env', { timeout: 20_000 })
    for (const b of [wes, rae]) await expect(bigFrame(b.page).locator('#main')).not.toContainText('Loading', { timeout: 20_000 })
    for (const b of [wes, rae]) expect(await bigFrame(b.page).locator('body').innerText()).not.toContain('/home/owner')
    for (const t of taps) expect(t.frames.filter((f) => f.includes('/home/owner'))).toEqual([])
  } finally {
    for (const b of opened) await b.close().catch(() => {})
    await close()
  }
})

test("an Ask failure naming the project path never reaches a write guest's copy or socket", async () => {
  test.setTimeout(240_000)
  const { cockpit: c, close } = await launchCockpit({ env: qaPath({ QA_FAIL_CWD: '1' }) })
  let wes: WebBrowser | undefined
  try {
    trust(c)
    await link(c, 'overlay-notes', NOTES)
    await enableWebAccess(c)
    await invokeIn(c.page, 'settings.pluginGuestAccessSet', { pluginId: NOTES, target: 'app', value: 'shown' })
    wes = await guest(c, 'Wes', 'write')
    const tap = await wiretap(wes)
    await run(c, `${NOTES}/open`)
    const doc = (p: Page): FrameLocator => p.frameLocator('iframe[title="Overlay notes"]')
    await expect(doc(wes.page).locator('#features')).toHaveText('notes ask discuss', { timeout: 20_000 })
    // Positive control: the owner's own failed Ask (the owner may see the path).
    await doc(c.page).locator('#question').fill('owner q')
    await doc(c.page).locator('#ask-send').click()
    await expect(doc(c.page).locator('#answer')).not.toHaveText('', { timeout: 20_000 })
    const ownerText = await doc(c.page).locator('#answer').innerText()
    await doc(wes.page).locator('#question').fill('guest q')
    await doc(wes.page).locator('#ask-send').click()
    await expect(doc(wes.page).locator('#answer')).not.toHaveText('', { timeout: 20_000 })
    const wesText = await doc(wes.page).locator('#answer').innerText()
    test.info().annotations.push({ type: 'qa', description: JSON.stringify({ ownerText, wesText }) })
    expect(wesText).not.toContain(c.projectDir)
    expect(tap.frames.filter((f) => f.includes(c.projectDir))).toEqual([])
  } finally {
    await wes?.close().catch(() => {})
    await close()
  }
})

test("a part hidden from a guest: its onAsk text never reaches the guest's Ask; shown, it does", async () => {
  test.setTimeout(240_000)
  const stdinLog = join(dirname(FIXTURES), `../test-results/qa-stdin-${process.pid}-${Date.now()}.log`)
  writeFileSync(stdinLog, '')
  const { cockpit: c, close } = await launchCockpit({ env: qaPath({ QA_STDIN_LOG: stdinLog }) })
  let wes: WebBrowser | undefined
  const sent = (): string => (existsSync(stdinLog) ? readFileSync(stdinLog, 'utf8') : '')
  try {
    trust(c)
    await link(c, 'overlay-notes', NOTES)
    await link(c, 'qa-part', 'test.qapart')
    await enableWebAccess(c)
    await invokeIn(c.page, 'settings.pluginGuestAccessSet', { pluginId: NOTES, target: 'app', value: 'shown' })
    wes = await guest(c, 'Wes', 'write')
    await c.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 1000))
    await wes.page.setViewportSize({ width: 1440, height: 1000 })
    await run(c, `${NOTES}/open`)
    const doc = (p: Page): FrameLocator => p.frameLocator('iframe[title="Overlay notes"]')
    const part = (p: Page): FrameLocator => p.frameLocator('iframe[title="QA part"]')
    await expect(part(c.page).locator('body')).toContainText('doc:fixture-1', { timeout: 20_000 })
    // Positive control: the owner's Ask carries the part's text.
    await doc(c.page).locator('#question').fill('owner q')
    await doc(c.page).locator('#ask-send').click()
    await expect(doc(c.page).locator('#answer')).toContainText('FAKE-ANSWER', { timeout: 20_000 })
    expect(sent()).toContain('PART-ASK-SECRET-9931')
    writeFileSync(stdinLog, '')

    await expect(doc(wes.page).locator('#features')).toHaveText('notes ask discuss', { timeout: 20_000 })
    await expect(part(wes.page).locator('body')).toHaveCount(0)
    await doc(wes.page).locator('#question').fill('guest q')
    await doc(wes.page).locator('#ask-send').click()
    await expect(doc(wes.page).locator('#answer')).toContainText('FAKE-ANSWER', { timeout: 20_000 })
    expect(sent()).toContain('guest q')
    expect(sent()).not.toContain('PART-ASK-SECRET-9931')

    // Shown to guests: the guest's view gets the part, and its next Ask carries the text.
    writeFileSync(stdinLog, '')
    await invokeIn(c.page, 'settings.pluginGuestAccessSet', { pluginId: 'test.qapart', target: 'app', value: 'shown' })
    await expect(part(wes.page).locator('body')).toContainText('doc:fixture-1', { timeout: 30_000 })
    await doc(wes.page).locator('#question').fill('guest q2')
    await doc(wes.page).locator('#ask-send').click()
    await expect(doc(wes.page).locator('#answer')).toContainText('FAKE-ANSWER', { timeout: 20_000 })
    expect(sent()).toContain('PART-ASK-SECRET-9931')
  } finally {
    await wes?.close().catch(() => {})
    await close()
  }
})

test('links in a browser view: middle-click and target=_blank in the document and the Original frame open no tab directly', async () => {
  test.setTimeout(240_000)
  const { cockpit: c, close } = await launchCockpit()
  let owner: WebBrowser | undefined
  try {
    await link(c, 'qa-bigkit', BIG)
    const web = await enableWebAccess(c)
    owner = await ownerBrowser(web)
    const popups: string[] = []
    owner.page.context().on('page', (p) => popups.push(p.url() || '(blank)'))
    await run(c, `${BIG}/open`)
    const f = bigFrame(owner.page)
    await expect(f.locator('#main')).toContainText('BIG-1: links', { timeout: 30_000 })
    const tried: Record<string, string> = {}
    const attempt = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      tried[name] = await fn().then(() => 'done', (e: unknown) => `error: ${String(e).split('\n')[0]}`)
      await owner!.page.waitForTimeout(1_000)
    }
    await attempt('doc plain middle', () => f.locator('a', { hasText: 'plain link' }).click({ button: 'middle' }))
    await attempt('doc blank click', () => f.locator('a', { hasText: 'blank link' }).click())
    await attempt('doc blank middle', () => f.locator('a', { hasText: 'blank link' }).click({ button: 'middle' }))
    await attempt('doc plain ctrl', () => f.locator('a', { hasText: 'plain link' }).click({ modifiers: ['Control'] }))
    const orig = f.frameLocator('iframe')
    await attempt('original blank click', () => orig.locator('a', { hasText: 'original blank link' }).click({ timeout: 5_000 }))
    await attempt('original plain middle', () => orig.locator('a', { hasText: 'original plain' }).click({ button: 'middle', timeout: 5_000 }))
    await owner.page.waitForTimeout(1_500)
    // What a person would see instead: core's link ask in the view (or a link notice).
    const dialogs = await owner.page.getByRole('dialog').allInnerTexts()
    test.info().annotations.push({ type: 'qa', description: JSON.stringify({ tried, popups, dialogs: dialogs.map((d) => d.slice(0, 120)) }) })
    expect(popups, JSON.stringify({ tried, popups })).toEqual([])
  } finally {
    await owner?.close().catch(() => {})
    await close()
  }
})

test('page Discuss popover: Space held across arming, or Space and Enter on the armed Send, send nothing; a click does', async ({ cockpit: c }) => {
  test.setTimeout(120_000)
  const claudeTabs = async (): Promise<number> => (await c.hook<TabInfo[]>('tabs', c.projectDir)).filter((t) => t.kind === 'claude').length
  await link(c, 'overlay-notes', NOTES)
  await run(c, `${NOTES}/open`)
  await expect.poll(async () => (await stack(c)).length).toBe(1)
  const doc = c.page.frameLocator('iframe[title="Overlay notes"]')
  await expect(doc.locator('#features')).toContainText('discuss', { timeout: 20_000 })
  const before = await claudeTabs()
  const popover = c.page.locator('.discuss-popover[data-mode="page"]')
  const send = popover.getByRole('button', { name: 'Send' })

  // Space pressed on the option before arming and released after it.
  await doc.locator('#discuss').click()
  await expect(send).toBeDisabled()
  await popover.getByRole('option', { name: /New Claude session/ }).click()
  await c.page.keyboard.down(' ')
  await expect(send).toBeEnabled({ timeout: 5_000 })
  await c.page.keyboard.up(' ')
  await c.page.waitForTimeout(600)
  expect(await claudeTabs()).toBe(before)

  // Focus on the armed Send: Space and Enter do nothing.
  await send.focus()
  await c.page.keyboard.press(' ')
  await c.page.keyboard.press('Enter')
  await c.page.waitForTimeout(600)
  await expect(popover).toBeVisible()
  expect(await claudeTabs()).toBe(before)

  // Positive control: a click sends.
  await send.click()
  await expect.poll(() => claudeTabs(), { timeout: 15_000 }).toBe(before + 1)
})
