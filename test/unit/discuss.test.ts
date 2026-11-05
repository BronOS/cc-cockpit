import { describe, expect, it } from 'vitest'
import { composeDiscuss, CUT_MARK, discussTypeLine, DiscussSessionBudget } from '../../src/main/overlays/discuss'
import { prepareText } from '../../src/main/sessions/send-gate'
import {
  MAX_DISCUSS_TEXT,
  MAX_DISCUSS_TYPE_LINE,
  preselectDiscussTarget
} from '../../src/shared/discuss'
import { discussReadiness, discussRowMeta, discussTabsOf, existingMenuTitle, orderDiscussTabs, type DiscussTab } from '../../src/renderer/overlays/discuss-tabs'
import type { SessionDetail, TabInfo } from '../../src/shared/ipc'

describe('composeDiscuss', () => {
  it('orders the About line, the type line, the context', () => {
    const text = composeDiscuss({
      title: 'Review src/x.ts',
      type: { name: 'file', data: { path: 'src/x.ts', mime: 'text/plain' } },
      context: 'Notes:\n- line 3 is odd'
    })
    expect(text).toBe('About: Review src/x.ts\nFile: src/x.ts\n\nNotes:\n- line 3 is odd')
  })

  it('leaves out what is missing or blank, and keeps the title on one line', () => {
    expect(composeDiscuss({ title: 'a\n\tb  c' })).toBe('About: a b c')
    expect(composeDiscuss({ title: '', context: '  ' })).toBe('About: Overlay')
    expect(composeDiscuss({ title: 'T', context: 'c' })).toBe('About: T\n\nc')
  })

  it('caps the whole at 20,000, cutting the context', () => {
    const text = composeDiscuss({ title: 'T'.repeat(200), type: { name: 'x', data: 'y'.repeat(4000) }, context: 'c'.repeat(50_000) })
    expect(text.length).toBe(MAX_DISCUSS_TEXT)
    expect(text.endsWith(CUT_MARK)).toBe(true)
    // Exactly at the cap nothing is cut.
    const head = 'About: T'
    const fits = 'c'.repeat(MAX_DISCUSS_TEXT - head.length - 2)
    expect(composeDiscuss({ title: 'T', context: fits })).toBe(`${head}\n\n${fits}`)
    expect(composeDiscuss({ title: 'T', context: `${fits}c` })).toContain(CUT_MARK)
  })

  it('always starts with "About:", so the send gate never refuses it as a command', () => {
    for (const title of ['/clear', '!rm -rf', '# memory', '& bg']) {
      const text = composeDiscuss({ title, context: '/compact' })
      expect(text.startsWith('About: ')).toBe(true)
      expect(() => prepareText(text)).not.toThrow()
    }
  })
})

describe('discussTypeLine', () => {
  it('reads the well-known types as words', () => {
    expect(discussTypeLine({ name: 'file', data: { path: 'src/a b.ts' } })).toBe('File: src/a b.ts')
    expect(discussTypeLine({ name: 'inbox-item', data: { source: 'example.mail', id: 'thread-12' } })).toBe(
      'Item: example.mail thread-12'
    )
  })

  it('shows other types, or a well-known one of another shape, as name: key=value', () => {
    expect(discussTypeLine({ name: 'ticket', data: { key: 'PROJ-12', n: 3, tags: ['a'] } })).toBe('ticket: key=PROJ-12 n=3 tags=["a"]')
    expect(discussTypeLine({ name: 'file', data: { path: 7 } })).toBe('file: path=7')
    expect(discussTypeLine({ name: 'inbox-item', data: { source: 'example.mail' } })).toBe('inbox-item: source=example.mail')
    expect(discussTypeLine({ name: 'thing', data: {} })).toBe('thing')
    expect(discussTypeLine({ name: 'thing', data: null })).toBe('thing: null')
    expect(discussTypeLine({ name: 'thing', data: [1, 2] })).toBe('thing: [1,2]')
    expect(discussTypeLine({ name: 'thing', data: { a: 'x\ny' } })).toBe('thing: a=x y')
  })

  it('is at most 500 characters', () => {
    const line = discussTypeLine({ name: 'thing', data: { long: 'z'.repeat(2000) } })
    expect(line.length).toBe(MAX_DISCUSS_TYPE_LINE)
    expect(line.endsWith('…')).toBe(true)
    expect(discussTypeLine({ name: 'file', data: { path: 'p'.repeat(900) } }).length).toBe(MAX_DISCUSS_TYPE_LINE)
  })
})

