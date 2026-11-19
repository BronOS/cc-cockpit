import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoomLog, type RoomLogEntry } from '../../src/main/rooms/room-log'
import {
  MAX_DOC_BYTES,
  MAX_DOC_DEPTH,
  MAX_ROOM_DOC_ENTRIES,
  PERSON_READ_LOG_MS,
  RoomDocs,
  parseDocPath,
  type RoomDocCaller
} from '../../src/main/rooms/room-docs'
import { RoomError } from '../../src/main/rooms/room-error'

const ROOM = '00000000-0000-4000-8000-000000000001'

let root: string
let dir: string
let warnings: string[]
let docs: RoomDocs

const plugin: RoomDocCaller = 'plugin'
const lead: RoomDocCaller = { name: 'lead', coordinator: true }
const alice: RoomDocCaller = { name: 'alice', coordinator: false }
const bob: RoomDocCaller = { name: 'bob', coordinator: false }

function logPath(roomId = ROOM): string {
  return join(dir, roomId, 'log.jsonl')
}

function logEntries(): RoomLogEntry[] {
  return new RoomLog(logPath()).page().entries
}

function store(...parts: string[]): string {
  return join(dir, ROOM, 'docs', ...parts)
}

async function failure(p: Promise<unknown>): Promise<{ code: string; message: string } | undefined> {
  try {
    await p
  } catch (e) {
    return e instanceof RoomError ? { code: e.code, message: e.message } : { code: 'other', message: String(e) }
  }
  return undefined
}

const NOT_FOUND = { code: 'not-found', message: 'no such doc' }

/** A small room total for the cap tests: the real 20 MiB fails with EDQUOT in a quota'd temp dir. */
const SMALL_ROOM_BYTES = 4 * MAX_DOC_BYTES
const smallRoomDocs = (): RoomDocs =>
  new RoomDocs({ dir, logOf: (id) => new RoomLog(logPath(id)), log: (m) => warnings.push(m), maxRoomBytes: SMALL_ROOM_BYTES })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'room-docs-'))
  dir = join(root, 'rooms')
  warnings = []
  // The room's own folder is the registry's (made with the room): the store makes only `docs` and below.
  mkdirSync(join(dir, ROOM), { recursive: true, mode: 0o700 })
  docs = new RoomDocs({ dir, logOf: (id) => new RoomLog(logPath(id)), log: (m) => warnings.push(m) })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('parseDocPath', () => {
  it('splits the area, the member and the parts', () => {
    expect(parseDocPath('shared/brief.md')).toEqual({ area: 'shared', parts: ['brief.md'] })
    expect(parseDocPath('members/alice/notes/q.md')).toEqual({ area: 'members', member: 'alice', parts: ['notes', 'q.md'] })
  })

  it('refuses dots, bad characters, empty parts, other areas and bad member names', () => {
    for (const bad of [
      'shared/../x',
      'shared/./x',
      'shared/..',
      'members/alice/..',
      'members/../shared/x',
      'shared',
      'shared/',
      'shared//x',
      '/shared/x',
      'shared/a b',
      'shared/é.md',
      'shared/a\\b',
      'members/Alice/x',
      'members/all/x',
      'members/alice',
      'other/x',
      'shared/x.tmp-abc',
      '',
      7
    ]) {
      expect(parseDocPath(bad), String(bad)).toBeNull()
    }
  })

  it('caps the depth below the area root', () => {
    const deep = Array.from({ length: MAX_DOC_DEPTH }, (_, i) => `d${i}`)
    expect(parseDocPath(['shared', ...deep].join('/'))).not.toBeNull()
    expect(parseDocPath(['members', 'bob', ...deep].join('/'))).not.toBeNull()
    expect(parseDocPath(['shared', ...deep, 'x'].join('/'))).toBeNull()
  })
})

