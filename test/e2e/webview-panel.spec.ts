// Plan B, Task 8: a `"kind": "webview"` panel in the shell. The fixture plugin drives its view from
// a Claude tab (`ccc wv open|show`); main lays the native view over the panel's placeholder and
// hides it while the panel is closed or collapsed, an overlay or the palette is up. The view's
// state is read from Electron itself (View.getVisible, getBounds), not from main's bookkeeping.
import { spawn } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expect, test, type Cockpit } from './fixtures'

const FIXTURE = join(__dirname, '..', 'fixtures', 'plugins', 'host-webview')
const ID = 'test.hostwebview'
const KEY = `${ID}/view`
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

interface ViewState {
  url: string
  loading: boolean
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
  webrtc: string
}

/** The webview panel's native view in the project window (the one WebContentsView on cc-preview:), or null. */
function viewState(c: Cockpit): Promise<ViewState | null> {
  return c.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      for (const child of win.contentView.children) {
        if (!(child instanceof WebContentsView)) continue
        const wc = child.webContents
        if (wc.isDestroyed() || !wc.getURL().startsWith('cc-preview://')) continue
        return {
          url: wc.getURL(),
          loading: wc.isLoading(),
          visible: child.getVisible(),
          bounds: child.getBounds(),
          webrtc: wc.getWebRTCIPHandlingPolicy()
        }
      }
    }
    return null
  })
}

/** Run `code` in the view's page once it has loaded. */
async function inView<T>(c: Cockpit, code: string): Promise<T> {
  let value: T | undefined
  await expect
    .poll(async () => {
      const out = await c.app.evaluate(async ({ webContents }, js) => {
        const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().startsWith('cc-preview://'))
        if (!wc || wc.isLoading()) return { ready: false }
        return { ready: true, value: (await wc.executeJavaScript(js, true)) as unknown }
      }, code)
      if (out.ready) value = out.value as T
      return out.ready
    })
    .toBe(true)
  return value as T
}

const visible = async (c: Cockpit): Promise<boolean | undefined> => (await viewState(c))?.visible

test('a webview panel shows a local page with its css, hides under shell layers and comes back', async ({ cockpit }) => {
  const { page } = cockpit
  const mock = join(cockpit.projectDir, 'mock')
  mkdirSync(mock)
  writeFileSync(
    join(mock, 'index.html'),
    '<!doctype html><title>Mock page</title><link rel="stylesheet" href="style.css"><p class="hello">hello mock</p>'
  )
  writeFileSync(join(mock, 'style.css'), 'body { background-color: rgb(1, 2, 3); } .hello { color: rgb(200, 100, 50); }')

  await cockpit.hook('linkPlugin', FIXTURE)
  await cockpit.hook('enablePlugin', cockpit.projectDir, ID)
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: ID, state: 'active' }] })
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')

  // The view exists once the plugin navigates, but its panel starts closed: not shown.
  await cockpit.typeLine('/ccc wv open mock/index.html')
  await cockpit.waitForTerminalText('FAKE-CLAUDE ccc exit=0 out="ok\\n" err=""')
  await expect.poll(async () => (await viewState(cockpit))?.url).toMatch(/^cc-preview:\/\/t[0-9a-f]+\/index\.html$/)
  expect(await visible(cockpit)).toBe(false)
  // The page rendered with the css next to it (served from the same token).
  expect(await inView<string>(cockpit, 'getComputedStyle(document.body).backgroundColor')).toBe('rgb(1, 2, 3)')
  expect(await inView<string>(cockpit, 'getComputedStyle(document.querySelector(".hello")).color')).toBe('rgb(200, 100, 50)')
  // WebRTC is kept off non-proxied UDP (webview-hardening.ts): a local page cannot reach a STUN server.
  expect((await viewState(cockpit))?.webrtc).toBe('disable_non_proxied_udp')

  // ctx.panels.show opens the panel: toolbar with the page, the view over the placeholder.
  await cockpit.typeLine('/ccc wv show')
  const panel = page.locator(`section.panel[data-panel="${KEY}"]`)
  await expect(panel).toBeVisible()
  await expect(panel.locator('.webview-url')).toHaveAttribute('data-url', /^cc-preview:\/\/t[0-9a-f]+\/index\.html$/)
  // A cc-preview page has no system-browser counterpart.
  await expect(panel.getByRole('button', { name: 'Open in system browser' })).toBeDisabled()
  await expect.poll(() => visible(cockpit)).toBe(true)
  const box = await panel.locator('.webview-placeholder').boundingBox()
  const bounds = (await viewState(cockpit))!.bounds
  expect(Math.abs(bounds.x - box!.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(bounds.y - box!.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(bounds.width - box!.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(bounds.height - box!.height)).toBeLessThanOrEqual(1)

  // An overlay hides the view; closing it shows the view again.
  await cockpit.hook('openOverlay', cockpit.projectDir, { kind: 'html', html: '<p>over</p>', title: 'Over' })
  await expect(page.locator('.overlay')).toBeVisible()
  await expect.poll(() => visible(cockpit)).toBe(false)
  await page.getByRole('button', { name: 'Close overlay' }).click()
  await expect(page.locator('.overlay')).toHaveCount(0)
  await expect.poll(() => visible(cockpit)).toBe(true)

  // So does the command palette (a shell layer only the page knows of).
  await page.locator('.terminal-view:not([hidden]) .xterm').click()
  await page.keyboard.press(`${MOD}+Shift+p`)
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  await expect.poll(() => visible(cockpit)).toBe(false)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0)
  await expect.poll(() => visible(cockpit)).toBe(true)

  // Collapsing the zone hides it; ctx.panels.show expands the zone again.
  await page.locator('.terminal-view:not([hidden]) .xterm').click()
  await page.keyboard.press(`${MOD}+Shift+b`)
  await expect(page.locator('.zone-right')).toHaveClass(/collapsed/)
  await expect.poll(() => visible(cockpit)).toBe(false)
  await cockpit.typeLine('/ccc wv show')
  await expect(page.locator('.zone-right')).not.toHaveClass(/collapsed/)
  await expect(panel).toBeVisible()
  await expect.poll(() => visible(cockpit)).toBe(true)
})

