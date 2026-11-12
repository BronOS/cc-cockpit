// design-web-browser.md §4.1, §5 (plan 20261111-streamed-webviews.md Task 7): pointer, wheel and
// keys from a server's browser view into its streamed page. Main's side (webview-input.ts): the
// checks, the rate cap, viewers only, the owner rule, the mapping to sendInputEvent, the manager's
// input target; the shared key and cursor tables; the browser's side (web/webview-stream.ts): page
// coordinates through the letterbox and the scale, the key split (shell chords, clipboard chords),
// the outbox, click counts and wheel units. The router's gate is in ipc-router.test.ts.
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  claimsOwner,
  cleanSelection,
  cursorEvent,
  encodedBytes,
  MAX_SELECTION_BYTES,
  MAX_SELECTION_CHARS,
  MAX_TEXT_BYTES,
  SELECTION_SCRIPT,
  type InputModifier,
  INPUT_BURST,
  INPUT_RATE,
  MAX_INPUT_EVENTS,
  MAX_WHEEL_DELTA,
  parseInputEvents,
  toElectronEvents,
  WebviewInput,
  type ElectronInputEvent,
  type WebviewInputEvent
} from '../../src/main/webview/webview-input'
import { WebviewViewers, type WebviewPanelOf } from '../../src/main/webview/webview-viewers'
import { WebviewManager, type WebviewView } from '../../src/main/webview/webview-manager'
import { REMOTE_CLASS, type WebviewInputEventWire } from '../../src/shared/ipc'
import { MAX_FRAME_BYTES } from '../../src/shared/web-protocol'
import { WEBVIEW_CURSORS, webviewCursor, webviewKeyChar, webviewKeyCode } from '../../src/shared/webview-keys'
import {
  boxToPage,
  ClickCounter,
  inputModifiers,
  InputQueue,
  isClipboardChord,
  letterbox,
  MAX_INPUT_BATCH,
  MULTI_CLICK_MS,
  MAX_TEXT_CHUNKS,
  pointerButton,
  TEXT_CHUNK_UNITS,
  textChunks,
  webviewKeyAction,
  wheelPixels,
  WHEEL_LINE_PX,
  type InputKeyEventLike
} from '../../src/renderer/web/webview-stream'

const PANEL: WebviewPanelOf = { windowId: 7, pluginId: 'a.one', panelId: 'view' }
const OTHER_WINDOW: WebviewPanelOf = { windowId: 8, pluginId: 'a.one', panelId: 'view' }
const shown = { width: 800, height: 600, visible: true, hidden: false }

const move = (x: number, y: number): WebviewInputEventWire => ({ kind: 'pointer', type: 'move', x, y })
const down = (x: number, y: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'pointer',
  type: 'down',
  x,
  y,
  button: 'left',
  clickCount: 1,
  ...extra
})
const key = (k: string, type: 'down' | 'up' = 'down', modifiers: string[] = []): Record<string, unknown> => ({ kind: 'key', type, key: k, modifiers })

/** A WebviewInput over real viewers and a recording page of 800x600. */
function setup(options: { size?: { width: number; height: number }; page?: boolean } = {}) {
  let t = 10_000
  const viewers = new WebviewViewers({ setViewed: () => {}, setSize: () => {}, now: () => t })
  const sent: ElectronInputEvent[][] = []
  const claims: string[] = []
  const input = new WebviewInput({
    isViewer: (panel, viewId) => viewers.isViewer(panel, viewId),
    claimOwner: (panel, viewId) => {
      claims.push(viewId)
      viewers.claimOwner(panel, viewId)
    },
    target: (panel) =>
      options.page === false || panel.windowId !== PANEL.windowId
        ? undefined
        : { size: () => options.size ?? { width: 800, height: 600 }, send: (events) => void sent.push([...events]) },
    now: () => t
  })
  return {
    viewers,
    input,
    sent,
    claims,
    advance: (ms: number) => {
      t += ms
    }
  }
}

describe('parseInputEvents: every field checked, the call refused whole', () => {
  it('takes pointer, wheel and key events with the allowed fields', () => {
    expect(
      parseInputEvents([
        move(1, 2),
        down(3, 4, { button: 'right', clickCount: 3, modifiers: ['shift', 'leftbuttondown', 'shift'] }),
        { kind: 'wheel', x: 5, y: 6, deltaX: 1e9, deltaY: -1e9 },
        key('a'),
        key('ArrowUp', 'up', ['control', 'isautorepeat'])
      ])
    ).toEqual([
      { kind: 'pointer', type: 'move', x: 1, y: 2, modifiers: [] },
      { kind: 'pointer', type: 'down', x: 3, y: 4, button: 'right', clickCount: 3, modifiers: ['shift', 'leftbuttondown'] },
      // Deltas clamped, never refused.
      { kind: 'wheel', x: 5, y: 6, deltaX: MAX_WHEEL_DELTA, deltaY: -MAX_WHEEL_DELTA, modifiers: [] },
      { kind: 'key', type: 'down', key: 'a', modifiers: [] },
      { kind: 'key', type: 'up', key: 'ArrowUp', modifiers: ['control', 'isautorepeat'] }
    ])
  })

  it('a click count defaults to 1', () => {
    expect(parseInputEvents([down(1, 1, { clickCount: undefined })])[0]).toMatchObject({ clickCount: 1 })
  })

  it.each([
    ['not a list', { kind: 'pointer' }],
    ['a non-object event', ['move']],
    ['an unknown kind', [{ kind: 'touch', x: 1, y: 1 }]],
    ['an unknown pointer type', [{ kind: 'pointer', type: 'drag', x: 1, y: 1 }]],
    ['NaN', [move(Number.NaN, 1)]],
    ['Infinity', [move(1, Infinity)]],
    ['a string coordinate', [{ kind: 'pointer', type: 'move', x: '1', y: 1 }]],
    ['a negative coordinate', [move(-1, 1)]],
    ['a coordinate past any page', [move(5000, 1)]],
    ['an unknown button', [down(1, 1, { button: 'back' })]],
    ['no button on a press', [down(1, 1, { button: undefined })]],
    ['clickCount 0', [down(1, 1, { clickCount: 0 })]],
    ['clickCount 4', [down(1, 1, { clickCount: 4 })]],
    ['clickCount 1.5', [down(1, 1, { clickCount: 1.5 })]],
    ['a NaN wheel delta', [{ kind: 'wheel', x: 1, y: 1, deltaX: Number.NaN, deltaY: 0 }]],
    ['an unknown modifier', [{ ...move(1, 1), modifiers: ['hyper'] }]],
    ['a modifier that is no string', [{ ...move(1, 1), modifiers: [1] }]],
    ['modifiers that are not a list', [{ ...move(1, 1), modifiers: 'shift' }]],
    ['too many modifiers', [{ ...move(1, 1), modifiers: Array(9).fill('shift') }]],
    ['an unknown key type', [{ kind: 'key', type: 'press', key: 'a' }]]
  ])('refuses %s', (_name, events) => {
    expect(() => parseInputEvents(events)).toThrow(/^webviews\.input: /)
  })

  it.each(['Shift', 'Control', 'Dead', 'Process', 'é', 'ab', 'F13', 'MediaPlayPause', 'constructor', '__proto__', '', 'x'.repeat(10_000)])(
    'refuses the key %j',
    (k) => {
      expect(() => parseInputEvents([key(k)])).toThrow(/unknown key/)
    }
  )

  it(`refuses more than ${MAX_INPUT_EVENTS} events in one call`, () => {
    expect(parseInputEvents(Array(MAX_INPUT_EVENTS).fill(move(1, 1)))).toHaveLength(MAX_INPUT_EVENTS)
    expect(() => parseInputEvents(Array(MAX_INPUT_EVENTS + 1).fill(move(1, 1)))).toThrow(/at most 64/)
  })
})

