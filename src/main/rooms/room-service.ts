// The room service (design-rooms.md, plan Task 8): one object that owns the room registry, the doc store, the delivery
// and the Stop decision, and wires them to the tab manager (the saved membership and the person's mark) and the session
// registry (status, the send gate, the person's input). Everything that changes a membership goes through here, so the
// three places that record one (the registry, the tab record, SessionInfo) never drift apart:
//   - a join (RoomRegistry.addMember or redeem) is followed by TabManager.setRoom and the SessionInfo mirror;
//   - a leave, a removal and a room's end by TabManager.clearRoom and the mirror, for every tab the room had bound
//     (RoomRegistry.endRoom drops its bindings without telling anyone, so they are read first);
//   - a read (the queue taken) and a restored member's start by the mirror; a resume and a restored member's start by
//     an offer of the pointer (room-delivery.ts offer), and the end or delete of a room by the delivery's and the room
//     stop's forgetting it.
//
// Identity. The tab-side calls (`ccc room ...`, socket/handlers.ts) take a RoomTabCaller: the tab and project main
// resolved from the caller's session token (CliCall.tabId's rule: never from the payload). The member's name and
// coordinator flag come from the registry by that tab, never from the request. A tab whose room is in another project
// than the token's answers as a tab in no room. The owner-side calls (ctx.rooms, Task 10) take a RoomOwner built by main
// from the calling host's own plugin and window; every one of them looks the room up through the registry first (a
// foreign room is "no such room") before it touches the docs or the log. The person's calls (the room view, Tasks 13
// and 14) are main's after its own window check.
//
// No Electron: the tab manager and the session registry come in as the slices used, so vitest drives the decisions
// with the real registries.
import type { TabKind } from '../../shared/types'
import type { TabRoom } from '../../shared/tab-room'
import type { SessionEntry, SessionRoom, TabStatus } from '../sessions/status-reducer'
import type { TabRoomHooks } from '../tabs/tab-manager'
import { warnLog } from '../warn-log'
import { fenceMessages, newFenceNonce } from './room-fence'
import { RoomDelivery, type RecipientAnswer, type RoomSendLimits } from './room-delivery'
import { RoomDocs, type RoomDocCaller, type RoomDocEntry } from './room-docs'
import type { RoomLogEntry } from './room-log'
import {
  RoomError,
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
}

/** The session registry as the room service uses it (SessionRegistry). */
export interface RoomServiceSessions {
  get(tabId: string): SessionEntry | undefined
  sendPointer(tabId: string, text: string): boolean
  setRoom(tabId: string, room: (SessionRoom & { held: number }) | null): boolean
  onPersonInput(listener: (tabId: string) => void): () => void
  onPersonPrompt(listener: (tabId: string) => void): () => void
}

export interface RoomServiceOptions {
  /** `<data>/rooms`. */
  dir: string
  tabs: RoomServiceTabs
  sessions: RoomServiceSessions
  /** The plugin's room send caps (Task 11: the person's override); the defaults when absent. */
  limits?(pluginId: string): RoomSendLimits
  now?: () => number
  newId?: () => string
  random?: (bytes: number) => Buffer
  /** Tests: a fixed nonce per read. */
  nonce?: () => string
  /** Tests: fixed ack ids and a short ack timeout (room-stop.ts). */
  newAckId?: () => string
  ackTimeoutMs?: number
  log?: (message: string) => void
}

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

/** `ccc room read`: how many messages were taken and the fenced text (empty for none). */
export interface RoomReadResult {
  count: number
  text: string
}

const NOT_IN_ROOM = 'this tab is in no room'

export class RoomService {
  readonly registry: RoomRegistry
  readonly docs: RoomDocs
  readonly delivery: RoomDelivery
  /** The Stop decision: hookHandler and hookAckHandler take it (index.ts). */
  readonly stop: RoomStop
  private readonly nonce: () => string
  private readonly warn: (message: string) => void
  private readonly unsubscribe: Array<() => void> = []

  constructor(private readonly options: RoomServiceOptions) {
    this.warn = options.log ?? warnLog
    this.nonce = options.nonce ?? newFenceNonce
    this.registry = new RoomRegistry({
      dir: options.dir,
      ...(options.now ? { now: options.now } : {}),
      ...(options.newId ? { newId: options.newId } : {}),
      ...(options.random ? { random: options.random } : {}),
      log: this.warn
    })
    this.docs = new RoomDocs({
      dir: options.dir,
      logOf: (roomId) => this.registry.logOf(roomId),
      log: this.warn,
      ...(options.random ? { random: options.random } : {})
    })
    const tabRoom = (tabId: string): TabRoom | undefined => this.tabRoom(tabId)
    this.stop = new RoomStop({
      rooms: this.registry,
      sessions: options.sessions,
      tabRoom,
      ...(options.newAckId ? { newAckId: options.newAckId } : {}),
      ...(options.ackTimeoutMs !== undefined ? { ackTimeoutMs: options.ackTimeoutMs } : {}),
      log: this.warn
    })
    this.delivery = new RoomDelivery({
      rooms: this.registry,
      sessions: options.sessions,
      tabRoom,
      ...(options.limits ? { limits: (pluginId: string) => options.limits!(pluginId) } : {}),
      // A pointer main pasted on its own decision counts toward the room's auto-pause (room-stop.ts delivered).
      delivered: (roomId) => this.stop.delivered(roomId),
      ...(options.now ? { now: options.now } : {}),
      log: this.warn
    })
    // The person's keystrokes reset the room's auto-pause count; the person's prompt ends the tab's run of Stop blocks.
    this.unsubscribe.push(options.sessions.onPersonInput((tabId) => this.stop.personInput(tabId)))
    this.unsubscribe.push(options.sessions.onPersonPrompt((tabId) => this.stop.personPrompt(tabId)))
  }

