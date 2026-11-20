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
  FRAME_WORLD_NAME,
  MAX_QUEUED_STEPS,
  MAX_RETESTS,
  PageInputRouter,
  pointInFrame,
  protocolKeyEvent,
  protocolMouseEvent,
  rectFromFrame,
  rectToTop,
  ROUTE_TIMEOUT_MS,
  STEP_TIMEOUT_MS
} from '../../src/main/webview/page-input'
import { InputDroppedError, type ElectronInputEvent } from '../../src/main/webview/webview-input'
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

  // Review finding (codex): an affine inverse of a perspective quad put a point in the wrong spot.
  it('refuses a perspective quad (no parallelogram): the point stays with the parent', () => {
    const q = [0, 0, 100, 0, 200, 200, 0, 200]
    expect(pointInFrame(box(q, q, 200, 200), 66.7, 66.7)).toBeUndefined()
  })

  // Codex (merge bar O1): the tolerance was in screen px; over a large viewport a tiny skew put the
  // point about 10 frame px off, into another child.
  it("measures the parallelogram tolerance in the frame's own px", () => {
    const q = [0, 0, 100, 0, 100.4, 100, 0, 100]
    expect(pointInFrame(box(q, q, 10000, 10000), 50, 50)).toBeUndefined()
    // The same skew over a viewport its own size is within half a px.
    expect(pointInFrame(box(q, q, 100, 100), 50, 50)).toMatchObject({ inside: true })
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
  const held: Array<{ sent: Sent; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = []
  /** Hit-test queries held while `holdQueries` is on: answered by hand (`answer`, from the layout then) or refused. */
  const heldQueries: Array<{ method: string; session: string; answer: () => void; reject: (e: unknown) => void }> = []
  const opts = {
    hold: false,
    holdQueries: false,
    /** Input on these sessions is held (never answered until resolved by hand) even when `hold` is off. */
    holdSessions: new Set<string>(),
    refuse: new Set<string>(),
    hang: new Set<string>(),
    hitAlways: undefined as number | undefined,
    onSent: undefined as ((sent: Sent) => void) | undefined,
    /** A query's own answer (main's scripts: isolated worlds, evaluations); undefined: the layout's. */
    answer: undefined as ((method: string, params: Record<string, unknown>, session: string) => Promise<unknown> | undefined) | undefined
  }
  const send = (method: string, params: Record<string, unknown> | undefined, sessionId?: string): Promise<unknown> => {
    const session = sessionId ?? ''
    if (sessionId === '') throw new Error('the page session is named by no id, never by an empty one')
    const p = params ?? {}
    if (method.startsWith('Input.')) {
      const entry = { method, params: p, session }
      if (opts.refuse.has(session)) return Promise.reject(new Error('No session with given id'))
      sent.push(entry)
      opts.onSent?.(entry)
      if (opts.hold || opts.holdSessions.has(session)) return new Promise((resolve, reject) => void held.push({ sent: entry, resolve, reject }))
      return Promise.resolve({})
    }
    queries.push({ method, session })
    if (opts.hang.has(method)) return new Promise(() => {})
    const own = opts.answer?.(method, p, session)
    if (own) return own
    if (opts.holdQueries) {
      return new Promise((resolve, reject) => {
        heldQueries.push({ method, session, answer: () => resolve(query(method, p, session)), reject })
      })
    }
    return query(method, p, session)
  }
  const query = (method: string, p: Record<string, unknown>, session: string): Promise<unknown> => {
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
  return { send, scroll, owners, sent, queries, held, heldQueries, opts }
}

function setup() {
  const page = fakePage()
  const fallback: ElectronInputEvent[] = []
  const logs: string[] = []
  const timers = new Map<number, () => void>()
  let next = 0
  let attached = true
  /** The top document's scripts (the adapter's isolated world) and what they answer. */
  const tops: string[] = []
  const top = { answer: (code: string): Promise<unknown> => Promise.resolve(`top:${code}`) }
  const router = new PageInputRouter({
    send: page.send,
    attached: () => attached,
    fallback: (e) => void fallback.push(e),
    log: (m) => void logs.push(m),
    isolated: (code) => {
      tops.push(code)
      return top.answer(code)
    },
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
  /** Unanswered input commands per session ('' the page's). */
  const unanswered = (): Map<string, number> => {
    const by = new Map<string, number>()
    for (const h of page.held) by.set(h.sent.session, (by.get(h.sent.session) ?? 0) + 1)
    return by
  }
  return { page, router, fallback, logs, frame, flush, fire, mice, unanswered, detach: () => (attached = false), attach: () => (attached = true), timers, tops, top }
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
    // The page's own session refusing: dropped and logged once, never sendInputEvent while attached.
    s.page.opts.refuse.add('')
    s.router.input([move(5, 5)])
    await s.flush()
    expect(s.fallback).toEqual([])
    expect(s.logs).toContain("webview: the page's protocol refused input; dropped")
    expect(s.mice().some((m) => m[0] === 'C')).toBe(false)
  })

  it('a captured frame that went: the rest of the drag goes to the page session, its release nowhere', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.router.input([down(20, 225)])
    await s.flush()
    s.router.frameDetached('A')
    s.router.input([move(30, 225, true), up(30, 225)])
    await s.flush()
    // A release goes only where its press went: the page never got one, so it gets no stray release.
    expect(s.mice()).toEqual([
      ['A', 'mousePressed', 20, 25],
      ['', 'mouseMoved', 30, 225]
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
    // The release is routed only once the press was answered, the key once the release was.
    expect(s.page.sent.map((x) => `${x.session} ${x.params.type}`)).toEqual(['A mousePressed'])
    for (const h of s.page.held.splice(0)) h.resolve({})
    await s.flush()
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

  it('a key that misses STEP_TIMEOUT_MS stalls the page session: the next key waits for its answer, nothing else unanswered', async () => {
    const s = setup()
    s.page.opts.hold = true
    s.router.input([keyDown('a'), keyDown('b'), move(5, 5)])
    await s.flush()
    expect(s.page.sent.map((x) => x.params.key)).toEqual(['a'])
    expect(STEP_TIMEOUT_MS).toBe(500)
    // The deadline: the page session owes 'a' and gets nothing more until it answers; the pump waits
    // with no timer of its own.
    s.fire()
    await s.flush()
    expect(s.timers.size).toBe(0)
    expect(s.page.sent.map((x) => x.params.key)).toEqual(['a'])
    expect(s.logs).toEqual(['webview: the page or a frame did not answer input in time; it gets no more until it does'])
    // Typing goes on meanwhile: held in order behind 'b' (not sent), and goes once 'a' answered.
    // The moves are dropped while the page owes its answer, the one queued before the stall too
    // (the next move after it is hit-tested anew).
    s.router.input([keyDown('c'), move(6, 6)])
    await s.flush()
    expect(s.page.sent).toHaveLength(1)
    s.page.opts.hold = false
    s.page.held.shift()?.resolve({})
    await s.flush()
    expect(s.page.sent.map((x) => x.params.key ?? `${x.params.type} ${x.params.x}`)).toEqual(['a', 'b', 'c'])
    s.router.input([move(7, 7)])
    await s.flush()
    expect(s.mice()).toEqual([['', 'mouseMoved', 7, 7]])
  })

  // Ruling 2026-11-19 #10: a late query stalls its session exactly as a late command does (fuzz: a
  // hung getLayoutMetrics, then the event sent to that page session anyway).
  it('a hit-test query that misses ROUTE_TIMEOUT_MS stalls its session: nothing more goes to it until it answers', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.page.opts.holdQueries = true
    s.router.input([down(20, 225)])
    await s.flush()
    expect(s.page.heldQueries.map((q) => q.method)).toEqual(['Page.getLayoutMetrics'])
    expect(ROUTE_TIMEOUT_MS).toBeLessThan(STEP_TIMEOUT_MS)
    s.fire()
    await s.flush()
    s.router.input([up(20, 225), down(20, 226)])
    await s.flush()
    // No command and no second query to the page's session, and no timer left.
    expect(s.mice()).toEqual([])
    expect(s.page.queries).toHaveLength(1)
    expect(s.timers.size).toBe(0)
    s.page.opts.holdQueries = false
    for (const q of s.page.heldQueries.splice(0)) q.answer()
    await s.flush()
    // Answered: the press is hit-tested anew and goes where the point is, then the rest in order.
    expect(s.mice().map((m) => `${m[0]} ${m[1]}`)).toEqual(['A mousePressed', 'A mouseReleased', 'A mousePressed'])
  })

  it('one command at a time: a move waits for the one before it; moves waiting coalesce, wheels sum', async () => {
    const s = setup()
    s.page.opts.hold = true
    s.router.input([move(1, 1)])
    s.router.input([move(2, 2)])
    await s.flush()
    expect(s.mice().map((m) => m[2])).toEqual([1])
    s.router.input([move(3, 3), keyDown('a'), move(4, 4), move(5, 5)])
    s.router.input([{ type: 'mouseWheel', x: 6, y: 6, deltaX: 1, deltaY: -100, modifiers: [] }])
    s.router.input([{ type: 'mouseWheel', x: 7, y: 7, deltaX: 2, deltaY: -20, modifiers: [] }])
    for (let n = 0; n < 6; n++) {
      await s.flush()
      for (const h of s.page.held.splice(0)) h.resolve({})
    }
    await s.flush()
    // 2 and 3 were one move behind 1; 4 and 5 one behind the key; the two wheels one (DOM sign, summed).
    expect(s.page.sent.map((x) => x.params.key ?? `${x.params.type} ${x.params.x}`)).toEqual([
      'mouseMoved 1',
      'mouseMoved 3',
      'a',
      'mouseMoved 5',
      'mouseWheel 7'
    ])
    expect(s.page.sent.at(-1)?.params).toMatchObject({ deltaX: -3, deltaY: 120 })
  })

  // Review finding (codex): every release was exempt from the queue cap, so releases nothing had
  // pressed queued without bound against a hung page.
  // C7, ruling 2026-11-19 #2: past the cap only an up that matches a live press record gets in (the
  // left press was sent, so it has one); the key down `c` was still queued, so its up is dropped.
  it('a full queue drops moves first; past it a release goes only for a live press record', async () => {
    const s = setup()
    s.page.opts.hold = true
    // A press taken and a key down taken, then the pump held on a key and the queue overfilled.
    s.router.input([down(9, 9), keyDown('c')])
    await s.flush()
    const many: ElectronInputEvent[] = []
    for (let n = 0; n < MAX_QUEUED_STEPS + 10; n++) many.push(keyDown('d'))
    const stray: ElectronInputEvent[] = []
    for (let n = 0; n < 100; n++) stray.push({ type: 'keyUp', keyCode: 'x', modifiers: [] }, up(9, 9, 'right'))
    s.router.input([...many, ...stray, up(9, 9), { type: 'keyUp', keyCode: 'c', modifiers: [] }])
    expect(s.logs).toEqual(['webview: the page answers no input; input dropped'])
    // Let everything through: the matched release is there, at the end, and no stray one.
    for (let n = 0; n < 4 * MAX_QUEUED_STEPS && (s.page.held.length > 0 || s.timers.size > 0); n++) {
      for (const h of s.page.held.splice(0)) h.resolve({})
      await new Promise((r) => setTimeout(r, 0))
    }
    await s.flush()
    expect(s.page.sent.slice(-2).map((x) => x.params.type)).toEqual(['rawKeyDown', 'mouseReleased'])
    expect(s.page.sent.filter((x) => x.params.key === 'x' || x.params.key === 'c' && x.params.type === 'keyUp' || x.params.button === 'right')).toEqual([])
  })

  // Review finding (codex): continuous pointer input to one session never drained, so a renderer
  // that answers nothing collected unanswered dispatches without end.
  it('a page session that answers nothing: one unanswered command; moves dropped, a press waits for the answer', async () => {
    const s = setup()
    s.page.opts.hold = true
    for (let n = 0; n < 40; n++) {
      s.router.input([move(n, n)])
      await s.flush()
      s.fire()
    }
    await s.flush()
    expect(s.mice()).toHaveLength(1)
    s.router.input([down(5, 5)])
    await s.flush()
    s.fire()
    await s.flush()
    expect(s.mice().some((m) => m[1] === 'mousePressed')).toBe(false)
    s.page.held.shift()?.resolve({})
    await s.flush()
    expect(s.mice().at(-1)).toEqual(['', 'mousePressed', 5, 5])
  })

  // Review finding (codex): the route was chosen before waiting for the input in flight, so a wheel
  // that scrolled the frame away still sent the next press to it.
  it('routes a pointer event only after the press, release or wheel in flight was answered', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.page.opts.hold = true
    s.router.input([{ type: 'mouseWheel', x: 20, y: 25, deltaX: 0, deltaY: -300, modifiers: [] }, down(20, 225)])
    await s.flush()
    expect(s.mice()).toEqual([['', 'mouseWheel', 20, 25]])
    // The wheel scrolled A out from under (20, 225), then was answered.
    s.page.owners.set('', [{ node: 7, frameId: 'T-A', box: rect(0, -100, 600, 300), width: 600, height: 300 }])
    s.page.held.shift()?.resolve({})
    s.page.opts.hold = false
    await s.flush()
    expect(s.mice().at(-1)).toEqual(['', 'mousePressed', 20, 225])
  })

  it('routes again after a hover move that changed the page under the point', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.router.input([move(20, 25)])
    await s.flush()
    // Into A: the top gets its hover move over A's owner, which (a page's hover style) sets the
    // owner to pointer-events: none, so the hit test no longer finds A there.
    s.page.opts.onSent = (sent) => {
      if (sent.session === '' && sent.params.type === 'mouseMoved' && sent.params.y === 225) s.page.owners.set('', [])
    }
    s.router.input([down(20, 225)])
    await s.flush()
    expect(s.mice().at(-1)).toEqual(['', 'mousePressed', 20, 225])
    expect(s.mice().some((m) => m[0] === 'A')).toBe(false)
  })

  it('detached: every event by sendInputEvent at once, and no capture survives it', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.router.input([down(20, 225)])
    await s.flush()
    s.detach()
    s.router.input([move(30, 225, true), up(30, 225)])
    // The press went to frame A, which no detached road reaches: its up goes to A or nowhere, never
    // to the page (C7, the router contract), so only the move goes.
    expect(s.fallback).toEqual([move(30, 225, true)])
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

// The two codex reviews of the router's scheduling (round 1 of 833e290, round 2 of 0cbc4ec), one
// test per scenario, by the review's own words. Each failed on 0cbc4ec unless its comment says so.
describe('PageInputRouter scheduling: review scenarios', () => {
  /** Answer everything from here on, held commands included, until the queue has run out. */
  const answerAll = async (s: ReturnType<typeof setup>): Promise<void> => {
    s.page.opts.hold = false
    s.page.opts.holdSessions.clear()
    for (let n = 0; n < 4000; n++) {
      for (const h of s.page.held.splice(0)) h.resolve({})
      await new Promise((r) => setImmediate(r))
    }
  }

  // Round 2, MUST 1: "With eight unanswered moves to A, a press hit-tests A and waits for capacity. A
  // pending move opens an overlay and answers; the press still dispatches into obscured A."
  it('the press waiting for capacity into an obscured frame: hit-tested only once the move before it answered', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.page.opts.hold = true
    s.router.input([move(20, 225)])
    await s.flush()
    s.router.input([down(20, 225)])
    await s.flush()
    // The press waits for the move's answer: nothing else unanswered meanwhile.
    expect(s.mice()).toEqual([['A', 'mouseMoved', 20, 25]])
    // A's hover opened an overlay over its owner, then the move answered.
    s.page.owners.set('', [])
    s.page.opts.hold = false
    s.page.held.shift()?.resolve({})
    await s.flush()
    expect(s.mice().filter((m) => m[1] === 'mousePressed')).toEqual([['', 'mousePressed', 20, 225]])
  })

  it('the press waiting for capacity into an obscured frame: after eight unanswered moves it never goes to A', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.page.opts.hold = true
    for (let n = 0; n < 8; n++) {
      s.router.input([move(20 + n, 225)])
      await s.flush()
      s.fire()
      await s.flush()
    }
    s.router.input([down(20, 225)])
    await s.flush()
    s.page.owners.set('', [])
    s.page.opts.hold = false
    s.page.held.shift()?.resolve({})
    await s.flush()
    s.fire()
    await s.flush()
    expect(s.mice().filter((m) => m[1] === 'mousePressed')).toEqual([['', 'mousePressed', 20, 225]])
  })

  // Round 2, MUST 2: "Press Shift+A, release Shift, then release A: down is "A", up is "a". At
  // capacity, that legitimate release is dropped, leaving the page's key down."
  it('Shift+A release dropped at the cap: a release matches its press by the physical key', async () => {
    const s = setup()
    s.page.opts.hold = true
    s.router.input([{ type: 'keyDown', keyCode: 'A', modifiers: ['shift'] }, keyDown('c')])
    await s.flush()
    const many: ElectronInputEvent[] = []
    for (let n = 0; n < MAX_QUEUED_STEPS + 10; n++) many.push(keyDown('d'))
    s.router.input([...many, { type: 'keyUp', keyCode: 'a', modifiers: [] }])
    await answerAll(s)
    expect(s.page.sent.filter((x) => x.params.type === 'keyUp').map((x) => x.params.code)).toEqual(['KeyA'])
  })

  // Round 2, MUST 3: "Synthetic hover dispatches bypass both room() and track(). Saturate A, move to
  // the parent, then repeatedly move toward A. Hover commands accumulate while actual moves drop."
  it('hover dispatches uncounted: never more than one unanswered command on any session, hover moves included', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.page.opts.hold = true
    for (let n = 0; n < 12; n++) {
      s.router.input([move(20 + n, 225)])
      await s.flush()
      s.fire()
      await s.flush()
      s.router.input([move(20 + n, 25)])
      await s.flush()
      s.fire()
      await s.flush()
    }
    expect(Math.max(...s.unanswered().values())).toBe(1)
  })

  // Round 2, MUST (additional): "Eight unanswered moves followed by a press hold every later
  // key/event forever while attached. Deadlines fire, but merely restart the loop."
  it('permanent blockage after eight unanswered moves plus a press: a frame that never answers holds nothing else', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.page.opts.holdSessions.add('A')
    for (let n = 0; n < 8; n++) {
      s.router.input([move(20 + n, 225)])
      await s.flush()
      s.fire()
      await s.flush()
    }
    s.router.input([down(20, 225), up(20, 225), keyDown('q')])
    for (let n = 0; n < 3; n++) {
      await s.flush()
      s.fire()
    }
    await s.flush()
    // A gets nothing more (it still owes an answer); the press and release go to the page session
    // at the top point, the key on the page session as always.
    expect(s.page.sent.filter((x) => x.session === '' && x.method === 'Input.dispatchKeyEvent').map((x) => x.params.key)).toEqual(['q'])
    expect(s.mice().filter((m) => m[1] !== 'mouseMoved')).toEqual([
      ['', 'mousePressed', 20, 225],
      ['', 'mouseReleased', 20, 225]
    ])
    expect(s.unanswered().get('A')).toBe(1)
  })

  // Round 2, MUST (additional): "lost() clears the map, not its retained sets. An old dispatch
  // answering afterward decrements the reset pendingChanges to −1. A new press raises it to zero,
  // allowing subsequent pointer routing to skip the required drain."
  it('a late answer after lost() corrupting order: a move after a press still waits for that press', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.page.opts.hold = true
    s.router.input([down(20, 225)])
    await s.flush()
    // Its deadline passed (A stalled), then the protocol detached.
    s.fire()
    await s.flush()
    const old = s.page.held.shift()
    s.detach()
    s.router.reset()
    s.router.input([up(20, 225)])
    // The attachment went and its press records with it (C7: an epoch change deletes them): the up
    // has nothing to match, dropped.
    expect(s.fallback).toEqual([])
    // A new attachment: its frames are announced anew (new sessions).
    s.attach()
    s.page.owners.set('', [])
    s.frame('A2', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.router.input([down(20, 225)])
    await s.flush()
    old?.resolve({})
    await s.flush()
    s.router.input([move(30, 225, true)])
    await s.flush()
    // The new press is unanswered: the move waits for it.
    expect(s.mice()).toEqual([
      ['A', 'mousePressed', 20, 25],
      ['A2', 'mousePressed', 20, 25]
    ])
    s.page.held.shift()?.resolve({})
    await s.flush()
    expect(s.mice().at(-1)).toEqual(['A2', 'mouseMoved', 30, 25])
  })

  // Round 1, MUST 1: "A preceding wheel can scroll that frame away during the drain ... Dispatch
  // still targets the previously selected child." Fixed in 0cbc4ec (its test above, "routes a
  // pointer event only after the press, release or wheel in flight was answered", passes there
  // too); this is the same with a move in flight, which 0cbc4ec still routed past.
  it('stale target during drain: a press is hit-tested after the move in flight answered', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.page.opts.hold = true
    s.router.input([move(20, 226), down(20, 225)])
    await s.flush()
    expect(s.mice()).toEqual([['A', 'mouseMoved', 20, 26]])
    // The page scrolled A away meanwhile (a scroll-on-hover), then the move answered.
    s.page.owners.set('', [{ node: 7, frameId: 'T-A', box: rect(0, -100, 600, 300), width: 600, height: 300 }])
    s.page.opts.hold = false
    s.page.held.shift()?.resolve({})
    await s.flush()
    expect(s.mice().filter((m) => m[1] === 'mousePressed')).toEqual([['', 'mousePressed', 20, 225]])
  })

  // Round 1, MUST 2: "A probe queued 2,048 releases despite the 512-step cap." Fixed in 0cbc4ec for
  // stray releases (the test above, "a full queue drops moves first", passes there); a key released
  // over and over after one press still matches it once only.
  it('unbounded releases: one press lets one release past the cap, not every release of that key', async () => {
    const s = setup()
    s.page.opts.hold = true
    s.router.input([keyDown('c'), keyDown('e')])
    await s.flush()
    const many: ElectronInputEvent[] = []
    for (let n = 0; n < MAX_QUEUED_STEPS + 10; n++) many.push(keyDown('d'))
    const ups: ElectronInputEvent[] = []
    for (let n = 0; n < 50; n++) ups.push({ type: 'keyUp', keyCode: 'c', modifiers: [] })
    s.router.input([...many, ...ups])
    await answerAll(s)
    expect(s.page.sent.filter((x) => x.params.type === 'keyUp' && x.params.code === 'KeyC')).toHaveLength(1)
  })

  // Round 1, MUST 3: "Continuous pointer input to one session never calls drain() ... A probe produced
  // 500 pending dispatches and zero queued steps." 0cbc4ec capped it at eight per session.
  it('unbounded pending: a page that answers nothing has at most one unanswered command', async () => {
    const s = setup()
    s.page.opts.hold = true
    for (let n = 0; n < 40; n++) {
      s.router.input([move(n, n)])
      await s.flush()
      s.fire()
    }
    s.router.input([{ type: 'mouseWheel', x: 5, y: 5, deltaX: 0, deltaY: -120, modifiers: [] }, keyDown('a')])
    await s.flush()
    s.fire()
    await s.flush()
    expect(s.page.held).toHaveLength(1)
  })

  // Rule 3: the hit test is the last thing before the send; a page that changes on every hover is
  // hit-tested again MAX_RETESTS times, then the page session takes the event.
  it('a page that changes under every hover move: two re-tests, then the page session at the top point', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.frame('C', '', 8, rect(0, 200, 600, 300), 600, 300)
    const a = s.page.owners.get('')?.[0] as FakeOwner
    const c = s.page.owners.get('')?.[1] as FakeOwner
    s.page.owners.set('', [a])
    s.router.input([move(20, 25)])
    await s.flush()
    // Each hover move over an owner swaps which frame is under the point.
    s.page.opts.onSent = (sent) => {
      if (sent.session === '' && sent.params.type === 'mouseMoved' && sent.params.y === 225) s.page.owners.set('', [s.page.owners.get('')?.[0] === a ? c : a])
    }
    const hits = (): number => s.page.queries.filter((q) => q.method === 'DOM.getNodeForLocation').length
    const before = hits()
    s.router.input([down(20, 225)])
    await s.flush()
    expect(MAX_RETESTS).toBe(2)
    expect(hits() - before).toBe(1 + MAX_RETESTS)
    expect(s.mice().filter((m) => m[1] === 'mousePressed')).toEqual([['', 'mousePressed', 20, 225]])
  })

  // Rule 4: a stalled frame gets nothing more; its wheel goes to the page session at the top point.
  it('a frame that missed a deadline: its moves dropped, its wheel and press on the page session, until it answers', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.page.opts.holdSessions.add('A')
    s.router.input([move(20, 225)])
    await s.flush()
    s.fire()
    await s.flush()
    s.router.input([move(21, 225), { type: 'mouseWheel', x: 22, y: 225, deltaX: 0, deltaY: -120, modifiers: [] }, down(23, 225)])
    await s.flush()
    expect(s.mice()).toEqual([
      ['A', 'mouseMoved', 20, 25],
      ['', 'mouseWheel', 22, 225],
      ['', 'mousePressed', 23, 225]
    ])
    // A answers: it takes input again (the release follows the press's capture, the top).
    s.page.opts.holdSessions.clear()
    s.page.held.shift()?.resolve({})
    await s.flush()
    s.router.input([up(23, 225), move(24, 226)])
    await s.flush()
    expect(s.mice().slice(3)).toEqual([
      ['', 'mouseReleased', 23, 225],
      ['', 'mouseMoved', 24, 226],
      ['A', 'mouseMoved', 24, 26]
    ])
  })

  // Rule 7: each attachment has an epoch; an answer from an older one changes nothing.
  it('a late answer from before a detach clears no stall of the new attachment', async () => {
    const s = setup()
    s.page.opts.hold = true
    s.router.input([keyDown('a')])
    await s.flush()
    s.fire()
    await s.flush()
    const old = s.page.held.shift()
    s.detach()
    s.router.input([keyDown('x')])
    expect(s.fallback).toEqual([keyDown('x')])
    s.attach()
    s.router.input([keyDown('b')])
    await s.flush()
    s.fire()
    await s.flush()
    old?.resolve({})
    await s.flush()
    s.router.input([keyDown('c')])
    await s.flush()
    expect(s.page.sent.map((x) => x.params.key)).toEqual(['a', 'b'])
    s.page.held.shift()?.resolve({})
    await s.flush()
    expect(s.page.sent.map((x) => x.params.key)).toEqual(['a', 'b', 'c'])
  })

  it('a detach while keys wait for the stalled page session: they are dropped with the attachment', async () => {
    const s = setup()
    s.page.opts.hold = true
    s.router.input([keyDown('a'), keyDown('b')])
    await s.flush()
    s.fire()
    await s.flush()
    s.detach()
    s.router.reset()
    await s.flush()
    // C1 (the router contract): a step of an attachment that went sends nothing, by any road.
    expect(s.fallback).toEqual([])
  })

  it('a text or an edit command goes through the router: in order, one at a time, the detached road while detached', async () => {
    const s = setup()
    s.page.opts.hold = true
    const detached: string[] = []
    s.router.input([keyDown('a')])
    const text = s.router.command('Input.insertText', { text: 'é' }, () => detached.push('é'))
    s.router.input([keyDown('b')])
    await s.flush()
    expect(s.page.sent.map((x) => x.method)).toEqual(['Input.dispatchKeyEvent'])
    s.page.held.shift()?.resolve({})
    await s.flush()
    expect(s.page.sent.at(-1)).toEqual({ method: 'Input.insertText', params: { text: 'é' }, session: '' })
    s.page.held.shift()?.resolve('inserted')
    await expect(text).resolves.toBe('inserted')
    await s.flush()
    expect(s.page.sent.map((x) => x.params.key ?? x.params.text)).toEqual(['a', 'é', 'b'])
    s.page.held.shift()?.resolve({})
    await s.flush()
    s.detach()
    await expect(s.router.command('Input.insertText', { text: 'ü' }, () => detached.push('ü'))).resolves.toBe(1)
    expect(detached).toEqual(['ü'])
  })
})

