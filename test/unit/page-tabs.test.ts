// Page tabs (design-editor.md §1 "Core: page tabs", plan Task 1): the manifest's `contributes.tabs`,
// the tab manager's page kind (open, cap, unseen dot, never typed into) and restore (persist, drop).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventChannel, IpcEventMap, TabInfo } from '../../src/shared/ipc'
import type { TabRecord } from '../../src/shared/types'
import {
  checkPageTabSpec,
  MAX_PAGE_TAB_PARAMS_BYTES,
  MAX_PAGE_TABS_PER_PLUGIN,
  PAGE_TAB_TITLE_MAX,
  pageTabTitleOf,
  type PageTabSpec
} from '../../src/shared/page-tabs'
import { validateManifest } from '../../src/main/plugins/validate'
import { buildRestorePlan, TabRestorer, tabRecordsOf, type RestoredTab } from '../../src/main/restore'
import { isPluginId, TabManager, type TabLifecycle } from '../../src/main/tabs/tab-manager'
import { SessionRegistry } from '../../src/main/sessions/session-registry'
import { closeQuestion } from '../../src/renderer/tabs/close-confirm'
import { tabLabel } from '../../src/renderer/tabs/tab-label'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

const A = 'aaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbb'

let root: string
let projA: string
let projB: string
let backend: FakePtyBackend
let events: Array<{ projectId: string; channel: EventChannel; payload: unknown }>
let selected: Record<string, string | undefined>

