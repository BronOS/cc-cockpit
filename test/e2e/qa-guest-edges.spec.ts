// qa-chloe blind verify (not for merge): edge cases. Switching to None with a guest in is refused (D-15);
// two parallel redeems of one invite make one device; a socket without the guest's cookie is never in;
// presence keeps a read guest's view of an unshared tab to "elsewhere".
import { WebSocket } from 'ws'
import type { CockpitApi } from '../../src/shared/ipc'
import { PROTOCOL_VERSION, socketProtocols, WS_PATH } from '../../src/shared/web-protocol'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { guestList, inviteGuest, rawSocket, redeem, redeemOk, type RawSocket } from './guest-fixtures'
import { enableWebAccess } from './web-fixtures'

async function invoke<T>(c: Cockpit, channel: string, payload?: unknown): Promise<T> {
  return c.page.evaluate(
    async ([ch, p]) => ((window as unknown as { cockpit: CockpitApi }).cockpit.invoke as unknown as (c: string, q?: unknown) => Promise<unknown>)(ch, p),
    [channel, payload] as const
  ) as Promise<T>
}

let callId = 9000
async function rawInvoke(s: RawSocket, ch: string, p?: unknown): Promise<{ ok: boolean; v?: unknown; err?: string }> {
  const id = ++callId
  s.ws.send(JSON.stringify({ t: 'invoke', id, ch, p }))
  const f = await s.next((x) => x.t === 'result' && x.id === id, 5000)
  return { ok: f.ok === true, v: f.v, err: typeof f.err === 'string' ? f.err : undefined }
}

interface TabLite {
  id: string
}
interface Person {
  id: string
  name: string
  tabId: string | null
  elsewhere?: true
  typing: boolean
}

test('qa: None refused with a guest in; parallel redeems; no cookie, no entry; presence on an unshared tab', async () => {
  test.setTimeout(120_000)
  const { cockpit: c, close } = await launchCockpit()
  try {
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    const [a, b] = await c.hook<TabLite[]>('tabs', c.projectDir)
    const web = await enableWebAccess(c)

    // Parallel redeems: exactly one device.
    const inv = await inviteGuest(c, { name: 'Pat', role: 'read', scope: [a.id] })
    const both = await Promise.all([redeem(web.origin, inv.token), redeem(web.origin, inv.token)])
    const statuses = both.map((r) => r.status).sort()
    expect(statuses, JSON.stringify(both.map((r) => r.body))).toEqual([200, 410])
    const reader = both.find((r) => r.status === 200)!.client!

    // D-15: switching to None with a guest in is refused and names the guest; the mode stays.
    const reply = await invoke<Record<string, unknown>>(c, 'settings.webAccessSet', { value: { mode: 'none' } }).catch((e: unknown) => ({ thrown: String(e) }))
    console.log('QA None with a guest in:', JSON.stringify(reply).slice(0, 400))
    expect(JSON.stringify(reply)).toContain('Pat')
    const view = await invoke<{ mode?: string; signIn?: string }>(c, 'settings.webAccess')
    expect(JSON.stringify(view)).not.toMatch(/"mode":"none"/)

    // A socket that offers the guest's key but no cookie is not the guest and not the owner.
    const bare = new WebSocket(`ws${web.origin.slice('http'.length)}${WS_PATH}`, socketProtocols(reader.key), { origin: web.origin })
    const bareResult = await new Promise<string>((resolve) => {
      const texts: string[] = []
      bare.on('message', (d) => texts.push(d.toString()))
      bare.on('open', () => bare.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, project: web.projectId })))
      bare.on('unexpected-response', (_q, res) => resolve(`refused ${res.statusCode}`))
      bare.on('close', (code) => resolve(`closed ${code} ${texts.some((t) => t.includes('"ready"')) ? 'AFTER READY' : ''}`))
      bare.on('error', () => resolve('error'))
    })
    console.log('QA bare socket:', bareResult)
    expect(bareResult).not.toContain('AFTER READY')

    // Presence: a write guest on all tabs types in tab B; the read guest (tab A only) sees it "elsewhere".
    const inv2 = await inviteGuest(c, { name: 'Wyn', role: 'write', scope: 'all' })
    const writer = await rawSocket(await redeemOk(web.origin, inv2.token))
    await writer.next((f) => f.t === 'ready')
    const r = await rawSocket(reader)
    await r.next((f) => f.t === 'ready')
    expect((await rawInvoke(writer, 'tabs.selected', { tabId: b.id })).ok).toBe(true)
    expect((await rawInvoke(writer, 'tabs.input', { tabId: b.id, data: 'x' })).ok).toBe(true)
    let people: Person[] = []
    await expect
      .poll(async () => {
        people = ((await rawInvoke(r, 'presence.get')).v as { people: Person[] }).people
        return people.find((p) => p.name === 'Wyn')?.elsewhere === true
      })
      .toBe(true)
    const wyn = people.find((p) => p.name === 'Wyn')!
    console.log('QA read guest sees Wyn:', JSON.stringify(wyn))
    expect(wyn.tabId).toBeNull()
    expect(wyn.typing, 'typing in a tab the read guest cannot see is visible to it').toBe(false)
    const snap = (await rawInvoke(r, 'presence.get')).v as { lastTyped: Record<string, string> }
    expect(Object.keys(snap.lastTyped)).not.toContain(b.id)
    expect((await guestList(c)).length).toBe(2)
  } finally {
    await close()
  }
})