// The third codex review (of c1c623f): four musts and a should, one test each.
describe('PageInputRouter scheduling: review 3', () => {
  // MUST: "keys A then B; A's deadline fires, A answers in the next microtask; B returns park, A's
  // answer clears the stall and calls pump(), which returns because pumping is true; the running pump
  // then parks unconditionally and B waits with no outstanding command or timer."
  it('lost wakeup while parking: a stall cleared while the next step parks still lets it go', async () => {
    for (let delay = 0; delay < 8; delay++) {
      const s = setup()
      s.page.opts.hold = true
      s.router.input([keyDown('a'), keyDown('b')])
      await s.flush()
      const a = s.page.held.shift()
      s.page.opts.hold = false
      s.fire()
      for (let n = 0; n < delay; n++) await Promise.resolve()
      a?.resolve({})
      await s.flush()
      expect([delay, s.page.sent.map((x) => x.params.key)]).toEqual([delay, ['a', 'b']])
    }
  })

  // MUST: "left press to frame A, A's answer withheld past the deadline, then the release goes only
  // to the page session and capture is cleared; when A answers, nobody sends A its mouseReleased."
  // Ruling 2026-11-19 #2 (C5, reversing ruling 3): a stalled session's release is sent to it at once,
  // in order, never parked behind later input.
  it('a stalled frame loses its release: the release goes to A at once, never to the page', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.page.opts.holdSessions.add('A')
    s.router.input([down(20, 225)])
    await s.flush()
    s.fire()
    await s.flush()
    s.router.input([up(30, 230)])
    await s.flush()
    // To A at once; nothing to the page session (it never got the press).
    expect(s.mice()).toEqual([
      ['A', 'mousePressed', 20, 25],
      ['A', 'mouseReleased', 30, 30]
    ])
    s.page.opts.holdSessions.clear()
    s.page.held.shift()?.resolve({})
    await s.flush()
    expect(s.mice()).toEqual([
      ['A', 'mousePressed', 20, 25],
      ['A', 'mouseReleased', 30, 30]
    ])
    expect(s.page.sent.at(-1)?.params).toMatchObject({ button: 'left', buttons: 0 })
  })

  it("a stalled frame's release when its box cannot be read: owed at the press point", async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.page.opts.holdSessions.add('A')
    s.router.input([down(20, 225)])
    await s.flush()
    s.fire()
    await s.flush()
    s.page.owners.set('', [])
    s.router.input([up(30, 230)])
    await s.flush()
    s.page.opts.holdSessions.clear()
    s.page.held.shift()?.resolve({})
    await s.flush()
    expect(s.mice()).toEqual([
      ['A', 'mousePressed', 20, 25],
      ['A', 'mouseReleased', 20, 25]
    ])
  })

  // Ruling 2026-11-19 #2: the release went to stalled A at once; A or the protocol going after it
  // sends nothing more anywhere.
  it("a stalled frame's release goes at once; A or the protocol going after it sends nothing more", async () => {
    for (const end of ['frame', 'protocol'] as const) {
      const s = setup()
      s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
      s.page.opts.holdSessions.add('A')
      s.router.input([down(20, 225)])
      await s.flush()
      s.fire()
      await s.flush()
      s.router.input([up(30, 230)])
      await s.flush()
      if (end === 'frame') s.router.frameDetached('A')
      else {
        s.detach()
        s.router.reset()
        s.attach()
      }
      s.page.held.shift()?.resolve({})
      await s.flush()
      expect([end, s.mice()]).toEqual([
        end,
        [
          ['A', 'mousePressed', 20, 25],
          ['A', 'mouseReleased', 30, 30]
        ]
      ])
    }
  })

  // MUST: "edit-command keydowns (Cmd+ArrowLeft through command('Input.dispatchKeyEvent', ...)) are not
  // recorded as pressed, so their keyup is dropped past the cap."
  it('an edit command key down counts as pressed: its key up passes the cap', async () => {
    const s = setup()
    s.page.opts.hold = true
    void s.router.command(
      'Input.dispatchKeyEvent',
      { type: 'rawKeyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, modifiers: 4, commands: ['moveToLeftEndOfLine'] },
      () => undefined
    )
    await s.flush()
    const many: ElectronInputEvent[] = []
    for (let n = 0; n < MAX_QUEUED_STEPS + 10; n++) many.push(keyDown('d'))
    s.router.input([...many, { type: 'keyUp', keyCode: 'Left', modifiers: ['meta'] }])
    s.page.opts.hold = false
    for (let n = 0; n < 4000; n++) {
      for (const h of s.page.held.splice(0)) h.resolve({})
      await new Promise((r) => setImmediate(r))
    }
    expect(s.page.sent.filter((x) => x.params.type === 'keyUp').map((x) => x.params.code)).toEqual(['ArrowLeft'])
  })

  // MUST: "send A's keydown, detach and reattach, then reject the original command before its
  // deadline; sendInput.end() resolves refused without an epoch check and pageRefused() replays the
  // old key through sendInputEvent into the new page. Same missing guard on the page-session
  // mouse-refusal path."
  it('old-epoch rejection injects input: a refusal from before a detach replays nothing', async () => {
    for (const event of [keyDown('a'), down(5, 5)]) {
      const s = setup()
      s.page.opts.hold = true
      s.router.input([event])
      await s.flush()
      const old = s.page.held.shift()
      s.detach()
      s.router.reset()
      s.attach()
      old?.reject(new Error('target closed'))
      await s.flush()
      expect([event.type, s.fallback]).toEqual([event.type, []])
    }
  })

  // SHOULD: rule 2's contract. At most one command on its way per page, except those of stalled
  // sessions: a command that missed its deadline no longer holds the others (it holds its own session
  // only), so a frame that never answers cannot block the page.
  it('one command on its way per page, stalled sessions excepted', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.page.opts.hold = true
    s.router.input([down(20, 225), keyDown('q'), keyDown('r')])
    await s.flush()
    // The press is on its way: nothing else is.
    expect(s.page.held.map((h) => h.sent.session)).toEqual(['A'])
    s.fire()
    await s.flush()
    // A is stalled (its press still unanswered); the page goes on with one command of its own.
    expect(s.page.held.map((h) => `${h.sent.session} ${h.sent.params.key ?? h.sent.params.type}`)).toEqual(['A mousePressed', ' q'])
    const q = s.page.held.pop()
    q?.resolve({})
    await s.flush()
    expect(s.page.held.map((h) => `${h.sent.session} ${h.sent.params.key ?? h.sent.params.type}`)).toEqual(['A mousePressed', ' r'])
  })
})

