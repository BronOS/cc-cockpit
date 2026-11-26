// QA, run 003 Verify (blind: written from the design, the decisions and the tasks' acceptance lines, not the devs'
// reports). Each test names the rule it checks; each refusal has its positive control in the same test.
//
//  1. Notes removal on Discuss (S3): a queued send keeps the notes until delivery; delivered, the sent ones go;
//     a session that ends with the send still queued keeps them.
//  2. Note caps (design §3): 4,000 characters added, 4,001 refused with a reason and nothing cut.
//  3. D15: the owner's Ask in a folder Claude Code never trusted runs isolated and says so; once trusted, a regular
//     session (D2).
//  4. S1: a plugin host cannot fake core's notes, Ask or reply envelopes into its own page.
//  5. Notes and the Ask chat survive an app restart (design §3, D14).
//  6. A write guest: its own Ask works (positive), Continue in a tab is refused (ask.continue GUEST no), and a start
//     naming a copy that is not its own is refused (S5 A8).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FrameLocator, Page } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { CockpitApi, OverlayInfo } from '../../src/shared/ipc'
import { expect, launchCockpit, type Cockpit } from './fixtures'
import { test } from './fixtures'
import { inviteGuest } from './guest-fixtures'
import { enableWebAccess, openBrowser, type WebAccessOn, type WebBrowser } from './web-fixtures'

const FIXTURES = join(__dirname, '..', 'fixtures', 'plugins')
const PLUGIN = 'test.overlaynotes'
const TITLE = 'Overlay notes'
const DOC = 'Fixture document: the quick brown fox.'

function invokeIn<T>(page: Page, channel: string, payload?: unknown): Promise<T> {
  return page.evaluate(
    async ([ch, p]) => ((window as unknown as { cockpit: CockpitApi }).cockpit.invoke as unknown as (c: string, q?: unknown) => Promise<unknown>)(ch, p),
    [channel, payload] as const
  ) as Promise<T>
}

const stack = (c: Cockpit): Promise<OverlayInfo[]> => c.hook<OverlayInfo[]>('overlays', c.projectDir)

async function linkActive(c: Cockpit, dir: string, id: string, relink = true): Promise<void> {
  if (relink) await c.hook('linkPlugin', join(FIXTURES, dir))
  await c.hook('enablePlugin', c.projectDir, id)
  await expect
    .poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.some((p) => p.id === id && p.state === 'active'), { timeout: 20_000 })
    .toBe(true)
}

async function runCommand(c: Cockpit, command: string): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          await c.hook('runPluginCommand', c.projectDir, command)
          return true
        } catch {
          return false
        }
      },
      { timeout: 15_000 }
    )
    .toBe(true)
}

async function openDoc(c: Cockpit): Promise<void> {
  await runCommand(c, `${PLUGIN}/open`)
  await expect.poll(async () => (await stack(c)).map((o) => o.title)).toEqual([TITLE])
}

async function copyOf(page: Page, features: string): Promise<FrameLocator> {
  await expect(page.getByRole('dialog', { name: TITLE })).toBeVisible({ timeout: 20_000 })
  const frame = page.frameLocator(`iframe[title="${TITLE}"]`)
  await expect(frame.locator('#doc p')).toContainText(DOC, { timeout: 20_000 })
  await expect(frame.locator('#features')).toHaveText(features, { timeout: 20_000 })
  return frame
}

const noteLines = (frame: FrameLocator): Promise<string[]> => frame.locator('#note-list li').allTextContents()

async function addNote(frame: FrameLocator, text: string): Promise<void> {
  await frame.locator('#note-text').fill(text)
  await frame.locator('#add-note').click()
}

const pressEsc = (c: Cockpit): Promise<void> =>
  c.app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  })

async function closeDoc(c: Cockpit): Promise<void> {
  await pressEsc(c)
  await expect.poll(async () => (await stack(c)).length).toBe(0)
}

