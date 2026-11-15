// ctx.files.download (design-download.md §2.1, plan Task 7): the host → main `files.download` request
// with HostApi's checks (the host's own plugin, the origin view as main knows it, the budget spent
// before the path is resolved) over a real Downloads on a temp project, wired as index.ts wires it, and
// the host-side ctx member that carries the click's view. Nothing touches the real app data dir.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostContexts } from '../../src/host/ctx'
import { carryView, dispatchInView } from '../../src/host/ctx/origin-view'
import type { RpcMeta } from '../../src/host/rpc'
import { DOWNLOAD_DESKTOP_TEXT, DOWNLOAD_NO_ORIGIN_TEXT, Downloads } from '../../src/main/files/downloads'
import { HostApi, type HostApiDeps, type HostScope } from '../../src/main/plugins/host-api'
import { DOWNLOAD_PLUGIN_MAX, isDownloadUrl, type DownloadStart } from '../../src/shared/downloads'
import { isRemoteViewId, type ViewId } from '../../src/shared/views'
import { hostSpec } from '../fakes/host-spec'
import { unusedOAuth, unusedSecrets } from '../fakes/unused-host-services'

const PROJECT = 'aaaaaaaaaaaaaaaa'
const WIN = 1
const OTHER_WIN = 2

let root: string
let project: string
let outside: string
let dataDir: string
/** What main sent each view: `downloads.start` payloads by view id. */
let sent: { viewId: ViewId; payload: DownloadStart }[]
/** Live browser views main knows: view id → its window and device. */
let views: Map<ViewId, { windowId: number; deviceId: string }>
let downloads: Downloads
const apis: HostApi[] = []

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'host-files-download-')))
  project = join(root, 'project')
  outside = join(root, 'outside')
  dataDir = join(root, 'data')
  mkdirSync(join(project, 'src'), { recursive: true })
  mkdirSync(outside)
  mkdirSync(dataDir)
  writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(project, '.env'), 'SECRET=1\n')
  writeFileSync(join(outside, 'secret.txt'), 'outside\n')
  symlinkSync(join(outside, 'secret.txt'), join(project, 'link-out.txt'))
  symlinkSync(outside, join(project, 'dir-out'))
  sent = []
  views = new Map([
    ['web:1', { windowId: WIN, deviceId: 'dev-phone' }],
    ['web:2', { windowId: OTHER_WIN, deviceId: 'dev-laptop' }]
  ])
  downloads = new Downloads({
    hooks: {
      // As index.ts: a browser view only, and false when it is gone.
      start: (viewId, payload) => {
        if (!isRemoteViewId(viewId) || !views.has(viewId)) return false
        sent.push({ viewId, payload })
        return true
      },
      failed: () => undefined
    },
    projectPath: (id) => (id === PROJECT ? project : undefined),
    windowOf: (id) => (id === PROJECT ? WIN : undefined),
    dataDir,
    env: { home: join(root, 'home'), platform: 'linux' }
  })
})

afterEach(() => {
  for (const api of apis.splice(0)) api.dispose()
  downloads.dropAll()
  rmSync(root, { recursive: true, force: true })
})

/** HostApi's deps with the downloads wiring of index.ts (the device from the view's connection). */
function deps(extra: Partial<HostApiDeps> = {}): HostApiDeps {
  return {
    listSessions: () => [],
    session: () => undefined,
    send: () => {
      throw new Error('not used')
    },
    onSessionsChange: () => () => {},
    openTab: async () => {
      throw new Error('not used')
    },
    setBadge: () => false,
    openOverlay: async () => {
      throw new Error('not used')
    },
    secrets: unusedSecrets,
    oauth: unusedOAuth,
    viewWindow: (viewId) => views.get(viewId)?.windowId,
    downloads: {
      hasBrowserView: (windowId) => [...views.values()].some((v) => v.windowId === windowId),
      start: async (caller, viewId, path, includeAll) => {
        const v = views.get(viewId)
        if (v === undefined || v.windowId !== caller.windowId) throw new Error('the browser view is gone')
        await downloads.start({ viewId, windowId: caller.windowId, deviceId: v.deviceId }, { projectId: caller.projectId, rel: path }, includeAll)
      }
    },
    log: () => {},
    ...extra
  }
}

