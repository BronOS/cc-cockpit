// The reviewer's file views beyond text (plan 20261107-file-views-open-with): a markdown file opens
// rendered when it has no diff and on the diff when it has one, with a Rendered / Source switch; the
// rendered markdown goes through the page's sanitizer (raw HTML in it is text), and a note taken on
// the rendered text is kept beside the line notes. Files reach the reviewer the way a person clicks
// them: the fake claude edits them (`/edit`) and the Sessions panel lists them.
// Bundled plugins are on for this spec.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
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

/** The suite must not read the developer's git config (same shape as bundled-plugins.spec.ts). */
const git = (cwd: string, ...args: string[]): void => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  delete env.XDG_CONFIG_HOME
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore', env })
}

const stack = (c: Cockpit): Promise<OverlayInfo[]> => c.hook<OverlayInfo[]>('overlays', c.projectDir)

/** A native Esc, as a person types it: main sees it before the page (overlays.spec.ts). */
async function escape(cockpit: Cockpit): Promise<void> {
  await cockpit.app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  })
}

/** Starts a fake Claude tab that edits `files`, so the Sessions panel lists them; returns the panel. */
async function editedFiles(cockpit: Cockpit, files: string[]) {
  const { page, projectDir } = cockpit
  await expect
    .poll(async () => (await cockpit.hook<HostStatus>('hostStatus', projectDir)).plugins.some((p) => p.id === 'cockpit.reviewer' && p.state === 'active'), {
      timeout: 15_000
    })
    .toBe(true)
  await page.locator('.zone-left').getByRole('button', { name: /^Sessions/ }).click()
  const panel = page.frameLocator('section.panel[aria-label="Sessions"] iframe')
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  for (const f of files) await cockpit.typeLine(`/edit ${f}`)
  await expect(panel.locator('.file')).toHaveCount(files.length)
  return panel
}

test('markdown: rendered without a diff, the diff first with one, the switch both ways, notes of both kinds', async ({ cockpit }) => {
  const { page, projectDir } = cockpit
  const readme = join(projectDir, 'README.md')
  writeFileSync(readme, '# Title\n\nOld text.\n')
  git(projectDir, 'init', '-q')
  git(projectDir, 'add', '-A')
  git(projectDir, 'commit', '-q', '-m', 'first')
  writeFileSync(readme, '# Title\n\nNew text with a [link](https://example.com/d).\n\n<script>window.pwned = 1</script>\n\n- one\n- two\n')
  const fresh = join(projectDir, 'NOTES.md')
  writeFileSync(fresh, '## Fresh\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')
  const panel = await editedFiles(cockpit, [readme, fresh])

  // A new file has no diff worth reading: it opens rendered.
  await panel.getByRole('button', { name: fresh }).click()
  await expect.poll(async () => (await stack(cockpit)).map((o) => o.title), { timeout: 15_000 }).toEqual(['Review: NOTES.md'])
  const notes = page.frameLocator('iframe[title="Review: NOTES.md"]')
  await expect(notes.locator('.doc-body.markdown h2')).toHaveText('Fresh')
  await expect(notes.locator('.doc-body.markdown td').first()).toHaveText('1')
  await expect(notes.locator('#mdview')).toHaveText('Source')
  await escape(cockpit)
  await expect.poll(async () => (await stack(cockpit)).length).toBe(0)

  // A changed file opens on its diff (the editors), with the switch offering Rendered.
  await panel.getByRole('button', { name: readme }).click()
  await expect.poll(async () => (await stack(cockpit)).map((o) => o.title), { timeout: 15_000 }).toEqual(['Review: README.md'])
  const review = page.frameLocator('iframe[title="Review: README.md"]')
  await expect(review.locator('.cm-editor').first()).toBeVisible()
  await expect(review.locator('#mdview')).toHaveText('Rendered')
  await review.locator('#mdview').click()
  await expect(review.locator('.doc-body.markdown h1')).toHaveText('Title')
  await expect(review.locator('.doc-body.markdown li')).toHaveCount(2)
  await expect(review.locator('.doc-body.markdown a')).toHaveText('link')
  // Raw HTML in the markdown is shown as text and never runs.
  await expect(review.locator('.doc-body.markdown')).toContainText('<script>window.pwned = 1</script>')
  await expect(review.locator('.doc-body.markdown script')).toHaveCount(0)
  expect(await review.locator('body').evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined()

  // A note on the rendered text: select a word, press a.
  await review.locator('.doc-body.markdown p').first().evaluate((p) => {
    const text = p.firstChild!
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 8) // "New text"
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  })
  await review.locator('.doc-body.markdown').press('a')
  await expect(review.locator('#notes .note')).toHaveCount(1)
  await expect(review.locator('#notes .note').first()).toContainText('New text')
  // It names its source line, like a Source note (markdown.mjs data-md-lines).
  await expect(review.locator('#notes .note button.link').first()).toHaveText(/^Line 3 · «New text»$/)

  // Back to Source: the editors again, the text note still listed; its label switches back.
  await review.locator('#mdview').click()
  await expect(review.locator('.cm-editor').first()).toBeVisible()
  await expect(review.locator('#notes .note')).toHaveCount(1)
  await review.locator('#notes .note button.link').first().click()
  await expect(review.locator('.doc-body.markdown h1')).toBeVisible()
  await expect(review.locator('#mdview')).toHaveText('Source')
})

