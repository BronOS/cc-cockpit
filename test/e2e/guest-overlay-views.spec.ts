// Overlays in every view (docs/design-overlay-views.md, plan 20261120-overlay-views Task 13): the bundled Reviewer is a
// `perView` plugin, so each screen that may see its overlay loads its own live copy. Driven end to end with the desktop,
// an owner browser and guests in plain browsers (web-fixtures.ts openBrowser: a guest is its invite link, redeemed by the
// real page), bundled plugins on, the Reviewer shown to guests through the Plugins page's own channel.
//
//  1. Owner screens and a read guest: the desktop and an owner browser each hold a live copy (no Take over) and a note
//     made on either shows on the other; the read guest sees the notes in a read-only copy, makes none, and a forged op
//     from its page is dropped by the host; its link click opens on its own side (the owner's shell.openExternal stays
//     empty); its ✕ hides the overlay for it alone, a reload does not bring it back, and a page `{ result }` from its
//     copy is a hide too.
//  2. A write guest and Discuss: its note shows on the owner's copy "by <invite name>"; Discuss (queued for a working
//     Claude tab) sends the one shared draft, and once delivered removes only what it sent (a note the guest added on a
//     reopened review meanwhile stays); the write guest's ✕ closes the overlay for everyone.
//  3. D-4: an overlay another plugin opens through the Reviewer's service while that plugin is hidden from guests never
//     reaches a guest (not in its stack, its title in no frame, before the guest connects or after), while a Reviewer
//     overlay of its own does and the same service call does once that plugin is shown; a non-perView plugin's overlay
//     is the reworded note with no Take over.
//  4. Server mode: the hidden page (the project's window nobody sees) loads no copy while a browser holds a live one.
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FrameLocator, Locator, Page } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { CockpitApi, OverlayInfo } from '../../src/shared/ipc'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { inviteGuest, rawSocket, redeemOk } from './guest-fixtures'
import { launchServer, type Server } from './server-fixtures'
import { enableWebAccess, openBrowser, openProjectInBrowser, type WebAccessOn, type WebBrowser } from './web-fixtures'

const FIXTURES = join(__dirname, '..', 'fixtures', 'plugins')
const REVIEW = 'Review: README.md'
const LINK = 'https://example.com/guest-link'
const README = `# Plan\n\nFirst paragraph to note.\n\nSecond paragraph to note.\n\nThird paragraph, with a [link](${LINK}).\n`

async function invoke<T>(c: Cockpit, channel: string, payload?: unknown): Promise<T> {
  return c.page.evaluate(
    async ([ch, p]) => ((window as unknown as { cockpit: CockpitApi }).cockpit.invoke as unknown as (c: string, q?: unknown) => Promise<unknown>)(ch, p),
    [channel, payload] as const
  ) as Promise<T>
}

const showToGuests = (c: Cockpit, pluginId: string): Promise<unknown> =>
  invoke(c, 'settings.pluginGuestAccessSet', { pluginId, target: 'app', value: 'shown' })

const stack = (c: Cockpit): Promise<OverlayInfo[]> => c.hook<OverlayInfo[]>('overlays', c.projectDir)

/** The suite must not read the developer's git config (same shape as reviewer-views.spec.ts). */
const git = (cwd: string, ...args: string[]): void => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  delete env.XDG_CONFIG_HOME
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore', env })
}

/**
 * `ccc <args>` from the project folder through the data dir's own wrapper, with no tab in its env (server-fixtures.ts
 * `ccc`): typing into a terminal is not possible while an overlay covers it.
 */
async function ccc(c: Cockpit, ...args: string[]): Promise<string> {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(c.root, 'home'), LANG: 'C.UTF-8' }
  const out = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(join(c.dataDir, 'bin', 'ccc'), ['--project', c.projectDir, ...args], { cwd: c.projectDir, env, timeout: 45_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr })
    )
  })
  expect(out.code, `ccc ${args.join(' ')}: ${out.stderr}`).toBe(0)
  return out.stdout
}

/** A git project with README.md (and `more`) untracked: a new markdown file opens rendered, with no diff. */
function project(c: Cockpit, more: Record<string, string> = {}): void {
  writeFileSync(join(c.projectDir, 'base.txt'), 'base\n')
  git(c.projectDir, 'init', '-q')
  git(c.projectDir, 'add', '-A')
  git(c.projectDir, 'commit', '-q', '-m', 'first')
  writeFileSync(join(c.projectDir, 'README.md'), README)
  for (const [name, text] of Object.entries(more)) writeFileSync(join(c.projectDir, name), text)
}

