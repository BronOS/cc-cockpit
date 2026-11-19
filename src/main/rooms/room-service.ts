// The room service (design-rooms.md): one object that owns the room registry, the doc store, the delivery
// and the Stop decision, and wires them to the tab manager (the saved membership and the person's mark) and the session
// registry (status, the send gate, the person's input). Everything that changes a membership goes through here, so the
// three places that record one (the registry, the tab record, SessionInfo) never drift apart:
//   - a join (RoomRegistry.addMember or redeem) is followed by TabManager.setRoom and the SessionInfo mirror;
//   - a leave, a removal and a room's end by TabManager.clearRoom and the mirror, for every tab the room had bound
//     (RoomRegistry.endRoom drops its bindings without telling anyone, so they are read first);
//   - a read's ack (the queue's head taken) and a restored member's start by the mirror; a resume and a restored
//     member's start by an offer of the pointer (room-delivery.ts offer), and the end or delete of a room by the
//     delivery's and the room stop's forgetting it.
//
// Identity. The tab-side calls (`ccc room ...`, socket/handlers.ts) take a RoomTabCaller: the tab and project main
// resolved from the caller's session token (CliCall.tabId's rule: never from the payload). The member's name and
// coordinator flag come from the registry by that tab, never from the request. A tab whose room is in another project
// than the token's answers as a tab in no room. The owner-side calls (ctx.rooms, §4) take a RoomOwner built by main
// from the calling host's own plugin and window; every one of them looks the room up through the registry first (a
// foreign room is "no such room") before it touches the docs or the log. The person's calls (the tab strip and the room
// view, §5) are main's after its own window check.
//
// No Electron: the tab manager and the session registry come in as the slices used, so vitest drives the decisions
// with the real registries.
import { MAX_LINE_BYTES, ROOM_READ_MAX_TEXT_BYTES, type RoomReadReply } from '../../shared/protocol'
import type { TabKind } from '../../shared/types'
import type { DeliverHeldAnswer, TabRoom } from '../../shared/tab-room'
import { ROOM_VIEW_LOG_LIMIT, ROOM_VIEW_LOG_MAX_BYTES, type RoomView, type RoomViewLogEntry, type RoomViewMember } from '../../shared/room-view'
import { MAX_ID_CHARS } from '../../shared/room-names'
import type { SessionEntry, SessionRoom, TabStatus } from '../sessions/status-reducer'
import type { TabRoomHooks } from '../tabs/tab-manager'
import { warnLog } from '../warn-log'
import { fenceBatch, newFenceNonce } from './room-fence'
import { RoomDelivery, type RecipientAnswer } from './room-delivery'
import type { PluginLimits } from '../../shared/plugin-limits'
import { RoomDocs, type RoomDocCaller, type RoomDocEntry } from './room-docs'
import type { RoomLogEntry, RoomLogPage } from './room-log'
import { RoomError } from './room-error'
import {
  RoomRegistry,
  type RoomInvite,
  type RoomMemberInfo,
  type RoomMembership,
  type RoomOwner,
  type RoomRecord
} from './room-registry'
import { RoomStop } from './room-stop'

/** The tab manager as the room service uses it (TabManager). */
export interface RoomServiceTabs {
  setRoom(projectId: string, tabId: string, room: { id: string; name: string; coordinator: boolean }): TabRoom
  clearRoom(projectId: string, tabId: string): void
  roomOf(projectId: string, tabId: string): TabRoom | undefined
  kindOf(projectId: string, tabId: string): TabKind | undefined
  /** Close a tab as a main-initiated close does (views told); no dialog. */
  close(projectId: string, tabId: string): void
}

/** The session registry as the room service uses it (SessionRegistry). */
export interface RoomServiceSessions {
  get(tabId: string): SessionEntry | undefined
  sendPointer(tabId: string, text: string): boolean
  setRoom(tabId: string, room: (SessionRoom & { held: number }) | null): boolean
  onPersonInput(listener: (tabId: string) => void): () => void
  onPersonPrompt(listener: (tabId: string) => void): () => void
  onChange(listener: (change: { tabId: string; entry: SessionEntry | undefined; prev: SessionEntry | undefined }) => void): () => void
}

