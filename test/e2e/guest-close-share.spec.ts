// Re-verify N-B (task 07c): two guest flows through the real UI. A tab the owner shares with a guest whose invite is
// still pending (Share with <name> in the tab menu: the invite's scope, 02b) is there when the guest joins. And D-9:
// a write guest's Close of the owner's tab asks the owner; Keep open reaches the guest's notice at once, through
// main's tabs.guestCloseDone, not after the page's own 65 s fallback (guest-close.ts GUEST_CLOSE_WAIT_MS).
import type { Page } from '@playwright/test'
import type { CockpitApi, TabInfo } from '../../src/shared/ipc'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { guestList, inviteGuest } from './guest-fixtures'
import { enableWebAccess, openBrowser, type WebBrowser } from './web-fixtures'

const tabsOf = (page: Page): Promise<TabInfo[]> =>
  page.evaluate(() => (window as unknown as { cockpit: CockpitApi }).cockpit.invoke('tabs.list') as Promise<TabInfo[]>)

/**
 * A new shell tab on the owner's desktop, ready; its id. Nothing is typed into it: with two shell tabs, the
 * fixture's typeLine (`.terminal-view:not([hidden]) .xterm`) can resolve to the other, not visible, terminal on
 * this Mac (the split-views failures of report-07b), and the tab id is all these tests need.
 */
async function newShell(c: Cockpit): Promise<string> {
  const before = new Set((await tabsOf(c.page)).map((t) => t.id))
  await c.newTab('shell')
  await c.waitForTerminalText('FAKE-SHELL ready')
  let created: TabInfo | undefined
  await expect
    .poll(async () => {
      created = (await tabsOf(c.page)).find((t) => !before.has(t.id))
      return created !== undefined
    })
    .toBe(true)
  return created!.id
}

test("a tab shared with a pending invite (the owner's tab menu) is there when the guest joins", async () => {
  test.setTimeout(120_000)
  const { cockpit: c, close } = await launchCockpit()
  let guest: WebBrowser | undefined
  try {
    const first = await newShell(c)
    const second = await newShell(c)
    await enableWebAccess(c)
    const invited = await inviteGuest(c, { name: 'Pia', scope: [first] })
    expect((await guestList(c)).find((g) => g.id === invited.guestId)?.state).toBe('pending')

    // The second tab's menu: Share with Pia (unchecked), then checked from guests.changed.
    const tabs = c.page.getByRole('tab')
    await expect(tabs).toHaveCount(2)
    await tabs.nth(1).click({ button: 'right' })
    const share = c.page.getByRole('menuitemcheckbox', { name: 'Share with Pia' })
    await expect(share).toHaveAttribute('aria-checked', 'false')
    await share.click()
    await expect.poll(async () => (await guestList(c)).find((g) => g.id === invited.guestId)?.scope).toEqual([first, second])
    expect((await guestList(c)).find((g) => g.id === invited.guestId)?.state).toBe('pending')

    // The guest joins: both tabs, the second one live (its shell's prompt on the guest's screen).
    guest = await openBrowser(invited.link)
    await expect(guest.page.getByTestId('guest-banner')).toBeVisible({ timeout: 20_000 })
    await expect(guest.page.getByRole('tab')).toHaveCount(2)
    await guest.page.getByRole('tab').nth(1).click()
    await expect(guest.page.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true')
    await guest.waitForTerminalText('FAKE-SHELL ready')
  } finally {
    await guest?.close()
    await close()
  }
})

test("D-9: a write guest's Close of the owner's tab asks the owner; Keep open reaches the guest within a second", async () => {
  test.setTimeout(120_000)
  const { cockpit: c, close } = await launchCockpit()
  let guest: WebBrowser | undefined
  try {
    await newShell(c)
    await enableWebAccess(c)
    const invited = await inviteGuest(c, { name: 'Wren', role: 'write' })
    guest = await openBrowser(invited.link)
    const { page } = guest
    await expect(page.getByTestId('guest-banner')).toHaveAttribute('data-role', 'write', { timeout: 20_000 })
    const tab = page.getByRole('tab')
    await expect(tab).toHaveCount(1)

    // The guest's Close on a tab it did not open: an ask, and the guest's notice says so.
    await tab.hover()
    await page.getByRole('button', { name: /^Close / }).click()
    // The page's own question first (its process is running), as for the owner; Close sends the ask.
    await expect(page.getByText('Its process is still running.')).toBeVisible()
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    const notice = page.getByTestId('guest-close-notice')
    await expect(notice).toContainText('Asked Host to close')

    // The owner answers Keep open: the tab stays, and the guest's notice turns at once (not after 65 s).
    const ask = c.page.getByTestId('guest-close-ask')
    await expect(ask).toBeVisible()
    await expect(ask).toContainText('Wren asks to close')
    await c.page.getByTestId('guest-close-keep').click()
    const answeredAt = Date.now()
    await expect(notice).toHaveText(/Host kept the tab open\./, { timeout: 1000 })
    expect(Date.now() - answeredAt).toBeLessThan(1000)
    await expect(ask).toHaveCount(0)
    expect(await tabsOf(c.page)).toHaveLength(1)
    await expect(tab).toHaveCount(1)
  } finally {
    await guest?.close()
    await close()
  }
})
