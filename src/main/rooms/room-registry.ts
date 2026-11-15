// Rooms, their members, invites and per-member queues (design-rooms.md §1, §2), persisted one file per room under
// `<data>/rooms/<id>/room.json`. Pure logic plus node:fs, no Electron: the room service (Task 8) wires it to tabs,
// the send gate and the socket. Every identity comes from the caller main resolved (the host's own plugin and
// project, the tab id the token named); nothing here reads an id from a payload.
//
// Tab binding is memory only: restored tabs get new ids (tab-manager.ts, randomUUID), so the saved membership lives
// in the tab record (Task 4) and is rebound here with `rebind`. A member whose tab is gone for a quit or a window
// close stays a member with no tab.
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../hooks/write-file-atomic'
import { warnLog } from '../warn-log'
import { RoomLog, type RoomLogType } from './room-log'
import { checkRoomName, checkRoomTitle, isRoomName } from './room-names'

/** Rooms a plugin may have that are not ended (design-rooms.md §1). */
export const MAX_ROOMS_PER_PLUGIN = 5
/** Members a room may have. */
export const MAX_MEMBERS_PER_ROOM = 20
/** How long an invite can be redeemed. */
export const INVITE_TTL_MS = 10 * 60 * 1000

export interface RoomMessage {
  id: string
  /** A member name or `plugin` (the owner's `ctx.rooms.send`); never the person. */
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

export type RoomErrorCode = 'not-found' | 'invalid' | 'limit' | 'conflict' | 'ended'

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
        room = parseRoom(JSON.parse(readFileSync(path, 'utf8')), entry.name)
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
    for (const r of this.rooms.values()) if (r.pluginId === owner.pluginId && r.endedAt === undefined) live++
    if (live >= MAX_ROOMS_PER_PLUGIN) {
      throw new RoomError('limit', `a plugin may have at most ${MAX_ROOMS_PER_PLUGIN} rooms that are not ended`)
    }
    const room: RoomRecord = {
      id: this.newId(),
      pluginId: owner.pluginId,
      projectId: owner.projectId,
      title: title.value,
      createdAt: this.now(),
      paused: false,
      members: {},
      queues: {}
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
    this.rooms.delete(room.id)
    this.logs.delete(room.id)
    rmSync(join(this.options.dir, room.id), { recursive: true, force: true })
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
    if (room.members[name.value]) throw new RoomError('conflict', `"${name.value}" is already a member`)
    this.dropExpired()
    const code = base32(this.random(16))
    const expiresAt = this.now() + INVITE_TTL_MS
    const coordinator = opts.coordinator === true
    this.invites.set(code, { roomId: room.id, name: name.value, coordinator, expiresAt })
    // Never the code itself: it is a credential until used, and the log is shown and handed to the plugin.
    this.logEvent(room.id, 'invite', { member: name.value, coordinator, expiresAt })
    return { code, expiresAt }
  }

