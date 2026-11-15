import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ROOM_SEND_LIMITS, RoomDelivery, pointerText } from '../../src/main/rooms/room-delivery'
import { RoomRegistry, type RoomOwner } from '../../src/main/rooms/room-registry'
import {
  ACK_TIMEOUT_MS,
  AUTO_PAUSE_DELIVERIES,
  MAX_STOP_BLOCKS_IN_A_ROW,
  RoomStop,
  type StopBlock
} from '../../src/main/rooms/room-stop'
import { hookHandler } from '../../src/main/sessions/hook-handler'
import { SessionRegistry } from '../../src/main/sessions/session-registry'
import type { Caller } from '../../src/main/socket/socket-server'
import type { TabRoom } from '../../src/shared/tab-room'

const ESC = '\x1b'
const paste = (text: string): string => `${ESC}[200~${text}${ESC}[201~\r`
const owner: RoomOwner = { pluginId: 'example.team', projectId: 'p1' }

let dir: string
let t: number
let ids: number
let acks: number
let rooms: RoomRegistry
let sessions: SessionRegistry
let writes: Array<{ tabId: string; data: string }>
let tabRooms: Map<string, TabRoom>
let warnings: string[]
let stop: RoomStop
let roomId: string

function nextId(): string {
  ids++
  return `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`
}

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'cc-room-stop-'))
  t = 1_000_000
  ids = 0
  acks = 0
  writes = []
  tabRooms = new Map()
  warnings = []
  rooms = new RoomRegistry({ dir, now: () => t, newId: nextId, log: () => {} })
  sessions = new SessionRegistry({
    projectName: () => 'p',
    broadcast: () => {},
    write: ({ tabId }, data) => {
      writes.push({ tabId, data })
    },
    log: () => {}
  })
  stop = new RoomStop({
    rooms,
    sessions,
    tabRoom: (tabId) => tabRooms.get(tabId),
    newAckId: () => `ack-${++acks}`,
    log: (m) => warnings.push(m)
  })
  roomId = rooms.create(owner, { title: 'Team' }).id
})