describe('RoomDocs access', () => {
  beforeEach(async () => {
    await docs.put(ROOM, plugin, 'shared/brief.md', 'the brief')
    await docs.put(ROOM, plugin, 'members/alice/kickoff.md', 'alice kickoff')
    await docs.put(ROOM, plugin, 'members/bob/kickoff.md', 'bob kickoff')
  })

  it('shared: every member reads, only coordinators and the plugin write', async () => {
    for (const c of [plugin, lead, alice, bob]) expect(await docs.get(ROOM, c, 'shared/brief.md')).toBe('the brief')
    await docs.put(ROOM, lead, 'shared/brief.md', 'v2')
    expect(await docs.get(ROOM, alice, 'shared/brief.md')).toBe('v2')
    expect(await failure(docs.put(ROOM, alice, 'shared/brief.md', 'mine'))).toEqual(NOT_FOUND)
    expect(await failure(docs.put(ROOM, alice, 'shared/new.md', 'mine'))).toEqual(NOT_FOUND)
    expect(readFileSync(store('shared', 'brief.md'), 'utf8')).toBe('v2')
  })

  it('members/<name>: the member reads and writes, coordinators read, other members get nothing', async () => {
    expect(await docs.get(ROOM, alice, 'members/alice/kickoff.md')).toBe('alice kickoff')
    await docs.put(ROOM, alice, 'members/alice/memo.md', 'a memo')
    expect(await docs.get(ROOM, lead, 'members/alice/memo.md')).toBe('a memo')
    expect(await failure(docs.get(ROOM, bob, 'members/alice/memo.md'))).toEqual(NOT_FOUND)
    expect(await failure(docs.put(ROOM, bob, 'members/alice/memo.md', 'x'))).toEqual(NOT_FOUND)
    expect(await failure(docs.put(ROOM, lead, 'members/alice/memo.md', 'x'))).toEqual(NOT_FOUND)
    expect(await docs.get(ROOM, alice, 'members/alice/memo.md')).toBe('a memo')
  })

  it('the plugin reads and writes everything', async () => {
    await docs.put(ROOM, plugin, 'members/alice/deep/a/b/c.md', 'deep')
    expect(await docs.get(ROOM, plugin, 'members/alice/deep/a/b/c.md')).toBe('deep')
    expect(await docs.get(ROOM, plugin, 'members/bob/kickoff.md')).toBe('bob kickoff')
  })

  it('a refused doc answers exactly like a missing one', async () => {
    const refused = await failure(docs.get(ROOM, bob, 'members/alice/kickoff.md'))
    const missing = await failure(docs.get(ROOM, bob, 'members/bob/nothing.md'))
    const missingOther = await failure(docs.get(ROOM, bob, 'members/carol/nothing.md'))
    expect(refused).toEqual(NOT_FOUND)
    expect(missing).toEqual(refused)
    expect(missingOther).toEqual(refused)
  })

  it('lists only what the caller may read', async () => {
    await docs.put(ROOM, alice, 'members/alice/notes/q.md', 'q?')
    const paths = async (c: RoomDocCaller) => (await docs.list(ROOM, c)).map((e) => e.path)
    expect(await paths(alice)).toEqual(['members/alice/kickoff.md', 'members/alice/notes/q.md', 'shared/brief.md'])
    expect(await paths(bob)).toEqual(['members/bob/kickoff.md', 'shared/brief.md'])
    const all = ['members/alice/kickoff.md', 'members/alice/notes/q.md', 'members/bob/kickoff.md', 'shared/brief.md']
    expect(await paths(lead)).toEqual(all)
    expect(await paths(plugin)).toEqual(all)
    expect((await docs.list(ROOM, bob)).find((e) => e.path === 'shared/brief.md')?.size).toBe(9)
  })

  it('an empty or unknown store lists nothing', async () => {
    expect(await docs.list('00000000-0000-4000-8000-000000000009', plugin)).toEqual([])
  })

  it('logs reads, writes and refusals with who and what', async () => {
    await docs.get(ROOM, alice, 'shared/brief.md')
    await failure(docs.get(ROOM, bob, 'members/alice/kickoff.md'))
    await failure(docs.put(ROOM, alice, 'shared/x.md', 'x'))
    await failure(docs.get(ROOM, alice, 'shared/../../x'))
    const e = logEntries().map((entry) => {
      const rest: Record<string, unknown> = { ...entry }
      delete rest.at
      delete rest.seq
      return rest
    })
    expect(e).toContainEqual({ type: 'doc-write', by: 'plugin', path: 'shared/brief.md', bytes: 9 })
    expect(e).toContainEqual({ type: 'doc-read', by: 'alice', path: 'shared/brief.md', bytes: 9 })
    expect(e).toContainEqual({ type: 'doc-refused', by: 'bob', path: 'members/alice/kickoff.md', op: 'get', reason: 'not allowed' })
    expect(e).toContainEqual({ type: 'doc-refused', by: 'alice', path: 'shared/x.md', op: 'put', reason: 'not allowed' })
    expect(e).toContainEqual({ type: 'doc-refused', by: 'alice', path: 'shared/../../x', op: 'get', reason: 'bad path' })
  })
})

