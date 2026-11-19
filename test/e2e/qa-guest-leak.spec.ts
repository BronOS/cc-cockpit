// qa-chloe blind verify (not for merge): a hidden plugin, another project and an unshared tab each carry a
// QAZX marker; a selected-tabs read guest's raw socket and HTTP answers must never hold one, while an owner
// browser on the same gateway (the positive control) does receive the plugin's and the unshared tab's.
// Then raw invokes from the guest: hidden ids answer like nonexistent ones, owner-only and write channels
// are refused and change nothing.
import { mkdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Page } from '@playwright/test'
import type { CockpitApi } from '../../src/shared/ipc'
import { pluginActive } from './download-fixtures'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { guestGet, guestList, inviteGuest, rawSocket, redeemOk, type RawSocket } from './guest-fixtures'
import { enableWebAccess, openBrowser, openProjectInBrowser, type WebBrowser } from './web-fixtures'

const FIXTURES = join(__dirname, '..', 'fixtures', 'plugins')

async function invoke<T>(c: Cockpit, channel: string, payload?: unknown): Promise<T> {
  return c.page.evaluate(
    async ([ch, p]) => ((window as unknown as { cockpit: CockpitApi }).cockpit.invoke as unknown as (c: string, q?: unknown) => Promise<unknown>)(ch, p),
    [channel, payload] as const
  ) as Promise<T>
}

interface TabLite {
  id: string
  kind: string
}

let callId = 1000
/** One invoke over the raw guest socket; resolves with the result frame. */
async function rawInvoke(s: RawSocket, ch: string, p?: unknown): Promise<{ ok: boolean; v?: unknown; err?: string }> {
  const id = ++callId
  s.ws.send(JSON.stringify({ t: 'invoke', id, ch, p }))
  const f = await s.next((x) => x.t === 'result' && x.id === id, 5000)
  const r = { ok: f.ok === true, v: f.v, err: typeof f.err === 'string' ? f.err : undefined }
  if (process.env.QA_DEBUG) console.log('QA', ch, JSON.stringify(p)?.slice(0, 80), '=>', JSON.stringify(r).slice(0, 200))
  return r
}

function recordFrames(page: Page): string[] {
  const frames: string[] = []
  page.on('websocket', (ws) => ws.on('framereceived', (f) => frames.push(String(f.payload))))
  return frames
}

