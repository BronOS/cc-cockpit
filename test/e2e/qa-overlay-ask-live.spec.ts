// QA, run 003 Verify (blind): Ask while a turn is live, with a held fake `claude` (test/fixtures/qa-bin/claude: a
// print session waits for a release file and records its pid).
//
//  1. A write guest's live Ask is killed at once on each narrowing of its access (S5 leo Q8: role to read, the plugin
//     hidden from guests, kick), not after the reconnect debounce. Positive control: untouched, it stays alive.
//  2. The owner has one chat per key shared by the owner's views: a question from the second view during a turn is
//     refused busy (D14); after the turn, the first view gets its answer.
//  3. A question over 10,000 characters is refused (S5 A9), 10,000 is taken.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import type { FrameLocator, Page } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { CockpitApi, OverlayInfo } from '../../src/shared/ipc'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { inviteGuest } from './guest-fixtures'
import { enableWebAccess, openBrowser, type WebAccessOn, type WebBrowser } from './web-fixtures'

const FIXTURES = join(__dirname, '..', 'fixtures')
const PLUGIN = 'test.overlaynotes'
const TITLE = 'Overlay notes'
const DOC = 'Fixture document: the quick brown fox.'

function invokeIn<T>(page: Page, channel: string, payload?: unknown): Promise<T> {
  return page.evaluate(
    async ([ch, p]) => ((window as unknown as { cockpit: CockpitApi }).cockpit.invoke as unknown as (c: string, q?: unknown) => Promise<unknown>)(ch, p),
    [channel, payload] as const
  ) as Promise<T>
}
const stack = (c: Cockpit): Promise<OverlayInfo[]> => c.hook<OverlayInfo[]>('overlays', c.projectDir)

/** A launch whose `claude` holds every print session until `release` exists; `pids()` are the held runs. */
async function launchSlow(): Promise<{ c: Cockpit; close(): Promise<void>; pids(): number[]; release(): void }> {
  const marker = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const pidFile = join(dirname(FIXTURES), `../test-results/qa-slow-${marker}.pids`)
  const releaseFile = join(dirname(FIXTURES), `../test-results/qa-slow-${marker}.release`)
  writeFileSync(pidFile, '')
  const PATH = [join(FIXTURES, 'qa-bin'), join(FIXTURES, 'bin'), dirname(process.execPath), process.env.PATH ?? ''].join(delimiter)
  const { cockpit: c, close } = await launchCockpit({ env: { PATH, QA_SLOW_PIDS: pidFile, QA_SLOW_RELEASE: releaseFile } })
  return {
    c,
    close,
    pids: () => (existsSync(pidFile) ? readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number) : []),
    release: () => writeFileSync(releaseFile, ''),
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function withFixture(c: Cockpit): Promise<void> {
  await c.hook('linkPlugin', join(FIXTURES, 'plugins', 'overlay-notes'))
  await c.hook('enablePlugin', c.projectDir, PLUGIN)
  await expect
    .poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.some((p) => p.id === PLUGIN && p.state === 'active'), { timeout: 20_000 })
    .toBe(true)
}

async function openDoc(c: Cockpit): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          await c.hook('runPluginCommand', c.projectDir, `${PLUGIN}/open`)
          return true
        } catch {
          return false
        }
      },
      { timeout: 15_000 }
    )
    .toBe(true)
  await expect.poll(async () => (await stack(c)).map((o) => o.title)).toEqual([TITLE])
}

async function copyOf(page: Page, features: string): Promise<FrameLocator> {
  await expect(page.getByRole('dialog', { name: TITLE })).toBeVisible({ timeout: 20_000 })
  const frame = page.frameLocator(`iframe[title="${TITLE}"]`)
  await expect(frame.locator('#doc p')).toContainText(DOC, { timeout: 20_000 })
  await expect(frame.locator('#features')).toHaveText(features, { timeout: 20_000 })
  return frame
}

async function ask(frame: FrameLocator, question: string): Promise<void> {
  await frame.locator('#question').fill(question)
  await frame.locator('#ask-send').click()
}

async function ownerBrowser(web: WebAccessOn): Promise<WebBrowser> {
  const browser = await openBrowser(web.link)
  const projects = browser.page.getByRole('list', { name: 'Open projects' }).getByRole('link')
  await expect(projects).toHaveCount(1)
  await projects.click()
  await expect(browser.page.locator('.tabs-pane')).toBeVisible()
  return browser
}

