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
//              perspective transform, a quad that is no parallelogram, is refused and the point
//              stays with the parent) and the frame's untransformed content size.
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
//   hover      when the pointer goes to another session without capture, every frame it left gets
//              one move outside its viewport (-1, -1) first, so its hover ends (mouseout, mouseleave)
//              instead of sticking, and every ancestor of the new frame one over the owner it now
//              hovers (the iframe element, as in a real browser). Each is a command of its own, sent
//              and answered like any other (below); then the point is hit-tested again, since a hover
//              can change the page under it (an overlay, `pointer-events: none` on the owner): at most
//              MAX_RETESTS times, then the frames left get their moves and the page's session takes
//              the event at the top point (a page that changes on every hover must not spin it).
//   order      one queue per page, run one step at a time (`pump`), and one input command on its way
//              per page, across all its sessions: every `Input.*` goes through `sendInput`, and the
//              step that sent it waits until it is answered or its deadline (STEP_TIMEOUT_MS, a timer
//              per command) passed before anything else goes. A key sent while the press into a frame
//              is still on its way lands in the old focus (a probe: 15 of 30 without the wait, 0 of
//              30 with it); a press hit-tested while a move was on its way can pick a frame that move's
//              hover covered (review finding). So a pointer event waits first and is hit-tested last,
//              right before its send. Keys too go one at a time: the page answers one in about 0.15
//              ms (scripts/offscreen-input-check.mjs), so a window of several would win nothing.
//              While a step waits, moves behind it coalesce to the latest and wheel deltas sum (each
//              only with the step right before it); presses, releases, keys, texts and calls keep their
//              order. The queue holds MAX_QUEUED_STEPS: past it moves go first, and then only a release
//              of a press it took (by the physical key, `code`, or the button) gets in.
//   stalled    a session whose command missed its deadline gets no other until that one answers (so a
//              renderer that answers nothing holds one unanswered command, never a pile), and that
//              command no longer counts toward the page's one on its way: a stalled frame holds itself,
//              not the page. A move for a stalled frame is dropped, a press or wheel goes to the page's
//              session at the top point. A release goes where its press went (`pressedAt`): to a
//              stalled frame it is owed and sent once that frame answers, in the same attachment. While the page's session is stalled its moves are dropped and the rest
//              waits in the queue (the pump idle, no timer: by the queue's caps), so a page busy for a
//              second loses no key; its answer, or a detach, starts the pump again. A hit test's query
//              that missed ROUTE_TIMEOUT_MS likewise: that session is asked nothing until it answers.
//   epoch      each attachment has a number, bumped when the protocol detaches (`lost`, `reset`): an
//              answer, a deadline or a hit test of an older one changes nothing (review finding: a late
//              answer after a detach counted down the new attachment's commands).
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

/**
 * An input command's deadline: the step that sent it waits this long at most for its answer, then
 * the next step goes and that session is stalled (gets no other command until it answers).
 */
export const STEP_TIMEOUT_MS = 500
/** The longest one pointer event waits for its hit test; then it goes to the page's session. */
export const ROUTE_TIMEOUT_MS = 200
/** Deepest chain of cross-site frames the hit test follows. */
export const MAX_FRAME_DEPTH = 8
/** Most steps waiting in the queue (see `order` at the top of the file). */
export const MAX_QUEUED_STEPS = 512
/** How often one pointer event is hit-tested again after its hover moves changed the page under it. */
export const MAX_RETESTS = 2

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