/** A busy Claude tab (Discuss to it is queued until its Stop). */
async function busyTab(c: Cockpit): Promise<void> {
  await c.newTab('claude')
  await c.waitForTerminalText('FAKE-CLAUDE banner')
  await c.typeLine('/prompt busy')
  await expect.poll(async () => (await c.hook<Array<{ status: string }>>('sessions', c.projectDir))[0]?.status, { timeout: 15_000 }).toBe('working')
}

/** Discuss from the toolbar into the one open tab (queued: it is working). */
async function discussQueued(c: Cockpit): Promise<void> {
  await c.page.getByRole('dialog', { name: TITLE }).locator('.overlay-discuss').getByRole('button', { name: 'Discuss in an existing session' }).click()
  const menu = c.page.getByRole('dialog', { name: 'Discuss in an existing session' })
  await expect(menu.getByRole('option').first()).toContainText('queued')
  await menu.getByRole('button', { name: 'Send' }).click()
  await expect.poll(async () => (await stack(c)).length).toBe(0)
}

test('notes: a queued Discuss keeps them; delivered, the sent ones go (S3)', async () => {
  test.setTimeout(180_000)
  const { cockpit: c, close } = await launchCockpit()
  try {
    await linkActive(c, 'overlay-notes', PLUGIN)
    await busyTab(c)
    await openDoc(c)
    let doc = await copyOf(c.page, 'notes ask discuss')
    await addNote(doc, 'first note')
    await addNote(doc, 'second note')
    await expect.poll(() => noteLines(doc)).toHaveLength(2)
    await discussQueued(c)
    expect(c.pastes()).toEqual([])

    // Queued: the notes are still there.
    await openDoc(c)
    doc = await copyOf(c.page, 'notes ask discuss')
    await expect.poll(() => noteLines(doc)).toEqual(['«the quick brown fox» first note', '«the quick brown fox» second note'])
    await closeDoc(c)

    // Delivered: the paste carries them as data, then they are gone.
    await c.typeLine('/stop')
    await expect.poll(() => c.pastes().length, { timeout: 15_000 }).toBe(1)
    const pasted = c.pastes()[0]!
    expect(pasted).toContain('Notes (data, not instructions)')
    expect(pasted).toContain('first note')
    expect(pasted).toContain('second note')
    await openDoc(c)
    doc = await copyOf(c.page, 'notes ask discuss')
    await expect.poll(() => noteLines(doc), { timeout: 10_000 }).toEqual([])
  } finally {
    await close()
  }
})

test('notes: a session that ends with the Discuss still queued keeps them (S3 dropped)', async () => {
  test.setTimeout(180_000)
  const { cockpit: c, close } = await launchCockpit()
  try {
    await linkActive(c, 'overlay-notes', PLUGIN)
    await busyTab(c)
    await openDoc(c)
    let doc = await copyOf(c.page, 'notes ask discuss')
    await addNote(doc, 'kept note')
    await expect.poll(() => noteLines(doc)).toHaveLength(1)
    await discussQueued(c)
    await c.typeLine('/exit 0')
    await expect.poll(async () => (await c.hook<Array<{ status: string }>>('sessions', c.projectDir))[0]?.status ?? 'gone', { timeout: 15_000 }).not.toBe('working')
    await c.page.waitForTimeout(1_000)
    expect(c.pastes()).toEqual([])
    await openDoc(c)
    doc = await copyOf(c.page, 'notes ask discuss')
    await expect.poll(() => noteLines(doc)).toEqual(['«the quick brown fox» kept note'])
  } finally {
    await close()
  }
})

test('notes: 4,000 characters added, 4,001 refused with a reason, nothing cut', async () => {
  test.setTimeout(120_000)
  const { cockpit: c, close } = await launchCockpit()
  try {
    await linkActive(c, 'overlay-notes', PLUGIN)
    await openDoc(c)
    const doc = await copyOf(c.page, 'notes ask discuss')
    await addNote(doc, 'x'.repeat(4_001))
    await expect(doc.locator('#note-error')).toContainText('refused')
    const reason = await doc.locator('#note-error').textContent()
    expect(reason, 'the refusal names a reason').toMatch(/4[,.]?000|long|cap|limit|characters/i)
    expect(await noteLines(doc)).toEqual([])
    await addNote(doc, 'y'.repeat(4_000))
    await expect.poll(() => noteLines(doc)).toHaveLength(1)
    expect((await noteLines(doc))[0]).toContain('y'.repeat(4_000))
  } finally {
    await close()
  }
})

