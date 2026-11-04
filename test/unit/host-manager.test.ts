import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { panelPortTag } from '../../src/host/ctx/ui'
import { RpcEndpoint, type RpcHandler } from '../../src/host/rpc'
import {
  activateBudgetMs,
  CRASH_WINDOW_MS,
  DEACTIVATE_GRACE_MS,
  HostManager,
  hostPluginSource,
  hostEnv,
  MAX_NOTIFICATIONS_PER_WINDOW,
  NOTIFY_WINDOW_MS,
  type HostCommandSink,
  type HostNotifySource,
  type HostSettings,
  type PluginLogEntry,
  LOG_WINDOW_MS,
  MAX_LOG_LINES_PER_WINDOW,
  restartDelay,
  STOPPED_TEXT,
  type HostPlugin,
  type HostProcess,
  type HostProcessFactory,
  type HostSpawnOptions
} from '../../src/main/plugins/host-manager'
import type { PanelStatus, PluginPanelDef } from '../../src/main/layout/layout-service'
import type { PluginNotice } from '../../src/main/notifications/notifier'
import { MAX_NOTIFY_ACTION_LABEL, MAX_NOTIFY_TITLE } from '../../src/shared/notify'
import { MAX_SOUND_ID_LENGTH } from '../../src/shared/notify-sound'
import { memoryPortPair } from '../fakes/memory-port'
import { unusedOAuth, unusedSecrets } from '../fakes/unused-host-services'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** A host process whose other end is an RpcEndpoint with scriptable handlers. */
class FakeHost implements HostProcess {
  readonly port
  readonly host: RpcEndpoint
  killed = false
  exited = false
  private readonly exitListeners: Array<(code: number) => void> = []
  readonly calls: string[] = []

  constructor(
    readonly options: HostSpawnOptions,
    handlers: Record<string, RpcHandler>,
    onEvent?: (event: string, params: unknown) => void
  ) {
    const [main, host] = memoryPortPair()
    this.port = main
    const record = (name: string, h: RpcHandler): RpcHandler => (p) => {
      this.calls.push(name)
      return h(p)
    }
    this.host = new RpcEndpoint({
      port: host,
      handlers: Object.fromEntries(Object.entries(handlers).map(([k, h]) => [k, record(k, h)])),
      ...(onEvent ? { onEvent } : {})
    })
  }

  onExit(listener: (code: number) => void): void {
    this.exitListeners.push(listener)
  }

  kill(): void {
    this.killed = true
    this.exit(-1)
  }

  /** Panel ports main handed over (panel-ports.ts), with the message that tagged each. */
  readonly ports: { message: string; port: unknown }[] = []
  transferPort(message: string, port: unknown): void {
    if (this.exited) throw new Error('plugin host has exited')
    this.ports.push({ message, port })
  }

  /** The process ends (a crash when main did not ask for it). */
  exit(code: number): void {
    if (this.exited) return
    this.exited = true
    this.host.close('exited')
    queueMicrotask(() => {
      for (const l of this.exitListeners) l(code)
    })
  }
}

/** Default host behaviour: every plugin activates, deactivate answers at once. */
const okHandlers = (): Record<string, RpcHandler> => ({
  activate: (p) => (p as { plugins: { id: string }[] }).plugins.map((x) => ({ id: x.id, state: 'active' })),
  deactivate: () => null
})

class FakeFactory implements HostProcessFactory {
  readonly spawned: FakeHost[] = []
  handlers: () => Record<string, RpcHandler> = okHandlers
  /** Receives the events main sends to a host (e.g. `settings`). */
  onHostEvent: ((event: string, params: unknown) => void) | undefined
  spawn(options: HostSpawnOptions): HostProcess {
    const h = new FakeHost(options, this.handlers(), this.onHostEvent)
    this.spawned.push(h)
    return h
  }
  get last(): FakeHost {
    const h = this.spawned.at(-1)
    if (!h) throw new Error('nothing spawned')
    return h
  }
}

class FakeLayouts {
  readonly panels = new Map<string, PluginPanelDef[]>()
  readonly status = new Map<string, PanelStatus | undefined>()
  /** Make the next setPluginPanels throw (a layout service bug). */
  failNext = false
  setPluginPanels(projectId: string, pluginId: string, panels: readonly PluginPanelDef[]): void {
    if (this.failNext) {
      this.failNext = false
      throw new Error('layout broke')
    }
    const key = `${projectId}:${pluginId}`
    if (panels.length === 0) this.panels.delete(key)
    else this.panels.set(key, [...panels])
  }
  setError(projectId: string, panelKey: string, error: string | undefined): boolean {
    this.status.set(`${projectId}:${panelKey}`, error === undefined ? undefined : { error })
    return true
  }
}

const panel = (id: string): PluginPanelDef => ({ id, title: id, defaultZone: 'left' })
const plugin = (id: string, extra: Partial<HostPlugin> = {}): HostPlugin => ({
  id,
  dir: `/plugins/${id}`,
  main: 'host.js',
  panels: [panel('main')],
  ...extra
})

