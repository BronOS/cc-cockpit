// page-input.ts PageInputRouter, randomized against its rules (design-web-browser.md §4.1; the
// eight rules of the scheduling contract). Each seed builds a script up front (viewer events, frame
// layout changes, hover side effects, how each session answers, frame detaches, the protocol lost
// and attached again, time passing) and plays it through the router's public API with fake sessions
// on a virtual clock. The oracle is this file's own bookkeeping of what was sent where and when,
// never the router's fields: it checks every send as it happens and the end state once everything
// was answered and released.
//
//   FUZZ_SEEDS=50000 npx vitest run test/unit/page-input.fuzz.test.ts   (a long run)
//   FUZZ_SEED=1234 ...                                                 (one seed)
//   FUZZ_CLASS=stray-release ...                                       (shrink that rule's first failure)
//
// Pointer events go to the router as Electron events built here, not through toElectronEvents (which
// rounds to whole px): each carries a tag in the fractions of its point (frames are placed at whole
// px, so a point mapped into a frame keeps them), so a press can be told apart wherever it lands.
// Keys go the way WebviewInput.accept sends them (clipboard chords dropped, edit chords as
// commands), so the clipboard rule is checked on what reaches the sessions. A detach can also land
// between two microtasks of the router's own continuations (`arm`), the detached roads answer
// asynchronously as Electron's do, and every delivery is checked against the attachment it lands in.
import { describe, it } from 'vitest'
import { MAX_QUEUED_STEPS, PageInputRouter, ROUTE_TIMEOUT_MS, STEP_TIMEOUT_MS } from '../../src/main/webview/page-input'
import {
  editCommandOfEvent,
  editKeyEvent,
  isClipboardKeyEvent,
  toElectronEvents,
  type ElectronInputEvent,
  type InputModifier,
  type WebviewInputEvent
} from '../../src/main/webview/webview-input'
import { webviewKeyInfo } from '../../src/shared/webview-keys'

// --- a seeded PRNG (mulberry32) -----------------------------------------------------------------

function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// --- the script ---------------------------------------------------------------------------------

type Button = 'left' | 'middle' | 'right'
const BUTTONS: readonly Button[] = ['left', 'right', 'middle']
const BUTTON_MOD: Readonly<Record<Button, InputModifier>> = { left: 'leftbuttondown', right: 'rightbuttondown', middle: 'middlebuttondown' }
/** How a session answers each input command. */
type Mode = 'fast' | 'slow' | 'late' | 'never' | 'reject'
/** How a session answers each hit-test query (slow: within the route's deadline, so a late input answer can land mid-hit-test). */
type QueryMode = 'fast' | 'slow' | 'late' | 'never' | 'reject'
type FrameName = 'A' | 'B' | 'C' | 'D'
type DocName = 'page' | FrameName
/** A hover side effect on a frame owner: a move over it covers it (an overlay), uncovers it, or flips. */
type Effect = 'none' | 'cover' | 'uncover' | 'flip'

type Action =
  | { a: 'move'; x: number; y: number; held: Button[] }
  | { a: 'down'; x: number; y: number; button: Button; held: Button[] }
  | { a: 'up'; x: number; y: number; button: Button; held: Button[] }
  | { a: 'wheel'; x: number; y: number; dy: number }
  /** `of`: the key as it went down, when the release spells it otherwise (Shift let go first). */
  | { a: 'key'; type: 'down' | 'up'; key: string; mods: InputModifier[]; of?: string }
  | { a: 'burst'; n: number }
  | { a: 'text' }
  | { a: 'call'; blocking: boolean; ms: number }
  | { a: 'advance'; ms: number }
  | { a: 'mode'; doc: DocName; mode: Mode }
  | { a: 'qmode'; doc: DocName; mode: QueryMode }
  | { a: 'box'; frame: FrameName; dx: number; dy: number }
  | { a: 'scroll'; doc: DocName; x: number; y: number }
  | { a: 'effect'; frame: FrameName; effect: Effect }
  | { a: 'attach'; frame: FrameName; ready: boolean }
  | { a: 'ready'; frame: FrameName }
  | { a: 'detach'; frame: FrameName; rejectPending: boolean }
  | { a: 'lose'; resetNow: boolean; rejectPending: boolean }
  | { a: 'reset' }
  | { a: 'reattach' }
  /** On the next input answer or refusal, after `after` microtasks: lose the protocol and attach again, or detach a frame. */
  | { a: 'arm'; after: number; then: 'relose' | 'detach'; frame: FrameName }

interface FrameDef {
  name: FrameName
  parent: DocName
  node: number
  /** The owner's box in the parent's document px. */
  rect: [number, number, number, number]
}

const FRAMES: readonly FrameDef[] = [
  { name: 'A', parent: 'page', node: 7, rect: [0, 200, 600, 300] },
  { name: 'B', parent: 'A', node: 8, rect: [50, 50, 200, 100] },
  { name: 'C', parent: 'page', node: 9, rect: [650, 100, 300, 300] },
  { name: 'D', parent: 'C', node: 10, rect: [10, 10, 100, 100] }
]
const FRAME_NAMES: readonly FrameName[] = ['A', 'B', 'C', 'D']
const DOCS: readonly DocName[] = ['page', 'A', 'B', 'C', 'D']
/** Keys a viewer may press: plain, named, and the letters of the clipboard and edit chords. */
const KEYS = ['a', 'b', 'q', 'c', 'v', 'x', 'z', 'A', 'Enter', 'ArrowLeft', 'Backspace', 'Insert', 'Delete', 'Tab']
const MOD_SETS: readonly InputModifier[][] = [[], [], [], ['shift'], ['control'], ['meta'], ['meta', 'shift'], ['alt']]
const ADVANCES = [1, 10, 30, 50, 199, 200, 201, 300, 499, 500, 501, 1000]
/** How long past its deadline a late session answers (some land while a later step is mid-hit-test). */
const LATE = [1, 30, 61, 120, 260, 520]

function pick<T>(r: () => number, list: readonly T[]): T {
  return list[Math.floor(r() * list.length)] as T
}

/** A point over the page, often over a frame (biased toward the owners and their edges). */
function pointOf(r: () => number): { x: number; y: number } {
  const p = r()
  if (p < 0.3) return { x: Math.floor(r() * 1000), y: Math.floor(r() * 700) }
  const f = pick(r, FRAMES)
  // In page px roughly (nested frames sit near their parent's top left).
  const base = f.parent === 'A' ? [0, 200] : f.parent === 'C' ? [650, 100] : [0, 0]
  const [x, y, w, h] = f.rect
  return { x: Math.max(0, Math.floor(base[0]! + x - 3 + r() * (w + 6))), y: Math.max(0, Math.floor(base[1]! + y - 3 + r() * (h + 6))) }
}

