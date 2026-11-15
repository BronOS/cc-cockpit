// Room message delivery (design-rooms.md §2 "Pull, not push", "The mark"): who gets the fixed pointer through the send
// gate, who is held behind the badge, the send caps, and the room fields of SessionInfo. Pure logic over injected
// parts (the room registry, the session registry, the tab manager's mark), no Electron: the room service (Task 8)
// wires it. Every identity arrives resolved by main: the sender's name from its tab token or `plugin` for the owner.
//
// The room's queue (RoomRegistry) is the only queue for room messages. The gate never holds one: it gets one pointer
// item (`N room messages waiting: run ccc room read`, fixed text, no message content), pasted at once when the tab
// qualifies and may take text, otherwise nothing (send-gate.ts sendNow). So a takeover, a pause or a draft can never
// leave a pointer waiting to be pasted later; the messages just stay held until a later chance decides again:
//   - an untyped member, or one with the person's mark and no draft, waiting for input: the pointer is pasted;
//   - a typed member without the mark gets nothing from here or from the Stop hook: its messages are held and the
//     badge shows the count; the person's click on it (deliverHeld) pastes the pointer as their own act;
//   - a paused room, a member with no tab (after a quit, until restore) or a tab that is not waiting: held.
// Delivered means the pointer went in; the messages leave the queue only through the member's own `ccc room read`.
import { maySend } from '../sessions/send-gate'
import type { SessionEntry, SessionRoom, TabStatus } from '../sessions/status-reducer'
import { warnLog } from '../warn-log'
import type { DeliverHeldAnswer, TabRoom } from '../../shared/tab-room'
import { isRoomName } from '../../shared/room-names'
import { pointerText } from '../../shared/room-pointer'
import { DEFAULT_PLUGIN_LIMITS } from '../../shared/plugin-limits'
import { RoomError, isMessageText, type RoomRecord, type RoomRegistry } from './room-registry'

/**
 * The person-settable room send caps (design-rooms.md §6), per plugin. `all` counts one send per recipient queued
 * against both (at least one per send). Read through `limits(pluginId)` (main/plugins/plugin-limits.ts, the person's
 * per-plugin override) on every send; the defaults without it.
 */
export interface RoomSendLimits {
  /** Sends a minute by one member (the owner's `plugin` sends count only against the room's cap). */
  roomSendsPerMember: number
  /** Sends a minute in one room, every sender together. */
  roomSendsPerRoom: number
}

export const DEFAULT_ROOM_SEND_LIMITS: Readonly<RoomSendLimits> = Object.freeze({
  roomSendsPerMember: DEFAULT_PLUGIN_LIMITS.roomSendsPerMember,
  roomSendsPerRoom: DEFAULT_PLUGIN_LIMITS.roomSendsPerRoom
})

/** The window both caps count over. */
export const ROOM_SEND_WINDOW_MS = 60_000

// The pointer (design-rooms.md §2): fixed text, the count only. The Stop hook's block reason is the same text (Task 6);
// it lives in src/shared because `ccc hook Stop` checks a reply against it (Task 7).
export { pointerText }

/** Why a message waits in the room's queue instead of a pointer going in now. */
export type HeldWhy =
  /** The room is paused (the person in the room view, the auto-pause, or a restore). */
  | 'paused'
  /** The member has no tab now (its window or the app went away; a restore binds it again). */
  | 'no-tab'
  /** The person typed in the tab and gave it no mark: the badge shows the count, their click delivers. */
  | 'typed'
  /** The person's mark, but they have input in the box since the last prompt (the draft bit). */
  | 'draft'
  /** The tab is not waiting for input (working, a permission dialog, starting, a paste in flight, ended). */
  | 'not-waiting'

/** What happened for one recipient. */
export type RecipientAnswer =
  | { to: string; path: 'delivered' }
  | { to: string; path: 'held'; why: HeldWhy; status?: TabStatus }
  /** No member by that name (never was, left or was removed): nothing was queued. */
  | { to: string; path: 'gone' }
  /** The recipient's queue is full (RoomRegistry caps): nothing was queued for it. */
  | { to: string; path: 'refused'; why: string }

/** The decision for one recipient, before the gate's own rule. */
export type DeliveryDecision = { pointer: true } | { pointer: false; why: HeldWhy; status?: TabStatus }

/**
 * Whether one member gets the pointer now (design-rooms.md §2). `entry` is the bound tab's session entry (undefined:
 * no tab); `mark` is the person's mark for THIS room and name (the caller matched them). Pure, so the rule is tested
 * on its own; the gate still has the last word (maySend again at the paste).
 */
