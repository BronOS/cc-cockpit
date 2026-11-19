// A streamed page's input on its DevTools protocol (server mode's off-screen view,
// electron-offscreen-webview.ts; design-web-browser.md §4.1). webview-input.ts has checked and
// mapped what a browser sent and keeps its order per view and panel; this decides which of the
// page's protocol sessions each event goes to, and keeps that order across them.
//
// Why not `webContents.sendInputEvent` (scripts/offscreen-input-check.mjs, macOS, Electron 45.1.0,
// 2026-11-19; docs/backlog history of streamed-clicks-miss-cross-site-iframes.md): neither it nor
// `Input.dispatchMouseEvent` on the page's own session reaches an out-of-process (cross-site)
// iframe of an off-screen page; the top document gets the event, its target the IFRAME element. The
// same command on the iframe's own session (the child target webview-hardening.ts auto-attaches),
// with the point in the iframe's coordinates, reaches it fully. Keys differ: `sendInputEvent` keys
// stay in the top document, while `Input.dispatchKeyEvent` and `Input.insertText` on the page's
// session follow focus into the frame. So:
//
//   keys       every key (key down, `char`, key up) as `Input.dispatchKeyEvent` on the page's
//              session (protocolKeyEvent), as are committed text and edit chords (`call`).
//   pointer    each mouse event (move, press, release, wheel) to the session of the deepest
//              cross-site frame under the point, the point in that frame's own CSS px (hitTest):
//              at each level the frame owner under the point (`DOM.getNodeForLocation`, which takes
//              the document's coordinates, so the level's scroll from `Page.getLayoutMetrics` is
//              added), whether it owns a child target (`DOM.describeNode`'s `frameId` is the
//              child's target id), and its content box (`DOM.getBoxModel`, viewport coordinates:
//              a quad, so CSS transforms are in it). The point is mapped through the quad (an
//              affine map from three corners: exact for translate, scale, rotate and skew; a
//              perspective transform is approximated) and the frame's untransformed content size.
//              The hit test is the renderer's own, so clipping, overlays and `pointer-events: none`
//              count as for a real click. A point on the owner's border or padding stays with the
//              parent; a point outside the owner's border box means the scroll read was stale (the
//              page scrolled between the two calls): read once more, then stay with the parent.
//              Never a child whose box does not hold the point. A same-process frame is the
//              parent's own document (the hit test goes into it), so it takes the event there, as
//              before. No cache: every event is hit-tested (one round trip per level for a page
//              with no cross-site frame: none), so a stale box can only cost the one event in flight.
//   capture    after a press, moves and the release go to the frame that got the press (as a real
//              browser captures the mouse: a drag that leaves the frame still selects in it, a drag
//              that started in the top document stays there over a frame), the owners' boxes read
//              again on each event (the page may scroll under a drag); released when no button is
//              held, or by a move with none held (a release that never came).
//   hover      when the pointer goes to another session without capture, the one it left gets one
//              move first: over the owner when it is an ancestor of the new frame (its hover is the
//              iframe element, as in a real browser), else outside its viewport (-1, -1), so its
//              hover ends (mouseout, mouseleave) instead of sticking.
//   order      one queue per page, run one step at a time (`pump`). Mouse events to the same session
//              are pipelined (their order is that widget's input queue); anything else (another
//              session, a key, a call) first waits for every command in flight to be answered: a
//              key sent while the press into a frame is still on its way lands in the old focus (a
//              probe: 15 of 30 without the wait, 0 of 30 with it). A command answers once its event
//              is handled; every wait is capped at STEP_TIMEOUT_MS (a hung frame costs order, never
//              input). A move queued behind a wait is replaced by the next move (a pointer move's
//              answer comes with the next frame, about 16 ms, so they would pile up otherwise); a
//              full queue drops moves first and never a release.
//   fallback   a refused command on a frame's session (the frame went: navigated, removed) goes to
//              the page's session at the top document's point, never to another frame and never
//              dropped; a refusal there, and every event while the protocol is detached, goes by
//              `sendInputEvent` as before. Each is logged once per view.
//
// Not routed into frames (top document only): the select popup's hit-test and choice and the
// selection read (select-hit.ts, SELECTION_SCRIPT run in the top document's isolated world; a
// frame's would need an isolated world per child session, `Page.createIsolatedWorld`): a select in
// a cross-site frame is keyboard-only and its selected text is not copied. A frame's own scroll
// chaining to its parent at its end, and the browser's drag and drop between frames, are Chromium's
// and were not checked.
//
// Pure: the protocol's `send`, the `sendInputEvent` fallback and the timers are injected.