/** One seed's script: a viewer's events (paired presses and releases, sometimes a release lost) and the world around them. */
function makeScript(seed: number): Action[] {
  const r = prng(seed)
  const out: Action[] = []
  const held = new Set<Button>()
  const keys = new Map<string, InputModifier[]>()
  const stress = r() < 0.05
  const length = stress ? 40 : 20 + Math.floor(r() * 100)
  if (stress) out.push({ a: 'mode', doc: 'page', mode: 'never' })
  const attached = new Set<FrameName>()
  for (const f of FRAME_NAMES) {
    if (r() < 0.75 && (FRAMES.find((d) => d.name === f)!.parent === 'page' || attached.has(FRAMES.find((d) => d.name === f)!.parent as FrameName))) {
      out.push({ a: 'attach', frame: f, ready: true })
      attached.add(f)
    }
  }
  for (let i = 0; i < length; i++) {
    const p = r()
    if (p < 0.3) {
      out.push({ a: 'move', ...pointOf(r), held: [...held] })
    } else if (p < 0.38) {
      const free = BUTTONS.filter((b) => !held.has(b))
      // Now and then a press of a button already down (the viewer lost its release).
      const button = free.length > 0 && r() < 0.95 ? pick(r, free) : pick(r, BUTTONS)
      held.add(button)
      out.push({ a: 'down', ...pointOf(r), button, held: [...held] })
    } else if (p < 0.46) {
      if (held.size === 0) continue
      const button = pick(r, [...held])
      held.delete(button)
      // A release the viewer lost: the next move holds no such button (rule 8).
      if (r() < 0.12) continue
      out.push({ a: 'up', ...pointOf(r), button, held: [...held] })
    } else if (p < 0.5) {
      out.push({ a: 'wheel', ...pointOf(r), dy: Math.floor(r() * 240) - 120 })
    } else if (p < 0.6) {
      if (keys.size > 0 && r() < 0.5) {
        const [key, mods] = pick(r, [...keys])
        keys.delete(key)
        if (/^[a-z]$/i.test(key) && r() < 0.4) {
          // Shift let go (or pressed) before the key: its release spells the letter the other way.
          const other = key === key.toLowerCase() ? key.toUpperCase() : key.toLowerCase()
          const shifted: InputModifier[] = mods.includes('shift') ? mods.filter((m) => m !== 'shift') : [...mods, 'shift']
          out.push({ a: 'key', type: 'up', key: other, mods: shifted, of: key })
        } else {
          out.push({ a: 'key', type: 'up', key, mods })
        }
      } else {
        const key = pick(r, KEYS.filter((k) => !keys.has(k)))
        const mods = pick(r, MOD_SETS)
        keys.set(key, mods)
        out.push({ a: 'key', type: 'down', key, mods })
      }
    } else if (p < 0.63) {
      out.push({ a: 'text' })
    } else if (p < 0.645) {
      out.push({ a: 'call', blocking: r() < 0.7, ms: pick(r, [0, 10, 600]) })
    } else if (p < 0.75) {
      out.push({ a: 'advance', ms: pick(r, ADVANCES) })
    } else if (p < 0.81) {
      out.push({ a: 'mode', doc: pick(r, DOCS), mode: pick(r, ['fast', 'fast', 'slow', 'late', 'late', 'never', 'reject'] as const) })
    } else if (p < 0.83) {
      out.push({ a: 'qmode', doc: pick(r, DOCS), mode: pick(r, ['fast', 'fast', 'slow', 'slow', 'late', 'never', 'reject'] as const) })
    } else if (p < 0.86) {
      out.push({ a: 'box', frame: pick(r, FRAME_NAMES), dx: Math.floor(r() * 41) - 20, dy: Math.floor(r() * 41) - 20 })
    } else if (p < 0.88) {
      out.push({ a: 'scroll', doc: pick(r, DOCS), x: Math.floor(r() * 3) * 25, y: Math.floor(r() * 4) * 40 })
    } else if (p < 0.91) {
      out.push({ a: 'effect', frame: pick(r, FRAME_NAMES), effect: pick(r, ['none', 'cover', 'uncover', 'flip'] as const) })
    } else if (p < 0.94) {
      out.push({ a: 'attach', frame: pick(r, FRAME_NAMES), ready: r() < 0.8 })
    } else if (p < 0.95) {
      out.push({ a: 'ready', frame: pick(r, FRAME_NAMES) })
    } else if (p < 0.97) {
      out.push({ a: 'detach', frame: pick(r, FRAME_NAMES), rejectPending: r() < 0.5 })
    } else if (p < 0.977) {
      out.push({ a: 'lose', resetNow: r() < 0.6, rejectPending: r() < 0.5 })
    } else if (p < 0.99) {
      out.push({ a: 'arm', after: Math.floor(r() * 6), then: r() < 0.5 ? 'relose' : 'detach', frame: pick(r, FRAME_NAMES) })
    } else if (p < 0.993) {
      out.push({ a: 'reset' })
    } else {
      out.push({ a: 'reattach' })
    }
    if (stress && i === 5) out.push({ a: 'burst', n: 300 + Math.floor(r() * 400) })
  }
  return out
}

// --- the virtual clock ----------------------------------------------------------------------------

interface Task {
  at: number
  seq: number
  router: boolean
  fn: () => void
}

/** Every timer of one run, the router's and the fake sessions' answers, on one virtual clock. */
class Clock {
  now = 0
  private seq = 0
  readonly tasks = new Map<number, Task>()
  constructor(private readonly yields: () => number) {}

  set(fn: () => void, ms: number, router: boolean): number {
    const id = ++this.seq
    this.tasks.set(id, { at: this.now + Math.max(0, ms), seq: id, router, fn })
    return id
  }

  clear(id: unknown): void {
    this.tasks.delete(id as number)
  }

  routerTimers(): number {
    let n = 0
    for (const t of this.tasks.values()) if (t.router) n++
    return n
  }

  private next(limit: number): [number, Task] | undefined {
    let best: [number, Task] | undefined
    for (const entry of this.tasks) {
      const t = entry[1]
      if (t.at > limit) continue
      // The router's timers before the sessions' answers due at the same time, then by order set.
      if (!best || t.at < best[1].at || (t.at === best[1].at && (t.router !== best[1].router ? t.router : t.seq < best[1].seq))) best = entry
    }
    return best
  }

