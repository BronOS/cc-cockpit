// Task 28: plugin panels. A linked fixture plugin's panel renders from cc-plugin:// in a sandboxed
// iframe, talks to its host over the MessagePort main hands out (panel -> host -> panel), gets the
// app's theme variables, may fetch its own files but not the network (refused by its CSP, seen as
// the page's own securitypolicyviolation report, so nothing depends on a real network), and a
// plugin command run from the palette opens the plugin's own html page as an overlay whose
// `{ result }` resolves ctx.overlay.open.
import type { Frame, Page } from '@playwright/test'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { OverlayInfo } from '../../src/shared/ipc'
import { expect, test } from './fixtures'

const FIXTURE = join(__dirname, '..', 'fixtures', 'plugins', 'panels')
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

function pluginFrame(page: Page, file: string): Frame | undefined {
  return page.frames().find((f) => f.url() === `cc-plugin://test.panels/${file}`)
}

/** Null while there is no such frame, or it is being replaced (a reload detaches the old one). */
// Expressions as strings: this file compiles without the DOM lib (tsconfig.node.json).
const text = (frame: Frame | undefined, id: string): Promise<string | null> =>
  frame
    ? frame.evaluate<string | null>(`document.getElementById(${JSON.stringify(id)})?.textContent ?? null`).catch(() => null)
    : Promise.resolve(null)

