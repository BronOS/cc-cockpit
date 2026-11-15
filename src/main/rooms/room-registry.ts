// Rooms, their members, invites and per-member queues (design-rooms.md §1, §2), persisted one file per room under
// `<data>/rooms/<id>/room.json`. Pure logic plus node:fs, no Electron: the room service (Task 8) wires it to tabs,
// the send gate and the socket. Every identity comes from the caller main resolved (the host's own plugin and
// project, the tab id the token named); nothing here reads an id from a payload.
//
// Tab binding is memory only: restored tabs get new ids (tab-manager.ts, randomUUID), so the saved membership lives
// in the tab record (Task 4) and is rebound here with `rebind`. A member whose tab is gone for a quit or a window
// close stays a member with no tab.
import { randomBytes, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, rmSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../hooks/write-file-atomic'
import { VERIFIED_OPEN_FLAGS } from '../verified-read'
import { warnLog } from '../warn-log'
import { RoomLog, type RoomLogType } from './room-log'
import { checkRoomName, checkRoomTitle, isRoomId, isRoomName } from '../../shared/room-names'

/**
 * Rooms a plugin may have that are not ended, in one project (design-rooms.md §1). Counted per project, not app-wide:
 * a host sees, ends and deletes only its own project's rooms, so rooms left live in another project (whose window may
 * be closed) must not block this one.
 */
export const MAX_ROOMS_PER_PLUGIN = 5
/** Members a room may have. */
export const MAX_MEMBERS_PER_ROOM = 20
/** How long an invite can be redeemed. */
export const INVITE_TTL_MS = 10 * 60 * 1000
/** Invites a room may have waiting at once: each is an in-memory entry for ten minutes and a log line. */
export const MAX_PENDING_INVITES_PER_ROOM = 20
/** The longest message, in characters (code points; design-rooms.md §2: longer goes in a doc). */
export const MAX_ROOM_MESSAGE_CHARS = 20_000
/** Messages one member may have waiting: a member that never reads (or a paused room) cannot grow without bound. */
export const MAX_QUEUED_PER_MEMBER = 100
/**
 * Queued text a room may hold, in UTF-16 units, across its members: every enqueue rewrites the whole room.json, so
 * the record stays small enough to rewrite on each send.
 */
export const MAX_QUEUED_CHARS_PER_ROOM = 1_000_000
/** The largest room.json read at start: the queued-text cap with JSON's worst escaping (`\uXXXX`, 6 bytes) and room to spare. */
export const MAX_ROOM_FILE_BYTES = 8 * 1024 * 1024

/**
 * The sender of main's own notices to a room (a member's tab closed, design-rooms.md §7 "Failures"). A reserved name,
 * so no member can take it; never the person.
 */
export const SYSTEM_SENDER = 'system'

export interface RoomMessage {
  id: string
  /** A member name, `plugin` (the owner's `ctx.rooms.send`) or `system` (main's own notices); never the person. */
  from: string
  text: string
  at: number
}

export interface RoomMemberRecord {
  coordinator: boolean
}

/** The saved record (plan "Technical Details"). Plain data: copies go out, never the live object. */
export interface RoomRecord {
  id: string
  pluginId: string
  projectId: string
  title: string
  createdAt: number
  endedAt?: number
  paused: boolean
  members: Record<string, RoomMemberRecord>
  queues: Record<string, RoomMessage[]>
}

/** Who owns a room: the plugin and the project (one window per project) whose host created it. */
export interface RoomOwner {
  pluginId: string
  projectId: string
}

export interface RoomMemberInfo {
  name: string
  coordinator: boolean
  /** The tab bound to this member now; absent after a quit until the restore rebinds it. */
  tabId?: string
  held: number
}

export interface RoomMembership {
  roomId: string
  name: string
  coordinator: boolean
}

export interface RoomInvite {
  code: string
  expiresAt: number
}

/** Why a member left, as the log says it (design-rooms.md §4). */
export type LeaveWhy = 'left' | 'removed' | 'closed'

export type RoomErrorCode = 'not-found' | 'invalid' | 'limit' | 'conflict' | 'ended' | 'error'

/** A refusal with a stable code; `not-found` is also the answer for another plugin's room (no way to probe ids). */
export class RoomError extends Error {
  constructor(
    readonly code: RoomErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'RoomError'
  }
}

export interface RoomRegistryOptions {
  /** `<data>/rooms`. */
  dir: string
  now?: () => number
  newId?: () => string
  /** Random bytes for invite codes (tests pin them). */
  random?: (bytes: number) => Buffer
  log?: (message: string) => void
}

interface PendingInvite {
  roomId: string
  name: string
  coordinator: boolean
  expiresAt: number
}

const NO_ROOM = 'no such room'
const NO_INVITE = 'invite is not valid (unknown, used or expired)'

/** RFC 4648 base32, lower case: an invite is copied by a model or typed by a person, and the alphabet has no 0 or 1 to misread. */
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

function base32(bytes: Buffer): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export class RoomRegistry {
  private readonly rooms = new Map<string, RoomRecord>()
  private readonly logs = new Map<string, RoomLog>()
  private readonly invites = new Map<string, PendingInvite>()
  /** tabId → membership; the reverse lookup is `boundTab`. One room per tab. */
  private readonly tabs = new Map<string, { roomId: string; name: string }>()
  private readonly now: () => number
  private readonly newId: () => string
  private readonly random: (bytes: number) => Buffer
  private readonly warn: (message: string) => void

  constructor(private readonly options: RoomRegistryOptions) {
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? randomUUID
    this.random = options.random ?? randomBytes
    this.warn = options.log ?? warnLog
  }

  /**
   * Read every `<dir>/<id>/room.json`. Each room comes back paused (design-rooms.md §1 "Restart": nothing is
   * delivered until the person resumes it), with no tab bound. A bad file loses only that room, with a warning.
   */
  load(): void {
    let entries: Dirent[]
    try {
      entries = readdirSync(this.options.dir, { withFileTypes: true })
    } catch {
      return // no rooms yet
    }
    for (const entry of entries) {
      // isDirectory is lstat-based: a link planted as a room directory is skipped, never followed.
      if (!entry.isDirectory()) continue
      const path = join(this.options.dir, entry.name, 'room.json')
      let room: RoomRecord | null
      try {
        room = parseRoom(JSON.parse(readRoomFile(path)), entry.name)
      } catch (err) {
        this.warn(`rooms: skipped ${path}: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      if (!room) {
        this.warn(`rooms: skipped ${path}: not a valid room record`)
        continue
      }
      room.paused = true
      this.rooms.set(room.id, room)
    }
  }

  create(owner: RoomOwner, opts: { title: unknown }): RoomRecord {
    const title = checkRoomTitle(opts.title)
    if (!title.ok) throw new RoomError('invalid', title.reason)
    let live = 0
    for (const r of this.rooms.values()) if (owns(owner, r) && r.endedAt === undefined) live++
    if (live >= MAX_ROOMS_PER_PLUGIN) {
      throw new RoomError('limit', `a plugin may have at most ${MAX_ROOMS_PER_PLUGIN} rooms that are not ended in a project`)
    }
    const room: RoomRecord = {
      id: this.newId(),
      pluginId: owner.pluginId,
      projectId: owner.projectId,
      title: title.value,
      createdAt: this.now(),
      paused: false,
      members: record(),
      queues: record()
    }
    this.rooms.set(room.id, room)
    this.save(room)
    this.logEvent(room.id, 'create', { title: room.title, pluginId: room.pluginId })
    return copy(room)
  }

  /** The owner's rooms, ended ones included (they stay until `delete`). */
  list(owner: RoomOwner): RoomRecord[] {
    return [...this.rooms.values()].filter((r) => owns(owner, r)).map(copy)
  }

  /** A copy of the owner's room; another plugin's or project's room answers as unknown. */
  get(owner: RoomOwner, id: unknown): RoomRecord {
    return copy(this.owned(owner, id))
  }

  /** A copy of any room, for main's own paths (the room view, delivery); never reached with a plugin's id unchecked. */
  peek(id: string): RoomRecord | undefined {
    const r = this.rooms.get(id)
    return r ? copy(r) : undefined
  }

  /** End a room: its tabs are released and its invites dropped; the record, queues and docs stay until `delete`. */
  end(owner: RoomOwner, id: unknown): void {
    this.endRoom(this.owned(owner, id), 'ended')
  }

  /** End every room of a plugin (disabled, removed or revoked; design-rooms.md §1). Docs stay. */
  endAllOf(pluginId: string, why = 'plugin gone'): void {
    for (const r of this.rooms.values()) if (r.pluginId === pluginId && r.endedAt === undefined) this.endRoom(r, why)
  }

  /** Delete an ended room and everything under its directory (record, log, docs). */
  delete(owner: RoomOwner, id: unknown): void {
    const room = this.owned(owner, id)
    if (room.endedAt === undefined) throw new RoomError('conflict', 'only an ended room can be deleted')
    // The directory first: a failed rm (EACCES, EBUSY) throws with the room still here, rather than gone from this run
    // and back at the next start.
    rmSync(join(this.options.dir, room.id), { recursive: true, force: true })
    this.rooms.delete(room.id)
    this.logs.delete(room.id)
  }

  /** A tab the plugin opened into the room (`ctx.rooms.open`): a member from the start. */
  addMember(owner: RoomOwner, id: unknown, member: { tabId: string; name: unknown; coordinator?: unknown }): RoomMembership {
    const room = this.owned(owner, id)
    const name = this.checkJoin(room, member.name, member.tabId)
    return this.join(room, name, member.coordinator === true, member.tabId, 'open')
  }

  /** Mint a one-time invite for a name; the tab that redeems it joins under that name. */
  invite(owner: RoomOwner, id: unknown, opts: { name: unknown; coordinator?: unknown }): RoomInvite {
    const room = this.owned(owner, id)
    if (room.endedAt !== undefined) throw new RoomError('ended', 'the room has ended')
    const name = checkRoomName(opts.name)
    if (!name.ok) throw new RoomError('invalid', name.reason)
    if (Object.hasOwn(room.members, name.value)) throw new RoomError('conflict', `"${name.value}" is already a member`)
    this.dropExpired()
    let pending = 0
    for (const inv of this.invites.values()) if (inv.roomId === room.id) pending++
    if (pending >= MAX_PENDING_INVITES_PER_ROOM) {
      throw new RoomError('limit', `a room may have at most ${MAX_PENDING_INVITES_PER_ROOM} invites waiting`)
    }
    const code = base32(this.random(16))
    const expiresAt = this.now() + INVITE_TTL_MS
    const coordinator = opts.coordinator === true
    this.invites.set(code, { roomId: room.id, name: name.value, coordinator, expiresAt })
    // Never the code itself: it is a credential until used, and the log is shown and handed to the plugin.
    this.logEvent(room.id, 'invite', { member: name.value, coordinator, expiresAt })
    return { code, expiresAt }
  }

  /**
   * `ccc room join <invite>` from the tab main resolved from the caller's token, with that tab's project (main's too).
   * Single use: consumed on success, and an expired one is dropped; an unknown, used or expired code all answer the
   * same. A tab of another project answers the same as well (no rooms across windows, design-rooms.md §1): a plugin
   * hands codes out through its own commands, so one can reach a tab in another window.
   */
  redeem(code: unknown, tabId: string, projectId: string): RoomMembership {
    if (typeof code !== 'string') throw new RoomError('not-found', NO_INVITE)
    const key = code.trim().toLowerCase()
    const inv = this.invites.get(key)
    if (!inv) throw new RoomError('not-found', NO_INVITE)
    if (this.now() >= inv.expiresAt) {
      this.invites.delete(key)
      throw new RoomError('not-found', NO_INVITE)
    }
    const room = this.rooms.get(inv.roomId)
    if (!room || room.endedAt !== undefined) {
      this.invites.delete(key)
      throw new RoomError('not-found', NO_INVITE)
    }
    // Kept unused: the refusal is the tab's, and another window must not be able to burn the room's invites.
    if (room.projectId !== projectId) throw new RoomError('not-found', NO_INVITE)
    // A tab already in a room keeps the invite unused: the refusal is the tab's, not the invite's.
    const name = this.checkJoin(room, inv.name, tabId)
    this.invites.delete(key)
    return this.join(room, name, inv.coordinator, tabId, 'invite')
  }

  /** The tab leaves by itself (`ccc room leave`) or the person closed it (`closed`). Its queue is dropped. */
  leave(tabId: string, why: Extract<LeaveWhy, 'left' | 'closed'> = 'left'): RoomMembership | undefined {
    const bound = this.tabs.get(tabId)
    if (!bound) return undefined
    const room = this.rooms.get(bound.roomId)
    if (!room) {
      this.tabs.delete(tabId)
      return undefined
    }
    return this.dropMember(room, bound.name, why)
  }

  /**
   * The person closed a member's tab (TabRoomHooks.closed): the member leaves (`closed`, its queue dropped and logged
   * with the count) and every coordinator still in the room is told by a `system` message, `<name> left: tab closed`
   * (design-rooms.md §7 "Failures"). A coordinator whose queue is full misses the notice (warned); the log has it.
   * Undefined for a tab in no room.
   */
  memberClosed(tabId: string): RoomMembership | undefined {
    const left = this.leave(tabId, 'closed')
    if (!left) return undefined
    const room = this.rooms.get(left.roomId)
    if (!room || room.endedAt !== undefined) return left
    for (const [name, m] of Object.entries(room.members)) {
      if (!m.coordinator) continue
      try {
        this.enqueue(room.id, name, { from: SYSTEM_SENDER, text: `${left.name} left: tab closed` })
      } catch (err) {
        this.warn(`rooms: could not tell ${name} in ${room.id} that ${left.name} left: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return left
  }

  /** The owner (`ctx.rooms.remove`) or the person (`'person'`, the room view: main checked the window) removes a member. */
  remove(owner: RoomOwner | 'person', id: unknown, name: unknown): RoomMembership {
    const room = owner === 'person' ? this.byId(id) : this.owned(owner, id)
    if (!isMember(room, name)) throw new RoomError('not-found', 'no such member')
    return this.dropMember(room, name, 'removed')
  }

  /** The owner's view of the members. */
  members(owner: RoomOwner, id: unknown): RoomMemberInfo[] {
    return this.memberInfos(this.owned(owner, id))
  }

  /** The same for main's own paths (status, room view). */
  memberInfos(room: RoomRecord | string): RoomMemberInfo[] {
    const r = typeof room === 'string' ? this.byId(room) : (this.rooms.get(room.id) ?? room)
    return Object.entries(r.members).map(([name, m]) => {
      const tabId = this.boundTab(r.id, name)
      return { name, coordinator: m.coordinator, held: queueOf(r, name)?.length ?? 0, ...(tabId ? { tabId } : {}) }
    })
  }

  /** The room membership of a tab, if any. */
  memberOf(tabId: string): RoomMembership | undefined {
    const bound = this.tabs.get(tabId)
    if (!bound) return undefined
    const room = this.rooms.get(bound.roomId)
    const m = room && isMember(room, bound.name) ? room.members[bound.name] : undefined
    return m ? { roomId: bound.roomId, name: bound.name, coordinator: m.coordinator } : undefined
  }

  /** The tab bound to a member now. */
  boundTab(roomId: string, name: string): string | undefined {
    for (const [tabId, b] of this.tabs) if (b.roomId === roomId && b.name === name) return tabId
    return undefined
  }

  /**
   * A restored tab's saved membership (Task 4): bound only when the room is there and not ended, the name is still a
   * member and no other tab holds it. False otherwise (the tab just loses its membership).
   */
  rebind(tabId: string, roomId: string, name: string): boolean {
    const room = this.rooms.get(roomId)
    if (!room || room.endedAt !== undefined || !isMember(room, name)) return false
    if (this.tabs.has(tabId) || this.boundTab(roomId, name) !== undefined) return false
    this.tabs.set(tabId, { roomId, name })
    return true
  }

  /** The tab is gone for a quit or a window close: the member stays, with no tab, until a restore rebinds it. */
  unbind(tabId: string): void {
    this.tabs.delete(tabId)
  }

  /** Pause delivery (the person in the room view, or the auto-pause, `auto`). An ended room is left as it is. */
  pause(id: string, opts: { auto?: boolean } = {}): void {
    const room = this.byId(id)
    if (room.paused || room.endedAt !== undefined) return
    room.paused = true
    this.save(room)
    this.logEvent(room.id, opts.auto ? 'auto-pause' : 'pause', {})
  }

  /** Resume delivery; a no-op for an ended room (nothing is delivered after the end, and the log stays ended). */
  resume(id: string): void {
    const room = this.byId(id)
    if (!room.paused || room.endedAt !== undefined) return
    room.paused = false
    this.save(room)
    this.logEvent(room.id, 'resume', {})
  }

  /**
   * Queue a message for one member. The send itself (and its delivery path) is logged by the delivery (Task 5). `from`
   * is a member name, `plugin` or `system`, checked here too: it goes into the fence header a member reads.
   */
  enqueue(roomId: string, to: unknown, msg: { from: string; text: string }): RoomMessage {
    const room = this.byId(roomId)
    if (room.endedAt !== undefined) throw new RoomError('ended', 'the room has ended')
    if (!isMember(room, to)) throw new RoomError('not-found', 'no such member')
    if (!isSender(msg.from)) throw new RoomError('invalid', 'a message is from a member name or plugin')
    if (!isMessageText(msg.text)) {
      throw new RoomError('invalid', `a message is text of at most ${MAX_ROOM_MESSAGE_CHARS} characters`)
    }
    const queue = queueOf(room, to) ?? []
    if (queue.length >= MAX_QUEUED_PER_MEMBER) {
      throw new RoomError('limit', `a member may have at most ${MAX_QUEUED_PER_MEMBER} messages waiting`)
    }
    if (queuedChars(room) + msg.text.length > MAX_QUEUED_CHARS_PER_ROOM) {
      throw new RoomError('limit', `a room may hold at most ${MAX_QUEUED_CHARS_PER_ROOM} characters of waiting messages`)
    }
    const message: RoomMessage = { id: this.newId(), from: msg.from, text: msg.text, at: this.now() }
    queue.push(message)
    room.queues[to] = queue
    this.save(room)
    return { ...message }
  }

  /** How many messages wait for a member. */
  held(roomId: string, name: string): number {
    const room = this.rooms.get(roomId)
    return room ? (queueOf(room, name)?.length ?? 0) : 0
  }

  /** Dequeue every message for a member (its own `ccc room read`). */
  take(roomId: string, name: string): RoomMessage[] {
    const room = this.rooms.get(roomId)
    const queue = room ? queueOf(room, name) : undefined
    if (!room || !queue || queue.length === 0) return []
    delete room.queues[name]
    this.save(room)
    return queue.map((m) => ({ ...m }))
  }

  /**
   * The room's log (created on first use), for the delivery, docs and `ctx.rooms.log`. Only for a room that exists:
   * the id is joined into a path and the first append makes the directory, so an unchecked id (`../x`) or a deleted
   * room's would write outside a room or bring its directory back.
   */
  logOf(roomId: string): RoomLog {
    const room = this.byId(roomId)
    let log = this.logs.get(room.id)
    if (!log) {
      log = new RoomLog(join(this.options.dir, roomId, 'log.jsonl'), undefined, this.now)
      this.logs.set(roomId, log)
    }
    return log
  }

  /** Append to the room's log; a failed append is a warning, never a refused change (the change already happened). */
  private logEvent(roomId: string, type: RoomLogType, fields: Record<string, unknown>): void {
    try {
      this.logOf(roomId).append(type, fields)
    } catch (err) {
      this.warn(`rooms: could not log to ${roomId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private checkJoin(room: RoomRecord, rawName: unknown, tabId: string): string {
    if (room.endedAt !== undefined) throw new RoomError('ended', 'the room has ended')
    const name = checkRoomName(rawName)
    if (!name.ok) throw new RoomError('invalid', name.reason)
    if (Object.hasOwn(room.members, name.value)) throw new RoomError('conflict', `"${name.value}" is already a member`)
    if (this.tabs.has(tabId)) throw new RoomError('conflict', 'the tab is already in a room')
    if (Object.keys(room.members).length >= MAX_MEMBERS_PER_ROOM) {
      throw new RoomError('limit', `a room may have at most ${MAX_MEMBERS_PER_ROOM} members`)
    }
    return name.value
  }

  private join(room: RoomRecord, name: string, coordinator: boolean, tabId: string, via: 'open' | 'invite'): RoomMembership {
    room.members[name] = { coordinator }
    this.tabs.set(tabId, { roomId: room.id, name })
    this.save(room)
    this.logEvent(room.id, 'join', { member: name, coordinator, via })
    return { roomId: room.id, name, coordinator }
  }

  private dropMember(room: RoomRecord, name: string, why: LeaveWhy): RoomMembership {
    const coordinator = isMember(room, name) && room.members[name]?.coordinator === true
    const dropped = queueOf(room, name)?.length ?? 0
    delete room.members[name]
    delete room.queues[name]
    const tabId = this.boundTab(room.id, name)
    if (tabId) this.tabs.delete(tabId)
    this.save(room)
    this.logEvent(room.id, 'leave', { member: name, why, dropped })
    return { roomId: room.id, name, coordinator }
  }

  private endRoom(room: RoomRecord, why: string): void {
    if (room.endedAt !== undefined) return
    room.endedAt = this.now()
    for (const [tabId, b] of this.tabs) if (b.roomId === room.id) this.tabs.delete(tabId)
    for (const [code, inv] of this.invites) if (inv.roomId === room.id) this.invites.delete(code)
    this.save(room)
    this.logEvent(room.id, 'end', { why })
  }

  private dropExpired(): void {
    const now = this.now()
    for (const [code, inv] of this.invites) if (now >= inv.expiresAt) this.invites.delete(code)
  }

  private byId(id: unknown): RoomRecord {
    const room = typeof id === 'string' ? this.rooms.get(id) : undefined
    if (!room) throw new RoomError('not-found', NO_ROOM)
    return room
  }

  /** The room when the caller owns it; another plugin's or another project's room is "no such room" (no probing). */
  private owned(owner: RoomOwner, id: unknown): RoomRecord {
    const room = typeof id === 'string' ? this.rooms.get(id) : undefined
    if (!room || !owns(owner, room)) throw new RoomError('not-found', NO_ROOM)
    return room
  }

  /**
   * Write the record. A failed write is a warning, not a refusal: the change already happened in memory and is what
   * this run delivers by; the next change writes the whole record again.
   */
  private save(room: RoomRecord): void {
    const dir = join(this.options.dir, room.id)
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileAtomic(join(dir, 'room.json'), JSON.stringify(room) + '\n', 0o600)
    } catch (err) {
      this.warn(`rooms: could not save ${room.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

function owns(owner: RoomOwner, room: RoomRecord): boolean {
  return room.pluginId === owner.pluginId && room.projectId === owner.projectId
}

/**
 * The live `members` and `queues` have no prototype: names come from plugins and tabs, and on a plain `{}` an
 * inherited key (`constructor`, `toString`) reads as present and `queues['__proto__'] = list` would replace the
 * prototype. Every lookup also goes through `Object.hasOwn` (isMember, queueOf).
 */
function record<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

function isMember(room: RoomRecord, name: unknown): name is string {
  return typeof name === 'string' && Object.hasOwn(room.members, name)
}

function queueOf(room: RoomRecord, name: string): RoomMessage[] | undefined {
  return Object.hasOwn(room.queues, name) ? room.queues[name] : undefined
}

function queuedChars(room: RoomRecord): number {
  let n = 0
  for (const q of Object.values(room.queues)) for (const m of q) n += m.text.length
  return n
}

/** Who a message may be from: a member name's shape, the owner (`plugin`) or main (`system`); it is printed in the fence header. */
function isSender(from: unknown): from is string {
  return from === 'plugin' || from === SYSTEM_SENDER || isRoomName(from)
}

/** A message's text: a string of at most MAX_ROOM_MESSAGE_CHARS code points (the delivery checks it before counting a send). */
export function isMessageText(text: unknown): text is string {
  if (typeof text !== 'string') return false
  if (text.length <= MAX_ROOM_MESSAGE_CHARS) return true
  if (text.length > MAX_ROOM_MESSAGE_CHARS * 2) return false // more code points than the cap even if all are pairs
  // Code points: each surrogate pair is one character.
  let n = text.length
  for (let i = 0; i < text.length - 1; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        n--
        i++
      }
    }
  }
  return n <= MAX_ROOM_MESSAGE_CHARS
}

/** A copy for a caller, with the same prototype-less maps as the live record (a caller may look names up in it). */
function copy(room: RoomRecord): RoomRecord {
  const out = structuredClone(room)
  out.members = Object.assign(record<RoomMemberRecord>(), out.members)
  out.queues = Object.assign(record<RoomMessage[]>(), out.queues)
  return out
}

/**
 * room.json, read like the doc store reads docs: O_NOFOLLOW (a room.json planted as a link is refused, ELOOP),
 * O_NONBLOCK and an fstat regular-file check (a FIFO would block main at start), and a size cap checked on the
 * descriptor and while reading. Throws on any refusal; `load` turns that into a skipped room.
 */
function readRoomFile(path: string): string {
  const fd = openSync(path, VERIFIED_OPEN_FLAGS)
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new Error('not a regular file')
    if (st.size > MAX_ROOM_FILE_BYTES) throw new Error(`larger than ${MAX_ROOM_FILE_BYTES} bytes`)
    const buf = Buffer.alloc(st.size + 1)
    let length = 0
    for (;;) {
      if (length === buf.length) throw new Error(`larger than ${MAX_ROOM_FILE_BYTES} bytes`)
      const n = readSync(fd, buf, length, buf.length - length, null)
      if (n === 0) break
      length += n
    }
    return buf.subarray(0, length).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** A room id's shape (one rule with the saved tab record, shared/room-names.ts isRoomId); the doc store checks it too. */
export const isUuid = isRoomId

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * A saved record, checked field by field (the file is user-writable): the id must be the directory's and a UUID, the
 * title and every member name must pass today's rules, and a queue must belong to a member. Null when anything is off.
 */
function parseRoom(v: unknown, dirName: string): RoomRecord | null {
  if (!isObject(v)) return null
  const { id, pluginId, projectId, title, createdAt, endedAt, members, queues } = v
  if (typeof id !== 'string' || id !== dirName || !isUuid(id)) return null
  if (typeof pluginId !== 'string' || pluginId === '' || typeof projectId !== 'string' || projectId === '') return null
  const t = checkRoomTitle(title)
  if (!t.ok || t.value !== title) return null
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null
  if (endedAt !== undefined && (typeof endedAt !== 'number' || !Number.isFinite(endedAt))) return null
  if (!isObject(members) || !isObject(queues)) return null
  const outMembers = record<RoomMemberRecord>()
  for (const [name, m] of Object.entries(members)) {
    if (!isRoomName(name) || !isObject(m) || typeof m.coordinator !== 'boolean') return null
    outMembers[name] = { coordinator: m.coordinator }
  }
  if (Object.keys(outMembers).length > MAX_MEMBERS_PER_ROOM) return null
  const outQueues = record<RoomMessage[]>()
  let chars = 0
  for (const [name, q] of Object.entries(queues)) {
    if (!Object.hasOwn(outMembers, name) || !Array.isArray(q) || q.length > MAX_QUEUED_PER_MEMBER) return null
    const list: RoomMessage[] = []
    for (const m of q) {
      if (!isObject(m)) return null
      if (typeof m.id !== 'string' || !isSender(m.from) || !isMessageText(m.text)) return null
      if (typeof m.at !== 'number' || !Number.isFinite(m.at)) return null
      chars += m.text.length
      list.push({ id: m.id, from: m.from, text: m.text, at: m.at })
    }
    if (list.length > 0) outQueues[name] = list
  }
  if (chars > MAX_QUEUED_CHARS_PER_ROOM) return null
  return {
    id,
    pluginId,
    projectId,
    title: t.value,
    createdAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
    paused: true,
    members: outMembers,
    queues: outQueues
  }
}
