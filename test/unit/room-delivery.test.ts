import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ROOM_SEND_LIMITS,
  ROOM_SEND_WINDOW_MS,
  RoomDelivery,
  decide,
  type RoomSendLimits
} from '../../src/main/rooms/room-delivery'
import { RoomError } from '../../src/main/rooms/room-error'
import { MAX_QUEUED_PER_MEMBER, RoomRegistry, type RoomOwner } from '../../src/main/rooms/room-registry'
import { sessionInfoOf } from '../../src/main/plugins/host-api'
import { SessionRegistry } from '../../src/main/sessions/session-registry'
import { newEntry, type SessionEntry, type TabStatus } from '../../src/main/sessions/status-reducer'
import { pointerText } from '../../src/shared/room-pointer'
import type { TabRoom } from '../../src/shared/tab-room'

const ESC = '\x1b'
const paste = (text: string): string => `${ESC}[200~${text}${ESC}[201~\r`
const owner: RoomOwner = { pluginId: 'example.team', projectId: 'p1' }

let dir: string
let t: number
let ids: number
let rooms: RoomRegistry
let sessions: SessionRegistry
let writes: Array<{ tabId: string; data: string }>
let failWrite: boolean
/** The tab manager's side: each tab's membership and the person's mark (TabManager.roomOf). */
let tabRooms: Map<string, TabRoom>
let limits: RoomSendLimits | undefined
let limitCalls: string[]
let delivery: RoomDelivery
let roomId: string

function nextId(): string {
  ids++
  return `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`
}

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'cc-room-delivery-'))
  t = 1_000_000
  ids = 0
  writes = []
  failWrite = false
  tabRooms = new Map()
  limits = undefined
  limitCalls = []
  rooms = new RoomRegistry({ dir, now: () => t, newId: nextId, log: () => {} })
  sessions = new SessionRegistry({
    projectName: () => 'p',
    broadcast: () => {},
    write: ({ tabId }, data) => {
      if (failWrite) throw new Error('pty gone')
      writes.push({ tabId, data })
    },
    log: () => {}
  })
  delivery = new RoomDelivery({
    rooms,
    sessions,
    tabRoom: (tabId) => tabRooms.get(tabId),
    limits: (pluginId) => {
      limitCalls.push(pluginId)
      return limits ?? DEFAULT_ROOM_SEND_LIMITS
    },
    now: () => t,
    log: () => {}
  })
  roomId = rooms.create(owner, { title: 'Team' }).id
})

