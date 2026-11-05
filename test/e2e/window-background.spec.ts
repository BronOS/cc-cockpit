// Settings › Appearance › Window (design §4 Window background): the "Transparent
// background" switch makes the project windows opened after it transparent (Electron cannot change
// an open window). The window it was flipped in offers to reopen itself ("Reopen window": closed and
// made again, its tabs restored as after a restart); "Later", and every other open window, keep how
// they were made. The opacity slider reaches every transparent window live, a theme switch keeps
// the glass, and only the shell's own surfaces become see-through: the settings screen, menus and
// overlays stay opaque.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { TabInfo } from '../../src/shared/ipc'
import { expect, launchCockpit, test } from './fixtures'

// String expressions: the e2e tsconfig has no DOM lib, and the code runs in the page anyway.
/**
 * Click a button that closes its own page. From a timer in the page, so nothing on Playwright's side
 * is waiting on that page: locator.click() and an evaluate that clicks directly both reject with
 * "Target page closed" when the close wins the race (every run on Linux). That rejection failed the
 * test, and the teardown's app.quit() then landed while main was building the new window,
 * segfaulting Electron inside Browser::Quit.
 */
const clickOwnClose = (button: Locator): Promise<void> =>
  button.evaluate((b: HTMLElement) => {
    setTimeout(() => b.click(), 50)
  })

const seeThrough = (page: Page): Promise<boolean> =>
  page.evaluate<boolean>(`document.documentElement.classList.contains('see-through')`)

const rootVar = (page: Page, name: string): Promise<string> =>
  page.evaluate<string>(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`)

/** The computed background colour of the first element matching `selector`. */
const background = (page: Page, selector: string): Promise<string> =>
  page.evaluate<string>(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).backgroundColor`)

/**
 * The alpha of a computed colour: Chromium writes a color-mix result as `color(srgb r g b / a)`,
 * a plain colour as `rgb(...)` (opaque) or `rgba(..., a)`. `transparent` is rgba(0, 0, 0, 0).
 */
function alphaOf(css: string): number {
  const slash = /\/\s*([\d.]+)\s*\)$/.exec(css)
  if (slash) return Number(slash[1])
  const rgba = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(css)
  if (rgba) return Number(rgba[1])
  return 1
}

/** Elements under `selector` (itself included) that paint a background; the cursor and the scrollbar thumb left out. */
const opaqueInside = (page: Page, selector: string): Promise<string[]> =>
  page.evaluate<string[]>(`(() => {
    const top = document.querySelector(${JSON.stringify(selector)})
    return [top, ...top.querySelectorAll('*')]
      .filter((el) => !el.closest('.xterm-cursor, .xterm-helper-textarea, .composition-view, .slider'))
      .map((el) => [el, getComputedStyle(el).backgroundColor])
      .filter(([, bg]) => bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent')
      .map(([el, bg]) => el.tagName.toLowerCase() + '.' + [...el.classList].join('.') + ' ' + bg)
  })()`)

/** The offer's whole text (WindowBackgroundSettings.tsx), checked word for word. */
const REOPEN_TEXT =
  'Reopen this window to apply? Claude conversations resume; shells start fresh, and anything running now is stopped.'