const NARROWINGS: Array<[string, (c: Cockpit, guestId: string) => Promise<unknown>]> = [
  ['role to read', (c, guestId) => invokeIn(c.page, 'guests.setRole', { guestId, role: 'read' })],
  ['plugin hidden from guests', (c) => invokeIn(c.page, 'settings.pluginGuestAccessSet', { pluginId: PLUGIN, target: 'app', value: 'hidden' })],
  ['kick', (c, guestId) => invokeIn(c.page, 'guests.kick', { guestId })],
]

for (const [name, narrow] of NARROWINGS) {
  test(`a write guest's live Ask is killed at once on ${name}`, async () => {
    test.setTimeout(180_000)
    const slow = await launchSlow()
    const { c } = slow
    let wesB: WebBrowser | undefined
    try {
      await withFixture(c)
      const web = await enableWebAccess(c)
      await invokeIn(c.page, 'settings.pluginGuestAccessSet', { pluginId: PLUGIN, target: 'app', value: 'shown' })
      const invited = await inviteGuest(c, { name: 'Wes', role: 'write' })
      wesB = await openBrowser(invited.link)
      await expect(wesB.page.getByTestId('guest-banner')).toHaveAttribute('data-role', 'write', { timeout: 20_000 })
      expect(web.projectId).toBeTruthy()
      await openDoc(c)
      const wes = await copyOf(wesB.page, 'notes ask discuss')
      await ask(wes, 'held question')
      await expect.poll(() => slow.pids().length, { timeout: 20_000 }).toBe(1)
      const pid = slow.pids()[0]!
      // Positive control: left alone, the held chat lives.
      await c.page.waitForTimeout(1_500)
      expect(alive(pid), 'the held Ask lives while nothing changes').toBe(true)
      const at = Date.now()
      await narrow(c, invited.guestId)
      await expect.poll(() => alive(pid), { timeout: 1_500, intervals: [50] }).toBe(false)
      expect(Date.now() - at).toBeLessThan(1_500)
    } finally {
      slow.release()
      await wesB?.close().catch(() => {})
      await slow.close()
    }
  })
}

test("the owner's second view asking during a turn is refused busy; the first view then gets its answer", async () => {
  test.setTimeout(180_000)
  const slow = await launchSlow()
  const { c } = slow
  let owner: WebBrowser | undefined
  try {
    await withFixture(c)
    // Trusted, so the owner's chat is a regular one (D15 does not matter here, but keep the owner's mode).
    writeFileSync(join(c.root, 'home', '.claude.json'), JSON.stringify({ projects: { [c.projectDir]: { hasTrustDialogAccepted: true } } }))
    const web = await enableWebAccess(c)
    owner = await ownerBrowser(web)
    await openDoc(c)
    const desk = await copyOf(c.page, 'notes ask discuss')
    const view = await copyOf(owner.page, 'notes ask discuss')
    await ask(desk, 'first view question')
    await expect.poll(() => slow.pids().length, { timeout: 20_000 }).toBe(1)
    await ask(view, 'second view question')
    await expect(view.locator('#answer')).toContainText('refused', { timeout: 10_000 })
    expect(slow.pids()).toHaveLength(1)
    slow.release()
    await expect(desk.locator('#answer')).toContainText('FAKE-ANSWER', { timeout: 20_000 })
  } finally {
    slow.release()
    await owner?.close().catch(() => {})
    await slow.close()
  }
})

test('a question over 10,000 characters is refused, 10,000 is taken', async () => {
  test.setTimeout(120_000)
  const slow = await launchSlow()
  const { c } = slow
  try {
    slow.release()
    await withFixture(c)
    await openDoc(c)
    const desk = await copyOf(c.page, 'notes ask discuss')
    const runs = (): number => c.claudeRuns().filter((a) => a[0] === '-p').length
    await ask(desk, 'q'.repeat(10_001))
    await expect(desk.locator('#answer')).toContainText('refused', { timeout: 10_000 })
    expect(runs()).toBe(0)
    await ask(desk, 'q'.repeat(10_000))
    await expect(desk.locator('#answer')).toContainText('FAKE-ANSWER', { timeout: 20_000 })
    expect(runs()).toBe(1)
  } finally {
    await slow.close()
  }
})
