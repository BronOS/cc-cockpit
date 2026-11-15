// `ccc room ...` (rooms Task 9, design-rooms.md §4): the requests each command sends, what it prints, the two-step read
// (print, then ack on the same connection), the bounded stdin of `send -` and `doc put`, and the real SocketServer with
// the room handlers answering the real client. Real Unix sockets in a temp dir under /tmp (macOS's /var/folders pushes a
// socket path past sun_path), a plain `net` fake app where a test controls each reply.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { run, STDIN_READ_TIMEOUT_MS, type Output } from '../../src/cli/client'
import type { RoomTabCaller } from '../../src/main/rooms/room-service'
import { registerRoomHandlers, type RoomCliService } from '../../src/main/socket/handlers'
import { SocketServer } from '../../src/main/socket/socket-server'
import { CLI_TIMEOUT_CODE, MAX_CLI_IO_BYTES } from '../../src/shared/plugin-cli'
import { LineFramer, MAX_LINE_BYTES, parseRequest, ROOM_READ_ACK_COMMAND, type Request } from '../../src/shared/protocol'
import { pointerText } from '../../src/shared/room-pointer'

const POSIX = process.platform !== 'win32'
const TOKEN = 'c'.repeat(64)

let root: string
let sock: string
let closers: (() => Promise<void> | void)[]

beforeEach(() => {
  root = mkdtempSync(join(POSIX ? '/tmp' : process.env.TEMP!, 'ccrm-'))
  sock = join(root, 's.sock')
  closers = []
})

afterEach(async () => {
  for (const close of closers) await close()
  rmSync(root, { recursive: true, force: true })
})

const env = (extra: Record<string, string> = {}): Record<string, string> => ({ APP_TAB_TOKEN: TOKEN, CC_COCKPIT_SOCK: sock, ...extra })
const stdinOf = (text: string): Readable => Readable.from([Buffer.from(text)])

function capture(): { out: Output; stdout: () => string; stderr: () => string } {
  let o = ''
  let e = ''
  return { out: { stdout: (t) => void (o += t), stderr: (t) => void (e += t) }, stdout: () => o, stderr: () => e }
}

const ok = (result: unknown, id = 1): string => `${JSON.stringify({ id, ok: true, result })}\n`
const fail = (error: string, id = 1): string => `${JSON.stringify({ id, ok: false, error })}\n`

/** A fake app: records each request line, answers request i with `answers[i]` (raw text), or never when undefined. */
function fakeApp(seen: Request[], answers: Array<string | undefined>): Promise<Server> {
  return new Promise((done) => {
    const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
      const framer = new LineFramer()
      let n = 0
      socket.on('error', () => {})
      socket.on('end', () => socket.end())
      socket.on('data', (chunk: Buffer) => {
        for (const line of framer.push(chunk)) {
          seen.push(parseRequest(line))
          const answer = answers[n++]
          if (answer !== undefined) socket.write(answer)
        }
      })
    })
    closers.push(() => new Promise<void>((r) => server.close(() => r())))
    server.listen(sock, () => done(server))
  })
}

/** Runs ccc with one fake-app answer and returns what it did. */
async function ccc(argv: string[], answer: string | undefined, stdin = stdinOf(''), environment = env()) {
  const seen: Request[] = []
  const server = await fakeApp(seen, [answer])
  const c = capture()
  const code = await run(argv, environment, stdin, c.out, root)
  // One fake app per call, on the same socket path: closed (and unregistered) before the next one listens.
  await new Promise<void>((r) => server.close(() => r()))
  closers.pop()
  return { code, seen, stdout: c.stdout(), stderr: c.stderr() }
}

const STATUS = {
  room: { title: 'Review', paused: true },
  name: 'alice',
  coordinator: true,
  held: 2,
  members: [
    { name: 'alice', coordinator: true, status: 'waiting', held: 2, you: true },
    { name: 'bob', coordinator: false, status: 'working', held: 0 },
    { name: 'cy', coordinator: false, status: 'no-tab', held: 3 }
  ]
}

