// Page tabs as split panes (docs/design-split-pages.md §2, §3; plan Task 2): a file pane beside a
// Claude pane, its frame placed at the pane's body box below the shell's header, and the page alive
// through every group change (a frame is never moved in the DOM, only placed); two visible frames
// keep their pages through a plugin host restart (a new port each, no reload). The shell decides
// which frame has the keys (§4, plan Task 3): a frame that takes the keyboard by itself is blurred,
// the pointer going into one picks its pane, keys off reach no frame, and `ccc edit` keeps the keys.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Frame, Page } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { domFocusInTerminal, focusedPanes, groupFor, invoke, paneOf, paneText, place, roomyDesktop, tabsOf, visiblePanes, waitPaneText } from './split-fixtures'

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

/** Whether the shell's keyboard is in a page tab's frame (its active element is one). */
const keysInFrame = (page: Page): Promise<boolean> => page.evaluate(() => document.activeElement?.classList.contains('page-tab-frame') === true)

/** `ccc edit <arg>` from the Claude pane (the fake runs `/ccc ...` lines); the file opens unselected, unmounted. */
async function cccEditFromClaude(c: Cockpit, claude: string, arg: string): Promise<void> {
  const before = (await paneText(paneOf(c.page, claude))).split('FAKE-CLAUDE ccc exit=0').length
  await c.page.keyboard.type(`/ccc edit ${arg}`)
  await c.page.keyboard.press('Enter')
  await expect.poll(async () => (await paneText(paneOf(c.page, claude))).replaceAll('\n', '').split('FAKE-CLAUDE ccc exit=0').length, { timeout: 15_000 }).toBeGreaterThan(before)
}

test('the shell decides which frame has the keys: a frame focusing itself beside Claude is blurred, a click into it picks its pane, keys off reach no frame', async () => {
  test.setTimeout(90_000)
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  try {
    const { page, projectDir } = c
    await roomyDesktop(c)
    writeFileSync(join(projectDir, 'notes.txt'), 'one\ntwo\nthree\nfour line\nfive\n')
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    const claude = (await tabsOf(page)).find((t) => t.kind === 'claude')!.id
    await pluginActive(c, 'cockpit.editor')
    await paneOf(page, claude).locator('.xterm').click()

    // `ccc edit` from the Claude pane: the tab opens unselected, nothing mounted yet.
    await cccEditFromClaude(c, claude, 'notes.txt')
    await expect.poll(async () => (await tabsOf(page)).some((t) => t.kind === 'page' && t.page?.title === 'notes.txt')).toBe(true)
    const file = (await tabsOf(page)).find((t) => t.kind === 'page' && t.page?.title === 'notes.txt')!.id
    await expect(page.locator('iframe.page-tab-frame')).toHaveCount(0)

    // Unprompted focus: the file pane mounts beside Claude (Show Tab Beside's placement) while the
    // person types in Claude. Every key lands in Claude; the frame never keeps the keyboard.
    expect(await domFocusInTerminal(page)).toBe(true)
    expect((await place(page, file, claude, 'right')).ok).toBe(true)
    await page.keyboard.type('abc')
    const editor = await pageIn(page, 'notes.txt')
    await expect(editor.locator('.cm-content')).toContainText('five')
    await page.keyboard.type('def')
    await page.keyboard.press('Enter')
    await waitPaneText(paneOf(page, claude), 'FAKE-CLAUDE echo: abcdef')
    await expect(focusedPanes(page)).toHaveAttribute('data-focused-pane', claude)

    // The page takes the keyboard by itself (a script's focus(), no click in it) while the pointer
    // rests over the file pane and the person types in Claude: the shell blurs the frame, and with the
    // pointer over the file (it could have been a click) the keys go to nothing, never to Claude.
    const fileHeader = paneOf(page, file).locator('[data-pane-header]')
    await fileHeader.hover()
    await page.keyboard.type('g')
    await editor.evaluate(() => (document.querySelector('.cm-content') as HTMLElement).focus())
    await expect.poll(() => keysInFrame(page)).toBe(false)
    expect(await domFocusInTerminal(page)).toBe(false)
    await page.keyboard.type('xx')
    // A click on the Claude pane gives it the keys again.
    await paneOf(page, claude).locator('.xterm').click()
    await expect.poll(() => domFocusInTerminal(page)).toBe(true)
    await page.keyboard.type('hi')
    await page.keyboard.press('Enter')
    await waitPaneText(paneOf(page, claude), 'FAKE-CLAUDE echo: ghi')
    await expect(focusedPanes(page)).toHaveAttribute('data-focused-pane', claude)
    await expect(editor.locator('.cm-content')).not.toContainText(/abc|def|hi|xx/)

    // `ccc edit` of the visible file from the Claude pane: the file moves to the line, the keys stay.
    await cccEditFromClaude(c, claude, 'notes.txt:4')
    await expect(editor.locator('.cm-activeLine')).toContainText('four line')
    expect(await keysInFrame(page)).toBe(false)
    await page.keyboard.type('jkl')
    await page.keyboard.press('Enter')
    await waitPaneText(paneOf(page, claude), 'FAKE-CLAUDE echo: jkl')
    await expect(editor.locator('.cm-content')).not.toContainText('jkl')

    // The person clicks into the file, coming in over its pane header: the pointer went into its
    // frame (the shell's last pointer position is at its edge), so the shell picks its pane.
    await fileHeader.hover()
    await editor.locator('.cm-line', { hasText: 'two' }).click()
    await expect(focusedPanes(page)).toHaveAttribute('data-focused-pane', file)
    await page.keyboard.type('Q')
    await expect(editor.locator('.cm-content')).toContainText('Q')

    // The review's MAJOR: typing in Claude with the pointer resting over the file, then a click into
    // it without moving. The shell has no evidence (the pointer came in with no shell event, a key
    // came after it), so the frame is blurred and the keys go to NOTHING: not one key reaches Claude.
    // The next click on the file, still without moving, reaches the shell's pane (the blurred frame
    // lets the pointer through) and picks it.
    await paneOf(page, claude).locator('.xterm').click()
    await expect.poll(() => domFocusInTerminal(page)).toBe(true)
    const line = await editor.locator('.cm-line', { hasText: 'three' }).boundingBox()
    if (!line) throw new Error('no line box')
    // One step from the Claude pane straight into the frame: the shell sees no move over the file.
    await page.mouse.move(line.x + 10, line.y + line.height / 2)
    await page.keyboard.type('m')
    await page.waitForTimeout(800)
    await page.mouse.down()
    await page.mouse.up()
    await expect.poll(() => keysInFrame(page)).toBe(false)
    expect(await domFocusInTerminal(page)).toBe(false)
    await expect(focusedPanes(page)).toHaveAttribute('data-focused-pane', claude)
    await page.keyboard.type('yn')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)
    await page.mouse.down()
    await page.mouse.up()
    await expect(focusedPanes(page)).toHaveAttribute('data-focused-pane', file)
    await expect.poll(() => keysInFrame(page)).toBe(true)
    await page.keyboard.type('P')
    await expect(editor.locator('.cm-content')).toContainText('P')
    await expect(editor.locator('.cm-content')).not.toContainText(/yn|m/)
    // Claude got only the 'm' typed while its pane had the keys: nothing after the click.
    await paneOf(page, claude).locator('.xterm').click()
    await expect.poll(() => domFocusInTerminal(page)).toBe(true)
    await page.keyboard.press('Enter')
    await waitPaneText(paneOf(page, claude), 'FAKE-CLAUDE echo: m')
    expect(await paneText(paneOf(page, claude))).not.toMatch(/FAKE-CLAUDE echo: m?yn/)
    // Back to the file for the keys-off case below (the person clicks its pane header).
    await fileHeader.click()
    await expect(focusedPanes(page)).toHaveAttribute('data-focused-pane', file)

    // Keys off on a page pane: a change from elsewhere moves the focused file out (a raw
    // `groups.remove`, no intent of this view). The frame is blurred and no key reaches any frame or
    // terminal until the person picks a tab.
    expect((await invoke<{ ok: boolean }>(page, 'groups.remove', { tabId: file })).ok).toBe(true)
    await expect.poll(async () => (await groupFor(page, file)) === undefined).toBe(true)
    await expect.poll(() => keysInFrame(page)).toBe(false)
    expect(await domFocusInTerminal(page)).toBe(false)
    await page.keyboard.type('zz')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(700)
    await expect(editor.locator('.cm-content')).not.toContainText('zz')
    await page.getByRole('tab', { name: /notes\.txt/ }).click()
    await expect.poll(() => keysInFrame(page)).toBe(true)
    await page.keyboard.type('R')
    await expect(editor.locator('.cm-content')).toContainText('R')
    expect(await paneText(paneOf(page, claude))).not.toContain('FAKE-CLAUDE echo: zz')
  } finally {
    await close()
  }
})

