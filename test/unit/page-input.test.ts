// page-input.ts: a streamed page's input on its DevTools protocol, with fake sessions. Checked here:
// the protocol params (mouse buttons and wheel sign, the key table), the point through an owner's
// box (translate, border and padding, scale, rotation, a flat box), and the router: keys on the
// page's session, each pointer event on the session of the deepest ready cross-site frame under it
// (scroll added for the hit test), capture after a press (the boxes read again), the hover move
// when the pointer changes frame, the fallback when a frame's session is gone (the page's session,
// never another frame, never dropped), the order across sessions, and the queue's caps and deadlines.
// Chromium's own routing is proven under Electron by scripts/offscreen-input-check.mjs.
import { describe, expect, it } from 'vitest'
import {
  MAX_QUEUED_STEPS,
  PageInputRouter,
  pointInFrame,
  protocolKeyEvent,
  protocolMouseEvent,
  ROUTE_TIMEOUT_MS,
  STEP_TIMEOUT_MS
} from '../../src/main/webview/page-input'
import type { ElectronInputEvent } from '../../src/main/webview/webview-input'
import { webviewKeyInfo } from '../../src/shared/webview-keys'

const rect = (x: number, y: number, w: number, h: number): number[] => [x, y, x + w, y, x + w, y + h, x, y + h]

