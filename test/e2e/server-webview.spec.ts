// Streamed web views in a server's browser (design-web-browser.md §3, plan
// 20261111-streamed-webviews.md Task 6): the Browser panel in a browser view is a canvas the
// server's off-screen page is painted on, with the desktop's toolbar. `ccc browser open` runs from a
// Claude tab (the fake claude runs a `/ccc ...` line), as in server-mode.spec.ts.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expectMainAlive, launchServer, type Server } from './server-fixtures'
import { openBrowser, openProjectInBrowser, type WebBrowser } from './web-fixtures'

test.skip(process.platform !== 'linux', 'server mode runs on Linux only')

let server: Server | undefined

test.afterEach(async () => {
  await server?.close()
  server = undefined
})

/** The page's colour, and a small square in a corner that moves every frame (so frames keep coming). */
const COLOUR = { r: 0x22, g: 0xaa, b: 0x55 }
const PAGE = `<!doctype html><title>Green page</title>
<style>html,body{margin:0;height:100%;background:rgb(${COLOUR.r},${COLOUR.g},${COLOUR.b})}
#tick{position:fixed;left:0;top:0;width:6px;height:6px;background:#000}</style>
<div id="tick"></div>
<script>let n=0;(function f(){n++;document.getElementById('tick').style.left=(n%20)+'px';requestAnimationFrame(f)})()</script>`

/** The canvas's pixel at its centre, read from the page (device px). */
async function centrePixel(page: Page): Promise<number[]> {
  return page.locator('section.panel[aria-label="Browser"] canvas.webview-canvas').evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d')
    if (!ctx || c.width < 2 || c.height < 2) return []
    return [...ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data]
  })
}

async function runInClaude(browser: WebBrowser, line: string): Promise<void> {
  await browser.page.locator('.terminal-view:not([hidden]) .xterm').click()
  await browser.page.keyboard.type(line)
  await browser.page.keyboard.press('Enter')
}

test('server mode: the Browser panel draws the stream, shows the URL and a load error; closing it stops frames', async () => {
  test.setTimeout(120_000)
  server = await launchServer({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  const { cockpit } = server
  writeFileSync(join(cockpit.projectDir, 'green.html'), PAGE)
  await expect
    .poll(async () => (await cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir)).plugins.find((p) => p.id === 'cockpit.browser')?.state, {
      timeout: 20_000
    })
    .toBe('active')
  const browser = await openBrowser(`${server.origin}/`)
  try {
    const { page } = browser
    await page.setViewportSize({ width: 1280, height: 800 })
    await openProjectInBrowser(browser, server.origin, server.projectId)
    const section = page.locator('section.panel[aria-label="Browser"]')
    const toggle = page.getByRole('button', { name: /^Browser/ }).first()
    if (!(await section.isVisible())) await toggle.click()
    await expect(section).toBeVisible({ timeout: 15_000 })
    await expect(section.locator('canvas.webview-canvas')).toHaveCount(1)
    await expect(section.getByText('Browser shows nothing yet')).toBeVisible()

    // Count decoded frames: the canvas decodes each with the page's createImageBitmap.
    await page.evaluate(() => {
      const w = window as unknown as { __frames: number; createImageBitmap: typeof createImageBitmap }
      w.__frames = 0
      const real = w.createImageBitmap.bind(window)
      w.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => {
        w.__frames++
        return real(...args)
      }) as typeof createImageBitmap
    })
    const frames = (): Promise<number> => page.evaluate(() => (window as unknown as { __frames: number }).__frames)

    await page.getByRole('button', { name: 'New tab' }).click()
    await page.getByRole('menuitem', { name: 'Claude' }).click()
    await browser.waitForTerminalText('FAKE-CLAUDE banner')
    await runInClaude(browser, '/ccc browser open green.html')
    await browser.waitForTerminalText('FAKE-CLAUDE ccc exit=0 out="ok\\n" err=""')

    // The toolbar follows the page; the canvas has the page's colour (JPEG: within a few levels).
    await expect(section.locator('.webview-url')).toHaveAttribute('data-url', /^cc-preview:\/\/t[0-9a-f]+\/green\.html$/, { timeout: 15_000 })
    await expect(section.locator('canvas.webview-canvas')).toHaveAttribute('data-drawn', 'true', { timeout: 15_000 })
    await expect
      .poll(async () => {
        const [r = -99, g = -99, b = -99] = await centrePixel(page)
        return Math.max(Math.abs(r - COLOUR.r), Math.abs(g - COLOUR.g), Math.abs(b - COLOUR.b))
      }, { timeout: 15_000 })
      .toBeLessThanOrEqual(8)
    // The only viewer owns the size: no "Fit to this screen".
    await expect(section.getByRole('button', { name: 'Fit to this screen' })).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('server-webview.png') })
    await expect.poll(frames).toBeGreaterThan(3)

    // A refused port (9: Chromium refuses it before connecting) shows the load-error text.
    await runInClaude(browser, '/ccc browser open http://127.0.0.1:9/')
    await expect(section.locator('.webview-load-error')).toContainText('Could not load the page: ERR_', { timeout: 15_000 })
    await expect(section.locator('.webview-url')).toHaveAttribute('data-url', 'http://127.0.0.1:9/')

    // Back to the animated page; frames flow again. Then closing the panel stops them.
    await runInClaude(browser, '/ccc browser open green.html')
    await expect(section.locator('.webview-load-error')).toHaveCount(0, { timeout: 15_000 })
    const before = await frames()
    await expect.poll(frames).toBeGreaterThan(before + 3)
    await toggle.click()
    await expect(section).toHaveCount(0)
    await expect.poll(async () => (await cockpit.hook<{ painting: boolean }[]>('offscreenWebviews')).map((v) => v.painting)).toEqual([false])
    // Frames already on the wire may land; then none for a second.
    await page.waitForTimeout(300)
    const settled = await frames()
    await page.waitForTimeout(1_000)
    expect(await frames()).toBe(settled)
    await expectMainAlive(server)
  } finally {
    await browser.close()
  }
})

