// qa-chloe blind verify (not for merge): the owner's and the guest's screens through the real UI, with a
// screenshot of each into $QA_SHOTS (default test-results/qa-shots). Asserts the brief's texts: the invite
// dialog's loopback (D-5, D-35), scrollback (D-13) and write warnings; the read guest's shell (banner, no
// New tab, no settings); a write guest saving a file from Files + Editor; presence; kick.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { CockpitApi } from '../../src/shared/ipc'
import { pluginActive } from './download-fixtures'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { guestList } from './guest-fixtures'
import { enableWebAccess, openBrowser, type WebBrowser } from './web-fixtures'

const SHOTS = process.env.QA_SHOTS ?? join(__dirname, '..', '..', 'test-results', 'qa-shots')
let n = 0
async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${String(++n).padStart(2, '0')}-${name}.png`) })
}

async function invoke<T>(c: Cockpit, channel: string, payload?: unknown): Promise<T> {
  return c.page.evaluate(
    async ([ch, p]) => ((window as unknown as { cockpit: CockpitApi }).cockpit.invoke as unknown as (c: string, q?: unknown) => Promise<unknown>)(ch, p),
    [channel, payload] as const
  ) as Promise<T>
}

test('qa walk: invite dialog texts, read guest shell, upgrade, write guest saves a file in the editor, kick', async () => {
  test.setTimeout(240_000)
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  let guest: WebBrowser | undefined
  try {
    writeFileSync(join(c.projectDir, 'notes.txt'), 'line one\n')
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    await pluginActive(c, 'cockpit.files')
    await enableWebAccess(c)
    await invoke(c, 'settings.pluginGuestAccessSet', { pluginId: 'cockpit.files', target: 'app', value: 'shown' })
    await invoke(c, 'settings.pluginGuestAccessSet', { pluginId: 'cockpit.editor', target: 'app', value: 'shown' })

    // The invite dialog on a loopback-only gateway.
    await c.page.getByRole('button', { name: 'Share' }).click()
    const dialog = c.page.getByTestId('guest-invite-dialog')
    await expect(dialog).toBeVisible()
    await shot(c.page, 'owner-invite-dialog-read')
    const readText = await dialog.innerText()
    await dialog.getByRole('radio', { name: /Write/ }).check()
    await shot(c.page, 'owner-invite-dialog-write')
    const writeText = await dialog.innerText()
    console.log('QA invite dialog (write):\n' + writeText)
    expect.soft(writeText, 'D-13 scrollback line').toContain('Scrollback from before now is visible in shared tabs')
    expect.soft(writeText, 'write warning').toMatch(/can run anything as you/i)
    expect.soft(readText, 'no write warning for a read invite').not.toMatch(/can run anything as you/i)
    expect.soft(writeText, 'lifetime choices').toMatch(/1 day/i)
    await dialog.getByRole('radio', { name: 'Read-only' }).check()
    await dialog.getByRole('textbox').first().fill('Ola')
    await dialog.getByRole('button', { name: 'Create invite' }).click()
    const link = (await dialog.getByTestId('guest-invite-link').innerText()).trim()
    await shot(c.page, 'owner-invite-link')
    const created = await dialog.innerText()
    console.log('QA invite created:\n' + created)
    expect.soft(created + readText, 'D-35 loopback warning').toMatch(/loopback|this computer only|external|network/i)
    await dialog.getByRole('button', { name: 'Done' }).click()

    // Read guest.
    guest = await openBrowser(link)
    const { page } = guest
    await expect(page.getByTestId('guest-banner')).toContainText('read-only', { timeout: 20_000 })
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('')
    await shot(page, 'guest-read-shell')
    console.log('QA guest banner:', await page.getByTestId('guest-banner').innerText())
    expect.soft(await page.getByRole('button', { name: /new tab|^\+$/i }).count(), 'read guest has New tab').toBe(0)
    expect.soft(await page.getByRole('button', { name: /settings/i }).count(), 'read guest has a settings button').toBe(0)
    // Files panel as a read guest.
    const filesBtn = page.getByRole('button', { name: /^Files/ })
    if ((await filesBtn.count()) > 0) {
      await filesBtn.first().click()
      await page.waitForTimeout(800)
      await shot(page, 'guest-read-files')
      const files = page.frameLocator('section.panel[aria-label="Files"] iframe')
      await files.getByText('notes.txt').click({ button: 'right' }).catch(() => {})
      await page.waitForTimeout(500)
      await shot(page, 'guest-read-files-menu')
      console.log('QA read guest files menu:', await files.locator('body').innerText().catch(() => '?'))
      // D-2: a read guest cannot open a page tab, whatever the Files row offers.
      const before = (await c.hook<Array<{ id: string }>>('tabs', c.projectDir)).length
      await page.keyboard.press('Escape')
      await files.getByText('notes.txt').click()
      await page.waitForTimeout(1000)
      console.log('QA owner overlays after the READ guest clicked a file:', JSON.stringify(await c.page.locator('.overlay').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))))
      await files.getByText('Edit', { exact: true }).first().click({ timeout: 5000 }).catch((e) => console.log('QA read Edit click failed', String(e).slice(0, 120)))
      await page.waitForTimeout(1500)
      await shot(page, 'guest-read-after-edit-click')
      const afterTabs = await c.hook<Array<{ id: string; kind: string }>>('tabs', c.projectDir)
      console.log('QA read guest Edit -> owner tabs', before, '->', afterTabs.length, JSON.stringify(afterTabs.map((t) => t.kind)))
      expect.soft(afterTabs.length, 'a read guest opened a page tab (D-2)').toBe(before)
    } else console.log('QA no Files button for the read guest')

    // Presence on the owner side.
    await c.page.locator('.guest-chip').click()
    await shot(c.page, 'owner-guest-list')
    console.log('QA owner guest list:\n' + (await c.page.getByRole('dialog', { name: 'Guests' }).innerText()))

    // Upgrade to write.
    await c.page.getByRole('radiogroup', { name: "Ola's role" }).getByRole('radio', { name: 'Write' }).click()
    const upgrade = c.page.getByTestId('guest-upgrade-confirm')
    await shot(c.page, 'owner-upgrade-confirm')
    console.log('QA upgrade confirm:\n' + (await upgrade.innerText()))
    await expect(upgrade.getByRole('button', { name: 'Allow write' })).toBeEnabled({ timeout: 5000 })
    await upgrade.getByRole('button', { name: 'Allow write' }).click()
    await expect(page.getByTestId('guest-banner')).toHaveAttribute('data-role', 'write', { timeout: 15_000 })
    await shot(page, 'guest-write-shell')

    // Write guest: open notes.txt from Files into the editor, type, save.
    const filesBtn2 = page.getByRole('button', { name: /^Files/ })
    if (!(await page.locator('section.panel[aria-label="Files"]').isVisible())) await filesBtn2.first().click()
    const files2 = page.frameLocator('section.panel[aria-label="Files"] iframe')
    await files2.getByText('notes.txt').click()
    await files2.getByText('Edit', { exact: true }).first().click()
    await expect(page.getByRole('tab', { name: /notes\.txt/ })).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(1500)
    await shot(page, 'guest-write-editor-open')
    console.log('QA iframes:', JSON.stringify(await page.locator('iframe').evaluateAll((els) => els.map((e) => [e.getAttribute('title'), e.getAttribute('src')?.slice(0, 80)]))))
    const editorFrame = page.frameLocator('iframe[src*="cockpit.editor"]').last()
    await editorFrame.locator('.cm-content').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' edited by Ola')
    await page.keyboard.press('Meta+s')
    await expect.poll(() => readFileSync(join(c.projectDir, 'notes.txt'), 'utf8'), { timeout: 10_000 }).toContain('edited by Ola')
    await shot(page, 'guest-write-saved')
    await shot(c.page, 'owner-after-guest-save')
    // Files' Edit opened a Review overlay on the owner's screen (reported); close it to go on.
    for (let i = 0; i < 8 && (await c.page.locator('.overlay').count()) > 0; i++) {
      console.log('QA owner overlays now:', JSON.stringify(await c.page.locator('.overlay').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))))
      await c.page.locator('.overlay-close').last().click({ timeout: 3000 }).catch(() => {})
    }

    // Kick.
    const list = c.page.getByRole('dialog', { name: 'Guests' })
    if (!(await list.isVisible())) await c.page.locator('.guest-chip').click()
    await list.getByRole('button', { name: 'Kick' }).click()
    await expect(page.getByText(/removed you/)).toBeVisible({ timeout: 1500 })
    await shot(page, 'guest-kicked')
    await expect.poll(async () => (await guestList(c)).length).toBe(0)

    // None mode refuses invites (D-1). Q3: the dialog stays reachable and says why at once, Create disabled.
    await invoke(c, 'settings.webAccessSet', { value: { mode: 'none' } })
    await expect.poll(async () => JSON.stringify(await invoke(c, 'settings.webAccess'))).toContain('"mode":"none"')
    await expect(c.page.getByRole('button', { name: 'Share' }), 'no Share entry under None: the reason cannot be seen (Q3)').toHaveCount(1)
    await c.page.getByRole('button', { name: 'Share' }).click()
    const nd = c.page.getByTestId('guest-invite-dialog')
    await expect(nd).toContainText('Guests need a sign-in mode')
    await expect(nd.getByRole('button', { name: 'Create invite' })).toBeDisabled()
    await shot(c.page, 'reverify-owner-invite-none-mode')
    expect(await guestList(c)).toEqual([])
  } finally {
    await guest?.close()
    await close()
  }
})

test("qa re-verify: a write guest's file click opens its own editor tab, nothing on the owner's screen; a binary file is refused on the guest's side", async () => {
  test.setTimeout(150_000)
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  let guest: WebBrowser | undefined
  try {
    writeFileSync(join(c.projectDir, 'a.txt'), 'aaa\n')
    writeFileSync(join(c.projectDir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 254, 0, 0, 7, 0]))
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    await pluginActive(c, 'cockpit.files')
    const web = await enableWebAccess(c)
    expect(web.origin).toBeTruthy()
    // Q3 control on a fresh app: the Share entry in link mode, under None, and back.
    const shareBtn = c.page.getByRole('button', { name: 'Share' })
    await expect(shareBtn).toHaveCount(1)
    await invoke(c, 'settings.webAccessSet', { value: { mode: 'none' } })
    await expect.poll(async () => JSON.stringify(await invoke(c, 'settings.webAccess'))).toContain('"mode":"none"')
    await c.page.waitForTimeout(1000)
    const underNone = await shareBtn.count()
    console.log('QA fresh app: Share buttons under None =', underNone)
    if (underNone > 0) {
      await shareBtn.click()
      const nd = c.page.getByTestId('guest-invite-dialog')
      console.log('QA fresh None dialog has the reason:', (await nd.innerText()).includes('Guests need a sign-in mode'), 'Create disabled:', await nd.getByRole('button', { name: 'Create invite' }).isDisabled())
      await nd.getByRole('button', { name: 'Cancel' }).click()
    }
    await invoke(c, 'settings.webAccessSet', { value: { mode: 'link' } })
    await expect(shareBtn).toHaveCount(1)
    await invoke(c, 'settings.pluginGuestAccessSet', { pluginId: 'cockpit.files', target: 'app', value: 'shown' })
    await invoke(c, 'settings.pluginGuestAccessSet', { pluginId: 'cockpit.editor', target: 'app', value: 'shown' })
    const answer = await c.hook<{ ok: boolean; link: string; guestId: string }>('guestInvite', c.projectDir, { name: 'Wes', role: 'write', scope: 'all', lifetime: '1d' })
    guest = await openBrowser(answer.link)
    const { page } = guest
    await expect(page.getByTestId('guest-banner')).toHaveAttribute('data-role', 'write', { timeout: 20_000 })
    const ownerOverlays = c.page.locator('.overlay')
    await expect(ownerOverlays).toHaveCount(0)

    // Q1: the guest clicks a text file: its own editor tab opens; the owner's screen gets no overlay.
    if (!(await page.locator('section.panel[aria-label="Files"]').isVisible())) await page.getByRole('button', { name: /^Files/ }).first().click()
    const gf = page.frameLocator('section.panel[aria-label="Files"] iframe')
    await gf.getByText('a.txt').click()
    await expect(page.getByRole('tab', { name: /a\.txt/ })).toBeVisible({ timeout: 10_000 })
    await expect(c.page.getByRole('tab', { name: /a\.txt/ })).toBeVisible({ timeout: 10_000 })
    await c.page.waitForTimeout(1500) // an absence: give a late overlay its chance (it came before the tab in the bug)
    await shot(c.page, 'reverify-owner-after-guest-file-click')
    await expect(ownerOverlays, 'an overlay opened on the owner screen from a guest click').toHaveCount(0)
    await expect(page.locator('.overlay')).toHaveCount(0)

    // Q4: a tab the guest opens itself (New tab > Shell): the owner's strip names the guest, never its id.
    const ownerCount = (await c.hook<unknown[]>('tabs', c.projectDir)).length
    await page.getByRole('button', { name: 'New tab' }).click()
    await page.getByRole('menuitem', { name: 'Shell' }).click()
    await expect.poll(async () => (await c.hook<unknown[]>('tabs', c.projectDir)).length).toBe(ownerCount + 1)
    const tabs = await c.hook<Array<{ id: string; openedByGuest?: string }>>('tabs', c.projectDir)
    console.log('QA openedByGuest values:', JSON.stringify(tabs.map((t) => t.openedByGuest ?? null)))
    const labels = await c.page.getByRole('tab').evaluateAll((els) => els.map((e) => [e.getAttribute('title'), e.getAttribute('aria-label'), (e as HTMLElement).innerText].join(' / ')))
    console.log('QA owner tab labels:', JSON.stringify(labels))
    const guestTab = c.page.getByRole('tab').last()
    await guestTab.hover()
    await c.page.waitForTimeout(800)
    const tips = await c.page.locator('[role=tooltip], .tooltip').allInnerTexts()
    console.log('QA tooltip on the guest tab:', JSON.stringify(tips))
    await shot(c.page, 'reverify-owner-guest-tab-hover')
    const all = labels.join(' ') + ' ' + tips.join(' ')
    expect(all, 'the opened-by label names the guest').toContain('Wes')
    expect(all, 'the opened-by label shows the guest id').not.toContain(answer.guestId)

    // New: a binary file: refused with a clear line for the guest, nothing for the owner, no new tab.
    const before = (await c.hook<unknown[]>('tabs', c.projectDir)).length
    const guestTextBefore = await page.locator('body').innerText()
    await gf.getByText('blob.bin').click()
    let shown = ''
    await expect
      .poll(async () => {
        const t = (await page.locator('body').innerText()) + '\n' + (await gf.locator('body').innerText().catch(() => ''))
        shown = t.split('\n').filter((l) => !guestTextBefore.includes(l) && /binary|text|open|can.?t|cannot/i.test(l)).join(' | ')
        return shown.length > 0
      }, { timeout: 8000 })
      .toBe(true)
    console.log('QA guest line for the binary file:', shown)
    await shot(page, 'reverify-guest-binary-click')
    await c.page.waitForTimeout(1500)
    await shot(c.page, 'reverify-owner-after-binary-click')
    await expect(ownerOverlays).toHaveCount(0)
    expect((await c.hook<unknown[]>('tabs', c.projectDir)).length).toBe(before)
  } finally {
    await guest?.close()
    await close()
  }
})
