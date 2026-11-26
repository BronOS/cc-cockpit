// QA, run 003 Verify round 2: the reviewer's fixed areas reachable from outside (shared/verify.md), each with a
// positive control. S-8 pick back to default, S-10 an open note edit survives another view's add, S-5 the part frame
// is not remounted, S-11 a browser view's copy keeps notes after its socket reconnects, S-6/F3 Continue in a tab only
// for the owner and only once a session exists.
import { join } from 'node:path'
import type { FrameLocator, Page } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { CockpitApi } from '../../src/shared/ipc'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { inviteGuest } from './guest-fixtures'
import { enableWebAccess, openBrowser, type WebAccessOn, type WebBrowser } from './web-fixtures'

const FIXTURES = join(__dirname, '..', 'fixtures', 'plugins')
const NOTES = 'test.overlaynotes'
const KIT = 'test.kitdemo'

function invokeIn<T>(page: Page, channel: string, payload?: unknown): Promise<T> {
  return page.evaluate(
    async ([ch, p]) => ((window as unknown as { cockpit: CockpitApi }).cockpit.invoke as unknown as (c: string, q?: unknown) => Promise<unknown>)(ch, p),
    [channel, payload] as const
  ) as Promise<T>
}
async function link(c: Cockpit, dir: string, id: string, relink = true): Promise<void> {
  if (relink) await c.hook('linkPlugin', join(FIXTURES, dir))
  await c.hook('enablePlugin', c.projectDir, id)
  await expect.poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.some((p) => p.id === id && p.state === 'active'), { timeout: 20_000 }).toBe(true)
}
async function run(c: Cockpit, command: string): Promise<void> {
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
async function ownerBrowser(web: WebAccessOn): Promise<WebBrowser> {
  const browser = await openBrowser(web.link)
  await browser.page.getByRole('list', { name: 'Open projects' }).getByRole('link').click()
  await expect(browser.page.locator('.tabs-pane')).toBeVisible()
  return browser
}
const notesDoc = (p: Page): FrameLocator => p.frameLocator('iframe[title="Overlay notes"]')
const kitDoc = (p: Page): FrameLocator => p.frameLocator('iframe[title="Kit demo"]')
type Pick = { model: string; effort: string; models: string[]; efforts: string[] }
const pickIn = (frame: FrameLocator, req: Record<string, unknown>): Promise<Pick> =>
  frame.locator('body').evaluate((_b, r) => (window as unknown as { ccPanel: { ask: { pick(x: unknown): Promise<Pick> } } }).ccPanel.ask.pick(r), req)

test('S-8: a pick set back to default stays default over a restart (a model pick is kept: control)', async () => {
  test.setTimeout(240_000)
  const first = await launchCockpit()
  const root = first.cockpit.root
  let picked: Pick | undefined
  try {
    const c = first.cockpit
    await link(c, 'overlay-notes', NOTES)
    await run(c, `${NOTES}/open`)
    const doc = notesDoc(c.page)
    await expect(doc.locator('#features')).toHaveText('notes ask discuss', { timeout: 20_000 })
    const initial = await pickIn(doc, {})
    const model = initial.models.find((m) => m !== initial.model && m !== 'default')!
    picked = await pickIn(doc, { model })
    expect(picked.model).toBe(model)
  } finally {
    await first.close({ keepFiles: true })
  }
  const second = await launchCockpit({ root })
  try {
    const c = second.cockpit
    await link(c, 'overlay-notes', NOTES, false)
    await run(c, `${NOTES}/open`)
    const doc = notesDoc(c.page)
    await expect(doc.locator('#features')).toHaveText('notes ask discuss', { timeout: 20_000 })
    // Control: the model pick came back.
    expect((await pickIn(doc, {})).model).toBe(picked!.model)
    const back = await pickIn(doc, { model: null })
    expect(back.model).not.toBe(picked!.model)
  } finally {
    await second.close({ keepFiles: true })
  }
  const third = await launchCockpit({ root })
  try {
    const c = third.cockpit
    await link(c, 'overlay-notes', NOTES, false)
    await run(c, `${NOTES}/open`)
    const doc = notesDoc(c.page)
    await expect(doc.locator('#features')).toHaveText('notes ask discuss', { timeout: 20_000 })
    expect((await pickIn(doc, {})).model).not.toBe(picked!.model)
  } finally {
    await third.close()
  }
})

test("S-10: an open note edit survives another view's add; saved, everyone sees it", async () => {
  test.setTimeout(240_000)
  const { cockpit: c, close } = await launchCockpit()
  let owner: WebBrowser | undefined
  try {
    await link(c, 'kit-demo', KIT)
    const web = await enableWebAccess(c)
    owner = await ownerBrowser(web)
    await run(c, `${KIT}/open`)
    const desk = kitDoc(c.page)
    const view = kitDoc(owner.page)
    await expect(desk.locator('body')).toContainText('DEMO-1', { timeout: 20_000 })
    await expect(view.locator('body')).toContainText('DEMO-1', { timeout: 20_000 })
    // A note to edit, added through the selection menu.
    const addVia = async (frame: FrameLocator, phrase: string, text: string): Promise<void> => {
      await frame.locator('body').evaluate((body, t) => {
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const at = (n.textContent ?? '').indexOf(t)
          if (at < 0) continue
          const range = document.createRange()
          range.setStart(n, at)
          range.setEnd(n, at + t.length)
          window.getSelection()!.removeAllRanges()
          window.getSelection()!.addRange(range)
          const r = range.getBoundingClientRect()
          n.parentElement!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.right, clientY: r.bottom }))
          document.dispatchEvent(new Event('selectionchange'))
          return
        }
      }, phrase)
      await frame.getByRole('button', { name: 'Note', exact: true }).click()
      const box = frame.locator('textarea').first()
      await box.fill(text)
      await frame.getByRole('button', { name: 'Save' }).first().click()
    }
    await addVia(desk, 'lazy dog', 'first text')
    await expect(view.locator('body')).toContainText('first text', { timeout: 10_000 })
    // The desktop opens Edit and types, unsaved.
    await desk.getByRole('button', { name: 'Edit' }).first().click()
    // The edit box is the textarea holding the note's text (the Ask box is another textarea).
    await expect.poll(() => desk.locator('textarea').evaluateAll((els) => els.findIndex((e) => (e as HTMLTextAreaElement).value === 'first text'))).toBeGreaterThanOrEqual(0)
    const at = await desk.locator('textarea').evaluateAll((els) => els.findIndex((e) => (e as HTMLTextAreaElement).value === 'first text'))
    const editBox = desk.locator('textarea').nth(at)
    await editBox.fill('edited text, not saved yet')
    // Meanwhile the browser view adds another note: the desktop's list is redrawn.
    await addVia(view, 'quick brown', 'second note')
    await expect(desk.locator('body')).toContainText('second note', { timeout: 10_000 })
    // The open edit is still there with what was typed.
    const values = await desk.locator('textarea').evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value))
    expect(values, JSON.stringify(values)).toContain('edited text, not saved yet')
    // Saved: the browser view shows the edit.
    await desk.getByRole('button', { name: 'Save' }).first().click()
    await expect(view.locator('body')).toContainText('edited text, not saved yet', { timeout: 10_000 })
  } finally {
    await owner?.close().catch(() => {})
    await close()
  }
})

