// design-web-browser.md §4.1, §5 (plan 20261111-streamed-webviews.md Task 7): pointer, wheel and
// keys from a server's browser view into its streamed page. Main's side (webview-input.ts): the
// checks, the rate cap, viewers only, the owner rule, the mapping to sendInputEvent, the manager's
// input target; the shared key and cursor tables; the browser's side (web/webview-stream.ts): page
// coordinates through the letterbox and the scale, the key split (shell chords, clipboard chords),
// the outbox, click counts and wheel units. The router's gate is in ipc-router.test.ts.
import { describe, expect, it } from 'vitest'
import {
  claimsOwner,
  cursorEvent,
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
  pointerButton,
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
  }

  function managerFor(server: boolean, withInput = true): { manager: WebviewManager; made: Fake[] } {
    const made: Fake[] = []
    const manager = new WebviewManager({
      views: {
        create: () => {
          const v: Fake = {
            input: [],
            load: () => Promise.resolve(),
            back: () => {},
            forward: () => {},
            reload: () => {},
            current: () => ({ url: '', title: '' }),
            isFocused: () => false,
            setBounds: () => {},
            setVisible: () => {},
            destroy: () => {},
            ...(withInput ? { size: () => ({ width: 640, height: 480 }), sendInput: (events: readonly ElectronInputEvent[]) => void v.input.push([...events]) } : {})
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
    // Another window's panel of the same key has no view: nothing.
    expect(manager.inputTarget(8, 'a.one', 'view')).toBeUndefined()
    // The view goes (the plugin stopped): a target handed out before sends nothing.
    manager.destroyPlugin(7, 'a.one')
    target?.send([ev])
    expect(made[0]?.input).toEqual([[ev]])
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

  it('the channels are adapted', () => {
    expect(REMOTE_CLASS['webviews.input']).toBe('adapted')
    expect(REMOTE_CLASS['webviews.cursor']).toBe('adapted')
  })
})