export function decide(input: { paused: boolean; entry: SessionEntry | undefined; mark: boolean }): DeliveryDecision {
  const { paused, entry, mark } = input
  if (paused) return { pointer: false, why: 'paused' }
  if (entry === undefined) return { pointer: false, why: 'no-tab' }
  // `typed` is the person's: without their mark a room member that read a hostile page must not continue their turn.
  if (entry.typed && !mark) return { pointer: false, why: 'typed' }
  // Untyped means no input from the person ever, so no draft either; a restored member is typed with no draft.
  if (entry.typed && entry.draft === true) return { pointer: false, why: 'draft' }
  if (!maySend(entry)) return { pointer: false, why: 'not-waiting', status: entry.status }
  return { pointer: true }
}

export interface RoomDeliveryDeps {
  rooms: Pick<RoomRegistry, 'peek' | 'held' | 'boundTab' | 'enqueue' | 'logOf' | 'memberOf'>
  sessions: {
    get(tabId: string): SessionEntry | undefined
    /** SessionRegistry.sendPointer: pasted now or not at all (send-gate.ts sendNow). */
    sendPointer(tabId: string, text: string): boolean
    /** SessionRegistry.setRoom: SessionInfo.room and held. */
    setRoom(tabId: string, room: (SessionRoom & { held: number }) | null): boolean
  }
  /** The tab's membership and the person's mark as the tab manager keeps it (TabManager.roomOf, the tab's own project). */
  tabRoom(tabId: string): TabRoom | undefined
  /** The plugin's room send caps, read on every send (PluginLimitsStore.limits: the person's override). Defaults when absent. */
  limits?(pluginId: string): RoomSendLimits
  /**
   * A pointer went in through the gate on main's own decision (offer), not the person's badge click: the room stop
   * counts it toward the room's auto-pause (room-stop.ts delivered).
   */
  delivered?(roomId: string): void
  now?: () => number
  log?: (message: string) => void
}

export class RoomDelivery {
  /** Send times in the current window, per room (`r:<id>`) and per member sender (`m:<id>:<name>`). */
  private readonly sends = new Map<string, number[]>()
  private readonly now: () => number
  private readonly warn: (message: string) => void

  constructor(private readonly deps: RoomDeliveryDeps) {
    this.now = deps.now ?? Date.now
    this.warn = deps.log ?? warnLog
  }

  /**
   * A message from `from` (a member name main resolved from the caller's tab, or `plugin` for the owner's
   * `ctx.rooms.send`) to one member or `all` (every member but the sender). Queued in the room for each recipient,
   * then each is offered the pointer. One answer per recipient; one log line for the send, its text and every
   * recipient's path. Throws a RoomError for an unknown or ended room, a sender that is not a member, a bad name or
   * text, a send to oneself, and a send cap (naming the cap and its value); nothing is queued then. Any other failure
   * to queue (a failed room.json save) is rethrown after the recipients before it were queued and offered: the log
   * line then names them and the one that failed.
   *
   * The caps are checked for every recipient up front (a send that could go over is refused whole) and charged for
   * the recipients actually queued, at least one per logged send: a send to a gone name or to full queues queues
   * nothing but still writes a log line with its text, so it must count, or a member could loop it and push the
   * room's real record out through the log's trim.
   */
  send(roomId: string, from: string, to: unknown, text: unknown): RecipientAnswer[] {
    const room = this.deps.rooms.peek(roomId)
    if (!room) throw new RoomError('not-found', 'no such room')
    if (room.endedAt !== undefined) throw new RoomError('ended', 'the room has ended')
    if (from !== 'plugin' && !Object.hasOwn(room.members, from)) throw new RoomError('not-found', 'the sender is not a member')
    if (typeof to !== 'string' || (to !== 'all' && !isRoomName(to))) throw new RoomError('invalid', 'send to a member name or all')
    if (to === from) throw new RoomError('invalid', 'a member cannot send to itself')
    if (!isMessageText(text) || text.trim() === '') {
      throw new RoomError('invalid', 'a message is non-empty text of at most 20000 characters (longer goes in a doc)')
    }
    if (to !== 'all' && !Object.hasOwn(room.members, to)) {
      this.charge(this.window(room, from, 1), 1)
      const answer: RecipientAnswer[] = [{ to, path: 'gone' }]
      this.logSend(room.id, from, to, text, answer)
      return answer
    }
    const recipients = to === 'all' ? Object.keys(room.members).filter((name) => name !== from) : [to]
    if (recipients.length === 0) return []
    const window = this.window(room, from, recipients.length)

    const answers: RecipientAnswer[] = []
    let queued = 0
    for (const name of recipients) {
      try {
        this.deps.rooms.enqueue(room.id, name, { from, text })
      } catch (err) {
        // A full queue is the recipient's (it is not reading); the others still get the message.
        if (err instanceof RoomError && err.code === 'limit') {
          answers.push({ to: name, path: 'refused', why: err.message })
          continue
        }
        // The ones before it are queued and were offered the pointer: count and record them before giving up.
        this.charge(window, Math.max(queued, 1))
        this.log(room.id, 'send', { from, to, text, delivery: answers, failed: name })
        throw err
      }
      queued++
      // Just queued, so something waits: offer answers for it.
      answers.push(this.offer(room.id, name) ?? { to: name, path: 'held', why: 'not-waiting' })
    }
    this.charge(window, Math.max(queued, 1))
    this.logSend(room.id, from, to, text, answers)
    return answers
  }