describe('the key allow-list and the cursor table (shared/webview-keys.ts)', () => {
  it('maps DOM key names to Electron keyCodes', () => {
    for (const k of ['a', 'Z', '0', '9', '!', '+', '\\', '"', '~']) expect(webviewKeyCode(k)).toBe(k)
    expect(webviewKeyCode(' ')).toBe('Space')
    expect(webviewKeyCode('ArrowUp')).toBe('Up')
    expect(webviewKeyCode('ArrowLeft')).toBe('Left')
    expect(webviewKeyCode('Enter')).toBe('Enter')
    for (const k of ['Tab', 'Backspace', 'Delete', 'Escape', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'F1', 'F12']) {
      expect(webviewKeyCode(k)).toBe(k)
    }
    for (const k of ['F13', 'F0', 'Space', 'Up', 'Return', 'toString', 'hasOwnProperty', 7, null]) expect(webviewKeyCode(k)).toBeUndefined()
  })

  it('types a char only for printable keys, Space and Enter, without Ctrl, Meta or Alt', () => {
    const none = { control: false, meta: false, alt: false }
    expect(webviewKeyChar('a', none)).toBe('a')
    expect(webviewKeyChar(' ', none)).toBe(' ')
    expect(webviewKeyChar('Enter', none)).toBe('\r')
    expect(webviewKeyChar('Backspace', none)).toBeUndefined()
    expect(webviewKeyChar('ArrowUp', none)).toBeUndefined()
    expect(webviewKeyChar('a', { ...none, control: true })).toBeUndefined()
    expect(webviewKeyChar('a', { ...none, meta: true })).toBeUndefined()
    expect(webviewKeyChar('Enter', { ...none, alt: true })).toBeUndefined()
  })

  it("maps Chromium's cursor names to CSS from a fixed table, the arrow for anything else", () => {
    expect(webviewCursor('hand')).toBe('pointer')
    expect(webviewCursor('pointer')).toBe('default')
    expect(webviewCursor('text')).toBe('text')
    expect(webviewCursor('nodrop')).toBe('no-drop')
    expect(webviewCursor('url(https://evil.test/x.png), auto')).toBe('default')
    expect(webviewCursor('constructor')).toBe('default')
    expect(webviewCursor(undefined)).toBe('default')
    expect(WEBVIEW_CURSORS.has('pointer')).toBe(true)
    expect(cursorEvent(PANEL, 'hand')).toEqual({ panelKey: 'a.one/view', cursor: 'pointer' })
  })
})

describe('toElectronEvents: what reaches sendInputEvent', () => {
  const size = { width: 800, height: 600 }
  const ev = (raw: Record<string, unknown> | WebviewInputEventWire): WebviewInputEvent => parseInputEvents([raw])[0] as WebviewInputEvent

  it('pointer events: whole px, the far edge on the last pixel, buttons held on moves', () => {
    expect(toElectronEvents(ev({ ...move(10.6, 20.2), modifiers: ['leftbuttondown'] }), size)).toEqual([
      { type: 'mouseMove', x: 11, y: 20, modifiers: ['leftbuttondown'] }
    ])
    expect(toElectronEvents(ev(down(800, 600, { clickCount: 2 })), size)).toEqual([
      { type: 'mouseDown', x: 799, y: 599, button: 'left', clickCount: 2, modifiers: [] }
    ])
    expect(toElectronEvents(ev({ ...down(1, 1), type: 'up', button: 'middle' }), size)).toEqual([
      { type: 'mouseUp', x: 1, y: 1, button: 'middle', clickCount: 1, modifiers: [] }
    ])
  })

  it("wheel: the DOM's sign turned into Chromium's", () => {
    expect(toElectronEvents(ev({ kind: 'wheel', x: 5, y: 5, deltaX: 10, deltaY: 120 }), size)).toEqual([
      { type: 'mouseWheel', x: 5, y: 5, deltaX: -10, deltaY: -120, modifiers: [] }
    ])
  })

  it('keys: a down that types gets its char; a shortcut and a named key do not', () => {
    expect(toElectronEvents(ev(key('a', 'down', ['shift'])), size)).toEqual([
      { type: 'keyDown', keyCode: 'a', modifiers: ['shift'] },
      { type: 'char', keyCode: 'a', modifiers: ['shift'] }
    ])
    expect(toElectronEvents(ev(key('Enter')), size)).toEqual([
      { type: 'keyDown', keyCode: 'Enter', modifiers: [] },
      { type: 'char', keyCode: '\r', modifiers: [] }
    ])
    expect(toElectronEvents(ev(key(' ')), size)).toEqual([
      { type: 'keyDown', keyCode: 'Space', modifiers: [] },
      { type: 'char', keyCode: ' ', modifiers: [] }
    ])
    expect(toElectronEvents(ev(key('a', 'down', ['control'])), size)).toEqual([{ type: 'keyDown', keyCode: 'a', modifiers: ['control'] }])
    expect(toElectronEvents(ev(key('Backspace')), size)).toEqual([{ type: 'keyDown', keyCode: 'Backspace', modifiers: [] }])
    expect(toElectronEvents(ev(key('ArrowDown', 'up')), size)).toEqual([{ type: 'keyUp', keyCode: 'Down', modifiers: [] }])
  })

  it('a press, a key down and a wheel claim the size; a move and a release do not', () => {
    expect(claimsOwner(ev(down(1, 1)))).toBe(true)
    expect(claimsOwner(ev(key('a')))).toBe(true)
    expect(claimsOwner(ev({ kind: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 1 }))).toBe(true)
    expect(claimsOwner(ev(move(1, 1)))).toBe(false)
    expect(claimsOwner(ev({ ...down(1, 1), type: 'up' }))).toBe(false)
    expect(claimsOwner(ev(key('a', 'up')))).toBe(false)
  })
})

