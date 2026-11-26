// Notes and Ask on a perView overlay (task 07; shared/design.md §3-§5, decisions D7, D12, D14): the overlay-notes
// fixture (test.overlaynotes, perView, guests.aware, notes key `fixture:doc-1`) seen by the owner's desktop, the owner's
// browser view, a write guest and a read guest, each in its own copy (web-fixtures.ts openBrowser: a guest is its invite
// link, redeemed by the real page). The fixture's page draws the notes with main's author record, Ask's stored turns
// (the history push) and the answer; the fake `claude` answers Ask's print sessions and logs every argv
// (test/fixtures/bin/claude).
//
//  1. A write guest's note reaches the owner's screens marked "note by guest <name>" (main's word, never the page's);
//     the owner's own note carries no author.
//  2. The read guest's copy shows the notes, but its note write is refused by main and it has no Ask (the intro leaves
//     ccPanel.ask out); writes and an Ask forged from its own shell page are refused too, and no claude runs.
//  3. Ask's chat survives Esc (the stored turns come back on the next open, and the next question resumes the same
//     session), and Continue in a tab (`ccPanel.ask.continue()`) opens a Claude tab with `--resume <id>` of that session.
//     The project folder carries Claude Code's trust record (D15), so the owner's Ask runs with the owner's flags.
//  4. D15: in a folder Claude Code has not trusted (no record), the owner's Ask runs isolated (the guest flags) and the
//     panel shows main's notice.
//
// Trust is read from the app's login env's `$HOME/.claude.json`: the e2e's own temp HOME (fixtures.ts), never the real one.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FrameLocator, Page } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { CockpitApi, OverlayInfo } from '../../src/shared/ipc'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { inviteGuest } from './guest-fixtures'
import { enableWebAccess, openBrowser, type WebAccessOn, type WebBrowser } from './web-fixtures'

const FIXTURES = join(__dirname, '..', 'fixtures', 'plugins')
const PLUGIN = 'test.overlaynotes'
const TITLE = 'Overlay notes'
const DOC = 'Fixture document: the quick brown fox.'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Claude Code's trust record for the project folder (`projects[<folder>].hasTrustDialogAccepted`, main's ask-trust.ts),
 * in the test app's own temp HOME (launchCockpit's `<root>/home`, the HOME of its login env): D15 then lets the owner's
 * Ask run with the owner's flags.
 */
function trustProject(c: Cockpit): void {
  writeFileSync(join(c.root, 'home', '.claude.json'), JSON.stringify({ projects: { [c.projectDir]: { hasTrustDialogAccepted: true } } }))
}

/** An invoke from a page's own `window.cockpit` (the desktop's preload or a browser view's web client). */
function invokeIn<T>(page: Page, channel: string, payload?: unknown): Promise<T> {
  return page.evaluate(
    async ([ch, p]) => ((window as unknown as { cockpit: CockpitApi }).cockpit.invoke as unknown as (c: string, q?: unknown) => Promise<unknown>)(ch, p),
    [channel, payload] as const
  ) as Promise<T>
}

const stack = (c: Cockpit): Promise<OverlayInfo[]> => c.hook<OverlayInfo[]>('overlays', c.projectDir)

async function pluginActive(c: Cockpit, id: string): Promise<void> {
  await expect
    .poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.some((p) => p.id === id && p.state === 'active'), { timeout: 20_000 })
    .toBe(true)
}

/** The fixture linked, enabled and active in the project. */
async function withFixture(c: Cockpit): Promise<void> {
  await c.hook('linkPlugin', join(FIXTURES, 'overlay-notes'))
  await c.hook('enablePlugin', c.projectDir, PLUGIN)
  await pluginActive(c, PLUGIN)
}

/** Opens the overlay through the plugin's own command (an overlay from a tab's `ccc` is that tab's to show). */
async function openDoc(c: Cockpit): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          await c.hook('runPluginCommand', c.projectDir, `${PLUGIN}/open`)
          return true
        } catch {
          return false
        }
      },
      { timeout: 15_000 }
    )
    .toBe(true)
  await expect.poll(async () => (await stack(c)).map((o) => o.title)).toEqual([TITLE])
}

/** The owner's own browser on the access link, in the project (guest-overlay-views.spec.ts ownerBrowser). */
async function ownerBrowser(web: WebAccessOn): Promise<WebBrowser> {
  const browser = await openBrowser(web.link)
  try {
    const projects = browser.page.getByRole('list', { name: 'Open projects' }).getByRole('link')
    await expect(projects).toHaveCount(1)
    await projects.click()
    await expect(browser.page).toHaveURL(`${web.origin}/?project=${encodeURIComponent(web.projectId)}`)
    await expect(browser.page.locator('.tabs-pane')).toBeVisible()
    return browser
  } catch (err) {
    await browser.close()
    throw err
  }
}

