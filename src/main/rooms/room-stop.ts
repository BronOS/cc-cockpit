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
//   2. `ccc` sends `hook.ack` with the id on the same connection: `ack(tabId, ackId)` confirms it (the delivery
//      counts) and main answers `{ acked: true }`. Only then does `ccc` print the block (cli/client.ts runHook). The
//      order is what makes the next step safe: an ack main never served proves the block was never printed.
//   3. The connection closes with the block still unacked (`ccc` gave up on a slow reply, died, or got a refusal):
//      `closedUnacked` drops it and the hook handler applies the plain Stop (SessionRegistry.unblockStop: `waiting`,
//      the gate's head delivered), since Claude did stop. Only while the blocked Stop is still the tab's last event.
//   4. An ack main served whose print then failed (stdout closed: EPIPE arrives after the write) or was cut by the
//      deadline leaves the tab `working` with Claude stopped: the safe direction. `waiting` while Claude goes on would
//      let the gate (or a plugin's send) paste into a running turn, where the Enter can answer a permission dialog:
//      the one thing the app must never do (CLAUDE.md). Wrongly `working` only hides a tab at its prompt until the
//      person's next prompt (UserPromptSubmit, then its Stop), the same recovery as a turn interrupted with Esc, which
//      fires no Stop either; an idle_prompt Notification does not promote `working` (status-reducer.ts), for the
//      same reason. The messages stay queued: nothing is lost.
//   5. No ack within ACK_TIMEOUT_MS on a connection that stays open: logged only, the tab stays `working`. The block
//      still counts toward the auto-pause once there is evidence it reached Claude: a late ack, or the next Stop saying
//      it follows a block.
//
// Who may be continued. Only a member with messages waiting, whose tab is untyped or carries the person's mark for
// this room and name, in a room that is neither paused nor ended. A typed tab without the mark is never blocked: a
// member that read a hostile page must not continue the person's own turn. The draft bit does not hold a Stop
// pointer (the box is Claude's while it works; it only holds the gate's paste).
//
// Loops. Claude Code overrides a Stop hook after 8 consecutive blocks (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP, read from the
// 2.1.325 binary). Main stays under it: at most MAX_STOP_BLOCKS_IN_A_ROW blocks in a row per tab, counted while the
// payload's `stop_hook_active` says the Stop follows a block. At the cap the tab is held behind the badge until the
// person's next prompt in it (SessionRegistry.onPersonPrompt: a UserPromptSubmit with the person's input in the box,
// not a mere keystroke: a key that answers a permission dialog, or a draft typed while Claude loops, does not mean the
// person looked at the loop): no Stop pointer at all until then, whatever `stop_hook_active` says. And a room pauses
// itself after AUTO_PAUSE_DELIVERIES pointers (acked Stop blocks and the gate's pastes) with no input from the person
// in any member tab (any keystroke of theirs: the design's "input"); the person resumes it.
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
 * How long a block waits for `ccc`'s ack before a log line. `ccc hook Stop` has 2 s in all (cli/client.ts
 * STOP_HOOK_BUDGET_MS, after `ccc` started) and Claude Code kills the hook at 5 s (hooks-file.ts HOOK_TIMEOUT_SECONDS),
 * so an ack later than this means a `ccc` that is stuck with its connection open; its close then undoes the block.
 */
export const ACK_TIMEOUT_MS = 5_000

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
  /** Undefined once the ack timeout fired: the block stays pending, so a late ack or the next Stop can count it. */
  timer: ReturnType<typeof setTimeout> | undefined
}

export class RoomStop {
  /** Blocks in a row per tab (reset when a Stop does not follow a block, and on the person's prompt). */
  private readonly streaks = new Map<string, number>()
  /** Tabs that reached the cap: no Stop pointer until the person's next prompt in the tab. */
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
      // Held behind the badge until the person's next prompt (personPrompt): not even a fresh run gets a block.
      this.capped.add(tabId)
      this.streaks.delete(tabId)
      this.warn(`rooms: tab ${tabId} had ${MAX_STOP_BLOCKS_IN_A_ROW} Stop pointers in a row; held until the person's next prompt`)
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
   * True when it did; false for no pending block (a later Stop ended the wait), another id, or one already acked. A
   * late ack (after the timeout's log line) still confirms: the block is pending until the next Stop. The delivery
   * counts toward the room's auto-pause.
   */
  ack(tabId: string, ackId: unknown): boolean {
    const p = this.pending.get(tabId)
    if (!p || typeof ackId !== 'string' || p.ackId !== ackId) return false
    if (p.timer !== undefined) clearTimeout(p.timer)
    this.pending.delete(tabId)
    this.delivered(p.roomId)
    return true
  }

  /**
   * The connection `ccc hook Stop` answered on closed (main's `peerGone`), for the block `ackId`. `ccc` prints the
   * block only after main confirmed its ack (cli/client.ts runHook), so a block still pending here was never printed:
   * Claude stopped. Drops it (no delivery counted) and returns true, and the hook handler then applies the plain
   * Stop (SessionRegistry.unblockStop). False for an acked block, another id, or none: the tab is left as it is.
   */
  closedUnacked(tabId: string, ackId: string): boolean {
    const p = this.pending.get(tabId)
    if (!p || p.ackId !== ackId) return false
    this.dropPending(tabId)
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
   * The person's input in a tab (SessionRegistry.onPersonInput, any keystroke of theirs): its room's auto-pause count
   * starts over. The tab's run of blocks and its cap stay: those end only at the person's prompt (personPrompt).
   */
  personInput(tabId: string): void {
    const member = this.deps.rooms.memberOf(tabId)
    if (member) this.deliveries.delete(member.roomId)
  }

  /**
   * The person submitted a prompt in a tab (SessionRegistry.onPersonPrompt): the tab's run of blocks and its cap end
   * (design-rooms.md §2 "Loops": held "until the person's next prompt").
   */
  personPrompt(tabId: string): void {
    this.streaks.delete(tabId)
    this.capped.delete(tabId)
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
    for (const p of this.pending.values()) if (p.timer !== undefined) clearTimeout(p.timer)
    this.pending.clear()
  }

  private timedOut(tabId: string, ackId: string): void {
    const p = this.pending.get(tabId)
    if (!p || p.ackId !== ackId) return
    // Log only: the tab stays `working` (the header, step 5). The block stays pending without its timer, so a late
    // ack or the next Stop can still count it, and the connection's close can still undo it (step 3).
    p.timer = undefined
    this.warn(`rooms: no ack for the Stop pointer of tab ${tabId} in ${this.ackTimeout} ms; the tab stays working until its next hook or the hook's connection closes`)
  }

  private dropPending(tabId: string): void {
    const p = this.pending.get(tabId)
    if (!p) return
    if (p.timer !== undefined) clearTimeout(p.timer)
    this.pending.delete(tabId)
  }

  private marked(tabId: string, roomId: string, name: string): boolean {
    const r = this.deps.tabRoom(tabId)
    // Bound to (tab, room) and the member's name, as in room-delivery.ts: a mark given in another room is no mark.
    return r !== undefined && r.id === roomId && r.name === name && r.mark === true
  }
}