  /**
   * Offer one member the pointer now (after a send; the room service also calls it when a room resumes or a restored
   * tab is bound). Undefined when nothing waits for the member (no pointer to give). Also mirrors the member's held
   * count into SessionInfo.
   */
  offer(roomId: string, name: string): RecipientAnswer | undefined {
    const room = this.deps.rooms.peek(roomId)
    if (!room || room.endedAt !== undefined || !Object.hasOwn(room.members, name)) return { to: name, path: 'gone' }
    const tabId = this.deps.rooms.boundTab(room.id, name)
    const held = this.deps.rooms.held(room.id, name)
    if (tabId !== undefined) this.mirror(tabId, room, name, held)
    if (held === 0) return undefined
    const entry = tabId === undefined ? undefined : this.deps.sessions.get(tabId)
    const decision = decide({ paused: room.paused, entry, mark: tabId !== undefined && this.marked(tabId, room.id, name) })
    if (!decision.pointer || tabId === undefined) {
      return decision.pointer ? heldAnswer(name, 'no-tab', undefined) : heldAnswer(name, decision.why, decision.status)
    }
    // The gate re-checks at the paste (a failed PTY write is also a false): held, the next chance decides again.
    if (!this.paste(tabId, held)) return heldAnswer(name, 'not-waiting', entry?.status)
    this.deps.delivered?.(room.id)
    return { to: name, path: 'delivered' }
  }

  /**
   * The person clicked the held badge on a member tab (design-rooms.md §2): the pointer through the gate as their own
   * act, so `typed` and the mark do not hold it back; the gate's own rule does (waiting for input, nothing in flight).
   * A pause holds it (Pause holds all delivery, design §2). The draft bit holds it unless `overDraft`: a paste plus Enter
   * on a half-typed prompt would submit both as one prompt, and main cannot see whether the box is empty (an answered
   * permission prompt sets no bit, but Ctrl+U or Backspace leaves it set), so the strip asks and the person's "Deliver
   * anyway" sends `overDraft`, their choice to add the pointer to whatever is in the box. The caller checked the click
   * came from the shell page for its own tab. Answers `delivered`, or why not (no room, nothing held, paused, ended, a
   * permission prompt, busy, a draft) so the strip can tell the person instead of a click that silently did nothing.
   * The state reasons come before the draft, so "Deliver anyway" is offered only when it would go in.
   */
  deliverHeld(tabId: string, options: { overDraft?: boolean } = {}): DeliverHeldAnswer {
    const member = this.deps.rooms.memberOf(tabId)
    if (!member) return { delivered: false, why: 'no-room' }
    const room = this.deps.rooms.peek(member.roomId)
    if (!room || room.endedAt !== undefined) return { delivered: false, why: 'no-room' }
    const held = this.deps.rooms.held(room.id, member.name)
    if (held === 0) return { delivered: false, why: 'nothing-held' }
    if (room.paused) return { delivered: false, why: 'paused' }
    const entry = this.deps.sessions.get(tabId)
    if (!entry || entry.exitCode !== undefined || entry.status === 'ended') return { delivered: false, why: 'ended' }
    if (entry.status === 'needs-permission') return { delivered: false, why: 'permission' }
    if (!maySend(entry)) return { delivered: false, why: 'busy' }
    const overDraft = entry.draft === true && options.overDraft === true
    if (entry.draft === true && !overDraft) return { delivered: false, why: 'draft' }
    const ok = this.paste(tabId, held)
    // The pointer only (no message moved): logged as the person's delivery, so the record shows why the member read.
    const fields = { from: 'person', to: member.name, via: 'badge', pointer: held, delivered: ok }
    this.log(room.id, 'send', overDraft ? { ...fields, overDraft: true } : fields)
    // The gate re-checks at the paste (a failed PTY write too): not waiting after all.
    return ok ? { delivered: true } : { delivered: false, why: 'busy' }
  }

