// design-web-browser.md §4.4 (plan 20261111-streamed-webviews.md Task 9): `<select>` popups of a
// streamed page. Main's side: the hit and choose scripts (run against a fake DOM in a vm context, as
// the isolated world would), the result's parsing and caps, the press held behind its hit-test
// (non-select presses forwarded unchanged and in order, the timeout and failure fallbacks), the popup
// id taken once (stale and forged ids ignored, bounds and disabled options refused), the manager's
// target and the off-screen adapter's calls are in electron-offscreen-webview.test.ts. The browser's
// side: the menu's placement through the letterbox and the keys (web/webview-select.ts).
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  chooseScript,
  HIT_TIMEOUT_MS,
  hitScript,
  MAX_HELD_EVENTS,
  MAX_OPTION_LABEL,
  MAX_SELECT_OPTIONS,
  newSelectId,
  parseHitResult,
  SelectPopups
} from '../../src/main/webview/select-hit'
import { PAGE_WAIT_MS, WebviewInput, type ElectronInputEvent } from '../../src/main/webview/webview-input'
import { WebviewViewers, type WebviewPanelOf } from '../../src/main/webview/webview-viewers'
import { WebviewManager, type WebviewView } from '../../src/main/webview/webview-manager'
import type { IpcEventMap, WebviewSelectOption } from '../../src/shared/ipc'
import { MAX_FRAME_BYTES } from '../../src/shared/web-protocol'
import { letterbox } from '../../src/renderer/web/webview-stream'
import {
  groupRuns,
  initialActive,
  MENU_MIN_WIDTH,
  moveActive,
  pageRectToArea,
  placeMenu,
  typeAhead
} from '../../src/renderer/web/webview-select'

const ID = 'a'.repeat(32)
const ID2 = 'b'.repeat(32)

// ---------------------------------------------------------------------------------------------
// The scripts, against a fake DOM.

interface FakeOption {
  label: string
  text: string
  disabled: boolean
  hidden: boolean
  parentElement: unknown
}

function fakeSelect(
  spec: {
    disabled?: boolean
    multiple?: boolean
    size?: number
    selectedIndex?: number
    options?: Array<{ text: string; label?: string; disabled?: boolean; hidden?: boolean; group?: { label: string; disabled?: boolean } }>
  } = {}
) {
  const events: string[] = []
  const groups = new Map<string, { tagName: string; label: string; disabled: boolean }>()
  const select = {
    tagName: 'SELECT',
    multiple: spec.multiple ?? false,
    size: spec.size ?? 0,
    selectedIndex: spec.selectedIndex ?? 0,
    isConnected: true,
    shadowRoot: null,
    focused: false,
    options: [] as FakeOption[],
    events,
    matches: (q: string) => q === ':disabled' && spec.disabled === true,
    closest(q: string) {
      return q === 'select' ? select : null
    },
    focus() {
      select.focused = true
    },
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 150, height: 24 }),
    dispatchEvent(e: { type: string; bubbles: boolean }) {
      events.push(`${e.type}${e.bubbles ? ' bubbles' : ''} ${select.selectedIndex}`)
      return true
    }
  }
  for (const o of spec.options ?? [{ text: 'One' }, { text: 'Two' }, { text: 'Three' }]) {
    let parent: unknown = select
    if (o.group) {
      const g = groups.get(o.group.label) ?? { tagName: 'OPTGROUP', label: o.group.label, disabled: o.group.disabled ?? false }
      groups.set(o.group.label, g)
      parent = g
    }
    select.options.push({ label: o.label ?? '', text: o.text, disabled: o.disabled ?? false, hidden: o.hidden ?? false, parentElement: parent })
  }
  return select
}

class FakeEvent {
  bubbles: boolean
  constructor(
    readonly type: string,
    init: { bubbles?: boolean } = {}
  ) {
    this.bubbles = init.bubbles === true
  }
}

/** A page whose elementFromPoint answers `at`; one context, so the isolated world's globals persist. */
function world(at: unknown) {
  const calls: Array<[number, number]> = []
  const context = createContext({
    document: {
      elementFromPoint: (x: number, y: number) => {
        calls.push([x, y])
        return at
      }
    },
    Event: FakeEvent
  })
  return { run: (code: string): unknown => runInContext(code, context), calls, context }
}