export interface RoomServiceOptions {
  /** `<data>/rooms`. */
  dir: string
  tabs: RoomServiceTabs
  sessions: RoomServiceSessions
  /**
   * The plugin's limits (PluginLimitsStore.limits: its override, else the global value, else the default): the send
   * caps read on every send, the room and member caps on every create and join. The defaults when absent.
   */
  limits?(pluginId: string): PluginLimits
  now?: () => number
  newId?: () => string
  random?: (bytes: number) => Buffer
  /** Tests: a fixed nonce per read. */
  nonce?: () => string
  /** Tests: a small read budget (protocol.ts ROOM_READ_MAX_TEXT_BYTES). */
  readMaxBytes?: number
  /** Tests: fixed ack ids and a short ack timeout (room-stop.ts). */
  newAckId?: () => string
  ackTimeoutMs?: number
  log?: (message: string) => void
  /**
   * A room of `projectId` changed (record, queue, binding, doc, log; or it was deleted): index.ts tells the project's
   * views (`rooms.changed`) so an open room view reads it again. Coalesced per room to one call per burst (a send to
   * `all` saves and logs once per member), after the change, and throttled per room (`changedThrottleMs`): a busy room
   * would otherwise make every open dialog (desktop and each browser) read the log, the docs tree and up to 1 MiB of
   * reply again many times a second. Leading and trailing, so the last change is always told.
   */
  changed?(room: { id: string; projectId: string }): void
  /**
   * A room changed in some way, told at once (not throttled, not coalesced) before `changed`: index.ts settles the
   * Remove asks whose member went away (`hasLiveMember`). Cheap by contract: it runs on every log event.
   */
  anyChange?(roomId: string): void
  /** Tests: the window of the `changed` throttle, 250 ms by default. */
  changedThrottleMs?: number
}

/** The default window of the `rooms.changed` throttle per room. */
export const ROOM_CHANGED_THROTTLE_MS = 250

/** One room's `rooms.changed` state: a change waiting to be told, the leading microtask, the window's timer. */
interface ChangeState {
  projectId: string
  dirty: boolean
  /** The leading call is still waiting for its microtask (a burst in one tick is one call). */
  queued: boolean
  /** The room ended or was deleted: the window's timer is gone, and this state goes after its last call. */
  ended: boolean
  timer?: ReturnType<typeof setTimeout>
}

/** How long a server's browser's Remove waits for the window's answer (`rooms.removeAsk`); past it nothing is removed. */
export const ROOM_REMOVE_ASK_MS = 5 * 60_000

/** A `ccc room` caller: the Claude tab main resolved from the session token, and that tab's project. */
export interface RoomTabCaller {
  tabId: string
  projectId: string
}

/** A member as `ccc room status` shows it. */
export interface RoomStatusMember {
  name: string
  coordinator: boolean
  /** The member's tab status now; `no-tab` while it has none (after a quit, until a restore binds it). */
  status: TabStatus | 'no-tab'
  held: number
  /** This is the caller. */
  you?: true
}

/** `ccc room status`: the caller's room, or none. No room id: a member names nothing by id, main knows its room. */
export type RoomStatus =
  | { room: null }
  | { room: { title: string; paused: boolean }; name: string; coordinator: boolean; held: number; members: RoomStatusMember[] }

/** `ccc room read`: protocol.ts RoomReadReply (the batch, what still waits, the ack to send once printed). */
export type RoomReadResult = RoomReadReply

const NOT_IN_ROOM = 'this tab is in no room'

/**
 * Room left in a reply line for everything around a doc's text: the envelope (`v`, `id`, `ok`, `appVersion`) and the
 * result's other fields are a few hundred bytes, so 4 KiB is a margin, not a measure.
 */
const REPLY_ENVELOPE_BYTES = 4096
/** Most bytes a doc's JSON-encoded text may take in a `ccc room doc get` reply: MAX_LINE_BYTES less the envelope. */
const ROOM_DOC_REPLY_MAX_BYTES = MAX_LINE_BYTES - REPLY_ENVELOPE_BYTES

export class RoomService {
  readonly registry: RoomRegistry
  readonly docs: RoomDocs
  readonly delivery: RoomDelivery
  /** The Stop decision: hookHandler and hookAckHandler take it (index.ts). */
  readonly stop: RoomStop
  private readonly nonce: () => string
  private readonly warn: (message: string) => void
  private readonly unsubscribe: Array<() => void> = []
  private disposed = false
  /** The `rooms.changed` throttle, by room id (`roomChanged`). */
  private readonly changeStates = new Map<string, ChangeState>()