/** Every string the router still holds in its own fields (maps, sets, arrays and records a few levels deep). */
function heldStrings(router: object): Set<string> {
  const found = new Set<string>()
  const seen = new Set<unknown>()
  const walk = (v: unknown, depth: number): void => {
    if (depth > 5 || v === null || v === undefined) return
    if (typeof v === 'string') return void found.add(v)
    if (typeof v !== 'object' || seen.has(v) || v instanceof Promise) return
    seen.add(v)
    if (v instanceof Map) {
      for (const [k, x] of v) {
        walk(k, depth + 1)
        walk(x, depth + 1)
      }
    } else if (v instanceof Set || Array.isArray(v)) for (const x of v) walk(x, depth + 1)
    else for (const x of Object.values(v)) walk(x, depth + 1)
  }
  for (const [k, v] of Object.entries(router)) if (k !== 'deps' && k !== 'timers') walk(v, 0)
  return found
}

// The fourth codex review of the router (of 59a3b00), one test per MUST, by the review's words.
describe('PageInputRouter scheduling: review 4', () => {
  // MUST: "Left-down reaches A and times out. Right-down falls back to the page while capture retains
  // A's links. A answers; right-up follows capture into A because releaseToPress ignores presses
  // recorded on the page session. The page receives right-down without right-up."
  it('a release goes to the session its press went to: the page, while the capture keeps A', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.page.opts.holdSessions.add('A')
    s.router.input([down(20, 225)])
    await s.flush()
    s.fire()
    await s.flush()
    // A owes its answer: the right press goes to the page's session at the top point.
    s.router.input([{ type: 'mouseDown', x: 30, y: 230, button: 'right', clickCount: 1, modifiers: ['leftbuttondown'] }])
    await s.flush()
    s.page.opts.holdSessions.clear()
    s.page.held.shift()?.resolve({})
    await s.flush()
    s.router.input([{ type: 'mouseUp', x: 30, y: 230, button: 'right', clickCount: 1, modifiers: ['leftbuttondown'] }, up(40, 240)])
    await s.flush()
    expect(s.mice().filter((m) => m[1] !== 'mouseMoved')).toEqual([
      ['A', 'mousePressed', 20, 25],
      ['', 'mousePressed', 30, 230],
      ['', 'mouseReleased', 30, 230],
      ['A', 'mouseReleased', 40, 40]
    ])
  })

  // MUST: "Send a page keydown, withhold its answer past 500 ms, then press inside ready frame A. A
  // receives the press immediately; wheels and releases can likewise proceed."
  it('a stalled page session holds everything, pointer input into a frame included, until it answers', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.page.opts.holdSessions.add('')
    s.router.input([keyDown('a')])
    await s.flush()
    s.fire()
    await s.flush()
    const queried = s.page.queries.length
    s.router.input([down(20, 225), { type: 'mouseWheel', x: 20, y: 225, deltaX: 0, deltaY: -120, modifiers: [] }, up(20, 225)])
    await s.flush()
    // Nothing at all: no input, not even a hit test.
    expect(s.mice()).toEqual([])
    expect(s.page.queries.length).toBe(queried)
    s.page.opts.holdSessions.clear()
    s.page.held.shift()?.resolve({})
    await s.flush()
    expect(s.mice().map((m) => `${m[0]} ${m[1]}`)).toEqual(['A mousePressed', 'A mouseWheel', 'A mouseReleased'])
  })

  // MUST: "Hover A, then press outside it; withhold A's synthetic hover-exit answer. Detach/reset/
  // reattach, then reject that old command. leave() returns false, the step returns `again`, and the
  // old press is dispatched into the new attachment."
  it('an old hover-exit refusal replays nothing into the new attachment', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.router.input([move(20, 225)])
    await s.flush()
    s.page.opts.holdSessions.add('A')
    s.router.input([down(700, 50)])
    await s.flush()
    expect(s.mice()).toEqual([
      ['A', 'mouseMoved', 20, 25],
      ['A', 'mouseMoved', -1, -1]
    ])
    const old = s.page.held.shift()
    s.detach()
    s.router.reset()
    s.attach()
    old?.reject(new Error('target closed'))
    await s.flush()
    s.fire()
    await s.flush()
    expect(s.mice()).toEqual([
      ['A', 'mouseMoved', 20, 25],
      ['A', 'mouseMoved', -1, -1]
    ])
    expect(s.fallback).toEqual([])
  })

  // MUST (same finding): "Stale hit-test continuations similarly requeue."
  it('a hit test answered after a detach replays nothing into the new attachment', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.page.opts.holdQueries = true
    s.router.input([down(20, 225)])
    await s.flush()
    expect(s.page.heldQueries.map((q) => q.method)).toEqual(['Page.getLayoutMetrics'])
    s.detach()
    s.router.reset()
    s.attach()
    s.page.opts.holdQueries = false
    s.page.heldQueries.shift()?.answer()
    await s.flush()
    s.fire()
    await s.flush()
    expect(s.mice()).toEqual([])
    expect(s.page.queries.map((q) => q.method)).toEqual(['Page.getLayoutMetrics'])
  })

  // MUST: "Send input to A, detach A before its deadline, then let the deadline fire while its
  // command remains unresolved. The timer reinserts A into `stalled` after frameDetached() removed it.
  // Repeat with fresh sessions: the map and promises grow without bound."
  it('a frame that went is held nowhere, its deadline firing after it went included', async () => {
    const s = setup()
    for (let n = 0; n < 50; n++) {
      const id = `A${n}`
      s.page.owners.set('', [])
      s.frame(id, '', 7, rect(0, 200, 600, 300), 600, 300)
      s.page.opts.holdSessions.add(id)
      s.router.input([move(20 + (n % 2), 225)])
      await s.flush()
      expect(s.page.held.at(-1)?.sent.session).toBe(id)
      s.router.frameDetached(id)
      s.fire()
      await s.flush()
    }
    const held = [...heldStrings(s.router)].filter((v) => /^A\d+$/.test(v) || v === 'T-A0')
    expect(held).toEqual([])
    expect(s.timers.size).toBe(0)
  })

  // MUST: "Down in A; move outside A with no button modifiers; then up outside. The move clears
  // pressedAt, so the up reaches the page instead of A. A never receives its release."
  it('a move with no button held sends the lost release to the press\'s frame, once', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.router.input([down(20, 225), move(700, 50), up(700, 50)])
    await s.flush()
    expect(s.mice().filter((m) => m[1] !== 'mouseMoved').map((m) => `${m[0]} ${m[1]}`)).toEqual(['A mousePressed', 'A mouseReleased'])
    // The move itself, no longer captured, is hit-tested: the top document, A's hover ended first.
    expect(s.mice().filter((m) => m[1] === 'mouseMoved')).toEqual([
      ['A', 'mouseMoved', -1, -1],
      ['', 'mouseMoved', 700, 50]
    ])
  })
})