beforeEach(() => {
  vi.useFakeTimers()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-page-tabs-')))
  projA = join(root, 'a')
  projB = join(root, 'b')
  for (const d of [projA, projB]) mkdirSync(d, { recursive: true })
  backend = new FakePtyBackend()
  events = []
  selected = {}
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

function manager(lifecycle?: TabLifecycle, onTabsChanged?: (projectId: string) => void): TabManager {
  return new TabManager({
    backend,
    projectPath: (id) => ({ [A]: projA, [B]: projB })[id],
    loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/u' }),
    hooksPath: '/data/hooks.json',
    binDir: '/data/bin',
    sock: () => '/data/app.sock',
    lifecycle,
    onTabsChanged,
    selectedTab: (projectId) => selected[projectId],
    emit: <C extends EventChannel>(projectId: string, channel: C, payload: IpcEventMap[C]) => {
      events.push({ projectId, channel, payload })
    },
    log: () => {}
  })
}

const file = (path: string, extra: Partial<PageTabSpec> = {}): PageTabSpec => ({
  plugin: 'cockpit.editor',
  type: 'file',
  params: { path },
  title: path.split('/').pop() ?? path,
  ...extra
})

describe('manifest contributes.tabs', () => {
  let dir: string
  beforeEach(() => {
    dir = join(root, 'plugin')
    mkdirSync(join(dir, 'tabs'), { recursive: true })
    writeFileSync(join(dir, 'host.js'), '')
    writeFileSync(join(dir, 'tabs/file.html'), '<!doctype html>')
    writeFileSync(join(dir, 'tabs/file.txt'), 'x')
  })
  const manifest = (tabs: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'example.editor',
    name: 'Editor',
    version: '1.0.0',
    api: 1,
    main: 'host.js',
    contributes: { tabs },
    ...extra
  })
  const errorsOf = async (raw: unknown): Promise<string> => {
    const r = await validateManifest(raw, dir)
    if (r.ok) throw new Error('expected a validation failure')
    return r.errors.join('\n')
  }

  it('accepts a type with its page and keys (an unknown key inside an entry is ignored)', async () => {
    const r = await validateManifest(manifest([{ type: 'file', page: 'tabs/file.html', keys: ['ctrl+p', 'ctrl+s'], later: 1 }]), dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.contributes?.tabs?.[0]).toMatchObject({ type: 'file', page: 'tabs/file.html', keys: ['ctrl+p', 'ctrl+s'] })
  })

  it('refuses a bad type, a missing page, a non-html page, a page outside the folder and a bad chord', async () => {
    expect(await errorsOf(manifest([{ type: 'File', page: 'tabs/file.html' }]))).toMatch(/\/contributes\/tabs\/0\/type/)
    expect(await errorsOf(manifest([{ type: 'file' }]))).toMatch(/page/)
    expect(await errorsOf(manifest([{ type: 'file', page: 'tabs/file.txt' }]))).toMatch(/must be an \.html page/)
    expect(await errorsOf(manifest([{ type: 'file', page: '../x.html' }]))).toMatch(/must not contain "\.\." segments/)
    expect(await errorsOf(manifest([{ type: 'file', page: 'tabs/none.html' }]))).toMatch(/page tab "file" page/)
    expect(await errorsOf(manifest([{ type: 'file', page: 'tabs/file.html', keys: ['ctrl+nope+x'] }]))).toMatch(/not a valid key chord/)
    expect(await errorsOf(manifest([{ type: 'file', page: 'tabs/file.html', keys: ['Ctrl+P', 'ctrl+p'] }]))).toMatch(/duplicate key chord/)
  })

  it('refuses duplicate types, too many types, and tabs without main', async () => {
    const one = { type: 'file', page: 'tabs/file.html' }
    expect(await errorsOf(manifest([one, one]))).toMatch(/duplicate page tab type "file"/)
    const many = Array.from({ length: 11 }, (_, i) => ({ type: `t${i}`, page: 'tabs/file.html' }))
    expect(await errorsOf(manifest(many))).toMatch(/\/contributes\/tabs/)
    const noMain = manifest([one])
    delete noMain.main
    expect(await errorsOf(noMain)).toMatch(/contributes\.tabs needs "main"/)
  })
})

describe('page tab spec checks', () => {
  it('clamps the title: controls become spaces, trimmed, cut at the limit without splitting a pair', () => {
    expect(pageTabTitleOf('  a\nb\u0007 ')).toBe('a b')
    expect(pageTabTitleOf('x'.repeat(PAGE_TAB_TITLE_MAX + 20))).toHaveLength(PAGE_TAB_TITLE_MAX)
    const emoji = 'x'.repeat(PAGE_TAB_TITLE_MAX - 1) + '😀'
    expect(pageTabTitleOf(emoji)).toBe('x'.repeat(PAGE_TAB_TITLE_MAX - 1))
    expect(pageTabTitleOf('   ')).toBeUndefined()
    expect(pageTabTitleOf(5)).toBeUndefined()
  })

  it('keeps a JSON copy of params under the cap and drops a bad icon', () => {
    const params = { path: 'a.ts', toJSON: undefined, fn: () => 1 }
    const spec = checkPageTabSpec({ plugin: 'cockpit.editor', type: 'file', params, title: 'a.ts', icon: '<svg>' }, isPluginId)
    expect(spec).toEqual({ plugin: 'cockpit.editor', type: 'file', params: { path: 'a.ts' }, title: 'a.ts' })
    expect(checkPageTabSpec({ plugin: 'cockpit.editor', type: 'file', title: 'a', icon: 'ts' }, isPluginId).icon).toBe('ts')
    const big = { text: 'x'.repeat(MAX_PAGE_TAB_PARAMS_BYTES) }
    expect(() => checkPageTabSpec({ plugin: 'cockpit.editor', type: 'file', params: big, title: 'a' }, isPluginId)).toThrow(/larger than/)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => checkPageTabSpec({ plugin: 'cockpit.editor', type: 'file', params: cyclic, title: 'a' }, isPluginId)).toThrow(/plain JSON/)
    expect(() => checkPageTabSpec({ plugin: 'Bad', type: 'file', title: 'a' }, isPluginId)).toThrow(/plugin/)
    expect(() => checkPageTabSpec({ plugin: 'cockpit.editor', type: 'File', title: 'a' }, isPluginId)).toThrow(/type/)
  })
})

