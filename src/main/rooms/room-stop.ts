// The Stop pointer (design-rooms.md §2 "The Stop pointer", "Loops"): whether main answers a member tab's Stop hook
// with `{"decision":"block","reason":"<pointer>"}`, the ack that confirms `ccc` printed it, the per-tab cap on blocks
// in a row and the room's auto-pause. Pure logic over injected parts (the room registry, the session registry, the
// tab manager's mark) plus one timer per pending block; no Electron. The room service (Task 8) wires it; the hook
// reply and the ack travel over the socket (Task 7).
//
// The flow, all on main's side:
//   1. `ccc hook Stop` reaches the hook handler; `stop(tabId, payload)` decides. A block carries the fixed pointer
//      (room-delivery.ts pointerText, the count only) and a fresh ack id; the handler applies the Stop with that id
//      (status-reducer.ts: a blocked Stop leaves the tab `working`, send-gate.ts: the gate delivers no head) and
//      answers `{ block, ackId }`.
//   2. `ccc` prints the block and sends `hook.ack` with the id: `ack(tabId, ackId)` confirms it (the delivery counts).
//   3. No ack within ACK_TIMEOUT_MS: the block counts as never sent. The Stop is applied as a plain one
//      (SessionRegistry.unblockStop: `waiting`, the gate delivers its head), unless the turn already went on (a later
//      hook cleared the entry's block). The messages stay queued: at worst the pointer comes again at the next Stop.
//
// Who may be continued. Only a member with messages waiting, whose tab is untyped or carries the person's mark for
// this room and name, in a room that is neither paused nor ended. A typed tab without the mark is never blocked: a
// member that read a hostile page must not continue the person's own turn. The draft bit does not hold a Stop
// pointer (the box is Claude's while it works; it only holds the gate's paste).
//
// Loops. Claude Code overrides a Stop hook after 8 consecutive blocks (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP, read from the
// 2.1.325 binary). Main stays under it: at most MAX_STOP_BLOCKS_IN_A_ROW blocks in a row per tab, counted while the
// payload's `stop_hook_active` says the Stop follows a block. At the cap the tab is held behind the badge until the
// person's next input in it: no Stop pointer at all until then, whatever `stop_hook_active` says. And a room pauses
// itself after AUTO_PAUSE_DELIVERIES pointers (acked Stop blocks and the gate's pastes) with no input from the person
// in any member tab; the person resumes it.
import { randomBytes } from 'node:crypto'
import { isPlainObject } from '../../shared/guards'
import type { TabRoom } from '../../shared/tab-room'
import type { SessionEntry } from '../sessions/status-reducer'
import { warnLog } from '../warn-log'
import { pointerText } from './room-delivery'
import type { RoomRegistry } from './room-registry'

/** Blocks in a row per tab (design-rooms.md §2 "Loops"): under Claude Code's own cap of 8. */
export const MAX_STOP_BLOCKS_IN_A_ROW = 5
/** Pointers delivered in a room with no input from the person in any member tab before the room pauses itself. */
export const AUTO_PAUSE_DELIVERIES = 100
/**
 * How long a block waits for `ccc`'s ack. The hook's whole budget is 500 ms (cli/client.ts HOOK_BUDGET_MS, Electron's
 * start included), so an ack later than this means `ccc` died between the reply and the ack, or never printed.
 */
export const ACK_TIMEOUT_MS = 2_000

/** What the hook handler answers a blocked Stop with (`ccc` prints `{"decision":"block","reason":<block>}`). */
export interface StopBlock {
  /** The pointer, fixed text with the count only: never room text. */
  block: string
  /** The id `ccc` sends back in `hook.ack`. */
  ackId: string
}

export interface RoomStopDeps {
  rooms: Pick<RoomRegistry, 'memberOf' | 'peek' | 'held' | 'pause'>
  sessions: {
    get(tabId: string): SessionEntry | undefined
    /** SessionRegistry.unblockStop: the plain Stop for a block that got no ack, if the turn did not go on. */
    unblockStop(tabId: string, ackId: string): boolean
  }
  /** The tab's membership and the person's mark as the tab manager keeps it (TabManager.roomOf). */
  tabRoom(tabId: string): TabRoom | undefined
  /** Tests: a short timeout. */
  ackTimeoutMs?: number
  /** Tests: fixed ack ids. */
  newAckId?: () => string
  log?: (message: string) => void
}

interface PendingBlock {
  ackId: string
  roomId: string
  timer: ReturnType<typeof setTimeout>
}

export class RoomStop {
  /** Blocks in a row per tab (reset when a Stop does not follow a block, and on the person's input). */
  private readonly streaks = new Map<string, number>()
  /** Tabs that reached the cap: no Stop pointer until the person's next input in the tab. */
  private readonly capped = new Set<string>()
  /** The block each tab waits to have acked (at most one: a new Stop replaces it). */
  private readonly pending = new Map<string, PendingBlock>()
  /** Pointers delivered per room since the person's last input in one of its member tabs. */
  private readonly deliveries = new Map<string, number>()
  private readonly ackTimeout: number
  private readonly newAckId: () => string
  private readonly warn: (message: string) => void

  constructor(private readonly deps: RoomStopDeps) {
    this.ackTimeout = deps.ackTimeoutMs ?? ACK_TIMEOUT_MS
    this.newAckId = deps.newAckId ?? (() => randomBytes(16).toString('hex'))
    this.warn = deps.log ?? warnLog
  }

