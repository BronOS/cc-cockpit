// Slots end to end (design-next §2): a host plugin (slot-host) places an `agenda` slot above its panel
// "Board"; two providers (slot-provider, slot-provider-2) declare the type. Each provider records the
// frames it was handed (type, host, params), the messages from the slot page and the closes in
// $HOME/slot-<one|two>.json; its page asks the provider (ping) and shows who answered and the params
// the provider saw. The picks go through the Plugins page, as a user does.
//
// The second test pins the top bar's slot `sessions-strip` as it is today: while a provider draws it,
// its frame takes the place of the built-in entries (the other windows' Claude tabs); "None" brings
// them back. The built-in entries go as soon as the frame exists, not when the provider's page has
// connected (task 36 removes the built-in strip).
import type { Frame, Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expect, test, type Cockpit } from './fixtures'

const fixture = (name: string): string => join(__dirname, '..', 'fixtures', 'plugins', name)
const HOST = 'test.slothost'
const ONE = 'test.slotone'
const TWO = 'test.slottwo'

interface ProviderLog {
  opens: Array<{ type: string; host: unknown; params: unknown }>
  messages: Array<{ type: string; message: unknown }>
  closes: number
}

const logOf = (c: Cockpit, tag: 'one' | 'two'): ProviderLog => {
  const file = join(c.root, 'home', `slot-${tag}.json`)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ProviderLog) : { opens: [], messages: [], closes: 0 }
}
const agendaOpens = (c: Cockpit, tag: 'one' | 'two'): number => logOf(c, tag).opens.filter((o) => o.type === 'agenda').length