import { webviewKeyInfo } from '../../shared/webview-keys'
import { protocolModifiers, type ElectronInputEvent, type InputModifier } from './webview-input'

/** One protocol command on the page's session (no `sessionId`) or a child frame's. */
export type ProtocolSend = (method: string, params: Record<string, unknown> | undefined, sessionId?: string) => Promise<unknown>

/** The longest one step waits for its answer (or for the commands before it) before the next goes. */
export const STEP_TIMEOUT_MS = 500
/** The longest one pointer event waits for its hit test; then it goes to the page's session. */
export const ROUTE_TIMEOUT_MS = 200
/** Deepest chain of cross-site frames the hit test follows. */
export const MAX_FRAME_DEPTH = 8
/** Most steps waiting in the queue (see `order` at the top of the file). */
export const MAX_QUEUED_STEPS = 512

type MouseEvent = Extract<ElectronInputEvent, { type: 'mouseMove' | 'mouseDown' | 'mouseUp' | 'mouseWheel' }>
type KeyEvent = Extract<ElectronInputEvent, { type: 'keyDown' | 'keyUp' | 'char' }>

const BUTTON_BITS: Readonly<Record<'left' | 'middle' | 'right', number>> = { left: 1, right: 2, middle: 4 }

function isMouse(event: ElectronInputEvent): event is MouseEvent {
  return event.type === 'mouseMove' || event.type === 'mouseDown' || event.type === 'mouseUp' || event.type === 'mouseWheel'
}

/** The protocol's `buttons` bits of the buttons a list of Electron modifiers holds down. */
function heldButtons(modifiers: readonly InputModifier[]): number {
  let bits = 0
  if (modifiers.includes('leftbuttondown')) bits |= BUTTON_BITS.left
  if (modifiers.includes('rightbuttondown')) bits |= BUTTON_BITS.right
  if (modifiers.includes('middlebuttondown')) bits |= BUTTON_BITS.middle
  return bits
}

function buttonOf(bits: number): 'left' | 'middle' | 'right' | 'none' {
  if (bits & BUTTON_BITS.left) return 'left'
  if (bits & BUTTON_BITS.right) return 'right'
  if (bits & BUTTON_BITS.middle) return 'middle'
  return 'none'
}

/** -v, but never -0 (the protocol does not care; a test's deep equal does). */
function negate(v: number): number {
  return v === 0 ? 0 : -v
}

/**
 * The `Input.dispatchMouseEvent` params for one mapped mouse event at (x, y) in the receiving
 * session's own CSS px. The lane's events are Electron's shape: held buttons travel as modifiers
 * (here the `buttons` bits, the press's own button added and the release's removed) and the wheel's
 * deltas are Chromium's sign (negated back: the protocol takes the DOM's, positive scrolls down).
 */
export function protocolMouseEvent(event: MouseEvent, x: number, y: number): Record<string, unknown> {
  const modifiers = protocolModifiers(event.modifiers)
  const held = heldButtons(event.modifiers)
  if (event.type === 'mouseWheel') {
    return { type: 'mouseWheel', x, y, deltaX: negate(event.deltaX), deltaY: negate(event.deltaY), modifiers, buttons: held, pointerType: 'mouse' }
  }
  if (event.type === 'mouseMove') {
    return { type: 'mouseMoved', x, y, modifiers, button: buttonOf(held), buttons: held, clickCount: 0, pointerType: 'mouse' }
  }
  const bit = BUTTON_BITS[event.button]
  return {
    type: event.type === 'mouseDown' ? 'mousePressed' : 'mouseReleased',
    x,
    y,
    modifiers,
    button: event.button,
    buttons: event.type === 'mouseDown' ? held | bit : held & ~bit,
    clickCount: event.clickCount,
    pointerType: 'mouse'
  }
}

