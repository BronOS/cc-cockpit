// Plan Task 4 review: Ask Claude's question box over a page tab (PageTabDiscussDialog.tsx). The page,
// not the person, opens the box, and a send goes to a Claude tab as the person's own text, so a send
// needs a deliberate act on a box the person has seen (page-tab-discuss-model.ts): armed only after
// about a second (ApprovalArm), Ctrl/Cmd+Enter only as a fresh chord, and a cancelled box does not
// reopen at once for its tab. The guards are DOM-free; the markup is rendered without a DOM
// (react-dom/server), as ApprovalDialog's test does.
import { createElement, type FunctionComponent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  DISCUSS_REOPEN_COOLDOWN_MS,
  DiscussCooldown,
  DiscussKeys,
  discussMayOpen,
  type DiscussKeyEvent,
  type DiscussOpenState
} from '../../src/renderer/tabs/page-tab-discuss-model'
import type { TabInfo } from '../../src/shared/ipc'

const down = (key: string, mods: Partial<Omit<DiscussKeyEvent, 'key'>> = {}): DiscussKeyEvent => ({
  key,
  ctrlKey: false,
  metaKey: false,
  repeat: false,
  ...mods
})
const ctrlEnter = (repeat = false): DiscussKeyEvent => down('Enter', { ctrlKey: true, repeat })

describe('DiscussKeys (Ctrl/Cmd+Enter)', () => {
  it('sends on a fresh Ctrl+Enter once armed, and never before', () => {
    const keys = new DiscussKeys()
    keys.keyDown(down('Control', { ctrlKey: true }), false)
    expect(keys.keyDown(ctrlEnter(), false)).toBe('block')
    expect(keys.keyDown(ctrlEnter(), true)).toBe('send')
  })

  it('Cmd+Enter on a Mac the same way, with Meta pressed in the box', () => {
    const keys = new DiscussKeys()
    expect(keys.keyDown(down('Enter', { metaKey: true }), true)).toBe('block')
    keys.keyDown(down('Meta', { metaKey: true }), true)
    expect(keys.keyDown(down('Enter', { metaKey: true }), true)).toBe('send')
    // Control pressed does not stand in for a Meta held from before.
    const other = new DiscussKeys()
    other.keyDown(down('Control', { ctrlKey: true }), true)
    expect(other.keyDown(down('Enter', { metaKey: true }), true)).toBe('block')
  })

  it('a held Ctrl+Enter whose first press opened the box never sends: repeats and the old modifier', () => {
    const keys = new DiscussKeys()
    // Ctrl went down in the page, before the box: here only its auto-repeats show.
    keys.keyDown(down('Control', { ctrlKey: true, repeat: true }), false)
    expect(keys.keyDown(ctrlEnter(true), false)).toBe('block')
    // Still held a second later: armed, but neither the repeat nor a new Enter on the old Ctrl counts.
    expect(keys.keyDown(ctrlEnter(true), true)).toBe('block')
    expect(keys.keyDown(ctrlEnter(), true)).toBe('block')
    // Released and pressed again: the person's own chord.
    keys.keyUp('Control')
    keys.keyDown(down('Control', { ctrlKey: true }), true)
    expect(keys.keyDown(ctrlEnter(), true)).toBe('send')
    // Its auto-repeat does not send twice.
    expect(keys.keyDown(ctrlEnter(true), true)).toBe('block')
  })

  it('a released modifier, or one the window lost, must be pressed again', () => {
    const keys = new DiscussKeys()
    keys.keyDown(down('Control', { ctrlKey: true }), true)
    keys.keyUp('Control')
    expect(keys.keyDown(ctrlEnter(), true)).toBe('block')
    keys.keyDown(down('Control', { ctrlKey: true }), true)
    keys.reset()
    expect(keys.keyDown(ctrlEnter(), true)).toBe('block')
  })

  it('plain Enter and other keys pass (a newline, typing)', () => {
    const keys = new DiscussKeys()
    expect(keys.keyDown(down('Enter'), true)).toBe('pass')
    expect(keys.keyDown(down('Enter', { repeat: true }), false)).toBe('pass')
    expect(keys.keyDown(down('a', { ctrlKey: true }), true)).toBe('pass')
  })
})

