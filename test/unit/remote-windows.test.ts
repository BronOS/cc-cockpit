// RemoteWindows (main/remote/remote-windows.ts) with a fake window factory and partition: the rules a
// server's page is held to (requests, navigation, page-opened windows), one window per (server,
// project), titles and recent names from the server's project list, the origin moving with the
// tunnel, and the re-pair loop (once, serialised per server, bounded, never for Direct).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteServer } from '../../src/shared/remote-servers'
import { REMOTE_DEVICE_COOKIE } from '../../src/main/remote/remote-cookie'
import {
  MAX_PAIR_ATTEMPTS,
  PAIR_WAIT_MS,
  RemoteWindows,
  allowRemoteNavigation,
  allowRemoteRequest,
  isLoopbackHost,
  isPickerNavigation,
  isProjectSwitch,
  projectOfUrl,
  remotePageUrl,
  remoteTitle,
  tabOfUrl,
  type RemoteSessionHooks,
  type RemoteWindowFactory,
  type RemoteWindowHooks,
  type RemoteWindowView
} from '../../src/main/remote/remote-windows'
import { TUNNEL_RETRY_MS, type LoadGate } from '../../src/main/remote/tunnel-probe'
import { MAX_OPENS_PER_VIEW, OPEN_WINDOW_MS } from '../../src/main/webview/open-budget'
import { FakeCookieStore, FakeJar } from '../fakes/fake-cookie-jar'

const ORIGIN = 'http://127.0.0.1:4100'

describe('the rules', () => {
  it('knows the loopback hosts', () => {
    const host = (url: string) => new URL(url).hostname
    for (const url of [
      'http://localhost/',
      'http://LOCALHOST./',
      'http://app.localhost/',
      'http://127.0.0.1/',
      'http://127.9.8.7/',
      'http://2130706433/',
      'http://0.0.0.0/',
      'http://[::1]/',
      'http://[::]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:0.0.0.0]/',
      'http://[::127.0.0.1]/'
    ]) {
      expect(isLoopbackHost(host(url)), url).toBe(true)
    }
    for (const url of ['http://example.com/', 'http://128.0.0.1/', 'http://10.0.0.1/', 'http://[::2]/', 'http://[::ffff:10.0.0.1]/', 'http://localhost.example/']) {
      expect(isLoopbackHost(host(url)), url).toBe(false)
    }
  })

  it('lets requests reach the server origin only among loopback hosts (SSH)', () => {
    expect(allowRemoteRequest(`${ORIGIN}/api/projects`, ORIGIN)).toBe(true)
    expect(allowRemoteRequest('ws://127.0.0.1:4100/ws', ORIGIN)).toBe(true)
    expect(allowRemoteRequest('http://127.0.0.1:3000/', ORIGIN)).toBe(false)
    expect(allowRemoteRequest('ws://127.0.0.1:3000/', ORIGIN)).toBe(false)
    expect(allowRemoteRequest('http://localhost:4100/', ORIGIN)).toBe(false)
    expect(allowRemoteRequest('http://[::1]:4100/', ORIGIN)).toBe(false)
    expect(allowRemoteRequest('http://0.0.0.0:4100/', ORIGIN)).toBe(false)
    expect(allowRemoteRequest('https://127.0.0.1:4100/', ORIGIN)).toBe(false)
    expect(allowRemoteRequest('https://example.com/x.png', ORIGIN)).toBe(true)
    expect(allowRemoteRequest('data:text/plain,x', ORIGIN)).toBe(true)
    expect(allowRemoteRequest('not a url', ORIGIN)).toBe(false)
  })

  it('cancels every loopback host for a Direct server on a real address, or with no origin', () => {
    const direct = 'https://box.example'
    expect(allowRemoteRequest('https://box.example/auth/session', direct)).toBe(true)
    expect(allowRemoteRequest('wss://box.example/ws', direct)).toBe(true)
    expect(allowRemoteRequest('http://127.0.0.1:4100/', direct)).toBe(false)
    expect(allowRemoteRequest('http://localhost/', direct)).toBe(false)
    expect(allowRemoteRequest('http://127.0.0.1:4100/', undefined)).toBe(false)
    expect(allowRemoteRequest('https://example.com/', undefined)).toBe(true)
  })

  it('pins navigation to the server origin', () => {
    expect(allowRemoteNavigation(`${ORIGIN}/?project=p`, ORIGIN)).toBe(true)
    expect(allowRemoteNavigation('http://127.0.0.1:4101/', ORIGIN)).toBe(false)
    expect(allowRemoteNavigation('https://example.com/', ORIGIN)).toBe(false)
    expect(allowRemoteNavigation('javascript:alert(1)', ORIGIN)).toBe(false)
    expect(allowRemoteNavigation('data:text/html,x', ORIGIN)).toBe(false)
    expect(allowRemoteNavigation(`${ORIGIN}/`, undefined)).toBe(false)
  })

  it('tells a project page going back to the server picker', () => {
    const from = `${ORIGIN}/?project=p1`
    expect(isPickerNavigation(from, `${ORIGIN}/`, ORIGIN)).toBe(true)
    expect(isPickerNavigation(from, `${ORIGIN}/?project=`, ORIGIN)).toBe(true)
    // Close project replaces the URL with the page's own path (a reverse-proxy prefix kept).
    expect(isPickerNavigation(`${ORIGIN}/cc/?project=p1`, `${ORIGIN}/cc/`, ORIGIN)).toBe(true)
    expect(isPickerNavigation(from, `${ORIGIN}/other`, ORIGIN)).toBe(false)
    expect(isPickerNavigation(from, `${ORIGIN}/?project=p2`, ORIGIN)).toBe(false)
    expect(isPickerNavigation(from, `${ORIGIN}/?project=p1`, ORIGIN)).toBe(false)
    // From the picker, or another origin: not this.
    expect(isPickerNavigation(`${ORIGIN}/`, `${ORIGIN}/`, ORIGIN)).toBe(false)
    expect(isPickerNavigation('data:text/plain,x', `${ORIGIN}/`, ORIGIN)).toBe(false)
    expect(isPickerNavigation(from, 'http://127.0.0.1:4101/', ORIGIN)).toBe(false)
    expect(isPickerNavigation(from, `${ORIGIN}/`, undefined)).toBe(false)
  })

  it('tells a project page going to another project', () => {
    const from = `${ORIGIN}/?project=p1`
    expect(isProjectSwitch(from, `${ORIGIN}/?project=p2`, ORIGIN)).toBe(true)
    expect(isProjectSwitch(from, `${ORIGIN}/?project=p2&tab=t1`, ORIGIN)).toBe(true)
    // The same project (a tab param, an in-page change), the picker, from the picker, off the origin.
    expect(isProjectSwitch(from, `${ORIGIN}/?project=p1&tab=t1`, ORIGIN)).toBe(false)
    expect(isProjectSwitch(from, `${ORIGIN}/`, ORIGIN)).toBe(false)
    expect(isProjectSwitch(`${ORIGIN}/`, `${ORIGIN}/?project=p2`, ORIGIN)).toBe(false)
    expect(isProjectSwitch(from, 'http://127.0.0.1:4101/?project=p2', ORIGIN)).toBe(false)
    expect(isProjectSwitch('data:text/plain,x', `${ORIGIN}/?project=p2`, ORIGIN)).toBe(false)
    expect(isProjectSwitch(from, `${ORIGIN}/?project=p2`, undefined)).toBe(false)
  })

  it('reads the project, builds page URLs and titles', () => {
    expect(projectOfUrl(`${ORIGIN}/?project=abc`)).toBe('abc')
    expect(projectOfUrl(`${ORIGIN}/`)).toBeUndefined()
    expect(projectOfUrl(`${ORIGIN}/?project=`)).toBeUndefined()
    expect(projectOfUrl(`${ORIGIN}/?project=${'x'.repeat(201)}`)).toBeUndefined()
    expect(remotePageUrl(ORIGIN)).toBe(`${ORIGIN}/`)
    expect(remotePageUrl(ORIGIN, 'a b', 't/1')).toBe(`${ORIGIN}/?project=a%20b#t=t%2F1`)
    // The tab a project page selects once loaded (a session chip of another project); none on the picker.
    expect(remotePageUrl(ORIGIN, 'p1', undefined, 'a&b')).toBe(`${ORIGIN}/?project=p1&tab=a%26b`)
    expect(remotePageUrl(ORIGIN, undefined, undefined, 't1')).toBe(`${ORIGIN}/`)
    expect(tabOfUrl(`${ORIGIN}/?project=p1&tab=a%26b`)).toBe('a&b')
    expect(tabOfUrl(`${ORIGIN}/?project=p1&tab=`)).toBeUndefined()
    expect(tabOfUrl(`${ORIGIN}/?project=p1&tab=${'x'.repeat(201)}`)).toBeUndefined()
    expect(remoteTitle('devbox')).toBe('devbox')
    expect(remoteTitle('devbox', 'api\u0007 ')).toBe('devbox — api')
    expect(remoteTitle('devbox', '\u0001')).toBe('devbox')
  })
})