const active = async (c: Cockpit): Promise<string[]> =>
  (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.filter((p) => p.state === 'active').map((p) => p.id).sort()

function pageFrame(page: Page, plugin: string, file: string): Frame | undefined {
  return page.frames().find((f) => f.url() === `cc-plugin://${plugin}/${file}`)
}

// Expressions as strings: this file compiles without the DOM lib (tsconfig.node.json). Null while the
// frame is missing or being replaced.
const text = (frame: Frame | undefined, id: string): Promise<string | null> =>
  frame
    ? frame.evaluate<string | null>(`document.getElementById(${JSON.stringify(id)})?.textContent ?? null`).catch(() => null)
    : Promise.resolve(null)

const invoke = (page: Page, channel: string, req: unknown): Promise<unknown> =>
  page.evaluate(`window.cockpit.invoke(${JSON.stringify(channel)}, ${JSON.stringify(req)})`)

test('an agenda slot: no provider picked, one picked, hidden panel, none, a provider disabled', async ({ cockpit }) => {
  const { page } = cockpit
  const frames = page.locator('[data-slot-frame][data-slot-type="agenda"]')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  const board = page.locator('.zone-left').getByRole('button', { name: /^Board/ })

  for (const name of ['slot-host', 'slot-provider', 'slot-provider-2']) await cockpit.hook('linkPlugin', fixture(name))
  await cockpit.hook('enablePlugin', cockpit.projectDir, HOST)
  await expect.poll(() => active(cockpit), { timeout: 15_000 }).toEqual([HOST])

  // Panels start closed: open it from the left strip. No provider: just the panel, no slot.
  await board.click()
  await expect(page.locator('section.panel[aria-label="Board"]')).toBeVisible()
  await expect(frames).toHaveCount(0)

  // Two providers and no pick: nothing is drawn, and the Plugins page asks for a pick.
  await cockpit.hook('enablePlugin', cockpit.projectDir, ONE)
  await cockpit.hook('enablePlugin', cockpit.projectDir, TWO)
  await expect.poll(() => active(cockpit), { timeout: 15_000 }).toEqual([HOST, ONE, TWO])
  const pick = async (value: string): Promise<void> => {
    await page.keyboard.press('ControlOrMeta+,')
    await expect(settings).toBeVisible()
    await settings.getByRole('navigation').getByRole('button', { name: 'Plugins', exact: true }).click()
    const row = settings.getByLabel('Plugin drawing the agenda slot')
    await row.selectOption(value)
    await expect(row).toHaveValue(value)
    await page.keyboard.press('Escape')
    await expect(settings).toBeHidden()
  }
  await page.keyboard.press('ControlOrMeta+,')
  await settings.getByRole('navigation').getByRole('button', { name: 'Plugins', exact: true }).click()
  const row = settings.getByLabel('Plugin drawing the agenda slot')
  await expect(row).toHaveValue('')
  await expect(row.locator('option')).toHaveText(['Pick one (nothing drawn until then)', 'Slot provider one', 'Slot provider two', 'None'])
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()
  await expect(frames).toHaveCount(0)
  expect(agendaOpens(cockpit, 'one') + agendaOpens(cockpit, 'two')).toBe(0)

  // Pick two: its page draws in the panel's column with the placement's height, hears the ping,
  // and the provider saw the host panel and the params.
  await pick(TWO)
  await expect(frames).toHaveCount(1)
  await expect(frames).toHaveAttribute('data-slot-plugin', TWO)
  await expect(frames).toHaveAttribute('style', /height: 90px/)
  await expect(frames.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(frames.locator('iframe')).toHaveAttribute('src', `cc-plugin://${TWO}/agenda.html`)
  await expect.poll(() => text(pageFrame(page, TWO, 'agenda.html'), 'who'), { timeout: 15_000 }).toBe('two')
  expect(await text(pageFrame(page, TWO, 'agenda.html'), 'params')).toBe('{"day":"mon"}')
  expect(await text(pageFrame(page, TWO, 'agenda.html'), 'slot')).toBe('agenda')
  const two = logOf(cockpit, 'two')
  expect(two.opens).toEqual([
    { type: 'agenda', host: { kind: 'panel', pluginId: HOST, panelId: 'board' }, params: { day: 'mon' } }
  ])
  expect(two.messages).toEqual([{ type: 'agenda', message: { ping: 1 } }])
  // The slot sits above the panel's own page, in the panel's column.
  const slotBox = (await frames.boundingBox())!
  const panelBox = (await page.locator('section.panel[aria-label="Board"] iframe[src*="board.html"]').boundingBox())!
  expect(slotBox.y + slotBox.height).toBeLessThanOrEqual(panelBox.y + 1)

  // Pick one: the frame is replaced by the other provider's, and the old one hears its close.
  await pick(ONE)
  await expect(frames).toHaveCount(1)
  await expect(frames).toHaveAttribute('data-slot-plugin', ONE)
  await expect.poll(() => text(pageFrame(page, ONE, 'agenda.html'), 'who'), { timeout: 15_000 }).toBe('one')
  await expect.poll(() => logOf(cockpit, 'two').closes).toBe(1)
  expect(agendaOpens(cockpit, 'one')).toBe(1)

  // Hide the host panel: its slot frames unmount and the provider hears the close; unhiding brings
  // the panel, and a new frame, back.
  const closesBefore = logOf(cockpit, 'one').closes
  await board.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Hide' }).click()
  await expect(page.locator('section.panel[aria-label="Board"]')).toHaveCount(0)
  await expect(frames).toHaveCount(0)
  await expect.poll(() => logOf(cockpit, 'one').closes).toBe(closesBefore + 1)
  await page.locator('.zone-left').getByRole('button', { name: 'Hidden panels' }).click()
  await page.getByRole('menuitem', { name: 'Board' }).click()
  await expect(frames).toHaveCount(1)
  await expect.poll(() => agendaOpens(cockpit, 'one')).toBe(2)
  await expect.poll(() => text(pageFrame(page, ONE, 'agenda.html'), 'who'), { timeout: 15_000 }).toBe('one')

  // None turns the slot off for the project; the panel stays.
  await pick('@none')
  await expect(frames).toHaveCount(0)
  await expect(page.locator('section.panel[aria-label="Board"]')).toBeVisible()
  await pick(ONE)
  await expect(frames).toHaveAttribute('data-slot-plugin', ONE)

  // A provider disabled mid-session: its frame goes. The other one is the only candidate left, so
  // it draws (a stale pick is no pick); with both off there is no slot.
  await invoke(page, 'settings.projectPluginEnable', { pluginId: ONE, enabled: false })
  await expect.poll(() => active(cockpit), { timeout: 15_000 }).toEqual([HOST, TWO])
  await expect(frames).toHaveAttribute('data-slot-plugin', TWO)
  await expect.poll(() => text(pageFrame(page, TWO, 'agenda.html'), 'who'), { timeout: 15_000 }).toBe('two')
  await invoke(page, 'settings.projectPluginEnable', { pluginId: TWO, enabled: false })
  await expect.poll(() => active(cockpit), { timeout: 15_000 }).toEqual([HOST])
  await expect(frames).toHaveCount(0)
  await expect(page.locator('section.panel[aria-label="Board"]')).toBeVisible()
})

test('the top bar slot sessions-strip: a provider\'s frame between the name and the "+", only the "+" without one', async ({ cockpit }) => {
  const { page } = cockpit
  const dirB = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-e2e-slots-b-')))
  try {
    // Window B has a Claude tab. Core draws no entry for it (the strip is a plugin's): with no
    // provider the bar is the project's name, the "+" and the gear.
    await cockpit.hook('openProject', dirB)
    await expect.poll(() => cockpit.app.windows().length).toBe(2)
    const pageB = cockpit.app.windows().find((p) => p !== page)!
    await pageB.locator('.tabs-pane').waitFor()
    await pageB.getByRole('button', { name: 'New tab' }).click()
    await pageB.getByRole('menuitem', { name: 'Claude' }).click()
    await expect.poll(async () => (await cockpit.hook<unknown[]>('sessions', dirB)).length, { timeout: 15_000 }).toBe(1)
    const plus = page.locator('.top-strip .strip-open-project')
    await expect(page.locator('.top-strip .strip-nav.has-slot')).toHaveCount(0)
    await expect(page.locator('.top-strip [data-slot-frame]')).toHaveCount(0)
    await expect(plus).toHaveCount(1)
    await expect(page.locator('.top-strip .strip-nav button')).toHaveCount(1)

    // The provider is the only candidate: its frame sits between the project name and the "+",
    // takes its room once its page has a port, and its page talks to the provider with the app host.
    await cockpit.hook('linkPlugin', fixture('slot-provider'))
    await cockpit.hook('enablePlugin', cockpit.projectDir, ONE)
    const frame = page.locator('.top-strip [data-slot-frame][data-slot-type="sessions-strip"]')
    await expect(frame).toHaveCount(1, { timeout: 15_000 })
    await expect(frame).toHaveAttribute('data-slot-plugin', ONE)
    await expect(page.locator('.top-strip .strip-nav.has-slot')).toHaveCount(1)
    await expect(plus).toHaveCount(1)
    await expect.poll(() => text(pageFrame(page, ONE, 'strip.html'), 'who'), { timeout: 15_000 }).toBe('one')
    await expect(frame).toHaveAttribute('data-connected', '')
    expect((await frame.boundingBox())!.width).toBeGreaterThan(100)
    // The "+" sits after the frame, before the gear.
    expect((await plus.boundingBox())!.x).toBeGreaterThan((await frame.boundingBox())!.x)
    expect(await text(pageFrame(page, ONE, 'strip.html'), 'slot')).toBe('sessions-strip')
    expect(logOf(cockpit, 'one').opens).toContainEqual({ type: 'sessions-strip', host: { kind: 'app', place: 'top-bar' }, params: null })

    // None: the frame is gone and the bar is the "+" again.
    await invoke(page, 'settings.pluginServiceProvider', { service: '@slot:sessions-strip', pluginId: '@none' })
    await expect(frame).toHaveCount(0)
    await expect(page.locator('.top-strip .strip-nav.has-slot')).toHaveCount(0)
    await expect(plus).toHaveCount(1)
  } finally {
    rmSync(dirB, { recursive: true, force: true })
  }
})
