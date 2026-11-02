// Task 35: Settings > Appearance and keys > "Install `ccc` command". HOME is the harness's temp
// home (fixtures.ts), so the link lands in <temp home>/.local/bin and nothing real is touched.
// A foreign file at that path is refused and left as it was.
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test('install the ccc command: creates ~/.local/bin/ccc, which runs the CLI', async ({ cockpit }) => {
  const { page } = cockpit
  const link = join(cockpit.root, 'home', '.local', 'bin', 'ccc')
  await page.keyboard.press('ControlOrMeta+,')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Appearance and keys' }).click()

  const row = settings.getByTestId('ccc-command')
  const install = row.getByRole('button', { name: 'Install ccc command' })
  await expect(install).toBeEnabled()
  await install.click()
  await expect(row.getByText('installed', { exact: true })).toBeVisible()
  await expect(install).toBeDisabled()
  // The temp home's ~/.local/bin is not on the (fake shell's) login PATH: the page says so.
  await expect(row).toContainText('is not on your shell')

  expect(lstatSync(link).isSymbolicLink()).toBe(true)
  expect(readlinkSync(link)).toBe(join(cockpit.dataDir, 'bin', 'ccc'))
  // The link works from outside the app: a hook call without a running socket token exits 0 silently.
  const out = execFileSync(link, ['hook', 'Stop'], { input: '{}', encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
  expect(out).toBe('')
})

test('install the ccc command: a foreign file at ~/.local/bin/ccc is left alone', async ({ cockpit }) => {
  const { page } = cockpit
  const bin = join(cockpit.root, 'home', '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'ccc'), 'my own script\n')
  await page.keyboard.press('ControlOrMeta+,')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Appearance and keys' }).click()

  const row = settings.getByTestId('ccc-command')
  await expect(row).toContainText('is already something else')
  await expect(row.getByRole('button', { name: 'Install ccc command' })).toBeDisabled()
  expect(readFileSync(join(bin, 'ccc'), 'utf8')).toBe('my own script\n')
})