async function pluginActive(c: Cockpit, id: string): Promise<void> {
  await expect
    .poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.some((p) => p.id === id && p.state === 'active'), { timeout: 20_000 })
    .toBe(true)
}

/** Replaces the host's system browser with a list main records the opened URLs in. */
async function recordOpened(c: Cockpit): Promise<() => Promise<string[]>> {
  await c.app.evaluate(({ shell }) => {
    const g = globalThis as { __opened?: string[] }
    g.__opened = []
    shell.openExternal = (url: string) => {
      g.__opened!.push(url)
      return Promise.resolve()
    }
  })
  return () => c.app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])
}

/** The owner's own browser on the access link, in the project (web-access-plugins.spec.ts joinProject). */
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

const dialog = (page: Page, title: string): Locator => page.getByRole('dialog', { name: title })
const frameOf = (page: Page, title: string): FrameLocator => page.frameLocator(`iframe[title="${title}"]`)

/** A copy that is up: its page drew the rendered file, its loader is gone, and nothing says "Open on …". */
async function liveCopy(page: Page, title: string = REVIEW): Promise<FrameLocator> {
  await expect(dialog(page, title)).toBeVisible({ timeout: 20_000 })
  const frame = frameOf(page, title)
  await expect(frame.locator('.doc-body.markdown p').first()).toBeVisible({ timeout: 20_000 })
  await expect(dialog(page, title).locator('.overlay-loader')).toHaveCount(0)
  await expect(page.getByTestId('held-elsewhere')).toHaveCount(0)
  return frame
}

/** The note texts a copy shows, in its list order. */
const noteTexts = (frame: FrameLocator): Promise<string[]> =>
  frame.locator('#notes .note textarea').evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value))

/** A note on the rendered paragraph that starts with `paragraph`, as a person makes one: select it, press a, type. */
async function addNote(frame: FrameLocator, paragraph: string, text: string): Promise<void> {
  const body = frame.locator('.doc-body.markdown')
  await body.locator('p', { hasText: paragraph }).evaluate((p) => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    const range = document.createRange()
    range.selectNodeContents(p)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
  })
  const before = await frame.locator('#notes .note').count()
  await body.press('a')
  await expect(frame.locator('#notes .note')).toHaveCount(before + 1)
  await frame.locator('#notes .note textarea:focus').fill(text)
}

/** A native Esc on the desktop, as a person types it: main sees it before the page (overlays.spec.ts). */
const pressEsc = (c: Cockpit): Promise<void> =>
  c.app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  })

