// Plan Task 4: Ask Claude from a page tab (design-editor.md §4), main's side (page-tab-discuss.ts):
// the tab and target checks, the plugin's context asked in the caller's view, the text composed and
// sent through the REAL send gate as the person's own (`core`), so a Claude tab the person typed in
// takes it (a plugin's own sessions.send is refused there), the target re-checked after the ask.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { composeDiscuss } from '../../src/main/overlays/discuss'
import type { DiscussSessions } from '../../src/main/overlays/overlay-manager'
import { SessionRegistry } from '../../src/main/sessions/session-registry'
import { PageTabDiscuss, discussQuestionOf, type DiscussPageTab } from '../../src/main/tabs/page-tab-discuss'
import { TabManager } from '../../src/main/tabs/tab-manager'
import { DISCUSS_ASK_MS, MAX_DISCUSS_QUESTION } from '../../src/shared/discuss'
import { FakePtyBackend } from '../fakes/fake-pty-backend'
import { entry, pool, settle, TAB_A, TAB_B } from '../fakes/fake-page-frames'
import { PanelClient, TAB_DISCUSS_MESSAGE, TAB_MESSAGE, type ThemeRoot } from '../../src/sdk/panel-core'

const A = 'aaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbb'
const WIN_A = 1
const DESKTOP = 'desktop:1'
const WEB = 'web:4'

let root: string
let backend: FakePtyBackend
let registry: SessionRegistry
let tabs: TabManager
let selected: Array<{ windowId: number; tabId: string }>
let asked: Array<{ projectId: string; tab: DiscussPageTab; view: string | undefined }>
let context: () => Promise<unknown>

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-discuss-page-')))
  for (const d of ['a', 'b']) mkdirSync(join(root, d))
  backend = new FakePtyBackend()
  selected = []
  asked = []
  context = async () => ({ text: 'src/x.ts:40-52\n```ts\nconst x = 1\n```' })
  registry = new SessionRegistry({
    projectName: () => 'p',
    broadcast: () => {},
    write: ({ tabId, projectId }, data) => tabs.input(projectId, tabId, data),
    log: () => {}
  })
  tabs = new TabManager({
    backend,
    projectPath: (id) => ({ [A]: join(root, 'a'), [B]: join(root, 'b') })[id],
    loginEnv: () => ({ PATH: '/usr/bin', SHELL: '/bin/sh', HOME: root }),
    hooksPath: '/data/hooks.json',
    binDir: '/data/bin',
    sock: () => '/data/app.sock',
    lifecycle: {
      started: (tab) => registry.tabStarted(tab),
      exited: (tabId, code) => registry.tabExited(tabId, code),
      closed: (tabId) => registry.tabClosed(tabId)
    },
    emit: () => {},
    log: () => {}
  })
})