  constructor(private readonly options: RoomServiceOptions) {
    this.warn = options.log ?? warnLog
    this.nonce = options.nonce ?? newFenceNonce
    this.registry = new RoomRegistry({
      dir: options.dir,
      ...(options.limits ? { limits: options.limits } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.newId ? { newId: options.newId } : {}),
      ...(options.random ? { random: options.random } : {}),
      log: this.warn,
      changed: (room) => this.roomChanged(room)
    })
    this.docs = new RoomDocs({
      dir: options.dir,
      // The docs' own log events (reads, writes, refusals) change what the room view shows too.
      logOf: (roomId) => {
        const log = this.registry.logOf(roomId)
        return {
          append: (type, fields) => {
            log.append(type, fields)
            // The person's own read (the room view opening a doc) is logged but changes nothing the dialog shows
            // except that log line, and the dialog opening a doc must not make itself read again: an open doc that
            // refreshed on `rooms.changed` would loop (read, log, changed, read), a throttle only slowing the loop.
            // So it is the one log event that tells nobody; the line shows with the next change or a re-open.
            if (type === 'doc-read' && fields?.by === 'person') return
            const room = this.registry.peek(roomId)
            if (room) this.roomChanged(room)
          }
        }
      },
      log: this.warn,
      ...(options.random ? { random: options.random } : {}),
      ...(options.now ? { now: options.now } : {})
    })
    const tabRoom = (tabId: string): TabRoom | undefined => this.tabRoom(tabId)
    this.stop = new RoomStop({
      rooms: this.registry,
      sessions: options.sessions,
      tabRoom,
      // An unacked block undone (the tab waiting, no Stop to come): what waits is offered through the gate.
      unblocked: (tabId) => this.offerTab(tabId),
      ...(options.newAckId ? { newAckId: options.newAckId } : {}),
      ...(options.ackTimeoutMs !== undefined ? { ackTimeoutMs: options.ackTimeoutMs } : {}),
      log: this.warn
    })
    this.delivery = new RoomDelivery({
      rooms: this.registry,
      sessions: options.sessions,
      tabRoom,
      // The per-tab Stop cap holds the gate's paste too; the person's badge click ends it (design §2 "Loops").
      capped: (tabId) => this.stop.isCapped(tabId),
      personDelivered: (tabId) => this.stop.personPrompt(tabId),
      ...(options.limits ? { limits: options.limits } : {}),
      // A pointer main pasted on its own decision counts toward the room's auto-pause (room-stop.ts delivered).
      delivered: (roomId) => this.stop.delivered(roomId),
      ...(options.now ? { now: options.now } : {}),
      log: this.warn
    })
    // The person's keystrokes reset the room's auto-pause count; the person's prompt ends the tab's run of Stop blocks.
    this.unsubscribe.push(
      options.sessions.onPersonInput((tabId) => {
        this.stop.personInput(tabId)
        // `closeTabs` keeps a tab the person typed in; the registry saves the record on the first keystroke only.
        this.registry.markPersonTyped(tabId)
      })
    )
    this.unsubscribe.push(options.sessions.onPersonPrompt((tabId) => this.stop.personPrompt(tabId)))
    // The settle window after SessionStart ended (send-gate.ts settled): the tab may take a paste now, with no hook event
    // to say so. A message sent in that window (a plugin's kickoff right after rooms.open, the rooms e2e) was held as
    // not waiting, and a waiting tab has no Stop coming to give it the pointer: offer it now. After the change is
    // committed (a microtask), not from inside the registry's listener call: the paste commits another change.
    this.unsubscribe.push(
      options.sessions.onChange(({ tabId, entry, prev }) => {
        if (prev?.settling === true && entry !== undefined && entry.settling !== true) queueMicrotask(() => this.settled(tabId))
      })
    )
  }

  /** A tab's settle window ended: a member is offered what waits for it (the delivery decides, paused and typed included). */
  private settled(tabId: string): void {
    if (this.disposed) return
    this.offerTab(tabId)
  }

  /** Offer a member tab what waits for it; a no-op for a tab in no room. */
  private offerTab(tabId: string): void {
    const member = this.registry.memberOf(tabId)
    if (member) this.delivery.offer(member.roomId, member.name)
  }

  /** Read the saved rooms (each comes back paused). Before any tab is restored, so the saved memberships can rebind. */
  load(): void {
    this.registry.load()
  }

  /**
   * TabManagerOptions.rooms: what a member tab's comings and goings mean (tab-manager.ts TabRoomHooks). A restored
   * tab's saved membership is bound only when the registry still has that member free, with the registry's
   * coordinator flag, and its room is paused (RoomRegistry.rebind); the person's close ends the membership (the
   * coordinators are told and offered the pointer); a window or app going away only unbinds it (a window closed for good
   * then ends it, projectClosed).
   */
  readonly tabHooks: TabRoomHooks = {
    rebind: (tabId, room, projectId) => {
      if (!this.registry.rebind(tabId, room.id, room.name, projectId)) return undefined
      const member = this.registry.memberOf(tabId)
      return member ? { coordinator: member.coordinator } : undefined
    },
    closed: (tabId) => {
      this.stop.tabGone(tabId)
      const left = this.registry.memberClosed(tabId)
      if (!left) return
      // The `system` notice memberClosed queued for each coordinator: offered now like any message.
      for (const m of this.registry.memberInfos(left.roomId)) if (m.coordinator) this.delivery.offer(left.roomId, m.name)
    },
    gone: (tabId) => {
      this.stop.tabGone(tabId)
      this.registry.unbind(tabId)
    }
  }

  /**
   * The project's window closed for good (index.ts onProjectClosed: not a quit or a reopen), after its saved tab records
   * were cleared: its members, unbound when their tabs went with the window, can never be bound again, so they leave as
   * on the person's close (RoomRegistry.projectClosed). Their Stop state already went in `tabHooks.gone`; the
   * coordinators told left with the rest (none has a tab in this project now), so there is nobody to offer the notice.
   */
  projectClosed(projectId: string): void {
    this.registry.projectClosed(projectId)
  }

