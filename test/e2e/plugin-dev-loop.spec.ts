// Plan B Task 6: the plugin dev loop from inside a Claude tab. The fake `claude` runs `/ccc <args>`
// like Claude's Bash tool and prints `FAKE-CLAUDE ccc exit=<code> out=<json> err=<json>`. The
// confirm dialog of `ccc plugin link` is answered by the `answerLink` test hook (none queued = Deny).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expect, test } from './fixtures'

const ID = 'local.devplugin'

test('new -> link (Allow) -> active -> edit -> reload -> logs; Deny, list and unlink', async ({ cockpit }) => {
  const dir = join(cockpit.root, 'devplugin')
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')

  // Scaffold: pure CLI, files on disk, the next step printed.
  await cockpit.typeLine(`/ccc plugin new ${dir} --cli devdemo`)
  await cockpit.waitForTerminalText(/FAKE-CLAUDE ccc exit=0 out="created plugin local\.devplugin in /)
  expect(existsSync(join(dir, 'plugin.json'))).toBe(true)
  expect(existsSync(join(dir, 'dist', 'host.js'))).toBe(true)

  // Deny is the default: no answer queued, nothing is linked, the command says "declined".
  await cockpit.typeLine(`/ccc plugin link ${dir}`)
  await cockpit.waitForTerminalText(/FAKE-CLAUDE ccc exit=1 out="" err="ccc: declined/)
  expect(await cockpit.hook<Array<{ id: string; name: string; path: string }>>('linkDialogs')).toMatchObject([
    { id: ID, name: 'Devplugin', path: expect.stringContaining('devplugin') }
  ])
  expect(await cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir)).toMatchObject({ plugins: [] })

  // Allow: linked and enabled in this project, and the host runs it.
  await cockpit.hook('answerLink', true)
  await cockpit.typeLine(`/ccc plugin link ${dir}`)
  await cockpit.waitForTerminalText(/FAKE-CLAUDE ccc exit=0 out="linked local\.devplugin \(Devplugin\) and enabled it in this project/)
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: ID, state: 'active' }] })

  // The command the scaffold declared works.
  await cockpit.typeLine('/ccc devdemo hi there')
  await cockpit.waitForTerminalText('FAKE-CLAUDE ccc exit=0 out="devdemo: hi there\\n" err=""')

  // list: one row for the plugin, enabled here.
  await cockpit.typeLine('/ccc plugin list')
  await cockpit.waitForTerminalText(`${ID}\\t0.1.0\\tlinked\\tenabled\\tok`)

  // Edit the linked plugin: the host reloads it by itself, the new activate logs a new line.
  const hostFile = join(dir, 'dist', 'host.js')
  writeFileSync(hostFile, readFileSync(hostFile, 'utf8').replace("ctx.log.info('activated')", "ctx.log.info('activated v2')"))
  const logFile = join(cockpit.dataDir, 'logs', `${ID}.log`)
  await expect
    .poll(() => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''), { timeout: 15_000 })
    .toContain('activated v2')
  await cockpit.typeLine(`/ccc plugin logs ${ID}`)
  await cockpit.waitForTerminalText('activated v2')

  // A path-like id never reaches a file: a usage error.
  await cockpit.typeLine('/ccc plugin logs ../../secret')
  await cockpit.waitForTerminalText(/FAKE-CLAUDE ccc exit=2 out="" err="ccc: plugin logs: not a plugin id/)

  // unlink removes it; its command is unknown again.
  await cockpit.typeLine(`/ccc plugin unlink ${ID}`)
  await cockpit.waitForTerminalText(`FAKE-CLAUDE ccc exit=0 out="unlinked ${ID}\\n"`)
  await cockpit.typeLine('/ccc devdemo x')
  await cockpit.waitForTerminalText('ccc: unknown command: devdemo')
})