describe('RoomDocs paths and links', () => {
  it('refuses a bad path as invalid and a bad room id as no such room, writing nothing', async () => {
    expect((await failure(docs.put(ROOM, plugin, 'shared/../../escape', 'x')))?.code).toBe('invalid')
    expect((await failure(docs.put(ROOM, plugin, ['shared', 'a', 'b', 'c', 'd', 'e'].join('/'), 'x')))?.code).toBe('invalid')
    expect((await failure(docs.put('../x', plugin, 'shared/a', 'x')))?.code).toBe('not-found')
    expect((await failure(docs.get('../x', plugin, 'shared/a')))?.code).toBe('not-found')
    expect(readdirSync(root)).toEqual(['rooms'])
  })

  it('refuses a doc that is a link, for read and write, without touching the target', async () => {
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'secret')
    mkdirSync(store('shared'), { recursive: true })
    symlinkSync(outside, store('shared', 'link.md'))
    expect(await failure(docs.get(ROOM, plugin, 'shared/link.md'))).toEqual(NOT_FOUND)
    expect(await failure(docs.put(ROOM, plugin, 'shared/link.md', 'overwrite'))).toEqual(NOT_FOUND)
    expect(readFileSync(outside, 'utf8')).toBe('secret')
    expect((await docs.list(ROOM, plugin)).map((e) => e.path)).toEqual([])
  })

  it('refuses a link at each folder level: the area, a member folder, a subfolder, docs and the room', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'x.md'), 'outside')
    const levels: Array<{ link: string; path: string }> = [
      { link: store('shared'), path: 'shared/x.md' },
      { link: store('members'), path: 'members/alice/x.md' },
      { link: store('members', 'alice'), path: 'members/alice/x.md' },
      { link: store('shared', 'sub'), path: 'shared/sub/x.md' }
    ]
    for (const { link, path } of levels) {
      rmSync(join(dir, ROOM), { recursive: true, force: true })
      mkdirSync(join(link, '..'), { recursive: true })
      symlinkSync(outside, link)
      expect(await failure(docs.get(ROOM, plugin, path)), path).toEqual(NOT_FOUND)
      expect(await failure(docs.put(ROOM, plugin, path, 'in')), path).toEqual(NOT_FOUND)
      expect(await docs.list(ROOM, plugin)).toEqual([])
    }
    rmSync(join(dir, ROOM), { recursive: true, force: true })
    mkdirSync(join(dir, ROOM), { recursive: true })
    symlinkSync(outside, store())
    expect(await failure(docs.put(ROOM, plugin, 'shared/x.md', 'in'))).toEqual(NOT_FOUND)
    rmSync(join(dir, ROOM), { recursive: true, force: true })
    symlinkSync(outside, join(dir, ROOM))
    expect(await failure(docs.put(ROOM, plugin, 'shared/x.md', 'in'))).toEqual(NOT_FOUND)
    expect(readFileSync(join(outside, 'x.md'), 'utf8')).toBe('outside')
    // The room log refuses a linked room folder too, so nothing at all landed outside.
    expect(readdirSync(outside)).toEqual(['x.md'])
  })

  it('refuses an ancestor swapped for a link after the walk, creating nothing outside', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    await docs.put(ROOM, plugin, 'shared/sub/seed.md', 'seed')
    // The temp-name callback runs between the walk and the open: swap the folder there.
    docs = new RoomDocs({
      dir,
      logOf: (id) => new RoomLog(logPath(id)),
      log: (m) => warnings.push(m),
      random: () => {
        renameSync(store('shared', 'sub'), store('shared', 'sub-moved'))
        symlinkSync(outside, store('shared', 'sub'))
        return Buffer.from('abcdef', 'hex')
      }
    })
    expect(await failure(docs.put(ROOM, plugin, 'shared/sub/x.md', 'in'))).toEqual(NOT_FOUND)
    expect(readdirSync(outside)).toEqual([])
  })

  it('answers not-found for a list of a bad room id', async () => {
    expect((await failure(docs.list('../x', plugin)))?.code).toBe('not-found')
  })

  it('refuses a folder where a doc goes and a doc where a folder goes', async () => {
    mkdirSync(store('shared', 'dir.md'), { recursive: true })
    expect(await failure(docs.get(ROOM, plugin, 'shared/dir.md'))).toEqual(NOT_FOUND)
    expect(await failure(docs.put(ROOM, plugin, 'shared/dir.md', 'x'))).toEqual(NOT_FOUND)
    await docs.put(ROOM, plugin, 'shared/file', 'x')
    expect(await failure(docs.put(ROOM, plugin, 'shared/file/below', 'x'))).toEqual(NOT_FOUND)
  })

  it('makes its folders 0700 and its files 0600, leaving no temp file', async () => {
    await docs.put(ROOM, plugin, 'shared/a/b.md', 'x')
    const { statSync } = await import('node:fs')
    expect(statSync(store('shared', 'a')).mode & 0o777).toBe(0o700)
    expect(statSync(store('shared', 'a', 'b.md')).mode & 0o777).toBe(0o600)
    expect(readdirSync(store('shared', 'a'))).toEqual(['b.md'])
  })
})