  /**
   * Mirror one tab's room fields into the session registry (SessionInfo.room and held) from the room registry, the
   * authority: none when the tab is in no room. The room service calls it after a join, a leave, a read, an end and a
   * restore (Task 8).
   */
  syncTab(tabId: string): void {
    const member = this.deps.rooms.memberOf(tabId)
    const room = member ? this.deps.rooms.peek(member.roomId) : undefined
    if (!member || !room || room.endedAt !== undefined) {
      this.deps.sessions.setRoom(tabId, null)
      return
    }
    this.mirror(tabId, room, member.name, this.deps.rooms.held(room.id, member.name))
  }

  /** Forget a room's send windows (it ended or was deleted). */
  forget(roomId: string): void {
    for (const key of [...this.sends.keys()]) if (key === `r:${roomId}` || key.startsWith(`m:${roomId}:`)) this.sends.delete(key)
  }

  private paste(tabId: string, held: number): boolean {
    try {
      return this.deps.sessions.sendPointer(tabId, pointerText(held))
    } catch (err) {
      // An ended session or a tab gone between the decision and the paste: the messages stay held.
      this.warn(`rooms: pointer to ${tabId} not sent: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  private marked(tabId: string, roomId: string, name: string): boolean {
    const r = this.deps.tabRoom(tabId)
    // Bound to (tab, room) and the member's name: a mark given in another room (or a stale record) is no mark.
    return r !== undefined && r.id === roomId && r.name === name && r.mark === true
  }

  private mirror(tabId: string, room: RoomRecord, name: string, held: number): void {
    const coordinator = Object.hasOwn(room.members, name) && room.members[name]?.coordinator === true
    this.deps.sessions.setRoom(tabId, { title: room.title, name, coordinator, held })
  }

  /**
   * Check that `n` more sends fit the room's cap and, for a member, its own; refused whole (nothing counted) when
   * either would go over. A cap hit names the cap and its value (design-rooms.md §6). Returns the window to charge.
   */
  private window(room: RoomRecord, from: string, n: number): SendWindow {
    const limits = this.deps.limits?.(room.pluginId) ?? DEFAULT_ROOM_SEND_LIMITS
    const now = this.now()
    const roomKey = `r:${room.id}`
    const memberKey = from === 'plugin' ? undefined : `m:${room.id}:${from}`
    const inRoom = this.recent(roomKey, now)
    const byMember = memberKey === undefined ? [] : this.recent(memberKey, now)
    if (memberKey !== undefined && byMember.length + n > limits.roomSendsPerMember) {
      throw new RoomError('limit', capText(`${limits.roomSendsPerMember} room sends a minute per member (roomSendsPerMember)`, n))
    }
    if (inRoom.length + n > limits.roomSendsPerRoom) {
      throw new RoomError('limit', capText(`${limits.roomSendsPerRoom} room sends a minute per room (roomSendsPerRoom)`, n))
    }
    return { now, roomKey, memberKey, inRoom, byMember }
  }

  /** Charge `n` sends (at most what `window` checked) to the room and the member. */
  private charge(w: SendWindow, n: number): void {
    for (let i = 0; i < n; i++) {
      w.inRoom.push(w.now)
      w.byMember.push(w.now)
    }
    if (w.inRoom.length > 0) this.sends.set(w.roomKey, w.inRoom)
    if (w.memberKey !== undefined && w.byMember.length > 0) this.sends.set(w.memberKey, w.byMember)
  }

  /** The send times of a key still inside the window (older ones dropped). */
  private recent(key: string, now: number): number[] {
    const list = (this.sends.get(key) ?? []).filter((t) => now - t < ROOM_SEND_WINDOW_MS)
    if (list.length === 0) this.sends.delete(key)
    return list
  }

  private logSend(roomId: string, from: string, to: string, text: string, delivery: RecipientAnswer[]): void {
    this.log(roomId, 'send', { from, to, text, delivery })
  }

  /** A failed log append is a warning: the send already happened. */
  private log(roomId: string, type: 'send', fields: Record<string, unknown>): void {
    try {
      this.deps.rooms.logOf(roomId).append(type, fields)
    } catch (err) {
      this.warn(`rooms: could not log to ${roomId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** A checked cap window: the times inside it, to charge once the send knows how many it queued. */
interface SendWindow {
  now: number
  roomKey: string
  memberKey: string | undefined
  inRoom: number[]
  byMember: number[]
}

function heldAnswer(to: string, why: HeldWhy, status: TabStatus | undefined): RecipientAnswer {
  return status === undefined || why !== 'not-waiting' ? { to, path: 'held', why } : { to, path: 'held', why, status }
}

function capText(cap: string, n: number): string {
  return n > 1 ? `the cap of ${cap} is reached ("all" counts one send per recipient, ${n} here)` : `the cap of ${cap} is reached`
}
