// Page tabs as split panes (docs/design-split-pages.md §2, §3; plan Task 2): a file pane beside a
// Claude pane, its frame placed at the pane's body box below the shell's header, and the page alive
// through every group change (a frame is never moved in the DOM, only placed); two visible frames
// keep their pages through a plugin host restart (a new port each, no reload).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Frame, Page } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { groupFor, invoke, paneOf, place, roomyDesktop, tabsOf, visiblePanes } from './split-fixtures'

async function pluginActive(c: Cockpit, id: string): Promise<void> {
  await expect
    .poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.find((p) => p.id === id)?.state, { timeout: 15_000 })
    .toBe('active')
}

/** The Files panel's Edit button for `name` (as editor.spec.ts does). */
async function editFromFiles(c: Cockpit, name: string): Promise<void> {
  await pluginActive(c, 'cockpit.files')
  const section = c.page.locator('section.panel[aria-label="Files"]')
  if (!(await section.isVisible())) await c.page.locator('.zone-left').getByRole('button', { name: /^Files/ }).click()
  const tree = c.page.frameLocator('section.panel[aria-label="Files"] iframe')
  const row = tree.locator('.row', { has: tree.locator('.name', { hasText: new RegExp(`^${name}$`) }) })
  await row.hover()
  await row.getByRole('button', { name: 'Edit' }).click()
}

/** The frame element of the page tab titled `title` (the iframe's title is the tab's). */
const frameEl = (page: Page, title: string) => page.locator(`iframe.page-tab-frame[title="${title}"]`)

/** The page inside that frame, once it has the editor. */
async function pageIn(page: Page, title: string): Promise<Frame> {
  const handle = await frameEl(page, title).elementHandle()
  const frame = await handle?.contentFrame()
  if (!frame) throw new Error(`no frame for ${title}`)
  await expect(frame.locator('.cm-content')).toBeVisible()
  return frame
}

/** A mark set in the page's own window: still there means the page never reloaded. */
async function mark(frame: Frame, value: string): Promise<void> {
  await frame.evaluate((v) => {
    ;(window as unknown as { __splitMark?: string }).__splitMark = v
  }, value)
}
const markOf = (frame: Frame): Promise<string | undefined> => frame.evaluate(() => (window as unknown as { __splitMark?: string }).__splitMark)

/** Opens `name` from the Files panel and returns its page tab's id once it is listed. */
async function openFile(c: Cockpit, name: string): Promise<string> {
  await editFromFiles(c, name)
  await expect(c.page.getByRole('tab', { name: new RegExp(name.replace('.', '\\.')) })).toHaveAttribute('aria-selected', 'true')
  await expect.poll(async () => (await tabsOf(c.page)).find((t) => t.kind === 'page' && t.page?.title === name)?.id).toBeTruthy()
  return (await tabsOf(c.page)).find((t) => t.kind === 'page' && t.page?.title === name)!.id
}