describe('ccc room: one request per command, from the token alone', () => {
  it('status asks room.status with no args and prints the room, the caller and the members', async () => {
    const r = await ccc(['room'], ok(STATUS))
    expect(r.code).toBe(0)
    expect(r.seen).toEqual([{ v: 1, id: 1, token: TOKEN, cmd: 'room.status', args: {} }])
    expect(r.stdout).toBe(
      [
        'room "Review" (paused)',
        'you: alice (coordinator), 2 message(s) held for you',
        'members:',
        '  alice (coordinator, you): waiting, 2 held',
        '  bob: working',
        '  cy: no-tab, 3 held',
        ''
      ].join('\n')
    )
  })

  it('status --json prints main\'s answer as JSON, and not in a room says so', async () => {
    const json = await ccc(['room', 'status', '--json'], ok(STATUS))
    expect(JSON.parse(json.stdout)).toEqual(STATUS)
    expect((await ccc(['room', '--json'], ok(STATUS))).seen[0]?.cmd).toBe('room.status')
    const none = await ccc(['room', 'status'], ok({ room: null }))
    expect(none.stdout).toBe('not in a room\n')
  })

  it('join sends the invite and prints the title, the name and the role', async () => {
    const r = await ccc(['room', 'join', 'ABCD234'], ok({ title: 'Review', name: 'bob', coordinator: false }))
    expect(r.seen).toEqual([{ v: 1, id: 1, token: TOKEN, cmd: 'room.join', args: { invite: 'ABCD234' } }])
    expect(r.stdout).toBe('joined room "Review" as bob\n')
  })

  it('leave asks room.leave', async () => {
    const r = await ccc(['room', 'leave'], ok({ title: 'Review', name: 'bob' }))
    expect(r.seen[0]).toMatchObject({ cmd: 'room.leave', args: {} })
    expect(r.stdout).toBe('left room "Review"\n')
  })

  it('send puts the words in one text and prints one line per recipient', async () => {
    const answer = ok({
      delivery: [
        { to: 'bob', path: 'delivered' },
        { to: 'cy', path: 'held', why: 'typed' },
        { to: 'dee', path: 'gone' },
        { to: 'eve', path: 'refused', why: 'a member may have at most 100 messages waiting' }
      ]
    })
    const r = await ccc(['room', 'send', 'all', 'build', 'is', 'green'], answer)
    expect(r.seen[0]).toMatchObject({ cmd: 'room.send', args: { to: 'all', text: 'build is green' } })
    expect(r.stdout).toBe(
      [
        'bob: delivered',
        'cy: held (the person is typing in its tab); it reads the message with ccc room read',
        'dee: gone (no member by that name; nothing sent)',
        'eve: refused (a member may have at most 100 messages waiting)',
        ''
      ].join('\n')
    )
  })

  it('send to all with nobody else in the room says so', async () => {
    const r = await ccc(['room', 'send', 'all', 'hello'], ok({ delivery: [] }))
    expect(r.stdout).toBe('nobody else is in the room; nothing sent\n')
  })

  it('doc ls prints path and size, doc get prints the doc exactly, doc put prints what it saved', async () => {
    const ls = await ccc(['room', 'doc', 'ls'], ok({ docs: [{ path: 'shared/brief.md', size: 12 }] }))
    expect(ls.seen[0]).toMatchObject({ cmd: 'room.doc.ls', args: {} })
    expect(ls.stdout).toBe('shared/brief.md\t12\n')
    const empty = await ccc(['room', 'doc', 'ls'], ok({ docs: [] }))
    expect(empty.stdout).toBe('no docs\n')
    const get = await ccc(['room', 'doc', 'get', 'shared/brief.md'], ok({ text: 'line one\n  line two' }))
    expect(get.seen[0]).toMatchObject({ cmd: 'room.doc.get', args: { path: 'shared/brief.md' } })
    expect(get.stdout).toBe('line one\n  line two')
    const put = await ccc(['room', 'doc', 'put', 'shared/x.md', '-'], ok(null), stdinOf('exact\n\n'))
    expect(put.seen[0]).toMatchObject({ cmd: 'room.doc.put', args: { path: 'shared/x.md', text: 'exact\n\n' } })
    expect(put.stdout).toBe('saved shared/x.md\n')
  })

  it('prints main\'s refusal on stderr with exit 1', async () => {
    const r = await ccc(['room', 'leave'], fail('this tab is in no room'))
    expect(r.code).toBe(1)
    expect(r.stderr).toBe('ccc: this tab is in no room\n')
    expect(r.stdout).toBe('')
  })

  it('flattens control characters a room title or a name carries, so no escape sequence reaches the terminal', async () => {
    const r = await ccc(['room'], ok({ ...STATUS, room: { title: 'a\u001b[31mred', paused: false } }))
    expect(r.stdout).toContain('room "a [31mred"')
    expect(r.stdout).not.toContain('\u001b')
  })

  it('is a silent exit 0 when the app is not running', async () => {
    const c = capture()
    expect(await run(['room', 'status'], env(), stdinOf(''), c.out, root)).toBe(0)
    expect(await run(['room', 'read'], env(), stdinOf(''), c.out, root)).toBe(0)
    expect(await run(['room', 'send', 'bob', '-'], env(), stdinOf('hi'), c.out, root)).toBe(0)
    expect(c.stdout() + c.stderr()).toBe('')
  })
})