const stored = (dataDir: string): unknown =>
  (JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8')) as { windowBackground?: unknown }).windowBackground

test('a transparent background reaches project windows opened after the switch; the opacity follows the slider live', async () => {
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'cc-e2e-window-bg-')))
  const { cockpit: c, close } = await launchCockpit()
  try {
    const { page } = c
    // Opaque by default: nothing see-through, the BrowserWindow made opaque.
    expect(await seeThrough(page)).toBe(false)
    expect(await c.hook('windowLook', c.projectDir)).toMatchObject({ transparent: false })
    expect(alphaOf(await background(page, 'body'))).toBe(1)

    await page.keyboard.press('ControlOrMeta+,')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Appearance', exact: true }).click()
    const transparent = settings.getByRole('checkbox', { name: 'Transparent background' })
    const opacity = settings.getByRole('slider', { name: 'Background opacity' })
    const blur = settings.getByRole('checkbox', { name: 'Blur behind' })
    await expect(transparent).not.toBeChecked()
    // The slider and the blur only mean something for a transparent window.
    await expect(opacity).toBeDisabled()
    await expect(opacity).toHaveValue('80')
    await expect(blur).toBeDisabled()

    // A controlled box: it shows the new state once main stored it and the page reloaded the view.
    await transparent.click()
    await expect(transparent).toBeChecked()
    await expect.poll(() => stored(c.dataDir)).toEqual({ transparent: true })
    await expect(opacity).toBeEnabled()
    if (process.platform === 'darwin' || process.platform === 'win32') {
      await expect(blur).toBeEnabled()
      await expect(blur).not.toBeChecked() // off by default: the macOS material is a near-solid tint
    } else {
      await expect(blur).toBeDisabled()
    }
    // The window that is open stays as it was made and offers to reopen; "Later" keeps it, and
    // the help then says how it is.
    const offer = settings.getByRole('group', { name: 'Reopen window' })
    await expect(offer.locator('.settings-confirm')).toHaveText(REOPEN_TEXT)
    await offer.getByRole('button', { name: 'Later' }).click()
    await expect(offer).toHaveCount(0)
    await expect(settings.getByText('This window stays opaque until it is reopened')).toBeVisible()
    expect(c.app.windows()).toHaveLength(1)
    expect(await seeThrough(page)).toBe(false)
    expect(await c.hook('windowLook', c.projectDir)).toMatchObject({ transparent: false })
    // Esc reaches the screen through the focused switch, which takes keys again once enabled.
    await expect(transparent).toBeEnabled()
    await transparent.focus()
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)

    // A project window opened now is made transparent.
    await c.hook('openProject', other)
    await expect.poll(() => c.app.windows().length).toBe(2)
    const second = c.app.windows().find((p) => p !== page)!
    await second.locator('.tabs-pane').waitFor()
    // The BrowserWindow's colour: #00000000 given, which Electron reads back without the alpha;
    // an opaque window has its theme colour (createWindow's default).
    expect(await c.hook('windowLook', other)).toEqual({ transparent: true, backgroundColor: expect.stringMatching(/^#(00)?000000$/) })
    expect(await c.hook('windowLook', c.projectDir)).not.toMatchObject({ backgroundColor: expect.stringMatching(/^#(00)?000000$/) })
    expect(await seeThrough(second)).toBe(true)
    expect(await rootVar(second, '--cc-window-alpha')).toBe('0.8')
    // One translucent layer: the body is clear, the bars carry the glass.
    expect(alphaOf(await background(second, 'body'))).toBe(0)
    expect(alphaOf(await background(second, '.top-strip'))).toBeCloseTo(0.8, 2)
    expect(alphaOf(await background(second, '.tab-bar'))).toBeCloseTo(0.8, 2)
    // The first window's bar is still solid.
    expect(alphaOf(await background(page, '.top-strip'))).toBe(1)

    // A terminal in the transparent window: the host is the glass, xterm paints nothing over it.
    await second.getByRole('button', { name: 'New tab' }).click()
    await second.getByRole('menuitem', { name: 'Shell' }).click()
    await expect(second.getByRole('tab')).toHaveCount(1)
    await second.locator('.terminal-host .xterm').waitFor()
    expect(alphaOf(await background(second, '.terminal-host'))).toBeCloseTo(0.8, 2)
    // Nothing inside xterm paints over the glass (its theme background, its stylesheet's #000
    // viewport): only the cursor and the scrollbar thumb may.
    expect(await opaqueInside(second, '.terminal-host .xterm')).toEqual([])

    // The slider, moved in the opaque window, reaches the transparent one live.
    await page.keyboard.press('ControlOrMeta+,')
    await settings.getByRole('button', { name: 'Appearance', exact: true }).click()
    await opacity.focus()
    await page.keyboard.press('Home')
    await expect(opacity).toHaveValue('40')
    await expect(settings.getByText('40 %')).toBeVisible()
    await expect.poll(() => rootVar(second, '--cc-window-alpha')).toBe('0.4')
    await expect.poll(async () => alphaOf(await background(second, '.top-strip'))).toBeCloseTo(0.4, 2)
    await expect.poll(() => stored(c.dataDir)).toEqual({ transparent: true, opacity: 40 })
    expect(await seeThrough(page)).toBe(false)

    // Blur is live too: main applies it to the transparent window (stored; no error shown).
    if (process.platform === 'darwin' || process.platform === 'win32') {
      await blur.click()
      await expect(blur).toBeChecked()
      await expect.poll(() => stored(c.dataDir)).toEqual({ transparent: true, opacity: 40, blur: true })
      await expect(settings.getByRole('alert')).toHaveCount(0)
      await expect(blur).toBeEnabled()
    }

    // "Main area only", live: the side and bottom zones go solid, the top bar and the tabs keep
    // the glass; "Whole window" brings the panels' glass back.
    const area = settings.getByRole('combobox', { name: 'See-through' })
    await expect(area).toHaveValue('window')
    // A zone with a panel open: a test panel declared in the right zone (core has none of its own).
    await c.hook('pluginPanels', other, 'test', [{ id: 'notes', title: 'Notes', defaultZone: 'right' }])
    await second.locator('.zone-right').getByRole('button', { name: /^Notes/ }).click()
    await second.locator('.zone-right .panel-area').waitFor()
    expect(alphaOf(await background(second, '.panel-area'))).toBeCloseTo(0.4, 2)
    expect(alphaOf(await background(second, '.icon-strip'))).toBeCloseTo(0.4, 2)
    await area.selectOption('main')
    await expect.poll(() => stored(c.dataDir)).toMatchObject({ area: 'main' })
    await expect.poll(async () => alphaOf(await background(second, '.panel-area'))).toBe(1)
    expect(alphaOf(await background(second, '.icon-strip'))).toBe(1)
    expect(alphaOf(await background(second, '.top-strip'))).toBeCloseTo(0.4, 2)
    expect(alphaOf(await background(second, '.tab-bar'))).toBeCloseTo(0.4, 2)
    expect(alphaOf(await background(second, '.terminal-host'))).toBeCloseTo(0.4, 2)
    await area.selectOption('window')
    await expect.poll(async () => alphaOf(await background(second, '.panel-area'))).toBeCloseTo(0.4, 2)
    // The click in the other window took the focus; Esc needs it back on the settings screen.
    await page.bringToFront()
    await transparent.focus()
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)

    // A theme switch keeps the glass, in the new theme's colours.
    await c.hook('setTheme', 'light')
    await expect.poll(() => rootVar(second, '--cc-bg')).toBe('#faf8f6')
    const lightBar = await background(second, '.tab-bar')
    expect(alphaOf(lightBar)).toBeCloseTo(0.4, 2)
    // #faf8f6 in srgb fractions.
    expect(lightBar).toMatch(/^color\(srgb 0\.98\d* 0\.97\d* 0\.96\d* \/ 0\.4\)$/)
    await c.hook('setTheme', 'dark')
    await expect.poll(() => rootVar(second, '--cc-bg')).toBe('#1a1817')
    expect(alphaOf(await background(second, '.tab-bar'))).toBeCloseTo(0.4, 2)

    // What is read stays solid in the transparent window: the settings screen, an overlay.
    await second.keyboard.press('ControlOrMeta+,')
    const secondSettings = second.getByRole('dialog', { name: 'Settings' })
    await expect(secondSettings).toBeVisible()
    expect(alphaOf(await background(second, '.settings'))).toBe(1)
    await second.keyboard.press('Escape')
    await expect(secondSettings).toHaveCount(0)
    await c.hook('openOverlay', other, { kind: 'terminal', argv: ['cat'], cwd: other })
    await second.locator('.overlay .xterm').waitFor()
    // The overlay is a dialog (.overlay-frame) over a dark scrim (.overlay): the dialog is what is
    // read, so it stays solid; the scrim is fixed at 0.45 and never follows the glass slider.
    expect(alphaOf(await background(second, '.overlay-frame'))).toBe(1)
    expect(alphaOf(await background(second, '.overlay'))).toBeCloseTo(0.45, 2)
    expect(alphaOf(await background(second, '.overlay .xterm-scrollable-element'))).toBe(1)
  } finally {
    await close()
    rmSync(other, { recursive: true, force: true })
  }
})

test('"Reopen window" remakes this window from the setting; its Claude tab resumes, its shell starts fresh', async () => {
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'cc-e2e-window-reopen-')))
  const { cockpit: c, close } = await launchCockpit()
  try {
    // A resumable Claude session (a prompt typed into it) and a shell, as restore.spec does.
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    await c.typeLine('/prompt hello')
    await c.waitForTerminalText('FAKE-CLAUDE hook UserPromptSubmit')
    await c.newTab('shell')
    await expect
      .poll(async () => (await c.hook<TabInfo[]>('tabs', c.projectDir)).find((t) => t.kind === 'claude')?.sessionId)
      .toMatch(/^fake-session-\d+$/)
    const sessionId = (await c.hook<TabInfo[]>('tabs', c.projectDir)).find((t) => t.kind === 'claude')!.sessionId!
    expect(c.claudeRuns()).toHaveLength(1)
    // Another project's window: a reopen leaves it as it is.
    await c.hook('openProject', other)
    await expect.poll(() => c.app.windows().length).toBe(2)
    const otherPage = c.app.windows().find((p) => p !== c.page)!
    await otherPage.locator('.tabs-pane').waitFor()

    const { page } = c
    await page.bringToFront()
    await page.keyboard.press('ControlOrMeta+,')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Appearance', exact: true }).click()
    const transparent = settings.getByRole('checkbox', { name: 'Transparent background' })
    const offer = settings.getByRole('group', { name: 'Reopen window' })
    await expect(offer).toHaveCount(0)
    await transparent.click()
    await expect(transparent).toBeChecked()
    await expect(offer).toBeVisible()
    // Back to how the window was made: nothing to reopen for.
    await expect(transparent).toBeEnabled()
    await transparent.click()
    await expect(transparent).not.toBeChecked()
    await expect(offer).toHaveCount(0)
    await expect(transparent).toBeEnabled()
    await transparent.click()
    await expect(transparent).toBeChecked()
    await expect.poll(() => stored(c.dataDir)).toEqual({ transparent: true })

    const closed = page.waitForEvent('close')
    const opened = c.app.waitForEvent('window')
    await clickOwnClose(offer.getByRole('button', { name: 'Reopen window' }))
    await closed
    const fresh = await opened
    await fresh.locator('.tabs-pane').waitFor()
    // The project's window is a new, transparent one; the other project's is untouched.
    expect(c.app.windows()).toHaveLength(2)
    expect(await c.hook('windowLook', c.projectDir)).toMatchObject({ transparent: true })
    expect(await seeThrough(fresh)).toBe(true)
    expect(otherPage.isClosed()).toBe(false)
    expect(await c.hook('windowLook', other)).toMatchObject({ transparent: false })
    expect(await seeThrough(otherPage)).toBe(false)

    // Its tabs came back as after a restart, in order: the Claude tab with `--resume <id>`, the
    // shell as a fresh shell (not a second claude).
    await expect(fresh.getByRole('tab')).toHaveCount(2)
    expect((await c.hook<TabInfo[]>('tabs', c.projectDir)).map((t) => t.kind)).toEqual(['claude', 'shell'])
    await expect.poll(() => c.claudeRuns().length).toBe(2)
    expect(c.claudeRuns()[1]).toEqual([
      '--settings',
      join(c.dataDir, 'hooks.json'),
      '--plugin-dir',
      join(c.dataDir, 'claude-plugins', 'core'),
      '--resume',
      sessionId
    ])

    // And back: turned off in the transparent window, it offers to reopen as an opaque one.
    await fresh.bringToFront()
    await fresh.keyboard.press('ControlOrMeta+,')
    const freshSettings = fresh.getByRole('dialog', { name: 'Settings' })
    await freshSettings.getByRole('button', { name: 'Appearance', exact: true }).click()
    const freshTransparent = freshSettings.getByRole('checkbox', { name: 'Transparent background' })
    const freshOffer = freshSettings.getByRole('group', { name: 'Reopen window' })
    await expect(freshTransparent).toBeChecked()
    await expect(freshOffer).toHaveCount(0)
    await freshTransparent.click()
    await expect(freshTransparent).not.toBeChecked()
    await expect(freshOffer).toBeVisible()
    const closedAgain = fresh.waitForEvent('close')
    const openedAgain = c.app.waitForEvent('window')
    await clickOwnClose(freshOffer.getByRole('button', { name: 'Reopen window' }))
    await closedAgain
    const opaque = await openedAgain
    await opaque.locator('.tabs-pane').waitFor()
    expect(await c.hook('windowLook', c.projectDir)).toMatchObject({ transparent: false })
    expect(await seeThrough(opaque)).toBe(false)
    await expect(opaque.getByRole('tab')).toHaveCount(2)
  } finally {
    await close()
    rmSync(other, { recursive: true, force: true })
  }
})
