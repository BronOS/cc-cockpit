// A colour per project (Settings › This project › Colour; design §6 Project colour): a palette
// colour or a custom one marks the project's window with a 3px line along its top edge, a tint of
// its top bar and a dot by its name, and the picker's row shows the dot live. (Other windows' strip
// entries are the cockpit.sessions plugin's.) None takes it all away. In a transparent window the
// tinted bar stays one translucent layer.
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test, type Cockpit } from './fixtures'

// String expressions: the e2e tsconfig has no DOM lib, and the code runs in the page anyway.
const rootVar = (page: Page, name: string): Promise<string> =>
  page.evaluate<string>(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`)

/** The top bar's line (its ::before) as drawn: none, or its height and colour. */
const topLine = (page: Page): Promise<{ content: string; height: string; color: string }> =>
  page.evaluate(`(() => {
    const s = getComputedStyle(document.querySelector('.top-strip'), '::before')
    return { content: s.content, height: s.height, color: s.backgroundColor }
  })()`)

const barBackground = (page: Page): Promise<string> =>
  page.evaluate<string>(`getComputedStyle(document.querySelector('.top-strip')).backgroundColor`)

/** The background of every `.project-dot` under `selector`, in order. */
const dots = (page: Page, selector: string): Promise<string[]> =>
  page.evaluate<string[]>(
    `[...document.querySelectorAll(${JSON.stringify(selector + ' .project-dot')})].map((d) => getComputedStyle(d).backgroundColor)`
  )

/** `#5b9df5` -> `rgb(91, 157, 245)`, as getComputedStyle writes a plain colour. */
function rgb(hex: string): string {
  const n = (i: number): number => parseInt(hex.slice(i, i + 2), 16)
  return `rgb(${n(1)}, ${n(3)}, ${n(5)})`
}

/** Same as window-background.spec: the alpha of a computed colour. */
function alphaOf(css: string): number {
  const slash = /\/\s*([\d.]+)\s*\)$/.exec(css)
  if (slash) return Number(slash[1])
  const rgba = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(css)
  if (rgba) return Number(rgba[1])
  return 1
}

/** The stored colour in the project's record (`undefined`: no field). */
function storedColor(c: Cockpit): unknown {
  const dir = join(c.dataDir, 'projects')
  // The record is written by a debounced writer: right after launch the folder may not exist yet.
  if (!existsSync(dir)) return 'no record'
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try {
      const record = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { path?: string; color?: unknown }
      if (record.path === c.projectDir) return record.color
    } catch {
      // A record mid-rename; the poll reads again.
    }
  }
  return 'no record'
}