test('owner screens and a read guest: live copies everywhere, notes both ways, a read-only guest copy, its link on its side, its ✕ for it alone', async () => {
  test.setTimeout(240_000)
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  let owner: WebBrowser | undefined
  let guest: WebBrowser | undefined
  try {
    project(c, { 'OTHER.md': '# Other\n\nAnother file to read.\n' })
    await pluginActive(c, 'cockpit.reviewer')
    const opened = await recordOpened(c)
    const web = await enableWebAccess(c)
    // Before any guest connects: a refusal holds for an overlay in a view until that view remounts.
    await showToGuests(c, 'cockpit.reviewer')
    owner = await ownerBrowser(web)
    guest = await guestBrowser(c, web, 'Rae', 'read')

    expect(await ccc(c, 'review', 'README.md')).toBe('reviewing README.md\n')

    // 1. Every screen its own live copy: the desktop, the owner's browser (no "Open on …", no Take over), the guest.
    const desk = await liveCopy(c.page)
    const web1 = await liveCopy(owner.page)
    const rae = await liveCopy(guest.page)
    expect((await stack(c)).map((o) => o.title)).toEqual([REVIEW])

    // A note on the desktop shows in the browser copy, and the reverse; the read guest sees both.
    await addNote(desk, 'First paragraph', 'from the desktop')
    await expect.poll(() => noteTexts(web1)).toEqual(['from the desktop'])
    await addNote(web1, 'Second paragraph', 'from the browser')
    await expect.poll(() => noteTexts(desk)).toEqual(['from the desktop', 'from the browser'])
    await expect.poll(() => noteTexts(rae)).toEqual(['from the desktop', 'from the browser'])
    // The owner's notes name no author.
    await expect(desk.locator('.note-author')).toHaveCount(0)

    // 2. The read guest's copy is read-only: no delete, text boxes and the comment read-only, and a selection plus
    // `a` makes no note.
    await expect(rae.locator('body')).toHaveClass(/read-only/)
    await expect(rae.locator('#notes .note-del')).toHaveCount(0)
    for (const box of await rae.locator('#notes .note textarea').all()) await expect(box).toHaveJSProperty('readOnly', true)
    await expect(rae.locator('#global')).toHaveJSProperty('readOnly', true)
    await rae.locator('.doc-body.markdown p', { hasText: 'Third paragraph' }).evaluate((p) => {
      const range = document.createRange()
      range.selectNodeContents(p)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
    })
    await rae.locator('.doc-body.markdown').press('a')
    await expect(rae.locator('#add-note')).toBeHidden()
    // Ops forged from its page (past the hidden UI) are dropped by the host, which decides by main's `from`. First the
    // owner's comment, which the guest sees (the pipeline to it is live).
    await desk.locator('#global').fill('the owner comment')
    await expect(rae.locator('#global')).toHaveValue('the owner comment')
    await expect(web1.locator('#global')).toHaveValue('the owner comment')
    const post = (frame: FrameLocator, ops: unknown[]): Promise<void> =>
      frame.locator('body').evaluate((_, list) => {
        const p = (window as unknown as { ccPanel: { post(m: unknown): void } }).ccPanel
        for (const m of list) p.post(m)
      }, ops)
    const lineNote = (tag: string, text: string): unknown => ({ type: 'note-add', tag, note: { from: 1, to: 1, side: 'new', text, quote: 'Plan' } })
    await post(rae, [{ type: 'global', text: 'forged by the read guest' }, lineNote('forged-1', 'forged note')])
    // The same note op from an owner copy is applied (the shape is a valid one), and arrives after the guest's.
    await post(web1, [lineNote('control-1', 'control note')])
    await expect.poll(async () => (await noteTexts(desk)).sort()).toEqual(['control note', 'from the browser', 'from the desktop'])
    await expect.poll(async () => (await noteTexts(rae)).sort()).toEqual(['control note', 'from the browser', 'from the desktop'])
    // (The posting copy itself never drew it: its page did not make the tag the host answers with.)
    // The comment is still the owner's on every screen.
    await expect(desk.locator('#global')).toHaveValue('the owner comment')
    await expect(web1.locator('#global')).toHaveValue('the owner comment')
    await expect(rae.locator('#global')).toHaveValue('the owner comment')

    // 5. A link in the guest's copy opens on the guest's side (a new tab, or the notice to click when the click's
    // activation did not carry): never through the owner's machine.
    await rae.locator('.doc-body.markdown a').click()
    await expect
      .poll(async () => (await guest!.opened()).includes(LINK) || (await guest!.page.locator('.link-notice', { hasText: LINK }).count()) > 0, {
        timeout: 10_000
      })
      .toBe(true)
    await guest.page.waitForTimeout(1000)
    expect(await opened()).toEqual([])
    // The owner's own click does reach the recorder (so its silence above means something).
    await desk.locator('.doc-body.markdown a').click()
    await expect.poll(opened).toEqual([LINK])

    // The guest's ✕: the overlay leaves its screen only; the owner's two copies stay, main still has it.
    await dialog(guest.page, REVIEW).getByRole('button', { name: 'Close overlay' }).click()
    await expect(dialog(guest.page, REVIEW)).toHaveCount(0)
    await stillOnOwnerScreens(c, owner)
    // A reload does not bring it back: a second review opened after the reload reaches the guest, this one never.
    await guest.page.reload()
    await expect(guest.page.getByTestId('guest-banner')).toHaveAttribute('data-role', 'read', { timeout: 20_000 })
    expect(await ccc(c, 'review', 'OTHER.md')).toBe('reviewing OTHER.md\n')
    const other = await liveCopy(guest.page, 'Review: OTHER.md')
    await expect(dialog(guest.page, REVIEW)).toHaveCount(0)
    expect((await stack(c)).map((o) => o.title).sort()).toEqual([REVIEW, 'Review: OTHER.md'].sort())

    // A page `{ result }` from a read guest's copy is its hide too (never a result for the opener): gone for it only.
    await other.locator('body').evaluate(() => (window as unknown as { ccPanel: { post(m: unknown): void } }).ccPanel.post({ result: 'from the read guest' }))
    await expect(dialog(guest.page, 'Review: OTHER.md')).toHaveCount(0)
    await expect(dialog(c.page, 'Review: OTHER.md')).toBeVisible()
    await expect(dialog(owner.page, 'Review: OTHER.md')).toBeVisible()
    expect((await stack(c)).map((o) => o.title).sort()).toEqual([REVIEW, 'Review: OTHER.md'].sort())
    await stillOnOwnerScreens(c, owner)
  } finally {
    await guest?.close()
    await owner?.close()
    await close()
  }
})

