// Theme per view (design-web.md §5.7): with no theme picked, a browser view shows the built-in of its
// own `prefers-color-scheme`, not the desktop's appearance (a server has none, and used to paint
// every dark browser light). The browser reports its scheme at `hello`, so its first theme is
// already right, and again on every change; the desktop keeps following nativeTheme. A pick wins
// everywhere. The browser's scheme is Playwright's media emulation (its own nativeTheme does not
// reach `prefers-color-scheme` under Playwright, which emulates a scheme already); the desktop's is
// its nativeTheme, which is what main reads.
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { enableWebAccess, openBrowser, openProjectInBrowser } from './web-fixtures'

// A string expression: the e2e tsconfig has no DOM lib, and the code runs in the page anyway.
const cssVar = (page: Page, name: string): Promise<string> =>
  page.evaluate<string>(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`)

const LIGHT_BG = '#faf8f6'
const DARK_BG = '#1a1817'

test('web access: with no pick a browser follows its own colour scheme, the desktop its own; a pick wins in both', async ({ cockpit }) => {
  test.setTimeout(60_000)
  const { page } = cockpit
  // The desktop on a light screen, whatever the machine running the suite uses.
  await cockpit.app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'light'
  })
  await expect.poll(() => cssVar(page, '--cc-bg')).toBe(LIGHT_BG)
  const web = await enableWebAccess(cockpit)
  const browser = await openBrowser(web.link)
  try {
    const { page: webPage } = browser
    // A dark browser: its picker page (which main never themes) is dark already.
    await webPage.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => cssVar(webPage, '--cc-bg')).toBe(DARK_BG)

    // Its project view joins dark (the scheme came with `hello`); the desktop stays light.
    await openProjectInBrowser(browser, web.origin, web.projectId)
    await expect.poll(() => cssVar(webPage, '--cc-bg')).toBe(DARK_BG)
    await expect(webPage.locator('body')).toHaveCSS('background-color', 'rgb(26, 24, 23)')
    expect(await cssVar(page, '--cc-bg')).toBe(LIGHT_BG)

    // The browser's screen turns light: `theme.scheme`, that view only.
    await webPage.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => cssVar(webPage, '--cc-bg')).toBe(LIGHT_BG)
    // The desktop's screen turns dark: the browser that reported its own scheme keeps it.
    await cockpit.app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark'
    })
    await expect.poll(() => cssVar(page, '--cc-bg')).toBe(DARK_BG)
    expect(await cssVar(webPage, '--cc-bg')).toBe(LIGHT_BG)

    // A pick is the same everywhere, and "follow the system" goes back to each screen's own.
    await cockpit.hook('setTheme', 'dark')
    await expect.poll(() => cssVar(webPage, '--cc-bg')).toBe(DARK_BG)
    await cockpit.hook('setTheme', 'light')
    await expect.poll(() => cssVar(page, '--cc-bg')).toBe(LIGHT_BG)
    await expect.poll(() => cssVar(webPage, '--cc-bg')).toBe(LIGHT_BG)
    await cockpit.hook('setTheme', null)
    await expect.poll(() => cssVar(page, '--cc-bg')).toBe(DARK_BG)
    await expect.poll(() => cssVar(webPage, '--cc-bg')).toBe(LIGHT_BG)
  } finally {
    await browser.close()
  }
})
