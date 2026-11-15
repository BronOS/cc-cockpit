import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoomLog } from '../../src/main/rooms/room-log'

let dir: string
let path: string
let t: number
const clock = (): number => ++t

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-log-'))
  path = join(dir, 'r1', 'log.jsonl')
  t = 1000
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('RoomLog', () => {
  it('appends one JSON line per event and reads them back', () => {
    const log = new RoomLog(path, undefined, clock)
    log.append('join', { member: 'a' })
    log.append('send', { from: 'a', to: 'b', text: 'hi', delivery: 'held' })
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2)
    expect(log.read()).toEqual([
      { member: 'a', at: 1001, type: 'join' },
      { from: 'a', to: 'b', text: 'hi', delivery: 'held', at: 1002, type: 'send' }
    ])
  })

  it('a caller field cannot override at or type', () => {
    const log = new RoomLog(path, undefined, clock)
    log.append('join', { at: 1, type: 'end' })
    expect(log.read()[0]).toMatchObject({ at: 1001, type: 'join' })
  })

  it('reads an absent file as empty', () => {
    expect(new RoomLog(path).read()).toEqual([])
  })

  it('filters by since and keeps the newest on a limit', () => {
    const log = new RoomLog(path, undefined, clock)
    for (let i = 0; i < 5; i++) log.append('send', { i })
    expect(log.read({ since: 1002 }).map((e) => e.i)).toEqual([2, 3, 4])
    expect(log.read({ limit: 2 }).map((e) => e.i)).toEqual([3, 4])
    expect(log.read({ since: 1001, limit: 2 }).map((e) => e.i)).toEqual([3, 4])
    expect(log.read({ limit: 0 })).toEqual([])
  })

  it('drops the oldest half past the cap and appends a line saying so', () => {
    const log = new RoomLog(path, 600, clock)
    for (let i = 0; i < 20; i++) log.append('send', { i, text: 'x'.repeat(20) })
    const entries = log.read()
    expect(entries.some((e) => e.type === 'trimmed')).toBe(true)
    const trimmed = entries.find((e) => e.type === 'trimmed')
    expect(trimmed?.dropped).toBeGreaterThan(0)
    // the newest event survives, the oldest is gone
    expect(entries.some((e) => e.i === 19)).toBe(true)
    expect(entries.some((e) => e.i === 0)).toBe(false)
    expect(readFileSync(path).length).toBeLessThan(700)
  })

  it('skips a torn last line on read and keeps appending after it', () => {
    const log = new RoomLog(path, undefined, clock)
    log.append('join', { member: 'a' })
    appendFileSync(path, '{"at":5,"type":"sen')
    expect(log.read()).toHaveLength(1)
    appendFileSync(path, '\n')
    log.append('leave', { member: 'a' })
    expect(log.read().map((e) => e.type)).toEqual(['join', 'leave'])
  })

  it('skips lines that are not log entries', () => {
    const log = new RoomLog(path, undefined, clock)
    log.append('join')
    appendFileSync(path, '[1,2]\n{"at":"x","type":"join"}\n42\n')
    expect(log.read()).toHaveLength(1)
  })
})
