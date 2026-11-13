// Dirty per view and core's close ask for page tabs (design-editor.md §1 "Dirty and close", plan
// Task 3): main keeps dirty per (tab, view) from each page's report (TabManager.setPageDirty), clears
// it when a view goes or unmounts its frame, and tells every view the tab's dirty-in-any-view; the
// renderer asks before a person's or a plugin's close of a dirty page tab; a window close and a quit
// ask in main (unsaved-dialog.ts, window-manager.test.ts covers the window). The page only reports.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventChannel, IpcEventMap, TabInfo } from '../../src/shared/ipc'
import type { PageTabSpec } from '../../src/shared/page-tabs'
import { TabManager } from '../../src/main/tabs/tab-manager'
import { closeWillAsk } from '../../src/main/sessions/close-asks'
import { QueuedUnsavedAsk, QuitGuard, unsavedDialogOptions, unsavedList } from '../../src/main/windows/unsaved-dialog'
import { closeAnswer, closeMayAsk, closeQuestion, closeQuestionText } from '../../src/renderer/tabs/close-confirm'
import { unsavedText } from '../../src/renderer/web/close-project-text'
import { PanelClient, TAB_DIRTY_MESSAGE, TAB_MESSAGE, type ThemeRoot } from '../../src/sdk/panel-core'
import { FakePtyBackend } from '../fakes/fake-pty-backend'
import { entry, pool, settle, TAB_A, TAB_B, TAB_C } from '../fakes/fake-page-frames'

const A = 'aaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbb'

let root: string
let events: Array<{ projectId: string; channel: EventChannel; payload: unknown }>

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-page-close-')))
  for (const d of ['a', 'b']) mkdirSync(join(root, d))
  events = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function manager(): TabManager {
  return new TabManager({
    backend: new FakePtyBackend(),
    projectPath: (id) => ({ [A]: join(root, 'a'), [B]: join(root, 'b') })[id],
    loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: '/home/u' }),
    hooksPath: '/data/hooks.json',
    binDir: '/data/bin',
    sock: () => '/data/app.sock',
    emit: <C extends EventChannel>(projectId: string, channel: C, payload: IpcEventMap[C]) => {
      events.push({ projectId, channel, payload })
    },
    log: () => {}
  })
}

const file = (path: string): PageTabSpec => ({ plugin: 'cockpit.editor', type: 'file', params: { path }, title: path })

/** The `tabs.added` events since the last call, as [tab id, dirty]. */
function told(): Array<[string, boolean]> {
  const out = events.filter((e) => e.channel === 'tabs.added').map((e) => [(e.payload as TabInfo).id, (e.payload as TabInfo).dirty === true] as [string, boolean])
  events = []
  return out
}