/**
 * The `Input.dispatchKeyEvent` params for one mapped key event, one for one with what
 * sendInputEvent got: a key down is a `rawKeyDown` (it types nothing by itself), its `char` (the
 * text a typing key adds, webviewKeyChar) a `char`, a key up a `keyUp`, so the page sees keydown,
 * keypress, input and keyup as from a keyboard, and preventing the keydown still suppresses the
 * char. `key`, `code` and the Windows key code from the shared table (webviewKeyInfo), since the
 * protocol derives none of them. Undefined for a key not in it (the lane only maps allow-listed ones).
 */
export function protocolKeyEvent(event: KeyEvent): Record<string, unknown> | undefined {
  const info = webviewKeyInfo(event.keyCode)
  if (!info) return undefined
  const base = { key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode, modifiers: protocolModifiers(event.modifiers) }
  const autoRepeat = event.modifiers.includes('isautorepeat')
  if (event.type === 'keyDown') return { type: 'rawKeyDown', ...base, autoRepeat }
  if (event.type === 'keyUp') return { type: 'keyUp', ...base }
  return { type: 'char', ...base, text: event.keyCode, unmodifiedText: event.keyCode, autoRepeat }
}

/** A point in a frame owner's box, as pointInFrame maps it. */
export interface FramePoint {
  /** The point in the frame's own viewport, CSS px. */
  x: number
  y: number
  /** Inside the frame's viewport (the owner's content box). */
  inside: boolean
  /** Inside the owner's border box (false: the box was read for another point, see childAt). */
  inBorder: boolean
}

function quadOf(v: unknown): number[] | undefined {
  if (!Array.isArray(v) || v.length !== 8) return undefined
  return v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? (v as number[]) : undefined
}

/** (x, y) as fractions (u along the top edge, v along the left edge) of a quad, or undefined (flat). */
function fractions(q: readonly number[], x: number, y: number): { u: number; v: number } | undefined {
  const [x0, y0, x1, y1, , , x3, y3] = q as [number, number, number, number, number, number, number, number]
  const ax = x1 - x0
  const ay = y1 - y0
  const bx = x3 - x0
  const by = y3 - y0
  const det = ax * by - ay * bx
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return undefined
  const dx = x - x0
  const dy = y - y0
  return { u: (dx * by - dy * bx) / det, v: (ax * dy - ay * dx) / det }
}

function edge(q: readonly number[], to: 2 | 6): number {
  return Math.hypot((q[to] as number) - (q[0] as number), (q[to + 1] as number) - (q[1] as number))
}

/**
 * The point (x, y) of a parent's viewport in the frame its owner holds, from the owner's
 * `DOM.getBoxModel` (quads in the parent's viewport, clockwise from the top left; `width` and
 * `height` the untransformed border box). The frame's viewport is the content box: its own size is
 * the border box's scaled by the quads' edge ratios (an affine transform keeps those), so a frame at
 * scale(0.5) maps a quad 150 px wide to its 300 px. Undefined for a malformed or flat box.
 */
export function pointInFrame(model: unknown, x: number, y: number): FramePoint | undefined {
  if (typeof model !== 'object' || model === null) return undefined
  const m = model as { content?: unknown; border?: unknown; width?: unknown; height?: unknown }
  const content = quadOf(m.content)
  const border = quadOf(m.border)
  if (!content || !border || typeof m.width !== 'number' || typeof m.height !== 'number') return undefined
  if (!(m.width > 0) || !(m.height > 0) || !Number.isFinite(m.width) || !Number.isFinite(m.height)) return undefined
  const borderTop = edge(border, 2)
  const borderLeft = edge(border, 6)
  if (borderTop < 1e-9 || borderLeft < 1e-9) return undefined
  const c = fractions(content, x, y)
  const b = fractions(border, x, y)
  if (!c || !b) return undefined
  const width = (m.width * edge(content, 2)) / borderTop
  const height = (m.height * edge(content, 6)) / borderLeft
  return {
    x: c.u * width,
    y: c.v * height,
    inside: c.u >= 0 && c.u < 1 && c.v >= 0 && c.v < 1,
    inBorder: b.u >= 0 && b.u <= 1 && b.v >= 0 && b.v <= 1
  }
}