// Found by page-input.fuzz.test.ts (a mutation it caught at 20,000 seeds; pinned here).
// Ruling 2026-11-19 #2 (C5): there are no owed releases any more; a stalled frame's release goes at
// once and is on its way like any command, so the next press waits for it.
describe('PageInputRouter scheduling: a stalled frame\'s release', () => {
  it('a stalled frame gets its release at once, before the press after it', async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.router.input([down(20, 225)])
    await s.flush()
    // A drag move A does not answer in time (A stalled), then the release: to A at once.
    s.page.opts.holdSessions.add('A')
    s.router.input([move(30, 230, true)])
    await s.flush()
    s.fire()
    await s.flush()
    s.router.input([up(30, 230)])
    await s.flush()
    // The next press waits for the release on its way: not even hit-tested.
    s.page.opts.holdQueries = true
    s.router.input([down(40, 240)])
    await s.flush()
    expect(s.page.heldQueries).toHaveLength(0)
    s.page.opts.holdSessions.clear()
    // A answers the move and the release.
    for (const h of s.page.held.splice(0)) h.resolve({})
    await s.flush()
    s.page.opts.holdQueries = false
    for (let n = 0; n < 10 && s.page.heldQueries.length > 0; n++) {
      s.page.heldQueries.shift()?.answer()
      await s.flush()
    }
    expect(s.mice().filter((m) => m[1] !== 'mouseMoved')).toEqual([
      ['A', 'mousePressed', 20, 25],
      ['A', 'mouseReleased', 30, 30],
      ['A', 'mousePressed', 40, 40]
    ])
  })
})