describe('TabManager: dirty per (tab, view)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('a tab is dirty while any view says so; each change of that is told to the project', () => {
    const tabs = manager()
    const t = tabs.createPage(A, file('a.ts'))
    events = []
    tabs.setPageDirty(A, t.id, 'desktop:1', true)
    expect(told()).toEqual([[t.id, true]])
    expect(tabs.list(A).find((x) => x.id === t.id)?.dirty).toBe(true)
    // A second view dirty too: no change, nothing told.
    tabs.setPageDirty(A, t.id, 'web:3', true)
    tabs.setPageDirty(A, t.id, 'desktop:1', true)
    expect(told()).toEqual([])
    // The desktop saved, the browser still holds changes: still dirty.
    tabs.setPageDirty(A, t.id, 'desktop:1', false)
    expect(told()).toEqual([])
    expect(tabs.unsavedTitles(A)).toEqual(['a.ts'])
    tabs.setPageDirty(A, t.id, 'web:3', false)
    expect(told()).toEqual([[t.id, false]])
    expect(tabs.list(A).find((x) => x.id === t.id)?.dirty).toBeUndefined()
    expect(tabs.unsavedTitles(A)).toEqual([])
  })

  it('ignores anything but a page tab of that project', () => {
    const tabs = manager()
    const shell = tabs.create(A, { kind: 'shell' })
    const page = tabs.createPage(A, file('a.ts'))
    events = []
    tabs.setPageDirty(A, shell.id, 'desktop:1', true)
    tabs.setPageDirty(B, page.id, 'desktop:1', true)
    tabs.setPageDirty(A, 'no-such-tab', 'desktop:1', true)
    expect(told()).toEqual([])
    expect(tabs.list(A).some((x) => x.dirty)).toBe(false)
    expect(tabs.unsavedTitles(B)).toEqual([])
  })

  it("a view that goes (or whose page reloads) takes its dirty with it; the others' stays", () => {
    const tabs = manager()
    const one = tabs.createPage(A, file('one.ts'))
    const two = tabs.createPage(A, file('two.ts'))
    tabs.setPageDirty(A, one.id, 'web:3', true)
    tabs.setPageDirty(A, two.id, 'web:3', true)
    tabs.setPageDirty(A, two.id, 'desktop:1', true)
    events = []
    tabs.viewGone('web:3')
    expect(told()).toEqual([[one.id, false]])
    expect(tabs.unsavedTitles(A)).toEqual(['two.ts'])
    tabs.clearViewDirty('desktop:1')
    expect(told()).toEqual([[two.id, false]])
    expect(tabs.unsavedTitles(A)).toEqual([])
  })

  it('a closed tab is no longer unsaved anywhere', () => {
    const tabs = manager()
    const t = tabs.createPage(A, file('a.ts'))
    tabs.setPageDirty(A, t.id, 'desktop:1', true)
    tabs.close(A, t.id)
    expect(tabs.unsavedTitles(A)).toEqual([])
  })
})

describe('the close ask for a page tab', () => {
  const page = (dirty: boolean): TabInfo => ({
    id: 't1',
    kind: 'page',
    cwd: '/p',
    gen: 1,
    page: { plugin: 'cockpit.editor', type: 'file', title: 'a.ts' },
    ...(dirty ? { dirty: true as const } : {})
  })

  it('asks for a dirty page tab whatever the setting, and never for a clean one', () => {
    expect(closeMayAsk(page(false))).toBe(false)
    expect(closeMayAsk(page(true))).toBe(true)
    expect(closeQuestion(page(false), undefined, true)).toBeNull()
    const q = closeQuestion(page(true), undefined, false)
    expect(q).toEqual({ tabId: 't1', title: 'a.ts', unsaved: true })
    expect(closeQuestionText(q!)).toMatch(/unsaved changes/)
    // Close discards; the setting is not touched by this ask (the dialog has no "Don't ask again").
    expect(closeAnswer('close', false)).toEqual({ close: true, stopAsking: false })
  })

  it("a running tab still asks only with the setting on", () => {
    const shell: TabInfo = { id: 's', kind: 'shell', cwd: '/p', gen: 1 }
    expect(closeQuestion(shell, undefined, false)).toBeNull()
    expect(closeQuestion(shell, undefined, true)?.unsaved).toBeUndefined()
  })

  it("main raises the window for a plugin's close only when the page tab is dirty", () => {
    expect(closeWillAsk({ kind: 'page' }, true)).toBe(false)
    expect(closeWillAsk({ kind: 'page', dirty: true }, false)).toBe(true)
    expect(closeWillAsk({ kind: 'shell' }, true)).toBe(true)
    expect(closeWillAsk({ kind: 'shell', exit: { code: 0 } }, true)).toBe(false)
  })
})