test('a project colour marks its window and reaches the picker live; None removes it', async ({
  cockpit
}) => {
  const { page, app } = cockpit
  const dirB = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-e2e-color-b-')))
  try {
    const plainBar = await barBackground(page)
    expect(await topLine(page)).toMatchObject({ content: 'none' })
    expect(await dots(page, '.titlebar-project')).toEqual([])

    // A second window, whose bar must stay untouched and whose "+" opens the picker. (Its strip of
    // the other windows' tabs is the cockpit.sessions plugin's, with its own dots: not core's.)
    await cockpit.hook('openProject', dirB)
    await expect.poll(() => app.windows().length).toBe(2)
    const pageB = app.windows().find((p) => p !== page)!
    await pageB.locator('.tabs-pane').waitFor()

    // Settings › This project › Colour: Blue.
    await page.keyboard.press('ControlOrMeta+,')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'This project' }).click()
    const group = settings.getByRole('radiogroup', { name: 'Project colour' })
    await expect(group.getByRole('radio', { name: 'Colour: None' })).toBeChecked()
    await group.getByRole('radio', { name: 'Colour: Blue' }).click()
    await expect(group.getByRole('radio', { name: 'Colour: Blue' })).toBeChecked()
    await expect.poll(() => storedColor(cockpit)).toBe('blue')

    // Window A: the line, the tint and the chip's dot, all in the theme's blue.
    const blue = rgb(await rootVar(page, '--cc-project-blue'))
    await expect(page.locator('.top-strip')).toHaveAttribute('data-project-color', 'blue')
    expect(await topLine(page)).toEqual({ content: '""', height: '3px', color: blue })
    expect(await barBackground(page)).not.toBe(plainBar)
    await expect(page.locator('.titlebar-project').getByRole('img', { name: 'Colour: Blue' })).toHaveCount(1)
    expect(await dots(page, '.titlebar-project')).toEqual([blue])
    // The line takes no room: the bar is as tall as ever.
    expect((await page.locator('.top-strip').boundingBox())?.height).toBe(40)

    // Window B's own bar is untouched.
    expect(await topLine(pageB)).toMatchObject({ content: 'none' })

    // The picker (from B's "+") lists A with its dot, and follows a change made in A meanwhile.
    await pageB.getByRole('button', { name: 'Open project…' }).click()
    await expect.poll(() => app.windows().length).toBe(3)
    const picker = app.windows().find((p) => p !== page && p !== pageB)!
    await picker.locator('.picker').waitFor()
    const rowA = picker.locator('.picker li', { hasText: cockpit.projectDir })
    await expect(rowA.locator('.project-dot')).toHaveCount(1)
    expect(await dots(picker, '.picker-list')).toEqual([rgb(await rootVar(picker, '--cc-project-blue'))])

    // A custom colour, through the native colour field: stored in lower case, drawn as-is.
    await settings.getByLabel('Colour: Custom…').fill('#12ABEF')
    await expect.poll(() => storedColor(cockpit)).toBe('#12abef')
    const custom = rgb('#12abef')
    await expect(page.locator('.top-strip')).toHaveAttribute('data-project-color', '#12abef')
    expect((await topLine(page)).color).toBe(custom)
    await expect(group.getByRole('radio', { checked: true })).toHaveCount(0)
    await expect(settings.getByLabel('Colour: Custom #12abef')).toHaveCount(1)
    await expect.poll(() => dots(picker, '.picker-list')).toContain(custom)

    // None: line, tint and dots gone everywhere.
    await picker.keyboard.press('Escape').catch(() => {})
    await expect.poll(() => picker.isClosed()).toBe(true)
    await group.getByRole('radio', { name: 'Colour: None' }).click()
    await expect.poll(() => storedColor(cockpit)).toBeUndefined()
    await expect(page.locator('.top-strip')).not.toHaveAttribute('data-project-color')
    expect(await topLine(page)).toMatchObject({ content: 'none' })
    expect(await barBackground(page)).toBe(plainBar)
    expect(await dots(page, '.titlebar-project')).toEqual([])
  } finally {
    rmSync(dirB, { recursive: true, force: true })
  }
})

test('a refused colour stores nothing, and a transparent window’s tinted bar stays one translucent layer', async ({
  cockpit
}) => {
  const { page, app } = cockpit
  const dirB = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-e2e-color-glass-')))
  try {
    // main refuses what the page could never offer.
    const refused = await page.evaluate<string>(
      `window.cockpit.invoke('settings.projectColorSet', { value: 'url(x)' }).then(() => 'stored', (e) => String(e))`
    )
    expect(refused).toMatch(/not a project colour/)
    // Main's own view (the record file may not be written yet this early): still no colour.
    expect(await page.evaluate(`window.cockpit.invoke('settings.project').then((v) => v.color ?? 'none')`)).toBe('none')

    // A window made transparent (the setting applies to windows opened after it).
    await page.evaluate(`window.cockpit.invoke('settings.windowBackgroundSet', { value: { transparent: true } })`)
    await cockpit.hook('openProject', dirB)
    await expect.poll(() => app.windows().length).toBe(2)
    const glass = app.windows().find((p) => p !== page)!
    await glass.locator('.tabs-pane').waitFor()
    expect(alphaOf(await barBackground(glass))).toBeCloseTo(0.8, 2)

    await glass.evaluate(`window.cockpit.invoke('settings.projectColorSet', { value: 'green' })`)
    await expect(glass.locator('.top-strip')).toHaveAttribute('data-project-color', 'green')
    // Tinted, and still exactly the glass alpha: the tint went in before the alpha, not on top.
    expect(alphaOf(await barBackground(glass))).toBeCloseTo(0.8, 2)
    expect((await topLine(glass)).color).toBe(rgb(await rootVar(glass, '--cc-project-green')))
  } finally {
    rmSync(dirB, { recursive: true, force: true })
  }
})
