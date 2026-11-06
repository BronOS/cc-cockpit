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
// notes are a compact list under the comment (no sidebar), and ✕ deletes one. The second test hands a
// companion (a mail with the issue it is about beside it): two columns side by side, each scrolling on
// its own under one header row (label, "Open in <site> ↗", facts; both cells the same height), a
// divider that is remembered, the companion's links, a note made in the companion and found again on
// reopen, stacked when narrow.
// Bundled plugins are on for this spec.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { OverlayInfo } from '../../src/shared/ipc'
import type { Locator } from '@playwright/test'
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

type Call = { ok: boolean; error?: string; value?: unknown; features?: string[] }

/** Links the fixture into the project; returns a runner of its commands that waits for the outcome. */
async function linkCaller(cockpit: Cockpit): Promise<{ run: (command: string) => Promise<Call>; calls: () => Call[] }> {
  const { projectDir } = cockpit
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
  const calls = (): Call[] => (JSON.parse(readFileSync(seenFile, 'utf8')) as { calls: Call[] }).calls
  // The command may reach main a moment after activate wrote the file: retry the run.
  const run = async (command: string): Promise<Call> => {
    const before = calls().length
    await expect
      .poll(
        async () => {
          try {
            await cockpit.hook('runPluginCommand', projectDir, `${CALLER}/${command}`)
            return true
          } catch {
            return false
          }
        },
        { timeout: 15_000 }
      )
      .toBe(true)
    await expect.poll(() => calls().length, { timeout: 10_000 }).toBe(before + 1)
    return calls()[before]!
  }
  return { run, calls }
}

/** Replaces the system browser with a list main records the opened URLs in. */
async function recordOpened(cockpit: Cockpit): Promise<() => Promise<string[]>> {
  await cockpit.app.evaluate(({ shell }) => {
    const g = globalThis as { __opened?: string[] }
    g.__opened = []
    shell.openExternal = (url: string) => {
      g.__opened!.push(url)
      return Promise.resolve()
    }
  })
  return () => cockpit.app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])
}

/** Selects the first occurrence of `text` in the text nodes under `root`. */
const selectIn = (root: Locator, text: string): Promise<void> =>
  root.evaluate((el, t) => {
    const w = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = (n as Text).data.indexOf(t)
      if (i === -1) continue
      const r = el.ownerDocument.createRange()
      r.setStart(n, i)
      r.setEnd(n, i + t.length)
      const sel = el.ownerDocument.getSelection()!
      sel.removeAllRanges()
      sel.addRange(r)
      return
    }
    throw new Error(`no text ${t}`)
  }, text)

/** How many ranges of the note highlight read `text`. */
const highlightedText = (root: Locator, text: string): Promise<number> =>
  root.evaluate((el, t) => {
    const css = (el.ownerDocument.defaultView as unknown as { CSS: { highlights: Map<string, Set<Range>> } }).CSS
    const h = css.highlights.get('rv-note')
    return h ? [...h].map((r) => r.toString()).filter((s) => s === t).length : 0
  }, text)

const pressEsc = (cockpit: Cockpit): Promise<void> =>
  cockpit.app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  })

