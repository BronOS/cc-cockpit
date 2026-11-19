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
//   capture    after a press, moves and other presses go to the frame that got the first press still
//              held (as a real browser captures the mouse: a drag that leaves the frame still selects
//              in it, a drag that started in the top document stays there over a frame), the owners'
//              boxes read again on each event (the page may scroll under a drag). Each press is one
//              record (`presses`, by button): the session it went to (the page's or a frame's) and its
//              owners; a press no session took records nothing. Its release goes
//              there and nowhere else, exactly once: to a frame that owes an answer it is owed and
//              sent once that frame answers; to one that went (or refused) it is dropped; a release
//              with no record (its press went nowhere: a detach, a full queue) is dropped too, so no
//              session gets a release it was not pressed for. A move without a button the router
//              holds down, or a press of a button it holds, means the viewer's release went missing:
//              that release is sent then, to the press's session (review finding: forgetting it left
//              the frame's button down).
//   hover      when the pointer goes to another session without capture, every frame it left gets
//              one move outside its viewport (-1, -1) first, so its hover ends (mouseout, mouseleave)
//              instead of sticking, and every ancestor of the new frame one over the owner it now
//              hovers (the iframe element, as in a real browser). Each is a command of its own, sent
//              and answered like any other (below); then the point is hit-tested again, since a hover
//              can change the page under it (an overlay, `pointer-events: none` on the owner): at most
//              MAX_RETESTS times, then the frames left get their moves and the page's session takes
//              the event at the top point (a page that changes on every hover must not spin it).
//   order      one queue per page, run one step at a time (`pump`), and one input command on its way
//              per page, across all its sessions: every `Input.*` goes through `sendInput`, which
//              holds the contract (nothing while the page's session owes an answer, nothing to a
//              session that owes one or went, one on its way), and the step that sent it waits until
//              it is answered or its deadline (STEP_TIMEOUT_MS, a timer per command) passed before
//              anything else goes. A key sent while the press into a frame is still on its way lands
//              in the old focus (a probe: 15 of 30 without the wait, 0 of 30 with it); a press
//              hit-tested while a move was on its way can pick a frame that move's hover covered
//              (review finding). So a pointer event waits first and is hit-tested last, right before
//              its send. Keys too go one at a time: the page answers one in about 0.15 ms
//              (scripts/offscreen-input-check.mjs), so a window of several would win nothing.
//              While a step waits, moves behind it coalesce to the latest and wheel deltas sum (each
//              only with the step right before it); presses, releases, keys, texts and calls keep their
//              order. The queue holds MAX_QUEUED_STEPS: past it moves go first, and then only a release
//              of a press it took (by the physical key, `code`, or the button) gets in.
//   stalled    a session whose command missed its deadline gets no other until that one answers (so a
//              renderer that answers nothing holds one unanswered command, never a pile), and that
//              command no longer counts toward the page's one on its way: a stalled frame holds itself,
//              not the page. A move for a stalled frame is dropped, a press or wheel goes to the page's
//              session at the top point, a release is owed (above). While the page's own session is
//              stalled nothing at all goes, page-wide: keys, texts, commands, calls, presses, releases
//              and wheels wait in the queue in order (the pump idle, no timer: by the queue's cap),
//              moves are dropped, no hit test runs, owed releases wait too (review finding: a press
//              into a frame went while a key to the page was unanswered, so focus could move before
//              it landed); its answer, or a detach, starts the pump again. A hit test's query that
//              missed ROUTE_TIMEOUT_MS likewise: that session is asked nothing until it answers.
//   epoch      each attachment has a number, bumped when the protocol detaches (`lost`, `reset`), and
//              each session is an object of its own (`Lane`) that `end` marks gone, the one place that
//              drops what the router holds for it. Every continuation (an answer, a refusal, a
//              deadline, a hover move's end, a hit test) checks both: one of an older attachment or of
//              a session that went changes nothing, requeues nothing, replays nothing (review
//              findings: a late answer after a detach counted down the new attachment's commands; a
//              hover move refused after a detach requeued its press into the new attachment; a
//              deadline put a frame that went back among the stalled ones).
//   fallback   a refused command on a live frame's session (the frame went: navigated, removed)
//              goes to the page's session at the top document's point, never to another frame (a
//              release excepted: above); a press sent there owes its release there. A refusal from a
//              frame that already went (or from an older attachment) is stale: nothing is sent again,
//              anywhere. Whatever the page's own session refuses (a pointer event, a key, a text, an
//              edit command) is dropped and logged once (a text or command's caller hears the
//              rejection), never sent by another road: one run after a refusal could land in a later
//              attachment or after the input queued behind it (review 5). A refused press records
//              nothing, so its release is dropped too; a refused release clears its press. The
//              detached roads (`sendInputEvent`, a command's own) are for a protocol that is
//              detached when the step runs, in order: what follows a text or command waits for its
//              road's answer. Each is logged once per view.
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
  /** `webContents.sendInputEvent`, the road only while the protocol is detached when a step runs. */
  fallback(event: ElectronInputEvent): void
  log(message: string): void
  timers?: RouterTimers
}

