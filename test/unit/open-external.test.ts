import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOpenExternal, NO_BROWSER_TEXT, urlForLog, type OpenExternal } from '../../src/main/external/open-external'
import { checkOAuthSpec, PluginOAuth } from '../../src/main/oauth/plugin-oauth'
import { ViewRegistry, type ViewSink } from '../../src/main/views/view-registry'
import { remoteViewId } from '../../src/shared/views'

// The openExternal adapter (design-web.md §6.1, §9 "shell.openExternal"): on the desktop the OS
// browser, or a notice in the browser view that asked; in server mode never the OS browser, a
// notice to the asking browser view, the window's browser views, or every window's for 'app'.

/** A view's sink that records the link notices it got. */
class Sink implements ViewSink {
  urls: string[] = []
  /** Every link notice's whole payload, in order. */
  payloads: unknown[] = []
  closed = false
  send(channel: string, payload: unknown): void {
    if (channel !== 'app.linkNotice') return
    this.urls.push((payload as { url: string }).url)
    this.payloads.push(payload)
  }
  isClosed(): boolean {
    return this.closed
  }
}

/**
 * Window 1: desktop (the hidden page in server mode) and browsers web:1, web:2. Window 2: desktop
 * and web:3. Window 3: desktop only (no browser attached).
 */
interface World {
  views: ViewRegistry
  desk1: Sink
  desk2: Sink
  desk3: Sink
  web1: Sink
  web2: Sink
  web3: Sink
}

function world(): World {
  const views = new ViewRegistry({ windowIdOf: () => undefined, log: () => {} })
  const w: World = { views, desk1: new Sink(), desk2: new Sink(), desk3: new Sink(), web1: new Sink(), web2: new Sink(), web3: new Sink() }
  views.addDesktop(1, w.desk1)
  views.addDesktop(2, w.desk2)
  views.addDesktop(3, w.desk3)
  views.addRemote(1, remoteViewId(1), w.web1)
  views.addRemote(1, remoteViewId(2), w.web2)
  views.addRemote(2, remoteViewId(3), w.web3)
  return w
}

let w: World
let system: string[]
let logs: string[]

function adapter(server: boolean): OpenExternal {
  return createOpenExternal({
    server,
    system: async (url) => {
      system.push(url)
    },
    views: w.views,
    log: (m) => logs.push(m)
  })
}

/** Every sink's notices, by name, only the ones that got any. */
function notices(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const name of ['desk1', 'desk2', 'desk3', 'web1', 'web2', 'web3'] as const) {
    if (w[name].urls.length > 0) out[name] = w[name].urls
  }
  return out
}

const URL_A = 'https://example.com/a'

beforeEach(() => {
  w = world()
  system = []
  logs = []
})

describe('openExternal adapter on the desktop', () => {
  it('opens the OS browser for the desktop view, a window with no view, and an app-wide call', async () => {
    const open = adapter(false)
    await open(URL_A, { windowId: 1, viewId: 'desktop:1' })
    await open(URL_A, { windowId: 1 })
    await open(URL_A, 'app')
    expect(system).toEqual([URL_A, URL_A, URL_A])
    expect(notices()).toEqual({})
  })

  it('a browser view that asked gets the notice (v1), only that view, and nothing opens on the host', async () => {
    const open = adapter(false)
    await open(URL_A, { windowId: 1, viewId: 'web:2' })
    expect(system).toEqual([])
    expect(notices()).toEqual({ web2: [URL_A] })
    // Its view gone: nothing, as before (its person left), and still not the host's browser.
    w.web2.closed = true
    await open(URL_A, { windowId: 1, viewId: 'web:2' })
    expect(system).toEqual([])
  })

  it('a sign-in id never reaches the OS browser nor a browser view on the desktop (no paste box there)', async () => {
    const open = adapter(false)
    await open(URL_A, { windowId: 1 }, { signIn: 'S'.repeat(22) })
    await open(URL_A, { windowId: 1, viewId: 'web:1' }, { signIn: 'S'.repeat(22) })
    expect(system).toEqual([URL_A])
    expect(w.web1.payloads).toEqual([{ url: URL_A }])
  })

  it('passes the OS opener\'s failure on', async () => {
    const open = createOpenExternal({ server: false, system: () => Promise.reject(new Error('no handler')), views: w.views, log: () => {} })
    await expect(open(URL_A, 'app')).rejects.toThrow('no handler')
  })
})