  /**
   * A tab's process started (TabLifecycle.started, after the session registry made its entry): a member (a restored
   * one the registry rebound, or a restart) gets its SessionInfo room fields and is offered what waits for it (a
   * restored room is paused, so that offer holds until the person resumes it).
   */
  tabStarted(tabId: string): void {
    const member = this.registry.memberOf(tabId)
    if (!member) return
    this.delivery.syncTab(tabId)
    this.delivery.offer(member.roomId, member.name)
  }

  /**
   * Any tab closed or went with its window (TabLifecycle.closed): the room stop forgets its run, cap and pending block.
   * Also for a tab that is in no room now (it left after a run of blocks); the membership itself is the tab hooks'.
   */
  tabClosed(tabId: string): void {
    this.stop.tabGone(tabId)
  }

  // --- `ccc room ...` (socket/handlers.ts): the caller is the token's tab ---

  status(caller: RoomTabCaller): RoomStatus {
    const found = this.memberRoom(caller)
    if (!found) return { room: null }
    const { member, room } = found
    const members = this.registry.memberInfos(room.id).map((m): RoomStatusMember => {
      const status = m.tabId === undefined ? 'no-tab' : (this.options.sessions.get(m.tabId)?.status ?? 'no-tab')
      return { name: m.name, coordinator: m.coordinator, status, held: m.held, ...(m.name === member.name ? { you: true as const } : {}) }
    })
    return {
      room: { title: room.title, paused: room.paused },
      name: member.name,
      coordinator: member.coordinator,
      held: this.registry.held(room.id, member.name),
      members
    }
  }

  /** `ccc room join <invite>`: the caller's own tab joins under the invite's name (redeem checks the project). */
  join(caller: RoomTabCaller, code: unknown): { title: string; name: string; coordinator: boolean } {
    if (this.options.tabs.kindOf(caller.projectId, caller.tabId) !== 'claude') throw new RoomError('invalid', 'only a Claude tab can join a room')
    const member = this.registry.redeem(code, caller.tabId, caller.projectId)
    this.bindTab(caller.projectId, caller.tabId, member)
    const room = this.registry.peek(member.roomId)
    return { title: room?.title ?? '', name: member.name, coordinator: member.coordinator }
  }

  /** `ccc room leave`: the caller's tab leaves its room (its queue is dropped). */
  leave(caller: RoomTabCaller): { title: string; name: string } {
    const { member, room } = this.requireMember(caller)
    this.registry.leave(caller.tabId, 'left')
    this.releaseTab(room.projectId, caller.tabId)
    return { title: room.title, name: member.name }
  }

  /** `ccc room send <name|all> <text>`: from the caller's member name, never one the request names. */
  send(caller: RoomTabCaller, to: unknown, text: unknown): RecipientAnswer[] {
    const { member, room } = this.requireMember(caller)
    return this.delivery.send(room.id, member.name, to, text)
  }

  /**
   * `ccc room read`, step one (protocol.ts ROOM_READ_ACK_COMMAND): the oldest messages waiting for the caller that fit
   * one reply line, fenced under a fresh nonce, with the count still waiting after them. Nothing leaves the queue
   * here: the reply may never reach Claude (`ccc` killed by Esc or its deadline, the socket gone before the write), and
   * the messages are taken only by the ack `ccc` sends once it printed them (readAck). Two steps rather than "take, and
   * put back if the write fails": a write main made is no proof `ccc` printed it. So a read is at least once: a `ccc`
   * killed between its print and its ack shows that batch again, and no batch is ever lost.
   */
  read(caller: RoomTabCaller): RoomReadResult {
    const { member, room } = this.requireMember(caller)
    const messages = this.registry.waiting(room.id, member.name)
    if (messages.length === 0) return { count: 0, more: 0, text: '' }
    const batch = fenceBatch(room.title, messages, this.nonce(), this.options.readMaxBytes ?? ROOM_READ_MAX_TEXT_BYTES)
    // The batch's last message id: the ack takes the queue's head through it, never a message sent after this read.
    const last = messages[batch.count - 1]
    return last ? { ...batch, ack: last.id } : batch
  }

  /**
   * `ccc room read`, step two: `ccc` printed the batch whose reply carried `ack`; its messages leave the caller's own
   * queue (only the caller's: the member comes from the token's tab, the id is looked up in that queue alone).
   */
  readAck(caller: RoomTabCaller, ack: unknown): { acked: number } {
    const { member, room } = this.requireMember(caller)
    if (typeof ack !== 'string' || ack.length === 0 || ack.length > MAX_ID_CHARS) throw new RoomError('invalid', 'room.read.ack needs the ack of a read')
    const acked = this.registry.dropThrough(room.id, member.name, ack)
    // The held count (SessionInfo and the badge) follows the queue.
    if (acked > 0) this.delivery.syncTab(caller.tabId)
    return { acked }
  }

  docList(caller: RoomTabCaller): Promise<RoomDocEntry[]> {
    const { roomId, doc } = this.docCaller(caller)
    return this.docs.list(roomId, doc)
  }

