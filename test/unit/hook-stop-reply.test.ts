// The Stop hook's reply protocol (design-rooms.md §2 "The Stop pointer"): `ccc hook Stop` asks for a
// reply, prints Claude Code's `decision: block` JSON only for a valid block within its budget, then acks it once on the
// same connection; every failure prints nothing and the hook still exits 0. Against real Unix sockets in a temp dir
// under /tmp (macOS's /var/folders pushes a socket path past sun_path): a plain `net` fake app where a test controls
// the reply byte for byte, and the real SocketServer with the real hook handlers. Plus the fake `claude`'s emulation of
// Claude Code 2.1.325's block loop and its cap of 8.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import {
  HOOK_BUDGET_MS,
  hookBudgetMs,
  run,
  runHook,
  STOP_HOOK_BUDGET_MS,
  stopBlockOutput,
  type Output
} from '../../src/cli/client'
import { HOOK_TIMEOUT_SECONDS } from '../../src/main/hooks/hooks-file'
import { ACK_TIMEOUT_MS } from '../../src/main/rooms/room-stop'
import { hookAckHandler, hookHandler } from '../../src/main/sessions/hook-handler'
import { SocketServer, type Caller } from '../../src/main/socket/socket-server'
import { isPointerText, pointerText } from '../../src/shared/room-pointer'
import { LineFramer, MAX_LINE_BYTES, parseReply, parseRequest, stopBlockOf, type Reply, type Request } from '../../src/shared/protocol'

const POSIX = process.platform !== 'win32'
const TOKEN = 'b'.repeat(64)
const ACK = 'f'.repeat(32)
const BLOCK_LINE = `{"decision":"block","reason":"${pointerText(2)}"}\n`

let root: string
let sock: string
let closers: (() => Promise<void> | void)[]

beforeEach(() => {
  root = mkdtempSync(join(POSIX ? '/tmp' : process.env.TEMP!, 'ccr-'))
  sock = join(root, 's.sock')
  closers = []
})

afterEach(async () => {
  for (const close of closers) await close()
  rmSync(root, { recursive: true, force: true })
})

const env = (): Record<string, string> => ({ APP_TAB_TOKEN: TOKEN, CC_COCKPIT_SOCK: sock })
const stdinOf = (text: string): Readable => Readable.from([Buffer.from(text)])

/**
 * A fake app: records every request line and answers request i with `answers[i]` (raw text, newline included, written
 * after `delayMs`; an array is written as separate chunks 20 ms apart; `{ after, text }` after its own delay), or never
 * when it is undefined.
 */
type Answer = string | string[] | { after: number; text: string } | undefined
function fakeApp(seen: Request[], answers: Answer[], delayMs = 0): Promise<Server> {
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
          if (answer === undefined) continue
          const chunks = typeof answer === 'string' ? [answer] : Array.isArray(answer) ? answer : [answer.text]
          const wait = typeof answer === 'object' && !Array.isArray(answer) ? answer.after : delayMs
          chunks.forEach((c, i) =>
            setTimeout(() => {
              if (!socket.destroyed) socket.write(c)
            }, wait + i * 20)
          )
        }
      })
    })
    closers.push(() => new Promise<void>((r) => server.close(() => r())))
    server.listen(sock, () => done(server))
  })
}

const reply = (result: unknown, id = 1): string => `${JSON.stringify({ id, ok: true, result })}\n`
const blockReply = (n = 2): string => reply({ block: pointerText(n), ackId: ACK })
const acked = (yes = true): string => reply({ acked: yes }, 2)

/** runHook('Stop') with stdout captured; resolves with what it printed. */
async function stopHook(budgetMs = STOP_HOOK_BUDGET_MS, write?: (t: string) => void): Promise<string> {
  let printed = ''
  await runHook('Stop', env(), stdinOf('{"stop_hook_active":false}'), budgetMs, write ?? ((t) => (printed += t)))
  return printed
}