  /**
   * `ccc room join <invite>` from the tab main resolved from the caller's token. Single use: consumed on success, and
   * an expired one is dropped; an unknown, used or expired code all answer the same.
   */
  redeem(code: unknown, tabId: string): RoomMembership {
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

  /** The owner (`ctx.rooms.remove`) or the person (`'person'`, the room view: main checked the window) removes a member. */
  remove(owner: RoomOwner | 'person', id: unknown, name: unknown): RoomMembership {
    const room = owner === 'person' ? this.byId(id) : this.owned(owner, id)
    if (typeof name !== 'string' || !room.members[name]) throw new RoomError('not-found', 'no such member')
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
      return { name, coordinator: m.coordinator, held: r.queues[name]?.length ?? 0, ...(tabId ? { tabId } : {}) }
    })
  }

  /** The room membership of a tab, if any. */
  memberOf(tabId: string): RoomMembership | undefined {
    const bound = this.tabs.get(tabId)
    if (!bound) return undefined
    const room = this.rooms.get(bound.roomId)
    const m = room?.members[bound.name]
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
    if (!room || room.endedAt !== undefined || !room.members[name]) return false
    if (this.tabs.has(tabId) || this.boundTab(roomId, name) !== undefined) return false
    this.tabs.set(tabId, { roomId, name })
    return true
  }

  /** The tab is gone for a quit or a window close: the member stays, with no tab, until a restore rebinds it. */
  unbind(tabId: string): void {
    this.tabs.delete(tabId)
  }

  /** Pause delivery (the person in the room view, or the auto-pause, `auto`). */
  pause(id: string, opts: { auto?: boolean } = {}): void {
    const room = this.byId(id)
    if (room.paused) return
    room.paused = true
    this.save(room)
    this.logEvent(room.id, opts.auto ? 'auto-pause' : 'pause', {})
  }

  resume(id: string): void {
    const room = this.byId(id)
    if (!room.paused) return
    room.paused = false
    this.save(room)
    this.logEvent(room.id, 'resume', {})
  }

  /** Queue a message for one member. The send itself (and its delivery path) is logged by the delivery (Task 5). */
  enqueue(roomId: string, to: string, msg: { from: string; text: string }): RoomMessage {
    const room = this.byId(roomId)
    if (room.endedAt !== undefined) throw new RoomError('ended', 'the room has ended')
    if (!room.members[to]) throw new RoomError('not-found', 'no such member')
    const message: RoomMessage = { id: this.newId(), from: msg.from, text: msg.text, at: this.now() }
    ;(room.queues[to] ??= []).push(message)
    this.save(room)
    return { ...message }
  }

  /** How many messages wait for a member. */
  held(roomId: string, name: string): number {
    return this.rooms.get(roomId)?.queues[name]?.length ?? 0
  }

  /** Dequeue every message for a member (its own `ccc room read`). */
  take(roomId: string, name: string): RoomMessage[] {
    const room = this.rooms.get(roomId)
    const queue = room?.queues[name]
    if (!room || !queue || queue.length === 0) return []
    delete room.queues[name]
    this.save(room)
    return queue.map((m) => ({ ...m }))
  }

  /** The room's log (created on first use), for the delivery, docs and `ctx.rooms.log`. */
  logOf(roomId: string): RoomLog {
    let log = this.logs.get(roomId)
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
    if (room.members[name.value]) throw new RoomError('conflict', `"${name.value}" is already a member`)
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
    const coordinator = room.members[name]?.coordinator === true
    const dropped = room.queues[name]?.length ?? 0
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

function copy(room: RoomRecord): RoomRecord {
  return structuredClone(room)
}

function isUuid(value: string): boolean {
  if (value.length !== 36) return false
  for (let i = 0; i < 36; i++) {
    const ch = value[i] as string
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (ch !== '-') return false
    } else if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) return false
  }
  return true
}

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
  const outMembers: Record<string, RoomMemberRecord> = {}
  for (const [name, m] of Object.entries(members)) {
    if (!isRoomName(name) || !isObject(m) || typeof m.coordinator !== 'boolean') return null
    outMembers[name] = { coordinator: m.coordinator }
  }
  if (Object.keys(outMembers).length > MAX_MEMBERS_PER_ROOM) return null
  const outQueues: Record<string, RoomMessage[]> = {}
  for (const [name, q] of Object.entries(queues)) {
    if (!outMembers[name] || !Array.isArray(q)) return null
    const list: RoomMessage[] = []
    for (const m of q) {
      if (!isObject(m)) return null
      if (typeof m.id !== 'string' || typeof m.from !== 'string' || typeof m.text !== 'string') return null
      if (typeof m.at !== 'number' || !Number.isFinite(m.at)) return null
      list.push({ id: m.id, from: m.from, text: m.text, at: m.at })
    }
    if (list.length > 0) outQueues[name] = list
  }
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
