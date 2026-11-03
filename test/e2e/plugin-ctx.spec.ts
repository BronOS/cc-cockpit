// Task 26: the host ctx in the real plugin host (utilityProcess): settings with defaults applied by
// main, storage and dataDir on disk, appStorage and appDataDir through main, exec without a shell, notify (options,
// the chime, a click), ctx.log into
// <data>/logs/<pluginId>.log, and a manifest command that main lists and runs in the host.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { RecordedNotice } from '../../src/main/notifications/notifier'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { CommandInfo } from '../../src/shared/ipc'
import { expect, test } from './fixtures'

const FIXTURE = join(__dirname, '..', 'fixtures', 'plugins', 'host-ctx')

test('a plugin uses settings, storage, app storage, exec, notify, log and a command through its ctx', async ({ cockpit }) => {
  await cockpit.hook('linkPlugin', FIXTURE)
  await cockpit.hook('enablePlugin', cockpit.projectDir, 'test.hostctx')
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: 'test.hostctx', state: 'active' }] })
  const seenFile = join(cockpit.root, 'home', 'host-ctx.json')
  await expect.poll(() => existsSync(seenFile), { timeout: 15_000 }).toBe(true)

  const seen = JSON.parse(readFileSync(seenFile, 'utf8')) as {
    settings: { project: Record<string, unknown>; app: Record<string, unknown> }
    stored: unknown
    dataDir: string
    appStored: unknown
    counted: number[]
    incrementError: string
    appDataDir: string
    exec: { code: number; stdout: string; stderr: string }
    undeclaredError: string
    soundNotify: unknown
    error?: string
  }
  expect(seen.error).toBeUndefined()
  // Main validated the (empty) stored settings against the schema and filled in the default.
  expect(seen.settings).toEqual({ project: { greeting: 'hello' }, app: {} })
  expect(seen.stored).toEqual({ n: 42 })
  // The path is main's: <data>/plugin-data/<projectId>/<pluginId>, created on demand.
  expect(seen.dataDir.startsWith(join(cockpit.dataDir, 'plugin-data'))).toBe(true)
  expect(seen.dataDir.endsWith(join('', 'test.hostctx'))).toBe(true)
  expect(readFileSync(join(seen.dataDir, 'hello.txt'), 'utf8')).toBe('written in dataDir')
  // App-wide: main's store and the folder beside the project folders, <data>/plugin-data/_app/<pluginId>.
  expect(seen.appStored).toEqual({ shared: true })
  expect(seen.counted).toEqual([1, 3])
  expect(seen.incrementError).toContain('not a number')
  expect(seen.appDataDir).toBe(join(cockpit.dataDir, 'plugin-data', '_app', 'test.hostctx'))
  expect(readFileSync(join(seen.appDataDir, 'hello.txt'), 'utf8')).toBe('written in appDataDir')
  // stdin arrived and the argument stayed literal.
  expect(seen.exec).toEqual({ code: 0, stdout: 'in:$(echo pwned)', stderr: '' })
  expect(seen.undeclaredError).toContain('not declared')

  // The KV file lands within the 300 ms debounce.
  const storageFile = join(seen.dataDir, 'storage.json')
  await expect.poll(() => existsSync(storageFile)).toBe(true)
  expect(JSON.parse(readFileSync(storageFile, 'utf8')).values).toEqual({ answer: { n: 42 } })
  // The project's folder and the app-wide `_app` (never a project id: those are 16 hex characters).
  const projectFolder = basename(dirname(seen.dataDir))
  expect(projectFolder).toMatch(/^[0-9a-f]{16}$/)
  expect(readdirSync(join(cockpit.dataDir, 'plugin-data')).sort()).toEqual(['_app', projectFolder].sort())
  // main's app storage file lands within its debounce too.
  const appStorageFile = join(seen.appDataDir, 'storage.json')
  await expect.poll(() => existsSync(appStorageFile)).toBe(true)
  expect(JSON.parse(readFileSync(appStorageFile, 'utf8')).values).toEqual({ app: { shared: true }, runs: 3 })

  expect(await cockpit.hook<string[]>('notifications')).toContain('hello from the fixture plugin')
  // The options as main gave them to the OS: the default title, a silent one with the app's chime
  // instead, and the action as a button that keeps the notification up.
  expect(seen.soundNotify).toEqual({ clicked: false })
  const details = await cockpit.hook<RecordedNotice[]>('notificationDetails')
  expect(details.find((n) => n.body === 'hello from the fixture plugin')).toEqual({
    title: 'cc-cockpit: test.hostctx',
    body: 'hello from the fixture plugin',
    open: true
  })
  expect(details.find((n) => n.body === 'chime please')).toMatchObject({ title: 'Fixture reminder', silent: true })
  // One chime, in this project's window (the setting is on by default), with the plugin's own
  // sound: a built-in the app offers.
  await expect.poll(() => cockpit.hook<number[]>('chimes')).toHaveLength(1)
  expect(await cockpit.hook<string[]>('chimeSounds')).toEqual(['builtin:bell'])
  await expect.poll(async () => (await cockpit.hook<RecordedNotice[]>('notificationDetails')).length).toBe(3)
  const reminder = (await cockpit.hook<RecordedNotice[]>('notificationDetails')).findIndex((n) => n.body === 'Standup in 2 min')
  expect((await cockpit.hook<RecordedNotice[]>('notificationDetails'))[reminder]).toMatchObject({
    title: 'Calendar',
    actionLabel: 'Join',
    persistent: true,
    open: true
  })
  const clickFile = join(cockpit.root, 'home', 'notify-click.json')
  expect(existsSync(clickFile)).toBe(false)
  expect(await cockpit.hook<boolean>('clickNotification', reminder)).toBe(true)
  await expect.poll(() => existsSync(clickFile)).toBe(true)
  expect(JSON.parse(readFileSync(clickFile, 'utf8'))).toEqual({ clicked: true })

  const logFile = join(cockpit.dataDir, 'logs', 'test.hostctx.log')
  await expect.poll(() => existsSync(logFile)).toBe(true)
  expect(readFileSync(logFile, 'utf8')).toMatch(/ info \[[0-9a-f]{16}\] fixture log line\n/)

  // Only the registered command appears, with the manifest's key (meta becomes ctrl off macOS, and the
  // modifiers come out in main's own order), and it runs in the host.
  const listed = await cockpit.hook<CommandInfo[]>('pluginCommands', cockpit.projectDir)
  expect(listed).toEqual([{ id: 'test.hostctx/ping', title: 'Ctx: Ping', key: 'shift+meta+9', source: 'plugin' }].map((c) =>
    process.platform === 'darwin' ? c : { ...c, key: 'ctrl+shift+9' }
  ))
  await cockpit.hook('runPluginCommand', cockpit.projectDir, 'test.hostctx/ping')
  expect(readFileSync(join(seen.dataDir, 'ping.txt'), 'utf8')).toBe('pong')
})