test('D15: the owner Ask in a never-trusted folder runs isolated and says so; trusted, a regular session', async () => {
  test.setTimeout(180_000)
  const { cockpit: c, close } = await launchCockpit()
  try {
    await linkActive(c, 'overlay-notes', PLUGIN)
    const printRuns = (): string[][] => c.claudeRuns().filter((a) => a[0] === '-p')
    const notices = async (doc: FrameLocator): Promise<string[]> =>
      doc.locator('body').evaluate(() => (window as unknown as { __notices?: string[] }).__notices ?? [])
    const watchNotices = (doc: FrameLocator): Promise<void> =>
      doc.locator('body').evaluate(() => {
        const w = window as unknown as { __notices: string[]; ccPanel: { ask: { on(t: string, f: (d: { notice?: string }) => void): void } } }
        w.__notices = []
        w.ccPanel.ask.on('state', (d) => {
          if (typeof d.notice === 'string') w.__notices.push(d.notice)
        })
      })

    // HOME is the test's fresh temp dir: no ~/.claude.json, so the folder is not trusted.
    await openDoc(c)
    let doc = await copyOf(c.page, 'notes ask discuss')
    await watchNotices(doc)
    await doc.locator('#question').fill('untrusted question')
    await doc.locator('#ask-send').click()
    await expect(doc.locator('#answer')).toContainText('FAKE-ANSWER', { timeout: 20_000 })
    const first = printRuns()[0]!
    for (const flag of ['--restricted', '--safe-mode', '--strict-mcp-config']) expect(first, flag).toContain(flag)
    expect(first[first.indexOf('--tools') + 1]).toBe('')
    expect((await notices(doc)).some((n) => /trust/i.test(n)), 'the panel is told why').toBe(true)
    await closeDoc(c)

    // Positive control: Claude Code trusted the folder; the next chat runs as a regular session.
    writeFileSync(join(c.root, 'home', '.claude.json'), JSON.stringify({ projects: { [c.projectDir]: { hasTrustDialogAccepted: true } } }))
    await openDoc(c)
    doc = await copyOf(c.page, 'notes ask discuss')
    await doc.locator('#question').fill('trusted question')
    await doc.locator('#ask-send').click()
    await expect(doc.locator('#answer')).toContainText('FAKE-ANSWER', { timeout: 20_000 })
    const second = printRuns()[1]!
    for (const flag of ['--restricted', '--safe-mode', '--strict-mcp-config', '--tools']) expect(second, flag).not.toContain(flag)
    expect(second).toContain('--permission-prompts')
    // It resumed the isolated chat's session (D14), and Continue in a tab opens a Claude tab on it.
    const id = second[second.indexOf('--resume') + 1] ?? ''
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    const before = c.claudeRuns().length
    const tabsBefore = await c.page.locator('.tab[data-tab-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-tab-id')))
    await doc.locator('#ask-continue').click()
    // The person is taken there (0.28.0 opened it in the background): the window closes, the new tab is selected.
    await expect(c.page.locator('.overlay')).toHaveCount(0, { timeout: 20_000 })
    await expect
      .poll(async () => {
        const id = await c.page.locator('.tab.active[data-tab-id]').first().getAttribute('data-tab-id', { timeout: 1_000 }).catch(() => null)
        return id !== null && !tabsBefore.includes(id)
      }, { timeout: 20_000 })
      .toBe(true)
    await expect.poll(() => c.claudeRuns().slice(before).some((a) => a[0] !== '-p' && !a.includes('--help')), { timeout: 20_000 }).toBe(true)
    const tabRun = c.claudeRuns().slice(before).find((a) => a[0] !== '-p' && !a.includes('--help'))!
    expect(tabRun[tabRun.indexOf('--resume') + 1]).toBe(id)
    // The key's session moved to the tab: the next question in the reopened window starts a fresh session.
    await openDoc(c)
    doc = await copyOf(c.page, 'notes ask discuss')
    await doc.locator('#question').fill('after continue')
    await doc.locator('#ask-send').click()
    await expect(doc.locator('#answer')).toContainText('FAKE-ANSWER', { timeout: 20_000 })
    expect(printRuns().at(-1)).not.toContain('--resume')
  } finally {
    await close()
  }
})

