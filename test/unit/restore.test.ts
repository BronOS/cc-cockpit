import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TabInfo } from '../../src/shared/ipc'
import type { ProjectView, TabRecord } from '../../src/shared/types'
import { ProjectRegistry } from '../../src/main/projects/registry'
import {
  buildRestorePlan,
  forgetMissing,
  planLaunch,
  relinkMissing,
  TabRestorer,
  tabRecordsOf,
  type RestoredTab
} from '../../src/main/restore'
import { TabManager } from '../../src/main/tabs/tab-manager'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

let root: string
let projectDir: string
let dataDir: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-restore-')))
  projectDir = join(root, 'project')
  dataDir = join(root, 'data')
  mkdirSync(join(projectDir, 'sub'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const rec = (partial: Partial<TabRecord> & Pick<TabRecord, 'kind'>, n = 1): TabRecord => ({
  id: `tab-${n}`,
  cwd: projectDir,
  ...partial
})

describe('buildRestorePlan', () => {
  it('turns saved records into tabs in saved order, resuming Claude sessions', () => {
    const plan = buildRestorePlan({
      path: projectDir,
      tabs: [
        rec({ kind: 'claude', sessionId: 'sess-1' }, 1),
        rec({ kind: 'shell', cwd: join(projectDir, 'sub') }, 2),
        rec({ kind: 'claude', sessionId: 'sess-2' }, 3)
      ]
    })
    expect(plan).toEqual<RestoredTab[]>([
      { kind: 'claude', cwd: projectDir, resumeId: 'sess-1' },
      { kind: 'shell', cwd: join(projectDir, 'sub') },
      { kind: 'claude', cwd: projectDir, resumeId: 'sess-2' }
    ])
  })

  it('starts a Claude tab without a session id fresh', () => {
    const [tab] = buildRestorePlan({ path: projectDir, tabs: [rec({ kind: 'claude' })] })
    expect(tab).toEqual({ kind: 'claude', cwd: projectDir })
    expect(tab).not.toHaveProperty('resumeId')
  })

  it('never resumes a shell tab, whatever its record says', () => {
    const [tab] = buildRestorePlan({ path: projectDir, tabs: [rec({ kind: 'shell', sessionId: 'sess-1' })] })
    expect(tab).toEqual({ kind: 'shell', cwd: projectDir })
  })

  it('drops a session id that would be read as an option, keeping the tab fresh', () => {
    const bad = ['--settings', '-r', '', 'a b', 'x'.repeat(200), '../x', 'id\n--foo']
    for (const sessionId of bad) {
      const [tab] = buildRestorePlan({ path: projectDir, tabs: [rec({ kind: 'claude', sessionId })] })
      expect(tab, JSON.stringify(sessionId)).toEqual({ kind: 'claude', cwd: projectDir })
    }
  })

  it('falls back to the project folder for a cwd that is gone, a file, or outside the project', () => {
    const file = join(projectDir, 'notes.txt')
    writeFileSync(file, 'x')
    const outside = join(root, 'elsewhere')
    mkdirSync(outside)
    const cwds = [join(projectDir, 'deleted'), file, outside, 'relative/path']
    const plan = buildRestorePlan({
      path: projectDir,
      tabs: cwds.map((cwd, i) => rec({ kind: 'shell', cwd }, i))
    })
    expect(plan).toHaveLength(4)
    for (const tab of plan) expect(tab).toEqual({ kind: 'shell' })
  })

  it('falls back to the project folder for a cwd inside the project that is a symlink pointing outside', () => {
    const outside = join(root, 'elsewhere')
    mkdirSync(outside)
    symlinkSync(outside, join(projectDir, 'link'))
    const plan = buildRestorePlan({
      path: projectDir,
      tabs: [rec({ kind: 'shell', cwd: join(projectDir, 'link') })]
    })
    expect(plan).toEqual([{ kind: 'shell' }])
  })

  it('brings a command tab back with its own saved label and command', () => {
    const plan = buildRestorePlan({
      path: projectDir,
      tabs: [rec({ kind: 'command', cwd: join(projectDir, 'sub'), label: ' Logs ', command: 'tail -f log | grep x', sessionId: 's' })]
    })
    // Trimmed like a settings entry; a session id on a command record is ignored.
    expect(plan).toEqual([{ kind: 'command', cwd: join(projectDir, 'sub'), command: { label: 'Logs', command: 'tail -f log | grep x' } }])
  })

  it('skips a command tab whose record has no valid label or command (nothing safe to run or show)', () => {
    const bad: Array<Partial<TabRecord>> = [
      { command: 'htop' },
      { label: 'Top' },
      { label: '', command: 'htop' },
      { label: 'Nul', command: 'echo a\0b' },
      { label: 'Long', command: 'x'.repeat(4097) },
      { label: 5 as unknown as string, command: 'htop' }
    ]
    const tabs = [...bad.map((b, i) => rec({ kind: 'command', ...b }, i)), rec({ kind: 'shell' }, 99)]
    expect(buildRestorePlan({ path: projectDir, tabs })).toEqual([{ kind: 'shell', cwd: projectDir }])
  })

  it('skips records it does not understand instead of failing the whole restore', () => {
    const garbage = [null, 7, 'tab', { kind: 'editor', cwd: projectDir }, { cwd: projectDir }]
    const tabs = [...garbage, rec({ kind: 'shell' })] as unknown as TabRecord[]
    expect(buildRestorePlan({ path: projectDir, tabs })).toEqual([{ kind: 'shell', cwd: projectDir }])
    expect(buildRestorePlan({ path: projectDir, tabs: 'nope' as unknown as TabRecord[] })).toEqual([])
    expect(buildRestorePlan({ path: projectDir, tabs: [] })).toEqual([])
  })
})

describe('session names', () => {
  it('are saved, restored for Claude tabs only, and dropped when invalid', () => {
    expect(tabRecordsOf([{ id: 'a', gen: 1, kind: 'claude', cwd: '/p', name: 'Mine' }])).toEqual([
      { id: 'a', kind: 'claude', cwd: '/p', name: 'Mine' }
    ])
    const plan = buildRestorePlan({
      path: projectDir,
      tabs: [
        rec({ kind: 'claude', name: ' Mine ' }, 1),
        rec({ kind: 'claude', name: 'x'.repeat(61) }, 2),
        rec({ kind: 'claude', name: 'a\u001bb' }, 3),
        rec({ kind: 'claude', name: 7 as unknown as string }, 4),
        rec({ kind: 'shell', name: 'Nope' }, 5)
      ]
    })
    expect(plan.map((t) => t.name)).toEqual(['Mine', undefined, undefined, undefined, undefined])
  })
})

describe('tab flags', () => {
  it('are saved for every kind, restored for every kind, and a damaged one is dropped, not the tab', () => {
    expect(
      tabRecordsOf([
        { id: 'a', gen: 1, kind: 'claude', cwd: '/p', flag: { color: 'red', note: 'come back' } },
        { id: 'b', gen: 1, kind: 'shell', cwd: '/p', flag: { color: 'blue' } },
        { id: 'c', gen: 1, kind: 'shell', cwd: '/p' }
      ])
    ).toEqual([
      { id: 'a', kind: 'claude', cwd: '/p', flag: { color: 'red', note: 'come back' } },
      { id: 'b', kind: 'shell', cwd: '/p', flag: { color: 'blue' } },
      { id: 'c', kind: 'shell', cwd: '/p' }
    ])
    const plan = buildRestorePlan({
      path: projectDir,
      tabs: [
        rec({ kind: 'claude', flag: { color: 'red', note: '  come\nback ' } }, 1),
        rec({ kind: 'shell', flag: { color: 'green' } }, 2),
        rec({ kind: 'command', label: 'Dev', command: 'npm run dev', flag: { color: 'purple' } }, 3),
        rec({ kind: 'shell', flag: { color: 'teal' } }, 4),
        rec({ kind: 'shell', flag: 'red' as never }, 5),
        rec({ kind: 'shell', flag: { color: 'yellow', note: 'x'.repeat(81) } }, 6),
        rec({ kind: 'shell', flag: { color: 'yellow', note: 7 as never } }, 7)
      ]
    })
    expect(plan.map((t) => t.flag)).toEqual([
      { color: 'red', note: 'come back' },
      { color: 'green' },
      { color: 'purple' },
      undefined,
      undefined,
      // A damaged note costs only the note.
      { color: 'yellow' },
      { color: 'yellow' }
    ])
  })

  it('a tab that failed to restore keeps its flag in the record', async () => {
    const saved: TabRecord[][] = []
    const restorer = new TabRestorer({ listTabs: () => [], saveTabs: (_id, r) => saved.push(r), projectPath: () => '/p', log: () => {} })
    restorer.queue('p1', [{ kind: 'shell', flag: { color: 'orange', note: 'n' } }])
    await restorer.restore('p1', Promise.resolve(), () => {
      throw new Error('out of ptys')
    })
    expect(saved.at(-1)).toEqual([{ id: expect.any(String), kind: 'shell', cwd: '/p', flag: { color: 'orange', note: 'n' } }])
  })

  it('survive an app restart on disk: flagged in one run, flagged in the next, any tab kind', async () => {
    const registry = new ProjectRegistry({ dataDir, log: () => {} })
    const project = registry.openPath(projectDir)
    const backend = new FakePtyBackend()
    let tabs: TabManager
    const restorer = new TabRestorer({
      listTabs: (id) => tabs.list(id),
      saveTabs: (id, records) =>
        registry.update(id, (r) => {
          r.tabs = records
        }),
      projectPath: (id) => registry.get(id)?.path
    })
    const makeManager = (): TabManager =>
      new TabManager({
        backend,
        projectPath: (id) => registry.get(id)?.path,
        loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/u' }),
        hooksPath: '/data/hooks.json',
        binDir: '/data/bin',
        sock: () => undefined,
        onTabsChanged: (id) => restorer.tabsChanged(id),
        emit: () => {},
        log: () => {}
      })
    tabs = makeManager()
    const claude = tabs.create(project.id, { kind: 'claude' })
    const shell = tabs.create(project.id, { kind: 'shell' })
    tabs.setFlag(project.id, claude.id, { color: 'red', note: 'review the plan' })
    tabs.setFlag(project.id, shell.id, { color: 'green' })
    registry.flushAll()

    const registry2 = new ProjectRegistry({ dataDir, log: () => {} })
    const saved = registry2.get(project.id)!
    tabs = makeManager()
    restorer.queue(project.id, buildRestorePlan(saved))
    await restorer.restore(project.id, Promise.resolve(), (t) => {
      tabs.restoreTab(project.id, t)
    })
    expect(tabs.list(project.id).map((t) => [t.kind, t.flag])).toEqual([
      ['claude', { color: 'red', note: 'review the plan' }],
      ['shell', { color: 'green' }]
    ])
  })
})

describe('tabRecordsOf', () => {
  it('keeps kind, cwd and the session id when known', () => {
    const tabs: TabInfo[] = [
      { id: 'a', gen: 1, kind: 'claude', cwd: '/p', sessionId: 's' },
      { id: 'b', gen: 1, kind: 'shell', cwd: '/p/sub', exit: { code: 1, signal: null } }
    ]
    expect(tabRecordsOf(tabs)).toEqual([
      { id: 'a', kind: 'claude', cwd: '/p', sessionId: 's' },
      { id: 'b', kind: 'shell', cwd: '/p/sub' }
    ])
  })

  it("saves a command tab's own copy of its label and command, not-started or not", () => {
    const tabs: TabInfo[] = [
      { id: 'c', gen: 1, kind: 'command', cwd: '/p', label: 'Dev', command: 'npm run dev' },
      { id: 'd', gen: 0, kind: 'command', cwd: '/p', label: 'Top', command: 'htop', notStarted: true, exit: { code: 0, signal: null } }
    ]
    expect(tabRecordsOf(tabs)).toEqual([
      { id: 'c', kind: 'command', cwd: '/p', label: 'Dev', command: 'npm run dev' },
      { id: 'd', kind: 'command', cwd: '/p', label: 'Top', command: 'htop' }
    ])
  })
})

describe('planLaunch', () => {
  const view = (path: string, missing: boolean, tabs: TabRecord[] = []): ProjectView =>
    ({ id: 'aaaaaaaaaaaaaaaa', path, missing, tabs }) as unknown as ProjectView

  it('opens projects whose folder is there and sets the missing ones aside', () => {
    const gone = view(join(root, 'gone'), true, [rec({ kind: 'claude', sessionId: 's' })])
    const here = view(projectDir, false, [rec({ kind: 'claude', sessionId: 's' })])
    const plan = planLaunch([gone, here])
    expect(plan.missing).toEqual([gone])
    expect(plan.open).toEqual([
      { project: here, tabs: [{ kind: 'claude', cwd: projectDir, resumeId: 's' }] }
    ])
  })
})

describe('TabRestorer', () => {
  function setup(): {
    restorer: TabRestorer
    saved: Array<{ projectId: string; records: TabRecord[] }>
    live: Map<string, TabInfo[]>
    logs: string[]
  } {
    const saved: Array<{ projectId: string; records: TabRecord[] }> = []
    const live = new Map<string, TabInfo[]>()
    const logs: string[] = []
    const restorer = new TabRestorer({
      listTabs: (id) => live.get(id) ?? [],
      saveTabs: (projectId, records) => saved.push({ projectId, records }),
      projectPath: (id) => (id === 'p1' ? '/p' : undefined),
      log: (m) => logs.push(m)
    })
    return { restorer, saved, live, logs }
  }

  it('saves the live tabs of the project that changed', () => {
    const { restorer, saved, live } = setup()
    live.set('p1', [{ id: 'a', gen: 1, kind: 'claude', cwd: '/p', sessionId: 's' }])
    restorer.tabsChanged('p1')
    expect(saved).toEqual([{ projectId: 'p1', records: [{ id: 'a', kind: 'claude', cwd: '/p', sessionId: 's' }] }])
  })

  it('starts the queued tabs in order on restore, then saves what runs', async () => {
    const { restorer, saved, live } = setup()
    restorer.queue('p1', [{ kind: 'claude', resumeId: 's1' }, { kind: 'shell' }])
    const started: RestoredTab[] = []
    await restorer.restore('p1', Promise.resolve(), (tab) => {
      started.push(tab)
      live.set('p1', [
        ...(live.get('p1') ?? []),
        { id: `t${started.length}`, gen: 1, kind: tab.kind, cwd: '/p', sessionId: tab.resumeId }
      ])
    })
    expect(started).toEqual([{ kind: 'claude', resumeId: 's1' }, { kind: 'shell' }])
    // One save, after the whole batch: a crash half way through must not leave a shortened list.
    expect(saved).toHaveLength(1)
    expect(saved[0]!.records.map((r) => r.sessionId)).toEqual(['s1', undefined])
  })

  it('waits for the login env before starting anything', async () => {
    const { restorer } = setup()
    restorer.queue('p1', [{ kind: 'shell' }])
    let release!: () => void
    const ready = new Promise<void>((r) => (release = r))
    const started: RestoredTab[] = []
    const done = restorer.restore('p1', ready, (t) => started.push(t))
    await Promise.resolve()
    expect(started).toEqual([])
    release()
    await done
    expect(started).toHaveLength(1)
  })

  it('runs once: a second attach during the run waits for it, a later one does nothing', async () => {
    const { restorer } = setup()
    restorer.queue('p1', [{ kind: 'shell' }])
    let release!: () => void
    const ready = new Promise<void>((r) => (release = r))
    const started: RestoredTab[] = []
    const first = restorer.restore('p1', ready, (t) => started.push(t))
    let secondDone = false
    const second = restorer.restore('p1', Promise.resolve(), (t) => started.push(t)).then(() => {
      secondDone = true
    })
    await Promise.resolve()
    expect(secondDone).toBe(false)
    release()
    await Promise.all([first, second])
    expect(started).toHaveLength(1)
    await restorer.restore('p1', Promise.resolve(), (t) => started.push(t))
    expect(started).toHaveLength(1)
  })

  it('starts nothing when the window is closed while the login env is still being captured', async () => {
    const { restorer, saved } = setup()
    restorer.queue('p1', [{ kind: 'shell' }])
    let release!: () => void
    const ready = new Promise<void>((r) => (release = r))
    const started: RestoredTab[] = []
    const done = restorer.restore('p1', ready, (t) => started.push(t))
    restorer.clear('p1') // onProjectClosed
    const savedAfterClose = saved.length
    release()
    await done
    expect(started).toEqual([])
    expect(saved).toHaveLength(savedAfterClose) // no write-back over the cleared record
  })

  it('logs a tab that fails to start and still brings back the others', async () => {
    const { restorer, logs, saved, live } = setup()
    restorer.queue('p1', [{ kind: 'claude', resumeId: 'bad' }, { kind: 'shell' }])
    const started: RestoredTab[] = []
    await restorer.restore('p1', Promise.resolve(), (tab) => {
      if (tab.kind === 'claude') throw new Error('spawn failed')
      started.push(tab)
      live.set('p1', [{ id: 'sh', gen: 1, kind: 'shell', cwd: '/p' }])
    })
    expect(started).toEqual([{ kind: 'shell' }])
    expect(logs.join('\n')).toMatch(/cannot restore a claude tab of project p1: spawn failed/)
    expect(saved).toHaveLength(1)
    // The failed tab keeps its record (and its conversation link) for the next launch, after
    // the live tabs, with a fresh id and the project folder as its cwd.
    expect(saved[0]!.records).toEqual([
      { id: 'sh', kind: 'shell', cwd: '/p' },
      { id: expect.any(String), kind: 'claude', cwd: '/p', sessionId: 'bad' }
    ])
  })

  it('keeps a failed tab in every later save until the window is closed', async () => {
    const { restorer, saved, live } = setup()
    restorer.queue('p1', [
      { kind: 'claude', cwd: '/p/sub', resumeId: 's1' },
      { kind: 'shell' },
      { kind: 'claude' }
    ])
    await restorer.restore('p1', Promise.resolve(), (tab) => {
      if (tab.kind === 'claude') throw new Error('out of ptys')
      live.set('p1', [{ id: 'sh', gen: 1, kind: 'shell', cwd: '/p' }])
    })
    const failed = saved[0]!.records.slice(1)
    expect(failed).toEqual([
      { id: expect.any(String), kind: 'claude', cwd: '/p/sub', sessionId: 's1' },
      { id: expect.any(String), kind: 'claude', cwd: '/p' }
    ])
    // A later tab change rewrites the record from the live tabs: the failed ones stay in it.
    live.set('p1', [{ id: 'sh', gen: 1, kind: 'shell', cwd: '/p' }, { id: 'new', gen: 1, kind: 'shell', cwd: '/p' }])
    restorer.tabsChanged('p1')
    expect(saved.at(-1)!.records.map((r) => r.id)).toEqual(['sh', 'new', failed[0]!.id, failed[1]!.id])
    // Closing the window ends them with the rest.
    restorer.clear('p1')
    expect(saved.at(-1)!.records).toEqual([])
    live.set('p1', [])
    restorer.tabsChanged('p1')
    expect(saved.at(-1)!.records).toEqual([])
  })

  it('keeps a command tab that failed to restore with its label and command', async () => {
    const { restorer, saved } = setup()
    restorer.queue('p1', [{ kind: 'command', command: { label: 'Dev', command: 'npm run dev' } }])
    await restorer.restore('p1', Promise.resolve(), () => {
      throw new Error('project folder does not exist')
    })
    expect(saved.at(-1)!.records).toEqual([
      { id: expect.any(String), kind: 'command', cwd: '/p', label: 'Dev', command: 'npm run dev' }
    ])
  })

  it('drops a failed tab it cannot place (no cwd and the project is unknown)', async () => {
    const { restorer, saved } = setup()
    restorer.queue('p2', [{ kind: 'claude', resumeId: 's1' }])
    await restorer.restore('p2', Promise.resolve(), () => {
      throw new Error('spawn failed')
    })
    expect(saved).toEqual([{ projectId: 'p2', records: [] }])
  })

  it('has nothing to do for a project without a plan', async () => {
    const { restorer, saved } = setup()
    restorer.queue('p1', [])
    expect(restorer.hasPending('p1')).toBe(false)
    await restorer.restore('p1', Promise.resolve(), () => {
      throw new Error('should not start')
    })
    expect(saved).toEqual([])
  })

  it('freeze keeps what is saved: window closes during quit write nothing', () => {
    const { restorer, saved, live } = setup()
    live.set('p1', [{ id: 'a', gen: 1, kind: 'shell', cwd: '/p' }])
    restorer.tabsChanged('p1')
    restorer.freeze()
    live.set('p1', [])
    restorer.tabsChanged('p1')
    restorer.clear('p1')
    expect(saved).toHaveLength(1)
  })

  describe('requeue (the window is reopened)', () => {
    it('saves the live tabs and queues them for the new window, as a launch would', async () => {
      const { restorer, saved, live } = setup()
      live.set('p1', [
        { id: 'c', gen: 1, kind: 'claude', cwd: '/p', sessionId: 's1' },
        { id: 'sh', gen: 1, kind: 'shell', cwd: '/p' },
        { id: 'cmd', gen: 1, kind: 'command', cwd: '/p', label: 'Dev', command: 'npm run dev' }
      ])
      restorer.requeue('p1')
      // From the live tabs right now, not from whatever the debounced save last wrote.
      expect(saved).toEqual([
        {
          projectId: 'p1',
          records: [
            { id: 'c', kind: 'claude', cwd: '/p', sessionId: 's1' },
            { id: 'sh', kind: 'shell', cwd: '/p' },
            { id: 'cmd', kind: 'command', cwd: '/p', label: 'Dev', command: 'npm run dev' }
          ]
        }
      ])
      expect(restorer.hasPending('p1')).toBe(true)
      // The close kills the tabs; the new window's attach starts the plan. ('/p' does not exist
      // here, so every cwd falls back to the folder, as buildRestorePlan does.)
      live.set('p1', [])
      const started: RestoredTab[] = []
      await restorer.restore('p1', Promise.resolve(), (t) => started.push(t))
      expect(started).toEqual([
        { kind: 'claude', resumeId: 's1' },
        { kind: 'shell' },
        { kind: 'command', command: { label: 'Dev', command: 'npm run dev' } }
      ])
    })

    it('queues nothing for a window without tabs (it gets its first tab like any empty one)', () => {
      const { restorer, saved } = setup()
      restorer.requeue('p1')
      expect(restorer.hasPending('p1')).toBe(false)
      expect(saved).toEqual([{ projectId: 'p1', records: [] }])
    })

    it('leaves a plan the old window never started as it is', () => {
      const { restorer, saved } = setup()
      restorer.queue('p1', [{ kind: 'claude', resumeId: 's1' }])
      restorer.requeue('p1')
      expect(saved).toEqual([]) // the empty live list must not overwrite the saved tabs
      expect(restorer.hasPending('p1')).toBe(true)
    })

    it('tries the tabs that failed to restore again, and does not carry them twice', async () => {
      const { restorer, saved, live } = setup()
      restorer.queue('p1', [{ kind: 'claude', resumeId: 's1' }, { kind: 'shell' }])
      await restorer.restore('p1', Promise.resolve(), (tab) => {
        if (tab.kind === 'claude') throw new Error('out of ptys')
        live.set('p1', [{ id: 'sh', gen: 1, kind: 'shell', cwd: '/p' }])
      })
      restorer.requeue('p1')
      expect(saved.at(-1)!.records.map((r) => [r.kind, r.sessionId])).toEqual([
        ['shell', undefined],
        ['claude', 's1']
      ])
      live.set('p1', [])
      const started: RestoredTab[] = []
      await restorer.restore('p1', Promise.resolve(), (tab) => {
        started.push(tab)
        live.set('p1', [...(live.get('p1') ?? []), { id: `n${started.length}`, gen: 1, kind: tab.kind, cwd: '/p', sessionId: tab.resumeId }])
      })
      expect(started).toEqual([{ kind: 'shell' }, { kind: 'claude', resumeId: 's1' }])
      expect(saved.at(-1)!.records.map((r) => r.id)).toEqual(['n1', 'n2'])
    })

    it('saves nothing while quitting, but still queues', () => {
      const { restorer, saved, live } = setup()
      live.set('p1', [{ id: 'sh', gen: 1, kind: 'shell', cwd: '/p' }])
      restorer.freeze()
      restorer.requeue('p1')
      expect(saved).toEqual([])
      expect(restorer.hasPending('p1')).toBe(true)
    })
  })

  it('clear drops the record and any pending plan (the user closed the window)', async () => {
    const { restorer, saved } = setup()
    restorer.queue('p1', [{ kind: 'shell' }])
    restorer.clear('p1')
    expect(restorer.hasPending('p1')).toBe(false)
    expect(saved).toEqual([{ projectId: 'p1', records: [] }])
  })
})

describe('restore end to end with the registry and the tab manager', () => {
  it('saves tabs, survives a registry reload and brings the same tabs back', async () => {
    const registry = new ProjectRegistry({ dataDir, log: () => {} })
    const project = registry.openPath(projectDir)
    const backend = new FakePtyBackend()
    let tabs: TabManager
    const restorer = new TabRestorer({
      listTabs: (id) => tabs.list(id),
      saveTabs: (id, records) =>
        registry.update(id, (r) => {
          r.tabs = records
        }),
      projectPath: (id) => registry.get(id)?.path
    })
    const makeManager = (): TabManager =>
      new TabManager({
        backend,
        projectPath: (id) => registry.get(id)?.path,
        loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/u' }),
        hooksPath: '/data/hooks.json',
        binDir: '/data/bin',
        sock: () => undefined,
        onTabsChanged: (id) => restorer.tabsChanged(id),
        emit: () => {},
        log: () => {}
      })
    tabs = makeManager()

    const claude = tabs.create(project.id, { kind: 'claude' })
    tabs.create(project.id, { kind: 'shell', cwd: 'sub' })
    tabs.sessionStarted(claude.id, 'sess-42')
    tabs.sessionPrompted(claude.id)
    registry.flushAll()

    // "Next start": new registry over the same data dir, new manager, nothing running.
    const registry2 = new ProjectRegistry({ dataDir, log: () => {} })
    const saved = registry2.get(project.id)!
    expect(saved.tabs.map((t) => [t.kind, t.cwd, t.sessionId])).toEqual([
      ['claude', projectDir, 'sess-42'],
      ['shell', join(projectDir, 'sub'), undefined]
    ])
    tabs = makeManager()
    const before = backend.spawned.length
    restorer.queue(project.id, buildRestorePlan(saved))
    await restorer.restore(project.id, Promise.resolve(), (t) => {
      tabs.restoreTab(project.id, t)
    })
    expect(backend.spawned.slice(before).map((p) => p.argv)).toEqual([
      ['claude', '--settings', '/data/hooks.json', '--resume', 'sess-42'],
      ['/bin/zsh', '-l']
    ])
    expect(tabs.list(project.id).map((t) => t.kind)).toEqual(['claude', 'shell'])
  })

  it('a command tab survives a relaunch NOT started, keeps its saved copy, and Restart runs it', async () => {
    const registry = new ProjectRegistry({ dataDir, log: () => {} })
    const project = registry.openPath(projectDir)
    const backend = new FakePtyBackend()
    let tabs: TabManager
    const restorer = new TabRestorer({
      listTabs: (id) => tabs.list(id),
      saveTabs: (id, records) =>
        registry.update(id, (r) => {
          r.tabs = records
        }),
      projectPath: (id) => registry.get(id)?.path
    })
    const makeManager = (): TabManager =>
      new TabManager({
        backend,
        projectPath: (id) => registry.get(id)?.path,
        loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/u' }),
        hooksPath: '/data/hooks.json',
        binDir: '/data/bin',
        sock: () => undefined,
        onTabsChanged: (id) => restorer.tabsChanged(id),
        emit: () => {},
        log: () => {}
      })
    tabs = makeManager()
    tabs.createCommand(project.id, { label: 'Deploy', command: './deploy.sh --prod' })
    // The menu entry is edited afterwards: the saved tab keeps what it ran.
    registry.update(project.id, (r) => {
      r.tabCommands = [{ id: 'e', label: 'Deploy', command: './deploy.sh --staging' }]
    })
    registry.flushAll()

    const registry2 = new ProjectRegistry({ dataDir, log: () => {} })
    const saved = registry2.get(project.id)!
    expect(saved.tabs.map((t) => [t.kind, t.label, t.command])).toEqual([['command', 'Deploy', './deploy.sh --prod']])
    tabs = makeManager()
    const before = backend.spawned.length
    restorer.queue(project.id, buildRestorePlan(saved))
    await restorer.restore(project.id, Promise.resolve(), (t) => {
      tabs.restoreTab(project.id, t)
    })
    // Launch ran nothing; the tab is there, waiting, and the record still names it.
    expect(backend.spawned.length).toBe(before)
    const [waiting] = tabs.list(project.id)
    expect(waiting).toMatchObject({ kind: 'command', notStarted: true, label: 'Deploy', command: './deploy.sh --prod' })
    tabs.restart(project.id, waiting!.id)
    expect(backend.spawned.slice(before).map((p) => p.argv)).toEqual([['/bin/zsh', '-l', '-i', '-c', './deploy.sh --prod']])
  })
})

describe('missing project folders', () => {
  function recentRegistry(): { registry: ProjectRegistry; id: string; path: string } {
    const registry = new ProjectRegistry({ dataDir, log: () => {} })
    const path = join(root, 'will-vanish')
    mkdirSync(path)
    const view = registry.openPath(path)
    registry.update(view.id, (r) => {
      r.tabs = [rec({ kind: 'claude', sessionId: 's' })]
    })
    return { registry, id: view.id, path }
  }

  it('forgets a missing recent project and its record', () => {
    const { registry, id, path } = recentRegistry()
    rmSync(path, { recursive: true })
    expect(registry.get(id)?.missing).toBe(true)
    forgetMissing(registry, id)
    expect(registry.get(id)).toBeUndefined()
    expect(registry.recent()).toEqual([])
  })

  it('relinks to the chosen folder and drops the saved tabs (they ran in the old folder)', () => {
    const { registry, id, path } = recentRegistry()
    rmSync(path, { recursive: true })
    const moved = join(root, 'moved')
    mkdirSync(moved)
    const view = relinkMissing(registry, id, moved)
    expect(view).toMatchObject({ id, path: moved, missing: false, tabs: [] })
    expect(registry.get(id)).toMatchObject({ path: moved, tabs: [] })
  })

  it('refuses a project that is fine, an id that is not recent, and a target that is no folder', () => {
    const { registry, id, path } = recentRegistry()
    expect(() => forgetMissing(registry, id)).toThrow(/not missing/)
    expect(() => relinkMissing(registry, id, join(root, 'x'))).toThrow(/not missing/)
    expect(() => forgetMissing(registry, 'ffffffffffffffff')).toThrow(/not a recent project/)
    rmSync(path, { recursive: true })
    expect(() => relinkMissing(registry, id, join(root, 'no-such-dir'))).toThrow(/not a directory/)
    // The failed relink changed nothing: still missing, tabs kept for a later relink.
    expect(registry.get(id)).toMatchObject({ missing: true })
    expect(registry.get(id)?.tabs).toHaveLength(1)
  })
})