// The fifth codex review (of b551fe8): its three MUSTs, by its words, and the owner's decision
// that a refusal while attached is dropped, never replayed by another road.
describe('PageInputRouter scheduling: review 5', () => {
  /** A detach, reset and new attachment a few microtasks from now: between the router's continuations. */
  const reconnectSoon = (s: ReturnType<typeof setup>, microtasks: number): void => {
    let left = microtasks
    const tick = (): void => {
      if (left-- > 0) return queueMicrotask(tick)
      s.detach()
      s.router.reset()
      s.attach()
    }
    queueMicrotask(tick)
  }

  // MUST 1: "Reject a command, then queue a microtask that detaches/resets/reattaches. outcome
  // resolves before reset, but run resumes afterward and invokes the old detached callback without
  // rechecking epoch. The key-refusal path has the same gap."
  it('a refused text, edit command or key runs no other road, a reconnect between its continuations included', async () => {
    for (let microtasks = 0; microtasks < 6; microtasks++) {
      const s = setup()
      s.page.opts.refuse.add('')
      const roads: string[] = []
      const text = s.router.command('Input.insertText', { text: 'A' }, () => void roads.push('insertText A'))
      const edit = s.router.command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', commands: ['selectAll'] }, () => void roads.push('selectAll'))
      s.router.input([keyDown('b')])
      reconnectSoon(s, microtasks)
      await expect(text).rejects.toThrow()
      await expect(edit).rejects.toThrow()
      await s.flush()
      expect([microtasks, roads, s.fallback]).toEqual([microtasks, [], []])
    }
  })

  // MUST 2: "Refuse text A; its detached insertText returns a pending promise; enqueue key B.
  // settle() starts A but returns immediately, so the router sends B before A completes."
  it('a refused text is dropped, so nothing of it can land after the key behind it', async () => {
    const s = setup()
    s.page.opts.refuse.add('')
    let landed = 0
    const text = s.router.command('Input.insertText', { text: 'A' }, () => new Promise<void>((r) => setTimeout(() => (landed++, r()), 5)))
    await expect(text).rejects.toThrow()
    s.page.opts.refuse.clear()
    s.router.input([keyDown('b')])
    await s.flush()
    await new Promise((r) => setTimeout(r, 20))
    expect(landed).toBe(0)
    expect(s.page.sent.map((x) => x.params.key)).toEqual(['b'])
  })

  // MUST 3: "Send left-down to A; detach A; reject its outstanding command before 500 ms. finish()
  // checks epoch but not lane.live, returns refused, and dispatch() sends left-down onto the page."
  it("a frame that went: its refusal replays nothing on the page, and its release is dropped with it", async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.page.opts.holdSessions.add('A')
    s.router.input([down(20, 225)])
    await s.flush()
    s.router.frameDetached('A')
    s.page.held.shift()?.reject(new Error('No session with given id'))
    await s.flush()
    s.router.input([up(20, 225)])
    await s.flush()
    expect(s.mice()).toEqual([['A', 'mousePressed', 20, 25]])
    expect(s.fallback).toEqual([])
  })

  // The path the decision keeps: a LIVE frame's refusal goes to the page at the top point, and that
  // press's release goes to the page too (it owes it there).
  it("a live frame's refusal goes to the page, and the press's release with it", async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.page.opts.refuse.add('A')
    s.router.input([down(20, 225)])
    await s.flush()
    s.page.opts.refuse.clear()
    s.router.input([up(30, 230)])
    await s.flush()
    expect(s.mice()).toEqual([
      ['', 'mousePressed', 20, 225],
      ['', 'mouseReleased', 30, 230]
    ])
  })
})

// The coordinator's decision after review 5: while attached, the page's own session refusing a
// pointer event drops it too (sendInputEvent only for a protocol detached when the step runs), and
// the pairing stays right.
describe('PageInputRouter scheduling: a page refusal while attached', () => {
  it('a refused press records nothing (its release is dropped); a refused release clears its press', async () => {
    const s = setup()
    s.page.opts.refuse.add('')
    s.router.input([down(20, 20)])
    await s.flush()
    s.page.opts.refuse.clear()
    s.router.input([up(20, 20), down(30, 30)])
    await s.flush()
    s.page.opts.refuse.add('')
    s.router.input([up(30, 30)])
    await s.flush()
    s.page.opts.refuse.clear()
    s.router.input([move(40, 40), down(50, 50), up(50, 50)])
    await s.flush()
    expect(s.fallback).toEqual([])
    expect(s.mice()).toEqual([
      ['', 'mousePressed', 30, 30],
      ['', 'mouseMoved', 40, 40],
      ['', 'mousePressed', 50, 50],
      ['', 'mouseReleased', 50, 50]
    ])
    expect(s.logs.filter((l) => /refused input; dropped/.test(l))).toHaveLength(1)
  })
})

// The sixth codex review (of de01148): one MUST, two SHOULDs and a nit, by its words.
describe('PageInputRouter scheduling: review 6', () => {
  const answerAll = async (s: ReturnType<typeof setup>): Promise<void> => {
    s.page.opts.hold = false
    s.page.opts.holdSessions.clear()
    for (let n = 0; n < 4000; n++) {
      for (const h of s.page.held.splice(0)) h.resolve({})
      await new Promise((r) => setImmediate(r))
    }
  }

  // MUST: "Hover A, then press outside A. Refuse A's synthetic exit; after sendInput settles its
  // outcome, detach A in a microtask before moveTo resumes. moveTo ignores the outcome and checks
  // only epoch/page stall, so the dead session's continuation still dispatches the waiting press."
  // Superseded by C1 of the router contract: a pointer event whose target frame went is sent to the
  // page's session at the top point, never dropped and never to a frame. The press was hit-tested to
  // the page: it goes there, once, and nothing goes by sendInputEvent.
  it('a hover exit whose session went before the step goes on: the press still goes to the page, once', async () => {
    for (const microtasks of [0, 1]) {
      const s = setup()
      s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
      s.router.input([move(20, 225)])
      await s.flush()
      s.page.opts.holdSessions.add('A')
      s.router.input([down(20, 25)])
      await s.flush()
      const exit = s.page.held.shift()
      expect(exit?.sent.params).toMatchObject({ type: 'mouseMoved', x: -1, y: -1 })
      exit?.reject(new Error('No session with given id'))
      if (microtasks === 0) s.router.frameDetached('A')
      else queueMicrotask(() => s.router.frameDetached('A'))
      await s.flush()
      expect([microtasks, s.mice().filter((m) => m[1] === 'mousePressed')]).toEqual([microtasks, [['', 'mousePressed', 20, 25]]])
      expect(s.fallback).toEqual([])
    }
  })

  // Nit: "Hover A; refuse its exit while pressing outside. The ignored outcome produces no refusal log."
  it("a live frame refusing its hover exit: logged once, and the press is routed again (to the page)", async () => {
    const s = setup()
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.router.input([move(20, 225)])
    await s.flush()
    s.page.opts.refuse.add('A')
    s.router.input([down(20, 25), up(20, 25)])
    await s.flush()
    expect(s.mice().slice(-2)).toEqual([
      ['', 'mousePressed', 20, 25],
      ['', 'mouseReleased', 20, 25]
    ])
    expect(s.logs.filter((l) => /refused/.test(l))).toHaveLength(1)
  })

  // SHOULD: "Detach; start call(asyncChoice, true); enqueue a key. The key immediately uses
  // fallback before the choice finishes."
  it('detached: a blocking call holds the input behind it until it settles', async () => {
    const s = setup()
    s.detach()
    let finish: () => void = () => {}
    const order: string[] = []
    void s.router.call(() => new Promise<void>((r) => (finish = () => (order.push('choice'), r()))), true)
    s.router.input([keyDown('b')])
    await s.flush()
    expect(s.fallback).toEqual([])
    finish()
    await s.flush()
    expect(order).toEqual(['choice'])
    expect(s.fallback.map((e) => e.type)).toEqual(['keyDown'])
  })

  // Rulings 2026-11-19 #5, #7 and #11: a detached delivery that misses its deadline stalls the detached
  // road until it settles or the renderer goes; a reset drops what waits but keeps the stall; the
  // renderer going is a full reset (what waited is dropped) and ends the stall.
  it('detached: a text that never settles holds the next one, across a reset, until the renderer goes', async () => {
    const s = setup()
    s.detach()
    const roads: string[] = []
    void s.router.command('Input.insertText', { text: 'a' }, () => (roads.push('a'), new Promise(() => {}))).catch(() => {})
    await s.flush()
    s.fire()
    await s.flush()
    s.router.reset()
    void s.router.command('Input.insertText', { text: 'b' }, () => (roads.push('b'), 'b')).catch(() => {})
    s.router.input([keyDown('c')])
    await s.flush()
    expect(roads).toEqual(['a'])
    expect(s.fallback).toEqual([])
    s.router.rendererGone()
    await s.flush()
    // What waited was the gone renderer's: dropped. The new one's input goes at once.
    expect(roads).toEqual(['a'])
    void s.router.command('Input.insertText', { text: 'd' }, () => (roads.push('d'), 'd')).catch(() => {})
    s.router.input([keyDown('e')])
    await s.flush()
    expect(roads).toEqual(['a', 'd'])
    expect(s.fallback.map((e) => e.type)).toEqual(['keyDown'])
  })

  // Codex (merge bar O4): the renderer went before a text's deadline; that deadline then stalled the
  // new renderer's road for good.
  it('detached: the renderer going before a delivery\'s deadline leaves no stall behind', async () => {
    const s = setup()
    s.detach()
    const roads: string[] = []
    void s.router.command('Input.insertText', { text: 'a' }, () => (roads.push('a'), new Promise(() => {}))).catch(() => {})
    await s.flush()
    s.router.rendererGone()
    await s.flush()
    // The wait ended with the renderer: its deadline timer is gone too.
    expect(s.timers.size).toBe(0)
    void s.router.command('Input.insertText', { text: 'b' }, () => (roads.push('b'), 'b')).catch(() => {})
    s.router.input([keyDown('c')])
    await s.flush()
    expect(roads).toEqual(['a', 'b'])
    expect(s.fallback.map((e) => e.type)).toEqual(['keyDown'])
  })

  // Codex (merge bar O4): calls were not counted, so each missed deadline let another one through.
  it('at most one call on its way: the next call waits for it, and past its deadline holds what follows until it settles', async () => {
    const s = setup()
    const ran: string[] = []
    let finish = (): void => {}
    void s.router.call(() => (ran.push('read'), new Promise<void>((r) => (finish = r))), false)
    void s.router.call(() => (ran.push('choice'), 'ok'))
    s.router.input([keyDown('a')])
    await s.flush()
    expect(ran).toEqual(['read'])
    s.fire()
    await s.flush()
    // Late: the second call and the key after it wait (no timer of the router's left).
    expect(ran).toEqual(['read'])
    expect(s.page.sent).toEqual([])
    expect(s.timers.size).toBe(0)
    finish()
    await s.flush()
    expect(ran).toEqual(['read', 'choice'])
    expect(s.page.sent.map((x) => x.params.key)).toEqual(['a'])
  })

  // Codex (O4): a late call's answer came between callHeld seeing it late and the pump acting on that;
  // its wake found the pump busy and was lost, so the next call and the key stayed queued for good.
  it('a call answered right after its deadline wakes the pump even while the pump is still deciding', async () => {
    const s = setup()
    const ran: string[] = []
    let finishA = (): void => {}
    void s.router.call(() => (ran.push('A'), new Promise<void>((r) => (finishA = r))), false)
    void s.router.call(() => (ran.push('B'), 'ok'))
    s.router.input([keyDown('k')])
    await s.flush()
    expect(ran).toEqual(['A'])
    // A's deadline, and its answer one microtask later: before callHeld's verdict reaches the pump.
    s.fire()
    finishA()
    await s.flush()
    expect(ran).toEqual(['A', 'B'])
    expect(s.page.sent.map((x) => x.params.key)).toEqual(['k'])
  })

  // Rulings 2026-11-19 #9 and #11: the call stall is the renderer's; the renderer going ends it (and
  // drops what waited, a full reset).
  it('the renderer going ends a hung call: the next call goes at once, and the old one settling changes nothing', async () => {
    const s = setup()
    const ran: string[] = []
    let finishOld = (): void => {}
    let finishNew = (): void => {}
    void s.router.call(() => (ran.push('old'), new Promise<void>((r) => (finishOld = r))))
    const waited = s.router.call(() => (ran.push('waited'), 'never'))
    await s.flush()
    s.fire()
    await s.flush()
    expect(ran).toEqual(['old'])
    s.router.rendererGone()
    await expect(waited).rejects.toThrow('reset')
    void s.router.call(() => (ran.push('new'), new Promise<void>((r) => (finishNew = r))), false)
    void s.router.call(() => (ran.push('last'), 'ok'))
    await s.flush()
    expect(ran).toEqual(['old', 'new'])
    // The old call settling now does not stand in for the new one.
    finishOld()
    await s.flush()
    expect(ran).toEqual(['old', 'new'])
    finishNew()
    await s.flush()
    expect(ran).toEqual(['old', 'new', 'last'])
  })

  // SHOULD: "Deliver KeyA down; reset/reconnect; stall the new page and fill its queue with 512
  // steps; submit KeyA up. pressed still contains the old attachment's KeyA, admitting step 513."
  it("a reset forgets the presses it discarded: past the new queue's cap their releases are dropped", async () => {
    const s = setup()
    s.router.input([keyDown('a'), down(10, 10)])
    await s.flush()
    s.detach()
    s.router.reset()
    s.attach()
    s.page.opts.hold = true
    s.router.input([keyDown('c')])
    await s.flush()
    s.fire()
    await s.flush()
    const many: ElectronInputEvent[] = []
    for (let n = 0; n < MAX_QUEUED_STEPS + 10; n++) many.push(keyDown('d'))
    s.router.input([...many, { type: 'keyUp', keyCode: 'a', modifiers: [] }, up(10, 10)])
    await answerAll(s)
    expect(s.page.sent.filter((x) => x.params.type === 'keyUp').map((x) => x.params.code)).toEqual([])
    expect(s.mice().filter((m) => m[1] === 'mouseReleased')).toEqual([])
  })

  // Found by the oracle above while fixing it: a key down sent by sendInputEvent while detached is
  // the page's all the same, so its key up passes the cap once attached again (it was forgotten).
  it('a key down sent while detached: its key up still passes the cap after the protocol is back', async () => {
    const s = setup()
    s.detach()
    s.router.input([keyDown('a')])
    expect(s.fallback.map((e) => e.type)).toEqual(['keyDown'])
    s.attach()
    s.page.opts.hold = true
    s.router.input([keyDown('c')])
    await s.flush()
    s.fire()
    await s.flush()
    const many: ElectronInputEvent[] = []
    for (let n = 0; n < MAX_QUEUED_STEPS + 10; n++) many.push(keyDown('d'))
    s.router.input([...many, { type: 'keyUp', keyCode: 'a', modifiers: [] }])
    await answerAll(s)
    expect(s.page.sent.filter((x) => x.params.type === 'keyUp').map((x) => x.params.code)).toEqual(['KeyA'])
  })
})