  /**
   * A doc's text for `ccc room doc get`. Every doc put through the store fits a reply line once JSON-escaped (put
   * refuses the controls that escape to six bytes: room-docs.ts isDocText, so at most twice MAX_DOC_BYTES); a file
   * that got there some other way and would not fit is refused with a reason, never sent as a line the client drops.
   */
  async docGet(caller: RoomTabCaller, path: unknown): Promise<string> {
    const { roomId, doc } = this.docCaller(caller)
    const text = await this.docs.get(roomId, doc, path)
    if (Buffer.byteLength(JSON.stringify(text)) > ROOM_DOC_REPLY_MAX_BYTES) {
      throw new RoomError('limit', 'this doc holds control characters that make it too large for one ccc reply')
    }
    return text
  }

  docPut(caller: RoomTabCaller, path: unknown, text: unknown): Promise<void> {
    const { roomId, doc } = this.docCaller(caller)
    return this.docs.put(roomId, doc, path, text)
  }

  /** `ccc room doc append`: the same access and text rule as a put, through the room's one write chain (room-docs.ts). */
  docAppend(caller: RoomTabCaller, path: unknown, text: unknown): Promise<void> {
    const { roomId, doc } = this.docCaller(caller)
    return this.docs.append(roomId, doc, path, text)
  }

  // --- the owner (ctx.rooms, design-rooms.md §4): main built `owner` from the calling host ---

  create(owner: RoomOwner, opts: { title: unknown }): RoomRecord {
    return this.registry.create(owner, opts)
  }

  list(owner: RoomOwner): RoomRecord[] {
    return this.registry.list(owner)
  }

