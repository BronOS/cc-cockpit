// Guests through the real UI (design-guests §5-§10, §14; task 07b, acceptance item 2): a read guest in a plain
// browser sees the shared tabs live and the plugins shown to guests, cannot type, cannot use a plugin that
// does not check who is looking (one-way port, D-17), and never receives the Gmail-like plugin hidden from
// guests: not its panel, not its marker in any frame, not its page by a guessed address. The hand test
// (spec-review item 29: the only spec that drives 05's dialog): the owner invites from Share, switches the
// guest to write (it types into Claude and saves a file from the shell), then kicks it.
import { existsSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { CockpitApi } from '../../src/shared/ipc'
import { filesTree, pluginActive, treeRow } from './download-fixtures'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { guestList, inviteGuest } from './guest-fixtures'
import { enableWebAccess, openBrowser, type WebAccessOn, type WebBrowser } from './web-fixtures'

const FIXTURES = join(__dirname, '..', 'fixtures', 'plugins')
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
/** test/fixtures/plugins/guest-mail/marker.js's MARKER (checked against the file below). */
const MARKER = 'CCC-GUEST-MAIL-MARKER-5b1e'

async function invoke<T>(c: Cockpit, channel: string, payload?: unknown): Promise<T> {
  return c.page.evaluate(
    async ([ch, p]) => ((window as unknown as { cockpit: CockpitApi }).cockpit.invoke as unknown as (c: string, q?: unknown) => Promise<unknown>)(ch, p),
    [channel, payload] as const
  ) as Promise<T>
}

/** The host: Files (bundled), the three guest fixtures, Files, Board and Counter shown to guests, Inbox hidden. */
async function host(c: Cockpit): Promise<WebAccessOn> {
  for (const [dir, id] of [['guest-team', 'test.guestteam'], ['guest-plain', 'test.guestplain'], ['guest-mail', 'test.guestmail']] as const) {
    await c.hook('linkPlugin', join(FIXTURES, dir))
    await c.hook('enablePlugin', c.projectDir, id)
  }
  await pluginActive(c, 'test.guestmail')
  await pluginActive(c, 'cockpit.files')
  const web = await enableWebAccess(c)
  for (const pluginId of ['cockpit.files', 'test.guestteam', 'test.guestplain']) {
    await invoke(c, 'settings.pluginGuestAccessSet', { pluginId, target: 'app', value: 'shown' })
  }
  return web
}

/** Every text frame the page's sockets receive, from now on. */
function recordFrames(page: Page): string[] {
  const frames: string[] = []
  page.on('websocket', (ws) => ws.on('framereceived', (f) => frames.push(String(f.payload))))
  return frames
}

/** Opens a panel from the left zone's strip and returns its frame. */
async function panel(page: Page, title: string) {
  const section = page.locator(`section.panel[aria-label="${title}"]`)
  if (!(await section.isVisible())) await page.locator('.zone-left').getByRole('button', { name: new RegExp(`^${title}`) }).click()
  await expect(section).toBeVisible()
  return page.frameLocator(`section.panel[aria-label="${title}"] iframe`)
}

test('a read guest: shared tab live, shown plugins only, no typing, a plugin that does not check gets no clicks, the hidden plugin never arrives', async () => {
  test.setTimeout(150_000)
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  let guest: WebBrowser | undefined
  try {
    await c.newTab('shell')
    await c.waitForTerminalText('FAKE-SHELL ready')
    const web = await host(c)
    const invited = await inviteGuest(c, { name: 'Rae' })
    guest = await openBrowser(invited.link)
    const frames = recordFrames(guest.page)
    const { page } = guest
    await expect(page).toHaveURL(`${web.origin}/?project=${encodeURIComponent(web.projectId)}`, { timeout: 20_000 })
    await expect(page.getByTestId('guest-banner')).toContainText("Guest · read-only — Host's cc-cockpit")

    // The shared shell, live.
    await guest.waitForTerminalText('FAKE-SHELL ready')
    await c.typeLine('echo live-from-host')
    await guest.waitForTerminalText('live-from-host')
    // Read-only: keys never reach the terminal.
    await page.locator('.terminal-view:not([hidden])').click()
    await page.keyboard.type('echo typed-by-read-guest\n')
    await page.waitForTimeout(1500)
    expect(await c.terminalText()).not.toContain('typed-by-read-guest')

    // Only the plugins shown to guests: Files, Board, Counter; never Inbox.
    const strip = page.locator('.zone-left, .zone-right, .zone-bottom').getByRole('button')
    await expect(page.locator('.zone-left').getByRole('button', { name: /^Board/ })).toBeVisible()
    expect((await strip.allInnerTexts()).join(' ')).not.toContain('Inbox')
    expect(await page.getByRole('button', { name: /Inbox/ }).count()).toBe(0)

    // The guest-aware Team stand-in answers by main's tag: the guest view, and a read guest's add refused.
    const board = await panel(page, 'Board')
    await expect(board.locator('#who')).toHaveText('guest view (read)')
    await board.locator('#text').fill('from Rae')
    await board.locator('#add').click()
    await expect(board.locator('#refused')).toHaveText('refused: from Rae')

    // The plugin that checks nobody: a read guest's click never reaches it (one-way port); the owner's does,
    // and the guest sees the result.
    const guestCounter = await panel(page, 'Counter')
    await guestCounter.locator('#bump').click()
    const ownerCounter = await panel(c.page, 'Counter')
    await expect(ownerCounter.locator('#count')).toHaveText('count 0')
    await ownerCounter.locator('#bump').click()
    await expect(ownerCounter.locator('#count')).toHaveText('count 1')
    await expect(guestCounter.locator('#count')).toHaveText('count 1')
    await guestCounter.locator('#bump').click()
    await page.waitForTimeout(1000)
    await expect(ownerCounter.locator('#count')).toHaveText('count 1')

    // The hidden Gmail-like plugin: the owner reads its inbox (the marker on the owner's screen, in a notice too).
    const inbox = c.page.locator('section.panel[aria-label="Inbox"]')
    if (!(await inbox.isVisible())) await c.page.locator('.zone-right').getByRole('button', { name: /^Inbox/ }).click()
    await expect(c.page.frameLocator('section.panel[aria-label="Inbox"] iframe').locator('#subject')).toContainText(MARKER)
    await page.waitForTimeout(1500)
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.filter((f) => f.includes(MARKER))).toEqual([])
    expect(frames.filter((f) => f.includes('test.guestmail'))).toEqual([])
    expect(await page.content()).not.toContain(MARKER)
    // Its page by a guessed address under the guest's own Board token: as a plugin that does not exist.
    const ready = JSON.parse(frames.find((f) => f.includes('"t":"ready"')) ?? '{}') as { paths?: { plugins: Record<string, string> } }
    const boardPath = ready.paths?.plugins['test.guestteam'] ?? ''
    expect(boardPath).toMatch(/^\/p\/[^/]+\/test\.guestteam\/$/)
    expect(Object.keys(ready.paths?.plugins ?? {}).sort()).toEqual(['cockpit.files', 'test.guestplain', 'test.guestteam'])
    const token = boardPath.split('/')[2]
    const fetched = await page.evaluate(async (paths) => {
      const out = []
      for (const p of paths) {
        const res = await fetch(p, { cache: 'no-store' })
        out.push({ status: res.status, type: res.headers.get('content-type'), body: await res.text() })
      }
      return out
    }, [`/p/${token}/test.guestmail/panel.html`, `/p/${token}/test.nosuchplugin/panel.html`])
    expect(fetched[0]!.status).toBe(404)
    expect(fetched[0]).toEqual(fetched[1])
    expect(readFileSync(join(FIXTURES, 'guest-mail', 'marker.js'), 'utf8')).toContain(MARKER)

    // The owner's chip says a guest is here (guests.changed).
    await expect(c.page.locator('.guest-chip')).toContainText('Live')

    // A kick kills the guest's page tokens with its device: the Board page it loaded a moment ago is a 404 now.
    const boardPage = `/p/${token}/test.guestteam/panel.html`
    const statusOf = (p: string): Promise<number> => page.evaluate(async (u) => (await fetch(u, { cache: 'no-store' })).status, p)
    expect(await statusOf(boardPage)).toBe(200)
    expect(await c.hook<boolean>('guestKick', invited.guestId)).toBe(true)
    await expect(page.getByText('Host removed you.')).toBeVisible({ timeout: 1500 })
    expect(await statusOf(boardPage)).toBe(404)
  } finally {
    await guest?.close()
    await close()
  }
})