// A 2 × 1 PNG (red, transparent).
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAD0lEQVR4nGP4z8AARAwMAAz8Af9c/RSVAAAAAElFTkSuQmCC'

test('images: a png and an svg show as pictures, fitted, with their size; the svg runs nothing', async ({ cockpit }) => {
  const { page, projectDir } = cockpit
  const png = join(projectDir, 'dot.png')
  writeFileSync(png, Buffer.from(PNG, 'base64'))
  const svg = join(projectDir, 'logo.svg')
  writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><script>window.top.pwned = 1</script><rect width="40" height="20" fill="teal"/></svg>')
  const panel = await editedFiles(cockpit, [png, svg])

  await panel.getByRole('button', { name: png }).click()
  await expect.poll(async () => (await stack(cockpit)).map((o) => o.title), { timeout: 15_000 }).toEqual(['Image: dot.png'])
  const a = page.frameLocator('iframe[title="Image: dot.png"]')
  const img = a.locator('.preview img.preview-img')
  await expect(img).toBeVisible()
  expect(await img.evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight])).toEqual([2, 1])
  await expect(a.locator('#base')).toHaveText(/^2 × 1 · \d+ B$/)
  await expect(img).toHaveClass(/fit/)
  await img.click()
  await expect(img).not.toHaveClass(/fit/)
  await expect(a.locator('#mdview')).toBeHidden()
  await expect(a.locator('#layout')).toBeHidden()
  await escape(cockpit)
  await expect.poll(async () => (await stack(cockpit)).length).toBe(0)

  await panel.getByRole('button', { name: svg }).click()
  await expect.poll(async () => (await stack(cockpit)).map((o) => o.title), { timeout: 15_000 }).toEqual(['Image: logo.svg'])
  const b = page.frameLocator('iframe[title="Image: logo.svg"]')
  await expect(b.locator('#base')).toHaveText(/^40 × 20 · /)
  expect(await b.locator('body').evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined()
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined()
})

/** A small valid PDF: one page per text, Helvetica (not embedded: pdf.js falls back to a system font). */
function makePdf(pages: Array<string | string[]>): Buffer {
  const objs: string[] = []
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')
  objs.push('<< /Type /Catalog /Pages 2 0 R >>')
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`)
  const font = 3 + pages.length * 2
  pages.forEach((text, i) => {
    // One line per string, 30 pt apart (a string array is a page of several lines).
    const lines = Array.isArray(text) ? text : [text]
    const stream = `BT /F1 24 Tf 72 700 Td ${lines.map((l, j) => `${j ? '0 -30 Td ' : ''}(${l}) Tj`).join(' ')} ET`
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`)
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  })
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

test('pdf: pages drawn by pdf.js in the sandboxed page, selectable text, a page note; a broken PDF says why', async ({ cockpit }) => {
  const { page, projectDir } = cockpit
  const pdf = join(projectDir, 'spec.pdf')
  writeFileSync(pdf, makePdf(['Hello page one', 'Second page text']))
  const bad = join(projectDir, 'bad.pdf')
  writeFileSync(bad, 'not a pdf at all')
  const panel = await editedFiles(cockpit, [pdf, bad])

  await panel.getByRole('button', { name: pdf }).click()
  await expect.poll(async () => (await stack(cockpit)).map((o) => o.title), { timeout: 15_000 }).toEqual(['PDF: spec.pdf'])
  const v = page.frameLocator('iframe[title="PDF: spec.pdf"]')
  await expect(v.locator('#base')).toHaveText(/^2 pages · /, { timeout: 15_000 })
  await expect(v.locator('.pdf-page')).toHaveCount(2)
  await expect(v.locator('.pdf-page[data-page="1"] canvas')).toBeVisible()
  await expect(v.locator('.pdf-page[data-page="1"] .textLayer')).toContainText('Hello page one')
  // The canvas has ink on it (not a blank sheet).
  const inked = await v.locator('.pdf-page[data-page="1"] canvas').evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
    for (let i = 0; i < d.length; i += 4) if (d[i]! < 128 && d[i + 3]! > 0) return true
    return false
  })
  expect(inked).toBe(true)

  // Select the text of page 1 and press a: a page note with the quote.
  await v.locator('.pdf-page[data-page="1"] .textLayer').evaluate((layer) => {
    const span = [...layer.querySelectorAll('span')].find((s) => s.textContent?.includes('Hello'))!
    const range = document.createRange()
    range.selectNodeContents(span)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  })
  await v.locator('.preview').press('a')
  await expect(v.locator('#notes .note')).toHaveCount(1)
  await expect(v.locator('#notes .note button.link')).toHaveText('Page 1')
  await expect(v.locator('#notes .note .quote')).toHaveText('Hello page one')
  // Its text saves (a page note has no line range; the draft check once refused it).
  await v.locator('#notes .note textarea').fill('a page note')
  await v.locator('#global').fill('about the PDF')
  await expect(v.locator('#draft-error')).toBeHidden()
  await escape(cockpit)
  await expect.poll(async () => (await stack(cockpit)).length).toBe(0)

  await panel.getByRole('button', { name: bad }).click()
  await expect.poll(async () => (await stack(cockpit)).map((o) => o.title), { timeout: 15_000 }).toEqual(['PDF: bad.pdf'])
  await expect(page.frameLocator('iframe[title="PDF: bad.pdf"]').locator('.preview-error')).toContainText('not a valid PDF', { timeout: 15_000 })
})

