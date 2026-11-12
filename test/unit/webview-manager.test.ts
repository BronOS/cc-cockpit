// Plan B Task 7: webview panels. The manager's decisions with a fake view factory (targets, page
// navigation, window.open, tokens, teardown), main's request checks (host-api.ts) and the host's
// ctx.webview. Temp dirs stand in for the home folder; no Electron, no real home.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostContexts, type ContextDeps } from '../../src/host/ctx'
import { HostApi, MAX_NAVIGATES_PER_WINDOW, MAX_PANEL_SHOWS_PER_WINDOW, type HostApiDeps } from '../../src/main/plugins/host-api'
import {
  LOAD_WAIT_MS,
  MAX_LOAD_ERROR_LENGTH,
  MAX_OPENS_PER_VIEW,
  MAX_PAGE_TITLE_LENGTH,
  MAX_TOKENS_PER_VIEW,
  NAVIGATED_COALESCE_MS,
  OPEN_WINDOW_MS,
  webviewPartition,
  WebviewLoadError,
  MAX_SERVER_VIEWS,
  MAX_SERVER_VIEWS_PER_WINDOW,
  WEBVIEW_LIMIT_REFUSAL,
  WebviewManager,
  type WebviewEvents,
  type WebviewManagerDeps,
  type WebviewOwner,
  type WebviewPage,
  type WebviewView
} from '../../src/main/webview/webview-manager'
import { isMountPoint, resolveWebviewTarget } from '../../src/main/webview/webview-target'
import { MAX_URL_LENGTH } from '../../src/main/overlays/overlay-manager'
import { hostSpec } from '../fakes/host-spec'
import { unusedOAuth, unusedSecrets } from '../fakes/unused-host-services'

interface FakeView extends WebviewView {
  windowId: number
  partition: string
  events: WebviewEvents
  loaded: string[]
  steps: string[]
  bounds: { x: number; y: number; width: number; height: number }[]
  visible: boolean[]
  destroyed: boolean
  page: WebviewPage
  /** Whether the page has the keyboard (tests set it). */
  focused: boolean
}

/** What the next view.load returns (loaded at once unless a test sets it). */
let nextLoad: () => Promise<void>
/** Which windows are focused (isWindowFocused); all of them unless a test says otherwise. */
let unfocused: Set<number>

let home: string
let proj: string
let views: FakeView[]
let external: string[]
/** The window each external open was for (the openExternal adapter's target). */
let externalWindows: number[]
let chords: { windowId: number; chord: string }[]
let refocused: number[]
let closedPartitions: string[]
let openWindows: Set<number>
let tokenCount: number
let clock: number
let manager: WebviewManager
/** What `manager` was made with: a test makes another manager from it (server mode). */
let managerDeps: WebviewManagerDeps