describe('rectFromFrame / rectToTop', () => {
  const box = (content: number[], border: number[], width: number, height: number) => ({ content, border, width, height })

  it("maps a frame's rectangle into its parent through the content box (a border, a scale)", () => {
    const bordered = box(rect(8, 208, 600, 300), rect(0, 200, 616, 316), 616, 316)
    expect(rectFromFrame(bordered, { x: 10, y: 120, width: 150, height: 24 })).toEqual({ x: 18, y: 328, width: 150, height: 24 })
    const scaled = box(rect(650, 200, 150, 150), rect(650, 200, 150, 150), 300, 300)
    expect(rectFromFrame(scaled, { x: 10, y: 120, width: 150, height: 24 })).toEqual({ x: 655, y: 260, width: 75, height: 12 })
  })

  it('takes the bounding box of a rotated frame, and is the inverse of pointInFrame', () => {
    const q = [400, 100, 400, 300, 300, 300, 300, 100]
    const rotated = box(q, q, 200, 100)
    const all = rectFromFrame(rotated, { x: 0, y: 0, width: 200, height: 100 }) as { x: number; y: number; width: number; height: number }
    expect(all.x).toBeCloseTo(300)
    expect(all.y).toBeCloseTo(100)
    expect(all.width).toBeCloseTo(100)
    expect(all.height).toBeCloseTo(200)
    // A rectangle's corner mapped up, then that point mapped down again: the same frame point.
    const corner = rectFromFrame(rotated, { x: 50, y: 10, width: 0, height: 0 }) as { x: number; y: number }
    const back = pointInFrame(rotated, corner.x, corner.y) as { x: number; y: number }
    expect(back.x).toBeCloseTo(50)
    expect(back.y).toBeCloseTo(10)
  })

  it('refuses what pointInFrame refuses (a perspective quad, a flat box) and a rectangle that is none', () => {
    const q = [0, 0, 100, 0, 200, 200, 0, 200]
    expect(rectFromFrame(box(q, q, 200, 200), { x: 0, y: 0, width: 10, height: 10 })).toBeUndefined()
    expect(rectFromFrame(box(rect(0, 0, 10, 10), rect(0, 0, 10, 10), 0, 10), { x: 0, y: 0, width: 1, height: 1 })).toBeUndefined()
    const ok = box(rect(0, 0, 100, 100), rect(0, 0, 100, 100), 100, 100)
    for (const bad of [undefined, null, 'x', { x: 0, y: 0, width: -1, height: 1 }, { x: Number.NaN, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 1 }, { x: 1e9, y: 0, width: 1, height: 1 }]) {
      expect(rectFromFrame(ok, bad), JSON.stringify(bad)).toBeUndefined()
    }
  })

  it('rectToTop goes up from the deepest owner; with none it only checks the rectangle', () => {
    const a = box(rect(0, 200, 600, 300), rect(0, 200, 600, 300), 600, 300)
    const b = box(rect(300, 100, 280, 180), rect(300, 100, 280, 180), 280, 180)
    const r = rectToTop([a, b], { x: 10, y: 120, width: 150, height: 24 })
    expect(r && Object.values(r).map((n) => Math.round(n * 1000) / 1000)).toEqual([310, 420, 150, 24])
    expect(rectToTop([], { x: 1, y: 2, width: 3, height: 4 })).toEqual({ x: 1, y: 2, width: 3, height: 4 })
    expect(rectToTop([], { x: 1, y: 2 })).toBeUndefined()
    expect(rectToTop([a, { content: [1] }], { x: 1, y: 2, width: 3, height: 4 })).toBeUndefined()
  })
})

/**
 * main's scripts on the fake sessions, answered as Chromium does (checked under Electron 45.1.0 with
 * a probe, 2026-11-20): `Page.createIsolatedWorld` gives the session's current document a context
 * (the same one again while it lives), a `Runtime.evaluate` with any other context id is refused (a
 * new document), by value the session's own answer to the code, by reference (the focus walk) the
 * frame owner holding that document's focus (`focus`, a target id) or null.
 */
