// 02's own wiring in src/main/index.ts (design-guests §2, §4): what the type checker cannot enforce. A callback
// that drops an argument still type-checks (addView without `who` makes every guest view the owner's, since
// ViewRegistry.addRemote defaults to the owner), and the gateway's and connections' guest stores are optional
// for their own unit tests. Read as text, as the other wiring guards (no-direct-*.test.ts) are.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const INDEX = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8')

/** The text of the object literal passed to `new <name>({`, up to its matching close. */
function depsOf(name: string): string {
  const start = INDEX.indexOf(`new ${name}({`)
  expect(start, name).toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1)
  }
  throw new Error(`unclosed ${name}`)
}

describe("index.ts wires 02's guest deps", () => {
  it('registers every remote view with the who its hello bound', () => {
    const conns = depsOf('WebConnections')
    expect(conns).toContain('addView: (windowId, viewId, sink, who) =>')
    expect(conns).toContain('views.addRemote(windowId, viewId, sink, who)')
  })

  it('gives the connections, the gateway, the access service and the plugin pages the guest store', () => {
    expect(depsOf('WebConnections')).toContain('access: (who) => guestStore.access(who)')
    expect(depsOf('WebConnections')).toContain('context: (viewId, access) => guestContext(guestSources, viewId, access)')
    expect(depsOf('WebGateway')).toContain('guests: guestStore')
    expect(depsOf('WebAccessService')).toContain('guests: guestStore')
    expect(depsOf('PluginPages')).toContain('guestProject: (deviceId) =>')
    expect(depsOf('PluginPages')).toContain('guestPluginVisible: (projectId, pluginId) => guestStore.pluginVisible(projectId, pluginId)')
  })

  it('the guest store reads who from the registry (the one whoOf) and closes views through the connections', () => {
    const store = depsOf('GuestStore')
    expect(store).toContain('whoOfView: (viewId) => views.whoOf(viewId)')
    expect(store).toContain('closeGuestViews: (guestId, code, reason) => webConnections.closeGuest(guestId, code, reason)')
    expect(store).toContain('target: () => webAccess.inviteTarget()')
  })

  it("the owner's guest list follows the store: guests.changed on every change (05's chip and list read it)", () => {
    expect(INDEX).toContain("guestStore.onChange(() => views.toAll('guests.changed', guestStore.list()))")
  })

  it("a view's end reaches the panel port relays and the webview viewers (what a kick's 4460 close tears down)", () => {
    const conns = depsOf('WebConnections')
    const gone = conns.slice(conns.indexOf('viewGone: (viewId) =>'))
    expect(gone).toContain('panelPorts.viewGone(viewId)')
    expect(gone).toContain('webviewViewers.viewGone(viewId)')
    expect(gone).toContain('presence.viewLeft(viewId)')
  })

  it('checks a guest invite pin against the certificate the host presents (D-29)', () => {
    expect(depsOf('RemoteService')).toContain('peerCertificate: (origin) => peerCertificateSha256(origin)')
  })
})