const scope = (): HostScope => ({
  projectId: PROJECT,
  windowId: WIN,
  projectDir: '/nonexistent',
  plugins: [
    { id: 'a.one', dir: '/nonexistent/a.one', panels: [] },
    { id: 'a.two', dir: '/nonexistent/a.two', panels: [] }
  ]
})

/** HostApi's handlers called as the RPC endpoint does, with the request's meta. */
function host(d: HostApiDeps = deps()): (params: unknown, meta?: RpcMeta) => Promise<unknown> {
  const api = new HostApi(d, scope(), () => {})
  apis.push(api)
  return (params, meta) => Promise.resolve().then(() => api.handlers['files.download']!(params, meta))
}

describe('files.download (HostApi)', () => {
  it('sends a file of the project to the clicking view alone, under its name, and resolves null', async () => {
    const call = host()
    await expect(call({ pluginId: 'a.one', path: 'src/a.ts', includeAll: false }, { view: 'web:1' })).resolves.toBeNull()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.viewId).toBe('web:1')
    expect(sent[0]!.payload.name).toBe('a.ts')
    expect(isDownloadUrl(sent[0]!.payload.url)).toBe(true)
    // Dot files go (design §1.2), and '' is the project folder as a zip.
    await call({ pluginId: 'a.one', path: '.env' }, { view: 'web:1' })
    await call({ pluginId: 'a.one', path: '' }, { view: 'web:1' })
    expect(sent.map((s) => s.payload.name)).toEqual(['a.ts', '.env', 'project.zip'])
  })

  it('refuses with no origin: "needs a click" with a browser view attached, "already on this computer" with none', async () => {
    const call = host()
    // A timer or a plugin command (no meta at all), a lapsed hint (empty meta): a browser view is attached to WIN.
    for (const meta of [undefined, {}]) {
      await expect(call({ pluginId: 'a.one', path: 'src/a.ts' }, meta)).rejects.toThrow(`files.download: ${DOWNLOAD_NO_ORIGIN_TEXT}`)
    }
    // The desktop page's click carries no view: with no browser of the window attached, the desktop's answer.
    views.delete('web:1')
    await expect(call({ pluginId: 'a.one', path: 'src/a.ts' }, {})).rejects.toThrow(`files.download: ${DOWNLOAD_DESKTOP_TEXT}`)
    expect(sent).toEqual([])
  })

  it('in server mode no origin is always "needs a click" (no desktop page anyone clicks)', async () => {
    views.clear()
    const call = host(deps({ server: true }))
    await expect(call({ pluginId: 'a.one', path: 'src/a.ts' }, {})).rejects.toThrow(DOWNLOAD_NO_ORIGIN_TEXT)
  })

  it('a desktop view id named by the host is refused as the desktop (never a link for it)', async () => {
    // viewIdOf drops it on the way in (rpc.ts); were it ever to reach HostApi, both HostApi and Downloads refuse it.
    views.set('desktop:1', { windowId: WIN, deviceId: 'desktop' })
    const call = host()
    await expect(call({ pluginId: 'a.one', path: 'src/a.ts' }, { view: 'desktop:1' })).rejects.toThrow(DOWNLOAD_DESKTOP_TEXT)
    expect(sent).toEqual([])
  })

  it('a view of another window, one main never minted and one that went are no origin', async () => {
    const call = host()
    for (const view of ['web:2', 'web:99']) {
      await expect(call({ pluginId: 'a.one', path: 'src/a.ts' }, { view })).rejects.toThrow(DOWNLOAD_NO_ORIGIN_TEXT)
    }
    // Gone between the origin check and the send (the connection closed): no link is left behind.
    const d = deps()
    const start = d.downloads!.start
    d.downloads = {
      ...d.downloads!,
      start: async (...args) => {
        views.delete('web:1')
        return start(...args)
      }
    }
    await expect(host(d)({ pluginId: 'a.one', path: 'src/a.ts' }, { view: 'web:1' })).rejects.toThrow('the browser view is gone')
    expect(sent).toEqual([])
    expect(downloads.tokenCount).toBe(0)
  })

  it('refuses paths outside the project, by name and by real path', async () => {
    const call = host()
    for (const path of ['../outside/secret.txt', join(outside, 'secret.txt'), 'link-out.txt', 'dir-out', 'dir-out/secret.txt', 'nope.txt']) {
      await expect(call({ pluginId: 'a.one', path }, { view: 'web:1' }), path).rejects.toThrow(/^files\.download: /)
    }
    expect(sent).toEqual([])
  })

  it('spends the budget (10 a minute per plugin) before the path is resolved, after the origin checks', async () => {
    const call = host()
    // Origin refusals cost nothing.
    for (let i = 0; i < 3; i++) await expect(call({ pluginId: 'a.one', path: 'src/a.ts' }, {})).rejects.toThrow(DOWNLOAD_NO_ORIGIN_TEXT)
    // Refused paths do: each one is fs lookups in main.
    for (let i = 0; i < DOWNLOAD_PLUGIN_MAX; i++) {
      await expect(call({ pluginId: 'a.one', path: 'missing.txt' }, { view: 'web:1' })).rejects.toThrow('no such')
    }
    await expect(call({ pluginId: 'a.one', path: 'src/a.ts' }, { view: 'web:1' })).rejects.toThrow(
      `files.download: more than ${DOWNLOAD_PLUGIN_MAX} in 60 s`
    )
    expect(sent).toEqual([])
    // Per plugin: the other plugin of the host still has all of it.
    await call({ pluginId: 'a.two', path: 'src/a.ts' }, { view: 'web:1' })
    expect(sent).toHaveLength(1)
  })

  it('checks the shapes and the plugin before anything, and is refused without the downloads dep', async () => {
    const call = host()
    await expect(call({ pluginId: 'x.other', path: 'src/a.ts' }, { view: 'web:1' })).rejects.toThrow()
    await expect(call({ pluginId: 'a.one', path: 3 }, { view: 'web:1' })).rejects.toThrow('path must be a string')
    await expect(call({ pluginId: 'a.one', path: 'src', includeAll: 'yes' }, { view: 'web:1' })).rejects.toThrow('includeAll must be a boolean')
    const without = deps()
    delete without.downloads
    await expect(host(without)({ pluginId: 'a.one', path: 'src/a.ts' }, { view: 'web:1' })).rejects.toThrow('not available')
    expect(sent).toEqual([])
  })
})