test('hand test: Share invites a read guest, the owner switches it to write (types into Claude, saves a file), then kicks it', async () => {
  test.setTimeout(180_000)
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  let guest: WebBrowser | undefined
  try {
    await c.newTab('shell')
    await c.waitForTerminalText('FAKE-SHELL ready')
    await c.newTab('claude')
    const web = await host(c)

    // The invite dialog: name, read-only, all tabs, one day; Create invite shows the link (the desktop page asks
    // nothing more; a server-mode browser gets an armed confirm first).
    await c.page.getByRole('button', { name: 'Share' }).click()
    const dialog = c.page.getByTestId('guest-invite-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('textbox').first().fill('Ola')
    await dialog.getByRole('radio', { name: 'Read-only' }).check()
    await dialog.getByRole('button', { name: 'Create invite' }).click()
    const link = (await dialog.getByTestId('guest-invite-link').innerText()).trim()
    expect(link.startsWith(`${web.origin}/#i=`)).toBe(true)
    await dialog.getByRole('button', { name: 'Done' }).click()

    guest = await openBrowser(link)
    const { page } = guest
    await expect(page.getByTestId('guest-banner')).toContainText('read-only', { timeout: 20_000 })
    const row = (await guestList(c)).find((g) => g.name === 'Ola')
    expect(row?.role).toBe('read')

    // Switch to write from the guest list: armed confirm, then the guest's page comes back as write.
    await c.page.locator('.guest-chip').click()
    await c.page.getByRole('radiogroup', { name: "Ola's role" }).getByRole('radio', { name: 'Write' }).click()
    const upgrade = c.page.getByTestId('guest-upgrade-confirm')
    await expect(upgrade.getByRole('button', { name: 'Allow write' })).toBeEnabled({ timeout: 5000 })
    await upgrade.getByRole('button', { name: 'Allow write' }).click()
    await expect(page.getByTestId('guest-banner')).toHaveAttribute('data-role', 'write', { timeout: 15_000 })

    // Types into Claude (the fake echoes every line it gets).
    await page.getByRole('tab', { name: /Claude/ }).click()
    await page.locator('.terminal-view:not([hidden])').click()
    await page.keyboard.type('hello from Ola\n')
    await c.page.getByRole('tab', { name: /Claude/ }).click()
    await c.waitForTerminalText('hello from Ola')

    // Saves a file: from the shared shell, as the person it runs as.
    await page.getByRole('tab', { name: /Shell/ }).click()
    await page.locator('.terminal-view:not([hidden])').click()
    await page.keyboard.type('echo saved-by-ola > ola.txt\n')
    await expect.poll(() => existsSync(join(c.projectDir, 'ola.txt')), { timeout: 10_000 }).toBe(true)
    expect(readFileSync(join(c.projectDir, 'ola.txt'), 'utf8')).toBe('saved-by-ola\n')

    // Kick: the guest's page says so and its terminals are cleared; the guest is gone from the list.
    const list = c.page.getByRole('dialog', { name: 'Guests' })
    if (!(await list.isVisible())) await c.page.locator('.guest-chip').click()
    await list.getByRole('button', { name: 'Kick' }).click()
    await expect(page.getByText('Host removed you.')).toBeVisible({ timeout: 1500 })
    await expect(page.locator('.xterm-rows')).toHaveCount(0)
    await expect.poll(async () => (await guestList(c)).length).toBe(0)
  } finally {
    await guest?.close()
    await close()
  }
})

test('a write guest saves through the editor, and a kick cuts its running download', async () => {
  test.setTimeout(150_000)
  const { cockpit: c, close } = await launchCockpit({
    env: { CC_COCKPIT_NO_BUNDLED: '' },
    // Save is the guest's own Cmd/Ctrl+S, never an autosave.
    settings: { pluginSettings: { 'cockpit.editor': { autosaveIdleSeconds: 0, autosaveOnBlur: false } } }
  })
  let guest: WebBrowser | undefined
  try {
    const notes = join(c.projectDir, 'notes.txt')
    writeFileSync(notes, 'alpha\nbeta\n')
    // Big enough that the stream is still running when the kick lands (the page reads one chunk, then waits).
    const SIZE = 1024 * 1024 * 1024
    writeFileSync(join(c.projectDir, 'big.bin'), '')
    truncateSync(join(c.projectDir, 'big.bin'), SIZE)
    await pluginActive(c, 'cockpit.files')
    await pluginActive(c, 'cockpit.editor')
    await enableWebAccess(c)
    for (const pluginId of ['cockpit.files', 'cockpit.editor']) {
      await invoke(c, 'settings.pluginGuestAccessSet', { pluginId, target: 'app', value: 'shown' })
    }
    const invited = await inviteGuest(c, { name: 'Wes', role: 'write' })
    guest = await openBrowser(invited.link)
    const { page } = guest
    await expect(page.getByTestId('guest-banner')).toHaveAttribute('data-role', 'write', { timeout: 20_000 })

    // Saves a file: opened from Files into the editor, typed, Cmd/Ctrl+S; on disk.
    const tree = await filesTree(page)
    const row = treeRow(tree, 'notes.txt')
    await row.hover()
    await row.getByRole('button', { name: 'Edit' }).click()
    const editor = page.frameLocator('iframe.page-tab-frame:not([hidden])')
    await expect(editor.locator('.cm-content')).toContainText('beta', { timeout: 15_000 })
    await editor.locator('.cm-content').click()
    await page.keyboard.press(`${MOD}+Home`)
    await page.keyboard.type('by Wes ')
    await expect(editor.locator('#state')).toHaveText('Unsaved')
    await page.keyboard.press(`${MOD}+s`)
    await expect.poll(() => readFileSync(notes, 'utf8'), { timeout: 20_000 }).toBe('by Wes alpha\nbeta\n')

    // A running download: Files' Download, caught in the guest browser's session before it is sent, then
    // fetched by the page, which reads one chunk and holds the rest.
    await guest.app.evaluate(({ session }) => {
      const g = globalThis as unknown as { capturedDownloads: string[] }
      g.capturedDownloads = []
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/d/*'] }, (details, callback) => {
        g.capturedDownloads.push(details.url)
        callback({ cancel: true })
      })
    })
    await treeRow(tree, 'big.bin').click({ button: 'right' })
    await tree.getByRole('menu').getByRole('menuitem', { name: 'Download', exact: true }).click()
    await expect.poll(() => guest!.app.evaluate(() => (globalThis as unknown as { capturedDownloads: string[] }).capturedDownloads.length)).toBe(1)
    const url = await guest.app.evaluate(({ session }) => {
      session.defaultSession.webRequest.onBeforeRequest(null)
      return (globalThis as unknown as { capturedDownloads: string[] }).capturedDownloads[0]!
    })
    // Read in the page, a pause after each chunk, state on window. Without a kick this read is still running 5 s
    // later (checked by hand: about 40 MB/s here, so the sparse 1 GiB file takes far longer).
    await page.evaluate((u) => {
      const dl = { status: 0, total: 0, state: 'running', error: '' }
      ;(window as unknown as { dl: typeof dl }).dl = dl
      void (async () => {
        const res = await fetch(u, { credentials: 'same-origin', cache: 'no-store' })
        dl.status = res.status
        const reader = res.body!.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) {
            dl.state = 'done'
            return
          }
          dl.total += value.length
          await new Promise((r) => setTimeout(r, 50))
        }
      })().catch((err: unknown) => {
        dl.state = 'error'
        dl.error = String(err)
      })
    }, url)
    type Dl = { status: number; total: number; state: string; error: string }
    const dl = (): Promise<Dl> => page.evaluate(() => ({ ...(window as unknown as { dl: Dl }).dl }))
    await expect.poll(async () => (await dl()).total).toBeGreaterThan(0)
    expect((await dl()).status).toBe(200)

    // The kick: the page is told, and the stream ends short of the file (an error, or a close before the end).
    expect(await c.hook<boolean>('guestKick', invited.guestId)).toBe(true)
    await expect(page.getByText('Host removed you.')).toBeVisible({ timeout: 1500 })
    await expect.poll(async () => (await dl()).state, { timeout: 5000 }).not.toBe('running')
    expect((await dl()).total).toBeLessThan(SIZE)
  } finally {
    await guest?.close()
    await close()
  }
})
