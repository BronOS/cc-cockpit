// page-input.ts PageInputRouter, randomized against its contract (clauses C1 to C9; the contract is the
// only source of what counts as a violation). Each seed builds a script up front (viewer events, frame
// layout changes, hover side effects, how each session answers, frame detaches, the protocol lost and
// attached again, time passing) and plays it through the router's public API with fake sessions on a
// virtual clock. On top of the script, a seeded fault injector detaches a frame or loses and reattaches
// the protocol at EVERY resolution point of the fake sessions (each answer, refusal and deadline, the
// hit-test answers and the detached roads' answers), 0, 1, 2 or more microtasks after it.
//
// The oracle is a ledger of viewer events kept here, never the router's fields (the queue is read only
// to see whether a hand-in was taken: the cap): every event has an enqueue epoch, an order number, its
// delivery attempts and, if it was never sent, one named excuse (the cap, an epoch change, move
// coalescing, wheel summing, or a press record the epoch or a frame going deleted). Press records are
// the oracle's own copy of the contract's C7 records. Each check cites its clause.
//
//   FUZZ_SEEDS=50000 npx vitest run test/unit/page-input.fuzz.test.ts   (a long run)
//   FUZZ_SEED=1234 ...                                                 (one seed)
//   FUZZ_CLASS=C3:lost ...                                             (shrink that violation's first failure)
//
// Pointer events go to the router as Electron events built here, not through toElectronEvents (which
// rounds to whole px): each carries a tag in the fractions of its point (frames are placed at whole
// px, so a point mapped into a frame keeps them), so an event can be told apart wherever it lands.
// Keys go the way WebviewInput.accept sends them (clipboard chords dropped, edit chords as commands).
// The protocol is always told of a loss at once (`reset`): an epoch is a `reset()` call.
//
// main's scripts (`scriptAt`, `scriptIn`, `scriptInFocus`) are interleaved with all of it, from a PRNG
// stream of their own (so a seed's other actions are the ones it had before; 30% of seeds get none and
// run exactly as before). Each script is a ledger event too (kind 'script', its place on the queue: C4,
// O3) with a record of its own: when its call started on the call road (read off the router's
// `runCall`), every evaluation and top run it made, and how it settled. Its code carries `#s<n>#`, so
// each `Runtime.evaluate` and top run (`deps.isolated`) names its call. Each document of the fake world
// has a loaderId and an isolated world's context id: `navigate` replaces it (a new loaderId; `keep`, the
// old context id still answers: a cross-process swap), `sflip` does so right as a script's query is
// answered (mid-run), and each script query and top run can hang, refuse, answer late or be malformed.
// The checks are the merge bar's O1 to O4 mapped onto scripts; each names its outcome.
import { describe, it } from 'vitest'
import {
  FRAME_WORLD_NAME,
  MAX_QUEUED_STEPS,
  MAX_RETESTS,
  PageInputRouter,
  ROUTE_TIMEOUT_MS,
  STEP_TIMEOUT_MS,
  type FrameScriptResult,
  type ScriptFrame
} from '../../src/main/webview/page-input'
import {
  InputDroppedError,
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
type Mode = 'fast' | 'slow' | 'late' | 'never' | 'reject' | 'ooo' | 'latereject'
/** How a session answers each hit-test query (slow: within the route's deadline, so a late input answer can land mid-hit-test). */
type QueryMode = 'fast' | 'slow' | 'late' | 'never' | 'reject'
type FrameName = 'A' | 'B' | 'C' | 'D'
type DocName = 'page' | FrameName
/** A hover side effect on a frame owner: a move over it covers it (an overlay), uncovers it, or flips. */
type Effect = 'none' | 'cover' | 'uncover' | 'flip'
/** How a document answers main's script queries: well, malformed (half of them), late (past STEP_TIMEOUT_MS) or never. */
type SMode = 'ok' | 'malformed' | 'late' | 'never'
/** How the top document's runner (`deps.isolated`) answers: odd, a value of a shape nobody expects. */
type TopMode = 'fast' | 'slow' | 'late' | 'hang' | 'reject' | 'throw' | 'odd'

export type Action =
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
  | { a: 'lose'; rejectPending: boolean }
  | { a: 'reset' }
  | { a: 'reattach' }
  /** From here on, at each resolution point the fault injector fires with this probability. */
  | { a: 'faults'; rate: number }
  /** From here on every external await (command, query, hover exit) never settles with this probability (ruling 2026-11-19 #10). */
  | { a: 'hangrate'; rate: number }
  /** A frame A seen at 100x100 px with a 10,000x10,000 viewport, its quad skewed by 0.4 px, and a child B at (4995, 4000) size 1005x2000. */
  | { a: 'bigframe' }
  /** The big frame is gone again (A and B back at their usual boxes). */
  | { a: 'bigoff' }
  /** The renderer goes (`router.rendererGone()`): the old detached calls never settle, a healthy one replaces it. */
  | { a: 'rendererGone' }
  /** The detached road (`wc.insertText` and the others) never settles from now on, or settles again. */
  | { a: 'hang'; on: boolean }
  /** Hand-written: at the `skip`th resolution point from now (-1: the answer of the next hover exit), `after` microtasks later, detach a frame or lose the protocol (and attach again). */
  | { a: 'arm'; skip: number; after: number; then: 'detach' | 'relose' | 'lose'; frame: FrameName }
  /** main's scripts; `stale`: handed back the epoch the last `epochmark` saw (an attachment that may have ended). */
  | { a: 'scriptAt'; x: number; y: number; stale: boolean }
  /** `pick`: which handle a scriptAt answered, newest first (-1: a forged handle, never one the router made). */
  | { a: 'scriptIn'; pick: number; stale: boolean }
  | { a: 'scriptInFocus'; stale: boolean }
  /** The element holding a document's focus: a cross-site frame's owner, a same-site frame's ('same'), or none. */
  | { a: 'focus'; doc: DocName; to: FrameName | 'same' | 'none' }
  /** The document replaced (a new loaderId); `keep`: the old context id still answers (a cross-process swap). */
  | { a: 'navigate'; doc: DocName; keep: boolean }
  | { a: 'smode'; doc: DocName; mode: SMode }
  | { a: 'topmode'; mode: TopMode }
  /** From here on each script query's answer first replaces its document with this probability (a loaderId change mid-run). */
  | { a: 'sflip'; rate: number }
  /** Remember the router's epoch now (`inputEpoch()`), for a later `stale` script. */
  | { a: 'epochmark' }

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

/** One of main's script calls or a change to the world they run in, from the scripts' own PRNG stream. */
function scriptActions(r: () => number): Action[] {
  const p = r()
  const stale = r() < 0.12
  if (p < 0.24) {
    const out: Action[] = [{ a: 'scriptAt', ...pointOf(r), stale }]
    // Often the choice after the hit test (a select's), on the handle it answered.
    if (r() < 0.4) out.push({ a: 'advance', ms: pick(r, [0, 1, 30, 250, 600]) }, { a: 'scriptIn', pick: 0, stale: false })
    return out
  }
  if (p < 0.36) return [{ a: 'scriptIn', pick: r() < 0.1 ? -1 : Math.floor(r() * 4), stale }]
  if (p < 0.54) return [{ a: 'scriptInFocus', stale }]
  if (p < 0.66) {
    const doc = pick(r, ['page', 'page', 'A', 'C'] as const)
    const kids = FRAMES.filter((f) => f.parent === doc).map((f) => f.name)
    return [{ a: 'focus', doc, to: r() < 0.75 ? pick(r, kids) : pick(r, ['same', 'none'] as const) }]
  }
  if (p < 0.78) return [{ a: 'navigate', doc: pick(r, DOCS), keep: r() < 0.5 }]
  if (p < 0.85) return [{ a: 'smode', doc: pick(r, DOCS), mode: pick(r, ['ok', 'ok', 'malformed', 'late', 'never'] as const) }]
  if (p < 0.92) return [{ a: 'topmode', mode: pick(r, ['fast', 'fast', 'slow', 'late', 'hang', 'reject', 'throw', 'odd'] as const) }]
  if (p < 0.96) return [{ a: 'sflip', rate: pick(r, [0, 0.05, 0.2] as const) }]
  return [{ a: 'epochmark' }]
}

/** One seed's script: a viewer's events (paired presses and releases, sometimes a release lost) and the world around them. */
function makeScript(seed: number): Action[] {
  const r = prng(seed)
  // main's scripts from a stream of their own: the other actions of a seed stay what they were.
  const rs = prng(seed ^ 0x3c6ef372)
  const scriptRate = rs() < 0.3 ? 0 : pick(rs, [0.04, 0.1, 0.2] as const)
  const out: Action[] = []
  if (scriptRate > 0) {
    if (rs() < 0.6) out.push({ a: 'focus', doc: 'page', to: pick(rs, ['A', 'C'] as const) })
    if (rs() < 0.4) out.push({ a: 'focus', doc: 'A', to: 'B' }, { a: 'focus', doc: 'C', to: 'D' })
    if (rs() < 0.3) out.push({ a: 'sflip', rate: pick(rs, [0.05, 0.2] as const) })
  }
  const held = new Set<Button>()
  const keys = new Map<string, InputModifier[]>()
  const stress = r() < 0.05
  if (r() < 0.3) out.push({ a: 'hangrate', rate: pick(r, [0.03, 0.1, 0.3] as const) })
  if (r() < 0.75) out.push({ a: 'faults', rate: pick(r, [0.05, 0.1, 0.2, 0.4] as const) })
  const length = stress ? 40 : 20 + Math.floor(r() * 100)
  if (stress) out.push({ a: 'mode', doc: 'page', mode: 'never' })
  const attached = new Set<FrameName>()
  for (const f of FRAME_NAMES) {
    if (r() < 0.75 && (FRAMES.find((d) => d.name === f)!.parent === 'page' || attached.has(FRAMES.find((d) => d.name === f)!.parent as FrameName))) {
      out.push({ a: 'attach', frame: f, ready: true })
      attached.add(f)
    }
  }
  const slotAt = !stress && r() < 0.1 ? Math.floor(r() * length) : -1
  const hangAt = !stress && r() < 0.08 ? Math.floor(r() * length) : -1
  const bigAt = !stress && r() < 0.06 ? Math.floor(r() * length) : -1
  const goneAt = !stress && r() < 0.06 ? Math.floor(r() * length) : -1
  const capAt = !stress && r() < 0.1 ? Math.floor(r() * length) : -1
  for (let i = 0; i < length; i++) {
    if (scriptRate > 0 && rs() < scriptRate) out.push(...scriptActions(rs))
    if (i === slotAt && held.size === 0 && !keys.has('Tab')) {
      // C7 / C9: a key and a button held, the page stalled, the queue filled, then the same ups over and over (one release slot per record).
      out.push({ a: 'key', type: 'down', key: 'Tab', mods: [] }, { a: 'down', x: 500, y: 650, button: 'left', held: ['left'] }, { a: 'mode', doc: 'page', mode: 'never' })
      out.push({ a: 'key', type: 'down', key: 'x', mods: [] }, { a: 'burst', n: 200 + Math.floor(r() * 100) })
      for (let k = 0; k < 6; k++) out.push({ a: 'key', type: 'up', key: 'Tab', mods: [] }, { a: 'up', x: 500, y: 650, button: 'left', held: [] })
      out.push({ a: 'key', type: 'up', key: 'x', mods: [] }, { a: 'mode', doc: 'page', mode: 'fast' })
      continue
    }
    if (i === bigAt) {
      // C1 / C6 (O1): a near-parallelogram quad over a large viewport: the child under the TRUE projective point, never another.
      const px = 50 + Math.floor(r() * 3) - 1
      out.push({ a: 'attach', frame: 'A', ready: true }, { a: 'attach', frame: 'B', ready: true }, { a: 'bigframe' })
      out.push({ a: 'move', x: px, y: 250, held: [] }, { a: 'down', x: px, y: 250 + Math.floor(r() * 3) - 1, button: pick(r, BUTTONS), held: [] }, { a: 'wheel', x: px, y: 250, dy: 40 }, { a: 'advance', ms: 1500 }, { a: 'bigoff' })
      continue
    }
    if (i === goneAt) {
      // C9 (O4): the renderer goes before, at or after a detached delivery's deadline: no stall may be left behind.
      out.push({ a: 'lose', rejectPending: false }, { a: 'hang', on: true }, { a: 'text' }, { a: 'advance', ms: pick(r, [0, 100, 499, 500, 501]) })
      out.push({ a: 'rendererGone' }, { a: 'hang', on: false }, { a: 'advance', ms: pick(r, [10, 700]) })
      out.push({ a: 'key', type: 'down', key: 'q', mods: [] }, { a: 'key', type: 'up', key: 'q', mods: [] }, { a: 'text' }, { a: 'advance', ms: 700 }, { a: 'reattach' })
      continue
    }
    if (i === hangAt) {
      // C9: the protocol lost and the renderer unresponsive: repeated texts must not pile up unsettled detached calls.
      out.push({ a: 'lose', rejectPending: false }, { a: 'hang', on: true })
      for (let k = 0; k < 6; k++) out.push({ a: 'text' }, { a: 'advance', ms: 501 })
      out.push({ a: 'hang', on: false }, { a: 'reattach' })
      continue
    }
    if (i === capAt && held.size === 0 && !keys.has('Tab')) {
      // C7 / C5: a button pressed, a move holding no button (the release owed), the page stalled, the queue filled past its cap, then the viewer's up.
      out.push({ a: 'down', x: 500, y: 650, button: 'left', held: ['left'] }, { a: 'move', x: 500, y: 650, held: [] }, { a: 'mode', doc: 'page', mode: 'never' })
      out.push({ a: 'key', type: 'down', key: 'Tab', mods: [] }, { a: 'burst', n: 200 + Math.floor(r() * 150) }, { a: 'up', x: 500, y: 650, button: 'left', held: [] })
      out.push({ a: 'key', type: 'up', key: 'Tab', mods: [] }, { a: 'mode', doc: 'page', mode: 'fast' })
      continue
    }
    if (r() < 0.04) {
      // A hover over a frame, a frame going (or the protocol lost) at the n-th resolution point after, `after` microtasks late, then a
      // press or wheel outside every frame: the hover exit's continuation finds the world changed (C1, C3, C6).
      const frame = pick(r, ['A', 'C'] as const)
      const at = frame === 'A' ? { x: 60 + Math.floor(r() * 400), y: 260 + Math.floor(r() * 200) } : { x: 700 + Math.floor(r() * 200), y: 150 + Math.floor(r() * 200) }
      out.push({ a: 'move', ...at, held: [...held] })
      out.push({ a: 'arm', skip: r() < 0.7 ? -1 : Math.floor(r() * 8), after: Math.floor(r() * 4), then: pick(r, ['detach', 'detach', 'detach', 'relose', 'lose'] as const), frame: r() < 0.7 ? frame : pick(r, FRAME_NAMES) })
      const away = { x: 300 + Math.floor(r() * 600), y: 600 + Math.floor(r() * 90) }
      if (r() < 0.7) {
        const free = BUTTONS.filter((b) => !held.has(b))
        const button = free.length > 0 ? pick(r, free) : 'left'
        held.add(button)
        out.push({ a: 'down', ...away, button, held: [...held] })
      } else out.push({ a: 'wheel', ...away, dy: Math.floor(r() * 240) - 120 })
      continue
    }
    const p = r()
    if (p < 0.3) {
      out.push({ a: 'move', ...pointOf(r), held: [...held] })
    } else if (p < 0.38) {
      const free = BUTTONS.filter((b) => !held.has(b))
      // Now and then a press of a button already down (the viewer lost its release).
      const button = free.length > 0 && r() < 0.95 ? pick(r, free) : pick(r, BUTTONS)
      held.add(button)
      let at = pointOf(r)
      // Often a hover first, over a frame, then the press outside every frame: the router's hover exit (C6) sits between them.
      if (r() < 0.3) {
        out.push({ a: 'move', ...pointOf(r), held: [...held].filter((b) => b !== button) })
        at = { x: 300 + Math.floor(r() * 600), y: 600 + Math.floor(r() * 90) }
      }
      out.push({ a: 'down', ...at, button, held: [...held] })
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
        const free = KEYS.filter((k) => !keys.has(k))
        if (free.length === 0) continue
        const key = pick(r, free)
        const mods = pick(r, MOD_SETS)
        keys.set(key, mods)
        out.push({ a: 'key', type: 'down', key, mods })
      }
    } else if (p < 0.63) {
      out.push({ a: 'text' })
    } else if (p < 0.645) {
      out.push({ a: 'call', blocking: r() < 0.7, ms: pick(r, [0, 10, 600, -1]) })
    } else if (p < 0.75) {
      out.push({ a: 'advance', ms: pick(r, ADVANCES) })
    } else if (p < 0.81) {
      out.push({ a: 'mode', doc: pick(r, DOCS), mode: pick(r, ['fast', 'fast', 'slow', 'late', 'late', 'never', 'reject', 'ooo', 'ooo', 'latereject'] as const) })
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
      out.push({ a: 'lose', rejectPending: r() < 0.5 })
    } else if (p < 0.99) {
      out.push({ a: 'faults', rate: pick(r, [0.05, 0.1, 0.2, 0.4] as const) })
    } else if (p < 0.993) {
      out.push({ a: 'reset' })
    } else {
      out.push({ a: 'reattach' })
    }
    if (stress && i === 5) {
      // Half the time across a lost protocol: keys held before it, then released past the cap of the
      // new attachment's queue (rule 5: a press of an older attachment admits no release there).
      if (r() < 0.5) {
        out.push({ a: 'lose', rejectPending: r() < 0.5 }, { a: 'reattach' })
        // A key down the never-answering page stalls on (held from now on, as any key down).
        if (!keys.has('Tab')) {
          keys.set('Tab', [])
          out.push({ a: 'key', type: 'down', key: 'Tab', mods: [] })
        }
        out.push({ a: 'advance', ms: 600 })
      }
      out.push({ a: 'burst', n: 300 + Math.floor(r() * 400) })
    }
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

/** A step in the router's queue, as the oracle reads it. */
interface QStep {
  kind: string
  event?: { type: string; keyCode?: string; button?: string; x?: number; y?: number }
  method?: string
  params?: Record<string, unknown>
}

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
  /** How main's scripts settled (FUZZ_STATS=1 prints the sums: a run whose scripts never answer from a frame proves little). */
  outcomes: { frame: number; top: number; undefined: number; rejected: number }
}

// --- the ledger ---------------------------------------------------------------------------------

type EvKind = 'move' | 'down' | 'up' | 'wheel' | 'key' | 'text' | 'cmd' | 'call' | 'script'

/** One viewer event, from its hand-in on: what the oracle owes it (C3) and what happened to it. */
interface Ev {
  /** Hand-in order over all kinds (C4). */
  n: number
  kind: EvKind
  /** The epoch at enqueue (C1/O2): the router's `reset()` count. */
  epoch: number
  at: number
  /** Pointer events: the tag in the fractions of the point. */
  tag: number
  /** Pointer events: the page point the viewer aimed at. */
  px?: number
  /** The layout epoch at hand-in. */
  layoutAt?: number
  py?: number
  /** Keys, commands, texts: the spelling the sink sees. */
  entry: string
  /** A key or button up (a release): matches a press record by `rid`. */
  release: boolean
  /** Press record id (`button:left`, `key:KeyA`); '' for events that are no press or release. */
  rid: string
  /** Moves: the buttons the viewer held. */
  held: readonly Button[]
  /** Wheels: the DOM-sign delta the event stands for (merged wheels folded in: C3 wheel summing). */
  sum: number
  /** Delivery attempts (a refused one counts: C2). */
  attempts: number
  /** A char whose key down was refused: C7 drops it with the down. */
  droppedWithDown?: boolean
  /** The first attempt went to a live frame that refused: one more, to the page at the top point, is allowed. */
  redirectOk: boolean
  /** Why it may never be sent: a named cause of this event (never an interval). */
  excuse?: string
  /** Handed in while the queue was at its cap and not taken into it. */
  capDropped: boolean
  /** The object the router queues for it (to see whether the hand-in was taken). */
  ref?: object
  blocking?: boolean
  /** The press record this event's up would match when it was handed in ('detached' road records matter to C7). */
  recAtHandIn?: string
  /** Calls and detached-road items: the barrier (C4). */
  startedAt?: number
}

/** A press record (C7): {code or button, session}; `session` is '' (the page), a frame's id, or 'detached'. */
interface Rec {
  id: string
  session: string
  n: number
  /** A no-button move was delivered while this was live: its release is owed. */
  owed: boolean
  /** An up already admitted past the cap for it (C7: one release slot per record). */
  slot?: boolean
  /** The command that made it (a refusal within its deadline deletes it again). */
  by?: Command
}

// --- one run --------------------------------------------------------------------------------------

/** The (u, v) fractions of a point in a quad (clockwise from the top left) under the true projective map of the unit square. */
function unproject(q: readonly number[], x: number, y: number): { u: number; v: number } | undefined {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q as [number, number, number, number, number, number, number, number]
  const sx = x0 - x1 + x2 - x3
  const sy = y0 - y1 + y2 - y3
  let g = 0
  let h = 0
  if (sx !== 0 || sy !== 0) {
    const dx1 = x1 - x2
    const dx2 = x3 - x2
    const dy1 = y1 - y2
    const dy2 = y3 - y2
    const den = dx1 * dy2 - dx2 * dy1
    g = (sx * dy2 - dx2 * sy) / den
    h = (dx1 * sy - sx * dy1) / den
  }
  const a = x1 - x0 + g * x1
  const b = x3 - x0 + h * x3
  const d = y1 - y0 + g * y1
  const e = y3 - y0 + h * y3
  // x (g u + h v + 1) = a u + b v + x0, and likewise for y: a 2x2 system in (u, v).
  const m00 = a - g * x
  const m01 = b - h * x
  const m10 = d - g * y
  const m11 = e - h * y
  const det = m00 * m11 - m01 * m10
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return undefined
  const r0 = x - x0
  const r1 = y - y0
  return { u: (r0 * m11 - m01 * r1) / det, v: (m00 * r1 - r0 * m10) / det }
}

async function runScript(seed: number, script: readonly Action[], withTrace = false): Promise<RunResult> {
  const violations: Violation[] = []
  const trace: string[] = []
  const violate = (clause: string, what: string, detail: string): void => {
    if (violations.length < 20) violations.push({ id: `${clause}:${what}`, detail: `${clause}:${what}: ${detail} (t=${clock.now})` })
  }
  const yieldRng = prng(seed ^ 0x9e3779b9)
  const clock = new Clock(() => Math.floor(yieldRng() * 9))

  // The world: each document's scroll, each owner's box and cover, each frame's session.
  const scroll = new Map<DocName, { x: number; y: number }>(DOCS.map((d) => [d, { x: 0, y: 0 }]))
  const rects = new Map<FrameName, [number, number, number, number]>(FRAMES.map((f) => [f.name, [...f.rect] as [number, number, number, number]]))
  const effects = new Map<FrameName, Effect>(FRAME_NAMES.map((f) => [f, 'none']))
  const covered = new Set<FrameName>()
  const big = new Map<FrameName, { bw: number; bh: number; skew: number }>()
  let bigOn = false
  /** Counts layout changes (boxes, scroll, covers): a step whose hit test saw one change is excused the wrong-child check (ruling 2026-11-19 #8). */
  let layoutEpoch = 0
  const modes = new Map<DocName, Mode>(DOCS.map((d) => [d, 'fast']))
  const qmodes = new Map<DocName, QueryMode>(DOCS.map((d) => [d, 'fast']))
  const sessionOf = new Map<DocName, Session>()
  const sessions = new Map<string, Session>()
  /** The epoch: the number of `router.reset()` calls (C1/O2, C7). */
  let gen = 0
  let attached = true
  let sessionSeq = 0
  const newPage = (): void => {
    sessionOf.set('page', { id: '', doc: 'page', gen, ended: false, ready: true })
  }
  newPage()

  // The oracle's own records.
  const commands: Command[] = []
  const evs: Ev[] = []
  const byTag = new Map<number, Ev>()
  const byEntry = new Map<string, Ev>()
  let evSeq = 0
  /** C7: the live press records, by id. */
  const records = new Map<string, Rec>()
  /** C7: records a second down of the same id superseded while they were live (the viewer lost a release); their owed releases still go to their sessions. */
  let stale: Rec[] = []
  /** Viewer keys by spelling, in hand-in order (sent ones are dropped from the front lazily). */
  const keyPending = new Map<string, Ev[]>()
  const allRecs = (): Rec[] => [...records.values(), ...stale]
  /** C7: the cause a record of this id was deleted for (epoch or frame gone), until the next down delivers. */
  const tombs = new Map<string, string>()
  /** C4: the last ordered event delivered, and the item holding the barrier. */
  let lastN = 0
  let barrier: { ev: Ev; startAt: number } | undefined
  /** Documents whose frame owners a hover move changed, not hit-tested since (C6). */
  const dirty = new Set<DocName>()
  /** C2: a refusal the router saw (its session still there when it went on) is logged once. */
  let pendingRefusal: Session | undefined
  let refusalSeen = false
  let refusedAnswers = 0
  let refusalLogs = 0
  /** C6: hit tests of the page's document since the last viewer pointer event was delivered, when nothing disturbed them. */
  let exitsSince = 0
  let exitPending = false
  let disturbed = false
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
      if (e !== 'none') {
        dirty.add(doc)
        layoutEpoch++
      }
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
      const b = big.get(f.name)
      const quad = b ? [x, y, x + rw, y, x + rw + b.skew, y + rh, x, y + rh] : [x, y, x + rw, y, x + rw, y + rh, x, y + rh]
      return { model: { content: quad, border: quad, width: b?.bw ?? rw, height: b?.bh ?? rh } }
    }
    return {}
  }

  // --- the fault injector: a frame detach or a lost()/reattach at every resolution point ---------

  const faultRng = prng(seed ^ 0x51ed270b)
  let faultRate = 0
  let faultCount = 0
  /** Run `run` after `offset` microtask hops (0: right now, before the router's continuation of what just resolved). */
  const afterHops = (offset: number, run: () => void): void => {
    if (offset <= 0) return run()
    let left = offset
    const tick = (): void => {
      if (--left > 0) return queueMicrotask(tick)
      run()
    }
    queueMicrotask(tick)
  }
  /** Called right after a fake session resolved or rejected something, or a router deadline fired. */
  let armed: Extract<Action, { a: 'arm' }> | undefined
  /** > 0 while the harness changes the world itself: a fault then waits at least one microtask (never inside its own loops). */
  let busy = 0
  const resolutionPoint = (target?: Session, exit = false): void => {
    // `skip` -1: the answer of the next synthetic hover exit.
    if (armed && (armed.skip < 0 ? exit : armed.skip-- <= 0)) {
      const a = armed
      armed = undefined
      afterHops(busy > 0 ? Math.max(1, a.after) : a.after, () => {
        if (withTrace) trace.push(`  t=${clock.now} armed after ${a.after}: ${a.then} ${a.frame}`)
        disturbed = true
        if (a.then === 'detach') detachFrame(a.frame, false)
        else if (attached) {
          lose(false)
          if (a.then === 'relose') reattach()
        }
      })
      return
    }
    if (faultRate === 0 || faultCount >= 80 || faultRng() >= faultRate) return
    faultCount++
    const offset = pick(faultRng, [0, 0, 1, 1, 2, 2, 3, 4, 6])
    const choice = faultRng()
    const frame = pick(faultRng, FRAME_NAMES)
    const reject = faultRng() < 0.5
    // Most often the frame whose answer this is (the hover exit's own frame going is the dangerous case).
    const aim = faultRng() < 0.7 ? target : undefined
    // main's scripts (codex review 2026-11-20: a reset or the renderer going between a run's end and its continuation): in runs with
    // scripts a fault is sometimes the renderer going, or the answering session's document replaced, from a stream of their own.
    const scriptFault = scriptsOn ? goneRng() : 1
    afterHops(busy > 0 ? Math.max(1, offset) : offset, () => {
      if (scriptFault < 0.2) {
        if (withTrace) trace.push(`  t=${clock.now} fault after ${offset}: renderer gone`)
        disturbed = true
        return rendererGoneNow()
      }
      if (scriptFault < 0.35 && target && !target.ended) return replaceDoc(target, goneRng() < 0.5)
      if (withTrace) trace.push(`  t=${clock.now} fault after ${offset}: ${choice < 0.5 ? `detach ${frame}` : choice < 0.85 ? 'lose+reattach' : 'lose'}`)
      disturbed = true
      if (!attached) return reattach()
      if (choice < 0.5) {
        const alive = FRAME_NAMES.filter((f) => sessionOf.get(f))
        if (aim && !aim.ended && aim.doc !== 'page' && sessionOf.get(aim.doc) === aim) detachFrame(aim.doc as FrameName, reject)
        else if (alive.length > 0) detachFrame(sessionOf.get(frame) ? frame : (alive[0] as FrameName), reject)
      } else if (choice < 0.85) {
        lose(reject)
        reattach()
      } else lose(reject)
    })
  }

  // --- the sink's view: every delivery of a viewer event, by any road -------------------------------

  const describe = (ev: Ev): string => `${ev.kind}#${ev.n}${ev.kind === 'key' || ev.kind === 'cmd' || ev.kind === 'text' || ev.kind === 'script' ? ` ${ev.entry}` : ` tag ${ev.tag}`} (enqueued t=${ev.at} epoch ${ev.epoch})`

  /** C1, C2, C4 for one delivery of a ledger event; `road`: the protocol (to `sessionId`) or the detached road. */
  const deliver = (ev: Ev, road: 'protocol' | 'fallback', sessionId: string): void => {
    // C1 / O2: the step's epoch is current at the sink; a delivery under another epoch is a violation.
    if (ev.epoch !== gen) violate('C1', 'epoch', `${describe(ev)} delivered under epoch ${gen} by ${road} to ${sessionId || 'page'}`)
    // C2: at most once. A second attempt is allowed only to the page after a live frame refused the first.
    ev.attempts++
    if (ev.attempts > 1) {
      if (ev.kind !== 'move' && !(ev.redirectOk && road === 'protocol' && sessionId === '' && ev.attempts === 2)) {
        violate('C2', 'resent', `${describe(ev)} sent again (attempt ${ev.attempts}) by ${road} to ${sessionId || 'page'}`)
      }
      ev.redirectOk = false
      return
    }
    ev.redirectOk = false
    // C4: delivered in enqueue order (moves are not in the list), past no open barrier.
    if (ev.kind !== 'move') {
      // C5 / C4 (ruling 2026-11-19 #2): a stalled session's release is sent at once, in enqueue order, never parked behind later events.
      if (ev.n < lastN) violate('C4', 'order', `${describe(ev)} delivered after #${lastN}`)
      lastN = Math.max(lastN, ev.n)
      if (barrier && barrier.ev !== ev && ev.n > barrier.ev.n && clock.now - barrier.startAt < STEP_TIMEOUT_MS) {
        violate('C4', 'barrier', `${describe(ev)} delivered while ${describe(barrier.ev)} holds the barrier (since t=${barrier.startAt})`)
      }
    }
    // C7, ruling 2026-11-19: an up is sent iff the model has a live record for it; every up with no live record when a later event
    // is delivered is dropped and excused (cause: no record), per event. A record-backed up that is not sent stays a violation.
    if (ev.kind !== 'move') for (const e of evs) if (e.release && e.attempts === 0 && e.n < ev.n && e.excuse === undefined && !allRecs().some((r) => r.id === e.rid)) e.excuse = 'no record'
    // C7: a no-button move delivered with a record live and owing its release marks the record.
    if (ev.kind === 'move') for (const rec of allRecs()) if (rec.id.startsWith('button:') && !ev.held.includes(rec.id.slice(7) as Button)) rec.owed = true
    // C7 owed releases: checked at quiescence only (ruling 2026-11-19: a release held for a stalled frame may be passed by later events).
  }

  const startBarrier = (ev: Ev): void => {
    barrier = { ev, startAt: clock.now }
    ev.startedAt = clock.now
  }
  const endBarrier = (ev: Ev): void => {
    if (barrier?.ev === ev) barrier = undefined
  }

  /** C7: a down delivered by any road makes a record. */
  const recordDown = (ev: Ev | undefined, rid: string, session: string, by?: Command): void => {
    tombs.delete(rid)
    const old = records.get(rid)
    // C7 (ruling 2026-11-19 #3): one record per key code: a key down on a live code is a repeat and keeps the record. A button down
    // on a live button first sends the old record's owed release (it stays live until then).
    if (old && rid.startsWith('key:')) return
    if (old) stale.push(old)
    records.set(rid, { id: rid, session, n: ev?.n ?? 0, owed: false, by })
  }
  /** C7: a record deleted by an epoch change or a frame going: its ups are dropped (a named cause, per event). */
  const endRecord = (rec: Rec, cause: string): void => {
    unlink(rec)
    if (!records.has(rec.id)) tombs.set(rec.id, cause)
      }
  /** C7: the up of a record goes to the record's session exactly once and deletes it. */
  /** Removes a record (the newest of its id gives way to the latest superseded one). */
  function unlink(rec: Rec): void {
    if (records.get(rec.id) === rec) {
      records.delete(rec.id)
      const at = stale.map((r) => r.id).lastIndexOf(rec.id)
      if (at >= 0) records.set(rec.id, stale.splice(at, 1)[0] as Rec)
    } else stale = stale.filter((r) => r !== rec)
  }
  const recordUp = (ev: Ev | undefined, rid: string, road: 'protocol' | 'fallback', sessionId: string): void => {
    const newest = records.get(rid)
    if (!newest) return
    // An up (the viewer's, or the router's owed release) matches a live record of its id by session; with a press superseded by a second one both are live.
    const rec = (allRecs().find((r) => r.id === rid && (r.session === 'detached' ? '' : r.session) === sessionId) ?? newest)
    const want = rec.session === 'detached' ? '' : rec.session
    if (road === 'protocol' && sessionId !== want) violate('C7', 'up-wrong-session', `${rid} up${ev ? ` ${describe(ev)}` : ' (owed)'} to ${sessionId || 'page'}, its record is at ${rec.session || 'page'}`)
    if (road === 'fallback' && rec.session !== 'detached' && rec.session !== '') violate('C7', 'up-wrong-session', `${rid} up by the detached road, its record is at frame ${rec.session}`)
    unlink(rec)
    if (!records.has(rid)) tombs.delete(rid)
  }

  /** Whether the sink was handed a session that is dead (C1). */
  const checkTarget = (method: string, sessionId: string, session: Session | undefined): void => {
    if (!method.startsWith('Input.') || (!attached && sessionId === '')) return
    if (!session) violate('C1', 'unknown-session', `${method} to ${sessionId}`)
    else if (session.ended) violate('C1', 'dead-session', `${method} to ${sessionId} (gen ${session.gen}, now ${gen}): a pointer goes to the page at the top point, never to a dead frame`)
  }

  const send = (method: string, params: Record<string, unknown> | undefined, sessionId?: string): Promise<unknown> => {
    const id = sessionId ?? ''
    const p = params ?? {}
    if (sessionId === '') violate('C1', 'empty-session-id', method)
    const session = docOfSession(id)
    if (withTrace) trace.push(`  t=${clock.now} send ${id || 'page'} ${method} ${JSON.stringify(p)}`)
    if (pendingRefusal) {
      if (!pendingRefusal.ended) refusalSeen = true
      pendingRefusal = undefined
    }
    const input = method.startsWith('Input.')
    // C6, ruling 2026-11-19: only re-tests caused by a synthetic hover exit count (a re-test after a park is required).
    if (method === 'Input.dispatchMouseEvent' && String(p.type) === 'mouseMoved' && (p.x as number) < 0 && (p.y as number) < 0) exitPending = true
    // C6, ruling 2026-11-19 #4: the cap counts re-tests (a hit test run again after a synthetic hover exit), never exits: one step may
    // send several exits (nested frames left at once). At most MAX_RETESTS per step, then the page session.
    if (method === 'DOM.getNodeForLocation' && id === '' && exitPending) {
      exitPending = false
      exitsSince++
      if (!disturbed && exitsSince > MAX_RETESTS) violate('C6', 'retests', `${exitsSince} re-tests after hover exits for one pointer step`)
    }
    // Which viewer event is this (if any), and the checks of its delivery.
    let ev: Ev | undefined
    let createdRecord = false
    if (input) {
      checkTarget(method, id, session)
      if (method === 'Input.dispatchMouseEvent') {
        const type = String(p.type)
        const x = p.x as number
        const y = p.y as number
        const tag = tagOf(x, y)
        let found = byTag.get(tag)
        // The big frame scales the point 100 times, so a tag in its fractions is gone: the earliest unsent event of that kind with an aim.
        if (!found && bigOn && session && (session.doc === 'A' || session.doc === 'B') && !(x < 0 && y < 0)) {
          const kind = type === 'mousePressed' ? 'down' : type === 'mouseWheel' ? 'wheel' : type === 'mouseMoved' ? 'move' : 'up'
          found = evs.find((e) => e.kind === kind && e.attempts === 0 && e.px !== undefined && e.px >= 48 && e.px <= 52 && (e.py as number) >= 248 && (e.py as number) <= 252 && (kind !== 'up' || e.rid === `button:${String(p.button)}`))
        }
        if (type === 'mouseMoved') {
          // A synthetic hover move (an exit, or a move over the owner) is no viewer event; the viewer's own move has its tag.
          // (Under capture the viewer's own move may land at negative frame coordinates; the exit is (-1, -1), tag 0.)
          if (found?.kind === 'move') ev = found
        } else if (type === 'mousePressed') {
          if (found?.kind === 'down') ev = found
          else violate('C2', 'press-from-nowhere', `${String(p.button)} press at ${id || 'page'} matches no viewer press (tag ${tag})`)
        } else if (type === 'mouseWheel') {
          if (found?.kind === 'wheel') ev = found
          else violate('C2', 'wheel-from-nowhere', `wheel at ${id || 'page'} matches no viewer wheel (tag ${tag})`)
        } else if (type === 'mouseReleased') {
          const rid = `button:${String(p.button)}`
          if (found?.kind === 'up' && found.rid === rid && (found.attempts === 0 || found.redirectOk)) ev = found
          else if (records.has(rid)) ev = undefined // the router's owed release for a live record
          else if (found?.kind === 'up') violate('C2', 'resent', `${describe(found)} sent again to ${id || 'page'} with no record`)
          else violate('C7', 'release-without-record', `${rid} released at ${id || 'page'}, which has no live record`)
        }
        if (ev) {
          deliver(ev, 'protocol', id)
          wrongChild(ev, session)
          if (ev.kind === 'wheel' && Math.abs((p.deltaY as number) - ev.sum) > 1e-9) violate('C3', 'wheel-sum', `${describe(ev)} sent with deltaY ${String(p.deltaY)}, its events sum to ${ev.sum}`)
          if (ev.kind === 'down') {
            // C6: a viewer press is hit-tested after the last hover move that changed a document on its way.
            routeCheck(type, session, id, tag)
            recordDown(ev, ev.rid, id, undefined)
            createdRecord = true
          }
          if (ev.kind === 'up') recordUp(ev, ev.rid, 'protocol', id)
          if (ev.kind === 'wheel') routeCheck(type, session, id, tag)
          // C6: after a hover exit the hit test runs again at most 2 times (3 tests in all), then the page session.
          exitsSince = 0
    exitPending = false
          disturbed = false
        } else if (type === 'mouseReleased') {
          recordUp(undefined, `button:${String(p.button)}`, 'protocol', id)
        }
        // Owed-release bookkeeping, and the C6 retests of hover exits.
        if (type === 'mouseMoved' && session && attached && x >= 0 && y >= 0) applyEffects(session.doc, x, y)
      } else if (method === 'Input.dispatchKeyEvent') {
        if (id !== '') violate('C1', 'key-to-frame', `${method} to ${id}`)
        if (isClipboardShape(p)) violate('C3', 'clipboard', JSON.stringify(p))
        ev = p.__tag !== undefined ? byEntry.get(`c:${String(p.__tag)}`) : unsentKey(`${keyEntry(String(p.type), p.code)}:${Number(p.modifiers ?? 0)}`)
        if (ev?.droppedWithDown) violate('C7', 'char-after-refused-down', `${describe(ev)} delivered though its key down was refused`)
        if (ev) {
          deliver(ev, 'protocol', id)
          const code = typeof p.code === 'string' && p.code !== '' ? p.code : ''
          const type = String(p.type)
          if (ev.release && ev.rid) recordUp(ev, ev.rid, 'protocol', id)
          else if (code !== '' && (type === 'rawKeyDown' || type === 'keyDown')) {
            recordDown(ev, `key:${code}`, id)
            createdRecord = true
          }
        } else violate('C2', 'key-from-nowhere', `${String(p.type)} ${String(p.code)} to ${id || 'page'} matches no unsent viewer key (a resend, or never handed in)`)
      } else if (method === 'Input.insertText') {
        if (id !== '') violate('C1', 'key-to-frame', `${method} to ${id}`)
        ev = byEntry.get(`t:${String(p.text)}`)
        if (ev) deliver(ev, 'protocol', id)
        else violate('C2', 'text-from-nowhere', `${String(p.text)} matches no viewer text`)
      } else {
        violate('C1', 'key-to-frame', `${method} to ${id}`)
      }
    }
    if (!attached) {
      // Refused at once, as Electron's debugger does when detached.
      const c: Command = { session: id, gen, sentAt: clock.now, answered: false, method, params: p, detached: true, resolve: () => {}, reject: () => {} }
      if (input) commands.push(c)
      refusedAnswers++
      return new Promise((_resolve, reject) => {
        clock.set(() => {
          c.answered = true
          reject(new Error('Debugger is not attached'))
        }, 0, false)
      })
    }
    // C5: nothing to a stalled session, one command on its way per page, the stalled page holds everything.
    if (pageStalled()) violate('C5', 'page-stalled-send', `${method} to ${id || 'page'} while the page owes an answer past its deadline`)
    const doc = session?.doc ?? 'page'
    if (!input) {
      if (method === 'DOM.getNodeForLocation') dirty.delete(doc)
      const mode = qmodes.get(doc) as QueryMode
      // C5, ruling 2026-11-19 #10: no query to a stalled session (an await of its past its deadline); a late query stalls like a command.
      const stalledOn = liveAwaits().find((a) => a.session === id && clock.now - a.at >= (a.kind.startsWith('Input.') ? STEP_TIMEOUT_MS : ROUTE_TIMEOUT_MS))
      if (stalledOn) violate('C5', 'query-to-stalled', `${method} to ${id || 'page'}, stalled by ${stalledOn.kind} since t=${stalledOn.at}`)
      // main's scripts: a script query's own checks (O1 to O4), made before it counts as outstanding.
      const sq = isScriptQuery(method, p) ? scriptQuery(method, p, id, session) : undefined
      const aw = trackAwait(method, id)
      if (sq) aw.script = true
      const hang = hangRate > 0 && hangRng() < hangRate
      const smode: SMode = sq ? (smodes.get(doc) as SMode) : 'ok'
      const compute = (): unknown => (sq ? answerScript(session, method, p, sq) : answerQuery(doc, method, p))
      return new Promise((resolve, reject) => {
        const answer = (): void => {
          aw.settled = true
          try {
            resolve(compute())
          } catch (err) {
            reject(err)
          }
        }
        if (hang || mode === 'never' || smode === 'never') {
          hungAwaits.push(answer)
          return
        }
        clock.set(
          () => {
            aw.settled = true
            if (mode === 'reject') reject(new Error('No session with given id'))
            else {
              try {
                resolve(compute())
              } catch (err) {
                reject(err)
              }
            }
            resolutionPoint(session)
          },
          smode === 'late' ? STEP_TIMEOUT_MS + 1 : mode === 'late' ? ROUTE_TIMEOUT_MS + 1 : mode === 'slow' ? 30 : 0,
          false
        )
      })
    }
    const live = commands.filter((c) => !c.answered && !c.detached && c.gen === gen && !(docOfSession(c.session)?.ended ?? true) && docOfSession(c.session)?.gen === gen)
    // C5 (ruling 2026-11-19 #2): a stalled session takes the owed release of each of its live records at once.
    const owedRelease = String(p.type) === 'mouseReleased' && live.filter((c) => c.session === id).every((c) => clock.now - c.sentAt >= STEP_TIMEOUT_MS)
    if (!owedRelease && live.some((c) => c.session === id)) violate('C5', 'session-busy', `${method} ${String(p.type ?? '')} to ${id || 'page'}, which owes an answer`)
    // C5 / C9 (O4): a session never holds more than 1 + its live records' owed releases outstanding commands.
    // Ruling 2026-11-19 #6: a release sent to a stalled session counts as outstanding until it answers though its record ended at send:
    // the bound is 1 (the stalling command) + the releases owed to it (one per record live when they were sent).
    const releases = live.filter((c) => c.session === id && c.params.type === 'mouseReleased').length + (String(p.type) === 'mouseReleased' ? 1 : 0)
    const outstanding = live.filter((c) => c.session === id).length + 1
    const owedSlots = allRecs().filter((r) => r.session === id).length + releases
    if (outstanding > 1 + owedSlots) violate('C9', 'session-outstanding', `${outstanding} commands outstanding at ${id || 'page'} (live records there: ${owedSlots})`)
    const inFlight = live.filter((c) => clock.now - c.sentAt < STEP_TIMEOUT_MS)
    if (inFlight.length > 0) violate('C5', 'two-in-flight', `${method} ${String(p.type ?? '')} to ${id || 'page'} while ${inFlight[0]!.session || 'page'} ${String(inFlight[0]!.params.type ?? '')} is on its way`)
    // O3 (C5, ruling 2026-11-19 #10: one outstanding command or query per session): an input command never goes to a session while
    // a script's query there is unanswered, but an owed release to a session that query stalled (ruling #2; ROUTE_TIMEOUT_MS is the
    // shortest deadline a script query has).
    const overScript = liveAwaits().find((a) => a.script && a.session === id && !(String(p.type) === 'mouseReleased' && clock.now - a.at >= ROUTE_TIMEOUT_MS))
    if (overScript) violate('O3', 'input-over-script', `${method} ${String(p.type ?? '')} to ${id || 'page'} while the script query ${overScript.kind} (t=${overScript.at}) is unanswered there`)
    const c: Command = { session: id, gen, sentAt: clock.now, answered: false, method, params: p, detached: false, resolve: () => {}, reject: () => {} }
    commands.push(c)
    if (createdRecord) {
      // Ruling 2026-11-19 #6: a refused repeat key down keeps the existing record; only the down that made the record is tied to its command.
      const rec = records.get(ev?.rid ?? '')
      if (rec && rec.n === (ev?.n ?? -1)) rec.by = c
    }
    const mode = modes.get(doc) as Mode
    const aw = trackAwait(`${method}${String(p.type ?? '') === 'mouseMoved' && (p.x as number) < 0 ? ' (hover exit)' : ''}`, id)
    const hang = hangRate > 0 && hangRng() < hangRate
    return new Promise((resolve, reject) => {
      const settle = (ok: boolean): void => {
        if (c.answered) return
        c.answered = true
        aw.settled = true
        if (withTrace) trace.push(`  t=${clock.now} ${ok ? 'answer' : 'refuse'} ${id || 'page'} ${String(p.type ?? method)}`)
        if (ok) resolve({})
        else {
          const seen = !c.detached && c.gen === gen && session && !session.ended && clock.now - c.sentAt < STEP_TIMEOUT_MS
          refusedAnswers++
          if (seen) pendingRefusal = session
          if (seen && ev && session && session.doc !== 'page' && method === 'Input.dispatchMouseEvent') ev.redirectOk = true
          // C7: a refused down made no press (within its deadline, the router saw it).
          if (seen) for (const r of allRecs()) if (r.by === c) endRecord(r, 'refusal')
          // C7: a refused key down drops its paired char too.
          // (A late refusal, past the deadline, drops it as well.)
          if (method === 'Input.dispatchKeyEvent' && (p.type === 'rawKeyDown' || p.type === 'keyDown')) {
            // Every char paired with it: those handed in after the down and before the next down of that key.
            const chars = keyPending.get(`${keyEntry('char', p.code)}:${Number(p.modifiers ?? 0)}`) ?? []
            const downs = keyPending.get(`${keyEntry(String(p.type), p.code)}:${Number(p.modifiers ?? 0)}`) ?? []
            const next = downs.find((e) => e.attempts === 0 && ev && e.n > ev.n)
            for (const pair of chars) if (ev && pair.attempts === 0 && pair.n > ev.n && (!next || pair.n < next.n) && pair.epoch === gen) pair.droppedWithDown = true

          }
          // C7: a live frame that refuses is a frame going for its other records (its ups are dropped, cause: the frame's refusal).
          if (seen && session && session.doc !== 'page' && method === 'Input.dispatchMouseEvent') for (const r of allRecs()) if (r.session === id) endRecord(r, 'frame refused')
          reject(new Error('No session with given id'))
        }
        resolutionPoint(session, method === 'Input.dispatchMouseEvent' && String(p.type) === 'mouseMoved' && (p.x as number) < 0 && (p.y as number) < 0)
      }
      c.resolve = () => settle(true)
      c.reject = () => settle(false)
      if (mode === 'never') return
      if (hang) {
        hungAwaits.push(() => settle(true))
        return
      }
      // 'ooo': answers out of order (a later command answers before an earlier one); 'latereject': refused past the deadline.
      const delay = mode === 'slow' ? 300 : mode === 'late' || mode === 'latereject' ? STEP_TIMEOUT_MS + LATE[commands.length % LATE.length]! : mode === 'ooo' ? [620, 540, 900, 100, 700, 30][commands.length % 6]! : 0
      clock.set(() => settle(mode !== 'reject' && mode !== 'latereject'), delay, false)
    })
  }

  /**
   * C1 / C6 (O1): with the big skewed frame A, a pointer delivered to its child B must lie, at the TRUE projective point of the
   * viewer's aim, inside B (the router's affine map from three corners puts it elsewhere on a near-parallelogram quad).
   */
  function wrongChild(ev: Ev, session: Session | undefined): void {
    const b = big.get('A')
    if (!bigOn || !b || !session || session.doc !== 'B' || ev.px === undefined || ev.py === undefined || ev.layoutAt !== layoutEpoch) return
    const sp = scroll.get('page') as { x: number; y: number }
    if (sp.x !== 0 || sp.y !== 0 || (scroll.get('A') as { x: number; y: number }).x !== 0 || (scroll.get('A') as { x: number; y: number }).y !== 0) return
    const [rx, ry, rw, rh] = rects.get('A') as [number, number, number, number]
    const q = [rx, ry, rx + rw, ry, rx + rw + b.skew, ry + rh, rx, ry + rh]
    const t = unproject(q, ev.px, ev.py)
    if (!t) return
    const [bx, by, bw, bh] = rects.get('B') as [number, number, number, number]
    const tx = t.u * b.bw
    const ty = t.v * b.bh
    if (tx < bx || tx >= bx + bw || ty < by || ty >= by + bh) violate('C1', 'wrong-child', `${describe(ev)} aimed at (${ev.px}, ${ev.py}) went to B, but its true point in A is (${tx.toFixed(1)}, ${ty.toFixed(1)}), outside B`)
  }
  /** C6: a press or wheel into a frame comes after the hit test that follows the last hover move changing a document on its way. */
  function routeCheck(type: string, session: Session | undefined, id: string, tag: number): void {
    if (!session || session.doc === 'page' || capturing()) return
    for (let d = parentDoc(session.doc); d; d = d === 'page' ? undefined : parentDoc(d)) {
      if (dirty.has(d)) violate('C6', 'stale-route', `${type} (tag ${tag}) to ${id} routed through ${d}, changed by a hover move since its hit test`)
    }
  }
  /** Whether a button press is held at a live session of this attachment (the router's capture). */
  function capturing(): boolean {
    for (const rec of allRecs()) {
      if (!rec.id.startsWith('button:')) continue
      const s = rec.session === 'detached' || rec.session === '' ? sessionOf.get('page') : sessions.get(rec.session)
      if (s && !s.ended) return true
    }
    return false
  }
  function parentDoc(doc: DocName): DocName | undefined {
    return FRAMES.find((f) => f.name === doc)?.parent
  }
  /** The earliest unsent viewer key with this spelling. */
  function unsentKey(entry: string): Ev | undefined {
    // A key has no tag of its own: the earliest unsent one of the current epoch (an older one that the
    // router dropped at the epoch change must not be taken for this delivery), else any (O2 then shows).
    const list = keyPending.get(entry)
    if (!list) return undefined
    while (list.length > 0 && list[0]!.attempts > 0) list.shift()
    // Ruling 2026-11-19: never steal from an excused event: the earliest unexcused candidate in enqueue order, this epoch first.
    const open = list.filter((e) => e.attempts === 0 && e.excuse === undefined && !e.capDropped && !e.droppedWithDown)
    return open.find((e) => e.epoch === gen) ?? open[0] ?? list.find((e) => e.attempts === 0 && e.droppedWithDown && e.epoch === gen)
  }

  // --- main's scripts (scriptAt, scriptIn, scriptInFocus) -------------------------------------------

  type ScriptKind = 'at' | 'in' | 'focus'
  /** One top run (`deps.isolated`): a call on the call road. `abandoned`: its renderer went and it never settles. */
  interface TopRun {
    sc: ScriptCall
    at: number
    settled: boolean
    settledAt?: number
    value?: unknown
    failed?: unknown
    abandoned?: boolean
    go: (ok: boolean) => void
  }
  /** One `Runtime.evaluate` by value of a script; `seq` orders its answer among its session's frame-tree reads. */
  interface EvalRec {
    session: Session
    seq: number
    answered: boolean
    loader?: string
    value?: unknown
  }
  /** A `scriptAt` answer's frame (`src`: where it ran), or a forged handle the router never made. */
  interface Handle {
    obj: object
    src: Session | 'top' | 'forged'
  }
  interface ScriptCall {
    n: number
    kind: ScriptKind
    ev: Ev
    /** The attachment it is of (handed in, or the stale one handed back). */
    epoch: number
    stale: boolean
    x: number
    y: number
    handle?: Handle
    pushed: boolean
    /** Its call's run began (the router's `runCall`), and the world then (O1's excuses, see `sigAt`). */
    started?: number
    sigAt?: string
    sigFocus?: string
    /** The router resolved or rejected it (its step's own resolve); `settled`: the caller's promise did. */
    routerSettled: boolean
    settled: boolean
    tops: TopRun[]
    evals: EvalRec[]
    /** A malformed answer came during its run (the focus walk cannot tell one from "no cross-site frame focused"). */
    malformed: boolean
    /** Its top run began: the router lets what follows go on (`release`). */
    released: boolean
  }
  interface DocState {
    loader: string
    ctx: number
    /** Frame-tree reads, evaluations and replacements of this session's document, in answer order. */
    log: Array<{ seq: number; kind: 'tree' | 'eval' | 'change'; loader?: string }>
  }
  interface ScriptQuery {
    sc?: ScriptCall
    rec?: EvalRec
  }
  /** A thrown script's or a refused evaluation's value: nothing the router may resolve equals it. */
  const DROPPED = Symbol('dropped')
  const scriptCalls = new Map<number, ScriptCall>()
  let scriptSeq = 0
  /** The script being handed in (its step is the next call `push` gets). */
  let pendingScript: ScriptCall | undefined
  const stepScript = new WeakMap<object, ScriptCall>()
  /** scriptAt's answers, newest last (a few: the oracle's own, bounded). */
  const handles: Handle[] = []
  const focusOf = new Map<DocName, FrameName | 'same'>()
  const docStates = new Map<Session, DocState>()
  let loaderSeq = 0
  let ctxSeq = 0
  let logSeq = 0
  const smodes = new Map<DocName, SMode>(DOCS.map((d) => [d, 'ok']))
  let topMode: TopMode = 'fast'
  let sflipRate = 0
  const sRng = prng(seed ^ 0x7f4a7c15)
  /** Top runs of the live renderer, unsettled (C5 / C9: with the harness's calls, at most one). */
  const liveTop = new Set<TopRun>()
  const topHung: TopRun[] = []
  let savedEpoch = 0
  const scriptsOn = script.some((a) => a.a === 'scriptAt' || a.a === 'scriptIn' || a.a === 'scriptInFocus')
  /** The renderer going and documents replaced at resolution points too, only in runs with scripts (the others keep their faults). */
  const goneRng = prng(seed ^ 0x1b873593)
  const outcomes = { frame: 0, top: 0, undefined: 0, rejected: 0 }

  const stateOf = (s: Session): DocState => {
    let st = docStates.get(s)
    if (!st) docStates.set(s, (st = { loader: `L${++loaderSeq}`, ctx: ++ctxSeq, log: [] }))
    return st
  }
  /** A new document in `s`'s frame: a new loaderId; a new context id too unless `keep` (a cross-process swap). */
  const replaceDoc = (s: Session, keep: boolean): void => {
    const st = stateOf(s)
    st.loader = `L${++loaderSeq}`
    if (!keep) st.ctx = ++ctxSeq
    st.log.push({ seq: ++logSeq, kind: 'change', loader: st.loader })
    if (withTrace) trace.push(`  t=${clock.now} document of ${s.id || 'page'} replaced (${st.loader}${keep ? ', context kept' : ''})`)
  }
  const markerOf = (code: unknown): number | undefined => {
    const m = /#s(\d+)#/.exec(String(code))
    return m ? Number(m[1]) : undefined
  }
  const isScriptQuery = (method: string, p: Record<string, unknown>): boolean =>
    method === 'Page.getFrameTree' || method === 'Page.createIsolatedWorld' || method === 'Runtime.evaluate' || method === 'Runtime.releaseObjectGroup' || (method === 'DOM.describeNode' && 'objectId' in p)
  /** The script whose walk sends an unmarked query: the newest started, not settled, not released (one walk at a time). */
  const activeScript = (): ScriptCall | undefined => {
    let best: ScriptCall | undefined
    for (const sc of scriptCalls.values()) if (sc.started !== undefined && !sc.routerSettled && !sc.released && (!best || sc.n > best.n)) best = sc
    return best
  }
  const sessionSig = (): string => `${gen}|${[...sessionOf].map(([d, s]) => `${d}:${s.id}:${s.ready ? 1 : 0}:${s.ended ? 1 : 0}`).join(',')}`
  /** What a press's route depends on: sessions, boxes, scroll, covers (layoutEpoch counts each change). */
  const sigAt = (): string => `${sessionSig()}|${layoutEpoch}|${[...covered].join('')}|${bigOn}`
  /** What the focus walk depends on: sessions and the focus. */
  const sigFocus = (): string => `${sessionSig()}|${[...focusOf].map(([d, f]) => `${d}>${f}`).join(',')}`
  const ancestry = (doc: DocName): FrameDef[] => {
    const out: FrameDef[] = []
    for (let d: DocName = doc; d !== 'page'; ) {
      const f = FRAMES.find((g) => g.name === d) as FrameDef
      out.unshift(f)
      d = f.parent
    }
    return out
  }
  /** The top page's viewport point (x, y) in `doc`'s own viewport (translates only: the big frame is excluded). */
  const pointIn = (doc: DocName, x: number, y: number): { x: number; y: number } => {
    let px = x
    let py = y
    for (const f of ancestry(doc)) {
      const s = scroll.get(f.parent) as { x: number; y: number }
      const [rx, ry] = rects.get(f.name) as [number, number, number, number]
      px -= rx - s.x
      py -= ry - s.y
    }
    return { x: px, y: py }
  }
  /** The sessions under (x, y), the page first: as the fake's hit-test answers give them (first owner in FRAMES order, a cover stops it). */
  const chainAt = (x: number, y: number): Session[] => {
    const page = sessionOf.get('page')
    if (!page) return []
    const out: Session[] = [page]
    let doc: DocName = 'page'
    let px = x
    let py = y
    for (let depth = 0; depth < 8; depth++) {
      const s = scroll.get(doc) as { x: number; y: number }
      const dx = Math.floor(px + s.x)
      const dy = Math.floor(py + s.y)
      const next = FRAMES.find((f) => {
        if (f.parent !== doc) return false
        const [rx, ry, rw, rh] = rects.get(f.name) as [number, number, number, number]
        return dx >= rx && dx < rx + rw && dy >= ry && dy < ry + rh
      })
      if (!next || covered.has(next.name)) break
      const child = sessionOf.get(next.name)
      if (!child || child.ended || !child.ready) break
      const [rx, ry] = rects.get(next.name) as [number, number, number, number]
      px -= rx - s.x
      py -= ry - s.y
      doc = next.name
      out.push(child)
    }
    return out
  }
  /** The sessions a live button record holds (the router's capture is the first of them; the oracle does not order them). */
  const captureSessions = (): { any: boolean; sessions: Set<Session> } => {
    const out = new Set<Session>()
    let any = false
    for (const rec of allRecs()) {
      if (!rec.id.startsWith('button:')) continue
      any = true
      const s = rec.session === '' || rec.session === 'detached' ? sessionOf.get('page') : sessions.get(rec.session)
      if (s) out.add(s)
    }
    return { any, sessions: out }
  }
  /** The focus walk's answer by the fake's own world: the page, then each focused ready cross-site child, deepest last. */
  const focusChain = (): Session[] => {
    const page = sessionOf.get('page')
    if (!page) return []
    const out: Session[] = [page]
    let doc: DocName = 'page'
    for (let depth = 0; depth < 8; depth++) {
      const kids = FRAMES.filter((f) => f.parent === doc).some((f) => {
        const s = sessionOf.get(f.name)
        return s !== undefined && !s.ended && s.ready
      })
      if (!kids) break
      const to = focusOf.get(doc)
      if (to === undefined || to === 'same') break
      const s = sessionOf.get(to)
      if (!s || s.ended || !s.ready) break
      doc = to
      out.push(s)
    }
    return out
  }
  const nameOf = (src: Session | 'top' | 'forged' | undefined): string => (src === undefined ? 'nothing' : typeof src === 'string' ? src : `${src.id || 'page'} (${src.doc}, epoch ${src.gen})`)

  /** The checks of one query of a script's walk or run, as it is sent (before it counts as outstanding). */
  const scriptQuery = (method: string, p: Record<string, unknown>, id: string, session: Session | undefined): ScriptQuery => {
    const marker = method === 'Runtime.evaluate' ? markerOf(p.expression) : undefined
    const sc = marker !== undefined ? scriptCalls.get(marker) : activeScript()
    const where = `${method} to ${id || 'page'}${sc ? ` for script#${sc.n} (${sc.kind})` : ''}`
    if (withTrace) trace.push(`  t=${clock.now} script query ${where}`)
    // O2 / O1: a script's query goes only to a live session of the attachment it was queued under.
    if (!session) violate('O1', 'script-unknown-session', where)
    else if (session.gen !== gen) violate('O2', 'script-old-attachment', `${where}: a session of epoch ${session.gen}, now ${gen}`)
    else if (session.ended) violate('O1', 'script-dead-session', `${where}: that session went`)
    // O3 (C5, ruling 2026-11-19 #10): one outstanding command or query per session; a script's query never overlaps one.
    const busy = liveAwaits().find((a) => a.session === id)
    if (busy) violate('O3', 'script-overlap', `${where} while ${busy.kind} (t=${busy.at}) is unanswered there`)
    if (!sc) {
      violate('O4', 'script-query-orphan', `${where}: no script's walk is running`)
      return {}
    }
    // O4: nothing of a script once it settled (or let what follows go: its run is the top document's then).
    if (sc.routerSettled || sc.released) violate('O4', 'script-query-after-end', `${where}: it ${sc.routerSettled ? 'settled' : 'ran in the top document'} already`)
    // O2: every protocol command of a script goes out under the epoch it was queued under.
    if (sc.epoch !== gen || sc.stale) violate('O2', 'script-query-epoch', `${where} under epoch ${gen}, queued under ${sc.epoch}`)
    // O1: never the main world (an evaluation always names its isolated world's context).
    if (method === 'Runtime.evaluate' && typeof p.contextId !== 'number') violate('O1', 'script-main-world', `${where} with no context id`)
    if (method === 'Page.createIsolatedWorld' && p.worldName !== FRAME_WORLD_NAME) violate('O1', 'script-main-world', `${where} names world ${String(p.worldName)}`)
    if (marker === undefined || !session) return { sc }
    const rec: EvalRec = { session, seq: 0, answered: false }
    sc.evals.push(rec)
    evalTarget(sc, session, String(p.expression))
    return { sc, rec }
  }

  /** O1: the document a script's evaluation runs in is the one its call picked. */
  const evalTarget = (sc: ScriptCall, session: Session, expr: string): void => {
    const what = `script#${sc.n} (${sc.kind}) evaluated in ${nameOf(session)}`
    if (sc.kind === 'in') {
      // scriptIn: the handle's frame, never another (nor any frame for a forged or top handle).
      if (sc.handle?.src !== session) violate('O1', 'script-in-other-frame', `${what}; its handle is ${nameOf(sc.handle?.src)}`)
      return
    }
    if (sc.kind === 'at') {
      // Accepted (contract): a page that covers or moves a frame while a hit test is in flight. Checked only with the world as it
      // was when the call started; the big frame's projective map is C6's own check.
      if (bigOn || sc.sigAt !== sigAt()) return
      // scriptAt: the press's own route. Under capture (any button record) the captor's frame or the top; else the frames under
      // the point, the page down to the deepest (a query refused or late stops the route at a parent: what the press would get).
      const cap = captureSessions()
      const chain = chainAt(sc.x, sc.y)
      const allowed = cap.any ? cap.sessions : new Set(chain)
      if (!allowed.has(session)) {
        violate('O1', 'script-at-wrong-frame', `${what}; ${cap.any ? `the capture holds ${[...cap.sessions].map(nameOf).join(', ')}` : `under (${sc.x}, ${sc.y}) are ${chain.map(nameOf).join(' > ')}`}`)
        return
      }
      // The point in that document's own CSS px.
      const at = /#s\d+#(.*),(.*)$/.exec(expr)
      const want = pointIn(session.doc, sc.x, sc.y)
      if (!at || Math.abs(Number(at[1]) - want.x) > 1e-6 || Math.abs(Number(at[2]) - want.y) > 1e-6) {
        violate('O1', 'script-at-point', `${what} got the point (${at?.[1]}, ${at?.[2]}), the press's point there is (${want.x}, ${want.y})`)
      }
      return
    }
    // Accepted (contract): a page moving focus (or a frame coming or going) while the walk is in flight. Checked only unchanged.
    if (sc.sigFocus !== sigFocus()) return
    const chain = focusChain()
    const target = chain[chain.length - 1]
    // scriptInFocus: the deepest focused cross-site frame. A malformed answer during the walk cannot be told from "no cross-site
    // frame focused there", so the walk may stop at an ancestor on the focus chain (nearest ruling: the safe direction is the top
    // document; that ancestor holds the focused frame); never a frame off the chain.
    if (sc.malformed ? !chain.includes(session) : session !== target) {
      violate('O1', 'script-focus-wrong-frame', `${what}; the focus is in ${nameOf(target)} (chain ${chain.map(nameOf).join(' > ')})${sc.malformed ? ', a malformed answer came' : ''}`)
    }
  }

  /** The fake's answer to a script query, as Chromium's (see page-input.test.ts `scripts`), malformed when its document's mode says. */
  const answerScript = (session: Session | undefined, method: string, p: Record<string, unknown>, sq: ScriptQuery): unknown => {
    if (!session || session.ended) throw new Error('No session with given id')
    const st = stateOf(session)
    // The document replaced right as this answer is made: a loaderId change mid-run.
    if (sflipRate > 0 && sRng() < sflipRate) replaceDoc(session, sRng() < 0.5)
    const bad = smodes.get(session.doc) === 'malformed' && sRng() < 0.5
    const k = Math.floor(sRng() * 4)
    if (bad && sq.sc) sq.sc.malformed = true
    const frameId = session.id === '' ? 'MAIN' : `T-${session.id}`
    if (method === 'Page.getFrameTree') {
      st.log.push({ seq: ++logSeq, kind: 'tree', loader: bad ? undefined : st.loader })
      if (bad) return [null, { frameTree: 'x' }, { frameTree: { frame: { id: frameId } } }, { frameTree: { frame: { id: frameId, loaderId: '' } } }][k]
      return { frameTree: { frame: { id: frameId, loaderId: st.loader }, childFrames: [{ frame: { id: `same-site-${session.doc}`, loaderId: 'LS' } }] } }
    }
    if (method === 'Page.createIsolatedWorld') {
      if (p.frameId !== frameId) throw new Error('No frame for given id found')
      if (bad) return [null, {}, { executionContextId: String(st.ctx) }, { executionContextId: st.ctx + 100000 }][k]
      return { executionContextId: st.ctx }
    }
    if (method === 'Runtime.evaluate') {
      // A context id of another document (or another session's) is refused, as Chromium does.
      if (p.contextId !== st.ctx) throw new Error('Cannot find context with specified id')
      if (p.returnByValue === false) {
        const owner = focusOf.get(session.doc)
        if (bad) return [null, { result: { objectId: 42 } }, { result: {} }, { result: { type: 'object' }, exceptionDetails: { text: 'Uncaught' } }][k]
        return { result: owner ? { type: 'object', subtype: 'node', objectId: `obj-${owner}` } : { type: 'object', subtype: 'null', value: null } }
      }
      const value = `${session.id || 'page'}|${st.loader}|${String(p.expression)}`
      const answer = bad ? [null, { result: 5 }, { result: { value }, exceptionDetails: { text: 'Uncaught' } }, { result: { value: { odd: value } } }][k] : { result: { value } }
      const rec = sq.rec
      if (rec) {
        rec.answered = true
        rec.seq = ++logSeq
        rec.loader = st.loader
        const a = answer as { result?: { value?: unknown }; exceptionDetails?: unknown } | null
        rec.value = a === null || a.exceptionDetails !== undefined ? DROPPED : a.result?.value
        st.log.push({ seq: rec.seq, kind: 'eval', loader: st.loader })
      }
      return answer
    }
    if (method === 'DOM.describeNode') {
      const owner = String(p.objectId).replace(/^obj-/, '')
      const s = (FRAME_NAMES as readonly string[]).includes(owner) ? sessionOf.get(owner as FrameName) : undefined
      const fid = owner === 'same' ? 'same-site-frame' : s ? `T-${s.id}` : `T-none-${owner}`
      if (bad) return [null, { node: null }, { node: { frameId: 5 } }, { node: {} }][k]
      return { node: { nodeName: 'IFRAME', frameId: fid } }
    }
    return bad ? null : {}
  }

  /**
   * O1 (the loaderId bracket): the evaluation `e` answered between two frame-tree reads of its session that named the same
   * document, the one it ran in (loaderIds never repeat, so no replacement came between them).
   */
  const bracketed = (e: EvalRec): boolean => {
    let before: { loader?: string } | undefined
    let after: { loader?: string } | undefined
    for (const l of stateOf(e.session).log) {
      if (l.kind !== 'tree') continue
      if (l.seq < e.seq) before = l
      else if (l.seq > e.seq && !after) after = l
    }
    return before?.loader !== undefined && before.loader === after?.loader && before.loader === e.loader
  }

  /** A script's call began on the call road: its place among the input (C4 / O3) and its barrier. */
  const scriptStarted = (sc: ScriptCall): void => {
    sc.started = clock.now
    sc.sigAt = sigAt()
    sc.sigFocus = sigFocus()
    if (withTrace) trace.push(`  t=${clock.now} script#${sc.n} (${sc.kind}) starts`)
    // O2: a script handed an attachment that ended never runs.
    if (sc.stale) violate('O2', 'script-stale-ran', `script#${sc.n} (${sc.kind}) handed epoch ${sc.epoch} ran under ${gen}`)
    // C1 (O2), C2, C4 (O3): under its own epoch, once, in its place among the input.
    deliver(sc.ev, 'fallback', '')
    // C4 (O3): what follows waits until it lets go (its top run) or settles; scriptIn's call is blocking (STEP_TIMEOUT_MS).
    startBarrier(sc.ev)
  }

  /** The router resolved or rejected a script (its step's own resolve: the checks at the router's own moment). */
  const routerSettled = (sc: ScriptCall, v: unknown, rejected: boolean): void => {
    sc.routerSettled = true
    endBarrier(sc.ev)
    if (withTrace) trace.push(`  t=${clock.now} script#${sc.n} (${sc.kind}) ${rejected ? `rejected (${String(v)})` : v === undefined ? 'dropped (undefined)' : 'answered'}`)
    if (rejected) {
      outcomes.rejected++
      return
    }
    if (v === undefined) {
      outcomes.undefined++
      return
    }
    const what = `script#${sc.n} (${sc.kind}, queued under epoch ${sc.epoch})`
    const value = sc.kind === 'at' ? (v as FrameScriptResult).value : v
    // O2: never resolved as a value once its attachment ended (undefined, or InputDroppedError).
    if (router.inputEpoch() !== sc.epoch || sc.stale) {
      // Named by where the value came from: the top document's run is the adapter's (TOP_FRAME: "whatever the attachment").
      violate('O2', sc.released ? 'script-top-value-after-end' : 'script-value-after-end', `${what} resolved with a value from ${sc.released ? `the top document (top run at t=${sc.tops[sc.tops.length - 1]?.at})` : 'a frame'} under epoch ${router.inputEpoch()}`)
    }
    let src: Session | 'top' | undefined
    if (sc.released) {
      src = 'top'
      outcomes.top++
      const top = sc.tops[sc.tops.length - 1]
      if (!top || !top.settled || top.failed !== undefined || !Object.is(top.value, value)) violate('O1', 'script-value-from-nowhere', `${what} resolved a value its top run did not answer`)
    } else {
      outcomes.frame++
      const e = [...sc.evals].reverse().find((x) => x.answered)
      if (!e) violate('O1', 'script-value-from-nowhere', `${what} resolved a value, and no evaluation of it was answered`)
      else {
        src = e.session
        if (!Object.is(e.value, value)) violate('O1', 'script-value-mismatch', `${what} resolved ${JSON.stringify(value)}, its evaluation in ${nameOf(e.session)} answered ${String(e.value === DROPPED ? 'an exception or nothing' : JSON.stringify(e.value))}`)
        // O1: a result from a frame whose loaderId changed is dropped.
        if (!bracketed(e)) violate('O1', 'script-loader-changed', `${what} resolved a value from ${nameOf(e.session)} (ran in ${e.loader}), not bracketed by two reads of that document: ${stateOf(e.session).log.map((l) => `${l.kind}${l.seq}:${l.loader ?? '?'}`).join(' ')}`)
      }
    }
    if (sc.kind === 'in' && src !== undefined && src !== sc.handle?.src) violate('O1', 'script-in-other-frame', `${what} answered from ${nameOf(src)}, its handle is ${nameOf(sc.handle?.src)}`)
    if (sc.kind !== 'at' || src === undefined) return
    const result = v as FrameScriptResult
    handles.push({ obj: result.frame as unknown as object, src })
    if (handles.length > 6) handles.shift()
    // O1: its rectangles mapped through the boxes of the frames it ran in (translates: the frame's origin in the top page).
    if (!bigOn && sc.sigAt === sigAt()) {
      const o = src === 'top' ? { x: 0, y: 0 } : pointIn(src.doc, 0, 0)
      const got = result.toTop({ x: 0, y: 0, width: 10, height: 10 })
      const want = { x: -o.x, y: -o.y, width: 10, height: 10 }
      if (!got || Math.abs(got.x - want.x) > 1e-6 || Math.abs(got.y - want.y) > 1e-6 || Math.abs(got.width - 10) > 1e-6 || Math.abs(got.height - 10) > 1e-6) {
        violate('O1', 'script-at-totop', `${what} from ${nameOf(src)} maps (0, 0, 10, 10) to ${JSON.stringify(got)}, the frame is at (${want.x}, ${want.y})`)
      }
    }
  }

  /** The caller's view: how the promise settled (a rejection is one of the named causes). */
  const watchScript = (sc: ScriptCall, p: Promise<unknown>): void => {
    p.then(
      (v) => {
        sc.settled = true
        if (sc.stale) violate('O2', 'script-stale-answered', `script#${sc.n} (${sc.kind}) handed epoch ${sc.epoch} answered ${v === undefined ? 'undefined' : 'a value'}, not InputDroppedError`)
      },
      (err: unknown) => {
        sc.settled = true
        const fromTop = sc.tops.some((t) => t.failed === err)
        const dropped = err instanceof InputDroppedError && (sc.stale || gen !== sc.epoch)
        const full = err instanceof Error && /queue full/.test(err.message) && sc.ev.capDropped
        if (!fromTop && !dropped && !full) violate('O4', 'script-rejected', `script#${sc.n} (${sc.kind}) rejected with ${String(err)} (epoch ${gen}, queued under ${sc.epoch})`)
      }
    )
  }

  /** The top document's runner (`deps.isolated`, executeJavaScriptInIsolatedWorld): a call on the call road. */
  const topRun = (code: string): Promise<unknown> => {
    const n = markerOf(code)
    const sc = n === undefined ? undefined : scriptCalls.get(n)
    if (withTrace) trace.push(`  t=${clock.now} top run ${code} (${topMode})`)
    if (!sc) {
      violate('O1', 'top-run-unknown', code)
      return Promise.resolve(undefined)
    }
    const what = `script#${sc.n} (${sc.kind})`
    // O2: a top run goes out only under the epoch its script was queued under.
    if (gen !== sc.epoch || sc.stale) violate('O2', 'script-top-epoch', `${what} ran in the top document under epoch ${gen}, queued under ${sc.epoch}`)
    if (sc.started === undefined || sc.routerSettled) violate('O4', 'script-top-outside-call', `${what} ran in the top document ${sc.started === undefined ? 'before its call started' : 'after it settled'}`)
    // O1: one document per script, never a frame's evaluation and a top run both.
    if (sc.evals.some((e) => e.answered)) violate('O1', 'script-two-documents', `${what} ran in the top document after an evaluation in ${nameOf(sc.evals[0]?.session)}`)
    if (sc.kind === 'in' && sc.handle?.src !== 'top') violate('O1', 'script-in-ran-top', `${what} ran in the top document; its handle is ${nameOf(sc.handle?.src)}`)
    if (sc.kind === 'focus' && !sc.malformed && sc.sigFocus === sigFocus() && focusChain().length > 1) {
      violate('O1', 'script-focus-ran-top', `${what} ran in the top document; the focus is in ${nameOf(focusChain().at(-1))}`)
    }
    sc.released = true
    if (sc.kind !== 'in') endBarrier(sc.ev)
    const mode = topMode
    const value = mode === 'odd' ? pick(sRng, [undefined, null, 0, { odd: true }]) : `top|${gen}|${code}`
    const run: TopRun = { sc, at: clock.now, settled: false, go: () => {} }
    sc.tops.push(run)
    liveTop.add(run)
    // C5 / C9 (O4): the call road holds one call at a time; a top run is one (with the harness's own calls).
    if (liveCalls.size + liveTop.size > 1) violate('C9', 'calls-outstanding', `${liveCalls.size + liveTop.size} calls outstanding (the top run of ${what})`)
    if (mode === 'throw') {
      const err = new Error('top threw')
      run.settled = true
      run.settledAt = clock.now
      run.failed = err
      liveTop.delete(run)
      throw err
    }
    return new Promise((resolve, reject) => {
      run.go = (ok: boolean): void => {
        if (run.settled || run.abandoned) return
        run.settled = true
        run.settledAt = clock.now
        liveTop.delete(run)
        if (withTrace) trace.push(`  t=${clock.now} top run of ${what} ${ok ? 'answers' : 'refused'}`)
        if (ok) {
          run.value = value
          resolve(value)
        } else {
          const err = new Error('top refused')
          run.failed = err
          reject(err)
        }
        resolutionPoint()
      }
      if (mode === 'hang') return void topHung.push(run)
      clock.set(() => run.go(mode !== 'reject'), mode === 'slow' ? 30 : mode === 'late' ? STEP_TIMEOUT_MS + 1 : 0, false)
    })
  }

  /** O4: a started script settles within its frame part's deadlines, and at once after its top run answered. */
  const checkScriptBounds = (): void => {
    for (const sc of scriptCalls.values()) {
      if (sc.settled || sc.started === undefined) continue
      if (sc.released) {
        // A top run is bounded only by the adapter (the contract's Accepted: a call hung forever parks what follows).
        const top = sc.tops[sc.tops.length - 1]
        if (top?.settled && clock.now > (top.settledAt as number)) violate('O4', 'script-unsettled', `script#${sc.n} (${sc.kind}) has not settled since its top run answered at t=${top.settledAt}`)
        continue
      }
      // scriptAt: the route's deadline, then the frame script's (ROUTE_TIMEOUT_MS each); scriptIn and scriptInFocus: STEP_TIMEOUT_MS.
      const bound = sc.kind === 'at' ? 2 * ROUTE_TIMEOUT_MS : STEP_TIMEOUT_MS
      if (clock.now > sc.started + bound) violate('O4', 'script-unsettled', `script#${sc.n} (${sc.kind}) started at t=${sc.started} and has not settled ${bound} ms later`)
    }
  }

  const fallback: ElectronInputEvent[] = []
  // A router that spins (a step that never ends and never waits) would hang the run: counted, then stopped.
  let turns = 0
  const router = new PageInputRouter({
    send,
    attached: () => {
      if (++turns > 200_000) {
        violate('C9', 'spin', 'the router ran 200000 turns in one run without waiting')
        throw new Error('spin')
      }
      return attached
    },
    fallback: (event) => {
      if (withTrace) trace.push(`  t=${clock.now} fallback ${JSON.stringify(event)}`)
      fallback.push(event)
      // C8: attached means protocol only.
      if (attached) violate('C8', 'detached-road-while-attached', `${JSON.stringify(event)} by sendInputEvent while attached`)
      let ev: Ev | undefined
      if (event.type === 'keyDown' || event.type === 'keyUp' || event.type === 'char') {
        const info = webviewKeyInfo(event.keyCode)
        ev = unsentKey(`${keyEntry(event.type === 'keyDown' ? 'rawKeyDown' : event.type, info?.code)}:${modBits(event.modifiers)}`)
        if (info && isClipboardShape({ code: info.code, modifiers: modBits(event.modifiers) })) violate('C3', 'clipboard', `fallback ${JSON.stringify(event)}`)
        if (!ev) return violate('C2', 'key-from-nowhere', `${JSON.stringify(event)} by sendInputEvent matches no unsent viewer key`)
        deliver(ev, 'fallback', '')
        if (ev.release && ev.rid) recordUp(ev, ev.rid, 'fallback', '')
        else if (event.type === 'keyDown') recordDown(ev, `key:${info?.code ?? event.keyCode}`, 'detached')
        return
      }
      const m = event as { type: string; x: number; y: number; button?: string; deltaY: number }
      const tag = tagOf(m.x, m.y)
      const found = byTag.get(tag)
      const kind = m.type === 'mouseDown' ? 'down' : m.type === 'mouseUp' ? 'up' : m.type === 'mouseWheel' ? 'wheel' : 'move'
      if (found?.kind !== kind) {
        if (kind === 'up' && records.has(`button:${m.button}`)) return recordUp(undefined, `button:${m.button}`, 'fallback', '')
        return violate('C2', 'event-from-nowhere', `${m.type} tag ${tag} by sendInputEvent matches no viewer ${kind}`)
      }
      if (kind === 'up' && !(found.attempts === 0 || found.redirectOk)) {
        if (records.has(found.rid)) return recordUp(undefined, found.rid, 'fallback', '')
      }
      deliver(found, 'fallback', '')
      if (kind === 'wheel' && Math.abs(-m.deltaY - found.sum) > 1e-9) violate('C3', 'wheel-sum', `${describe(found)} sent with deltaY ${-m.deltaY}, its events sum to ${found.sum}`)
      if (kind === 'down') recordDown(found, found.rid, 'detached')
      if (kind === 'up') recordUp(found, found.rid, 'fallback', '')
    },
    // The router's own logs: a step that threw, or a command its sender held back, drops input
    // silently; either is a loss.
    log: (message) => {
      if (/refused/.test(message)) refusalLogs++
      if (/input step failed|held back/.test(message)) violate('C3', 'router-log', message)
    },
    isolated: (code) => topRun(code),
    timers: {
      set: (fn, ms) =>
        clock.set(
          () => {
            fn()
            resolutionPoint()
          },
          ms,
          true
        ),
      clear: (h) => clock.clear(h)
    }
  })

  // A script's step is the router's own closure, so the oracle reads two moments off the call road: the step as it is queued (its
  // resolve wrapped, to check a value at the router's own moment) and the call's run beginning (`runCall`). Nothing else is changed.
  type CallStep = { kind: string; run?: unknown; resolve?: (v: unknown) => void; reject?: (e: unknown) => void }
  const internals = router as unknown as { push(step: CallStep): boolean; runCall(step: CallStep): unknown }
  const push0 = internals.push.bind(router)
  internals.push = (step: CallStep): boolean => {
    const sc = pendingScript
    if (!sc || step.kind !== 'call' || typeof step.run !== 'function' || !step.resolve || !step.reject) return push0(step)
    pendingScript = undefined
    sc.ev.ref = step.run as object
    stepScript.set(step.run as object, sc)
    const resolve = step.resolve
    const reject = step.reject
    step.resolve = (v: unknown): void => {
      routerSettled(sc, v, false)
      resolve(v)
    }
    step.reject = (e: unknown): void => {
      routerSettled(sc, e, true)
      reject(e)
    }
    sc.pushed = push0(step)
    return sc.pushed
  }
  const runCall0 = internals.runCall.bind(router)
  internals.runCall = (step: CallStep): unknown => {
    const sc = typeof step.run === 'function' ? stepScript.get(step.run as object) : undefined
    if (sc) scriptStarted(sc)
    return runCall0(step)
  }

  /** The router's queue (read only: what is taken and not run yet; only to see whether a hand-in was taken, the cap). */
  function queueOf(): QStep[] {
    return (router as unknown as { queue: QStep[] }).queue
  }
  const inQueue = (ev: Ev): boolean => queueOf().some((st) => (ev.ref !== undefined && (st.event === ev.ref || st.params === ev.ref || (st as { run?: unknown }).run === ev.ref)) || (ev.tag !== 0 && st.kind === 'mouse' && typeof st.event?.x === 'number' && tagOf(st.event.x, st.event.y as number) === ev.tag))
  const tailOf = (): { tag: number; type: string } | undefined => {
    const q = queueOf()
    const t = q[q.length - 1]
    return t && t.kind === 'mouse' && typeof t.event?.x === 'number' ? { tag: tagOf(t.event.x, t.event.y as number), type: String(t.event.type) } : undefined
  }

  /** One viewer event handed in: registered, then given to the router, then classified (cap, merge) by what the queue did (C3, C7). */
  function hand(ev: Ev, fn: () => void): void {
    ev.n = ++evSeq
    ev.epoch = gen
    ev.at = clock.now
    ev.layoutAt = layoutEpoch
    evs.push(ev)
    if (ev.tag !== 0) byTag.set(ev.tag, ev)
    if (ev.kind === 'text' || ev.kind === 'cmd' || ev.kind === 'call') byEntry.set(ev.entry, ev)
    if (ev.kind === 'key') {
      const list = keyPending.get(ev.entry)
      if (list) list.push(ev)
      else keyPending.set(ev.entry, [ev])
    }
    const before = queueOf().length
    const tailBefore = tailOf()
    const liveRec = ev.release ? records.has(ev.rid) : false
    // A down taken into the queue and not run yet is the record in the making (its up may pass the cap with it).
    const queuedDown = ev.release && before >= MAX_QUEUED_STEPS && evs.some((e) => !e.release && e.rid === ev.rid && e.epoch === gen && e.attempts === 0 && e.kind !== 'up' && inQueue(e))
    if (ev.release) ev.recAtHandIn = records.get(ev.rid)?.session
    fn()
    const taken = ev.attempts > 0 || inQueue(ev)
    // C3: move coalescing and wheel summing, named per event, from what the queue did to its tail.
    const tailNow = tailOf()
    if ((ev.kind === 'move' || ev.kind === 'wheel') && tailBefore && tailNow && tailBefore.type === (ev.kind === 'move' ? 'mouseMove' : 'mouseWheel')) {
      const older = byTag.get(tailBefore.tag)
      if (tailNow.tag === ev.tag && tailBefore.tag !== ev.tag && !inQueueTag(tailBefore.tag) && older && older.attempts === 0) {
        older.excuse = ev.kind === 'move' ? 'coalesced into a later move' : 'summed into a later wheel'
        if (ev.kind === 'wheel') ev.sum += older.sum
      } else if (tailNow.tag === tailBefore.tag && !taken && older && older.attempts === 0) {
        ev.excuse = ev.kind === 'move' ? 'coalesced into a later move' : 'summed into a later wheel'
        if (ev.kind === 'wheel') older.sum += ev.sum
      }
    }
    // C3: the cap. Only an event handed in at the cap and not taken is excused by it.
    if (!taken && before >= MAX_QUEUED_STEPS) ev.capDropped = true
    // C7 / C5: past the cap only an up that matches a live record is admitted.
    if (ev.release && before >= MAX_QUEUED_STEPS && taken && !liveRec && !queuedDown) violate('C7', 'past-cap-admission', `${describe(ev)} admitted past the cap with no live record (nor a queued down) for ${ev.rid}`)
    const admittedUp = ev.release && before >= MAX_QUEUED_STEPS && taken
    // C7 / C9 (O4), ruling 2026-11-19 #2: admitting an up past the cap consumes its record's one release slot; a second one is not admitted.
    if (admittedUp && liveRec) {
      const rec = records.get(ev.rid)
      if (rec?.slot) violate('C7', 'second-up-past-cap', `${describe(ev)} admitted past the cap, the record of ${ev.rid} had its release slot already (queue ${queueOf().length})`)
      else if (rec) rec.slot = true
    }
    // C9 / O4: the queue never passes its cap but by an admitted up.
    if (queueOf().length > MAX_QUEUED_STEPS + allRecs().length + 1) violate('C9', 'queue-over-cap-records', `the queue holds ${queueOf().length}, past the cap ${MAX_QUEUED_STEPS} plus ${allRecs().length} live records`)
    if (queueOf().length > Math.max(before, MAX_QUEUED_STEPS) + (admittedUp ? 1 : 0)) violate('C9', 'queue-over-cap', `the queue went from ${before} to ${queueOf().length} (cap ${MAX_QUEUED_STEPS})`)
  }
  function inQueueTag(tag: number): boolean {
    return queueOf().some((st) => st.kind === 'mouse' && typeof st.event?.x === 'number' && tagOf(st.event.x, st.event.y as number) === tag)
  }
  const blank = (kind: EvKind): Ev => ({ n: 0, kind, epoch: 0, at: 0, tag: 0, entry: '', release: false, rid: '', held: [], sum: 0, attempts: 0, redirectOk: false, capDropped: false })

  /** A detached road as Electron's: it lands a little later (an IPC), so a router that does not wait for it reorders. */
  let detachedHang = false
  let callsOut = 0
  /** Ruling 2026-11-19 #10: every external await of the live renderer, until it settles; hung ones wait here for the heal. */
  interface Await {
    kind: string
    session: string
    gen: number
    settled: boolean
    at: number
    /** A query of one of main's scripts (O3: never overlaps an input command on its session). */
    script?: boolean
  }
  const awaits = new Set<Await>()
  const hungAwaits: Array<() => void> = []
  let hangRate = 0
  const hangRng = prng(seed ^ 0x2545f491)
  /** The unsettled awaits of the live renderer on live sessions (a dead session's or an old attachment's are not counted). */
  const liveAwaits = (): Await[] => {
    const out: Await[] = []
    for (const a of awaits) {
      if (a.settled) awaits.delete(a)
      else if (a.gen === gen && !(docOfSession(a.session)?.ended ?? true)) out.push(a)
    }
    return out
  }
  /**
   * C5 / C9 (O4), ruling 2026-11-19 #10: at every step the unsettled external promises of the live renderer are bounded by, for each
   * live session, 1 plus the releases owed to it (live records there, and releases outstanding); plus 1 detached; plus 1 call.
   */
  const trackAwait = (kind: string, session: string): Await => {
    const aw: Await = { kind, session, gen, settled: false, at: clock.now }
    awaits.add(aw)
    const live = liveAwaits()
    const sessionsLive = new Set(live.map((a) => a.session))
    let bound = 0
    for (const sid of sessionsLive) bound += 1 + allRecs().filter((r) => r.session === sid).length + commands.filter((c) => !c.answered && !c.detached && c.session === sid && c.gen === gen && c.params.type === 'mouseReleased').length
    if (live.length > bound) {
      violate('C9', 'global-outstanding', `${live.length} unsettled awaits (bound ${bound}) after ${kind} to ${session || 'page'}; kinds: ${[...new Set(live.map((a) => a.kind))].join(', ')}`)
    }
    return aw
  }
  /** Calls outstanding on the current renderer (a renderer-gone ends them: their late settling changes nothing). */
  const liveCalls = new Set<Ev>()
  const callHung: Array<() => void> = []
  let detachedOut = 0
  /** Detached deliveries outstanding on the current renderer (a renderer-gone ends them: their late settling changes nothing). */
  const liveDetached = new Set<object>()
  const hung: Array<() => void> = []
  const detachedRoad = (entry: string, n: number, down?: string) => (): Promise<void> => {
    const ev = byEntry.get(entry)
    if (attached) violate('C8', 'detached-road-while-attached', `${entry} by its detached road while attached`)
    if (ev) {
      deliver(ev, 'fallback', '')
      // C7: every road that delivers a down makes a record (ruling 2026-11-19: a command's key down by the detached road too).
      if (down !== undefined && ev.attempts === 1) recordDown(ev, down, 'detached')
      if (ev.attempts === 1) startBarrier(ev)
    }
    // C9 (O4): unsettled detached-road deliveries are bounded (the router moves on at its deadline, and must not pile them up).
    const token = {}
    liveDetached.add(token)
    detachedOut = liveDetached.size
    if (detachedOut > 1) violate('C9', 'detached-outstanding', `${detachedOut} detached-road deliveries unsettled (${entry}); the contract allows one`)
    if (detachedHang) {
      return new Promise((resolve) => {
        hung.push(() => {
          liveDetached.delete(token)
          detachedOut = liveDetached.size
          resolve()
        })
      })
    }
    return new Promise((resolve) =>
      clock.set(
        () => {
          liveDetached.delete(token)
          detachedOut = liveDetached.size
          if (ev) endBarrier(ev)
          resolve()
          resolutionPoint()
        },
        [0, 5, 40][n % 3] as number,
        false
      )
    )
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
      const tag = commandSeq
      const code = (params as { code?: unknown }).code
      const ev = blank('cmd')
      ev.entry = `c:${tag}`
      ev.ref = params
      ev.rid = typeof code === 'string' && code !== '' ? `key:${code}` : ''
      hand(ev, () => void router.command('Input.dispatchKeyEvent', params, detachedRoad(`c:${tag}`, tag, ev.rid !== '' && ['rawKeyDown', 'keyDown'].includes(String((params as { type?: unknown }).type)) ? ev.rid : undefined)).then(() => {}, () => {}))
      return
    }
    for (const e of toElectronEvents(event, { width: 1000, height: 700 })) {
      if (e.type !== 'keyDown' && e.type !== 'keyUp' && e.type !== 'char') continue
      const info = webviewKeyInfo(e.keyCode)
      const ev = blank('key')
      ev.entry = `${keyEntry(e.type === 'keyDown' ? 'rawKeyDown' : e.type, info?.code)}:${modBits(e.modifiers)}`
      ev.release = e.type === 'keyUp'
      ev.rid = e.type === 'char' ? '' : `key:${info?.code ?? e.keyCode}`
      ev.ref = e
      hand(ev, () => router.input([e]))
    }
  }

  const attachFrame = (name: FrameName, ready: boolean): void => {
    const def = FRAMES.find((f) => f.name === name) as FrameDef
    const parent = sessionOf.get(def.parent)
    if (!attached || !parent || parent.ended || sessionOf.get(name)) return
    const s: Session = { id: `S:${name}#${++sessionSeq}`, doc: name, gen, ended: false, ready }
    sessions.set(s.id, s)
    sessionOf.set(name, s)
    router.frameAttached(s.id, `T-${s.id}`, parent.id, 'iframe')
    if (ready) router.frameReady(s.id)
  }

  const endSession = (s: Session, rejectPending: boolean): void => {
    s.ended = true
    if (pendingRefusal === s) pendingRefusal = undefined
    if (sessionOf.get(s.doc) === s) sessionOf.delete(s.doc)
    if (rejectPending) for (const c of commands) if (c.session === s.id && !c.answered) c.reject(new Error('gone'))
  }

  const detachFrame = (name: FrameName, rejectPending: boolean): void => {
    busy++
    try {
      detachFrameNow(name, rejectPending)
    } finally {
      busy--
    }
  }
  const detachFrameNow = (name: FrameName, rejectPending: boolean): void => {
    const s = sessionOf.get(name)
    if (!s || s.doc === 'page') return
    disturbed = true
    exitsSince = 0
    exitPending = false
    // The frame and every frame under it.
    const gone: Session[] = [s]
    for (let i = 0; i < gone.length; i++) {
      for (const f of FRAMES) {
        const child = sessionOf.get(f.name)
        if (f.parent === gone[i]!.doc && child && child.doc !== 'page') gone.push(child)
      }
    }
    router.frameDetached(s.id)
    for (const g of gone) {
      // C7: a frame going deletes its records; their ups are dropped (cause: frame gone).
      for (const rec of allRecs()) if (rec.session === g.id) endRecord(rec, 'frame gone')
      endSession(g, rejectPending)
    }
  }

  const lose = (rejectPending: boolean): void => {
    busy++
    try {
      loseNow(rejectPending)
    } finally {
      busy--
    }
  }
  const loseNow = (rejectPending: boolean): void => {
    if (!attached) return
    attached = false
    disturbed = true
    exitsSince = 0
    exitPending = false
    // Every session of this attachment refuses from now on (Electron's debugger).
    for (const c of commands) if (!c.answered && rejectPending) c.reject(new Error('Debugger is not attached'))
    for (const s of [...sessionOf.values()]) endSession(s, false)
    gen++
    // C7: an epoch change deletes all records; their ups are dropped (cause: epoch). C4: it ends the barrier.
    for (const rec of allRecs()) endRecord(rec, 'epoch')
    barrier = undefined
    router.reset()
  }

  const reattach = (): void => {
    if (attached) return
    attached = true
    newPage()
    for (const f of FRAME_NAMES) attachFrame(f, true)
  }

  /** The renderer goes (`router.rendererGone()`): the old detached calls never settle, a healthy one replaces it. */
  function rendererGoneNow(): void {
    // Ruling 2026-11-19 #8: account before the call (it pumps synchronously and may start a new delivery on the healthy renderer).
    // Ruling 2026-11-19 #9: the call stall is the renderer's too: rendererGone ends a hung call (no longer outstanding).
    callHung.length = 0
    liveCalls.clear()
    callsOut = 0
    hung.length = 0
    liveDetached.clear()
    detachedOut = 0
    detachedHang = false
    barrier = undefined
    // main's scripts: a top run of the renderer that went is no longer outstanding (ruling #9). Half of them never settle (the
    // adapter's "never settles for a page gone"), half are refused now (its "rejects").
    topHung.length = 0
    for (const run of [...liveTop]) {
      liveTop.delete(run)
      if (sRng() < 0.5) run.abandoned = true
      else clock.set(() => run.go(false), 0, false)
    }
    // Ruling 2026-11-19 #11: rendererGone is a full reset (everything lost() does): an epoch change (queued items dropped with cause
    // epoch, records deleted, session stalls cleared); the old sessions never answer and are not counted. A new renderer's page
    // session and frames follow when the protocol is attached.
    busy++
    try {
      for (const sess of [...sessionOf.values()]) endSession(sess, false)
      gen++
      for (const rec of allRecs()) endRecord(rec, 'epoch')
      router.rendererGone()
      if (attached) {
        newPage()
        for (const f of FRAME_NAMES) attachFrame(f, true)
      }
    } finally {
      busy--
    }
  }

  const play = async (action: Action): Promise<void> => {
    if (withTrace) trace.push(`t=${clock.now} ${JSON.stringify(action)}`)
    switch (action.a) {
      case 'move': {
        const t = nextTag()
        const ev = blank('move')
        ev.tag = t.tag
        ev.held = action.held
        ev.px = action.x
        ev.py = action.y
        const e: ElectronInputEvent = { type: 'mouseMove', x: action.x + t.fx, y: action.y + t.fy, modifiers: mods(action.held) }
        ev.ref = e
        hand(ev, () => router.input([e]))
        break
      }
      case 'down':
      case 'up': {
        const t = nextTag()
        const ev = blank(action.a)
        ev.tag = t.tag
        ev.release = action.a === 'up'
        ev.px = action.x
        ev.py = action.y
        ev.rid = `button:${action.button}`
        const event: ElectronInputEvent = { type: action.a === 'down' ? 'mouseDown' : 'mouseUp', x: action.x + t.fx, y: action.y + t.fy, button: action.button, clickCount: 1, modifiers: mods(action.held) }
        ev.ref = event
        hand(ev, () => router.input([event]))
        break
      }
      case 'wheel': {
        const t = nextTag()
        const ev = blank('wheel')
        ev.tag = t.tag
        ev.sum = action.dy
        ev.px = action.x
        ev.py = action.y
        const e: ElectronInputEvent = { type: 'mouseWheel', x: action.x + t.fx, y: action.y + t.fy, deltaX: 0, deltaY: -action.dy, modifiers: [] }
        ev.ref = e
        hand(ev, () => router.input([e]))
        break
      }
      case 'key':
        viewerKey({ kind: 'key', type: action.type, key: action.key, modifiers: action.mods })
        break
      case 'burst':
        for (let i = 0; i < action.n; i++) {
          // A key no other action presses, so a burst never presses a held key again.
          viewerKey({ kind: 'key', type: 'down', key: 'w', modifiers: [] })
          viewerKey({ kind: 'key', type: 'up', key: 'w', modifiers: [] })
        }
        break
      case 'text': {
        const text = `t${++textSeq}`
        const ev = blank('text')
        ev.entry = `t:${text}`
        hand(ev, () => void router.command('Input.insertText', { text }, detachedRoad(`t:${text}`, textSeq)).then(() => {}, () => {}))
        break
      }
      case 'call': {
        const n = ++callSeq
        const ev = blank('call')
        ev.entry = `call:${n}`
        ev.blocking = action.blocking
        const run = (): Promise<unknown> => {
          if (withTrace) trace.push(`  t=${clock.now} call ${n}`)
          deliver(ev, 'fallback', '')
          if (action.blocking) startBarrier(ev)
          // C5 / C9 (O4): a call counts as outstanding until it settles; one at most (a call past its deadline stalls its road like a command).
          liveCalls.add(ev)
          callsOut = liveCalls.size
          // A script's top run is a call on the same road (main's scripts).
          if (callsOut + liveTop.size > 1) violate('C9', 'calls-outstanding', `${callsOut + liveTop.size} calls outstanding (call ${n})`)
          if (action.ms < 0) {
            return new Promise((resolve) => {
              callHung.push(() => {
                liveCalls.delete(ev)
                callsOut = liveCalls.size
                endBarrier(ev)
                resolve(n)
              })
            })
          }
          return new Promise((resolve) =>
            clock.set(
              () => {
                liveCalls.delete(ev)
                callsOut = liveCalls.size
                endBarrier(ev)
                resolve(n)
                resolutionPoint()
              },
              action.ms,
              false
            )
          )
        }
        ev.ref = run
        hand(ev, () => void router.call(run, action.blocking).then(() => {}, () => {}))
        break
      }
      case 'advance':
        await clock.advance(action.ms)
        checkScriptBounds()
        return
      case 'mode':
        modes.set(action.doc, action.mode)
        break
      case 'qmode':
        qmodes.set(action.doc, action.mode)
        break
      case 'box': {
        layoutEpoch++
        const r = rects.get(action.frame) as [number, number, number, number]
        rects.set(action.frame, [Math.max(0, r[0] + action.dx), Math.max(0, r[1] + action.dy), r[2], r[3]])
        break
      }
      case 'scroll':
        layoutEpoch++
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
        lose(action.rejectPending)
        break
      case 'reset':
        break
      case 'reattach':
        reattach()
        break
      case 'hang':
        detachedHang = action.on
        break
      case 'faults':
        faultRate = action.rate
        break
      case 'hangrate':
        hangRate = action.rate
        break
      case 'bigframe':
        layoutEpoch++
        rects.set('A', [0, 200, 100, 100])
        rects.set('B', [4995, 4000, 1005, 2000])
        big.set('A', { bw: 10000, bh: 10000, skew: 0.4 })
        bigOn = true
        break
      case 'bigoff':
        for (const f of ['A', 'B'] as const) rects.set(f, [...(FRAMES.find((d) => d.name === f) as FrameDef).rect] as [number, number, number, number])
        big.clear()
        bigOn = false
        break
      case 'rendererGone':
        rendererGoneNow()
        break
      case 'arm':
        armed = { ...action }
        break
      case 'scriptAt':
      case 'scriptIn':
      case 'scriptInFocus': {
        const n = ++scriptSeq
        const kind: ScriptKind = action.a === 'scriptAt' ? 'at' : action.a === 'scriptIn' ? 'in' : 'focus'
        const ev = blank('script')
        ev.entry = `s:${n}`
        const epochArg = action.stale ? savedEpoch : undefined
        const sc: ScriptCall = { n, kind, ev, epoch: epochArg ?? gen, stale: epochArg !== undefined && epochArg !== gen, x: 0, y: 0, pushed: false, routerSettled: false, settled: false, tops: [], evals: [], malformed: false, released: false }
        if (action.a === 'scriptAt') {
          // Half a px off the grid: an owner's edge is whole px, and the router's affine map of a whole point can land a hair
          // under it (109.99999999999997), which the fake's floor puts on the other side (the oracle's own hit test is exact).
          sc.x = action.x + 0.5
          sc.y = action.y + 0.5
        }
        if (action.a === 'scriptIn') {
          sc.handle = action.pick < 0 || handles.length === 0 ? { obj: Object.freeze({}), src: 'forged' } : handles[handles.length - 1 - (action.pick % handles.length)]
        }
        scriptCalls.set(n, sc)
        const code = `#s${n}#`
        if (withTrace) trace.push(`  script#${n} (${kind})${sc.handle ? ` handle ${nameOf(sc.handle.src)}` : ''}${epochArg !== undefined ? ` epoch ${epochArg}` : ''}`)
        pendingScript = sc
        hand(ev, () => {
          const p =
            action.a === 'scriptAt'
              ? router.scriptAt(sc.x, sc.y, (x, y) => `${code}${x},${y}`, epochArg)
              : action.a === 'scriptIn'
                ? router.scriptIn((sc.handle as Handle).obj as unknown as ScriptFrame, code, epochArg)
                : router.scriptInFocus(code, epochArg)
          watchScript(sc, p)
        })
        pendingScript = undefined
        // C3: a script handed an attachment that ended is rejected and never queued (cause: an epoch change).
        if (!sc.pushed && sc.stale) ev.excuse = 'an epoch change'
        break
      }
      case 'focus':
        if (action.to === 'none') focusOf.delete(action.doc)
        else focusOf.set(action.doc, action.to)
        break
      case 'navigate': {
        const s = sessionOf.get(action.doc)
        if (s && !s.ended) replaceDoc(s, action.keep)
        break
      }
      case 'smode':
        smodes.set(action.doc, action.mode)
        break
      case 'topmode':
        topMode = action.mode
        break
      case 'sflip':
        sflipRate = action.rate
        break
      case 'epochmark':
        savedEpoch = router.inputEpoch()
        break
    }
    await clock.advance(0)
    checkScriptBounds()
    // C9 (O4): queued steps with nothing outstanding and no timer while the renderer is live are a stuck queue (a script's top run is a call).
    if (queueOf().length > 0 && liveAwaits().length === 0 && liveDetached.size === 0 && liveCalls.size === 0 && liveTop.size === 0 && clock.routerTimers() === 0 && !commands.some((c) => !c.answered && !c.detached && c.gen === gen)) {
      violate('C9', 'stuck-queue-live', `${queueOf().length} steps queued with nothing outstanding and no timer, after ${action.a}`)
    }
  }

  try {
    for (const action of script) await play(action)
    // Heal: every session answers from now on, every unanswered command is answered, the protocol
    // comes back, no more faults; then the viewer lets go of everything and moves once with no button held.
    faultRate = 0
    hangRate = 0
    if (!attached) reattach()
    for (const d of DOCS) {
      modes.set(d, 'fast')
      qmodes.set(d, 'fast')
    }
    detachedHang = false
    topMode = 'fast'
    sflipRate = 0
    for (const d of DOCS) smodes.set(d, 'ok')
    for (const h of hung.splice(0)) h()
    for (const c of commands) if (!c.answered) c.resolve({})
    await clock.advance(0)
    for (let i = 0; i < 4; i++) await clock.advance(1000)
    // Ruling 2026-11-19 #8: hung calls are released repeatedly until true quiescence: nothing hung, outstanding, queued or timed.
    let quiet = false
    for (let i = 0; i < 300 && !quiet; i++) {
      for (const h of callHung.splice(0)) h()
      for (const h of hung.splice(0)) h()
      for (const h of hungAwaits.splice(0)) h()
      for (const run of topHung.splice(0)) run.go(true)
      for (const c of commands) if (!c.answered) c.resolve({})
      await clock.advance(600)
      quiet = hungAwaits.length === 0 && liveAwaits().length === 0 && callHung.length === 0 && topHung.length === 0 && liveTop.size === 0 && hung.length === 0 && callsOut === 0 && detachedOut === 0 && queueOf().length === 0 && clock.routerTimers() === 0 && !commands.some((c) => !c.answered && !c.detached && c.gen === gen)
    }
    if (!quiet) violate('C9', 'stuck-queue', `quiescence never reached after 300 release rounds (calls ${callHung.length}/${callsOut}, detached ${hung.length}/${detachedOut}, queued ${queueOf().length}, timers ${clock.routerTimers()}, open commands ${commands.filter((c) => !c.answered && !c.detached && c.gen === gen).length})`)
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
    // C9 (O4): with the renderer live nothing stays queued with no timer and no outstanding delivery.
    if (queueOf().length > 0) violate('C9', 'stuck-queue', `${queueOf().length} steps still queued at quiescence`)
    // C9: no timers left, nothing unanswered.
    if (clock.routerTimers() > 0) violate('C9', 'timers-left', `${clock.routerTimers()} router timers pending`)
    const unanswered = commands.filter((c) => !c.answered && c.gen === gen && !c.detached && !(docOfSession(c.session)?.ended ?? true))
    if (unanswered.length > 0) violate('C5', 'unanswered', `${unanswered.length} commands still unanswered`)
    // C7: every live button record owing its release got it (the last move held no button).
    for (const rec of allRecs()) if (rec.owed) violate('C7', 'owed-release-missing', `${rec.id} (session ${rec.session || 'page'}) still live after the last no-button move`)
    // C3: a viewer event never sent is a violation unless its own named excuse says why.
    for (const ev of evs) {
      if (ev.attempts > 0) continue
      const excuse = ev.excuse ?? (ev.droppedWithDown ? 'its key down was refused' : ev.capDropped ? 'the cap' : ev.epoch < gen ? 'an epoch change' : undefined)
      if (excuse !== undefined) continue
      // C3: move coalescing: a move superseded by a later move (named: the later move handed in).
      if (ev.kind === 'move' && evs.some((e) => e.kind === 'move' && e.n > ev.n)) continue
      // C7, ruling 2026-11-19: an up with no live record in the model at the end is dropped (cause: no record).
      if (ev.release && !allRecs().some((r) => r.id === ev.rid)) continue
      // The detached-road press whose up never came is C7's own line (the up must reach the page after a reattach).
      const detachedUp = ev.release && ev.recAtHandIn === 'detached'
      violate(detachedUp ? 'C7' : 'C3', detachedUp ? 'detached-road-up-lost' : `lost-${ev.kind}`, `${describe(ev)} was never sent and has no excuse${ev.recAtHandIn !== undefined ? ` (record at ${ev.recAtHandIn || 'page'})` : ''}`)
    }
    // C2: a refusal the router acted on is logged, once.
    if (pendingRefusal && !pendingRefusal.ended) refusalSeen = true
    if (refusalSeen && refusalLogs === 0) violate('C2', 'refusal-unlogged', 'a session refused input the router acted on, and it logged no refusal')
    if (refusalLogs > refusedAnswers) violate('C2', 'refusal-logged-twice', `${refusalLogs} refusal logs for ${refusedAnswers} refused answers`)
    // C9: bounded by live sessions and live press records.
    const live = new Set([...sessions.values()].filter((s) => !s.ended).map((s) => s.id))
    for (const ref of sessionRefs(router)) if (!live.has(ref)) violate('C9', 'dead-session-held', `the router still holds ${ref}`)
    for (const [name, size] of collectionSizes(router)) if (size > live.size + allRecs().length + 4) violate('C9', 'unbounded', `${name} holds ${size} with ${live.size} live frames and ${allRecs().length} live records`)
    if (unhandled.length > 0) violate('C9', 'unhandled-rejection', String(unhandled[0]))
    // O4: every script settled: dropped, answered or rejected; but one whose top run's renderer went and never answered (nearest
    // ruling 2026-11-19 #9: that call is the renderer's, and the adapter may never settle for a page gone).
    for (const sc of scriptCalls.values()) {
      if (sc.settled || sc.tops.some((t) => t.abandoned)) continue
      violate('O4', 'script-never-settled', `script#${sc.n} (${sc.kind}) ${sc.started === undefined ? (sc.pushed ? 'queued and never run' : 'never queued') : `started at t=${sc.started}`} has not settled at quiescence`)
    }
    // O4: the handles' map (`scriptFrames`) keeps no frame alive: a WeakMap (collectionSizes cannot see one, so its kind is checked).
    if (scriptsOn && !((router as unknown as { scriptFrames?: unknown }).scriptFrames instanceof WeakMap)) violate('O4', 'handles-held', 'the router keeps its script handles in something other than a WeakMap')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  return { violations, trace, outcomes }
}

