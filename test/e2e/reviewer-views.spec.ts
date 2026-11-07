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