// Task 7 (design-web-browser.md §4.1): pointer, wheel and keys from the browser's canvas reach the
// server's page as trusted input; the page's cursor comes back; a page's alert() leaves main alive.
// Each page reports what it got in its title, which the toolbar shows (`.webview-url`'s tooltip).
const CLICK_PAGE = `<!doctype html><title>idle</title>
<style>html,body{margin:0;height:100%;background:#fff}#link{position:fixed;right:0;top:0;width:200px;height:200px;cursor:pointer;background:#ccc}</style>
<div id="link"></div>
<script>document.addEventListener('mousedown',(e)=>{if(e.target.id==='link')return;document.body.style.background='rgb(220,20,20)';document.title='clicked '+e.button})</script>`
const TALL_PAGE = `<!doctype html><title>top</title><body style="margin:0;height:6000px;background:linear-gradient(#fff,#00f)">
<script>addEventListener('scroll',()=>{document.title='scrolled '+Math.round(scrollY)})</script>`
const INPUT_PAGE = `<!doctype html><title>empty</title><body style="margin:0">
<form id="f"><input id="i" style="display:block;margin:0;width:300px;height:40px;font-size:20px" autocomplete="off"></form>
<script>const i=document.getElementById('i');i.addEventListener('input',()=>{document.title='value '+i.value});
document.getElementById('f').addEventListener('submit',(e)=>{e.preventDefault();document.title='sent '+i.value})</script>`
const ALERT_PAGE = `<!doctype html><title>ready</title><body style="margin:0;height:100%">
<script>document.addEventListener('click',()=>{alert('hi');const ok=confirm('sure?');document.title='after alert '+ok})</script>`