describe('WebviewInput.accept', () => {
  it('sends a viewer\'s events to the page, in order', () => {
    const { viewers, input, sent } = setup()
    viewers.report(PANEL, 'web:1', shown)
    expect(input.accept(PANEL, 'web:1', [move(10, 10), down(10, 10), { ...down(10, 10), type: 'up' }, key('b')])).toBe(4)
    expect(sent).toEqual([
      [
        { type: 'mouseMove', x: 10, y: 10, modifiers: [] },
        { type: 'mouseDown', x: 10, y: 10, button: 'left', clickCount: 1, modifiers: [] },
        { type: 'mouseUp', x: 10, y: 10, button: 'left', clickCount: 1, modifiers: [] },
        { type: 'keyDown', keyCode: 'b', modifiers: [] },
        { type: 'char', keyCode: 'b', modifiers: [] }
      ]
    ])
  })

  it('refuses a view that is not a viewer: never reported, hidden, gone, or of another window', () => {
    const { viewers, input, sent } = setup()
    expect(() => input.accept(PANEL, 'web:1', [move(1, 1)])).toThrow(/not a viewer/)
    viewers.report(PANEL, 'web:1', { ...shown, hidden: true })
    expect(() => input.accept(PANEL, 'web:1', [move(1, 1)])).toThrow(/not a viewer/)
    viewers.report(PANEL, 'web:1', shown)
    viewers.viewGone('web:1')
    expect(() => input.accept(PANEL, 'web:1', [move(1, 1)])).toThrow(/not a viewer/)
    // A viewer of the same panel key in another window is no viewer of this window's panel (the
    // router resolves the key in the caller's own window, so it can only name OTHER_WINDOW).
    viewers.report(OTHER_WINDOW, 'web:2', shown)
    expect(() => input.accept(PANEL, 'web:2', [move(1, 1)])).toThrow(/not a viewer/)
    expect(sent).toEqual([])
  })

  it('refuses a malformed call whole, sending nothing', () => {
    const { viewers, input, sent, claims } = setup()
    viewers.report(PANEL, 'web:1', shown)
    expect(() => input.accept(PANEL, 'web:1', [down(1, 1), key('Meta')])).toThrow(/unknown key/)
    expect(() => input.accept(PANEL, 'web:1', 'events')).toThrow(/must be a list/)
    expect(sent).toEqual([])
    expect(claims).toEqual([])
  })

  it('drops points outside the page, keeps the rest of the call', () => {
    const { viewers, input, sent } = setup({ size: { width: 400, height: 300 } })
    viewers.report(PANEL, 'web:1', shown)
    expect(input.accept(PANEL, 'web:1', [move(401, 10), move(10, 301), { ...down(400, 300), type: 'up' }])).toBe(1)
    expect(sent).toEqual([[{ type: 'mouseUp', x: 399, y: 299, button: 'left', clickCount: 1, modifiers: [] }]])
  })

  it('takes nothing for a panel with no page yet', () => {
    const { viewers, input, sent } = setup({ page: false })
    viewers.report(PANEL, 'web:1', shown)
    expect(input.accept(PANEL, 'web:1', [down(1, 1)])).toBe(0)
    expect(sent).toEqual([])
  })

  it(`caps each view at ${INPUT_RATE} events per second, dropping the rest silently`, () => {
    const { viewers, input, sent, advance } = setup()
    viewers.report(PANEL, 'web:1', shown)
    viewers.report(PANEL, 'web:2', shown)
    const batch = Array(MAX_INPUT_EVENTS).fill(move(1, 1))
    let taken = 0
    for (let i = 0; i < 20; i++) taken += input.accept(PANEL, 'web:1', batch)
    expect(taken).toBe(INPUT_BURST)
    expect(input.accept(PANEL, 'web:1', batch)).toBe(0)
    // Another view has its own bucket.
    expect(input.accept(PANEL, 'web:2', batch)).toBe(MAX_INPUT_EVENTS)
    // A tenth of a second refills a tenth of the rate.
    advance(100)
    expect(input.accept(PANEL, 'web:1', batch)).toBe(INPUT_RATE / 10)
    // A clock going back refills nothing.
    advance(-5000)
    expect(input.accept(PANEL, 'web:1', batch)).toBe(0)
    // The view's socket closed: a new one with the same id starts full.
    input.viewGone('web:1')
    viewers.report(PANEL, 'web:1', shown)
    expect(input.accept(PANEL, 'web:1', batch)).toBe(MAX_INPUT_EVENTS)
    expect(sent.flat().length).toBeGreaterThan(0)
  })

  it('a press, a key or a wheel makes the sender the size owner; a move does not', () => {
    const { viewers, input, claims } = setup()
    viewers.report(PANEL, 'web:1', shown)
    viewers.report(PANEL, 'web:2', { ...shown, width: 500, height: 400 })
    expect(viewers.ownerOf(PANEL)).toBe('web:1')
    input.accept(PANEL, 'web:2', [move(5, 5), move(6, 6)])
    expect(claims).toEqual([])
    expect(viewers.ownerOf(PANEL)).toBe('web:1')
    input.accept(PANEL, 'web:2', [down(5, 5)])
    expect(viewers.ownerOf(PANEL)).toBe('web:2')
    input.accept(PANEL, 'web:1', [key('x')])
    expect(viewers.ownerOf(PANEL)).toBe('web:1')
    input.accept(PANEL, 'web:2', [{ kind: 'wheel', x: 5, y: 5, deltaX: 0, deltaY: 50 }])
    expect(viewers.ownerOf(PANEL)).toBe('web:2')
    // A press outside the page claims nothing (it is dropped).
    claims.length = 0
    input.accept(PANEL, 'web:1', [down(801, 10)])
    expect(claims).toEqual([])
    expect(viewers.ownerOf(PANEL)).toBe('web:2')
    input.accept(PANEL, 'web:1', [down(800, 600)])
    expect(claims).toEqual(['web:1'])
  })
})