test('an app chord typed into the page runs in the app; other keys stay with the page', async ({ cockpit }) => {
  const { page } = cockpit
  const mock = join(cockpit.projectDir, 'mock')
  mkdirSync(mock)
  writeFileSync(
    join(mock, 'index.html'),
    '<!doctype html><title>Keys</title><input id="f" autofocus><script>window.keys = []; addEventListener("keydown", (e) => keys.push(e.key))</script>'
  )
  await cockpit.hook('linkPlugin', FIXTURE)
  await cockpit.hook('enablePlugin', cockpit.projectDir, ID)
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: ID, state: 'active' }] })
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  await cockpit.typeLine('/ccc wv open mock/index.html')
  await cockpit.waitForTerminalText('FAKE-CLAUDE ccc exit=0 out="ok\\n" err=""')
  await cockpit.typeLine('/ccc wv show')
  await expect.poll(() => visible(cockpit)).toBe(true)
  await inView(cockpit, 'document.readyState')

  const press = (keyCode: string, modifiers: string[]): Promise<void> =>
    cockpit.app.evaluate(
      ({ webContents }, [code, mods]) => {
        const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().startsWith('cc-preview://'))
        const m = mods as Array<'meta' | 'shift' | 'control'>
        wc?.sendInputEvent({ type: 'keyDown', keyCode: code as string, modifiers: m })
        wc?.sendInputEvent({ type: 'keyUp', keyCode: code as string, modifiers: m })
      },
      [keyCode, modifiers] as const
    )

  // A plain key and Escape are the page's own (no command bound with Cmd/Ctrl/Alt).
  await press('k', [])
  await press('Escape', [])
  await expect.poll(() => inView<string[]>(cockpit, 'window.keys')).toEqual(expect.arrayContaining(['k', 'Escape']))
  await expect(page.locator('.zone-right')).not.toHaveClass(/collapsed/)

  // Cmd+Shift+B (toggle right zone) typed into the page runs in the app: the zone collapses and
  // the view hides with it.
  await press('B', [process.platform === 'darwin' ? 'meta' : 'control', 'shift'])
  await expect(page.locator('.zone-right')).toHaveClass(/collapsed/)
  await expect.poll(() => visible(cockpit)).toBe(false)
})

