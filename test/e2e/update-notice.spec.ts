// The update notice and its Settings toggle (plan: distribution, Task 5). A test run never reaches
// GitHub: the `fakeRelease` hook sets what the update check's fetcher answers and runs one check.
// Shown, dismissed, still dismissed after a relaunch, shown again for a newer version, and absent
// with the setting off. The release link opens only main's own URL, and only while an update is on offer.
import { launchCockpit, expect, test } from './fixtures'

test('update notice: shown, dismissed for good, back for a newer version, off with the setting', async () => {
  const first = await launchCockpit()
  const root = first.cockpit.root
  try {
    const { page } = first.cockpit
    const bar = page.getByRole('status', { name: 'Update available' })
    await expect(bar).toHaveCount(0)

    // A recorder in place of shell.openExternal: nothing may reach the real browser.
    await first.cockpit.app.evaluate(({ shell }) => {
      const g = globalThis as { __opened?: string[] }
      g.__opened = []
      shell.openExternal = (url: string) => {
        g.__opened!.push(url)
        return Promise.resolve()
      }
    })
    const opened = (): Promise<string[]> => first.cockpit.app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])
    const RELEASE_PAGE = 'https://github.com/BronOS/cc-cockpit/releases/tag/v99.0.0'
    const openRelease = (arg: string): Promise<unknown> => page.evaluate(`window.cockpit.invoke('updates.openRelease'${arg}).then(() => null)`)

    // No update on offer: nothing opens.
    await openRelease('')
    expect(await opened()).toEqual([])

    await first.cockpit.hook('fakeRelease', 'v99.0.0')
    await expect(bar).toBeVisible()
    await expect(bar).toContainText('cc-cockpit 99.0.0 is available')
    await expect(bar).toContainText('Quit cc-cockpit before upgrading, or restart it afterwards.')
    await bar.getByRole('button', { name: /Release notes|Open release page/ }).click()
    await expect.poll(opened).toEqual([RELEASE_PAGE])

    // A URL from the renderer is ignored: main opens the page it built.
    await openRelease(", { url: 'https://evil.example/' }")
    expect(await opened()).toEqual([RELEASE_PAGE, RELEASE_PAGE])

    await bar.getByRole('button', { name: 'Dismiss' }).click()
    await expect(bar).toHaveCount(0)

    // Dismissed: no longer on offer, so nothing opens.
    await openRelease('')
    expect(await opened()).toEqual([RELEASE_PAGE, RELEASE_PAGE])
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

    // A dismiss of the version a window showed before this one, or of no string at all, changes nothing.
    for (const arg of ["{ version: '99.0.0' }", "{ version: 99 }", 'undefined']) {
      await c.page.evaluate(`window.cockpit.invoke('updates.dismiss', ${arg}).then(() => null)`)
    }
    await expect(c.page.evaluate(`window.cockpit.invoke('updates.state').then((s) => s.available && s.available.version)`)).resolves.toBe('99.0.1')
    await expect(bar).toContainText('cc-cockpit 99.0.1 is available')

    // Settings: the toggle is on and shows the version; off removes the bar and stops the check.
    await c.page.keyboard.press('ControlOrMeta+,')
    const settings = c.page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'General', exact: true }).click()
    // The bar is inert behind Settings: no Tab or Enter reaches its buttons.
    await expect(c.page.locator('.update-notice')).toHaveAttribute('inert', '')
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