describe('protocol params', () => {
  it('mouse: the held buttons as bits, the press adds its own, the release removes it; moves name the held button', () => {
    expect(protocolMouseEvent({ type: 'mouseDown', x: 1, y: 2, button: 'left', clickCount: 2, modifiers: ['shift'] }, 5, 6)).toEqual({
      type: 'mousePressed',
      x: 5,
      y: 6,
      modifiers: 8,
      button: 'left',
      buttons: 1,
      clickCount: 2,
      pointerType: 'mouse'
    })
    expect(protocolMouseEvent({ type: 'mouseUp', x: 1, y: 2, button: 'right', clickCount: 1, modifiers: ['leftbuttondown', 'rightbuttondown'] }, 1, 2)).toMatchObject({
      type: 'mouseReleased',
      button: 'right',
      buttons: 1
    })
    expect(protocolMouseEvent({ type: 'mouseMove', x: 1, y: 2, modifiers: ['leftbuttondown', 'control', 'meta'] }, 1, 2)).toMatchObject({
      type: 'mouseMoved',
      button: 'left',
      buttons: 1,
      modifiers: 6,
      clickCount: 0
    })
    expect(protocolMouseEvent({ type: 'mouseMove', x: 1, y: 2, modifiers: [] }, 1, 2)).toMatchObject({ button: 'none', buttons: 0 })
  })

  it("wheel: Electron's (Chromium's) sign turned back into the DOM's, never -0", () => {
    // The lane negated the DOM's deltas for sendInputEvent (webview-input.ts toElectronEvents).
    expect(protocolMouseEvent({ type: 'mouseWheel', x: 1, y: 2, deltaX: 0, deltaY: -120, modifiers: [] }, 3, 4)).toEqual({
      type: 'mouseWheel',
      x: 3,
      y: 4,
      deltaX: 0,
      deltaY: 120,
      modifiers: 0,
      buttons: 0,
      pointerType: 'mouse'
    })
  })

  it("keys: one for one with sendInputEvent's, with the US key's code and Windows key code", () => {
    expect(protocolKeyEvent({ type: 'keyDown', keyCode: 'a', modifiers: [] })).toEqual({
      type: 'rawKeyDown',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      modifiers: 0,
      autoRepeat: false
    })
    expect(protocolKeyEvent({ type: 'char', keyCode: 'A', modifiers: ['shift'] })).toEqual({
      type: 'char',
      key: 'A',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      modifiers: 8,
      text: 'A',
      unmodifiedText: 'A',
      autoRepeat: false
    })
    expect(protocolKeyEvent({ type: 'keyUp', keyCode: 'Up', modifiers: ['isautorepeat'] })).toEqual({
      type: 'keyUp',
      key: 'ArrowUp',
      code: 'ArrowUp',
      windowsVirtualKeyCode: 38,
      modifiers: 0
    })
    // Enter's char is '\r'; Space is named 'Space' by Electron and ' ' by the DOM.
    expect(protocolKeyEvent({ type: 'char', keyCode: '\r', modifiers: [] })).toMatchObject({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    expect(protocolKeyEvent({ type: 'keyDown', keyCode: 'Space', modifiers: [] })).toMatchObject({ key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
    expect(protocolKeyEvent({ type: 'keyDown', keyCode: 'nope', modifiers: [] })).toBeUndefined()
  })

  it('the key table covers every printable ASCII character and named key the allow-list has', () => {
    for (let c = 0x21; c <= 0x7e; c++) expect(webviewKeyInfo(String.fromCharCode(c)), String.fromCharCode(c)).toBeDefined()
    expect(webviewKeyInfo('!')).toEqual({ key: '!', code: 'Digit1', keyCode: 49 })
    expect(webviewKeyInfo('"')).toEqual({ key: '"', code: 'Quote', keyCode: 222 })
    expect(webviewKeyInfo('7')).toEqual({ key: '7', code: 'Digit7', keyCode: 55 })
    expect(webviewKeyInfo('F12')).toEqual({ key: 'F12', code: 'F12', keyCode: 123 })
    expect(webviewKeyInfo('Backspace')).toEqual({ key: 'Backspace', code: 'Backspace', keyCode: 8 })
    // Electron's names only: the DOM's 'ArrowUp' is no Electron keyCode.
    expect(webviewKeyInfo('ArrowUp')).toBeUndefined()
    expect(webviewKeyInfo('é')).toBeUndefined()
  })
})

describe('pointInFrame', () => {
  const box = (content: number[], border: number[], width: number, height: number) => ({ content, border, width, height })

  it('translates by the content box; the owner border and padding are outside the frame', () => {
    // Border 5 + padding 3 around a 600x300 frame at (0, 200): the border box is 616x316.
    const model = box(rect(8, 208, 600, 300), rect(0, 200, 616, 316), 616, 316)
    expect(pointInFrame(model, 20, 225)).toEqual({ x: 12, y: 17, inside: true, inBorder: true })
    expect(pointInFrame(model, 3, 203)).toMatchObject({ inside: false, inBorder: true })
    expect(pointInFrame(model, 700, 100)).toMatchObject({ inside: false, inBorder: false })
    // The right edge is the next pixel, not the frame's.
    expect(pointInFrame(model, 608, 300)).toMatchObject({ inside: false })
  })

  it('maps through a scale and a rotation to the frame\'s own, untransformed size', () => {
    // scale(0.5) from the top left: a 300x300 frame drawn 150x150 at (650, 200).
    const scaled = box(rect(650, 200, 150, 150), rect(650, 200, 150, 150), 300, 300)
    expect(pointInFrame(scaled, 660, 212.5)).toEqual({ x: 20, y: 25, inside: true, inBorder: true })
    // rotate(90deg) about the top left at (400, 100): the top edge points down, the left edge left.
    const q = [400, 100, 400, 300, 300, 300, 300, 100]
    const rotated = box(q, q, 200, 100)
    const p = pointInFrame(rotated, 390, 150) as { x: number; y: number; inside: boolean }
    expect(p.x).toBeCloseTo(50)
    expect(p.y).toBeCloseTo(10)
    expect(p.inside).toBe(true)
  })

  it('undefined for a flat or malformed box', () => {
    expect(pointInFrame(box([0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0], 10, 10), 0, 0)).toBeUndefined()
    expect(pointInFrame(box(rect(0, 0, 10, 10), rect(0, 0, 10, 10), 0, 10), 1, 1)).toBeUndefined()
    expect(pointInFrame({ content: [1, 2, 3], border: rect(0, 0, 1, 1), width: 1, height: 1 }, 0, 0)).toBeUndefined()
    expect(pointInFrame({ content: rect(0, 0, 1, 1).map(() => Number.NaN), border: rect(0, 0, 1, 1), width: 1, height: 1 }, 0, 0)).toBeUndefined()
    expect(pointInFrame(undefined, 0, 0)).toBeUndefined()
  })
})

/** A frame owner in a session's document: its box (viewport px of that session) and the frame it holds. */
interface FakeOwner {
  node: number
  frameId: string
  /** The border box quad (the hit test's area). */
  box: number[]
  /** The content box quad when it differs (a border or padding). */
  content?: number[]
  width: number
  height: number
}

interface Sent {
  method: string
  params: Record<string, unknown>
  session: string
}

/**
 * Fake page sessions: each ('' the page's) has a scroll and frame owners; the DOM queries answer
 * from them as Chromium does (getNodeForLocation takes document px, boxes are viewport px), input
 * commands are recorded and answered at once, or held (`hold`), or refused (`refuse`).
 */
function fakePage() {
  const scroll = new Map<string, { x: number; y: number }>()
  const owners = new Map<string, FakeOwner[]>()
  const sent: Sent[] = []
  const queries: Array<{ method: string; session: string }> = []
  const held: Array<{ sent: Sent; resolve: (v: unknown) => void }> = []
  const opts = { hold: false, refuse: new Set<string>(), hang: new Set<string>(), hitAlways: undefined as number | undefined }
  const send = (method: string, params: Record<string, unknown> | undefined, sessionId?: string): Promise<unknown> => {
    const session = sessionId ?? ''
    if (sessionId === '') throw new Error('the page session is named by no id, never by an empty one')
    const p = params ?? {}
    if (method.startsWith('Input.')) {
      const entry = { method, params: p, session }
      if (opts.refuse.has(session)) return Promise.reject(new Error('No session with given id'))
      sent.push(entry)
      if (opts.hold) return new Promise((resolve) => void held.push({ sent: entry, resolve }))
      return Promise.resolve({})
    }
    queries.push({ method, session })
    if (opts.hang.has(method)) return new Promise(() => {})
    if (opts.refuse.has(session)) return Promise.reject(new Error('No session with given id'))
    const s = scroll.get(session) ?? { x: 0, y: 0 }
    const list = owners.get(session) ?? []
    if (method === 'Page.getLayoutMetrics') return Promise.resolve({ cssLayoutViewport: { pageX: s.x, pageY: s.y, clientWidth: 1000, clientHeight: 700 } })
    if (method === 'DOM.getNodeForLocation') {
      const x = (p.x as number) - s.x
      const y = (p.y as number) - s.y
      const o = list.find((own) => x >= (own.box[0] as number) && x < (own.box[2] as number) && y >= (own.box[1] as number) && y < (own.box[5] as number))
      return Promise.resolve({ backendNodeId: opts.hitAlways ?? (o ? o.node : 1), frameId: 'doc' })
    }
    if (method === 'DOM.describeNode') {
      const o = list.find((own) => own.node === p.backendNodeId)
      return Promise.resolve({ node: o ? { nodeName: 'IFRAME', frameId: o.frameId } : { nodeName: 'BODY' } })
    }
    if (method === 'DOM.getBoxModel') {
      const o = list.find((own) => own.node === p.backendNodeId)
      if (!o) return Promise.reject(new Error('Could not compute box model.'))
      return Promise.resolve({ model: { content: o.content ?? o.box, border: o.box, width: o.width, height: o.height } })
    }
    return Promise.resolve({})
  }
  return { send, scroll, owners, sent, queries, held, opts }
}

function setup() {
  const page = fakePage()
  const fallback: ElectronInputEvent[] = []
  const logs: string[] = []
  const timers = new Map<number, () => void>()
  let next = 0
  let attached = true
  const router = new PageInputRouter({
    send: page.send,
    attached: () => attached,
    fallback: (e) => void fallback.push(e),
    log: (m) => void logs.push(m),
    timers: {
      set: (fn) => {
        timers.set(++next, fn)
        return next
      },
      clear: (h) => void timers.delete(h as number)
    }
  })
  /** A ready cross-site frame `session` (target `T-<session>`) owned by node `node` of `parent`. */
  const frame = (session: string, parent: string, node: number, box: number[], width: number, height: number): void => {
    router.frameAttached(session, `T-${session}`, parent, 'iframe')
    router.frameReady(session)
    page.owners.set(parent, [...(page.owners.get(parent) ?? []), { node, frameId: `T-${session}`, box, width, height }])
  }
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
  }
  /** Run every timer now (the step and route deadlines). */
  const fire = (): void => {
    const fns = [...timers.values()]
    timers.clear()
    for (const fn of fns) fn()
  }
  const mice = (): Array<[string, string, number, number]> =>
    page.sent.filter((s) => s.method === 'Input.dispatchMouseEvent').map((s) => [s.session, s.params.type as string, s.params.x as number, s.params.y as number])
  return { page, router, fallback, logs, frame, flush, fire, mice, detach: () => (attached = false), timers }
}

const down = (x: number, y: number, button: 'left' | 'right' = 'left'): ElectronInputEvent => ({ type: 'mouseDown', x, y, button, clickCount: 1, modifiers: [] })
const up = (x: number, y: number, button: 'left' | 'right' = 'left'): ElectronInputEvent => ({ type: 'mouseUp', x, y, button, clickCount: 1, modifiers: [] })
const move = (x: number, y: number, held = false): ElectronInputEvent => ({ type: 'mouseMove', x, y, modifiers: held ? ['leftbuttondown'] : [] })
const keyDown = (keyCode: string): ElectronInputEvent => ({ type: 'keyDown', keyCode, modifiers: [] })

describe('PageInputRouter', () => {
  it('a page with no cross-site frame: everything on the page session, no hit test', async () => {
    const s = setup()
    s.router.input([move(10, 10), down(10, 10), up(10, 10), keyDown('a')])
    await s.flush()
    expect(s.mice()).toEqual([
      ['', 'mouseMoved', 10, 10],
      ['', 'mousePressed', 10, 10],
      ['', 'mouseReleased', 10, 10]
    ])
    expect(s.page.sent.at(-1)).toMatchObject({ method: 'Input.dispatchKeyEvent', session: '', params: { type: 'rawKeyDown', key: 'a' } })
    expect(s.page.queries).toEqual([])
  })

  it('routes to the deepest ready frame under the point, the point in its own px, keys on the page session', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.frame('B', 'A', 9, rect(300, 100, 280, 180), 280, 180)
    s.router.input([down(20, 225), up(20, 225), down(320, 325), up(320, 325), down(20, 25), keyDown('q')])
    await s.flush()
    expect(s.mice()).toEqual([
      ['A', 'mousePressed', 20, 25],
      ['A', 'mouseReleased', 20, 25],
      // Into B under A: each ancestor hovers the owner it is over (the top A's, A B's).
      ['', 'mouseMoved', 320, 325],
      ['A', 'mouseMoved', 320, 125],
      ['B', 'mousePressed', 20, 25],
      ['B', 'mouseReleased', 20, 25],
      // From B straight to the top: B's hover ends, then A's (deepest first), outside their viewports.
      ['B', 'mouseMoved', -1, -1],
      ['A', 'mouseMoved', -1, -1],
      ['', 'mousePressed', 20, 25]
    ])
    // Keys follow focus on the page's session, never a frame's.
    const keys = s.page.sent.filter((x) => x.method === 'Input.dispatchKeyEvent')
    expect(keys.map((k) => k.session)).toEqual([''])
  })

  it('adds each level\'s scroll for the hit test (document px) and maps with the viewport box', async () => {
    const s = setup()
    // The top scrolled by 100: A's owner is at viewport y 100; A scrolled by 20.
    s.page.scroll.set('', { x: 0, y: 100 })
    s.page.scroll.set('A', { x: 0, y: 20 })
    s.frame('A', '', 7, rect(0, 100, 600, 300), 600, 300)
    s.frame('B', 'A', 9, rect(300, 80, 280, 180), 280, 180)
    s.router.input([down(320, 205)])
    await s.flush()
    expect(s.mice()).toEqual([['B', 'mousePressed', 20, 25]])
  })

  it('a frame not resumed yet, or gone, takes nothing: the page session gets the event', async () => {
    const s = setup()
    s.router.frameAttached('A', 'T-A', '', 'iframe')
    s.page.owners.set('', [{ node: 7, frameId: 'T-A', box: rect(0, 200, 600, 300), width: 600, height: 300 }])
    s.router.input([down(20, 225), up(20, 225)])
    await s.flush()
    expect(s.mice().map((m) => m[0])).toEqual(['', ''])
    s.router.frameReady('A')
    s.router.input([down(20, 226), up(20, 226)])
    await s.flush()
    // (After the top's hover move over A's owner.)
    expect(s.mice().slice(2)).toEqual([
      ['', 'mouseMoved', 20, 226],
      ['A', 'mousePressed', 20, 26],
      ['A', 'mouseReleased', 20, 26]
    ])
    // A worker is never a frame.
    s.router.frameAttached('W', 'T-W', '', 'worker')
    s.router.frameReady('W')
    s.router.frameDetached('A')
    s.router.input([down(20, 227)])
    await s.flush()
    expect(s.mice().at(-1)).toEqual(['', 'mousePressed', 20, 227])
  })

  it('a point on the owner border or padding stays with the parent', async () => {
    const s = setup()
    s.router.frameAttached('A', 'T-A', '', 'iframe')
    s.router.frameReady('A')
    // A 584x284 frame inset by 8 px of border and padding in a 600x300 border box at (0, 200).
    s.page.owners.set('', [{ node: 7, frameId: 'T-A', box: rect(0, 200, 600, 300), content: rect(8, 208, 584, 284), width: 600, height: 300 }])
    s.router.input([down(3, 203), up(3, 203), down(20, 225)])
    await s.flush()
    expect(s.mice()).toEqual([
      ['', 'mousePressed', 3, 203],
      ['', 'mouseReleased', 3, 203],
      ['', 'mouseMoved', 20, 225],
      ['A', 'mousePressed', 12, 17]
    ])
  })

  it('a hit whose box does not hold the point (the scroll read went stale) is read again, then left with the parent', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    // The hit test finds A's owner, but its box is far from the point: never A.
    s.page.opts.hitAlways = 7
    s.router.input([down(20, 50)])
    await s.flush()
    expect(s.page.queries.filter((q) => q.method === 'DOM.getNodeForLocation')).toHaveLength(2)
    expect(s.mice()).toEqual([['', 'mousePressed', 20, 50]])
  })

  it('captures after a press: moves and the release go to that frame, outside it too, its box read again each time', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.router.input([down(20, 225)])
    await s.flush()
    s.router.input([move(100, 225, true)])
    await s.flush()
    s.router.input([move(650, 150, true)])
    await s.flush()
    // The page scrolled under the drag: A's owner moved up by 50.
    s.page.owners.set('', [{ node: 7, frameId: 'T-A', box: rect(0, 150, 600, 300), width: 600, height: 300 }])
    s.router.input([move(650, 150, true), up(650, 150), move(650, 150)])
    await s.flush()
    expect(s.mice()).toEqual([
      ['A', 'mousePressed', 20, 25],
      ['A', 'mouseMoved', 100, 25],
      ['A', 'mouseMoved', 650, -50],
      ['A', 'mouseMoved', 650, 0],
      ['A', 'mouseReleased', 650, 0],
      // Released: the next move is hit-tested (the top), and A's hover ends.
      ['A', 'mouseMoved', -1, -1],
      ['', 'mouseMoved', 650, 150]
    ])
  })

  it('a drag that started in the top document stays there over a frame', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.router.input([down(20, 25), move(20, 300, true), up(20, 300)])
    await s.flush()
    expect(s.mice().map((m) => m[0])).toEqual(['', '', ''])
  })

  it('a move with no button held ends a capture whose release never came', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.router.input([down(20, 225), move(20, 25)])
    await s.flush()
    expect(s.mice().at(-1)).toEqual(['', 'mouseMoved', 20, 25])
  })

  it('two buttons: the capture holds until the last is released', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.router.input([down(20, 225), down(20, 225, 'right'), up(20, 25, 'left'), up(20, 25, 'right'), down(20, 25)])
    await s.flush()
    expect(s.mice().map((m) => `${m[0]} ${m[1]}`)).toEqual(['A mousePressed', 'A mousePressed', 'A mouseReleased', 'A mouseReleased', 'A mouseMoved', ' mousePressed'])
  })

  it("a frame's refused command goes to the page session at the top point, logged once; never dropped, never another frame", async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.frame('C', '', 8, rect(650, 200, 300, 300), 300, 300)
    s.page.opts.refuse.add('A')
    s.router.input([down(20, 225), up(20, 225)])
    await s.flush()
    // getBoxModel on A's parent still answers; the input to A is refused and goes to the page.
    expect(s.mice()).toEqual([
      ['', 'mousePressed', 20, 225],
      ['', 'mouseReleased', 20, 225]
    ])
    expect(s.logs).toEqual(["webview: a frame's protocol refused input; it went to the page instead"])
    // The page's own session refusing: sendInputEvent.
    s.page.opts.refuse.add('')
    s.router.input([move(5, 5)])
    await s.flush()
    expect(s.fallback).toEqual([move(5, 5)])
    expect(s.mice().some((m) => m[0] === 'C')).toBe(false)
  })

  it('a captured frame that went: the rest of the drag goes to the page session', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.router.input([down(20, 225)])
    await s.flush()
    s.router.frameDetached('A')
    s.router.input([move(30, 225, true), up(30, 225)])
    await s.flush()
    expect(s.mice()).toEqual([
      ['A', 'mousePressed', 20, 25],
      ['', 'mouseMoved', 30, 225],
      ['', 'mouseReleased', 30, 225]
    ])
  })

  it('a nested frame goes with its parent', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.frame('B', 'A', 9, rect(300, 100, 280, 180), 280, 180)
    s.router.frameDetached('A')
    s.router.input([down(320, 325)])
    await s.flush()
    expect(s.mice()).toEqual([['', 'mousePressed', 320, 325]])
  })

  it('keeps order across sessions: a key waits until the press into a frame was answered', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.page.opts.hold = true
    s.router.input([down(20, 225), up(20, 225), keyDown('q')])
    await s.flush()
    // The press and release (same session) both went; the key waits for their answers.
    expect(s.page.sent.map((x) => `${x.session} ${x.params.type}`)).toEqual(['A mousePressed', 'A mouseReleased'])
    for (const h of s.page.held.splice(0)) h.resolve({})
    await s.flush()
    expect(s.page.sent.map((x) => `${x.session} ${x.params.type}`)).toEqual(['A mousePressed', 'A mouseReleased', ' rawKeyDown'])
  })

  it('a call goes after the input before it, and blocks what follows until it settles (or the deadline)', async () => {
    const s = setup()
    s.page.opts.hold = true
    const order: string[] = []
    s.router.input([keyDown('a')])
    let finish: (v: unknown) => void = () => {}
    const text = s.router.call(() => {
      order.push('text')
      return new Promise((r) => (finish = r))
    })
    s.router.input([keyDown('b')])
    await s.flush()
    expect(order).toEqual([])
    for (const h of s.page.held.splice(0)) h.resolve({})
    await s.flush()
    expect(order).toEqual(['text'])
    expect(s.page.sent.map((x) => x.params.key)).toEqual(['a'])
    finish('done')
    await expect(text).resolves.toBe('done')
    await s.flush()
    expect(s.page.sent.map((x) => x.params.key)).toEqual(['a', 'b'])
    // A non-blocking call (a selection read) holds nothing after it.
    for (const h of s.page.held.splice(0)) h.resolve({})
    await s.flush()
    void s.router.call(() => new Promise(() => {}), false)
    s.router.input([keyDown('c')])
    await s.flush()
    expect(s.page.sent.map((x) => x.params.key)).toEqual(['a', 'b', 'c'])
  })

  it('a command that never answers holds the rest only until STEP_TIMEOUT_MS', async () => {
    const s = setup()
    s.page.opts.hold = true
    s.router.input([keyDown('a'), keyDown('b')])
    await s.flush()
    expect(s.page.sent.map((x) => x.params.key)).toEqual(['a'])
    expect(STEP_TIMEOUT_MS).toBe(500)
    s.fire()
    await s.flush()
    expect(s.page.sent.map((x) => x.params.key)).toEqual(['a', 'b'])
  })

  it('a hit test that never answers sends the event to the page session after ROUTE_TIMEOUT_MS', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.page.opts.hang.add('DOM.getNodeForLocation')
    s.router.input([down(20, 225)])
    await s.flush()
    expect(s.mice()).toEqual([])
    expect(ROUTE_TIMEOUT_MS).toBeLessThan(STEP_TIMEOUT_MS)
    s.fire()
    await s.flush()
    expect(s.mice()).toEqual([['', 'mousePressed', 20, 225]])
  })

  it('pipelines events to one session, coalesces moves waiting behind a wait, and a full queue never drops a release', async () => {
    const s = setup()
    s.page.opts.hold = true
    s.router.input([move(1, 1)])
    s.router.input([move(2, 2)])
    await s.flush()
    // Both went without waiting for the first's answer (same session).
    expect(s.mice().map((m) => m[2])).toEqual([1, 2])
    s.router.input([keyDown('a'), move(3, 3), move(4, 4), move(5, 5)])
    await s.flush()
    // The key waits for the moves' answers; the three moves behind it are one.
    for (const h of s.page.held.splice(0)) h.resolve({})
    await s.flush()
    for (const h of s.page.held.splice(0)) h.resolve({})
    await s.flush()
    expect(s.mice().map((m) => m[2])).toEqual([1, 2, 5])
    // Hold the pump on a key, then overfill the queue.
    s.router.input([keyDown('b')])
    await s.flush()
    const many: ElectronInputEvent[] = []
    for (let n = 0; n < MAX_QUEUED_STEPS + 10; n++) many.push(keyDown('c'))
    s.router.input([...many, up(9, 9), { type: 'keyUp', keyCode: 'c', modifiers: [] }])
    expect(s.logs).toEqual(['webview: the page answers no input; input dropped'])
    // Let everything through: both releases are there, at the end.
    for (let n = 0; n < 2 * MAX_QUEUED_STEPS && (s.page.held.length > 0 || s.timers.size > 0); n++) {
      for (const h of s.page.held.splice(0)) h.resolve({})
      await new Promise((r) => setTimeout(r, 0))
    }
    await s.flush()
    const tail = s.page.sent.slice(-2).map((x) => x.params.type)
    expect(tail).toEqual(['mouseReleased', 'keyUp'])
  })

  it('detached: every event by sendInputEvent at once, and no capture survives it', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.router.input([down(20, 225)])
    await s.flush()
    s.detach()
    s.router.input([move(30, 225, true), up(30, 225)])
    expect(s.fallback).toEqual([move(30, 225, true), up(30, 225)])
    // A call runs its own fallback.
    await expect(s.router.call(() => 'fallback text')).resolves.toBe('fallback text')
  })

  it('reset (the protocol detached) forgets every frame', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.router.reset()
    s.router.input([down(20, 225)])
    await s.flush()
    expect(s.mice()).toEqual([['', 'mousePressed', 20, 225]])
    expect(s.page.queries).toEqual([])
  })
})