test('server mode: clicks, the wheel and keys reach the streamed page; its cursor shows; alert() leaves main alive', async () => {
  test.setTimeout(150_000)
  server = await launchServer({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  const { cockpit } = server
  writeFileSync(join(cockpit.projectDir, 'click.html'), CLICK_PAGE)
  writeFileSync(join(cockpit.projectDir, 'tall.html'), TALL_PAGE)
  writeFileSync(join(cockpit.projectDir, 'input.html'), INPUT_PAGE)
  writeFileSync(join(cockpit.projectDir, 'alert.html'), ALERT_PAGE)
  await expect
    .poll(async () => (await cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir)).plugins.find((p) => p.id === 'cockpit.browser')?.state, {
      timeout: 20_000
    })
    .toBe('active')
  const browser = await openBrowser(`${server.origin}/`)
  try {
    const { page } = browser
    await page.setViewportSize({ width: 1280, height: 800 })
    await openProjectInBrowser(browser, server.origin, server.projectId)
    const section = page.locator('section.panel[aria-label="Browser"]')
    if (!(await section.isVisible())) await page.getByRole('button', { name: /^Browser/ }).first().click()
    await expect(section).toBeVisible({ timeout: 15_000 })
    const layer = section.locator('.webview-input')
    const pageTitle = section.locator('.webview-url')
    await page.getByRole('button', { name: 'New tab' }).click()
    await page.getByRole('menuitem', { name: 'Claude' }).click()
    await browser.waitForTerminalText('FAKE-CLAUDE banner')
    const open = async (file: string, title: string): Promise<void> => {
      await runInClaude(browser, `/ccc browser open ${file}`)
      await expect(pageTitle).toHaveAttribute('title', new RegExp(`^${title}\\n`), { timeout: 15_000 })
      await expect(section.locator('canvas.webview-canvas')).toHaveAttribute('data-drawn', 'true', { timeout: 15_000 })
      await expect(layer).toBeVisible()
    }
    // The only viewer owns the size, so its frame is drawn 1:1 from the area's top left.
    const box = async (): Promise<{ x: number; y: number; width: number; height: number }> => {
      const b = await layer.boundingBox()
      if (!b) throw new Error('no input layer')
      return b
    }

    // A click runs the page's handler: the canvas turns red. The cursor over the page's
    // `cursor: pointer` box is the browser's pointer (Chromium's `hand`, mapped).
    await open('click.html', 'idle')
    let b = await box()
    await page.mouse.click(b.x + 100, b.y + b.height / 2)
    await expect(pageTitle).toHaveAttribute('title', /^clicked 0\n/, { timeout: 10_000 })
    await expect
      .poll(async () => {
        const [r = -99, g = -99, bl = -99] = await centrePixel(page)
        return Math.max(Math.abs(r - 220), Math.abs(g - 20), Math.abs(bl - 20))
      }, { timeout: 10_000 })
      .toBeLessThanOrEqual(10)
    await page.mouse.move(b.x + b.width - 100, b.y + 100)
    await expect.poll(() => layer.evaluate((n: HTMLElement) => n.style.cursor), { timeout: 10_000 }).toBe('pointer')
    await page.mouse.move(b.x + 100, b.y + b.height - 50)
    await expect.poll(() => layer.evaluate((n: HTMLElement) => n.style.cursor), { timeout: 10_000 }).toBe('default')

    // The wheel scrolls the page (and not the shell).
    await open('tall.html', 'top')
    b = await box()
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await page.mouse.wheel(0, 600)
    await expect(pageTitle).toHaveAttribute('title', /^scrolled [1-9]\d*\n/, { timeout: 10_000 })
    expect(await page.evaluate(() => [document.scrollingElement?.scrollTop ?? 0, window.scrollY])).toEqual([0, 0])

    // Keys reach a focused input: typed letters (key down + char), Backspace, then Enter submits.
    await open('input.html', 'empty')
    b = await box()
    await page.mouse.click(b.x + 100, b.y + 20)
    await expect(layer).toBeFocused()
    await page.keyboard.type('abc')
    await expect(pageTitle).toHaveAttribute('title', /^value abc\n/, { timeout: 10_000 })
    await page.keyboard.press('Backspace')
    await expect(pageTitle).toHaveAttribute('title', /^value ab\n/, { timeout: 10_000 })
    // Shift reaches the page (an upper-case letter), and a clipboard chord does not (Ctrl+V types nothing).
    await page.keyboard.press('Shift+D')
    await expect(pageTitle).toHaveAttribute('title', /^value abD\n/, { timeout: 10_000 })
    await page.keyboard.press('Control+v')
    await page.keyboard.press('Enter')
    await expect(pageTitle).toHaveAttribute('title', /^sent abD\n/, { timeout: 10_000 })
    // The keys never reached the shell's terminal behind the panel.
    expect(await browser.page.locator('.terminal-view:not([hidden]) .xterm-rows').innerText()).not.toContain('abD')

    // alert() and confirm() in the page are disabled (they would abort main headless): the click
    // handler runs on past them, confirm says false, and main lives.
    await open('alert.html', 'ready')
    b = await box()
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
    await expect(pageTitle).toHaveAttribute('title', /^after alert false\n/, { timeout: 10_000 })
    await expectMainAlive(server)
  } finally {
    await browser.close()
  }
})
