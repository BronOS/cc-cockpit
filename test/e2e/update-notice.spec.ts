// The update notice and its Settings toggle (plan: distribution, Task 5). A test run never reaches
// GitHub: the `fakeRelease` hook sets what the update check's fetcher answers and runs one check.
// Shown, dismissed, still dismissed after a relaunch, shown again for a newer version, and absent
// with the setting off.
import { launchCockpit, expect, test } from './fixtures'

test('update notice: shown, dismissed for good, back for a newer version, off with the setting', async () => {
  const first = await launchCockpit()
  const root = first.cockpit.root
  try {
    const { page } = first.cockpit
    const bar = page.getByRole('status', { name: 'Update available' })
    await expect(bar).toHaveCount(0)

    await first.cockpit.hook('fakeRelease', 'v99.0.0')
    await expect(bar).toBeVisible()
    await expect(bar).toContainText('cc-cockpit 99.0.0 is available')
    await expect(bar).toContainText('Quit cc-cockpit before upgrading, or restart it afterwards.')
    await expect(bar.getByRole('button', { name: /Release notes|Open release page/ })).toBeVisible()

    await bar.getByRole('button', { name: 'Dismiss' }).click()
    await expect(bar).toHaveCount(0)
  } finally {
    await first.close({ keepFiles: true })
  }

  // The dismissal is in app.json: the same version stays quiet, a newer one shows again.
  const second = await launchCockpit({ root })
  try {
    const c = second.cockpit
    const bar = c.page.getByRole('status', { name: 'Update available' })
    await c.hook('fakeRelease', 'v99.0.0')
    await expect(bar).toHaveCount(0)
    await c.hook('fakeRelease', 'v99.0.1')
    await expect(bar).toContainText('cc-cockpit 99.0.1 is available')

    // Settings: the toggle is on and shows the version; off removes the bar and stops the check.
    await c.page.keyboard.press('ControlOrMeta+,')
    const settings = c.page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Appearance and keys' }).click()
    const toggle = settings.getByLabel('Check for new versions')
    await expect(toggle).toBeChecked()
    await toggle.click()
    await expect(toggle).not.toBeChecked()
    await expect(bar).toHaveCount(0)
    await c.hook('fakeRelease', 'v99.0.2')
    await expect(bar).toHaveCount(0)

    // On again: checks at once and shows the newest.
    await toggle.click()
    await expect(toggle).toBeChecked()
    await expect(bar).toContainText('cc-cockpit 99.0.2 is available')
  } finally {
    await second.close()
  }
})