describe('RoomDocs limits and text', () => {
  it('takes a doc of exactly the cap and refuses one byte more', async () => {
    await docs.put(ROOM, plugin, 'shared/max.md', 'a'.repeat(MAX_DOC_BYTES))
    expect((await docs.get(ROOM, plugin, 'shared/max.md')).length).toBe(MAX_DOC_BYTES)
    expect((await failure(docs.put(ROOM, plugin, 'shared/big.md', 'a'.repeat(MAX_DOC_BYTES + 1))))?.code).toBe('limit')
    // Counted in UTF-8 bytes, not characters.
    expect((await failure(docs.put(ROOM, plugin, 'shared/big.md', 'é'.repeat(MAX_DOC_BYTES / 2 + 1))))?.code).toBe('limit')
  })

  it('refuses a doc on disk grown past the cap as missing', async () => {
    mkdirSync(store('shared'), { recursive: true })
    writeFileSync(store('shared', 'huge.md'), 'a'.repeat(MAX_DOC_BYTES + 1))
    expect(await failure(docs.get(ROOM, plugin, 'shared/huge.md'))).toEqual(NOT_FOUND)
  })

  it('keeps UTF-8 text whole and refuses what is not text', async () => {
    const text = 'héllo — 日本 🎉\nline two\r\n\tindented\r\n'
    await docs.put(ROOM, alice, 'members/alice/u.md', text)
    expect(await docs.get(ROOM, alice, 'members/alice/u.md')).toBe(text)
    // C0 controls other than tab, LF and CR are refused: ESC, BEL, a form feed each JSON-escape to six bytes, which
    // would let a doc under the cap outgrow a `ccc` reply line.
    for (const bad of ['lone \ud800 surrogate', 'trail \udc00 first', 'nul \0 byte', 'esc \x1b[2K', 'bell \x07', 'ff \f', 'del \x7f', 'c1 \u009b2K', 'rlo \u202e', 'isolate \u2066x\u2069', 'zwsp \u200b', 'lone cr \rx', 'ls \u2028', 'bom \ufeff mid', 'tags \u{e0068}\u{e0069}', 'shy \u00ad', 'mvs \u180e', 'ann \ufff9x\ufffb', 42, undefined]) {
      expect((await failure(docs.put(ROOM, plugin, 'shared/bad.md', bad)))?.code).toBe('invalid')
    }
    mkdirSync(store('shared'), { recursive: true })
    writeFileSync(store('shared', 'bin.md'), Buffer.from([0xff, 0xfe, 0x00, 0xc3]))
    expect(await failure(docs.get(ROOM, plugin, 'shared/bin.md'))).toEqual(NOT_FOUND)
  })

  it('keeps ZWNJ and ZWJ (words and emoji need them)', async () => {
    const text = 'می\u200cخواهم \u{1f468}\u200d\u{1f469}'
    await docs.put(ROOM, plugin, 'shared/zw.md', text)
    expect(await docs.get(ROOM, plugin, 'shared/zw.md')).toBe(text)
  })

  it('keeps a leading BOM and logs refusals for bad text and a too large doc', async () => {
    await docs.put(ROOM, plugin, 'shared/bom.md', '\ufeffhi')
    expect(await docs.get(ROOM, plugin, 'shared/bom.md')).toBe('\ufeffhi')
    await failure(docs.put(ROOM, plugin, 'shared/bad.md', 'nul \0'))
    await failure(docs.put(ROOM, plugin, 'shared/big.md', 'a'.repeat(MAX_DOC_BYTES + 1)))
    const reasons = logEntries().filter((e) => e.type === 'doc-refused').map((e) => e.reason)
    expect(reasons).toEqual(['bad text', 'too large'])
  })

  it('a put still queued when the room is deleted (its folder removed) makes no folder again', async () => {
    let deleted = false
    // As the registry's logOf: a deleted room has no log (a RoomLog would make the folder again for its line).
    const gated = new RoomDocs({
      dir,
      logOf: (id) => {
        if (deleted) throw new Error('no such room')
        return new RoomLog(logPath(id))
      },
      log: (m) => warnings.push(m)
    })
    await gated.put(ROOM, plugin, 'shared/a.md', 'a')
    const first = gated.put(ROOM, plugin, 'shared/b.md', 'b')
    const queued = gated.put(ROOM, plugin, 'members/alice/c.md', 'c')
    // The registry's delete: the whole folder, synchronously, while both puts wait in the room's chain.
    rmSync(join(dir, ROOM), { recursive: true, force: true })
    deleted = true
    expect(await failure(first)).toEqual(NOT_FOUND)
    expect(await failure(queued)).toEqual(NOT_FOUND)
    expect(existsSync(join(dir, ROOM))).toBe(false)
  })

  it("a person's reads of one doc are logged at most once a minute; a member's every time", async () => {
    let now = 1_000_000
    const timed = new RoomDocs({ dir, logOf: (id) => new RoomLog(logPath(id)), log: (m) => warnings.push(m), now: () => now })
    await timed.put(ROOM, plugin, 'shared/a.md', 'a')
    const reads = (by: string): number => logEntries().filter((e) => e.type === 'doc-read' && e.by === by).length
    for (let i = 0; i < 3; i++) await timed.get(ROOM, 'person', 'shared/a.md')
    expect(reads('person')).toBe(1)
    await timed.get(ROOM, 'person', 'members/alice/none.md').catch(() => {})
    now += PERSON_READ_LOG_MS
    await timed.get(ROOM, 'person', 'shared/a.md')
    expect(reads('person')).toBe(2)
    for (let i = 0; i < 3; i++) await timed.get(ROOM, alice, 'shared/a.md')
    expect(reads('alice')).toBe(3)
  })

  it('caps the files and folders in a room, still allowing a replace', async () => {
    mkdirSync(store('shared', 'fill'), { recursive: true })
    for (let i = 0; i < MAX_ROOM_DOC_ENTRIES - 1; i++) writeFileSync(store('shared', 'fill', `f${i}.md`), '')
    expect((await failure(docs.put(ROOM, plugin, 'shared/new.md', 'x')))?.code).toBe('limit')
    expect(existsSync(store('shared', 'new.md'))).toBe(false)
    await docs.put(ROOM, plugin, 'shared/fill/f0.md', 'replaced')
  })

  it('counts the folders a put makes against the entry cap, not the new file alone', async () => {
    // shared + fill + MAX - 4 files: MAX - 2 entries, room for a doc in one new folder and nothing deeper.
    mkdirSync(store('shared', 'fill'), { recursive: true })
    for (let i = 0; i < MAX_ROOM_DOC_ENTRIES - 4; i++) writeFileSync(store('shared', 'fill', `f${i}.md`), '')
    // Two folders and the file: one past the cap, refused before anything is made.
    expect((await failure(docs.put(ROOM, plugin, 'shared/b/c/new.md', 'x')))?.code).toBe('limit')
    expect(existsSync(store('shared', 'b'))).toBe(false)
    // A member's first doc makes members/ and members/<name>/ too: three entries, refused alike.
    expect((await failure(docs.put(ROOM, plugin, 'members/bob/new.md', 'x')))?.code).toBe('limit')
    expect(existsSync(store('members'))).toBe(false)
    // One folder and the file: exactly the cap.
    await docs.put(ROOM, plugin, 'shared/a/new.md', 'x')
    expect(existsSync(store('shared', 'a', 'new.md'))).toBe(true)
  })

  it('removes temp files a killed write left behind, so they stop counting', async () => {
    mkdirSync(store('shared'), { recursive: true })
    writeFileSync(store('shared', 'a.md.tmp-abcdef123456'), 'x'.repeat(1000))
    await docs.put(ROOM, plugin, 'shared/b.md', 'b')
    expect(readdirSync(store('shared'))).toEqual(['b.md'])
  })

  // A folder the process cannot write to (skipped as root, which ignores modes).
  it.skipIf(process.getuid?.() === 0)('answers an fs failure with words that name no path', async () => {
    mkdirSync(store('shared'), { recursive: true })
    chmodSync(store('shared'), 0o500)
    let err: unknown
    try {
      err = await failure(docs.put(ROOM, plugin, 'shared/x.md', 'x'))
    } finally {
      chmodSync(store('shared'), 0o700)
    }
    expect(err).toEqual({ code: 'error', message: 'could not write the doc' })
    expect(warnings.some((w) => w.includes('failed'))).toBe(true)
  })

  it('checks the text only after access, so a refused caller learns only "no such doc"', async () => {
    expect(await failure(docs.put(ROOM, alice, 'shared/x.md', 'a'.repeat(MAX_DOC_BYTES + 1)))).toEqual(NOT_FOUND)
    expect(await failure(docs.put(ROOM, alice, 'shared/x.md', 'nul \0'))).toEqual(NOT_FOUND)
  })

  it('refuses a write that would put the room over its total, counting a replaced doc once', async () => {
    const chunk = 'a'.repeat(MAX_DOC_BYTES)
    const fit = SMALL_ROOM_BYTES / MAX_DOC_BYTES
    docs = smallRoomDocs()
    // Seeded on disk directly (writing them through put is the same code path, only slower).
    mkdirSync(store('shared', 'fill'), { recursive: true })
    for (let i = 0; i < fit; i++) writeFileSync(store('shared', 'fill', `f${i}.md`), chunk)
    expect((await failure(docs.put(ROOM, plugin, 'shared/one-more.md', 'x')))?.code).toBe('limit')
    expect((await failure(docs.put(ROOM, lead, 'shared/one-more.md', 'x')))?.code).toBe('limit')
    // Replacing a doc with one of the same size fits.
    await docs.put(ROOM, plugin, 'shared/fill/f0.md', 'b'.repeat(MAX_DOC_BYTES))
    await docs.put(ROOM, plugin, 'shared/fill/f1.md', 'small')
    await docs.put(ROOM, plugin, 'shared/one-more.md', 'x')
    expect(logEntries().some((e) => e.type === 'doc-refused' && e.reason === 'limit')).toBe(true)
  })
})