test('html: rendered through the sanitizer (no script, no handler, nothing remote), Source shows the markup, notes work', async ({ cockpit }) => {
  const { page, projectDir } = cockpit
  const file = join(projectDir, 'page.html')
  writeFileSync(
    file,
    '<!doctype html><html><head><link rel="stylesheet" href="https://evil.example/x.css"><script>window.top.pwned=1</script></head>' +
      '<body><h1 onclick="window.pwned=2">Mock-up</h1><p>Some <b>bold</b> text and a <a href="https://example.com/x">link</a>.</p>' +
      '<img src="https://evil.example/t.png" alt="tracker"><iframe src="https://evil.example"></iframe></body></html>\n'
  )
  const panel = await editedFiles(cockpit, [file])
  await panel.getByRole('button', { name: file }).click()
  await expect.poll(async () => (await stack(cockpit)).map((o) => o.title), { timeout: 15_000 }).toEqual(['Review: page.html'])
  const v = page.frameLocator('iframe[title="Review: page.html"]')
  await expect(v.locator('#mdview')).toHaveText('Source')
  await expect(v.locator('.doc-body.markdown h1')).toHaveText('Mock-up')
  await expect(v.locator('.doc-body.markdown p').first()).toContainText('Some bold text and a link.')
  await expect(v.locator('.doc-body.markdown a')).toHaveText('link')
  await expect(v.locator('.doc-body.markdown script, .doc-body.markdown iframe, .doc-body.markdown link, .doc-body.markdown img[src]')).toHaveCount(0)
  await expect(v.locator('.doc-body.markdown h1')).not.toHaveAttribute('onclick')
  await v.locator('.doc-body.markdown h1').click()
  expect(await v.locator('body').evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined()
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined()
  await v.locator('#mdview').click()
  await expect(v.locator('.cm-content')).toContainText('<h1 onclick=')
})

test('pdf: a drag from the blank margin above a heading selects from the heading (no jump into the paragraph)', async ({ cockpit }) => {
  const { page, projectDir } = cockpit
  const lines = ['Section heading here', 'First line of the paragraph,', 'second line goes on,', 'third line continues,', 'The end of the paragraph.']
  const pdf = join(projectDir, 'long.pdf')
  writeFileSync(pdf, makePdf([lines]))
  const panel = await editedFiles(cockpit, [pdf])
  await panel.getByRole('button', { name: pdf }).click()
  const v = page.frameLocator('iframe[title="PDF: long.pdf"]')
  await expect(v.locator('#base')).toHaveText(/^1 page · /, { timeout: 15_000 })
  const layer = v.locator('.pdf-page[data-page="1"] .textLayer')
  await expect(layer).toContainText('The end of the paragraph.')
  const head = (await layer.locator('span', { hasText: 'Section heading' }).boundingBox())!
  const end = (await layer.locator('span', { hasText: 'The end of the paragraph' }).boundingBox())!
  const selected = async () => v.locator('body').evaluate(() => window.getSelection()!.toString().replace(/\s+/g, ' ').trim())
  for (const [from, to] of [
    [[head.x + 20, head.y - 25], [end.x + end.width - 1, end.y + end.height / 2]], // above the heading to the last letter
    [[head.x - 30, head.y + head.height / 2], [end.x + end.width + 40, end.y + end.height / 2]], // left margin to past the end
  ] as const) {
    await page.mouse.move(from[0], from[1])
    await page.mouse.down()
    await page.mouse.move(to[0], to[1], { steps: 15 })
    await page.mouse.up()
    expect(await selected()).toMatch(/^Section heading here First line .* The end of the paragraph\.?$/)
  }
  // A double click still selects a word (native).
  await layer.locator('span', { hasText: 'second line' }).dblclick({ position: { x: 5, y: 5 } })
  expect(await selected()).toBe('second')
})