const WIN = 7
const owner = (panelId = 'view', pluginId = 'a.one', windowId = WIN, projectId = 'P1'): WebviewOwner => ({
  windowId,
  projectId,
  pluginId,
  panelId
})

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-webview-home-')))
  proj = join(home, 'proj')
  for (const d of [proj, join(proj, 'sub'), join(home, '.ssh'), join(proj, '.hidden')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(proj, 'mock.html'), '<p>mock</p>')
  writeFileSync(join(proj, 'other.html'), '<p>other</p>')
  writeFileSync(join(proj, 'sub', 'deep.html'), '<p>deep</p>')
  writeFileSync(join(proj, '.env'), 'SECRET=1')
  writeFileSync(join(home, 'top.html'), '<p>in home</p>')
  writeFileSync(join(home, '.ssh', 'keys.html'), '<p>keys</p>')
  symlinkSync(join(home, 'top.html'), join(proj, 'alias.html'))
  views = []
  external = []
  externalWindows = []
  chords = []
  refocused = []
  closedPartitions = []
  nextLoad = () => Promise.resolve()
  unfocused = new Set()
  openWindows = new Set([WIN, 8])
  tokenCount = 0
  clock = 1_000_000
  managerDeps = {
    views: {
      create: (windowId, partition, events) => {
        const view: FakeView = {
          windowId,
          partition,
          events,
          loaded: [],
          steps: [],
          bounds: [],
          visible: [],
          destroyed: false,
          page: { url: '', title: '' },
          focused: false,
          load(url) {
            view.loaded.push(url)
            view.page = { url, title: '' }
            return nextLoad()
          },
          back: () => view.steps.push('back'),
          forward: () => view.steps.push('forward'),
          reload: () => view.steps.push('reload'),
          current: () => view.page,
          isFocused: () => view.focused && !view.destroyed,
          setBounds: (b) => view.bounds.push(b),
          setVisible: (v) => view.visible.push(v),
          destroy() {
            view.destroyed = true
          }
        }
        views.push(view)
        return view
      }
    },
    openExternal: (url, windowId) => {
      external.push(url)
      externalWindows.push(windowId)
    },
    focusShell: (windowId) => refocused.push(windowId),
    partitionClosed: (partition) => closedPartitions.push(partition),
    isWindowFocused: (windowId) => !unfocused.has(windowId),
    chord: (windowId, chord) => {
      chords.push({ windowId, chord })
      return chord === 'Escape'
    },
    isWindowOpen: (id) => openWindows.has(id),
    homeDir: () => home,
    newToken: () => `t${String(++tokenCount).padStart(32, '0')}`,
    now: () => clock,
    log: () => {}
  }
  manager = new WebviewManager(managerDeps)
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const tokenOf = (url: string): string => new URL(url).hostname

// The target rules live in webview/webview-target.ts; they are tested here, next to the manager
// that applies them, because both use the same home and project folders.
describe('resolveWebviewTarget', () => {
  it('takes http and https URLs as they are (normalized)', async () => {
    expect(await resolveWebviewTarget('http://localhost:5173', home)).toEqual({ kind: 'url', url: 'http://localhost:5173/' })
    expect(await resolveWebviewTarget('https://example.com/a?b#c', home)).toEqual({ kind: 'url', url: 'https://example.com/a?b#c' })
  })

  it('takes an absolute file path, realpath\'d, split into folder and name', async () => {
    expect(await resolveWebviewTarget(join(proj, 'sub', '..', 'mock.html'), home)).toEqual({ kind: 'file', folder: proj, name: 'mock.html' })
  })

  it.each([
    ['mock.html', /must be absolute/],
    ['./mock.html', /must be absolute/],
    ['file:///etc/hosts', /only http\(s\) URLs and absolute file paths/],
    ['javascript:alert(1)', /only http\(s\) URLs and absolute file paths/],
    ['data:text/html,hi', /only http\(s\) URLs and absolute file paths/],
    ['cc-preview://t0/x', /only http\(s\) URLs and absolute file paths/],
    ['http://', /not a valid http\(s\) URL/],
    ['', /must be a URL or an absolute file path/]
  ])('refuses %j', async (target, message) => {
    await expect(resolveWebviewTarget(target, home)).rejects.toThrow(message)
  })

  it('refuses a non-string target', async () => {
    await expect(resolveWebviewTarget(42, home)).rejects.toThrow(/must be a URL/)
  })

  it('refuses a file directly under home, a home dot-folder, a dot-file, a folder and a missing file', async () => {
    await expect(resolveWebviewTarget(join(home, 'top.html'), home)).rejects.toThrow(/home folder/)
    // A symlink in a project folder that leads to a file directly in home is that file.
    await expect(resolveWebviewTarget(join(proj, 'alias.html'), home)).rejects.toThrow(/home folder/)
    await expect(resolveWebviewTarget(join(home, '.ssh', 'keys.html'), home)).rejects.toThrow(/inside a dot-folder/)
    await expect(resolveWebviewTarget(join(proj, '.env'), home)).rejects.toThrow(/dot-files/)
    await expect(resolveWebviewTarget(join(proj, 'sub'), home)).rejects.toThrow(/not a regular file/)
    await expect(resolveWebviewTarget(join(proj, 'nope.html'), home)).rejects.toThrow(/no such file/)
    await expect(resolveWebviewTarget('/', home)).rejects.toThrow(/not a regular file/)
  })

  it('refuses a child of home whose name starts with `..` as a dot-folder (not "outside home")', async () => {
    mkdirSync(join(home, '..cache'))
    writeFileSync(join(home, '..cache', 'p.html'), 'x')
    await expect(resolveWebviewTarget(join(home, '..cache', 'p.html'), home)).rejects.toThrow(/inside a dot-folder/)
  })

  // Review finding (ext round 8): only the first folder below home was checked, so a project's
  // `.git/description` made `.git` a root and its `config` (remote credentials) was then served.
  it('refuses a file with a dot-folder anywhere on its real path, inside home or not', async () => {
    writeFileSync(join(proj, '.hidden', 'p.html'), 'x')
    await expect(resolveWebviewTarget(join(proj, '.hidden', 'p.html'), home)).rejects.toThrow(/inside a dot-folder/)
    mkdirSync(join(proj, '.git', 'deep'), { recursive: true })
    writeFileSync(join(proj, '.git', 'description'), 'x')
    writeFileSync(join(proj, '.git', 'deep', 'p.html'), 'x')
    await expect(resolveWebviewTarget(join(proj, '.git', 'description'), home)).rejects.toThrow(/inside a dot-folder/)
    await expect(resolveWebviewTarget(join(proj, '.git', 'deep', 'p.html'), home)).rejects.toThrow(/inside a dot-folder/)
    // Outside home: the "home" here is some other folder, so proj is not under it.
    const other = join(home, 'elsewhere-home')
    mkdirSync(other)
    await expect(resolveWebviewTarget(join(proj, '.git', 'deep', 'p.html'), other)).rejects.toThrow(/inside a dot-folder/)
    // Reached through a symlink with a plain name: the real path is what counts.
    symlinkSync(join(proj, '.git', 'deep'), join(proj, 'plain-link'))
    await expect(resolveWebviewTarget(join(proj, 'plain-link', 'p.html'), home)).rejects.toThrow(/inside a dot-folder/)
  })

  it('refuses ~/Library except inside a cloud drive\'s own folder', async () => {
    const page = (...parts: string[]): string => {
      const file = join(home, 'Library', ...parts, 'p.html')
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, 'x')
      return file
    }
    await expect(resolveWebviewTarget(page(), home)).rejects.toThrow(/~\/Library/)
    await expect(resolveWebviewTarget(page('Keychains'), home)).rejects.toThrow(/~\/Library/)
    await expect(resolveWebviewTarget(page('Application Support', 'App'), home)).rejects.toThrow(/~\/Library/)
    await expect(resolveWebviewTarget(page('CloudStorage'), home)).rejects.toThrow(/~\/Library/)
    await expect(resolveWebviewTarget(page('CloudStorage', 'Dropbox', 'proj'), home)).resolves.toMatchObject({ kind: 'file' })
    await expect(resolveWebviewTarget(page('Mobile Documents', 'com~apple~CloudDocs'), home)).resolves.toMatchObject({ kind: 'file' })
  })

  it('takes a symlink to the home folder as the home folder', async () => {
    const link = join(proj, 'home-link')
    symlinkSync(home, link)
    await expect(resolveWebviewTarget(join(home, 'top.html'), link)).rejects.toThrow(/home folder/)
    await expect(resolveWebviewTarget(join(home, '.ssh', 'keys.html'), link)).rejects.toThrow(/inside a dot-folder/)
    await expect(resolveWebviewTarget(join(proj, 'mock.html'), link)).resolves.toEqual({ kind: 'file', folder: proj, name: 'mock.html' })
  })

  it('falls back to the spelling of a home folder that does not resolve', async () => {
    await expect(resolveWebviewTarget(join(proj, 'mock.html'), join(home, 'gone'))).resolves.toMatchObject({ kind: 'file', folder: proj })
    // The string rule still applies to that spelling: a dot-folder right under it.
    mkdirSync(join(proj, 'sub', '.x'), { recursive: true })
    writeFileSync(join(proj, 'sub', '.x', 'p.html'), 'x')
    await expect(resolveWebviewTarget(join(proj, 'sub', '.x', 'p.html'), join(proj, 'sub', 'gone', '..'))).rejects.toThrow(/dot-folder/)
  })

  it('refuses a file directly in a shared temp folder, not in a folder inside it', async () => {
    const shared = join(proj, 'shared-tmp')
    mkdirSync(join(shared, 'mine'), { recursive: true })
    writeFileSync(join(shared, 'loose.html'), 'x')
    writeFileSync(join(shared, 'mine', 'p.html'), 'x')
    // Given through a symlink: compared by identity.
    symlinkSync(shared, join(proj, 'tmp-link'))
    await expect(resolveWebviewTarget(join(shared, 'loose.html'), home, [join(proj, 'tmp-link')])).rejects.toThrow(/shared temp folder/)
    await expect(resolveWebviewTarget(join(shared, 'mine', 'p.html'), home, [shared])).resolves.toMatchObject({ kind: 'file' })
  })

  // macOS: `/System/Volumes/Data/<path>` is a firmlink spelling of `/<path>` that realpath keeps.
  // The temp home lives under /private/var/folders, which is firmlinked like /Users.
  const dataVolume = '/System/Volumes/Data'
  const firmlinked = process.platform === 'darwin' && existsSync(join(dataVolume, realpathSync(tmpdir())))

  it.skipIf(!firmlinked)('refuses a target spelled through the data volume (firmlink)', async () => {
    await expect(resolveWebviewTarget(dataVolume + join(home, 'top.html'), home)).rejects.toThrow(/System\/Volumes\/Data/)
    await expect(resolveWebviewTarget(dataVolume + join(home, '.ssh', 'keys.html'), home)).rejects.toThrow(/System\/Volumes\/Data/)
  })

  it.skipIf(!firmlinked)('compares by identity with a home folder given in the data volume spelling', async () => {
    const aliasHome = dataVolume + home
    // realpath keeps the alias, so only the identity checks see that home and the target agree.
    expect(realpathSync(aliasHome)).toBe(aliasHome)
    await expect(resolveWebviewTarget(join(home, 'top.html'), aliasHome)).rejects.toThrow(/home folder/)
    await expect(resolveWebviewTarget(join(home, '.ssh', 'keys.html'), aliasHome)).rejects.toThrow(/inside a dot-folder/)
    await expect(resolveWebviewTarget(join(proj, 'mock.html'), aliasHome)).resolves.toMatchObject({ kind: 'file', folder: proj })
  })

  it('refuses a file directly in the top folder of a disk (device differs from the parent\'s)', async () => {
    // proj sits on its own device, everything else on device 1.
    const deviceOf = async (p: string): Promise<bigint> => (p === proj ? 2n : 1n)
    await expect(resolveWebviewTarget(join(proj, 'mock.html'), home, [], deviceOf)).rejects.toThrow(/top folder of a disk/)
    // A folder below the mount point is fine: its parent is on the same device.
    await expect(resolveWebviewTarget(join(proj, 'sub', 'deep.html'), home, [], async (p) => (p === proj || p.startsWith(proj + '/') ? 2n : 1n))).resolves.toMatchObject({
      kind: 'file',
      folder: join(proj, 'sub')
    })
  })

  it('isMountPoint: a device that differs from the parent\'s, and false when a stat fails', async () => {
    expect(await isMountPoint('/Volumes/disk', async (p) => (p === '/Volumes/disk' ? 7n : 1n))).toBe(true)
    expect(await isMountPoint('/Volumes/disk/sub', async (p) => (p.startsWith('/Volumes/disk') ? 7n : 1n))).toBe(false)
    expect(await isMountPoint('/gone', async () => Promise.reject(new Error('ENOENT')))).toBe(false)
    // The real stat: the temp project folder is not a mount point.
    expect(await isMountPoint(proj)).toBe(false)
  })

  // A regular file directly in a mount point's own folder, if this machine has one (read only).
  const mountPointFile = (): string | undefined => {
    for (const parent of ['/Volumes', '/System/Volumes']) {
      let names: string[]
      try {
        names = readdirSync(parent)
      } catch {
        continue
      }
      for (const name of names) {
        const dir = join(parent, name)
        try {
          if (realpathSync(dir) !== dir || statSync(dir).dev === statSync(parent).dev) continue
          for (const f of readdirSync(dir)) {
            if (!f.startsWith('.') && statSync(join(dir, f)).isFile()) return join(dir, f)
          }
        } catch {
          // Unreadable: try the next one.
        }
      }
    }
    return undefined
  }
  const mountFile = mountPointFile()

  it.skipIf(mountFile === undefined)('refuses a file directly in the top folder of a disk', async () => {
    await expect(resolveWebviewTarget(mountFile as string, home)).rejects.toThrow(/top folder of a disk/)
  })
})

