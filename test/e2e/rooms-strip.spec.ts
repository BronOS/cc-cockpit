// Rooms: the tab strip's room parts (design-rooms.md §5). A fixture plugin (room-strip) makes a room and opens
// its member bob; the strip shows the marker, a message held for a typed tab shows the badge, its click pastes the
// fixed pointer as the person's act (and says why when it cannot, with "Deliver anyway" for a possible draft), and the
// person's mark is set and cleared from the tab's context menu, stored on the tab by main; setting it delivers at once.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { TabInfo } from '../../src/shared/ipc'
import { pointerText } from '../../src/shared/room-pointer'
import { expect, test, type Cockpit } from './fixtures'

const PLUGIN = 'test.roomstrip'
const FIXTURE = join(__dirname, '..', 'fixtures', 'plugins', 'room-strip')

interface Entry {
  tabId: string
  status: string
  typed: boolean
  draft?: boolean
  held?: number
}
const entry = async (c: Cockpit): Promise<Entry> => {
  const [first] = await c.hook<Entry[]>('sessions', c.projectDir)
  if (!first) throw new Error('no Claude tab yet')
  return first
}
const run = (c: Cockpit, command: string): Promise<unknown> => c.hook('runPluginCommand', c.projectDir, `${PLUGIN}/${command}`)
const seen = (c: Cockpit): { opened?: { tabId: string }; sent?: unknown; error?: string } =>
  JSON.parse(readFileSync(join(c.root, 'home', 'room-strip.json'), 'utf8'))
const tabRoom = async (c: Cockpit): Promise<TabInfo['room']> => (await c.hook<TabInfo[]>('tabs', c.projectDir))[0]?.room

test('a member tab shows its marker; the held badge delivers the pointer; the mark is set from the tab menu', async ({ cockpit }) => {
  await cockpit.hook('linkPlugin', FIXTURE)
  await cockpit.hook('enablePlugin', cockpit.projectDir, PLUGIN)
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: PLUGIN, state: 'active' }] })
  await run(cockpit, 'open')
  expect(seen(cockpit).error).toBeUndefined()
  await expect.poll(async () => (await entry(cockpit)).status, { timeout: 15_000 }).toBe('waiting')

  // The marker: the member's name, the room and name in its tooltip.
  const tab = cockpit.page.locator('.tab').first()
  const marker = tab.locator('.tab-room')
  await expect(marker).toHaveText('bob')
  await expect(marker).toHaveAttribute('title', 'Room "Strip test" as bob')
  await expect(tab.locator('.tab-held')).toHaveCount(0)

  // The person takes the tab over and ends a turn with nothing left in the box: a line that schedules the Stop, then a
  // prompt (its UserPromptSubmit clears the draft bit the keys set), then the Stop on its own.
  await cockpit.typeLine('/later 1500 /stop')
  await cockpit.typeLine('/prompt mine')
  await expect.poll(async () => (await entry(cockpit)).status).toBe('working')
  await expect.poll(async () => (await entry(cockpit)).status, { timeout: 10_000 }).toBe('waiting')
  const taken = await entry(cockpit)
  expect(taken.typed).toBe(true)
  expect(taken.draft).not.toBe(true)

  // A message for a typed tab without the mark is held: the badge counts it and says why.
  await run(cockpit, 'send')
  expect(seen(cockpit).error).toBeUndefined()
  const badge = tab.getByRole('button', { name: '1 room message waiting: deliver now' })
  await expect(badge).toHaveText('1')
  await expect(badge).toHaveAttribute('title', /you typed in this tab/)
  expect(cockpit.pastes()).toEqual([])

  // The click pastes the fixed pointer (no message text) through the gate; the message stays queued until bob reads.
  await badge.click()
  await expect.poll(() => cockpit.pastes()).toEqual([`\x1b[200~${pointerText(1)}\x1b[201~`])
  expect(cockpit.pastes().join('')).not.toContain('hello bob')
  await expect.poll(async () => (await entry(cockpit)).status).toBe('working')
  await expect(badge).toHaveText('1')
  // Clicked again while Claude works: nothing goes in, and the strip says why.
  await badge.click()
  const error = cockpit.page.locator('.tabs-error')
  await expect(error).toContainText('Claude is busy')
  expect(cockpit.pastes()).toHaveLength(1)

  // A draft: the person ends the turn by hand, and the keys of `/stop` set the draft bit (main cannot see the box). The
  // click says so and offers "Deliver anyway", the person's choice; that puts the pointer in.
  await cockpit.typeLine('/stop')
  await expect.poll(async () => (await entry(cockpit)).status).toBe('waiting')
  expect((await entry(cockpit)).draft).toBe(true)
  await badge.click()
  await expect(error).toContainText('may hold unsent text')
  expect(cockpit.pastes()).toHaveLength(1)
  await error.getByRole('button', { name: 'Deliver anyway' }).click()
  await expect.poll(() => cockpit.pastes()).toHaveLength(2)
  expect(cockpit.pastes()[1]).toBe(`\x1b[200~${pointerText(1)}\x1b[201~`)
  await expect(error).toHaveCount(0)
  await expect.poll(async () => (await entry(cockpit)).status).toBe('working')

  // Waiting again with nothing unsent (the prompt clears the bit, then the scheduled Stop): still held, typed, no mark.
  await cockpit.typeLine('/later 1500 /stop')
  await cockpit.typeLine('/prompt mine')
  await expect.poll(async () => (await entry(cockpit)).status, { timeout: 10_000 }).toBe('waiting')
  expect((await entry(cockpit)).draft).not.toBe(true)
  await expect(badge).toHaveText('1')
  expect(cockpit.pastes()).toHaveLength(2)

  // The mark, from the tab menu: stored on the tab by main, shown checked, in the marker's tooltip. Turned on while the
  // tab waits with no draft, what is held goes in at once, not at the next Stop.
  const menuItem = cockpit.page.getByRole('menuitemcheckbox', { name: 'Deliver room messages automatically' })
  await tab.getByRole('tab').click({ button: 'right' })
  await expect(menuItem).toHaveAttribute('aria-checked', 'false')
  await menuItem.click()
  await expect.poll(() => tabRoom(cockpit)).toMatchObject({ name: 'bob', mark: true })
  await expect.poll(() => cockpit.pastes()).toHaveLength(3)
  expect(cockpit.pastes()[2]).toBe(`\x1b[200~${pointerText(1)}\x1b[201~`)
  await expect(marker).toHaveAttribute('title', /delivered automatically/)
  await expect(badge).not.toHaveAttribute('title', /you typed in this tab/)
  await expect.poll(async () => (await entry(cockpit)).status).toBe('working')

  // Cleared, and waiting again: nothing more goes in (clearing never offers, and a typed tab without the mark holds).
  await tab.getByRole('tab').click({ button: 'right' })
  await expect(menuItem).toHaveAttribute('aria-checked', 'true')
  await menuItem.click()
  await expect.poll(() => tabRoom(cockpit)).toMatchObject({ name: 'bob', mark: false })
  await expect(marker).toHaveAttribute('title', 'Room "Strip test" as bob')
  await cockpit.typeLine('/later 1500 /stop')
  await cockpit.typeLine('/prompt mine')
  await expect.poll(async () => (await entry(cockpit)).status, { timeout: 10_000 }).toBe('waiting')
  await expect(badge).toHaveAttribute('title', /you typed in this tab/)
  expect(cockpit.pastes()).toHaveLength(3)
})