// ---------------------------------------------------------------------------------------------

let nextId = 1

class FakeView implements RemoteWindowView {
  readonly id = nextId++
  readonly webContentsId = 1000 + this.id
  readonly loads: string[] = []
  readonly errors: string[] = []
  reloads = 0
  focuses = 0
  closed = false
  title: string
  current = ''

  constructor(
    readonly serverId: string,
    title: string,
    readonly hooks: RemoteWindowHooks
  ) {
    this.title = title
  }

  load(url: string): void {
    this.loads.push(url)
    this.current = url
  }
  reload(): void {
    this.reloads++
  }
  focus(): void {
    this.focuses++
  }
  setTitle(title: string): void {
    this.title = title
  }
  url(): string {
    return this.current
  }
  showError(text: string): void {
    this.errors.push(text)
    this.current = 'data:text/plain,error'
    this.hooks.navigated(this.current)
    this.hooks.loaded()
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.hooks.closed()
  }

  /** The page committed `url` (a load or in-page) and finished loading. */
  commit(url: string): void {
    this.current = url
    this.hooks.navigated(url)
    this.hooks.loaded()
  }
}

type Fetcher = (url: string) => Promise<unknown>
type Poster = (url: string, body: unknown, origin: string) => Promise<{ status: number; body: unknown }>

class FakeFactory implements RemoteWindowFactory {
  readonly views: FakeView[] = []
  readonly sessions = new Map<string, { hooks: RemoteSessionHooks; jar: FakeJar; fetches: string[]; posts: Array<{ url: string; body: unknown; origin: string }> }>()
  readonly events: string[] = []
  fetcher: Fetcher = async () => ({ mode: 'link', device: { id: 'd1', name: 'x' } })
  /** The reopen POST; by default an old gateway with no such route (the page loads as is). */
  poster: Poster = async () => ({ status: 404, body: undefined })

  session(serverId: string, hooks: RemoteSessionHooks) {
    this.events.push(`session ${serverId}`)
    const jar = new FakeJar()
    const origSet = jar.set.bind(jar)
    jar.set = async (details) => {
      this.events.push(`cookie ${details.value}`)
      await origSet(details)
    }
    const entry = { hooks, jar, fetches: [] as string[], posts: [] as Array<{ url: string; body: unknown; origin: string }> }
    this.sessions.set(serverId, entry)
    return {
      jar,
      fetchJson: (url: string) => {
        entry.fetches.push(url)
        return this.fetcher(url)
      },
      postJson: (url: string, body: unknown, origin: string) => {
        this.events.push(`post ${url} ${JSON.stringify(body)}`)
        entry.posts.push({ url, body, origin })
        return this.poster(url, body, origin)
      }
    }
  }

  create(serverId: string, title: string, hooks: RemoteWindowHooks): FakeView {
    const view = new FakeView(serverId, title, hooks)
    const load = view.load.bind(view)
    view.load = (url) => {
      this.events.push(`load ${url}`)
      load(url)
    }
    this.views.push(view)
    return view
  }