/**
 * One protocol session of one attachment, from its attach to its end: the page's own (`id` '') or
 * a child frame's. Everything the router knows about a session lives here, so ending it (`end`) is
 * one flag, and a continuation that kept the object (an answer, a deadline, a hit test) checks
 * `live` instead of looking an id up again (review finding: a deadline put a frame that had gone
 * back into a map by its id, so the map grew with every frame that went with a command unanswered).
 */
interface Lane {
  /** The protocol's session id; '' the page's own. */
  readonly id: string
  /** The attachment it belongs to (`epoch`). */
  readonly epoch: number
  /** False once it went (frameDetached, its parent went, the attachment ended): it gets nothing more, ever. */
  live: boolean
  /** The command that missed its deadline and is not answered yet: the session gets nothing else until it is. */
  stalled: object | undefined
  /** The same for a hit test's query: the session is asked nothing until it answers. */
  queryStalled: object | undefined
  /** A frame's: its target id (a frame's id is its target's), its parent, whether it was resumed. */
  readonly targetId: string
  readonly parent: Lane | undefined
  ready: boolean
}

function newLane(id: string, epoch: number, targetId = '', parent?: Lane): Lane {
  return { id, epoch, live: true, stalled: undefined, queryStalled: undefined, targetId, parent, ready: id === '' }
}

/** One link of a route: the owner element (`owner`, a backend node id) in `parent` of the frame `lane`. */
interface Link {
  parent: Lane
  owner: number
  lane: Lane
}

/** Where a pointer event goes: the session and the point there. */
interface Route {
  lane: Lane
  x: number
  y: number
  /** The owners from the top down to `lane`. */
  links: Link[]
  /** The point in each link's parent (points[i] in links[i].parent). */
  points: Array<{ x: number; y: number }>
}

/** Where the pointer was last delivered: the session and the owners down to it (see `hover` at the top of the file). */
interface Hover {
  lane: Lane
  links: Link[]
}

/** `route` one level up: its parent session, the point there (the route itself at the top). */
function parentRoute(route: Route): Route {
  const n = route.links.length
  if (n === 0) return route
  const point = route.points[n - 1] as { x: number; y: number }
  return { lane: (route.links[n - 1] as Link).parent, x: point.x, y: point.y, links: route.links.slice(0, -1), points: route.points.slice(0, -1) }
}

