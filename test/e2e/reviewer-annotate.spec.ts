// The bundled reviewer's annotate() in HTML mode, end to end: a fixture plugin (annotate-caller)
// hands it markup with a script, an onerror handler, a style block and attribute, a javascript:
// link, an iframe, a form and a remote image next to the content it must keep, plus one image as
// an asset. The overlay page parses it inertly and rebuilds it from an allow-list
// (plugins/reviewer/src/page/sanitize.mjs); this checks the DOM it ended up with in the real
// Chromium parser, that the asset image loads, that a link click opens the link through the host's
// ctx.openExternal without navigating the frame (a drag-select ending on a link does not), and that a note on a
// selection (made with the floating "Add note" under it) is highlighted again when the draft reopens,
// and that the "Open in browser" icon at the end of the document's h1 opens the caller's url through
// ctx.openExternal. The page has no header row in annotate mode: the overlay's title bar names it.
// The caller's `aside` is a details column, sanitized the same way, with its facts list vertical; the
// notes are a compact list under the comment (no sidebar), and ✕ deletes one. Bundled plugins are on for this spec.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { OverlayInfo } from '../../src/shared/ipc'
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
const TITLE = 'Notes: PROJ-1 Fix the login redirect'
const stack = (c: Cockpit): Promise<OverlayInfo[]> => c.hook<OverlayInfo[]>('overlays', c.projectDir)