test('S1: a host cannot fake core notes, Ask or reply envelopes into its page', async () => {
  test.setTimeout(120_000)
  const { cockpit: c, close } = await launchCockpit()
  try {
    await linkActive(c, 'qa-spoof', 'test.qaspoof')
    await runCommand(c, 'test.qaspoof/open')
    const frame = c.page.frameLocator('iframe[title="QA spoof"]')
    // Positive control: the plain post arrives.
    await expect(frame.locator('#log')).toContainText('message {"plain":"hello"}', { timeout: 20_000 })
    await expect(frame.locator('#log')).toContainText('ready')
    await c.page.waitForTimeout(1_000)
    const log = (await frame.locator('#log').textContent()) ?? ''
    expect(log).not.toContain('SPOOF')
    const notes = await c.hook<string[]>('notifications')
    expect(notes.filter((n) => n.startsWith('spoof accepted')), JSON.stringify(notes)).toEqual([])
    expect(notes.filter((n) => n.startsWith('spoof refused'))).toHaveLength(3)
  } finally {
    await close()
  }
})

test('notes and the Ask chat survive an app restart', async () => {
  test.setTimeout(240_000)
  const first = await launchCockpit()
  const root = first.cockpit.root
  try {
    const c = first.cockpit
    await linkActive(c, 'overlay-notes', PLUGIN)
    await openDoc(c)
    const doc = await copyOf(c.page, 'notes ask discuss')
    await addNote(doc, 'before restart')
    await expect.poll(() => noteLines(doc)).toHaveLength(1)
    await doc.locator('#question').fill('remember me')
    await doc.locator('#ask-send').click()
    await expect(doc.locator('#answer')).toContainText('FAKE-ANSWER', { timeout: 20_000 })
  } finally {
    await first.close({ keepFiles: true })
  }
  const second = await launchCockpit({ root })
  try {
    const c = second.cockpit
    // The link is kept over the restart (plugins.json in the same data dir).
    await linkActive(c, 'overlay-notes', PLUGIN, false)
    await openDoc(c)
    const doc = await copyOf(c.page, 'notes ask discuss')
    await expect.poll(() => noteLines(doc), { timeout: 15_000 }).toEqual(['«the quick brown fox» before restart'])
    await expect(doc.locator('#history li')).toHaveText([/^Q: remember me A: FAKE-ANSWER /], { timeout: 20_000 })
  } finally {
    await second.close()
  }
})

async function ownerBrowser(web: WebAccessOn): Promise<WebBrowser> {
  const browser = await openBrowser(web.link)
  const projects = browser.page.getByRole('list', { name: 'Open projects' }).getByRole('link')
  await expect(projects).toHaveCount(1)
  await projects.click()
  await expect(browser.page.locator('.tabs-pane')).toBeVisible()
  return browser
}

