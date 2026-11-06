import { describe, expect, it } from 'vitest'
import darkJson from '../../src/themes/dark.json'
import lightJson from '../../src/themes/light.json'
import {
  applyFlagPatch,
  checkFlagPatch,
  cleanFlagNote,
  FLAG_COLORS,
  flagColorCss,
  MAX_FLAG_NOTE_CHARS,
  tabFlagOf
} from '../../src/shared/tab-flag'
import { allTabsOrder, nextAttention, statusesOf } from '../../src/renderer/tabs/tab-flags'
import { hiddenFlags } from '../../src/renderer/tabs/tab-overflow'
import { initialTabsState, tabsReducer } from '../../src/renderer/state/tabs-store'
import type { TabInfo, TabStatus } from '../../src/shared/ipc'

describe('the flag model (shared/tab-flag.ts)', () => {
  it('has six colours, each a token in the light and the dark theme', () => {
    expect(FLAG_COLORS).toEqual(['red', 'orange', 'yellow', 'green', 'blue', 'purple'])
    for (const theme of [darkJson, lightJson]) {
      for (const c of FLAG_COLORS) expect(theme.vars, `${theme.id} ${c}`).toHaveProperty(`--cc-flag-${c}`)
    }
    expect(flagColorCss('red')).toBe('var(--cc-flag-red)')
  })

  it('cleans a note: control, bidi and invisible characters out, line breaks to spaces, trimmed', () => {
    expect(cleanFlagNote('  check\nthe\r\n\tlogs  ')).toBe('check the logs')
    expect(cleanFlagNote('a\u0000b\u001bc\u007f')).toBe('abc')
    expect(cleanFlagNote('ab\u202ecd\u200bef\ufeff')).toBe('abcdef')
    expect(cleanFlagNote('one\u2028two')).toBe('one two')
    // ZWJ emoji and ZWNJ words are kept, as in a session name.
    expect(cleanFlagNote('\u{1f469}\u200d\u{1f4bb} می\u200cخواهم')).toBe('\u{1f469}\u200d\u{1f4bb} می\u200cخواهم')
  })

  it('checks a patch strictly: null clears, colour from the six, note 1-80 characters after cleaning', () => {
    expect(checkFlagPatch(null)).toEqual({ ok: true, value: null })
    expect(checkFlagPatch({ color: 'red' })).toEqual({ ok: true, value: { color: 'red' } })
    expect(checkFlagPatch({ note: ' hi ' })).toEqual({ ok: true, value: { note: 'hi' } })
    expect(checkFlagPatch({ note: '' })).toEqual({ ok: true, value: { note: null } })
    expect(checkFlagPatch({ note: ' \n ' })).toEqual({ ok: true, value: { note: null } })
    expect(checkFlagPatch({ note: null })).toEqual({ ok: true, value: { note: null } })
    // Counted in characters, not UTF-16 units; control characters stripped before counting.
    expect(checkFlagPatch({ note: '\u{1f600}'.repeat(MAX_FLAG_NOTE_CHARS) }).ok).toBe(true)
    expect(checkFlagPatch({ note: `${'x'.repeat(MAX_FLAG_NOTE_CHARS)}\u0000\u0000` }).ok).toBe(true)
    // Only color and note are read.
    expect(checkFlagPatch({ color: 'blue', projectId: 'x', tabId: 'y' })).toEqual({ ok: true, value: { color: 'blue' } })
    for (const bad of [undefined, 'red', 5, [], { color: 'teal' }, { color: 'Red' }, { color: 5 }, { note: 5 }, { note: 'x'.repeat(81) }]) {
      expect(checkFlagPatch(bad).ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('applies a patch: a missing colour keeps the tab\'s or takes the last-used one, a missing note keeps the tab\'s', () => {
    expect(applyFlagPatch(undefined, { color: 'red' }, 'blue')).toEqual({ color: 'red' })
    expect(applyFlagPatch(undefined, { note: 'n' }, 'blue')).toEqual({ color: 'blue', note: 'n' })
    expect(applyFlagPatch({ color: 'green', note: 'n' }, { color: 'red' }, 'blue')).toEqual({ color: 'red', note: 'n' })
    expect(applyFlagPatch({ color: 'green', note: 'n' }, { note: null }, 'blue')).toEqual({ color: 'green' })
    expect(applyFlagPatch({ color: 'green' }, { note: 'm' }, 'blue')).toEqual({ color: 'green', note: 'm' })
  })

  it('reads a saved flag leniently: a damaged one is none, a damaged note only loses the note', () => {
    expect(tabFlagOf({ color: 'red', note: ' a\nb ' })).toEqual({ color: 'red', note: 'a b' })
    expect(tabFlagOf({ color: 'red', note: 'x'.repeat(81) })).toEqual({ color: 'red' })
    expect(tabFlagOf({ color: 'red', note: 7 })).toEqual({ color: 'red' })
    expect(tabFlagOf({ color: 'red', note: '   ' })).toEqual({ color: 'red' })
    for (const bad of [undefined, null, 'red', 5, {}, { color: 'grey' }, { color: '#ff0000' }]) {
      expect(tabFlagOf(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })
})

const tab = (id: string, over: Partial<TabInfo> = {}): TabInfo => ({ id, kind: 'claude', cwd: '/p', gen: 1, ...over })

describe('All tabs order', () => {
  it('lists flagged tabs first, each part in strip order', () => {
    const tabs = [tab('a'), tab('b', { flag: { color: 'red' } }), tab('c'), tab('d', { kind: 'shell', flag: { color: 'blue' } })]
    expect(allTabsOrder(tabs).map((t) => t.id)).toEqual(['b', 'd', 'a', 'c'])
    expect(allTabsOrder([tab('a'), tab('b')]).map((t) => t.id)).toEqual(['a', 'b'])
  })
})

describe('the attention pulse', () => {
  const run = (
    prev: Set<string>,
    seen: Map<string, TabStatus>,
    tabs: TabInfo[],
    now: Record<string, TabStatus>,
    active: string | null
  ): Set<string> => nextAttention(prev, seen, tabs, (id) => now[id], active)

  it('starts when a flagged Claude tab becomes waiting while another tab is shown, and lasts until it is selected', () => {
    const tabs = [tab('a'), tab('f', { flag: { color: 'red' } })]
    const seen = new Map<string, TabStatus>([['a', 'waiting'], ['f', 'working']])
    let att = run(new Set(), seen, tabs, { a: 'waiting', f: 'waiting' }, 'a')
    expect([...att]).toEqual(['f'])
    // Claude moved on (a queued text started a turn): the reminder stays.
    att = run(att, new Map([['f', 'waiting']]), tabs, { a: 'waiting', f: 'working' }, 'a')
    expect([...att]).toEqual(['f'])
    // The person selects it: gone.
    expect([...run(att, new Map(), tabs, { f: 'working' }, 'f')]).toEqual([])
  })

  it('does not start for the tab being looked at, an unflagged tab, a shell tab, or a tab first seen waiting', () => {
    const working = new Map<string, TabStatus>([['f', 'working'], ['u', 'working'], ['s', 'working']])
    const tabs = [tab('f', { flag: { color: 'red' } }), tab('u'), tab('s', { kind: 'shell', flag: { color: 'red' } })]
    expect([...run(new Set(), working, tabs, { f: 'waiting', u: 'waiting', s: 'waiting' }, 'f')]).toEqual([])
    expect([...run(new Set(), working, tabs, { u: 'waiting' }, 'f')]).toEqual([])
    // A page load: nothing was seen before, so a tab already waiting is not a change.
    expect([...run(new Set(), new Map(), tabs, { f: 'waiting' }, 'u')]).toEqual([])
    // A restored tab goes starting -> waiting: that is a change.
    expect([...run(new Set(), new Map([['f', 'starting']]), tabs, { f: 'waiting' }, 'u')]).toEqual(['f'])
  })

  it('stops when the flag is cleared or the tab closes', () => {
    const att = new Set(['f'])
    expect([...run(att, new Map(), [tab('f')], {}, null)]).toEqual([])
    expect([...run(att, new Map(), [], {}, null)]).toEqual([])
  })

  it('statusesOf keeps only tabs with a status', () => {
    expect([...statusesOf([tab('a'), tab('b')], (id) => (id === 'a' ? 'idle' : undefined))]).toEqual([['a', 'idle']])
  })
})

describe('the crowded strip hints', () => {
  it('names the colour of the hidden flagged tab nearest each edge', () => {
    // The strip shows 100..500; the fade is 22 px.
    const tabs = [
      { left: -200, right: -50, color: 'blue' },
      { left: -50, right: 100, color: 'red' },
      { left: 200, right: 350, color: 'green' },
      { left: 490, right: 640, color: 'purple' },
      { left: 700, right: 850, color: 'yellow' }
    ]
    expect(hiddenFlags(100, 500, tabs, 22)).toEqual({ start: 'red', end: 'purple' })
    expect(hiddenFlags(100, 500, [tabs[2]!], 22)).toEqual({})
    // A tab whose centre is still left of the fade's inner edge counts as hidden.
    expect(hiddenFlags(100, 500, [{ left: 20, right: 200, color: 'red' }], 22)).toEqual({ start: 'red' })
    expect(hiddenFlags(100, 500, [{ left: 30, right: 220, color: 'red' }], 22)).toEqual({})
  })
})

describe('tabs store: flagged', () => {
  it('sets and clears a tab\'s flag from main\'s reply, and ignores an unknown tab', () => {
    let s = tabsReducer(initialTabsState, { type: 'loaded', tabs: [tab('a'), tab('b')] })
    s = tabsReducer(s, { type: 'flagged', tabId: 'b', flag: { color: 'red', note: 'n' } })
    expect(s.tabs.map((t) => t.flag)).toEqual([undefined, { color: 'red', note: 'n' }])
    s = tabsReducer(s, { type: 'flagged', tabId: 'b', flag: null })
    expect('flag' in s.tabs[1]!).toBe(false)
    expect(tabsReducer(s, { type: 'flagged', tabId: 'zz', flag: { color: 'red' } })).toBe(s)
  })

  it('a restart reply keeps the flag main still holds (the reply is main\'s TabInfo)', () => {
    let s = tabsReducer(initialTabsState, { type: 'loaded', tabs: [tab('a')] })
    s = tabsReducer(s, { type: 'flagged', tabId: 'a', flag: { color: 'green' } })
    s = tabsReducer(s, { type: 'exited', tabId: 'a', exit: { code: 1, signal: null }, gen: 1 })
    s = tabsReducer(s, { type: 'restarted', tab: tab('a', { gen: 2, flag: { color: 'green' } }) })
    expect(s.tabs[0]!.flag).toEqual({ color: 'green' })
  })
})
