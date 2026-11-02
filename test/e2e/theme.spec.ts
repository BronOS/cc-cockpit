import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// A string expression: the e2e tsconfig has no DOM lib, and the code runs in the page anyway.
const cssVar = (page: Page, name: string): Promise<string> =>
  page.evaluate<string>(
    `getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`
  )

test('switching theme changes a CSS var and the page background in every open window', async ({ cockpit }) => {
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-e2e-second-')))
  try {
    await cockpit.hook('openProject', other)
    await expect.poll(() => cockpit.app.windows().length).toBe(2)
    const pages = cockpit.app.windows()
    for (const p of pages) await p.locator('.tabs-pane').waitFor()

    await cockpit.hook('setTheme', 'light')
    for (const p of pages) await expect.poll(() => cssVar(p, '--cc-bg')).toBe('#faf8f6')

    await cockpit.hook('setTheme', 'dark')
    for (const p of pages) await expect.poll(() => cssVar(p, '--cc-bg')).toBe('#1a1817')

    // The shell styles read the variables: the page background follows.
    await cockpit.hook('setTheme', 'light')
    await expect(cockpit.page.locator('body')).toHaveCSS('background-color', 'rgb(250, 248, 246)')
  } finally {
    rmSync(other, { recursive: true, force: true })
  }
})