describe('the window close and quit box', () => {
  it('names at most five tabs, Cancel the default', () => {
    expect(unsavedList(['a', 'b'])).toBe('• a\n• b')
    expect(unsavedList(['1', '2', '3', '4', '5', '6', '7'])).toBe('• 1\n• 2\n• 3\n• 4\n• 5\nand 2 more')
    const quit = unsavedDialogOptions('quit', ['a.ts'])
    expect(quit.buttons).toEqual(['Discard and Quit', 'Cancel'])
    expect(quit.defaultId).toBe(1)
    expect(quit.cancelId).toBe(1)
    expect(unsavedDialogOptions('window', ['a', 'b']).message).toBe('2 tabs have unsaved changes.')
  })

  it("a test run's box: Cancel for a window and Discard for a quit unless answers are queued", async () => {
    const q = new QueuedUnsavedAsk()
    await expect(q.ask(1, ['a'], 'window')).resolves.toBe(false)
    await expect(q.ask(undefined, ['a'], 'quit')).resolves.toBe(true)
    q.answer(true)
    await expect(q.ask(1, ['b'], 'window')).resolves.toBe(true)
    expect(q.asks().map((a) => a.kind)).toEqual(['window', 'quit', 'window'])
  })

  it('server mode names the unsaved tabs in its Close project ask', () => {
    expect(unsavedText(['a.ts'])).toBe('Unsaved changes in a.ts are lost.')
    expect(unsavedText(['a', 'b'])).toBe('Unsaved changes in a and b are lost.')
    expect(unsavedText(['a', 'b', 'c', 'd', 'e'])).toBe('Unsaved changes in a, b, c and 2 more are lost.')
  })
})

