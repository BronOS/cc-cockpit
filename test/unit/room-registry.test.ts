import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  INVITE_TTL_MS,
  MAX_ENDED_ROOMS_PER_PLUGIN,
  MAX_MEMBERS_PER_ROOM,
  MAX_PENDING_INVITES_PER_ROOM,
  MAX_QUEUED_CHARS_PER_ROOM,
  MAX_QUEUED_PER_MEMBER,
  MAX_ROOM_FILE_BYTES,
  MAX_ROOM_MESSAGE_CHARS,
  MAX_ROOMS_PER_PLUGIN,
  RoomError,
  RoomRegistry,
  type RoomOwner
} from '../../src/main/rooms/room-registry'
import { checkRoomName, checkRoomTitle, isPathPart, isPathPartChar, ROOM_NAME } from '../../src/shared/room-names'

let dir: string
let t: number
let ids: number
let warnings: string[]

const owner: RoomOwner = { pluginId: 'example.team', projectId: 'p1' }
const other: RoomOwner = { pluginId: 'example.other', projectId: 'p1' }
const otherProject: RoomOwner = { pluginId: 'example.team', projectId: 'p2' }

/** UUID-shaped ids in order, so a reload's directory check passes. */
function nextId(): string {
  ids++
  return `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`
}

function make(): RoomRegistry {
  let n = 0
  return new RoomRegistry({
    dir,
    now: () => t,
    newId: nextId,
    random: (bytes) => Buffer.alloc(bytes, ++n),
    log: (m) => warnings.push(m)
  })
}

function code(err: () => unknown): string | undefined {
  try {
    err()
  } catch (e) {
    return e instanceof RoomError ? e.code : 'other'
  }
  return undefined
}

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'room-registry-')), 'rooms')
  t = 1000
  ids = 0
  warnings = []
})
afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }))

describe('room names', () => {
  it('accepts the name shape and refuses reserved names', () => {
    for (const ok of ['a', 'lead', 'dev-1', 'a' + 'b'.repeat(30)]) expect(checkRoomName(ok).ok).toBe(true)
    for (const bad of ['', 'A', '1a', '-a', 'a_b', 'a b', 'a' + 'b'.repeat(31), 'lead\n', 'é']) {
      expect(checkRoomName(bad).ok).toBe(false)
    }
    for (const reserved of ['all', 'plugin', 'person', 'user', 'system']) {
      expect(checkRoomName(reserved)).toEqual({ ok: false, reason: `name "${reserved}" is reserved` })
      expect(ROOM_NAME.test(reserved)).toBe(false)
    }
    // The reserved words only as whole names.
    expect(checkRoomName('all-hands').ok).toBe(true)
    expect(checkRoomName('users').ok).toBe(true)
    expect(checkRoomName(3).ok).toBe(false)
  })

  it('checks a title character by character', () => {
    expect(checkRoomTitle('  Fix the login bug ')).toEqual({ ok: true, value: 'Fix the login bug' })
    expect(checkRoomTitle('Ünïcode ✓ ok').ok).toBe(true)
    expect(checkRoomTitle('x'.repeat(60)).ok).toBe(true)
    expect(checkRoomTitle('x'.repeat(61)).ok).toBe(false)
    for (const bad of ['', '   ', 'a"b', "a'b", 'a`b', 'a“b', 'a«b', 'a[b', 'a]b', 'a(b', 'a{b', 'a<b', 'a\nb', 'a\u001bb', 'a‮b', 'a​b']) {
      expect(checkRoomTitle(bad).ok).toBe(false)
    }
    expect(checkRoomTitle(null).ok).toBe(false)
  })

  it('has the path-part character set', () => {
    for (const ok of ['a', 'notes.md', 'A_b-1.txt', '.hidden', '...']) expect(isPathPart(ok)).toBe(true)
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a b', 'é', 'a\0', 'x'.repeat(129), 3]) expect(isPathPart(bad)).toBe(false)
    expect(isPathPartChar('ab')).toBe(false)
    expect(isPathPartChar('/')).toBe(false)
  })
})

