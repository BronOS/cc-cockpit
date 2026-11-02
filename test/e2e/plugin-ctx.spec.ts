// Task 26: the host ctx in the real plugin host (utilityProcess): settings with defaults applied by
// main, storage and dataDir on disk, exec without a shell, notify, ctx.log into
// <data>/logs/<pluginId>.log, and a manifest command that main lists and runs in the host.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { CommandInfo } from '../../src/shared/ipc'
import { expect, test } from './fixtures'

const FIXTURE = join(__dirname, '..', 'fixtures', 'plugins', 'host-ctx')

test('a plugin uses settings, storage, exec, notify, log and a command through its ctx', async ({ cockpit }) => {
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
    exec: { code: number; stdout: string; stderr: string }
    undeclaredError: string
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
  // stdin arrived and the argument stayed literal.
  expect(seen.exec).toEqual({ code: 0, stdout: 'in:$(echo pwned)', stderr: '' })
  expect(seen.undeclaredError).toContain('not declared')

  // The KV file lands within the 300 ms debounce.
  const storageFile = join(seen.dataDir, 'storage.json')
  await expect.poll(() => existsSync(storageFile)).toBe(true)
  expect(JSON.parse(readFileSync(storageFile, 'utf8')).values).toEqual({ answer: { n: 42 } })
  expect(readdirSync(join(cockpit.dataDir, 'plugin-data'))).toHaveLength(1)

  expect(await cockpit.hook<string[]>('notifications')).toContain('hello from the fixture plugin')

  const logFile = join(cockpit.dataDir, 'logs', 'test.hostctx.log')
  await expect.poll(() => existsSync(logFile)).toBe(true)
  expect(readFileSync(logFile, 'utf8')).toMatch(/ info \[[0-9a-f]{16}\] fixture log line\n/)

  // Only the registered command appears, with the manifest's key, and it runs in the host.
  const listed = await cockpit.hook<CommandInfo[]>('pluginCommands', cockpit.projectDir)
  expect(listed).toEqual([{ id: 'test.hostctx/ping', title: 'Ctx: Ping', key: 'shift+meta+9', source: 'plugin' }].map((c) =>
    process.platform === 'darwin' ? c : { ...c, key: 'shift+ctrl+9' }
  ))
  await cockpit.hook('runPluginCommand', cockpit.projectDir, 'test.hostctx/ping')
  expect(readFileSync(join(seen.dataDir, 'ping.txt'), 'utf8')).toBe('pong')
})