describe('WebviewManager', () => {
  it('creates one hidden view per panel on first navigate, on the plugin\'s partition', async () => {
    await manager.navigate(owner(), 'https://example.com/')
    await manager.navigate(owner(), 'https://example.org/')
    expect(views).toHaveLength(1)
    const view = views[0] as FakeView
    expect(view.windowId).toBe(WIN)
    expect(view.partition).toBe(webviewPartition('P1', 'a.one'))
    expect(view.partition).toBe('webview-P1-a.one')
    expect(view.loaded).toEqual(['https://example.com/', 'https://example.org/'])
    expect(view.bounds[0]).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(view.visible[0]).toBe(false)
    await manager.navigate(owner('second'), 'https://example.com/')
    expect(views).toHaveLength(2)
  })

  it('serves a file through a token of its own view, reused for the same folder', async () => {
    await manager.navigate(owner(), join(proj, 'mock.html'))
    await manager.navigate(owner(), join(proj, 'other.html'))
    await manager.navigate(owner(), join(proj, 'sub', 'deep.html'))
    const [a, b, c] = (views[0] as FakeView).loaded as [string, string, string]
    expect(a).toMatch(/^cc-preview:\/\/t0+1\/mock\.html$/)
    expect(tokenOf(b)).toBe(tokenOf(a))
    expect(tokenOf(c)).not.toBe(tokenOf(a))
    const partition = webviewPartition('P1', 'a.one')
    expect(manager.previewFolder(partition, tokenOf(a))).toBe(proj)
    expect(manager.previewFolder(partition, tokenOf(c))).toBe(join(proj, 'sub'))
    // Another session (another plugin or project) does not see the token.
    expect(manager.previewFolder(webviewPartition('P1', 'a.two'), tokenOf(a))).toBeUndefined()
    expect(manager.previewFolder(partition, 'nottoken')).toBeUndefined()
  })

  it('keeps at most MAX_TOKENS_PER_VIEW folders, dropping the least recently navigated', async () => {
    const partition = webviewPartition('P1', 'a.one')
    for (let i = 0; i <= MAX_TOKENS_PER_VIEW; i++) {
      mkdirSync(join(proj, `d${i}`))
      writeFileSync(join(proj, `d${i}`, 'p.html'), 'x')
      await manager.navigate(owner(), join(proj, `d${i}`, 'p.html'))
      // The first folder is looked at again just before the table overflows: it is not the oldest.
      if (i === MAX_TOKENS_PER_VIEW - 1) await manager.navigate(owner(), join(proj, 'd0', 'p.html'))
    }
    const loaded = (views[0] as FakeView).loaded
    expect(manager.previewFolder(partition, tokenOf(loaded[0] as string))).toBe(join(proj, 'd0'))
    expect(manager.previewFolder(partition, tokenOf(loaded[1] as string))).toBeUndefined()
    expect(manager.previewFolder(partition, tokenOf(loaded[2] as string))).toBe(join(proj, 'd2'))
  })

  it('lets page navigation go to http(s) and its own tokens only', async () => {
    await manager.navigate(owner(), join(proj, 'mock.html'))
    await manager.navigate(owner('second'), join(proj, 'sub', 'deep.html'))
    const view = views[0] as FakeView
    const own = view.loaded[0] as string
    const foreign = (views[1] as FakeView).loaded[0] as string
    const allow = (url: string, main = true): boolean => view.events.allowNavigation(url, main)
    expect(allow('https://example.com/')).toBe(true)
    expect(allow('http://localhost:3000/x')).toBe(true)
    expect(allow(own)).toBe(true)
    expect(allow(`cc-preview://${tokenOf(own)}/other.html`)).toBe(true)
    expect(allow(foreign)).toBe(false)
    expect(allow('file:///etc/passwd')).toBe(false)
    expect(allow('cc-plugin://a.one/page.html')).toBe(false)
    expect(allow('javascript:alert(1)')).toBe(false)
    expect(allow('not a url')).toBe(false)
    // Sub-frames are the page's business, except file: and other views' tokens.
    expect(allow('about:blank', false)).toBe(true)
    expect(allow('file:///etc/passwd', false)).toBe(false)
    expect(allow(foreign, false)).toBe(false)
  })

  it('sends window.open to the openExternal adapter for http(s) only, with the view\'s window', async () => {
    await manager.navigate(owner(), 'https://example.com/')
    await manager.navigate(owner('view', 'a.one', 8), 'https://example.com/')
    const view = views[0] as FakeView
    view.events.openWindow('https://other.example/')
    view.events.openWindow('file:///etc/passwd')
    view.events.openWindow('javascript:alert(1)')
    ;(views[1] as FakeView).events.openWindow('https://eight.example/')
    expect(external).toEqual(['https://other.example/', 'https://eight.example/'])
    // The window of the view whose page asked: in server mode its browsers get the link notice.
    expect(externalWindows).toEqual([WIN, 8])
    expect(views).toHaveLength(2)
  })

  it('caps window.open per view: the rest of a loop is dropped until the window passes', async () => {
    await manager.navigate(owner(), 'https://example.com/')
    await manager.navigate(owner('second'), 'https://example.com/')
    const [view, second] = views as [FakeView, FakeView]
    for (let i = 0; i < 10; i++) view.events.openWindow(`https://o.example/${i}`)
    expect(external).toHaveLength(MAX_OPENS_PER_VIEW)
    // Another view has its own budget.
    second.events.openWindow('https://o.example/second')
    expect(external).toHaveLength(MAX_OPENS_PER_VIEW + 1)
    clock += OPEN_WINDOW_MS
    view.events.openWindow('https://o.example/later')
    expect(external.at(-1)).toBe('https://o.example/later')
  })

  it('reports committed pages to the latest navigate\'s listener', async () => {
    const seen: WebviewPage[] = []
    await manager.navigate(owner(), 'https://example.com/', (p) => seen.push(p))
    const view = views[0] as FakeView
    view.page = { url: 'https://example.com/next', title: 'Next' }
    view.events.navigated(true)
    expect(seen).toEqual([{ url: 'https://example.com/next', title: 'Next' }])
    expect(manager.current(owner())).toEqual({ url: 'https://example.com/next', title: 'Next' })
  })

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('coalesces a burst of navigations: the first at once, the last when the window closes', async () => {
      const seen: WebviewPage[] = []
      await manager.navigate(owner(), 'https://example.com/', (p) => seen.push(p))
      const view = views[0] as FakeView
      for (let i = 0; i < 100; i++) {
        view.page = { url: `https://example.com/#${i}`, title: `T${i}` }
        view.events.navigated(true)
      }
      expect(seen).toEqual([{ url: 'https://example.com/#0', title: 'T0' }])
      vi.advanceTimersByTime(NAVIGATED_COALESCE_MS)
      expect(seen).toEqual([
        { url: 'https://example.com/#0', title: 'T0' },
        { url: 'https://example.com/#99', title: 'T99' }
      ])
      // Quiet now: nothing more, and the next change is reported at once again.
      vi.advanceTimersByTime(NAVIGATED_COALESCE_MS * 5)
      expect(seen).toHaveLength(2)
      view.page = { url: 'https://example.com/later', title: 'L' }
      view.events.navigated(true)
      expect(seen).toHaveLength(3)
    })

    it('drops a pending report when the view goes', async () => {
      const seen: WebviewPage[] = []
      await manager.navigate(owner(), 'https://example.com/', (p) => seen.push(p))
      const view = views[0] as FakeView
      view.events.navigated(true)
      view.events.navigated(true)
      manager.destroyPlugin(WIN, 'a.one')
      vi.advanceTimersByTime(NAVIGATED_COALESCE_MS)
      expect(seen).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  it('caps the url and title a page reports', async () => {
    const seen: WebviewPage[] = []
    await manager.navigate(owner(), 'https://example.com/', (p) => seen.push(p))
    const view = views[0] as FakeView
    view.page = { url: `https://example.com/${'a'.repeat(MAX_URL_LENGTH * 2)}`, title: 'x'.repeat(MAX_PAGE_TITLE_LENGTH * 10) }
    view.events.navigated(true)
    expect(seen[0]?.url).toHaveLength(MAX_URL_LENGTH)
    expect(seen[0]?.title).toHaveLength(MAX_PAGE_TITLE_LENGTH)
    const page = manager.current(owner())
    expect(page.url).toHaveLength(MAX_URL_LENGTH)
    expect(page.title).toHaveLength(MAX_PAGE_TITLE_LENGTH)
  })

  // Review finding (ext round 8): `ccc browser url` prints the title on a terminal.
  it('turns control characters in a page title into spaces', async () => {
    const seen: WebviewPage[] = []
    await manager.navigate(owner(), 'https://example.com/', (p) => seen.push(p))
    const view = views[0] as FakeView
    view.page = { url: 'https://example.com/', title: 'a\u001b]0;pwned\u0007b\tc\u009bd\u007fe' }
    view.events.navigated(true)
    expect(seen[0]?.title).toBe('a ]0;pwned b c d e')
    expect(manager.current(owner()).title).toBe('a ]0;pwned b c d e')
  })

  it('back, forward, reload and current are harmless before the first navigate', () => {
    manager.back(owner())
    manager.forward(owner())
    manager.reload(owner())
    expect(manager.current(owner())).toEqual({ url: '', title: '' })
    expect(views).toHaveLength(0)
  })

  it('passes history steps to the view, never another project\'s view', async () => {
    await manager.navigate(owner(), 'https://example.com/')
    manager.back(owner())
    manager.forward(owner())
    manager.reload(owner())
    manager.back(owner('view', 'a.one', WIN, 'P2'))
    expect((views[0] as FakeView).steps).toEqual(['back', 'forward', 'reload'])
  })

  it('applies placements: kept before the view exists, sanitized, hidden at zero size', async () => {
    manager.setPlacement(WIN, 'a.one', 'view', { bounds: { x: 10, y: 20.4, width: 300, height: 200 }, visible: true })
    await manager.navigate(owner(), 'https://example.com/')
    const view = views[0] as FakeView
    expect(view.bounds.at(-1)).toEqual({ x: 10, y: 20, width: 300, height: 200 })
    expect(view.visible.at(-1)).toBe(true)
    manager.setPlacement(WIN, 'a.one', 'view', { bounds: { x: Number.NaN, y: -5, width: 0, height: 100 }, visible: true })
    expect(view.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 0, height: 100 })
    expect(view.visible.at(-1)).toBe(false)
  })

  it('forwards chords typed into the view to the window\'s key handling', async () => {
    await manager.navigate(owner(), 'https://example.com/')
    const view = views[0] as FakeView
    expect(view.events.chord('Escape')).toBe(true)
    expect(view.events.chord('Cmd+T')).toBe(false)
    expect(chords).toEqual([
      { windowId: WIN, chord: 'Escape' },
      { windowId: WIN, chord: 'Cmd+T' }
    ])
  })

  it('hands the keyboard to the shell when a showing view gets hidden, not when it was hidden already', async () => {
    await manager.navigate(owner(), 'https://example.com/')
    ;(views[0] as FakeView).focused = true
    manager.setPlacement(WIN, 'a.one', 'view', { bounds: { x: 0, y: 0, width: 100, height: 100 }, visible: false })
    expect(refocused).toEqual([])
    manager.setPlacement(WIN, 'a.one', 'view', { bounds: { x: 0, y: 0, width: 100, height: 100 }, visible: true })
    expect(refocused).toEqual([])
    manager.setWindowCovered(WIN, true)
    expect(refocused).toEqual([WIN])
    manager.setWindowCovered(WIN, true)
    manager.setWindowCovered(WIN, false)
    expect(refocused).toEqual([WIN])
  })

  // Review finding (ext round 8): a dropped view that was showing may have had the keyboard.
  it('hands the keyboard to the shell when a showing view goes, not a hidden one or in a closing window', async () => {
    const shown = { bounds: { x: 0, y: 0, width: 100, height: 100 }, visible: true }
    await manager.navigate(owner(), 'https://example.com/')
    manager.setPlacement(WIN, 'a.one', 'view', shown)
    ;(views[0] as FakeView).events.gone()
    expect(refocused).toEqual([WIN])
    // A hidden view (the panel closed) never had the keyboard.
    await manager.navigate(owner('other'), 'https://example.com/')
    manager.destroyPlugin(WIN, 'a.one')
    expect(refocused).toEqual([WIN])
    // A window that is closing is left alone.
    await manager.navigate(owner('view', 'a.two'), 'https://example.com/')
    manager.setPlacement(WIN, 'a.two', 'view', shown)
    openWindows.delete(WIN)
    manager.closeWindow(WIN)
    expect(refocused).toEqual([WIN])
  })

  // Review finding (ext round 9): with two panels open, hiding or dropping panel A moved the
  // keyboard out of panel B while the user typed there.
  it('leaves the keyboard in another view of the window when a showing view hides or goes', async () => {
    const shown = { bounds: { x: 0, y: 0, width: 100, height: 100 }, visible: true }
    await manager.navigate(owner('a'), 'https://example.com/')
    await manager.navigate(owner('b'), 'https://example.com/')
    manager.setPlacement(WIN, 'a.one', 'a', shown)
    manager.setPlacement(WIN, 'a.one', 'b', shown)
    const [a, b] = views as [FakeView, FakeView]
    b.focused = true
    manager.setPlacement(WIN, 'a.one', 'a', { ...shown, visible: false })
    expect(refocused).toEqual([])
    manager.setPlacement(WIN, 'a.one', 'a', shown)
    a.events.gone()
    expect(refocused).toEqual([])
    // The view that has the keyboard does hand it back.
    manager.setPlacement(WIN, 'a.one', 'b', { ...shown, visible: false })
    expect(refocused).toEqual([WIN])
  })

  // Review finding (ext round 10): on macOS webContents.focus() brings its window to the front, so
  // a view hidden in a background project window pulled that window over the one the user typed in.
  it('hands the keyboard back only in the focused window; a background one gets it once focused', async () => {
    const shown = { bounds: { x: 0, y: 0, width: 100, height: 100 }, visible: true }
    await manager.navigate(owner(), 'https://example.com/')
    manager.setPlacement(WIN, 'a.one', 'view', shown)
    ;(views[0] as FakeView).focused = true
    unfocused.add(WIN)
    manager.setPlacement(WIN, 'a.one', 'view', { ...shown, visible: false })
    expect(refocused).toEqual([])
    // Focused again: the hidden view would still have the keyboard, the shell page takes it.
    unfocused.delete(WIN)
    manager.windowFocused(WIN)
    expect(refocused).toEqual([WIN])
    // Once only.
    manager.windowFocused(WIN)
    expect(refocused).toEqual([WIN])
    // A drop in the background too (a crashed page).
    manager.setPlacement(WIN, 'a.one', 'view', shown)
    unfocused.add(WIN)
    ;(views[0] as FakeView).events.gone()
    expect(refocused).toEqual([WIN])
    manager.windowFocused(WIN)
    expect(refocused).toEqual([WIN, WIN])
  })

  it('does not take the keyboard on focus from a showing view the user is in, nor after the window closed', async () => {
    const shown = { bounds: { x: 0, y: 0, width: 100, height: 100 }, visible: true }
    await manager.navigate(owner('a'), 'https://example.com/')
    await manager.navigate(owner('b'), 'https://example.com/')
    manager.setPlacement(WIN, 'a.one', 'a', shown)
    manager.setPlacement(WIN, 'a.one', 'b', shown)
    const [a, b] = views as [FakeView, FakeView]
    a.focused = true
    unfocused.add(WIN)
    manager.setPlacement(WIN, 'a.one', 'a', { ...shown, visible: false })
    a.focused = false
    b.focused = true
    manager.windowFocused(WIN)
    expect(refocused).toEqual([])
    // Due again, then the window closes: nothing is owed to a window that is gone.
    manager.setPlacement(WIN, 'a.one', 'a', shown)
    b.focused = false
    a.focused = true
    manager.setPlacement(WIN, 'a.one', 'a', { ...shown, visible: false })
    manager.closeWindow(WIN)
    manager.windowFocused(WIN)
    expect(refocused).toEqual([])
  })

  // Review finding (ext round 10): a failed load reached only console.warn: `ccc browser open`
  // printed `ok` with the dev server down, current() could not tell, the toolbar stayed on "No page".
  describe('a failed load', () => {
    it('rejects navigate with the error and reports it until a page commits', async () => {
      const pages: WebviewPage[] = []
      let failLoad: (err: Error) => void = () => {}
      nextLoad = () => new Promise<void>((_resolve, reject) => (failLoad = reject))
      const pending = manager.navigate(owner(), 'http://127.0.0.1:5173/', (p) => pages.push(p)).catch((err: unknown) => err)
      await vi.waitFor(() => expect(views).toHaveLength(1))
      const view = views[0] as FakeView
      // As the adapter does: did-fail-load first, then loadURL rejects.
      view.events.loadFailed('http://127.0.0.1:5173/', 'ERR_CONNECTION_REFUSED (-102)')
      failLoad(new Error('ERR_CONNECTION_REFUSED (-102)'))
      const err = await pending
      expect(err).toBeInstanceOf(WebviewLoadError)
      expect((err as Error).message).toBe('webview.navigate: http://127.0.0.1:5173/ did not load: ERR_CONNECTION_REFUSED (-102)')
      const failed = { url: 'http://127.0.0.1:5173/', title: '', error: 'ERR_CONNECTION_REFUSED (-102)' }
      expect(manager.current(owner())).toEqual(failed)
      expect(pages).toEqual([failed])
      // The empty page's title is no commit: the error stays.
      view.page = { url: 'http://127.0.0.1:5173/', title: '127.0.0.1:5173' }
      view.events.navigated(false)
      expect(manager.current(owner())).toEqual(failed)
      // A page that commits (a reload once the server is up) clears it.
      view.page = { url: 'http://127.0.0.1:5173/', title: 'App' }
      view.events.navigated(true)
      expect(manager.current(owner())).toEqual({ url: 'http://127.0.0.1:5173/', title: 'App' })
    })

    it('a load error is one capped line', async () => {
      await manager.navigate(owner(), 'https://example.com/')
      ;(views[0] as FakeView).events.loadFailed('https://example.com/', `ERR\x1b[31m${'x'.repeat(500)}`)
      const { error } = manager.current(owner())
      expect(error).toMatch(/^ERR \[31mx+$/)
      expect(error).toHaveLength(MAX_LOAD_ERROR_LENGTH)
    })

    it('a superseded load is no error, and a slow one resolves after LOAD_WAIT_MS', async () => {
      // Superseded: the adapter resolves load (ERR_ABORTED is not a failure).
      await expect(manager.navigate(owner(), 'https://example.com/')).resolves.toBeUndefined()
      vi.useFakeTimers()
      try {
        nextLoad = () => new Promise<void>(() => {}) // never settles
        let done = false
        const slow = manager.navigate(owner(), 'https://slow.example/').then(() => (done = true))
        await vi.advanceTimersByTimeAsync(LOAD_WAIT_MS - 1)
        expect(done).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        await slow
        expect(done).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('forgets a plugin\'s placements on destroyPlugin: the next view is not shown at the stale bounds', async () => {
    manager.setPlacement(WIN, 'a.one', 'view', { bounds: { x: 10, y: 20, width: 300, height: 200 }, visible: true })
    await manager.navigate(owner(), 'https://example.com/')
    expect(manager.isShown(WIN, 'a.one', 'view')).toBe(true)
    manager.destroyPlugin(WIN, 'a.one')
    await manager.navigate(owner(), 'https://example.com/')
    expect(manager.isShown(WIN, 'a.one', 'view')).toBe(false)
    expect((views[1] as FakeView).visible.at(-1)).toBe(false)
  })

  it('lets the newest navigate of a panel win when an older file resolution finishes after it', async () => {
    // The file target awaits the file system (several ticks); the URL resolves sooner and loads first.
    const slow = manager.navigate(owner(), join(proj, 'mock.html'))
    const fast = manager.navigate(owner(), 'https://example.com/')
    await Promise.all([slow, fast])
    expect((views[0] as FakeView).loaded).toEqual(['https://example.com/'])
  })

  // Review finding (ext round 9): a refused navigate bumped the sequence, so an older valid one
  // that had overlapped it loaded nothing although its caller was told ok.
  it('still loads an older valid navigate when a newer overlapping one is refused', async () => {
    const valid = manager.navigate(owner(), join(proj, 'mock.html'))
    const refusedNow = manager.navigate(owner(), 'ftp://example.com/')
    const refusedLater = manager.navigate(owner(), join(proj, 'missing.html'))
    const settled = await Promise.allSettled([valid, refusedNow, refusedLater])
    expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'rejected'])
    const loaded = (views[0] as FakeView).loaded
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatch(/^cc-preview:\/\/t0+1\/mock\.html$/)
  })

  it('ends on the newer valid navigate when an older one resolves first', async () => {
    const fast = manager.navigate(owner(), 'https://example.com/')
    const slow = manager.navigate(owner(), join(proj, 'mock.html'))
    await Promise.all([fast, slow])
    expect((views[0] as FakeView).loaded.at(-1)).toMatch(/\/mock\.html$/)
  })

  it('tears down a plugin\'s views (and their tokens) on destroyPlugin, the others stay', async () => {
    await manager.navigate(owner(), join(proj, 'mock.html'))
    await manager.navigate(owner('view', 'a.two'), 'https://example.com/')
    const token = tokenOf((views[0] as FakeView).loaded[0] as string)
    manager.destroyPlugin(WIN, 'a.one')
    expect((views[0] as FakeView).destroyed).toBe(true)
    expect((views[1] as FakeView).destroyed).toBe(false)
    expect(manager.has(WIN, 'a.one', 'view')).toBe(false)
    expect(manager.previewFolder(webviewPartition('P1', 'a.one'), token)).toBeUndefined()
    // The next navigate makes a fresh view.
    await manager.navigate(owner(), 'https://example.com/')
    expect(views).toHaveLength(3)
  })

  it('tears down every view of a window when it closes', async () => {
    await manager.navigate(owner(), 'https://example.com/')
    await manager.navigate(owner('view', 'a.two'), 'https://example.com/')
    await manager.navigate(owner('view', 'a.one', 8, 'P2'), 'https://example.com/')
    manager.closeWindow(WIN)
    expect(views.map((v) => v.destroyed)).toEqual([true, true, false])
  })

  // Review finding (ext round 10): a partition's cc-preview budget was never reset, so a charge
  // Electron did not give back would 503 that project and plugin's previews until a restart.
  it('says when a partition\'s last view goes (its preview budget starts over), not before', async () => {
    const one = webviewPartition('P1', 'a.one')
    await manager.navigate(owner('view'), 'https://example.com/')
    await manager.navigate(owner('second'), 'https://example.com/')
    await manager.navigate(owner('view', 'a.two'), 'https://example.com/')
    ;(views[0] as FakeView).events.gone()
    expect(closedPartitions).toEqual([])
    manager.destroyPlugin(WIN, 'a.one')
    expect(closedPartitions).toEqual([one])
    await manager.navigate(owner('view', 'a.one', 8, 'P2'), 'https://example.com/')
    manager.closeWindow(WIN)
    expect(closedPartitions).toEqual([one, webviewPartition('P1', 'a.two')])
    manager.closeWindow(8)
    expect(closedPartitions).toEqual([one, webviewPartition('P1', 'a.two'), webviewPartition('P2', 'a.one')])
  })

  it('drops a view whose page went away by itself', async () => {
    await manager.navigate(owner(), 'https://example.com/')
    ;(views[0] as FakeView).events.gone()
    expect(manager.has(WIN, 'a.one', 'view')).toBe(false)
    expect((views[0] as FakeView).destroyed).toBe(true)
  })

  it('creates no view for a navigate that outlived its plugin or window', async () => {
    const pending = manager.navigate(owner(), join(proj, 'mock.html'))
    manager.destroyPlugin(WIN, 'a.one')
    await expect(pending).rejects.toThrow(/the plugin was stopped/)
    openWindows.delete(WIN)
    await expect(manager.navigate(owner(), 'https://example.com/')).rejects.toThrow(/window is gone/)
    expect(views).toHaveLength(0)
  })
})

describe('HostApi webview requests', () => {
  const emitted: { event: string; params: unknown }[] = []
  let api: HostApi

  beforeEach(() => {
    emitted.length = 0
    const deps: HostApiDeps = {
      listSessions: () => [],
      session: () => undefined,
      send: () => {
        throw new Error('unused')
      },
      onSessionsChange: () => () => {},
      openTab: async () => {
        throw new Error('unused')
      },
      setBadge: () => true,
      openOverlay: async () => {
        throw new Error('unused')
      },
      secrets: unusedSecrets,
      oauth: unusedOAuth,
      webview: manager,
      log: () => {}
    }
    api = new HostApi(
      deps,
      {
        projectId: 'P1',
        windowId: WIN,
        projectDir: proj,
        plugins: [
          { id: 'a.one', dir: proj, panels: ['view', 'page'], webviewPanels: ['view'] },
          { id: 'a.two', dir: proj, panels: ['inbox'] }
        ]
      },
      (event, params) => emitted.push({ event, params })
    )
  })

  const call = (method: string, params: unknown): Promise<unknown> => Promise.resolve().then(() => api.handlers[method]?.(params))

  it('sends a failed load\'s error to the host with the navigation and from current', async () => {
    await call('webview.navigate', { pluginId: 'a.one', panelId: 'view', target: 'https://example.com/' })
    ;(views[0] as FakeView).events.loadFailed('http://127.0.0.1:5173/', 'ERR_CONNECTION_REFUSED (-102)')
    const failed = { url: 'http://127.0.0.1:5173/', title: '', error: 'ERR_CONNECTION_REFUSED (-102)' }
    expect(emitted).toEqual([{ event: 'webview.navigated', params: { pluginId: 'a.one', panelId: 'view', ...failed } }])
    expect(await call('webview.current', { pluginId: 'a.one', panelId: 'view' })).toEqual(failed)
  })

  it('drives a declared webview panel in the host\'s own window and reports navigations', async () => {
    await call('webview.navigate', { pluginId: 'a.one', panelId: 'view', target: 'https://example.com/' })
    const view = views[0] as FakeView
    expect(view.windowId).toBe(WIN)
    expect(view.partition).toBe('webview-P1-a.one')
    view.page = { url: 'https://example.com/', title: 'Example' }
    view.events.navigated(true)
    expect(emitted).toEqual([
      { event: 'webview.navigated', params: { pluginId: 'a.one', panelId: 'view', url: 'https://example.com/', title: 'Example' } }
    ])
    expect(await call('webview.current', { pluginId: 'a.one', panelId: 'view' })).toEqual({ url: 'https://example.com/', title: 'Example' })
    await call('webview.back', { pluginId: 'a.one', panelId: 'view' })
    await call('webview.reload', { pluginId: 'a.one', panelId: 'view' })
    expect(view.steps).toEqual(['back', 'reload'])
  })

  it('contextDisposed clears the placement of a declared panel that never navigated', async () => {
    manager.setPlacement(WIN, 'a.one', 'view', { bounds: { x: 1, y: 2, width: 300, height: 200 }, visible: true })
    api.contextDisposed({ pluginId: 'a.one' })
    // The panel is collapsed on re-enable (no report): the first view must not show at the old bounds.
    await call('webview.navigate', { pluginId: 'a.one', panelId: 'view', target: 'https://example.com/' })
    expect(manager.isShown(WIN, 'a.one', 'view')).toBe(false)
  })

  it('a dev reload that drops the last webview panel still clears the old copy\'s placement', async () => {
    manager.setPlacement(WIN, 'a.one', 'view', { bounds: { x: 1, y: 2, width: 300, height: 200 }, visible: true })
    // host-manager's order: the new declarations first, then the host disposes the old ctx.
    api.updatePlugin({ id: 'a.one', dir: proj, panels: ['page'], webviewPanels: [] })
    const contexts = new HostContexts({ log: () => {}, call: async () => null, emit: (event, params) => {
      if (event === 'plugin.disposed') api.contextDisposed(params)
    } })
    contexts.create(hostSpec({ id: 'a.one', dir: proj, main: 'h.js', panels: ['view', 'page'], webviewPanels: ['view'] }))
    contexts.dispose('a.one')
    // The panel comes back in a later reload, collapsed (no report): its first view stays hidden.
    api.updatePlugin({ id: 'a.one', dir: proj, panels: ['view', 'page'], webviewPanels: ['view'] })
    await call('webview.navigate', { pluginId: 'a.one', panelId: 'view', target: 'https://example.com/' })
    expect(manager.isShown(WIN, 'a.one', 'view')).toBe(false)
  })

  it('dispose clears the placements of declared panels that never navigated', async () => {
    manager.setPlacement(WIN, 'a.one', 'view', { bounds: { x: 1, y: 2, width: 300, height: 200 }, visible: true })
    api.dispose()
    await manager.navigate({ windowId: WIN, projectId: 'P1', pluginId: 'a.one', panelId: 'view' }, 'https://example.com/')
    expect(manager.isShown(WIN, 'a.one', 'view')).toBe(false)
  })

  it('refuses an html panel, an undeclared panel, another plugin\'s panel and an unknown plugin', async () => {
    await expect(call('webview.navigate', { pluginId: 'a.one', panelId: 'page', target: 'https://x.test/' })).rejects.toThrow(
      /declares no webview panel "page"/
    )
    await expect(call('webview.current', { pluginId: 'a.one', panelId: 'nope' })).rejects.toThrow(/declares no webview panel/)
    await expect(call('webview.navigate', { pluginId: 'a.two', panelId: 'view', target: 'https://x.test/' })).rejects.toThrow(
      /a\.two declares no webview panel "view"/
    )
    await expect(call('webview.back', { pluginId: 'z.zz', panelId: 'view' })).rejects.toThrow(/unknown plugin/)
    expect(views).toHaveLength(0)
  })

  it('caps ctx.panels.show calls per minute', async () => {
    const a = new HostApi(
      {
        listSessions: () => [],
        session: () => undefined,
        send: () => {
          throw new Error('unused')
        },
        onSessionsChange: () => () => {},
        openTab: async () => {
          throw new Error('unused')
        },
        setBadge: () => true,
        showPanel: () => true,
        openOverlay: async () => {
          throw new Error('unused')
        },
        secrets: unusedSecrets,
        oauth: unusedOAuth,
        log: () => {}
      },
      { projectId: 'P1', windowId: WIN, projectDir: '/p', plugins: [{ id: 'a.one', dir: '/p/one', panels: ['view'], webviewPanels: ['view'] }] },
      () => {}
    )
    const show = (): unknown => a.handlers['panels.show']?.({ pluginId: 'a.one', panelId: 'view' })
    for (let i = 0; i < MAX_PANEL_SHOWS_PER_WINDOW; i++) expect(show()).toBeNull()
    expect(show).toThrow(/more than 30 calls/)
  })

  it('refunds a refused target and caps navigations per minute', async () => {
    for (let i = 0; i < MAX_NAVIGATES_PER_WINDOW + 5; i++) {
      await expect(call('webview.navigate', { pluginId: 'a.one', panelId: 'view', target: 'relative.html' })).rejects.toThrow(/absolute/)
    }
    for (let i = 0; i < MAX_NAVIGATES_PER_WINDOW; i++) {
      await call('webview.navigate', { pluginId: 'a.one', panelId: 'view', target: 'https://example.com/' })
    }
    await expect(call('webview.navigate', { pluginId: 'a.one', panelId: 'view', target: 'https://example.com/' })).rejects.toThrow(
      /more than 60 navigations/
    )
  })

  it('keeps the charge of a navigate whose page failed to load: a loop on a dead server stays capped', async () => {
    nextLoad = () => Promise.reject(new Error('ERR_CONNECTION_REFUSED (-102)'))
    const target = { pluginId: 'a.one', panelId: 'view', target: 'http://127.0.0.1:5173/' }
    for (let i = 0; i < MAX_NAVIGATES_PER_WINDOW; i++) await expect(call('webview.navigate', target)).rejects.toThrow(/did not load/)
    await expect(call('webview.navigate', target)).rejects.toThrow(/more than 60 navigations/)
  })

  it('closes the plugin\'s views when its ctx ends and when the host goes; refuses once revoked', async () => {
    await call('webview.navigate', { pluginId: 'a.one', panelId: 'view', target: 'https://example.com/' })
    api.contextDisposed({ pluginId: 'a.one' })
    expect((views[0] as FakeView).destroyed).toBe(true)
    await call('webview.navigate', { pluginId: 'a.one', panelId: 'view', target: 'https://example.com/' })
    api.dispose()
    expect((views[1] as FakeView).destroyed).toBe(true)
    await expect(call('webview.navigate', { pluginId: 'a.one', panelId: 'view', target: 'https://example.com/' })).rejects.toThrow(
      /stopping/
    )
  })
})

// design-web-browser.md §3.1, §5 (plan 20261111-streamed-webviews.md Task 2): in server mode main
// gives the manager the off-screen factory (index.ts, by `server`) and the manager's own server rules
// apply: a navigate nobody sees is recorded until a browser shows the panel (setViewed, the hook
// Task 4 drives), one the CLI waits on (`now`) loads at once, at most 4 views per window and 12 in
// the app, the hidden page's placement reports and reloads change nothing, and no keyboard or chord
// path to the hidden page exists.
describe('server mode: off-screen views', () => {
  let server: WebviewManager
  let pages: Array<{ owner: WebviewOwner; page: WebviewPage }>
  const logs: string[] = []
  beforeEach(() => {
    pages = []
    logs.length = 0
    for (let id = 1; id <= 6; id++) openWindows.add(id)
    // As index.ts wires it in server mode: no chord, no focusShell, no isWindowFocused.
    const rest: WebviewManagerDeps = { ...managerDeps }
    delete rest.chord
    delete rest.focusShell
    delete rest.isWindowFocused
    server = new WebviewManager({
      ...rest,
      server: true,
      pageChanged: (owner, page) => void pages.push({ owner, page }),
      log: (m) => void logs.push(m)
    })
  })
  const now = { now: true }

  it('records a navigate no browser shows, makes no view, and loads it when the first browser shows the panel', async () => {
    const seen: WebviewPage[] = []
    await server.navigate(owner(), 'https://example.com/', (p) => seen.push(p))
    expect(views).toEqual([])
    expect(server.has(WIN, 'a.one', 'view')).toBe(false)
    expect(server.hasDeferred(WIN, 'a.one', 'view')).toBe(true)
    expect(server.current(owner())).toEqual({ url: '', title: '' })
    // Another panel's viewer loads nothing of this one.
    server.setViewed(WIN, 'a.one', 'other', true)
    expect(views).toEqual([])
    server.setViewed(WIN, 'a.one', 'view', true)
    expect(views).toHaveLength(1)
    const view = views[0] as FakeView
    expect(view.windowId).toBe(WIN)
    expect(view.loaded).toEqual(['https://example.com/'])
    expect(server.hasDeferred(WIN, 'a.one', 'view')).toBe(false)
    // The deferred navigate's listener hears the page.
    view.page = { url: 'https://example.com/', title: 'Example' }
    view.events.navigated(true)
    expect(seen).toEqual([{ url: 'https://example.com/', title: 'Example' }])
    // A second report of the same viewer, or a new one after it left, loads nothing again.
    server.setViewed(WIN, 'a.one', 'view', true)
    server.setViewed(WIN, 'a.one', 'view', false)
    server.setViewed(WIN, 'a.one', 'view', true)
    expect(view.loaded).toEqual(['https://example.com/'])
  })

  it('keeps the newest deferred navigate, resolves a file target at once, and serves it once loaded', async () => {
    await server.navigate(owner(), 'https://example.com/')
    await server.navigate(owner(), join(proj, 'mock.html'))
    // A refused target says so now, and leaves the recorded one in place.
    await expect(server.navigate(owner(), join(proj, 'missing.html'))).rejects.toThrow()
    expect(views).toEqual([])
    server.setViewed(WIN, 'a.one', 'view', true)
    const loaded = (views[0] as FakeView).loaded
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatch(/^cc-preview:\/\/t0+1\/mock\.html$/)
    expect(server.previewFolder(webviewPartition('P1', 'a.one'), tokenOf(loaded[0] as string))).toBe(proj)
  })

  it('a deferred load that fails is recorded for current() and the toolbar; nothing awaits it', async () => {
    nextLoad = () => Promise.reject(new Error('ERR_CONNECTION_REFUSED (-102)'))
    await server.navigate(owner(), 'http://127.0.0.1:9/')
    server.setViewed(WIN, 'a.one', 'view', true)
    const view = views[0] as FakeView
    view.events.loadFailed('http://127.0.0.1:9/', 'ERR_CONNECTION_REFUSED (-102)')
    expect(server.current(owner())).toEqual({ url: 'http://127.0.0.1:9/', title: '', error: 'ERR_CONNECTION_REFUSED (-102)' })
    expect(pages.at(-1)?.page.error).toBe('ERR_CONNECTION_REFUSED (-102)')
  })

  it('loads at once, viewer or not, when the caller waits (`now`: `ccc browser open`), superseding a deferred one', async () => {
    await server.navigate(owner(), 'https://home.example/')
    await server.navigate(owner(), 'https://asked.example/', undefined, now)
    expect(views).toHaveLength(1)
    expect((views[0] as FakeView).loaded).toEqual(['https://asked.example/'])
    expect(server.hasDeferred(WIN, 'a.one', 'view')).toBe(false)
    // The first viewer later has nothing left to load: the home page does not replace it.
    server.setViewed(WIN, 'a.one', 'view', true)
    expect((views[0] as FakeView).loaded).toEqual(['https://asked.example/'])
    // A failed `now` load still rejects with the error, as on the desktop.
    nextLoad = () => Promise.reject(new Error('ERR_CONNECTION_REFUSED (-102)'))
    await expect(server.navigate(owner('second'), 'http://127.0.0.1:9/', undefined, now)).rejects.toBeInstanceOf(WebviewLoadError)
  })

  it('a panel that has a view, or that a browser shows, loads every navigate at once', async () => {
    await server.navigate(owner(), 'https://a.example/', undefined, now)
    await server.navigate(owner(), 'https://b.example/')
    expect((views[0] as FakeView).loaded).toEqual(['https://a.example/', 'https://b.example/'])
    server.setViewed(WIN, 'a.one', 'second', true)
    await server.navigate(owner('second'), 'https://c.example/')
    expect((views[1] as FakeView).loaded).toEqual(['https://c.example/'])
  })

  it(`makes at most ${MAX_SERVER_VIEWS_PER_WINDOW} views per window, refused with the reason and not as a load error`, async () => {
    for (let i = 0; i < MAX_SERVER_VIEWS_PER_WINDOW; i++) await server.navigate(owner(`p${i}`), 'https://example.com/', undefined, now)
    const past = server.navigate(owner('extra'), 'https://example.com/', undefined, now)
    await expect(past).rejects.toThrow(WEBVIEW_LIMIT_REFUSAL)
    await expect(server.navigate(owner('extra'), 'https://example.com/', undefined, now)).rejects.not.toBeInstanceOf(WebviewLoadError)
    expect(WEBVIEW_LIMIT_REFUSAL).toContain(`${MAX_SERVER_VIEWS_PER_WINDOW} per project window`)
    expect(views).toHaveLength(MAX_SERVER_VIEWS_PER_WINDOW)
    // A panel that has its view keeps navigating; another window has room of its own.
    await server.navigate(owner('p0'), 'https://again.example/')
    await server.navigate(owner('p0', 'a.one', 8), 'https://example.com/', undefined, now)
    expect(views).toHaveLength(MAX_SERVER_VIEWS_PER_WINDOW + 1)
  })

  it(`makes at most ${MAX_SERVER_VIEWS} views in the app`, async () => {
    const windowsUsed = Math.ceil(MAX_SERVER_VIEWS / MAX_SERVER_VIEWS_PER_WINDOW)
    let made = 0
    for (let w = 1; w <= windowsUsed; w++) {
      for (let i = 0; i < MAX_SERVER_VIEWS_PER_WINDOW && made < MAX_SERVER_VIEWS; i++, made++) {
        await server.navigate(owner(`p${i}`, 'a.one', w), 'https://example.com/', undefined, now)
      }
    }
    expect(views).toHaveLength(MAX_SERVER_VIEWS)
    // A window with none of its own is still refused: the app is full.
    await expect(server.navigate(owner('p0', 'a.one', windowsUsed + 1), 'https://example.com/', undefined, now)).rejects.toThrow(
      WEBVIEW_LIMIT_REFUSAL
    )
  })

  it('frees a slot however a view goes: its page gone (the project window closing takes the off-screen window), its plugin, its window', async () => {
    for (let i = 0; i < MAX_SERVER_VIEWS_PER_WINDOW; i++) await server.navigate(owner(`p${i}`), 'https://example.com/', undefined, now)
    await expect(server.navigate(owner('extra'), 'https://example.com/', undefined, now)).rejects.toThrow(WEBVIEW_LIMIT_REFUSAL)
    // The adapter destroys its window when the project window closes; the page's `destroyed` is `gone`.
    ;(views[0] as FakeView).events.gone()
    expect(server.has(WIN, 'a.one', 'p0')).toBe(false)
    await server.navigate(owner('extra'), 'https://example.com/', undefined, now)
    expect(server.has(WIN, 'a.one', 'extra')).toBe(true)
    // gone after the manager's own drop (destroy fires it too) frees nothing twice.
    ;(views[0] as FakeView).events.gone()
    await expect(server.navigate(owner('more'), 'https://example.com/', undefined, now)).rejects.toThrow(WEBVIEW_LIMIT_REFUSAL)
    server.destroyPlugin(WIN, 'a.one')
    await server.navigate(owner('more'), 'https://example.com/', undefined, now)
    server.closeWindow(WIN)
    expect(views.filter((v) => !v.destroyed)).toEqual([])
    for (let i = 0; i < MAX_SERVER_VIEWS_PER_WINDOW; i++) await server.navigate(owner(`q${i}`, 'a.one', 8), 'https://example.com/', undefined, now)
  })

  it('a deferred load past the limits makes no view, tells the toolbar why, and keeps the target for the next viewer', async () => {
    await server.navigate(owner('home'), 'https://home.example/')
    for (let i = 0; i < MAX_SERVER_VIEWS_PER_WINDOW; i++) await server.navigate(owner(`p${i}`), 'https://example.com/', undefined, now)
    server.setViewed(WIN, 'a.one', 'home', true)
    expect(server.has(WIN, 'a.one', 'home')).toBe(false)
    expect(logs.join()).toContain('too many web views')
    expect(pages.at(-1)).toEqual({ owner: owner('home'), page: { url: '', title: '', error: WEBVIEW_LIMIT_REFUSAL.slice(0, MAX_LOAD_ERROR_LENGTH) } })
    expect(server.hasDeferred(WIN, 'a.one', 'home')).toBe(true)
    // Room again: the next time a browser shows the panel, it loads.
    server.destroyPlugin(WIN, 'a.one')
    await server.navigate(owner('home'), 'https://home.example/')
    server.setViewed(WIN, 'a.one', 'home', false)
    server.setViewed(WIN, 'a.one', 'home', true)
    expect(server.has(WIN, 'a.one', 'home')).toBe(true)
  })

  it('forgets deferred targets and viewers with the plugin and the window', async () => {
    await server.navigate(owner(), 'https://example.com/')
    server.destroyPlugin(WIN, 'a.one')
    expect(server.hasDeferred(WIN, 'a.one', 'view')).toBe(false)
    server.setViewed(WIN, 'a.one', 'view', true)
    expect(views).toEqual([])
    // The viewer went with the plugin: a navigate after it is deferred again.
    server.setViewed(WIN, 'a.one', 'other', true)
    server.destroyPlugin(WIN, 'a.one')
    await server.navigate(owner('other'), 'https://example.com/')
    expect(server.hasDeferred(WIN, 'a.one', 'other')).toBe(true)
    server.closeWindow(WIN)
    expect(server.hasDeferred(WIN, 'a.one', 'other')).toBe(false)
    // A window that is not open (closed, or never a project window) gets no viewer.
    openWindows.delete(WIN)
    server.setViewed(WIN, 'a.one', 'other', true)
    openWindows.add(WIN)
    await server.navigate(owner('other'), 'https://example.com/')
    expect(views).toEqual([])
  })

  it("ignores the hidden page's placement reports and reloads: views keep their page and never paint for it", async () => {
    await server.navigate(owner(), 'https://example.com/', undefined, now)
    const view = views[0] as FakeView
    server.setPlacement(WIN, 'a.one', 'view', { bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: true })
    expect(server.isShown(WIN, 'a.one', 'view')).toBe(false)
    expect(view.visible).toEqual([false])
    // index.ts does not call resetWindow for the hidden page's did-navigate in server mode; even
    // if it did, the view stays, with its page.
    server.resetWindow(WIN)
    server.setWindowCovered(WIN, true)
    server.setWindowCovered(WIN, false)
    expect(view.destroyed).toBe(false)
    expect(view.visible.every((v) => !v)).toBe(true)
    expect(server.current(owner())).toEqual({ url: 'https://example.com/', title: '' })
  })

  it('has no chord path and never hands the keyboard to the hidden page', async () => {
    await server.navigate(owner(), 'https://example.com/', undefined, now)
    const view = views[0] as FakeView
    expect(view.events.chord('Ctrl+T')).toBe(false)
    expect(chords).toEqual([])
    // Even with a focusShell dep (index.ts passes none in server mode), a view going is no hand-back.
    const withFocus = new WebviewManager({ ...managerDeps, server: true })
    await withFocus.navigate(owner(), 'https://example.com/', undefined, now)
    ;(views[1] as FakeView).focused = true
    withFocus.destroyPlugin(WIN, 'a.one')
    withFocus.windowFocused(WIN)
    expect(refocused).toEqual([])
  })

  it('the desktop (server false or absent) defers nothing and has no view limits', async () => {
    const desktop = new WebviewManager({ ...managerDeps, server: false })
    for (let i = 0; i <= MAX_SERVER_VIEWS_PER_WINDOW; i++) await desktop.navigate(owner(`p${i}`), 'https://example.com/')
    expect(views).toHaveLength(MAX_SERVER_VIEWS_PER_WINDOW + 1)
    expect(desktop.hasDeferred(WIN, 'a.one', 'p0')).toBe(false)
    // Its page's placement reports still place the view.
    desktop.setPlacement(WIN, 'a.one', 'p0', { bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: true })
    expect(desktop.isShown(WIN, 'a.one', 'p0')).toBe(true)
  })

  describe('through HostApi', () => {
    const hostApi = (cliRunning?: () => boolean): HostApi =>
      new HostApi(
        {
          listSessions: () => [],
          session: () => undefined,
          send: () => {
            throw new Error('unused')
          },
          onSessionsChange: () => () => {},
          openTab: async () => {
            throw new Error('unused')
          },
          setBadge: () => true,
          openOverlay: async () => {
            throw new Error('unused')
          },
          secrets: unusedSecrets,
          oauth: unusedOAuth,
          webview: server,
          log: () => {}
        },
        {
          projectId: 'P1',
          windowId: WIN,
          projectDir: proj,
          plugins: [{ id: 'a.one', dir: proj, panels: ['view', 'p1', 'p2', 'p3', 'p4'], webviewPanels: ['view', 'p1', 'p2', 'p3', 'p4'] }],
          ...(cliRunning ? { cliRunning } : {})
        },
        () => {}
      )
    const params = (panelId = 'view') => ({ pluginId: 'a.one', panelId, target: 'https://example.com/' })

    it("a navigate outside a `ccc` command (the browser plugin's home at activation) is deferred", async () => {
      const api = hostApi(() => false)
      await api.handlers['webview.navigate']!(params())
      expect(views).toEqual([])
      expect(server.hasDeferred(WIN, 'a.one', 'view')).toBe(true)
      api.dispose()
    })

    it('a navigate while one of the plugin\'s `ccc` commands runs (`ccc browser open`) loads at once', async () => {
      let running = true
      const api = hostApi(() => running)
      await api.handlers['webview.navigate']!(params())
      expect((views[0] as FakeView).loaded).toEqual(['https://example.com/'])
      running = false
      await api.handlers['webview.navigate']!(params('p1'))
      expect(views).toHaveLength(1)
      api.dispose()
    })

    it('a navigate past the limits is refused with the reason and refunded, so retrying never hits the rate cap', async () => {
      const api = hostApi(() => true)
      for (const panel of ['view', 'p1', 'p2', 'p3']) await api.handlers['webview.navigate']!(params(panel))
      for (let i = 0; i <= MAX_NAVIGATES_PER_WINDOW; i++) {
        await expect(Promise.resolve().then(() => api.handlers['webview.navigate']!(params('p4')))).rejects.toThrow(WEBVIEW_LIMIT_REFUSAL)
      }
      api.dispose()
    })
  })
})

describe('ctx.webview (host side)', () => {
  function setup(): { contexts: HostContexts; calls: { method: string; params: unknown }[]; events: { event: string; params: unknown }[] } {
    const calls: { method: string; params: unknown }[] = []
    const events: { event: string; params: unknown }[] = []
    const deps: ContextDeps = {
      log: () => {},
      call: async (method, params) => {
        calls.push({ method, params })
        return method === 'webview.current' ? { url: 'https://x.test/', title: 'X' } : null
      },
      emit: (event, params) => events.push({ event, params })
    }
    return { contexts: new HostContexts(deps), calls, events }
  }
  const spec = hostSpec({ id: 'a.one', dir: '/p/one', main: 'h.js', panels: ['view', 'page'], webviewPanels: ['view'] })

  it('asks main for declared webview panels and hears its navigations', async () => {
    const { contexts, calls } = setup()
    const ctx = contexts.create(spec)
    const seen: WebviewPage[] = []
    ctx.webview.onNavigate('view', (p) => seen.push(p))
    await ctx.webview.navigate('view', 'https://x.test/')
    await ctx.webview.back('view')
    await ctx.webview.forward('view')
    await ctx.webview.reload('view')
    expect(await ctx.webview.current('view')).toEqual({ url: 'https://x.test/', title: 'X' })
    expect(calls.map((c) => c.method)).toEqual(['webview.navigate', 'webview.back', 'webview.forward', 'webview.reload', 'webview.current'])
    expect(calls[0]?.params).toEqual({ pluginId: 'a.one', panelId: 'view', target: 'https://x.test/' })
    contexts.handleEvent('webview.navigated', { pluginId: 'a.one', panelId: 'view', url: 'https://x.test/2', title: 'Two' })
    contexts.handleEvent('webview.navigated', { pluginId: 'a.one', panelId: 'other', url: 'u', title: 't' })
    contexts.handleEvent('webview.navigated', { pluginId: 'a.one', panelId: 'view', url: 5 })
    expect(seen).toEqual([{ url: 'https://x.test/2', title: 'Two' }])
  })

  // Review finding (ext round 10): the e2e found the error dropped on the host side, so
  // `ccc browser url` could not report a failed load.
  it('passes a failed load\'s error on from current() and from navigations', async () => {
    const failed = { url: 'http://127.0.0.1:5173/', title: '', error: 'ERR_CONNECTION_REFUSED (-102)' }
    const contexts = new HostContexts({ log: () => {}, call: async () => failed, emit: () => {} })
    const ctx = contexts.create(spec)
    const seen: WebviewPage[] = []
    ctx.webview.onNavigate('view', (p) => seen.push(p))
    expect(await ctx.webview.current('view')).toEqual(failed)
    contexts.handleEvent('webview.navigated', { pluginId: 'a.one', panelId: 'view', ...failed })
    contexts.handleEvent('webview.navigated', { pluginId: 'a.one', panelId: 'view', url: 'u', title: 't', error: 7 })
    expect(seen).toEqual([failed, { url: 'u', title: 't' }])
  })

  it('throws at the call site for an html or undeclared panel', () => {
    const { contexts, calls } = setup()
    const ctx = contexts.create(spec)
    expect(() => ctx.webview.navigate('page', 'https://x.test/')).toThrow(/not a "webview" panel/)
    expect(() => ctx.webview.current('nope')).toThrow(/not a "webview" panel/)
    expect(() => ctx.webview.onNavigate('page', () => {})).toThrow(/not a "webview" panel/)
    expect(calls).toEqual([])
  })

  it('refuses ctx.panels.post and onMessage on a webview panel, still allows its badge', () => {
    const { contexts, calls } = setup()
    const ctx = contexts.create(spec)
    expect(() => ctx.panels.post('view', { hi: 1 })).toThrow(/"webview" panel: it has no page/)
    expect(() => ctx.panels.onMessage('view', () => {})).toThrow(/"webview" panel/)
    expect(() => ctx.panels.post('page', { hi: 1 })).not.toThrow()
    ctx.badge('view', 3)
    expect(calls.map((c) => c.method)).toEqual(['badge'])
  })

  it('tells main at dispose when the plugin declares a webview panel, even before any navigate', () => {
    const { contexts, events } = setup()
    contexts.create(spec)
    contexts.dispose('a.one')
    expect(events).toEqual([{ event: 'plugin.disposed', params: { pluginId: 'a.one' } }])
  })

  it('tells main at dispose when the ctx drove a view (and only then), and drops its listeners', async () => {
    const { contexts, events } = setup()
    const idle = contexts.create(hostSpec({ ...spec, id: 'a.two', webviewPanels: [] }))
    void idle
    contexts.dispose('a.two')
    expect(events).toEqual([])

    const ctx = contexts.create(spec)
    const seen: WebviewPage[] = []
    ctx.webview.onNavigate('view', (p) => seen.push(p))
    await ctx.webview.navigate('view', 'https://x.test/')
    contexts.dispose('a.one')
    expect(events).toEqual([{ event: 'plugin.disposed', params: { pluginId: 'a.one' } }])
    contexts.handleEvent('webview.navigated', { pluginId: 'a.one', panelId: 'view', url: 'u', title: 't' })
    expect(seen).toEqual([])
    expect(() => ctx.webview.navigate('view', 'https://x.test/')).toThrow(/deactivated/)
  })
})
