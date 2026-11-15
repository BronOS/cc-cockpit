// Rooms: the room dialog (design-rooms.md §5 "The room view"). A fixture plugin (room-view) makes a room with
// alice (coordinator) and bob, writes a doc and sends bob messages. On the desktop the dialog opens from a member tab's
// "Room...", shows the members, the doc read-only and the log, follows a new message live (`rooms.changed` reaching
// the project's views), pauses and resumes, and removes a member after its own on-screen question. In server mode a
// browser's Remove is the window's ApprovalDialog (`rooms.removeAsk`), replayed to a browser that reloads mid-ask, and
// only its Remove removes.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { TabInfo } from '../../src/shared/ipc'
import { expect, test, type Cockpit } from './fixtures'
import { expectMainAlive, launchServer, type Server } from './server-fixtures'
import { openBrowser, openProjectInBrowser } from './web-fixtures'

const PLUGIN = 'test.roomview'
const FIXTURE = join(__dirname, '..', 'fixtures', 'plugins', 'room-view')

const run = (c: Cockpit, command: string): Promise<unknown> => c.hook('runPluginCommand', c.projectDir, `${PLUGIN}/${command}`)
const seen = (c: Cockpit): { roomId?: string; error?: string } => JSON.parse(readFileSync(join(c.root, 'home', 'room-view.json'), 'utf8'))
const roomsOf = async (c: Cockpit): Promise<Array<TabInfo['room']>> => (await c.hook<TabInfo[]>('tabs', c.projectDir)).map((t) => t.room)

/** Links and enables the fixture, opens the room with its two members, writes the doc, sends bob one message. */
async function setUpRoom(c: Cockpit): Promise<void> {
  await c.hook('linkPlugin', FIXTURE)
  await c.hook('enablePlugin', c.projectDir, PLUGIN)
  await expect
    .poll(() => c.hook<HostStatus>('hostStatus', c.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: PLUGIN, state: 'active' }] })
  await run(c, 'open')
  expect(seen(c).error).toBeUndefined()
  await expect
    .poll(async () => (await c.hook<Array<{ status: string }>>('sessions', c.projectDir)).map((s) => s.status), { timeout: 15_000 })
    .toEqual(['waiting', 'waiting'])
  await run(c, 'doc')
  await run(c, 'send')
  expect(seen(c).error).toBeUndefined()
}

/** Right-click bob's tab, then "Room…". */
async function openRoomDialog(page: Page): Promise<void> {
  const bobTab = page.locator('.tab', { has: page.locator('.tab-room', { hasText: /^bob$/ }) })
  await bobTab.getByRole('tab').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Room…' }).click()
}