/** The README review is still up on both owner screens (after a guest's hide). */
async function stillOnOwnerScreens(c: Cockpit, owner: WebBrowser): Promise<void> {
  await expect(dialog(c.page, REVIEW)).toBeVisible()
  await expect(dialog(owner.page, REVIEW)).toBeVisible()
  await expect(frameOf(c.page, REVIEW).locator('.doc-body.markdown p').first()).toBeVisible()
  await expect(frameOf(owner.page, REVIEW).locator('.doc-body.markdown p').first()).toBeVisible()
  expect((await stack(c)).map((o) => o.title)).toContain(REVIEW)
}

test("a write guest's note carries its name, Discuss sends the shared draft and clears only what it sent, its ✕ closes for all", async () => {
  test.setTimeout(240_000)
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  let guest: WebBrowser | undefined
  try {
    project(c)
    await pluginActive(c, 'cockpit.reviewer')
    // One Claude tab, the Discuss target, working from the start (typed now: an overlay will cover its terminal).
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    await c.typeLine('/prompt busy')
    await expect.poll(async () => (await c.hook<Array<{ status: string }>>('sessions', c.projectDir))[0]?.status, { timeout: 15_000 }).toBe('working')
    const web = await enableWebAccess(c)
    await showToGuests(c, 'cockpit.reviewer')
    guest = await guestBrowser(c, web, 'Wes', 'write')

    const openReview = async (): Promise<void> => {
      expect(await ccc(c, 'review', 'README.md')).toBe('reviewing README.md\n')
    }
    await openReview()
    const desk = await liveCopy(c.page)
    const wes = await liveCopy(guest.page)
    // A write guest's copy edits.
    await expect(wes.locator('body')).not.toHaveClass(/read-only/)

    // 3. The guest's note: on the owner's copy with its author (the invite name; the page draws "by " before it).
    await addNote(desk, 'First paragraph', 'owner note')
    await addNote(wes, 'Second paragraph', 'wes note')
    await expect.poll(() => noteTexts(desk)).toEqual(['owner note', 'wes note'])
    const by = desk.locator('#notes .note .note-author')
    await expect(by).toHaveCount(1)
    await expect(by).toHaveText('Wes')
    await expect(by).toHaveAttribute('title', 'Note by Wes')
    await expect.poll(() => noteTexts(wes)).toEqual(['owner note', 'wes note'])
    await expect(wes.locator('#notes .note .note-author')).toHaveText('Wes')

    // 6. Discuss to a working tab is queued: the overlay goes from every screen, nothing pasted yet.
    await c.page.locator('.overlay .overlay-discuss').getByRole('button', { name: 'Discuss in an existing session' }).click()
    const menu = c.page.getByRole('dialog', { name: 'Discuss in an existing session' })
    await expect(menu.getByRole('option').first()).toContainText('queued — sent when it is free')
    await menu.getByRole('button', { name: 'Send' }).click()
    await expect(dialog(c.page, REVIEW)).toHaveCount(0)
    await expect(dialog(guest.page, REVIEW)).toHaveCount(0)
    await expect.poll(async () => (await stack(c)).length).toBe(0)
    expect(c.pastes()).toEqual([])

    // Reopened before Claude takes it: the draft is kept until then; the write guest adds a note the send never had,
    // then its ✕ closes the review for everyone (the host saves the draft at close).
    await openReview()
    const desk2 = await liveCopy(c.page)
    const wes2 = await liveCopy(guest.page)
    await expect.poll(() => noteTexts(desk2)).toEqual(['owner note', 'wes note'])
    await addNote(wes2, 'Third paragraph', 'late note')
    await expect.poll(() => noteTexts(desk2)).toEqual(['owner note', 'wes note', 'late note'])
    await dialog(guest.page, REVIEW).getByRole('button', { name: 'Close overlay' }).click()
    await expect(dialog(c.page, REVIEW)).toHaveCount(0)
    await expect(dialog(guest.page, REVIEW)).toHaveCount(0)
    await expect.poll(async () => (await stack(c)).length).toBe(0)

    // The tab stops: the queued review goes in as one paste with both screens' notes, and not the later one.
    await c.typeLine('/stop')
    await expect.poll(() => c.pastes().length, { timeout: 15_000 }).toBe(1)
    const [pasted] = c.pastes()
    expect(pasted).toContain('About: Review: README.md')
    expect(pasted).toContain('owner note')
    expect(pasted).toContain('wes note')
    expect(pasted).not.toContain('late note')
    // Only what it sent leaves the stored draft.
    const storage = join(c.dataDir, 'plugin-data', web.projectId, 'cockpit.reviewer', 'storage.json')
    const stored = (): string => (existsSync(storage) ? readFileSync(storage, 'utf8') : '')
    await expect.poll(() => stored().includes('owner note') || stored().includes('wes note'), { timeout: 15_000 }).toBe(false)
    expect(stored()).toContain('late note')
    // And the review opens on that: the late note alone, still the guest's.
    await openReview()
    const desk3 = await liveCopy(c.page)
    await expect.poll(() => noteTexts(desk3)).toEqual(['late note'])
    await expect(desk3.locator('#notes .note .note-author')).toHaveText('Wes')
  } finally {
    await guest?.close()
    await close()
  }
})

