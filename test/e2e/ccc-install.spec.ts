// Task 35: Settings > General > "Install `ccc` command". HOME is the harness's temp
// home (fixtures.ts), so the link lands in <temp home>/.local/bin and nothing real is touched.
// A foreign file at that path is refused and left as it was.
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, launchCockpit, test } from './fixtures'

test('install the ccc command: creates ~/.local/bin/ccc, which runs the CLI', async ({ cockpit }) => {
  const { page } = cockpit
  const link = join(cockpit.root, 'home', '.local', 'bin', 'ccc')
  await page.keyboard.press('ControlOrMeta+,')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'General', exact: true }).click()

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
  await settings.getByRole('button', { name: 'General', exact: true }).click()

  const row = settings.getByTestId('ccc-command')
  await expect(row).toContainText('is already something else')
  await expect(row.getByRole('button', { name: 'Install ccc command' })).toBeDisabled()
  expect(readFileSync(join(bin, 'ccc'), 'utf8')).toBe('my own script\n')
})

// The start-up question (main/hooks/ccc-offer.ts). Never asked in a test run unless the launch sets
// CC_COCKPIT_CCC_OFFER=1, so every other spec runs without the dialog.
const OFFER = { CC_COCKPIT_CCC_OFFER: '1' }

test('start-up offer: not shown in a plain test run', async ({ cockpit }) => {
  await expect(cockpit.page.getByRole('alertdialog')).toHaveCount(0)
})

test('start-up offer: Yes installs the link and says so; the dialog is not asked again', async () => {
  const { cockpit: c, close } = await launchCockpit({ env: OFFER })
  try {
    const dialog = c.page.getByRole('alertdialog', { name: 'Install the ccc command?' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('use ccc to talk to this app')
    await expect(dialog.getByRole('button', { name: 'No' })).toBeFocused()
    await dialog.getByRole('button', { name: 'Yes' }).click()
    const done = c.page.getByRole('alertdialog', { name: 'ccc is installed' })
    await expect(done).toContainText("is not on your shell's PATH")
    await c.page.screenshot({ path: process.env.CCC_SHOT2 ?? join(c.root, 'offer-done.png') })
    const link = join(c.root, 'home', '.local', 'bin', 'ccc')
    expect(readlinkSync(link)).toBe(join(c.dataDir, 'bin', 'ccc'))
    await done.getByRole('button', { name: 'OK' }).click()
    await expect(c.page.getByRole('alertdialog')).toHaveCount(0)
    // Saved nothing: the box was not checked.
    expect(JSON.parse(readFileSync(join(c.dataDir, 'app.json'), 'utf8'))).not.toHaveProperty('cccOffer')
  } finally {
    await close()
  }
})

test('start-up offer: No closes it; Don\'t ask again persists across a relaunch; Settings turns it back on', async () => {
  const first = await launchCockpit({ env: OFFER })
  const link = join(first.cockpit.root, 'home', '.local', 'bin', 'ccc')
  let root: string
  try {
    const { page } = first.cockpit
    const dialog = page.getByRole('alertdialog', { name: 'Install the ccc command?' })
    await expect(dialog).toBeVisible()
    await page.screenshot({ path: process.env.CCC_SHOT ?? join(first.cockpit.root, 'offer.png') })
    await dialog.getByRole('button', { name: 'No' }).click()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    expect(existsSync(link)).toBe(false)
    expect(JSON.parse(readFileSync(join(first.cockpit.dataDir, 'app.json'), 'utf8'))).not.toHaveProperty('cccOffer')
    root = first.cockpit.root
  } finally {
    await first.close({ keepFiles: true })
  }

  // Asked again at the next launch (No saved nothing); this time with the box checked.
  const second = await launchCockpit({ env: OFFER, root })
  try {
    const { page, dataDir } = second.cockpit
    const dialog = page.getByRole('alertdialog', { name: 'Install the ccc command?' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('checkbox', { name: "Don't ask again" }).check()
    await dialog.getByRole('button', { name: 'No' }).click()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect.poll(() => (JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8')) as { cccOffer?: unknown }).cccOffer).toBe(false)
  } finally {
    await second.close({ keepFiles: true })
  }

  const third = await launchCockpit({ env: OFFER, root })
  try {
    const { page, dataDir } = third.cockpit
    await page.waitForTimeout(1500)
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+,')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'General', exact: true }).click()
    const box = settings.getByRole('checkbox', { name: 'Offer to install at start-up' })
    await expect(box).not.toBeChecked()
    await box.click()
    await expect(box).toBeChecked()
    await expect.poll(() => (JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8')) as { cccOffer?: unknown }).cccOffer).toBeUndefined()
  } finally {
    await third.close({ keepFiles: true })
  }

  const fourth = await launchCockpit({ env: OFFER, root })
  try {
    await expect(fourth.cockpit.page.getByRole('alertdialog', { name: 'Install the ccc command?' })).toBeVisible()
  } finally {
    await fourth.close()
  }
})