  session1(id = 's1') {
    const s = this.sessions.get(id)
    if (s === undefined) throw new Error('no session')
    return s
  }
}

class FakeStore extends FakeCookieStore {
  readonly servers = new Map<string, Omit<RemoteServer, 'cookie'>>()
  readonly recent: Array<[string, string, string]> = []
  get(id: string) {
    return this.servers.get(id)
  }
  recordRecent(id: string, projectId: string, name: string): void {
    this.recent.push([id, projectId, name])
  }
}

function setup() {
  const factory = new FakeFactory()
  const store = new FakeStore()
  store.servers.set('s1', { id: 's1', name: 'devbox', via: { kind: 'ssh', host: 'devbox' }, recent: [] })
  store.servers.set('d1', { id: 'd1', name: 'box', via: { kind: 'direct', origin: 'https://box.example' }, recent: [] })
  const external: string[] = []
  const minted: string[] = []
  const allClosed: string[] = []
  const logs: string[] = []
  let changes = 0
  let clock = 1_000_000
  let tokens = 0
  let pickers = 0
  const options = {
    factory,
    store,
    showPicker: () => void pickers++,
    openExternal: (url: string) => void external.push(url),
    mintToken: vi.fn(async (server: Omit<RemoteServer, 'cookie'>) => {
      minted.push(server.id)
      return `tok${++tokens}`
    }),
    onAllClosed: (id: string) => void allClosed.push(id),
    onChanged: () => void changes++,
    now: () => clock,
    log: (m: string) => void logs.push(m)
  }
  const windows = new RemoteWindows(options)
  return {
    factory,
    store,
    windows,
    options,
    external,
    minted,
    allClosed,
    logs,
    changes: () => changes,
    pickers: () => pickers,
    tick: (ms: number) => {
      clock += ms
    }
  }
}