describe('hitScript and chooseScript (run in the isolated world)', () => {
  it('finds a select under the point and returns its options, selection and rectangle; focuses it', () => {
    const select = fakeSelect({
      selectedIndex: 2,
      options: [
        { text: '  Apple  ' },
        { text: 'Banana', label: 'Banana (ripe)' },
        { text: 'Cherry', disabled: true },
        { text: 'Hidden', hidden: true },
        { text: 'Dates', group: { label: 'Dry' } },
        { text: 'Figs', group: { label: 'Off', disabled: true } }
      ]
    })
    const w = world(select)
    const result = w.run(hitScript(12.5, 30, ID))
    expect(w.calls).toEqual([[12.5, 30]])
    expect(result).toEqual({
      select: true,
      options: [
        { index: 0, label: 'Apple', disabled: false },
        { index: 1, label: 'Banana (ripe)', disabled: false },
        { index: 2, label: 'Cherry', disabled: true },
        { index: 4, label: 'Dates', disabled: false, group: 'Dry' },
        { index: 5, label: 'Figs', disabled: true, group: 'Off' }
      ],
      selected: 2,
      rect: { x: 10, y: 20, width: 150, height: 24 }
    })
    expect(select.focused).toBe(true)
    expect(parseHitResult(result)).toBeDefined()
  })

  it('walks into open shadow roots and up from an option to its select', () => {
    const select = fakeSelect()
    const host = { tagName: 'MY-PICKER', shadowRoot: { elementFromPoint: () => select }, closest: () => null }
    expect(world(host).run(hitScript(1, 1, ID))).toMatchObject({ select: true })
    const option = { tagName: 'OPTION', shadowRoot: null, closest: (q: string) => (q === 'select' ? select : null) }
    expect(world(option).run(hitScript(1, 1, ID))).toMatchObject({ select: true })
    // A shadow root that answers its own host: no endless walk.
    const self: { tagName: string; shadowRoot: unknown; closest: () => null } = { tagName: 'X-SELF', shadowRoot: null, closest: () => null }
    self.shadowRoot = { elementFromPoint: () => self }
    expect(world(self).run(hitScript(1, 1, ID))).toBeNull()
  })

  it('is null for anything that is no single-choice, enabled select (an iframe included)', () => {
    expect(world(null).run(hitScript(1, 1, ID))).toBeNull()
    expect(world({ tagName: 'IFRAME', shadowRoot: null, closest: () => null }).run(hitScript(1, 1, ID))).toBeNull()
    expect(world(fakeSelect({ disabled: true })).run(hitScript(1, 1, ID))).toBeNull()
    expect(world(fakeSelect({ multiple: true })).run(hitScript(1, 1, ID))).toBeNull()
    expect(world(fakeSelect({ size: 4 })).run(hitScript(1, 1, ID))).toBeNull()
    expect(world(fakeSelect({ size: 1 })).run(hitScript(1, 1, ID))).toMatchObject({ select: true })
  })

  it('cuts the options and their labels in the page before they cross', () => {
    const long = 'x'.repeat(5000)
    const select = fakeSelect({ options: Array.from({ length: 700 }, (_, i) => ({ text: i === 0 ? long : `o${i}` })) })
    const result = world(select).run(hitScript(1, 1, ID)) as { options: WebviewSelectOption[] }
    expect(result.options).toHaveLength(MAX_SELECT_OPTIONS)
    expect(result.options[0]?.label).toHaveLength(MAX_OPTION_LABEL)
  })

  it('chooses through the kept element: sets the index and fires input and change, bubbling', () => {
    const select = fakeSelect({ selectedIndex: 0 })
    const w = world(select)
    w.run(hitScript(1, 1, ID))
    expect(w.run(chooseScript(ID, 2))).toBe(true)
    expect(select.selectedIndex).toBe(2)
    expect(select.events).toEqual(['input bubbles 2', 'change bubbles 2'])
    // Taken once: the same id again finds nothing.
    expect(w.run(chooseScript(ID, 1))).toBe(false)
    expect(select.selectedIndex).toBe(2)
  })

  it('refuses a stale id, out of bounds, disabled options and groups, a select gone or disabled since', () => {
    const select = fakeSelect({
      options: [{ text: 'a' }, { text: 'b', disabled: true }, { text: 'c', group: { label: 'G', disabled: true } }, { text: 'd' }]
    })
    const w = world(select)
    // Never hit-tested under this id (forged or from another page's world).
    expect(w.run(chooseScript(ID2, 3))).toBe(false)
    for (const index of [1, 2, 9]) {
      w.run(hitScript(1, 1, ID))
      expect(w.run(chooseScript(ID, index))).toBe(false)
    }
    // The same index again: nothing changes, nothing fires (as a native select).
    w.run(hitScript(1, 1, ID))
    expect(w.run(chooseScript(ID, 0))).toBe(false)
    // null forgets it.
    w.run(hitScript(1, 1, ID))
    expect(w.run(chooseScript(ID, null))).toBe(false)
    expect(w.run(chooseScript(ID, 3))).toBe(false)
    w.run(hitScript(1, 1, ID))
    select.isConnected = false
    expect(w.run(chooseScript(ID, 3))).toBe(false)
    expect(select.selectedIndex).toBe(0)
    expect(select.events).toEqual([])
  })

  it('keeps few elements in the world (oldest go first)', () => {
    const w = world(fakeSelect())
    const ids = Array.from({ length: 20 }, () => newSelectId())
    for (const id of ids) w.run(hitScript(1, 1, id))
    expect(w.run('globalThis.__ccCockpitSelects.size')).toBe(16)
    expect(w.run(chooseScript(ids[0] as string, 1))).toBe(false)
    expect(w.run(chooseScript(ids[19] as string, 1))).toBe(true)
  })

  it('embeds only main\'s numbers and hex ids', () => {
    expect(newSelectId()).toMatch(/^[0-9a-f]{32}$/)
    expect(() => hitScript(1, 1, "x'); evil(); ('")).toThrow(/bad popup id/)
    expect(() => chooseScript('A'.repeat(32), 1)).toThrow(/bad popup id/)
    expect(() => hitScript(Number.NaN, 1, ID)).toThrow(/bad number/)
    expect(() => chooseScript(ID, Infinity)).toThrow(/bad number/)
  })
})

// ---------------------------------------------------------------------------------------------
// The result as main passes it on.

