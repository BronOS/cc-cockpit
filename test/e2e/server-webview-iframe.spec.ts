// Input into a cross-site iframe of a streamed page, end to end (design-web-browser.md §4.1,
// `PageInputRouter` in main/webview/page-input.ts): a browser's pointer events go to the deepest
// out-of-process frame under the point, keys and text go on the page's session and follow focus.
// scripts/offscreen-input-check.mjs proves the router in Electron with main's own input object; these
// cases drive the real road: the browser's canvas and hidden textarea, the gateway's WebSocket, main,
// the off-screen page.
//
// The fixture: a top page on http://127.0.0.1:<p1> holding an iframe on http://localhost:<p2>, two
// sites, so with site isolation the iframe is its own renderer process (each case checks the two
// frames' pids differ before any input). Each document logs its trusted presses and releases and the
// buttons of its last move; the cases read the documents through main (`executeJavaScript` on each
// frame of the off-screen page), never by pixels, and only read: focus and carets come from the
// clicks and keys under test.
import { writeFileSync } from 'node:fs'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expectMainAlive, launchServer, type Server } from './server-fixtures'
import { openBrowser, openProjectInBrowser, type WebBrowser } from './web-fixtures'

test.skip(process.platform === 'win32', 'server mode does not run on Windows')

let server: Server | undefined
let browser: WebBrowser | undefined
const http: HttpServer[] = []

test.afterEach(async () => {
  await browser?.close()
  browser = undefined
  await server?.close()
  server = undefined
  for (const h of http.splice(0)) await new Promise<void>((done) => h.close(() => done()))
})

/** What every document runs: its log, its state, one field `#i` at its top left. */
const DOC_SCRIPT = `window.__log = []; window.__move = -1
for (const t of ['mousedown', 'mouseup']) document.addEventListener(t, (e) => { if (e.isTrusted) __log.push(t + ':' + (e.target.id || e.target.tagName)) }, true)
document.addEventListener('mousemove', (e) => { if (e.isTrusted) __move = e.buttons }, true)
const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } }
const i = document.getElementById('i')
window.__state = () => ({ ready: document.readyState, value: i.value, sel: [i.selectionStart, i.selectionEnd],
  active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
  input: rect(i), frame: rect(document.getElementById('A')), log: __log.slice(), move: __move })
window.__clear = () => { __log.length = 0; __move = -1 }`

const STYLE = `html,body{margin:0;height:100%}
input{position:absolute;left:10px;top:10px;width:180px;height:30px;margin:0;font:16px monospace}
iframe{position:absolute;left:0;top:60px;width:280px;height:160px;border:0}`

/** The top page: its field, then the iframe (nothing focusable between them, for the Tab case). */
const topPage = (frameUrl: string): string => `<!doctype html><meta charset="utf-8"><title>top</title>
<style>${STYLE} body{background:#fff}</style>
<input id="i" autocomplete="off"><iframe id="A" src="${frameUrl}"></iframe>
<script>${DOC_SCRIPT}</script>`
const FRAME_PAGE = `<!doctype html><meta charset="utf-8"><title>frame</title>
<style>${STYLE} body{background:#dde}</style>
<input id="i" autocomplete="off">
<script>${DOC_SCRIPT}</script>`

interface Rect {
  x: number
  y: number
  w: number
  h: number
}
interface DocState {
  pid: number
  ready: string
  value: string
  sel: [number, number]
  active: string | null
  input: Rect
  frame: Rect | null
  log: string[]
  move: number
}
type Role = 'top' | 'frame'

/** A loopback http server answering every request with `body` (the other site's page or ours). */
async function serve(body: () => string): Promise<number> {
  const h = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body())
  })
  http.push(h)
  await new Promise<void>((done) => h.listen(0, '127.0.0.1', done))
  return (h.address() as AddressInfo).port
}

/** The off-screen page's WebContents id (one Browser panel, so one page). */
async function pageId(s: Server): Promise<number> {
  const views = await s.cockpit.hook<{ webContentsId: number }[]>('offscreenWebviews')
  expect(views).toHaveLength(1)
  return views[0]!.webContentsId
}

/**
 * One document's state, read in main from the off-screen page's frame whose URL has `?role=<role>`
 * (null while it is not there). A frame that does not answer in 3 s reads as null too.
 */
async function docState(s: Server, id: number, role: Role, code = '__state()'): Promise<DocState | null> {
  return s.cockpit.app.evaluate(
    async ({ webContents }, a) => {
      const wc = webContents.fromId(a.id)
      if (!wc || wc.isDestroyed()) return null
      const frame = wc.mainFrame.framesInSubtree.find((f) => {
        try {
          return new URL(f.url || 'about:blank').searchParams.get('role') === a.role
        } catch {
          return false
        }
      })
      if (!frame) return null
      const read = frame.executeJavaScript(a.code).then((v) => ({ pid: frame.osProcessId, ...(v as Omit<DocState, 'pid'>) }))
      return Promise.race([read, new Promise<null>((done) => setTimeout(() => done(null), 3_000))]).catch(() => null)
    },
    { id, role, code }
  )
}

