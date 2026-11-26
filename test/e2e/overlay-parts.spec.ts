// Parts (shared/design-parts.md, task 07 "overlay-parts.spec.ts", D13): the overlay-part fixture hears the
// overlay-notes fixture's announce (kind fixture.doc) and attaches its own page beside that overlay's. Driven end to
// end with the desktop, an owner browser and a guest in a plain browser (web-fixtures.ts openBrowser):
//
//  1. The owner's screens draw both frames, each its own plugin's page (the part's under a strip naming its plugin,
//     its intro with nothing on); a guest shown overlay-notes but not overlay-part sees the opener's window without
//     the part (not in its frames, its list or its DOM); the part's ✕ closes it for everyone and leaves the opener.
//  2. Discuss over an attached part: the one Send carries the opener's text and the part's own section.
import { join } from 'node:path'
import type { FrameLocator, Locator, Page } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { CockpitApi, OverlayInfo } from '../../src/shared/ipc'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { inviteGuest } from './guest-fixtures'
import { enableWebAccess, openBrowser, type WebAccessOn, type WebBrowser } from './web-fixtures'

const FIXTURES = join(__dirname, '..', 'fixtures', 'plugins')
const OPENER = 'test.overlaynotes'
const PART = 'test.overlaypart'
const DOC_TITLE = 'Overlay notes'
const PART_TITLE = 'Overlay part'
const DOC = 'Fixture document: the quick brown fox. A second paragraph to select and ask about.'
const PART_TEXT = `${DOC_TITLE}: doc:fixture-1`

async function invoke<T>(c: Cockpit, channel: string, payload?: unknown): Promise<T> {
  return c.page.evaluate(
    async ([ch, p]) => ((window as unknown as { cockpit: CockpitApi }).cockpit.invoke as unknown as (c: string, q?: unknown) => Promise<unknown>)(ch, p),
    [channel, payload] as const
  ) as Promise<T>
}

const showToGuests = (c: Cockpit, pluginId: string): Promise<unknown> =>
  invoke(c, 'settings.pluginGuestAccessSet', { pluginId, target: 'app', value: 'shown' })

const stack = (c: Cockpit): Promise<OverlayInfo[]> => c.hook<OverlayInfo[]>('overlays', c.projectDir)

async function pluginActive(c: Cockpit, id: string): Promise<void> {
  await expect
    .poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.some((p) => p.id === id && p.state === 'active'), { timeout: 20_000 })
    .toBe(true)
}

/** Both fixtures linked and running. */
async function linkFixtures(c: Cockpit): Promise<void> {
  await c.hook('linkPlugin', join(FIXTURES, 'overlay-notes'))
  await c.hook('enablePlugin', c.projectDir, OPENER)
  await c.hook('linkPlugin', join(FIXTURES, 'overlay-part'))
  await c.hook('enablePlugin', c.projectDir, PART)
  await pluginActive(c, OPENER)
  await pluginActive(c, PART)
}

/**
 * The desktop window's width. A default-size overlay is 75% of the window (styles.css `.overlay-frame`), so parts sit
 * side by side (a body of 1280 px or more) only from a window about 1707 px wide; the harness's window is narrower.
 */
const deskWidth = (c: Cockpit, width: number): Promise<unknown> =>
  c.app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]?.setSize(w, 1000), width)
const WIDE = 1900

/** The opener's frame in the desktop page (by its plugin's URL), to mark its window and see it was never reloaded. */
const openerFrame = (c: Cockpit): import('@playwright/test').Frame => {
  const frame = c.page.frames().find((f) => f.url().startsWith(`cc-plugin://${OPENER}/`))
  if (!frame) throw new Error('no opener frame')
  return frame
}
const mark = (c: Cockpit): Promise<unknown> => openerFrame(c).evaluate(() => ((window as unknown as { __kept?: number }).__kept = 1))
const marked = (c: Cockpit): Promise<unknown> => openerFrame(c).evaluate(() => (window as unknown as { __kept?: number }).__kept)

const openDoc = (c: Cockpit): Promise<unknown> => c.hook('runPluginCommand', c.projectDir, `${OPENER}/open`)