describe('preselectDiscussTarget', () => {
  const tabs = [{ tabId: 't1' }, { tabId: 't2' }]
  it("takes the opener's tab, else the active Claude tab, else New session", () => {
    expect(preselectDiscussTarget(tabs, 't2', 't1')).toEqual({ kind: 'tab', tabId: 't2' })
    expect(preselectDiscussTarget(tabs, 'gone', 't1')).toEqual({ kind: 'tab', tabId: 't1' })
    expect(preselectDiscussTarget(tabs, undefined, 't1')).toEqual({ kind: 'tab', tabId: 't1' })
    // The active tab is a shell tab (not listed), or there is none.
    expect(preselectDiscussTarget(tabs, undefined, 'shell')).toEqual({ kind: 'new' })
    expect(preselectDiscussTarget(tabs, undefined, null)).toEqual({ kind: 'new' })
    expect(preselectDiscussTarget([], 't1', 't1')).toEqual({ kind: 'new' })
  })
})

describe('DiscussSessionBudget', () => {
  it('allows 5 a minute per window, refunds and forgets', () => {
    const b = new DiscussSessionBudget()
    for (let i = 0; i < 5; i++) expect(b.take(1, 1000 + i)).toBe(true)
    expect(b.take(1, 2000)).toBe(false)
    expect(b.take(2, 2000)).toBe(true)
    b.refund(1)
    expect(b.take(1, 2000)).toBe(true)
    expect(b.take(1, 2000)).toBe(false)
    // The oldest start leaves the window after a minute.
    expect(b.take(1, 61_000)).toBe(true)
    b.forget(1)
    for (let i = 0; i < 5; i++) expect(b.take(1, 61_001)).toBe(true)
  })
})

describe('discussTabsOf', () => {
  const tab = (id: string, kind: TabInfo['kind'], cwd = '/p/app'): TabInfo => ({ id, kind, cwd, gen: 1 }) as TabInfo
  const detail = (tabId: string, status: SessionDetail['status'], more: Partial<SessionDetail> = {}): SessionDetail => ({
    tabId,
    status,
    notes: [],
    files: [],
    queue: [],
    ...more
  })

  it("lists this window's live Claude tabs in tab order, named like the tab bar", () => {
    const own = new Map([
      ['c1', detail('c1', 'waiting', { title: 'Fix the parser' })],
      ['c2', detail('c2', 'working', { tool: 'Bash' })],
      ['c3', detail('c3', 'ended')]
    ])
    expect(discussTabsOf([tab('s1', 'shell'), tab('c2', 'claude'), tab('c1', 'claude'), tab('c3', 'claude'), tab('c4', 'claude')], own)).toEqual([
      { tabId: 'c2', label: 'Claude · app', status: 'working', tool: 'Bash' },
      { tabId: 'c1', label: 'Fix the parser', status: 'waiting' }
    ])
  })
})

describe('orderDiscussTabs', () => {
  const t = (tabId: string, status: DiscussTab['status']): DiscussTab => ({ tabId, label: tabId, status })
  const tabs = [t('a', 'working'), t('b', 'waiting'), t('c', 'idle'), t('d', 'waiting')]
  it('puts the preselected tab first, then waiting, then busy, then not ready, in tab order', () => {
    expect(orderDiscussTabs(tabs, 'a').map((x) => x.tabId)).toEqual(['a', 'b', 'd', 'c'])
    expect(orderDiscussTabs(tabs, undefined).map((x) => x.tabId)).toEqual(['b', 'd', 'a', 'c'])
    expect(orderDiscussTabs(tabs, 'gone').map((x) => x.tabId)).toEqual(['b', 'd', 'a', 'c'])
    expect(orderDiscussTabs([], 'a')).toEqual([])
  })
  // The first row is the initial target: a preselected tab that cannot take a send is not it.
  it('does not put a not-ready preselected tab first', () => {
    expect(orderDiscussTabs(tabs, 'c').map((x) => x.tabId)).toEqual(['b', 'd', 'a', 'c'])
    expect(orderDiscussTabs([t('i', 'idle'), t('s', 'starting')], 'i').map((x) => x.tabId)).toEqual(['s', 'i'])
  })
  // starting frees itself: SessionStart makes it waiting (send-gate settle window); idle does not.
  it('sends now only to waiting, queues for a running turn or a starting tab, and calls idle not ready', () => {
    expect(tabs.map(discussReadiness)).toEqual(['queued', 'now', 'not-ready', 'now'])
    expect(discussReadiness({ status: 'needs-permission' })).toBe('queued')
    expect(discussReadiness({ status: 'starting' })).toBe('queued')
    expect(discussRowMeta(t('x', 'waiting'), 'waiting')).toBe('waiting')
    expect(discussRowMeta(t('x', 'working'), 'working')).toMatch(/queued/)
    expect(discussRowMeta(t('x', 'idle'), 'idle')).toMatch(/not ready/)
  })
  it('says why the menu is disabled with no session', () => {
    expect(existingMenuTitle([])).toMatch(/No Claude session/)
    expect(existingMenuTitle(tabs)).toBe('Discuss in an existing session')
  })
})