async function runInClaude(b: WebBrowser, line: string): Promise<void> {
  await b.page.locator('.terminal-view:not([hidden]) .xterm').click()
  await b.page.keyboard.type(line)
  await b.page.keyboard.press('Enter')
}

interface Fixture {
  page: Page
  section: Locator
  textbox: Locator
  /** The input layer's top left in the browser's page: the streamed page's (0, 0), drawn 1:1. */
  origin: { x: number; y: number; width: number; height: number }
  /** A document's state now (it must be there). */
  state(role: Role): Promise<DocState>
  /** A point in the browser for `role`'s field, `dx` px into it, vertically centred. */
  fieldPoint(role: Role, dx?: number): Promise<{ x: number; y: number }>
}

/**
 * A server, a browser on its project with the Browser panel open, and the two-site page loaded in it:
 * both documents complete, the frame confirmed in its own process, the canvas drawn.
 */
async function openFixture(): Promise<Fixture> {
  const framePort = await serve(() => FRAME_PAGE)
  const topPort = await serve(() => topPage(`http://localhost:${framePort}/?role=frame`))
  server = await launchServer({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  const s = server
  // The fake claude needs a project file to start in; the page itself is on the http servers.
  writeFileSync(join(s.cockpit.projectDir, 'readme.txt'), 'iframe input\n')
  await expect
    .poll(async () => (await s.cockpit.hook<HostStatus>('hostStatus', s.cockpit.projectDir)).plugins.find((p) => p.id === 'cockpit.browser')?.state, {
      timeout: 20_000
    })
    .toBe('active')
  browser = await openBrowser(`${s.origin}/`)
  const b = browser
  const { page } = b
  await page.setViewportSize({ width: 1280, height: 800 })
  await openProjectInBrowser(b, s.origin, s.projectId)
  const section = page.locator('section.panel[aria-label="Browser"]')
  if (!(await section.isVisible())) await page.getByRole('button', { name: /^Browser/ }).first().click()
  await expect(section).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'New tab' }).click()
  await page.getByRole('menuitem', { name: 'Claude' }).click()
  await b.waitForTerminalText('FAKE-CLAUDE banner')
  await runInClaude(b, `/ccc browser open http://127.0.0.1:${topPort}/?role=top`)
  await b.waitForTerminalText('FAKE-CLAUDE ccc exit=0 out="ok\\n" err=""')
  await expect(section.locator('.webview-url')).toHaveAttribute('title', /^top\n/, { timeout: 15_000 })
  await expect(section.locator('canvas.webview-canvas')).toHaveAttribute('data-drawn', 'true', { timeout: 15_000 })

  const id = await pageId(s)
  await expect
    .poll(async () => [(await docState(s, id, 'top'))?.ready, (await docState(s, id, 'frame'))?.ready], { timeout: 15_000 })
    .toEqual(['complete', 'complete'])
  const state = async (role: Role): Promise<DocState> => {
    const st = await docState(s, id, role)
    if (!st) throw new Error(`the ${role} document did not answer`)
    return st
  }
  const top = await state('top')
  const frame = await state('frame')
  // Site isolation: the localhost iframe is out of process (else the router's frame road is untested).
  expect(frame.pid, `top pid ${top.pid}, iframe pid ${frame.pid}`).not.toBe(top.pid)

  const layer = await section.locator('.webview-input').boundingBox()
  if (!layer) throw new Error('no input layer')
  const frameRect = top.frame
  if (!frameRect) throw new Error('the top page has no iframe')
  // The fixture's whole layout (the iframe, and the strip below it for the drag) fits the panel (about 320 px wide).
  expect(layer.width).toBeGreaterThanOrEqual(frameRect.x + frameRect.w)
  expect(layer.height).toBeGreaterThan(frameRect.y + frameRect.h + 60)
  const fieldPoint = async (role: Role, dx = 20): Promise<{ x: number; y: number }> => {
    const st = await state(role)
    const off = role === 'frame' ? { x: frameRect.x, y: frameRect.y } : { x: 0, y: 0 }
    return { x: layer.x + off.x + st.input.x + dx, y: layer.y + off.y + st.input.y + st.input.h / 2 }
  }
  return { page, section, textbox: section.locator('textarea.webview-text'), origin: layer, state, fieldPoint }
}

/** Polls both documents' field values until they are `[top, frame]`. */
async function expectValues(f: Fixture, top: string, frame: string): Promise<void> {
  await expect
    .poll(async () => [(await f.state('top')).value, (await f.state('frame')).value], { timeout: 10_000 })
    .toEqual([top, frame])
}

test('server mode, cross-site iframe: a click into its field and typing land there, not in the top page', async () => {
  test.setTimeout(120_000)
  const f = await openFixture()
  const p = await f.fieldPoint('frame')
  await f.page.mouse.click(p.x, p.y)
  await expect(f.textbox).toBeFocused()
  await expect.poll(async () => (await f.state('frame')).active, { timeout: 10_000 }).toBe('i')
  await f.page.keyboard.type('hello frame')
  await expectValues(f, '', 'hello frame')
  // The press and release were the iframe's, the top saw neither.
  expect((await f.state('frame')).log).toEqual(['mousedown:i', 'mouseup:i'])
  expect((await f.state('top')).log).toEqual([])
  await expectMainAlive(server!)
})