/** `ccc --project <project> wv …` from outside a tab, with the project as cwd; its exit status. */
function wv(c: Cockpit, args: string[]): Promise<number | null> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: c.dataDir }
  return new Promise((resolve) => {
    const child = spawn(join(c.dataDir, 'bin', 'ccc'), ['--project', c.projectDir, 'wv', ...args], { env, cwd: c.projectDir, stdio: 'ignore' })
    child.on('close', resolve)
  })
}

// Review finding: a dev reload ends the plugin's views and main drops their placements, but the
// panel stays mounted and its reporter sends nothing it already sent: the new copy's view stayed
// hidden until the placeholder moved. The panel now mounts again on the reload and reports.
test("after a dev reload the plugin's new view shows over the panel without a layout change", async ({ cockpit }) => {
  const dev = join(cockpit.root, 'dev-webview')
  cpSync(FIXTURE, dev, { recursive: true })
  const mock = join(cockpit.projectDir, 'mock')
  mkdirSync(mock)
  writeFileSync(join(mock, 'index.html'), '<!doctype html><title>Mock</title><p>mock</p>')
  await cockpit.hook('linkPlugin', dev)
  await cockpit.hook('enablePlugin', cockpit.projectDir, ID)
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: ID, state: 'active' }] })
  expect(await wv(cockpit, ['open', 'mock/index.html'])).toBe(0)
  expect(await wv(cockpit, ['show'])).toBe(0)
  await expect.poll(() => visible(cockpit)).toBe(true)

  // Edit the linked folder: the plugin reloads in its host and its view goes with the old copy.
  appendFileSync(join(dev, 'host.js'), '\n// edited\n')
  await expect.poll(() => viewState(cockpit), { timeout: 15_000 }).toBeNull()
  await expect.poll(() => wv(cockpit, ['open', 'mock/index.html']), { timeout: 15_000 }).toBe(0)
  await expect.poll(async () => (await viewState(cockpit))?.url).toMatch(/^cc-preview:\/\/t[0-9a-f]+\/index\.html$/)
  await expect.poll(() => visible(cockpit)).toBe(true)
})

// Review finding (ext round 9): once the user has touched a page with a beforeunload handler (an
// editor, a form), Electron cancels its unload silently, so `ccc browser open <other>` and reload
// did nothing while the CLI printed ok. The view ignores beforeunload (webview-hardening.ts).
test('a page with a beforeunload handler the user has touched does not hold the view', async ({ cockpit }) => {
  const mock = join(cockpit.projectDir, 'mock')
  mkdirSync(mock)
  writeFileSync(
    join(mock, 'editor.html'),
    '<!doctype html><title>Editor</title><input id="f">' +
      '<script>addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = "unsaved" })</script>'
  )
  writeFileSync(join(mock, 'next.html'), '<!doctype html><title>Next</title><p>next</p>')
  await cockpit.hook('linkPlugin', FIXTURE)
  await cockpit.hook('enablePlugin', cockpit.projectDir, ID)
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: ID, state: 'active' }] })
  expect(await wv(cockpit, ['open', 'mock/editor.html'])).toBe(0)
  expect(await wv(cockpit, ['show'])).toBe(0)
  await expect.poll(() => visible(cockpit)).toBe(true)
  await inView(cockpit, 'document.readyState')
  // The user's touch (sticky activation), which arms the handler: a click into the page.
  await cockpit.app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().startsWith('cc-preview://'))
    wc?.sendInputEvent({ type: 'mouseDown', x: 10, y: 10, button: 'left', clickCount: 1 })
    wc?.sendInputEvent({ type: 'mouseUp', x: 10, y: 10, button: 'left', clickCount: 1 })
  })
  await expect.poll(() => inView<boolean>(cockpit, 'navigator.userActivation.hasBeenActive')).toBe(true)

  expect(await wv(cockpit, ['open', 'mock/next.html'])).toBe(0)
  await expect.poll(async () => (await viewState(cockpit))?.url).toMatch(/^cc-preview:\/\/t[0-9a-f]+\/next\.html$/)
})