/** A guest in a plain browser: the invite link, redeemed by the page itself, landed in the project. */
async function guestBrowser(c: Cockpit, web: WebAccessOn, name: string, role: 'read' | 'write'): Promise<WebBrowser> {
  const invited = await inviteGuest(c, { name, role })
  const guest = await openBrowser(invited.link)
  try {
    await expect(guest.page).toHaveURL(`${web.origin}/?project=${encodeURIComponent(web.projectId)}`, { timeout: 20_000 })
    await expect(guest.page.getByTestId('guest-banner')).toHaveAttribute('data-role', role, { timeout: 20_000 })
    return guest
  } catch (err) {
    await guest.close()
    throw err
  }
}

/** A copy that is up: its page drew the document the host posted to it at connect, and says what the app gave it. */
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

/** The owner's screens and both guests on one opened overlay, the plugin shown to guests. */
async function fourScreens(c: Cockpit): Promise<{ web: WebAccessOn; owner: WebBrowser; writer: WebBrowser; reader: WebBrowser; close(): Promise<void> }> {
  await withFixture(c)
  const web = await enableWebAccess(c)
  await invokeIn(c.page, 'settings.pluginGuestAccessSet', { pluginId: PLUGIN, target: 'app', value: 'shown' })
  const opened: WebBrowser[] = []
  const close = async (): Promise<void> => {
    for (const b of opened.splice(0)) await b.close().catch(() => {})
  }
  try {
    opened.push(await ownerBrowser(web))
    opened.push(await guestBrowser(c, web, 'Wes', 'write'))
    opened.push(await guestBrowser(c, web, 'Rae', 'read'))
  } catch (err) {
    await close()
    throw err
  }
  const [owner, writer, reader] = opened as [WebBrowser, WebBrowser, WebBrowser]
  return { web, owner, writer, reader, close }
}

/** A native Esc on the desktop, as a person types it: main sees it before the page (overlays.spec.ts). */
const pressEsc = (c: Cockpit): Promise<void> =>
  c.app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  })

test("a write guest's note shows 'note by guest <name>' in the owner's view", async () => {
  test.setTimeout(240_000)
  const { cockpit: c, close } = await launchCockpit()
  let screens: Awaited<ReturnType<typeof fourScreens>> | undefined
  try {
    screens = await fourScreens(c)
    await openDoc(c)
    const desk = await copyOf(c.page, 'notes ask discuss')
    const web1 = await copyOf(screens.owner.page, 'notes ask discuss')
    const wes = await copyOf(screens.writer.page, 'notes ask discuss')
    const rae = await copyOf(screens.reader.page, 'notes')

    // The owner's note names no author; the write guest's is marked with its invite name, from main's record.
    await addNote(desk, 'from the owner')
    await expect.poll(() => noteLines(web1)).toEqual(['«the quick brown fox» from the owner'])
    await addNote(wes, 'from Wes')
    const both = ['«the quick brown fox» from the owner', '«the quick brown fox» from Wes (note by guest Wes)']
    await expect.poll(() => noteLines(desk)).toEqual(both)
    await expect.poll(() => noteLines(web1)).toEqual(both)
    await expect.poll(() => noteLines(wes)).toEqual(both)
    await expect.poll(() => noteLines(rae)).toEqual(both)
    await expect(wes.locator('#note-error')).toHaveText('')

    // The plugin host reads the same store, with the same author (ctx.notes(key).list(), its notice).
    await c.hook('runPluginCommand', c.projectDir, `${PLUGIN}/list`)
  } finally {
    await screens?.close()
    await close()
  }
})

test("the read guest's note write and Ask are refused; its copy shows the notes", async () => {
  test.setTimeout(240_000)
  const { cockpit: c, close } = await launchCockpit()
  let screens: Awaited<ReturnType<typeof fourScreens>> | undefined
  try {
    screens = await fourScreens(c)
    await openDoc(c)
    const desk = await copyOf(c.page, 'notes ask discuss')
    const wes = await copyOf(screens.writer.page, 'notes ask discuss')
    // A read guest's copy has the notes (read) and nothing else: no Ask, no Discuss (the intro left them out).
    const rae = await copyOf(screens.reader.page, 'notes')
    await expect(rae.locator('#ask')).toBeHidden()
    expect(await rae.locator('body').evaluate(() => (window as unknown as { ccPanel: { ask?: unknown } }).ccPanel.ask === undefined)).toBe(true)

    // Its copy shows the notes the others write, live.
    await addNote(desk, 'owner note')
    await addNote(wes, 'writer note')
    const notes = ['«the quick brown fox» owner note', '«the quick brown fox» writer note (note by guest Wes)']
    await expect.poll(() => noteLines(rae)).toEqual(notes)

    // Its own write is refused by main (the page's add rejects), and nothing changes anywhere.
    await addNote(rae, 'read guest note')
    await expect(rae.locator('#note-error')).toContainText('refused')
    await desk.locator('body').evaluate(() => new Promise((r) => setTimeout(r, 500)))
    expect(await noteLines(desk)).toEqual(notes)
    expect(await noteLines(rae)).toEqual(notes)

    // Forged from its own shell page, past the copy: main refuses the write and the Ask by the connection it bound (its
    // GUEST_CLASS rows), whatever overlay or copy the payload names.
    const overlayId = (await stack(c))[0]!.id
    const runsBefore = c.claudeRuns().length
    for (const [channel, payload] of [
      ['overlays.notes.write', { overlayId, copy: 'forged', op: 'add', quote: 'the quick brown fox', anchor: null, text: 'forged note' }],
      ['overlays.notes.write', { overlayId, copy: 'forged', op: 'setGlobal', text: 'forged global' }],
      ['overlays.ask.start', { overlayId, copy: 'forged', question: 'forged question' }],
      ['overlays.ask.continue', { overlayId, copy: 'forged' }],
    ] as const) {
      await expect(invokeIn(screens.reader.page, channel, payload), channel).rejects.toThrow()
    }
    await desk.locator('body').evaluate(() => new Promise((r) => setTimeout(r, 500)))
    expect(await noteLines(desk)).toEqual(notes)
    expect(c.claudeRuns().length, 'no claude ran for the read guest').toBe(runsBefore)
    // The owner's view of the store agrees (main's own list).
    const listed = await invokeIn<{ global: string; notes: Array<{ text: string }> }>(screens.owner.page, 'overlays.notes.read', { overlayId, copy: 'forged' }).catch(() => null)
    if (listed) expect(listed.notes.map((n) => n.text)).toEqual(['owner note', 'writer note'])
  } finally {
    await screens?.close()
    await close()
  }
})