describe('ccc room send - and doc put: stdin', () => {
  it('send - sends stdin as the text with one final newline removed', async () => {
    const r = await ccc(['room', 'send', 'bob', '-'], ok({ delivery: [{ to: 'bob', path: 'delivered' }] }), stdinOf('two\nlines\n'))
    expect(r.seen[0]).toMatchObject({ cmd: 'room.send', args: { to: 'bob', text: 'two\nlines' } })
  })

  it('send -- - sends a message that is literally a dash and reads no stdin', async () => {
    const r = await ccc(['room', 'send', 'bob', '--', '-'], ok({ delivery: [] }), new PassThrough())
    expect(r.seen[0]).toMatchObject({ args: { to: 'bob', text: '-' } })
  })

  it('an open pipe nobody closes is exit 124 after STDIN_READ_TIMEOUT_MS, with nothing sent', async () => {
    expect(STDIN_READ_TIMEOUT_MS).toBe(40_000)
    const seen: Request[] = []
    await fakeApp(seen, [ok(null)])
    const c = capture()
    const stdin = new PassThrough()
    const started = Date.now()
    const timers = vi
    timers.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pending = run(['room', 'doc', 'put', 'shared/x.md', '-'], env(), stdin, c.out, root)
      await timers.advanceTimersByTimeAsync(STDIN_READ_TIMEOUT_MS + 1)
      expect(await pending).toBe(CLI_TIMEOUT_CODE)
    } finally {
      timers.useRealTimers()
    }
    expect(Date.now() - started).toBeLessThan(5000)
    expect(c.stderr()).toContain('room doc put: stdin was not closed within 40 s')
    expect(seen).toEqual([])
  })

  it('a text over the stdin cap, or too big for a socket line once escaped, is exit 1 with nothing sent', async () => {
    const seen: Request[] = []
    await fakeApp(seen, [ok(null), ok(null)])
    const c = capture()
    expect(await run(['room', 'doc', 'put', 'shared/x.md', '-'], env(), stdinOf('a'.repeat(MAX_CLI_IO_BYTES + 1)), c.out, root)).toBe(1)
    expect(c.stderr()).toContain('stdin is over 256 KiB')
    // 200 KiB of control characters is under the raw cap but six times that as JSON: over MAX_LINE_BYTES.
    const c2 = capture()
    expect(await run(['room', 'doc', 'put', 'shared/x.md', '-'], env(), stdinOf('\u0001'.repeat(200 * 1024)), c2.out, root)).toBe(1)
    expect(c2.stderr()).toContain('stdin is over 256 KiB')
    expect(seen).toEqual([])
    expect(MAX_LINE_BYTES).toBeGreaterThan(MAX_CLI_IO_BYTES)
  })

  it('a doc is sent exactly: a text of 256 KiB with many line breaks still goes', async () => {
    const text = 'x\n'.repeat(MAX_CLI_IO_BYTES / 2)
    const r = await ccc(['room', 'doc', 'put', 'shared/big.md', '-'], ok(null), stdinOf(text))
    expect(r.code).toBe(0)
    expect(r.seen).toHaveLength(1)
    expect((r.seen[0] as Request).args.text).toBe(text)
  })

  it('a stdin that fails halfway sends nothing', async () => {
    const seen: Request[] = []
    await fakeApp(seen, [ok(null)])
    const c = capture()
    const stdin = new PassThrough()
    const pending = run(['room', 'send', 'bob', '-'], env(), stdin, c.out, root)
    stdin.write('part')
    stdin.destroy(new Error('EIO'))
    expect(await pending).toBe(1)
    expect(c.stderr()).toContain('reading stdin failed')
    expect(seen).toEqual([])
  })
})