  /** Run what is due up to now + ms, in order; between two due at the same time only a few microtasks run. */
  async advance(ms: number): Promise<void> {
    const limit = this.now + ms
    await drain()
    for (;;) {
      const next = this.next(limit)
      if (!next) break
      const [id, task] = next
      this.tasks.delete(id)
      this.now = Math.max(this.now, task.at)
      task.fn()
      const after = this.next(limit)
      if (after && after[1].at === task.at) {
        // Same tick: a seeded few microtasks only (a wake landing while the pump is mid-step).
        for (let i = this.yields(); i > 0; i--) await Promise.resolve()
      } else {
        await drain()
      }
    }
    this.now = limit
    await drain()
  }
}

/** Every pending microtask, chained ones included (Node runs them all before the next macrotask). */
function drain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

// --- one run --------------------------------------------------------------------------------------

interface Violation {
  id: string
  detail: string
}

interface Command {
  session: string
  gen: number
  sentAt: number
  answered: boolean
  method: string
  params: Record<string, unknown>
  /** Sent while the harness had the protocol detached (refused at once, counted for nothing). */
  detached: boolean
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  /** The key log entry this command made (removed if it is refused). */
  logged?: { entry: string }
}

interface Session {
  id: string
  doc: DocName
  gen: number
  /** The router was told it went (frameDetached, or reset for every session of that attachment). */
  ended: boolean
  ready: boolean
}

const TAG_SCALE = 1024

function tagOf(x: number, y: number): number {
  const fx = Math.round((((x % 1) + 1) % 1) * TAG_SCALE) % TAG_SCALE
  const fy = Math.round((((y % 1) + 1) % 1) * TAG_SCALE) % TAG_SCALE
  return fx + fy * TAG_SCALE
}

function keyEntry(type: string, code: unknown): string {
  return `k:${type}:${String(code)}`
}

/** A clipboard chord's shape on the protocol: Ctrl/Cmd with C, X or V; Insert with Shift or Ctrl; Shift+Delete. */
function isClipboardShape(params: Record<string, unknown>): boolean {
  const mods = Number(params.modifiers ?? 0)
  const ctrlOrMeta = (mods & 2) !== 0 || (mods & 4) !== 0
  const shift = (mods & 8) !== 0
  const code = params.code
  if (ctrlOrMeta && (code === 'KeyC' || code === 'KeyX' || code === 'KeyV')) return true
  if (code === 'Insert' && (shift || (mods & 2) !== 0)) return true
  return code === 'Delete' && shift && mods === 8
}

interface RunResult {
  violations: Violation[]
  trace: string[]
}

