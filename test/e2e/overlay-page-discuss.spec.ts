// Page-started Discuss (task 04, S6), end to end in real Chromium. The overlay-notes fixture is a perView,
// guests.aware plugin whose page has a Discuss button calling ccPanel.overlay.discuss(): the shell opens the toolbar's
// Discuss popover in page mode. What only a real browser shows is checked here (the arming and key rules themselves
// are unit-tested in page-discuss-model.test.ts):
//  1. The owner's desktop: the popover takes no focus (the keyboard stays in the page's frame), Send is disabled and a
//     click on it does nothing until it has armed (about a second of the popover seen), a press begun before arming
//     does not count even when released armed, Enter and Space do nothing (in the page and on a focused row), and an
//     armed click sends (the control: New Claude session opens a tab).
//  2. A read guest in a plain browser: its copy has no Discuss, and a discuss.open envelope forged on its frame's own
//     port is answered ok: false and opens nothing, on its screen or the owner's.
import type { FrameLocator, Locator, Page } from '@playwright/test'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { CockpitApi, TabInfo } from '../../src/shared/ipc'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { inviteGuest } from './guest-fixtures'
import { enableWebAccess, openBrowser, type WebAccessOn, type WebBrowser } from './web-fixtures'

const NOTES = 'test.overlaynotes'
const TITLE = 'Overlay notes'
const plugin = (name: string): string => join(__dirname, '..', 'fixtures', 'plugins', name)

async function enable(c: Cockpit): Promise<void> {
  await c.hook('linkPlugin', plugin('overlay-notes'))
  await c.hook('enablePlugin', c.projectDir, NOTES)
  await expect
    .poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.some((p) => p.id === NOTES && p.state === 'active'), { timeout: 15_000 })
    .toBe(true)
}

const openDoc = (c: Cockpit): Promise<unknown> => c.hook('runPluginCommand', c.projectDir, `${NOTES}/open`)
const claudeTabs = async (c: Cockpit): Promise<number> => (await c.hook<TabInfo[]>('tabs', c.projectDir)).filter((t) => t.kind === 'claude').length
const overlayOf = (page: Page): Locator => page.getByRole('dialog', { name: TITLE })
const frameOf = (page: Page): FrameLocator => overlayOf(page).frameLocator('iframe')
const popoverOf = (page: Page): Locator => page.locator('.discuss-popover[data-mode="page"]')

/** The copy is up: the fixture drew the document and listed the features the app gave it. */
async function liveCopy(page: Page): Promise<FrameLocator> {
  await expect(overlayOf(page)).toBeVisible({ timeout: 20_000 })
  const frame = frameOf(page)
  await expect(frame.locator('#doc p')).toContainText('quick brown fox', { timeout: 20_000 })
  return frame
}

/** Where the keyboard is: the shell document's focused element, and the page frame's. */
async function focusIn(page: Page, frame: FrameLocator): Promise<{ shell: string; page: string }> {
  const shell = await page.evaluate(() => document.activeElement?.tagName ?? '')
  const inPage = await frame.locator('body').evaluate(() => (document.hasFocus() ? (document.activeElement?.id ?? '') : ''))
  return { shell, page: inPage }
}

test('page-started Discuss: Send ignored before arming; Enter does nothing; focus stays in the page', async ({ cockpit: c }) => {
  test.setTimeout(90_000)
  const { page } = c
  await enable(c)
  await openDoc(c)
  const frame = await liveCopy(page)
  await expect(frame.locator('#features')).toContainText('discuss')
  const before = await claudeTabs(c)

  // The page asks (a real click in its frame, so the keyboard is there).
  await frame.locator('#discuss').click()
  const popover = popoverOf(page)
  await expect(popover).toBeVisible()
  await expect(popover).toHaveAttribute('aria-label', 'Discuss with Claude')
  // New session is the first row.
  await expect(popover.getByRole('option').first()).toHaveText(/New Claude session/)

  // Focus stays in the page: the shell's focused element is the frame, and in it the page's own button.
  expect(await focusIn(page, frame)).toEqual({ shell: 'IFRAME', page: 'discuss' })

  // Send is not armed yet, and a click on it does nothing.
  const send = popover.getByRole('button', { name: 'Send' })
  await expect(send).toBeDisabled()
  await send.click({ force: true })
  await page.waitForTimeout(300)
  await expect(popover).toBeVisible()
  expect(await claudeTabs(c)).toBe(before)

  // Enter in the page (its Discuss button has the focus) asks again: the open popover is all there is, nothing sent.
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  await expect(popoverOf(page)).toHaveCount(1)
  expect(await claudeTabs(c)).toBe(before)

  // Armed after about a second.
  await expect(send).toBeEnabled({ timeout: 5_000 })
  // On a row (focused by the click): Enter and Space send nothing.
  const newSession = popover.getByRole('option', { name: /New Claude session/ })
  await newSession.click()
  await expect(newSession).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.press(' ')
  await page.waitForTimeout(500)
  await expect(popover).toBeVisible()
  expect(await claudeTabs(c)).toBe(before)

  // A press begun before arming does not count, even released after Send armed. Cancel, wait out the 2 s cooldown,
  // and have the page ask again.
  await popover.getByRole('button', { name: 'Cancel' }).click()
  await expect(popover).toHaveCount(0)
  await page.waitForTimeout(2_500)
  await frame.locator('#discuss').click()
  await expect(popover).toBeVisible()
  await expect(send).toBeDisabled()
  const box = await send.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await expect(send).toBeEnabled({ timeout: 5_000 })
  await page.mouse.up()
  await page.waitForTimeout(800)
  await expect(popover).toBeVisible()
  expect(await claudeTabs(c)).toBe(before)

  // The control: an armed click on Send, New Claude session selected, opens the tab.
  await popover.getByRole('option', { name: /New Claude session/ }).click()
  await send.click()
  await expect.poll(() => claudeTabs(c), { timeout: 15_000 }).toBe(before + 1)
  await expect(popover).toHaveCount(0)
})

