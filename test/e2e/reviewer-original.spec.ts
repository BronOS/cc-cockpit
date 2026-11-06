// The bundled reviewer's Original view (annotate's `originals`, feature 'original'), end to end in
// Electron: a fixture plugin (annotate-caller, command "original") hands the reviewer a mail whose
// original HTML is a breakout attempt, with no sanitizer of a caller in front: script in the head
// and the body, an <img onerror>, an <svg onload>, CSS url() and @import to http, a meta refresh, a
// form with an action, a javascript: link, a base href, a stylesheet link, an iframe, a style block
// with an http background image. The page must show it in a frame with `sandbox="allow-popups"` and the
// CSP meta first, keep the sender's styling (a layout table, inline background colours, a struck-out
// value), fill a picture from an asset, never navigate the frame on a link click but open the link in
// the system browser through main's window-open handler (no new window), open it from its own Links
// list through the host's check too, and switch to the Reader view and back (the `view` event
// reaching the caller). Main records every request the app makes (the default session's webRequest)
// and every console message: no request to http(s) at all, no line a script of the mail would print,
// and the browser's own refusals (blocked script, CSP violations of the frame's meta policy) present.
// Bundled plugins are on for this spec.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expect, launchCockpit, test as base, type Cockpit } from './fixtures'

const test = base.extend<{ cockpit: Cockpit }>({
  // eslint-disable-next-line no-empty-pattern
  cockpit: async ({}, use) => {
    const { cockpit, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
    try {
      await use(cockpit)
    } finally {
      await close()
    }
  }
})

const CALLER = 'test.annotatecaller'
const TITLE = 'Notes: [JIRA] PROJ-7 moved to In Progress'

interface Seen {
  calls: { ok: boolean; error?: string; value?: unknown }[]
  views?: { key: string; view: string; caller: string }[]
}

test('original view: the mail in a sandboxed frame keeps its styling, loads and runs nothing, never navigates, and switches to Reader', async ({ cockpit }) => {
  const { page, projectDir } = cockpit
  // Recorded from before the overlay opens: every request of the default session (the shell, the
  // plugin pages and every frame in them) and every console line of every WebContents.
  await cockpit.app.evaluate(({ session, webContents }) => {
    const g = globalThis as { __requests?: string[]; __console?: string[]; __opened?: string[] }
    g.__requests = []
    g.__console = []
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
      g.__requests!.push(d.url)
      cb({})
    })
    for (const wc of webContents.getAllWebContents()) wc.on('console-message', (e) => g.__console!.push(String((e as unknown as { message: string }).message)))
  })
  await cockpit.app.evaluate(({ shell }) => {
    const g = globalThis as { __opened?: string[] }
    g.__opened = []
    shell.openExternal = (url: string) => {
      g.__opened!.push(url)
      return Promise.resolve()
    }
  })
  const opened = (): Promise<string[]> => cockpit.app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])
  const requests = (): Promise<string[]> => cockpit.app.evaluate(() => (globalThis as { __requests?: string[] }).__requests ?? [])
  const consoleLines = (): Promise<string[]> => cockpit.app.evaluate(() => (globalThis as { __console?: string[] }).__console ?? [])
  const frameUrls = (): Promise<string[]> =>
    cockpit.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap((w) => w.webContents.mainFrame.framesInSubtree.map((f) => f.url)))

  await expect
    .poll(async () => (await cockpit.hook<HostStatus>('hostStatus', projectDir)).plugins.some((p) => p.id === 'cockpit.reviewer' && p.state === 'active'), { timeout: 15_000 })
    .toBe(true)
  const seenFile = join(cockpit.root, 'home', 'annotate-caller.json')
  rmSync(seenFile, { force: true })
  await cockpit.hook('linkPlugin', join(__dirname, '..', 'fixtures', 'plugins', 'annotate-caller'))
  await cockpit.hook('enablePlugin', projectDir, CALLER)
  await expect.poll(() => existsSync(seenFile), { timeout: 15_000 }).toBe(true)
  const seen = (): Seen => JSON.parse(readFileSync(seenFile, 'utf8')) as Seen
  await expect
    .poll(
      async () => {
        try {
          await cockpit.hook('runPluginCommand', projectDir, `${CALLER}/original`)
          return true
        } catch {
          return false
        }
      },
      { timeout: 15_000 }
    )
    .toBe(true)
  await expect.poll(() => seen().calls.length, { timeout: 10_000 }).toBe(1)
  expect(seen().calls[0]).toEqual({ ok: true, value: { opened: true } })

  const review = page.frameLocator(`iframe[title="${TITLE}"]`)
  const iframe = review.locator('iframe.original-frame')
  await expect(iframe).toHaveCount(1)
  // The frame exactly as designed: sandbox with allow-popups as its only token (inside the overlay's
  // own allow-scripts allow-popups), no referrer, and its document starts with the CSP meta, before
  // anything of the mail.
  expect(await iframe.getAttribute('sandbox')).toBe('allow-popups')
  expect(await page.locator(`iframe[title="${TITLE}"]`).getAttribute('sandbox')).toBe('allow-scripts allow-popups')
  expect(await iframe.getAttribute('referrerpolicy')).toBe('no-referrer')
  expect(await iframe.getAttribute('allow')).toBeNull()
  const srcdoc = (await iframe.getAttribute('srcdoc')) ?? ''
  expect(
    srcdoc.startsWith(
      `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'">`
    )
  ).toBe(true)

  // The sender's styling holds: the struck-out old value in its red, the new one on its green.
  const mail = review.frameLocator('iframe.original-frame')
  await expect(mail.locator('#designed')).toContainText('In Progress')
  expect(await mail.locator('#designed .old').evaluate((e) => getComputedStyle(e).textDecorationLine)).toBe('line-through')
  expect(await mail.locator('#designed span[style]').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(227, 252, 239)')
  // The picture from the asset (a data: URL, built into the frame once the assets are in).
  await expect(mail.locator('#pic')).toHaveAttribute('src', /^data:image\/png;base64,/)
  // In the Original view the Reader rendering of that message is hidden.
  await expect(review.locator('.mail-body[data-reader="m1"]')).toBeHidden()
  await expect(review.locator('.view-opt[data-view="original"]')).toHaveAttribute('aria-pressed', 'true')

  // A click on a link inside the frame opens it in the system browser: the frame asks for a popup
  // (sandbox allow-popups), main's window-open handler (mail-frame-links.ts) denies the window and
  // hands the checked URL to shell.openExternal (the recorder here). No new window, the frame stays.
  // The status line said its hint when the view showed, not on this click: shown at mousedown it
  // moved the frame under the pointer and the first click opened nothing (the frame's box is the same
  // after the click).
  await expect(review.locator('#status')).toContainText('notes go on the Reader view')
  const box = await iframe.boundingBox()
  const windowCount = (): Promise<number> => cockpit.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  const windowsBefore = await windowCount()
  await mail.locator('#view').click()
  await expect.poll(opened).toEqual(['https://jira.example.com/browse/PROJ-7'])
  expect(await iframe.boundingBox()).toEqual(box)
  // The click did land on the link (it has the focus).
  expect(await mail.locator('body').evaluate((b) => b.ownerDocument.activeElement?.id)).toBe('view')
  // The javascript: link lost its href in the walk: a click on it asks for nothing and opens nothing.
  await mail.locator('#js').click()
  await page.waitForTimeout(500)
  expect(await opened()).toEqual(['https://jira.example.com/browse/PROJ-7'])
  expect(await windowCount()).toBe(windowsBefore)
  await expect(mail.locator('#designed')).toBeVisible()
  expect((await frameUrls()).filter((u) => /^https?:/.test(u))).toEqual([])
  expect((await frameUrls()).filter((u) => u === 'about:srcdoc')).toHaveLength(1)

  // The page's Links list opens it too, through the host's check of the caller's own links.
  await review.locator('.view-links-btn').click()
  await expect(review.locator('.view-links li')).toHaveCount(1)
  await review.locator('.view-links li button', { hasText: 'View issue' }).click()
  await expect.poll(opened).toEqual(['https://jira.example.com/browse/PROJ-7', 'https://jira.example.com/browse/PROJ-7'])

  // Reader and back: the page switches at once, and the caller hears of each choice.
  await review.locator('.view-opt[data-view="reader"]').click()
  await expect(review.locator('.mail-body[data-reader="m1"]')).toBeVisible()
  await expect(iframe).toBeHidden()
  await expect(review.locator('.view-links-btn')).toBeHidden()
  await review.locator('.view-opt[data-view="original"]').click()
  await expect(iframe).toBeVisible()
  await expect.poll(() => seen().views).toEqual([
    { key: 'mail:original', view: 'reader', caller: CALLER },
    { key: 'mail:original', view: 'original', caller: CALLER }
  ])

  // Nothing ran and nothing loaded: no request to http(s) at all (the fixture's URLs are all
  // http://127.0.0.1:9, the Links list's open went to the recorder in place of the browser), no line
  // of the mail's scripts, and the browser's own refusals are there.
  expect((await requests()).filter((u) => /^(?:https?|wss?):/i.test(u))).toEqual([])
  const lines = await consoleLines()
  expect(lines.filter((l) => l.includes('PWNED'))).toEqual([])
  expect(lines.some((l) => l.includes("Blocked script execution in 'about:srcdoc'"))).toBe(true)
  expect(lines.some((l) => l.includes('"img-src data:"'))).toBe(true)
})
