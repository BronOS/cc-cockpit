import { appendFileSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
    expect(log.page().entries).toEqual([
      { member: 'a', seq: 1, at: 1001, type: 'join' },
      { from: 'a', to: 'b', text: 'hi', delivery: 'held', seq: 2, at: 1002, type: 'send' }
    ])
  })

  it('a caller field cannot override seq, at or type', () => {
    const log = new RoomLog(path, undefined, clock)
    log.append('join', { seq: 9, at: 1, type: 'end' })
    expect(log.page().entries[0]).toMatchObject({ seq: 1, at: 1001, type: 'join' })
  })

  it('numbers entries from the file itself: another instance, a restart and a torn line keep counting', () => {
    const log = new RoomLog(path, undefined, () => 5)
    log.append('join')
    log.append('send')
    new RoomLog(path, undefined, () => 5).append('leave')
    appendFileSync(path, '{"seq":99,"at":5,"type":"sen')
    log.append('end')
    expect(new RoomLog(path).page().entries.map((e) => [e.seq, e.type])).toEqual([
      [1, 'join'],
      [2, 'send'],
      [3, 'leave'],
      [4, 'end']
    ])
  })

  it('reads an absent file as empty', () => {
    expect(new RoomLog(path).page().entries).toEqual([])
  })

  it('without since answers the newest; with the since cursor the oldest after it, and says when more remain', () => {
    const log = new RoomLog(path, undefined, clock)
    for (let i = 0; i < 5; i++) log.append('send', { i })
    expect(log.page({ limit: 2 })).toEqual({ entries: [expect.objectContaining({ i: 3 }), expect.objectContaining({ i: 4 })], more: true })
    expect(log.page({ limit: 5 }).more).toBe(false)
    expect(log.page({ since: 2 }).entries.map((e) => e.i)).toEqual([2, 3, 4])
    expect(log.page({ since: 1, limit: 2 })).toEqual({ entries: [expect.objectContaining({ i: 1 }), expect.objectContaining({ i: 2 })], more: true })
    expect(log.page({ since: 3, limit: 2 })).toEqual({ entries: [expect.objectContaining({ i: 3 }), expect.objectContaining({ i: 4 })], more: false })
    expect(log.page({ since: 5 })).toEqual({ entries: [], more: false })
    expect(log.page({ since: 0 }).entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
    expect(log.page({ limit: 0 }).entries).toEqual([])
  })

  it('a poll never skips an entry logged in the same millisecond as the last one it saw (review M2)', () => {
    const log = new RoomLog(path, undefined, () => 7)
    log.append('leave', { member: 'a' })
    const first = log.page({ since: 0 }).entries
    log.append('end')
    expect(log.page({ since: first.at(-1)!.seq }).entries.map((e) => e.type)).toEqual(['end'])
  })

  it('a poller that fell behind pages through everything in order, across a large file with torn lines', () => {
    const log = new RoomLog(path, undefined, clock)
    for (let i = 0; i < 3000; i++) {
      log.append('send', { i, text: 'y'.repeat(i % 7 === 0 ? 900 : 40) })
      if (i % 500 === 250) appendFileSync(path, '{"seq":1,"at":5,"type":"torn')
    }
    expect(readFileSync(path).length).toBeGreaterThan(4 * 64 * 1024)
    const seen: number[] = []
    let since = 0
    for (let page = log.page({ since, limit: 1000 }); ; page = log.page({ since, limit: 1000 })) {
      seen.push(...page.entries.map((e) => e.i as number))
      since = page.entries.at(-1)?.seq ?? since
      if (!page.more) break
    }
    expect(seen).toEqual([...Array(3000).keys()])
    // A cursor anywhere in the file lands on the next entry.
    for (const at of [1, 2, 777, 1500, 2999, 3000]) expect(log.page({ since: at, limit: 1 }).entries.map((e) => e.seq)).toEqual(at < 3000 ? [at + 1] : [])
    expect(log.page({ limit: 3 }).entries.map((e) => e.i)).toEqual([2997, 2998, 2999])
  })

  it('drops the oldest half past the cap and appends a line saying so', () => {
    const log = new RoomLog(path, 600, clock)
    for (let i = 0; i < 20; i++) log.append('send', { i, text: 'x'.repeat(20) })
    const entries = log.page().entries
    expect(entries.some((e) => e.type === 'trimmed')).toBe(true)
    const trimmed = entries.find((e) => e.type === 'trimmed')
    expect(trimmed?.dropped).toBeGreaterThan(0)
    // the newest event survives, the oldest is gone
    expect(entries.some((e) => e.i === 19)).toBe(true)
    expect(entries.some((e) => e.i === 0)).toBe(false)
    expect(readFileSync(path).length).toBeLessThan(700)
    // The numbers survive the trim and keep counting: a cursor from before it still finds what is newer.
    const seqs = entries.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
    log.append('end')
    expect(log.page().entries.at(-1)?.seq).toBe(Math.max(...seqs) + 1)
    expect(log.page({ since: seqs.at(-1)! }).entries.map((e) => e.type)).toEqual(['end'])
    // A cursor from before the trim answers the oldest entries still there, every one newer than it.
    expect(log.page({ since: 1, limit: 1 }).entries[0]?.seq).toBe(entries[0]?.seq)
  })

  it('skips a torn last line on read and keeps appending after it', () => {
    const log = new RoomLog(path, undefined, clock)
    log.append('join', { member: 'a' })
    appendFileSync(path, '{"at":5,"type":"sen')
    expect(log.page().entries).toHaveLength(1)
    const fresh = new RoomLog(path, undefined, clock)
    fresh.append('leave', { member: 'a' })
    expect(log.page().entries.map((e) => e.type)).toEqual(['join', 'leave'])
  })

  it('does not lose an entry appended right after a torn line', () => {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, '{"at":5,"type":"sen')
    new RoomLog(path, undefined, clock).append('leave', { member: 'a' })
    expect(new RoomLog(path).page().entries.map((e) => e.type)).toEqual(['leave'])
  })

  it('ignores a NaN since and a negative limit', () => {
    const log = new RoomLog(path, undefined, clock)
    log.append('join')
    expect(log.page({ since: NaN, limit: -1 }).entries).toHaveLength(1)
  })

  it('maxBytes bounds a page by its JSON lines, never below one entry, and says there is more', () => {
    const log = new RoomLog(path, undefined, clock)
    for (let i = 0; i < 6; i++) log.append('send', { i, text: 'x'.repeat(1000) })
    const line = readFileSync(path, 'utf8').split('\n')[0]!.length + 1
    // The newest: as many as fit, oldest first.
    const newest = log.page({ maxBytes: line * 2 + 10 })
    expect(newest.entries.map((e) => e.i)).toEqual([4, 5])
    expect(newest.more).toBe(true)
    // After a cursor: the oldest that fit, and `more` to page on.
    const after = log.page({ since: 1, maxBytes: line * 3 + 10 })
    expect(after.entries.map((e) => e.i)).toEqual([1, 2, 3])
    expect(after.more).toBe(true)
    // One entry bigger than the budget still comes (a poller must move on), with `more` while others remain.
    expect(log.page({ since: 0, maxBytes: 1 })).toEqual({ entries: [expect.objectContaining({ i: 0 })], more: true })
    expect(log.page({ maxBytes: 1 })).toEqual({ entries: [expect.objectContaining({ i: 5 })], more: true })
    // A budget that takes everything: no `more`; with a limit too, the smaller bound wins.
    expect(log.page({ since: 0, maxBytes: line * 100 }).more).toBe(false)
    expect(log.page({ limit: 1, maxBytes: line * 100 })).toEqual({ entries: [expect.objectContaining({ i: 5 })], more: true })
  })

  it('an append reads back only the last line for its seq, however large the ones before it', () => {
    const log = new RoomLog(path, undefined, clock)
    log.append('send', { text: 'x'.repeat(200_000) })
    log.append('send', { text: 'y' })
    // A second large line before the last: the seq still comes from the last whole line.
    log.append('end')
    expect(log.page().entries.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('a trim keeps whole lines only and counts the dropped ones exactly', () => {
    const log = new RoomLog(path, 1000, clock)
    let sends = 0
    while (!log.page().entries.some((e) => e.type === 'trimmed')) {
      log.append('send', { i: sends, text: 'z'.repeat(40) })
      sends++
    }
    const raw = readFileSync(path, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    // Every line parses: the cut fell on a line boundary.
    for (const l of raw.trim().split('\n')) expect(() => JSON.parse(l)).not.toThrow()
    expect(raw.length).toBeLessThanOrEqual(500 + 100)
    const entries = log.page().entries
    const trimmed = entries.at(-1)!
    expect(trimmed.type).toBe('trimmed')
    // The one trim: what it dropped and what it kept are every send there was, the newest kept.
    expect((trimmed.dropped as number) + entries.length - 1).toBe(sends)
    expect(entries.at(-2)?.i).toBe(sends - 1)
  })

  it('trims by bytes when a few huge lines stay over the cap', () => {
    const log = new RoomLog(path, 1000, clock)
    for (let i = 0; i < 4; i++) log.append('send', { text: 'x'.repeat(400) })
    expect(readFileSync(path).length).toBeLessThan(1000)
  })

  it('skips lines that are not log entries', () => {
    const log = new RoomLog(path, undefined, clock)
    log.append('join')
    appendFileSync(path, '[1,2]\n{"seq":2,"at":"x","type":"join"}\n{"at":5,"type":"join"}\n{"seq":0,"at":5,"type":"join"}\n42\n')
    expect(log.page().entries).toHaveLength(1)
  })

  it('never follows a link: a linked log file or room folder refuses the append and leaves the target alone', () => {
    const target = join(dir, 'target.txt')
    writeFileSync(target, 'keep')
    mkdirSync(join(dir, 'r1'))
    symlinkSync(target, path)
    const log = new RoomLog(path, undefined, clock)
    expect(() => log.append('join')).toThrow()
    expect(log.page().entries).toEqual([])
    expect(readFileSync(target, 'utf8')).toBe('keep')
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    const linked = join(dir, 'r2')
    symlinkSync(outside, linked)
    expect(() => new RoomLog(join(linked, 'log.jsonl'), undefined, clock).append('join')).toThrow()
    expect(readdirSync(outside)).toEqual([])
  })
})