/** The owner's own browser on the access link, in the project (guest-overlay-views.spec.ts ownerBrowser). */
async function ownerBrowser(web: WebAccessOn): Promise<WebBrowser> {
  const browser = await openBrowser(web.link)
  try {
    const projects = browser.page.getByRole('list', { name: 'Open projects' }).getByRole('link')
    await expect(projects).toHaveCount(1)
    await projects.click()
    await expect(browser.page).toHaveURL(`${web.origin}/?project=${encodeURIComponent(web.projectId)}`)
    await expect(browser.page.locator('.tabs-pane')).toBeVisible()
    return browser
  } catch (err) {
    await browser.close()
    throw err
  }
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

const dialog = (page: Page): Locator => page.getByRole('dialog', { name: DOC_TITLE })
const frameOf = (page: Page, title: string): FrameLocator => page.frameLocator(`iframe[title="${title}"]`)
const partSection = (page: Page): Locator => dialog(page).locator(`section.overlay-part[data-part-plugin="${PART}"]`)

/** The opener's copy is up on this screen: its page drew the document. */
async function openerUp(page: Page): Promise<void> {
  await expect(dialog(page)).toBeVisible({ timeout: 20_000 })
  await expect(frameOf(page, DOC_TITLE).locator('#doc p')).toHaveText(DOC, { timeout: 20_000 })
}

/** The part's copy is up on this screen: under its strip, its page drew what its host heard, with no feature on. */
async function partUp(page: Page): Promise<void> {
  // Side by side: the screens are sized wide (deskWidth, setViewportSize).
  await expect(dialog(page).locator('.overlay-parts')).toHaveAttribute('data-mode', 'side', { timeout: 20_000 })
  await expect(partSection(page)).toBeVisible({ timeout: 20_000 })
  await expect(partSection(page).locator('.overlay-part-name')).toHaveText(PART_TITLE)
  const part = frameOf(page, PART_TITLE)
  await expect(part.locator('#part p')).toHaveText(PART_TEXT, { timeout: 20_000 })
  // A part's intro has nothing on: no notes, Ask or page-started Discuss in its page.
  await expect(part.locator('#features')).toHaveText('')
  await expect(partSection(page).locator('.overlay-loader')).toHaveCount(0)
}

test("parts: the owner sees both frames; a guest not shown the part plugin sees the opener's window without the part; the part's ✕ closes it for everyone", async () => {
  test.setTimeout(240_000)
  const { cockpit: c, close } = await launchCockpit()
  let owner: WebBrowser | undefined
  let guest: WebBrowser | undefined
  try {
    await linkFixtures(c)
    const web = await enableWebAccess(c)
    // The guest may see the opener, never the part's plugin.
    await showToGuests(c, OPENER)
    owner = await ownerBrowser(web)
    guest = await guestBrowser(c, web, 'Ann', 'read')
    await deskWidth(c, WIDE)
    await owner.page.setViewportSize({ width: WIDE, height: 1000 })
    await guest.page.setViewportSize({ width: WIDE, height: 1000 })

    await openDoc(c)
    // Main's list: the opener, then its part (partOf), which is never on the stack itself.
    await expect.poll(async () => (await stack(c)).map((o) => [o.title, o.partOf === undefined ? 'top' : 'part']), { timeout: 20_000 }).toEqual([
      [DOC_TITLE, 'top'],
      [PART_TITLE, 'part']
    ])
    const [doc, part] = await stack(c)
    expect(part!.partOf).toBe(doc!.id)
    expect(part!.discuss).toBeUndefined()
    expect(part!.buttons).toBeUndefined()

    // 1. Both of the owner's screens: the opener's page and the part's, each in its own frame.
    for (const page of [c.page, owner.page]) {
      await openerUp(page)
      await partUp(page)
      // One window: the part is drawn in the opener's body, not as an overlay of its own.
      await expect(page.getByRole('dialog')).toHaveCount(1)
      await expect(dialog(page).locator('.overlay-parts .overlay-part-opener iframe')).toHaveAttribute('title', DOC_TITLE)
    }

    // The window narrows: stacked, then one frame behind a switch; wide again: side by side. The opener's page is the
    // same page throughout (a frame moved or remounted in the DOM would reload it and lose the mark).
    await mark(c)
    const parts = dialog(c.page).locator('.overlay-parts')
    await deskWidth(c, 1100)
    await expect(parts).toHaveAttribute('data-mode', 'stacked')
    await expect(partSection(c.page)).toBeVisible()
    await expect(dialog(c.page).locator('.overlay-part-opener')).toBeVisible()
    await deskWidth(c, 800)
    await expect(parts).toHaveAttribute('data-mode', 'switch')
    await expect(partSection(c.page)).toBeHidden()
    const tabs = dialog(c.page).getByRole('tablist', { name: 'Shown here' })
    await expect(tabs.getByRole('tab', { name: DOC_TITLE })).toHaveAttribute('aria-selected', 'true')
    await tabs.getByRole('tab', { name: PART_TITLE }).click()
    await expect(partSection(c.page)).toBeVisible()
    await expect(dialog(c.page).locator('.overlay-part-opener')).toBeHidden()
    await expect(frameOf(c.page, PART_TITLE).locator('#part p')).toHaveText(PART_TEXT)
    await deskWidth(c, WIDE)
    await partUp(c.page)
    await expect(dialog(c.page).locator('.overlay-part-opener')).toBeVisible()
    expect(await marked(c)).toBe(1)

    // 2. The guest: the opener's window, and nothing of the part (no strip, no frame, no title anywhere in its DOM).
    await openerUp(guest.page)
    await expect(partSection(guest.page)).toHaveCount(0)
    await expect(guest.page.locator(`iframe[title="${PART_TITLE}"]`)).toHaveCount(0)
    await expect(guest.page.locator('.overlay-part')).toHaveCount(0)
    expect(await guest.page.locator('body').innerHTML()).not.toContain(PART)

    // 3. The part's ✕ (the desktop's): gone from every screen; the opener stays, its page untouched.
    await partSection(c.page).getByRole('button', { name: `Close ${PART_TITLE}` }).click()
    for (const page of [c.page, owner.page]) {
      await expect(partSection(page)).toHaveCount(0)
      await expect(page.locator(`iframe[title="${PART_TITLE}"]`)).toHaveCount(0)
      await openerUp(page)
    }
    await openerUp(guest.page)
    await expect.poll(async () => (await stack(c)).map((o) => o.title)).toEqual([DOC_TITLE])
    // The part detaching left the opener's page as it was.
    expect(await marked(c)).toBe(1)
    await expect(dialog(c.page).locator('.overlay-part-divider')).toHaveCount(0)
  } finally {
    await guest?.close()
    await owner?.close()
    await close()
  }
})

test("Discuss over an attached part sends the opener's text and the part's own section", async () => {
  test.setTimeout(180_000)
  const { cockpit: c, close } = await launchCockpit()
  try {
    await linkFixtures(c)
    // One Claude tab, the Discuss target, working from the start (typed now: the overlay will cover its terminal).
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    await c.typeLine('/prompt busy')
    await expect.poll(async () => (await c.hook<Array<{ status: string }>>('sessions', c.projectDir))[0]?.status, { timeout: 15_000 }).toBe('working')

    await deskWidth(c, WIDE)
    await openDoc(c)
    // The part's text is asked only of a part with a live copy in the acting view: wait for the desktop's.
    await openerUp(c.page)
    await partUp(c.page)

    // Discuss to the working tab is queued: the window goes (with its part), nothing pasted yet.
    await dialog(c.page).locator('.overlay-discuss').getByRole('button', { name: 'Discuss in an existing session' }).click()
    const menu = c.page.getByRole('dialog', { name: 'Discuss in an existing session' })
    await expect(menu.getByRole('option').first()).toContainText('queued — sent when it is free')
    await menu.getByRole('button', { name: 'Send' }).click()
    await expect(dialog(c.page)).toHaveCount(0)
    await expect.poll(async () => (await stack(c)).length).toBe(0)
    expect(c.pastes()).toEqual([])

    // The tab stops: one paste with the opener's document and the part's section, headed with its plugin's name.
    await c.typeLine('/stop')
    await expect.poll(() => c.pastes().length, { timeout: 15_000 }).toBe(1)
    const [pasted] = c.pastes()
    expect(pasted).toContain(`About: ${DOC_TITLE}`)
    expect(pasted).toContain(DOC)
    expect(pasted).toContain('Part refs: doc:fixture-1')
    expect(pasted).toContain(PART_TITLE)
    // The opener's text comes first, the part's after it.
    expect(pasted!.indexOf(DOC)).toBeLessThan(pasted!.indexOf('Part refs: doc:fixture-1'))
  } finally {
    await close()
  }
})