describe('DiscussCooldown and discussMayOpen (TabsPane gates)', () => {
  const state = (over: Partial<DiscussOpenState> = {}): DiscussOpenState => ({ modalUp: false, switcherUp: false, activeId: 't1', ...over })

  it('opens only for the tab this view shows, never over a modal or the switcher', () => {
    const cooldown = new DiscussCooldown(() => 0)
    expect(discussMayOpen('t1', state(), cooldown)).toBe(true)
    expect(discussMayOpen('t1', state({ modalUp: true }), cooldown)).toBe(false)
    expect(discussMayOpen('t1', state({ switcherUp: true }), cooldown)).toBe(false)
    expect(discussMayOpen('t1', state({ activeId: 't2' }), cooldown)).toBe(false)
    expect(discussMayOpen('t1', state({ activeId: null }), cooldown)).toBe(false)
  })

  it('a cancelled box does not reopen for its tab within the cooldown; other tabs are not held', () => {
    let now = 1000
    const cooldown = new DiscussCooldown(() => now)
    cooldown.cancelled('t1')
    // The page asks again as its frame gets the keyboard back.
    now += 16
    expect(discussMayOpen('t1', state(), cooldown)).toBe(false)
    expect(discussMayOpen('t2', state({ activeId: 't2' }), cooldown)).toBe(true)
    now = 1000 + DISCUSS_REOPEN_COOLDOWN_MS - 1
    expect(discussMayOpen('t1', state(), cooldown)).toBe(false)
    now = 1000 + DISCUSS_REOPEN_COOLDOWN_MS
    expect(discussMayOpen('t1', state(), cooldown)).toBe(true)
    expect(DISCUSS_REOPEN_COOLDOWN_MS).toBeGreaterThanOrEqual(1000)
  })
})

describe('PageTabDiscussDialog markup', () => {
  const tab = { id: 'p1', kind: 'page', cwd: '/x', gen: 1, page: { plugin: 'p.editor', type: 'file', title: 'x.ts' } } as TabInfo
  async function render(claudeTabs: { tabId: string; label: string; status: 'waiting' | 'idle' | 'busy' }[], last?: string): Promise<string> {
    // A .tsx module, loaded by a path the node typecheck does not follow (it has no JSX or DOM lib);
    // vitest transforms it like any other.
    const file = '../../src/renderer/tabs/PageTabDiscussDialog.tsx'
    const { PageTabDiscussDialog } = (await import(file)) as { PageTabDiscussDialog: FunctionComponent<Record<string, unknown>> }
    return renderToStaticMarkup(
      createElement(PageTabDiscussDialog, { tab, claudeTabs, ...(last !== undefined ? { lastClaudeTabId: last } : {}), onClose: () => {} })
    )
  }

  it('Send starts disabled (disarmed): no send on the keystroke after the page opened the box', async () => {
    const html = await render([{ tabId: 'c1', label: 'Claude', status: 'waiting' }], 'c1')
    expect(html).toMatch(/<button[^>]*class="page-tab-discuss-send"[^>]*disabled=""/)
    expect(html).toContain('Ask Claude about “x.ts”')
    // The last Claude tab of this view is preselected.
    expect(html).toMatch(/<option value="c1" selected="">/)
  })

  it('an idle last Claude tab is listed but not picked: a new session is', async () => {
    const html = await render([{ tabId: 'c1', label: 'Claude', status: 'idle' }], 'c1')
    expect(html).toMatch(/<option value="c1">/)
    expect(html).toMatch(/<option value="new" selected="">/)
  })
})
