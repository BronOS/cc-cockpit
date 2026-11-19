// qa-chloe blind verify (not for merge): write guest limits (tab cap, closing tabs, D-9 owner ask, owner-only
// calls), and every way the owner narrows a live guest cutting it off within 1 s: downgrade (4461), scope
// narrowed (4464), a shown plugin hidden (4464 and its /p/ page gone), kick (4460 and /p/ gone).
import { join } from 'node:path'
import type { CockpitApi } from '../../src/shared/ipc'
import { pluginActive } from './download-fixtures'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { guestGet, inviteGuest, rawSocket, redeem, redeemOk, type GuestClient, type RawSocket } from './guest-fixtures'
import { enableWebAccess } from './web-fixtures'

const FIXTURES = join(__dirname, '..', 'fixtures', 'plugins')

async function invoke<T>(c: Cockpit, channel: string, payload?: unknown): Promise<T> {
  return c.page.evaluate(
    async ([ch, p]) => ((window as unknown as { cockpit: CockpitApi }).cockpit.invoke as unknown as (c: string, q?: unknown) => Promise<unknown>)(ch, p),
    [channel, payload] as const
  ) as Promise<T>
}

let callId = 5000
async function rawInvoke(s: RawSocket, ch: string, p?: unknown): Promise<{ ok: boolean; v?: unknown; err?: string }> {
  const id = ++callId
  s.ws.send(JSON.stringify({ t: 'invoke', id, ch, p }))
  const f = await s.next((x) => x.t === 'result' && x.id === id, 5000)
  const r = { ok: f.ok === true, v: f.v, err: typeof f.err === 'string' ? f.err : undefined }
  if (process.env.QA_DEBUG) console.log('QA', ch, JSON.stringify(p)?.slice(0, 80), '=>', JSON.stringify(r).slice(0, 200))
  return r
}

interface TabLite {
  id: string
  kind: string
  openedByGuest?: string
}

async function readyOf(s: RawSocket): Promise<{ paths: { plugins: Record<string, string> } }> {
  return (await s.next((f) => f.t === 'ready')) as unknown as { paths: { plugins: Record<string, string> } }
}

/** Ms from `t0` until the socket closed, and its code. */
async function closedWithin(s: RawSocket, t0: number): Promise<{ code: number; ms: number }> {
  const c = await Promise.race([s.closed, new Promise<undefined>((r) => setTimeout(() => r(undefined), 5000))])
  return c ? { code: c.code, ms: c.at - t0 } : { code: -1, ms: 99999 }
}

async function setup(): Promise<{ c: Cockpit; close: () => Promise<void>; origin: string }> {
  const { cockpit: c, close } = await launchCockpit()
  await c.hook('linkPlugin', join(FIXTURES, 'guest-team'))
  await c.hook('enablePlugin', c.projectDir, 'test.guestteam')
  await pluginActive(c, 'test.guestteam')
  await c.newTab('claude')
  await c.waitForTerminalText('FAKE-CLAUDE banner')
  const web = await enableWebAccess(c)
  await invoke(c, 'settings.pluginGuestAccessSet', { pluginId: 'test.guestteam', target: 'app', value: 'shown' })
  return { c, close, origin: web.origin }
}

test('qa: write guest limits and the D-9 owner ask', async () => {
  test.setTimeout(120_000)
  const { c, close, origin } = await setup()
  try {
    const [ownerTab] = (await c.hook<TabLite[]>('tabs', c.projectDir)) as [TabLite]
    const inv = await inviteGuest(c, { name: 'Wes', role: 'write', scope: 'all' })
    const client = await redeemOk(origin, inv.token)
    // The invite is spent: a second redeem is refused.
    expect((await redeem(origin, inv.token)).status).toBe(410)
    const g = await rawSocket(client)
    await readyOf(g)

    // Typing reaches the owner's Claude tab.
    expect((await rawInvoke(g, 'tabs.input', { tabId: ownerTab.id, data: 'qa-from-guest\r' })).ok).toBe(true)
    await c.waitForTerminalText('qa-from-guest')

    // At most 4 new tabs (D-21), each tagged openedByGuest.
    const made: string[] = []
    for (let i = 0; i < 4; i++) {
      const r = await rawInvoke(g, 'tabs.create', { kind: 'shell' })
      expect(r.ok, `tab ${i + 1}: ${JSON.stringify(r)}`).toBe(true)
      made.push((r.v as TabLite).id)
    }
    const fifth = await rawInvoke(g, 'tabs.create', { kind: 'shell' })
    expect(fifth.ok && fifth.v !== null, `5th tab accepted: ${JSON.stringify(fifth)}`).toBe(false)
    const tabs = await c.hook<TabLite[]>('tabs', c.projectDir)
    expect(tabs.filter((t) => made.includes(t.id)).every((t) => t.openedByGuest === inv.guestId), JSON.stringify(tabs)).toBe(true)
    // Command tabs from the owner's menu are not a guest's.
    expect((await rawInvoke(g, 'tabs.commands', undefined)).ok).toBe(false)

    // Closing its own tab: closes. Owner-only calls: refused.
    expect((await rawInvoke(g, 'tabs.close', { tabId: made[0] })).ok).toBe(true)
    await expect.poll(async () => (await c.hook<TabLite[]>('tabs', c.projectDir)).some((t) => t.id === made[0])).toBe(false)
    for (const [ch, p] of [
      ['tabs.flag', { tabId: ownerTab.id, flag: { color: 'red' } }],
      ['tabs.rename', { tabId: ownerTab.id, name: 'x' }],
      ['guests.setRole', { guestId: inv.guestId, role: 'write' }],
      ['guests.invite', { name: 'Eve', role: 'write', scope: 'all', lifetime: 'forever' }],
      ['settings.pluginGuestAccessSet', { pluginId: 'test.guestteam', target: 'app', value: 'hidden' }],
      ['groups.dissolve', { groupId: 'x' }],
      ['tabs.guestCloseAnswer', { requestId: 'x', close: true }]
    ] as const) {
      const r = await rawInvoke(g, ch, p)
      expect(r.ok && r.v !== false && r.v !== null, `${ch} accepted from a write guest: ${JSON.stringify(r)}`).toBe(false)
    }

    // D-9: closing the owner's tab asks the owner; the tab stays until the owner answers.
    const ask = await rawInvoke(g, 'tabs.close', { tabId: ownerTab.id })
    expect(ask.v).toEqual({ asked: true })
    const dialog = c.page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    expect(await dialog.innerText()).toContain('Wes asks to close')
    expect((await c.hook<TabLite[]>('tabs', c.projectDir)).some((t) => t.id === ownerTab.id)).toBe(true)
    await dialog.getByRole('button', { name: /keep/i }).click()
    await expect(dialog).toBeHidden()
    expect((await c.hook<TabLite[]>('tabs', c.projectDir)).some((t) => t.id === ownerTab.id)).toBe(true)
    // Asked again, the owner closes it.
    expect((await rawInvoke(g, 'tabs.close', { tabId: ownerTab.id })).v).toEqual({ asked: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: /^close/i }).click()
    await expect.poll(async () => (await c.hook<TabLite[]>('tabs', c.projectDir)).some((t) => t.id === ownerTab.id)).toBe(false)
    g.close()
  } finally {
    await close()
  }
})