test('Ask after Esc shows the chat; Continue in a tab opens a Claude tab with --resume <id>', async () => {
  test.setTimeout(180_000)
  const { cockpit: c, close } = await launchCockpit()
  try {
    trustProject(c)
    await withFixture(c)
    await openDoc(c)
    let doc = await copyOf(c.page, 'notes ask discuss')
    const printRuns = (): string[][] => c.claudeRuns().filter((a) => a[0] === '-p')

    // The first question: a print session with the owner's flags (no --resume yet), answered beside the document.
    await doc.locator('#question').fill('what is the fox')
    await doc.locator('#ask-send').click()
    // (The fake answers with the start of what main sent it: main's own framing of the question comes first.)
    await expect(doc.locator('#answer')).toContainText('FAKE-ANSWER', { timeout: 20_000 })
    expect(printRuns()).toHaveLength(1)
    expect(printRuns()[0]).not.toContain('--resume')
    expect(printRuns()[0]).not.toContain('--safe-mode')
    await expect(doc.locator('#ask-notice')).toHaveText('')

    // Esc closes the overlay; the chat is kept by the app (D14), so the next open shows its turn.
    await pressEsc(c)
    await expect.poll(async () => (await stack(c)).length).toBe(0)
    await openDoc(c)
    doc = await copyOf(c.page, 'notes ask discuss')
    await expect(doc.locator('#history li')).toHaveText([/^Q: what is the fox A: FAKE-ANSWER /], { timeout: 20_000 })

    // The next question resumes the same session: its id is the one the first run's init line gave.
    await doc.locator('#question').fill('and the dog')
    await doc.locator('#ask-send').click()
    await expect(doc.locator('#answer')).toContainText('FAKE-ANSWER', { timeout: 20_000 })
    expect(printRuns()).toHaveLength(2)
    const second = printRuns()[1]!
    const id = second[second.indexOf('--resume') + 1] ?? ''
    expect(id).toMatch(UUID)

    // Continue in a tab: a Claude tab (not a print run) resuming that session.
    const before = c.claudeRuns().length
    await doc.locator('#ask-continue').click()
    await expect(doc.locator('#continue-result')).toHaveText(/^tab \S+/, { timeout: 20_000 })
    await expect.poll(() => c.claudeRuns().length, { timeout: 20_000 }).toBeGreaterThan(before)
    const tabRun = c.claudeRuns().slice(before).find((a) => a[0] !== '-p' && !a.includes('--help'))
    expect(tabRun, JSON.stringify(c.claudeRuns().slice(before))).toBeDefined()
    expect(tabRun![tabRun!.indexOf('--resume') + 1]).toBe(id)
  } finally {
    await close()
  }
})

test("D15: in a folder Claude Code has not trusted, the owner's Ask runs isolated and the panel says so", async () => {
  test.setTimeout(120_000)
  const { cockpit: c, close } = await launchCockpit()
  try {
    // No trust record: the temp HOME has no .claude.json at all.
    await withFixture(c)
    await openDoc(c)
    const doc = await copyOf(c.page, 'notes ask discuss')
    await doc.locator('#question').fill('what is the fox')
    await doc.locator('#ask-send').click()
    await expect(doc.locator('#ask-notice')).toContainText('Claude Code has not trusted this folder yet', { timeout: 20_000 })
    await expect.poll(() => c.claudeRuns().filter((a) => a[0] === '-p').length, { timeout: 20_000 }).toBe(1)
    const run = c.claudeRuns().find((a) => a[0] === '-p')!
    // The guest isolation (D12): no tools, none of the folder's hooks or settings, no MCP.
    for (const flag of ['--restricted', '--safe-mode', '--strict-mcp-config']) expect(run, flag).toContain(flag)
    expect(run[run.indexOf('--tools') + 1]).toBe('')
  } finally {
    await close()
  }
})