function scripts(s: ReturnType<typeof setup>) {
  const contexts = new Map<string, number>()
  let next = 100
  /** Each session's document's loader id (`Page.getFrameTree`): a navigation makes a new one. */
  const loaders = new Map<string, string>()
  let nextLoader = 0
  const calls: Array<{ method: string; session: string; params: Record<string, unknown> }> = []
  const focus = new Map<string, string>()
  const held = new Map<string, Array<() => void>>()
  const opts = {
    /** Each session's answer to a script by value. */
    value: (session: string, code: string): unknown => `${session || 'page'}:${code}`,
    throws: new Set<string>(),
    /** Methods held per `${session} ${method}` until `release` (a frame that goes meanwhile). */
    hold: new Set<string>(),
    /** Sessions whose frame tree names no loader id (a malformed or failed read). */
    noLoader: new Set<string>()
  }
  const loaderOf = (session: string): string => {
    let id = loaders.get(session)
    if (id === undefined) loaders.set(session, (id = `L${++nextLoader}`))
    return id
  }
  const contextOf = (session: string): number => {
    let id = contexts.get(session)
    if (id === undefined) contexts.set(session, (id = ++next))
    return id
  }
  const answer = (method: string, p: Record<string, unknown>, session: string): Promise<unknown> | undefined => {
    const scriptMethod = ['Page.createIsolatedWorld', 'Runtime.evaluate', 'Page.getFrameTree', 'Runtime.releaseObjectGroup'].includes(method) || (method === 'DOM.describeNode' && 'objectId' in p)
    if (!scriptMethod) return undefined
    calls.push({ method, session, params: p })
    const compute = (): unknown => {
      if (method === 'Page.getFrameTree') {
        const frame = { id: session ? `T-${session}` : 'MAIN', ...(opts.noLoader.has(session) ? {} : { loaderId: loaderOf(session) }) }
        // A child frame of the same process under the root, as Chromium lists them (never the one asked for).
        return { frameTree: { frame, childFrames: [{ frame: { id: `same-site-${session}`, loaderId: 'LS' } }] } }
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: contextOf(session) }
      if (method === 'DOM.describeNode') return { node: { nodeName: 'IFRAME', frameId: String(p.objectId).slice('obj-'.length) } }
      if (method === 'Runtime.releaseObjectGroup') return {}
      if (p.contextId !== contexts.get(session)) throw new Error('Cannot find context with specified id')
      if (opts.throws.has(session)) return { result: { type: 'object', subtype: 'error' }, exceptionDetails: { text: 'Uncaught' } }
      if (p.returnByValue === false) {
        const owner = focus.get(session)
        return { result: owner ? { type: 'object', subtype: 'node', objectId: `obj-${owner}` } : { type: 'object', subtype: 'null', value: null } }
      }
      return { result: { value: opts.value(session, String(p.expression)) } }
    }
    const run = (): Promise<unknown> => {
      try {
        return Promise.resolve(compute())
      } catch (err) {
        return Promise.reject(err)
      }
    }
    const key = `${session} ${method}`
    if (!opts.hold.has(key)) return run()
    return new Promise((resolve, reject) => {
      const list = held.get(key) ?? []
      list.push(() => run().then(resolve, reject))
      held.set(key, list)
    })
  }
  s.page.opts.answer = answer
  return {
    calls,
    focus,
    opts,
    /** The frame's document replaced (a navigation in its process): a new context, the old one refused. */
    navigate: (session: string) => {
      contexts.delete(session)
      loaders.delete(session)
    },
    /**
     * The frame's document replaced by a cross-process navigation whose new renderer has a context
     * under the old id (V8 ids are per process): the old id still answers, only the loader id tells.
     */
    swapProcess: (session: string) => void loaders.delete(session),
    release: (key: string) => {
      for (const go of held.get(key)?.splice(0) ?? []) go()
    },
    /** The script methods each session got, in order. */
    on: (session: string) => calls.filter((c) => c.session === session).map((c) => c.method)
  }
}