test('S-5: the part frame is not reloaded by a resize across 1280 px or by a note add (it is on a reopen: control)', async () => {
  test.setTimeout(240_000)
  const { cockpit: c, close } = await launchCockpit()
  try {
    await link(c, 'overlay-notes', NOTES)
    await link(c, 'overlay-part', 'test.overlaypart')
    await c.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 1000))
    let partLoads = 0
    c.page.on('framenavigated', (f) => {
      if (f.url().includes('test.overlaypart')) partLoads++
    })
    await run(c, `${NOTES}/open`)
    const part = c.page.frameLocator('iframe[title="Overlay part"]')
    await expect(part.locator('body')).toContainText('doc:fixture-1', { timeout: 20_000 })
    await c.page.waitForTimeout(1_000)
    const afterOpen = partLoads
    expect(afterOpen).toBeGreaterThanOrEqual(1)
    for (const w of [1100, 1440, 1100, 1440]) {
      await c.app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]?.setSize(width, 1000), w)
      await c.page.waitForTimeout(700)
    }
    const doc = notesDoc(c.page)
    await doc.locator('#note-text').fill('a note')
    await doc.locator('#add-note').click()
    await c.page.waitForTimeout(1_000)
    expect(partLoads, 'no reload of the part frame').toBe(afterOpen)
    await expect(part.locator('body')).toContainText('doc:fixture-1')
  } finally {
    await close()
  }
})