function modBits(m: readonly InputModifier[]): number {
  let bits = 0
  if (m.includes('alt')) bits |= 1
  if (m.includes('control')) bits |= 2
  if (m.includes('meta')) bits |= 4
  if (m.includes('shift')) bits |= 8
  return bits
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
      const started = Date.now()
      const failures = new Map<string, { seed: number; detail: string; count: number }>()
      const stats = { frame: 0, top: 0, undefined: 0, rejected: 0 }
      for (const seed of seeds) {
        // FUZZ_SCRIPT: one script of actions (JSON) instead of the seed's, to try a case by hand.
        const script = process.env.FUZZ_SCRIPT !== undefined ? (JSON.parse(process.env.FUZZ_SCRIPT) as Action[]) : makeScript(seed)
        const { violations, trace, outcomes } = await runScript(seed, script, process.env.FUZZ_SCRIPT !== undefined)
        if (process.env.FUZZ_SCRIPT !== undefined) console.log(trace.join('\n'))
        for (const k of Object.keys(stats) as Array<keyof typeof stats>) stats[k] += outcomes[k]
        const once = new Set<string>()
        for (const v of violations) {
          if (once.has(v.id)) continue
          once.add(v.id)
          const f = failures.get(v.id)
          if (f) f.count++
          else failures.set(v.id, { seed, detail: v.detail, count: 1 })
        }
      }
      if (process.env.FUZZ_STATS !== undefined) console.log(`main's scripts settled: ${JSON.stringify(stats)}`)
      if (failures.size > 0) {
        const lines: string[] = []
        for (const [id, f] of failures) {
          lines.push(`${id}: ${f.count} of ${seeds.length} seeds (loop ${Date.now() - started} ms), first seed ${f.seed}: ${f.detail}`)
        }
        // The first failing class's smallest script and its trace.
        const chosen = process.env.FUZZ_CLASS !== undefined ? [...failures].find(([k]) => k === process.env.FUZZ_CLASS) : undefined
        const [id, first] = (chosen ?? [...failures][0]) as [string, { seed: number }]
        const small = process.env.FUZZ_SCRIPT !== undefined ? (JSON.parse(process.env.FUZZ_SCRIPT) as Action[]) : await shrink(first.seed, makeScript(first.seed), id)
        const { violations, trace } = await runScript(first.seed, small, true)
        lines.push('', `minimal script for ${id} (seed ${first.seed}, ${small.length} actions):`, ...small.map((a) => `  ${JSON.stringify(a)}`))
        lines.push('', 'its trace (sends, answers, fallbacks):', ...trace.slice(-120), '', ...violations.map((v) => v.detail))
        throw new Error(lines.join('\n'))
      }
    },
    Math.max(60_000, (ONE_SEED === undefined ? SEEDS : 1) * 30)
  )
})