test("a write guest: its Ask works, Continue is refused, a start naming another view's copy is refused", async () => {
  test.setTimeout(240_000)
  const { cockpit: c, close } = await launchCockpit()
  const opened: WebBrowser[] = []
  try {
    await linkActive(c, 'overlay-notes', PLUGIN)
    const web = await enableWebAccess(c)
    await invokeIn(c.page, 'settings.pluginGuestAccessSet', { pluginId: PLUGIN, target: 'app', value: 'shown' })
    const owner = await ownerBrowser(web)
    opened.push(owner)
    const invited = await inviteGuest(c, { name: 'Wes', role: 'write' })
    const wesB = await openBrowser(invited.link)
    opened.push(wesB)
    await expect(wesB.page.getByTestId('guest-banner')).toHaveAttribute('data-role', 'write', { timeout: 20_000 })
    await openDoc(c)
    await copyOf(c.page, 'notes ask discuss')
    const ownerDoc = await copyOf(owner.page, 'notes ask discuss')
    const wes = await copyOf(wesB.page, 'notes ask discuss')

    // Positive: the write guest's own Ask runs, isolated (D12).
    await wes.locator('#question').fill('guest question')
    await wes.locator('#ask-send').click()
    await expect(wes.locator('#answer')).toContainText('FAKE-ANSWER', { timeout: 20_000 })
    const guestRun = c.claudeRuns().filter((a) => a[0] === '-p').at(-1)!
    expect(guestRun).toContain('--safe-mode')
    expect(guestRun[guestRun.indexOf('--tools') + 1]).toBe('')
    // The owner's copy saw nothing of the guest's chat (events reach only the chat's own person).
    expect(await ownerDoc.locator('#answer').textContent()).toBe('')

    // Continue in a tab is the owner's alone: the guest's page is not offered it (S-6), and the call forged from its
    // own shell page is refused by main.
    const offered = await wes.locator('body').evaluate(() => typeof (window as unknown as { ccPanel: { ask: { continue?: unknown } } }).ccPanel.ask.continue)
    if (offered === 'function') {
      await wes.locator('#ask-continue').click()
      await expect(wes.locator('#continue-result')).toContainText('refused', { timeout: 10_000 })
    }
    await expect(invokeIn(wesB.page, 'overlays.ask.continue', { overlayId: (await stack(c))[0]!.id, copy: 'mine?' })).rejects.toThrow()

    // A start forged from the guest's shell page naming a copy that is not its own: refused, nothing spawned.
    const overlayId = (await stack(c))[0]!.id
    const runs = c.claudeRuns().length
    await expect(invokeIn(wesB.page, 'overlays.ask.start', { overlayId, copy: 'not-mine', question: 'forged' })).rejects.toThrow()
    await c.page.waitForTimeout(500)
    expect(c.claudeRuns().length).toBe(runs)
  } finally {
    for (const b of opened) await b.close().catch(() => {})
    await close()
  }
})

test("a guest not shown the plugin gets no frame with the owner's note text; shown, it sees the note", async () => {
  test.setTimeout(240_000)
  const { cockpit: c, close } = await launchCockpit()
  let wesB: WebBrowser | undefined
  try {
    await linkActive(c, 'overlay-notes', PLUGIN)
    await enableWebAccess(c)
    const invited = await inviteGuest(c, { name: 'Wes', role: 'write' })
    wesB = await openBrowser(invited.link)
    await expect(wesB.page.getByTestId('guest-banner')).toHaveAttribute('data-role', 'write', { timeout: 20_000 })
    // Every socket frame the guest's page gets from here on (a reload starts its socket again under the listener).
    const frames: string[] = []
    wesB.page.on('websocket', (ws) => ws.on('framereceived', (f) => frames.push(typeof f.payload === 'string' ? f.payload : f.payload.toString('utf8'))))
    await wesB.page.reload()
    await expect(wesB.page.getByTestId('guest-banner')).toHaveAttribute('data-role', 'write', { timeout: 20_000 })
    await openDoc(c)
    const doc = await copyOf(c.page, 'notes ask discuss')
    await addNote(doc, 'SECRET-NOTE-4711')
    await expect.poll(() => noteLines(doc)).toHaveLength(1)
    await c.page.waitForTimeout(2_000)
    expect(frames.length, 'the guest socket is live').toBeGreaterThan(0)
    expect(frames.filter((f) => f.includes('SECRET-NOTE-4711'))).toEqual([])
    await expect(wesB.page.getByRole('dialog', { name: TITLE })).toHaveCount(0)

    // Positive control: shown to guests, its copy comes and carries the note.
    await invokeIn(c.page, 'settings.pluginGuestAccessSet', { pluginId: PLUGIN, target: 'app', value: 'shown' })
    const wes = await copyOf(wesB.page, 'notes ask discuss')
    await expect.poll(() => noteLines(wes), { timeout: 20_000 }).toEqual(['«the quick brown fox» SECRET-NOTE-4711'])
  } finally {
    await wesB?.close().catch(() => {})
    await close()
  }
})