describe('TabManager page tabs', () => {
  it('opens a page tab with no process, in the project folder, saved through onTabsChanged', () => {
    const changed: string[] = []
    const tabs = manager(undefined, (id) => changed.push(id))
    const tab = tabs.createPage(A, file('src/a.ts', { icon: 'ts' }))
    expect(tab).toEqual({
      id: tab.id,
      kind: 'page',
      cwd: projA,
      gen: 1,
      page: { plugin: 'cockpit.editor', type: 'file', params: { path: 'src/a.ts' }, title: 'a.ts', icon: 'ts' }
    })
    expect(backend.spawned).toHaveLength(0)
    expect(changed).toEqual([A])
    expect(tabs.list(A).map((t) => t.id)).toEqual([tab.id])
    expect(tabs.list(B)).toEqual([])
  })

  it('refuses an unknown project and a bad spec, and clamps the title', () => {
    const tabs = manager()
    expect(() => tabs.createPage('cccccccccccccccc', file('a'))).toThrow(/unknown project/)
    expect(() => tabs.createPage(A, { ...file('a'), title: '' })).toThrow(/title/)
    expect(tabs.createPage(A, { ...file('a'), title: 'y'.repeat(300) }).page?.title).toHaveLength(PAGE_TAB_TITLE_MAX)
  })

  it('closes, reorders and flags like any tab', () => {
    const lifecycle = { closed: vi.fn(), started: vi.fn(), flagged: vi.fn() }
    const tabs = manager(lifecycle)
    const shell = tabs.create(A, { kind: 'shell' })
    const page = tabs.createPage(A, file('a'))
    tabs.reorder(A, page.id, 0)
    expect(tabs.list(A).map((t) => t.id)).toEqual([page.id, shell.id])
    expect(tabs.setFlag(A, page.id, { color: 'orange' })).toEqual({ color: 'orange' })
    expect(tabs.list(A)[0]?.flag).toEqual({ color: 'orange' })
    expect(() => tabs.close(B, page.id)).toThrow(/unknown tab/)
    tabs.close(A, page.id)
    expect(lifecycle.closed).toHaveBeenCalledWith(page.id)
    expect(tabs.list(A).map((t) => t.id)).toEqual([shell.id])
    // `started` is for processes: only the shell had one.
    expect(lifecycle.started).toHaveBeenCalledTimes(1)
  })

  it('is never typed into: no pty write, no typedBy, no size, no restart, no rename, no token', () => {
    const tabs = manager()
    const page = tabs.createPage(A, file('a'))
    expect(tabs.viewInput(A, page.id, 'hello\r', 'desktop')).toBe('')
    tabs.input(A, page.id, 'pasted\r')
    tabs.resize(A, page.id, 100, 30, 'desktop')
    expect(tabs.fit(A, page.id, 'desktop')).toBe(false)
    expect(tabs.list(A)[0]?.typedBy).toBeUndefined()
    expect(events.filter((e) => e.channel === 'tabs.typed')).toEqual([])
    expect(backend.spawned).toHaveLength(0)
    expect(() => tabs.restart(A, page.id)).toThrow(/no process/)
    expect(() => tabs.rename(A, page.id, 'x')).toThrow(/only a Claude tab/)
    // Its token is '' (none): no 64-hex token resolves to it.
    expect(tabs.resolveToken('0'.repeat(64))).toBeUndefined()
    // screen and ack are ignored too: no answer, no pty ack.
    const answer = vi.fn()
    tabs.screen(A, page.id, answer as never)
    tabs.ack(A, page.id, 10)
    expect(answer).not.toHaveBeenCalled()
  })

  it('never reaches the send gate or Claude status: the session registry has no entry for it', () => {
    const registry = new SessionRegistry({ projectName: () => 'a', broadcast: () => {}, write: () => {}, log: () => {} })
    const tabs = manager({
      started: (t) => registry.tabStarted(t),
      closed: (id) => registry.tabClosed(id)
    })
    const page = tabs.createPage(A, file('a'))
    expect(registry.get(page.id)).toBeUndefined()
    expect(registry.list()).toEqual([])
  })

  it('caps page tabs per plugin per project', () => {
    const tabs = manager()
    for (let i = 0; i < MAX_PAGE_TABS_PER_PLUGIN; i++) tabs.createPage(A, file(`f${i}`))
    expect(() => tabs.createPage(A, file('one-more'))).toThrow(/at most/)
    // Another plugin, and another project, have their own count.
    expect(tabs.createPage(A, { ...file('x'), plugin: 'example.other' }).kind).toBe('page')
    expect(tabs.createPage(B, file('x')).kind).toBe('page')
  })

  describe('unseen dot', () => {
    it('marks a tab opened while another tab is selected, until a view shows it', () => {
      const tabs = manager()
      const shell = tabs.create(A, { kind: 'shell' })
      selected[A] = shell.id
      const page = tabs.createPage(A, file('a'))
      expect(page.unseen).toBe(true)
      expect(tabs.list(A).find((t) => t.id === page.id)?.unseen).toBe(true)
      expect(tabs.markSeen(A, page.id)).toMatchObject({ id: page.id })
      expect(tabs.list(A).find((t) => t.id === page.id)?.unseen).toBeUndefined()
      // Seen once is seen: nothing more to tell.
      expect(tabs.markSeen(A, page.id)).toBeUndefined()
    })

    it('is not set when nothing was selected, and is never a flag', () => {
      const tabs = manager()
      const page = tabs.createPage(A, file('a'))
      expect(page.unseen).toBeUndefined()
      selected[A] = 'x'
      const later = tabs.createPage(A, file('b'))
      expect(later.unseen).toBe(true)
      expect(later.flag).toBeUndefined()
    })

    it('is cleared only by a view of its own project', () => {
      const tabs = manager()
      selected[A] = 'x'
      const page = tabs.createPage(A, file('a'))
      expect(tabs.markSeen(B, page.id)).toBeUndefined()
      expect(tabs.list(A)[0]?.unseen).toBe(true)
    })

    it('is not saved', () => {
      const tabs = manager()
      selected[A] = 'x'
      tabs.createPage(A, file('a'))
      expect(tabRecordsOf(tabs.list(A))[0]).not.toHaveProperty('unseen')
    })

    it('comes back on markUnseen unless the project shows the tab or it has the dot', () => {
      const tabs = manager()
      const shell = tabs.create(A, { kind: 'shell' })
      const page = tabs.createPage(A, file('a'))
      // Shown: nothing to mark (the person sees the tab already).
      selected[A] = page.id
      expect(tabs.markUnseen(A, page.id)).toBeUndefined()
      expect(tabs.list(A).find((t) => t.id === page.id)?.unseen).toBeUndefined()
      // Another tab shown: the dot again, once.
      selected[A] = shell.id
      expect(tabs.markUnseen(A, page.id)).toMatchObject({ id: page.id, unseen: true })
      expect(tabs.markUnseen(A, page.id)).toBeUndefined()
      expect(tabs.markSeen(A, page.id)).toMatchObject({ id: page.id })
      // Only a page tab, only of its own project, and never with nothing selected.
      expect(tabs.markUnseen(A, shell.id)).toBeUndefined()
      expect(tabs.markUnseen(B, page.id)).toBeUndefined()
      delete selected[A]
      expect(tabs.markUnseen(A, page.id)).toBeUndefined()
      expect(tabs.list(A).find((t) => t.id === page.id)?.unseen).toBeUndefined()
    })
  })
})