/** Let promise chains run (fetches, the cookie store). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const projects = { projects: [{ id: 'p1', name: 'Api', path: '/srv/api' }], recent: [{ id: 'p2', name: 'Web', path: '/srv/web', missing: false }] }
const signedIn = { mode: 'link', device: { id: 'd1', name: 'x' } }
const signedOut = { mode: 'link', device: null }

describe('RemoteWindows: windows', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
    t.factory.fetcher = async (url) => (url.endsWith('/api/projects') ? projects : signedIn)
  })

  it('restores the cookie before the first load, then loads the project page', async () => {
    t.store.saved = 'dev-1'
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    await flush()
    expect(t.factory.events).toEqual(['session s1', 'cookie dev-1', `load ${ORIGIN}/?project=p1`])
    expect(t.windows.count()).toBe(1)
    expect(t.changes()).toBe(1)
  })

  it('titles the window with the server and the project name and records the recent project', async () => {
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    const view = t.factory.views[0] as FakeView
    await flush()
    expect(view.title).toBe('devbox — Api')
    expect(t.store.recent).toEqual([['s1', 'p1', 'Api']])
    // The title's lookup, and the open check before the load.
    expect(t.factory.session1().fetches).toEqual([`${ORIGIN}/api/projects`, `${ORIGIN}/api/projects`])
    // An in-page change of the same project asks nothing again.
    view.hooks.navigated(`${ORIGIN}/?project=p1#x`)
    await flush()
    expect(t.factory.session1().fetches).toHaveLength(2)
  })

  it('finds a name among the recent projects too; an unknown one keeps the server name', async () => {
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p2' })
    await flush()
    expect(t.factory.views[0]?.title).toBe('devbox — Web')
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'nope' })
    await flush()
    expect(t.factory.views[1]?.title).toBe('devbox')
    expect(t.store.recent.map((r) => r[1])).toEqual(['p2'])
  })

  it('a failed project list leaves the server name and asks again on the next navigation', async () => {
    t.factory.fetcher = async () => {
      throw new Error('the server answered 401')
    }
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    await flush()
    const view = t.factory.views[0] as FakeView
    expect(view.title).toBe('devbox')
    t.factory.fetcher = async (url) => (url.endsWith('/api/projects') ? projects : signedIn)
    view.hooks.navigated(`${ORIGIN}/?project=p1`)
    await flush()
    expect(view.title).toBe('devbox — Api')
  })

  it('focuses the window that shows a project instead of opening a second one', async () => {
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    expect(t.factory.views).toHaveLength(1)
    expect(t.factory.views[0]?.focuses).toBe(1)
    // The picker is its own window, once.
    await t.windows.open('s1', { origin: ORIGIN })
    await t.windows.open('s1', { origin: ORIGIN })
    expect(t.factory.views).toHaveLength(2)
    expect(t.factory.views[1]?.loads).toEqual([`${ORIGIN}/`])
  })

  it('tracks the project the server picker navigates to', async () => {
    await t.windows.open('s1', { origin: ORIGIN })
    const picker = t.factory.views[0] as FakeView
    picker.commit(`${ORIGIN}/?project=p1`)
    await flush()
    expect(picker.title).toBe('devbox — Api')
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    expect(t.factory.views).toHaveLength(1)
    expect(picker.focuses).toBe(1)
    // Back to the picker: the server's name alone.
    picker.commit(`${ORIGIN}/`)
    expect(picker.title).toBe('devbox')
  })

  it('a second window navigated to a shown project focuses the first and goes back to the picker', async () => {
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    await t.windows.open('s1', { origin: ORIGIN })
    const [first, second] = t.factory.views as [FakeView, FakeView]
    second.commit(`${ORIGIN}/?project=p1`)
    expect(first.focuses).toBe(1)
    expect(second.loads.at(-1)).toBe(`${ORIGIN}/`)
    expect(second.title).toBe('devbox')
    // The second one is a picker again, so opening the project still finds the first.
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    expect(first.focuses).toBe(2)
    expect(t.factory.views).toHaveLength(2)
  })

  it('ignores navigations off the origin (the error page) for tracking', async () => {
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    const view = t.factory.views[0] as FakeView
    view.hooks.navigated('data:text/plain,oops')
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    expect(t.factory.views).toHaveLength(1)
  })

  it('keeps windows of different servers apart', async () => {
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    await t.windows.open('d1', { origin: 'https://box.example', projectId: 'p1' })
    expect(t.factory.views).toHaveLength(2)
    expect(t.windows.countOf('s1')).toBe(1)
    expect(t.windows.countOf('d1')).toBe(1)
  })

  it('reports the last window of a server closing', async () => {
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    await t.windows.open('s1', { origin: ORIGIN })
    const [a, b] = t.factory.views as [FakeView, FakeView]
    a.close()
    expect(t.allClosed).toEqual([])
    expect(t.windows.count()).toBe(1)
    b.close()
    expect(t.allClosed).toEqual(['s1'])
    expect(t.windows.count()).toBe(0)
    expect(t.windows.focusAny()).toBe(false)
  })

  it('reloads a server windows at the new origin when the tunnel moves', async () => {
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    await t.windows.open('s1', { origin: ORIGIN })
    t.store.saved = 'dev-1'
    await t.windows.setOrigin('s1', 'http://127.0.0.1:4200')
    expect(t.factory.views.map((v) => v.loads.at(-1))).toEqual(['http://127.0.0.1:4200/?project=p1', 'http://127.0.0.1:4200/'])
    expect(t.factory.session1().jar.sets.at(-1)?.url).toBe('http://127.0.0.1:4200/')
    // The rules follow the new origin.
    expect(t.factory.session1().hooks.allowRequest('http://127.0.0.1:4200/ws')).toBe(true)
    expect(t.factory.session1().hooks.allowRequest('http://127.0.0.1:4100/ws')).toBe(false)
    expect(t.factory.views[0]?.hooks.allowNavigation('http://127.0.0.1:4100/')).toBe(false)
    // The same origin again: nothing.
    await t.windows.setOrigin('s1', 'http://127.0.0.1:4200')
    expect(t.factory.views[0]?.loads).toHaveLength(2)
  })

  it('hands page-opened http(s) windows to the person browser under the budget', async () => {
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    const view = t.factory.views[0] as FakeView
    view.hooks.openWindow('file:///etc/passwd')
    view.hooks.openWindow('javascript:alert(1)')
    for (let i = 0; i < MAX_OPENS_PER_VIEW + 1; i++) view.hooks.openWindow(`https://example.com/${i}`)
    await flush()
    expect(t.external).toEqual(Array.from({ length: MAX_OPENS_PER_VIEW }, (_, i) => `https://example.com/${i}`))
    expect(t.logs.some((l) => l.includes('dropped a window.open'))).toBe(true)
    t.tick(OPEN_WINDOW_MS)
    view.hooks.openWindow('https://example.com/later')
    await flush()
    expect(t.external.at(-1)).toBe('https://example.com/later')
  })

  it('refreshes titles after a rename, and forget closes the windows', async () => {
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    await flush()
    t.store.servers.set('s1', { id: 's1', name: 'work', via: { kind: 'ssh', host: 'devbox' }, recent: [] })
    t.windows.refreshTitles('s1')
    await flush()
    expect(t.factory.views[0]?.title).toBe('work — Api')
    t.windows.forget('s1')
    expect(t.factory.views[0]?.closed).toBe(true)
    expect(t.windows.count()).toBe(0)
    // The partition's listeners find no server: loopback refused.
    expect(t.factory.session1().hooks.allowRequest(`${ORIGIN}/`)).toBe(false)
  })

  it('refuses an unknown server', async () => {
    await expect(t.windows.open('zz', { origin: ORIGIN })).rejects.toThrow('unknown server')
  })
})

describe('RemoteWindows: back to the picker', () => {
  let t: ReturnType<typeof setup>
  let open: { projects: Array<{ id: string; name: string; path: string }> }
  beforeEach(() => {
    t = setup()
    open = { projects: [{ id: 'p1', name: 'Api', path: '/srv/api' }] }
    t.factory.fetcher = async (url) => (url.endsWith('/api/projects') ? open : signedIn)
  })

  async function projectWindow(): Promise<FakeView> {
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    const view = t.factory.views.at(-1) as FakeView
    view.commit(`${ORIGIN}/?project=p1`)
    await flush()
    return view
  }

  it('the tab strip "+" shows the desktop picker and keeps the window (the project is still open)', async () => {
    const view = await projectWindow()
    const fetches = t.factory.session1().fetches.length
    expect(view.hooks.allowNavigation(`${ORIGIN}/`)).toBe(false)
    expect(t.pickers()).toBe(1)
    await flush()
    expect(t.factory.session1().fetches.slice(fetches)).toEqual([`${ORIGIN}/api/projects`])
    expect(view.closed).toBe(false)
    expect(t.windows.count()).toBe(1)
  })

  it('Close project shows the desktop picker and closes the window (the project is no longer open)', async () => {
    const view = await projectWindow()
    open = { projects: [] }
    expect(view.hooks.allowNavigation(`${ORIGIN}/`)).toBe(false)
    expect(t.pickers()).toBe(1)
    await flush()
    expect(view.closed).toBe(true)
    expect(t.windows.count()).toBe(0)
    expect(t.allClosed).toEqual(['s1'])
  })

  it('keeps the window when the server does not answer, or answers something else', async () => {
    const view = await projectWindow()
    t.factory.fetcher = async () => {
      throw new Error('the server answered 401')
    }
    expect(view.hooks.allowNavigation(`${ORIGIN}/`)).toBe(false)
    await flush()
    expect(view.closed).toBe(false)
    expect(t.logs.some((l) => l.includes('the window stays'))).toBe(true)
    t.factory.fetcher = async () => ({ nope: true })
    expect(view.hooks.allowNavigation(`${ORIGIN}/`)).toBe(false)
    await flush()
    expect(view.closed).toBe(false)
    expect(t.pickers()).toBe(2)
  })

  it('leaves the server picker window own navigation alone', async () => {
    await t.windows.open('s1', { origin: ORIGIN })
    const picker = t.factory.views[0] as FakeView
    picker.commit(`${ORIGIN}/`)
    const fetches = t.factory.session1().fetches.length
    expect(picker.hooks.allowNavigation(`${ORIGIN}/`)).toBe(true)
    expect(picker.hooks.allowNavigation(`${ORIGIN}/?project=p1`)).toBe(true)
    // Within the project, and off the origin, as before.
    const view = await projectWindow()
    expect(view.hooks.allowNavigation(`${ORIGIN}/?project=p1&tab=t1`)).toBe(true)
    expect(view.hooks.allowNavigation('https://example.com/')).toBe(false)
    expect(t.pickers()).toBe(0)
    await flush()
    // The project window's title and its open check; nothing for the navigations.
    expect(t.factory.session1().fetches.slice(fetches).filter((u) => u.endsWith('/api/projects')).length).toBe(2)
  })
})

// A session chip of another project clicked in a remote window: the server sends that view to the
// other project's page (`project.goto`); here it gets its own window instead.
describe('RemoteWindows: another project from a project page', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
    const open = {
      projects: [
        { id: 'p1', name: 'Api', path: '/srv/api' },
        { id: 'p2', name: 'Web', path: '/srv/web' }
      ]
    }
    t.factory.fetcher = async (url) => (url.endsWith('/api/projects') ? open : signedIn)
  })

  async function projectWindow(projectId: string): Promise<FakeView> {
    await t.windows.open('s1', { origin: ORIGIN, projectId })
    const view = t.factory.views.at(-1) as FakeView
    view.commit(`${ORIGIN}/?project=${projectId}`)
    await flush()
    return view
  }

  it("opens the other project's own window with the tab, and this one stays on its project", async () => {
    const first = await projectWindow('p1')
    expect(first.hooks.allowNavigation(`${ORIGIN}/?project=p2&tab=t9`)).toBe(false)
    await flush()
    expect(t.factory.views).toHaveLength(2)
    const second = t.factory.views[1] as FakeView
    expect(second.loads).toEqual([`${ORIGIN}/?project=p2&tab=t9`])
    expect(first.loads).toEqual([`${ORIGIN}/?project=p1`])
    expect(first.closed).toBe(false)
    expect(t.pickers()).toBe(0)
    // One window per project: the page dropping `tab` from its address is still p2's window.
    second.commit(`${ORIGIN}/?project=p2`)
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    expect(first.focuses).toBe(1)
    expect(t.factory.views).toHaveLength(2)
  })

  it('focuses the window that shows the other project already, opening nothing', async () => {
    const first = await projectWindow('p1')
    const second = await projectWindow('p2')
    expect(first.hooks.allowNavigation(`${ORIGIN}/?project=p2&tab=t9`)).toBe(false)
    await flush()
    expect(t.factory.views).toHaveLength(2)
    expect(second.focuses).toBe(1)
    expect(second.loads).toEqual([`${ORIGIN}/?project=p2`])
    // No tab: the same.
    expect(second.hooks.allowNavigation(`${ORIGIN}/?project=p1`)).toBe(false)
    await flush()
    expect(first.focuses).toBe(1)
    expect(t.factory.views).toHaveLength(2)
  })
})

// A recent project the server closed (design §4): main asks the project list, reopens it with the
// server's own POST, then loads the id the server answered.
describe('RemoteWindows: a project the server closed', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
    t.factory.fetcher = async (url) => (url.endsWith('/api/projects') ? projects : signedIn)
    t.factory.poster = async () => ({ status: 200, body: { id: 'p2' } })
  })

  it('loads a project that is open with no POST', async () => {
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    await flush()
    expect(t.factory.session1().posts).toEqual([])
    expect(t.factory.views[0]?.loads).toEqual([`${ORIGIN}/?project=p1`])
  })

  it('reopens a closed one with the server origin, then loads the id it answered', async () => {
    t.factory.poster = async () => ({ status: 200, body: { id: 'p2-new' } })
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p2' })
    await flush()
    expect(t.factory.session1().posts).toEqual([{ url: `${ORIGIN}/api/projects`, body: { reopen: 'p2' }, origin: ORIGIN }])
    const view = t.factory.views[0] as FakeView
    expect(view.loads).toEqual([`${ORIGIN}/?project=p2-new`])
    expect(t.factory.events.filter((e) => !e.startsWith('session'))).toEqual([`post ${ORIGIN}/api/projects {"reopen":"p2"}`, `load ${ORIGIN}/?project=p2-new`])
    expect(view.errors).toEqual([])
  })

  it('shows the server refusal on the error page and loads nothing', async () => {
    t.factory.poster = async () => ({ status: 400, body: { error: 'The folder /srv/web is missing.\u0007' } })
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p2' })
    await flush()
    const view = t.factory.views[0] as FakeView
    expect(view.loads).toEqual([])
    expect(view.errors).toEqual(['devbox could not reopen this project: The folder /srv/web is missing.'])
  })

  it('a project the server forgot entirely is its error too', async () => {
    t.factory.poster = async () => ({ status: 400, body: { error: 'not a recent project' } })
    await t.windows.open('d1', { origin: 'https://box.example', projectId: 'gone' })
    await flush()
    const view = t.factory.views[0] as FakeView
    expect(t.factory.session1('d1').posts[0]?.origin).toBe('https://box.example')
    expect(view.loads).toEqual([])
    expect(view.errors).toEqual(['box could not reopen this project: not a recent project'])
  })

  it('loads the page as before when the list or the POST does not answer, or the session is signed out', async () => {
    t.factory.fetcher = async () => {
      throw new Error('the server answered 401')
    }
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p2' })
    await flush()
    expect(t.factory.session1().posts).toEqual([])
    expect(t.factory.views[0]?.loads).toEqual([`${ORIGIN}/?project=p2`])
    // The list answers, the POST does not (or says signed out, or the gateway has no such route).
    t.factory.fetcher = async (url) => (url.endsWith('/api/projects') ? projects : signedIn)
    const answers: Poster[] = [
      async () => {
        throw new Error('net::ERR_CONNECTION_RESET')
      },
      async () => ({ status: 401, body: { error: 'not signed in' } }),
      async () => ({ status: 404, body: undefined })
    ]
    for (const [i, poster] of answers.entries()) {
      t.factory.poster = poster
      await t.windows.open('s1', { origin: ORIGIN, projectId: `x${i}` })
      await flush()
      const view = t.factory.views.at(-1) as FakeView
      expect(view.loads).toEqual([`${ORIGIN}/?project=x${i}`])
      expect(view.errors).toEqual([])
    }
  })

  it('a window closed while the server is asked loads nothing', async () => {
    let answer: (v: { status: number; body: unknown }) => void = () => undefined
    t.factory.poster = () => new Promise((resolve) => (answer = resolve))
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p2' })
    await flush()
    const view = t.factory.views[0] as FakeView
    view.close()
    answer({ status: 200, body: { id: 'p2' } })
    await flush()
    expect(view.loads).toEqual([])
  })
})

describe('RemoteWindows: re-pair', () => {
  let t: ReturnType<typeof setup>
  /** What SESSION_PATH answers now. */
  let session: unknown
  beforeEach(() => {
    vi.useFakeTimers()
    t = setup()
    session = signedOut
    t.factory.fetcher = async (url) => (url.endsWith('/api/projects') ? projects : session)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** The page signs in with the token it was given: the server sets the cookie, with an expiry. */
  function pageSignsIn(id = 's1', value = 'dev-new'): void {
    session = signedIn
    t.factory.session1(id).jar.put({ name: REMOTE_DEVICE_COOKIE, value, domain: '127.0.0.1', expirationDate: Date.now() / 1000 + 86_400 })
  }

  it('a signed-out page gets one add-device link, then the other windows reload', async () => {
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    await t.windows.open('s1', { origin: ORIGIN })
    const [a, b] = t.factory.views as [FakeView, FakeView]
    a.commit(`${ORIGIN}/?project=p1`)
    await flush()
    expect(t.minted).toEqual(['s1'])
    expect(a.loads.at(-1)).toBe(`${ORIGIN}/?project=p1#t=tok1`)
    expect(b.reloads).toBe(0)
    pageSignsIn()
    await t.windows.settled('s1')
    expect(b.reloads).toBe(1)
    expect(a.reloads).toBe(0)
    expect(t.store.saved).toBe('dev-new')
    expect(t.minted).toEqual(['s1'])
    expect(a.errors).toEqual([])
  })

  it('serialises: two windows asking at once mint one token', async () => {
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    await t.windows.open('s1', { origin: ORIGIN })
    const [a, b] = t.factory.views as [FakeView, FakeView]
    a.commit(`${ORIGIN}/?project=p1`)
    b.commit(`${ORIGIN}/`)
    // The page's own SESSION_PATH requests are triggers too.
    t.factory.session1().hooks.sessionRequestCompleted(a.webContentsId)
    t.factory.session1().hooks.sessionRequestCompleted(b.webContentsId)
    await flush()
    expect(t.minted).toEqual(['s1'])
    pageSignsIn()
    await t.windows.settled('s1')
    expect(t.minted).toEqual(['s1'])
    expect(b.reloads).toBe(1)
  })

  it('a page signed in does not mint', async () => {
    session = signedIn
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    ;(t.factory.views[0] as FakeView).commit(`${ORIGIN}/?project=p1`)
    await t.windows.settled('s1')
    expect(t.minted).toEqual([])
  })

  it('a second failure in a row shows the error instead of minting again', async () => {
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    const a = t.factory.views[0] as FakeView
    a.commit(`${ORIGIN}/?project=p1`)
    await flush()
    expect(t.minted).toHaveLength(1)
    // The cookie never lands.
    await vi.advanceTimersByTimeAsync(PAIR_WAIT_MS)
    expect(t.minted).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(PAIR_WAIT_MS)
    await t.windows.settled('s1')
    expect(t.minted).toHaveLength(MAX_PAIR_ATTEMPTS)
    expect(a.errors).toHaveLength(1)
    expect(a.errors[0]).toContain('devbox did not take')
    // The error page's own load triggers nothing, and neither does a later load.
    a.commit(`${ORIGIN}/?project=p1`)
    await vi.advanceTimersByTimeAsync(PAIR_WAIT_MS * 3)
    expect(t.minted).toHaveLength(MAX_PAIR_ATTEMPTS)
    expect(a.errors).toHaveLength(2)
  })

  it('a cookie that lands but does not sign in is bounded too', async () => {
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    const a = t.factory.views[0] as FakeView
    const jar = t.factory.session1().jar
    t.options.mintToken.mockImplementation(async () => {
      // The cookie lands each time, but the server still says no device.
      setTimeout(() => jar.put({ name: REMOTE_DEVICE_COOKIE, value: `v${Math.random()}`, domain: '127.0.0.1', expirationDate: 1e10 }), 10)
      return 'tok'
    })
    a.commit(`${ORIGIN}/?project=p1`)
    await vi.advanceTimersByTimeAsync(100)
    await t.windows.settled('s1')
    expect(t.options.mintToken).toHaveBeenCalledTimes(MAX_PAIR_ATTEMPTS)
    expect(a.errors).toHaveLength(1)
  })

  it('opening from the picker starts the count again', async () => {
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    const a = t.factory.views[0] as FakeView
    a.commit(`${ORIGIN}/?project=p1`)
    await vi.advanceTimersByTimeAsync(PAIR_WAIT_MS * 3)
    await t.windows.settled('s1')
    expect(t.minted).toHaveLength(2)
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    a.commit(`${ORIGIN}/?project=p1`)
    await flush()
    expect(t.minted).toHaveLength(3)
  })

  it('a token that cannot be minted shows ssh\'s error', async () => {
    t.options.mintToken.mockRejectedValueOnce(new Error('Permission denied (publickey).'))
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    const a = t.factory.views[0] as FakeView
    a.commit(`${ORIGIN}/?project=p1`)
    await t.windows.settled('s1')
    expect(a.errors).toEqual(['Signing in to devbox again failed: Permission denied (publickey).'])
  })

  it('password mode is the server page own business', async () => {
    session = { mode: 'password', device: null }
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    ;(t.factory.views[0] as FakeView).commit(`${ORIGIN}/?project=p1`)
    await t.windows.settled('s1')
    expect(t.minted).toEqual([])
  })

  it('Direct never re-pairs (and never asks)', async () => {
    await t.windows.open('d1', { origin: 'https://box.example', projectId: 'p1' })
    const a = t.factory.views[0] as FakeView
    a.commit('https://box.example/?project=p1')
    t.factory.session1('d1').hooks.sessionRequestCompleted(a.webContentsId)
    await flush()
    expect(t.minted).toEqual([])
    expect(t.factory.session1('d1').fetches.filter((u) => u.endsWith('/auth/session'))).toEqual([])
  })

  it('a window opened with a token waits for its sign-in instead of minting another', async () => {
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1', token: 'given' })
    const a = t.factory.views[0] as FakeView
    expect(a.loads).toEqual([`${ORIGIN}/?project=p1#t=given`])
    // The page's first SESSION_PATH (before it posts the token) says no device: a trigger, held.
    a.commit(`${ORIGIN}/?project=p1`)
    t.factory.session1().hooks.sessionRequestCompleted(a.webContentsId)
    await flush()
    expect(t.minted).toEqual([])
    pageSignsIn()
    await t.windows.settled('s1')
    expect(t.minted).toEqual([])
    expect(t.store.saved).toBe('dev-new')
  })

  it('a sign-in that lands on a project the server closed reopens it, then loads it', async () => {
    t.factory.poster = async () => ({ status: 200, body: { id: 'p2' } })
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p2', token: 'given' })
    const a = t.factory.views[0] as FakeView
    expect(a.loads).toEqual([`${ORIGIN}/?project=p2#t=given`])
    a.commit(`${ORIGIN}/?project=p2`)
    pageSignsIn()
    await t.windows.settled('s1')
    await flush()
    expect(t.factory.session1().posts.map((p) => p.body)).toEqual([{ reopen: 'p2' }])
    expect(a.loads).toEqual([`${ORIGIN}/?project=p2#t=given`, `${ORIGIN}/?project=p2`])
  })

  it('a sign-in that lands on an open project loads nothing more', async () => {
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1', token: 'given' })
    const a = t.factory.views[0] as FakeView
    a.commit(`${ORIGIN}/?project=p1`)
    pageSignsIn()
    await t.windows.settled('s1')
    await flush()
    expect(t.factory.session1().posts).toEqual([])
    expect(a.loads).toEqual([`${ORIGIN}/?project=p1#t=given`])
  })

  it('a given token that never signs in re-pairs once the wait is over', async () => {
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1', token: 'stale' })
    const a = t.factory.views[0] as FakeView
    a.commit(`${ORIGIN}/?project=p1`)
    await flush()
    expect(t.minted).toEqual([])
    await vi.advanceTimersByTimeAsync(PAIR_WAIT_MS)
    expect(t.minted).toEqual(['s1'])
    expect(a.loads.at(-1)).toBe(`${ORIGIN}/?project=p1#t=tok1`)
  })

  it('ignores session requests of a window it does not know or of another server', async () => {
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    await t.windows.open('d1', { origin: 'https://box.example' })
    const direct = t.factory.views[1] as FakeView
    t.factory.session1().hooks.sessionRequestCompleted(direct.webContentsId)
    t.factory.session1().hooks.sessionRequestCompleted(99_999)
    await flush()
    expect(t.minted).toEqual([])
  })
})

