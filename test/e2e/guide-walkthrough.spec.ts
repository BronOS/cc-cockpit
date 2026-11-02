// Plan B Task 11: the walkthrough in `ccc guide plugins` is the tested example. The spec takes the
// code blocks (fence info = "<lang> <file name>") from the CLI's own output only, writes them to a
// temp dir, links the folder through `ccc plugin link` (the confirm answered Allow), and checks the
// panel, the `ctx.cli` command and the skill dir. A guide edit that breaks the walkthrough fails here.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expect, test } from './fixtures'

const ID = 'acme.greeter'

/** Every fenced block whose info string has a second word (the file name); plain blocks are skipped. */
function walkthroughFiles(guide: string): [string, string][] {
  return [...guide.matchAll(/^```\w+ (\S+)\n([\s\S]*?)^```$/gm)].map((m) => [m[1]!, m[2]!])
}

test('the plugins guide walkthrough builds a plugin that links and runs: panel, command, skill', async ({ cockpit }) => {
  const { page } = cockpit
  // Run the built CLI exactly as a Claude session would; no socket is involved for the guide.
  const guide = execFileSync(join(cockpit.dataDir, 'bin', 'ccc'), ['guide', 'plugins'], { encoding: 'utf8' })
  const blocks = walkthroughFiles(guide)
  // An array, not a Map: a duplicated block must fail here instead of the last copy winning.
  const names = blocks.map(([name]) => name)
  expect(new Set(names).size).toBe(names.length)
  const files = new Map(blocks)
  expect([...names].sort()).toEqual(
    ['dist/host.js', 'panels/main.html', 'panels/main.js', 'plugin.json', 'skills/greet/SKILL.md'].sort()
  )

  const dir = join(cockpit.root, 'walkthrough')
  for (const [name, body] of files) {
    const file = join(dir, name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, body)
  }

  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')

  // Link needs a person: Allow answers the native confirm.
  await cockpit.hook('answerLink', true)
  await cockpit.typeLine(`/ccc plugin link ${dir}`)
  await cockpit.waitForTerminalText(/FAKE-CLAUDE ccc exit=0 out="linked acme\.greeter \(Greeter\) and enabled it/)
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: ID, state: 'active' }] })

  // ctx.cli: the command the manifest declares.
  await cockpit.typeLine('/ccc greet world')
  await cockpit.waitForTerminalText('FAKE-CLAUDE ccc exit=0 out="hello world\\n" err=""')

  // Panel: the page posts { ping: 1 } and the host echoes it back.
  await page.locator('.zone-left').getByRole('button', { name: /^Greeter/ }).click()
  const iframe = page.locator('section.panel[aria-label="Greeter"] iframe')
  await expect(iframe).toHaveAttribute('src', `cc-plugin://${ID}/panels/main.html`)
  await expect(page.frameLocator('section.panel[aria-label="Greeter"] iframe').locator('#out')).toHaveText(
    '{"echo":{"ping":1}}',
    { timeout: 15_000 }
  )

  // Skill: copied into the generated tree, and a new Claude tab of this project gets its --plugin-dir.
  const child = join(cockpit.dataDir, 'claude-plugins', ID)
  expect(readFileSync(join(child, 'skills', 'greet', 'SKILL.md'), 'utf8')).toBe(files.get('skills/greet/SKILL.md'))
  expect(existsSync(join(child, '.claude-plugin', 'plugin.json'))).toBe(true)
  await cockpit.newTab('claude')
  await expect.poll(() => cockpit.claudeRuns().length).toBe(2)
  expect(cockpit.claudeRuns()[1]).toContain(child)
})
