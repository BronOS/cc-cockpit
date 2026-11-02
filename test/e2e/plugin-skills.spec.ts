// Plan B, Task 3: plugin-contributed skills. A linked plugin that declares `contributes.skills` is
// copied into `<data>/claude-plugins/<pluginId>/` as a Claude Code plugin, and a Claude tab of a
// project that enables it starts with one more `--plugin-dir` (the fake `claude` records its argv).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

const FIXTURE = join(__dirname, '..', 'fixtures', 'plugins', 'with-skill')
const ID = 'test.with-skill'

test('a linked plugin with a skill is loaded into a new Claude tab of a project that enables it', async ({ cockpit }) => {
  await cockpit.hook('linkPlugin', FIXTURE)
  const child = join(cockpit.dataDir, 'claude-plugins', ID)
  // Copied as soon as the link resolves, named for Claude after the plugin id.
  expect(JSON.parse(readFileSync(join(child, '.claude-plugin', 'plugin.json'), 'utf8'))).toEqual({
    name: 'ccc-test-with-skill',
    version: '1.0.0'
  })
  expect(readFileSync(join(child, 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe(
    readFileSync(join(FIXTURE, 'skills', 'demo', 'SKILL.md'), 'utf8')
  )

  // Linked but not enabled here: a Claude tab gets core only.
  const core = join(cockpit.dataDir, 'claude-plugins', 'core')
  const hooks = join(cockpit.dataDir, 'hooks.json')
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  await expect.poll(() => cockpit.claudeRuns()).toEqual([['--settings', hooks, '--plugin-dir', core]])

  await cockpit.hook('enablePlugin', cockpit.projectDir, ID)
  await cockpit.newTab('claude')
  await expect.poll(() => cockpit.claudeRuns().length).toBe(2)
  expect(cockpit.claudeRuns()[1]).toEqual(['--settings', hooks, '--plugin-dir', core, '--plugin-dir', child])
})
