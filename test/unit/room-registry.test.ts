import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  INVITE_TTL_MS,
  MAX_MEMBERS_PER_ROOM,
  MAX_ROOMS_PER_PLUGIN,
  RoomError,
  RoomRegistry,
  type RoomOwner
} from '../../src/main/rooms/room-registry'
import { checkRoomName, checkRoomTitle, isPathPart, isPathPartChar, ROOM_NAME } from '../../src/main/rooms/room-names'

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
    reg.end(owner, made[0]?.id)
    expect(reg.create(owner, { title: 'after an end' }).title).toBe('after an end')
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
    expect(reg.redeem(`${inv.code.toUpperCase()}\n`, 't1')).toEqual({ roomId: room.id, name: 'reviewer', coordinator: true })
    expect(code(() => reg.redeem(inv.code, 't2'))).toBe('not-found')

    const late = reg.invite(owner, room.id, { name: 'late' })
    t += INVITE_TTL_MS
    expect(code(() => reg.redeem(late.code, 't3'))).toBe('not-found')
    // Unknown, used and expired answer the same text.
    const messages = new Set<string>()
    for (const c of [inv.code, late.code, 'nope', 5]) {
      try {
        reg.redeem(c, 't9')
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
    expect(code(() => reg.redeem(inv.code, 't1'))).toBe('conflict')
    expect(reg.redeem(inv.code, 't2').name).toBe('dev')
  })

  it('refuses an invite for a taken name and one whose name was taken since', () => {
    const reg = make()
    const room = reg.create(owner, { title: 'Team' })
    reg.addMember(owner, room.id, { tabId: 't1', name: 'lead' })
    expect(code(() => reg.invite(owner, room.id, { name: 'lead' }))).toBe('conflict')
    expect(code(() => reg.invite(owner, room.id, { name: 'Bad' }))).toBe('invalid')
    const a = reg.invite(owner, room.id, { name: 'dev' })
    const b = reg.invite(owner, room.id, { name: 'dev' })
    reg.redeem(a.code, 't2')
    expect(code(() => reg.redeem(b.code, 't3'))).toBe('conflict')
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
    expect(code(() => reg.redeem(inv.code, 't2'))).toBe('not-found')
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
    reg.redeem(inv.code, 't2')
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
      expect(again.rebind('new-1', room.id, 'lead')).toBe(true)
      expect(again.memberOf('new-1')).toEqual({ roomId: room.id, name: 'lead', coordinator: false })
      expect(again.rebind('new-2', room.id, 'lead')).toBe(false)
      expect(again.rebind('new-1', room.id, 'lead')).toBe(false)
      expect(again.rebind('new-3', room.id, 'ghost')).toBe(false)
      expect(again.rebind('new-3', 'nope', 'lead')).toBe(false)
      again.unbind('new-1')
      expect(again.memberOf('new-1')).toBeUndefined()
      expect(again.members(owner, room.id)).toEqual([{ name: 'lead', coordinator: false, held: 0 }])
      again.end(owner, room.id)
      expect(again.rebind('new-4', room.id, 'lead')).toBe(false)
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
      // A room directory planted as a link is skipped, never followed.
      const outside = join(dir, '..', 'outside')
      mkdirSync(outside)
      writeFileSync(join(outside, 'room.json'), JSON.stringify({ ...base, id: id(10) }))
      symlinkSync(outside, join(dir, id(10)))
      writeFileSync(join(dir, 'stray-file'), 'x')

      const again = make()
      again.load()
      expect(again.list(owner).map((r) => r.id)).toEqual([good.id])
      expect(warnings).toHaveLength(9)
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
})
