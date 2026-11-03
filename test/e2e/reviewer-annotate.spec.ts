// The bundled reviewer's annotate() in HTML mode, end to end: a fixture plugin (annotate-caller)
// hands it markup with a script, an onerror handler, a style block and attribute, a javascript:
// link, an iframe, a form and a remote image next to the content it must keep, plus one image as
// an asset. The overlay page parses it inertly and rebuilds it from an allow-list
// (plugins/reviewer/src/page/sanitize.mjs); this checks the DOM it ended up with in the real
// Chromium parser, that the asset image loads, that a link does not navigate, and that a note on a
// selection is highlighted again when the draft reopens. Bundled plugins are on for this spec.
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
  const doc = frame.locator('.doc-body')
  await expect(doc).toContainText('Users land on')
  await expect(frame.locator('#base')).toHaveText('https://example.atlassian.net/browse/PROJ-1')

  // Dropped with their content: script, style, iframe, form and its input.
  for (const sel of ['script', 'style', 'iframe', 'form', 'input']) await expect(doc.locator(sel)).toHaveCount(0)
  await expect(doc).not.toContainText('__pwned')
  await expect(doc).not.toContainText('display: none')
  // No event handler, style or id attribute anywhere; classes off the allow-list are gone.
  const attrs = await doc.evaluate((root) =>
    [...root.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => a.name)).filter((n) => n.startsWith('on') || n === 'style' || n === 'id' || n === 'target')
  )
  expect(attrs).toEqual([])
  await expect(doc.locator('h2')).toHaveText('Fix the login redirect')
  await expect(doc.locator('div.jira-panel')).toHaveAttribute('class', 'jira-panel jira-panel-warning')
  await expect(doc.locator('span.mention')).toHaveText('@Ann Lee')
  await expect(doc.locator('td')).toHaveAttribute('colspan', '2')
  // The javascript: link keeps its text but no href; the https one keeps its href.
  const links = doc.locator('a')
  await expect(links).toHaveCount(2)
  expect(await links.nth(0).getAttribute('href')).toBeNull()
  await expect(links.nth(1)).toHaveAttribute('href', 'https://example.atlassian.net/browse/PROJ-1')
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

  // A link click stays in the page and says where it goes.
  await links.nth(1).click()
  await expect(frame.locator('#status')).toHaveText('Link (not opened from here): https://example.atlassian.net/browse/PROJ-1')
  await expect(doc).toContainText('Users land on')
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
  await select('redirect target')
  await expect(frame.locator('#add-note')).toBeEnabled()
  await frame.locator('#add-note').click()
  await expect(frame.locator('.note')).toHaveCount(1)
  await expect(frame.locator('.note-head button').first()).toHaveText('«redirect target»')
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
  await expect(frame.locator('.note-head button').first()).toHaveText('«redirect target»')
  await expect.poll(highlighted).toBe(1)
})