async function runScript(seed: number, script: readonly Action[], withTrace = false): Promise<RunResult> {
  const violations: Violation[] = []
  const trace: string[] = []
  const violate = (id: string, detail: string): void => {
    if (violations.length < 20) violations.push({ id, detail: `${id}: ${detail} (t=${clock.now})` })
  }
  const yieldRng = prng(seed ^ 0x9e3779b9)
  const clock = new Clock(() => Math.floor(yieldRng() * 9))

  // The world: each document's scroll, each owner's box and cover, each frame's session.
  const scroll = new Map<DocName, { x: number; y: number }>(DOCS.map((d) => [d, { x: 0, y: 0 }]))
  const rects = new Map<FrameName, [number, number, number, number]>(FRAMES.map((f) => [f.name, [...f.rect] as [number, number, number, number]]))
  const effects = new Map<FrameName, Effect>(FRAME_NAMES.map((f) => [f, 'none']))
  const covered = new Set<FrameName>()
  const modes = new Map<DocName, Mode>(DOCS.map((d) => [d, 'fast']))
  const qmodes = new Map<DocName, QueryMode>(DOCS.map((d) => [d, 'fast']))
  const sessionOf = new Map<DocName, Session>()
  const sessions = new Map<string, Session>()
  let gen = 0
  let attached = true
  let resetPending = false
  let sessionSeq = 0
  const newPage = (): void => {
    const s: Session = { id: '', doc: 'page', gen, ended: false, ready: true }
    sessionOf.set('page', s)
  }
  newPage()

  // The oracle's own records.
  const commands: Command[] = []
  /** Open presses: session id → button → the press's tag. */
  const open = new Map<Session, Map<string, number>>()
  const pressTags = new Map<number, number>()
  const clientPressTags = new Set<number>()
  const lostPresses = new Set<number>()
  /** Viewer presses refused by a session that went or by an older attachment: never to be delivered again. */
  const noReplay = new Set<number>()
  /** Texts and commands a session refused: never to be delivered again (by any road). */
  const refusedEntries = new Set<string>()
  let refusedCount = 0
  /** The attachment in which the page's own session last refused a command (a mouse fallback's only reason while attached). */
  let pageRefusedGen = -1
  /** Documents whose frame owners a hover move changed, not hit-tested since (rule 3). */
  const dirty = new Set<DocName>()
  /** Wheel deltas (the DOM's sign): handed in, and delivered. */
  let wheelIn = 0
  let wheelOut = 0
  /** The last pointer event's tag delivered (presses, moves, wheels keep their order). */
  let lastPointerTag = 0
  /** Key downs (by code) and key ups delivered, for rule 6. */
  const keyDowns = new Map<string, number>()
  const keyUps = new Map<string, number>()
  let lostHappened = false
  let peakQueue = 0
  let armed: Extract<Action, { a: 'arm' }> | undefined
  /**
   * The pointer event a live frame just refused, until the router sends anything again: if the frame
   * goes in between (before the router's continuation runs), the router replays nothing (rule 7), so
   * that event is lost with the frame, never to be delivered.
   */
  let justRefused: { session: Session; wheel: number; press?: number } | undefined
  const delivered: string[] = []
  const expected: string[] = []
  let dropsPossible = false
  const pageCommands = (): Command[] => commands.filter((c) => c.session === '' && c.gen === gen && !c.detached && !c.answered)
  const pageStalled = (): boolean => attached && pageCommands().some((c) => clock.now - c.sentAt >= STEP_TIMEOUT_MS)

  const docOfSession = (id: string): Session | undefined => (id === '' ? sessionOf.get('page') : sessions.get(id))

  const applyEffects = (doc: DocName, x: number, y: number): void => {
    const s = scroll.get(doc) as { x: number; y: number }
    for (const f of FRAMES) {
      if (f.parent !== doc) continue
      const [rx, ry, rw, rh] = rects.get(f.name) as [number, number, number, number]
      const dx = x + s.x
      const dy = y + s.y
      if (dx < rx || dx >= rx + rw || dy < ry || dy >= ry + rh) continue
      const e = effects.get(f.name)
      if (e !== 'none') dirty.add(doc)
      if (e === 'cover') covered.add(f.name)
      else if (e === 'uncover') covered.delete(f.name)
      else if (e === 'flip') {
        if (covered.has(f.name)) covered.delete(f.name)
        else covered.add(f.name)
      }
    }
  }

  const answerQuery = (doc: DocName, method: string, p: Record<string, unknown>): unknown => {
    const s = scroll.get(doc) as { x: number; y: number }
    const owners = FRAMES.filter((f) => f.parent === doc)
    if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { pageX: s.x, pageY: s.y } }
    if (method === 'DOM.getNodeForLocation') {
      const x = p.x as number
      const y = p.y as number
      for (const f of owners) {
        const [rx, ry, rw, rh] = rects.get(f.name) as [number, number, number, number]
        if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) return { backendNodeId: covered.has(f.name) ? 1 : f.node }
      }
      return { backendNodeId: 1 }
    }
    if (method === 'DOM.describeNode') {
      const f = owners.find((o) => o.node === p.backendNodeId)
      const target = f ? sessionOf.get(f.name) : undefined
      return { node: f ? { nodeName: 'IFRAME', frameId: target ? `T-${target.id}` : `T-none-${f.name}` } : { nodeName: 'BODY' } }
    }
    if (method === 'DOM.getBoxModel') {
      const f = owners.find((o) => o.node === p.backendNodeId)
      if (!f) throw new Error('Could not compute box model.')
      const [rx, ry, rw, rh] = rects.get(f.name) as [number, number, number, number]
      const x = rx - s.x
      const y = ry - s.y
      const quad = [x, y, x + rw, y, x + rw, y + rh, x, y + rh]
      return { model: { content: quad, border: quad, width: rw, height: rh } }
    }
    return {}
  }

  const send = (method: string, params: Record<string, unknown> | undefined, sessionId?: string): Promise<unknown> => {
    const id = sessionId ?? ''
    const p = params ?? {}
    if (sessionId === '') violate('empty-session-id', method)
    const session = docOfSession(id)
    if (withTrace) trace.push(`  t=${clock.now} send ${id || 'page'} ${method} ${JSON.stringify(p)}`)
    // The router went on from the refusal (to the page, attached or not): the frame going now changes nothing.
    justRefused = undefined
    if (!attached) {
      // Refused at once, as Electron's debugger does when detached; nothing to check.
      const c: Command = { session: id, gen, sentAt: clock.now, answered: false, method, params: p, detached: true, resolve: () => {}, reject: () => {} }
      if (method.startsWith('Input.')) commands.push(c)
      return new Promise((_resolve, reject) => {
        clock.set(() => {
          c.answered = true
          reject(new Error('Debugger is not attached'))
        }, 0, false)
      })
    }
    if (!session) violate('unknown-session', `${method} to ${id}`)
    else if (session.ended) violate('ended-session', `${method} to ${id} (gen ${session.gen}, now ${gen})`)
    if (pageStalled()) violate('page-stalled-send', `${method} to ${id || 'page'} while the page owes an answer past its deadline`)
    const doc = session?.doc ?? 'page'
    if (!method.startsWith('Input.')) {
      if (method === 'DOM.getNodeForLocation') dirty.delete(doc)
      const mode = qmodes.get(doc) as QueryMode
      return new Promise((resolve, reject) => {
        if (mode === 'never') return
        clock.set(
          () => {
            if (mode === 'reject') return reject(new Error('No session with given id'))
            try {
              resolve(answerQuery(doc, method, p))
            } catch (err) {
              reject(err)
            }
          },
          mode === 'late' ? ROUTE_TIMEOUT_MS + 1 : mode === 'slow' ? 30 : 0,
          false
        )
      })
    }
    // Rules 2 and 4: nothing to a session that owes an answer; one on its way per page, stalled ones aside.
    const live = commands.filter((c) => !c.answered && !c.detached && c.gen === gen && !(docOfSession(c.session)?.ended ?? true) && docOfSession(c.session)?.gen === gen)
    if (live.some((c) => c.session === id)) violate('session-busy', `${method} ${String(p.type ?? '')} to ${id || 'page'}, which owes an answer`)
    const inFlight = live.filter((c) => clock.now - c.sentAt < STEP_TIMEOUT_MS)
    if (inFlight.length > 0) violate('two-in-flight', `${method} ${String(p.type ?? '')} to ${id || 'page'} while ${inFlight[0]!.session || 'page'} ${String(inFlight[0]!.params.type ?? '')} is on its way`)
    if (method === 'Input.dispatchKeyEvent' && isClipboardShape(p)) violate('clipboard', JSON.stringify(p))
    if (method === 'Input.dispatchMouseEvent' && p.type !== 'mouseReleased' && (p.x as number) >= 0) {
      const tag = tagOf(p.x as number, p.y as number)
      // Rule 5: presses, moves and wheels never reorder (moves coalesce to the latest).
      if (tag < lastPointerTag) violate('pointer-order', `${String(p.type)} tag ${tag} after tag ${lastPointerTag}`)
      lastPointerTag = Math.max(lastPointerTag, tag)
      if (p.type === 'mousePressed' && noReplay.has(tag)) violate('dead-replay', `the press tag ${tag}, refused by a session that went or an older attachment, sent again to ${id || 'page'}`)
      // Rule 3: a press or wheel into a frame is hit-tested after the last hover move that changed a
      // document on its way (not under capture, which follows the press).
      if ((p.type === 'mousePressed' || p.type === 'mouseWheel') && session && session.doc !== 'page' && !capturing()) {
        for (let d = parentDoc(session.doc); d; d = d === 'page' ? undefined : parentDoc(d)) {
          if (dirty.has(d)) violate('stale-route', `${String(p.type)} to ${id} routed through ${d}, changed by a hover move since its hit test`)
        }
      }
    }
    if (method === 'Input.dispatchMouseEvent' && p.type === 'mouseWheel') wheelOut += p.deltaY as number
    const c: Command = { session: id, gen, sentAt: clock.now, answered: false, method, params: p, detached: false, resolve: () => {}, reject: () => {} }
    commands.push(c)
    if (session) {
      // Rule 8 at each session: presses and releases of a button alternate, starting with a press.
      if (method === 'Input.dispatchMouseEvent' && (p.type === 'mousePressed' || p.type === 'mouseReleased')) {
        const byButton = open.get(session) ?? new Map<string, number>()
        open.set(session, byButton)
        const button = String(p.button)
        if (p.type === 'mousePressed') {
          if (byButton.has(button)) violate('double-press', `${button} pressed again at ${id || 'page'} with no release between`)
          const tag = tagOf(p.x as number, p.y as number)
          if (!clientPressTags.has(tag)) violate('press-from-nowhere', `${button} press at ${id || 'page'} matches no viewer press (tag ${tag})`)
          pressTags.set(tag, (pressTags.get(tag) ?? 0) + 1)
          if ((pressTags.get(tag) ?? 0) > 1) violate('press-twice', `the viewer press tag ${tag} delivered twice`)
          byButton.set(button, tag)
        } else {
          if (!byButton.has(button)) violate('stray-release', `${button} released at ${id || 'page'}, which has no open ${button} press`)
          byButton.delete(button)
        }
      }
      if (method === 'Input.dispatchMouseEvent' && p.type === 'mouseMoved' && (p.x as number) >= 0) applyEffects(session.doc, p.x as number, p.y as number)
    }
    if (id === '' && method === 'Input.dispatchKeyEvent') {
      c.logged = { entry: p.__tag !== undefined ? `c:${String(p.__tag)}` : keyEntry(String(p.type), p.code) }
      if (refusedEntries.has(c.logged.entry)) violate('refused-replayed', `${c.logged.entry} delivered again after a refusal`)
      delivered.push(c.logged.entry)
      countKey(p.type === 'keyUp' ? keyUps : p.type === 'rawKeyDown' ? keyDowns : undefined, p.code)
    } else if (id === '' && method === 'Input.insertText') {
      c.logged = { entry: `t:${String(p.text)}` }
      if (refusedEntries.has(c.logged.entry)) violate('refused-replayed', `${c.logged.entry} delivered again after a refusal`)
      delivered.push(c.logged.entry)
    } else if (method !== 'Input.dispatchMouseEvent') {
      violate('key-to-frame', `${method} to ${id}`)
    }
    const mode = modes.get(doc) as Mode
    return new Promise((resolve, reject) => {
      const settle = (ok: boolean): void => {
        if (c.answered) return
        c.answered = true
        if (withTrace) trace.push(`  t=${clock.now} ${ok ? 'answer' : 'refuse'} ${id || 'page'} ${String(p.type ?? method)}`)
        fireArmed()
        if (ok) return resolve({})
        if (session?.doc === 'page' && !c.detached) pageRefusedGen = c.gen
        // A wheel refused past its deadline or by a session that went is lost with it (the router had moved on).
        const lostWith = clock.now - c.sentAt >= STEP_TIMEOUT_MS || (session?.ended ?? false) || c.gen !== gen
        if (method === 'Input.dispatchMouseEvent' && p.type === 'mouseWheel' && !lostWith) wheelOut -= p.deltaY as number
        if (method === 'Input.dispatchMouseEvent' && session && session.doc !== 'page' && !lostWith) {
          justRefused = { session, wheel: p.type === 'mouseWheel' ? (p.deltaY as number) : 0, press: p.type === 'mousePressed' ? tagOf(p.x as number, p.y as number) : undefined }
        }
        // Refused: it never happened there. The oracle forgets what it recorded for it. A frame's
        // refusal means it went, so its open presses are excused; the page's own session refusing
        // sends by sendInputEvent instead, to the same page, so a press there stays open until its
        // release (by either road).
        if (c.logged) {
          const at = delivered.lastIndexOf(c.logged.entry)
          if (at >= 0) delivered.splice(at, 1)
          // A refused text, command or key is dropped, never replayed by another road (decision of
          // review 5): it no longer counts as handed in.
          refusedCount++
          if (!c.logged.entry.startsWith('k:')) refusedEntries.add(c.logged.entry)
          // A refused key down never went down; a refused key up is excused (the session refusing
          // it is the end of what the router can do: it never sends one by another road).
          countKey(p.type === 'rawKeyDown' ? keyDowns : undefined, p.code, -1)
        }
        if (session && method === 'Input.dispatchMouseEvent') {
          if (p.type === 'mousePressed') {
            const tag = tagOf(p.x as number, p.y as number)
            pressTags.set(tag, (pressTags.get(tag) ?? 1) - 1)
            open.get(session)?.delete(String(p.button))
            // Refused past its deadline, or by a session that went: the router had moved on (a late
            // continuation replays nothing), so that press is lost with its session.
            if (clock.now - c.sentAt >= STEP_TIMEOUT_MS || session.ended) lostPresses.add(tag)
            // A refusal from a session that went, or from an older attachment, replays nothing (rule 7).
            if (session.ended || c.gen !== gen) noReplay.add(tag)
          }
          if (session.doc !== 'page') open.delete(session)
        }
        reject(new Error('No session with given id'))
      }
      c.resolve = () => settle(true)
      c.reject = () => settle(false)
      if (mode === 'never') return
      const delay = mode === 'slow' ? 300 : mode === 'late' ? STEP_TIMEOUT_MS + LATE[commands.length % LATE.length]! : 0
      clock.set(() => settle(mode !== 'reject'), delay, false)
    })
  }

  const fallback: ElectronInputEvent[] = []
  // A router that spins (a step that never ends and never waits) would hang the run: counted, then stopped.
  let turns = 0
  const router = new PageInputRouter({
    send,
    attached: () => {
      if (++turns > 200_000) {
        violate('spin', 'the router ran 200000 turns in one run without waiting')
        throw new Error('spin')
      }
      return attached
    },
    fallback: (event) => {
      if (withTrace) trace.push(`  t=${clock.now} fallback ${JSON.stringify(event)}`)
      fallback.push(event)
      // While attached, sendInputEvent is a mouse event's road only after the page's own session
      // refused one in this attachment; a key never (a refused key is dropped).
      if (attached && (event.type === 'keyDown' || event.type === 'keyUp' || event.type === 'char')) violate('fallback-while-attached', `key ${JSON.stringify(event)} by sendInputEvent while attached`)
      else if (attached && pageRefusedGen !== gen) violate('fallback-old-epoch', `${event.type} by sendInputEvent while attached, with no refusal in this attachment`)
      if (event.type === 'mouseWheel') wheelOut -= event.deltaY
      if (event.type === 'mouseDown' && noReplay.has(tagOf(event.x, event.y))) violate('dead-replay', `the press tag ${tagOf(event.x, event.y)} sent again by sendInputEvent`)
      if (event.type === 'keyDown' || event.type === 'keyUp' || event.type === 'char') {
        const info = webviewKeyInfo(event.keyCode)
        delivered.push(keyEntry(event.type === 'keyDown' ? 'rawKeyDown' : event.type, info?.code))
        countKey(event.type === 'keyUp' ? keyUps : event.type === 'keyDown' ? keyDowns : undefined, info?.code)
        if (info && isClipboardShape({ code: info.code, modifiers: modBits(event.modifiers) })) violate('clipboard', `fallback ${JSON.stringify(event)}`)
      }
      if (event.type === 'mouseDown') {
        const tag = tagOf(event.x, event.y)
        pressTags.set(tag, (pressTags.get(tag) ?? 0) + 1)
        if ((pressTags.get(tag) ?? 0) > 1) violate('press-twice', `the viewer press tag ${tag} delivered twice (fallback)`)
      }
    },
    // The router's own logs: a step that threw, or a command its sender held back, drops input
    // silently; either is a broken rule here.
    log: (message) => {
      if (/input step failed|held back/.test(message)) violate('router-log', message)
    },
    timers: {
      set: (fn, ms) => clock.set(fn, ms, true),
      clear: (h) => clock.clear(h)
    }
  })

  function countKey(map: Map<string, number> | undefined, code: unknown, by = 1): void {
    if (map && typeof code === 'string') map.set(code, (map.get(code) ?? 0) + by)
  }
  function parentDoc(doc: DocName): DocName | undefined {
    return FRAMES.find((f) => f.name === doc)?.parent
  }
  /** Whether a press is open at a live session of this attachment (the router's capture). */
  function capturing(): boolean {
    for (const [session, byButton] of open) if (!session.ended && session.gen === gen && byButton.size > 0) return true
    return false
  }
  /** A detached road as Electron's: it lands a little later (an IPC), so a router that does not wait for it reorders. */
  const detachedRoad = (entry: string, n: number) => (): Promise<void> => {
    if (attached) violate('detached-road-while-attached', `${entry} by its detached road while attached`)
    if (refusedEntries.has(entry)) violate('refused-replayed', `${entry} by its detached road after a refusal`)
    return new Promise((resolve) =>
      clock.set(
        () => {
          delivered.push(entry)
          resolve()
        },
        [0, 5, 40][n % 3] as number,
        false
      )
    )
  }
  /** The armed detach, after a few microtasks of the answer that fired it (between the router's continuations). */
  function fireArmed(): void {
    const a = armed
    if (!a) return
    armed = undefined
    let left = a.after
    const tick = (): void => {
      if (left-- > 0) return queueMicrotask(tick)
      if (withTrace) trace.push(`  t=${clock.now} armed ${a.then}${a.then === 'detach' ? ` ${a.frame}` : ''}`)
      if (a.then === 'detach') detachFrame(a.frame, false)
      else if (attached) {
        lose(true, false)
        reattach()
      }
    }
    queueMicrotask(tick)
  }

  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)

  let mouseSeq = 0
  let textSeq = 0
  let commandSeq = 0
  let callSeq = 0
  const nextTag = (): { fx: number; fy: number; tag: number } => {
    mouseSeq++
    const fx = mouseSeq % TAG_SCALE
    const fy = Math.floor(mouseSeq / TAG_SCALE) % TAG_SCALE
    return { fx: fx / TAG_SCALE, fy: fy / TAG_SCALE, tag: fx + fy * TAG_SCALE }
  }
  const mods = (held: readonly Button[]): InputModifier[] => held.map((b) => BUTTON_MOD[b])

  /** A viewer key event the way WebviewInput.accept hands it on. */
  const viewerKey = (event: WebviewInputEvent): void => {
    if (isClipboardKeyEvent(event)) return
    const command = editCommandOfEvent(event)
    if (command && event.kind === 'key') {
      const params = { ...editKeyEvent({ type: 'editCommand', command, key: event.key, modifiers: event.modifiers }), __tag: ++commandSeq }
      expected.push(`c:${commandSeq}`)
      const tag = commandSeq
      router.command('Input.dispatchKeyEvent', params, detachedRoad(`c:${tag}`, tag)).then(
        () => {},
        () => {}
      )
      return
    }
    const events = toElectronEvents(event, { width: 1000, height: 700 })
    for (const e of events) {
      if (e.type === 'keyDown' || e.type === 'keyUp' || e.type === 'char') expected.push(keyEntry(e.type === 'keyDown' ? 'rawKeyDown' : e.type, webviewKeyInfo(e.keyCode)?.code))
    }
    if (events.length > 0) router.input(events)
  }

  const attachFrame = (name: FrameName, ready: boolean): void => {
    const def = FRAMES.find((f) => f.name === name) as FrameDef
    const parent = sessionOf.get(def.parent)
    if (!attached || resetPending || !parent || parent.ended || sessionOf.get(name)) return
    const s: Session = { id: `S:${name}#${++sessionSeq}`, doc: name, gen, ended: false, ready }
    sessions.set(s.id, s)
    sessionOf.set(name, s)
    router.frameAttached(s.id, `T-${s.id}`, parent.id, 'iframe')
    if (ready) router.frameReady(s.id)
  }

  const endSession = (s: Session, rejectPending: boolean): void => {
    s.ended = true
    if (justRefused?.session === s) {
      wheelOut += justRefused.wheel
      if (justRefused.press !== undefined) {
        lostPresses.add(justRefused.press)
        noReplay.add(justRefused.press)
      }
      justRefused = undefined
    }
    if (sessionOf.get(s.doc) === s) sessionOf.delete(s.doc)
    if (rejectPending) for (const c of commands) if (c.session === s.id && !c.answered) c.reject(new Error('gone'))
  }

  const detachFrame = (name: FrameName, rejectPending: boolean): void => {
    const s = sessionOf.get(name)
    if (!s || s.doc === 'page') return
    // The frame and every frame under it.
    const gone: Session[] = [s]
    for (let i = 0; i < gone.length; i++) {
      for (const f of FRAMES) {
        const child = sessionOf.get(f.name)
        if (f.parent === gone[i]!.doc && child && child.doc !== 'page') gone.push(child)
      }
    }
    router.frameDetached(s.id)
    for (const g of gone) endSession(g, rejectPending)
  }

  const doReset = (rejectPending: boolean): void => {
    resetPending = false
    for (const s of [...sessionOf.values()]) endSession(s, rejectPending)
    gen++
    router.reset()
  }

  const lose = (resetNow: boolean, rejectPending: boolean): void => {
    if (!attached) return
    attached = false
    dropsPossible = true
    lostHappened = true
    // Every session of this attachment refuses from now on (Electron's debugger).
    for (const c of commands) if (!c.answered && rejectPending) c.reject(new Error('Debugger is not attached'))
    if (resetNow) doReset(false)
    else resetPending = true
  }

  const reattach = (): void => {
    if (attached) return
    if (resetPending) doReset(false)
    attached = true
    newPage()
    for (const f of FRAME_NAMES) attachFrame(f, true)
  }

  const play = async (action: Action): Promise<void> => {
    if (withTrace) trace.push(`t=${clock.now} ${JSON.stringify(action)}`)
    switch (action.a) {
      case 'move': {
        const t = nextTag()
        router.input([{ type: 'mouseMove', x: action.x + t.fx, y: action.y + t.fy, modifiers: mods(action.held) }])
        break
      }
      case 'down':
      case 'up': {
        const t = nextTag()
        if (action.a === 'down') clientPressTags.add(t.tag)
        router.input([{ type: action.a === 'down' ? 'mouseDown' : 'mouseUp', x: action.x + t.fx, y: action.y + t.fy, button: action.button, clickCount: 1, modifiers: mods(action.held) }])
        break
      }
      case 'wheel': {
        const t = nextTag()
        wheelIn += action.dy
        router.input([{ type: 'mouseWheel', x: action.x + t.fx, y: action.y + t.fy, deltaX: 0, deltaY: -action.dy, modifiers: [] }])
        break
      }
      case 'key':
        viewerKey({ kind: 'key', type: action.type, key: action.key, modifiers: action.mods })
        break
      case 'burst':
        dropsPossible = true
        for (let i = 0; i < action.n; i++) {
          // A key no other action presses, so a burst never presses a held key again.
          viewerKey({ kind: 'key', type: 'down', key: 'w', modifiers: [] })
          viewerKey({ kind: 'key', type: 'up', key: 'w', modifiers: [] })
        }
        break
      case 'text': {
        const text = `t${++textSeq}`
        expected.push(`t:${text}`)
        router.command('Input.insertText', { text }, detachedRoad(`t:${text}`, textSeq)).then(
          () => {},
          () => {}
        )
        break
      }
      case 'call': {
        const n = ++callSeq
        router
          .call(() => {
            if (withTrace) trace.push(`  t=${clock.now} call ${n}`)
            return new Promise((resolve) => clock.set(() => resolve(n), action.ms, false))
          }, action.blocking)
          .then(
            () => {},
            () => {}
          )
        break
      }
      case 'advance':
        await clock.advance(action.ms)
        return
      case 'mode':
        modes.set(action.doc, action.mode)
        break
      case 'qmode':
        qmodes.set(action.doc, action.mode)
        break
      case 'box': {
        const r = rects.get(action.frame) as [number, number, number, number]
        rects.set(action.frame, [Math.max(0, r[0] + action.dx), Math.max(0, r[1] + action.dy), r[2], r[3]])
        break
      }
      case 'scroll':
        scroll.set(action.doc, { x: action.x, y: action.y })
        break
      case 'effect':
        effects.set(action.frame, action.effect)
        break
      case 'attach':
        attachFrame(action.frame, action.ready)
        break
      case 'ready': {
        const s = sessionOf.get(action.frame)
        if (s && !s.ready && !s.ended) {
          s.ready = true
          router.frameReady(s.id)
        }
        break
      }
      case 'detach':
        detachFrame(action.frame, action.rejectPending)
        break
      case 'lose':
        lose(action.resetNow, action.rejectPending)
        break
      case 'reset':
        if (resetPending) doReset(false)
        break
      case 'reattach':
        reattach()
        break
      case 'arm':
        armed = action
        break
    }
    await clock.advance(0)
    // Rule 5: the queue's cap, a few matched releases past it at most.
    for (const [, size] of collectionSizes(router)) peakQueue = Math.max(peakQueue, size)
  }

  try {
    for (const action of script) await play(action)
    // Heal: every session answers from now on, every unanswered command is answered, the protocol
    // comes back; then the viewer lets go of everything and moves once with no button held.
    if (!attached) reattach()
    for (const d of DOCS) {
      modes.set(d, 'fast')
      qmodes.set(d, 'fast')
    }
    for (const c of commands) if (!c.answered) c.resolve({})
    await clock.advance(0)
    for (let i = 0; i < 4; i++) await clock.advance(1000)
    const heldButtons = new Set<Button>()
    const heldKeys = new Map<string, InputModifier[]>()
    for (const action of script) {
      if (action.a === 'down') heldButtons.add(action.button)
      if (action.a === 'up') heldButtons.delete(action.button)
      if (action.a === 'move') for (const b of BUTTONS) if (!action.held.includes(b)) heldButtons.delete(b)
      if (action.a === 'key' && action.type === 'down') heldKeys.set(action.key, action.mods)
      if (action.a === 'key' && action.type === 'up') heldKeys.delete(action.of ?? action.key)
    }
    const remaining = new Set(heldButtons)
    for (const b of heldButtons) {
      remaining.delete(b)
      await play({ a: 'up', x: 300, y: 300, button: b, held: [...remaining] })
    }
    for (const [key, m] of heldKeys) await play({ a: 'key', type: 'up', key, mods: m })
    await play({ a: 'move', x: 500, y: 650, held: [] })
    for (let i = 0; i < 6; i++) await clock.advance(1000)

    // Quiescence.
    if (clock.routerTimers() > 0) violate('timers-left', `${clock.routerTimers()} router timers pending`)
    const unanswered = commands.filter((c) => !c.answered && c.gen === gen && !c.detached && !(docOfSession(c.session)?.ended ?? true))
    if (unanswered.length > 0) violate('unanswered', `${unanswered.length} commands still unanswered`)
    for (const [session, byButton] of open) {
      if (session.ended || session.gen !== gen) continue
      if (byButton.size > 0) violate('unreleased', `${[...byButton.keys()].join(',')} still pressed at ${session.id || 'page'}`)
    }
    // Keys, texts, commands and calls in the order they were handed in: a subsequence always (a
    // detach drops the one on its way, a full queue drops), the same list when nothing could drop.
    let at = 0
    for (const entry of delivered) {
      while (at < expected.length && expected[at] !== entry) at++
      if (at === expected.length) {
        violate('key-order', `${entry} out of order or not handed in (delivered ${delivered.length}, expected ${expected.length})`)
        break
      }
      at++
    }
    if (!dropsPossible && delivered.length !== expected.length - refusedCount) violate('key-lost', `delivered ${delivered.length} of ${expected.length} (${refusedCount} refused): ${firstDiff(delivered, expected)}`)
    if (!dropsPossible && Math.abs(wheelOut - wheelIn) > 1e-9) violate('wheel-lost', `wheel deltas handed in ${wheelIn}, delivered ${wheelOut}`)
    if (peakQueue > MAX_QUEUED_STEPS + 32) violate('queue-over-cap', `the router held ${peakQueue} steps (cap ${MAX_QUEUED_STEPS})`)
    // Rule 6: every key down delivered got its key up, the release matched by the physical key
    // whatever its spelling (Shift let go first), past the queue's cap too.
    if (!lostHappened) {
      for (const [code, n] of keyDowns) if ((keyUps.get(code) ?? 0) < n) violate('key-stuck', `${code} went down ${n} times, up ${keyUps.get(code) ?? 0}`)
    }
    // Presses too: with nothing that could drop one (a detach, a full queue), every viewer press
    // reached the page once (a session that took it, or sendInputEvent).
    if (!dropsPossible) {
      for (const tag of clientPressTags) if ((pressTags.get(tag) ?? 0) < 1 && !lostPresses.has(tag)) violate('press-lost', `the viewer press tag ${tag} reached no session`)
    }
    const live = new Set([...sessions.values()].filter((s) => !s.ended).map((s) => s.id))
    for (const ref of sessionRefs(router)) if (!live.has(ref)) violate('dead-session-held', `the router still holds ${ref}`)
    const sizes = collectionSizes(router)
    for (const [name, size] of sizes) if (size > live.size + 16) violate('unbounded', `${name} holds ${size} with ${live.size} live frames`)
    if (unhandled.length > 0) violate('unhandled-rejection', String(unhandled[0]))
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  return { violations, trace }
}

