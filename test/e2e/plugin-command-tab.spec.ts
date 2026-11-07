// ctx.sessions.openCommand end to end (plan 20261107 Task 6): a fixture plugin (command-tab) opens a
// command tab whose argv is run with no shell, so `'x y'` arrives as ONE argument and the shell the
// argv itself names prints `hello-x y`. The tab's tooltip names the plugin. The app is then quit and
// started again over the same data dir: the tab comes back NOT started (Restart runs it), still marked.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { TabInfo } from '../../src/shared/ipc'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'

const PLUGIN = 'test.commandtab'
const fixture = join(__dirname, '..', 'fixtures', 'plugins', 'command-tab')
const ARGV = ['sh', '-c', 'echo "hello-$1"; sleep 30', 'sh', 'x y']
const MARK = `Opened by Command tab (${PLUGIN})`

/** The tabs saved in the project's record on disk (what the next start reads). */
function savedTabs(c: Cockpit): Array<Record<string, unknown>> {
  const dir = join(c.dataDir, 'projects')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  for (const name of names) {
    if (!/^[0-9a-f]{16}\.json$/.test(name)) continue
    const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { path: string; tabs: Array<Record<string, unknown>> }
    if (record.path === c.projectDir) return record.tabs
  }
  return []
}

test('a plugin opens a command tab: argv with no shell, marked, restored not started after a restart', async () => {
  const first = await launchCockpit()
  const root = first.cockpit.root
  try {
    const c = first.cockpit
    await c.hook('linkPlugin', fixture)
    await c.hook('enablePlugin', c.projectDir, PLUGIN)
    await expect
      .poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.map((p) => `${p.id}:${p.state}`), { timeout: 15_000 })
      .toEqual([`${PLUGIN}:active`])
    await c.hook('runPluginCommand', c.projectDir, `${PLUGIN}/open`)
    await expect.poll(() => c.hook<string[]>('notifications')).toContainEqual(expect.stringMatching(/^opened /))

    // focus: true selected it; the argv ran as is ('x y' one argument).
    await c.waitForTerminalText('hello-x y')
    const live = await c.hook<TabInfo[]>('tabs', c.projectDir)
    expect(live).toEqual([expect.objectContaining({ kind: 'command', label: 'Hello', argv: ARGV, openedBy: PLUGIN, openedByName: 'Command tab' })])
    expect(live[0]!.command).toBeUndefined()

    const tab = c.page.getByRole('tab', { name: 'Hello' })
    await expect(tab).toHaveAttribute('title', `sh -c 'echo "hello-$1"; sleep 30' sh 'x y'\n${c.projectDir}\n${MARK}`)

    await expect
      .poll(() => savedTabs(c).map((t) => [t.kind, t.label, t.argv, t.openedBy, t.command]))
      .toEqual([['command', 'Hello', ARGV, PLUGIN, undefined]])
  } finally {
    await first.close({ keepFiles: true })
  }

  const second = await launchCockpit({ root, folderArg: false })
  try {
    const c = second.cockpit
    const tab = c.page.getByRole('tab', { name: 'Hello' })
    await expect(tab).toHaveCount(1)
    // Back, waiting: nothing ran at launch, the banner offers Restart, the marker is still there.
    const restored = await c.hook<TabInfo[]>('tabs', c.projectDir)
    expect(restored).toEqual([expect.objectContaining({ kind: 'command', notStarted: true, gen: 0, argv: ARGV, openedBy: PLUGIN })])
    await expect(c.page.getByText('not started (restored commands run only when you ask)')).toBeVisible()
    await expect(tab).toHaveAttribute('title', new RegExp(`\\n${MARK.replace(/[()]/g, '\\$&')}$`))
    expect(await c.terminalText()).not.toContain('hello-x y')
  } finally {
    await second.close()
  }
})