describe('page tab restore', () => {
  const pageRec = (n: number, extra: Partial<TabRecord> = {}): TabRecord => ({
    id: `tab-${n}`,
    kind: 'page',
    cwd: projA,
    plugin: 'cockpit.editor',
    type: 'file',
    params: { path: `f${n}.ts` },
    title: `f${n}.ts`,
    ...extra
  })

  it('saves a page tab flat in its record and plans it back', () => {
    const tabs = manager()
    const page = tabs.createPage(A, file('src/a.ts', { icon: 'ts' }))
    tabs.setFlag(A, page.id, { color: 'orange' })
    const records = tabRecordsOf(tabs.list(A))
    expect(records).toEqual([
      { id: page.id, kind: 'page', cwd: projA, plugin: 'cockpit.editor', type: 'file', params: { path: 'src/a.ts' }, title: 'a.ts', icon: 'ts', flag: { color: 'orange' } }
    ])
    expect(buildRestorePlan({ path: projA, tabs: records })).toEqual<RestoredTab[]>([
      { kind: 'page', page: { plugin: 'cockpit.editor', type: 'file', params: { path: 'src/a.ts' }, title: 'a.ts', icon: 'ts' }, flag: { color: 'orange' } }
    ])
  })

  it('drops a damaged record: bad plugin, type, title, oversized params, or session and command fields', () => {
    const bad: TabRecord[] = [
      pageRec(1, { plugin: 'Nope' }),
      pageRec(2, { type: 'File' }),
      pageRec(3, { title: '' }),
      pageRec(4, { params: { x: 'y'.repeat(MAX_PAGE_TAB_PARAMS_BYTES) } }),
      pageRec(5, { sessionId: 'sess-1' }),
      pageRec(6, { command: 'rm -rf /' }),
      pageRec(7, { argv: ['x'], openedBy: 'cockpit.editor' })
    ]
    expect(buildRestorePlan({ path: projA, tabs: bad })).toEqual([])
    // A bad icon only loses the icon.
    expect(buildRestorePlan({ path: projA, tabs: [pageRec(8, { icon: '<b>' })] })[0]?.page).not.toHaveProperty('icon')
  })

  it('drops a page tab whose plugin is gone or revoked, and past the per-plugin cap', () => {
    const records = Array.from({ length: MAX_PAGE_TABS_PER_PLUGIN + 3 }, (_, i) => pageRec(i))
    records.push(pageRec(999, { plugin: 'example.gone' }))
    const plan = buildRestorePlan({ path: projA, tabs: records }, (id) => id !== 'example.gone')
    expect(plan).toHaveLength(MAX_PAGE_TABS_PER_PLUGIN)
    expect(plan.every((t) => t.page?.plugin === 'cockpit.editor')).toBe(true)
  })

  it('asks before putting a page tab back: a plugin off in the project or without the type is dropped for good', async () => {
    const tabs = manager()
    const saved: TabRecord[][] = []
    const logs: string[] = []
    const asked: string[] = []
    const restorer = new TabRestorer({
      listTabs: (id) => tabs.list(id),
      saveTabs: (_id, r) => saved.push(r),
      projectPath: (id) => (id === A ? projA : undefined),
      pageTabAvailable: (projectId, pluginId, type) => {
        asked.push(`${projectId}/${pluginId}/${type}`)
        return pluginId === 'cockpit.editor' && type === 'file'
      },
      log: (m) => logs.push(m)
    })
    const plan = buildRestorePlan({ path: projA, tabs: [pageRec(1), pageRec(2, { type: 'diff' }), pageRec(3, { plugin: 'example.off' })] })
    restorer.queue(A, plan)
    await restorer.restore(A, Promise.resolve(), (tab) => {
      tabs.restoreTab(A, tab)
    })
    expect(asked).toEqual([`${A}/cockpit.editor/file`, `${A}/cockpit.editor/diff`, `${A}/example.off/file`])
    const back = tabs.list(A)
    expect(back).toHaveLength(1)
    expect(back[0]).toMatchObject({ kind: 'page', gen: 1, page: { type: 'file', params: { path: 'f1.ts' } } })
    // Restored tabs are not unseen (the person had them open), and the dropped ones leave the record.
    expect(back[0]?.unseen).toBeUndefined()
    expect(saved.at(-1)?.map((r) => r.type)).toEqual(['file'])
    expect(logs.join('\n')).toMatch(/not restoring a page tab/)
  })

  it('keeps a page tab that failed to restore in the record, for the next launch', async () => {
    const saved: TabRecord[][] = []
    const restorer = new TabRestorer({ listTabs: () => [], saveTabs: (_id, r) => saved.push(r), projectPath: () => projA, log: () => {} })
    restorer.queue(A, buildRestorePlan({ path: projA, tabs: [pageRec(1)] }))
    await restorer.restore(A, Promise.resolve(), () => {
      throw new Error('cap')
    })
    expect(saved.at(-1)).toEqual([
      { id: expect.any(String), kind: 'page', cwd: projA, plugin: 'cockpit.editor', type: 'file', params: { path: 'f1.ts' }, title: 'f1.ts' }
    ])
  })

  it('restoreTab re-checks the spec and refuses session or command fields on a page tab', () => {
    const tabs = manager()
    expect(() => tabs.restoreTab(A, { kind: 'page' })).toThrow(/needs its plugin/)
    expect(() => tabs.restoreTab(A, { kind: 'page', page: file('a'), resumeId: 's' })).toThrow(/no session/)
    expect(() => tabs.restoreTab(A, { kind: 'shell', page: file('a') })).toThrow(/only a page tab/)
    expect(() => tabs.restoreTab(A, { kind: 'page', page: { ...file('a'), title: '\n' } })).toThrow(/title/)
    const t: TabInfo = tabs.restoreTab(A, { kind: 'page', page: file('a'), flag: { color: 'orange' } })
    expect(t).toMatchObject({ kind: 'page', flag: { color: 'orange' } })
    expect(backend.spawned).toHaveLength(0)
  })
})

describe('renderer: a page tab in the strip', () => {
  it('is labelled by its title and never asks "still running" on close', () => {
    const tab: TabInfo = { id: 't', kind: 'page', cwd: projA, gen: 1, page: file('src/a.ts') }
    expect(tabLabel(tab)).toBe('a.ts')
    expect(closeQuestion(tab, undefined, true)).toBeNull()
  })
})
