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

// Friction round 1, Task 2: the dev loop is "edit, the app reloads by itself, run the command".
// A `ccc` command sent in the gap of a reload (old copy deactivated, new one not active yet) is
// served by the new copy once it is active, never refused or left hanging. The plugin takes half a
// second to deactivate and half a second to activate, so calls sent every 100 ms after the edit
// are sure to land in the gap; the shell tab runs the real `ccc`, as Claude's Bash tool would.
test('a plugin command sent right after an edit is served by the new copy, not refused and not hung', async ({ cockpit }) => {
  const folder = join(cockpit.root, 'cliplugin')
  mkdirSync(folder)
  writeFileSync(
    join(folder, 'plugin.json'),
    JSON.stringify({ id: 'test.reloadcli', name: 'Reload CLI', version: '1.0.0', api: 1, main: 'host.js', contributes: { cli: [{ name: 'rl', summary: 'Echo' }] } })
  )
  const slowHost = (tag: string): string => `
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
exports.activate = async (ctx) => {
  await wait(500)
  ctx.cli.register('rl', (argv) => ({ stdout: '${tag} ' + argv.join(' ') + '\\n' }))
}
exports.deactivate = () => wait(500)
`
  writeFileSync(join(folder, 'host.js'), slowHost('v1'))
  await cockpit.hook('linkPlugin', folder)
  await cockpit.hook('enablePlugin', cockpit.projectDir, 'test.reloadcli')
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: 'test.reloadcli', state: 'active' }] })
  await cockpit.newTab('shell')
  await cockpit.waitForTerminalText('FAKE-SHELL ready')

  // The edit, then 30 calls 100 ms apart, each with its exit code, time and output.
  const log = join(cockpit.root, 'calls.log')
  writeFileSync(join(folder, 'host.js'), slowHost('v2'))
  await cockpit.typeLine(
    `for i in $(seq 1 30); do s=$(date +%s%N); out=$(ccc rl x 2>&1 </dev/null); rc=$?; ms=$(( ($(date +%s%N) - s) / 1000000 )); echo "rc=$rc ms=$ms out=$out" >> '${log}'; sleep 0.1; done; echo DONE >> '${log}'`
  )
  const read = (): string => {
    try {
      return readFileSync(log, 'utf8')
    } catch {
      return ''
    }
  }
  // 30 calls of ~50 ms plus the sleeps, one of them waiting about a second: well under this.
  await expect.poll(read, { timeout: 30_000 }).toContain('DONE')
  const calls = read().trim().split('\n').slice(0, -1).map((line) => /^rc=(\d+) ms=(\d+) out=(.*)$/.exec(line))
  expect(calls).toHaveLength(30)
  for (const c of calls) {
    expect(c?.[1], c?.[0]).toBe('0')
    expect(c?.[3]).toMatch(/^v[12] x$/)
  }
  // The new copy took over, and at least one call landed in the gap and waited for it.
  expect(calls.at(-1)?.[3]).toBe('v2 x')
  expect(Math.max(...calls.map((c) => Number(c?.[2])))).toBeGreaterThan(300)
})