describe('parseHitResult: cleaned and capped, or nothing', () => {
  const ok = (extra: Record<string, unknown> = {}) => ({
    select: true,
    options: [
      { index: 0, label: 'a', disabled: false },
      { index: 3, label: 'b', disabled: true, group: 'G' }
    ],
    selected: 3,
    rect: { x: 1, y: 2, width: 3, height: 4 },
    ...extra
  })

  it('takes the script\'s result', () => {
    expect(parseHitResult(ok())).toEqual({
      options: [
        { index: 0, label: 'a', disabled: false },
        { index: 3, label: 'b', disabled: true, group: 'G' }
      ],
      selected: 3,
      rect: { x: 1, y: 2, width: 3, height: 4 }
    })
  })

  it.each([
    ['null (no select there)', null],
    ['a string', 'select'],
    ['no select flag', { ...ok(), select: 1 }],
    ['options not a list', ok({ options: {} })],
    ['too many options', ok({ options: Array.from({ length: MAX_SELECT_OPTIONS + 1 }, (_, i) => ({ index: i, label: '', disabled: false })) })],
    ['an index past the cap', ok({ options: [{ index: MAX_SELECT_OPTIONS, label: '', disabled: false }] })],
    ['indices out of order', ok({ options: [{ index: 2, label: '', disabled: false }, { index: 2, label: '', disabled: false }] })],
    ['a fractional index', ok({ options: [{ index: 0.5, label: '', disabled: false }] })],
    ['a label that is no string', ok({ options: [{ index: 0, label: 7, disabled: false }] })],
    ['disabled that is no boolean', ok({ options: [{ index: 0, label: '', disabled: 'no' }] })],
    ['a group that is no string', ok({ options: [{ index: 0, label: '', disabled: false, group: 1 }] })],
    ['no rectangle', ok({ rect: null })],
    ['a NaN in the rectangle', ok({ rect: { x: Number.NaN, y: 0, width: 1, height: 1 } })]
  ])('nothing for %s', (_name, raw) => {
    expect(parseHitResult(raw)).toBeUndefined()
  })

  it('cleans labels: capped, controls as spaces, lone surrogates replaced', () => {
    const r = parseHitResult(
      ok({ options: [{ index: 0, label: `a\u0000b\nc\u009f${'y'.repeat(500)}`, disabled: false, group: '\ud800x' }] })
    )
    expect(r?.options[0]?.label).toBe(`a b c ${'y'.repeat(MAX_OPTION_LABEL - 6)}`)
    expect(r?.options[0]?.group).toBe('�x')
  })

  it('a bad selected index is none; the rectangle is clamped', () => {
    expect(parseHitResult(ok({ selected: 'x' }))?.selected).toBe(-1)
    expect(parseHitResult(ok({ selected: -5 }))?.selected).toBe(-1)
    expect(parseHitResult(ok({ rect: { x: -1e12, y: 1e12, width: -3, height: 4 } }))?.rect).toEqual({ x: -100_000, y: 100_000, width: 0, height: 4 })
  })

  it('the largest popup stays far under the socket frame cap', () => {
    const label = '一'.repeat(MAX_OPTION_LABEL)
    const r = parseHitResult(
      ok({ options: Array.from({ length: MAX_SELECT_OPTIONS }, (_, i) => ({ index: i, label, disabled: false, group: label })) })
    )
    const event: IpcEventMap['webviews.select'] = { panelKey: 'a/b', id: ID, ...(r as NonNullable<typeof r>) }
    expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(MAX_FRAME_BYTES / 4)
  })
})