/** Who hears the page's child targets (webview-hardening.ts cancelOffscreenNativeUi). */
export interface ChildFrameObserver {
  /** A child target attached from `parentSessionId` ('' the page's own session), paused. */
  frameAttached(sessionId: string, targetId: string, parentSessionId: string, type: string): void
  /** Its cancels are in and it was resumed: it may take input from now on. */
  frameReady(sessionId: string): void
  /** It went (`Target.detachedFromTarget`): it, and the frames under it. */
  frameDetached(sessionId: string): void
  /** The page's protocol detached: every child with it. */
  reset(): void
}

export interface RouterTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface PageInputDeps {
  send: ProtocolSend
  /** Whether the page's protocol is attached now (false: every event by `fallback`). */
  attached(): boolean
  /** `webContents.sendInputEvent`, the road while detached and after the page's session refused. */
  fallback(event: ElectronInputEvent): void
  log(message: string): void
  timers?: RouterTimers
}

interface ChildFrame {
  sessionId: string
  targetId: string
  parent: string
  ready: boolean
}

/** One link of a route: the owner element (`owner`, a backend node id) in `parent` of the frame `session`. */
interface Link {
  parent: string
  owner: number
  session: string
}

/** Where a pointer event goes: the session ('' the page's) and the point there. */
interface Route {
  session: string
  x: number
  y: number
  /** The owners from the top down to `session`. */
  links: Link[]
  /** The point in each link's parent (points[i] in links[i].parent). */
  points: Array<{ x: number; y: number }>
}

type Step =
  | { kind: 'mouse'; event: MouseEvent }
  | { kind: 'key'; event: KeyEvent }
  | { kind: 'call'; run: () => unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void; blocking: boolean }

/** The road of key events and calls (never a session id, which is hex, nor '' the page's). */
const KEYS = '#keys'

const defaultTimers: RouterTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

function isRelease(step: Step): boolean {
  return step.kind !== 'call' && (step.event.type === 'mouseUp' || step.event.type === 'keyUp')
}

/** One per off-screen page: its child frames, its input queue, the mouse capture and hover. */
export class PageInputRouter implements ChildFrameObserver {
  private readonly frames = new Map<string, ChildFrame>()
  private queue: Step[] = []
  private pumping = false
  private readonly inflight = new Set<Promise<unknown>>()
  /** Where the last step went: a mouse event's session, or KEYS. */
  private road: string | undefined
  /** The last mouse event's route (for the hover move when the pointer changes session). */
  private hover: Route | undefined
  private capture: { links: Link[]; buttons: number } | undefined
  private readonly warned = new Set<string>()
  private readonly timers: RouterTimers

  constructor(private readonly deps: PageInputDeps) {
    this.timers = deps.timers ?? defaultTimers
  }

  frameAttached(sessionId: string, targetId: string, parentSessionId: string, type: string): void {
    // Only an iframe is a document under a point; a worker is not, and a prerendered page is not shown.
    if (type !== 'iframe' || sessionId === '' || targetId === '') return
    this.frames.set(sessionId, { sessionId, targetId, parent: parentSessionId, ready: false })
  }

  frameReady(sessionId: string): void {
    const frame = this.frames.get(sessionId)
    if (frame) frame.ready = true
  }

  frameDetached(sessionId: string): void {
    const gone = [sessionId]
    while (gone.length > 0) {
      const id = gone.pop() as string
      this.frames.delete(id)
      for (const f of this.frames.values()) if (f.parent === id) gone.push(f.sessionId)
    }
  }

  reset(): void {
    this.frames.clear()
    this.capture = undefined
    this.hover = undefined
  }

  /** Mapped input for the page (webview-input.ts toElectronEvents), in order. */
  input(events: readonly ElectronInputEvent[]): void {
    // Detached with nothing queued: straight to sendInputEvent, as before the router.
    if (!this.pumping && this.queue.length === 0 && !this.deps.attached()) {
      this.lost()
      for (const event of events) this.deps.fallback(event)
      return
    }
    for (const event of events) this.push(isMouse(event) ? { kind: 'mouse', event } : { kind: 'key', event: event as KeyEvent })
    void this.pump()
  }