describe('WebviewManager.inputTarget', () => {
  interface Fake extends WebviewView {
    input: ElectronInputEvent[][]
    texts: string[]
  }

  function managerFor(server: boolean, withInput = true): { manager: WebviewManager; made: Fake[] } {
    const made: Fake[] = []
    const manager = new WebviewManager({
      views: {
        create: () => {
          const v: Fake = {
            input: [],
            texts: [],
            load: () => Promise.resolve(),
            back: () => {},
            forward: () => {},
            reload: () => {},
            current: () => ({ url: '', title: '' }),
            isFocused: () => false,
            setBounds: () => {},
            setVisible: () => {},
            destroy: () => {},
            ...(withInput
              ? {
                  size: () => ({ width: 640, height: 480 }),
                  sendInput: (events: readonly ElectronInputEvent[]) => void v.input.push([...events]),
                  insertText: (text: string) => void v.texts.push(text),
                  readSelection: () => Promise.resolve('sel')
                }
              : {})
          }
          made.push(v)
          return v
        }
      },
      openExternal: () => {},
      isWindowOpen: () => true,
      homeDir: () => '/nonexistent-home',
      tempRoots: () => [],
      server,
      log: () => {}
    })
    return { manager, made }
  }
  const owner = { windowId: 7, projectId: 'P1', pluginId: 'a.one', panelId: 'view' }
  const ev: ElectronInputEvent = { type: 'mouseMove', x: 1, y: 1, modifiers: [] }

  it("is the live off-screen page's size and input, in server mode only", async () => {
    const { manager, made } = managerFor(true)
    expect(manager.inputTarget(7, 'a.one', 'view')).toBeUndefined()
    await manager.navigate(owner, 'https://example.com/', undefined, { now: true })
    const target = manager.inputTarget(7, 'a.one', 'view')
    expect(target?.size()).toEqual({ width: 640, height: 480 })
    target?.send([ev])
    expect(made[0]?.input).toEqual([[ev]])
    // Task 8: text and the selection go to the same live page.
    target?.insertText?.('é')
    expect(made[0]?.texts).toEqual(['é'])
    await expect(target?.readSelection?.()).resolves.toBe('sel')
    // Another window's panel of the same key has no view: nothing.
    expect(manager.inputTarget(8, 'a.one', 'view')).toBeUndefined()
    // The view goes (the plugin stopped): a target handed out before sends nothing.
    manager.destroyPlugin(7, 'a.one')
    target?.send([ev])
    target?.insertText?.('x')
    expect(made[0]?.input).toEqual([[ev]])
    expect(made[0]?.texts).toEqual(['é'])
    await expect(target?.readSelection?.()).resolves.toBeUndefined()
    expect(manager.inputTarget(7, 'a.one', 'view')).toBeUndefined()
  })

  it('is undefined on the desktop and for a view with no input', async () => {
    const desktop = managerFor(false)
    await desktop.manager.navigate(owner, 'https://example.com/')
    expect(desktop.manager.inputTarget(7, 'a.one', 'view')).toBeUndefined()
    const plain = managerFor(true, false)
    await plain.manager.navigate(owner, 'https://example.com/', undefined, { now: true })
    expect(plain.manager.inputTarget(7, 'a.one', 'view')).toBeUndefined()
  })
})