  /** Read the saved rooms (each comes back paused). Before any tab is restored, so the saved memberships can rebind. */
  load(): void {
    this.registry.load()
  }

  /**
   * TabManagerOptions.rooms: what a member tab's comings and goings mean (tab-manager.ts TabRoomHooks). A restored
   * tab's saved membership is bound only when the registry still has that member free, with the registry's
   * coordinator flag; the person's close ends the membership (the coordinators are told and offered the pointer); a
   * window or app going away only unbinds it.
   */
  readonly tabHooks: TabRoomHooks = {
    rebind: (tabId, room) => {
      if (!this.registry.rebind(tabId, room.id, room.name)) return undefined
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

  /** `ccc room read`: every message waiting for the caller, fenced under a fresh nonce, and dequeued. */
  read(caller: RoomTabCaller): RoomReadResult {
    const { member, room } = this.requireMember(caller)
    const messages = this.registry.take(room.id, member.name)
    this.delivery.syncTab(caller.tabId)
    return { count: messages.length, text: messages.length === 0 ? '' : fenceMessages(room.title, messages, this.nonce()) }
  }

  docList(caller: RoomTabCaller): Promise<RoomDocEntry[]> {
    const { roomId, doc } = this.docCaller(caller)
    return this.docs.list(roomId, doc)
  }

  docGet(caller: RoomTabCaller, path: unknown): Promise<string> {
    const { roomId, doc } = this.docCaller(caller)
    return this.docs.get(roomId, doc, path)
  }

  docPut(caller: RoomTabCaller, path: unknown, text: unknown): Promise<void> {
    const { roomId, doc } = this.docCaller(caller)
    return this.docs.put(roomId, doc, path, text)
  }

  // --- the owner (ctx.rooms, Task 10): main built `owner` from the calling host ---

  create(owner: RoomOwner, opts: { title: unknown }): RoomRecord {
    return this.registry.create(owner, opts)
  }

  list(owner: RoomOwner): RoomRecord[] {
    return this.registry.list(owner)
  }

  /** End the owner's room: every tab it had bound leaves it (record, mirror), and its counts are forgotten. */
  end(owner: RoomOwner, id: unknown): void {
    const room = this.registry.get(owner, id)
    const bound = this.boundTabs(room.id)
    this.registry.end(owner, room.id)
    this.roomEnded(room, bound)
  }

  /** End every live room of a plugin (disabled, removed or revoked: design-rooms.md §1), in every project. */
  endAllOf(pluginId: string, why = 'plugin gone'): void {
    const rooms = this.registry.liveRoomsOf(pluginId).map((room) => ({ room, bound: this.boundTabs(room.id) }))
    this.registry.endAllOf(pluginId, why)
    for (const { room, bound } of rooms) this.roomEnded(room, bound)
  }

  /** Delete the owner's ended room (record, log, docs). */
  delete(owner: RoomOwner, id: unknown): void {
    const room = this.registry.get(owner, id)
    this.registry.delete(owner, room.id)
    this.delivery.forget(room.id)
    this.stop.roomGone(room.id)
  }

  /**
   * A tab the owner's host opened into the room (ctx.rooms.open, Task 10, after it created the tab in its own window):
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

  /** ctx.rooms.send: a message `from plugin` (the owner's own room only). */
  sendAsPlugin(owner: RoomOwner, id: unknown, to: unknown, text: unknown): RecipientAnswer[] {
    const room = this.registry.get(owner, id)
    return this.delivery.send(room.id, 'plugin', to, text)
  }

  ownerDocList(owner: RoomOwner, id: unknown): Promise<RoomDocEntry[]> {
    return this.docs.list(this.registry.get(owner, id).id, 'plugin')
  }

  ownerDocGet(owner: RoomOwner, id: unknown, path: unknown): Promise<string> {
    return this.docs.get(this.registry.get(owner, id).id, 'plugin', path)
  }

  ownerDocPut(owner: RoomOwner, id: unknown, path: unknown, text: unknown): Promise<void> {
    return this.docs.put(this.registry.get(owner, id).id, 'plugin', path, text)
  }

  /** ctx.rooms.log: the owner's room's events, newer than `since` when given. */
  log(owner: RoomOwner, id: unknown, opts: { since?: unknown; limit?: unknown } = {}): RoomLogEntry[] {
    const room = this.registry.get(owner, id)
    return this.registry.logOf(room.id).read({
      ...(typeof opts.since === 'number' ? { since: opts.since } : {}),
      ...(typeof opts.limit === 'number' ? { limit: opts.limit } : {})
    })
  }

  // --- the person (the room view and the tab strip, Tasks 13 and 14; main checked the window) ---

  pause(roomId: string): void {
    this.registry.pause(roomId)
  }

  /** Resume a room and offer every member what waits for it. */
  resume(roomId: string): void {
    this.registry.resume(roomId)
    for (const m of this.registry.memberInfos(roomId)) this.delivery.offer(roomId, m.name)
  }

  /** The held badge's click (rooms.deliverHeld, Task 13): the pointer as the person's own act. */
  deliverHeld(tabId: string): boolean {
    return this.delivery.deliverHeld(tabId)
  }

  /** App quit: the room stop's ack timers stop and the listeners go. */
  dispose(): void {
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

  private roomEnded(room: RoomRecord, bound: string[]): void {
    for (const tabId of bound) this.releaseTab(room.projectId, tabId)
    this.delivery.forget(room.id)
    this.stop.roomGone(room.id)
  }
}