test('server mode, cross-site iframe: a drag that starts inside it and ends outside gives it the release', async () => {
  test.setTimeout(120_000)
  const f = await openFixture()
  const top = await f.state('top')
  const frame = top.frame!
  // Press in the iframe below its field (its body), move out below the iframe, release there.
  const start = { x: f.origin.x + frame.x + 100, y: f.origin.y + frame.y + 100 }
  const end = { x: f.origin.x + frame.x + 100, y: f.origin.y + frame.y + frame.h + 40 }
  await f.page.mouse.move(start.x, start.y)
  await f.page.mouse.down()
  await f.page.mouse.move(start.x, start.y + 20, { steps: 2 })
  await f.page.mouse.move(end.x, end.y, { steps: 4 })
  await f.page.mouse.up()
  // (The press's target is the iframe's body; the release's whatever is at the point outside it.)
  const kinds = async (role: Role): Promise<string[]> => (await f.state(role)).log.map((l) => l.split(':')[0]!)
  await expect.poll(() => kinds('frame'), { timeout: 10_000 }).toEqual(['mousedown', 'mouseup'])
  expect((await f.state('top')).log, 'the top page got no press or release').toEqual([])
  // No button left down in the iframe: a plain move over it reports none held.
  await docState(server!, await pageId(server!), 'frame', '__clear()')
  await f.page.mouse.move(start.x + 10, start.y)
  await f.page.mouse.move(start.x + 20, start.y)
  await expect.poll(async () => (await f.state('frame')).move, { timeout: 10_000 }).toBe(0)
  await expectMainAlive(server!)
})

test('server mode, cross-site iframe: Tab from the top field moves into its field, and typing lands there', async () => {
  test.setTimeout(120_000)
  const f = await openFixture()
  const p = await f.fieldPoint('top')
  await f.page.mouse.click(p.x, p.y)
  await expect.poll(async () => (await f.state('top')).active, { timeout: 10_000 }).toBe('i')
  // One Tab should do (the iframe's field is the next focusable); a few allowed, each awaited.
  let reached = false
  for (let n = 0; n < 4 && !reached; n++) {
    await f.page.keyboard.press('Tab')
    reached = await expect
      .poll(async () => (await f.state('frame')).active, { timeout: 2_000 })
      .toBe('i')
      .then(
        () => true,
        () => false
      )
  }
  expect(reached, 'Tab never focused the iframe field').toBe(true)
  // The browser's focus stays on the panel's textarea (Tab went to the page, not the shell).
  await expect(f.textbox).toBeFocused()
  await f.page.keyboard.type('tabbed')
  await expectValues(f, '', 'tabbed')
  await expectMainAlive(server!)
})

test('server mode, cross-site iframe: Cmd+Left and Cmd+Backspace edit its field by the line (macOS)', async () => {
  test.skip(process.platform !== 'darwin', 'the Mac line keys')
  test.setTimeout(120_000)
  const f = await openFixture()
  const p = await f.fieldPoint('frame')
  await f.page.mouse.click(p.x, p.y)
  await expect.poll(async () => (await f.state('frame')).active, { timeout: 10_000 }).toBe('i')
  await f.page.keyboard.type('abc def')
  await expectValues(f, '', 'abc def')
  // Cmd+Left: the caret to the line's start.
  await f.page.keyboard.press('Meta+ArrowLeft')
  await expect.poll(async () => (await f.state('frame')).sel, { timeout: 10_000 }).toEqual([0, 0])
  // A marker typed there, then Cmd+Backspace deletes the line before the caret: the marker only.
  await f.page.keyboard.type('XY ')
  await expectValues(f, '', 'XY abc def')
  await expect.poll(async () => (await f.state('frame')).sel, { timeout: 10_000 }).toEqual([3, 3])
  await f.page.keyboard.press('Meta+Backspace')
  await expectValues(f, '', 'abc def')
  await expect.poll(async () => (await f.state('frame')).sel, { timeout: 10_000 }).toEqual([0, 0])
  await expectMainAlive(server!)
})

test('server mode, cross-site iframe: typing in its field, then clicking the top field and typing, keeps each text in its own field', async () => {
  test.setTimeout(120_000)
  const f = await openFixture()
  const inFrame = await f.fieldPoint('frame')
  const inTop = await f.fieldPoint('top')
  await f.page.mouse.click(inFrame.x, inFrame.y)
  await f.page.keyboard.type('frame text')
  await f.page.mouse.click(inTop.x, inTop.y)
  await f.page.keyboard.type('top text')
  // Nothing awaited between: the order is the router's promise.
  await expectValues(f, 'top text', 'frame text')
  expect((await f.state('top')).active).toBe('i')
  await expectMainAlive(server!)
})
