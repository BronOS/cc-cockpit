import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ROOM_SEND_LIMITS, RoomDelivery } from '../../src/main/rooms/room-delivery'
import { pointerText } from '../../src/shared/room-pointer'
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
function hookStop(
  tabId: string,
  payload: unknown = { stop_hook_active: false },
  connection: AbortController = new AbortController()
): unknown {
  return handler()({ event: 'Stop', payload, reply: true }, caller(tabId), connection.signal)
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
  it(`at most ${MAX_STOP_BLOCKS_IN_A_ROW} in a row, then held until the person's next prompt`, () => {
    member('t1', 'alpha')
    message('alpha')
    for (let i = 0; i < MAX_STOP_BLOCKS_IN_A_ROW; i++) {
      expect(stop.stop('t1', { stop_hook_active: i > 0 })).toBeDefined()
    }
    expect(stop.stop('t1', { stop_hook_active: true })).toBeUndefined()
    expect(warnings.some((w) => w.includes('in a row'))).toBe(true)
    // Held: a fresh run (stop_hook_active false) gets nothing either, until the person's prompt in the tab. A
    // keystroke is not one (an answer key, a draft typed while Claude loops).
    expect(stop.stop('t1', { stop_hook_active: false })).toBeUndefined()
    stop.personInput('t1')
    expect(stop.stop('t1', { stop_hook_active: false })).toBeUndefined()
    stop.personPrompt('t1')
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

  it("through the registry: the person's submitted prompt ends the cap; keystrokes and our own pastes do not", () => {
    member('t1', 'alpha')
    mark('t1')
    message('alpha')
    const offPrompt = sessions.onPersonPrompt((tabId) => stop.personPrompt(tabId))
    const offInput = sessions.onPersonInput((tabId) => stop.personInput(tabId))
    for (let i = 0; i < MAX_STOP_BLOCKS_IN_A_ROW; i++) expect(stop.stop('t1', { stop_hook_active: i > 0 })).toBeDefined()
    expect(stop.stop('t1', { stop_hook_active: true })).toBeUndefined()
    // A prompt with no input of the person's in the box (a gate paste, a harness turn): still capped.
    sessions.applyHook('t1', 'UserPromptSubmit', { prompt: 'pasted' })
    expect(stop.stop('t1', { stop_hook_active: false })).toBeUndefined()
    // The person types: still capped until they submit.
    sessions.userInput('p1', 't1', `${ESC}[I`) // a focus report: not the person
    sessions.userInput('p1', 't1', 'y')
    expect(stop.stop('t1', { stop_hook_active: false })).toBeUndefined()
    sessions.applyHook('t1', 'UserPromptSubmit', { prompt: 'y' })
    expect(stop.stop('t1', { stop_hook_active: false })).toBeDefined()
    offPrompt()
    offInput()
  })

  it('a throwing person-prompt subscriber is logged and the prompt still applies', () => {
    const logs: string[] = []
    const reg = new SessionRegistry({ projectName: () => 'p', broadcast: () => {}, write: () => {}, log: (m) => logs.push(m) })
    reg.tabStarted({ tabId: 'x', projectId: 'p1', kind: 'claude', cwd: '/proj' })
    const seen: string[] = []
    reg.onPersonPrompt(() => {
      throw new Error('boom')
    })
    reg.onPersonPrompt((tabId) => seen.push(tabId))
    reg.userInput('p1', 'x', 'h')
    reg.applyHook('x', 'UserPromptSubmit', { prompt: 'h' })
    expect(reg.get('x')?.status).toBe('working')
    expect(seen).toEqual(['x'])
    expect(logs.some((l) => l.includes('person-prompt subscriber threw'))).toBe(true)
    reg.dispose()
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

  /** The delivery as the room service wires it to the room stop (room-service.ts). */
  const wiredDelivery = (): RoomDelivery =>
    new RoomDelivery({
      rooms,
      sessions,
      tabRoom: (tabId) => tabRooms.get(tabId),
      capped: (tabId) => stop.isCapped(tabId),
      personDelivered: (tabId) => stop.personPrompt(tabId),
      now: () => t,
      log: () => {}
    })

  it("at the cap the gate holds the pointer too (capped), marked or not; the person's badge click delivers and ends it", () => {
    const delivery = wiredDelivery()
    member('t1', 'alpha')
    member('t2', 'beta', { typed: true })
    mark('t2')
    message('alpha')
    message('beta')
    for (const tabId of ['t1', 't2']) {
      for (let i = 0; i <= MAX_STOP_BLOCKS_IN_A_ROW; i++) stop.stop(tabId, { stop_hook_active: i > 0 })
      expect(stop.isCapped(tabId)).toBe(true)
      // Claude stopped (the plain Stop): the tab waits for input, where the gate would paste.
      sessions.applyHook(tabId, 'Stop', {})
    }
    expect(delivery.offer(roomId, 'alpha')).toEqual({ to: 'alpha', path: 'held', why: 'capped' })
    expect(delivery.send(roomId, 'plugin', 'all', 'more')).toEqual([
      { to: 'alpha', path: 'held', why: 'capped' },
      { to: 'beta', path: 'held', why: 'capped' }
    ])
    expect(writes).toEqual([])
    // The badge click is the person's own act: it goes in, and the loop may go on from there.
    expect(delivery.deliverHeld('t1')).toEqual({ delivered: true })
    expect(writes).toEqual([{ tabId: 't1', data: paste(pointerText(2)) }])
    expect(stop.isCapped('t1')).toBe(false)
    expect(stop.isCapped('t2')).toBe(true)
  })

  it("the person's Resume of the room ends its member tabs' runs and caps, and only that room's", () => {
    member('t1', 'alpha')
    message('alpha')
    const other = rooms.create(owner, { title: 'Other' }).id
    sessions.tabStarted({ tabId: 't9', projectId: 'p1', kind: 'claude', cwd: '/proj' })
    sessions.applyHook('t9', 'UserPromptSubmit', { prompt: 'go' })
    rooms.addMember(owner, other, { tabId: 't9', name: 'zeta' })
    tabRooms.set('t9', { id: other, name: 'zeta', coordinator: false, mark: false })
    rooms.enqueue(other, 'zeta', { from: 'plugin', text: 'hi' })
    for (const tabId of ['t1', 't9']) for (let i = 0; i <= MAX_STOP_BLOCKS_IN_A_ROW; i++) stop.stop(tabId, { stop_hook_active: i > 0 })
    stop.roomResumed(roomId)
    expect(stop.isCapped('t1')).toBe(false)
    expect(stop.isCapped('t9')).toBe(true)
    expect(stop.stop('t1', { stop_hook_active: true })).toBeDefined()
  })
})

describe('the blocked Stop through the hook handler', () => {
  it('answers the block, keeps the tab working and the gate delivers nothing', () => {
    member('t1', 'alpha')
    message('alpha')
    // A core text queued while the turn runs: a plain Stop would deliver it.
    expect(sessions.send('t1', 'from discuss', 'core').delivered).toBe(false)
    expect(hookStop('t1')).toEqual({ block: pointerText(1), ackId: 'ack-1' })
    expect(sessions.get('t1')?.status).toBe('working')
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

  it('a room stop that throws is logged and the Stop is applied as a plain one', () => {
    member('t1', 'alpha')
    message('alpha')
    sessions.send('t1', 'from discuss', 'core')
    vi.spyOn(stop, 'stop').mockImplementation(() => {
      throw new Error('bad room state')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(hookStop('t1')).toBeNull()
    expect(sessions.get('t1')?.status).toBe('waiting')
    expect(writes).toEqual([{ tabId: 't1', data: paste('from discuss') }])
    expect(warn.mock.calls.some(([m]) => String(m).includes('bad room state'))).toBe(true)
    warn.mockRestore()
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

  it('no ack in time: logged, the tab stays working and nothing is typed (the turn may have gone on)', () => {
    member('t1', 'alpha')
    message('alpha')
    sessions.send('t1', 'from discuss', 'core')
    hookStop('t1')
    vi.advanceTimersByTime(ACK_TIMEOUT_MS * 10)
    expect(sessions.get('t1')?.status).toBe('working')
    expect(writes).toEqual([])
    expect(warnings.some((w) => w.includes('no ack') && w.includes('stays working'))).toBe(true)
    // A send finds the tab not sendable either: it queues.
    expect(sessions.send('t1', 'later', 'core').delivered).toBe(false)
    expect(writes).toEqual([])
    // A late ack still confirms the block; the messages stay queued for `ccc room read`.
    expect(stop.ack('t1', 'ack-1')).toBe(true)
    expect(rooms.held(roomId, 'alpha')).toBe(1)
    // The next real Stop is a plain one and delivers the head as usual.
    stop.personPrompt('t1')
    rooms.pause(roomId)
    expect(hookStop('t1', { stop_hook_active: true })).toBeNull()
    expect(sessions.get('t1')?.status).toBe('waiting')
    expect(writes).toEqual([{ tabId: 't1', data: paste('from discuss') }])
  })

  it('no ack but the turn went on: the timeout leaves the tab alone', () => {
    member('t1', 'alpha')
    message('alpha')
    hookStop('t1')
    continued('t1')
    vi.advanceTimersByTime(ACK_TIMEOUT_MS)
    expect(sessions.get('t1')?.status).toBe('working')
  })

  it('the connection closes unacked (ccc never printed): the plain Stop is applied, waiting, the head delivered', () => {
    member('t1', 'alpha')
    message('alpha')
    sessions.send('t1', 'from discuss', 'core')
    const connection = new AbortController()
    hookStop('t1', { stop_hook_active: false }, connection)
    expect(sessions.get('t1')?.status).toBe('working')
    expect(writes).toEqual([])
    connection.abort()
    expect(sessions.get('t1')?.status).toBe('waiting')
    expect(writes).toEqual([{ tabId: 't1', data: paste('from discuss') }])
    // The block is gone: a late ack confirms nothing, the messages stay held, no delivery counted.
    expect(stop.ack('t1', 'ack-1')).toBe(false)
    expect(rooms.held(roomId, 'alpha')).toBe(1)
    vi.advanceTimersByTime(ACK_TIMEOUT_MS)
    expect(warnings).toEqual([])
  })

  it('the connection closes unacked with nothing else queued: the room pointer is offered through the gate', () => {
    stop.dispose()
    const wired: { delivery?: RoomDelivery } = {}
    const unblocked: string[] = []
    stop = new RoomStop({
      rooms,
      sessions,
      tabRoom: (tabId) => tabRooms.get(tabId),
      newAckId: () => `ack-${++acks}`,
      log: (m) => warnings.push(m),
      // As the room service wires it: the member is offered what waits.
      unblocked: (tabId) => {
        unblocked.push(tabId)
        const m = rooms.memberOf(tabId)
        if (m) wired.delivery?.offer(m.roomId, m.name)
      }
    })
    wired.delivery = new RoomDelivery({ rooms, sessions, tabRoom: (tabId) => tabRooms.get(tabId), now: () => t, log: () => {} })
    member('t1', 'alpha')
    message('alpha')
    const connection = new AbortController()
    hookStop('t1', { stop_hook_active: false }, connection)
    expect(writes).toEqual([])
    connection.abort()
    expect(unblocked).toEqual(['t1'])
    expect(writes).toEqual([{ tabId: 't1', data: paste(pointerText(1)) }])
  })

  it('the connection closes after the ack: Claude goes on, the tab stays working', () => {
    member('t1', 'alpha')
    message('alpha')
    sessions.send('t1', 'from discuss', 'core')
    const connection = new AbortController()
    hookStop('t1', { stop_hook_active: false }, connection)
    expect(stop.ack('t1', 'ack-1')).toBe(true)
    connection.abort()
    expect(sessions.get('t1')?.status).toBe('working')
    expect(writes).toEqual([])
  })

  it('a later hook since the blocked Stop: the close leaves the tab as the turn left it', () => {
    member('t1', 'alpha')
    message('alpha')
    sessions.send('t1', 'from discuss', 'core')
    const connection = new AbortController()
    hookStop('t1', { stop_hook_active: false }, connection)
    continued('t1')
    const unblocked = vi.spyOn(stop, 'unblocked')
    connection.abort()
    // Nothing undone, so nothing offered either: the turn goes on.
    expect(unblocked).not.toHaveBeenCalled()
    expect(sessions.get('t1')?.status).toBe('working')
    expect(sessions.get('t1')?.blockedStop).toBeUndefined()
    expect(writes).toEqual([])
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
  const autoPaused = () => rooms.logOf(roomId).page().entries.filter((e) => e.type === 'auto-pause')

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

  it('a timed-out block counts once, at a late ack or at the next Stop that follows it', () => {
    member('t1', 'alpha')
    message('alpha')
    for (let i = 0; i < AUTO_PAUSE_DELIVERIES - 1; i++) stop.delivered(roomId)
    hookStop('t1')
    vi.advanceTimersByTime(ACK_TIMEOUT_MS)
    // The timeout alone is no evidence the block reached Claude: no count.
    expect(rooms.peek(roomId)?.paused).toBe(false)
    hookStop('t1', { stop_hook_active: true })
    expect(rooms.peek(roomId)?.paused).toBe(true)
  })

  it('a timed-out block whose next Stop does not follow a block is not counted', () => {
    member('t1', 'alpha')
    message('alpha')
    for (let i = 0; i < AUTO_PAUSE_DELIVERIES - 1; i++) stop.delivered(roomId)
    hookStop('t1')
    vi.advanceTimersByTime(ACK_TIMEOUT_MS)
    hookStop('t1', { stop_hook_active: false })
    expect(stop.ack('t1', 'ack-1')).toBe(false)
    expect(rooms.peek(roomId)?.paused).toBe(false)
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

  it('a room that ended or was deleted counts nothing (a late ack after roomGone): no pause, no throw', () => {
    rooms.end(owner, roomId)
    for (let i = 0; i < AUTO_PAUSE_DELIVERIES; i++) stop.delivered(roomId)
    expect(rooms.peek(roomId)?.paused).toBe(false)
    rooms.delete(owner, roomId)
    for (let i = 0; i < AUTO_PAUSE_DELIVERIES; i++) stop.delivered(roomId)
    expect(warnings.some((w) => w.includes('could not auto-pause'))).toBe(false)
  })

  it('roomGone forgets the count', () => {
    for (let i = 0; i < AUTO_PAUSE_DELIVERIES - 1; i++) stop.delivered(roomId)
    stop.roomGone(roomId)
    stop.delivered(roomId)
    expect(rooms.peek(roomId)?.paused).toBe(false)
  })
})