test("S-11: after its socket drops and comes back, a browser view's copy still writes notes", async () => {
  test.setTimeout(240_000)
  const { cockpit: c, close } = await launchCockpit()
  let owner: WebBrowser | undefined
  try {
    await link(c, 'overlay-notes', NOTES)
    const web = await enableWebAccess(c)
    owner = await ownerBrowser(web)
    // Keep every socket the web client opens, so the test can cut it (a reload starts the page under the script).
    await owner.page.addInitScript(() => {
      const Real = window.WebSocket
      const list: WebSocket[] = []
      ;(window as unknown as { __qaSockets: WebSocket[] }).__qaSockets = list
      window.WebSocket = class extends Real {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols)
          list.push(this)
        }
      } as typeof WebSocket
    })
    await owner.page.reload()
    await expect(owner.page.locator('.tabs-pane')).toBeVisible({ timeout: 20_000 })
    await run(c, `${NOTES}/open`)
    const view = notesDoc(owner.page)
    await expect(view.locator('#features')).toHaveText('notes ask discuss', { timeout: 20_000 })
    await view.locator('#note-text').fill('before the drop')
    await view.locator('#add-note').click()
    await expect(view.locator('#note-list li')).toHaveCount(1, { timeout: 10_000 })
    // The socket drops (closed under the web client, as a network cut would) and the client reconnects in place.
    let sockets = 0
    owner.page.on('websocket', () => sockets++)
    const closed = await owner.page.evaluate(() => {
      const list = (window as unknown as { __qaSockets?: WebSocket[] }).__qaSockets ?? []
      for (const ws of list) ws.close()
      return list.length
    })
    expect(closed, 'the init script saw the client socket').toBeGreaterThan(0)
    await expect.poll(() => sockets, { timeout: 30_000 }).toBeGreaterThan(0)
    await owner.page.waitForTimeout(3_000)
    const after = notesDoc(owner.page)
    await expect(after.locator('#features')).toHaveText('notes ask discuss', { timeout: 20_000 })
    await after.locator('#note-text').fill('after the drop')
    await after.locator('#add-note').click()
    await expect(after.locator('#note-error')).toHaveText('', { timeout: 5_000 })
    await expect(notesDoc(c.page).locator('#note-list li')).toHaveCount(2, { timeout: 10_000 })
  } finally {
    await owner?.close().catch(() => {})
    await close()
  }
})

test('S-6/F3: Continue in a tab shows for the owner only once a session exists, never for a write guest', async () => {
  test.setTimeout(240_000)
  const { cockpit: c, close } = await launchCockpit()
  let wes: WebBrowser | undefined
  try {
    await link(c, 'kit-demo', KIT)
    await enableWebAccess(c)
    await invokeIn(c.page, 'settings.pluginGuestAccessSet', { pluginId: KIT, target: 'app', value: 'shown' })
    wes = await openBrowser((await inviteGuest(c, { name: 'Wes', role: 'write' })).link)
    await expect(wes.page.getByTestId('guest-banner')).toHaveAttribute('data-role', 'write', { timeout: 20_000 })
    await run(c, `${KIT}/open`)
    const desk = kitDoc(c.page)
    const guest = kitDoc(wes.page)
    await expect(desk.locator('body')).toContainText('DEMO-1', { timeout: 20_000 })
    await expect(guest.locator('body')).toContainText('DEMO-1', { timeout: 20_000 })
    await desk.getByRole('tab', { name: 'Ask' }).click()
    const cont = (f: FrameLocator) => f.getByRole('button', { name: 'Continue in a tab' })
    await expect(cont(desk)).toHaveCount(0)
    const ask = async (f: FrameLocator, q: string): Promise<void> => {
      const box = f.getByPlaceholder(/Ask/).first()
      await box.fill(q)
      await box.press('Enter')
    }
    await ask(desk, 'owner question')
    await expect(cont(desk)).toBeVisible({ timeout: 20_000 })
    await guest.getByRole('tab', { name: 'Ask' }).click().catch(() => undefined)
    await ask(guest, 'guest question')
    await expect(guest.locator('body')).toContainText('FAKE-ANSWER', { timeout: 20_000 })
    await expect(cont(guest)).toHaveCount(0)
  } finally {
    await wes?.close().catch(() => {})
    await close()
  }
})