describe('ccc room read: print, then ack on the same connection', () => {
  const BATCH = '[cockpit room "Review" abc] from bob (a room member, not the person):\n| hi\n[end abc]'

  it('prints the text, then sends room.read.ack with the reply\'s ack and reads the answer', async () => {
    const seen: Request[] = []
    await fakeApp(seen, [ok({ count: 1, more: 0, text: BATCH, ack: 'm-1' }), ok({ acked: 1 }, 2)])
    const c = capture()
    expect(await run(['room', 'read'], env(), stdinOf(''), c.out, root)).toBe(0)
    expect(c.stdout()).toBe(`${BATCH}\n`)
    expect(c.stderr()).toBe('')
    expect(seen).toEqual([
      { v: 1, id: 1, token: TOKEN, cmd: 'room.read', args: {} },
      { v: 1, id: 2, token: TOKEN, cmd: ROOM_READ_ACK_COMMAND, args: { ack: 'm-1' } }
    ])
  })

  it('prints the text as main sent it: its lines and escapes are not flattened', async () => {
    const text = `${BATCH}\n| \\u{1b}[31m\n${pointerText(3)}`
    const seen: Request[] = []
    await fakeApp(seen, [ok({ count: 1, more: 3, text, ack: 'm-9' }), ok({ acked: 1 }, 2)])
    const c = capture()
    await run(['room', 'read'], env(), stdinOf(''), c.out, root)
    expect(c.stdout()).toBe(`${text}\n`)
  })

  it('an empty read prints a line and sends no ack', async () => {
    const seen: Request[] = []
    await fakeApp(seen, [ok({ count: 0, more: 0, text: '' }), ok({ acked: 0 }, 2)])
    const c = capture()
    expect(await run(['room', 'read'], env(), stdinOf(''), c.out, root)).toBe(0)
    expect(c.stdout()).toBe('no room messages waiting\n')
    expect(seen).toHaveLength(1)
  })

  it('prints before it acks: the text is out when the ack request arrives', async () => {
    let printedAtAck: string | undefined
    const c = capture()
    const seen: Request[] = []
    await new Promise<void>((done) => {
      const server = createServer({ allowHalfOpen: true }, (socket) => {
        const framer = new LineFramer()
        socket.on('error', () => {})
        socket.on('end', () => socket.end())
        socket.on('data', (chunk: Buffer) => {
          for (const line of framer.push(chunk)) {
            const request = parseRequest(line)
            seen.push(request)
            if (request.cmd === 'room.read') socket.write(ok({ count: 1, more: 0, text: BATCH, ack: 'm-1' }))
            else {
              printedAtAck = c.stdout()
              socket.write(ok({ acked: 1 }, 2))
            }
          }
        })
      })
      closers.push(() => new Promise<void>((r) => server.close(() => r())))
      server.listen(sock, () => done())
    })
    await run(['room', 'read'], env(), stdinOf(''), c.out, root)
    expect(printedAtAck).toBe(`${BATCH}\n`)
  })

  it('a refused ack is a warning, not a failure: the text was printed and may show again', async () => {
    const seen: Request[] = []
    await fakeApp(seen, [ok({ count: 1, more: 0, text: BATCH, ack: 'm-1' }), fail('this tab is in no room', 2)])
    const c = capture()
    expect(await run(['room', 'read'], env(), stdinOf(''), c.out, root)).toBe(0)
    expect(c.stdout()).toBe(`${BATCH}\n`)
    expect(c.stderr()).toContain('could not confirm the read')
  })

  it('a connection closed before the ack answer is the same warning', async () => {
    await new Promise<void>((done) => {
      const server = createServer((socket) => {
        const framer = new LineFramer()
        socket.on('error', () => {})
        socket.on('data', (chunk: Buffer) => {
          for (const line of framer.push(chunk)) {
            if (parseRequest(line).cmd === 'room.read') socket.write(ok({ count: 1, more: 0, text: BATCH, ack: 'm-1' }))
            else socket.destroy()
          }
        })
      })
      closers.push(() => new Promise<void>((r) => server.close(() => r())))
      server.listen(sock, () => done())
    })
    const c = capture()
    expect(await run(['room', 'read'], env(), stdinOf(''), c.out, root)).toBe(0)
    expect(c.stdout()).toBe(`${BATCH}\n`)
    expect(c.stderr()).toContain('could not confirm the read')
  })

  it('a reply with no ack id prints the text, sends nothing more and warns', async () => {
    const seen: Request[] = []
    await fakeApp(seen, [ok({ count: 1, more: 0, text: BATCH })])
    const c = capture()
    expect(await run(['room', 'read'], env(), stdinOf(''), c.out, root)).toBe(0)
    expect(seen).toHaveLength(1)
    expect(c.stderr()).toContain('no ack')
  })

  it('main\'s refusal, an answer of the wrong shape and a connection closed with no reply are exit 1 and print nothing', async () => {
    const refused = await ccc(['room', 'read'], fail('ccc room needs a Claude tab (run it inside a cockpit Claude tab)'))
    expect(refused.code).toBe(1)
    expect(refused.stdout).toBe('')
    expect(refused.stderr).toContain('needs a Claude tab')
    const odd = await ccc(['room', 'read'], ok({ text: 5 }))
    expect(odd.code).toBe(1)
    expect(odd.stdout).toBe('')
    expect(odd.stderr).toContain('does not understand')
  })

  it('does not wait forever for a main that never answers', async () => {
    const seen: Request[] = []
    await fakeApp(seen, [undefined])
    const c = capture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pending = run(['room', 'read'], env(), stdinOf(''), c.out, root)
      // The request is out (and the wait for its answer has started) once the app has seen it.
      while (seen.length === 0) await new Promise<void>((r) => setImmediate(r))
      await vi.advanceTimersByTimeAsync(10_001)
      expect(await pending).toBe(1)
    } finally {
      vi.useRealTimers()
    }
    expect(c.stderr()).toBe('ccc: the app did not answer\n')
  })
})