afterEach(() => {
  sessions.dispose()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

/** A member tab with a live session, left waiting for input (a turn ran and stopped). */
function member(tabId: string, name: string, opts: { coordinator?: boolean; status?: 'waiting' | 'working' } = {}): void {
  sessions.tabStarted({ tabId, projectId: 'p1', kind: 'claude', cwd: '/proj' })
  sessions.applyHook(tabId, 'UserPromptSubmit', { prompt: 'go' })
  if (opts.status !== 'working') sessions.applyHook(tabId, 'Stop', {})
  rooms.addMember(owner, roomId, { tabId, name, coordinator: opts.coordinator === true })
  tabRooms.set(tabId, { id: roomId, name, coordinator: opts.coordinator === true, mark: false })
}

const pasted = (tabId: string): string[] => writes.filter((w) => w.tabId === tabId).map((w) => w.data)
const mark = (tabId: string, on = true): void => {
  const r = tabRooms.get(tabId)!
  tabRooms.set(tabId, { ...r, mark: on })
}
const logged = () => rooms.logOf(roomId).page().entries.filter((e) => e.type === 'send')

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (e) {
    return e instanceof RoomError ? e.code : 'other'
  }
  return undefined
}

describe('pointerText', () => {
  it('is fixed text with the count only', () => {
    expect(pointerText(1)).toBe('1 room message waiting: run ccc room read')
    expect(pointerText(3)).toBe('3 room messages waiting: run ccc room read')
  })
})

describe('decide (pure)', () => {
  const at = (status: TabStatus, extra: Partial<SessionEntry> = {}): SessionEntry => ({
    ...newEntry({ tabId: 't', projectId: 'p1', kind: 'claude', cwd: '/' }),
    status,
    ...extra
  })

  it('an untyped tab waiting for input gets the pointer', () => {
    expect(decide({ paused: false, entry: at('waiting'), mark: false })).toEqual({ pointer: true })
  })

  it('a typed tab needs the mark, and the mark needs no draft', () => {
    expect(decide({ paused: false, entry: at('waiting', { typed: true }), mark: false })).toEqual({ pointer: false, why: 'typed' })
    expect(decide({ paused: false, entry: at('waiting', { typed: true }), mark: true })).toEqual({ pointer: true })
    expect(decide({ paused: false, entry: at('waiting', { typed: true, draft: true }), mark: true })).toEqual({ pointer: false, why: 'draft' })
  })

  it.each<TabStatus>(['working', 'needs-permission', 'starting', 'ended'])('holds a tab in %s as busy', (status) => {
    expect(decide({ paused: false, entry: at(status), mark: true })).toEqual({ pointer: false, why: 'not-waiting', status })
  })

  // An idle tab is not busy: nothing delivers to it by itself (compaction incident, 2026-11-19).
  it('holds an idle tab with its own reason', () => {
    expect(decide({ paused: false, entry: at('idle'), mark: true })).toEqual({ pointer: false, why: 'idle', status: 'idle' })
  })

  it('holds while a paste is in flight or the start settles, in a paused room and with no tab', () => {
    expect(decide({ paused: false, entry: at('waiting', { delivering: true }), mark: false })).toMatchObject({ why: 'not-waiting' })
    expect(decide({ paused: false, entry: at('waiting', { settling: true }), mark: false })).toMatchObject({ why: 'not-waiting' })
    expect(decide({ paused: true, entry: at('waiting'), mark: true })).toEqual({ pointer: false, why: 'paused' })
    expect(decide({ paused: false, entry: undefined, mark: true })).toEqual({ pointer: false, why: 'no-tab' })
  })
})

describe('send: each path', () => {
  it('an untyped member waiting for input: the pointer is pasted, the message stays queued until read', () => {
    member('a', 'alice')
    member('b', 'bob')
    expect(delivery.send(roomId, 'alice', 'bob', 'hello bob')).toEqual([{ to: 'bob', path: 'delivered' }])
    expect(pasted('b')).toEqual([paste(pointerText(1))])
    expect(pasted('a')).toEqual([])
    // The pointer only: the text reaches bob through his own `ccc room read`.
    expect(writes.some((w) => w.data.includes('hello bob'))).toBe(false)
    expect(rooms.held(roomId, 'bob')).toBe(1)
    expect(sessions.get('b')).toMatchObject({ delivering: true, queue: [], held: 1, room: { title: 'Team', name: 'bob', coordinator: false } })
  })

  it('a marked typed member with no draft gets the pointer', () => {
    member('b', 'bob')
    sessions.userInput('p1', 'b', 'x')
    sessions.applyHook('b', 'UserPromptSubmit', { prompt: 'x' }) // the draft goes with the prompt
    sessions.applyHook('b', 'Stop', {})
    mark('b')
    expect(sessions.get('b')).toMatchObject({ typed: true })
    expect(sessions.get('b')?.draft).toBeUndefined()
    expect(delivery.send(roomId, 'plugin', 'bob', 'hi')).toEqual([{ to: 'bob', path: 'delivered' }])
    expect(pasted('b')).toEqual([paste(pointerText(1))])
  })

  it('a marked member with a draft is held (the badge), and gets it once the prompt is submitted', () => {
    member('b', 'bob')
    mark('b')
    sessions.userInput('p1', 'b', 'half a prom')
    expect(sessions.get('b')).toMatchObject({ typed: true, draft: true, status: 'waiting' })
    expect(delivery.send(roomId, 'plugin', 'bob', 'hi')).toEqual([{ to: 'bob', path: 'held', why: 'draft' }])
    expect(writes).toEqual([])
    sessions.applyHook('b', 'UserPromptSubmit', { prompt: 'half a prompt' })
    sessions.applyHook('b', 'Stop', {})
    expect(delivery.offer(roomId, 'bob')).toEqual({ to: 'bob', path: 'delivered' })
    expect(pasted('b')).toEqual([paste(pointerText(1))])
  })

  it('a typed member without the mark is held behind the badge, whatever its status', () => {
    member('b', 'bob')
    sessions.userInput('p1', 'b', 'x')
    sessions.applyHook('b', 'UserPromptSubmit', { prompt: 'x' })
    sessions.applyHook('b', 'Stop', {})
    expect(delivery.send(roomId, 'plugin', 'bob', 'one')).toEqual([{ to: 'bob', path: 'held', why: 'typed' }])
    expect(delivery.send(roomId, 'plugin', 'bob', 'two')).toEqual([{ to: 'bob', path: 'held', why: 'typed' }])
    expect(writes).toEqual([])
    expect(sessions.get('b')?.held).toBe(2)
  })

  it('a mark given for another room (or name) is no mark', () => {
    member('b', 'bob')
    sessions.userInput('p1', 'b', 'x')
    sessions.applyHook('b', 'UserPromptSubmit', { prompt: 'x' })
    sessions.applyHook('b', 'Stop', {})
    tabRooms.set('b', { id: nextId(), name: 'bob', coordinator: false, mark: true })
    expect(delivery.send(roomId, 'plugin', 'bob', 'hi')).toEqual([{ to: 'bob', path: 'held', why: 'typed' }])
    tabRooms.set('b', { id: roomId, name: 'robert', coordinator: false, mark: true })
    expect(delivery.send(roomId, 'plugin', 'bob', 'hi')).toEqual([{ to: 'bob', path: 'held', why: 'typed' }])
    expect(writes).toEqual([])
  })

  it('a member in a permission dialog (or working) is held with its status', () => {
    member('b', 'bob')
    member('w', 'walt', { status: 'working' })
    sessions.applyHook('b', 'Notification', { notification_type: 'permission_prompt' })
    expect(delivery.send(roomId, 'plugin', 'bob', 'hi')).toEqual([{ to: 'bob', path: 'held', why: 'not-waiting', status: 'needs-permission' }])
    expect(delivery.send(roomId, 'plugin', 'walt', 'hi')).toEqual([{ to: 'walt', path: 'held', why: 'not-waiting', status: 'working' }])
    expect(writes).toEqual([])
  })

  it('a paused room holds every member, marked or not', () => {
    member('b', 'bob')
    mark('b')
    rooms.pause(roomId)
    expect(delivery.send(roomId, 'plugin', 'bob', 'hi')).toEqual([{ to: 'bob', path: 'held', why: 'paused' }])
    expect(writes).toEqual([])
    rooms.resume(roomId)
    expect(delivery.offer(roomId, 'bob')).toEqual({ to: 'bob', path: 'delivered' })
  })

  it('a member with no tab (after a quit) is held; an unknown name is gone and nothing is queued', () => {
    member('b', 'bob')
    rooms.unbind('b')
    expect(delivery.send(roomId, 'plugin', 'bob', 'hi')).toEqual([{ to: 'bob', path: 'held', why: 'no-tab' }])
    expect(delivery.send(roomId, 'plugin', 'nobody', 'hi')).toEqual([{ to: 'nobody', path: 'gone' }])
    expect(rooms.held(roomId, 'nobody')).toBe(0)
    expect(logged().at(-1)).toMatchObject({ from: 'plugin', to: 'nobody', delivery: [{ to: 'nobody', path: 'gone' }] })
  })

  it('one paste for any number of messages: held ones are counted in the one pointer', () => {
    member('w', 'walt', { status: 'working' })
    for (const text of ['one', 'two', 'three']) delivery.send(roomId, 'plugin', 'walt', text)
    expect(writes).toEqual([])
    sessions.applyHook('w', 'Stop', {})
    expect(delivery.offer(roomId, 'walt')).toEqual({ to: 'walt', path: 'delivered' })
    expect(pasted('w')).toEqual([paste(pointerText(3))])
    // A fourth while the pointer is in flight: no second paste on top of the first.
    expect(delivery.send(roomId, 'plugin', 'walt', 'four')).toEqual([{ to: 'walt', path: 'held', why: 'not-waiting', status: 'waiting' }])
    expect(pasted('w')).toHaveLength(1)
    // Nothing waits after a read: offer has nothing to give.
    rooms.take(roomId, 'walt')
    expect(delivery.offer(roomId, 'walt')).toBeUndefined()
  })
})

describe('the pointer never waits in the gate', () => {
  it('a failed paste is not put back: the messages stay held and the next Stop pastes nothing', () => {
    member('b', 'bob')
    failWrite = true
    expect(delivery.send(roomId, 'plugin', 'bob', 'hi')).toEqual([{ to: 'bob', path: 'held', why: 'not-waiting', status: 'waiting' }])
    expect(sessions.get('b')).toMatchObject({ queue: [], delivering: false })
    failWrite = false
    sessions.applyHook('b', 'UserPromptSubmit', { prompt: 'p' })
    sessions.applyHook('b', 'Stop', {})
    expect(writes).toEqual([])
    expect(rooms.held(roomId, 'bob')).toBe(1)
  })

  it("the person's takeover returns the room to held: no pointer comes after it, the messages stay queued", () => {
    member('w', 'walt', { status: 'working' })
    delivery.send(roomId, 'plugin', 'walt', 'one')
    sessions.userInput('p1', 'w', 'k') // the person takes the tab over
    sessions.applyHook('w', 'Stop', {})
    expect(sessions.get('w')?.queue).toEqual([])
    expect(writes).toEqual([])
    expect(delivery.offer(roomId, 'walt')).toEqual({ to: 'walt', path: 'held', why: 'typed' })
    expect(rooms.held(roomId, 'walt')).toBe(1)
  })
})

describe('caps', () => {
  it('per member: refused whole with the cap and its value named; counted again after the window', () => {
    limits = { roomSendsPerMember: 3, roomSendsPerRoom: 100 }
    member('a', 'alice')
    member('b', 'bob')
    for (let i = 0; i < 3; i++) delivery.send(roomId, 'alice', 'bob', `m${i}`)
    expect(() => delivery.send(roomId, 'alice', 'bob', 'm3')).toThrow('the cap of 3 room sends a minute per member (roomSendsPerMember) is reached')
    expect(rooms.held(roomId, 'bob')).toBe(3)
    // Bob has his own count.
    expect(delivery.send(roomId, 'bob', 'alice', 'reply')).toHaveLength(1)
    expect(limitCalls.every((id) => id === owner.pluginId)).toBe(true)
    t += ROOM_SEND_WINDOW_MS
    expect(delivery.send(roomId, 'alice', 'bob', 'later')).toHaveLength(1)
  })

  it('`all` counts one send per recipient, against the member and the room caps', () => {
    limits = { roomSendsPerMember: 5, roomSendsPerRoom: 8 }
    member('a', 'alice')
    member('b', 'bob')
    member('c', 'carol')
    member('d', 'dave')
    const answers = delivery.send(roomId, 'alice', 'all', 'to everyone')
    expect(answers.map((a) => a.to)).toEqual(['bob', 'carol', 'dave'])
    // 3 used: another `all` (3 more) would be 6 > 5.
    expect(codeOf(() => delivery.send(roomId, 'alice', 'all', 'again'))).toBe('limit')
    expect(() => delivery.send(roomId, 'alice', 'all', 'again')).toThrow(/"all" counts one send per recipient, 3 here/)
    expect(rooms.held(roomId, 'bob')).toBe(1)
    delivery.send(roomId, 'bob', 'all', 'from bob') // room at 6
    expect(() => delivery.send(roomId, 'carol', 'all', 'from carol')).toThrow('8 room sends a minute per room (roomSendsPerRoom)')
    // The owner's sends count against the room only.
    delivery.send(roomId, 'plugin', 'dave', 'x')
    delivery.send(roomId, 'plugin', 'dave', 'y')
    expect(codeOf(() => delivery.send(roomId, 'plugin', 'dave', 'z'))).toBe('limit')
  })

  it('the defaults apply without a getter', () => {
    const d = new RoomDelivery({ rooms, sessions, tabRoom: () => undefined, now: () => t, log: () => {} })
    member('b', 'bob')
    for (let i = 0; i < DEFAULT_ROOM_SEND_LIMITS.roomSendsPerRoom; i++) {
      if (i === MAX_QUEUED_PER_MEMBER) break
      d.send(roomId, 'plugin', 'bob', `m${i}`)
    }
    expect(codeOf(() => d.send(roomId, 'plugin', 'bob', 'over'))).toBe('limit')
  })

  it('a send to a gone name counts as one send (it is logged with its text)', () => {
    limits = { roomSendsPerMember: 2, roomSendsPerRoom: 100 }
    member('a', 'alice')
    member('b', 'bob')
    expect(delivery.send(roomId, 'alice', 'nobody', 'x'.repeat(20_000))).toEqual([{ to: 'nobody', path: 'gone' }])
    expect(delivery.send(roomId, 'alice', 'nobody', 'again')).toEqual([{ to: 'nobody', path: 'gone' }])
    expect(codeOf(() => delivery.send(roomId, 'alice', 'nobody', 'third'))).toBe('limit')
    expect(codeOf(() => delivery.send(roomId, 'alice', 'bob', 'real'))).toBe('limit')
    expect(logged()).toHaveLength(2)
  })

  it('charges only the recipients queued (a full queue costs nothing), at least one per send', () => {
    limits = { roomSendsPerMember: 3, roomSendsPerRoom: 100 }
    member('a', 'alice')
    member('b', 'bob')
    member('c', 'carol')
    for (let i = 0; i < MAX_QUEUED_PER_MEMBER; i++) rooms.enqueue(roomId, 'bob', { from: 'plugin', text: `m${i}` })
    // Checked for both up front, charged for carol only: 1 used.
    expect(delivery.send(roomId, 'alice', 'all', 'hi').map((a) => a.path)).toEqual(['refused', 'delivered'])
    // A send that queued nothing still counts once: 2 used.
    expect(delivery.send(roomId, 'alice', 'bob', 'full')).toMatchObject([{ to: 'bob', path: 'refused' }])
    expect(delivery.send(roomId, 'alice', 'carol', 'third')).toHaveLength(1)
    expect(codeOf(() => delivery.send(roomId, 'alice', 'carol', 'fourth'))).toBe('limit')
  })

  it('another queue failure is rethrown after logging the recipients reached and the one that failed', () => {
    member('a', 'alice')
    member('b', 'bob')
    member('c', 'carol')
    member('d', 'dave')
    const real = rooms.enqueue.bind(rooms)
    vi.spyOn(rooms, 'enqueue').mockImplementation((id, name, msg) => {
      if (name === 'carol') throw new Error('room.json save failed')
      return real(id, name, msg)
    })
    expect(() => delivery.send(roomId, 'alice', 'all', 'partial')).toThrow('room.json save failed')
    expect(rooms.held(roomId, 'bob')).toBe(1)
    expect(rooms.held(roomId, 'dave')).toBe(0)
    expect(logged().at(-1)).toMatchObject({
      from: 'alice',
      to: 'all',
      text: 'partial',
      delivery: [{ to: 'bob', path: 'delivered' }],
      failed: 'carol'
    })
  })

  it("a full queue refuses that recipient only; the others still get the message", () => {
    limits = { roomSendsPerMember: 1000, roomSendsPerRoom: 1000 }
    member('a', 'alice')
    member('b', 'bob')
    member('c', 'carol')
    for (let i = 0; i < MAX_QUEUED_PER_MEMBER; i++) rooms.enqueue(roomId, 'bob', { from: 'plugin', text: `m${i}` })
    const answers = delivery.send(roomId, 'alice', 'all', 'hi')
    expect(answers[0]).toMatchObject({ to: 'bob', path: 'refused', why: expect.stringContaining('at most') })
    expect(answers[1]).toEqual({ to: 'carol', path: 'delivered' })
  })
})

describe('send refusals', () => {
  it('refuses an unknown or ended room, a sender not in it, a bad name, oneself and bad text; nothing counted', () => {
    limits = { roomSendsPerMember: 1, roomSendsPerRoom: 1 }
    member('a', 'alice')
    member('b', 'bob')
    expect(codeOf(() => delivery.send(nextId(), 'alice', 'bob', 'x'))).toBe('not-found')
    expect(codeOf(() => delivery.send(roomId, 'mallory', 'bob', 'x'))).toBe('not-found')
    expect(codeOf(() => delivery.send(roomId, 'alice', 'Bob!', 'x'))).toBe('invalid')
    expect(codeOf(() => delivery.send(roomId, 'alice', 42, 'x'))).toBe('invalid')
    expect(codeOf(() => delivery.send(roomId, 'alice', 'alice', 'x'))).toBe('invalid')
    expect(codeOf(() => delivery.send(roomId, 'alice', 'bob', '  '))).toBe('invalid')
    expect(codeOf(() => delivery.send(roomId, 'alice', 'bob', 'x'.repeat(20_001)))).toBe('invalid')
    expect(codeOf(() => delivery.send(roomId, 'alice', 'bob', { text: 'x' }))).toBe('invalid')
    // Nothing above used the one send allowed.
    expect(delivery.send(roomId, 'alice', 'bob', 'ok')).toEqual([{ to: 'bob', path: 'delivered' }])
    rooms.end(owner, roomId)
    expect(codeOf(() => delivery.send(roomId, 'plugin', 'bob', 'x'))).toBe('ended')
  })

  it('`all` from the only member reaches nobody and queues nothing, but is logged and counted like a gone name', () => {
    member('a', 'alice')
    limits = { roomSendsPerMember: 1, roomSendsPerRoom: 60 }
    expect(delivery.send(roomId, 'alice', 'all', 'anyone?')).toEqual([])
    expect(logged()).toEqual([expect.objectContaining({ from: 'alice', to: 'all', text: 'anyone?', delivery: [] })])
    expect(codeOf(() => delivery.send(roomId, 'alice', 'all', 'again?'))).toBe('limit')
  })
})

describe('the log', () => {
  it('a send to `all` queues every recipient under one room.json save, before any pointer is offered', () => {
    member('a', 'alice')
    member('b', 'bob')
    member('c', 'carol')
    const batch = vi.spyOn(rooms, 'batch')
    const offered: number[] = []
    const offer = vi.spyOn(delivery, 'offer').mockImplementation((id, name) => {
      // Both queued by the time the first is offered.
      offered.push(rooms.held(id, 'bob') + rooms.held(id, 'carol'))
      return { to: name, path: 'delivered' }
    })
    delivery.send(roomId, 'alice', 'all', 'hi')
    expect(batch).toHaveBeenCalledTimes(1)
    expect(offered).toEqual([2, 2])
    offer.mockRestore()
  })

  it('every send is one line with its text and each recipient path', () => {
    member('a', 'alice')
    member('b', 'bob')
    member('w', 'walt', { status: 'working' })
    delivery.send(roomId, 'alice', 'all', 'standup in 5')
    expect(logged()).toEqual([
      expect.objectContaining({
        from: 'alice',
        to: 'all',
        text: 'standup in 5',
        delivery: [
          { to: 'bob', path: 'delivered' },
          { to: 'walt', path: 'held', why: 'not-waiting', status: 'working' }
        ]
      })
    ])
  })
})

describe("deliverHeld (the person's badge click)", () => {
  function typedBob(): void {
    member('b', 'bob')
    sessions.userInput('p1', 'b', 'x')
    sessions.applyHook('b', 'UserPromptSubmit', { prompt: 'x' })
    sessions.applyHook('b', 'Stop', {})
  }

  it('pastes the pointer into a typed unmarked tab and logs it', () => {
    typedBob()
    delivery.send(roomId, 'plugin', 'bob', 'one')
    delivery.send(roomId, 'plugin', 'bob', 'two')
    expect(delivery.deliverHeld('b')).toEqual({ delivered: true })
    expect(pasted('b')).toEqual([paste(pointerText(2))])
    expect(logged().at(-1)).toMatchObject({ from: 'person', to: 'bob', via: 'badge', pointer: 2, delivered: true })
  })

  it('holds in a paused room and while the person has a draft (a paste plus Enter would submit it)', () => {
    typedBob()
    delivery.send(roomId, 'plugin', 'bob', 'one')
    rooms.pause(roomId)
    expect(delivery.deliverHeld('b')).toEqual({ delivered: false, why: 'paused' })
    rooms.resume(roomId)
    sessions.userInput('p1', 'b', 'half a prompt')
    expect(delivery.deliverHeld('b')).toEqual({ delivered: false, why: 'draft' })
    expect(writes).toEqual([])
    // Submitting the draft clears the bit; once the turn stops the click delivers.
    sessions.applyHook('b', 'UserPromptSubmit', { prompt: 'half a prompt' })
    sessions.applyHook('b', 'Stop', {})
    expect(delivery.deliverHeld('b')).toEqual({ delivered: true })
    expect(pasted('b')).toEqual([paste(pointerText(1))])
  })

  it('"Deliver anyway" (overDraft) goes past the draft bit only, logged as such', () => {
    typedBob()
    delivery.send(roomId, 'plugin', 'bob', 'one')
    // The person typed and cleared the box (Ctrl+U): main cannot tell, the bit stays.
    sessions.userInput('p1', 'b', 'x')
    sessions.userInput('p1', 'b', '\x15')
    expect(delivery.deliverHeld('b')).toEqual({ delivered: false, why: 'draft' })
    // A pause still holds it, and so does a tab that is not waiting.
    rooms.pause(roomId)
    expect(delivery.deliverHeld('b', { overDraft: true })).toEqual({ delivered: false, why: 'paused' })
    rooms.resume(roomId)
    expect(writes).toEqual([])
    expect(delivery.deliverHeld('b', { overDraft: true })).toEqual({ delivered: true })
    expect(pasted('b')).toEqual([paste(pointerText(1))])
    expect(logged().at(-1)).toMatchObject({ from: 'person', to: 'bob', via: 'badge', pointer: 1, delivered: true, overDraft: true })
  })

  it('a tab whose last input answered a permission prompt has no draft: the badge delivers after the Stop', () => {
    typedBob()
    delivery.send(roomId, 'plugin', 'bob', 'one')
    sessions.applyHook('b', 'UserPromptSubmit', { prompt: 'go' })
    sessions.applyHook('b', 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' })
    expect(sessions.get('b')?.status).toBe('needs-permission')
    expect(delivery.deliverHeld('b')).toEqual({ delivered: false, why: 'permission' })
    // Down to "Yes, and don't ask again", then Enter: keys the prompt takes, nothing left in the box.
    sessions.userInput('p1', 'b', '\x1b[B')
    sessions.userInput('p1', 'b', '\r')
    expect(sessions.get('b')?.draft).toBeUndefined()
    expect(delivery.deliverHeld('b')).toEqual({ delivered: false, why: 'busy' }) // working again
    sessions.applyHook('b', 'Stop', {})
    expect(delivery.deliverHeld('b')).toEqual({ delivered: true })
    expect(pasted('b')).toEqual([paste(pointerText(1))])
  })

  it('does nothing for a tab not waiting, ended, with nothing held, or in no room', () => {
    typedBob()
    expect(delivery.deliverHeld('b')).toEqual({ delivered: false, why: 'nothing-held' })
    delivery.send(roomId, 'plugin', 'bob', 'one')
    sessions.applyHook('b', 'UserPromptSubmit', { prompt: 'y' })
    expect(delivery.deliverHeld('b')).toEqual({ delivered: false, why: 'busy' }) // working
    expect(delivery.deliverHeld('b', { overDraft: true })).toEqual({ delivered: false, why: 'busy' })
    expect(delivery.deliverHeld('nope')).toEqual({ delivered: false, why: 'no-room' })
    sessions.tabExited('b', 0)
    expect(delivery.deliverHeld('b')).toEqual({ delivered: false, why: 'ended' })
    expect(writes).toEqual([])
  })
})

describe('SessionInfo.room and held', () => {
  it('syncTab mirrors the membership and the held count, and clears them when the tab leaves', () => {
    member('c', 'carol', { coordinator: true, status: 'working' })
    delivery.send(roomId, 'plugin', 'carol', 'a')
    delivery.send(roomId, 'plugin', 'carol', 'b')
    expect(sessions.get('c')).toMatchObject({ room: { title: 'Team', name: 'carol', coordinator: true }, held: 2 })
    rooms.take(roomId, 'carol')
    delivery.syncTab('c')
    expect(sessions.get('c')?.room).toEqual({ title: 'Team', name: 'carol', coordinator: true })
    expect(sessions.get('c')).not.toHaveProperty('held')
    rooms.leave('c')
    delivery.syncTab('c')
    expect(sessions.get('c')).not.toHaveProperty('room')
  })

  it('reach SessionInfo (the messages never do) and never the scope-all summaries', () => {
    member('w', 'walt', { status: 'working' })
    delivery.send(roomId, 'plugin', 'walt', 'secret plan')
    const entry = sessions.get('w')!
    const info = sessionInfoOf(entry)
    expect(info.room).toEqual({ title: 'Team', name: 'walt', coordinator: false })
    expect(info.held).toBe(1)
    expect(JSON.stringify(info)).not.toContain('secret plan')
    const [summary] = sessions.summariesFor('p1')
    expect(summary).not.toHaveProperty('room')
    expect(summary).not.toHaveProperty('held')
    expect(sessionInfoOf({ ...entry, room: undefined, held: undefined })).not.toHaveProperty('room')
  })
})