test('with Notification sounds off in Settings, a notification asking for a sound rings no chime and stays silent', async ({
  cockpit
}) => {
  const { page } = cockpit
  await page.keyboard.press('ControlOrMeta+,')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Appearance and keys' }).click()
  const box = settings.getByRole('checkbox', { name: 'Notification sounds' })
  await expect(box).toBeChecked()
  // A controlled box (see first-tab.spec.ts): click, then wait for main's stored state.
  await box.click()
  await expect(box).not.toBeChecked()
  await expect
    .poll(() => (JSON.parse(readFileSync(join(cockpit.dataDir, 'app.json'), 'utf8')) as { notificationSounds?: unknown }).notificationSounds)
    .toBe(false)
  await page.keyboard.press('Escape')

  await cockpit.hook('linkPlugin', FIXTURE)
  await cockpit.hook('enablePlugin', cockpit.projectDir, 'test.hostctx')
  await expect
    .poll(async () => (await cockpit.hook<RecordedNotice[]>('notificationDetails')).map((n) => n.body), { timeout: 15_000 })
    .toContain('chime please')
  const details = await cockpit.hook<RecordedNotice[]>('notificationDetails')
  expect(details.find((n) => n.body === 'chime please')).toMatchObject({ silent: true })
  expect(await cockpit.hook<number[]>('chimes')).toEqual([])
})

test('Settings picks a built-in notification sound and plays it once, and the picker follows the on/off switch', async ({
  cockpit
}) => {
  const { page } = cockpit
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.text().includes('notification sound')) errors.push(msg.text())
  })
  await page.keyboard.press('ControlOrMeta+,')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Appearance and keys' }).click()
  const sound = settings.getByRole('combobox', { name: 'Sound' })
  await expect(sound).toHaveValue('builtin:chime')
  // The built-ins come first, in their own group; the OS folders (whatever this machine has) after.
  const builtins = await sound.locator('optgroup[label="Built-in"] option').allTextContents()
  expect(builtins).toEqual(['Chime', 'Bell', 'Ping', 'Soft pop', 'Two-tone', 'Marimba'])
  await sound.selectOption('builtin:two-tone')
  await expect
    .poll(() => (JSON.parse(readFileSync(join(cockpit.dataDir, 'app.json'), 'utf8')) as { notificationSound?: unknown }).notificationSound)
    .toBe('builtin:two-tone')
  await expect(sound).toHaveValue('builtin:two-tone')
  const play = settings.getByRole('button', { name: 'Play' })
  await play.dblclick()
  await play.click()
  await expect(settings.getByRole('alert')).toHaveCount(0)

  // Sounds off: nothing to pick or play.
  await settings.getByRole('checkbox', { name: 'Notification sounds' }).click()
  await expect(sound).toBeDisabled()
  await expect(play).toBeDisabled()
  expect(errors).toEqual([])
})