type C = RoomTabCaller

describe('ccc room against the real SocketServer and the room handlers', () => {
  function rooms(calls: Array<[string, ...unknown[]]>): RoomCliService {
    return {
      status: (caller: C) => (calls.push(['status', caller]), { room: null }),
      join: (caller: C, invite: unknown) => (calls.push(['join', caller, invite]), { title: 'T', name: 'bob', coordinator: false }),
      leave: (caller: C) => (calls.push(['leave', caller]), { title: 'T', name: 'bob' }),
      send: (caller: C, to: unknown, text: unknown) => (calls.push(['send', caller, to, text]), [{ to: 'bob', path: 'delivered' }]),
      read: (caller: C) => (calls.push(['read', caller]), { count: 1, more: 0, text: 'fenced', ack: 'm-1' }),
      readAck: (caller: C, ack: unknown) => (calls.push(['readAck', caller, ack]), { acked: 1 }),
      docList: async (caller: C) => (calls.push(['docList', caller]), [{ path: 'shared/a.md', size: 3 }]),
      docGet: async (caller: C, path: unknown) => (calls.push(['docGet', caller, path]), 'doc text'),
      docPut: async (caller: C, path: unknown, text: unknown) => void calls.push(['docPut', caller, path, text])
    } as unknown as RoomCliService
  }

  async function app(calls: Array<[string, ...unknown[]]>): Promise<void> {
    const server = new SocketServer({
      path: sock,
      resolveToken: (token) => (token === TOKEN ? { kind: 'session', tabId: 'tab-1', projectId: 'p1' } : token === 'w'.repeat(64) ? { kind: 'window', projectId: 'p1' } : undefined),
      resolveProject: (path) => ({ path, projectId: 'p1' }),
      log: () => {},
      probeTimeoutMs: 200
    })
    registerRoomHandlers(server, rooms(calls))
    expect(await server.start()).toBe(true)
    closers.push(() => server.stop())
  }

  it('every command reaches its handler with the token\'s tab and project, and a read is acked on its connection', async () => {
    const calls: Array<[string, ...unknown[]]> = []
    await app(calls)
    const caller = { tabId: 'tab-1', projectId: 'p1' }
    const go = async (argv: string[], stdin = stdinOf('')): Promise<{ code: number; stdout: string; stderr: string }> => {
      const c = capture()
      const code = await run(argv, env(), stdin, c.out, root)
      return { code, stdout: c.stdout(), stderr: c.stderr() }
    }
    expect((await go(['room'])).stdout).toBe('not in a room\n')
    expect((await go(['room', 'join', 'INV'])).stdout).toBe('joined room "T" as bob\n')
    expect((await go(['room', 'send', 'bob', 'hi', 'there'])).stdout).toBe('bob: delivered\n')
    expect((await go(['room', 'read'])).stdout).toBe('fenced\n')
    expect((await go(['room', 'doc', 'ls'])).stdout).toBe('shared/a.md\t3\n')
    expect((await go(['room', 'doc', 'get', 'shared/a.md'])).stdout).toBe('doc text')
    expect((await go(['room', 'doc', 'put', 'members/bob/n.md', '-'], stdinOf('memo'))).stdout).toBe('saved members/bob/n.md\n')
    expect((await go(['room', 'leave'])).stdout).toBe('left room "T"\n')
    expect(calls).toEqual([
      ['status', caller],
      ['join', caller, 'INV'],
      ['send', caller, 'bob', 'hi there'],
      ['read', caller],
      ['readAck', caller, 'm-1'],
      ['docList', caller],
      ['docGet', caller, 'shared/a.md'],
      ['docPut', caller, 'members/bob/n.md', 'memo'],
      ['leave', caller]
    ])
  })

  it('a window token and no token at all are refused, exit 1, and reach no handler', async () => {
    const calls: Array<[string, ...unknown[]]> = []
    await app(calls)
    for (const environment of [env({ APP_TAB_TOKEN: 'w'.repeat(64) }), { CC_COCKPIT_SOCK: sock }]) {
      for (const argv of [['room'], ['room', 'read'], ['room', 'leave']]) {
        const c = capture()
        expect(await run(argv, environment, stdinOf(''), c.out, root), argv.join(' ')).toBe(1)
        expect(c.stdout()).toBe('')
        expect(c.stderr()).toMatch(/^ccc: /)
      }
    }
    expect(calls).toEqual([])
  })
})