describe('QuitGuard: a quit with unsaved page tabs', () => {
  function guard(titles: string[]) {
    const asks: Array<{ windowId: number | undefined; titles: readonly string[]; answer(discard: boolean): void }> = []
    let quits = 0
    const g = new QuitGuard({
      unsaved: () => titles,
      windowId: () => 4,
      ask: (windowId, t, kind) =>
        new Promise<boolean>((resolve) => {
          expect(kind).toBe('quit')
          asks.push({ windowId, titles: t, answer: resolve })
        }),
      quit: () => quits++
    })
    return { g, asks, quits: () => quits }
  }

  it('nothing unsaved: the quit goes through', () => {
    const t = guard([])
    expect(t.g.beforeQuit()).toBe(false)
    expect(t.asks).toHaveLength(0)
  })

  it('stops the quit and asks once; Cancel leaves the app, Discard quits again and lets that through', async () => {
    const t = guard(['a.ts'])
    expect(t.g.beforeQuit()).toBe(true)
    expect(t.g.beforeQuit()).toBe(true)
    expect(t.asks).toHaveLength(1)
    expect(t.asks[0]!.windowId).toBe(4)
    t.asks[0]!.answer(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(t.quits()).toBe(0)
    expect(t.g.beforeQuit()).toBe(true)
    t.asks[1]!.answer(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(t.quits()).toBe(1)
    expect(t.g.beforeQuit()).toBe(false)
  })
})

describe('the page reports, the pool keeps', () => {
  const root = (): ThemeRoot => ({ setProperty: () => {}, removeProperty: () => undefined, colorScheme: '' })

  it('SDK: ccPanel.tab.setDirty sends a change only, and takes booleans only', () => {
    const sent: unknown[] = []
    const c = new PanelClient(root(), () => {}, undefined, undefined, (m) => sent.push(m))
    c.receive({ type: TAB_MESSAGE, tab: { type: 'file' } }, [])
    c.api.tab!.setDirty(true)
    c.api.tab!.setDirty(true)
    c.api.tab!.setDirty(false)
    expect(sent).toEqual([
      { type: TAB_DIRTY_MESSAGE, dirty: true },
      { type: TAB_DIRTY_MESSAGE, dirty: false }
    ])
    expect(() => c.api.tab!.setDirty('yes' as unknown as boolean)).toThrow(TypeError)
  })

  it('reports to main per change, never unmounts a dirty frame for the LRU, and forgets it at unmount', async () => {
    const reports: Array<[string, boolean]> = []
    const t = pool({ maxLive: 1, reportDirty: (tabId, dirty) => reports.push([tabId, dirty]) })
    t.frames.sync([entry(TAB_A), entry(TAB_B), entry(TAB_C)])
    t.frames.show(TAB_A)
    await settle()
    t.el(TAB_A).fromPage({ type: TAB_DIRTY_MESSAGE, dirty: true })
    t.el(TAB_A).fromPage({ type: TAB_DIRTY_MESSAGE, dirty: true })
    t.el(TAB_A).fromPage({ type: TAB_DIRTY_MESSAGE, dirty: 'no' })
    expect(reports).toEqual([[TAB_A, true]])
    expect(t.frames.isDirty(TAB_A)).toBe(true)
    // Past the cap of 1: the clean B goes when C shows, the dirty A stays.
    t.frames.show(TAB_B)
    await settle()
    t.frames.show(TAB_C)
    await settle()
    expect(t.frames.isLive(TAB_A)).toBe(true)
    expect(t.frames.isLive(TAB_B)).toBe(false)
    // Saved: A is clean and past the cap now, so it goes.
    t.el(TAB_A).fromPage({ type: TAB_DIRTY_MESSAGE, dirty: false })
    expect(reports.at(-1)).toEqual([TAB_A, false])
    expect(t.frames.isLive(TAB_A)).toBe(false)
  })

  it('a closed dirty tab unmounts (main clears at the disconnect) and is no longer dirty here', async () => {
    const t = pool()
    t.frames.sync([entry(TAB_A)])
    t.frames.show(TAB_A)
    await settle()
    t.el(TAB_A).fromPage({ type: TAB_DIRTY_MESSAGE, dirty: true })
    t.frames.sync([])
    expect(t.disconnects).toEqual([TAB_A])
    expect(t.frames.isDirty(TAB_A)).toBe(false)
  })

  it('a remounted frame (a page that navigated itself) is a clean page: dirty clears, and the LRU may trim it', async () => {
    const reports: Array<[string, boolean]> = []
    const t = pool({ guard: true, maxLive: 1, reportDirty: (tabId, dirty) => reports.push([tabId, dirty]) })
    t.frames.sync([entry(TAB_A), entry(TAB_B)])
    t.frames.show(TAB_A)
    await settle()
    t.el(TAB_A).fire()
    t.el(TAB_A).fromPage({ type: TAB_DIRTY_MESSAGE, dirty: true })
    t.frames.show(TAB_B)
    await settle()
    expect(t.frames.isLive(TAB_A)).toBe(true)
    // A load the shell did not start: a fresh element, whose page has nothing unsaved.
    const old = t.el(TAB_A)
    old.fire()
    expect(t.elements.filter((e) => e.title === old.title)).toHaveLength(2)
    expect(t.frames.isDirty(TAB_A)).toBe(false)
    expect(reports.at(-1)).toEqual([TAB_A, false])
  })

  it('a web reconnect says the dirty tabs again (main dropped the old view); a host restart does not', async () => {
    const reports: Array<[string, boolean]> = []
    const t = pool({ reportDirty: (tabId, dirty) => reports.push([tabId, dirty]) })
    t.frames.sync([entry(TAB_A), entry(TAB_B)])
    t.frames.show(TAB_A)
    await settle()
    t.frames.show(TAB_B)
    await settle()
    t.el(TAB_A).fromPage({ type: TAB_DIRTY_MESSAGE, dirty: true })
    reports.length = 0
    t.frames.reconnect(['a.one'])
    expect(reports).toEqual([])
    t.frames.reconnect()
    expect(reports).toEqual([[TAB_A, true]])
  })

  it("a replaced frame element's messages count for nothing", async () => {
    const reports: Array<[string, boolean]> = []
    const t = pool({ reportDirty: (tabId, dirty) => reports.push([tabId, dirty]) })
    t.frames.sync([entry(TAB_A)])
    t.frames.show(TAB_A)
    await settle()
    const old = t.el(TAB_A)
    t.frames.sync([])
    old.fromPage({ type: TAB_DIRTY_MESSAGE, dirty: true })
    expect(reports).toEqual([])
  })
})