describe('ctx.files.download (host)', () => {
  function ctxFor() {
    const api = new HostApi(deps(), scope(), () => {})
    apis.push(api)
    const calls: { method: string; params: unknown; view?: ViewId }[] = []
    const contexts = new HostContexts({
      log: () => {},
      // As host/index.ts: every request carries the view of the listener it runs in (carryView).
      call: carryView((method, params, options?: { timeoutMs?: number; view?: ViewId }) => {
        calls.push({ method, params, ...(options?.view !== undefined ? { view: options.view } : {}) })
        return Promise.resolve().then(() => api.handlers[method]!(params, options?.view !== undefined ? { view: options.view } : {}))
      })
    })
    return { ctx: contexts.create(hostSpec({ id: 'a.one', dir: '/nonexistent/a.one', main: 'm.js' })), contexts, calls }
  }

  it("carries the click's view and the include choice; resolves undefined", async () => {
    const { ctx, calls } = ctxFor()
    await expect(dispatchInView('web:1', () => ctx.files.download('src'))).resolves.toBeUndefined()
    await dispatchInView('web:1', () => ctx.files.download('', { includeGitAndNodeModules: true }))
    expect(calls).toEqual([
      { method: 'files.download', params: { pluginId: 'a.one', path: 'src', includeAll: false }, view: 'web:1' },
      { method: 'files.download', params: { pluginId: 'a.one', path: '', includeAll: true }, view: 'web:1' }
    ])
    expect(sent.map((s) => [s.viewId, s.payload.name])).toEqual([
      ['web:1', 'src.zip'],
      ['web:1', 'project.zip']
    ])
  })

  it('rejects with the message to show when there is no click (outside a listener)', async () => {
    const { ctx } = ctxFor()
    await expect(ctx.files.download('src/a.ts')).rejects.toThrow(`files.download: ${DOWNLOAD_NO_ORIGIN_TEXT}`)
  })

  it('refuses a bad call shape before asking main, and rejects after deactivate', async () => {
    const { ctx, calls, contexts } = ctxFor()
    await expect(ctx.files.download(3 as never)).rejects.toThrow('files.download needs a path relative to the project folder')
    await expect(ctx.files.download('a', null as never)).rejects.toThrow('options must be an object')
    await expect(ctx.files.download('a', { includeGitAndNodeModules: 'yes' as never })).rejects.toThrow('must be a boolean')
    expect(calls).toEqual([])
    contexts.dispose('a.one')
    await expect(ctx.files.download('a')).rejects.toThrow('deactivated')
  })
})