describe('RoomDocs concurrent writes', () => {
  it('serializes writes to a room in call order: the last call wins', async () => {
    const writes = Array.from({ length: 20 }, (_, i) => docs.put(ROOM, plugin, 'shared/race.md', `v${i}`))
    await Promise.all(writes)
    expect(await docs.get(ROOM, plugin, 'shared/race.md')).toBe('v19')
    const order = logEntries()
      .filter((e) => e.type === 'doc-write')
      .map((e) => e.bytes)
    expect(order).toHaveLength(20)
    expect(readdirSync(store('shared'))).toEqual(['race.md'])
  })

  it('a failed write does not stop the ones after it', async () => {
    const a = docs.put(ROOM, plugin, 'shared/a.md', 'a')
    // A write that fails inside the chain (a folder where the doc goes), unlike an oversized doc refused up front.
    mkdirSync(store('shared', 'fill'), { recursive: true })
    const bad = failure(docs.put(ROOM, plugin, 'shared/fill', 'a folder is there'))
    const c = docs.put(ROOM, plugin, 'shared/c.md', 'c')
    await a
    expect(await bad).toEqual(NOT_FOUND)
    await c
    expect(await docs.get(ROOM, plugin, 'shared/c.md')).toBe('c')
  })

  it('holds the room total across writes in flight together', async () => {
    const chunk = 'a'.repeat(MAX_DOC_BYTES)
    const fit = SMALL_ROOM_BYTES / MAX_DOC_BYTES
    docs = smallRoomDocs()
    mkdirSync(store('shared', 'fill'), { recursive: true })
    for (let i = 0; i < fit - 1; i++) writeFileSync(store('shared', 'fill', `f${i}.md`), chunk)
    const results = await Promise.all([
      failure(docs.put(ROOM, plugin, 'shared/x.md', chunk)),
      failure(docs.put(ROOM, plugin, 'shared/y.md', chunk))
    ])
    expect(results.filter((r) => r === undefined)).toHaveLength(1)
    expect(results.filter((r) => r?.code === 'limit')).toHaveLength(1)
  })
})