test('qa: selected-tabs read guest gets no marker of a hidden plugin, another project or an unshared tab; the owner browser does', async () => {
  test.setTimeout(180_000)
  const { cockpit: c, close } = await launchCockpit()
  let owner: WebBrowser | undefined
  try {
    for (const [dir, id] of [['qa-leak', 'test.qaleakzq'], ['guest-team', 'test.guestteam']] as const) {
      await c.hook('linkPlugin', join(FIXTURES, dir))
      await c.hook('enablePlugin', c.projectDir, id)
    }
    await pluginActive(c, 'test.qaleakzq')
    // Another project whose folder name and path carry the marker.
    const other = join(dirname(c.projectDir), 'QAZX-otherproj')
    mkdirSync(other)
    await c.hook('openProject', realpathSync(other))
    await expect.poll(() => c.hook('windowLook', realpathSync(other))).not.toBeUndefined()

    // Tab A shared, tab B not: B's title and output carry the marker.
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    const tabs = await c.hook<TabLite[]>('tabs', c.projectDir)
    expect(tabs.length).toBe(2)
    const [a, b] = tabs as [TabLite, TabLite]
    await invoke(c, 'tabs.rename', { tabId: b.id, name: 'QAZX-tabtitle' })
    await invoke(c, 'tabs.input', { tabId: b.id, data: 'QAZX-unsharedout\r' })
    await c.waitForTerminalText('QAZX-unsharedout')

    const web = await enableWebAccess(c)
    await invoke(c, 'settings.pluginGuestAccessSet', { pluginId: 'test.guestteam', target: 'app', value: 'shown' })

    // Positive control: the owner's browser receives the hidden plugin and tab B's markers.
    owner = await openBrowser(web.link)
    await openProjectInBrowser(owner, web.origin, web.projectId)
    const ownerFrames = recordFrames(owner.page)
    await owner.page.reload()
    await owner.page.locator('.tabs-pane').waitFor()

    const inv = await inviteGuest(c, { name: 'Rita', role: 'read', scope: [a.id] })
    const client = await redeemOk(web.origin, inv.token)
    const g = await rawSocket(client)
    const ready = await g.next((f) => f.t === 'ready')
    expect(ready.t).toBe('ready')

    // Live events after the guest is in: the hidden plugin posts, notifies and opens an overlay; tab B prints.
    await c.hook('runPluginCommand', c.projectDir, 'test.qaleakzq/ping')
    await invoke(c, 'tabs.selected', { tabId: b.id }).catch(() => {})
    await invoke(c, 'tabs.input', { tabId: b.id, data: 'QAZX-liveout\r' }) // the overlay covers the terminal
    await c.waitForTerminalText('QAZX-liveout')
    await expect.poll(() => ownerFrames.some((t) => t.includes('QAZX-paneltitle'))).toBe(true)
    await expect.poll(() => ownerFrames.some((t) => t.includes('QAZX-tabtitle'))).toBe(true)

    // Sentinel: the guest's own presence answer comes after everything above.
    const pres = await rawInvoke(g, 'presence.get')
    expect(pres.ok).toBe(true)

    const tabList = await rawInvoke(g, 'tabs.list')
    expect(tabList.ok).toBe(true)
    const seenIds = (tabList.v as TabLite[]).map((t) => t.id)
    expect(seenIds).toEqual([a.id])

    const all = g.texts.join('\n')
    const hits = (needle: string): string[] => g.texts.filter((t) => t.includes(needle)).map((t) => t.slice(0, 300))
    expect(hits('QAZX'), 'a QAZX marker reached the guest socket').toEqual([])
    expect(hits('qaleakzq'), 'the hidden plugin id reached the guest').toEqual([])
    expect(hits(c.projectDir), "the host's project path reached the guest (D-33)").toEqual([])
    expect(all.length).toBeGreaterThan(0)

    // HTTP: the guest's answers carry no marker either.
    for (const path of ['/', '/auth/session', '/api/projects', '/api/sessions', '/api/folders']) {
      const r = await guestGet(client, path)
      expect(r.body.includes('QAZX'), `${path} carries a marker`).toBe(false)
      expect(r.body.includes(c.projectDir), `${path} carries the host path`).toBe(false)
    }

    // Guessed ids: a hidden plugin's panel, an unshared tab, a hidden command answer like nonexistent ones.
    const same = async (ch: string, hidden: unknown, none: unknown): Promise<void> => {
      const h = await rawInvoke(g, ch, hidden)
      const n = await rawInvoke(g, ch, none)
      expect({ ch, ok: h.ok, err: h.err }, `${ch}: hidden vs nonexistent`).toEqual({ ch, ok: n.ok, err: n.err })
      expect(h.ok && h.v !== false, `${ch} accepted a hidden target`).toBe(false)
    }
    await same('panels.connect', { panelKey: 'test.qaleakzq/box', nonce: 1 }, { panelKey: 'test.nopezq/box', nonce: 2 })
    await same('tabs.selected', { tabId: b.id }, { tabId: 'no-such-tab-zq' })
    await same('pageTabs.connect', { tabId: b.id, nonce: 3 }, { tabId: 'no-such-tab-zq', nonce: 4 })
    await same('commands.run', { id: 'test.qaleakzq/ping' }, { id: 'test.nopezq/ping' })

    // A read guest: no input, no new tab, no self-upgrade, no access changes; nothing changes.
    const before = c.pastes().length
    for (const [ch, p] of [
      ['tabs.input', { tabId: a.id, data: 'QAZX-guesttyped\r' }],
      ['tabs.create', { kind: 'shell' }],
      ['tabs.close', { tabId: a.id }],
      ['tabs.rename', { tabId: a.id, name: 'guest-renamed' }],
      ['tabs.flag', { tabId: a.id, flag: { color: 'red' } }],
      ['guests.setRole', { guestId: inv.guestId, role: 'write' }],
      ['guests.setScope', { guestId: inv.guestId, scope: 'all' }],
      ['guests.shareTab', { guestId: inv.guestId, tabId: b.id, shared: true }],
      ['guests.invite', { name: 'Mallory', role: 'write', scope: 'all', lifetime: 'forever' }],
      ['guests.kick', { guestId: inv.guestId }],
      ['guests.list', undefined],
      ['settings.pluginGuestAccessSet', { pluginId: 'test.qaleakzq', target: 'app', value: 'shown' }],
      ['settings.webAccessSet', { value: { mode: 'none' } }],
      ['layout.set', {}]
    ] as const) {
      const r = await rawInvoke(g, ch, p)
      expect(r.ok && r.v !== false && r.v !== null, `${ch} was accepted from a read guest: ${JSON.stringify(r)}`).toBe(false)
    }
    expect(c.pastes().length).toBe(before)
    await c.waitForTerminalText('QAZX-liveout') // B still active and unchanged on the owner
    const after = await c.hook<TabLite[]>('tabs', c.projectDir)
    expect(after.map((t) => t.id)).toEqual(tabs.map((t) => t.id))
    const list = await guestList(c)
    expect(list.map((x) => [x.name, x.role, x.scope])).toEqual([['Rita', 'read', [a.id]]])
    expect(g.texts.join('\n').includes('QAZX')).toBe(false)
    g.close()
  } finally {
    await owner?.close()
    await close()
  }
})
