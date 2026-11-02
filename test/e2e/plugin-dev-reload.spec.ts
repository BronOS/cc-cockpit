// Task 29: a linked dev plugin reloads inside the running plugin host when its folder changes
// (real fs watcher, real utilityProcess). The process stays; the plugin's new code runs; a broken
// manifest takes it down with the reason, and fixing it brings it back.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expect, test } from './fixtures'

const manifest = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ id: 'test.devreload', name: 'Dev reload', version: '1.0.0', api: 1, main: 'host.js', ...extra })

/** Records "<tag> <pid> <activations so far>" in $HOME at every activate, and deactivation in a second file. */
const hostJs = (tag: string): string => `
const fs = require('node:fs')
const path = require('node:path')
const dep = require('./dep')
exports.activate = () => {
  const log = path.join(process.env.HOME, 'dev-reload.log')
  fs.appendFileSync(log, '${tag} ' + dep + ' ' + process.pid + '\\n')
}
exports.deactivate = () => {
  fs.appendFileSync(path.join(process.env.HOME, 'dev-reload.log'), 'bye ${tag}\\n')
}
`

test('editing a linked plugin reloads it in the running host; an invalid manifest disables it with the reason', async ({ cockpit }) => {
  const folder = join(cockpit.root, 'devplugin')
  mkdirSync(folder)
  writeFileSync(join(folder, 'plugin.json'), manifest())
  writeFileSync(join(folder, 'dep.js'), "module.exports = 'dep1'")
  writeFileSync(join(folder, 'host.js'), hostJs('v1'))
  const logFile = join(cockpit.root, 'home', 'dev-reload.log')
  const lines = (): string[] => {
    try {
      return readFileSync(logFile, 'utf8').trim().split('\n')
    } catch {
      return []
    }
  }

  await cockpit.hook('linkPlugin', folder)
  await cockpit.hook('enablePlugin', cockpit.projectDir, 'test.devreload')
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: 'test.devreload', state: 'active' }] })
  await expect.poll(lines, { timeout: 10_000 }).toHaveLength(1)
  const pid = lines()[0]?.split(' ')[2]

  // New code and a changed nested module: deactivate of the old copy, then the new one activates
  // from the files as they are now, in the same process.
  writeFileSync(join(folder, 'dep.js'), "module.exports = 'dep2'")
  writeFileSync(join(folder, 'host.js'), hostJs('v2'))
  await expect.poll(lines, { timeout: 15_000 }).toEqual([`v1 dep1 ${pid}`, 'bye v1', `v2 dep2 ${pid}`])

  // An invalid manifest (the main file is gone from it): the plugin is down, with the reason.
  writeFileSync(join(folder, 'plugin.json'), manifest({ main: 'missing.js' }))
  await expect
    .poll(async () => (await cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir))?.plugins[0], { timeout: 15_000 })
    .toMatchObject({ id: 'test.devreload', state: 'errored', error: expect.stringContaining('plugin disabled: invalid plugin') })
  expect(lines().at(-1)).toBe('bye v2')

  // Fixed: back in the same process.
  writeFileSync(join(folder, 'plugin.json'), manifest())
  await expect
    .poll(async () => (await cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir))?.plugins[0], { timeout: 15_000 })
    .toEqual({ id: 'test.devreload', state: 'active' })
  expect(lines().at(-1)).toBe(`v2 dep2 ${pid}`)
})