/** The top document's own point: the page's session, no frame. */
function topRoute(event: MouseEvent, page: Lane): Route {
  return { lane: page, x: event.x, y: event.y, links: [], points: [] }
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
 * `stale` when the attachment changed before it ended (or the sender held it back), so its step
 * does nothing more: no fallback, no requeue, no replay (review findings: a refusal from before a
 * detach was replayed by sendInputEvent into the new page; a hover move's refusal from before a
 * detach requeued its press into the new attachment).
 */
type Outcome = 'answered' | 'refused' | 'late' | 'stale'

/**
 * What the pump does after a step: next, or put it back at the head (`park`, same attachment only)
 * and run it again once what it waits for is over: the page's session owing an answer, or the
 * releases a frame is owed going first.
 */
type StepEnd = 'done' | 'park'

type Button = 'left' | 'middle' | 'right'
type MouseUp = Extract<MouseEvent, { type: 'mouseDown' | 'mouseUp' }>

/**
 * A press that was delivered and not released yet: where it went, so its release goes there and
 * nowhere else (rule: a release goes to the session its press went to, exactly once).
 */
interface Press {
  button: Button
  lane: Lane
  /** The owners down to `lane` when it was pressed (the capture follows them, boxes read again). */
  links: Link[]
  /** The press's point in `lane`, for a release whose route cannot be read. */
  x: number
  y: number
}

/** A release whose session owed an answer when it came: sent once that session answers (dropped if it goes). */
interface Owed {
  lane: Lane
  params: Record<string, unknown>
}

/** One hit test (or capture follow) in progress: dropped at its deadline or by a new attachment. */
interface RouteRun {
  epoch: number
  cancelled: boolean
  /** The query on its way, for the deadline to know which session did not answer. */
  current?: { lane: Lane; sent: Promise<unknown>; answered: boolean; token: object }
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

/** A release the viewer never sent, at `event`'s point: its button up, the rest of `event`'s modifiers kept. */
function releaseOf(event: MouseEvent, button: Button): MouseUp {
  const modifiers = event.modifiers.filter((m) => m !== `${button}buttondown`)
  return { type: 'mouseUp', x: event.x, y: event.y, button, clickCount: 1, modifiers }
}

/** One per off-screen page: its sessions, its input queue, the presses held and the hover. */
export class PageInputRouter implements ChildFrameObserver {
  /** The attachment's number: `lost()` (a detach) bumps it, and every continuation checks it. */
  private epoch = 0
  /** The page's own session in this attachment (a new one per attachment). */
  private page: Lane = newLane('', 0)
  /** The child frames' sessions of this attachment, by session id. */
  private readonly frames = new Map<string, Lane>()
  private queue: Step[] = []
  private pumping = false
  /** The command on its way and not late yet (at most one per page: `sendInput`). */
  private onWay: object | undefined
  /**
   * Presses taken into the queue and not released yet, by the physical key (`code`: Shift+A goes
   * down as "A" and, Shift let go first, up as "a") or the button: what a release past the queue's
   * cap may match. Bounded by the keys and buttons there are.
   */
  private readonly pressed = new Set<string>()
  /** Presses delivered and not released, by button; the first one held is the capture. */
  private readonly presses = new Map<Button, Press>()
  /** Releases owed to sessions that owed an answer when they came, in order. */
  private owed: Owed[] = []
  /** Where the pointer was last delivered (for the hover moves when it changes session). */
  private hover: Hover | undefined
  private readonly warned = new Set<string>()
  private readonly timers: RouterTimers

  constructor(private readonly deps: PageInputDeps) {
    this.timers = deps.timers ?? defaultTimers
  }

  frameAttached(sessionId: string, targetId: string, parentSessionId: string, type: string): void {
    // Only an iframe is a document under a point; a worker is not, and a prerendered page is not shown.
    if (type !== 'iframe' || sessionId === '' || targetId === '') return
    // A child is attached through its parent's session, so its parent is known; one that is not
    // (a worker's) is under no point.
    const parent = parentSessionId === '' ? this.page : this.frames.get(parentSessionId)
    if (!parent) return
    const old = this.frames.get(sessionId)
    if (old) this.end(old)
    this.frames.set(sessionId, newLane(sessionId, this.epoch, targetId, parent))
  }

  frameReady(sessionId: string): void {
    const frame = this.frames.get(sessionId)
    if (frame) frame.ready = true
  }

  frameDetached(sessionId: string): void {
    const frame = this.frames.get(sessionId)
    if (frame) this.end(frame)
  }

  reset(): void {
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
   * at a time, its deadline, a stalled page session). Its promise is the command's answer (a
   * refusal rejects it, and nothing else runs it); `detached` runs instead only while the protocol
   * is detached (`webContents.insertText`, ...), and the input after it waits for its answer.
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
    // While the page's session owes an answer its moves are dropped (the next one after it answers
    // is hit-tested anew); the rest waits.
    if (isMove(step) && this.page.stalled && this.deps.attached()) return true
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
   * Run the queue, one step at a time; each step's commands are answered (or late) before the next.
   * Owed releases go first. While the page's session owes an answer nothing runs (`park`): its
   * answer, or a detach, calls `pump` again. The check is made at the top of each turn with no wait
   * between it and the return, so a wake that came while a step ran (and found the pump busy) is
   * seen there (review finding: a lost wakeup left a key queued with nothing to restart it).
   */
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      for (;;) {
        if (!this.deps.attached()) {
          // The protocol went: what waits goes by the roads of a detached view, in order. A text or
          // an edit command's road answers later (an IPC of its own), so what comes after it waits
          // for that answer, STEP_TIMEOUT_MS at most, as for a command on the protocol.
          this.lost()
          const step = this.queue.shift()
          if (!step) return
          if (step.kind === 'command') await this.within(this.settle(step, step.detached), STEP_TIMEOUT_MS)
          else this.runDetached(step)
          continue
        }
        if (this.page.stalled) {
          this.queue = this.queue.filter((s) => !isMove(s))
          return
        }
        const owed = this.owed.findIndex((o) => !o.lane.stalled)
        if (owed >= 0) {
          const [o] = this.owed.splice(owed, 1) as [Owed]
          const outcome = await this.sendInput(o.lane, 'Input.dispatchMouseEvent', o.params).outcome
          // Refused: that release is dropped; a frame's refusal (it went) drops its other presses too.
          if (outcome === 'refused' && o.lane.live) {
            if (o.lane === this.page) this.pageRefused()
            else this.frameRefused(o.lane)
          }
          continue
        }
        const step = this.queue.shift()
        if (!step) return
        const epoch = this.epoch
        let end: StepEnd = 'done'
        try {
          end = await this.run(step)
        } catch (err) {
          this.warn('step', `webview: input step failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        // Back at the head to wait for the page's answer; never into another attachment.
        if (end === 'park' && epoch === this.epoch) this.queue.unshift(step)
      }
    } finally {
      this.pumping = false
    }
  }

  private runDetached(step: Exclude<Step, { kind: 'command' }>): void {
    if (step.kind === 'call') this.runCall(step)
    else this.deps.fallback(step.event)
  }

  private async run(step: Step): Promise<StepEnd> {
    if (step.kind === 'call') {
      const pending = this.runCall(step)
      if (step.blocking) await this.within(pending, STEP_TIMEOUT_MS)
      return 'done'
    }
    if (step.kind === 'command') {
      // Refused: the caller hears the rejection, and no other road runs it (review 5: a detached
      // road run after a refusal could land in a later attachment, or after the input behind it).
      const { sent, outcome } = this.sendInput(this.page, step.method, step.params)
      sent.then(step.resolve, step.reject)
      if ((await outcome) === 'refused') this.pageRefused()
      return 'done'
    }
    if (step.kind === 'key') {
      const params = protocolKeyEvent(step.event)
      if (!params) {
        this.deps.fallback(step.event)
        return 'done'
      }
      // Refused: dropped, never by sendInputEvent (the same reasons).
      if ((await this.sendInput(this.page, 'Input.dispatchKeyEvent', params).outcome) === 'refused') this.pageRefused()
      return 'done'
    }
    return this.runMouse(step.event)
  }

  /**
   * After a wait inside a mouse step: `done` when the attachment changed (the step is dropped, never
   * replayed), the step's end while the page's session owes an answer (a move is dropped, anything
   * else waits whole and runs again), undefined to go on.
   */
  private interrupted(epoch: number, event: MouseEvent): StepEnd | undefined {
    if (epoch !== this.epoch) return 'done'
    if (this.page.stalled) return event.type === 'mouseMove' ? 'done' : 'park'
    return undefined
  }

  /**
   * One mouse event: a release to its press; else every wait first (the releases the viewer lost,
   * the hover moves), then the hit test, then its send (see `order` and `hover` at the top of the file).
   */
  private async runMouse(event: MouseEvent): Promise<StepEnd> {
    const epoch = this.epoch
    if (event.type === 'mouseUp') {
      // A release goes where its press went, or nowhere: a session that got no press for it (it
      // went, a detach, a full queue) gets no stray release.
      const press = this.presses.get(event.button)
      if (press) await this.release(press, event)
      return 'done'
    }
    // A move without a button the router holds down, or a press of a button it holds: that
    // button's release went missing (the browser lost it). Sent now where its press went, as the
    // viewer would have (review finding: forgetting it left the frame's button down for good).
    const held = event.type === 'mouseMove' ? heldButtons(event.modifiers) : undefined
    for (const press of [...this.presses.values()]) {
      const lost = held !== undefined ? (held & BUTTON_BITS[press.button]) === 0 : event.type === 'mouseDown' && event.button === press.button
      if (!lost) continue
      await this.release(press, releaseOf(event, press.button))
      const end = this.interrupted(epoch, event)
      if (end) return end
    }
    const found = await this.routeOf(event)
    const stop = this.interrupted(epoch, event)
    if (stop) return stop
    if (found && this.owedFirst(found.lane)) return 'park'
    let route = found && this.deliverable(found, event)
    if (!route) return 'done'
    // A hover move can change the page under the point (an overlay that opens on hover, an owner set
    // to `pointer-events: none`): hit-tested again after it, at most MAX_RETESTS times, then the
    // page's session takes the event (a page that changes on every hover must not spin it).
    for (let retests = 0; this.presses.size === 0 && this.hover && this.hover.lane !== route.lane; retests++) {
      const to: Route = retests === MAX_RETESTS ? topRoute(event, this.page) : route
      await this.leave(this.hover, to, event)
      const end = this.interrupted(epoch, event)
      if (end) return end
      // What hovers now: the new route's ancestors (over its owner), not that frame itself.
      this.hover = parentRoute(to)
      if (retests === MAX_RETESTS) {
        route = to
        break
      }
      const again = await this.routeOf(event)
      const after = this.interrupted(epoch, event)
      if (after) return after
      if (again && this.owedFirst(again.lane)) return 'park'
      const next = again && this.deliverable(again, event)
      if (!next) return 'done'
      const same = next.lane === route.lane
      route = next
      if (same) break
    }
    // No wait from here to the send: the route is what the page is now. A frame that went (or
    // stalled) during the hover moves: as for any route to it.
    if (this.owedFirst(route.lane)) return 'park'
    route = this.deliverable(route, event)
    if (!route) return 'done'
    return this.dispatch(route, event, epoch)
  }

  /** The send of one mouse event on `route`, its fallbacks, and what it leaves held (hover, press). */
  private async dispatch(route: Route, event: MouseEvent, epoch: number): Promise<StepEnd> {
    const outcome = await this.sendInput(route.lane, 'Input.dispatchMouseEvent', protocolMouseEvent(event, route.x, route.y)).outcome
    // Checked again where the step goes on (a detach, or the frame going, may land between the
    // command's end and here): a session that went replays nothing anywhere (review 5).
    if (outcome === 'stale' || epoch !== this.epoch || !route.lane.live) return 'done'
    let at = route
    if (outcome === 'refused') {
      // The page's own session refusing: dropped (a refused press records nothing, so its release
      // is dropped too), never by sendInputEvent while attached (the coordinator's decision on
      // review 5: that road could land in a later attachment or out of order).
      if (route.lane === this.page) return this.pageRefused()
      // The frame went (navigated, removed): the page's session at the top point, never another frame.
      this.frameRefused(route.lane)
      const top = topRoute(event, this.page)
      const second = await this.sendInput(this.page, 'Input.dispatchMouseEvent', protocolMouseEvent(event, event.x, event.y)).outcome
      if (second === 'stale' || epoch !== this.epoch || !top.lane.live) return 'done'
      if (second === 'refused') return this.pageRefused()
      at = top
    }
    const lane = at.lane
    if (!lane.live) return 'done'
    this.hover = { lane, links: at.links }
    if (event.type === 'mouseDown') this.presses.set(event.button, { button: event.button, lane, links: at.links, x: at.x, y: at.y })
    return 'done'
  }

  /**
   * A press's release (the viewer's, or one it lost), to the session the press went to, once: at
   * its point there now (the press's owners' boxes read again), or at the press's own point when
   * they cannot be read. To a session that owes an answer it is owed (sent once it answers); to one
   * that went it is dropped, as is one the session refuses (it went).
   */
  private async release(press: Press, event: MouseUp): Promise<void> {
    this.presses.delete(press.button)
    const lane = press.lane
    if (!lane.live) return
    let point = { x: event.x, y: event.y }
    if (lane !== this.page) {
      const followed = await this.bounded((run) => this.follow(press.links, event.x, event.y, run))
      if (!lane.live || lane.epoch !== this.epoch) return
      point = followed ?? { x: press.x, y: press.y }
    }
    const params = protocolMouseEvent(event, point.x, point.y)
    if (lane.stalled || this.owes(lane)) {
      this.owed.push({ lane, params })
      return
    }
    const outcome = await this.sendInput(lane, 'Input.dispatchMouseEvent', params).outcome
    if (outcome === 'stale' || !lane.live || lane.epoch !== this.epoch) return
    if (outcome === 'refused') {
      // Its press record is already cleared: the release is dropped, nowhere else.
      if (lane === this.page) return void this.pageRefused()
      this.frameRefused(lane)
    }
    this.hover = { lane, links: press.links }
  }

  /**
   * Whether `lane` answered and its owed releases have not gone yet (it answered while this step
   * ran): the step waits for them (`park`: the pump sends them first, then runs it again), so the
   * frame gets its release before anything new and a press for it is not sent elsewhere.
   */
  private owedFirst(lane: Lane): boolean {
    return lane !== this.page && lane.live && !lane.stalled && this.owes(lane)
  }

  /** Whether a release is still owed to `lane` (it gets nothing new before those). */
  private owes(lane: Lane): boolean {
    return this.owed.some((o) => o.lane === lane)
  }

  /** Whether `lane` can take an event now: live, owing no answer and no release. */
  private open(lane: Lane): boolean {
    return lane.live && lane.epoch === this.epoch && !lane.stalled && !this.owes(lane)
  }

  /**
   * The route an event can take now: a frame that owes an answer or a release gets nothing new, so
   * a move for it is dropped (undefined: the next one is hit-tested anew) and anything else goes to
   * the page's session at the top point, as for a frame that went.
   */
  private deliverable(route: Route, event: MouseEvent): Route | undefined {
    if (route.lane === this.page || this.open(route.lane)) return route
    if (event.type === 'mouseMove' && route.lane.live) return undefined
    return topRoute(event, this.page)
  }

  /**
   * The one sender of `Input.*` commands, the hover moves included. The contract, held here: nothing
   * while the page's session owes an answer, nothing to a session that owes one or went, and at most
   * one command on its way per page (one that missed its deadline no longer counts: a stalled frame
   * holds itself, not the page). `outcome` settles when the command is answered, refused or late
   * (STEP_TIMEOUT_MS, a timer per command, cleared by the answer), or `stale` in a later attachment,
   * and the step that sent it waits for that. Late: the session gets nothing else until this one
   * answers. Every continuation checks the attachment and the session's own lifetime: one from before
   * a detach, or of a session that went, changes nothing. `sent` is the protocol's own answer.
   */
  private sendInput(lane: Lane, method: InputMethod, params: Record<string, unknown>): { sent: Promise<unknown>; outcome: Promise<Outcome> } {
    const epoch = this.epoch
    if (!lane.live || lane.epoch !== epoch || lane.stalled || this.page.stalled || this.onWay) {
      // The callers check all of it first; this is the contract's last line, never reached.
      this.warn('order', 'webview: an input command was held back (out of order)')
      const refused = Promise.reject(new Error('webview: input held back'))
      refused.catch(() => {})
      return { sent: refused, outcome: Promise.resolve('stale') }
    }
    let sent: Promise<unknown>
    try {
      sent = lane.id === '' ? this.deps.send(method, params) : this.deps.send(method, params, lane.id)
    } catch (err) {
      sent = Promise.reject(err)
    }
    const token = {}
    this.onWay = token
    const outcome = new Promise<Outcome>((done) => {
      let over = false
      const finish = (result: Outcome): void => {
        over = true
        if (this.onWay === token) this.onWay = undefined
        // An answer, refusal or deadline of an older attachment or of a session that went is stale:
        // its step does nothing more with it (review 5: a frame's refusal after it went replayed its
        // press on the page).
        done(epoch === this.epoch && lane.live ? result : 'stale')
      }
      const timer = this.timers.set(() => {
        if (over) return
        if (epoch === this.epoch && lane.live) {
          lane.stalled = token
          this.warn('stalled', 'webview: the page or a frame did not answer input in time; it gets no more until it does')
        }
        finish('late')
      }, STEP_TIMEOUT_MS)
      const end = (result: 'answered' | 'refused'): void => {
        if (!over) {
          this.timers.clear(timer)
          finish(result)
          return
        }
        // A late answer: the session takes input again (its owed releases first), only if it is
        // still the one that missed the deadline with this command.
        if (lane.stalled !== token) return
        lane.stalled = undefined
        if (lane.live && lane.epoch === this.epoch) void this.pump()
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

  /** A command's detached road, its result (or throw) handed to its caller; the promise the pump waits on. */
  private settle(step: Extract<Step, { kind: 'command' }>, run: () => unknown): Promise<unknown> {
    let pending: Promise<unknown>
    try {
      pending = Promise.resolve(run())
    } catch (err) {
      pending = Promise.reject(err)
    }
    pending.then(step.resolve, step.reject)
    return pending
  }

  /**
   * The one end of a session and of what the router holds for it: it and the frames under it get
   * nothing more, their presses and owed releases are dropped, and the hover keeps the part of its
   * chain that is still there (those frames still get their hover's end).
   */
  private end(lane: Lane): void {
    const gone = [lane]
    for (let i = 0; i < gone.length; i++) {
      const l = gone[i] as Lane
      l.live = false
      if (l.id !== '') this.frames.delete(l.id)
      for (const f of this.frames.values()) if (f.parent === l) gone.push(f)
    }
    this.owed = this.owed.filter((o) => o.lane.live)
    for (const [button, press] of this.presses) if (!press.lane.live) this.presses.delete(button)
    if (this.hover) {
      const k = this.hover.links.findIndex((l) => !l.lane.live)
      if (!this.hover.lane.live && k < 0) this.hover = undefined
      else if (k === 0) this.hover = { lane: this.page, links: [] }
      else if (k > 0) this.hover = { lane: (this.hover.links[k - 1] as Link).lane, links: this.hover.links.slice(0, k) }
      if (this.hover && !this.hover.lane.live) this.hover = undefined
    }
  }

  /** The protocol detached (or was never attached): a new attachment; no session, press, hover or stall survives it. */
  private lost(): void {
    this.epoch++
    for (const f of [...this.frames.values()]) this.end(f)
    this.end(this.page)
    this.page = newLane('', this.epoch)
    this.presses.clear()
    this.owed = []
    this.hover = undefined
    this.onWay = undefined
  }

  /** A frame's session refused a command (it went: navigated, removed): its presses and owed releases with it. */
  private frameRefused(lane: Lane): void {
    this.warn('frame', "webview: a frame's protocol refused input; it went to the page instead")
    for (const [button, press] of this.presses) if (press.lane === lane) this.presses.delete(button)
    this.owed = this.owed.filter((o) => o.lane !== lane)
  }

  /** The first press still held: it captures the pointer (moves and presses follow it). */
  private captor(): Press | undefined {
    for (const press of this.presses.values()) return press
    return undefined
  }

  /**
   * Where a mouse event goes (the capture first, then the hit test; the page's session when neither
   * says). Undefined: a move with nowhere to go now (its captured frame's box could not be read).
   */
  private async routeOf(event: MouseEvent): Promise<Route | undefined> {
    const top = topRoute(event, this.page)
    const captor = event.type === 'mouseWheel' ? undefined : this.captor()
    if (captor) {
      if (captor.lane === this.page) return top
      const links = captor.links
      const followed = await this.bounded((run) => this.follow(links, event.x, event.y, run))
      if (followed) return followed
      return event.type === 'mouseMove' ? undefined : top
    }
    if (!this.hasChildren(this.page)) return top
    return (await this.bounded((run) => this.hitTest(event.x, event.y, run))) ?? top
  }

  /** The captured frame's point now: its owners' boxes read again (the page may have scrolled). */
  private async follow(links: readonly Link[], x: number, y: number, run: RouteRun): Promise<Route | undefined> {
    if (links.length === 0) return undefined
    const points: Array<{ x: number; y: number }> = []
    let px = x
    let py = y
    for (const link of links) {
      if (!link.lane.live) return undefined
      const box = await this.query('DOM.getBoxModel', { backendNodeId: link.owner }, link.parent, run)
      const at = pointInFrame((box as { model?: unknown } | undefined)?.model, px, py)
      if (!at) return undefined
      points.push({ x: px, y: py })
      px = at.x
      py = at.y
    }
    return { lane: (links[links.length - 1] as Link).lane, x: px, y: py, links: [...links], points }
  }

  /** The deepest cross-site frame under (x, y) of the top document, and the point there. */
  private async hitTest(x: number, y: number, run: RouteRun): Promise<Route> {
    const links: Link[] = []
    const points: Array<{ x: number; y: number }> = []
    let lane = this.page
    let px = x
    let py = y
    for (let depth = 0; depth < MAX_FRAME_DEPTH && this.hasChildren(lane); depth++) {
      const next = await this.childAt(lane, px, py, true, run)
      if (!next) break
      links.push({ parent: lane, owner: next.owner, lane: next.lane })
      points.push({ x: px, y: py })
      lane = next.lane
      px = next.x
      py = next.y
    }
    return { lane, x: px, y: py, links, points }
  }

  /** The ready child frame of `lane` under its viewport point (x, y), and the point in it. */
  private async childAt(lane: Lane, x: number, y: number, retry: boolean, run: RouteRun): Promise<{ lane: Lane; owner: number; x: number; y: number } | undefined> {
    const metrics = (await this.query('Page.getLayoutMetrics', undefined, lane, run)) as { cssLayoutViewport?: { pageX?: unknown; pageY?: unknown } } | undefined
    const scrollX = Number(metrics?.cssLayoutViewport?.pageX)
    const scrollY = Number(metrics?.cssLayoutViewport?.pageY)
    if (!Number.isFinite(scrollX) || !Number.isFinite(scrollY)) return undefined
    // Document coordinates (the viewport point plus the scroll), whole px; the boxes below are the viewport's.
    const hit = (await this.query(
      'DOM.getNodeForLocation',
      { x: Math.floor(x + scrollX), y: Math.floor(y + scrollY), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false },
      lane,
      run
    )) as { backendNodeId?: unknown } | undefined
    const owner = hit?.backendNodeId
    if (typeof owner !== 'number' || !Number.isInteger(owner)) return undefined
    const described = (await this.query('DOM.describeNode', { backendNodeId: owner }, lane, run)) as { node?: { frameId?: unknown } } | undefined
    const frameId = described?.node?.frameId
    if (typeof frameId !== 'string') return undefined
    const child = this.childOf(lane, frameId)
    if (!child) return undefined
    const box = await this.query('DOM.getBoxModel', { backendNodeId: owner }, lane, run)
    const at = pointInFrame((box as { model?: unknown } | undefined)?.model, x, y)
    if (!at) return undefined
    if (!at.inBorder) return retry ? this.childAt(lane, x, y, false, run) : undefined
    if (!at.inside) return undefined
    return { lane: child, owner, x: at.x, y: at.y }
  }

  /**
   * One read-only protocol query of a hit test on a session; undefined when refused, or when that
   * session still owes the answer to one that missed a route's deadline (asked nothing until then:
   * the hit test stops at its parent's level). Throws RouteDropped once the hit test was dropped
   * (its deadline, a detach) or its session went, so nothing after it runs.
   */
  private async query(method: string, params: Record<string, unknown> | undefined, lane: Lane, run: RouteRun): Promise<unknown> {
    if (run.cancelled || run.epoch !== this.epoch || !lane.live) throw new RouteDropped()
    if (lane.queryStalled) return undefined
    let sent: Promise<unknown>
    try {
      sent = lane.id === '' ? this.deps.send(method, params) : this.deps.send(method, params, lane.id)
    } catch {
      sent = Promise.reject(new Error('refused'))
    }
    const current = { lane, sent, answered: false, token: {} }
    run.current = current
    let value: unknown
    try {
      value = await sent
    } catch {
      value = undefined
    }
    current.answered = true
    if (run.cancelled || run.epoch !== this.epoch || !lane.live) throw new RouteDropped()
    return value
  }

  private hasChildren(lane: Lane): boolean {
    for (const f of this.frames.values()) if (f.parent === lane && f.ready) return true
    return false
  }

  /** The newest ready child of `parent` for the frame `targetId` (a frame's id is its target's). */
  private childOf(parent: Lane, targetId: string): Lane | undefined {
    let found: Lane | undefined
    for (const f of this.frames.values()) if (f.parent === parent && f.targetId === targetId && f.ready) found = f
    return found
  }

  /**
   * The pointer moved from `from` to another session without capture: each frame of the old chain
   * that is not on the new one gets a move outside its viewport, deepest first (B, then A, when the
   * pointer goes from B in A straight to the top document), and each ancestor on the new chain a
   * move over the owner it now hovers (see `hover` at the top of the file). Each is a command of its
   * own (`sendInput`), answered before the next; a session that owes an answer gets none. Stops at
   * once when the attachment changed or the page's session missed a deadline (the caller looks).
   */
  private async leave(from: Hover, to: Route, event: MouseEvent): Promise<void> {
    const epoch = this.epoch
    const modifiers = protocolModifiers(event.modifiers)
    const moveTo = async (lane: Lane, x: number, y: number): Promise<boolean> => {
      if (lane !== this.page && !this.open(lane)) return true
      const params = { type: 'mouseMoved', x, y, modifiers, button: 'none', buttons: 0, clickCount: 0, pointerType: 'mouse' }
      await this.sendInput(lane, 'Input.dispatchMouseEvent', params).outcome
      return epoch === this.epoch && !this.page.stalled
    }
    const next = new Set<Lane>([this.page, ...to.links.map((l) => l.lane)])
    const old = [this.page, ...from.links.map((l) => l.lane)]
    for (const lane of old.reverse()) if (!next.has(lane) && !(await moveTo(lane, -1, -1))) return
    for (let i = 0; i < to.links.length; i++) {
      const link = to.links[i] as Link
      const point = to.points[i] as { x: number; y: number }
      if (!(await moveTo(link.parent, point.x, point.y))) return
    }
  }

  /** The page's own session refused: logged once and dropped, never sent by another road while attached. */
  private pageRefused(): 'done' {
    this.warn('refused', "webview: the page's protocol refused input; dropped")
    return 'done'
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
        if (q && !q.answered && run.epoch === this.epoch && q.lane.live) {
          const lane = q.lane
          lane.queryStalled = q.token
          const clear = (): void => {
            if (lane.queryStalled === q.token) lane.queryStalled = undefined
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