describe('HostManager', () => {
  let factory: FakeFactory
  let layouts: FakeLayouts
  let enabled: Record<string, HostPlugin[]>
  let listError: Error | undefined
  let log: ReturnType<typeof vi.fn<(message: string) => void>>
  let manager: HostManager
  /** What the settings service answers per `<projectId>:<pluginId>` (default: valid, empty). */
  let settingsFor: Record<string, HostSettings>
  let sink: { added: string[]; removed: string[]; cleared: string[] } & HostCommandSink
  let notified: { text: string; projectId: string; pluginId: string }[]
  /** Every deps.notify call in full (notice, main's source, the abort signal). */
  let noticeCalls: { notice: PluginNotice; source: HostNotifySource; signal: AbortSignal }[]
  /** What deps.notify returns for a notice with an action (default: never settles). */
  let notifyAnswer: (signal: AbortSignal) => Promise<boolean>
  let pluginLines: PluginLogEntry[]
  /** Launches that finished activating (onPluginsReady: their panel pages reload). */
  let ready: { projectId: string; pluginIds: string[] }[]

  beforeEach(() => {
    vi.useFakeTimers()
    factory = new FakeFactory()
    layouts = new FakeLayouts()
    enabled = { p1: [plugin('a.one'), plugin('a.two')], p2: [plugin('a.two')] }
    listError = undefined
    settingsFor = {}
    notified = []
    noticeCalls = []
    notifyAnswer = () => new Promise(() => {})
    pluginLines = []
    ready = []
    sink = {
      added: [],
      removed: [],
      cleared: [],
      add: (projectId, pluginId, def) => void sink.added.push(`${projectId}:${pluginId}/${def.id}`),
      remove: (projectId, pluginId, id) => void sink.removed.push(`${projectId}:${pluginId}/${id}`),
      clear: (projectId, pluginId) => void sink.cleared.push(`${projectId}:${pluginId}`)
    }
    log = vi.fn<(message: string) => void>()
    manager = new HostManager({
      factory,
      plugins: async (projectId) => {
        if (listError) throw listError
        return enabled[projectId] ?? []
      },
      env: async () => ({ PATH: '/usr/bin', HOME: '/home/u', GITHUB_TOKEN: 'secret', LC_ALL: 'C' }),
      projectPath: (projectId) => `/projects/${projectId}`,
      projectName: (projectId) => `name-${projectId}`,
      layouts,
      pluginDataDir: (projectId, pluginId) => `/data/plugin-data/${projectId}/${pluginId}`,
      pluginAppDataDir: (pluginId) => `/data/plugin-data/_app/${pluginId}`,
      settings: (projectId, pluginId) => settingsFor[`${projectId}:${pluginId}`] ?? { ok: true, project: {}, app: {} },
      commands: sink,
      notify: (notice, source, signal) => {
        notified.push({ text: notice.text, projectId: source.projectId, pluginId: source.pluginId })
        noticeCalls.push({ notice, source, signal })
        return notice.action ? notifyAnswer(signal) : undefined
      },
      pluginLog: (entry) => void pluginLines.push(entry),
      onPluginsReady: (projectId, pluginIds) => void ready.push({ projectId, pluginIds }),
      log
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('spawns one host per project window with a minimal env and activates its plugins', async () => {
    await manager.open('p1', 1)
    expect(factory.spawned).toHaveLength(1)
    const opts = factory.last.options
    expect(opts.env).toEqual({ PATH: '/usr/bin', HOME: '/home/u', LC_ALL: 'C' })
    expect(opts.cwd).toBe('/projects/p1')
    expect(opts.name).toBe('cc-cockpit plugin host (name-p1)')
    expect(layouts.panels.get('p1:a.one')).toEqual([panel('main')])
    expect(manager.status('p1')).toEqual({
      running: true,
      stopped: false,
      plugins: [
        { id: 'a.one', state: 'active' },
        { id: 'a.two', state: 'active' }
      ]
    })
    // Opening the same project again does not start a second host.
    await manager.open('p1', 1)
    expect(factory.spawned).toHaveLength(1)
  })

  it('marks an errored plugin on its panels and trusts only results for its own plugins', async () => {
    factory.handlers = () => ({
      activate: () => [
        { id: 'a.one', state: 'errored', error: 'activate() failed: boom' },
        { id: 'a.two', state: 'active' },
        { id: 'evil.other', state: 'active' }
      ],
      deactivate: () => null
    })
    await manager.open('p1', 1)
    expect(layouts.status.get('p1:a.one/main')).toEqual({ error: 'activate() failed: boom' })
    expect(layouts.status.get('p1:a.two/main')).toBeUndefined()
    expect(manager.status('p1')?.plugins.map((p) => p.id)).toEqual(['a.one', 'a.two'])
  })

  it('marks a plugin the host did not report as errored', async () => {
    factory.handlers = () => ({ activate: () => [{ id: 'a.one', state: 'active' }], deactivate: () => null })
    await manager.open('p1', 1)
    expect(manager.status('p1')?.plugins[1]).toEqual({
      id: 'a.two',
      state: 'errored',
      error: 'the plugin host did not report it'
    })
  })

  it('starts no process when no enabled plugin has host code, but declares their panels', async () => {
    enabled.p3 = [plugin('a.static', { main: undefined })]
    await manager.open('p3', 3)
    expect(factory.spawned).toHaveLength(0)
    expect(layouts.panels.get('p3:a.static')).toEqual([panel('main')])
    expect(manager.status('p3')).toEqual({ running: false, stopped: false, plugins: [] })
  })

  it('reloads the panels of a static-only plugin after an update or a re-enable (no host to signal it)', async () => {
    enabled.p3 = [plugin('a.static', { main: undefined })]
    await manager.open('p3', 3)
    ready = []
    await manager.reloadPlugin('a.static')
    expect(ready).toEqual([{ projectId: 'p3', pluginIds: ['a.static'] }])
    // Mixed with a plugin that runs in a host: both reload, each once.
    enabled.p3 = [plugin('a.static', { main: undefined }), plugin('a.one')]
    ready = []
    await manager.enabledChanged('p3')
    expect(ready).toEqual([
      { projectId: 'p3', pluginIds: ['a.one'] },
      { projectId: 'p3', pluginIds: ['a.static'] }
    ])
  })

  it('deactivates on close, then kills', async () => {
    await manager.open('p1', 1)
    const host = factory.last
    await manager.close('p1')
    expect(host.calls).toEqual(['activate', 'deactivate'])
    expect(host.killed).toBe(true)
    expect(manager.status('p1')).toBeUndefined()
    // An exit we caused is not a crash: nothing restarts.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(factory.spawned).toHaveLength(1)
  })

  it('kills a host whose deactivate does not answer within 5 s', async () => {
    factory.handlers = () => ({ ...okHandlers(), deactivate: () => new Promise(() => {}) })
    await manager.open('p1', 1)
    const host = factory.last
    const closing = manager.close('p1')
    await vi.advanceTimersByTimeAsync(DEACTIVATE_GRACE_MS - 1)
    expect(host.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await closing
    expect(host.killed).toBe(true)
  })

  it("starts a reopened window's host only once the closing host of the project has exited", async () => {
    // Both hosts would share each plugin's storage.json: the old one's last flush would overwrite
    // what the new one wrote with its stale snapshot.
    factory.handlers = () => ({ ...okHandlers(), deactivate: () => new Promise(() => {}) })
    await manager.open('p1', 1)
    const old = factory.last
    const closing = manager.close('p1')
    await flush()
    factory.handlers = okHandlers
    const opening = manager.open('p1', 2)
    await flush()
    // Every other way to launch waits too (a restart, a settings or enabled-set change).
    const restarting = manager.restart('p1')
    await flush()
    expect(factory.spawned).toHaveLength(1)
    // Another project is not held up.
    await manager.open('p2', 3)
    expect(factory.spawned).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(DEACTIVATE_GRACE_MS)
    await Promise.all([closing, opening, restarting])
    expect(old.exited).toBe(true)
    // One new host for p1 (the restart replaced the open's launch before it spawned).
    expect(factory.spawned.filter((h) => h.options.cwd === '/projects/p1')).toHaveLength(2)
    expect(manager.status('p1')?.running).toBe(true)
  })

  it('a project closed and reopened twice within the grace still waits for the first host', async () => {
    factory.handlers = () => ({ ...okHandlers(), deactivate: () => new Promise(() => {}) })
    await manager.open('p1', 1)
    const first = factory.last
    const closing1 = manager.close('p1')
    await flush()
    factory.handlers = okHandlers
    const opening1 = manager.open('p1', 2)
    await flush()
    // The second window closes before its host could start, and the project opens a third time.
    const closing2 = manager.close('p1')
    const opening2 = manager.open('p1', 3)
    await flush()
    expect(factory.spawned).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(DEACTIVATE_GRACE_MS - 1)
    expect(factory.spawned).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([closing1, opening1, closing2, opening2])
    expect(first.exited).toBe(true)
    expect(factory.spawned).toHaveLength(2)
    expect(manager.status('p1')?.running).toBe(true)
  })

  it("a reopened window's host is activated with settings changed while it waited for the closing host", async () => {
    factory.handlers = () => ({ ...okHandlers(), deactivate: () => new Promise(() => {}) })
    await manager.open('p1', 1)
    const closing = manager.close('p1')
    await flush()
    let params: { plugins: { id: string; settings: unknown }[] } | undefined
    factory.handlers = () => ({
      ...okHandlers(),
      activate: (p) => {
        params = p as typeof params
        return (p as { plugins: { id: string }[] }).plugins.map((x) => ({ id: x.id, state: 'active' }))
      }
    })
    const opening = manager.open('p1', 2)
    await flush()
    // Saved while the new host waits: there is no process yet to push the values to.
    settingsFor['p1:a.one'] = { ok: true, project: { limit: 7 }, app: { url: 'new' } }
    await manager.settingsChanged('p1', 'a.one')
    expect(factory.spawned).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(DEACTIVATE_GRACE_MS)
    await Promise.all([closing, opening])
    expect(factory.spawned).toHaveLength(2)
    expect(params?.plugins.find((p) => p.id === 'a.one')?.settings).toEqual({ project: { limit: 7 }, app: { url: 'new' } })
  })

  it('restarts a crashed host after 1, 2, 4, 8 s and gives up at the fifth crash within 2 minutes', async () => {
    await manager.open('p1', 1)
    // The panel's Restart (plugins.restart) does nothing to a healthy host.
    await manager.restartStopped('p1')
    expect(factory.spawned).toHaveLength(1)
    expect(factory.last.killed).toBe(false)
    const delays = [1000, 2000, 4000, 8000]
    for (const [i, delay] of delays.entries()) {
      factory.last.exit(1)
      await flush()
      // ...nor to one in backoff: the crash budget keeps counting.
      await manager.restartStopped('p1')
      expect(factory.spawned).toHaveLength(i + 1)
      expect(manager.status('p1')?.running).toBe(false)
      expect(layouts.status.get('p1:a.one/main')).toEqual({
        error: `plugin host crashed; restarting in ${delay / 1000} s`
      })
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(factory.spawned).toHaveLength(i + 1)
      await vi.advanceTimersByTimeAsync(1)
      await flush()
      expect(factory.spawned).toHaveLength(i + 2)
      expect(manager.status('p1')?.running).toBe(true)
      // A restarted host clears the crash mark once its plugins are active again.
      expect(layouts.status.get('p1:a.one/main')).toBeUndefined()
    }
    factory.last.exit(1)
    await flush()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(factory.spawned).toHaveLength(5)
    expect(manager.status('p1')).toEqual({
      running: false,
      stopped: true,
      plugins: [
        { id: 'a.one', state: 'stopped' },
        { id: 'a.two', state: 'stopped' }
      ]
    })
    expect(layouts.status.get('p1:a.one/main')).toEqual({ error: STOPPED_TEXT })
    expect(layouts.status.get('p1:a.two/main')).toEqual({ error: STOPPED_TEXT })

    // Restart (the panel's button) starts it again with a fresh budget; a second click does not.
    await manager.restartStopped('p1')
    expect(factory.spawned).toHaveLength(6)
    await manager.restartStopped('p1')
    expect(factory.spawned).toHaveLength(6)
    expect(manager.status('p1')?.stopped).toBe(false)
    expect(layouts.status.get('p1:a.one/main')).toBeUndefined()
    factory.last.exit(1)
    await flush()
    await vi.advanceTimersByTimeAsync(1000)
    expect(factory.spawned).toHaveLength(7)
  })

  it('caps the delay at 30 s and starts a new series after a host that lived 2 minutes', async () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(restartDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
    await manager.open('p1', 1)
    // Crashes spaced so that never 5 fall within 2 minutes: the backoff keeps growing, no give-up.
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000]) {
      await vi.advanceTimersByTimeAsync(40_000)
      factory.last.exit(1)
      await flush()
      expect(layouts.status.get('p1:a.one/main')).toEqual({
        error: `plugin host crashed; restarting in ${delay / 1000} s`
      })
      await vi.advanceTimersByTimeAsync(delay)
      await flush()
    }
    expect(manager.status('p1')?.stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(CRASH_WINDOW_MS)
    factory.last.exit(1)
    await flush()
    expect(layouts.status.get('p1:a.one/main')).toEqual({ error: 'plugin host crashed; restarting in 1 s' })
  })

  it('cancels a pending restart when the window closes', async () => {
    await manager.open('p1', 1)
    factory.last.exit(1)
    await flush()
    await manager.close('p1')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(factory.spawned).toHaveLength(1)
  })

  it('kills a host that never answers activate, and treats that as a crash', async () => {
    factory.handlers = () => ({ activate: () => new Promise(() => {}), deactivate: () => null })
    const opening = manager.open('p1', 1)
    await vi.advanceTimersByTimeAsync(activateBudgetMs(2))
    await opening
    expect(factory.spawned[0]?.killed).toBe(true)
    await flush()
    expect(log).toHaveBeenCalledWith('plugin host p1: activate unanswered, killing the host')
    await vi.advanceTimersByTimeAsync(1000)
    expect(factory.spawned).toHaveLength(2)
  })

  it('gives activate 5 s more per plugin: the loader requires their modules one after another', async () => {
    expect([1, 2, 3].map((n) => activateBudgetMs(n))).toEqual([15_000, 20_000, 25_000])
    // Two plugins whose requires took 9 s in all: the answer at 18 s is in time.
    factory.handlers = () => ({
      ...okHandlers(),
      activate: (p) => new Promise((r) => setTimeout(() => r(okHandlers().activate?.(p)), 18_000))
    })
    const opening = manager.open('p1', 1)
    await vi.advanceTimersByTimeAsync(18_000)
    await opening
    expect(factory.last.killed).toBe(false)
    expect(manager.status('p1')?.plugins.every((p) => p.state === 'active')).toBe(true)
  })

  it('caps the error text a host reports for a plugin', async () => {
    factory.handlers = () => ({
      activate: () => [
        { id: 'a.one', state: 'errored', error: 'x'.repeat(10_000) },
        { id: 'a.two', state: 'active' }
      ],
      deactivate: () => null
    })
    await manager.open('p1', 1)
    const shown = layouts.status.get('p1:a.one/main')?.error ?? ''
    expect(shown).toBe(`${'x'.repeat(500)}…`)
    expect(manager.status('p1')?.plugins[0]).toEqual({ id: 'a.one', state: 'errored', error: shown })
  })

  it('shows why a crash restart could not start instead of "restarting in N s" forever', async () => {
    await manager.open('p1', 1)
    factory.last.exit(1)
    await flush()
    listError = new Error('index unreadable')
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(factory.spawned).toHaveLength(1)
    expect(layouts.status.get('p1:a.one/main')).toEqual({
      error: 'plugin host did not start: cannot list plugins: index unreadable'
    })
    expect(manager.status('p1')?.plugins[1]).toMatchObject({ state: 'errored' })
  })

  it('catches a throw in a timer-started restart and shows it on the panels', async () => {
    await manager.open('p1', 1)
    factory.last.exit(1)
    await flush()
    layouts.failNext = true
    // An unhandled rejection here would fail the test run.
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(layouts.status.get('p1:a.one/main')).toEqual({ error: 'plugin host did not start: layout broke' })
  })

  it('marks every plugin errored when the host process cannot be spawned', async () => {
    vi.spyOn(factory, 'spawn').mockImplementation(() => {
      throw new Error('no utility process')
    })
    await manager.open('p1', 1)
    expect(manager.status('p1')).toEqual({
      running: false,
      stopped: false,
      plugins: [
        { id: 'a.one', state: 'errored', error: 'plugin host did not start: no utility process' },
        { id: 'a.two', state: 'errored', error: 'plugin host did not start: no utility process' }
      ]
    })
    expect(layouts.status.get('p1:a.two/main')).toEqual({ error: 'plugin host did not start: no utility process' })
  })

  it('stops cleanly when the window closes while activate is still running', async () => {
    factory.handlers = () => ({ ...okHandlers(), activate: () => new Promise(() => {}) })
    const opening = manager.open('p1', 1)
    await flush()
    const host = factory.last
    await manager.close('p1')
    await opening
    expect(host.calls).toEqual(['activate', 'deactivate'])
    expect(host.killed).toBe(true)
    // The abandoned activate is neither a timeout kill nor a crash: nothing restarts.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(factory.spawned).toHaveLength(1)
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('activate unanswered'))
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('exited unexpectedly'))
  })

  it('does not count a host that dies while deactivating as a crash', async () => {
    factory.handlers = () => ({ ...okHandlers(), deactivate: () => new Promise(() => {}) })
    await manager.open('p1', 1)
    const first = factory.last
    const restarting = manager.restart('p1')
    await flush()
    expect(first.calls).toEqual(['activate', 'deactivate'])
    first.exit(1)
    await restarting
    expect(factory.spawned).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(factory.spawned).toHaveLength(2)
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('exited unexpectedly'))
    expect(manager.status('p1')?.running).toBe(true)
  })

  it('restarts once, cancelling the pending crash restart, when restart() or reloadPlugin comes during backoff', async () => {
    await manager.open('p1', 1)
    factory.last.exit(1)
    await flush()
    await manager.restart('p1')
    expect(factory.spawned).toHaveLength(2)
    expect(layouts.status.get('p1:a.one/main')).toBeUndefined()
    factory.last.exit(1)
    await flush()
    await manager.reloadPlugin('a.one')
    expect(factory.spawned).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(factory.spawned).toHaveLength(3)
    expect(manager.status('p1')?.running).toBe(true)
  })

  it('enabledChanged restarts the host with the new set: the old process goes, the panels follow', async () => {
    await manager.open('p1', 1)
    const first = factory.last
    expect(layouts.panels.has('p1:a.one')).toBe(true)
    // The project turned a.one off in Settings › This project.
    enabled.p1 = [plugin('a.two')]
    await manager.enabledChanged('p1')
    expect(first.killed).toBe(true)
    expect(factory.spawned).toHaveLength(2)
    expect(layouts.panels.has('p1:a.one')).toBe(false)
    expect(layouts.panels.has('p1:a.two')).toBe(true)
    expect(manager.status('p1')?.plugins).toEqual([{ id: 'a.two', state: 'active' }])
    // And on again.
    enabled.p1 = [plugin('a.one'), plugin('a.two')]
    await manager.enabledChanged('p1')
    expect(factory.spawned).toHaveLength(3)
    expect(manager.status('p1')?.plugins.map((p) => p.id)).toEqual(['a.one', 'a.two'])
  })

  it('enabledChanged with nothing left to run stops the process and drops every panel', async () => {
    await manager.open('p2', 1)
    const first = factory.last
    enabled.p2 = []
    await manager.enabledChanged('p2')
    expect(first.killed).toBe(true)
    expect(factory.spawned).toHaveLength(1)
    expect(layouts.panels.has('p2:a.two')).toBe(false)
    expect(manager.status('p2')).toEqual({ running: false, stopped: false, plugins: [] })
  })

  it('enabledChanged for a project without a host does nothing', async () => {
    await manager.enabledChanged('nobody')
    expect(factory.spawned).toHaveLength(0)
  })

  it('replaces a host whose activate is still running on restart, and the old launch gives up', async () => {
    let n = 0
    factory.handlers = () => (n++ === 0 ? { ...okHandlers(), activate: () => new Promise(() => {}) } : okHandlers())
    const opening = manager.open('p1', 1)
    await flush()
    await manager.restart('p1')
    await opening
    expect(factory.spawned).toHaveLength(2)
    expect(factory.spawned[0]?.killed).toBe(true)
    expect(manager.status('p1')).toEqual({
      running: true,
      stopped: false,
      plugins: [
        { id: 'a.one', state: 'active' },
        { id: 'a.two', state: 'active' }
      ]
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(factory.spawned).toHaveLength(2)
  })

  it('reloads only the hosts that run a plugin, from the current plugin list', async () => {
    await manager.open('p1', 1)
    await manager.open('p2', 2)
    expect(factory.spawned).toHaveLength(2)
    const [h1, h2] = factory.spawned
    // a.one is uninstalled: p1 restarts without it, p2 (which never had it) is left alone.
    enabled.p1 = [plugin('a.two')]
    await manager.reloadPlugin('a.one')
    expect(h1?.calls).toEqual(['activate', 'deactivate'])
    expect(h1?.killed).toBe(true)
    expect(h2?.killed).toBe(false)
    expect(factory.spawned).toHaveLength(3)
    expect(layouts.panels.has('p1:a.one')).toBe(false)
    expect(manager.status('p1')?.plugins).toEqual([{ id: 'a.two', state: 'active' }])
  })

  it('does not spawn when the window closes while the plugin list is still loading', async () => {
    let release: (v: HostPlugin[]) => void = () => {}
    const slow = new HostManager({
      factory,
      plugins: () => new Promise((r) => (release = r)),
      env: () => ({}),
      projectPath: () => undefined,
      layouts,
      pluginDataDir: () => '/data',
      pluginAppDataDir: (pluginId) => `/data/plugin-data/_app/${pluginId}`,
      log
    })
    const opening = slow.open('p1', 1)
    await slow.close('p1')
    release([plugin('a.one')])
    await opening
    expect(factory.spawned).toHaveLength(0)
    expect(layouts.panels.size).toBe(0)
  })

  it('logs ctx.log events only for the host\'s own plugins', async () => {
    await manager.open('p1', 1)
    factory.last.host.emit('log', { pluginId: 'a.one', level: 'warn', text: 'hello' })
    factory.last.host.emit('log', { pluginId: 'someone.else', level: 'warn', text: 'spoof' })
    await flush()
    expect(log).toHaveBeenCalledWith('plugin a.one (p1) warn: hello')
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('spoof'))
  })

  it('writes a plugin log line as one line, so it cannot forge another plugin\'s', async () => {
    await manager.open('p1', 1)
    factory.last.host.emit('log', { pluginId: 'a.one', level: 'info', text: 'ok\nplugin a.two (p1) error: forged\r\nx' })
    await flush()
    expect(log).toHaveBeenCalledWith('plugin a.one (p1) info: ok\\nplugin a.two (p1) error: forged\\nx')
  })

  it('caps plugin log lines per host and reports the dropped count in the next window', async () => {
    await manager.open('p1', 1)
    log.mockClear()
    for (let i = 0; i < MAX_LOG_LINES_PER_WINDOW + 50; i++) {
      factory.last.host.emit('log', { pluginId: 'a.one', level: 'info', text: `line ${i}` })
    }
    await flush()
    expect(log).toHaveBeenCalledTimes(MAX_LOG_LINES_PER_WINDOW)
    await vi.advanceTimersByTimeAsync(LOG_WINDOW_MS)
    factory.last.host.emit('log', { pluginId: 'a.one', level: 'info', text: 'after' })
    await flush()
    expect(log).toHaveBeenCalledWith('plugin host p1: 50 plugin log lines dropped (over 100 in 10 s)')
    expect(log).toHaveBeenLastCalledWith('plugin a.one (p1) info: after')
  })

  it('refuses host -> main calls it has no handler for (no `api` deps: no sessions)', async () => {
    await manager.open('p1', 1)
    await expect(factory.last.host.call('sessions.list')).rejects.toThrow('unknown method: sessions.list')
    await expect(factory.last.host.call('panels.whatever')).rejects.toThrow('unknown method: panels.whatever')
  })

  describe('sessions, badge and overlay (Task 27)', () => {
    let badges: { projectId: string; key: string; badge: unknown }[]
    let overlaysOpened: { windowId: number; spec: unknown; opener: string; signal: AbortSignal | undefined }[]
    let listeners: Set<(change: never) => void>

    beforeEach(() => {
      badges = []
      overlaysOpened = []
      listeners = new Set()
      manager = new HostManager({
        factory,
        plugins: async (projectId) => enabled[projectId] ?? [],
        env: async () => ({ PATH: '/usr/bin' }),
        projectPath: (projectId) => `/projects/${projectId}`,
        layouts,
        pluginDataDir: (projectId, pluginId) => `/data/plugin-data/${projectId}/${pluginId}`,
        pluginAppDataDir: (pluginId) => `/data/plugin-data/_app/${pluginId}`,
        settings: (projectId, pluginId) => settingsFor[`${projectId}:${pluginId}`] ?? { ok: true, project: {}, app: {} },
        api: {
          listSessions: (projectId) =>
            projectId === 'p1'
              ? [{ tabId: 't1', projectId: 'p1', kind: 'claude', cwd: '/projects/p1', status: 'idle', notes: [], files: [], queue: [], delivering: false }]
              : [],
          session: () => undefined,
          send: () => ({ id: 'q', delivered: false }),
          onSessionsChange: (l) => {
            listeners.add(l as never)
            return () => listeners.delete(l as never)
          },
          openTab: async () => ({ id: 'new' }),
          setBadge: (projectId, key, badge) => {
            badges.push({ projectId, key, badge })
            return true
          },
          openOverlay: (windowId, spec, opener, signal) => {
            overlaysOpened.push({ windowId, spec, opener, signal })
            return new Promise((resolve) => signal?.addEventListener('abort', () => resolve({ kind: 'dismissed' })))
          },
          secrets: unusedSecrets,
          oauth: unusedOAuth
        },
        log
      })
    })

    it("answers with the host's own project and window, and only for the plugins it started", async () => {
      settingsFor['p1:a.two'] = { ok: false, reason: 'bad settings' }
      await manager.open('p1', 7)
      const host = factory.last.host
      await expect(host.call('sessions.list')).resolves.toEqual([
        { tabId: 't1', status: 'idle', cwd: '/projects/p1', notes: [], files: [] }
      ])
      await host.call('badge', { pluginId: 'a.one', panelId: 'main', value: 2 })
      expect(badges).toEqual([{ projectId: 'p1', key: 'a.one/main', badge: { kind: 'count', count: 2 } }])
      // a.two was disabled by its settings: it does not run, so it may not badge.
      await expect(host.call('badge', { pluginId: 'a.two', panelId: 'main', value: 2 })).rejects.toThrow('unknown plugin')
      void host.call('overlay.open', { pluginId: 'a.one', spec: { kind: 'url', url: 'https://example.com' } })
      await flush()
      expect(overlaysOpened).toMatchObject([{ windowId: 7, opener: 'plugin a.one' }])
    })

    it('dismisses its overlays, clears its badges and stops its session events when the host goes', async () => {
      await manager.open('p1', 1)
      const first = factory.last
      await first.host.call('badge', { pluginId: 'a.one', panelId: 'main', value: 'dot' })
      const pending = first.host.call('overlay.open', { pluginId: 'a.one', spec: { kind: 'url', url: 'https://x' } }, { timeoutMs: Infinity })
      void pending.catch(() => {})
      await flush()
      expect(listeners.size).toBe(1)
      first.exit(1) // a crash
      await flush()
      expect(overlaysOpened[0]!.signal?.aborted).toBe(true)
      expect(badges.at(-1)).toEqual({ projectId: 'p1', key: 'a.one/main', badge: null })
      expect(listeners.size).toBe(0)
      // The restart gets a fresh api with its own subscription.
      await vi.advanceTimersByTimeAsync(1000)
      expect(factory.spawned).toHaveLength(2)
      expect(listeners.size).toBe(1)
      await manager.close('p1')
      expect(listeners.size).toBe(0)
    })

    it("routes a header action click to the project's host and clears the header when the host goes", async () => {
      const headers: { projectId: string; key: string; header: unknown }[] = []
      manager = new HostManager({
        factory,
        plugins: async (projectId) => enabled[projectId] ?? [],
        env: async () => ({ PATH: '/usr/bin' }),
        projectPath: (projectId) => `/projects/${projectId}`,
        layouts,
        pluginDataDir: (projectId, pluginId) => `/data/plugin-data/${projectId}/${pluginId}`,
        pluginAppDataDir: (pluginId) => `/data/plugin-data/_app/${pluginId}`,
        settings: () => ({ ok: true, project: {}, app: {} }),
        api: {
          listSessions: () => [],
          session: () => undefined,
          send: () => ({ id: 'q', delivered: false }),
          onSessionsChange: () => () => {},
          openTab: async () => ({ id: 'new' }),
          setBadge: () => true,
          setPanelHeader: (projectId, key, header) => {
            headers.push({ projectId, key, header })
            return true
          },
          openOverlay: async () => ({ kind: 'dismissed' }),
          secrets: unusedSecrets,
          oauth: unusedOAuth
        },
        log
      })
      const heard: unknown[] = []
      factory.onHostEvent = (event, params) => {
        if (event === 'panel.action') heard.push(params)
      }
      await manager.open('p1', 1)
      const first = factory.last
      await first.host.call('panels.header', {
        pluginId: 'a.one',
        panelId: 'main',
        header: { meta: 'm', actions: [{ id: 'refresh', icon: 'refresh', title: 'Refresh' }] }
      })
      expect(headers).toEqual([
        { projectId: 'p1', key: 'a.one/main', header: { meta: 'm', actions: [{ id: 'refresh', title: 'Refresh', icon: 'refresh' }] } }
      ])
      expect(manager.panelAction('p1', 'a.one/main', 'refresh')).toBe(true)
      // Another project's window cannot click this host's action; an unknown action is dropped.
      expect(manager.panelAction('p2', 'a.one/main', 'refresh')).toBe(false)
      expect(manager.panelAction('p1', 'a.one/main', 'other')).toBe(false)
      await flush()
      expect(heard).toEqual([{ pluginId: 'a.one', panelId: 'main', actionId: 'refresh' }])
      first.exit(1) // a crash
      await flush()
      expect(headers.at(-1)).toEqual({ projectId: 'p1', key: 'a.one/main', header: null })
      expect(manager.panelAction('p1', 'a.one/main', 'refresh')).toBe(false)
      await manager.close('p1')
    })

    // Plan 20261102 Task 5: every way a plugin's code is replaced or turned off closes its overlays.
    // A whole-host stop goes through disposeApi; an in-place reload or unload through the host's
    // `plugin.disposed` (what the real host sends for a ctx with an overlay open, host/ctx).
    describe("closes the plugin's overlays whenever its code goes", () => {
      const openFromHost = (pluginId = 'a.one'): Promise<unknown> => {
        const pending = factory.last.host.call('overlay.open', { pluginId, spec: { kind: 'url', url: 'https://x' } }, { timeoutMs: Infinity })
        void pending.catch(() => {})
        return pending
      }
      /** The fake host disposes the plugin's ctx inside `plugin.reload` / `plugin.unload`, as the loader does. */
      const disposingHandlers = (): Record<string, RpcHandler> => ({
        ...okHandlers(),
        'plugin.reload': (p) => {
          const id = (p as { plugin: { id: string } }).plugin.id
          factory.last.host.emit('plugin.disposed', { pluginId: id })
          return { id, state: 'active' }
        },
        'plugin.unload': (p) => {
          factory.last.host.emit('plugin.disposed', { pluginId: (p as { pluginId: string }).pluginId })
          return null
        }
      })
      const scenarios: [string, () => Promise<void>][] = [
        ['window close', () => manager.close('p1')],
        ['disabled (or another plugin enabled) in the project', () => manager.enabledChanged('p1')],
        ['updated or uninstalled', () => manager.reloadPlugin('a.one')],
        ['dev reload in place', () => manager.devReload('a.one')],
        ['dev reload with an invalid manifest', () => manager.devReload('a.one', 'invalid plugin: main is required')]
      ]
      for (const [reason, stop] of scenarios) {
        it(reason, async () => {
          factory.handlers = disposingHandlers
          await manager.open('p1', 1)
          const mine = openFromHost('a.one')
          void openFromHost('a.two')
          await flush()
          expect(overlaysOpened).toHaveLength(2)
          await stop()
          await flush()
          expect(overlaysOpened[0]!.signal?.aborted).toBe(true)
          // An in-place reload of a.one leaves a.two's overlay alone; a host stop takes both.
          const inPlace = reason.startsWith('dev reload')
          // The old copy hears dismissed (in place); a stopped host's call ends with its RPC.
          if (inPlace) await expect(mine).resolves.toEqual({ kind: 'dismissed' })
          expect(overlaysOpened[1]!.signal?.aborted).toBe(!inPlace)
          if (inPlace) {
            // The new copy's overlays are not caught by the old copy's dispose.
            void openFromHost('a.one')
            await flush()
            expect(overlaysOpened[2]!.signal?.aborted).toBe(false)
          }
        })
      }
    })

    it("a host still deactivating after its window closed cannot reach the reopened window's tabs", async () => {
      const sent: string[] = []
      const opened: number[] = []
      const p1Tab = { tabId: 't1', projectId: 'p1', kind: 'claude' as const, cwd: '/projects/p1', status: 'waiting' as const, notes: [], files: [], queue: [], delivering: false }
      const notified: string[] = []
      manager = new HostManager({
        factory,
        plugins: async (projectId) => enabled[projectId] ?? [],
        env: async () => ({ PATH: '/usr/bin' }),
        projectPath: (projectId) => `/projects/${projectId}`,
        layouts,
        pluginDataDir: (projectId, pluginId) => `/data/plugin-data/${projectId}/${pluginId}`,
        pluginAppDataDir: (pluginId) => `/data/plugin-data/_app/${pluginId}`,
        notify: (notice) => void notified.push(notice.text),
        api: {
          listSessions: (projectId) => (projectId === 'p1' ? [p1Tab] : []),
          // A real p1 tab: without it `send` would fail as "unknown tab" and prove nothing.
          session: (tabId) => (tabId === 't1' ? p1Tab : undefined),
          send: (tabId, text) => {
            sent.push(`${tabId}:${text}`)
            return { id: 'q', delivered: true }
          },
          onSessionsChange: (l) => {
            listeners.add(l as never)
            return () => listeners.delete(l as never)
          },
          openTab: async (_projectId, _options, windowId) => {
            opened.push(windowId)
            return { id: 'new' }
          },
          setBadge: (projectId, key, badge) => {
            badges.push({ projectId, key, badge })
            return true
          },
          openOverlay: () => new Promise(() => {}),
          secrets: unusedSecrets,
          oauth: unusedOAuth
        },
        log
      })
      const hostEvents: string[] = []
      factory.onHostEvent = (event) => hostEvents.push(event)
      factory.handlers = () => ({ ...okHandlers(), deactivate: () => new Promise(() => {}) })
      await manager.open('p1', 1)
      const old = factory.last
      // Live: the old host is answered (the same calls are refused below).
      await expect(old.host.call('sessions.list')).resolves.toHaveLength(1)
      await old.host.call('sessions.send', { pluginId: 'a.one', tabId: 't1', text: 'before' })
      expect(sent).toEqual(['t1:before'])

      const closing = manager.close('p1')
      await flush()
      factory.handlers = okHandlers
      // The project is reopened in a new window while the old host's deactivate is stalled.
      const opening = manager.open('p1', 2)
      await flush()
      expect(old.killed).toBe(false)
      await expect(old.host.call('sessions.list')).rejects.toThrow('the plugin host is stopping')
      await expect(old.host.call('sessions.send', { pluginId: 'a.one', tabId: 't1', text: 'after' })).rejects.toThrow(
        'the plugin host is stopping'
      )
      await expect(old.host.call('sessions.open', { pluginId: 'a.one' })).rejects.toThrow('the plugin host is stopping')
      await expect(old.host.call('badge', { pluginId: 'a.one', panelId: 'main', value: 1 })).rejects.toThrow(
        'the plugin host is stopping'
      )
      await expect(
        old.host.call('overlay.open', { pluginId: 'a.one', spec: { kind: 'url', url: 'https://x' } })
      ).rejects.toThrow('the plugin host is stopping')
      await expect(old.host.call('notify', { pluginId: 'a.one', text: 'hi' })).rejects.toThrow('the window is closing')
      // Nor does it hear about the project's tabs any more.
      expect(listeners.size).toBe(0)
      // A status from the dying host does not put a ⚠ on the project's (now the new window's) panels.
      old.host.emit('status', { pluginId: 'a.one', error: 'late failure' })
      await flush()
      expect(layouts.status.get('p1:a.one/main')).not.toEqual({ error: 'late failure' })
      expect(sent).toEqual(['t1:before'])
      expect(opened).toEqual([])
      expect(notified).toEqual([])

      await vi.advanceTimersByTimeAsync(DEACTIVATE_GRACE_MS)
      await Promise.all([closing, opening])
      expect(old.killed).toBe(true)
      expect(factory.spawned).toHaveLength(2)
      // The reopened window's host is answered as usual and gets the session events.
      await expect(factory.last.host.call('sessions.list')).resolves.toHaveLength(1)
      await factory.last.host.call('sessions.send', { pluginId: 'a.one', tabId: 't1', text: 'new host' })
      expect(sent).toEqual(['t1:before', 't1:new host'])
      expect(listeners.size).toBe(1)
      hostEvents.length = 0
      for (const l of listeners) l({ entry: p1Tab } as never)
      await vi.advanceTimersByTimeAsync(1000)
      expect(hostEvents).toContain('sessions')
    })

    it('a restart revokes the old process before its deactivate, the new one is answered', async () => {
      factory.handlers = () => ({ ...okHandlers(), deactivate: () => new Promise(() => {}) })
      await manager.open('p1', 1)
      const old = factory.last
      const restarting = manager.restart('p1')
      await flush()
      await expect(old.host.call('sessions.list')).rejects.toThrow('the plugin host is stopping')
      factory.handlers = okHandlers
      await vi.advanceTimersByTimeAsync(DEACTIVATE_GRACE_MS)
      await restarting
      expect(factory.spawned).toHaveLength(2)
      await expect(factory.last.host.call('sessions.list')).resolves.toHaveLength(1)
    })

    it("a host still deactivating after its window closed clears its badges before the reopened window's host starts", async () => {
      factory.handlers = () => ({ ...okHandlers(), deactivate: () => new Promise(() => {}) })
      await manager.open('p1', 1)
      const old = factory.last
      await old.host.call('badge', { pluginId: 'a.one', panelId: 'main', value: 2 })
      await old.host.call('badge', { pluginId: 'a.two', panelId: 'main', value: 3 })
      const closing = manager.close('p1')
      await flush()
      factory.handlers = okHandlers
      // Reopened within the deactivate grace: the new host waits for the old one to be gone.
      const opening = manager.open('p1', 2)
      await flush()
      expect(factory.spawned).toHaveLength(1)
      badges = []
      await vi.advanceTimersByTimeAsync(DEACTIVATE_GRACE_MS)
      await Promise.all([closing, opening])
      expect(old.killed).toBe(true)
      expect(factory.spawned).toHaveLength(2)
      expect(badges).toEqual([
        { projectId: 'p1', key: 'a.one/main', badge: null },
        { projectId: 'p1', key: 'a.two/main', badge: null }
      ])
      // The new host's badges are its own; nothing of the old one is left to clear them.
      await factory.last.host.call('badge', { pluginId: 'a.one', panelId: 'main', value: 5 })
      expect(badges.at(-1)).toEqual({ projectId: 'p1', key: 'a.one/main', badge: { kind: 'count', count: 5 } })
    })
  })

  describe('ctx services (Task 26)', () => {
    /** Plugins that declare commands, so registration has something to check against. */
    const withCommands = (): void => {
      enabled.p1 = [
        plugin('a.one', {
          commands: [
            { id: 'refresh', title: 'Refresh', key: 'Cmd+Shift+J' },
            { id: 'other', title: 'Other' }
          ]
        }),
        plugin('a.two')
      ]
    }

    it('hands each plugin its paths, declared commands and validated settings; main builds the paths', async () => {
      withCommands()
      settingsFor['p1:a.one'] = { ok: true, project: { limit: 5 }, app: { url: 'u' } }
      let params: unknown
      factory.handlers = () => ({
        ...okHandlers(),
        activate: (p) => {
          params = p
          return (p as { plugins: { id: string }[] }).plugins.map((x) => ({ id: x.id, state: 'active' }))
        }
      })
      await manager.open('p1', 1)
      expect(params).toEqual({
        plugins: [
          {
            id: 'a.one',
            dir: '/plugins/a.one',
            main: 'host.js',
            projectDir: '/projects/p1',
            dataDir: '/data/plugin-data/p1/a.one',
            appDataDir: '/data/plugin-data/_app/a.one',
            storageFile: '/data/plugin-data/p1/a.one/storage.json',
            commands: ['refresh', 'other'],
            panels: ['main'],
            webviewPanels: [],
            cli: [],
            settings: { project: { limit: 5 }, app: { url: 'u' } }
          },
          {
            id: 'a.two',
            dir: '/plugins/a.two',
            main: 'host.js',
            projectDir: '/projects/p1',
            dataDir: '/data/plugin-data/p1/a.two',
            appDataDir: '/data/plugin-data/_app/a.two',
            storageFile: '/data/plugin-data/p1/a.two/storage.json',
            commands: [],
            panels: ['main'],
            webviewPanels: [],
            cli: [],
            settings: { project: {}, app: {} }
          }
        ],
        // No serviceProviders dependency: no picks.
        serviceProviders: {}
      })
    })

    it('passes each plugin\'s declared services and the project\'s provider picks into the host', async () => {
      const services = { provides: { triage: 1 }, uses: { mail: 2 } }
      const asked: string[] = []
      let params: { plugins: { id: string; services?: unknown }[]; serviceProviders: unknown } | undefined
      factory.handlers = () => ({
        ...okHandlers(),
        activate: (p) => {
          params = p as typeof params
          return (p as { plugins: { id: string }[] }).plugins.map((x) => ({ id: x.id, state: 'active' }))
        }
      })
      const withServices = new HostManager({
        factory,
        plugins: () => [{ ...plugin('a.one'), services }, plugin('a.two')],
        env: () => ({}),
        projectPath: () => '/p',
        layouts,
        pluginDataDir: () => '/d',
        pluginAppDataDir: (pluginId) => `/data/plugin-data/_app/${pluginId}`,
        serviceProviders: (projectId) => {
          asked.push(projectId)
          return { triage: 'a.one' }
        },
        log
      })
      await withServices.open('p7', 7)
      expect(asked).toEqual(['p7'])
      expect(params?.serviceProviders).toEqual({ triage: 'a.one' })
      expect(params?.plugins[0]?.services).toEqual(services)
      // A plugin without the field gets none (not an empty object).
      expect(params?.plugins[1]).not.toHaveProperty('services')
    })

    // Bundled reviewer/editor plan Task 6: `ctx.projectDir` is the real path (the reviewer ran
    // `pwd -P` for it). The record's path reached through a symlink still arrives resolved.
    it('sends the real path of the project folder as projectDir, through a symlink', async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-projdir-')))
      try {
        mkdirSync(join(root, 'real'))
        symlinkSync(join(root, 'real'), join(root, 'link'))
        let params: { plugins: { projectDir: string }[] } | undefined
        factory.handlers = () => ({
          ...okHandlers(),
          activate: (p) => {
            params = p as typeof params
            return (p as { plugins: { id: string }[] }).plugins.map((x) => ({ id: x.id, state: 'active' }))
          }
        })
        const linked = new HostManager({
          factory,
          plugins: () => [plugin('a.one')],
          env: () => ({}),
          projectPath: () => join(root, 'link'),
          layouts,
          pluginDataDir: () => '/d',
          pluginAppDataDir: (pluginId) => `/data/plugin-data/_app/${pluginId}`,
          log
        })
        await linked.open('p8', 8)
        expect(params?.plugins[0]?.projectDir).toBe(join(root, 'real'))
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('servicePlugins lists the set a launch would run: host code, valid settings, the listed folder', async () => {
      const services = { provides: { triage: 1 } }
      const manager = new HostManager({
        factory,
        plugins: () => [
          { ...plugin('a.one'), services },
          { ...plugin('a.bad'), services },
          { ...plugin('a.moved'), services },
          { ...plugin('a.static', { main: undefined }), services },
          plugin('a.plain')
        ],
        env: () => ({}),
        projectPath: () => '/p',
        layouts,
        pluginDataDir: () => '/d',
        pluginAppDataDir: (pluginId) => `/data/plugin-data/_app/${pluginId}`,
        settings: (_p, id) => (id === 'a.bad' ? { ok: false, reason: 'invalid' } : { ok: true, project: {}, app: {} }),
        pluginSource: (_p, id) => {
          const p = plugin(id)
          return id === 'a.moved' ? { dir: '/elsewhere' } : { dir: p.dir }
        },
        log
      })
      expect(await manager.servicePlugins('p1')).toEqual([{ id: 'a.one', services }, { id: 'a.plain' }])
    })

    it('names the webview panels of each plugin (only those kind: webview drive ctx.webview)', async () => {
      enabled.p1 = [plugin('a.one', { panels: [panel('main'), { ...panel('view'), kind: 'webview' }, { ...panel('page'), kind: 'html' }] })]
      let params: { plugins: { panels: string[]; webviewPanels: string[] }[] } | undefined
      factory.handlers = () => ({
        ...okHandlers(),
        activate: (p) => {
          params = p as typeof params
          return [{ id: 'a.one', state: 'active' }]
        }
      })
      await manager.open('p1', 1)
      expect(params?.plugins[0]?.panels).toEqual(['main', 'view', 'page'])
      expect(params?.plugins[0]?.webviewPanels).toEqual(['view'])
    })

    it('does not start a plugin whose settings are invalid, shows the reason, and starts the others', async () => {
      settingsFor['p1:a.one'] = { ok: false, reason: 'invalid project settings: /limit must be integer' }
      let started: string[] = []
      factory.handlers = () => ({
        ...okHandlers(),
        activate: (p) => {
          started = (p as { plugins: { id: string }[] }).plugins.map((x) => x.id)
          return started.map((id) => ({ id, state: 'active' }))
        }
      })
      await manager.open('p1', 1)
      expect(started).toEqual(['a.two'])
      expect(manager.status('p1')?.plugins).toEqual([
        { id: 'a.one', state: 'errored', error: 'plugin disabled: invalid project settings: /limit must be integer' },
        { id: 'a.two', state: 'active' }
      ])
      expect(layouts.status.get('p1:a.one/main')).toEqual({
        error: 'plugin disabled: invalid project settings: /limit must be integer'
      })
      // A crash does not rewrite the reason of a plugin that was never running.
      factory.last.exit(1)
      await flush()
      expect(manager.status('p1')?.plugins[0]).toMatchObject({
        id: 'a.one',
        error: expect.stringContaining('plugin disabled') as unknown
      })
    })

    it('starts no process when every plugin is disabled by its settings', async () => {
      settingsFor['p2:a.two'] = { ok: false, reason: 'bad' }
      await manager.open('p2', 2)
      expect(factory.spawned).toHaveLength(0)
      expect(manager.status('p2')?.plugins).toEqual([{ id: 'a.two', state: 'errored', error: 'plugin disabled: bad' }])
    })

    it('a settings service that throws disables the plugin instead of crashing the launch', async () => {
      const throwing = new HostManager({
        factory,
        plugins: () => [plugin('a.one')],
        env: () => ({}),
        projectPath: () => '/p',
        layouts,
        pluginDataDir: () => '/d',
        pluginAppDataDir: (pluginId) => `/data/plugin-data/_app/${pluginId}`,
        settings: () => {
          throw new Error('registry gone')
        },
        log
      })
      await throwing.open('p9', 9)
      expect(throwing.status('p9')?.plugins[0]).toMatchObject({
        state: 'errored',
        error: 'plugin disabled: settings cannot be read: registry gone'
      })
    })

    it('settingsChanged pushes valid values to running plugins, and restarts when validity flips', async () => {
      const pushed: unknown[] = []
      factory.onHostEvent = (e, p) => pushed.push([e, p])
      await manager.open('p1', 1)
      settingsFor['p1:a.one'] = { ok: true, project: { n: 2 }, app: { m: 3 } }
      await manager.settingsChanged('p1')
      await flush()
      expect(pushed).toEqual([
        ['settings', { pluginId: 'a.one', project: { n: 2 }, app: { m: 3 } }],
        ['settings', { pluginId: 'a.two', project: {}, app: {} }]
      ])
      expect(factory.spawned).toHaveLength(1)

      // a.one turns invalid: the host restarts without it.
      settingsFor['p1:a.one'] = { ok: false, reason: 'now bad' }
      await manager.settingsChanged('p1')
      expect(factory.spawned).toHaveLength(2)
      expect(manager.status('p1')?.plugins[0]).toMatchObject({ id: 'a.one', state: 'errored' })

      // ... and valid again: it comes back.
      settingsFor['p1:a.one'] = { ok: true, project: {}, app: {} }
      await manager.settingsChanged('p1')
      expect(factory.spawned).toHaveLength(3)
      expect(manager.status('p1')?.plugins.map((p) => p.state)).toEqual(['active', 'active'])
    })

    it('settingsChanged with a plugin id pushes to that plugin only', async () => {
      const pushed: unknown[] = []
      factory.onHostEvent = (e, p) => pushed.push([e, p])
      await manager.open('p1', 1)
      settingsFor['p1:a.two'] = { ok: true, project: { k: 1 }, app: {} }
      await manager.settingsChanged('p1', 'a.two')
      await flush()
      expect(pushed).toEqual([['settings', { pluginId: 'a.two', project: { k: 1 }, app: {} }]])
    })

    it("adds a declared command to the registry, refuses an undeclared one and another host's plugin", async () => {
      withCommands()
      await manager.open('p1', 1)
      const host = factory.last.host
      await host.call('commands.register', { pluginId: 'a.one', id: 'refresh' })
      expect(sink.added).toEqual(['p1:a.one/refresh'])
      await expect(host.call('commands.register', { pluginId: 'a.one', id: 'undeclared' })).rejects.toThrow('not declared')
      // a.two declares nothing.
      await expect(host.call('commands.register', { pluginId: 'a.two', id: 'refresh' })).rejects.toThrow('not declared')
      // A plugin this host does not run.
      await expect(host.call('commands.register', { pluginId: 'a.three', id: 'refresh' })).rejects.toThrow('unknown plugin')
      await expect(host.call('commands.register', { pluginId: 7, id: 'refresh' })).rejects.toThrow('unknown plugin')
      expect(sink.added).toEqual(['p1:a.one/refresh'])
      await host.call('commands.unregister', { pluginId: 'a.one', id: 'refresh' })
      expect(sink.removed).toEqual(['p1:a.one/refresh'])
    })

    it("a host still deactivating after its window closed leaves a reopened window's commands alone", async () => {
      withCommands()
      factory.handlers = () => ({ ...okHandlers(), deactivate: () => new Promise(() => {}) })
      await manager.open('p1', 1)
      const old = factory.last
      await old.host.call('commands.register', { pluginId: 'a.one', id: 'refresh' })
      await old.host.call('commands.register', { pluginId: 'a.one', id: 'other' })
      const closing = manager.close('p1')
      await flush()
      // Deactivating: what it registers now would outlive it.
      await expect(old.host.call('commands.register', { pluginId: 'a.one', id: 'refresh' })).rejects.toThrow(
        'window is closing'
      )
      // The window is reopened within the deactivate grace: its host waits for the old one.
      factory.handlers = okHandlers
      const opening = manager.open('p1', 2)
      await flush()
      expect(factory.spawned).toHaveLength(1)
      // The old plugin's ctx disposal unregisters its commands while it deactivates.
      await old.host.call('commands.unregister', { pluginId: 'a.one', id: 'refresh' })
      sink.cleared = []
      sink.removed = []
      sink.added = []
      await vi.advanceTimersByTimeAsync(DEACTIVATE_GRACE_MS)
      await Promise.all([closing, opening])
      expect(old.killed).toBe(true)
      // The old host's remaining command goes one by one (a newer record serves the project); no
      // plugin-wide clear.
      expect(sink.cleared).toEqual([])
      expect(sink.removed).toEqual(['p1:a.one/other'])
      // Only now does the new host run and register; nothing of the old one can remove it.
      expect(factory.spawned).toHaveLength(2)
      await factory.last.host.call('commands.register', { pluginId: 'a.one', id: 'refresh' })
      expect(sink.added).toEqual(['p1:a.one/refresh'])
      expect(sink.removed).toEqual(['p1:a.one/other'])
    })

    it('runs a registered command in the host, and only a registered one', async () => {
      withCommands()
      const ran: unknown[] = []
      factory.handlers = () => ({ ...okHandlers(), 'command.run': (p) => void ran.push(p) })
      await manager.open('p1', 1)
      await expect(manager.runCommand('p1', 'a.one/refresh')).rejects.toThrow('unknown command')
      await factory.last.host.call('commands.register', { pluginId: 'a.one', id: 'refresh' })
      await manager.runCommand('p1', 'a.one/refresh')
      expect(ran).toEqual([{ pluginId: 'a.one', id: 'refresh' }])
      await expect(manager.runCommand('p2', 'a.one/refresh')).rejects.toThrow('unknown command')
      await expect(manager.runCommand('p1', 'a.one/other')).rejects.toThrow('unknown command')
    })

    it('waits for a long command (one awaiting an overlay) past the RPC timeout; a host exit ends it', async () => {
      withCommands()
      factory.handlers = () => ({ ...okHandlers(), 'command.run': () => new Promise(() => {}) })
      await manager.open('p1', 1)
      await factory.last.host.call('commands.register', { pluginId: 'a.one', id: 'refresh' })
      let outcome: string | undefined
      void manager.runCommand('p1', 'a.one/refresh').then(
        () => (outcome = 'done'),
        (err: unknown) => (outcome = String(err))
      )
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(outcome).toBeUndefined()
      factory.last.exit(1)
      await flush()
      expect(outcome).toMatch(/Error/)
    })

    it("takes the host's commands out of the registry when it exits or closes", async () => {
      withCommands()
      await manager.open('p1', 1)
      await factory.last.host.call('commands.register', { pluginId: 'a.one', id: 'refresh' })
      factory.last.exit(1)
      await flush()
      expect(sink.cleared).toEqual(['p1:a.one', 'p1:a.two'])
      await expect(manager.runCommand('p1', 'a.one/refresh')).rejects.toThrow('unknown command')
      sink.cleared.length = 0
      await manager.close('p1')
      expect(sink.cleared).toContain('p1:a.one')
    })

    it("shows ctx.notify text for the host's own plugins only, capped in size and rate", async () => {
      await manager.open('p1', 1)
      const host = factory.last.host
      await host.call('notify', { pluginId: 'a.one', text: 'x'.repeat(2000) })
      expect(notified).toEqual([{ text: `${'x'.repeat(500)}…`, projectId: 'p1', pluginId: 'a.one' }])
      await expect(host.call('notify', { pluginId: 'someone.else', text: 'hi' })).rejects.toThrow('unknown plugin')
      await expect(host.call('notify', { pluginId: 'a.one', text: '  ' })).rejects.toThrow('non-empty')
      await expect(host.call('notify', { pluginId: 'a.one', text: 5 })).rejects.toThrow('non-empty')
      for (let i = 1; i < MAX_NOTIFICATIONS_PER_WINDOW; i++) await host.call('notify', { pluginId: 'a.one', text: `n${i}` })
      await expect(host.call('notify', { pluginId: 'a.one', text: 'one too many' })).rejects.toThrow('notifications in 60 s')
      await vi.advanceTimersByTimeAsync(NOTIFY_WINDOW_MS)
      await host.call('notify', { pluginId: 'a.one', text: 'again' })
      expect(notified.at(-1)?.text).toBe('again')
      expect(notified).toHaveLength(MAX_NOTIFICATIONS_PER_WINDOW + 1)
    })

    it('counts the notify cap per plugin: one noisy plugin does not use up the budget of the others', async () => {
      await manager.open('p1', 1)
      const host = factory.last.host
      for (let i = 0; i < MAX_NOTIFICATIONS_PER_WINDOW; i++) await host.call('notify', { pluginId: 'a.one', text: `n${i}` })
      await expect(host.call('notify', { pluginId: 'a.one', text: 'too many' })).rejects.toThrow('notifications in 60 s')
      await host.call('notify', { pluginId: 'a.two', text: 'mine' })
      expect(notified.at(-1)).toEqual({ text: 'mine', projectId: 'p1', pluginId: 'a.two' })
    })

    it('checks ctx.notify options in main and passes them on with main\'s own window', async () => {
      await manager.open('p1', 7)
      const host = factory.last.host
      const bad: [unknown, string][] = [
        [5, 'options must be an object'],
        [{ title: 5 }, 'title must be a string'],
        [{ title: ' \n ' }, 'title must not be empty'],
        [{ title: 'x'.repeat(MAX_NOTIFY_TITLE + 1) }, `title is over ${MAX_NOTIFY_TITLE} characters`],
        [{ sound: 1 }, 'sound must be true, false or a sound id'],
        [{ sound: 'x'.repeat(MAX_SOUND_ID_LENGTH + 1) }, `sound is over ${MAX_SOUND_ID_LENGTH} characters`],
        [{ action: 'Join' }, 'action must be an object'],
        [{ action: { label: '' } }, 'action.label must not be empty'],
        [{ action: { label: 'x'.repeat(MAX_NOTIFY_ACTION_LABEL + 1) } }, `action.label is over ${MAX_NOTIFY_ACTION_LABEL} characters`]
      ]
      for (const [options, error] of bad) {
        await expect(host.call('notify', { pluginId: 'a.one', text: 'hi', options })).rejects.toThrow(error)
      }
      // A refused call spends no budget, and shows nothing.
      expect(noticeCalls).toEqual([])
      await expect(
        host.call('notify', {
          pluginId: 'a.one',
          text: 'Standup in 2 min',
          // Control characters become spaces; an unknown key (a later release's) is ignored.
          options: { title: 'Calendar\nreminder', sound: true, later: 1 },
          // A project or window the host names is never used.
          projectId: 'p2',
          windowId: 99
        })
      ).resolves.toEqual({ clicked: false })
      expect(noticeCalls[0]?.notice).toEqual({ text: 'Standup in 2 min', title: 'Calendar reminder', sound: true })
      expect(noticeCalls[0]?.source).toEqual({ projectId: 'p1', pluginId: 'a.one', windowId: 7 })
      // A plugin's own sound id travels as it is (main's notify resolves it, NotifySounds); "" is
      // a "format": "sound" field left at App default, the app's sound.
      await host.call('notify', { pluginId: 'a.one', text: 'own', options: { sound: 'builtin:bell' } })
      await host.call('notify', { pluginId: 'a.one', text: 'default', options: { sound: '' } })
      expect(noticeCalls.slice(1).map((c) => c.notice.sound)).toEqual(['builtin:bell', true])
      for (let i = 3; i < MAX_NOTIFICATIONS_PER_WINDOW; i++) await host.call('notify', { pluginId: 'a.one', text: `n${i}` })
      await expect(host.call('notify', { pluginId: 'a.one', text: 'one too many' })).rejects.toThrow('notifications in 60 s')
    })

    it('answers a ctx.notify with an action with the click main reports', async () => {
      await manager.open('p1', 1)
      const host = factory.last.host
      notifyAnswer = async () => true
      await expect(host.call('notify', { pluginId: 'a.one', text: 'Standup', options: { action: { label: 'Join' } } })).resolves.toEqual({
        clicked: true
      })
      notifyAnswer = async () => false
      await expect(host.call('notify', { pluginId: 'a.one', text: 'Standup', options: { action: { label: 'Join' } } })).resolves.toEqual({
        clicked: false
      })
      expect(noticeCalls.map((c) => c.notice.action)).toEqual([{ label: 'Join' }, { label: 'Join' }])
      // Settled: nothing of these calls is left to abort.
      expect(noticeCalls.every((c) => !c.signal.aborted)).toBe(true)
    })

    it("ends a plugin's waiting notifications when its ctx is disposed, and every one when the window closes", async () => {
      await manager.open('p1', 1)
      const host = factory.last.host
      // deps.notify answers false once aborted, as the Notifier does.
      notifyAnswer = (signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(false)))
      const one = host.call('notify', { pluginId: 'a.one', text: 'one', options: { action: { label: 'Go' } } })
      const two = host.call('notify', { pluginId: 'a.two', text: 'two', options: { action: { label: 'Go' } } })
      await flush()
      expect(noticeCalls).toHaveLength(2)
      host.emit('plugin.disposed', { pluginId: 'a.one' })
      await flush()
      expect(noticeCalls[0]?.signal.aborted).toBe(true)
      expect(noticeCalls[1]?.signal.aborted).toBe(false)
      await expect(one).resolves.toEqual({ clicked: false })
      const closing = manager.close('p1')
      expect(noticeCalls[1]?.signal.aborted).toBe(true)
      await vi.advanceTimersByTimeAsync(DEACTIVATE_GRACE_MS)
      await closing
      // The host is gone, so its call settles by the endpoint closing, never by hanging.
      await two.catch(() => {})
    })

    it('ends the waiting notifications of a host that crashed', async () => {
      await manager.open('p1', 1)
      const proc = factory.last
      void proc.host.call('notify', { pluginId: 'a.one', text: 'one', options: { action: { label: 'Go' } } }).catch(() => {})
      await flush()
      proc.exit(1)
      await flush()
      expect(noticeCalls[0]?.signal.aborted).toBe(true)
    })

    it('hands ctx.log lines to the plugin log writer, one line each', async () => {
      await manager.open('p1', 1)
      factory.last.host.emit('log', { pluginId: 'a.one', level: 'warn', text: 'a\nb' })
      factory.last.host.emit('log', { pluginId: 'evil.other', level: 'warn', text: 'spoof' })
      await flush()
      expect(pluginLines).toEqual([{ pluginId: 'a.one', projectId: 'p1', level: 'warn', text: 'a\\nb' }])
    })

    it('shows a failing scheduled job as the panel error and clears it when the job recovers', async () => {
      await manager.open('p1', 1)
      const host = factory.last.host
      host.emit('status', { pluginId: 'a.one', error: 'run failed: boom' })
      await flush()
      expect(layouts.status.get('p1:a.one/main')).toEqual({ error: 'run failed: boom' })
      expect(manager.status('p1')?.plugins[0]).toEqual({ id: 'a.one', state: 'errored', error: 'run failed: boom' })
      host.emit('status', { pluginId: 'a.one', error: null })
      await flush()
      expect(layouts.status.get('p1:a.one/main')).toBeUndefined()
      expect(manager.status('p1')?.plugins[0]).toEqual({ id: 'a.one', state: 'active' })
      // Not this host's plugin, and a recovery for a plugin that is not failing: ignored.
      host.emit('status', { pluginId: 'evil.other', error: 'x' })
      host.emit('status', { pluginId: 'a.two', error: null })
      await flush()
      expect(layouts.status.has('p1:evil.other/main')).toBe(false)
      expect(manager.status('p1')?.plugins[1]).toEqual({ id: 'a.two', state: 'active' })
    })
  })

  it('keeps the error of a job that failed while activate was still running once activate succeeds', async () => {
    factory.handlers = () => ({
      ...okHandlers(),
      activate: (p) => {
        // The job's first tick fails before activate() returns; the host reports it only once.
        factory.last.host.emit('status', { pluginId: 'a.one', error: 'run failed: early' })
        return (p as { plugins: { id: string }[] }).plugins.map((x) => ({ id: x.id, state: 'active' }))
      }
    })
    await manager.open('p1', 1)
    expect(layouts.status.get('p1:a.one/main')).toEqual({ error: 'run failed: early' })
    expect(manager.status('p1')?.plugins[0]).toEqual({ id: 'a.one', state: 'errored', error: 'run failed: early' })
    expect(manager.status('p1')?.plugins[1]).toEqual({ id: 'a.two', state: 'active' })
    factory.last.host.emit('status', { pluginId: 'a.one', error: null })
    await flush()
    expect(layouts.status.get('p1:a.one/main')).toBeUndefined()
    expect(manager.status('p1')?.plugins[0]).toEqual({ id: 'a.one', state: 'active' })
  })

  describe('openFile (Sessions panel click, friction round 1 Task 12)', () => {
    const req = { path: 'src/a.ts', tabId: 't1' }

    it('sends files.open to the plugin that declares openFile and answers what the host acked', async () => {
      enabled.p1 = [plugin('a.one', { openFile: { title: 'Review' } }), plugin('a.two')]
      const seen: unknown[] = []
      let answer: unknown = true
      factory.handlers = () => ({
        ...okHandlers(),
        'files.open': (p) => {
          seen.push(p)
          return answer
        }
      })
      await manager.open('p1', 1)
      await expect(manager.openFile('p1', 'a.one', req)).resolves.toBe(true)
      expect(seen).toEqual([{ pluginId: 'a.one', path: 'src/a.ts', tabId: 't1' }])
      answer = false
      await expect(manager.openFile('p1', 'a.one', req)).resolves.toBe(false)
      // A ctx.files.open without a tab: no tabId key at all.
      answer = true
      await expect(manager.openFile('p1', 'a.one', { path: 'src/a.ts' })).resolves.toBe(true)
      expect(seen[2]).toEqual({ pluginId: 'a.one', path: 'src/a.ts' })
      // Not a candidate (no openFile), not in this host, or another project: false without asking.
      await expect(manager.openFile('p1', 'a.two', req)).resolves.toBe(false)
      await expect(manager.openFile('p1', 'x.gone', req)).resolves.toBe(false)
      await expect(manager.openFile('p2', 'a.one', req)).resolves.toBe(false)
      expect(seen).toHaveLength(3)
    })

    it('is false when the host throws, does not answer within the bound, or the plugin is not active', async () => {
      enabled.p1 = [plugin('a.one', { openFile: { title: 'Review' } })]
      let mode: 'throw' | 'hang' = 'throw'
      factory.handlers = () => ({
        ...okHandlers(),
        'files.open': () => {
          if (mode === 'throw') throw new Error('listener blew up')
          return new Promise(() => {})
        }
      })
      await manager.open('p1', 1)
      await expect(manager.openFile('p1', 'a.one', req)).resolves.toBe(false)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('listener blew up'))

      mode = 'hang'
      const pending = manager.openFile('p1', 'a.one', req)
      await vi.advanceTimersByTimeAsync(1_999)
      let settled = false
      void pending.then(() => (settled = true))
      await flush()
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).resolves.toBe(false)

      // An errored activate: the plugin never ran in this process.
      factory.handlers = () => ({
        ...okHandlers(),
        activate: () => [{ id: 'a.one', state: 'errored', error: 'boom' }],
        'files.open': () => true
      })
      await manager.restart('p1')
      await expect(manager.openFile('p1', 'a.one', req)).resolves.toBe(false)
      expect(factory.last.calls).not.toContain('files.open')
    })

    it('marks the spec openFile and keeps the open-file pick out of the picks sent to the host', async () => {
      enabled.p1 = [plugin('a.one', { openFile: { title: 'Review' } }), plugin('a.two')]
      let activateParams: unknown
      factory.handlers = () => ({
        ...okHandlers(),
        activate: (p) => {
          activateParams = p
          return okHandlers().activate!(p)
        }
      })
      const withPicks = new HostManager({
        factory,
        plugins: async (projectId) => enabled[projectId] ?? [],
        env: async () => ({}),
        projectPath: (projectId) => `/projects/${projectId}`,
        layouts,
        pluginDataDir: (projectId, pluginId) => `/data/${projectId}/${pluginId}`,
        pluginAppDataDir: (pluginId) => `/data/_app/${pluginId}`,
        serviceProviders: () => ({ greet: 'a.two', '@open-file': 'a.one' })
      })
      await withPicks.open('p1', 1)
      const params = activateParams as { plugins: { id: string; openFile?: boolean }[]; serviceProviders: Record<string, string> }
      expect(params.plugins.map((p) => [p.id, p.openFile])).toEqual([
        ['a.one', true],
        ['a.two', undefined]
      ])
      expect(params.serviceProviders).toEqual({ greet: 'a.two' })
      await expect(withPicks.servicePlugins('p1')).resolves.toEqual([{ id: 'a.one', openFile: { title: 'Review' } }, { id: 'a.two' }])
      withPicks.disposeAll()
    })

    it('keeps every @ key (slot picks too) out of the picks sent to the host; servicePlugins carries the slots', async () => {
      const agenda = { type: 'agenda', entry: 'slots/agenda.html' }
      enabled.p1 = [plugin('a.one', { slots: [agenda] }), plugin('a.two', { slots: [] })]
      let activateParams: unknown
      factory.handlers = () => ({
        ...okHandlers(),
        activate: (p) => {
          activateParams = p
          return okHandlers().activate!(p)
        }
      })
      const withPicks = new HostManager({
        factory,
        plugins: async (projectId) => enabled[projectId] ?? [],
        env: async () => ({}),
        projectPath: (projectId) => `/projects/${projectId}`,
        layouts,
        pluginDataDir: (projectId, pluginId) => `/data/${projectId}/${pluginId}`,
        pluginAppDataDir: (pluginId) => `/data/_app/${pluginId}`,
        serviceProviders: () => ({ greet: 'a.two', '@slot:agenda': 'a.one', '@slot:weather': '@none', '@later': 'a.one' })
      })
      await withPicks.open('p1', 1)
      expect((activateParams as { serviceProviders: Record<string, string> }).serviceProviders).toEqual({ greet: 'a.two' })
      // An empty list is no slots: the pick rows list only plugins that draw one.
      await expect(withPicks.servicePlugins('p1')).resolves.toEqual([{ id: 'a.one', slots: [agenda] }, { id: 'a.two' }])
      withPicks.disposeAll()
    })
  })

  describe('panel ports', () => {
    it('hands a panel port to the running plugin only, tagged with the ids main gave it', async () => {
      enabled.p1 = [plugin('a.one', { panels: [panel('board'), panel('side')] }), plugin('a.two')]
      factory.handlers = () => ({
        activate: () => [
          { id: 'a.one', state: 'active' },
          { id: 'a.two', state: 'errored', error: 'activate() failed' }
        ],
        deactivate: () => null
      })
      // Before the window's host has activated anything: no panel takes a port.
      expect(manager.runningPanels('p1', 'a.one')).toBeUndefined()
      expect(manager.sendPanelPort('p1', 'a.one', 'board', {})).toBe(false)
      await manager.open('p1', 1)
      expect(ready).toEqual([{ projectId: 'p1', pluginIds: ['a.one', 'a.two'] }])
      expect(manager.runningPanels('p1', 'a.one')).toEqual(['board', 'side'])
      // A plugin that failed to activate, one not enabled here, and another project: none.
      expect(manager.runningPanels('p1', 'a.two')).toBeUndefined()
      expect(manager.runningPanels('p1', 'evil.other')).toBeUndefined()
      expect(manager.runningPanels('p2', 'a.one')).toBeUndefined()

      const port = { the: 'port' }
      expect(manager.sendPanelPort('p1', 'a.one', 'board', port)).toBe(true)
      expect(factory.last.ports).toEqual([{ message: JSON.stringify({ panelPort: { pluginId: 'a.one', panelId: 'board' } }), port }])
      // What the host reads back off that message (host/index.ts).
      expect(panelPortTag(factory.last.ports[0]!.message)).toEqual({ pluginId: 'a.one', panelId: 'board' })
    })

    it('keeps the ports of a plugin whose scheduled job fails, drops all of them when the host goes', async () => {
      await manager.open('p1', 1)
      factory.last.host.emit('status', { pluginId: 'a.one', error: 'job failed' })
      await flush()
      expect(manager.runningPanels('p1', 'a.one')).toEqual(['main'])

      // A crash: the old ports died with the process, and nothing can take a new one until the
      // restarted host has activated; then the window is told to reload those panels.
      factory.last.exit(1)
      await flush()
      expect(manager.runningPanels('p1', 'a.one')).toBeUndefined()
      expect(manager.sendPanelPort('p1', 'a.one', 'main', {})).toBe(false)
      expect(ready).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1000)
      await flush()
      expect(factory.spawned).toHaveLength(2)
      expect(ready).toEqual([
        { projectId: 'p1', pluginIds: ['a.one', 'a.two'] },
        { projectId: 'p1', pluginIds: ['a.one', 'a.two'] }
      ])
      expect(manager.sendPanelPort('p1', 'a.one', 'main', {})).toBe(true)
      expect(factory.spawned[0]!.ports).toEqual([])
      expect(factory.last.ports).toHaveLength(1)

      // Restart (the panel's button, a plugin update) and close.
      await manager.restart('p1')
      expect(ready).toHaveLength(3)
      await manager.close('p1')
      expect(manager.runningPanels('p1', 'a.one')).toBeUndefined()
    })

    it('reports no ready plugins for a launch whose activate failed', async () => {
      factory.handlers = () => ({
        activate: () => {
          throw new Error('host broke')
        },
        deactivate: () => null
      })
      await manager.open('p1', 1)
      expect(ready).toEqual([])
      expect(manager.runningPanels('p1', 'a.one')).toBeUndefined()
    })
  })

  describe('slots (design-next §2)', () => {
    const agenda = { type: 'agenda', entry: 'slots/agenda.html', minHeight: 48, maxHeight: 320 }
    let picks: Record<string, string>
    let changed: string[]
    let slotted: HostManager
    let hostEvents: { event: string; params: unknown }[]

    beforeEach(() => {
      picks = {}
      changed = []
      hostEvents = []
      factory.onHostEvent = (event, params) => void hostEvents.push({ event, params })
      factory.handlers = () => ({
        ...okHandlers(),
        'plugin.reload': (p) => ({ id: (p as { plugin: { id: string } }).plugin.id, state: 'active' })
      })
      slotted = new HostManager({
        factory,
        plugins: async (projectId) => enabled[projectId] ?? [],
        env: async () => ({}),
        projectPath: (projectId) => `/projects/${projectId}`,
        layouts,
        pluginDataDir: (projectId, pluginId) => `/data/${projectId}/${pluginId}`,
        pluginAppDataDir: (pluginId) => `/data/_app/${pluginId}`,
        settings: (projectId, pluginId) => settingsFor[`${projectId}:${pluginId}`] ?? { ok: true, project: {}, app: {} },
        serviceProviders: () => picks,
        onSlotsChanged: (projectId) => void changed.push(projectId)
      })
    })
    afterEach(() => slotted.disposeAll())

    it('resolves the provider from the pick among running plugins only, with min/max and an epoch', async () => {
      enabled.p1 = [plugin('a.one', { slots: [agenda] }), plugin('a.two', { slots: [{ type: 'agenda', entry: 'b.html' }] }), plugin('a.three')]
      // No host yet: nothing draws.
      expect(slotted.slotProvider('p1', 'agenda')).toBeUndefined()
      await slotted.open('p1', 1)
      expect(changed).toEqual(['p1'])
      // Two candidates and no pick: none (the Plugins page shows the row).
      expect(slotted.slotProvider('p1', 'agenda')).toBeUndefined()
      picks = { '@slot:agenda': 'a.two' }
      // Defaults when the provider names no min/max.
      expect(slotted.slotProvider('p1', 'agenda')).toEqual({ pluginId: 'a.two', entry: 'b.html', minHeight: 24, maxHeight: 600, epoch: 1 })
      picks = { '@slot:agenda': 'a.one' }
      expect(slotted.slotProvider('p1', 'agenda')).toEqual({ pluginId: 'a.one', entry: 'slots/agenda.html', minHeight: 48, maxHeight: 320, epoch: 1 })
      // "None", a stale pick among two, a type nobody declares, another project.
      picks = { '@slot:agenda': '@none' }
      expect(slotted.slotProvider('p1', 'agenda')).toBeUndefined()
      picks = { '@slot:agenda': 'gone.plugin' }
      expect(slotted.slotProvider('p1', 'agenda')).toBeUndefined()
      expect(slotted.slotProvider('p1', 'weather')).toBeUndefined()
      expect(slotted.slotProvider('p2', 'agenda')).toBeUndefined()
    })

    it('draws nothing for a provider that failed to activate or whose settings are invalid', async () => {
      enabled.p1 = [plugin('a.one', { slots: [agenda] })]
      factory.handlers = () => ({ activate: () => [{ id: 'a.one', state: 'errored', error: 'boom' }], deactivate: () => null })
      await slotted.open('p1', 1)
      expect(slotted.slotProvider('p1', 'agenda')).toBeUndefined()
      await slotted.close('p1')
      settingsFor['p1:a.one'] = { ok: false, reason: 'bad' }
      factory.handlers = okHandlers
      await slotted.open('p1', 1)
      expect(slotted.slotProvider('p1', 'agenda')).toBeUndefined()
    })

    it('gives a reloaded or restarted provider a new epoch and says so; a crash takes it away', async () => {
      enabled.p1 = [plugin('a.one', { slots: [agenda] })]
      await slotted.open('p1', 1)
      expect(slotted.slotProvider('p1', 'agenda')?.epoch).toBe(1)
      changed.length = 0
      await slotted.devReload('a.one')
      expect(slotted.slotProvider('p1', 'agenda')?.epoch).toBe(2)
      expect(changed).toContain('p1')
      changed.length = 0
      factory.last.exit(1)
      await flush()
      expect(changed).toEqual(['p1'])
      expect(slotted.slotProvider('p1', 'agenda')).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1000)
      await flush()
      expect(slotted.slotProvider('p1', 'agenda')?.epoch).toBe(3)
      // A reload that turns the manifest invalid takes it down.
      changed.length = 0
      await slotted.devReload('a.one', 'invalid plugin: main is required')
      expect(changed).toContain('p1')
      expect(slotted.slotProvider('p1', 'agenda')).toBeUndefined()
    })

    it("hands a frame's port to the running provider only, and tells it when the frame closes", async () => {
      enabled.p1 = [plugin('a.one', { slots: [agenda] }), plugin('a.two')]
      const open = { pluginId: 'a.one', id: 's1', type: 'agenda', host: { kind: 'panel' as const, pluginId: 'a.two', panelId: 'main' }, params: { day: 'today' } }
      expect(slotted.sendSlotPort('p1', open, {})).toBe(false)
      await slotted.open('p1', 1)
      const port = { the: 'port' }
      expect(slotted.sendSlotPort('p1', open, port)).toBe(true)
      expect(factory.last.ports).toEqual([{ message: JSON.stringify({ slotOpen: open }), port }])
      // Not a plugin this host runs, nor another project.
      expect(slotted.sendSlotPort('p1', { ...open, pluginId: 'evil.other' }, {})).toBe(false)
      expect(slotted.sendSlotPort('p2', open, {})).toBe(false)
      slotted.closeSlot('p1', 'a.one', 's1')
      await flush()
      expect(hostEvents).toContainEqual({ event: 'slot.close', params: { pluginId: 'a.one', id: 's1' } })
      // No host: nothing to tell.
      slotted.closeSlot('p2', 'a.one', 's1')
    })
  })

  describe('devReload (linked dev plugin changed, Task 29)', () => {
    /** Host handlers that record the plugin.* calls and answer like a healthy loader. */
    const reloadHandlers = (calls: { method: string; params: unknown }[], reloadState?: () => unknown): (() => Record<string, RpcHandler>) =>
      () => ({
        ...okHandlers(),
        'plugin.reload': (p) => {
          calls.push({ method: 'plugin.reload', params: p })
          return reloadState ? reloadState() : { id: (p as { plugin: { id: string } }).plugin.id, state: 'active' }
        },
        'plugin.unload': (p) => {
          calls.push({ method: 'plugin.unload', params: p })
          return null
        }
      })

    it('reloads one plugin inside the running host, then reloads its panels; the process and the others stay', async () => {
      const calls: { method: string; params: unknown }[] = []
      factory.handlers = reloadHandlers(calls)
      await manager.open('p1', 1)
      ready.length = 0
      // The manifest now declares another panel.
      enabled.p1 = [plugin('a.one', { panels: [panel('main'), panel('extra')] }), plugin('a.two')]
      await manager.devReload('a.one')
      expect(factory.spawned).toHaveLength(1)
      expect(calls.map((c) => c.method)).toEqual(['plugin.reload'])
      const spec = (calls[0]?.params as { plugin: { id: string; panels: string[]; dir: string } }).plugin
      expect(spec).toMatchObject({ id: 'a.one', dir: '/plugins/a.one', panels: ['main', 'extra'] })
      expect(factory.last.calls).toEqual(['activate', 'plugin.reload'])
      expect(layouts.panels.get('p1:a.one')).toEqual([panel('main'), panel('extra')])
      expect(ready).toEqual([{ projectId: 'p1', pluginIds: ['a.one'] }])
      expect(manager.runningPanels('p1', 'a.one')).toEqual(['main', 'extra'])
      // Its commands left the registry before the host registered them again.
      expect(sink.cleared).toContain('p1:a.one')
      expect(sink.cleared).not.toContain('p1:a.two')
    })

    it('a reload that arrives while the launch is still activating ends with the plugin active, in one process', async () => {
      const calls: { method: string; params: unknown }[] = []
      let finishActivate: (() => void) | undefined
      factory.handlers = () => ({
        ...reloadHandlers(calls)(),
        activate: (p) =>
          new Promise((resolve) => {
            finishActivate = () =>
              resolve((p as { plugins: { id: string }[] }).plugins.map((x) => ({ id: x.id, state: 'active' })))
          })
      })
      const opening = manager.open('p1', 1)
      await flush()
      expect(finishActivate).toBeDefined()
      ready.length = 0
      const reloading = manager.devReload('a.one')
      await flush()
      finishActivate!()
      await opening
      await reloading
      expect(factory.spawned).toHaveLength(1)
      expect(manager.status('p1')?.plugins).toEqual([
        { id: 'a.one', state: 'active' },
        { id: 'a.two', state: 'active' }
      ])
      // Its panels were told to reload after the reload, so they show the new code.
      expect(ready.at(-1)).toEqual({ projectId: 'p1', pluginIds: ['a.one'] })
    })

    it('a reload during a crash backoff starts the host now, once: the pending restart is dropped', async () => {
      const calls: { method: string; params: unknown }[] = []
      factory.handlers = reloadHandlers(calls)
      await manager.open('p1', 1)
      factory.last.exit(1) // a crash: a restart is pending (1 s backoff), no process now
      await flush()
      expect(manager.status('p1')?.running).toBe(false)
      await manager.devReload('a.one')
      // No process to reload in: a fresh launch with the new code, not a plugin.reload.
      expect(factory.spawned).toHaveLength(2)
      expect(calls).toEqual([])
      expect(manager.status('p1')?.running).toBe(true)
      // The backoff timer that was pending must not start a third process.
      await vi.advanceTimersByTimeAsync(5000)
      expect(factory.spawned).toHaveLength(2)
    })

    it('shows an activate failure of the new code on the plugin panels', async () => {
      const calls: { method: string; params: unknown }[] = []
      factory.handlers = reloadHandlers(calls, () => ({ id: 'a.one', state: 'errored', error: 'activate() failed: boom' }))
      await manager.open('p1', 1)
      await manager.devReload('a.one')
      expect(layouts.status.get('p1:a.one/main')).toEqual({ error: 'activate() failed: boom' })
      expect(manager.runningPanels('p1', 'a.one')).toBeUndefined()
      expect(manager.status('p1')?.plugins.find((x) => x.id === 'a.two')).toEqual({ id: 'a.two', state: 'active' })
    })

    it('reloads in every open host that runs the plugin and skips the ones that do not', async () => {
      const calls: { method: string; params: unknown }[] = []
      factory.handlers = reloadHandlers(calls)
      enabled.p3 = [plugin('a.other')]
      await manager.open('p1', 1)
      await manager.open('p2', 2)
      await manager.open('p3', 3)
      await manager.devReload('a.two')
      expect(calls.filter((c) => c.method === 'plugin.reload')).toHaveLength(2)
      expect(factory.spawned[2]?.calls).toEqual(['activate'])
    })

    it('takes a plugin with an invalid manifest down with the reason on its panels, and brings it back when fixed', async () => {
      const calls: { method: string; params: unknown }[] = []
      factory.handlers = reloadHandlers(calls)
      await manager.open('p1', 1)
      await manager.devReload('a.one', 'invalid plugin: main is required')
      expect(calls).toEqual([{ method: 'plugin.unload', params: { pluginId: 'a.one' } }])
      expect(layouts.status.get('p1:a.one/main')).toEqual({ error: 'plugin disabled: invalid plugin: main is required' })
      expect(manager.status('p1')?.plugins.find((x) => x.id === 'a.one')).toEqual({
        id: 'a.one',
        state: 'errored',
        error: 'plugin disabled: invalid plugin: main is required'
      })
      expect(manager.runningPanels('p1', 'a.one')).toBeUndefined()
      expect(sink.cleared).toContain('p1:a.one')
      // The panel keeps its icon (so the reason has somewhere to show).
      expect(layouts.panels.get('p1:a.one')).toEqual([panel('main')])
      // A crash of the host does not overwrite the reason.
      factory.last.exit(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(layouts.status.get('p1:a.one/main')).toEqual({ error: 'plugin disabled: invalid plugin: main is required' })
    })

    it('recovers in place: a fixed manifest activates the plugin again in the same process', async () => {
      const calls: { method: string; params: unknown }[] = []
      factory.handlers = reloadHandlers(calls)
      await manager.open('p1', 1)
      await manager.devReload('a.one', 'broken')
      calls.length = 0
      await manager.devReload('a.one')
      expect(calls.map((c) => c.method)).toEqual(['plugin.reload'])
      expect(factory.spawned).toHaveLength(1)
      expect(layouts.status.get('p1:a.one/main')).toBeUndefined()
      expect(manager.runningPanels('p1', 'a.one')).toEqual(['main'])
    })

    /** A manager whose oauth.authorize stays pending until aborted; `signals` gets each one's signal. */
    const signInManager = (signals: AbortSignal[]): HostManager =>
      new HostManager({
        factory,
        plugins: async (projectId) => enabled[projectId] ?? [],
        env: async () => ({ PATH: '/usr/bin' }),
        projectPath: (projectId) => `/projects/${projectId}`,
        layouts,
        pluginDataDir: (projectId, pluginId) => `/data/plugin-data/${projectId}/${pluginId}`,
        pluginAppDataDir: (pluginId) => `/data/plugin-data/_app/${pluginId}`,
        settings: () => ({ ok: true, project: {}, app: {} }),
        api: {
          listSessions: () => [],
          session: () => undefined,
          send: () => ({ id: 'q', delivered: false }),
          onSessionsChange: () => () => {},
          openTab: async () => ({ id: 'new' }),
          setBadge: () => true,
          openOverlay: async () => ({ kind: 'dismissed' }),
          secrets: unusedSecrets,
          oauth: {
            authorize: (_spec, signal) =>
              new Promise((_resolve, reject) => {
                signals.push(signal)
                signal.addEventListener('abort', () => reject(new Error('sign-in was cancelled')), { once: true })
              }),
            refresh: async () => ({ accessToken: 'a', refreshToken: null, expiresAt: 0 })
          }
        },
        log
      })
    const signInSpec = { authUrl: 'https://auth.example/authorize', tokenUrl: 'https://auth.example/token', clientId: 'c', scopes: [] }
    const authorizeFromHost = (pluginId = 'a.one'): Promise<unknown> => {
      const pending = factory.last.host.call('oauth.authorize', { pluginId, spec: signInSpec }, { timeoutMs: Infinity })
      void pending.catch(() => {})
      return pending
    }
    /** What the real host sends when it disposes a plugin's ctx with ctx.oauth calls in flight (host/ctx). */
    const disposedInHost = (pluginId = 'a.one'): void => factory.last.host.emit('plugin.disposed', { pluginId })

    it('a plugin taken down inside the running host loses its pending sign-in when the host disposes its ctx', async () => {
      const signals: AbortSignal[] = []
      manager = signInManager(signals)
      factory.handlers = () => ({
        ...okHandlers(),
        'plugin.unload': (p) => {
          disposedInHost((p as { pluginId: string }).pluginId)
          return null
        }
      })
      await manager.open('p1', 1)
      const pending = authorizeFromHost()
      await vi.waitFor(() => expect(signals).toHaveLength(1))
      await manager.devReload('a.one', 'invalid plugin: main is required')
      expect(signals[0]!.aborted).toBe(true)
      await expect(pending).rejects.toThrow('cancelled')
    })

    it('a sign-in the plugin starts during its unload (its deactivate) ends at its dispose; other plugins keep theirs', async () => {
      const signals: AbortSignal[] = []
      manager = signInManager(signals)
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      factory.handlers = () => ({ ...okHandlers(), 'plugin.unload': async () => (await gate, null) })
      await manager.open('p1', 1)
      const other = authorizeFromHost('a.two')
      const reloading = manager.devReload('a.one', 'invalid plugin: main is required')
      await flush()
      // The host is running a.one's deactivate(), which signs in.
      const during = authorizeFromHost()
      await vi.waitFor(() => expect(signals).toHaveLength(2))
      // Its ctx is disposed after the deactivate, before the unload answers.
      disposedInHost()
      release()
      await reloading
      await expect(during).rejects.toThrow('cancelled')
      expect(signals.filter((s) => s.aborted)).toHaveLength(1)
      void manager.close('p1')
      await expect(other).rejects.toThrow('cancelled')
    })

    it('an in-place reload ends the old copy’s sign-in at its dispose; the new copy signs in during its activate', async () => {
      const signals: AbortSignal[] = []
      manager = signInManager(signals)
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let newCopy: Promise<unknown> | undefined
      factory.handlers = () => ({
        ...okHandlers(),
        'plugin.reload': async (p) => {
          // The loader deactivates the old copy and disposes its ctx, then activates the new one.
          disposedInHost()
          newCopy = authorizeFromHost()
          await gate
          return { id: (p as { plugin: { id: string } }).plugin.id, state: 'active' }
        }
      })
      await manager.open('p1', 1)
      const before = authorizeFromHost()
      await vi.waitFor(() => expect(signals).toHaveLength(1))
      const reloading = manager.devReload('a.one')
      await expect(before).rejects.toThrow('cancelled')
      await vi.waitFor(() => expect(signals).toHaveLength(2))
      expect(signals[1]!.aborted).toBe(false)
      release()
      await reloading
      expect(signals[1]!.aborted).toBe(false)
      void manager.close('p1')
      await expect(newCopy).rejects.toThrow('cancelled')
    })

    it('writes nothing for a window that closed during the unload of a taken-down plugin', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      factory.handlers = () => ({ ...okHandlers(), 'plugin.unload': async () => (await gate, null) })
      await manager.open('p1', 1)
      const statusBefore = layouts.status.get('p1:a.one/main')
      const reloading = manager.devReload('a.one', 'broken')
      await flush()
      void manager.close('p1')
      release()
      await reloading
      await flush()
      expect(layouts.status.get('p1:a.one/main')).toEqual(statusBefore)
      expect(manager.status('p1')).toBeUndefined()
    })

    it('ignores an invalid manifest of a plugin that is not part of the host', async () => {
      const calls: { method: string; params: unknown }[] = []
      factory.handlers = reloadHandlers(calls)
      await manager.open('p1', 1)
      await manager.devReload('not.enabled', 'broken')
      expect(calls).toEqual([])
    })

    it('restarts the whole host for a plugin it was not started with (newly valid, or gave main)', async () => {
      const calls: { method: string; params: unknown }[] = []
      factory.handlers = reloadHandlers(calls)
      await manager.open('p1', 1)
      enabled.p1 = [plugin('a.one'), plugin('a.two'), plugin('a.new')]
      await manager.devReload('a.new')
      expect(calls).toEqual([])
      expect(factory.spawned).toHaveLength(2)
      expect(manager.runningPanels('p1', 'a.new')).toEqual(['main'])
    })

    it('restarts a host that gave up after repeated crashes (fresh crash budget)', async () => {
      factory.handlers = reloadHandlers([])
      await manager.open('p1', 1)
      for (const delay of [1000, 2000, 4000, 8000]) {
        factory.last.exit(1)
        await vi.advanceTimersByTimeAsync(delay)
      }
      factory.last.exit(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(manager.status('p1')?.stopped).toBe(true)
      const before = factory.spawned.length
      await manager.devReload('a.one')
      expect(factory.spawned.length).toBe(before + 1)
      expect(manager.status('p1')?.stopped).toBe(false)
    })

    it('runs a plugin that lost its host code as static panels: unloaded in the host, panels reloaded', async () => {
      const calls: { method: string; params: unknown }[] = []
      factory.handlers = reloadHandlers(calls)
      await manager.open('p1', 1)
      ready.length = 0
      enabled.p1 = [plugin('a.one', { main: undefined }), plugin('a.two')]
      await manager.devReload('a.one')
      expect(calls).toEqual([{ method: 'plugin.unload', params: { pluginId: 'a.one' } }])
      expect(ready).toEqual([{ projectId: 'p1', pluginIds: ['a.one'] }])
      expect(manager.status('p1')?.plugins.map((x) => x.id)).toEqual(['a.two'])
    })

    it('reloads a static plugin without a process: panels only', async () => {
      enabled.p3 = [plugin('a.static', { main: undefined })]
      await manager.open('p3', 3)
      enabled.p3 = [plugin('a.static', { main: undefined, panels: [panel('main'), panel('b')] })]
      await manager.devReload('a.static')
      expect(factory.spawned).toHaveLength(0)
      expect(layouts.panels.get('p3:a.static')).toEqual([panel('main'), panel('b')])
      expect(ready.at(-1)).toEqual({ projectId: 'p3', pluginIds: ['a.static'] })
    })

    it('disables the plugin with the reason when its settings no longer validate', async () => {
      const calls: { method: string; params: unknown }[] = []
      factory.handlers = reloadHandlers(calls)
      await manager.open('p1', 1)
      settingsFor['p1:a.one'] = { ok: false, reason: 'token is required' }
      await manager.devReload('a.one')
      expect(calls.map((c) => c.method)).toEqual(['plugin.unload'])
      expect(layouts.status.get('p1:a.one/main')).toEqual({ error: 'plugin disabled: token is required' })
    })

    it('kills a host that does not answer the reload within the activate budget (handled as a crash)', async () => {
      factory.handlers = () => ({ ...okHandlers(), 'plugin.reload': () => new Promise(() => {}) })
      await manager.open('p1', 1)
      const host = factory.last
      const reloading = manager.devReload('a.one')
      // Not killed while a slow deactivate plus a slow activate may still be running...
      await vi.advanceTimersByTimeAsync(activateBudgetMs(1))
      expect(host.killed).toBe(false)
      // ...only once the deactivate grace is spent as well.
      await vi.advanceTimersByTimeAsync(DEACTIVATE_GRACE_MS)
      await reloading
      expect(host.killed).toBe(true)
    })

    it('runs two reloads of one host one after the other', async () => {
      const order: string[] = []
      let release: (() => void) | undefined
      factory.handlers = () => ({
        ...okHandlers(),
        'plugin.reload': (p) => {
          const id = (p as { plugin: { id: string } }).plugin.id
          order.push(`start ${id}`)
          if (order.length === 1) {
            return new Promise((resolve) => {
              release = () => {
                order.push(`end ${id}`)
                resolve({ id, state: 'active' })
              }
            })
          }
          order.push(`end ${id}`)
          return { id, state: 'active' }
        }
      })
      await manager.open('p1', 1)
      const first = manager.devReload('a.one')
      const second = manager.devReload('a.two')
      await flush()
      expect(order).toEqual(['start a.one'])
      release?.()
      await Promise.all([first, second])
      expect(order).toEqual(['start a.one', 'end a.one', 'start a.two', 'end a.two'])
    })

    it('does nothing for a host whose window already closed', async () => {
      const calls: { method: string; params: unknown }[] = []
      factory.handlers = reloadHandlers(calls)
      await manager.open('p1', 1)
      const closing = manager.close('p1')
      await manager.devReload('a.one')
      await closing
      expect(calls).toEqual([])
    })

    it('settings saved while the host swaps the copies reach the new copy, not only the discarded old one', async () => {
      // The host deactivates the old copy before activating the new one from the spec: a `settings`
      // event sent meanwhile lands in the old context, and the new copy ran on the values from
      // before the save.
      const calls: { method: string; params: unknown }[] = []
      let finishReload: (() => void) | undefined
      factory.handlers = () => ({
        ...reloadHandlers(calls)(),
        'plugin.reload': (p) =>
          new Promise((resolve) => {
            calls.push({ method: 'plugin.reload', params: p })
            finishReload = () => resolve({ id: (p as { plugin: { id: string } }).plugin.id, state: 'active' })
          })
      })
      const pushed: unknown[] = []
      factory.onHostEvent = (e, p) => pushed.push([e, p])
      await manager.open('p1', 1)
      const reloading = manager.devReload('a.one')
      await flush()
      expect(finishReload).toBeDefined()
      const sent = (calls[0]?.params as { plugin: { settings: unknown } }).plugin.settings
      expect(sent).toEqual({ project: {}, app: {} })
      settingsFor['p1:a.one'] = { ok: true, project: { limit: 9 }, app: {} }
      await manager.settingsChanged('p1', 'a.one')
      await flush()
      // Not to the copy that is going away.
      expect(pushed).toEqual([])
      finishReload!()
      await reloading
      await flush()
      expect(pushed).toEqual([['settings', { pluginId: 'a.one', project: { limit: 9 }, app: {} }]])
      // Afterwards settings go straight to the running copy again.
      settingsFor['p1:a.one'] = { ok: true, project: { limit: 10 }, app: {} }
      await manager.settingsChanged('p1', 'a.one')
      await flush()
      expect(pushed.at(-1)).toEqual(['settings', { pluginId: 'a.one', project: { limit: 10 }, app: {} }])
      expect(pushed).toHaveLength(2)
    })

    it('a reload with no settings change in between pushes no settings event', async () => {
      const calls: { method: string; params: unknown }[] = []
      factory.handlers = reloadHandlers(calls)
      const pushed: unknown[] = []
      factory.onHostEvent = (e, p) => pushed.push([e, p])
      await manager.open('p1', 1)
      await manager.devReload('a.one')
      // Another plugin's save during nothing: only its own event.
      await manager.settingsChanged('p1', 'a.two')
      await flush()
      expect(calls.map((c) => c.method)).toEqual(['plugin.reload'])
      expect(pushed).toEqual([['settings', { pluginId: 'a.two', project: {}, app: {} }]])
    })
  })

  describe('a plugin replaced while its launch waits', () => {
    /** The installer's answer now, and a hold on whichever wait the test is about. */
    function waiting(where: 'plugins' | 'env') {
      let dir: string | undefined = '/plugins/a.one@1'
      let release = (): void => {}
      const gate = new Promise<void>((r) => (release = r))
      let held = false
      const once = async (): Promise<void> => {
        if (!held) {
          held = true
          await gate
        }
      }
      const hosts = new HostManager({
        factory,
        plugins: async () => {
          const listed = [plugin('a.one', { dir: dir ?? 'gone' })]
          if (where === 'plugins') await once()
          return listed
        },
        env: async () => {
          if (where === 'env') await once()
          return {}
        },
        projectPath: () => '/work/p1',
        layouts,
        pluginDataDir: (projectId, pluginId) => `/data/${projectId}/${pluginId}`,
        pluginAppDataDir: (pluginId) => `/data/plugin-data/_app/${pluginId}`,
        pluginSource: () => (dir === undefined ? undefined : { dir }),
        log
      })
      return { hosts, release, setDir: (next: string | undefined) => (dir = next) }
    }

    it.each(['plugins', 'env'] as const)('does not start the listed folder after a wait in %s; the reload starts the new one', async (where) => {
      const t = waiting(where)
      const opening = t.hosts.open('p1', 1)
      await flush()
      t.setDir('/plugins/a.one@2')
      t.release()
      await opening
      await flush()
      expect(factory.spawned).toHaveLength(0)
      expect(t.hosts.status('p1')?.plugins).toEqual([{ id: 'a.one', state: 'errored', error: 'plugin disabled: it changed while starting' }])

      // What the installer's update does next (afterHostsReload).
      await t.hosts.reloadPlugin('a.one')
      await flush()
      expect(factory.spawned).toHaveLength(1)
      expect(t.hosts.status('p1')?.plugins).toEqual([{ id: 'a.one', state: 'active' }])
      t.hosts.disposeAll()
    })

    it('does not start one revoked during the wait', async () => {
      const t = waiting('plugins')
      const opening = t.hosts.open('p1', 1)
      await flush()
      t.setDir(undefined)
      t.release()
      await opening
      await flush()
      expect(factory.spawned).toHaveLength(0)
      t.hosts.disposeAll()
    })

    it('starts a plugin that did not change', async () => {
      const t = waiting('plugins')
      const opening = t.hosts.open('p1', 1)
      await flush()
      t.release()
      await opening
      await flush()
      expect(factory.spawned).toHaveLength(1)
      t.hosts.disposeAll()
    })
  })

  describe('a same-version replacement or a switch-off while its launch waits', () => {
    /** HostManager over hostPluginSource, as index.ts wires it; `listing` holds the launch in `plugins`. */
    function wired() {
      const state = {
        installed: { dir: '/plugins/a.one@1', commit: 'aaa', manifest: {}, state: { ok: true } } as Parameters<typeof hostPluginSource>[0],
        enabled: true
      }
      let release = (): void => {}
      const gate = new Promise<void>((r) => (release = r))
      const hosts = new HostManager({
        factory,
        plugins: async () => {
          const source = hostPluginSource(state.installed, state.enabled)
          await gate
          return source ? [plugin('a.one', source)] : []
        },
        env: async () => ({}),
        projectPath: () => '/work/p1',
        layouts,
        pluginDataDir: (projectId, pluginId) => `/data/${projectId}/${pluginId}`,
        pluginAppDataDir: (pluginId) => `/data/plugin-data/_app/${pluginId}`,
        pluginSource: () => hostPluginSource(state.installed, state.enabled),
        log
      })
      return { hosts, state, release }
    }

    it('does not start another commit that took over the same folder', async () => {
      const t = wired()
      const opening = t.hosts.open('p1', 1)
      await flush()
      t.state.installed = { dir: '/plugins/a.one@1', commit: 'bbb', manifest: {}, state: { ok: true } }
      t.release()
      await opening
      await flush()
      expect(factory.spawned).toHaveLength(0)
      t.hosts.disposeAll()
    })

    it('does not start a plugin the project no longer has on', async () => {
      const t = wired()
      const opening = t.hosts.open('p1', 1)
      await flush()
      t.state.enabled = false
      t.release()
      await opening
      await flush()
      expect(factory.spawned).toHaveLength(0)
      t.hosts.disposeAll()
    })

    it('starts one where neither moved', async () => {
      const t = wired()
      const opening = t.hosts.open('p1', 1)
      await flush()
      t.release()
      await opening
      await flush()
      expect(factory.spawned).toHaveLength(1)
      t.hosts.disposeAll()
    })
  })

  describe('hostPluginSource', () => {
    const ok = { dir: '/plugins/a@1', manifest: {}, state: { ok: true } }
    it('is the folder and the commit of a plugin that may run', () => {
      expect(hostPluginSource({ ...ok, commit: 'aaa' }, true)).toEqual({ dir: '/plugins/a@1', commit: 'aaa' })
      expect(hostPluginSource(ok, true)).toEqual({ dir: '/plugins/a@1' })
    })
    it.each([
      ['switched off in the project', ok, false],
      ['not installed', undefined, true],
      ['without a valid manifest', { dir: '/plugins/a@1', state: { ok: true } }, true],
      ['revoked or disabled', { ...ok, state: { ok: false } }, true],
      ['without a folder', { ...ok, dir: '' }, true]
    ])('is nothing when %s', (_what, installed, enabled) => {
      expect(hostPluginSource(installed, enabled)).toBeUndefined()
    })
  })

  describe('reloadPlugin (installed, linked, updated, uninstalled)', () => {
    it('starts a plugin (re)installed while a project still has it enabled, and leaves other hosts alone', async () => {
      // p1 has a.one enabled, but it is not installed (uninstalled earlier): the host runs a.two only.
      enabled.p1 = [plugin('a.two')]
      enabled.p3 = [plugin('a.other')]
      await manager.open('p1', 1)
      await manager.open('p3', 3)
      expect(factory.spawned).toHaveLength(2)
      expect(layouts.panels.has('p1:a.one')).toBe(false)
      ready.length = 0
      // Reinstalled (or relinked): the index has it again, the enabled list never lost it.
      enabled.p1 = [plugin('a.one'), plugin('a.two')]
      await manager.reloadPlugin('a.one')
      expect(factory.spawned).toHaveLength(3)
      expect(factory.spawned[0]?.killed).toBe(true)
      expect(factory.spawned[1]?.killed).toBe(false)
      expect(manager.status('p1')?.plugins).toEqual([
        { id: 'a.one', state: 'active' },
        { id: 'a.two', state: 'active' }
      ])
      expect(layouts.panels.get('p1:a.one')).toEqual([panel('main')])
      expect(ready).toEqual([{ projectId: 'p1', pluginIds: ['a.one', 'a.two'] }])
    })

    it('a static-only plugin (re)installed into a project that has it enabled declares and reloads its panels', async () => {
      enabled.p3 = []
      await manager.open('p3', 3)
      enabled.p3 = [plugin('a.static', { main: undefined })]
      ready.length = 0
      await manager.reloadPlugin('a.static')
      expect(factory.spawned).toHaveLength(0)
      expect(layouts.panels.get('p3:a.static')).toEqual([panel('main')])
      expect(ready).toEqual([{ projectId: 'p3', pluginIds: ['a.static'] }])
    })

    it('a host whose plugin list cannot be read is logged and skipped; the others still restart', async () => {
      enabled.p1 = [plugin('a.two')]
      await manager.open('p1', 1)
      listError = new Error('index gone')
      await manager.reloadPlugin('a.one')
      expect(factory.spawned).toHaveLength(1)
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/cannot list plugins to reload a\.one: index gone/))
    })
  })

  it('kills every host at once on dispose', async () => {
    await manager.open('p1', 1)
    await manager.open('p2', 2)
    manager.disposeAll()
    expect(factory.spawned.every((h) => h.killed)).toBe(true)
    expect(factory.spawned.every((h) => h.calls.includes('deactivate'))).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(factory.spawned).toHaveLength(2)
  })

  it('still kills a host that is deactivating after its window closed when the app quits', async () => {
    factory.handlers = () => ({ ...okHandlers(), deactivate: () => new Promise(() => {}) })
    await manager.open('p1', 1)
    const host = factory.last
    const closing = manager.close('p1')
    await flush()
    expect(host.killed).toBe(false)
    manager.disposeAll()
    expect(host.killed).toBe(true)
    await vi.advanceTimersByTimeAsync(DEACTIVATE_GRACE_MS)
    await closing
  })
})

describe('hostEnv', () => {
  it('keeps only the allow-listed variables', () => {
    expect(
      hostEnv({
        PATH: '/bin',
        HOME: '/h',
        LANG: 'en_US.UTF-8',
        LC_CTYPE: 'UTF-8',
        HTTPS_PROXY: 'http://proxy:8080',
        AWS_SECRET_ACCESS_KEY: 'x',
        GITHUB_TOKEN: 'y',
        CC_COCKPIT_DATA_DIR: '/data',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--require /evil.js',
        UNSET: undefined
      })
    ).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'en_US.UTF-8', LC_CTYPE: 'UTF-8', HTTPS_PROXY: 'http://proxy:8080' })
  })
})