describe('SelectPopups: one per view and panel, taken once', () => {
  const hit = parseHitResult({
    select: true,
    options: [
      { index: 0, label: 'a', disabled: false },
      { index: 1, label: 'b', disabled: true }
    ],
    selected: 0,
    rect: { x: 0, y: 0, width: 1, height: 1 }
  }) as NonNullable<ReturnType<typeof parseHitResult>>

  it('answers only its current id, once; a new popup replaces the old', () => {
    const p = new SelectPopups()
    p.set('web:1', 'k', hit, ID)
    expect(p.take('web:2', 'k', ID)).toBeUndefined()
    expect(p.take('web:1', 'other', ID)).toBeUndefined()
    expect(p.take('web:1', 'k', ID2)).toBeUndefined()
    expect(p.take('web:1', 'k', 7)).toBeUndefined()
    expect([...(p.take('web:1', 'k', ID)?.choosable ?? [])]).toEqual([0])
    expect(p.take('web:1', 'k', ID)).toBeUndefined()
    p.set('web:1', 'k', hit, ID)
    p.set('web:1', 'k', hit, ID2)
    expect(p.take('web:1', 'k', ID)).toBeUndefined()
    expect(p.take('web:1', 'k', ID2)).toBeDefined()
    p.set('web:1', 'k', hit, ID)
    p.viewGone('web:1')
    expect(p.take('web:1', 'k', ID)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------------
// The press held behind its hit-test (WebviewInput).

const PANEL: WebviewPanelOf = { windowId: 7, pluginId: 'a.one', panelId: 'view' }
const shown = { width: 800, height: 600, visible: true, hidden: false }
const SELECT_RESULT = {
  select: true,
  options: [
    { index: 0, label: 'Apple', disabled: false },
    { index: 1, label: 'Banana', disabled: false },
    { index: 2, label: 'Cherry', disabled: true }
  ],
  selected: 0,
  rect: { x: 10, y: 20, width: 150, height: 24 }
}

const pdown = (x: number, y: number, button = 'left') => ({ kind: 'pointer', type: 'down', x, y, button, clickCount: 1 })
const pup = (x: number, y: number, button = 'left') => ({ kind: 'pointer', type: 'up', x, y, button, clickCount: 1 })
const pmove = (x: number, y: number, modifiers: string[] = []) => ({ kind: 'pointer', type: 'move', x, y, modifiers })
const pkey = (k: string) => ({ kind: 'key', type: 'down', key: k })

function pressSetup(
  options: {
    hit?: (x: number, y: number, id: string) => Promise<unknown>
    pushSelect?: boolean
    /** What insertText and chooseSelect return (default: void and a resolved promise). */
    textDone?: () => Promise<unknown> | void
    chooseDone?: () => Promise<unknown>
  } = {}
) {
  const viewers = new WebviewViewers({ setViewed: () => {}, setSize: () => {}, now: () => 0 })
  const timers = new Map<number, () => void>()
  let nextTimer = 0
  const sent: ElectronInputEvent[] = []
  const order: string[] = []
  const texts: string[] = []
  const hits: Array<{ x: number; y: number; id: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = []
  const chosen: Array<[string, number | null]> = []
  const popups: Array<[string, IpcEventMap['webviews.select']]> = []
  let ids = 0
  const input = new WebviewInput({
    isViewer: (panel, viewId) => viewers.isViewer(panel, viewId),
    claimOwner: (panel, viewId) => viewers.claimOwner(panel, viewId),
    target: () => ({
      size: () => ({ width: 800, height: 600 }),
      send: (events) => {
        sent.push(...events)
        order.push(...events.map((e) => e.type))
      },
      insertText: (text) => {
        texts.push(text)
        order.push(`text ${text}`)
        return options.textDone?.()
      },
      hitSelect:
        options.hit ??
        ((x, y, id) =>
          new Promise((resolve, reject) => {
            hits.push({ x, y, id, resolve, reject })
          })),
      chooseSelect: (id, index) => {
        chosen.push([id, index])
        order.push(`choose ${index}`)
        return options.chooseDone ? options.chooseDone() : Promise.resolve(true)
      }
    }),
    ...(options.pushSelect === false ? {} : { pushSelect: (viewId: string, event: IpcEventMap['webviews.select']) => void popups.push([viewId, event]) }),
    newSelectId: () => (++ids % 2 === 1 ? ID : ID2),
    timers: {
      set: (fn) => {
        timers.set(++nextTimer, fn)
        return nextTimer
      },
      clear: (h) => void timers.delete(h as number)
    },
    now: () => 0
  })
  viewers.report(PANEL, 'web:1', shown)
  viewers.report(PANEL, 'web:2', shown)
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  const timeout = (): void => {
    const fns = [...timers.values()]
    timers.clear()
    for (const fn of fns) fn()
  }
  return { viewers, input, sent, order, texts, hits, chosen, popups, flush, timeout, timers }
}

const types = (events: ElectronInputEvent[]): string[] => events.map((e) => e.type)

describe('a press held behind its hit-test', () => {
  it('a press that is no select goes on unchanged, with what came after it, in order', async () => {
    const { input, sent, hits, flush, popups } = pressSetup()
    input.accept(PANEL, 'web:1', [pmove(1, 1), pdown(100.4, 50), pup(100.4, 50), pmove(2, 2)])
    // Moves before the press went at once; the press and the rest wait.
    expect(types(sent)).toEqual(['mouseMove'])
    expect(hits.map((h) => [h.x, h.y])).toEqual([[100, 50]])
    // A later call queues behind it.
    input.accept(PANEL, 'web:1', [pkey('a'), pmove(3, 3)])
    expect(types(sent)).toEqual(['mouseMove'])
    hits[0]?.resolve(null)
    await flush()
    expect(types(sent)).toEqual(['mouseMove', 'mouseDown', 'mouseUp', 'mouseMove', 'keyDown', 'char', 'mouseMove'])
    expect(sent[1]).toEqual({ type: 'mouseDown', x: 100, y: 50, button: 'left', clickCount: 1, modifiers: [] })
    expect(popups).toEqual([])
  })

  it('inserted text waits behind a held press too, in order with the keys', async () => {
    const { input, sent, hits, flush, texts, order } = pressSetup()
    input.accept(PANEL, 'web:1', [pdown(10, 10), pup(10, 10), pkey('h')])
    expect(input.acceptText(PANEL, 'web:1', 'é')).toBe(true)
    input.accept(PANEL, 'web:1', [pkey('l')])
    expect(texts).toEqual([])
    hits[0]?.resolve(null)
    await flush()
    expect(texts).toEqual(['é'])
    expect(types(sent)).toEqual(['mouseDown', 'mouseUp', 'keyDown', 'char', 'keyDown', 'char'])
    expect(order).toEqual(['mouseDown', 'mouseUp', 'keyDown', 'char', 'text é', 'keyDown', 'char'])
    // With nothing held, text goes at once.
    input.acceptText(PANEL, 'web:1', 'ü')
    expect(texts).toEqual(['é', 'ü'])
  })

  it('only a left press is asked about; right and middle go at once', () => {
    const { input, sent, hits } = pressSetup()
    input.accept(PANEL, 'web:1', [pdown(5, 5, 'right'), pup(5, 5, 'right'), pdown(5, 5, 'middle')])
    expect(types(sent)).toEqual(['mouseDown', 'mouseUp', 'mouseDown'])
    expect(hits).toEqual([])
  })

  it('a slow hit-test lets the press go after HIT_TIMEOUT_MS; its late answer opens nothing', async () => {
    const { input, sent, hits, flush, popups, timeout, timers } = pressSetup()
    expect(HIT_TIMEOUT_MS).toBeLessThanOrEqual(100)
    input.accept(PANEL, 'web:1', [pdown(10, 10), pup(10, 10)])
    expect(sent).toEqual([])
    expect(timers.size).toBe(1)
    timeout()
    expect(types(sent)).toEqual(['mouseDown', 'mouseUp'])
    hits[0]?.resolve(SELECT_RESULT)
    await flush()
    expect(popups).toEqual([])
    // Nothing is held any more: the next events go at once.
    input.accept(PANEL, 'web:1', [pmove(4, 4)])
    expect(types(sent)).toEqual(['mouseDown', 'mouseUp', 'mouseMove'])
  })

  it('a failed or throwing hit-test lets the press go', async () => {
    const failing = pressSetup()
    failing.input.accept(PANEL, 'web:1', [pdown(10, 10), pup(10, 10)])
    failing.hits[0]?.reject(new Error('gone'))
    await failing.flush()
    expect(types(failing.sent)).toEqual(['mouseDown', 'mouseUp'])
    const throwing = pressSetup({
      hit: () => {
        throw new Error('destroyed')
      }
    })
    throwing.input.accept(PANEL, 'web:1', [pdown(10, 10), pup(10, 10)])
    expect(types(throwing.sent)).toEqual(['mouseDown', 'mouseUp'])
    expect(throwing.timers.size).toBe(0)
  })

  it('without a way to show a popup, presses are never held', () => {
    const { input, sent, hits } = pressSetup({ pushSelect: false })
    input.accept(PANEL, 'web:1', [pdown(10, 10), pup(10, 10)])
    expect(types(sent)).toEqual(['mouseDown', 'mouseUp'])
    expect(hits).toEqual([])
  })

  it('a select: the press and its release never reach the page; the popup goes to the clicking view', async () => {
    const { input, sent, hits, flush, popups } = pressSetup()
    input.accept(PANEL, 'web:1', [pdown(20, 30), pmove(21, 31, ['leftbuttondown'])])
    hits[0]?.resolve(SELECT_RESULT)
    await flush()
    // The drag of a press the page never saw goes without its button.
    expect(sent).toEqual([{ type: 'mouseMove', x: 21, y: 31, modifiers: [] }])
    expect(popups).toEqual([['web:1', { panelKey: 'a.one/view', id: ID, ...parseHitResult(SELECT_RESULT) }]])
    // The release comes in a later call: dropped too; what follows goes.
    input.accept(PANEL, 'web:1', [pup(20, 30), pmove(5, 5, ['leftbuttondown']), pkey('Tab')])
    expect(types(sent)).toEqual(['mouseMove', 'mouseMove', 'keyDown'])
    // The next press is asked about again.
    input.accept(PANEL, 'web:1', [pdown(400, 400), pup(400, 400)])
    expect(hits).toHaveLength(2)
    hits[1]?.resolve(null)
    await flush()
    expect(types(sent)).toEqual(['mouseMove', 'mouseMove', 'keyDown', 'mouseDown', 'mouseUp'])
  })

  it('a press among the held events is asked about in its turn', async () => {
    const { input, sent, hits, flush } = pressSetup()
    input.accept(PANEL, 'web:1', [pdown(1, 1), pup(1, 1), pdown(2, 2), pup(2, 2), pkey('a')])
    hits[0]?.resolve(null)
    await flush()
    expect(types(sent)).toEqual(['mouseDown', 'mouseUp'])
    expect(hits.map((h) => [h.x, h.y])).toEqual([
      [1, 1],
      [2, 2]
    ])
    hits[1]?.resolve(SELECT_RESULT)
    await flush()
    expect(types(sent)).toEqual(['mouseDown', 'mouseUp', 'keyDown', 'char'])
  })

  it('holds at most MAX_HELD_EVENTS behind one press', async () => {
    const { input, sent, hits, flush } = pressSetup()
    input.accept(PANEL, 'web:1', [pdown(1, 1)])
    for (let i = 0; i < 6; i++) input.accept(PANEL, 'web:1', Array.from({ length: 64 }, () => pmove(1, 1)))
    hits[0]?.resolve(null)
    await flush()
    expect(sent).toHaveLength(1 + MAX_HELD_EVENTS)
  })

  it('a view that stopped viewing gets no popup (the press goes as it came); a view that went, nothing', async () => {
    const s = pressSetup()
    s.input.accept(PANEL, 'web:1', [pdown(20, 30), pup(20, 30)])
    s.viewers.report(PANEL, 'web:1', { ...shown, visible: false })
    s.hits[0]?.resolve(SELECT_RESULT)
    await s.flush()
    expect(s.popups).toEqual([])
    expect(types(s.sent)).toEqual(['mouseDown', 'mouseUp'])
    const gone = pressSetup()
    gone.input.accept(PANEL, 'web:1', [pdown(20, 30), pup(20, 30)])
    gone.input.viewGone('web:1')
    expect(gone.timers.size).toBe(0)
    gone.hits[0]?.resolve(SELECT_RESULT)
    await gone.flush()
    expect(gone.popups).toEqual([])
    expect(gone.sent).toEqual([])
  })

  it("one view's held press does not hold another view's input", () => {
    const { input, sent } = pressSetup()
    input.accept(PANEL, 'web:1', [pdown(1, 1)])
    input.accept(PANEL, 'web:2', [pkey('b')])
    expect(types(sent)).toEqual(['keyDown', 'char'])
  })
})

// One lane per view and panel for all three channels (webviews.input, .insertText, .selectChoose):
// the page gets them in the order they came. A text or a choice takes another road into the page
// than sendInputEvent, so what comes after one waits until the page has it.
describe('one ordered lane per view and panel: input, text and choices', () => {
  /** A promise settled by hand, one per call. */
  function deferreds() {
    const list: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = []
    return {
      list,
      make: (): Promise<unknown> =>
        new Promise((resolve, reject) => {
          list.push({ resolve, reject })
        })
    }
  }

  it('keys after a text wait until the page has the text; keys before it go first', async () => {
    const d = deferreds()
    const { input, order, flush } = pressSetup({ textDone: d.make })
    input.accept(PANEL, 'web:1', [pkey('h')])
    input.acceptText(PANEL, 'web:1', 'é')
    input.accept(PANEL, 'web:1', [pkey('l'), pkey('l')])
    input.acceptText(PANEL, 'web:1', 'ü')
    input.accept(PANEL, 'web:1', [pkey('o')])
    expect(order).toEqual(['keyDown', 'char', 'text é'])
    d.list[0]?.resolve(undefined)
    await flush()
    expect(order).toEqual(['keyDown', 'char', 'text é', 'keyDown', 'char', 'keyDown', 'char', 'text ü'])
    d.list[1]?.resolve(undefined)
    await flush()
    expect(order).toEqual(['keyDown', 'char', 'text é', 'keyDown', 'char', 'keyDown', 'char', 'text ü', 'keyDown', 'char'])
    // Nothing waits any more: input goes at once.
    input.accept(PANEL, 'web:1', [pmove(1, 1)])
    expect(order.at(-1)).toBe('mouseMove')
  })

  it('a paste in chunks goes chunk by chunk, each after the page has the one before', async () => {
    const d = deferreds()
    const { input, texts, flush } = pressSetup({ textDone: d.make })
    for (const chunk of ['one ', 'two ', 'three']) input.acceptText(PANEL, 'web:1', chunk)
    expect(texts).toEqual(['one '])
    d.list[0]?.resolve(undefined)
    await flush()
    expect(texts).toEqual(['one ', 'two '])
    d.list[1]?.resolve(undefined)
    await flush()
    expect(texts).toEqual(['one ', 'two ', 'three'])
  })

  it('a press, text and keys interleaved: the press held for its hit-test, the text for the page, all in order', async () => {
    const d = deferreds()
    const { input, order, hits, flush } = pressSetup({ textDone: d.make })
    input.accept(PANEL, 'web:1', [pmove(5, 5), pdown(10, 10), pmove(11, 11), pup(11, 11), pkey('a')])
    input.acceptText(PANEL, 'web:1', 'é')
    input.accept(PANEL, 'web:1', [pkey('b'), pdown(20, 20), pup(20, 20)])
    input.acceptText(PANEL, 'web:1', 'ü')
    expect(order).toEqual(['mouseMove'])
    hits[0]?.resolve(null)
    await flush()
    expect(order).toEqual(['mouseMove', 'mouseDown', 'mouseMove', 'mouseUp', 'keyDown', 'char', 'text é'])
    d.list[0]?.resolve(undefined)
    await flush()
    // The second press is asked about in its turn; the text behind it waits for that.
    expect(order).toEqual(['mouseMove', 'mouseDown', 'mouseMove', 'mouseUp', 'keyDown', 'char', 'text é', 'keyDown', 'char'])
    expect(hits).toHaveLength(2)
    hits[1]?.resolve(null)
    await flush()
    expect(order.slice(-3)).toEqual(['mouseDown', 'mouseUp', 'text ü'])
  })

  it(`a text the page never confirms holds the rest at most PAGE_WAIT_MS; a failed one holds nothing`, async () => {
    const hung = pressSetup({ textDone: () => new Promise(() => {}) })
    hung.input.acceptText(PANEL, 'web:1', 'é')
    hung.input.accept(PANEL, 'web:1', [pkey('a')])
    expect(hung.order).toEqual(['text é'])
    expect(PAGE_WAIT_MS).toBeLessThanOrEqual(1000)
    hung.timeout()
    expect(hung.order).toEqual(['text é', 'keyDown', 'char'])
    const failed = pressSetup({ textDone: () => Promise.reject(new Error('gone')) })
    failed.input.acceptText(PANEL, 'web:1', 'é')
    failed.input.accept(PANEL, 'web:1', [pkey('a')])
    await failed.flush()
    expect(failed.order).toEqual(['text é', 'keyDown', 'char'])
    // A text the view inserts with no promise (an older adapter) holds nothing.
    const plain = pressSetup()
    plain.input.acceptText(PANEL, 'web:1', 'é')
    plain.input.accept(PANEL, 'web:1', [pkey('a')])
    expect(plain.order).toEqual(['text é', 'keyDown', 'char'])
  })

  it('a select choice waits behind a held text and holds what comes after it', async () => {
    const texts = deferreds()
    const chooses = deferreds()
    const s = pressSetup({ textDone: texts.make, chooseDone: chooses.make })
    s.input.accept(PANEL, 'web:1', [pdown(20, 30), pup(20, 30)])
    s.hits[0]?.resolve(SELECT_RESULT)
    await s.flush()
    s.input.acceptText(PANEL, 'web:1', 'x')
    expect(s.input.acceptChoice(PANEL, 'web:1', ID, 1)).toBe(true)
    s.input.accept(PANEL, 'web:1', [pkey('Enter')])
    expect(s.order).toEqual(['text x'])
    texts.list[0]?.resolve(undefined)
    await s.flush()
    expect(s.order).toEqual(['text x', 'choose 1'])
    chooses.list[0]?.resolve(true)
    await s.flush()
    expect(s.order).toEqual(['text x', 'choose 1', 'keyDown', 'char'])
  })

  it("one view's waiting text does not hold another view's input", () => {
    const { input, order } = pressSetup({ textDone: () => new Promise(() => {}) })
    input.acceptText(PANEL, 'web:1', 'é')
    input.accept(PANEL, 'web:2', [pkey('b')])
    expect(order).toEqual(['text é', 'keyDown', 'char'])
  })

  it('a view that goes while its text waits: its held input is dropped and nothing runs later', async () => {
    const d = deferreds()
    const { input, order, flush, timers } = pressSetup({ textDone: d.make })
    input.acceptText(PANEL, 'web:1', 'é')
    input.accept(PANEL, 'web:1', [pkey('a')])
    input.viewGone('web:1')
    expect(timers.size).toBe(0)
    d.list[0]?.resolve(undefined)
    await flush()
    expect(order).toEqual(['text é'])
  })
})

describe('acceptChoice: the current popup id only, once; bounds and disabled options refused', () => {
  async function opened() {
    const s = pressSetup()
    s.input.accept(PANEL, 'web:1', [pdown(20, 30), pup(20, 30)])
    s.hits[0]?.resolve(SELECT_RESULT)
    await s.flush()
    return s
  }

  it('sets the chosen option through the page, once', async () => {
    const { input, chosen } = await opened()
    expect(input.acceptChoice(PANEL, 'web:1', ID, 1)).toBe(true)
    expect(chosen).toEqual([[ID, 1]])
    // Stale now.
    expect(input.acceptChoice(PANEL, 'web:1', ID, 0)).toBe(false)
    expect(chosen).toEqual([[ID, 1]])
  })

  it('ignores a forged id, another view\'s answer and an answer with no popup open', async () => {
    const { input, chosen } = await opened()
    expect(input.acceptChoice(PANEL, 'web:1', ID2, 1)).toBe(false)
    expect(input.acceptChoice(PANEL, 'web:1', { id: ID }, 1)).toBe(false)
    expect(input.acceptChoice(PANEL, 'web:2', ID, 1)).toBe(false)
    expect(chosen).toEqual([])
    // Still open for its own view.
    expect(input.acceptChoice(PANEL, 'web:1', ID, 0)).toBe(true)
    const none = pressSetup()
    expect(none.input.acceptChoice(PANEL, 'web:1', ID, 0)).toBe(false)
  })

  it('a newer popup replaces the older one: the old id is ignored', async () => {
    const s = await opened()
    s.input.accept(PANEL, 'web:1', [pdown(20, 30), pup(20, 30)])
    s.hits[1]?.resolve(SELECT_RESULT)
    await s.flush()
    expect(s.popups.map(([, p]) => p.id)).toEqual([ID, ID2])
    expect(s.input.acceptChoice(PANEL, 'web:1', ID, 1)).toBe(false)
    expect(s.input.acceptChoice(PANEL, 'web:1', ID2, 1)).toBe(true)
    expect(s.chosen).toEqual([[ID2, 1]])
  })

  it('a disabled or unlisted option closes the popup with no choice; null closes it', async () => {
    for (const index of [2, 3, null]) {
      const { input, chosen } = await opened()
      expect(input.acceptChoice(PANEL, 'web:1', ID, index)).toBe(false)
      // The page forgets the element; nothing is set.
      expect(chosen).toEqual([[ID, null]])
      expect(input.acceptChoice(PANEL, 'web:1', ID, 0)).toBe(false)
    }
  })

  it.each([
    ['a negative index', -1],
    ['an index past the cap', MAX_SELECT_OPTIONS],
    ['a fraction', 0.5],
    ['a string', '1'],
    ['undefined', undefined]
  ])('throws for %s', async (_name, index) => {
    const { input, chosen } = await opened()
    expect(() => input.acceptChoice(PANEL, 'web:1', ID, index)).toThrow(/index must be/)
    expect(chosen).toEqual([])
  })

  it('throws for a view that is no viewer', async () => {
    const { input, viewers } = await opened()
    viewers.report(PANEL, 'web:1', { ...shown, visible: false })
    expect(() => input.acceptChoice(PANEL, 'web:1', ID, 1)).toThrow(/not a viewer/)
  })

  it('a view that went has no popup', async () => {
    const { input, chosen } = await opened()
    input.viewGone('web:1')
    expect(input.acceptChoice(PANEL, 'web:1', ID, 1)).toBe(false)
    expect(chosen).toEqual([])
  })
})

describe('WebviewManager.inputTarget: the select calls go to the live page only', () => {
  it('passes hitSelect and chooseSelect, and answers nothing once the view is gone', async () => {
    const calls: string[] = []
    const manager = new WebviewManager({
      views: {
        create: (): WebviewView => ({
          load: () => Promise.resolve(),
          back: () => {},
          forward: () => {},
          reload: () => {},
          current: () => ({ url: '', title: '' }),
          isFocused: () => false,
          setBounds: () => {},
          setVisible: () => {},
          destroy: () => {},
          size: () => ({ width: 640, height: 480 }),
          sendInput: () => {},
          hitSelect: (x, y, id) => {
            calls.push(`hit ${x} ${y} ${id}`)
            return Promise.resolve('hit')
          },
          chooseSelect: (id, index) => {
            calls.push(`choose ${id} ${index}`)
            return Promise.resolve(true)
          }
        })
      },
      openExternal: () => {},
      isWindowOpen: () => true,
      homeDir: () => '/nonexistent-home',
      tempRoots: () => [],
      server: true,
      log: () => {}
    })
    await manager.navigate({ windowId: 7, projectId: 'P1', pluginId: 'a.one', panelId: 'view' }, 'https://example.com/', undefined, { now: true })
    const target = manager.inputTarget(7, 'a.one', 'view')
    await expect(target?.hitSelect?.(1, 2, ID)).resolves.toBe('hit')
    await expect(target?.chooseSelect?.(ID, 3)).resolves.toBe(true)
    manager.destroyPlugin(7, 'a.one')
    await expect(target?.hitSelect?.(1, 2, ID)).resolves.toBeUndefined()
    await expect(target?.chooseSelect?.(ID, 3)).resolves.toBe(false)
    expect(calls).toEqual([`hit 1 2 ${ID}`, `choose ${ID} 3`])
  })
})

// ---------------------------------------------------------------------------------------------
// The browser's menu (web/webview-select.ts).

const opts = (...spec: Array<string | [string, boolean]>): WebviewSelectOption[] =>
  spec.map((s, index) => (typeof s === 'string' ? { index, label: s, disabled: false } : { index, label: s[0], disabled: s[1] }))

describe('the browser menu: placed over the select as drawn', () => {
  it('maps the page rectangle through the frame scale and the letterbox', () => {
    // The owner's frame: 1:1 at the top left.
    const frame = { width: 800, height: 600, scale: 1 }
    expect(pageRectToArea(letterbox(800, 600, frame), frame, { x: 10, y: 20, width: 150, height: 24 })).toEqual({ x: 10, y: 20, width: 150, height: 24 })
    // A HiDPI frame (encoded at 2x) in a box half the page's width: half size, centred vertically.
    const hidpi = { width: 1600, height: 1200, scale: 2 }
    const box = letterbox(400, 600, hidpi)
    expect(pageRectToArea(box, hidpi, { x: 100, y: 100, width: 200, height: 20 })).toEqual({ x: 50, y: 150 + 50, width: 100, height: 10 })
    expect(pageRectToArea(letterbox(0, 0, frame), frame, { x: 1, y: 1, width: 1, height: 1 })).toBeUndefined()
  })

  it('goes below the select, flips above near the bottom, and stays inside the area', () => {
    const area = { width: 800, height: 600 }
    expect(placeMenu({ x: 10, y: 20, width: 150, height: 24 }, area, 200)).toEqual({ left: 10, width: 150, top: 44, maxHeight: 552 })
    const low = placeMenu({ x: 10, y: 500, width: 150, height: 24 }, area, 200)
    expect(low).toEqual({ left: 10, width: 150, bottom: 100, maxHeight: 496 })
    // Narrow select: the least width; near the right edge: moved in.
    expect(placeMenu({ x: 780, y: 20, width: 20, height: 24 }, area, 100)).toMatchObject({ left: 800 - 4 - MENU_MIN_WIDTH, width: MENU_MIN_WIDTH })
    // Little room either way: the larger side, never a negative height.
    expect(placeMenu({ x: 0, y: 10, width: 150, height: 24 }, { width: 800, height: 40 }, 300)).toMatchObject({ bottom: 30, maxHeight: 6 })
    // A select scrolled out of the top: clamped in.
    expect(placeMenu({ x: 0, y: -100, width: 150, height: 24 }, area, 100)).toMatchObject({ top: 0 })
  })
})

describe('the browser menu: keys', () => {
  const list = opts(['Off', true], 'Apple', 'Avocado', ['Apricot', true], 'Banana', 'blueberry', 'Cherry')

  it('opens on the selected option, or the first enabled one', () => {
    expect(initialActive(list, 4)).toBe(4)
    expect(initialActive(list, 0)).toBe(1)
    expect(initialActive(list, -1)).toBe(1)
    expect(initialActive(opts(['x', true]), 0)).toBe(-1)
  })

  it('arrows, Home, End and pages skip disabled options and stop at the ends', () => {
    expect(moveActive(list, 1, 'ArrowDown')).toBe(2)
    expect(moveActive(list, 2, 'ArrowDown')).toBe(4)
    expect(moveActive(list, 6, 'ArrowDown')).toBe(6)
    expect(moveActive(list, 4, 'ArrowUp')).toBe(2)
    expect(moveActive(list, 1, 'ArrowUp')).toBe(1)
    expect(moveActive(list, 4, 'Home')).toBe(1)
    expect(moveActive(list, 1, 'End')).toBe(6)
    expect(moveActive(list, 1, 'PageDown', 2)).toBe(2)
    expect(moveActive(list, 1, 'PageDown')).toBe(6)
    expect(moveActive(list, 6, 'PageUp')).toBe(1)
    expect(moveActive(list, 1, 'a')).toBeUndefined()
  })

  it('type-ahead: a prefix, case-insensitive, skipping disabled; one letter again cycles', () => {
    expect(typeAhead(list, 1, 'b')).toBe(4)
    expect(typeAhead(list, 4, 'b')).toBe(5)
    expect(typeAhead(list, 5, 'b')).toBe(4)
    expect(typeAhead(list, 1, 'av')).toBe(2)
    expect(typeAhead(list, 1, 'ap')).toBe(1)
    // 'aa' is the letter a again: on to the next a-option (Apricot is disabled).
    expect(typeAhead(list, 2, 'aa')).toBe(1)
    expect(typeAhead(list, 1, 'z')).toBe(-1)
    expect(typeAhead(list, 1, 'off')).toBe(-1)
  })

  it('groups consecutive options for the headings', () => {
    const grouped: WebviewSelectOption[] = [
      { index: 0, label: 'a', disabled: false },
      { index: 1, label: 'b', disabled: false, group: 'G' },
      { index: 2, label: 'c', disabled: false, group: 'G' },
      { index: 3, label: 'd', disabled: false }
    ]
    expect(groupRuns(grouped).map((r) => [r.group, r.from, r.items.length])).toEqual([
      [undefined, 0, 1],
      ['G', 1, 2],
      [undefined, 3, 1]
    ])
  })
})