describe("PageInputRouter: main's scripts (scriptAt, scriptIn, scriptInFocus)", () => {
  it('a page with no cross-site frame: every script in the top document, no protocol command', async () => {
    const s = setup()
    const hit = await s.router.scriptAt(20, 30, (x, y) => `hit ${x} ${y}`)
    expect(hit?.value).toBe('top:hit 20 30')
    expect(hit?.toTop({ x: 1, y: 2, width: 3, height: 4 })).toEqual({ x: 1, y: 2, width: 3, height: 4 })
    await expect(s.router.scriptIn(hit!.frame, 'choose')).resolves.toBe('top:choose')
    await expect(s.router.scriptInFocus('sel')).resolves.toBe('top:sel')
    expect(s.tops).toEqual(['hit 20 30', 'choose', 'sel'])
    expect(s.page.queries).toEqual([])
  })

  it("scriptAt: the press's own route (the deepest frame under it), an isolated world made on that frame's session, the rectangle mapped back", async () => {
    const s = setup()
    const sc = scripts(s)
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.frame('B', 'A', 9, rect(300, 100, 280, 180), 280, 180)
    const hit = await s.router.scriptAt(330, 330, (x, y) => `hit ${x} ${y}`)
    // The code got B's own point: (330, 330) is (330, 130) in A, (30, 30) in B.
    expect(hit?.value).toBe('B:hit 30 30')
    const mapped = hit?.toTop({ x: 10, y: 120, width: 150, height: 24 })
    expect(mapped && Object.values(mapped).map((n) => Math.round(n * 1000) / 1000)).toEqual([310, 420, 150, 24])
    // The bracket: B's loader id read before the world and again after the answer, on B's session.
    expect(sc.calls).toEqual([
      { method: 'Page.getFrameTree', session: 'B', params: {} },
      { method: 'Page.createIsolatedWorld', session: 'B', params: { frameId: 'T-B', worldName: FRAME_WORLD_NAME, grantUniveralAccess: false } },
      { method: 'Runtime.evaluate', session: 'B', params: { expression: 'hit 30 30', contextId: 101, returnByValue: true, awaitPromise: false, silent: true } },
      { method: 'Page.getFrameTree', session: 'B', params: {} }
    ])
    // Never in the top document, no input command.
    expect(s.tops).toEqual([])
    expect(s.page.sent).toEqual([])
    // The answer later, in the same frame (the same world), by its handle.
    await expect(s.router.scriptIn(hit!.frame, 'choose')).resolves.toBe('B:choose')
    expect(sc.on('B').slice(4)).toEqual(['Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate', 'Page.getFrameTree'])
    // A point outside every frame: the top document, at the top point.
    const top = await s.router.scriptAt(620, 20, (x, y) => `hit ${x} ${y}`)
    expect(top?.value).toBe('top:hit 620 20')
  })

  it('scriptAt follows what the press would get: a frame that owes an answer sends the press, and the script, to the top', async () => {
    const s = setup()
    scripts(s)
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    // A press into A that A never answers: A is stalled once its deadline passed.
    s.page.opts.holdSessions.add('A')
    s.router.input([down(20, 220)])
    await s.flush()
    s.fire()
    await s.flush()
    const hit = await s.router.scriptAt(30, 230, (x, y) => `hit ${x} ${y}`)
    expect(hit?.value).toBe('top:hit 30 230')
  })

  it('scriptIn runs only in its own frame: gone, replaced under the same session id, or a new document → nothing, nowhere else', async () => {
    const s = setup()
    const sc = scripts(s)
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    const hit = await s.router.scriptAt(20, 220, () => 'hit')
    expect(hit?.value).toBe('A:hit')
    // A new document in A (same session): its context is new, the old one refused; what the hit kept
    // there is the old document's, so the choice finds nothing (here: the script is not even run).
    sc.navigate('A')
    sc.opts.value = (session, code) => (code === 'choose' ? `${session}:found nothing` : '')
    await expect(s.router.scriptIn(hit!.frame, 'choose')).resolves.toBe('A:found nothing')
    // A gone: dropped, no command anywhere, not the top document.
    const before = sc.calls.length
    s.router.frameDetached('A')
    await expect(s.router.scriptIn(hit!.frame, 'choose')).resolves.toBeUndefined()
    // Another frame attached under the same session id: still the old handle's frame, which went.
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    await expect(s.router.scriptIn(hit!.frame, 'choose')).resolves.toBeUndefined()
    expect(sc.calls.length).toBe(before)
    expect(s.tops).toEqual([])
  })

  it('a frame that goes, or whose document is replaced, mid-script: dropped (no value), never run in the top document', async () => {
    const s = setup()
    const sc = scripts(s)
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    // Gone while its evaluation is on its way.
    sc.opts.hold.add('A Runtime.evaluate')
    const gone = s.router.scriptAt(20, 220, () => 'hit')
    await s.flush()
    expect(sc.on('A')).toEqual(['Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate'])
    s.router.frameDetached('A')
    sc.release('A Runtime.evaluate')
    await expect(gone).resolves.toBeUndefined()
    // Replaced between its world and its evaluation: the context is refused.
    s.page.owners.set('', [])
    s.frame('C', '', 8, rect(0, 200, 600, 300), 600, 300)
    sc.opts.hold.clear()
    sc.opts.hold.add('C Page.createIsolatedWorld')
    const replaced = s.router.scriptAt(20, 220, () => 'hit')
    await s.flush()
    sc.release('C Page.createIsolatedWorld')
    sc.navigate('C')
    await expect(replaced).resolves.toBeUndefined()
    // A script that threw: dropped too.
    sc.opts.hold.clear()
    sc.opts.throws.add('C')
    await expect(s.router.scriptAt(20, 220, () => 'hit')).resolves.toBeUndefined()
    expect(s.tops).toEqual([])
  })

  it("a frame's script holds the input after it until it is answered; past its deadline it is dropped and the frame stalled", async () => {
    const s = setup()
    const sc = scripts(s)
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    sc.opts.hold.add('A Runtime.evaluate')
    const late = s.router.scriptAt(20, 220, () => 'hit')
    s.router.input([keyDown('a')])
    await s.flush()
    // No input command while A's evaluation is on its way (one outstanding per session, C9).
    expect(s.page.sent).toEqual([])
    s.fire()
    await expect(late).resolves.toBeUndefined()
    await s.flush()
    expect(s.page.sent.map((x) => x.params.key)).toEqual(['a'])
    // A owes that answer: a press there goes to the page at the top point, a script there is dropped.
    s.router.input([down(20, 220), up(20, 220)])
    await s.flush()
    expect(s.mice()).toEqual([
      ['', 'mousePressed', 20, 220],
      ['', 'mouseReleased', 20, 220]
    ])
    expect((await s.router.scriptAt(20, 220, () => 'hit'))?.value).toBe('top:hit')
    // Its answer comes: A takes input again.
    sc.release('A Runtime.evaluate')
    await s.flush()
    s.router.input([down(20, 220)])
    await s.flush()
    expect(s.mice().at(-1)).toEqual(['A', 'mousePressed', 20, 20])
  })

  // Advisor finding: the call's own deadline came before the frame script's, so the pump went on with
  // the frame's evaluation still on its way, and a press waiting behind the call went to that frame.
  it("the call's own deadline does not end the wait for a frame's script: nothing goes to that frame until its own deadline", async () => {
    const s = setup()
    const sc = scripts(s)
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    sc.opts.hold.add('A Runtime.evaluate')
    const late = s.router.scriptAt(20, 220, () => 'hit')
    await s.flush()
    s.router.input([down(20, 220), up(20, 220)])
    await s.flush()
    expect(sc.on('A')).toEqual(['Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate'])
    // Two timers now: the call's (set first) and the frame script's. Only the call's fires.
    const ids = [...s.timers.keys()].sort((a, b) => a - b)
    expect(ids).toHaveLength(2)
    const callTimer = s.timers.get(ids[0] as number) as () => void
    s.timers.delete(ids[0] as number)
    callTimer()
    await s.flush()
    expect(s.page.sent).toEqual([])
    // The frame script's deadline: dropped, A stalled, the press and release to the page at the top point.
    s.fire()
    await expect(late).resolves.toBeUndefined()
    await s.flush()
    expect(s.mice()).toEqual([
      ['', 'mousePressed', 20, 220],
      ['', 'mouseReleased', 20, 220]
    ])
  })

  it('a script in the top document holds nothing after it (as before)', async () => {
    for (const run of [(r: PageInputRouter) => r.scriptAt(5, 5, () => 'hit'), (r: PageInputRouter) => r.scriptInFocus('sel')]) {
      const s = setup()
      s.top.answer = () => new Promise(() => {})
      void run(s.router)
      s.router.input([keyDown('a')])
      await s.flush()
      expect(s.page.sent.map((x) => x.params.key)).toEqual(['a'])
    }
  })

  it('scriptInFocus: main walks the focus down to the deepest focused cross-site frame, else the top document', async () => {
    const s = setup()
    const sc = scripts(s)
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    s.frame('B', 'A', 9, rect(300, 100, 280, 180), 280, 180)
    sc.focus.set('', 'T-A')
    sc.focus.set('A', 'T-B')
    await expect(s.router.scriptInFocus('sel')).resolves.toBe('B:sel')
    expect(sc.on('')).toEqual(['Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate', 'DOM.describeNode', 'Runtime.releaseObjectGroup', 'Page.getFrameTree'])
    expect(sc.calls.find((c) => c.session === '' && c.method === 'Page.createIsolatedWorld')?.params).toMatchObject({ frameId: 'MAIN', worldName: FRAME_WORLD_NAME })
    expect(sc.calls.find((c) => c.session === '' && c.method === 'Runtime.evaluate')?.params).toMatchObject({ returnByValue: false, contextId: 101 })
    // B has no cross-site child: no walk there, the read only.
    expect(sc.on('B')).toEqual(['Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate', 'Page.getFrameTree'])
    // Every evaluation names its isolated context (never the main world).
    expect(sc.calls.filter((c) => c.method === 'Runtime.evaluate').every((c) => typeof c.params.contextId === 'number')).toBe(true)
    expect(s.tops).toEqual([])
    // Focus in A itself: A's selection.
    sc.focus.delete('A')
    await expect(s.router.scriptInFocus('sel')).resolves.toBe('A:sel')
    // No frame focused, or a frame owner that is no cross-site frame's (a same-site one): the top document.
    sc.focus.delete('')
    await expect(s.router.scriptInFocus('sel')).resolves.toBe('top:sel')
    sc.focus.set('', 'T-same-site')
    await expect(s.router.scriptInFocus('sel')).resolves.toBe('top:sel')
    expect(s.tops).toEqual(['sel', 'sel'])
  })

  it('scriptInFocus: the focused frame going mid-walk drops the read (no copy), never reads the top document', async () => {
    const s = setup()
    const sc = scripts(s)
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    sc.focus.set('', 'T-A')
    sc.opts.hold.add(' DOM.describeNode')
    const read = s.router.scriptInFocus('sel')
    await s.flush()
    s.router.frameDetached('A')
    s.page.owners.set('', [])
    sc.release(' DOM.describeNode')
    await expect(read).resolves.toBeUndefined()
    // And mid-read in the frame itself.
    s.frame('A2', '', 8, rect(0, 200, 600, 300), 600, 300)
    sc.focus.set('', 'T-A2')
    sc.opts.hold.clear()
    sc.opts.hold.add('A2 Runtime.evaluate')
    const again = s.router.scriptInFocus('sel')
    await s.flush()
    s.router.reset()
    sc.release('A2 Runtime.evaluate')
    await expect(again).resolves.toBeUndefined()
    expect(s.tops).toEqual([])
  })

  // codex review 2026-11-20: a frame's session outlives a cross-process navigation of the frame, and
  // V8 context ids are per process, so the old id can name the new renderer's main world.
  it("a frame's script is bracketed by its loader id: a new document between the two reads drops it, the same one passes", async () => {
    const s = setup()
    const sc = scripts(s)
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    sc.opts.hold.add('A Runtime.evaluate')
    const same = s.router.scriptAt(20, 220, () => 'hit')
    await s.flush()
    sc.release('A Runtime.evaluate')
    const hit = await same
    expect(hit?.value).toBe('A:hit')
    // The process swapped while the evaluation was on its way: the old context id still answered.
    const swapped = s.router.scriptAt(20, 220, () => 'hit')
    await s.flush()
    sc.swapProcess('A')
    sc.release('A Runtime.evaluate')
    await expect(swapped).resolves.toBeUndefined()
    expect(sc.on('A').slice(-4)).toEqual(['Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate', 'Page.getFrameTree'])
    // The choice, the same way.
    const choice = s.router.scriptIn(hit!.frame, 'choose')
    await s.flush()
    sc.swapProcess('A')
    sc.release('A Runtime.evaluate')
    await expect(choice).resolves.toBeUndefined()
    // A frame tree with no loader id for the frame: dropped, not run.
    sc.opts.hold.clear()
    sc.opts.noLoader.add('A')
    const before = sc.calls.length
    await expect(s.router.scriptAt(20, 220, () => 'hit')).resolves.toBeUndefined()
    expect(sc.calls.slice(before).map((c) => c.method)).toEqual(['Page.getFrameTree'])
    expect(s.tops).toEqual([])
  })

  it('the focus walk is bracketed too: a new document while its owner was described drops the read, at the top and in a frame', async () => {
    for (const [session, key] of [
      ['', ' DOM.describeNode'],
      ['A', 'A DOM.describeNode']
    ] as const) {
      const s = setup()
      const sc = scripts(s)
      s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
      s.frame('B', 'A', 9, rect(300, 100, 280, 180), 280, 180)
      sc.focus.set('', 'T-A')
      sc.focus.set('A', 'T-B')
      sc.opts.hold.add(key)
      const read = s.router.scriptInFocus('sel')
      await s.flush()
      sc.swapProcess(session)
      sc.release(key)
      await expect(read).resolves.toBeUndefined()
      expect(sc.on('B')).toEqual([])
      expect(s.tops).toEqual([])
      // The same document: the walk goes on down to B.
      const again = s.router.scriptInFocus('sel')
      await s.flush()
      sc.release(key)
      await expect(again).resolves.toBe('B:sel')
    }
    // The page's tree with no loader id: dropped, never the top document.
    const s = setup()
    const sc = scripts(s)
    s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
    sc.opts.noLoader.add('')
    await expect(s.router.scriptInFocus('sel')).resolves.toBeUndefined()
    expect(sc.on('')).toEqual(['Page.getFrameTree'])
    expect(s.tops).toEqual([])
  })

  // codex review 2026-11-20: the walk's promise (`bounded`) resolves first and the call's continuation
  // runs microtasks later; a new attachment in that gap must drop what the old walk found. The gap is
  // hit by a reset from the bounded deadline's own clear (the walk's end, before the continuation).
  it('a new attachment between the end of a walk and what the call does with it: dropped, nothing run in the new document', async () => {
    // `newest`: whether the walk's deadline was set after the call's (scriptAt routes first, then
    // starts the frame's script) or before it (scriptInFocus starts its walk as the call starts).
    const cases: Array<{ name: string; newest: boolean; prep: (sc: ReturnType<typeof scripts>) => string; run: (r: PageInputRouter) => Promise<unknown> }> = [
      // The walk found no focused frame: the top document's run must not go to the new attachment.
      { name: 'scriptInFocus, top', newest: false, prep: () => ' Runtime.evaluate', run: (r) => r.scriptInFocus('sel') },
      // The walk read A's selection: the old attachment's answer.
      {
        name: 'scriptInFocus, frame',
        newest: false,
        prep: (sc) => {
          sc.focus.set('', 'T-A')
          return 'A Runtime.evaluate'
        },
        run: (r) => r.scriptInFocus('sel')
      },
      // A's hit test: no value and no handle of the old attachment's frame.
      { name: 'scriptAt, frame', newest: true, prep: () => 'A Runtime.evaluate', run: (r) => r.scriptAt(20, 220, () => 'hit') }
    ]
    for (const how of ['reset', 'rendererGone'] as const) {
      for (const c of cases) {
        const s = setup()
        const sc = scripts(s)
        s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
        const key = c.prep(sc)
        sc.opts.hold.add(key)
        const epochs: number[] = []
        s.top.answer = (code) => {
          epochs.push(s.router.inputEpoch())
          return Promise.resolve(`top:${code}`)
        }
        const result = c.run(s.router)
        await s.flush()
        // Two timers: the call's and the walk's own deadline.
        expect(s.timers.size).toBe(2)
        const walkTimer = c.newest ? Math.max(...s.timers.keys()) : Math.min(...s.timers.keys())
        let ended = false
        const timers = s.timers
        const clear = timers.delete.bind(timers)
        timers.delete = (h: number): boolean => {
          const had = clear(h)
          if (h === walkTimer && !ended) {
            ended = true
            if (how === 'reset') s.router.reset()
            else s.router.rendererGone()
          }
          return had
        }
        sc.release(key)
        await expect(result, `${c.name}, ${how}`).resolves.toBeUndefined()
        expect(ended, `${c.name}, ${how}`).toBe(true)
        expect(epochs, `${c.name}, ${how}`).toEqual([])
      }
    }
  })

  // codex review 2026-11-20 (the fix's re-check): scriptIn's frame run had the same gap, so a choice
  // made under the old attachment was reported as made under the new one.
  it("scriptIn: a new attachment between the end of the frame's run and the answer drops it", async () => {
    for (const how of ['reset', 'rendererGone'] as const) {
      const s = setup()
      const sc = scripts(s)
      s.frame('A', '', 7, rect(0, 200, 600, 300), 600, 300)
      const hit = await s.router.scriptAt(20, 220, () => 'hit')
      expect(hit?.value, how).toBe('A:hit')
      sc.opts.hold.add('A Runtime.evaluate')
      const result = s.router.scriptIn(hit!.frame, 'choose')
      await s.flush()
      // Two timers: the call's and the run's own deadline (set first: scriptIn starts its run as the
      // call starts, before the pump sets the call's).
      expect(s.timers.size, how).toBe(2)
      const runTimer = Math.min(...s.timers.keys())
      let ended = false
      const timers = s.timers
      const clear = timers.delete.bind(timers)
      timers.delete = (h: number): boolean => {
        const had = clear(h)
        if (h === runTimer && !ended) {
          ended = true
          if (how === 'reset') s.router.reset()
          else s.router.rendererGone()
        }
        return had
      }
      sc.release('A Runtime.evaluate')
      await expect(result, how).resolves.toBeUndefined()
      expect(ended, how).toBe(true)
    }
  })

  it('a script asked under an attachment that ended is rejected as dropped', async () => {
    const s = setup()
    const epoch = s.router.inputEpoch()
    s.router.reset()
    await expect(s.router.scriptAt(1, 1, () => 'hit', epoch)).rejects.toBeInstanceOf(InputDroppedError)
    await expect(s.router.scriptInFocus('sel', epoch)).rejects.toBeInstanceOf(InputDroppedError)
    expect(s.tops).toEqual([])
  })
})