test('the room dialog opens from the tab menu: members, a doc read-only, the live log, pause and resume, remove', async ({ cockpit }) => {
  await setUpRoom(cockpit)
  const { page } = cockpit
  await openRoomDialog(page)
  const dialog = page.getByTestId('room-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Room “View test”' })).toBeVisible()
  await expect(dialog.getByTestId('room-state')).toHaveText(`Active · by ${PLUGIN}`)

  // Members: the coordinator first, bob with his held message.
  const members = dialog.getByTestId('room-member')
  await expect(members).toHaveCount(2)
  await expect(members.nth(0)).toContainText('alice')
  await expect(members.nth(0)).toContainText('coordinator')
  await expect(members.nth(1)).toContainText('bob')
  await expect(members.nth(1)).toContainText('1 held')

  // The log, newest first; a message sent while the dialog is up shows without any action here (rooms.changed).
  const log = dialog.getByTestId('room-log')
  await expect(log).toContainText('plugin → bob: hello bob 1')
  await run(cockpit, 'send')
  await expect(log.locator('li').first()).toContainText('plugin → bob: hello bob 2')
  await expect(members.nth(1)).toContainText('2 held')

  // A doc opens read-only in the dialog's own viewer; Back returns to the lists. The read is the person's.
  await dialog.getByRole('button', { name: 'shared/plan.md' }).click()
  await expect(dialog.getByRole('button', { name: 'Back' })).toBeFocused()
  await expect(dialog.getByTestId('room-doc-text')).toHaveText('kickoff plan\nstep two\n')
  await expect(dialog.locator('textarea, [contenteditable="true"]')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Reload' }).click()
  await expect(dialog.getByTestId('room-doc-text')).toHaveText('kickoff plan\nstep two\n')
  await dialog.getByRole('button', { name: 'Back' }).click()
  // Back puts the focus on the doc's own button, not on <body>.
  await expect(dialog.getByRole('button', { name: 'shared/plan.md' })).toBeFocused()
  // Reveal is offered on the desktop.
  await expect(dialog.getByRole('button', { name: 'Reveal folder' })).toBeVisible()

  // Pause and resume.
  await dialog.getByRole('button', { name: 'Pause' }).click()
  await expect(dialog.getByTestId('room-state')).toHaveText(`Paused: nothing is delivered · by ${PLUGIN}`)
  await expect(log.locator('li').first()).toContainText('Paused')
  // The person's doc reads are logged; they fire no rooms.changed (no read loop), so they show with the next read.
  await expect(log).toContainText('person read shared/plan.md')
  await dialog.getByRole('button', { name: 'Resume' }).click()
  await expect(dialog.getByTestId('room-state')).toHaveText(`Active · by ${PLUGIN}`)
  await expect(log.locator('li').first()).toContainText('Resumed')

  // Remove asks on screen first; Cancel keeps bob, Remove takes him out (his tab stays, in no room).
  const question = dialog.getByRole('group', { name: 'Remove bob?' })
  // A double click on Remove cannot answer the question: its Remove is disarmed for a second (and Cancel, not
  // Remove, sits where the row's button was).
  await dialog.getByRole('button', { name: 'Remove bob' }).dblclick()
  await page.waitForTimeout(300)
  await expect(members).toHaveCount(2)
  if ((await question.count()) > 0) await question.getByRole('button', { name: 'Cancel' }).click()
  await expect(question).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Remove bob' }).click()
  await expect(question.getByRole('button', { name: 'Remove' })).toBeDisabled()
  await expect(question.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await question.getByRole('button', { name: 'Cancel' }).click()
  await expect(members).toHaveCount(2)
  await expect(dialog.getByRole('button', { name: 'Remove bob' })).toBeFocused()
  await dialog.getByRole('button', { name: 'Remove bob' }).click()
  await question.getByRole('button', { name: 'Remove' }).click()
  await expect(members).toHaveCount(1)
  await expect(members.nth(0)).toContainText('alice')
  await expect(log.locator('li').first()).toContainText('bob left')
  await expect.poll(async () => (await roomsOf(cockpit)).map((r) => r?.name)).toEqual(['alice', undefined])

  // Esc closes the dialog.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test.describe('server mode', () => {
  test.skip(process.platform !== 'linux', 'server mode runs on Linux only')
  let server: Server | undefined
  test.afterEach(async () => {
    await server?.close()
    server = undefined
  })

  test('Remove from a browser asks through the ApprovalDialog; replayed after a reload; Remove removes', async () => {
    test.setTimeout(120_000)
    server = await launchServer()
    const { cockpit } = server
    await setUpRoom(cockpit)
    const browser = await openBrowser(`${server.origin}/`)
    try {
      const { page } = browser
      await openProjectInBrowser(browser, server.origin, server.projectId)
      await openRoomDialog(page)
      const dialog = page.getByTestId('room-dialog')
      await expect(dialog.getByTestId('room-member')).toHaveCount(2)
      // A server's browser acts (Pause is offered) but has no Reveal (the host has no screen).
      await expect(dialog.getByRole('button', { name: 'Pause' })).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Reveal folder' })).toHaveCount(0)

      // No on-screen question of the dialog's own: main asks every view of the window.
      await dialog.getByRole('button', { name: 'Remove bob' }).click()
      const ask = page.getByRole('alertdialog', { name: 'Remove bob from the room “View test”?' })
      await expect(ask).toBeVisible()
      const allow = ask.getByRole('button', { name: 'Remove' })
      await expect(allow).toBeDisabled()
      await expect(allow).toBeEnabled({ timeout: 5_000 })
      // Enter on the focused Remove does nothing (the ApprovalDialog's rule): the ask stays and bob stays, over a
      // while (the removal would be async).
      await allow.focus()
      await page.keyboard.press('Enter')
      await page.waitForTimeout(1_000)
      await expect(ask).toBeVisible()
      expect((await roomsOf(cockpit)).map((r) => r?.name)).toEqual(['alice', 'bob'])

      // Esc with the ask up does not close the room dialog under it.
      await dialog.getByRole('button', { name: 'Close' }).focus()
      await page.keyboard.press('Escape')
      await expect(dialog).toBeVisible()
      await expect(ask).toBeVisible()

      // The ask is on top of the room dialog and answered with that dialog still open: Cancel keeps bob, and the
      // dialog's Remove comes back (not stuck on "Waiting…").
      await ask.getByRole('button', { name: 'Cancel' }).click()
      await expect(ask).toHaveCount(0)
      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Remove bob' })).toBeEnabled()
      await expect(dialog.getByTestId('room-member')).toHaveCount(2)
      await dialog.getByRole('button', { name: 'Remove bob' }).click()
      await expect(ask).toBeVisible()
      await expect(allow).toBeDisabled()

      // A reload mid-ask finds it again in ready, disarmed again; its Remove removes bob (main still waits on the ask).
      await page.reload()
      await page.locator('.tabs-pane').waitFor()
      await expect(ask).toBeVisible()
      await expect(allow).toBeDisabled()
      await expect(allow).toBeEnabled({ timeout: 5_000 })
      await allow.click()
      await expect(ask).toHaveCount(0)
      await expect.poll(async () => (await roomsOf(cockpit)).map((r) => r?.name)).toEqual(['alice', undefined])
      await expectMainAlive(server)
    } finally {
      await browser.close()
    }
  })
})
