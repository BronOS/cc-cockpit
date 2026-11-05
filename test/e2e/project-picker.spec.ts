// The top strip's "+" (and File › Open Project) shows the project picker over open projects: one
// picker however often it is asked for, and a pick opens (or focuses) that project and closes it.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { expect, test } from './fixtures'

/** Titles of main's windows, sorted: a project window is titled by its project, the picker "cc-cockpit". */
const titles = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()).sort())

test('the strip’s + shows the picker, once; picking a recent project opens it and closes the picker', async ({
  cockpit
}) => {
  const dirB = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-e2e-picker-b-')))
  const nameA = basename(cockpit.projectDir)
  const nameB = basename(dirB)
  try {
    const { app, page } = cockpit
    // Project B becomes a recent project that is not open: opened, then its window closed.
    await cockpit.hook('openProject', dirB)
    await expect.poll(() => titles(app)).toEqual([nameA, nameB].sort())
    await app.evaluate(({ BrowserWindow }, name) => {
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === name)
        ?.close()
    }, nameB)
    await expect.poll(() => titles(app)).toEqual([nameA])

    // No Claude tab anywhere: the bar is there all the same, with its "+".
    const plus = page.locator('.top-strip').getByRole('button', { name: 'Open project…' })
    await expect(plus).toHaveAttribute('title', 'Open project…')
    await plus.click()
    await expect.poll(() => titles(app)).toEqual(['cc-cockpit', nameA].sort())
    await expect.poll(() => app.windows().length).toBe(2)
    const picker = app.windows().find((p) => p !== page)!
    await picker.locator('.picker').waitFor()

    // Asked again: focused, not a second picker. The `window.info` round trip from the same page
    // is handled after the click's request (one renderer's messages are handled in order).
    await plus.click()
    await page.evaluate(() =>
      (globalThis as unknown as { cockpit: { invoke(c: string): Promise<unknown> } }).cockpit.invoke('window.info')
    )
    expect(await titles(app)).toEqual(['cc-cockpit', nameA].sort())

    // The picker lists B (and A, which is open); picking B opens its window and the picker goes.
    const rowB = picker.locator('.picker li', { hasText: dirB })
    await rowB.getByRole('button', { name: nameB, exact: true }).click()
    await expect.poll(() => titles(app)).toEqual([nameA, nameB].sort())
    await expect.poll(() => app.windows().filter((p) => p !== page && p !== picker && !p.isClosed()).length).toBe(1)
    const pageB = app.windows().find((p) => p !== page && p !== picker && !p.isClosed())!
    await pageB.locator('.tabs-pane').waitFor()
    await expect(pageB.locator('.top-strip').getByRole('button', { name: 'Open project…' })).toBeVisible()
  } finally {
    rmSync(dirB, { recursive: true, force: true })
  }
})

test('opened from a project window the picker is its modal child; Esc closes it and the parent is usable again', async ({
  cockpit
}) => {
  const { app, page } = cockpit
  const nameA = basename(cockpit.projectDir)
  await page.locator('.top-strip').getByRole('button', { name: 'Open project…' }).click()
  await expect.poll(() => app.windows().length).toBe(2)
  const picker = app.windows().find((p) => p !== page)!
  await picker.locator('.picker').waitFor()
  // main's own BrowserWindow state: the picker's parent is the project window that asked.
  const relation = (): Promise<{ parent: string | null; modal: boolean } | undefined> =>
    app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'cc-cockpit')
      return w ? { parent: w.getParentWindow()?.getTitle() ?? null, modal: w.isModal() } : undefined
    })
  expect(await relation()).toEqual({ parent: nameA, modal: true })

  // Esc closes it (nothing typed in the filter) and ends the modal; no stray window is left. The
  // page can be gone before the press resolves (that is the point): the polls below decide.
  await picker.keyboard.press('Escape').catch(() => {})
  await expect.poll(() => relation()).toBeUndefined()
  await expect.poll(() => titles(app)).toEqual([nameA])
  await expect(page.locator('.top-strip')).toBeVisible()
})

test('picking a project that is already open focuses its window and closes the picker', async ({ cockpit }) => {
  const { app, page } = cockpit
  const nameA = basename(cockpit.projectDir)
  await page.locator('.top-strip').getByRole('button', { name: 'Open project…' }).click()
  await expect.poll(() => titles(app)).toEqual(['cc-cockpit', nameA].sort())
  await expect.poll(() => app.windows().length).toBe(2)
  const picker = app.windows().find((p) => p !== page)!
  await picker.locator('.picker li', { hasText: cockpit.projectDir }).getByRole('button', { name: nameA, exact: true }).click()
  await expect.poll(() => titles(app)).toEqual([nameA])
})

test('the filter narrows the recent list, Esc clears it, ↓ and Enter open the highlighted project; a missing one offers relink and forget', async ({
  cockpit
}) => {
  const { app, page } = cockpit
  const nameA = basename(cockpit.projectDir)
  // Three more recent projects sharing a prefix the filter can pick out; C's folder goes away.
  const made = ['b', 'c', 'gone'].map((tag) => realpathSync(mkdtempSync(join(tmpdir(), `ccc-e2e-pick-${tag}-`))))
  const [dirB, dirC, dirGone] = made as [string, string, string]
  try {
    for (const dir of made) {
      await cockpit.hook('openProject', dir)
      await expect.poll(() => titles(app)).toContain(basename(dir))
      await app.evaluate(({ BrowserWindow }, name) => {
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle() === name)
          ?.close()
      }, basename(dir))
      await expect.poll(() => titles(app)).toEqual([nameA])
    }
    rmSync(dirGone, { recursive: true, force: true })

    await page.locator('.top-strip').getByRole('button', { name: 'Open project…' }).click()
    await expect.poll(() => app.windows().length).toBe(2)
    const picker = app.windows().find((p) => p !== page)!
    const rows = picker.locator('.picker li')
    await expect(rows).toHaveCount(4)

    // A missing folder: dimmed with a badge, its row cannot open it, Relink and Forget are there.
    const gone = rows.filter({ hasText: dirGone })
    await expect(gone.locator('.picker-badge')).toHaveText('missing')
    await expect(gone.getByRole('button', { name: basename(dirGone), exact: true })).toBeDisabled()
    await expect(gone.getByRole('button', { name: 'Relink…' })).toBeVisible()
    await expect(gone.getByRole('button', { name: 'Forget' })).toBeVisible()

    // The filter field has the focus; it matches name or path, ignoring case.
    const filter = picker.getByRole('textbox', { name: 'Search recent projects' })
    await expect(filter).toBeFocused()
    await filter.pressSequentially('E2E-PICK-')
    await expect(rows).toHaveCount(3)
    await picker.keyboard.press('Escape')
    await expect(filter).toHaveValue('')
    await expect(rows).toHaveCount(4)

    // Most recent first: gone, C, B. The highlight starts on C (the missing row is skipped) and ↓
    // moves it to B; Enter opens B and the picker goes.
    await filter.pressSequentially('e2e-pick-')
    await expect(rows).toHaveCount(3)
    await expect(picker.locator('.picker li.highlighted')).toContainText(dirC)
    await picker.keyboard.press('ArrowDown')
    await expect(picker.locator('.picker li.highlighted')).toContainText(dirB)
    // The open closes the picker, possibly before the key-up is delivered: that half may fail.
    await picker.keyboard.press('Enter').catch(() => {})
    await expect.poll(() => titles(app)).toEqual([nameA, basename(dirB)].sort())
  } finally {
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  }
})