test('unprompted focus at a relaunch: the restored group mounts the file pane while the person types in Claude, and every key lands in Claude', async () => {
  test.setTimeout(120_000)
  const first = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  const root = first.cockpit.root
  try {
    const c = first.cockpit
    await roomyDesktop(c)
    writeFileSync(join(c.projectDir, 'notes.txt'), 'one\ntwo\n')
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    const claude = (await tabsOf(c.page)).find((t) => t.kind === 'claude')!.id
    await pluginActive(c, 'cockpit.editor')
    await paneOf(c.page, claude).locator('.xterm').click()
    await cccEditFromClaude(c, claude, 'notes.txt')
    await expect.poll(async () => (await tabsOf(c.page)).some((t) => t.kind === 'page')).toBe(true)
    const file = (await tabsOf(c.page)).find((t) => t.kind === 'page')!.id
    expect((await place(c.page, file, claude, 'right')).ok).toBe(true)
    await expect(visiblePanes(c.page)).toHaveCount(2)
    await expect(focusedPanes(c.page)).toHaveAttribute('data-focused-pane', claude)
  } finally {
    await first.close({ keepFiles: true })
  }

  const second = await launchCockpit({ root, folderArg: false, env: { CC_COCKPIT_NO_BUNDLED: '' } })
  try {
    const { page } = second.cockpit
    await expect(visiblePanes(page)).toHaveCount(2, { timeout: 15_000 })
    const claude = (await tabsOf(page)).find((t) => t.kind === 'claude')!.id
    await expect.poll(() => domFocusInTerminal(page), { timeout: 15_000 }).toBe(true)
    // Typing while the file's page loads beside it: a key every 50 ms until the editor is there.
    let typed = ''
    const content = page.frameLocator('iframe.page-tab-frame').locator('.cm-content')
    for (let i = 0; i < 300 && !(await content.isVisible().catch(() => false)); i++) {
      await page.keyboard.type('x')
      typed += 'x'
      await page.waitForTimeout(50)
    }
    await expect(content).toContainText('two', { timeout: 15_000 })
    await page.keyboard.type('end')
    typed += 'end'
    await page.keyboard.press('Enter')
    await waitPaneText(paneOf(page, claude), `FAKE-CLAUDE echo: ${typed}`, 15_000)
    expect(await keysInFrame(page)).toBe(false)
    await expect(content).not.toContainText('xend')
    await expect(focusedPanes(page)).toHaveAttribute('data-focused-pane', claude)
  } finally {
    await second.close()
  }
})