test('annotate html: the page keeps the allowed markup only, loads the asset, and re-highlights a note', async ({ cockpit }) => {
  const { page } = cockpit
  const { run } = await linkCaller(cockpit)
  const annotate = async (): Promise<void> => {
    expect(await run('html')).toEqual({ ok: true, value: { opened: true } })
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
  const opened = await recordOpened(cockpit)
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
  const select = (text: string): Promise<void> => selectIn(doc, text)
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
  const highlighted = (): Promise<number> => highlightedText(doc, 'redirect target')
  expect(await highlighted()).toBe(1)

  // Esc keeps the draft; the same key reopens it with the note found and highlighted again.
  await pressEsc(cockpit)
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

test('annotate companion: two columns with their own facts, a remembered divider, notes and links in the companion', async ({ cockpit }) => {
  const { page } = cockpit
  const { run } = await linkCaller(cockpit)
  const TITLE2 = 'Notes: Re: the login redirect'
  const annotate = async (): Promise<void> => {
    expect(await run('companion')).toEqual({ ok: true, value: { opened: true }, features: ['companion', 'prepare', 'type', 'mail', 'actions', 'update'] })
    await expect.poll(async () => (await stack(cockpit)).map((o) => o.title), { timeout: 15_000 }).toEqual([TITLE2])
  }
  await annotate()
  const frame = page.frameLocator(`iframe[title="${TITLE2}"]`)
  const left = frame.locator('.split > .col-main')
  const right = frame.locator('.split > .col-companion')
  const mainDoc = left.locator('article.doc-body')
  const issueDoc = right.locator('article.doc-body')
  await expect(mainDoc).toContainText('Is the redirect fixed')
  await expect(issueDoc).toContainText('Users land on the wrong page')
  // Side by side: main left, companion right, the divider between, about half and half.
  const lb = (await left.boundingBox())!
  const rb = (await right.boundingBox())!
  expect(rb.x).toBeGreaterThanOrEqual(lb.x + lb.width)
  expect(Math.abs(rb.y - lb.y)).toBeLessThan(2)
  expect(Math.abs(lb.width - rb.width)).toBeLessThan(12)
  // No details column at the right. One header row above both documents: each cell a bar with the
  // column's label and its open button, then its facts; both cells the same height (the taller one's).
  await expect(frame.locator('#details')).toBeHidden()
  const mainHead = frame.locator('.split > .col-head-main')
  const issueHead = frame.locator('.split > .col-head-companion')
  await expect(mainHead.locator('.col-label')).toHaveText('Mail')
  await expect(issueHead.locator('.col-label')).toHaveText('Jira · PROJ-1')
  await expect(mainHead.locator('.col-open')).toHaveText('Open in Example Mail ↗')
  await expect(issueHead.locator('.col-open')).toHaveText('Open in Jira ↗')
  await expect(issueHead.locator('.col-open')).toHaveAttribute('title', 'Open in Jira: https://example.atlassian.net/browse/PROJ-1')
  await expect(mainHead.locator('.col-facts .person')).toHaveText('Ann Lee')
  await expect(issueHead.locator('.col-facts .lozenge')).toHaveText('In progress')
  expect(await issueHead.locator('dl.facts').evaluate((e) => getComputedStyle(e).display)).toBe('grid')
  const mh = (await mainHead.boundingBox())!
  const ih = (await issueHead.boundingBox())!
  expect(Math.abs(mh.height - ih.height)).toBeLessThan(1)
  expect(Math.abs(mh.y - ih.y)).toBeLessThan(1)
  // The mail's facts are one row, the issue's several: the row still took the taller one.
  expect((await mainHead.locator('dl.facts').boundingBox())!.height).toBeLessThan((await issueHead.locator('dl.facts').boundingBox())!.height)
  expect((await left.boundingBox())!.y).toBeGreaterThanOrEqual(mh.y + mh.height - 1)
  // The companion's picture came from the one asset set.
  await expect.poll(() => issueDoc.locator('img[data-asset="issue-shot"]').evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(2)
  // Each column scrolls on its own, under the header row: the long issue scrolls, the mail and the facts stay put.
  const scrollTop = (col: Locator): Promise<number> => col.locator('.doc').evaluate((e) => e.scrollTop)
  await right.locator('.doc').evaluate((e) => (e.scrollTop = 400))
  expect(await scrollTop(right)).toBeGreaterThan(0)
  expect(await scrollTop(left)).toBe(0)
  expect((await issueHead.boundingBox())!.y).toBe(ih.y)
  await expect(issueHead.locator('.col-facts .lozenge')).toBeInViewport()
  await right.locator('.doc').evaluate((e) => (e.scrollTop = 0))

  // The header buttons open each column's own url; no icon after the h1s then.
  const opened = await recordOpened(cockpit)
  await expect(frame.locator('#open-url')).toBeHidden()
  await expect(mainDoc.locator('#open-url')).toHaveCount(0)
  await issueHead.locator('.col-open').click()
  await expect.poll(opened).toEqual(['https://example.atlassian.net/browse/PROJ-1'])
  // A link of the companion's opens: the host's allow-set has the companion's links too.
  await issueDoc.locator('a', { hasText: 'PROJ-3' }).click()
  await expect.poll(opened).toEqual(['https://example.atlassian.net/browse/PROJ-1', 'https://example.atlassian.net/browse/PROJ-3'])
  await mainHead.locator('.col-open').click()
  await expect.poll(opened).toEqual(['https://example.atlassian.net/browse/PROJ-1', 'https://example.atlassian.net/browse/PROJ-3', 'https://mail.example.com/thread/1'])
  await expect(frame.locator('#status')).toHaveText('')

  // The divider drags; the split is remembered for the next companion.
  const divider = frame.locator('.split > .divider')
  const db = (await divider.boundingBox())!
  await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2)
  await page.mouse.down()
  await page.mouse.move(db.x - 150, db.y + db.height / 2, { steps: 6 })
  await page.mouse.up()
  const narrowed = (await left.boundingBox())!.width
  expect(narrowed).toBeLessThan(lb.width - 100)
  const split = await frame.locator('.split').evaluate((e) => (e as HTMLElement).style.getPropertyValue('--split'))
  expect(parseFloat(split)).toBeLessThan(45)

  // A note on a selection in the companion: tagged with its title, highlighted there.
  await selectIn(issueDoc, 'wrong page')
  await expect(frame.locator('#add-note')).toBeVisible()
  await frame.locator('#add-note').click()
  await expect(frame.locator('.note')).toHaveCount(1)
  await expect(frame.locator('.note .doc-tag')).toHaveText('Jira · PROJ-1')
  await expect(frame.locator('.note .link')).toHaveText('«wrong page»')
  await frame.locator('.note-text').fill('Which page?')
  // And one in the mail, listed first, with no tag (out of the note first: typing hides "Add note").
  await frame.locator('.note-text').blur()
  await selectIn(mainDoc, 'second step')
  await frame.locator('#add-note').click()
  await expect(frame.locator('.note')).toHaveCount(2)
  await expect(frame.locator('.note').first().locator('.doc-tag')).toHaveCount(0)
  await expect(frame.locator('.note').first().locator('.link')).toHaveText('«second step»')
  await frame.locator('.note').first().locator('.note-text').fill('Not yet.')
  expect(await highlightedText(issueDoc, 'wrong page')).toBe(1)
  expect(await highlightedText(mainDoc, 'second step')).toBe(1)

  // Esc keeps the draft; reopening finds both notes again, each in its own document, at the same split.
  await pressEsc(cockpit)
  await expect.poll(async () => (await stack(cockpit)).length).toBe(0)
  await annotate()
  await expect(frame.locator('.note')).toHaveCount(2)
  await expect(frame.locator('.note').nth(1).locator('.note-text')).toHaveValue('Which page?')
  await expect.poll(() => highlightedText(issueDoc, 'wrong page')).toBe(1)
  await expect.poll(() => highlightedText(mainDoc, 'second step')).toBe(1)
  await expect(frame.locator('.note .outdated')).toHaveCount(0)
  expect(Math.abs((await left.boundingBox())!.width - narrowed)).toBeLessThan(4)

  // Narrow: stacked, each header above its own document, the companion under the main one, no divider.
  await page.locator(`iframe[title="${TITLE2}"]`).evaluate((f) => ((f as HTMLElement).style.width = '600px'))
  await expect(divider).toBeHidden()
  const below = async (a: Locator, b: Locator): Promise<boolean> => {
    const x = (await a.boundingBox())!
    return (await b.boundingBox())!.y >= x.y + x.height - 1
  }
  await expect.poll(() => below(mainHead, left)).toBe(true)
  await expect.poll(() => below(left, issueHead)).toBe(true)
  await expect.poll(() => below(issueHead, right)).toBe(true)
})

// design-next §3.3: a review of the well-known `file` type shows the bundled editor's "Edit" in the
// toolbar (the page has no Edit of its own any more); a click opens micro on top and the review
// stays under it. `micro` is the stand-in of test/fixtures/bin. Discuss is there too (a typed overlay).
test('a file review gets the editor\'s Edit button; a click opens micro over it and the review stays', async ({ cockpit }) => {
  const { page, projectDir } = cockpit
  writeFileSync(join(projectDir, 'notes.txt'), 'one\ntwo\n')
  const { run } = await linkCaller(cockpit)
  expect(await run('filetype')).toEqual({ ok: true, value: { opened: true } })
  const TITLE3 = 'Notes: A file review'
  await expect.poll(async () => (await stack(cockpit)).map((o) => o.title), { timeout: 15_000 }).toEqual([TITLE3])

  const toolbar = page.locator('.overlay-header').first()
  await expect(toolbar.locator('[data-source="type"]')).toHaveText(['Edit'], { timeout: 15_000 })
  await expect(toolbar.locator('.overlay-discuss')).toHaveCount(1)
  await toolbar.getByRole('button', { name: 'Edit' }).click()

  await expect.poll(async () => (await stack(cockpit)).map((o) => o.title), { timeout: 15_000 }).toEqual([TITLE3, 'Edit: notes.txt'])
  const terminal = page.locator('.overlay[data-kind="terminal"]')
  await expect(terminal.locator('.xterm-rows')).toContainText('FAKE-MICRO', { timeout: 15_000 })
  await expect(terminal.locator('.xterm-rows')).toContainText('notes.txt')

  // Closing micro leaves the review.
  await terminal.getByRole('button', { name: 'Close overlay' }).click()
  await expect.poll(async () => (await stack(cockpit)).map((o) => o.title)).toEqual([TITLE3])
})