afterEach(() => {
  stop.dispose()
  sessions.dispose()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

/** A member tab with a live session in a turn (working): its Stop is what the tests send. */
function member(tabId: string, name: string, opts: { typed?: boolean } = {}): void {
  sessions.tabStarted({ tabId, projectId: 'p1', kind: 'claude', cwd: '/proj' })
  sessions.applyHook(tabId, 'UserPromptSubmit', { prompt: 'go' })
  if (opts.typed) sessions.userInput('p1', tabId, 'x')
  rooms.addMember(owner, roomId, { tabId, name })
  tabRooms.set(tabId, { id: roomId, name, coordinator: false, mark: false })
}

const message = (to: string, text = 'hi'): void => {
  rooms.enqueue(roomId, to, { from: 'plugin', text })
}
const mark = (tabId: string, patch: Partial<TabRoom> = {}): void => {
  tabRooms.set(tabId, { ...tabRooms.get(tabId)!, mark: true, ...patch })
}
/** The hook handler as main runs it: the room stop decides, then the registry applies the Stop. */
const handler = () => hookHandler(sessions, stop)
const caller = (tabId: string): Caller => ({ kind: 'session', tabId, projectId: 'p1' })
function hookStop(tabId: string, payload: unknown = { stop_hook_active: false }): unknown {
  return handler()({ event: 'Stop', payload }, caller(tabId), new AbortController().signal)
}
/** A turn that goes on after a block (the continued turn runs a tool) and stops again. */
function continued(tabId: string): void {
  sessions.applyHook(tabId, 'PreToolUse', { tool_name: 'Bash' })
}

describe('the block decision', () => {
  it('blocks an untyped member with messages: the fixed pointer and a fresh ack id', () => {
    member('t1', 'alpha')
    message('alpha')
    message('alpha')
    expect(stop.stop('t1', { stop_hook_active: false })).toEqual<StopBlock>({ block: pointerText(2), ackId: 'ack-1' })
  })

  it('no block with nothing waiting, for a tab in no room, or with no session', () => {
    member('t1', 'alpha')
    expect(stop.stop('t1', {})).toBeUndefined()
    sessions.tabStarted({ tabId: 'loner', projectId: 'p1', kind: 'claude', cwd: '/proj' })
    expect(stop.stop('loner', {})).toBeUndefined()
    rooms.addMember(owner, roomId, { tabId: 'ghost', name: 'ghost' })
    message('ghost')
    expect(stop.stop('ghost', {})).toBeUndefined()
  })

  it('no block in a paused or an ended room', () => {
    member('t1', 'alpha')
    message('alpha')
    rooms.pause(roomId)
    expect(stop.stop('t1', {})).toBeUndefined()
    rooms.resume(roomId)
    expect(stop.stop('t1', {})).toBeDefined()
    rooms.end(owner, roomId)
    expect(stop.stop('t1', {})).toBeUndefined()
  })

  it('a typed member without the mark is never blocked', () => {
    member('t1', 'alpha', { typed: true })
    message('alpha')
    for (let i = 0; i < 3; i++) expect(stop.stop('t1', { stop_hook_active: false })).toBeUndefined()
  })

  it('a typed member with the mark is blocked, a draft does not hold the Stop pointer', () => {
    member('t1', 'alpha', { typed: true })
    message('alpha')
    mark('t1')
    expect(sessions.get('t1')?.draft).toBe(true)
    expect(stop.stop('t1', {})?.block).toBe(pointerText(1))
  })

  it('a mark for another room or name is no mark', () => {
    member('t1', 'alpha', { typed: true })
    message('alpha')
    mark('t1', { id: '00000000-0000-4000-8000-00000000ffff' })
    expect(stop.stop('t1', {})).toBeUndefined()
    mark('t1', { id: roomId, name: 'beta' })
    expect(stop.stop('t1', {})).toBeUndefined()
  })

  it('no block for an ended session or while a paste of ours waits for its UserPromptSubmit', () => {
    member('t1', 'alpha')
    message('alpha')
    sessions.applyHook('t1', 'Stop', {})
    expect(sessions.sendPointer('t1', pointerText(1))).toBe(true)
    expect(sessions.get('t1')?.delivering).toBe(true)
    expect(stop.stop('t1', {})).toBeUndefined()
    sessions.tabExited('t1', 0)
    expect(stop.stop('t1', {})).toBeUndefined()
  })
})

describe('blocks in a row', () => {
  it(`at most ${MAX_STOP_BLOCKS_IN_A_ROW} in a row, then held until the person's input`, () => {
    member('t1', 'alpha')
    message('alpha')
    for (let i = 0; i < MAX_STOP_BLOCKS_IN_A_ROW; i++) {
      expect(stop.stop('t1', { stop_hook_active: i > 0 })).toBeDefined()
    }
    expect(stop.stop('t1', { stop_hook_active: true })).toBeUndefined()
    expect(warnings.some((w) => w.includes('in a row'))).toBe(true)
    // Held: a fresh run (stop_hook_active false) gets nothing either, until the person types in the tab.
    expect(stop.stop('t1', { stop_hook_active: false })).toBeUndefined()
    stop.personInput('t1')
    expect(stop.stop('t1', { stop_hook_active: false })).toBeDefined()
  })

  it('a Stop that does not follow a block starts the run over', () => {
    member('t1', 'alpha')
    message('alpha')
    for (let i = 0; i < MAX_STOP_BLOCKS_IN_A_ROW - 1; i++) expect(stop.stop('t1', { stop_hook_active: i > 0 })).toBeDefined()
    // The run broke (the tab got a prompt from the gate's pointer, say): a new run of five.
    for (let i = 0; i < MAX_STOP_BLOCKS_IN_A_ROW; i++) expect(stop.stop('t1', { stop_hook_active: i > 0 })).toBeDefined()
    expect(stop.stop('t1', { stop_hook_active: true })).toBeUndefined()
  })

  it('a payload ccc could not read keeps the run (only ever blocks less)', () => {
    member('t1', 'alpha')
    message('alpha')
    for (let i = 0; i < MAX_STOP_BLOCKS_IN_A_ROW; i++) expect(stop.stop('t1', i === 0 ? {} : null)).toBeDefined()
    expect(stop.stop('t1', null)).toBeUndefined()
  })

  it('the person typing mid-run resets it; through the registry, focus reports do not count', () => {
    member('t1', 'alpha')
    mark('t1')
    message('alpha')
    const off = sessions.onPersonInput((tabId) => stop.personInput(tabId))
    for (let i = 0; i < MAX_STOP_BLOCKS_IN_A_ROW; i++) expect(stop.stop('t1', { stop_hook_active: i > 0 })).toBeDefined()
    sessions.userInput('p1', 't1', `${ESC}[I`) // a focus report: not the person
    expect(stop.stop('t1', { stop_hook_active: true })).toBeUndefined()
    sessions.userInput('p1', 't1', 'y')
    expect(stop.stop('t1', { stop_hook_active: true })).toBeDefined()
    off()
  })

  it('runs are per tab', () => {
    member('t1', 'alpha')
    member('t2', 'beta')
    message('alpha')
    message('beta')
    for (let i = 0; i <= MAX_STOP_BLOCKS_IN_A_ROW; i++) stop.stop('t1', { stop_hook_active: i > 0 })
    expect(stop.stop('t1', { stop_hook_active: true })).toBeUndefined()
    expect(stop.stop('t2', { stop_hook_active: false })).toBeDefined()
  })

  it('a closed tab forgets its run', () => {
    member('t1', 'alpha')
    message('alpha')
    for (let i = 0; i <= MAX_STOP_BLOCKS_IN_A_ROW; i++) stop.stop('t1', { stop_hook_active: i > 0 })
    stop.tabGone('t1')
    expect(stop.stop('t1', { stop_hook_active: false })).toBeDefined()
  })
})

describe('the blocked Stop through the hook handler', () => {
  it('answers the block, keeps the tab working and the gate delivers nothing', () => {
    member('t1', 'alpha')
    message('alpha')
    // A core text queued while the turn runs: a plain Stop would deliver it.
    expect(sessions.send('t1', 'from discuss', 'core').delivered).toBe(false)
    expect(hookStop('t1')).toEqual({ block: pointerText(1), ackId: 'ack-1' })
    expect(sessions.get('t1')).toMatchObject({ status: 'working', blockedStop: 'ack-1' })
    expect(writes).toEqual([])
  })

  it('a Stop with no block answers null and is a plain Stop', () => {
    member('t1', 'alpha')
    sessions.send('t1', 'from discuss', 'core')
    expect(hookStop('t1')).toBeNull()
    expect(sessions.get('t1')?.status).toBe('waiting')
    expect(writes).toEqual([{ tabId: 't1', data: paste('from discuss') }])
  })

  it('other events never ask the room stop', () => {
    member('t1', 'alpha')
    message('alpha')
    const spy = vi.spyOn(stop, 'stop')
    expect(handler()({ event: 'PreToolUse', payload: { tool_name: 'Bash' } }, caller('t1'), new AbortController().signal)).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('without a room stop the handler is as before', () => {
    member('t1', 'alpha')
    message('alpha')
    expect(hookHandler(sessions)({ event: 'Stop', payload: {} }, caller('t1'), new AbortController().signal)).toBeNull()
    expect(sessions.get('t1')?.status).toBe('waiting')
  })
})

describe('the ack', () => {
  it('confirms only the block the tab waits on, once', () => {
    member('t1', 'alpha')
    member('t2', 'beta')
    message('alpha')
    hookStop('t1')
    expect(stop.ack('t2', 'ack-1')).toBe(false)
    expect(stop.ack('t1', 'ack-9')).toBe(false)
    expect(stop.ack('t1', 42)).toBe(false)
    expect(stop.ack('t1', 'ack-1')).toBe(true)
    expect(stop.ack('t1', 'ack-1')).toBe(false)
    // Acked: the timer is gone, the turn goes on as Claude continues it.
    vi.advanceTimersByTime(ACK_TIMEOUT_MS * 2)
    expect(sessions.get('t1')?.status).toBe('working')
  })

  it('a new Stop ends the wait for the older block', () => {
    member('t1', 'alpha')
    message('alpha')
    hookStop('t1')
    continued('t1')
    hookStop('t1', { stop_hook_active: true })
    expect(stop.ack('t1', 'ack-1')).toBe(false)
    expect(stop.ack('t1', 'ack-2')).toBe(true)
  })

  it('no ack in time: applied as a plain Stop, waiting, and the gate delivers its head', () => {
    member('t1', 'alpha')
    message('alpha')
    sessions.send('t1', 'from discuss', 'core')
    hookStop('t1')
    vi.advanceTimersByTime(ACK_TIMEOUT_MS - 1)
    expect(sessions.get('t1')?.status).toBe('working')
    vi.advanceTimersByTime(1)
    expect(sessions.get('t1')?.status).toBe('waiting')
    expect(sessions.get('t1')?.blockedStop).toBeUndefined()
    expect(writes).toEqual([{ tabId: 't1', data: paste('from discuss') }])
    expect(warnings.some((w) => w.includes('applied as a plain Stop'))).toBe(true)
    // Too late now; the messages are still queued for the next chance.
    expect(stop.ack('t1', 'ack-1')).toBe(false)
    expect(rooms.held(roomId, 'alpha')).toBe(1)
  })

  it('no ack but the turn went on: the timeout leaves the tab alone', () => {
    member('t1', 'alpha')
    message('alpha')
    hookStop('t1')
    continued('t1')
    vi.advanceTimersByTime(ACK_TIMEOUT_MS)
    expect(sessions.get('t1')?.status).toBe('working')
  })

  it('unblockStop needs the very block', () => {
    member('t1', 'alpha')
    message('alpha')
    hookStop('t1')
    expect(sessions.unblockStop('t1', 'ack-2')).toBe(false)
    expect(sessions.unblockStop('nobody', 'ack-1')).toBe(false)
    expect(sessions.unblockStop('t1', 'ack-1')).toBe(true)
    expect(sessions.get('t1')?.status).toBe('waiting')
    expect(sessions.unblockStop('t1', 'ack-1')).toBe(false)
  })

  it('dispose and a closed tab stop the timer', () => {
    member('t1', 'alpha')
    message('alpha')
    hookStop('t1')
    stop.tabGone('t1')
    vi.advanceTimersByTime(ACK_TIMEOUT_MS)
    expect(sessions.get('t1')?.status).toBe('working')
  })
})

describe('auto-pause', () => {
  const autoPaused = () => rooms.logOf(roomId).read().filter((e) => e.type === 'auto-pause')

  it(`pauses the room after ${AUTO_PAUSE_DELIVERIES} deliveries with no person input (logged)`, () => {
    member('t1', 'alpha')
    message('alpha')
    for (let i = 0; i < AUTO_PAUSE_DELIVERIES - 1; i++) stop.delivered(roomId)
    expect(rooms.peek(roomId)?.paused).toBe(false)
    // The hundredth: an acked Stop block.
    hookStop('t1')
    expect(stop.ack('t1', 'ack-1')).toBe(true)
    expect(rooms.peek(roomId)?.paused).toBe(true)
    expect(autoPaused()).toHaveLength(1)
    // Paused: no more Stop pointers until the person resumes, and the count starts over then.
    continued('t1')
    expect(hookStop('t1', { stop_hook_active: true })).toBeNull()
    rooms.resume(roomId)
    for (let i = 0; i < AUTO_PAUSE_DELIVERIES - 1; i++) stop.delivered(roomId)
    expect(rooms.peek(roomId)?.paused).toBe(false)
  })

  it("the person's input in any member tab starts the count over", () => {
    member('t1', 'alpha')
    member('t2', 'beta')
    for (let i = 0; i < AUTO_PAUSE_DELIVERIES - 1; i++) stop.delivered(roomId)
    stop.personInput('t2')
    for (let i = 0; i < AUTO_PAUSE_DELIVERIES - 1; i++) stop.delivered(roomId)
    expect(rooms.peek(roomId)?.paused).toBe(false)
    stop.delivered(roomId)
    expect(rooms.peek(roomId)?.paused).toBe(true)
  })

  it('an unacked block whose next Stop follows a block still counts', () => {
    member('t1', 'alpha')
    message('alpha')
    for (let i = 0; i < AUTO_PAUSE_DELIVERIES - 1; i++) stop.delivered(roomId)
    hookStop('t1')
    continued('t1')
    hookStop('t1', { stop_hook_active: true })
    expect(rooms.peek(roomId)?.paused).toBe(true)
  })

  it("the gate's pointer pastes count through the delivery's hook", () => {
    const delivery = new RoomDelivery({
      rooms,
      sessions,
      tabRoom: (tabId) => tabRooms.get(tabId),
      limits: () => ({ ...DEFAULT_ROOM_SEND_LIMITS, roomSendsPerRoom: 1000 }),
      delivered: (id) => stop.delivered(id),
      now: () => t,
      log: () => {}
    })
    member('t1', 'alpha')
    sessions.applyHook('t1', 'Stop', {})
    for (let i = 0; i < AUTO_PAUSE_DELIVERIES - 1; i++) stop.delivered(roomId)
    expect(delivery.send(roomId, 'plugin', 'alpha', 'hi')).toEqual([{ to: 'alpha', path: 'delivered' }])
    expect(rooms.peek(roomId)?.paused).toBe(true)
    // Paused now: the next message is held.
    sessions.applyHook('t1', 'UserPromptSubmit', { prompt: 'x' })
    sessions.applyHook('t1', 'Stop', {})
    expect(delivery.send(roomId, 'plugin', 'alpha', 'again')).toEqual([{ to: 'alpha', path: 'held', why: 'paused' }])
  })

  it('a room gone meanwhile is a warning, not a throw', () => {
    rooms.end(owner, roomId)
    rooms.delete(owner, roomId)
    for (let i = 0; i < AUTO_PAUSE_DELIVERIES; i++) stop.delivered(roomId)
    expect(warnings.some((w) => w.includes('could not auto-pause'))).toBe(true)
  })

  it('roomGone forgets the count', () => {
    for (let i = 0; i < AUTO_PAUSE_DELIVERIES - 1; i++) stop.delivered(roomId)
    stop.roomGone(roomId)
    stop.delivered(roomId)
    expect(rooms.peek(roomId)?.paused).toBe(false)
  })
})