  /**
   * `run` in its place among the input: after everything queued before it was answered. Its
   * promise is `run`'s. `blocking` (the default): what comes after waits for it too (a text, an
   * edit chord, a select choice: each may move focus or change what a key does); false for a read
   * (the selection) that only needs what came before.
   */
  call(run: () => unknown, blocking = true): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.push({ kind: 'call', run, resolve, reject, blocking })) reject(new Error('webview: input queue full'))
      void this.pump()
    })
  }

  /** Queue a step; false when it was dropped (a full queue). */
  private push(step: Step): boolean {
    const last = this.queue[this.queue.length - 1]
    if (step.kind === 'mouse' && step.event.type === 'mouseMove' && last?.kind === 'mouse' && last.event.type === 'mouseMove') {
      // Only the latest position of a move that has not gone yet matters (the browser coalesces
      // per animation frame too). Same held buttons only: a press's modifiers change nothing here.
      if (last.event.modifiers.join() === step.event.modifiers.join()) {
        this.queue[this.queue.length - 1] = step
        return true
      }
    }
    if (this.queue.length >= MAX_QUEUED_STEPS && !isRelease(step)) {
      // A hung page with a person still typing: moves go first, never a release (a key or button
      // left down in the page would repeat or drag for good).
      const move = this.queue.findIndex((s) => s.kind === 'mouse' && s.event.type === 'mouseMove')
      if (move < 0 || (step.kind === 'mouse' && step.event.type === 'mouseMove')) {
        this.warn('full', 'webview: the page answers no input; input dropped')
        return false
      }
      this.queue.splice(move, 1)
    }
    this.queue.push(step)
    return true
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      for (let step = this.queue.shift(); step; step = this.queue.shift()) {
        try {
          await this.run(step)
        } catch (err) {
          this.warn('step', `webview: input step failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } finally {
      this.pumping = false
    }
  }

  private async run(step: Step): Promise<void> {
    if (!this.deps.attached()) {
      this.lost()
      if (step.kind === 'call') this.runCall(step)
      else this.deps.fallback(step.event)
      return
    }
    if (step.kind === 'call') {
      await this.drain()
      this.road = KEYS
      const pending = this.runCall(step)
      if (step.blocking) await this.within(pending, STEP_TIMEOUT_MS)
      return
    }
    if (step.kind === 'key') {
      await this.drain()
      this.road = KEYS
      const params = protocolKeyEvent(step.event)
      if (!params) {
        this.deps.fallback(step.event)
        return
      }
      const event = step.event
      await this.within(
        this.deps.send('Input.dispatchKeyEvent', params).catch(() => this.pageRefused(event)),
        STEP_TIMEOUT_MS
      )
      return
    }
    const event = step.event
    const route = await this.routeOf(event)
    if (route.session !== this.road) await this.drain()
    if (!this.capture && this.hover && this.hover.session !== route.session) await this.leave(this.hover.session, route, event)
    this.road = route.session
    this.hover = route
    this.track(this.dispatch(route, event))
    this.captureAfter(route, event)
  }

  /** A call's run, its result handed to its caller; the promise the pump may wait on. */
  private runCall(step: Extract<Step, { kind: 'call' }>): Promise<unknown> {
    let pending: Promise<unknown>
    try {
      pending = Promise.resolve(step.run())
    } catch (err) {
      pending = Promise.reject(err)
    }
    pending.then(step.resolve, step.reject)
    return pending
  }

  /** The protocol detached (or was never attached): no route, capture or hover survives it. */
  private lost(): void {
    this.capture = undefined
    this.hover = undefined
    this.road = undefined
    this.inflight.clear()
  }

  /** Where a mouse event goes (capture first, then the hit test; the page's session when neither says). */
  private async routeOf(event: MouseEvent): Promise<Route> {
    const top: Route = { session: '', x: event.x, y: event.y, links: [], points: [] }
    if (this.capture && event.type !== 'mouseWheel') {
      if (event.type === 'mouseMove' && heldButtons(event.modifiers) === 0) {
        // A move with no button held: the release went missing (the browser lost it). No capture.
        this.capture = undefined
      } else {
        const links = this.capture.links
        if (links.length === 0) return top
        const followed = await this.bounded(this.follow(links, event.x, event.y))
        if (followed) return followed
        this.capture = undefined
        return top
      }
    }
    if (!this.hasChildren('')) return top
    return (await this.bounded(this.hitTest(event.x, event.y))) ?? top
  }

  /** The captured frame's point now: its owners' boxes read again (the page may have scrolled). */
  private async follow(links: readonly Link[], x: number, y: number): Promise<Route | undefined> {
    const points: Array<{ x: number; y: number }> = []
    let px = x
    let py = y
    for (const link of links) {
      if (!this.frames.has(link.session)) return undefined
      const box = await this.query('DOM.getBoxModel', { backendNodeId: link.owner }, link.parent)
      const at = pointInFrame((box as { model?: unknown } | undefined)?.model, px, py)
      if (!at) return undefined
      points.push({ x: px, y: py })
      px = at.x
      py = at.y
    }
    return { session: (links[links.length - 1] as Link).session, x: px, y: py, links: [...links], points }
  }

  /** The deepest cross-site frame under (x, y) of the top document, and the point there. */
  private async hitTest(x: number, y: number): Promise<Route> {
    const links: Link[] = []
    const points: Array<{ x: number; y: number }> = []
    let session = ''
    let px = x
    let py = y
    for (let depth = 0; depth < MAX_FRAME_DEPTH && this.hasChildren(session); depth++) {
      const next = await this.childAt(session, px, py, true)
      if (!next) break
      links.push({ parent: session, owner: next.owner, session: next.session })
      points.push({ x: px, y: py })
      session = next.session
      px = next.x
      py = next.y
    }
    return { session, x: px, y: py, links, points }
  }

  /** The ready child frame of `session` under its viewport point (x, y), and the point in it. */
  private async childAt(session: string, x: number, y: number, retry: boolean): Promise<{ session: string; owner: number; x: number; y: number } | undefined> {
    const metrics = (await this.query('Page.getLayoutMetrics', undefined, session)) as { cssLayoutViewport?: { pageX?: unknown; pageY?: unknown } } | undefined
    const scrollX = Number(metrics?.cssLayoutViewport?.pageX)
    const scrollY = Number(metrics?.cssLayoutViewport?.pageY)
    if (!Number.isFinite(scrollX) || !Number.isFinite(scrollY)) return undefined
    // Document coordinates (the viewport point plus the scroll), whole px; the boxes below are the viewport's.
    const hit = (await this.query(
      'DOM.getNodeForLocation',
      { x: Math.floor(x + scrollX), y: Math.floor(y + scrollY), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false },
      session
    )) as { backendNodeId?: unknown } | undefined
    const owner = hit?.backendNodeId
    if (typeof owner !== 'number' || !Number.isInteger(owner)) return undefined
    const described = (await this.query('DOM.describeNode', { backendNodeId: owner }, session)) as { node?: { frameId?: unknown } } | undefined
    const frameId = described?.node?.frameId
    if (typeof frameId !== 'string') return undefined
    const child = this.childOf(session, frameId)
    if (!child) return undefined
    const box = await this.query('DOM.getBoxModel', { backendNodeId: owner }, session)
    const at = pointInFrame((box as { model?: unknown } | undefined)?.model, x, y)
    if (!at) return undefined
    if (!at.inBorder) return retry ? this.childAt(session, x, y, false) : undefined
    if (!at.inside) return undefined
    return { session: child.sessionId, owner, x: at.x, y: at.y }
  }

  /** One read-only protocol query on a session ('' the page's); undefined when refused. */
  private async query(method: string, params: Record<string, unknown> | undefined, session: string): Promise<unknown> {
    try {
      return await (session === '' ? this.deps.send(method, params) : this.deps.send(method, params, session))
    } catch {
      return undefined
    }
  }

  private hasChildren(session: string): boolean {
    for (const f of this.frames.values()) if (f.parent === session && f.ready) return true
    return false
  }

  /** The newest ready child of `parent` for the frame `targetId` (a frame's id is its target's). */
  private childOf(parent: string, targetId: string): ChildFrame | undefined {
    let found: ChildFrame | undefined
    for (const f of this.frames.values()) if (f.parent === parent && f.targetId === targetId && f.ready) found = f
    return found
  }

  /**
   * The pointer moved from `from` to another session without capture: one move to `from` so its
   * hover follows (see `hover` at the top of the file). Waited for, so its cursor comes first.
   */
  private async leave(from: string, to: Route, event: MouseEvent): Promise<void> {
    if (from !== '' && !this.frames.has(from)) return
    const at = to.links.findIndex((l) => l.parent === from)
    const point = at >= 0 ? (to.points[at] as { x: number; y: number }) : { x: -1, y: -1 }
    const params = { type: 'mouseMoved', x: point.x, y: point.y, modifiers: protocolModifiers(event.modifiers), button: 'none', buttons: 0, clickCount: 0, pointerType: 'mouse' }
    await this.within(this.query('Input.dispatchMouseEvent', params, from), STEP_TIMEOUT_MS)
  }

  /** Send one mouse event on its route; a refusal falls back (see `fallback` at the top of the file). */
  private dispatch(route: Route, event: MouseEvent): Promise<unknown> {
    const page = (): Promise<unknown> =>
      this.deps.send('Input.dispatchMouseEvent', protocolMouseEvent(event, event.x, event.y)).catch(() => this.pageRefused(event))
    if (route.session === '') return page()
    if (!this.frames.has(route.session)) return page()
    return this.deps.send('Input.dispatchMouseEvent', protocolMouseEvent(event, route.x, route.y), route.session).catch(() => {
      this.warn('frame', "webview: a frame's protocol refused input; it went to the page instead")
      return page()
    })
  }

  private pageRefused(event: ElectronInputEvent): void {
    this.warn('page', "webview: the page's protocol refused input; sent by sendInputEvent instead")
    this.deps.fallback(event)
  }

  /** A press starts (or joins) the capture on its route; the release of the last held button ends it. */
  private captureAfter(route: Route, event: MouseEvent): void {
    if (event.type === 'mouseDown') {
      const bit = BUTTON_BITS[event.button]
      this.capture = this.capture ? { ...this.capture, buttons: this.capture.buttons | bit } : { links: route.links, buttons: bit }
    } else if (event.type === 'mouseUp' && this.capture) {
      const buttons = this.capture.buttons & ~BUTTON_BITS[event.button]
      this.capture = buttons === 0 ? undefined : { ...this.capture, buttons }
    }
  }

  private track(pending: Promise<unknown>): void {
    const forget = (): void => {
      this.inflight.delete(settled)
    }
    const settled: Promise<unknown> = pending.then(forget, forget)
    this.inflight.add(settled)
  }

  /** Every command in flight answered (or STEP_TIMEOUT_MS passed). */
  private async drain(): Promise<void> {
    if (this.inflight.size === 0) return
    await this.within(Promise.allSettled([...this.inflight]), STEP_TIMEOUT_MS)
    this.inflight.clear()
  }

  /** A route within ROUTE_TIMEOUT_MS, else undefined (a page too busy to answer goes on unrouted). */
  private bounded(pending: Promise<Route | undefined>): Promise<Route | undefined> {
    return new Promise((done) => {
      const timer = this.timers.set(() => done(undefined), ROUTE_TIMEOUT_MS)
      pending.then(
        (route) => {
          this.timers.clear(timer)
          done(route)
        },
        () => {
          this.timers.clear(timer)
          done(undefined)
        }
      )
    })
  }

  /** `pending` settled, or `ms` passed: either way the pump goes on. */
  private within(pending: Promise<unknown>, ms: number): Promise<void> {
    return new Promise((done) => {
      const timer = this.timers.set(done, ms)
      const end = (): void => {
        this.timers.clear(timer)
        done()
      }
      pending.then(end, end)
    })
  }

  private warn(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.deps.log(message)
  }
}