// My own tunnel (design §6): every load main makes passes the gate (tunnel-probe.ts) first; nothing
// answering shows the waiting page once and probes again every 3 s while the window is open.
describe('RemoteWindows: My own tunnel gate', () => {
  const TUNNEL = 'http://127.0.0.1:7331'

  function tunnelSetup(results: LoadGate[]) {
    const t = setup()
    t.store.servers.set('t1', { id: 't1', name: 'tun', via: { kind: 'tunnel', localPort: 7331, remotePort: 7330 }, recent: [] })
    const tasks = new Map<number, { fn: () => void; ms: number }>()
    let next = 1
    const gated: string[] = []
    const windows = new RemoteWindows({
      ...t.options,
      gate: async (server) => {
        gated.push(server.id)
        return results.shift() ?? { go: true }
      },
      timers: {
        setTimeout: (fn, ms) => {
          tasks.set(next, { fn, ms })
          return next++
        },
        clearTimeout: (h) => void tasks.delete(h as number)
      }
    })
    /** Run the pending retries (the 3 s ones; the sign-in wait is left alone). */
    const retry = async (): Promise<void> => {
      for (const [id, task] of [...tasks]) {
        if (task.ms !== TUNNEL_RETRY_MS) continue
        tasks.delete(id)
        task.fn()
      }
      await flush()
    }
    const retries = (): number => [...tasks.values()].filter((x) => x.ms === TUNNEL_RETRY_MS).length
    return { ...t, windows, gated, retry, retries }
  }

  it('waits with the command while nothing answers, then loads the page with the token', async () => {
    const wait = { wait: 'Nothing answers on 127.0.0.1:7331. Start the tunnel: …' }
    const t = tunnelSetup([wait, wait, { go: true }])
    await t.windows.open('t1', { origin: TUNNEL, token: 'tok' })
    await flush()
    const view = t.factory.views[0] as FakeView
    expect(view.loads).toEqual([])
    expect(view.errors).toEqual([wait.wait])
    expect(t.retries()).toBe(1)
    // A second miss probes again without drawing the page again.
    await t.retry()
    expect(view.errors).toEqual([wait.wait])
    expect(t.retries()).toBe(1)
    await t.retry()
    expect(view.loads).toEqual([`${TUNNEL}/#t=tok`])
    expect(t.retries()).toBe(0)
    expect(t.gated).toEqual(['t1', 't1', 't1'])
  })

  it('something else answering shows the error and loads nothing, with no retry', async () => {
    const t = tunnelSetup([{ error: 'Something else is listening on 127.0.0.1:7331' }])
    await t.windows.open('t1', { origin: TUNNEL, projectId: 'p1' })
    await flush()
    const view = t.factory.views[0] as FakeView
    expect(view.loads).toEqual([])
    expect(view.errors).toEqual(['Something else is listening on 127.0.0.1:7331'])
    expect(t.retries()).toBe(0)
  })

  it('a window closed while it waits stops probing', async () => {
    const t = tunnelSetup([{ wait: 'waiting' }])
    await t.windows.open('t1', { origin: TUNNEL })
    await flush()
    expect(t.retries()).toBe(1)
    ;(t.factory.views[0] as FakeView).close()
    expect(t.retries()).toBe(0)
    expect(t.gated).toEqual(['t1'])
  })

  it('a move to another origin replaces the waiting load', async () => {
    const t = tunnelSetup([{ wait: 'waiting' }, { go: true }])
    await t.windows.open('t1', { origin: TUNNEL, projectId: 'p1' })
    await flush()
    await t.windows.setOrigin('t1', 'http://127.0.0.1:7340')
    await flush()
    const view = t.factory.views[0] as FakeView
    expect(view.loads).toEqual(['http://127.0.0.1:7340/?project=p1'])
    expect(t.retries()).toBe(0)
  })

  it('probes, then reopens a closed project, then loads it', async () => {
    const t = tunnelSetup([{ go: true }])
    // Each request with the number of probes made before it.
    const order: string[] = []
    t.factory.fetcher = async (url) => {
      order.push(`get after ${t.gated.length} probes`)
      expect(url).toBe(`${TUNNEL}/api/projects`)
      return projects
    }
    t.factory.poster = async (url, body) => {
      order.push(`post ${JSON.stringify(body)} after ${t.gated.length} probes`)
      return { status: 200, body: { id: 'p2' } }
    }
    await t.windows.open('t1', { origin: TUNNEL, projectId: 'p2' })
    await flush()
    // The title's name lookup goes at once (as before); the open check and the reopen only after the probe.
    expect(order).toEqual(['get after 0 probes', 'get after 1 probes', 'post {"reopen":"p2"} after 1 probes'])
    expect(t.factory.session1('t1').posts[0]?.origin).toBe(TUNNEL)
    expect((t.factory.views[0] as FakeView).loads).toEqual([`${TUNNEL}/?project=p2`])
  })

  it('a closed project behind a tunnel that is down waits, and is not asked about', async () => {
    const t = tunnelSetup([{ wait: 'waiting' }])
    await t.windows.open('t1', { origin: TUNNEL, projectId: 'p2' })
    await flush()
    expect(t.factory.session1('t1').posts).toEqual([])
    expect((t.factory.views[0] as FakeView).loads).toEqual([])
  })

  it('other kinds load at once, never through the gate', async () => {
    const t = tunnelSetup([])
    t.factory.fetcher = async () => signedIn
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    await t.windows.open('d1', { origin: 'https://box.example' })
    await flush()
    expect(t.gated).toEqual([])
    expect((t.factory.views[0] as FakeView).loads).toEqual([`${ORIGIN}/?project=p1`])
  })
})

