// Plan Task 29: the web shell in a plain browser (test/e2e/web-fixtures.ts) next to the Electron
// window, with web access on loopback. The access link signs the browser in (the token leaves the
// address bar, the desktop lists the device), the picker opens the project, and a shell tab is one
// terminal on both screens: what ran before the browser came is in its snapshot, the desktop's
// output reaches the browser live, the browser's typing reaches the tab and both screens show the
// result. A reload of the web page draws the same screen again from a fresh snapshot, with nothing
// replayed twice, and the reloaded page is live.
//
// Markers are printed by shell arithmetic (`echo web-$((50+5))` prints web-55), so the command line
// echoed back never contains the text a step waits for: only the shell's output does.
import type { CockpitApi } from '../../src/shared/ipc'
import { expect, test } from './fixtures'
import { enableWebAccess, openBrowser } from './web-fixtures'

/** How many times `marker` is on a screen (rows glued: a long row can wrap at either width). */
function count(text: string, marker: string): number {
  return text.replaceAll('\n', '').split(marker).length - 1
}

test('web access: the access link signs a browser in; a terminal tab is mirrored both ways and a reload re-snapshots', async ({ cockpit }) => {
  test.setTimeout(90_000)
  const { page } = cockpit
  // On before the tab starts: a tab already running when web access turns on is mirrored from a
  // blank screen (docs/features.md, known limitation), and this spec checks the whole screen.
  const web = await enableWebAccess(cockpit)
  await cockpit.newTab('shell')
  await cockpit.waitForTerminalText('FAKE-SHELL ready')
  await cockpit.typeLine('echo desk-$((40+2))')
  await cockpit.waitForTerminalText('desk-42')

  const browser = await openBrowser(web.link)
  try {
    const { page: webPage } = browser

    // 1. Sign-in: the link signs this browser in and the token is gone from the address bar; the
    //    picker lists the desktop's open project, and the desktop lists the new device.
    const projects = webPage.getByRole('list', { name: 'Open projects' }).getByRole('link')
    await expect(projects).toHaveCount(1)
    expect(webPage.url()).not.toContain('#t=')
    expect(webPage.url()).toBe(`${web.origin}/`)
    const devices = await page.evaluate(async () => {
      const api = (window as unknown as { cockpit: CockpitApi }).cockpit
      return (await api.invoke('settings.webAccess')).devices.map((d) => ({ mode: d.mode, name: d.name }))
    })
    // Named from the browser's user agent (sign-in.ts deviceName): "Chrome on <os>".
    expect(devices).toEqual([{ mode: 'link', name: expect.stringMatching(/^Chrome/) }])
    await projects.click()
    await expect(webPage).toHaveURL(`${web.origin}/?project=${encodeURIComponent(web.projectId)}`)
    // The desktop's top bar counts the browser once its view is live.
    await expect(page.locator('header.top-strip .web-access-chip')).toContainText('1 device')

    // 2. The tab's output before the browser came is in the browser's snapshot.
    await expect(webPage.getByRole('tab')).toHaveCount(1)
    await browser.waitForTerminalText('FAKE-SHELL ready')
    await browser.waitForTerminalText('desk-42')

    // 3. The desktop's output reaches the browser live.
    await cockpit.typeLine('echo live-$((60+6))')
    await cockpit.waitForTerminalText('live-66')
    await browser.waitForTerminalText('live-66')

    // 4. The browser's typing reaches the tab; both screens show the output, and the desktop says
    //    who typed last.
    await webPage.locator('.terminal-view:not([hidden]) .xterm').click()
    await webPage.keyboard.type('echo web-$((50+5))')
    await webPage.keyboard.press('Enter')
    await browser.waitForTerminalText('web-55')
    await cockpit.waitForTerminalText('web-55')
    await expect(page.getByText(/Typed last on Chrome/)).toBeVisible()

    // 5. A reload re-snapshots: the same markers, each exactly once (nothing replayed on top of the
    //    snapshot), and the reloaded page is live in both directions.
    const before = await browser.terminalText()
    for (const marker of ['desk-42', 'live-66', 'web-55']) expect(count(before, marker)).toBe(1)
    await webPage.reload()
    await browser.waitForTerminalText('web-55')
    const after = await browser.terminalText()
    for (const marker of ['FAKE-SHELL ready', 'desk-42', 'live-66', 'web-55']) expect(count(after, marker)).toBe(1)
    await cockpit.typeLine('echo again-$((70+7))')
    await browser.waitForTerminalText('again-77')
    await webPage.locator('.terminal-view:not([hidden]) .xterm').click()
    await webPage.keyboard.type('echo back-$((80+8))')
    await webPage.keyboard.press('Enter')
    await cockpit.waitForTerminalText('back-88')
    await browser.waitForTerminalText('back-88')
    expect(count(await cockpit.terminalText(), 'back-88')).toBe(1)
    expect(count(await browser.terminalText(), 'back-88')).toBe(1)
  } finally {
    await browser.close()
  }
})