function modBits(m: readonly InputModifier[]): number {
  let bits = 0
  if (m.includes('alt')) bits |= 1
  if (m.includes('control')) bits |= 2
  if (m.includes('meta')) bits |= 4
  if (m.includes('shift')) bits |= 8
  return bits
}

function firstDiff(a: readonly string[], b: readonly string[]): string {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return `at ${i}: ${a[i]} vs ${b[i]}`
  return 'same'
}

/** Every harness session id (`S:...`) reachable from the router's own fields, a few levels deep. */
function sessionRefs(router: object): Set<string> {
  const found = new Set<string>()
  const seen = new Set<unknown>()
  const walk = (v: unknown, depth: number): void => {
    if (depth > 5 || v === null || v === undefined) return
    if (typeof v === 'string') {
      if (v.startsWith('S:')) found.add(v)
      return
    }
    if (typeof v !== 'object' || seen.has(v)) return
    seen.add(v)
    if (v instanceof Map) {
      for (const [k, x] of v) {
        walk(k, depth + 1)
        walk(x, depth + 1)
      }
    } else if (v instanceof Set || Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1)
    } else if (!(v instanceof Promise)) {
      for (const x of Object.values(v)) walk(x, depth + 1)
    }
  }
  for (const [k, v] of Object.entries(router)) if (k !== 'deps' && k !== 'timers') walk(v, 0)
  return found
}