test('qa: downgrade, scope narrowed, plugin hidden and kick each cut a live guest off within 1 s', async () => {
  test.setTimeout(120_000)
  const { c, close, origin } = await setup()
  try {
    const [tab] = (await c.hook<TabLite[]>('tabs', c.projectDir)) as [TabLite]
    const inv = await inviteGuest(c, { name: 'Dee', role: 'write', scope: 'all' })
    const client: GuestClient = await redeemOk(origin, inv.token)

    // Downgrade write -> read: 4461 within 1 s, and the next socket may not type.
    let g = await rawSocket(client)
    await readyOf(g)
    let t0 = Date.now()
    expect(await invoke(c, 'guests.setRole', { guestId: inv.guestId, role: 'read' })).toBe(true)
    let cut = await closedWithin(g, t0)
    expect(cut.code).toBe(4461)
    expect(cut.ms).toBeLessThan(1000)
    g = await rawSocket(client)
    await readyOf(g)
    expect((await rawInvoke(g, 'tabs.input', { tabId: tab.id, data: 'after-downgrade\r' })).ok).toBe(false)

    // A shown plugin's page loads for the guest; hiding the plugin closes 4464 and the page 404s within 1 s.
    const prefix = (await readyOf(g)).paths.plugins['test.guestteam'] ?? ''
    expect(prefix, 'no /p/ prefix for a shown plugin').toBeTruthy()
    const pageUrl = `${prefix.startsWith('/') ? '' : '/'}${prefix}${prefix.endsWith('/') ? '' : '/'}panel.html`
    expect((await guestGet(client, pageUrl)).status).toBe(200)
    t0 = Date.now()
    await invoke(c, 'settings.pluginGuestAccessSet', { pluginId: 'test.guestteam', target: 'app', value: 'hidden' })
    cut = await closedWithin(g, t0)
    expect(cut.code).toBe(4464)
    expect(cut.ms).toBeLessThan(1000)
    expect((await guestGet(client, pageUrl)).status).toBe(404)
    expect(Date.now() - t0).toBeLessThan(1500)
    g = await rawSocket(client)
    const r2 = await readyOf(g)
    expect(Object.keys(r2.paths.plugins)).not.toContain('test.guestteam')

    // Scope narrowed to nothing: 4464 within 1 s, then no tabs.
    t0 = Date.now()
    expect(await invoke(c, 'guests.setScope', { guestId: inv.guestId, scope: [] })).toBe(true)
    cut = await closedWithin(g, t0)
    expect(cut.code).toBe(4464)
    expect(cut.ms).toBeLessThan(1000)
    g = await rawSocket(client)
    await readyOf(g)
    expect((await rawInvoke(g, 'tabs.list')).v).toEqual([])

    // Show the plugin again, then kick: 4460 within 1 s, the page and the socket are gone.
    await invoke(c, 'settings.pluginGuestAccessSet', { pluginId: 'test.guestteam', target: 'app', value: 'shown' })
    await expect.poll(async () => (await g.closed.then(() => true, () => false))).toBe(true)
    g = await rawSocket(client)
    const prefix2 = (await readyOf(g)).paths.plugins['test.guestteam'] ?? ''
    const page2 = `${prefix2.startsWith('/') ? '' : '/'}${prefix2}${prefix2.endsWith('/') ? '' : '/'}panel.html`
    expect((await guestGet(client, page2)).status).toBe(200)
    t0 = Date.now()
    expect(await invoke(c, 'guests.kick', { guestId: inv.guestId })).toBe(true)
    cut = await closedWithin(g, t0)
    expect(cut.code).toBe(4460)
    expect(cut.ms).toBeLessThan(1000)
    expect((await guestGet(client, page2)).status).toBe(404)
    const frames = g.frames.length
    expect(g.frames.length).toBe(frames)
  } finally {
    await close()
  }
})