// The machine chips' side (design-remote-desktop.md §4.1, plan 20261112-machine-chips Task 2): which
// servers have a window, the server's most recently focused window, and main's own GET through the
// partition (machine-status.ts polls SESSIONS_PATH with it).
describe('RemoteWindows: machine chips', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
    t.factory.fetcher = async (url) => (url.endsWith('/api/projects') ? projects : signedIn)
  })

  it('lists each server with a window once, in the order its first window opened', async () => {
    expect(t.windows.serverIds()).toEqual([])
    await t.windows.open('d1', { origin: 'https://box.example' })
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    await t.windows.open('d1', { origin: 'https://box.example', projectId: 'p1' })
    expect(t.windows.serverIds()).toEqual(['d1', 's1'])
    ;(t.factory.views[1] as FakeView).close()
    expect(t.windows.serverIds()).toEqual(['d1'])
  })

  it('focuses the server\'s most recently focused window, else its newest; false with none open', async () => {
    expect(t.windows.focusServer('s1')).toBe(false)
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p2' })
    await t.windows.open('d1', { origin: 'https://box.example' })
    const [a, b, other] = t.factory.views as [FakeView, FakeView, FakeView]
    // No focus event yet: the newest opened (shown focused).
    expect(t.windows.focusServer('s1')).toBe(true)
    expect([a.focuses, b.focuses, other.focuses]).toEqual([0, 1, 0])
    a.hooks.focused()
    // Another server's window taking the focus changes nothing for s1.
    other.hooks.focused()
    expect(t.windows.focusServer('s1')).toBe(true)
    expect([a.focuses, b.focuses, other.focuses]).toEqual([1, 1, 0])
    a.close()
    expect(t.windows.focusServer('s1')).toBe(true)
    expect(b.focuses).toBe(2)
  })

  it('fetches a path through the server\'s partition at its current origin; an unknown server rejects', async () => {
    await expect(t.windows.fetchFromServer('s1', '/api/sessions')).rejects.toThrow('no such server')
    await t.windows.open('s1', { origin: ORIGIN, projectId: 'p1' })
    await flush()
    t.factory.fetcher = async (url) => (url.endsWith('/api/sessions') ? { waiting: 1, working: 0, idle: 2 } : signedIn)
    await expect(t.windows.fetchFromServer('s1', '/api/sessions')).resolves.toEqual({ waiting: 1, working: 0, idle: 2 })
    expect(t.factory.session1().fetches.at(-1)).toBe(`${ORIGIN}/api/sessions`)
    await t.windows.setOrigin('s1', 'http://127.0.0.1:4200')
    await t.windows.fetchFromServer('s1', '/api/sessions')
    expect(t.factory.session1().fetches.at(-1)).toBe('http://127.0.0.1:4200/api/sessions')
  })
})