describe('RoomRegistry', () => {
  it('creates rooms up to the per-plugin cap and counts only rooms not ended', () => {
    const reg = make()
    const made = []
    for (let i = 0; i < MAX_ROOMS_PER_PLUGIN; i++) made.push(reg.create(owner, { title: `Room ${i}` }))
    expect(code(() => reg.create(owner, { title: 'one more' }))).toBe('limit')
    // Another plugin has its own count.
    expect(reg.create(other, { title: 'theirs' }).pluginId).toBe('example.other')
    // So does the same plugin in another project: that host cannot see or end these rooms.
    expect(reg.create(otherProject, { title: 'elsewhere' }).projectId).toBe('p2')
    reg.end(owner, made[0]?.id)
    expect(reg.create(owner, { title: 'after an end' }).title).toBe('after an end')
  })

  it('caps the ended rooms a plugin keeps in a project: create refuses until one is deleted (review m3)', () => {
    const reg = make()
    for (let i = 0; i < MAX_ENDED_ROOMS_PER_PLUGIN; i++) reg.end(owner, reg.create(owner, { title: `Room ${i}` }).id)
    const refused = (() => {
      try {
        reg.create(owner, { title: 'one more' })
      } catch (err) {
        return err as RoomError
      }
      return undefined
    })()
    expect(refused?.code).toBe('limit')
    expect(refused?.message).toContain(`at most ${MAX_ENDED_ROOMS_PER_PLUGIN} ended rooms`)
    expect(refused?.message).toContain('delete an ended room first')
    // Nothing was dropped to make room, and other owners have their own count.
    expect(reg.list(owner)).toHaveLength(MAX_ENDED_ROOMS_PER_PLUGIN)
    expect(reg.create(other, { title: 'theirs' }).pluginId).toBe('example.other')
    reg.delete(owner, reg.list(owner)[0]?.id)
    expect(reg.create(owner, { title: 'after a delete' }).title).toBe('after a delete')
  })

  it('refuses a bad title', () => {
    expect(code(() => make().create(owner, { title: 'a "quoted" title' }))).toBe('invalid')
  })

  it('answers another plugin or project as an unknown room', () => {
    const reg = make()
    const room = reg.create(owner, { title: 'Mine' })
    for (const who of [other, otherProject]) {
      expect(code(() => reg.get(who, room.id))).toBe('not-found')
      expect(code(() => reg.end(who, room.id))).toBe('not-found')
      expect(code(() => reg.invite(who, room.id, { name: 'a' }))).toBe('not-found')
      expect(code(() => reg.addMember(who, room.id, { tabId: 't1', name: 'a' }))).toBe('not-found')
      expect(code(() => reg.members(who, room.id))).toBe('not-found')
      expect(code(() => reg.remove(who, room.id, 'a'))).toBe('not-found')
      expect(reg.list(who)).toEqual([])
    }
    expect(code(() => reg.get(owner, 'nope'))).toBe('not-found')
    expect(code(() => reg.get(owner, 42))).toBe('not-found')
    expect(reg.list(owner).map((r) => r.id)).toEqual([room.id])
  })

  it('adds members by plugin-open with unique names, a cap and one room per tab', () => {
    const reg = make()
    const room = reg.create(owner, { title: 'Team' })
    expect(reg.addMember(owner, room.id, { tabId: 't1', name: 'lead', coordinator: true })).toEqual({
      roomId: room.id,
      name: 'lead',
      coordinator: true
    })
    expect(code(() => reg.addMember(owner, room.id, { tabId: 't2', name: 'lead' }))).toBe('conflict')
    expect(code(() => reg.addMember(owner, room.id, { tabId: 't2', name: 'all' }))).toBe('invalid')
    // One room per tab: t1 is in this room and cannot join another.
    const second = reg.create(owner, { title: 'Second' })
    expect(code(() => reg.addMember(owner, second.id, { tabId: 't1', name: 'dev' }))).toBe('conflict')
    for (let i = 1; i < MAX_MEMBERS_PER_ROOM; i++) reg.addMember(owner, room.id, { tabId: `x${i}`, name: `m${i}` })
    expect(code(() => reg.addMember(owner, room.id, { tabId: 'x99', name: 'late' }))).toBe('limit')
    expect(reg.memberOf('t1')).toEqual({ roomId: room.id, name: 'lead', coordinator: true })
    expect(reg.members(owner, room.id)[0]).toEqual({ name: 'lead', coordinator: true, tabId: 't1', held: 0 })
    // A coordinator flag that is not `true` is no coordinator.
    expect(reg.addMember(owner, second.id, { tabId: 't2', name: 'dev', coordinator: 'yes' }).coordinator).toBe(false)
  })

  it('mints single-use invites that expire after ten minutes', () => {
    const reg = make()
    const room = reg.create(owner, { title: 'Team' })
    const inv = reg.invite(owner, room.id, { name: 'reviewer', coordinator: true })
    expect(inv.code).toMatch(/^[a-z2-7]{26}$/)
    expect(inv.expiresAt).toBe(t + INVITE_TTL_MS)
    // The person may paste it upper-cased or with a trailing newline.
    expect(reg.redeem(`${inv.code.toUpperCase()}\n`, 't1', 'p1')).toEqual({ roomId: room.id, name: 'reviewer', coordinator: true })
    expect(code(() => reg.redeem(inv.code, 't2', 'p1'))).toBe('not-found')

    const late = reg.invite(owner, room.id, { name: 'late' })
    t += INVITE_TTL_MS
    expect(code(() => reg.redeem(late.code, 't3', 'p1'))).toBe('not-found')
    // Unknown, used and expired answer the same text.
    const messages = new Set<string>()
    for (const c of [inv.code, late.code, 'nope', 5]) {
      try {
        reg.redeem(c, 't9', 'p1')
      } catch (e) {
        messages.add((e as Error).message)
      }
    }
    expect(messages.size).toBe(1)
  })

  it('keeps an invite when the redeeming tab is already in a room', () => {
    const reg = make()
    const room = reg.create(owner, { title: 'Team' })
    reg.addMember(owner, room.id, { tabId: 't1', name: 'lead' })
    const inv = reg.invite(owner, room.id, { name: 'dev' })
    expect(code(() => reg.redeem(inv.code, 't1', 'p1'))).toBe('conflict')
    expect(reg.redeem(inv.code, 't2', 'p1').name).toBe('dev')
  })

  it('refuses an invite redeemed by a tab of another project, and keeps it', () => {
    const reg = make()
    const room = reg.create(owner, { title: 'Team' })
    const inv = reg.invite(owner, room.id, { name: 'dev' })
    let foreign = ''
    try {
      reg.redeem(inv.code, 't1', 'p2')
    } catch (e) {
      foreign = (e as Error).message
    }
    let unknown = ''
    try {
      reg.redeem('nope', 't1', 'p1')
    } catch (e) {
      unknown = (e as Error).message
    }
    expect(foreign).toBe(unknown)
    expect(reg.memberOf('t1')).toBeUndefined()
    expect(reg.redeem(inv.code, 't2', 'p1').name).toBe('dev')
  })

  it('caps the invites waiting in a room; expired ones do not count', () => {
    const reg = make()
    const room = reg.create(owner, { title: 'Team' })
    for (let i = 0; i < MAX_PENDING_INVITES_PER_ROOM; i++) reg.invite(owner, room.id, { name: `m${i}` })
    expect(code(() => reg.invite(owner, room.id, { name: 'late' }))).toBe('limit')
    t += INVITE_TTL_MS
    expect(reg.invite(owner, room.id, { name: 'late' }).code).toMatch(/^[a-z2-7]{26}$/)
  })

  it('refuses an invite for a taken name and one whose name was taken since', () => {
    const reg = make()
    const room = reg.create(owner, { title: 'Team' })
    reg.addMember(owner, room.id, { tabId: 't1', name: 'lead' })
    expect(code(() => reg.invite(owner, room.id, { name: 'lead' }))).toBe('conflict')
    expect(code(() => reg.invite(owner, room.id, { name: 'Bad' }))).toBe('invalid')
    const a = reg.invite(owner, room.id, { name: 'dev' })
    const b = reg.invite(owner, room.id, { name: 'dev' })
    reg.redeem(a.code, 't2', 'p1')
    expect(code(() => reg.redeem(b.code, 't3', 'p1'))).toBe('conflict')
  })

  it('ends a room: tabs released, invites dropped, no new members; delete only when ended', () => {
    const reg = make()
    const room = reg.create(owner, { title: 'Team' })
    reg.addMember(owner, room.id, { tabId: 't1', name: 'lead' })
    const inv = reg.invite(owner, room.id, { name: 'dev' })
    expect(code(() => reg.delete(owner, room.id))).toBe('conflict')
    reg.end(owner, room.id)
    expect(reg.get(owner, room.id).endedAt).toBe(t)
    expect(reg.memberOf('t1')).toBeUndefined()
    expect(code(() => reg.redeem(inv.code, 't2', 'p1'))).toBe('not-found')
    expect(code(() => reg.addMember(owner, room.id, { tabId: 't2', name: 'x' }))).toBe('ended')
    expect(code(() => reg.invite(owner, room.id, { name: 'x' }))).toBe('ended')
    expect(code(() => reg.enqueue(room.id, 'lead', { from: 'plugin', text: 'hi' }))).toBe('ended')
    expect(code(() => reg.delete(other, room.id))).toBe('not-found')
    reg.delete(owner, room.id)
    expect(existsSync(join(dir, room.id))).toBe(false)
    expect(code(() => reg.get(owner, room.id))).toBe('not-found')
  })

  it('ends every room of a plugin', () => {
    const reg = make()
    const a = reg.create(owner, { title: 'A' })
    const b = reg.create(otherProject, { title: 'B' })
    const c = reg.create(other, { title: 'C' })
    reg.endAllOf('example.team')
    expect(reg.peek(a.id)?.endedAt).toBe(t)
    expect(reg.peek(b.id)?.endedAt).toBe(t)
    expect(reg.peek(c.id)?.endedAt).toBeUndefined()
  })

  it('removes and leaves members, dropping their queue', () => {
    const reg = make()
    const room = reg.create(owner, { title: 'Team' })
    reg.addMember(owner, room.id, { tabId: 't1', name: 'lead', coordinator: true })
    reg.addMember(owner, room.id, { tabId: 't2', name: 'dev' })
    reg.addMember(owner, room.id, { tabId: 't3', name: 'qa' })
    reg.enqueue(room.id, 'dev', { from: 'lead', text: 'go' })
    expect(reg.leave('t2')).toEqual({ roomId: room.id, name: 'dev', coordinator: false })
    expect(reg.memberOf('t2')).toBeUndefined()
    expect(reg.held(room.id, 'dev')).toBe(0)
    expect(reg.leave('t2')).toBeUndefined()
    expect(reg.remove('person', room.id, 'qa').name).toBe('qa')
    expect(code(() => reg.remove(owner, room.id, 'qa'))).toBe('not-found')
    expect(reg.remove(owner, room.id, 'lead').coordinator).toBe(true)
    expect(reg.members(owner, room.id)).toEqual([])
    // The name is free again.
    expect(reg.addMember(owner, room.id, { tabId: 't2', name: 'dev' }).name).toBe('dev')
  })

  it('queues messages per member and dequeues them on take', () => {
    const reg = make()
    const room = reg.create(owner, { title: 'Team' })
    reg.addMember(owner, room.id, { tabId: 't1', name: 'lead' })
    const m1 = reg.enqueue(room.id, 'lead', { from: 'dev', text: 'one' })
    t++
    reg.enqueue(room.id, 'lead', { from: 'plugin', text: 'two' })
    expect(m1).toMatchObject({ from: 'dev', text: 'one', at: 1000 })
    expect(reg.held(room.id, 'lead')).toBe(2)
    expect(reg.members(owner, room.id)[0]?.held).toBe(2)
    expect(reg.take(room.id, 'lead').map((m) => m.text)).toEqual(['one', 'two'])
    expect(reg.take(room.id, 'lead')).toEqual([])
    expect(code(() => reg.enqueue(room.id, 'nobody', { from: 'plugin', text: 'x' }))).toBe('not-found')
    expect(code(() => reg.enqueue('nope', 'lead', { from: 'plugin', text: 'x' }))).toBe('not-found')
  })

  it('treats inherited object keys as names like any other', () => {
    const reg = make()
    const room = reg.create(owner, { title: 'Team' })
    for (const name of ['constructor', 'tostring']) {
      // Not members: nothing inherited reads as one.
      expect(code(() => reg.remove(owner, room.id, name))).toBe('not-found')
      expect(code(() => reg.enqueue(room.id, name, { from: 'plugin', text: 'x' }))).toBe('not-found')
      expect(reg.held(room.id, name)).toBe(0)
      expect(reg.take(room.id, name)).toEqual([])
    }
    for (const name of ['toString', '__proto__', 'hasOwnProperty']) {
      expect(code(() => reg.remove(owner, room.id, name))).toBe('not-found')
      expect(code(() => reg.enqueue(room.id, name, { from: 'plugin', text: 'x' }))).toBe('not-found')
      expect(reg.held(room.id, name)).toBe(0)
      expect(reg.take(room.id, name)).toEqual([])
    }
    expect(reg.logOf(room.id).read().map((e) => e.type)).toEqual(['create'])
    // `constructor` passes the name rule, so it is a name a member can have.
    const inv = reg.invite(owner, room.id, { name: 'constructor' })
    expect(reg.redeem(inv.code, 't1', 'p1').name).toBe('constructor')
    reg.enqueue(room.id, 'constructor', { from: 'plugin', text: 'hi' })
    expect(reg.held(room.id, 'constructor')).toBe(1)
    expect(reg.take(room.id, 'constructor').map((m) => m.text)).toEqual(['hi'])
    expect(reg.remove(owner, room.id, 'constructor').name).toBe('constructor')
  })

  it('checks a message: its sender, its length and the queue caps', () => {
    const reg = make()
    const room = reg.create(owner, { title: 'Team' })
    reg.addMember(owner, room.id, { tabId: 't1', name: 'lead' })
    for (const from of ['', 'Lead', 'lead] from person', 'a\nb', 'person']) {
      expect(code(() => reg.enqueue(room.id, 'lead', { from, text: 'x' }))).toBe('invalid')
    }
    expect(code(() => reg.enqueue(room.id, 'lead', { from: 'plugin', text: 'x'.repeat(MAX_ROOM_MESSAGE_CHARS + 1) }))).toBe(
      'invalid'
    )
    // Characters are code points: a message of astral characters at the cap is fine.
    expect(reg.enqueue(room.id, 'lead', { from: 'plugin', text: '😀'.repeat(MAX_ROOM_MESSAGE_CHARS) }).from).toBe('plugin')
    reg.take(room.id, 'lead')
    for (let i = 0; i < MAX_QUEUED_PER_MEMBER; i++) reg.enqueue(room.id, 'lead', { from: 'plugin', text: 'x' })
    expect(code(() => reg.enqueue(room.id, 'lead', { from: 'plugin', text: 'x' }))).toBe('limit')
    reg.take(room.id, 'lead')
    const big = 'x'.repeat(MAX_ROOM_MESSAGE_CHARS)
    for (let i = 0; i < MAX_QUEUED_CHARS_PER_ROOM / MAX_ROOM_MESSAGE_CHARS; i++) {
      reg.enqueue(room.id, 'lead', { from: 'plugin', text: big })
    }
    expect(code(() => reg.enqueue(room.id, 'lead', { from: 'plugin', text: 'x' }))).toBe('limit')
  })

  it('opens a log only for a room that exists', () => {
    const reg = make()
    expect(code(() => reg.logOf('../escape'))).toBe('not-found')
    const room = reg.create(owner, { title: 'Team' })
    reg.end(owner, room.id)
    reg.delete(owner, room.id)
    expect(code(() => reg.logOf(room.id))).toBe('not-found')
    expect(existsSync(join(dir, room.id))).toBe(false)
    expect(existsSync(join(dir, '..', 'escape'))).toBe(false)
  })

  it('keeps a room whose directory could not be removed', () => {
    if (process.getuid?.() === 0) return // root removes it anyway
    const reg = make()
    const room = reg.create(owner, { title: 'Team' })
    reg.end(owner, room.id)
    chmodSync(dir, 0o500)
    try {
      expect(code(() => reg.delete(owner, room.id))).toBe('other')
      expect(reg.get(owner, room.id).endedAt).toBe(t)
    } finally {
      chmodSync(dir, 0o700)
    }
    reg.delete(owner, room.id)
    expect(code(() => reg.get(owner, room.id))).toBe('not-found')
  })

  it('leaves an ended room as it is on pause and resume', () => {
    const reg = make()
    const room = reg.create(owner, { title: 'Team' })
    reg.pause(room.id)
    reg.end(owner, room.id)
    reg.resume(room.id)
    expect(reg.peek(room.id)?.paused).toBe(true)
    const other2 = reg.create(owner, { title: 'Two' })
    reg.end(owner, other2.id)
    reg.pause(other2.id, { auto: true })
    expect(reg.peek(other2.id)?.paused).toBe(false)
    expect(reg.logOf(room.id).read().map((e) => e.type)).toEqual(['create', 'pause', 'end'])
    expect(reg.logOf(other2.id).read().map((e) => e.type)).toEqual(['create', 'end'])
  })

  it('returns copies, never the live record', () => {
    const reg = make()
    const room = reg.create(owner, { title: 'Team' })
    room.title = 'changed'
    room.members.evil = { coordinator: true }
    expect(reg.get(owner, room.id).title).toBe('Team')
    expect(reg.get(owner, room.id).members).toEqual({})
  })

  it('pauses and resumes, idempotently', () => {
    const reg = make()
    const room = reg.create(owner, { title: 'Team' })
    reg.pause(room.id)
    reg.pause(room.id)
    expect(reg.peek(room.id)?.paused).toBe(true)
    reg.resume(room.id)
    expect(reg.peek(room.id)?.paused).toBe(false)
    reg.pause(room.id, { auto: true })
    expect(reg.logOf(room.id).read().map((e) => e.type)).toEqual(['create', 'pause', 'resume', 'auto-pause'])
    expect(code(() => reg.pause('nope'))).toBe('not-found')
  })

  it('logs every change', () => {
    const reg = make()
    const room = reg.create(owner, { title: 'Team' })
    reg.addMember(owner, room.id, { tabId: 't1', name: 'lead', coordinator: true })
    const inv = reg.invite(owner, room.id, { name: 'dev' })
    reg.redeem(inv.code, 't2', 'p1')
    reg.enqueue(room.id, 'dev', { from: 'lead', text: 'hi' })
    reg.leave('t2', 'closed')
    reg.end(owner, room.id)
    const log = reg.logOf(room.id).read()
    expect(log.map((e) => e.type)).toEqual(['create', 'join', 'invite', 'join', 'leave', 'end'])
    expect(log[1]).toMatchObject({ member: 'lead', coordinator: true, via: 'open' })
    expect(log[3]).toMatchObject({ member: 'dev', via: 'invite' })
    expect(log[4]).toMatchObject({ member: 'dev', why: 'closed', dropped: 1 })
    // The invite code is a credential: never in the log.
    expect(readFileSync(join(dir, room.id, 'log.jsonl'), 'utf8')).not.toContain(inv.code)
  })

  describe('persistence', () => {
    it('saves each room and reloads every room paused with no tab bound', () => {
      const reg = make()
      const room = reg.create(owner, { title: 'Team' })
      reg.addMember(owner, room.id, { tabId: 't1', name: 'lead', coordinator: true })
      reg.addMember(owner, room.id, { tabId: 't2', name: 'dev' })
      reg.enqueue(room.id, 'dev', { from: 'lead', text: 'hi' })
      const ended = reg.create(owner, { title: 'Old' })
      reg.end(owner, ended.id)
      const saved = JSON.parse(readFileSync(join(dir, room.id, 'room.json'), 'utf8'))
      expect(saved).toMatchObject({ id: room.id, pluginId: 'example.team', projectId: 'p1', title: 'Team', paused: false })

      const again = make()
      again.load()
      const back = again.get(owner, room.id)
      expect(back.paused).toBe(true)
      expect(back.members).toEqual({ lead: { coordinator: true }, dev: { coordinator: false } })
      expect(again.take(room.id, 'dev').map((m) => m.text)).toEqual(['hi'])
      expect(again.memberOf('t1')).toBeUndefined()
      expect(again.get(owner, ended.id).endedAt).toBe(1000)
      expect(again.list(owner)).toHaveLength(2)
      expect(warnings).toEqual([])
    })

    it('rebinds a restored tab to its saved membership only once', () => {
      const reg = make()
      const room = reg.create(owner, { title: 'Team' })
      reg.addMember(owner, room.id, { tabId: 't1', name: 'lead' })
      const again = make()
      again.load()
      expect(again.rebind('new-1', room.id, 'lead', 'p1')).toBe(true)
      expect(again.memberOf('new-1')).toEqual({ roomId: room.id, name: 'lead', coordinator: false })
      expect(again.rebind('new-2', room.id, 'lead', 'p1')).toBe(false)
      expect(again.rebind('new-1', room.id, 'lead', 'p1')).toBe(false)
      expect(again.rebind('new-3', room.id, 'ghost', 'p1')).toBe(false)
      expect(again.rebind('new-3', 'nope', 'lead', 'p1')).toBe(false)
      again.unbind('new-1')
      expect(again.memberOf('new-1')).toBeUndefined()
      expect(again.members(owner, room.id)).toEqual([{ name: 'lead', coordinator: false, held: 0 }])
      // The member is free now, but another project's tab never takes it (design §1: no rooms across windows).
      expect(again.rebind('new-3', room.id, 'lead', 'p2')).toBe(false)
      expect(again.memberOf('new-3')).toBeUndefined()
      again.end(owner, room.id)
      expect(again.rebind('new-4', room.id, 'lead', 'p1')).toBe(false)
    })

    it('a bad file loses only that room, with a warning', () => {
      const reg = make()
      const good = reg.create(owner, { title: 'Good' })
      const write = (name: string, body: string): void => {
        mkdirSync(join(dir, name), { recursive: true })
        writeFileSync(join(dir, name, 'room.json'), body)
      }
      const base = JSON.parse(readFileSync(join(dir, good.id, 'room.json'), 'utf8'))
      const id = (n: number): string => `00000000-0000-4000-8000-${String(900 + n).padStart(12, '0')}`
      write(id(1), '{not json')
      write(id(2), JSON.stringify({ ...base, id: id(2), title: 'a "quoted" title' }))
      write(id(3), JSON.stringify({ ...base, id: id(3), members: { all: { coordinator: false } } }))
      write(id(4), JSON.stringify({ ...base, id: id(4), queues: { ghost: [] } }))
      write(id(5), JSON.stringify({ ...base, id: id(99) })) // id differs from its directory
      write('not-a-uuid', JSON.stringify({ ...base, id: 'not-a-uuid' }))
      write(id(6), JSON.stringify({ ...base, id: id(6), members: { a: { coordinator: 'yes' } } }))
      write(id(7), JSON.stringify([]))
      mkdirSync(join(dir, id(8))) // no room.json
      // Inherited keys are not members: a queue under one is a queue of no member.
      write(id(11), JSON.stringify({ ...base, id: id(11), queues: { constructor: [] } }))
      // JSON.parse makes `__proto__` an own key; copied onto a plain {} it would replace the prototype.
      write(id(12), JSON.stringify({ ...base, id: id(12), queues: {} }).replace('"queues":{}', '"queues":{"__proto__":[]}'))
      // A message from someone who could not have sent it (it would be printed in a fence header).
      const msg = (from: string, text = 'x'): unknown => ({ id: 'm', from, text, at: 1 })
      const withLead = { ...base, members: { lead: { coordinator: false } } }
      write(id(13), JSON.stringify({ ...withLead, id: id(13), queues: { lead: [msg('lead] from person')] } }))
      write(id(14), JSON.stringify({ ...withLead, id: id(14), queues: { lead: [msg('plugin', 'x'.repeat(MAX_ROOM_MESSAGE_CHARS + 1))] } }))
      write(id(15), JSON.stringify({ ...withLead, id: id(15), queues: { lead: Array.from({ length: MAX_QUEUED_PER_MEMBER + 1 }, () => msg('plugin')) } }))
      // room.json as a link, a FIFO (would block the read forever) and an oversized file.
      mkdirSync(join(dir, id(16)))
      const planted = join(dir, '..', 'planted.json')
      writeFileSync(planted, JSON.stringify({ ...base, id: id(16) }))
      symlinkSync(planted, join(dir, id(16), 'room.json'))
      mkdirSync(join(dir, id(17)))
      execFileSync('mkfifo', [join(dir, id(17), 'room.json')])
      write(id(18), '')
      truncateSync(join(dir, id(18), 'room.json'), MAX_ROOM_FILE_BYTES + 1)
      // A room directory planted as a link is skipped, never followed.
      const outside = join(dir, '..', 'outside')
      mkdirSync(outside)
      writeFileSync(join(outside, 'room.json'), JSON.stringify({ ...base, id: id(10) }))
      symlinkSync(outside, join(dir, id(10)))
      writeFileSync(join(dir, 'stray-file'), 'x')

      const again = make()
      again.load()
      expect(again.list(owner).map((r) => r.id)).toEqual([good.id])
      expect(warnings).toHaveLength(17)
      expect(warnings.every((w) => w.startsWith('rooms: skipped '))).toBe(true)
    })

    it('loads nothing from a missing directory', () => {
      const reg = make()
      reg.load()
      expect(reg.list(owner)).toEqual([])
    })

    it('warns when a save fails and keeps the change in memory', () => {
      const reg = make()
      // A file where the rooms directory should be makes every save fail.
      mkdirSync(join(dir, '..'), { recursive: true })
      writeFileSync(dir, 'x')
      const room = reg.create(owner, { title: 'Team' })
      expect(reg.get(owner, room.id).title).toBe('Team')
      expect(warnings.some((w) => w.startsWith(`rooms: could not save ${room.id}`))).toBe(true)
    })
  })

  it("the person closing a member's tab drops it and its queue, logs why, and tells every other coordinator", () => {
    const reg = make()
    const room = reg.create(owner, { title: 'Team' })
    reg.addMember(owner, room.id, { tabId: 't1', name: 'lead', coordinator: true })
    reg.addMember(owner, room.id, { tabId: 't2', name: 'dev' })
    reg.addMember(owner, room.id, { tabId: 't3', name: 'qa', coordinator: true })
    reg.addMember(owner, room.id, { tabId: 't4', name: 'ops' })
    reg.enqueue(room.id, 'dev', { from: 'lead', text: 'do it' })
    expect(reg.memberClosed('t2')).toEqual({ roomId: room.id, name: 'dev', coordinator: false })
    expect(reg.memberOf('t2')).toBeUndefined()
    expect(reg.held(room.id, 'dev')).toBe(0)
    // Every coordinator is told, from `system` (a reserved name no member can take); other members are not.
    for (const name of ['lead', 'qa']) {
      expect(reg.take(room.id, name).map((m) => [m.from, m.text])).toEqual([['system', 'dev left: tab closed']])
    }
    expect(reg.held(room.id, 'ops')).toBe(0)
    const leave = reg.logOf(room.id).read().find((e) => e.type === 'leave')
    expect(leave).toMatchObject({ member: 'dev', why: 'closed', dropped: 1 })
    // A coordinator closing is told to the other coordinators, never to itself.
    reg.memberClosed('t1')
    expect(reg.take(room.id, 'qa').map((m) => m.text)).toEqual(['lead left: tab closed'])
    // A tab in no room: nothing.
    expect(reg.memberClosed('t2')).toBeUndefined()
    expect(reg.memberClosed('nope')).toBeUndefined()
  })

  it('a coordinator whose queue is full misses the notice with a warning; the leave still happens', () => {
    const reg = make()
    const room = reg.create(owner, { title: 'Team' })
    reg.addMember(owner, room.id, { tabId: 't1', name: 'lead', coordinator: true })
    reg.addMember(owner, room.id, { tabId: 't2', name: 'dev' })
    for (let i = 0; i < MAX_QUEUED_PER_MEMBER; i++) reg.enqueue(room.id, 'lead', { from: 'dev', text: `m${i}` })
    expect(reg.memberClosed('t2')?.name).toBe('dev')
    expect(reg.memberOf('t2')).toBeUndefined()
    expect(warnings.some((w) => w.includes('could not tell lead'))).toBe(true)
  })

  it('a member cannot send as system, and a saved system message reloads', () => {
    const reg = make()
    const room = reg.create(owner, { title: 'Team' })
    reg.addMember(owner, room.id, { tabId: 't1', name: 'lead', coordinator: true })
    expect(code(() => reg.addMember(owner, room.id, { tabId: 't2', name: 'system' }))).toBe('invalid')
    reg.enqueue(room.id, 'lead', { from: 'system', text: 'dev left: tab closed' })
    const again = make()
    again.load()
    expect(again.peek(room.id)?.queues.lead?.[0]?.from).toBe('system')
  })
})
