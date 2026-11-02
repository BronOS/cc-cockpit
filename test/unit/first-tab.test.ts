import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectRegistry } from '../../src/main/projects/registry'
import { buildRestorePlan, TabRestorer, type RestoredTab } from '../../src/main/restore'
import { FirstTab } from '../../src/main/tabs/first-tab'
import { TabManager } from '../../src/main/tabs/tab-manager'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

let root: string
let projectDir: string
let dataDir: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-first-tab-')))
  projectDir = join(root, 'project')
  dataDir = join(root, 'data')
  mkdirSync(projectDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/**
 * main's wiring (index.ts) over the real registry, restorer and tab manager with a fake PTY
 * backend: `open` is WindowManager's onProjectOpened, `attach` the tabs.list handler, `close`
 * onProjectClosed, `ready` the login env.
 */
function rig() {
  const registry = new ProjectRegistry({ dataDir, log: () => {} })
  const project = registry.openPath(projectDir)
  const backend = new FakePtyBackend()
  const windows = new Map<string, number>()
  const state = { enabled: true, logs: [] as string[] }
  let ready = Promise.resolve()
  const tabs: TabManager = new TabManager({
    backend,
    projectPath: (id) => registry.get(id)?.path,
    loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/u' }),
    hooksPath: '/data/hooks.json',
    binDir: '/data/bin',
    sock: () => undefined,
    onTabsChanged: (id) => restorer.tabsChanged(id),
    closeOnCleanExit: () => true,
    emit: () => {},
    log: () => {}
  })
  const restorer = new TabRestorer({
    listTabs: (id) => tabs.list(id),
    saveTabs: (id, records) =>
      registry.update(id, (r) => {
        r.tabs = records
      }),
    projectPath: (id) => registry.get(id)?.path,
    log: () => {}
  })
  const firstTab = new FirstTab({
    enabled: () => state.enabled,
    tabCount: (id) => tabs.list(id).length,
    windowIdOf: (id) => windows.get(id),
    open: (id) => {
      tabs.create(id, { kind: 'claude' })
    },
    log: (m) => state.logs.push(m)
  })
  const open = (windowId: number): void => {
    windows.set(project.id, windowId)
    const saved = registry.get(project.id)
    firstTab.arm(
      project.id,
      windowId,
      restorer.hasPending(project.id) || (saved !== undefined && buildRestorePlan(saved).length > 0)
    )
  }
  // The attaching window is the one open when the call starts (the router resolves the sender).
  const attach = async (): Promise<string[]> => {
    const windowId = windows.get(project.id) ?? -1
    await restorer.restore(project.id, ready, (tab) => {
      tabs.restoreTab(project.id, tab)
    })
    await firstTab.settle(project.id, windowId, ready)
    return tabs.attach(project.id).map((t) => t.kind)
  }
  const close = (): void => {
    windows.delete(project.id)
    firstTab.disarm(project.id)
    tabs.closeProject(project.id)
    restorer.clear(project.id)
  }
  return {
    registry,
    project,
    backend,
    tabs,
    restorer,
    firstTab,
    state,
    open,
    attach,
    close,
    setReady: (p: Promise<void>) => {
      ready = p
    }
  }
}

describe('FirstTab: the first Claude tab of a project that opens empty', () => {
  it('opens one Claude tab in the project folder when a window opens with nothing to restore', async () => {
    const r = rig()
    r.open(1)
    expect(await r.attach()).toEqual(['claude'])
    expect(r.backend.spawned).toHaveLength(1)
    // A fresh `claude`, exactly as New tab > Claude starts it: no --resume, cwd the project.
    expect(r.backend.spawned[0]!.argv).not.toContain('--resume')
    expect(r.backend.spawned[0]!.options.cwd).toBe(r.project.path)
    expect(r.tabs.list(r.project.id)[0]!.cwd).toBe(r.project.path)
  })

  it('does nothing with the setting off', async () => {
    const r = rig()
    r.state.enabled = false
    r.open(1)
    expect(await r.attach()).toEqual([])
    expect(r.backend.spawned).toHaveLength(0)
  })

  it('reads the setting when the window attaches, not when it opened', async () => {
    const r = rig()
    r.open(1)
    r.state.enabled = false
    expect(await r.attach()).toEqual([])
  })

  it('does not fire when the restore brought tabs back', async () => {
    const r = rig()
    r.restorer.queue(r.project.id, [{ kind: 'shell' }])
    r.open(1)
    expect(await r.attach()).toEqual(['shell'])
    expect(r.backend.spawned).toHaveLength(1)
  })

  it('does not fire when every restored tab failed to start (they still came back as records)', async () => {
    const r = rig()
    const plan: RestoredTab[] = [{ kind: 'claude', resumeId: 'sess-1' }]
    r.restorer.queue(r.project.id, plan)
    r.open(1)
    r.backend.failWith = new Error('out of ptys')
    expect(await r.attach()).toEqual([])
    expect(r.backend.spawned).toHaveLength(0)
    // The failed tab's session id is still in the record for the next launch.
    expect(r.registry.get(r.project.id)?.tabs.map((t) => t.sessionId)).toEqual(['sess-1'])
  })

  it('does not fire for a project whose record still holds saved tabs (its folder was missing at launch)', async () => {
    const r = rig()
    r.registry.update(r.project.id, (p) => {
      p.tabs = [{ id: 'old', kind: 'claude', cwd: projectDir, sessionId: 'sess-9' }]
    })
    r.open(1)
    expect(await r.attach()).toEqual([])
    // Nothing rewrote the record: the saved session survives.
    expect(r.registry.get(r.project.id)?.tabs.map((t) => t.sessionId)).toEqual(['sess-9'])
  })

  it('does not fire when a plugin already opened a tab before the window attached', async () => {
    const r = rig()
    r.open(1)
    r.tabs.create(r.project.id, { kind: 'shell' })
    expect(await r.attach()).toEqual(['shell'])
  })

  it('fires at most once per window open: a reload and closing the last tab bring nothing back', async () => {
    const r = rig()
    r.open(1)
    expect(await r.attach()).toEqual(['claude'])
    const [tab] = r.tabs.list(r.project.id)
    r.tabs.close(r.project.id, tab!.id)
    expect(await r.attach()).toEqual([])
    expect(r.backend.spawned).toHaveLength(1)
  })

  it('does not reopen after a clean exit auto-closed the last tab', async () => {
    const r = rig()
    r.open(1)
    expect(await r.attach()).toEqual(['claude'])
    r.backend.spawned[0]!.exit(0)
    expect(r.tabs.list(r.project.id)).toEqual([])
    expect(await r.attach()).toEqual([])
    expect(r.backend.spawned).toHaveLength(1)
  })

  it('fires again for the next open of the window', async () => {
    const r = rig()
    r.open(1)
    expect(await r.attach()).toEqual(['claude'])
    r.close()
    r.open(2)
    expect(await r.attach()).toEqual(['claude'])
    expect(r.backend.spawned).toHaveLength(2)
  })

  it('waits for an async restore before deciding, and a second attach meanwhile gets the same tabs', async () => {
    const r = rig()
    const login = deferred()
    r.setReady(login.promise)
    r.restorer.queue(r.project.id, [{ kind: 'shell' }])
    r.open(1)
    const first = r.attach()
    const second = r.attach()
    await Promise.resolve()
    expect(r.backend.spawned).toHaveLength(0)
    login.resolve()
    expect(await first).toEqual(['shell'])
    expect(await second).toEqual(['shell'])
    expect(r.backend.spawned).toHaveLength(1)
  })

  it('waits for the login env with nothing to restore; a plugin tab that lands first wins', async () => {
    const r = rig()
    const login = deferred()
    r.setReady(login.promise)
    r.open(1)
    const attached = r.attach()
    // ctx.tabs.open also waits for the login env; here it runs before the decision does.
    const plugin = login.promise.then(() => r.tabs.create(r.project.id, { kind: 'claude', prompt: 'hi' }))
    login.resolve()
    await plugin
    expect(await attached).toEqual(['claude'])
    expect(r.backend.spawned).toHaveLength(1)
  })

  it('a reload while the login env is awaited does not open a second tab and sees the first', async () => {
    const r = rig()
    const login = deferred()
    r.setReady(login.promise)
    r.open(1)
    const first = r.attach()
    const second = r.attach()
    login.resolve()
    expect(await second).toEqual(['claude'])
    expect(await first).toEqual(['claude'])
    expect(r.backend.spawned).toHaveLength(1)
  })

  it('opens nothing when the window closed while the login env was awaited, even if it reopened', async () => {
    const r = rig()
    const login = deferred()
    r.setReady(login.promise)
    r.open(1)
    const stale = r.attach()
    r.close()
    r.open(2)
    login.resolve()
    await stale
    // The stale attach of window 1 spawned nothing; window 2 still has its own arm.
    expect(r.backend.spawned).toHaveLength(0)
    expect(await r.attach()).toEqual(['claude'])
  })

  it('does nothing for a window closed before it attached', async () => {
    const r = rig()
    r.open(1)
    r.close()
    await r.firstTab.settle(r.project.id, 1, Promise.resolve())
    expect(r.backend.spawned).toHaveLength(0)
  })

  it('logs a failed spawn and still lets the window attach', async () => {
    const r = rig()
    r.open(1)
    r.backend.failWith = new Error('no ptys left')
    expect(await r.attach()).toEqual([])
    expect(r.state.logs).toEqual([expect.stringContaining('no ptys left')])
  })
})