describe('RoomDocs append', () => {
  it('makes a missing doc, then adds to its end exactly (no newline added or taken)', async () => {
    await docs.append(ROOM, alice, 'members/alice/log.md', 'one')
    expect(await docs.get(ROOM, alice, 'members/alice/log.md')).toBe('one')
    await docs.append(ROOM, alice, 'members/alice/log.md', '\ntwo\n')
    await docs.append(ROOM, alice, 'members/alice/log.md', 'three\r\n')
    expect(await docs.get(ROOM, alice, 'members/alice/log.md')).toBe('one\ntwo\nthree\r\n')
    expect(readdirSync(store('members', 'alice'))).toEqual(['log.md'])
  })

  it('many appends in flight together all land, whole and in call order', async () => {
    await docs.put(ROOM, lead, 'shared/verify.md', '# verify\n')
    const lines = Array.from({ length: 30 }, (_, i) => `- item ${i} ${'x'.repeat(i * 50)}\n`)
    await Promise.all(lines.map((line, i) => docs.append(ROOM, i % 2 === 0 ? lead : plugin, 'shared/verify.md', line)))
    expect(await docs.get(ROOM, alice, 'shared/verify.md')).toBe(`# verify\n${lines.join('')}`)
  })

  it('a put and appends in one chain keep call order: the put replaces what came before it', async () => {
    const a = docs.append(ROOM, plugin, 'shared/x.md', 'a')
    const p = docs.put(ROOM, plugin, 'shared/x.md', 'P')
    const b = docs.append(ROOM, plugin, 'shared/x.md', 'b')
    await Promise.all([a, p, b])
    expect(await docs.get(ROOM, plugin, 'shared/x.md')).toBe('Pb')
  })

  it('has the access rule of a put: a refused caller gets "no such doc" and writes nothing', async () => {
    await docs.put(ROOM, plugin, 'members/alice/n.md', 'mine')
    await docs.put(ROOM, plugin, 'shared/brief.md', 'brief')
    expect(await failure(docs.append(ROOM, bob, 'members/alice/n.md', 'x'))).toEqual(NOT_FOUND)
    expect(await failure(docs.append(ROOM, lead, 'members/alice/n.md', 'x'))).toEqual(NOT_FOUND)
    expect(await failure(docs.append(ROOM, alice, 'shared/brief.md', 'x'))).toEqual(NOT_FOUND)
    expect(await failure(docs.append(ROOM, 'person', 'shared/brief.md', 'x'))).toEqual(NOT_FOUND)
    // Access before text: a refused caller with bad or oversized text still learns only "no such doc".
    expect(await failure(docs.append(ROOM, bob, 'members/alice/n.md', '\u0007'))).toEqual(NOT_FOUND)
    expect(await failure(docs.append(ROOM, bob, 'members/alice/n.md', 'a'.repeat(MAX_DOC_BYTES + 1)))).toEqual(NOT_FOUND)
    expect(await docs.get(ROOM, plugin, 'members/alice/n.md')).toBe('mine')
    expect(await docs.get(ROOM, plugin, 'shared/brief.md')).toBe('brief')
    expect(logEntries()).toContainEqual(expect.objectContaining({ type: 'doc-refused', by: 'bob', path: 'members/alice/n.md', op: 'append', reason: 'not allowed' }))
  })

  it('caps the doc after the append, leaving it unchanged when over', async () => {
    await docs.put(ROOM, plugin, 'shared/full.md', 'a'.repeat(MAX_DOC_BYTES - 2))
    await docs.append(ROOM, plugin, 'shared/full.md', 'bb')
    expect((await docs.get(ROOM, plugin, 'shared/full.md')).length).toBe(MAX_DOC_BYTES)
    const over = await failure(docs.append(ROOM, plugin, 'shared/full.md', 'c'))
    expect(over?.code).toBe('limit')
    expect(over?.message).toContain('after the append')
    expect(await docs.get(ROOM, plugin, 'shared/full.md')).toBe(`${'a'.repeat(MAX_DOC_BYTES - 2)}bb`)
    // A piece over the cap alone is refused before the chain, as a put's is.
    expect((await failure(docs.append(ROOM, plugin, 'shared/new.md', 'a'.repeat(MAX_DOC_BYTES + 1))))?.code).toBe('limit')
    expect(existsSync(store('shared', 'new.md'))).toBe(false)
    expect(readdirSync(store('shared')).sort()).toEqual(['full.md'])
  })

  it('checks the text of the piece and of the doc it makes: a BOM is fine at the start only', async () => {
    expect((await failure(docs.append(ROOM, plugin, 'shared/t.md', 'a\u001b[31m')))?.code).toBe('invalid')
    expect((await failure(docs.append(ROOM, plugin, 'shared/t.md', 'lone\r')))?.code).toBe('invalid')
    await docs.append(ROOM, plugin, 'shared/t.md', '﻿start')
    // Valid as a text of its own (a leading BOM), not in the middle of the doc.
    expect((await failure(docs.append(ROOM, plugin, 'shared/t.md', '﻿more')))?.code).toBe('invalid')
    expect(await docs.get(ROOM, plugin, 'shared/t.md')).toBe('﻿start')
    expect(logEntries()).toContainEqual(expect.objectContaining({ type: 'doc-refused', path: 'shared/t.md', op: 'append', reason: 'bad text' }))
  })

  it('refuses a doc that is a link or a folder, without touching the target', async () => {
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'secret')
    mkdirSync(store('shared', 'dir.md'), { recursive: true })
    symlinkSync(outside, store('shared', 'link.md'))
    expect(await failure(docs.append(ROOM, plugin, 'shared/link.md', 'more'))).toEqual(NOT_FOUND)
    expect(await failure(docs.append(ROOM, plugin, 'shared/dir.md', 'more'))).toEqual(NOT_FOUND)
    expect(readFileSync(outside, 'utf8')).toBe('secret')
  })

  it('refuses a doc on disk that is not UTF-8 or grew past the cap, as missing', async () => {
    mkdirSync(store('shared'), { recursive: true })
    writeFileSync(store('shared', 'bin.md'), Buffer.from([0x63, 0xe9]))
    writeFileSync(store('shared', 'huge.md'), 'a'.repeat(MAX_DOC_BYTES + 1))
    expect(await failure(docs.append(ROOM, plugin, 'shared/bin.md', 'x'))).toEqual(NOT_FOUND)
    expect(await failure(docs.append(ROOM, plugin, 'shared/huge.md', 'x'))).toEqual(NOT_FOUND)
  })

  it('logs a doc-write with op append, the doc size and the bytes added; a put logs as before', async () => {
    await docs.put(ROOM, plugin, 'shared/l.md', 'abc')
    await docs.append(ROOM, plugin, 'shared/l.md', 'de')
    const writes = logEntries()
      .filter((e) => e.type === 'doc-write')
      .map((entry) => {
        const rest: Record<string, unknown> = { ...entry }
        delete rest.at
        delete rest.seq
        return rest
      })
    expect(writes).toEqual([
      { type: 'doc-write', by: 'plugin', path: 'shared/l.md', bytes: 3 },
      { type: 'doc-write', by: 'plugin', path: 'shared/l.md', bytes: 5, op: 'append', added: 2 }
    ])
  })

  it('counts against the room total by the size after the append', async () => {
    docs = smallRoomDocs()
    mkdirSync(store('shared', 'fill'), { recursive: true })
    for (let i = 0; i < SMALL_ROOM_BYTES / MAX_DOC_BYTES - 1; i++) writeFileSync(store('shared', 'fill', `f${i}.md`), 'a'.repeat(MAX_DOC_BYTES))
    await docs.put(ROOM, plugin, 'shared/x.md', 'a'.repeat(MAX_DOC_BYTES - 10))
    await docs.append(ROOM, plugin, 'shared/x.md', 'b'.repeat(10))
    expect((await failure(docs.append(ROOM, plugin, 'shared/y.md', 'c')))?.code).toBe('limit')
  })
})

describe('RoomDocs: a final newline round-trips exactly', () => {
  // The backlog's third point (a patch read back without its final newline failed `git apply`): the store keeps bytes.
  it.each([
    ['none', 'a'],
    ['LF', 'a\n'],
    ['two LF', 'a\n\n'],
    ['CRLF', 'a\r\n'],
    ['a patch', 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n']
  ])('put then get: %s', async (_name, text) => {
    await docs.put(ROOM, plugin, 'shared/p.md', text)
    expect(await docs.get(ROOM, alice, 'shared/p.md')).toBe(text)
    expect(readFileSync(store('shared', 'p.md'), 'utf8')).toBe(text)
  })
})