afterEach(() => {
  tabs.disposeAll()
  registry.dispose()
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

/** Window 1 shows project A; the sessions as index.ts builds them for overlay Discuss and this. */
function discuss(opened: string[] = []): PageTabDiscuss {
  const sessions: DiscussSessions = {
    isClaudeTab: (windowId, tabId) => {
      const entry = registry.get(tabId)
      return windowId === WIN_A && entry?.projectId === A && entry.status !== 'ended'
    },
    notReady: (tabId) => registry.get(tabId)?.status === 'idle',
    send: (tabId, text, origin) => registry.send(tabId, text, origin),
    openSession: async (_windowId, prompt) => {
      opened.push(prompt)
      return { tabId: tabs.create(A, { kind: 'claude' }).id }
    },
    selectTab: (windowId, tabId) => void selected.push({ windowId, tabId }),
    prompt: () => undefined
  }
  return new PageTabDiscuss({
    pageTab: (projectId, tabId) => {
      const t = tabs.list(projectId).find((x) => x.id === tabId && x.kind === 'page')
      if (!t?.page) return undefined
      return { id: t.id, pluginId: t.page.plugin, type: t.page.type, title: t.page.title, ...(t.page.params !== undefined ? { params: t.page.params } : {}) }
    },
    askContext: (projectId, tab, view) => {
      asked.push({ projectId, tab, view })
      return context()
    },
    sessions,
    pluginTitle: (id) => (id === 'p.editor' ? 'Editor' : id),
    log: () => {}
  })
}

function waitingTab(projectId = A): string {
  const tab = tabs.create(projectId, { kind: 'claude' })
  registry.applyHook(tab.id, 'SessionStart', { session_id: 's' })
  registry.applyHook(tab.id, 'Stop', {})
  return tab.id
}

const ptyOf = (tabId: string) => {
  const pty = backend.spawned.find((p) => p.options.env.APP_TAB_ID === tabId)
  if (!pty) throw new Error('no pty')
  return pty
}

const fileTab = (projectId = A): string =>
  tabs.createPage(projectId, { plugin: 'p.editor', type: 'file', params: { path: 'src/x.ts' }, title: 'x.ts' }).id

const caller = (viewId = DESKTOP) => ({ windowId: WIN_A, projectId: A, viewId })

describe('PageTabDiscuss', () => {
  it('asks the plugin in the caller view, composes About:, context and question, sends as the person', async () => {
    const page = fileTab()
    const claude = waitingTab()
    const answer = await discuss().discuss(caller(WEB), page, 'Why is x 1?', { kind: 'tab', tabId: claude })
    expect(answer).toEqual({ ok: true, tabId: claude, queued: false })
    expect(asked).toEqual([{ projectId: A, tab: { id: page, pluginId: 'p.editor', type: 'file', title: 'x.ts', params: { path: 'src/x.ts' } }, view: WEB }])
    const text = composeDiscuss({
      title: 'x.ts',
      type: { name: 'file', data: { path: 'src/x.ts' } },
      context: 'src/x.ts:40-52\n```ts\nconst x = 1\n```',
      question: 'Why is x 1?'
    })
    expect(text.startsWith('About: x.ts\nFile: src/x.ts\n\nsrc/x.ts:40-52')).toBe(true)
    expect(text.endsWith('```\n\nWhy is x 1?')).toBe(true)
    expect(ptyOf(claude).writes.join('')).toContain('Why is x 1?')
    expect(selected).toEqual([{ windowId: WIN_A, tabId: claude }])
  })

  it('the desktop view is asked as no view', async () => {
    const page = fileTab()
    await discuss().discuss(caller(DESKTOP), page, '', { kind: 'tab', tabId: waitingTab() })
    expect(asked[0]?.view).toBeUndefined()
  })

  it('a Claude tab the person typed in takes the text (person-origin), where a plugin send is refused', async () => {
    const page = fileTab()
    const claude = waitingTab()
    registry.userInput(A, claude, 'h')
    expect(registry.get(claude)?.typed).toBe(true)
    expect(() => registry.send(claude, 'from a plugin', 'plugin')).toThrow(/typing/)
    const answer = await discuss().discuss(caller(), page, 'explain', { kind: 'tab', tabId: claude })
    expect(answer).toEqual({ ok: true, tabId: claude, queued: false })
    expect(ptyOf(claude).writes.join('')).toContain('explain')
  })

  it('a busy tab queues it, sent at its Stop', async () => {
    const page = fileTab()
    const claude = waitingTab()
    registry.applyHook(claude, 'UserPromptSubmit', { prompt: 'p' })
    await expect(discuss().discuss(caller(), page, 'q', { kind: 'tab', tabId: claude })).resolves.toEqual({ ok: true, tabId: claude, queued: true })
  })

  it('re-checks the target after the ask: a tab that ended meanwhile gets nothing', async () => {
    const page = fileTab()
    const claude = waitingTab()
    context = async () => {
      tabs.close(A, claude)
      return null
    }
    await expect(discuss().discuss(caller(), page, 'q', { kind: 'tab', tabId: claude })).resolves.toEqual({
      ok: false,
      error: 'That Claude tab is gone; pick another'
    })
    expect(selected).toEqual([])
  })

  it('refuses a target of another window or project, an idle one, and a tab that is no page tab here', async () => {
    const page = fileTab()
    const other = waitingTab(B)
    const shell = tabs.create(A, { kind: 'shell' }).id
    const d = discuss()
    await expect(d.discuss(caller(), page, 'q', { kind: 'tab', tabId: other })).resolves.toMatchObject({ ok: false, error: /gone/ })
    await expect(d.discuss(caller(), page, 'q', { kind: 'tab', tabId: shell })).resolves.toMatchObject({ ok: false, error: /gone/ })
    const idle = tabs.create(A, { kind: 'claude' }).id
    registry.applyHook(idle, 'SessionStart', { session_id: 's', source: 'compact' })
    expect(registry.get(idle)?.status).toBe('idle')
    await expect(d.discuss(caller(), page, 'q', { kind: 'tab', tabId: idle })).resolves.toMatchObject({ ok: false, error: /idle/ })
    const claude = waitingTab()
    await expect(d.discuss(caller(), shell, 'q', { kind: 'tab', tabId: claude })).resolves.toEqual({ ok: false, error: 'That tab is gone' })
    await expect(d.discuss(caller(), fileTab(B), 'q', { kind: 'tab', tabId: claude })).resolves.toEqual({ ok: false, error: 'That tab is gone' })
    await expect(d.discuss(caller(), page, 'q', { kind: 'other' })).resolves.toMatchObject({ ok: false })
    expect(asked).toEqual([])
  })

  it("a plugin that throws, answers junk or takes too long sends nothing; its error names it", async () => {
    const page = fileTab()
    const claude = waitingTab()
    context = async () => {
      throw new Error('boom')
    }
    await expect(discuss().discuss(caller(), page, 'q', { kind: 'tab', tabId: claude })).resolves.toEqual({
      ok: false,
      error: 'Editor could not give its context: boom'
    })
    context = async () => 'text'
    await expect(discuss().discuss(caller(), page, 'q', { kind: 'tab', tabId: claude })).resolves.toMatchObject({ ok: false, error: /\{ text \} or null/ })
    vi.useFakeTimers()
    context = () => new Promise(() => {})
    const pending = discuss().discuss(caller(), page, 'q', { kind: 'tab', tabId: claude })
    await vi.advanceTimersByTimeAsync(DISCUSS_ASK_MS + 1)
    await expect(pending).resolves.toMatchObject({ ok: false, error: /longer than 5 s/ })
    expect(ptyOf(claude).writes.join('')).not.toContain('About:')
  })

  it('a new session gets the text as its first prompt, within the per-window budget', async () => {
    const page = fileTab()
    const opened: string[] = []
    const d = discuss(opened)
    for (let i = 0; i < 5; i++) await expect(d.discuss(caller(), page, `q${i}`, { kind: 'new' })).resolves.toMatchObject({ ok: true, queued: false })
    expect(opened[0]?.startsWith('About: x.ts')).toBe(true)
    await expect(d.discuss(caller(), page, 'q', { kind: 'new' })).resolves.toMatchObject({ ok: false, error: /Too many new sessions/ })
  })

  it('the question is text within the cap; blank is none', () => {
    expect(discussQuestionOf(undefined)).toBeUndefined()
    expect(discussQuestionOf('  ')).toBeUndefined()
    expect(discussQuestionOf('why')).toBe('why')
    expect(() => discussQuestionOf(5)).toThrow(/text/)
    expect(() => discussQuestionOf('x'.repeat(MAX_DISCUSS_QUESTION + 1))).toThrow(/too long/)
  })

  it('a double Send while the plugin is asked sends once', async () => {
    const page = fileTab()
    const claude = waitingTab()
    let release: (v: unknown) => void = () => {}
    context = () => new Promise((r) => (release = r))
    const d = discuss()
    const first = d.discuss(caller(), page, 'q', { kind: 'tab', tabId: claude })
    await expect(d.discuss(caller(), page, 'q', { kind: 'tab', tabId: claude })).resolves.toEqual({ ok: false, error: 'Already sending' })
    release(null)
    await expect(first).resolves.toMatchObject({ ok: true })
  })
})

describe('composeDiscuss with a question', () => {
  it('cuts the context, never the question or the prompt', () => {
    const question = 'q'.repeat(3000)
    const text = composeDiscuss({ title: 't', context: 'c'.repeat(30_000), question, prompt: 'be brief' })
    expect(text.length).toBeLessThanOrEqual(20_000)
    expect(text.endsWith(`${question}\n\nbe brief`)).toBe(true)
    expect(text).toContain('[… cut to fit]')
  })
})

describe('the page asks: ccPanel.tab.discuss() and the shell pool', () => {
  const root = (): ThemeRoot => ({ setProperty: () => {}, removeProperty: () => undefined, colorScheme: '' })

  it('the SDK posts the ask to its parent only once the page is a page tab', () => {
    const sent: unknown[] = []
    const c = new PanelClient(root(), () => {}, undefined, undefined, (m) => sent.push(m))
    expect(c.api.tab).toBeUndefined()
    c.receive({ type: TAB_MESSAGE, tab: { type: 'file' } }, [])
    c.api.tab!.discuss()
    expect(sent).toEqual([{ type: TAB_DISCUSS_MESSAGE }])
  })

  it('the pool opens the box only for the shown frame that has the keyboard', async () => {
    const asks: string[] = []
    const t = pool({ discuss: (tabId) => asks.push(tabId) })
    t.frames.sync([entry(TAB_A), entry(TAB_B)])
    t.frames.show([TAB_A], TAB_A)
    await settle()
    t.frames.show([TAB_B], TAB_B)
    await settle()
    const a = t.el(TAB_A)
    const b = t.el(TAB_B)
    // A page in the background, even with focus, cannot put a box in front of the person.
    a.focusedNow = true
    a.fromPage({ type: TAB_DISCUSS_MESSAGE })
    b.fromPage({ type: TAB_DISCUSS_MESSAGE })
    expect(asks).toEqual([])
    b.focusedNow = true
    b.fromPage({ type: TAB_DISCUSS_MESSAGE })
    expect(asks).toEqual([TAB_B])
  })
})