function collectionSizes(router: object): Array<[string, number]> {
  const out: Array<[string, number]> = []
  for (const [k, v] of Object.entries(router)) {
    if (v instanceof Map || v instanceof Set) out.push([k, v.size])
    else if (Array.isArray(v)) out.push([k, v.length])
  }
  return out
}

/** The shortest script (by removing chunks, then single actions) that still breaks the same rule. */
async function shrink(seed: number, script: Action[], id: string): Promise<Action[]> {
  let current = script
  let runs = 0
  for (let chunk = Math.ceil(current.length / 2); chunk >= 1 && runs < 3000; chunk = chunk === 1 ? 0 : Math.ceil(chunk / 2)) {
    for (let i = 0; i < current.length && runs < 3000; ) {
      const candidate = [...current.slice(0, i), ...current.slice(i + chunk)]
      runs++
      const { violations } = await runScript(seed, candidate)
      if (violations.some((v) => v.id === id)) current = candidate
      else i += chunk
    }
  }
  return current
}

const SEEDS = Number(process.env.FUZZ_SEEDS ?? 2000)
const ONE_SEED = process.env.FUZZ_SEED === undefined ? undefined : Number(process.env.FUZZ_SEED)

describe('PageInputRouter, randomized against its rules', () => {
  it(
    `${ONE_SEED ?? SEEDS} ${ONE_SEED === undefined ? 'seeds' : '(one seed)'}: every send and the end state keep the rules`,
    async () => {
      const seeds = ONE_SEED === undefined ? Array.from({ length: SEEDS }, (_, i) => i + 1) : [ONE_SEED]
      const failures = new Map<string, { seed: number; detail: string; count: number }>()
      for (const seed of seeds) {
        const script = makeScript(seed)
        const { violations } = await runScript(seed, script)
        for (const v of violations) {
          const f = failures.get(v.id)
          if (f) f.count++
          else failures.set(v.id, { seed, detail: v.detail, count: 1 })
        }
      }
      if (failures.size > 0) {
        const lines: string[] = []
        for (const [id, f] of failures) {
          lines.push(`${id}: ${f.count} seeds, first seed ${f.seed}: ${f.detail}`)
        }
        // The first failing class's smallest script and its trace.
        const chosen = process.env.FUZZ_CLASS !== undefined ? [...failures].find(([k]) => k === process.env.FUZZ_CLASS) : undefined
        const [id, first] = (chosen ?? [...failures][0]) as [string, { seed: number }]
        const small = await shrink(first.seed, makeScript(first.seed), id)
        const { violations, trace } = await runScript(first.seed, small, true)
        lines.push('', `minimal script for ${id} (seed ${first.seed}, ${small.length} actions):`, ...small.map((a) => `  ${JSON.stringify(a)}`))
        lines.push('', 'its trace (sends, answers, fallbacks):', ...trace.slice(-120), '', ...violations.map((v) => v.detail))
        throw new Error(lines.join('\n'))
      }
    },
    Math.max(60_000, (ONE_SEED === undefined ? SEEDS : 1) * 30)
  )
})