test('a file beside Claude: both visible, the frame inside its pane below the header, the page alive through Move out and Ungroup', async () => {
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  try {
    const { page, projectDir } = c
    await roomyDesktop(c)
    writeFileSync(join(projectDir, 'notes.txt'), 'one\ntwo\n')
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    const claude = (await tabsOf(page)).find((t) => t.kind === 'claude')!.id
    await pluginActive(c, 'cockpit.editor')
    const file = await openFile(c, 'notes.txt')
    const editor = await pageIn(page, 'notes.txt')
    await expect(editor.locator('.cm-content')).toContainText('two')
    await mark(editor, 'kept')

    // Placed right of the Claude pane: main takes a page tab as a pane now.
    expect((await place(page, file, claude, 'right')).ok).toBe(true)
    await expect(visiblePanes(page)).toHaveCount(2)
    await expect(frameEl(page, 'notes.txt')).toBeVisible()
    // The frame lies inside the right pane, below its header (the shell's, naming the plugin).
    const pane = paneOf(page, file)
    const header = pane.locator('[data-pane-header]')
    await expect(header).toContainText('notes.txt')
    await expect(header).toContainText('Opened by cockpit.editor')
    await expect
      .poll(async () => {
        const [f, p, h] = [await frameEl(page, 'notes.txt').boundingBox(), await pane.boundingBox(), await header.boundingBox()]
        if (!f || !p || !h) return false
        return f.x >= p.x && f.x + f.width <= p.x + p.width + 0.5 && f.y >= h.y + h.height - 0.5 && f.y + f.height <= p.y + p.height + 0.5
      })
      .toBe(true)
    // The Claude pane's terminal is still on screen, left of the frame.
    await expect(paneOf(page, claude).locator('.xterm')).toBeVisible()
    expect(await markOf(editor)).toBe('kept')

    // Move out: the file is a plain tab again, the same page.
    expect((await invoke<{ ok: boolean }>(page, 'groups.remove', { tabId: file })).ok).toBe(true)
    await expect.poll(async () => (await groupFor(page, file)) === undefined).toBe(true)
    await page.getByRole('tab', { name: /notes\.txt/ }).click()
    await expect(frameEl(page, 'notes.txt')).toBeVisible()
    expect(await markOf(editor)).toBe('kept')

    // Placed again and the group ungrouped: still the same page.
    expect((await place(page, file, claude, 'right')).ok).toBe(true)
    const group = await groupFor(page, file)
    if (!group) throw new Error('no group')
    await expect(visiblePanes(page)).toHaveCount(2)
    expect((await invoke<{ ok: boolean }>(page, 'groups.dissolve', { groupId: group.id })).ok).toBe(true)
    await expect.poll(async () => (await groupFor(page, file)) === undefined).toBe(true)
    await page.getByRole('tab', { name: /notes\.txt/ }).click()
    await expect(frameEl(page, 'notes.txt')).toBeVisible()
    expect(await markOf(editor)).toBe('kept')
    await expect(page.locator('iframe.page-tab-frame')).toHaveCount(1)
  } finally {
    await close()
  }
})

test('two visible file frames side by side keep their pages through a plugin host restart', async () => {
  test.setTimeout(90_000)
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  try {
    const { page, projectDir } = c
    await roomyDesktop(c)
    writeFileSync(join(projectDir, 'a.txt'), 'alpha\n')
    writeFileSync(join(projectDir, 'b.txt'), 'beta\n')
    await pluginActive(c, 'cockpit.editor')
    const a = await openFile(c, 'a.txt')
    const b = await openFile(c, 'b.txt')
    expect((await place(page, b, a, 'right')).ok).toBe(true)
    await expect(visiblePanes(page)).toHaveCount(2)
    await expect(frameEl(page, 'a.txt')).toBeVisible()
    await expect(frameEl(page, 'b.txt')).toBeVisible()
    const [fa, fb] = [await pageIn(page, 'a.txt'), await pageIn(page, 'b.txt')]
    await expect(fa.locator('.cm-content')).toContainText('alpha')
    await expect(fb.locator('.cm-content')).toContainText('beta')
    await mark(fa, 'a-kept')
    await mark(fb, 'b-kept')
    // Side by side, never overlapping.
    const [ba, bb] = [await frameEl(page, 'a.txt').boundingBox(), await frameEl(page, 'b.txt').boundingBox()]
    if (!ba || !bb) throw new Error('no frame boxes')
    expect(ba.x + ba.width).toBeLessThanOrEqual(bb.x)

    // The project's plugin host dies; main starts a new one (panels.reload): each frame takes a new
    // port with no reload.
    const hostPids = () =>
      c.app.evaluate(({ app }) =>
        app
          .getAppMetrics()
          .filter((m) => m.type === 'Utility' && (m.name ?? '').startsWith('cc-cockpit plugin host'))
          .map((m) => m.pid)
      )
    const [before] = await hostPids()
    if (before === undefined) throw new Error('no plugin host process')
    await c.app.evaluate((_, pid) => process.kill(pid, 'SIGKILL'), before)
    await expect.poll(async () => (await hostPids()).filter((p) => p !== before).length, { timeout: 15_000 }).toBe(1)
    await pluginActive(c, 'cockpit.editor')

    expect(await markOf(fa)).toBe('a-kept')
    expect(await markOf(fb)).toBe('b-kept')
    await expect(frameEl(page, 'a.txt')).toBeVisible()
    await expect(frameEl(page, 'b.txt')).toBeVisible()
    await expect(page.locator('iframe.page-tab-frame')).toHaveCount(2)
  } finally {
    await close()
  }
})