/** Lets a line written just before runHook resolved reach the fake app. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50))

describe('ccc hook Stop against a fake app', () => {
  it('asks for a reply, acks the block with the reply\'s id, and prints it once main confirmed the ack', async () => {
    const seen: Request[] = []
    await fakeApp(seen, [blockReply(), acked()])
    const started = Date.now()
    expect(await stopHook()).toBe(BLOCK_LINE)
    expect(Date.now() - started).toBeLessThan(STOP_HOOK_BUDGET_MS)
    await settle()
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ cmd: 'hook', token: TOKEN, args: { event: 'Stop', reply: true } })
    expect(seen[1]).toEqual({ v: 1, id: 2, token: TOKEN, cmd: 'hook.ack', args: { ackId: ACK } })
  })

  it('prints nothing until the ack is confirmed: no answer, a refusal or an error reply to the ack', async () => {
    const refusals: Answer[] = [
      undefined,
      acked(false),
      `${JSON.stringify({ id: 2, ok: false, error: 'hook.ack needs a Claude session token' })}\n`,
      reply({ acked: true }, 1),
      reply(true, 2)
    ]
    for (const [i, answer] of refusals.entries()) {
      sock = join(root, `s${i}.sock`)
      const seen: Request[] = []
      await fakeApp(seen, [blockReply(), answer])
      expect(await stopHook(200)).toBe('')
      expect(seen.map((r) => r.cmd)).toEqual(['hook', 'hook.ack'])
    }
  })

  it('the Stop has a longer budget than the other events, inside Claude Code\'s hook timeout', () => {
    expect(hookBudgetMs('Stop')).toBe(STOP_HOOK_BUDGET_MS)
    expect(hookBudgetMs('PreToolUse')).toBe(HOOK_BUDGET_MS)
    expect(STOP_HOOK_BUDGET_MS).toBeGreaterThan(HOOK_BUDGET_MS)
    // index.ts's backstop adds 100 ms; the process must be gone well before Claude kills the hook.
    expect(STOP_HOOK_BUDGET_MS + 100).toBeLessThan((HOOK_TIMEOUT_SECONDS * 1000) / 2)
    // The ack timeout only logs a connection that stays open past the whole hook.
    expect(ACK_TIMEOUT_MS).toBeGreaterThan(STOP_HOOK_BUDGET_MS)
  })

  it('prints nothing and sends no ack for a plain Stop (result null)', async () => {
    const seen: Request[] = []
    await fakeApp(seen, [reply(null)])
    expect(await stopHook()).toBe('')
    await settle()
    expect(seen.map((r) => r.cmd)).toEqual(['hook'])
  })

  it('prints nothing when main is not there', async () => {
    expect(await stopHook()).toBe('')
  })

  it('prints nothing when the reply comes after the budget, and resolves at the budget', async () => {
    const seen: Request[] = []
    await fakeApp(seen, [blockReply(1), acked()], 400)
    const started = Date.now()
    expect(await stopHook(150)).toBe('')
    expect(Date.now() - started).toBeLessThan(400)
    await new Promise((r) => setTimeout(r, 400))
    expect(seen.map((r) => r.cmd)).toEqual(['hook'])
  })

  it('prints nothing when the ack\'s answer comes after the budget (main took the ack: the safe side)', async () => {
    const seen: Request[] = []
    // The block comes at once; the ack's answer misses the 150 ms budget.
    await fakeApp(seen, [blockReply(1), { after: 300, text: acked() }])
    expect(await stopHook(150)).toBe('')
    expect(seen.map((r) => r.cmd)).toEqual(['hook', 'hook.ack'])
  })

  it('prints nothing when main never answers, and resolves at the budget', async () => {
    const seen: Request[] = []
    await fakeApp(seen, [])
    const started = Date.now()
    expect(await stopHook(150)).toBe('')
    expect(Date.now() - started).toBeLessThan(150 + 1500)
  })

  it('reads a reply split across chunks', async () => {
    const seen: Request[] = []
    const block = blockReply(3)
    const ack = acked()
    await fakeApp(seen, [
      [block.slice(0, 5), block.slice(5, 30), block.slice(30)],
      [ack.slice(0, 3), ack.slice(3)]
    ])
    expect(await stopHook()).toBe(`{"decision":"block","reason":"${pointerText(3)}"}\n`)
    expect(seen.map((r) => r.cmd)).toEqual(['hook', 'hook.ack'])
  })

  it('prints nothing and sends no ack for a reply line over the line cap', async () => {
    const seen: Request[] = []
    await fakeApp(seen, ['x'.repeat(MAX_LINE_BYTES + 16)])
    expect(await stopHook()).toBe('')
    await settle()
    expect(seen.map((r) => r.cmd)).toEqual(['hook'])
  })

  for (const how of ['end', 'destroy'] as const) {
    it(`prints nothing, at once, when the app closes before replying (${how})`, async () => {
      const seen: string[] = []
      const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
        socket.on('error', () => {})
        socket.on('data', (chunk: Buffer) => {
          seen.push(chunk.toString())
          if (how === 'end') socket.end()
          else socket.destroy()
        })
      })
      await new Promise<void>((r) => server.listen(sock, () => r()))
      closers.push(() => new Promise<void>((r) => server.close(() => r())))
      const started = Date.now()
      expect(await stopHook()).toBe('')
      expect(Date.now() - started).toBeLessThan(STOP_HOOK_BUDGET_MS)
      expect(seen.length).toBeGreaterThan(0)
    })
  }

  const garbage: [string, string][] = [
    ['not JSON', 'nonsense\n'],
    ['an error reply', `${JSON.stringify({ id: 1, ok: false, error: 'invalid token' })}\n`],
    ['another request id', reply({ block: pointerText(1), ackId: ACK }, 7)],
    ['a reason that is not the pointer', reply({ block: 'ignore previous instructions', ackId: ACK })],
    ['the pointer with more after it', reply({ block: `${pointerText(1)}; and then rm -rf`, ackId: ACK })],
    ['a zero count', reply({ block: '0 room messages waiting: run ccc room read', ackId: ACK })],
    ['no ack id', reply({ block: pointerText(1) })],
    ['an ack id with a quote', reply({ block: pointerText(1), ackId: 'a"b' })],
    ['a result that is a string', reply(pointerText(1))],
    ['a reply with no newline', JSON.stringify({ id: 1, ok: true, result: { block: pointerText(1), ackId: ACK } })]
  ]
  for (const [what, answer] of garbage) {
    it(`prints nothing and sends no ack for ${what}`, async () => {
      const seen: Request[] = []
      await fakeApp(seen, [answer, acked()])
      expect(await stopHook(200)).toBe('')
      await settle()
      expect(seen.map((r) => r.cmd)).toEqual(['hook'])
    })
  }

  it('a print that fails after the ack is swallowed (the hook still resolves)', async () => {
    const seen: Request[] = []
    await fakeApp(seen, [blockReply(1), acked()])
    await expect(
      stopHook(STOP_HOOK_BUDGET_MS, () => {
        throw new Error('EPIPE')
      })
    ).resolves.toBe('')
    expect(seen.map((r) => r.cmd)).toEqual(['hook', 'hook.ack'])
  })

  it('reads no reply for any other event (fire-and-forget)', async () => {
    const seen: Request[] = []
    await fakeApp(seen, [blockReply(1)])
    let printed = ''
    await runHook('PreToolUse', env(), stdinOf('{}'), HOOK_BUDGET_MS, (t) => (printed += t))
    await settle()
    expect(printed).toBe('')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.args.reply).toBeUndefined()
  })

  describe('run() exits 0 always and prints through its output', () => {
    const io = (): Output & { out: string; err: string } => {
      const o = { out: '', err: '', stdout: (t: string) => void (o.out += t), stderr: (t: string) => void (o.err += t) }
      return o
    }

    it('a block', async () => {
      await fakeApp([], [blockReply(), acked()])
      const o = io()
      expect(await run(['hook', 'Stop'], env(), stdinOf('{}'), o)).toBe(0)
      expect(o.out).toBe(BLOCK_LINE)
      expect(o.err).toBe('')
    })

    it('garbage', async () => {
      await fakeApp([], ['nonsense\n'])
      const o = io()
      expect(await run(['hook', 'Stop'], env(), stdinOf('{}'), o)).toBe(0)
      expect(o.out).toBe('')
    })

    it('main down', async () => {
      const o = io()
      expect(await run(['hook', 'Stop'], env(), stdinOf('{}'), o)).toBe(0)
      expect(o.out).toBe('')
    })
  })
})

describe('ccc hook Stop against the real socket server and hook handlers', () => {
  const WINDOW_TOKEN = 'c'.repeat(64)

  /** A room stop fake that keeps one pending block per tab, as RoomStop does. */
  function roomsFake(block: { block: string; ackId: string } | undefined, onStop: () => void = () => {}) {
    const pending = new Map<string, string>()
    const log: string[] = []
    return {
      log,
      stop(tabId: string) {
        onStop()
        if (block) pending.set(tabId, block.ackId)
        log.push(`stop ${tabId}`)
        return block
      },
      ack(tabId: string, ackId: unknown) {
        log.push(`ack ${tabId} ${String(ackId)}`)
        if (pending.get(tabId) !== ackId) return false
        pending.delete(tabId)
        return true
      },
      closedUnacked(tabId: string, ackId: string) {
        if (pending.get(tabId) !== ackId) return false
        pending.delete(tabId)
        log.push(`closed unacked ${tabId} ${ackId}`)
        return true
      }
    }
  }

  async function app(rooms: ReturnType<typeof roomsFake>): Promise<{
    applied: [string, string, unknown, string | undefined][]
    unblocked: [string, string, unknown][]
  }> {
    const applied: [string, string, unknown, string | undefined][] = []
    const unblocked: [string, string, unknown][] = []
    const server = new SocketServer({
      path: sock,
      resolveToken: (token) =>
        token === TOKEN
          ? { kind: 'session', tabId: 'tab-1', projectId: 'p1' }
          : token === WINDOW_TOKEN
            ? { kind: 'window', projectId: 'p1' }
            : undefined,
      resolveProject: (path) => ({ path, projectId: 'p1' }),
      log: () => {},
      probeTimeoutMs: 200
    })
    server.handle(
      'hook',
      hookHandler(
        {
          applyHook: (tabId, event, payload, blocked) => {
            applied.push([tabId, event, payload, blocked])
            return true
          },
          unblockStop: (tabId, ackId, payload) => {
            unblocked.push([tabId, ackId, payload])
            return true
          }
        },
        rooms
      )
    )
    server.handle('hook.ack', hookAckHandler(rooms))
    expect(await server.start()).toBe(true)
    closers.push(() => server.stop())
    return { applied, unblocked }
  }

  /** Writes raw request lines on one connection and resolves with the replies, once the server closed it. */
  function exchange(lines: string[]): Promise<Reply[]> {
    return new Promise((done, fail) => {
      const client = createConnection(sock)
      const framer = new LineFramer()
      const replies: Reply[] = []
      client.on('error', fail)
      client.on('data', (chunk: Buffer) => {
        for (const line of framer.push(chunk)) replies.push(parseReply(line))
        if (replies.length === lines.length) client.end()
      })
      client.on('close', () => done(replies))
      client.write(lines.join(''))
    })
  }
  const line = (request: Record<string, unknown>): string => `${JSON.stringify({ v: 1, id: 1, ...request })}\n`

  it('the block main issues is acked once for the token\'s tab, then printed; the close changes nothing', async () => {
    const rooms = roomsFake({ block: pointerText(3), ackId: ACK })
    const { applied, unblocked } = await app(rooms)
    expect(await stopHook()).toBe(`{"decision":"block","reason":"${pointerText(3)}"}\n`)
    await settle()
    expect(rooms.log).toEqual(['stop tab-1', `ack tab-1 ${ACK}`])
    expect(applied).toEqual([['tab-1', 'Stop', { stop_hook_active: false }, ACK]])
    expect(unblocked).toEqual([])
  })

  it('a plain Stop prints nothing and sends no ack', async () => {
    const rooms = roomsFake(undefined)
    const { applied, unblocked } = await app(rooms)
    expect(await stopHook()).toBe('')
    await settle()
    expect(applied).toEqual([['tab-1', 'Stop', { stop_hook_active: false }, undefined]])
    expect(rooms.log).toEqual(['stop tab-1'])
    expect(unblocked).toEqual([])
  })

  it('main stalls past ccc\'s budget: ccc prints nothing, and its close turns the blocked Stop back into a plain one', async () => {
    // The room stop blocks main's event loop (and so ccc's, which runs in this process) past the budget: ccc's deadline
    // fires before it reads the reply, the review's scenario of a main busy at start or with a pty burst.
    const rooms = roomsFake({ block: pointerText(1), ackId: ACK }, () => {
      const until = Date.now() + 150
      while (Date.now() < until) {
        // busy
      }
    })
    const { applied, unblocked } = await app(rooms)
    expect(await stopHook(50)).toBe('')
    await settle()
    expect(applied).toEqual([['tab-1', 'Stop', { stop_hook_active: false }, ACK]])
    expect(rooms.log).toEqual(['stop tab-1', `closed unacked tab-1 ${ACK}`])
    expect(unblocked).toEqual([['tab-1', ACK, { stop_hook_active: false }]])
  })

  it('a connection that closes after the block and before the ack undoes the block', async () => {
    const rooms = roomsFake({ block: pointerText(1), ackId: ACK })
    const { unblocked } = await app(rooms)
    const replies = await exchange([line({ token: TOKEN, cmd: 'hook', args: { event: 'Stop', payload: {}, reply: true } })])
    expect(stopBlockOf(replies[0]?.ok ? replies[0].result : undefined)).toEqual({ block: pointerText(1), ackId: ACK })
    await settle()
    expect(unblocked).toEqual([['tab-1', ACK, {}]])
    // An ack after that is refused: ccc would print nothing.
    const late = await exchange([line({ token: TOKEN, cmd: 'hook.ack', args: { ackId: ACK } })])
    expect(late[0]).toMatchObject({ ok: true, result: { acked: false } })
  })

  it('the real server refuses hook.ack from a window token, with no token and with an unknown one', async () => {
    const rooms = roomsFake({ block: pointerText(1), ackId: ACK })
    await app(rooms)
    const refused = await exchange([
      line({ token: WINDOW_TOKEN, cmd: 'hook.ack', args: { ackId: ACK } }),
      line({ id: 2, cmd: 'hook.ack', args: { ackId: ACK } }),
      line({ id: 3, cmd: 'hook.ack', project: '/proj', args: { ackId: ACK } }),
      line({ id: 4, token: 'd'.repeat(64), cmd: 'hook.ack', args: { ackId: ACK } })
    ])
    expect(refused.map((r) => r.ok)).toEqual([false, false, false, false])
    expect(refused[0]).toMatchObject({ error: expect.stringMatching(/needs a Claude session/) })
    expect(refused[1]).toMatchObject({ error: expect.stringMatching(/needs a tab token/) })
    expect(refused[3]).toMatchObject({ error: 'invalid token' })
    expect(rooms.log).toEqual([])
  })
})

