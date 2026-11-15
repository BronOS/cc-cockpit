// "Ask before closing a tab that is still running": when a user's close asks, what it asks, and
// what the answer does. The dialog, the inert window behind it and every close path are covered
// end to end in test/e2e/close-confirm.spec.ts.
import { createElement, type FunctionComponent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TabInfo } from '../../src/shared/ipc'
import {
  closeAnswer,
  closeGroupQuestion,
  closeQuestion,
  closeQuestionText,
  tabIsRunning
} from '../../src/renderer/tabs/close-confirm'

const tab = (extra: Partial<TabInfo> = {}): TabInfo => ({
  id: 't1',
  kind: 'shell',
  cwd: '/work/app',
  gen: 1,
  ...extra
})

describe('closeQuestion', () => {
  it('asks about a running tab while the setting is on', () => {
    expect(closeQuestion(tab(), undefined, true)).toEqual({ tabId: 't1', title: 'Shell · app' })
    expect(closeQuestion(tab({ kind: 'command', label: 'Dev server', command: 'npm run dev' }), undefined, true)).toEqual({
      tabId: 't1',
      title: 'Dev server'
    })
  })

  it('names a Claude tab’s status in words', () => {
    expect(closeQuestion(tab({ kind: 'claude' }), 'working', true)).toEqual({
      tabId: 't1',
      title: 'Claude · app',
      status: 'working'
    })
    expect(closeQuestion(tab({ kind: 'claude' }), 'waiting', true)?.status).toBe('waiting for input')
    expect(closeQuestion(tab({ kind: 'claude' }), 'needs-permission', true)?.status).toBe('needs permission')
    // No session entry yet (the registry has not reported it): asked all the same, without a status.
    expect(closeQuestion(tab({ kind: 'claude' }), undefined, true)).toEqual({ tabId: 't1', title: 'Claude · app' })
  })

  it('never asks with the setting off', () => {
    expect(closeQuestion(tab(), undefined, false)).toBeNull()
    expect(closeQuestion(tab({ kind: 'claude' }), 'working', false)).toBeNull()
  })

  it('never asks about a tab whose process already ended, whatever the exit', () => {
    for (const exit of [{ code: 0, signal: null }, { code: 1, signal: null }, { code: 0, signal: 9 }]) {
      expect(tabIsRunning(tab({ exit }))).toBe(false)
      expect(closeQuestion(tab({ exit }), undefined, true)).toBeNull()
      expect(closeQuestion(tab({ kind: 'claude', exit }), 'ended', true)).toBeNull()
    }
  })

  it('never asks about a restored command tab that was not started', () => {
    const restored = tab({ kind: 'command', label: 'Deploy', command: 'make deploy', gen: 0, notStarted: true, exit: { code: 0, signal: null } })
    expect(tabIsRunning(restored)).toBe(false)
    expect(closeQuestion(restored, undefined, true)).toBeNull()
  })

  it('does not ask about a tab that is gone (the close goes through and main answers it)', () => {
    expect(closeQuestion(undefined, undefined, true)).toBeNull()
  })
})

describe('closeQuestionText', () => {
  it('says what a close would end', () => {
    expect(closeQuestionText({ tabId: 't', title: 'Claude · app', status: 'working' })).toBe(
      'Claude is working in this tab. Closing it ends the session.'
    )
    expect(closeQuestionText({ tabId: 't', title: 'Shell · app' })).toBe('Its process is still running. Closing the tab ends it.')
  })
})

describe('closeAnswer', () => {
  it('Close closes; with "Don\'t ask again" it also turns the setting off', () => {
    expect(closeAnswer('close', false)).toEqual({ close: true, stopAsking: false })
    expect(closeAnswer('close', true)).toEqual({ close: true, stopAsking: true })
  })

  it('Cancel keeps the tab and the setting, the checkbox notwithstanding', () => {
    expect(closeAnswer('cancel', false)).toEqual({ close: false, stopAsking: false })
    expect(closeAnswer('cancel', true)).toEqual({ close: false, stopAsking: false })
  })
})

describe('closeGroupQuestion (Close all of a split group)', () => {
  const shell = tab({ id: 's' })
  const exited = tab({ id: 'x', exit: { code: 0 } as TabInfo['exit'] })
  const page = (extra: Partial<TabInfo> = {}): TabInfo => ({ id: 'p', kind: 'page', cwd: '/work/app', gen: 1, page: { title: 'notes.txt' } as TabInfo['page'], ...extra })
  const status = (): undefined => undefined

  it('closes at once when nothing runs and nothing is unsaved, whatever the setting', () => {
    expect(closeGroupQuestion('g', 'G', [exited, page()], status, true)).toBeNull()
    expect(closeGroupQuestion('g', 'G', [shell], status, false)).toBeNull()
  })

  it('asks about an unsaved page member with the setting off, and lists only it', () => {
    const q = closeGroupQuestion('g', 'G', [shell, page({ dirty: true })], status, false)
    expect(q?.group).toMatchObject({ groupId: 'g', tabIds: ['s', 'p'], running: [], unsaved: ['p'] })
    expect(q?.group?.unsavedTitles).toHaveLength(1)
  })

  it('counts this view’s own dirty report before main’s round trip shows it', () => {
    const q = closeGroupQuestion('g', 'G', [page()], status, false, (id) => id === 'p')
    expect(q?.group?.unsaved).toEqual(['p'])
  })

  it('lists running members and unsaved ones separately when the setting is on', () => {
    const q = closeGroupQuestion('g', 'G', [shell, page({ dirty: true })], status, true)
    expect(q?.group?.running).toHaveLength(1)
    expect(q?.group?.unsaved).toEqual(['p'])
    expect(closeQuestionText(q!)).toBe('This closes all 2 tabs of the group; 1 is still running (closing ends it) and 1 has unsaved changes (closing discards them):')
  })

  it('a group with only running members lists none unsaved (the plain dialog)', () => {
    const q = closeGroupQuestion('g', 'G', [shell, page()], status, true)
    expect(q?.group?.unsaved).toEqual([])
    expect(q?.group?.running).toHaveLength(1)
  })
})

// The portal needs a document; the static render draws the box itself (as approval-dialog.test.ts does).
vi.mock('../../src/renderer/notices/ApprovalDialog', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>()
  return { ...actual, ApprovalDialog: actual.ApprovalBox }
})

describe('server view: a group question with unsaved members is an approval', () => {
  it('says "Discard and Close all", names the unsaved member and has no "Don\'t ask again"', async () => {
    // A .tsx module loaded by a path the node typecheck does not follow (as approval-dialog.test.ts does).
    const file = '../../src/renderer/tabs/CloseTabDialog.tsx'
    const { CloseTabApproval } = (await import(file)) as { CloseTabApproval: FunctionComponent<{ question: unknown; onAnswer(c: string): void }> }
    const q = closeGroupQuestion('g', 'G', [tab({ id: 'p', kind: 'page', dirty: true, page: { title: 'notes.txt' } as TabInfo['page'] })], () => undefined, false)
    const html = renderToStaticMarkup(createElement(CloseTabApproval, { question: q, onAnswer: () => {} }))
    expect(html).toContain('Discard and Close all')
    expect(html).toContain('unsaved changes')
    expect(html).not.toContain("Don't ask again")
    expect(html).toContain('role="alertdialog"')
  })
})