async function invoke<T>(c: Cockpit, channel: string, payload?: unknown): Promise<T> {
  return c.page.evaluate(
    async ([ch, p]) => ((window as unknown as { cockpit: CockpitApi }).cockpit.invoke as unknown as (c: string, q?: unknown) => Promise<unknown>)(ch, p),
    [channel, payload] as const
  ) as Promise<T>
}

/** A guest in a plain browser: the invite link, redeemed by the page itself, landed in the project. */
async function guestBrowser(c: Cockpit, web: WebAccessOn, name: string, role: 'read' | 'write'): Promise<WebBrowser> {
  const invited = await inviteGuest(c, { name, role })
  const guest = await openBrowser(invited.link)
  try {
    await expect(guest.page).toHaveURL(`${web.origin}/?project=${encodeURIComponent(web.projectId)}`, { timeout: 20_000 })
    await expect(guest.page.getByTestId('guest-banner')).toHaveAttribute('data-role', role, { timeout: 20_000 })
    return guest
  } catch (err) {
    await guest.close()
    throw err
  }
}

test('a read guest\'s request opens nothing', async () => {
  test.setTimeout(180_000)
  const { cockpit: c, close } = await launchCockpit()
  let guest: WebBrowser | undefined
  try {
    await enable(c)
    const web = await enableWebAccess(c)
    await invoke(c, 'settings.pluginGuestAccessSet', { pluginId: NOTES, target: 'app', value: 'shown' })
    guest = await guestBrowser(c, web, 'Rae', 'read')
    // Every frame of the guest's page keeps the port the shell hands it (the SDK keeps its own reference too), so
    // the spec can post on it what a page script could: a forged envelope past the SDK's missing discuss().
    await guest.page.addInitScript(() => {
      const w = window as unknown as { __ccPorts?: MessagePort[] }
      window.addEventListener(
        'message',
        (e) => {
          if (e.ports && e.ports.length) w.__ccPorts = [...(w.__ccPorts ?? []), ...e.ports]
        },
        true
      )
    })
    await guest.page.reload()
    await expect(guest.page.getByTestId('guest-banner')).toHaveAttribute('data-role', 'read', { timeout: 20_000 })

    await openDoc(c)
    const desk = await liveCopy(c.page)
    await expect(desk.locator('#features')).toContainText('discuss')
    const rae = await liveCopy(guest.page)
    // The read guest's copy is told there is no Discuss (the SDK gives it no discuss()); it reads the notes.
    await expect(rae.locator('#features')).toHaveText('notes')
    await expect(rae.locator('#discuss')).toBeHidden()

    // Forged on its frame's own port: answered ok: false, and nothing opens.
    const answer = await rae.locator('body').evaluate(async () => {
      const ports = (window as unknown as { __ccPorts?: MessagePort[] }).__ccPorts ?? []
      if (!ports.length) return 'no port captured'
      const port = ports[ports.length - 1]!
      return await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('no answer'), 5_000)
        port.addEventListener('message', (e: MessageEvent) => {
          const data: unknown = e.data
          const text = typeof data === 'string' ? data : JSON.stringify(data)
          if (!text.includes('"re":9001')) return
          clearTimeout(timer)
          resolve(text)
        })
        port.postMessage(JSON.stringify({ $cc: 1, id: 9001, op: 'discuss.open', args: {} }))
      })
    })
    expect(answer).toMatch(/"ok":false/)
    await guest.page.waitForTimeout(1_000)
    await expect(popoverOf(guest.page)).toHaveCount(0)
    await expect(guest.page.locator('.discuss-popover')).toHaveCount(0)
    await expect(popoverOf(c.page)).toHaveCount(0)
    await expect(c.page.locator('.discuss-popover')).toHaveCount(0)
  } finally {
    await guest?.close()
    await close()
  }
})