describe('the hook handlers', () => {
  const session: Caller = { kind: 'session', tabId: 'tab-1', projectId: 'p1' }
  const signal = new AbortController().signal
  const noUnblock = { unblockStop: () => false }

  it('offer a Stop to the room stop only when the request asks for a reply on a live connection', () => {
    const stops: string[] = []
    const blocked: (string | undefined)[] = []
    const handler = hookHandler(
      { applyHook: (_t, _e, _p, b) => blocked.push(b) > 0, ...noUnblock },
      { stop: (tabId) => (stops.push(tabId), { block: pointerText(1), ackId: ACK }), closedUnacked: () => false }
    )
    expect(handler({ event: 'Stop', payload: {} }, session, signal)).toBeNull()
    expect(handler({ event: 'Stop', payload: {}, reply: 'yes' }, session, signal)).toBeNull()
    // No connection to answer on, or one already gone (ccc gave up before main read the line): nobody would print it.
    expect(handler({ event: 'Stop', payload: {}, reply: true }, session)).toBeNull()
    const gone = new AbortController()
    gone.abort()
    expect(handler({ event: 'Stop', payload: {}, reply: true }, session, gone.signal)).toBeNull()
    expect(stops).toEqual([])
    expect(handler({ event: 'Stop', payload: {}, reply: true }, session, signal)).toEqual({ block: pointerText(1), ackId: ACK })
    expect(stops).toEqual(['tab-1'])
    expect(blocked).toEqual([undefined, undefined, undefined, undefined, ACK])
  })

  it('a close with the block unacked applies the plain Stop once; an acked block is left alone', () => {
    const unblocked: string[] = []
    let unacked = true
    const handler = hookHandler(
      { applyHook: () => true, unblockStop: (tabId, ackId) => unblocked.push(`${tabId} ${ackId}`) > 0 },
      { stop: () => ({ block: pointerText(1), ackId: ACK }), closedUnacked: () => unacked }
    )
    const first = new AbortController()
    handler({ event: 'Stop', payload: {}, reply: true }, session, first.signal)
    first.abort()
    expect(unblocked).toEqual([`tab-1 ${ACK}`])
    unacked = false
    const second = new AbortController()
    handler({ event: 'Stop', payload: {}, reply: true }, session, second.signal)
    second.abort()
    expect(unblocked).toEqual([`tab-1 ${ACK}`])
  })

  it('hook.ack takes the tab from the caller, never from args, and refuses anything but a session token', () => {
    const acks: [string, unknown][] = []
    const handler = hookAckHandler({ ack: (tabId, ackId) => (acks.push([tabId, ackId]), ackId === ACK) })
    expect(handler({ ackId: ACK, tabId: 'tab-9' }, session, signal)).toEqual({ acked: true })
    expect(handler({ ackId: 'other' }, session, signal)).toEqual({ acked: false })
    expect(acks).toEqual([
      ['tab-1', ACK],
      ['tab-1', 'other']
    ])
    expect(() => handler({ ackId: ACK }, { kind: 'window', projectId: 'p1' }, signal)).toThrow(/session token/)
    expect(() => handler({ ackId: ACK }, { kind: 'project', path: '/p', projectId: 'p1' }, signal)).toThrow(/session token/)
    expect(() => handler({ ackId: ACK }, { kind: 'anonymous' }, signal)).toThrow(/session token/)
    expect(acks).toHaveLength(2)
  })

  it('hook.ack with no room stop, or one that throws, confirms nothing', () => {
    expect(hookAckHandler()({ ackId: ACK }, session, signal)).toEqual({ acked: false })
    const throwing = hookAckHandler({
      ack: () => {
        throw new Error('boom')
      }
    })
    expect(throwing({ ackId: ACK }, session, signal)).toEqual({ acked: false })
  })
})