describe('openExternal adapter in server mode', () => {
  it('never calls the OS browser, whatever the target', async () => {
    const open = adapter(true)
    await open(URL_A, { windowId: 1, viewId: 'web:1' })
    await open(URL_A, { windowId: 1, viewId: 'desktop:1' })
    await open(URL_A, { windowId: 2 })
    await open(URL_A, 'app')
    await expect(open(URL_A, { windowId: 3 })).rejects.toThrow(NO_BROWSER_TEXT)
    expect(system).toEqual([])
  })

  it('a browser view that asked: the notice reaches that view only', async () => {
    await adapter(true)(URL_A, { windowId: 1, viewId: 'web:1' })
    expect(notices()).toEqual({ web1: [URL_A] })
  })

  it('a window with no view, or the hidden page\'s view: every browser view of that window, none of another', async () => {
    const open = adapter(true)
    await open('https://example.com/no-view', { windowId: 1 })
    await open('https://example.com/hidden', { windowId: 1, viewId: 'desktop:1' })
    expect(notices()).toEqual({
      web1: ['https://example.com/no-view', 'https://example.com/hidden'],
      web2: ['https://example.com/no-view', 'https://example.com/hidden']
    })
  })

  it("'app': every browser view of every window, never a desktop view", async () => {
    await adapter(true)(URL_A, 'app')
    expect(notices()).toEqual({ web1: [URL_A], web2: [URL_A], web3: [URL_A] })
  })

  it('no browser reached: refused, with a log line that has no query, fragment or userinfo', async () => {
    const open = adapter(true)
    const secret = 'https://auth.example/authorize?state=s3cr3t-state&code_challenge=abc#frag'
    await expect(open(secret, { windowId: 3 })).rejects.toThrow(NO_BROWSER_TEXT)
    // The asking view gone: refused too, never sent to another screen of the window.
    w.web1.closed = true
    await expect(open(secret, { windowId: 1, viewId: 'web:1' })).rejects.toThrow(NO_BROWSER_TEXT)
    expect(notices()).toEqual({})
    // 'app' with no browser anywhere.
    const empty = new ViewRegistry({ windowIdOf: () => undefined, log: () => {} })
    empty.addDesktop(1, new Sink())
    const lonely = createOpenExternal({ server: true, system: async () => {}, views: empty, log: (m) => logs.push(m) })
    await expect(lonely(secret, 'app')).rejects.toThrow(NO_BROWSER_TEXT)
    expect(logs).toHaveLength(3)
    for (const line of logs) {
      expect(line).toContain('https://auth.example/authorize')
      expect(line).not.toContain('s3cr3t')
      expect(line).not.toContain('code_challenge')
      expect(line).not.toContain('frag')
    }
  })

  it('urlForLog keeps scheme, host and path only', () => {
    expect(urlForLog('https://user:pw@example.com:8443/p/q?x=1#y')).toBe('https://example.com:8443/p/q')
    expect(urlForLog('not a url')).toBe('(not a URL)')
  })
})

describe("a plugin's sign-in URL in server mode", () => {
  let controller: AbortController

  afterEach(() => controller.abort())

  it('reaches the browsers of the window of the host that asked, and no other', async () => {
    const oauth = new PluginOAuth({ openExternal: adapter(true), log: () => {} })
    const spec = checkOAuthSpec({
      authUrl: 'https://auth.example/authorize',
      tokenUrl: 'https://auth.example/token',
      clientId: 'c',
      scopes: ['read']
    })
    controller = new AbortController()
    const pending = oauth.authorize(spec, controller.signal, { windowId: 2 })
    await expect.poll(() => w.web3.urls.length).toBe(1)
    expect(new URL(w.web3.urls[0]!).origin).toBe('https://auth.example')
    expect(notices()).toEqual({ web3: w.web3.urls })
    // The notice carries the sign-in's id, for its paste box (design-web.md §9.9).
    expect(w.web3.payloads[0]).toEqual({ url: w.web3.urls[0], signIn: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) })
    expect(system).toEqual([])
    controller.abort()
    await expect(pending).rejects.toThrow('cancelled')
  })
})