test('annotate html: the page keeps the allowed markup only, loads the asset, and re-highlights a note', async ({ cockpit }) => {
  const { page, projectDir } = cockpit
  await expect
    .poll(async () => (await cockpit.hook<HostStatus>('hostStatus', projectDir)).plugins.some((p) => p.id === 'cockpit.reviewer' && p.state === 'active'), {
      timeout: 15_000
    })
    .toBe(true)

  const seenFile = join(cockpit.root, 'home', 'annotate-caller.json')
  rmSync(seenFile, { force: true })
  await cockpit.hook('linkPlugin', join(__dirname, '..', 'fixtures', 'plugins', 'annotate-caller'))
  await cockpit.hook('enablePlugin', projectDir, CALLER)
  await expect.poll(() => existsSync(seenFile), { timeout: 15_000 }).toBe(true)
  const calls = (): Array<{ ok: boolean; error?: string }> => (JSON.parse(readFileSync(seenFile, 'utf8')) as { calls: [] }).calls
  // The command may reach main a moment after activate wrote the file: retry the run.
  const annotate = async (): Promise<void> => {
    const before = calls().length
    await expect
      .poll(
        async () => {
          try {
            await cockpit.hook('runPluginCommand', projectDir, `${CALLER}/html`)
            return true
          } catch {
            return false
          }
        },
        { timeout: 15_000 }
      )
      .toBe(true)
    await expect.poll(() => calls().length, { timeout: 10_000 }).toBe(before + 1)
    expect(calls()[before]).toEqual({ ok: true, value: { opened: true } })
  }

  await annotate()
  await expect.poll(async () => (await stack(cockpit)).map((o) => o.title), { timeout: 15_000 }).toEqual([TITLE])
  const frame = page.frameLocator(`iframe[title="${TITLE}"]`)
  const doc = frame.locator('#editors .doc-body')
  await expect(doc).toContainText('Users land on')
  // No header row (title, toolbar): the overlay frame's title bar is the one title outside the document.
  await expect(frame.locator('header')).toBeHidden()
  // The caller's url is an icon button at the end of the document's first h1, not text; a click opens
  // that URL through the reviewer host's ctx.openExternal (main records it here in place of the real browser).
  const openUrl = frame.locator('#open-url')
  await expect(openUrl).toBeVisible()
  await expect(doc.locator('h1 > #open-url')).toHaveCount(1)
  await expect(openUrl).toHaveAttribute('aria-label', 'Open in browser')
  await expect(openUrl).toHaveAttribute('title', 'Open in browser: https://example.atlassian.net/browse/PROJ-1')
  await cockpit.app.evaluate(({ shell }) => {
    const g = globalThis as { __opened?: string[] }
    g.__opened = []
    shell.openExternal = (url: string) => {
      g.__opened!.push(url)
      return Promise.resolve()
    }
  })
  const opened = (): Promise<string[]> => cockpit.app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])
  await openUrl.click()
  await expect.poll(opened).toEqual(['https://example.atlassian.net/browse/PROJ-1'])

  // No notes sidebar: the only column beside the document is the caller's details.
  await expect(frame.locator('main > aside')).toHaveCount(1)
  await expect(frame.locator('#notes')).toBeHidden() // no note yet: the list takes no room
  const aside = frame.locator('#details')
  await expect(aside).toBeVisible()
  await expect(aside.locator('.person')).toHaveText('Bob Stone')
  await expect(aside.locator('.lozenge')).toHaveAttribute('class', 'lozenge lozenge-danger')
  await expect(aside.locator('script')).toHaveCount(0)
  await expect(aside.locator('dl')).not.toHaveAttribute('style')
  await expect(aside.locator('dl')).not.toHaveAttribute('onclick')
  await expect(aside.locator('a')).toHaveAttribute('href', 'https://example.atlassian.net/browse/PROJ-2')
  // Facts: a grid in the document, a vertical list (each label above its value) in the column.
  expect(await doc.locator('dl.facts').evaluate((e) => getComputedStyle(e).display)).toBe('grid')
  expect(await aside.locator('dl.facts').evaluate((e) => getComputedStyle(e).display)).toBe('block')
  const dt = (await aside.locator('dt').first().boundingBox())!
  const dd = (await aside.locator('dd').first().boundingBox())!
  expect(dd.y).toBeGreaterThanOrEqual(dt.y + dt.height - 1)
  expect(Math.abs(dd.x - dt.x)).toBeLessThan(2)

  // Dropped with their content: script, style, iframe, form and its input.
  for (const sel of ['script', 'style', 'iframe', 'form', 'input']) await expect(doc.locator(sel)).toHaveCount(0)
  await expect(doc).not.toContainText('__pwned')
  await expect(doc).not.toContainText('display: none')
  // No event handler, style or id attribute anywhere; classes off the allow-list are gone. (The open
  // icon is the page's own element, not the caller's markup.)
  const attrs = await doc.evaluate((root) =>
    [...root.querySelectorAll('*:not(#open-url):not(#open-url *)')].flatMap((e) => [...e.attributes].map((a) => a.name)).filter((n) => n.startsWith('on') || n === 'style' || n === 'id' || n === 'target')
  )
  expect(attrs).toEqual([])
  await expect(doc.locator('h1')).toHaveText('Fix the login redirect')
  await expect(doc.locator('div.jira-panel')).toHaveAttribute('class', 'jira-panel jira-panel-warning')
  await expect(doc.locator('span.mention')).toHaveText('@Ann Lee')
  await expect(doc.locator('td')).toHaveAttribute('colspan', '2')
  // The javascript: link keeps its text but no href; the https one keeps its href.
  const links = doc.locator('a')
  await expect(links).toHaveCount(3)
  expect(await links.nth(0).getAttribute('href')).toBeNull()
  await expect(links.nth(1)).toHaveAttribute('href', 'https://example.atlassian.net/browse/PROJ-1')
  // The caller wrote `?a=1&amp;b=2`: the DOM has it decoded, and the host matches it to the caller's markup.
  const attachment = 'https://example.atlassian.net/secure/attachment/1/redirect-log.txt?a=1&b=2'
  await expect(links.nth(2)).toHaveAttribute('href', attachment)
  // A remote image is not loaded: its alt text stands in.
  await expect(doc.locator('.img-missing')).toHaveText('[image: broken]')
  // Nothing ran: no script, no handler.
  expect(await doc.evaluate((el) => (el.ownerDocument.defaultView as unknown as { __pwned?: string }).__pwned)).toBeUndefined()

  // The asset image arrives in its own message and loads; the one never sent shows its alt text.
  const shot = doc.locator('img[data-asset="shot-1"]')
  await expect(shot).toHaveAttribute('src', /^data:image\/png;base64,/)
  await expect.poll(() => shot.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(2)
  await expect(doc.locator('.asset-box:has(img[data-asset="never-sent"])')).toHaveClass(/failed/)
  await expect(doc.locator('.asset-box:has(img[data-asset="shot-1"])')).not.toHaveClass(/pending|failed/)

  // A link click opens it through the reviewer host's ctx.openExternal (only a link the caller's own
  // html has); the frame stays where it was. A link shows its URL as a tooltip. (openExternal takes 3
  // links per 10 s: this spec opens exactly 3.)
  await expect(links.nth(1)).toHaveAttribute('title', 'https://example.atlassian.net/browse/PROJ-1')
  await links.nth(1).click()
  await expect.poll(opened).toEqual(['https://example.atlassian.net/browse/PROJ-1', 'https://example.atlassian.net/browse/PROJ-1'])
  await expect(frame.locator('#status')).toHaveText('')
  await expect(doc).toContainText('Users land on')
  // A drag-select from the text before the link to its end makes a selection for a note and opens nothing.
  await links.nth(2).scrollIntoViewIfNeeded()
  const linkBox = (await links.nth(2).boundingBox())!
  await page.mouse.move(linkBox.x - 50, linkBox.y + linkBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(linkBox.x + linkBox.width - 3, linkBox.y + linkBox.height / 2, { steps: 8 })
  await page.mouse.up()
  expect(await doc.evaluate((root) => root.ownerDocument.getSelection()!.toString().length)).toBeGreaterThan(10)
  await expect(frame.locator('#add-note')).toBeVisible()
  await page.waitForTimeout(500)
  expect(await opened()).toHaveLength(2)
  // Enter on the focused link opens it too.
  await doc.evaluate((root) => root.ownerDocument.getSelection()!.removeAllRanges())
  await links.nth(2).focus()
  await links.nth(2).press('Enter')
  await expect.poll(opened).toEqual(['https://example.atlassian.net/browse/PROJ-1', 'https://example.atlassian.net/browse/PROJ-1', attachment])
  await expect(frame.locator('#status')).toHaveText('')
  // The image opens larger; a click closes it.
  await shot.click()
  await expect(frame.locator('#lightbox')).toBeVisible()
  await expect(frame.locator('#lightbox-img')).toHaveAttribute('src', /^data:image\/png/)
  await frame.locator('#lightbox').click()
  await expect(frame.locator('#lightbox')).toBeHidden()

  // A note on a selection: the quote is listed and highlighted.
  const select = (text: string): Promise<void> =>
    doc.evaluate((root, t) => {
      const w = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = (n as Text).data.indexOf(t)
        if (i === -1) continue
        const r = root.ownerDocument.createRange()
        r.setStart(n, i)
        r.setEnd(n, i + t.length)
        const sel = root.ownerDocument.getSelection()!
        sel.removeAllRanges()
        sel.addRange(r)
        return
      }
      throw new Error(`no text ${t}`)
    }, text)
  // "Add note" floats just under the end of the selection, and only while there is one.
  const addNote = frame.locator('#add-note')
  await expect(addNote).toBeHidden()
  await select('redirect target')
  await expect(addNote).toBeVisible()
  await expect(addNote).toBeEnabled()
  const selBottom = await doc.evaluate((root) => {
    const rects = root.ownerDocument.getSelection()!.getRangeAt(0).getClientRects()
    return rects[rects.length - 1]!.bottom
  })
  const box = (await addNote.evaluate((b) => b.getBoundingClientRect().toJSON())) as DOMRect
  expect(box.top).toBeGreaterThanOrEqual(selBottom)
  expect(box.top - selBottom).toBeLessThan(20)
  await doc.evaluate((root) => root.ownerDocument.getSelection()!.collapseToEnd())
  await expect(addNote).toBeHidden()
  await select('redirect target')
  await addNote.click()
  await expect(frame.locator('.note')).toHaveCount(1)
  await expect(addNote).toBeHidden()
  // The notes list sits under the comment, outside the document's row.
  await expect(frame.locator('#notes')).toBeVisible()
  await expect(frame.locator('main #notes')).toHaveCount(0)
  const commentBox = (await frame.locator('#global').boundingBox())!
  expect((await frame.locator('#notes').boundingBox())!.y).toBeGreaterThanOrEqual(commentBox.y + commentBox.height)
  await expect(frame.locator('.note .link').first()).toHaveText('«redirect target»')
  await frame.locator('.note-text').fill('Which step?')
  const highlighted = (): Promise<number> =>
    doc.evaluate((el) => {
      const css = (el.ownerDocument.defaultView as unknown as { CSS: { highlights: Map<string, Set<Range>> } }).CSS
      const h = css.highlights.get('rv-note')
      return h ? [...h].map((r) => r.toString()).filter((s) => s === 'redirect target').length : 0
    })
  expect(await highlighted()).toBe(1)

  // Esc keeps the draft; the same key reopens it with the note found and highlighted again.
  await cockpit.app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  })
  await expect.poll(async () => (await stack(cockpit)).length).toBe(0)
  await annotate()
  await expect.poll(async () => (await stack(cockpit)).map((o) => o.title), { timeout: 15_000 }).toEqual([TITLE])
  await expect(frame.locator('.note-text')).toHaveValue('Which step?')
  await expect(frame.locator('.note .link').first()).toHaveText('«redirect target»')
  await expect.poll(highlighted).toBe(1)

  // ✕ deletes the note: the list goes, and so does the highlight.
  await frame.getByRole('button', { name: 'Delete note' }).click()
  await expect(frame.locator('.note')).toHaveCount(0)
  await expect(frame.locator('#notes')).toBeHidden()
  await expect.poll(highlighted).toBe(0)
})