describe('stopBlockOf and the pointer check', () => {
  it('accepts exactly the pointer text', () => {
    expect(isPointerText(pointerText(1))).toBe(true)
    expect(isPointerText(pointerText(42))).toBe(true)
    expect(isPointerText(pointerText(999999))).toBe(true)
    expect(isPointerText('1 room messages waiting: run ccc room read')).toBe(false)
    expect(isPointerText('2 room message waiting: run ccc room read')).toBe(false)
    expect(isPointerText('02 room messages waiting: run ccc room read')).toBe(false)
    expect(isPointerText('1234567 room messages waiting: run ccc room read')).toBe(false)
    expect(isPointerText(` ${pointerText(1)}`)).toBe(false)
    expect(isPointerText(3)).toBe(false)
  })

  it('takes only the block and the ack id', () => {
    expect(stopBlockOf({ block: pointerText(1), ackId: ACK, extra: 'x' })).toEqual({ block: pointerText(1), ackId: ACK })
    expect(stopBlockOf({ block: pointerText(1), ackId: 'x'.repeat(65) })).toBeUndefined()
    expect(stopBlockOf({ block: pointerText(1), ackId: '' })).toBeUndefined()
    expect(stopBlockOf(null)).toBeUndefined()
    expect(stopBlockOf([pointerText(1), ACK])).toBeUndefined()
  })

  it('prints the block as Claude Code reads it', () => {
    expect(JSON.parse(stopBlockOutput({ block: pointerText(2), ackId: ACK }))).toEqual({ decision: 'block', reason: pointerText(2) })
  })
})