  /**
   * A Stop hook from `tabId` (the tab main resolved from the token). Returns the block to answer with, or undefined
   * for a plain Stop. Synchronous, before the registry applies the Stop (the hook handler passes the block's ack id
   * along): a block is recorded here, with its ack timer running, and the caller must apply the Stop as blocked.
   */
  stop(tabId: string, payload: unknown): StopBlock | undefined {
    // `stop_hook_active` false: this Stop does not follow a block, so the run starts over. Only an explicit false: a
    // payload `ccc` could not read (null) keeps the run, which only ever blocks less.
    const active = isPlainObject(payload) ? payload.stop_hook_active : undefined
    // Any Stop ends the wait for an earlier block's ack: the turn it continued has stopped again. One that says it
    // follows a block shows that block reached Claude though its ack was lost, so it still counts toward the
    // auto-pause (a `ccc` that never acks must not keep a room from pausing).
    const earlier = this.pending.get(tabId)
    this.dropPending(tabId)
    if (earlier && active === true) this.delivered(earlier.roomId)
    if (active === false) this.streaks.delete(tabId)

    const member = this.deps.rooms.memberOf(tabId)
    if (!member) return undefined
    const room = this.deps.rooms.peek(member.roomId)
    if (!room || room.endedAt !== undefined || room.paused) return undefined
    const held = this.deps.rooms.held(room.id, member.name)
    if (held === 0) return undefined
    const entry = this.deps.sessions.get(tabId)
    // No entry, a dead process, or a paste of ours still waiting for its UserPromptSubmit (it will be the next
    // prompt: continuing the turn now would only put the pointer in twice).
    if (!entry || entry.status === 'ended' || entry.exitCode !== undefined || entry.delivering) return undefined
    if (entry.typed && !this.marked(tabId, room.id, member.name)) return undefined
    if (this.capped.has(tabId)) return undefined
    const streak = this.streaks.get(tabId) ?? 0
    if (streak >= MAX_STOP_BLOCKS_IN_A_ROW) {
      // Held behind the badge until the person's next input (personInput): not even a fresh run gets a block.
      this.capped.add(tabId)
      this.streaks.delete(tabId)
      this.warn(`rooms: tab ${tabId} had ${MAX_STOP_BLOCKS_IN_A_ROW} Stop pointers in a row; held until the person's input`)
      return undefined
    }
    this.streaks.set(tabId, streak + 1)
    const ackId = this.newAckId()
    const timer = setTimeout(() => this.timedOut(tabId, ackId), this.ackTimeout)
    timer.unref?.()
    this.pending.set(tabId, { ackId, roomId: room.id, timer })
    return { block: pointerText(held), ackId }
  }

  /**
   * `hook.ack` from `tabId` (the token's tab, Task 7): confirms only the block this tab is waiting on, with its id.
   * True when it did; false for no pending block, another id, or one that already timed out. The delivery counts
   * toward the room's auto-pause.
   */
  ack(tabId: string, ackId: unknown): boolean {
    const p = this.pending.get(tabId)
    if (!p || typeof ackId !== 'string' || p.ackId !== ackId) return false
    clearTimeout(p.timer)
    this.pending.delete(tabId)
    this.delivered(p.roomId)
    return true
  }

  /**
   * A pointer went in (an acked Stop block, or the gate's paste: room-delivery.ts `delivered`). At
   * AUTO_PAUSE_DELIVERIES with no input from the person in the room, the room pauses itself (the registry logs the
   * auto-pause) and the count starts over for after the person's resume.
   */
  delivered(roomId: string): void {
    const n = (this.deliveries.get(roomId) ?? 0) + 1
    if (n < AUTO_PAUSE_DELIVERIES) {
      this.deliveries.set(roomId, n)
      return
    }
    this.deliveries.delete(roomId)
    try {
      this.deps.rooms.pause(roomId, { auto: true })
    } catch (err) {
      // The room went away meanwhile: nothing left to pause.
      this.warn(`rooms: could not auto-pause ${roomId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * The person's input in a tab (SessionRegistry.onPersonInput): the tab's run of blocks and its cap end, and its
   * room's auto-pause count starts over.
   */
  personInput(tabId: string): void {
    this.streaks.delete(tabId)
    this.capped.delete(tabId)
    const member = this.deps.rooms.memberOf(tabId)
    if (member) this.deliveries.delete(member.roomId)
  }

  /** The tab closed: forget its run, cap and pending block. */
  tabGone(tabId: string): void {
    this.dropPending(tabId)
    this.streaks.delete(tabId)
    this.capped.delete(tabId)
  }

  /** The room ended or was deleted: forget its count. */
  roomGone(roomId: string): void {
    this.deliveries.delete(roomId)
  }

  /** App quit: every ack timer stops. */
  dispose(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer)
    this.pending.clear()
  }

  private timedOut(tabId: string, ackId: string): void {
    const p = this.pending.get(tabId)
    if (!p || p.ackId !== ackId) return
    this.pending.delete(tabId)
    // Never acked: the block counts as not sent. A Stop that leaves the turn running would hide a tab waiting at its
    // prompt, so the plain Stop is applied now, unless the session has said something since (the turn did go on).
    const applied = this.deps.sessions.unblockStop(tabId, ackId)
    this.warn(`rooms: no ack for the Stop pointer of tab ${tabId} in ${this.ackTimeout} ms${applied ? '; applied as a plain Stop' : ''}`)
  }

  private dropPending(tabId: string): void {
    const p = this.pending.get(tabId)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(tabId)
  }

  private marked(tabId: string, roomId: string, name: string): boolean {
    const r = this.deps.tabRoom(tabId)
    // Bound to (tab, room) and the member's name, as in room-delivery.ts: a mark given in another room is no mark.
    return r !== undefined && r.id === roomId && r.name === name && r.mark === true
  }
}