const cssVar = (frame: Frame | undefined, name: string): Promise<string | null> =>
  frame
    ? frame
        .evaluate<string>(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`)
        .catch(() => null)
    : Promise.resolve(null)

test('a plugin panel renders, round-trips a message through its host, gets the theme and no network', async ({
  cockpit
}) => {
  const { page } = cockpit
  await cockpit.hook('linkPlugin', FIXTURE)
  await cockpit.hook('enablePlugin', cockpit.projectDir, 'test.panels')
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: 'test.panels', state: 'active' }] })

  // Panels start closed: open it from the left strip.
  await page.locator('.zone-left').getByRole('button', { name: /^Echo/ }).click()
  const iframe = page.locator('section.panel[aria-label="Echo"] iframe')
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(iframe).toHaveAttribute('src', 'cc-plugin://test.panels/panel.html')

  // The page posted { ping: 1 } before it had a port; the host echoed it back.
  const reply = async (): Promise<{ echo?: unknown; pid?: number }> => {
    const raw = await text(pluginFrame(page, 'panel.html'), 'reply')
    return raw && raw !== 'waiting' ? (JSON.parse(raw) as { echo?: unknown; pid?: number }) : {}
  }
  await expect.poll(async () => (await reply()).echo, { timeout: 15_000 }).toEqual({ ping: 1 })
  const firstPid = (await reply()).pid
  expect(typeof firstPid).toBe('number')
  // Its own files are fetchable (connect-src of its own origin, CORS for the opaque origin)...
  await expect.poll(() => text(pluginFrame(page, 'panel.html'), 'own')).toBe('own true')
  // ...the network is not: refused by the CSP before any request is made.
  await expect.poll(() => text(pluginFrame(page, 'panel.html'), 'net')).toBe('net blocked')
  await expect.poll(() => text(pluginFrame(page, 'panel.html'), 'csp')).toBe('connect-src https://example.com/')

  // The app's theme variables are on the page's :root, and follow a theme change.
  await cockpit.hook('setTheme', 'dark')
  await expect.poll(() => cssVar(pluginFrame(page, 'panel.html'), '--cc-bg')).toBe('#1a1817')
  await cockpit.hook('setTheme', 'light')
  await expect.poll(() => cssVar(pluginFrame(page, 'panel.html'), '--cc-bg')).toBe('#faf8f6')

  // The host restarts: the old port died with it, the page reloads and talks to the new host.
  await cockpit.hook('enablePlugin', cockpit.projectDir, 'test.panels')
  await expect
    .poll(async () => {
      const r = await reply()
      return typeof r.pid === 'number' && r.pid !== firstPid ? r.echo : undefined
    }, { timeout: 15_000 })
    .toEqual({ ping: 1 })
})

test('a plugin command from the palette opens its html overlay; the page-sent result resolves it', async ({
  cockpit
}) => {
  const { page } = cockpit
  await cockpit.hook('linkPlugin', FIXTURE)
  await cockpit.hook('enablePlugin', cockpit.projectDir, 'test.panels')
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: 'test.panels', state: 'active' }] })

  // The command registered after the window opened: the palette must have heard of it.
  await page.keyboard.press(`${MOD}+Shift+P`)
  await page.getByRole('combobox', { name: 'Command' }).fill('Panels: Pick')
  await expect(page.getByRole('option', { name: /Panels: Pick/ })).toBeVisible()
  await page.keyboard.press('Enter')

  const overlayFrame = page.locator('iframe[title="Pick"]')
  await expect(overlayFrame).toHaveAttribute('src', 'cc-plugin://test.panels/pick.html')
  await expect(overlayFrame).toHaveAttribute('sandbox', 'allow-scripts')
  await page.frameLocator('iframe[title="Pick"]').getByRole('button', { name: 'Pick b' }).click()

  await expect
    .poll(() => cockpit.hook<string[]>('notifications'))
    .toContain(`picked ${JSON.stringify({ kind: 'value', value: { picked: 'b' } })}`)
  await expect.poll(() => cockpit.hook<OverlayInfo[]>('overlays', cockpit.projectDir)).toEqual([])

  // Its key runs it too (the renderer's key table has a handler per plugin command).
  await page.keyboard.press(`${MOD}+Shift+8`)
  await expect(page.locator('iframe[title="Pick"]')).toBeVisible()
})

// What the sandbox, the page's CSP and main's frame-navigation guard (create-window.ts) leave a
// panel page: no popup, no fetch or frame of another plugin's files, no navigating itself to the
// network or to another plugin's page. Each is driven from inside the frame, as the page would.
test("a panel page cannot open windows, reach another plugin's files or navigate itself away", async ({ cockpit }) => {
  const { page } = cockpit
  await cockpit.hook('linkPlugin', FIXTURE)
  await cockpit.hook('enablePlugin', cockpit.projectDir, 'test.panels')
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: 'test.panels', state: 'active' }] })
  await page.locator('.zone-left').getByRole('button', { name: /^Echo/ }).click()
  await expect.poll(() => text(pluginFrame(page, 'panel.html'), 'reply'), { timeout: 15_000 }).toContain('"ping":1')
  const frame = pluginFrame(page, 'panel.html')!

  // No allow-popups in the sandbox: window.open gives nothing.
  expect(await frame.evaluate(`String(window.open('https://example.com/'))`)).toBe('null')
  expect(await frame.evaluate(`String(window.open('cc-plugin://test.panels/pick.html'))`)).toBe('null')

  // The page's own CSP report for an action, or 'none' if nothing was refused within a second.
  const violation = (action: string): Promise<string> =>
    frame.evaluate<string>(
      `new Promise((resolve) => {
        document.addEventListener('securitypolicyviolation', (e) => resolve(e.effectiveDirective + ' ' + e.blockedURI), { once: true })
        setTimeout(() => resolve('none'), 1000)
        ${action}
      })`
    )
  // (The report names only the scheme of a cross-origin URL, and to an opaque origin all are.)
  expect(await violation(`fetch('cc-plugin://other.plugin/data.json').catch(() => {})`)).toMatch(/^connect-src cc-plugin/)
  expect(
    await violation(`const f = document.createElement('iframe'); f.src = 'cc-plugin://other.plugin/x.html'; document.body.append(f)`)
  ).toMatch(/^frame-src cc-plugin/)

  // Navigating itself to another plugin's page is refused by main; the page stays and still talks.
  // (A mark on the window tells the same document from a reloaded one.)
  await frame.evaluate(`window.stayed = true; location.href = 'cc-plugin://other.plugin/x.html'`)
  await page.waitForTimeout(1000)
  expect(page.frames().some((f) => f.url().startsWith('cc-plugin://other.plugin'))).toBe(false)
  expect(await pluginFrame(page, 'panel.html')?.evaluate(`window.stayed === true`)).toBe(true)

  // Reloading itself (its own origin) is allowed, and the new page gets a port again.
  await frame.evaluate(`location.reload()`)
  const reloadedReply = async (): Promise<string | null> => {
    const f = pluginFrame(page, 'panel.html')
    const fresh = await f?.evaluate<boolean>(`window.stayed === undefined`).catch(() => false)
    return fresh ? text(f, 'reply') : null
  }
  await expect.poll(reloadedReply, { timeout: 15_000 }).toContain('"ping":1')

  // The network: no frame ever shows an http(s) page.
  await pluginFrame(page, 'panel.html')!.evaluate(`location.href = 'https://example.com/'`)
  await page.waitForTimeout(1000)
  expect(page.frames().map((f) => f.url()).filter((u) => /^https?:/.test(u))).toEqual([])
})

test('plugin panel icons are masks in the strip colour; an undecodable icon falls back to the letter', async ({
  cockpit
}) => {
  const { page } = cockpit
  await cockpit.hook('linkPlugin', FIXTURE)
  await cockpit.hook('enablePlugin', cockpit.projectDir, 'test.panels')
  const strip = page.locator('.zone-left')
  const pic = strip.getByRole('button', { name: /^Pic/ })
  const mask = pic.locator('.panel-icon-img')
  await expect(mask).toHaveCSS('mask-image', 'url("cc-plugin://test.panels/icons/pic.svg")')
  // Same colour as the button text (the strip's), not the file's black, and it follows hover.
  const colours = (): Promise<[string, string]> =>
    pic.evaluate((b) => {
      const el = b.querySelector('.panel-icon-img')
      return [getComputedStyle(el as Element).backgroundColor, getComputedStyle(b).color] as [string, string]
    })
  const [bg, fg] = await colours()
  expect(bg).toBe(fg)
  await pic.hover()
  await expect.poll(async () => (await colours())[0]).not.toBe(bg)
  const [hbg, hfg] = await colours()
  expect(hbg).toBe(hfg)
  await page.mouse.move(0, 0)
  await expect(pic).toHaveAttribute('aria-label', 'Pic')
  await expect(mask).toHaveAttribute('aria-hidden', 'true')

  // The broken icon: the probe fails, so the letter shows and no mask is left.
  const broken = strip.getByRole('button', { name: /^Broken/ })
  await expect(broken.locator('.panel-icon-letter')).toHaveText('B')
  await expect(broken.locator('.panel-icon-img')).toHaveCount(0)
})