describe("the browser's side (web/webview-stream.ts)", () => {
  it('maps box px to page px through the letterbox and the frame scale; nothing in the bars', () => {
    // A 2560x1440 page encoded at 0.75 (1920x1080 frame px) in a 1280x1000 box: drawn 1280x720 at y 140.
    const frame = { width: 1920, height: 1080, scale: 0.75 }
    const lb = letterbox(1280, 1000, frame)
    expect(lb).toMatchObject({ x: 0, y: 140, width: 1280, height: 720 })
    expect(boxToPage(lb, frame, 640, 500)).toEqual({ x: 1280, y: 720 })
    expect(boxToPage(lb, frame, 0, 140)).toEqual({ x: 0, y: 0 })
    expect(boxToPage(lb, frame, 640, 100)).toBeUndefined()
    expect(boxToPage(lb, frame, 640, 900)).toBeUndefined()
    // Under capture (a drag that left the frame): clamped to the edge.
    expect(boxToPage(lb, frame, -50, 100, true)).toEqual({ x: 0, y: 0 })
    expect(boxToPage(lb, frame, Number.NaN, 100, true)).toBeUndefined()
    // The owner's frame, 1:1.
    const own = { width: 800, height: 600, scale: 1 }
    expect(boxToPage(letterbox(800, 600, own), own, 100.5, 200)).toEqual({ x: 100.5, y: 200 })
  })

  const keyEvent = (k: string, mods: Partial<InputKeyEventLike> = {}): InputKeyEventLike => ({
    key: k,
    code: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods
  })
  const noCommands = (): boolean => false

  it("leaves the shell's command chords to the shell (its own table), forwards allow-listed keys", () => {
    // The shell's table has Ctrl+T and Ctrl+Shift+P bound (commandForEvent in the app).
    const commands = new Set(['t', 'P'])
    const isCommand = (e: { key: string; ctrlKey: boolean }): boolean => e.ctrlKey && commands.has(e.key)
    expect(webviewKeyAction(keyEvent('t', { ctrlKey: true }), isCommand)).toBe('shell')
    expect(webviewKeyAction(keyEvent('P', { ctrlKey: true, shiftKey: true }), isCommand)).toBe('shell')
    // The window's capture handler already took it.
    expect(webviewKeyAction(keyEvent('a', { defaultPrevented: true }), noCommands)).toBe('shell')
    expect(webviewKeyAction(keyEvent('a', { ctrlKey: true }), isCommand)).toBe('forward')
    expect(webviewKeyAction(keyEvent('t'), isCommand)).toBe('forward')
    expect(webviewKeyAction(keyEvent('Enter'), isCommand)).toBe('forward')
    expect(webviewKeyAction(keyEvent('F5'), isCommand)).toBe('forward')
    // Not keys of the page: modifiers alone, an IME's composition, a dead key, non-ASCII text (Task 8).
    for (const e of [keyEvent('Shift', { shiftKey: true }), keyEvent('Control'), keyEvent('a', { isComposing: true }), keyEvent('Process'), keyEvent('Dead'), keyEvent('é')]) {
      expect(webviewKeyAction(e, noCommands)).toBe('ignore')
    }
  })

  it('never forwards a clipboard chord, on any platform or layout', () => {
    for (const k of ['c', 'x', 'v', 'C', 'V']) {
      expect(webviewKeyAction(keyEvent(k, { ctrlKey: true }), noCommands)).toBe('clipboard')
      expect(webviewKeyAction(keyEvent(k, { metaKey: true }), noCommands)).toBe('clipboard')
      expect(webviewKeyAction(keyEvent(k, { ctrlKey: true, shiftKey: true }), noCommands)).toBe('clipboard')
    }
    // A Russian layout's Ctrl+C: another key, the same physical key.
    expect(webviewKeyAction(keyEvent('с', { ctrlKey: true, code: 'KeyC' }), noCommands)).toBe('clipboard')
    expect(webviewKeyAction(keyEvent('Insert', { shiftKey: true }), noCommands)).toBe('clipboard')
    expect(webviewKeyAction(keyEvent('Insert', { ctrlKey: true }), noCommands)).toBe('clipboard')
    expect(webviewKeyAction(keyEvent('Delete', { shiftKey: true }), noCommands)).toBe('clipboard')
    // Plain letters, plain Insert and Delete are typing.
    expect(isClipboardChord(keyEvent('c'))).toBe(false)
    expect(isClipboardChord(keyEvent('Insert'))).toBe(false)
    expect(isClipboardChord(keyEvent('Delete'))).toBe(false)
    // A shell command chord on a clipboard key stays the shell's.
    expect(webviewKeyAction(keyEvent('c', { ctrlKey: true }), () => true)).toBe('shell')
  })

  it('names modifiers and held buttons as Electron does, and only three buttons', () => {
    expect(inputModifiers({ shiftKey: true, ctrlKey: true, altKey: true, metaKey: true, buttons: 7, repeat: true })).toEqual([
      'shift',
      'control',
      'alt',
      'meta',
      'leftbuttondown',
      'middlebuttondown',
      'rightbuttondown',
      'isautorepeat'
    ])
    expect(inputModifiers({ shiftKey: false, ctrlKey: false, altKey: false, metaKey: false })).toEqual([])
    expect([0, 1, 2, 3, 4].map(pointerButton)).toEqual(['left', 'middle', 'right', undefined, undefined])
  })

  it('counts clicks up to three for the same button, close in time and space', () => {
    const c = new ClickCounter()
    expect(c.press('left', 10, 10, 0)).toBe(1)
    expect(c.press('left', 11, 11, 200)).toBe(2)
    expect(c.current()).toBe(2)
    expect(c.press('left', 11, 11, 400)).toBe(3)
    expect(c.press('left', 11, 11, 500)).toBe(1)
    expect(c.press('right', 11, 11, 600)).toBe(1)
    expect(c.press('right', 11, 11, 600 + MULTI_CLICK_MS + 1)).toBe(1)
    expect(c.press('right', 30, 11, 700 + MULTI_CLICK_MS)).toBe(1)
  })

  it('turns wheel lines and pages into px', () => {
    expect(wheelPixels(0, 3, -4, 600)).toEqual({ deltaX: 3, deltaY: -4 })
    expect(wheelPixels(1, 0, 3, 600)).toEqual({ deltaX: 0, deltaY: 3 * WHEEL_LINE_PX })
    expect(wheelPixels(2, 0, 1, 600)).toEqual({ deltaX: 0, deltaY: 600 })
    expect(wheelPixels(0, Number.NaN, 1, 600)).toEqual({ deltaX: 0, deltaY: 1 })
  })

  it('the outbox: one call per animation frame, moves coalesced, wheels summed, the rest in order', () => {
    const calls: WebviewInputEventWire[][] = []
    let due: (() => void) | undefined
    const q = new InputQueue((events) => void calls.push(events), {
      frame: (fn) => {
        due = fn
        return 1
      },
      cancel: () => {
        due = undefined
      }
    })
    q.push(move(1, 1))
    q.push(move(2, 2))
    q.push({ kind: 'pointer', type: 'down', x: 2, y: 2, button: 'left', clickCount: 1 })
    q.push(move(3, 3))
    q.push({ kind: 'wheel', x: 3, y: 3, deltaX: 0, deltaY: 10 })
    q.push({ kind: 'wheel', x: 4, y: 4, deltaX: 1, deltaY: 15 })
    q.push({ kind: 'key', type: 'down', key: 'a' })
    expect(calls).toEqual([])
    due?.()
    expect(calls).toEqual([
      [
        move(2, 2),
        { kind: 'pointer', type: 'down', x: 2, y: 2, button: 'left', clickCount: 1 },
        move(3, 3),
        { kind: 'wheel', x: 4, y: 4, deltaX: 1, deltaY: 25 },
        { kind: 'key', type: 'down', key: 'a' }
      ]
    ])
    // A full batch goes at once; dispose flushes what waits, and nothing after.
    calls.length = 0
    for (let i = 0; i < MAX_INPUT_BATCH; i++) q.push({ kind: 'key', type: i % 2 ? 'up' : 'down', key: 'b' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(MAX_INPUT_BATCH)
    q.push({ kind: 'key', type: 'up', key: 'b' })
    q.dispose()
    expect(calls).toHaveLength(2)
    q.push(move(1, 1))
    q.flush()
    expect(calls).toHaveLength(2)
  })

  it('the outbox keeps text and choices in their place: the events before them go first, moves never merge across them', () => {
    // One log of what leaves, in order: a batch of events, or a text / choice call.
    const out: string[] = []
    const name = (e: WebviewInputEventWire): string =>
      e.kind === 'key' ? `${e.type}:${e.key}` : e.kind === 'pointer' ? `${e.type}@${e.x}` : `wheel:${e.deltaY}`
    let due: (() => void) | undefined
    const q = new InputQueue((events) => void out.push(events.map(name).join(' ')), {
      frame: (fn) => {
        due = fn
        return 1
      },
      cancel: () => {
        due = undefined
      }
    })
    // 'h' as a key, 'é' as text, then 'l' while a frame is still due: never 'é' before 'h', nor
    // 'l' before 'é' (the e2e's "hlélo" and "éhllo").
    q.push({ kind: 'key', type: 'down', key: 'h' })
    q.push({ kind: 'key', type: 'up', key: 'h' })
    q.call(() => void out.push('text é'))
    q.push({ kind: 'key', type: 'down', key: 'l' })
    expect(out).toEqual(['down:h up:h', 'text é'])
    // A move before the text and one after it stay two moves, on either side of it.
    q.push(move(1, 1))
    q.call(() => void out.push('text ü'))
    q.push(move(2, 2))
    q.push(move(3, 3))
    q.push({ kind: 'pointer', type: 'down', x: 3, y: 3, button: 'left', clickCount: 1 })
    q.push(move(4, 4))
    q.call(() => void out.push('choose 1'))
    expect(out).toEqual(['down:h up:h', 'text é', 'down:l move@1', 'text ü', 'move@3 down@3 move@4', 'choose 1'])
    // Nothing waits: the frame that was due sends nothing, and a call with nothing queued goes at once.
    due?.()
    q.call(() => void out.push('text x'))
    expect(out.slice(-1)).toEqual(['text x'])
    // After dispose (the layer went) nothing more leaves.
    q.dispose()
    q.call(() => void out.push('late'))
    expect(out).not.toContain('late')
  })

  it('the channels are adapted', () => {
    expect(REMOTE_CLASS['webviews.input']).toBe('adapted')
    expect(REMOTE_CLASS['webviews.cursor']).toBe('adapted')
  })
})

// Task 8 (design-web-browser.md §4.2): text, paste and the selection pushed for copy.
describe('WebviewInput.acceptText', () => {
  function textSetup(options: { page?: boolean } = {}) {
    let t = 10_000
    const viewers = new WebviewViewers({ setViewed: () => {}, setSize: () => {}, now: () => t })
    const texts: string[] = []
    const sent: ElectronInputEvent[][] = []
    const claims: string[] = []
    const input = new WebviewInput({
      isViewer: (panel, viewId) => viewers.isViewer(panel, viewId),
      claimOwner: (panel, viewId) => {
        claims.push(viewId)
        viewers.claimOwner(panel, viewId)
      },
      target: () =>
        options.page === false
          ? undefined
          : { size: () => ({ width: 800, height: 600 }), send: (events) => void sent.push([...events]), insertText: (text) => void texts.push(text) },
      now: () => t
    })
    viewers.report(PANEL, 'web:1', shown)
    return { viewers, input, texts, sent, claims, advance: (ms: number) => void (t += ms) }
  }

  it("inserts a viewer's text as the page's committed text and claims the size", () => {
    const { viewers, input, texts, claims } = textSetup()
    viewers.report(PANEL, 'web:2', { ...shown, width: 500 })
    expect(input.acceptText(PANEL, 'web:2', 'héllo ü 👋')).toBe(true)
    expect(texts).toEqual(['héllo ü 👋'])
    expect(claims).toEqual(['web:2'])
    expect(viewers.ownerOf(PANEL)).toBe('web:2')
  })

  it(`takes at most ${MAX_TEXT_BYTES} bytes of UTF-8 per call, counted in bytes, refusing more whole`, () => {
    const { input, texts } = textSetup()
    expect(input.acceptText(PANEL, 'web:1', 'a'.repeat(MAX_TEXT_BYTES))).toBe(true)
    expect(() => input.acceptText(PANEL, 'web:1', 'a'.repeat(MAX_TEXT_BYTES + 1))).toThrow(/at most 65536 bytes/)
    // Fewer units than the cap, more bytes: refused.
    expect(() => input.acceptText(PANEL, 'web:1', 'é'.repeat(MAX_TEXT_BYTES / 2 + 1))).toThrow(/at most 65536 bytes/)
    expect(() => input.acceptText(PANEL, 'web:1', 42)).toThrow(/must be a string/)
    expect(() => input.acceptText(PANEL, 'web:1', ['a'])).toThrow(/must be a string/)
    expect(texts).toHaveLength(1)
  })

  it('refuses a view that is not a viewer, and inserts nothing for a panel with no page or no text', () => {
    const { input, texts, claims } = textSetup()
    expect(() => input.acceptText(PANEL, 'web:9', 'x')).toThrow(/not a viewer/)
    expect(() => input.acceptText(OTHER_WINDOW, 'web:1', 'x')).toThrow(/not a viewer/)
    expect(input.acceptText(PANEL, 'web:1', '')).toBe(false)
    // Nothing but control characters: nothing left to type, no claim.
    expect(input.acceptText(PANEL, 'web:1', '\u0000\u001b\u007f')).toBe(false)
    expect(texts).toEqual([])
    expect(claims).toEqual([])
    const none = textSetup({ page: false })
    expect(none.input.acceptText(PANEL, 'web:1', 'x')).toBe(false)
  })

  it('strips control characters but \\n and \\t, and makes every line break \\n', () => {
    const { input, texts } = textSetup()
    input.acceptText(PANEL, 'web:1', 'a\r\nb\rc\nd\te\u0000f\u001b[31mg\u0085h\u007f')
    expect(texts).toEqual(['a\nb\nc\nd\tef[31mgh'])
  })

  it('takes a token of the same rate bucket as the input, dropped silently when there is none', () => {
    const { input, texts, advance } = textSetup()
    const batch = Array(MAX_INPUT_EVENTS).fill(move(1, 1))
    while (input.accept(PANEL, 'web:1', batch) > 0) {
      // drain the bucket
    }
    expect(input.acceptText(PANEL, 'web:1', 'x')).toBe(false)
    expect(texts).toEqual([])
    advance(10)
    expect(input.acceptText(PANEL, 'web:1', 'x')).toBe(true)
    expect(texts).toEqual(['x'])
  })
})

describe('the selection pushed for copy', () => {
  /** Timers run by hand. */
  function manualTimers() {
    const pending = new Map<number, () => void>()
    let next = 0
    return {
      timers: {
        set: (fn: () => void) => {
          pending.set(++next, fn)
          return next
        },
        clear: (h: unknown) => void pending.delete(h as number)
      },
      size: () => pending.size,
      run: () => {
        const fns = [...pending.values()]
        pending.clear()
        for (const fn of fns) fn()
      }
    }
  }

  function selectionSetup() {
    const viewers = new WebviewViewers({ setViewed: () => {}, setSize: () => {}, now: () => 0 })
    const clock = manualTimers()
    const pushes: Array<[string, { panelKey: string; text: string }]> = []
    const reads: Array<(v: unknown) => void> = []
    let reading: () => Promise<unknown> = () =>
      new Promise((resolve) => {
        reads.push(resolve)
      })
    const input = new WebviewInput({
      isViewer: (panel, viewId) => viewers.isViewer(panel, viewId),
      claimOwner: (panel, viewId) => viewers.claimOwner(panel, viewId),
      target: () => ({
        size: () => ({ width: 800, height: 600 }),
        send: () => {},
        insertText: () => {},
        readSelection: () => reading()
      }),
      pushSelection: (viewId, event) => void pushes.push([viewId, event]),
      timers: clock.timers,
      now: () => 0
    })
    viewers.report(PANEL, 'web:1', shown)
    viewers.report(PANEL, 'web:2', shown)
    const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
    return {
      viewers,
      input,
      clock,
      pushes,
      reads,
      flush,
      setReading: (fn: () => Promise<unknown>) => {
        reading = fn
      }
    }
  }
  const up = { kind: 'pointer', type: 'up', x: 5, y: 5, button: 'left', clickCount: 2 }

  it('reads after a release, a key down or text, debounced, and pushes to the acting view only', async () => {
    const { input, clock, pushes, reads, flush } = selectionSetup()
    // A move, a press and a wheel select nothing (a drag ends in a release).
    input.accept(PANEL, 'web:1', [move(1, 1), down(1, 1), { kind: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 5 }, key('a', 'up')])
    expect(clock.size()).toBe(0)
    // A double click's release, then Ctrl+A, then shift-arrows: one debounce, restarted each time.
    input.accept(PANEL, 'web:1', [up])
    input.accept(PANEL, 'web:1', [key('a', 'down', ['control'])])
    input.accept(PANEL, 'web:1', [key('ArrowLeft', 'down', ['shift'])])
    expect(clock.size()).toBe(1)
    expect(reads).toHaveLength(0)
    clock.run()
    expect(reads).toHaveLength(1)
    reads[0]?.('the word')
    await flush()
    expect(pushes).toEqual([['web:1', { panelKey: 'a.one/view', text: 'the word' }]])
    // Text typed: the selection collapsed, so '' goes (a stale selection must not stay copyable).
    input.acceptText(PANEL, 'web:1', 'x')
    clock.run()
    reads[1]?.('')
    await flush()
    expect(pushes[1]).toEqual(['web:1', { panelKey: 'a.one/view', text: '' }])
    // web:2 is a viewer too, but did nothing: it never gets web:1's selection.
    expect(pushes.every(([viewId]) => viewId === 'web:1')).toBe(true)
  })

  it('deduplicates against the last push to that view; the first empty selection is no news', async () => {
    const { input, clock, pushes, reads, flush } = selectionSetup()
    for (const text of ['', 'abc', 'abc', '', '']) {
      input.accept(PANEL, 'web:1', [up])
      clock.run()
      reads[reads.length - 1]?.(text)
      await flush()
    }
    expect(pushes.map(([, e]) => e.text)).toEqual(['abc', ''])
    // Each view has its own last push: web:2 selecting the same text gets it.
    input.accept(PANEL, 'web:2', [up])
    clock.run()
    reads[reads.length - 1]?.('abc')
    await flush()
    expect(pushes.at(-1)).toEqual(['web:2', { panelKey: 'a.one/view', text: 'abc' }])
  })

  it('keeps one read in flight: input during it makes its result stale, and the latest is read after', async () => {
    const { input, clock, pushes, reads, flush } = selectionSetup()
    input.accept(PANEL, 'web:1', [up])
    clock.run()
    expect(reads).toHaveLength(1)
    // More input while the page is slow to answer: its debounce ends, but no second read starts.
    input.accept(PANEL, 'web:1', [key('ArrowRight', 'down', ['shift'])])
    clock.run()
    expect(reads).toHaveLength(1)
    reads[0]?.('stale')
    await flush()
    expect(pushes).toEqual([])
    expect(reads).toHaveLength(2)
    reads[1]?.('fresh')
    await flush()
    expect(pushes).toEqual([['web:1', { panelKey: 'a.one/view', text: 'fresh' }]])
  })

  it('a page that fails the read pushes no selection; a view that left or closed gets nothing', async () => {
    const { input, viewers, clock, pushes, flush, setReading } = selectionSetup()
    setReading(() => Promise.resolve('one'))
    input.accept(PANEL, 'web:1', [up])
    clock.run()
    await flush()
    setReading(() => Promise.reject(new Error('page gone')))
    input.accept(PANEL, 'web:1', [up])
    clock.run()
    await flush()
    expect(pushes.map(([, e]) => e.text)).toEqual(['one', ''])
    setReading(() => Promise.resolve('two'))
    input.accept(PANEL, 'web:1', [up])
    viewers.report(PANEL, 'web:1', { ...shown, hidden: true })
    clock.run()
    await flush()
    expect(pushes).toHaveLength(2)
    // The socket closed: its debounce is cancelled.
    viewers.report(PANEL, 'web:1', shown)
    input.accept(PANEL, 'web:1', [up])
    expect(clock.size()).toBe(1)
    input.viewGone('web:1')
    expect(clock.size()).toBe(0)
  })

  it('a hostile 10 MB selection of control characters and escapes is pushed small enough', async () => {
    const { input, clock, pushes, flush, setReading } = selectionSetup()
    setReading(() => Promise.resolve('\u0001"\\\u001f\ud800'.repeat(2 * 1024 * 1024)))
    input.accept(PANEL, 'web:1', [up])
    clock.run()
    await flush()
    const text = pushes[0]?.[1].text ?? ''
    expect(text.length).toBeGreaterThan(0)
    expect(encodedBytes(text)).toBeLessThanOrEqual(MAX_SELECTION_BYTES)
    expect([...text].some((c) => c.charCodeAt(0) < 0x20 && c !== '\n' && c !== '\t')).toBe(false)
  })
})

describe('cleanSelection', () => {
  it('strips control characters but \\n and \\t', () => {
    expect(cleanSelection('a\u0000b\u0007c\r\nd\te\u001bf\u0090g\u007f')).toBe('abc\nd\tefg')
  })

  it('is empty for anything but a string', () => {
    expect(cleanSelection(undefined)).toBe('')
    expect(cleanSelection(42)).toBe('')
    expect(cleanSelection({ toString: () => 'x' })).toBe('')
  })

  it(`caps the JSON-encoded string at ${MAX_SELECTION_BYTES} bytes, quotes and escapes counted`, () => {
    const ascii = cleanSelection('a'.repeat(MAX_SELECTION_BYTES * 2))
    expect(encodedBytes(ascii)).toBeLessThanOrEqual(MAX_SELECTION_BYTES)
    expect(encodedBytes(ascii)).toBeGreaterThan(MAX_SELECTION_BYTES - 16)
    // Each '"' is two bytes encoded: half as many fit.
    const quotes = cleanSelection('"'.repeat(MAX_SELECTION_BYTES))
    expect(encodedBytes(quotes)).toBeLessThanOrEqual(MAX_SELECTION_BYTES)
    expect(quotes.length).toBeLessThan(MAX_SELECTION_BYTES / 2)
    // Three-byte characters, and an emoji never cut in half.
    const cjk = cleanSelection('漢'.repeat(MAX_SELECTION_BYTES))
    expect(encodedBytes(cjk)).toBeLessThanOrEqual(MAX_SELECTION_BYTES)
    const emoji = cleanSelection('👋'.repeat(MAX_SELECTION_BYTES))
    expect(encodedBytes(emoji)).toBeLessThanOrEqual(MAX_SELECTION_BYTES)
    expect(emoji.length % 2).toBe(0)
    expect(emoji).not.toContain('�')
  })

  it('turns a lone surrogate into U+FFFD (JSON would escape it as six bytes)', () => {
    expect(cleanSelection('a\ud800b\udc00c👋')).toBe('a�b�c👋')
  })

  it('stays far under the socket frame limit, envelope included', () => {
    const text = cleanSelection('\u0001"\\'.repeat(4 * 1024 * 1024))
    const frame = JSON.stringify({ t: 'event', ch: 'webviews.selection', p: { panelKey: 'a'.repeat(200), text } })
    expect(Buffer.byteLength(frame)).toBeLessThan(MAX_FRAME_BYTES / 8)
  })
})

describe('SELECTION_SCRIPT (run in the isolated world)', () => {
  /** Runs the script against a fake DOM, as the isolated world would. */
  function run(activeElement: unknown, selection: string | null): unknown {
    return runInNewContext(SELECTION_SCRIPT, {
      document: { activeElement },
      getSelection: () => (selection === null ? null : { toString: () => selection })
    })
  }
  const field = (tag: string, type: string, value: string, start: number, end: number) => ({
    tagName: tag,
    type,
    value,
    selectionStart: start,
    selectionEnd: end
  })

  it("reads a focused text field's selected slice, never a password field's", () => {
    expect(run(field('INPUT', 'text', 'hello world', 6, 11), 'other')).toBe('world')
    expect(run(field('TEXTAREA', 'textarea', 'line one\nline two', 0, 8), '')).toBe('line one')
    expect(run(field('INPUT', 'text', 'hello', 2, 2), 'other')).toBe('')
    expect(run(field('INPUT', 'password', 'hunter2', 0, 7), 'hunter2')).toBe('')
    expect(run(field('INPUT', 'PassWord', 'hunter2', 0, 7), 'hunter2')).toBe('')
  })

  it('walks into open shadow roots, so a password field inside one is still skipped', () => {
    const inner = field('INPUT', 'password', 'secret', 0, 6)
    expect(run({ tagName: 'MY-LOGIN', shadowRoot: { activeElement: inner } }, 'secret')).toBe('')
    const text = field('INPUT', 'text', 'shadow text', 0, 6)
    expect(run({ tagName: 'MY-FIELD', shadowRoot: { activeElement: text } }, '')).toBe('shadow')
  })

  it("reads the document's selection otherwise, or for a field with no selection API", () => {
    expect(run({ tagName: 'BODY' }, 'a paragraph')).toBe('a paragraph')
    expect(run(null, 'x')).toBe('x')
    expect(run(null, null)).toBe('')
    const email = {
      tagName: 'INPUT',
      type: 'email',
      value: 'a@b',
      get selectionStart(): number {
        throw new Error('no selection API')
      },
      selectionEnd: 0
    }
    expect(run(email, 'from the document')).toBe('from the document')
  })

  it(`cuts the text to ${MAX_SELECTION_CHARS} units before it leaves the page`, () => {
    expect((run({ tagName: 'BODY' }, 'x'.repeat(MAX_SELECTION_CHARS + 50)) as string).length).toBe(MAX_SELECTION_CHARS)
    const big = 'y'.repeat(MAX_SELECTION_CHARS * 2)
    expect((run(field('TEXTAREA', 'textarea', big, 10, big.length), '') as string).length).toBe(MAX_SELECTION_CHARS)
  })
})

describe('keys and text never both type (no double typing)', () => {
  const ev = (k: string, extra: Partial<InputKeyEventLike> = {}): InputKeyEventLike => ({
    key: k,
    code: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...extra
  })
  const action = (e: InputKeyEventLike): string => webviewKeyAction(e, () => false)

  it('a printable ASCII key is a key (prevented: the textarea never sees it) with exactly one char', () => {
    for (const k of ['a', 'Z', '1', '/', ' ']) {
      expect(action(ev(k))).toBe('forward')
      const out = toElectronEvents({ kind: 'key', type: 'down', key: k, modifiers: [] }, { width: 1, height: 1 })
      expect(out.filter((e) => e.type === 'char')).toHaveLength(1)
    }
  })

  it("non-ASCII, dead keys, an IME's composition and AltGr text are the textarea's: not forwarded", () => {
    expect(action(ev('é'))).toBe('ignore')
    expect(action(ev('ü', { shiftKey: true }))).toBe('ignore')
    expect(action(ev('Dead'))).toBe('ignore')
    expect(action(ev('Process'))).toBe('ignore')
    expect(action(ev('a', { isComposing: true }))).toBe('ignore')
    expect(action(ev('Unidentified'))).toBe('ignore')
    // AltGr on Windows reads as Ctrl+Alt; with AltGraph set it is text, not a shortcut.
    const altGr = (k: string): InputKeyEventLike => ev(k, { ctrlKey: true, altKey: true, getModifierState: (m) => m === 'AltGraph' })
    expect(action(altGr('@'))).toBe('ignore')
    expect(action(altGr('€'))).toBe('ignore')
    // A real Ctrl+Alt shortcut stays a key.
    expect(action(ev('t', { ctrlKey: true, altKey: true, getModifierState: () => false }))).toBe('forward')
  })

  it('Enter, Tab, Backspace, Delete, arrows, Escape, F-keys and chords are keys; only Enter types (\\r)', () => {
    for (const k of ['Enter', 'Tab', 'Backspace', 'Delete', 'ArrowLeft', 'Escape', 'F5']) expect(action(ev(k))).toBe('forward')
    expect(action(ev('a', { ctrlKey: true }))).toBe('forward')
    const chars = (k: string, modifiers: InputModifier[] = []) =>
      toElectronEvents({ kind: 'key', type: 'down', key: k, modifiers }, { width: 1, height: 1 }).filter((e) => e.type === 'char')
    expect(chars('Enter')).toEqual([{ type: 'char', keyCode: '\r', modifiers: [] }])
    for (const k of ['Tab', 'Backspace', 'Delete', 'ArrowLeft', 'Escape', 'F5']) expect(chars(k)).toEqual([])
    expect(chars('a', ['control'])).toEqual([])
  })
})

describe('textChunks (a paste into insertText calls)', () => {
  it('cuts long text into calls under main\'s byte cap, never inside a surrogate pair', () => {
    expect(textChunks('')).toEqual([])
    expect(textChunks('abc')).toEqual(['abc'])
    expect(TEXT_CHUNK_UNITS * 3).toBeLessThanOrEqual(MAX_TEXT_BYTES)
    const chunks = textChunks('a' + '👋'.repeat(TEXT_CHUNK_UNITS))
    expect(chunks.join('')).toBe('a' + '👋'.repeat(TEXT_CHUNK_UNITS))
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(TEXT_CHUNK_UNITS)
      expect(c).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/)
      expect(Buffer.byteLength(c)).toBeLessThanOrEqual(MAX_TEXT_BYTES)
    }
  })

  it(`stops at ${MAX_TEXT_CHUNKS} calls`, () => {
    expect(textChunks('x'.repeat(10), 2, 3)).toEqual(['xx', 'xx', 'xx'])
    expect(textChunks('x'.repeat(TEXT_CHUNK_UNITS * (MAX_TEXT_CHUNKS + 5)))).toHaveLength(MAX_TEXT_CHUNKS)
  })
})