  /** End the owner's room: every tab it had bound leaves it (record, mirror), and its counts are forgotten. */
  end(owner: RoomOwner, id: unknown, opts: { closeTabs?: boolean } = {}): number {
    const room = this.registry.get(owner, id)
    const bound = this.boundTabs(room.id)
    // Chosen before the end (it unbinds the tabs) but closed after it, so members leave as an end, not as `closed`.
    // Only the boolean comes from the plugin; which tabs qualify is the registry's rule. No dialog: the tabs were opened
    // automatically and ending the team is the decision. `endAllOf` never closes tabs.
    const toClose = opts.closeTabs === true ? this.registry.closableTabs(room.id) : []
    this.registry.end(owner, room.id)
    this.roomEnded(room, bound)
    let closed = 0
    for (const tabId of toClose) {
      try {
        this.options.tabs.close(room.projectId, tabId)
        closed++
      } catch (err) {
        this.warn(`rooms: could not close tab ${tabId} of ended room ${room.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return closed
  }

  /**
   * End every live room of a plugin (disabled, removed or revoked: design-rooms.md §1), in every project or, with
   * `projectId`, in that one (the plugin switched off there).
   */
  endAllOf(pluginId: string, why = 'plugin gone', projectId?: string): void {
    const rooms = this.registry.liveRoomsOf(pluginId, projectId).map((room) => ({ room, bound: this.boundTabs(room.id) }))
    this.registry.endAllOf(pluginId, why, projectId)
    for (const { room, bound } of rooms) this.roomEnded(room, bound)
  }

  /**
   * The plugin set changed (an install, an uninstall, a revocation, a switch in a project or for all projects; and
   * once after the plugins load): end the live rooms whose plugin is no longer on in their project. `offWhy` is
   * main's answer for a plugin and project (index.ts, enablement.ts roomEndReason): the reason the log records, or
   * undefined while the plugin is on there. A throw for one pair is logged and the others are still checked.
   */
  endRoomsOfPluginsOff(offWhy: (owner: RoomOwner) => string | undefined): void {
    for (const owner of this.registry.liveOwners()) {
      try {
        const why = offWhy(owner)
        if (why !== undefined) this.endAllOf(owner.pluginId, why, owner.projectId)
      } catch (err) {
        this.warn(`rooms: could not end the rooms of ${owner.pluginId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /** Delete the owner's ended room (record, log, docs). */
  delete(owner: RoomOwner, id: unknown): void {
    const room = this.registry.get(owner, id)
    this.registry.delete(owner, room.id)
    this.delivery.forget(room.id)
    this.stop.roomGone(room.id)
    this.endChangeWindow(room.id)
  }

  /** ctx.rooms.open's check before it opens a tab: the room is the owner's and live, the name valid and free, a seat left. */
  checkAdd(owner: RoomOwner, id: unknown, name: unknown): void {
    this.registry.checkAdd(owner, id, name)
  }

  /**
   * A tab the owner's host opened into the room (ctx.rooms.open, design-rooms.md §1, after it created the tab in its own window):
   * a member from the start. Only a Claude tab of the owner's project.
   */
  addMember(owner: RoomOwner, id: unknown, member: { tabId: string; name: unknown; coordinator?: unknown }): RoomMembership {
    const room = this.registry.get(owner, id)
    if (this.options.tabs.kindOf(owner.projectId, member.tabId) !== 'claude') throw new RoomError('invalid', 'only a Claude tab of this project can join a room')
    const joined = this.registry.addMember(owner, room.id, member)
    this.bindTab(owner.projectId, member.tabId, joined)
    return joined
  }

  invite(owner: RoomOwner, id: unknown, opts: { name: unknown; coordinator?: unknown }): RoomInvite {
    return this.registry.invite(owner, id, opts)
  }

  members(owner: RoomOwner, id: unknown): RoomMemberInfo[] {
    return this.registry.members(owner, id)
  }

  /** The owner (ctx.rooms.remove) or the person (`'person'`, the room view: main checked the window) removes a member. */
  remove(owner: RoomOwner | 'person', id: unknown, name: unknown): RoomMembership {
    const room = owner === 'person' ? this.registry.peek(typeof id === 'string' ? id : '') : this.registry.get(owner, id)
    if (!room) throw new RoomError('not-found', 'no such room')
    const tabId = typeof name === 'string' ? this.registry.boundTab(room.id, name) : undefined
    const left = this.registry.remove(owner, room.id, name)
    if (tabId !== undefined) this.releaseTab(room.projectId, tabId)
    return left
  }

  /**
   * ctx.rooms.remove with `closeTab: true`: removes the member, then closes its tab with no dialog when the registry's
   * rule allows (opened by the app, not a coordinator, never typed in: the same as `end`'s `closeTabs`). Chosen before
   * the removal (it unbinds the tab); a failing close is logged and counts 0, the member is out either way.
   */
  removeOwned(owner: RoomOwner, id: unknown, name: unknown, opts: { closeTab?: boolean } = {}): number {
    const room = this.registry.get(owner, id)
    const toClose = opts.closeTab === true && typeof name === 'string' ? this.registry.closableTab(room.id, name) : undefined
    this.remove(owner, room.id, name)
    if (toClose === undefined) return 0
    try {
      this.options.tabs.close(room.projectId, toClose)
      return 1
    } catch (err) {
      this.warn(`rooms: could not close tab ${toClose} of removed member in room ${room.id}: ${err instanceof Error ? err.message : String(err)}`)
      return 0
    }
  }

  /** ctx.rooms.send: a message `from plugin` (the owner's own room only). */
  sendAsPlugin(owner: RoomOwner, id: unknown, to: unknown, text: unknown): RecipientAnswer[] {
    return this.delivery.send(this.ownerRoomId(owner, id), 'plugin', to, text)
  }

  ownerDocList(owner: RoomOwner, id: unknown): Promise<RoomDocEntry[]> {
    return this.docs.list(this.ownerRoomId(owner, id), 'plugin')
  }

  ownerDocGet(owner: RoomOwner, id: unknown, path: unknown): Promise<string> {
    return this.docs.get(this.ownerRoomId(owner, id), 'plugin', path)
  }

  ownerDocPut(owner: RoomOwner, id: unknown, path: unknown, text: unknown): Promise<void> {
    return this.docs.put(this.ownerRoomId(owner, id), 'plugin', path, text)
  }

  /** The id of the owner's room (a refusal for another owner's or a missing one: every ctx.rooms call checks it first). */
  private ownerRoomId(owner: RoomOwner, id: unknown): string {
    return this.registry.get(owner, id).id
  }

  /**
   * ctx.rooms.log: the owner's room's events, the oldest after the `since` cursor (a `seq`) when given, else the newest.
   * `maxBytes` bounds the page by its JSON lines (at least one entry; `more` says to page on).
   */
  log(owner: RoomOwner, id: unknown, opts: { since?: unknown; limit?: unknown; maxBytes?: number } = {}): RoomLogPage {
    const room = this.registry.get(owner, id)
    return this.registry.logOf(room.id).page({
      ...(typeof opts.since === 'number' ? { since: opts.since } : {}),
      ...(typeof opts.limit === 'number' ? { limit: opts.limit } : {}),
      ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {})
    })
  }

  // --- the person (the room view and the tab strip, design-rooms.md §5; main checked the window) ---

  pause(roomId: string): void {
    this.registry.pause(roomId)
  }

  /**
   * Resume a room and offer every member what waits for it. The person's Resume also ends its tabs' runs of Stop
   * blocks and their caps (room-stop.ts roomResumed): for an untyped member it is one of the person's ways past the cap.
   */
  resume(roomId: string): void {
    this.registry.resume(roomId)
    this.stop.roomResumed(roomId)
    for (const m of this.registry.memberInfos(roomId)) this.delivery.offer(roomId, m.name)
  }

  /**
   * The held badge's click (rooms.deliverHeld): the pointer as the person's own act, or why it did not go in.
   * `overDraft`: the person's "Deliver anyway" after a `draft` answer (RoomDelivery.deliverHeld).
   */
  deliverHeld(tabId: string, options: { overDraft?: boolean } = {}): DeliverHeldAnswer {
    return this.delivery.deliverHeld(tabId, options)
  }

  /**
   * The person turned the mark on for a member tab (tabs.roomMark, after TabManager.setRoomMark stored it, only when it
   * was off before: the strip handlers decide): what waits is offered again, so a marked typed tab waiting for input
   * gets the pointer now instead of at its next Stop. A tab at the per-tab Stop cap stays held (the offer answers
   * `capped`: design §2 "Loops"). Never on clearing the mark or setting it again: turning delivery off must not
   * deliver. A no-op for a tab in no room.
   */
  markTurnedOn(tabId: string): void {
    this.offerTab(tabId)
  }

  // --- the room view (rooms.view and the rest, design-rooms.md §5): `projectId` is main's, the sender's window's project ---

  /**
   * The room of the person's window: one of `projectId`'s rooms, live or ended. Another project's room, an unknown id
   * and a deleted room are the same "no such room" (a view names a room only by the id its own tabs carry).
   */
  personRoom(projectId: string, id: unknown): RoomRecord {
    const room = typeof id === 'string' ? this.registry.peek(id) : undefined
    if (!room || room.projectId !== projectId) throw new RoomError('not-found', 'no such room')
    return room
  }

  /** `rooms.view`: members with their tab status and held counts, every doc, the newest log events. */
  async view(projectId: string, id: unknown): Promise<RoomView> {
    const room = this.personRoom(projectId, id)
    const members = this.registry.memberInfos(room.id).map((m): RoomViewMember => {
      const status = m.tabId === undefined ? 'no-tab' : (this.options.sessions.get(m.tabId)?.status ?? 'no-tab')
      return { name: m.name, coordinator: m.coordinator, status, held: m.held, ...(m.tabId !== undefined ? { tabId: m.tabId } : {}) }
    })
    const docs = await this.docs.list(room.id, 'person')
    const page = this.registry.logOf(room.id).page({ limit: ROOM_VIEW_LOG_LIMIT })
    const log = viewLog(page.entries)
    return {
      id: room.id,
      title: room.title,
      pluginId: room.pluginId,
      createdAt: room.createdAt,
      ...(room.endedAt !== undefined ? { endedAt: room.endedAt } : {}),
      paused: room.paused,
      members,
      docs,
      log: log.entries,
      logMore: page.more || log.dropped
    }
  }

  /** `rooms.doc`: a doc's text for the read-only viewer, read as the person (every folder; logged `by person`). */
  async personDoc(projectId: string, id: unknown, path: unknown): Promise<string> {
    return await this.docs.get(this.personRoom(projectId, id).id, 'person', path)
  }

  personPause(projectId: string, id: unknown): void {
    this.pause(this.personRoom(projectId, id).id)
  }

  personResume(projectId: string, id: unknown): void {
    this.resume(this.personRoom(projectId, id).id)
  }

  /**
   * The member a Remove names, checked before a server's browser is asked (an ask for a member that is not there would
   * only be a dialog that does nothing): the room's title and the name for the ask's words.
   */
  removeTarget(projectId: string, id: unknown, name: unknown): { roomId: string; title: string; name: string } {
    const room = this.personRoom(projectId, id)
    // Checked before the ask as the removal itself checks it (room-registry.ts remove): an ended room keeps its members.
    if (room.endedAt !== undefined) throw new RoomError('ended', 'the room has ended')
    if (typeof name !== 'string' || !Object.hasOwn(room.members, name)) throw new RoomError('not-found', 'no such member')
    return { roomId: room.id, title: room.title, name }
  }

  /** `rooms.remove` once allowed: the person removes the member (checked again: it may have left during the ask). */
  personRemove(projectId: string, id: unknown, name: unknown): void {
    this.remove('person', this.personRoom(projectId, id).id, name)
  }

  /** `rooms.reveal`: the folder to show (room-docs.ts folder), or a refusal when the room has none on disk. */
  async revealFolder(projectId: string, id: unknown): Promise<string> {
    const folder = await this.docs.folder(this.personRoom(projectId, id).id)
    if (folder === null) throw new RoomError('not-found', 'the room has no folder yet')
    return folder
  }

  /** Whether `name` is a member of the live (not ended, not deleted) room: a Remove ask for it still means something. */
  hasLiveMember(roomId: string, name: string): boolean {
    const room = this.registry.peek(roomId)
    return room !== undefined && room.endedAt === undefined && Object.hasOwn(room.members, name)
  }

  /** App quit: the room stop's ack timers stop and the listeners go. */
  dispose(): void {
    this.disposed = true
    for (const state of this.changeStates.values()) clearTimeout(state.timer)
    this.changeStates.clear()
    this.stop.dispose()
    for (const off of this.unsubscribe.splice(0)) off()
  }

  /** The tab's membership and the person's mark, from the tab manager in the tab's own project (its session entry's). */
  private tabRoom(tabId: string): TabRoom | undefined {
    const projectId = this.options.sessions.get(tabId)?.projectId
    return projectId === undefined ? undefined : this.options.tabs.roomOf(projectId, tabId)
  }

  /** The caller's membership and live room; undefined for a tab in no room, or whose room is another project's. */
  private memberRoom(caller: RoomTabCaller): { member: RoomMembership; room: RoomRecord } | undefined {
    const member = this.registry.memberOf(caller.tabId)
    if (!member) return undefined
    const room = this.registry.peek(member.roomId)
    if (!room || room.endedAt !== undefined || room.projectId !== caller.projectId) return undefined
    return { member, room }
  }

  private requireMember(caller: RoomTabCaller): { member: RoomMembership; room: RoomRecord } {
    const found = this.memberRoom(caller)
    if (!found) throw new RoomError('not-found', NOT_IN_ROOM)
    return found
  }

  /** The doc store's caller for a member: the name and coordinator flag the registry has, never the request's. */
  private docCaller(caller: RoomTabCaller): { roomId: string; doc: RoomDocCaller } {
    const { member, room } = this.requireMember(caller)
    return { roomId: room.id, doc: { name: member.name, coordinator: member.coordinator } }
  }

  /** After a join: the tab record (saved, told to every view) and the SessionInfo mirror. */
  private bindTab(projectId: string, tabId: string, member: RoomMembership): void {
    try {
      this.options.tabs.setRoom(projectId, tabId, { id: member.roomId, name: member.name, coordinator: member.coordinator })
    } catch (err) {
      // The tab went between the check and the join: the registry's binding is all there is, and the tab's close or
      // the next restore settles it. Never a refused join: the member exists now.
      this.warn(`rooms: could not record the membership on tab ${tabId}: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.delivery.syncTab(tabId)
  }

  /** After a leave, a removal or an end: the tab record loses the membership and its mark, and the mirror clears. */
  private releaseTab(projectId: string, tabId: string): void {
    try {
      this.options.tabs.clearRoom(projectId, tabId)
    } catch (err) {
      this.warn(`rooms: could not clear the membership on tab ${tabId}: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.delivery.syncTab(tabId)
  }

  private boundTabs(roomId: string): string[] {
    return this.registry.memberInfos(roomId).flatMap((m) => (m.tabId === undefined ? [] : [m.tabId]))
  }

  /**
   * A change to a room. Told to `changed` once per burst on the next microtask (the leading call), then at most once
   * per throttle window with whatever came in during it (the trailing call, so the last change is never lost).
   */
  private roomChanged(room: { id: string; projectId: string }): void {
    try {
      this.options.anyChange?.(room.id)
    } catch (err) {
      this.warn(`rooms: change listener failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!this.options.changed) return
    const state = this.changeStates.get(room.id)
    if (state) {
      state.dirty = true
      return
    }
    const fresh: ChangeState = { projectId: room.projectId, dirty: true, queued: true, ended: false }
    this.changeStates.set(room.id, fresh)
    queueMicrotask(() => {
      fresh.queued = false
      this.tellChanged(room.id, fresh)
      if (fresh.ended && this.changeStates.get(room.id) === fresh) this.changeStates.delete(room.id)
    })
    this.startChangeWindow(room.id, fresh)
  }

  private startChangeWindow(id: string, state: ChangeState): void {
    const ms = this.options.changedThrottleMs ?? ROOM_CHANGED_THROTTLE_MS
    state.timer = setTimeout(() => {
      state.timer = undefined
      if (this.changeStates.get(id) !== state) return
      if (!state.dirty) {
        this.changeStates.delete(id)
        return
      }
      this.tellChanged(id, state)
      this.startChangeWindow(id, state)
    }, ms)
    state.timer.unref?.()
  }

  private tellChanged(id: string, state: ChangeState): void {
    if (!state.dirty) return
    state.dirty = false
    try {
      this.options.changed?.({ id, projectId: state.projectId })
    } catch (err) {
      this.warn(`rooms: change listener failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * The room ended or was deleted: its throttle timer stops now (a deleted room must not keep a timer, nor tell a
   * trailing change after its own delete event). A change still waiting is told at once, unless the leading microtask
   * has not run yet (it tells it, so an end and a delete in one tick are one call).
   */
  private endChangeWindow(id: string): void {
    const state = this.changeStates.get(id)
    if (!state) return
    clearTimeout(state.timer)
    state.timer = undefined
    if (state.queued) {
      state.ended = true
      return
    }
    this.tellChanged(id, state)
    this.changeStates.delete(id)
  }

  private roomEnded(room: RoomRecord, bound: string[]): void {
    for (const tabId of bound) this.releaseTab(room.projectId, tabId)
    this.delivery.forget(room.id)
    this.stop.roomGone(room.id)
    this.endChangeWindow(room.id)
  }
}

/**
 * The log entries a room view carries: the newest that fit ROOM_VIEW_LOG_MAX_BYTES (JSON), oldest first; `dropped` when
 * older ones were left out for the size. Entries are plain data read back from the JSON-lines file, passed on as is.
 */
function viewLog(entries: RoomLogEntry[]): { entries: RoomViewLogEntry[]; dropped: boolean } {
  let bytes = 0
  let from = entries.length
  while (from > 0) {
    const size = Buffer.byteLength(JSON.stringify(entries[from - 1]))
    if (bytes + size > ROOM_VIEW_LOG_MAX_BYTES) break
    bytes += size
    from--
  }
  return { entries: entries.slice(from), dropped: from > 0 }
}