/** Whether a quad's diagonals halve each other (any affine image of a rectangle), within half a px. */
function isParallelogram(q: readonly number[]): boolean {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q as [number, number, number, number, number, number, number, number]
  return Math.abs(x0 + x2 - x1 - x3) <= 0.5 && Math.abs(y0 + y2 - y1 - y3) <= 0.5
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
  // A perspective transform draws the box as a quad that is no parallelogram, which the affine map
  // from three corners gets wrong (review finding: a point picked the wrong spot, so a nested hit
  // test could pick the wrong child). Refused: the point stays with the parent.
  if (!isParallelogram(content) || !isParallelogram(border)) return undefined
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

/** `route` one level up: its parent session, the point there (the route itself at the top). */
function parentRoute(route: Route): Route {
  const n = route.links.length
  if (n === 0) return route
  const point = route.points[n - 1] as { x: number; y: number }
  return { session: (route.links[n - 1] as Link).parent, x: point.x, y: point.y, links: route.links.slice(0, -1), points: route.points.slice(0, -1) }
}

/** The top document's own point: the page's session, no frame. */
function topRoute(event: MouseEvent): Route {
  return { session: '', x: event.x, y: event.y, links: [], points: [] }
}

/** The `Input.*` commands the router sends (`sendInput`, the only place that does). */
type InputMethod = 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent' | 'Input.insertText'

/** A text or an edit command a caller hands the router (`command`): an `Input.*` on the page's session. */
export type PageCommandMethod = 'Input.insertText' | 'Input.dispatchKeyEvent'

type Step =
  | { kind: 'mouse'; event: MouseEvent }
  | { kind: 'key'; event: KeyEvent }
  | {
      kind: 'command'
      method: PageCommandMethod
      params: Record<string, unknown>
      detached: () => unknown
      resolve: (v: unknown) => void
      reject: (e: unknown) => void
    }
  | { kind: 'call'; run: () => unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void; blocking: boolean }

/**
 * How one `Input.*` command ended for the step that sent it (the answer itself goes to `sent`):
 * `stale` when the attachment changed before it ended, so its step does nothing more with it (review
 * finding: a refusal from before a detach was replayed by sendInputEvent into the new page).
 */
type Outcome = 'answered' | 'refused' | 'late' | 'stale'

/** A release a stalled frame is owed (its press reached it): sent once it answers, in that attachment. */
interface OwedRelease {
  session: string
  epoch: number
  params: Record<string, unknown>
}

/** What the pump does after a step: next, the same step again (a new attachment), or wait (`parked`). */
type StepEnd = 'done' | 'again' | 'park'

/** One hit test (or capture follow) in progress: dropped at its deadline or by a new attachment. */
interface RouteRun {
  epoch: number
  cancelled: boolean
  /** The query on its way, for the deadline to know which session did not answer. */
  current?: { session: string; sent: Promise<unknown>; answered: boolean }
}

/** Thrown inside a hit test that was dropped meanwhile: nothing after it may run. */
class RouteDropped extends Error {}

const defaultTimers: RouterTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

function isMove(step: Step | undefined): boolean {
  return step?.kind === 'mouse' && step.event.type === 'mouseMove'
}

/** One per off-screen page: its child frames, its input queue, the mouse capture and hover. */
export class PageInputRouter implements ChildFrameObserver {
  private readonly frames = new Map<string, ChildFrame>()
  private queue: Step[] = []
  private pumping = false
  /** The head step waits for the page's session to answer (`stalled`); nothing runs till then. */
  private parked = false
  /**
   * The attachment's number: `lost()` (a detach) bumps it. An answer, a deadline or a hit test of an
   * older one changes nothing here (review finding: a late answer after a detach counted down the
   * new attachment's commands, so a pointer event skipped the wait it needed).
   */
  private epoch = 0
  /**
   * Sessions that missed an input command's deadline ('' the page's), each with that command: it
   * gets no other until that one answers (Chromium holds one callback per command, so a session that
   * answers nothing collects at most one).
   */
  private readonly stalled = new Map<string, Promise<unknown>>()
  /** The same for a hit test's queries: a session that left one unanswered is not asked again until it answers. */
  private readonly queryStalled = new Map<string, Promise<unknown>>()
  /**
   * Presses queued and not released yet, by the physical key (`code`: Shift+A goes down as "A" and,
   * Shift let go first, up as "a") or the button: what a release past the queue's cap may match.
   */
  private readonly pressed = new Set<string>()
  /** The last mouse event's route (for the hover moves when the pointer changes session). */
  private hover: Route | undefined
  private capture: { links: Link[]; buttons: number } | undefined
  /**
   * Where each held button's press went (its session and route): its release goes there too, so a
   * frame that got a press always gets its release (review finding: a frame that was late answering
   * the press lost the release to the page's session, and kept the button down).
   */
  private readonly pressedAt = new Map<'left' | 'middle' | 'right', Route>()
  /** Releases owed to stalled frames, by session and button (one per button at most). */
  private readonly owed = new Map<string, Map<string, OwedRelease>>()
  /** Owed releases whose frame answered: the pump sends them before the next queued step. */
  private owedReady: OwedRelease[] = []
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
      this.stalled.delete(id)
      this.queryStalled.delete(id)
      this.owed.delete(id)
      this.owedReady = this.owedReady.filter((o) => o.session !== id)
      for (const [button, route] of this.pressedAt) if (route.session === id) this.pressedAt.delete(button)
      for (const f of this.frames.values()) if (f.parent === id) gone.push(f.sessionId)
    }
  }

  reset(): void {
    this.frames.clear()
    this.lost()
    // A step waiting for the page's answer goes on (by sendInputEvent, the protocol being gone).
    void this.pump()
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
   * A text (`Input.insertText`) or an edit command's key down (`Input.dispatchKeyEvent`) on the
   * page's session, in its place among the input and sent by the router as any key is (one command
   * at a time, its deadline, a stalled page session). Its promise is the command's answer;
   * `detached` runs instead while the protocol is detached (`webContents.insertText`, ...).
   */
  command(method: PageCommandMethod, params: Record<string, unknown>, detached: () => unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.push({ kind: 'command', method, params, detached, resolve, reject })) reject(new Error('webview: input queue full'))
      void this.pump()
    })
  }

  /**
   * `run` (never an `Input.*` command: `command` is for those) in its place among the input: after
   * the command before it was answered. Its promise is `run`'s. `blocking` (the default): what comes
   * after waits for it too, STEP_TIMEOUT_MS at most (a select choice may move focus); false for a
   * read (the selection) that only needs what came before.
   */
  call(run: () => unknown, blocking = true): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.push({ kind: 'call', run, resolve, reject, blocking })) reject(new Error('webview: input queue full'))
      void this.pump()
    })
  }

  /** Queue a step (see `order` at the top of the file); false when it was dropped (a full queue). */
  private push(step: Step): boolean {
    const last = this.queue[this.queue.length - 1]
    // Only with the step right before: merging across a press, a release or a key would reorder them.
    // A step that runs is out of the queue, so a merge never touches one on its way.
    if (step.kind === 'mouse' && last?.kind === 'mouse' && last.event.modifiers.join() === step.event.modifiers.join()) {
      if (step.event.type === 'mouseMove' && last.event.type === 'mouseMove') {
        // Only the latest position of a move that has not gone yet matters (the browser coalesces per
        // animation frame too). Same held buttons only.
        this.queue[this.queue.length - 1] = step
        return true
      }
      if (step.event.type === 'mouseWheel' && last.event.type === 'mouseWheel') {
        this.queue[this.queue.length - 1] = {
          kind: 'mouse',
          event: { ...step.event, deltaX: last.event.deltaX + step.event.deltaX, deltaY: last.event.deltaY + step.event.deltaY }
        }
        return true
      }
    }
    const key = pressKey(step)
    if (key?.release) {
      // A release past the cap only for a press that was taken and not released yet (bounded by the
      // keys and buttons there are): a key or button left down in the page would repeat or drag for
      // good. A release nothing pressed is dropped there (review finding: a client sending only
      // releases to a hung page queued thousands past the cap).
      if (this.queue.length >= MAX_QUEUED_STEPS && !this.pressed.has(key.id)) {
        this.warn('full', 'webview: the page answers no input; input dropped')
        return false
      }
      this.pressed.delete(key.id)
      this.queue.push(step)
      return true
    }
    if (this.queue.length >= MAX_QUEUED_STEPS) {
      // A hung page with a person still typing: moves go first.
      const move = this.queue.findIndex(isMove)
      if (move < 0 || isMove(step)) {
        this.warn('full', 'webview: the page answers no input; input dropped')
        return false
      }
      this.queue.splice(move, 1)
    }
    if (key) this.pressed.add(key.id)
    this.queue.push(step)
    return true
  }

  /**
   * Run the queue, one step at a time; each step's own command is answered (or late) before the next.
   * Owed releases go first. A step that must wait for the stalled page session parks the pump; every
   * wake (the stall cleared, a release owed, a detach) calls `pump`, and the park itself checks again
   * that its reason still holds, since a wake that came while the pump was still running found it
   * busy and returned (review finding: a lost wakeup left a key queued with nothing to restart it).
   */
  private async pump(): Promise<void> {
    if (this.pumping) return
    if (this.parked && this.mustPark()) return
    this.parked = false
    this.pumping = true
    try {
      for (;;) {
        const owed = this.owedReady.shift()
        if (owed) {
          await this.sendOwed(owed)
          continue
        }
        const step = this.queue.shift()
        if (!step) return
        let end: StepEnd = 'done'
        try {
          end = await this.run(step)
        } catch (err) {
          this.warn('step', `webview: input step failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        if (end === 'done') continue
        // Out of the queue while it ran (so no merge touched it): back at the head.
        this.queue.unshift(step)
        if (end === 'park' && this.mustPark()) {
          this.parked = true
          return
        }
      }
    } finally {
      this.pumping = false
    }
  }

  /** Whether the head step still has to wait: the page's session stalled, attached, no owed release to send. */
  private mustPark(): boolean {
    return this.stalled.has('') && this.deps.attached() && this.owedReady.length === 0
  }

  /** One owed release to the frame that answered (dropped if that frame or the attachment went). */
  private async sendOwed(owed: OwedRelease): Promise<void> {
    if (owed.epoch !== this.epoch || !this.deps.attached() || !this.frames.has(owed.session)) return
    if (this.stalled.has(owed.session)) {
      this.oweTo(owed)
      return
    }
    await this.sendInput(owed.session, 'Input.dispatchMouseEvent', owed.params).outcome
  }

  private oweTo(owed: OwedRelease): void {
    let byButton = this.owed.get(owed.session)
    if (!byButton) {
      byButton = new Map()
      this.owed.set(owed.session, byButton)
    }
    byButton.set(String(owed.params.button), owed)
  }

  private async run(step: Step): Promise<StepEnd> {
    if (!this.deps.attached()) {
      this.lost()
      if (step.kind === 'call') this.runCall(step)
      else if (step.kind === 'command') this.settle(step, () => step.detached())
      else this.deps.fallback(step.event)
      return 'done'
    }
    if (step.kind === 'call') {
      const pending = this.runCall(step)
      if (step.blocking) await this.within(pending, STEP_TIMEOUT_MS)
      return 'done'
    }
    if (step.kind === 'command') {
      if (this.stalled.has('')) return 'park'
      const { sent, outcome } = this.sendInput('', step.method, step.params)
      sent.then(step.resolve, step.reject)
      await outcome
      return 'done'
    }
    if (step.kind === 'key') {
      const params = protocolKeyEvent(step.event)
      if (!params) {
        this.deps.fallback(step.event)
        return 'done'
      }
      if (this.stalled.has('')) return 'park'
      // A refusal in this attachment only: `stale` (a detach meanwhile) replays nothing.
      if ((await this.sendInput('', 'Input.dispatchKeyEvent', params).outcome) === 'refused') this.pageRefused(step.event)
      return 'done'
    }
    return this.runMouse(step.event)
  }

  /**
   * One mouse event: every wait first (the command before it was answered: the pump; the hover
   * moves), then the hit test, then its send (see `order` and `hover` at the top of the file).
   */
  private async runMouse(event: MouseEvent): Promise<StepEnd> {
    const epoch = this.epoch
    const found = await this.routeOf(event)
    if (epoch !== this.epoch) return 'again'
    if (event.type === 'mouseUp') {
      const end = await this.releaseToPress(event, found, epoch)
      if (end) return end
    }
    let route = this.deliverable(found, event)
    if (!route) return 'done'
    // A hover move can change the page under the point (an overlay that opens on hover, an owner set
    // to `pointer-events: none`): hit-tested again after it, at most MAX_RETESTS times, then the
    // page's session takes the event (a page that changes on every hover must not spin it).
    for (let retests = 0; !this.capture && this.hover && this.hover.session !== route.session; retests++) {
      if (route.session === '' && this.stalled.has('')) break
      if (retests === MAX_RETESTS) {
        const top = topRoute(event)
        if (!(await this.leave(this.hover, top, event, epoch))) return 'again'
        route = top
        break
      }
      if (!(await this.leave(this.hover, route, event, epoch))) return 'again'
      const again = this.deliverable(await this.routeOf(event), event)
      if (epoch !== this.epoch) return 'again'
      if (!again) return 'done'
      if (again.session === route.session) {
        route = again
        break
      }
      // What hovers now: the left route's ancestors (over its owner), not that frame itself.
      this.hover = parentRoute(route)
      route = again
    }
    // No wait from here to the send: the route is what the page is now.
    let target = route
    if (target.session === '' && this.stalled.has('')) return event.type === 'mouseMove' ? 'done' : 'park'
    const outcome = await this.sendInput(target.session, 'Input.dispatchMouseEvent', protocolMouseEvent(event, target.x, target.y)).outcome
    if (outcome === 'stale') return 'done'
    if (outcome === 'refused') {
      if (target.session === '') {
        this.pageRefused(event)
      } else {
        // The frame went (navigated, removed): the page's session at the top point, never another frame.
        this.warn('frame', "webview: a frame's protocol refused input; it went to the page instead")
        target = topRoute(event)
        if (epoch !== this.epoch) return 'done'
        if (this.stalled.has('')) return event.type === 'mouseMove' ? 'done' : 'park'
        if ((await this.sendInput('', 'Input.dispatchMouseEvent', protocolMouseEvent(event, event.x, event.y)).outcome) === 'refused') this.pageRefused(event)
      }
    }
    if (epoch !== this.epoch) return 'done'
    this.hover = target
    this.captureAfter(target, event)
    if (event.type === 'mouseDown') this.pressedAt.set(event.button, target)
    return 'done'
  }

  /**
   * A release whose press went to a frame goes to that frame (`pressedAt`), at its point there (the
   * capture's route), or at the press's point when the route lost it (the box could not be read): a
   * frame that got a press always gets its release. A stalled frame is owed it (sent once it answers,
   * in this attachment). Undefined: no frame press for this button (or that frame went), routed as any.
   */
  private async releaseToPress(event: Extract<MouseEvent, { button: unknown }>, found: Route, epoch: number): Promise<StepEnd | undefined> {
    const press = this.pressedAt.get(event.button)
    this.pressedAt.delete(event.button)
    if (!press || press.session === '' || !this.frames.has(press.session)) return undefined
    const at = found.session === press.session ? found : press
    const params = protocolMouseEvent(event, at.x, at.y)
    this.captureAfter(at, event)
    if (this.stalled.has(press.session)) {
      this.oweTo({ session: press.session, epoch, params })
      return 'done'
    }
    const outcome = await this.sendInput(press.session, 'Input.dispatchMouseEvent', params).outcome
    if (outcome === 'refused' && epoch === this.epoch) {
      // The frame went: the page's session at the top point, as for any refused frame command.
      this.warn('frame', "webview: a frame's protocol refused input; it went to the page instead")
      if (!this.stalled.has('') && (await this.sendInput('', 'Input.dispatchMouseEvent', protocolMouseEvent(event, event.x, event.y)).outcome) === 'refused') {
        this.pageRefused(event)
      }
    }
    if (epoch === this.epoch) this.hover = at
    return 'done'
  }

  /**
   * The route an event can take now: a frame that owes an answer (`stalled`) gets nothing more, so a
   * move for it is dropped (undefined: the next one is hit-tested anew) and anything else goes to the
   * page's session at the top point, as for a frame that went.
   */
  private deliverable(route: Route, event: MouseEvent): Route | undefined {
    if (route.session === '' || (!this.stalled.has(route.session) && this.frames.has(route.session))) return route
    if (event.type === 'mouseMove' && this.frames.has(route.session)) return undefined
    return topRoute(event)
  }

  /**
   * The one sender of `Input.*` commands, the hover moves included. The contract: at most one command
   * on its way per page, not counting the one each stalled session still owes (a stalled session is
   * held, not the page: a frame that never answers must not block the rest). `outcome` settles when
   * the command is answered, refused or late (STEP_TIMEOUT_MS, a timer per command, cleared by the
   * answer), or `stale` in a later attachment, and the step that sent it waits for that. Late: the
   * session is stalled (gets no other command) until this one answers. `sent` is the protocol's own answer.
   */
  private sendInput(session: string, method: InputMethod, params: Record<string, unknown>): { sent: Promise<unknown>; outcome: Promise<Outcome> } {
    const epoch = this.epoch
    let sent: Promise<unknown>
    try {
      sent = session === '' ? this.deps.send(method, params) : this.deps.send(method, params, session)
    } catch (err) {
      sent = Promise.reject(err)
    }
    const outcome = new Promise<Outcome>((done) => {
      let over = false
      const timer = this.timers.set(() => {
        over = true
        if (epoch !== this.epoch) return done('stale')
        this.stalled.set(session, sent)
        this.warn('stalled', 'webview: the page or a frame did not answer input in time; it gets no more until it does')
        done('late')
      }, STEP_TIMEOUT_MS)
      const end = (result: Outcome): void => {
        if (!over) {
          over = true
          this.timers.clear(timer)
          done(epoch === this.epoch ? result : 'stale')
          return
        }
        // A late answer: the session takes input again, only in the attachment it was sent in, and
        // gets the releases it was owed meanwhile first.
        if (epoch !== this.epoch || this.stalled.get(session) !== sent) return
        this.stalled.delete(session)
        const owed = this.owed.get(session)
        if (owed) {
          this.owed.delete(session)
          this.owedReady.push(...owed.values())
        }
        void this.pump()
      }
      sent.then(
        () => end('answered'),
        () => end('refused')
      )
    })
    return { sent, outcome }
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

  /** A command's detached road, its result (or throw) handed to its caller. */
  private settle(step: Extract<Step, { kind: 'command' }>, run: () => unknown): void {
    try {
      Promise.resolve(run()).then(step.resolve, step.reject)
    } catch (err) {
      step.reject(err)
    }
  }

  /** The protocol detached (or was never attached): a new attachment; no route, capture, hover or stall survives it. */
  private lost(): void {
    this.epoch++
    this.capture = undefined
    this.hover = undefined
    this.stalled.clear()
    this.queryStalled.clear()
    this.pressedAt.clear()
    this.owed.clear()
    this.owedReady = []
    this.parked = false
  }

  /** Where a mouse event goes (capture first, then the hit test; the page's session when neither says). */
  private async routeOf(event: MouseEvent): Promise<Route> {
    const top = topRoute(event)
    if (this.capture && event.type !== 'mouseWheel') {
      if (event.type === 'mouseMove' && heldButtons(event.modifiers) === 0) {
        // A move with no button held: the release went missing (the browser lost it). No capture, and
        // no release owed to where the presses went (none is coming).
        this.capture = undefined
        this.pressedAt.clear()
      } else {
        const links = this.capture.links
        if (links.length === 0) return top
        const epoch = this.epoch
        const followed = await this.bounded((run) => this.follow(links, event.x, event.y, run))
        if (followed) return followed
        if (epoch === this.epoch) this.capture = undefined
        return top
      }
    }
    if (!this.hasChildren('')) return top
    return (await this.bounded((run) => this.hitTest(event.x, event.y, run))) ?? top
  }

  /** The captured frame's point now: its owners' boxes read again (the page may have scrolled). */
  private async follow(links: readonly Link[], x: number, y: number, run: RouteRun): Promise<Route | undefined> {
    const points: Array<{ x: number; y: number }> = []
    let px = x
    let py = y
    for (const link of links) {
      if (!this.frames.has(link.session)) return undefined
      const box = await this.query('DOM.getBoxModel', { backendNodeId: link.owner }, link.parent, run)
      const at = pointInFrame((box as { model?: unknown } | undefined)?.model, px, py)
      if (!at) return undefined
      points.push({ x: px, y: py })
      px = at.x
      py = at.y
    }
    return { session: (links[links.length - 1] as Link).session, x: px, y: py, links: [...links], points }
  }

  /** The deepest cross-site frame under (x, y) of the top document, and the point there. */
  private async hitTest(x: number, y: number, run: RouteRun): Promise<Route> {
    const links: Link[] = []
    const points: Array<{ x: number; y: number }> = []
    let session = ''
    let px = x
    let py = y
    for (let depth = 0; depth < MAX_FRAME_DEPTH && this.hasChildren(session); depth++) {
      const next = await this.childAt(session, px, py, true, run)
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
  private async childAt(
    session: string,
    x: number,
    y: number,
    retry: boolean,
    run: RouteRun
  ): Promise<{ session: string; owner: number; x: number; y: number } | undefined> {
    const metrics = (await this.query('Page.getLayoutMetrics', undefined, session, run)) as { cssLayoutViewport?: { pageX?: unknown; pageY?: unknown } } | undefined
    const scrollX = Number(metrics?.cssLayoutViewport?.pageX)
    const scrollY = Number(metrics?.cssLayoutViewport?.pageY)
    if (!Number.isFinite(scrollX) || !Number.isFinite(scrollY)) return undefined
    // Document coordinates (the viewport point plus the scroll), whole px; the boxes below are the viewport's.
    const hit = (await this.query(
      'DOM.getNodeForLocation',
      { x: Math.floor(x + scrollX), y: Math.floor(y + scrollY), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false },
      session,
      run
    )) as { backendNodeId?: unknown } | undefined
    const owner = hit?.backendNodeId
    if (typeof owner !== 'number' || !Number.isInteger(owner)) return undefined
    const described = (await this.query('DOM.describeNode', { backendNodeId: owner }, session, run)) as { node?: { frameId?: unknown } } | undefined
    const frameId = described?.node?.frameId
    if (typeof frameId !== 'string') return undefined
    const child = this.childOf(session, frameId)
    if (!child) return undefined
    const box = await this.query('DOM.getBoxModel', { backendNodeId: owner }, session, run)
    const at = pointInFrame((box as { model?: unknown } | undefined)?.model, x, y)
    if (!at) return undefined
    if (!at.inBorder) return retry ? this.childAt(session, x, y, false, run) : undefined
    if (!at.inside) return undefined
    return { session: child.sessionId, owner, x: at.x, y: at.y }
  }

  /**
   * One read-only protocol query of a hit test on a session ('' the page's); undefined when refused,
   * or when that session still owes the answer to one that missed a route's deadline (asked nothing
   * until then: the hit test stops at its parent's level). Throws RouteDropped once the hit test was
   * dropped (its deadline, a detach), so nothing after it runs.
   */
  private async query(method: string, params: Record<string, unknown> | undefined, session: string, run: RouteRun): Promise<unknown> {
    if (run.cancelled || run.epoch !== this.epoch) throw new RouteDropped()
    if (this.queryStalled.has(session)) return undefined
    let sent: Promise<unknown>
    try {
      sent = session === '' ? this.deps.send(method, params) : this.deps.send(method, params, session)
    } catch {
      sent = Promise.reject(new Error('refused'))
    }
    const current = { session, sent, answered: false }
    run.current = current
    let value: unknown
    try {
      value = await sent
    } catch {
      value = undefined
    }
    current.answered = true
    if (run.cancelled || run.epoch !== this.epoch) throw new RouteDropped()
    return value
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
   * The pointer moved from `from`'s route to another session without capture: each frame of the old
   * chain that is not on the new one gets a move outside its viewport, deepest first (B, then A,
   * when the pointer goes from B in A straight to the top document), and each ancestor on the new
   * chain a move over the owner it now hovers (see `hover` at the top of the file). Each is a
   * command of its own (`sendInput`), answered before the next; a session that owes an answer gets
   * none. False when the attachment changed meanwhile (the step starts over).
   */
  private async leave(from: Route, to: Route, event: MouseEvent, epoch: number): Promise<boolean> {
    const modifiers = protocolModifiers(event.modifiers)
    const moveTo = async (session: string, x: number, y: number): Promise<boolean> => {
      if ((session !== '' && !this.frames.has(session)) || this.stalled.has(session)) return true
      const params = { type: 'mouseMoved', x, y, modifiers, button: 'none', buttons: 0, clickCount: 0, pointerType: 'mouse' }
      await this.sendInput(session, 'Input.dispatchMouseEvent', params).outcome
      return epoch === this.epoch
    }
    const next = new Set(['', ...to.links.map((l) => l.session)])
    const old = ['', ...from.links.map((l) => l.session)]
    for (const session of old.reverse()) if (!next.has(session) && !(await moveTo(session, -1, -1))) return false
    for (let i = 0; i < to.links.length; i++) {
      const link = to.links[i] as Link
      const point = to.points[i] as { x: number; y: number }
      if (!(await moveTo(link.parent, point.x, point.y))) return false
    }
    return true
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

  /**
   * A hit test within ROUTE_TIMEOUT_MS, else undefined (the event goes on unrouted). At the deadline
   * the walk is dropped (its next query throws) and the session whose query is on its way is asked
   * nothing more until it answers (`queryStalled`): one unanswered query per session at most.
   */
  private bounded(walk: (run: RouteRun) => Promise<Route | undefined>): Promise<Route | undefined> {
    const run: RouteRun = { epoch: this.epoch, cancelled: false }
    return new Promise((done) => {
      const timer = this.timers.set(() => {
        run.cancelled = true
        const q = run.current
        if (q && !q.answered && run.epoch === this.epoch) {
          this.queryStalled.set(q.session, q.sent)
          const clear = (): void => {
            if (run.epoch === this.epoch && this.queryStalled.get(q.session) === q.sent) this.queryStalled.delete(q.session)
          }
          q.sent.then(clear, clear)
        }
        done(undefined)
      }, ROUTE_TIMEOUT_MS)
      walk(run).then(
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

  /** `pending` settled, or `ms` passed: either way the pump goes on (one reaction on `pending`, one timer). */
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

/** A press or a release's identity for the queue's cap: the physical key (`code`) or the button. */
function pressKey(step: Step): { id: string; release: boolean } | undefined {
  // An edit command's key down (Cmd+Left, Ctrl+A, ...) is a press too: its key up comes as a key
  // (review finding: it was not counted, so its key up was dropped past the cap).
  if (step.kind === 'command' && step.method === 'Input.dispatchKeyEvent') {
    const { type, code } = step.params
    return (type === 'rawKeyDown' || type === 'keyDown') && typeof code === 'string' && code !== '' ? { id: `key:${code}`, release: false } : undefined
  }
  if (step.kind === 'key' && (step.event.type === 'keyDown' || step.event.type === 'keyUp')) {
    return { id: `key:${webviewKeyInfo(step.event.keyCode)?.code ?? step.event.keyCode}`, release: step.event.type === 'keyUp' }
  }
  if (step.kind === 'mouse' && (step.event.type === 'mouseDown' || step.event.type === 'mouseUp')) {
    return { id: `button:${step.event.button}`, release: step.event.type === 'mouseUp' }
  }
  return undefined
}