test('D-4: an overlay opened through the Reviewer for a plugin hidden from guests never reaches them; a non-perView overlay is the note', async () => {
  test.setTimeout(240_000)
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  let guest: WebBrowser | undefined
  const raws: Array<{ close(): void }> = []
  try {
    project(c)
    await pluginActive(c, 'cockpit.reviewer')
    // The caller of the reviewer service (reviewer-annotate.spec.ts), hidden from guests (every plugin is by default).
    const seenFile = join(c.root, 'home', 'annotate-caller.json')
    rmSync(seenFile, { force: true })
    await c.hook('linkPlugin', join(FIXTURES, 'annotate-caller'))
    await c.hook('enablePlugin', c.projectDir, 'test.annotatecaller')
    await expect.poll(() => existsSync(seenFile), { timeout: 15_000 }).toBe(true)
    const calls = (): Array<{ ok: boolean; error?: string }> => (JSON.parse(readFileSync(seenFile, 'utf8')) as { calls: Array<{ ok: boolean }> }).calls
    const annotate = async (command: string): Promise<void> => {
      const before = calls().length
      // Through the plugin's own command (never a tab's `ccc`: an overlay from a shared tab is the tab's to show).
      await expect
        .poll(
          async () => {
            try {
              await c.hook('runPluginCommand', c.projectDir, `test.annotatecaller/${command}`)
              return true
            } catch {
              return false
            }
          },
          { timeout: 15_000 }
        )
        .toBe(true)
      await expect.poll(() => calls().length, { timeout: 10_000 }).toBe(before + 1)
      expect(calls()[before]).toMatchObject({ ok: true })
    }
    // A non-perView plugin with an html overlay, shown to guests.
    await c.hook('linkPlugin', join(FIXTURES, 'overlay-toolbar'))
    await c.hook('enablePlugin', c.projectDir, 'test.overlaytoolbar')
    await pluginActive(c, 'test.overlaytoolbar')
    const web = await enableWebAccess(c)
    await showToGuests(c, 'cockpit.reviewer')
    await showToGuests(c, 'test.overlaytoolbar')

    // Opened before any guest is here: the `ready` snapshot must leave it out.
    await annotate('html')
    const TITLE = 'Notes: PROJ-1 Fix the login redirect'
    await expect.poll(async () => (await stack(c)).map((o) => o.title)).toEqual([TITLE])
    await expect(frameOf(c.page, TITLE).locator('#editors .doc-body')).toContainText('Users land on', { timeout: 20_000 })

    // A raw guest socket records every frame main sends a guest; a guest in a browser shows what a guest gets.
    const rawInvite = await inviteGuest(c, { name: 'Raw' })
    const rawClient = await redeemOk(web.origin, rawInvite.token)
    const raw = await rawSocket(rawClient)
    raws.push(raw)
    await raw.next((f) => f.t === 'ready')
    guest = await guestBrowser(c, web, 'Rae', 'read')

    // Opened while they are here: live events must leave it out too.
    await annotate('companion')
    const COMPANION = 'Notes: Re: the login redirect'
    await expect.poll(async () => (await stack(c)).map((o) => o.title).sort()).toEqual([COMPANION, TITLE].sort())
    await expect(frameOf(c.page, COMPANION).locator('body')).toContainText('Is the redirect fixed', { timeout: 20_000 })
    await guest.page.waitForTimeout(2000)
    await expect(guest.page.locator('.overlay')).toHaveCount(0)
    const secrets = ['PROJ-1', 'login redirect', 'Users land on', 'Is the redirect fixed', 'test.annotatecaller', 'Annotate Caller']
    const leaked = (): string[] => raw.texts.filter((t) => secrets.some((s) => t.includes(s)))
    expect(raw.texts.length).toBeGreaterThan(0)
    expect(leaked()).toEqual([])
    const shown = await guest.page.content()
    for (const s of secrets) expect(shown).not.toContain(s)

    // Both closed on the desktop (Esc pops the top one), then a review of the Reviewer's own reaches both guests:
    // the socket above would have recorded the others.
    await pressEsc(c)
    await expect.poll(async () => (await stack(c)).length).toBe(1)
    await pressEsc(c)
    await expect.poll(async () => (await stack(c)).length).toBe(0)
    expect(await ccc(c, 'review', 'README.md')).toBe('reviewing README.md\n')
    await liveCopy(guest.page)
    await expect.poll(() => raw.texts.some((t) => t.includes(REVIEW))).toBe(true)
    expect(leaked()).toEqual([])

    // The same service call reaches guests once the plugin it was made for is shown to them. A visibility change sends
    // every guest to a fresh `ready` (D-30): the page reconnects by itself, the raw client does so here.
    await showToGuests(c, 'test.annotatecaller')
    await raw.closed
    const raw2 = await rawSocket(rawClient)
    raws.push(raw2)
    // Its `ready` names the review open now: the snapshot carries the guest's overlays (so the first socket's said the
    // annotate overlay was not one of them).
    const ready2 = await raw2.next((f) => f.t === 'ready')
    expect(JSON.stringify(ready2)).toContain(REVIEW)
    expect(raw.frames.some((f) => f.t === 'ready')).toBe(true)
    await expect(guest.page.getByTestId('guest-banner')).toBeVisible({ timeout: 20_000 })
    await annotate('filetype')
    const FILETYPE = 'Notes: A file review'
    await expect(dialog(guest.page, FILETYPE)).toBeVisible({ timeout: 20_000 })
    await expect(frameOf(guest.page, FILETYPE).locator('body')).toContainText('Some words to review.', { timeout: 20_000 })
    await expect.poll(() => raw2.texts.some((t) => t.includes(FILETYPE))).toBe(true)

    // A plugin that is not perView: the guest gets the note saying where and why, and nothing to press.
    await pressEsc(c)
    await expect.poll(async () => (await stack(c)).length).toBe(1)
    await c.hook('runPluginCommand', c.projectDir, 'test.overlaytoolbar/opener')
    const note = dialog(guest.page, 'Opener page').getByTestId('held-elsewhere')
    await expect(note).toHaveText("Open on Host's screen. Overlay toolbar does not show its windows to guests.", { timeout: 20_000 })
    await expect(dialog(guest.page, 'Opener page').getByRole('button', { name: 'Take over' })).toHaveCount(0)
    await expect(dialog(guest.page, 'Opener page').locator('iframe')).toHaveCount(0)
  } finally {
    for (const r of raws) r.close()
    await guest?.close()
    await close()
  }
})

test('server mode: the hidden page loads no copy of a perView overlay, a browser loads a live one', async () => {
  test.skip(process.platform === 'win32', 'server mode does not run on Windows')
  test.setTimeout(180_000)
  let server: Server | undefined
  let browser: WebBrowser | undefined
  try {
    server = await launchServer({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
    const c = server.cockpit
    project(c)
    await pluginActive(c, 'cockpit.reviewer')
    browser = await openBrowser(`${server.origin}/`)
    await openProjectInBrowser(browser, server.origin, server.projectId)

    expect(await ccc(c, 'review', 'README.md')).toBe('reviewing README.md\n')
    const frame = await liveCopy(browser.page)
    await addNote(frame, 'First paragraph', 'from a browser of the server')
    expect((await stack(c)).map((o) => o.title)).toEqual([REVIEW])
    // The hidden page (Playwright's page of the server) draws no frame for it, now or a moment later.
    await c.page.waitForTimeout(1500)
    await expect(c.page.locator(`iframe[title="${REVIEW}"]`)).toHaveCount(0)
    await expect(c.page.locator('iframe.overlay-html')).toHaveCount(0)
  } finally {
    await browser?.close()
    await server?.close()
  }
})