describe('the fake claude: decision block, stop_hook_active and the cap of 8 (Claude Code 2.1.325)', () => {
  const FAKE = resolve(__dirname, '../fixtures/bin/claude')

  /**
   * Runs the fake with a Stop hook that logs its stdin and prints `stdout` every time (or only for its first `upTo`
   * Stops); then `/stop`.
   */
  function fake(
    stdout: string,
    extraEnv: Record<string, string> = {},
    upTo?: number
  ): { lines: string[]; payloads: unknown[] } {
    const log = join(root, 'stop.log')
    const out = join(root, 'out.txt')
    writeFileSync(out, stdout)
    writeFileSync(log, '')
    const settings = join(root, 'hooks.json')
    // The command sees the payload on stdin; one line per Stop in the log.
    const print = upTo === undefined ? `cat '${out}'` : `if [ "$(grep -c . '${log}')" -le ${upTo} ]; then cat '${out}'; fi`
    const command = `cat >> '${log}'; echo >> '${log}'; ${print}`
    writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }))
    const r = spawnSync(process.execPath, [FAKE, '--settings', settings], {
      input: '/stop\n',
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...extraEnv },
      timeout: 20_000
    })
    expect(r.status).toBe(0)
    const payloads = readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { stop_hook_active: boolean })
      .map((p) => p.stop_hook_active)
    return { lines: r.stdout.split('\n').filter((l) => l.startsWith('FAKE-CLAUDE block')), payloads }
  }

  it.skipIf(!POSIX)('a hook that always blocks continues the turn 8 times, then the cap ends it', () => {
    const { lines, payloads } = fake(BLOCK_LINE)
    expect(lines).toEqual([...Array(8).fill(`FAKE-CLAUDE block ${JSON.stringify(pointerText(2))}`), 'FAKE-CLAUDE block cap'])
    expect(payloads).toEqual([false, ...Array(8).fill(true)])
  }, 30_000)

  it.skipIf(!POSIX)('CLAUDE_CODE_STOP_HOOK_BLOCK_CAP changes the cap', () => {
    const { lines, payloads } = fake(BLOCK_LINE, { CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: '2' })
    expect(lines).toHaveLength(3)
    expect(lines[2]).toBe('FAKE-CLAUDE block cap')
    expect(payloads).toEqual([false, true, true])
  })

  it.skipIf(!POSIX)('CLAUDE_CODE_STOP_HOOK_BLOCK_CAP set to 0 or a non-number means no cap, as in 2.1.325', () => {
    for (const cap of ['0', 'none']) {
      const { lines, payloads } = fake(BLOCK_LINE, { CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: cap }, 10)
      expect(lines).toEqual(Array(10).fill(`FAKE-CLAUDE block ${JSON.stringify(pointerText(2))}`))
      expect(payloads).toEqual([false, ...Array(10).fill(true)])
    }
  }, 30_000)

  it.skipIf(!POSIX)('a hook that prints nothing, or another decision, ends the turn at the first Stop', () => {
    expect(fake('')).toEqual({ lines: [], payloads: [false] })
    expect(fake('{"decision":"approve","reason":"x"}\n')).toEqual({ lines: [], payloads: [false] })
    expect(fake('not json\n')).toEqual({ lines: [], payloads: [false] })
  })
})
