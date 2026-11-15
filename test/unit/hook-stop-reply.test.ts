// The Stop hook's reply protocol (rooms Task 7, design-rooms.md §2 "The Stop pointer"): `ccc hook Stop` asks for a
// reply, prints Claude Code's `decision: block` JSON only for a valid block within its budget, then acks it once on the
// same connection; every failure prints nothing and the hook still exits 0. Against real Unix sockets in a temp dir
// under /tmp (macOS's /var/folders pushes a socket path past sun_path): a plain `net` fake app where a test controls
// the reply byte for byte, and the real SocketServer with the real hook handlers. Plus the fake `claude`'s emulation of
// Claude Code 2.1.325's block loop and its cap of 8.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { HOOK_BUDGET_MS, run, runHook, stopBlockOutput, type Output } from '../../src/cli/client'
import { hookAckHandler, hookHandler } from '../../src/main/sessions/hook-handler'
import { SocketServer, type Caller } from '../../src/main/socket/socket-server'
import { isPointerText, pointerText } from '../../src/shared/room-pointer'
import { LineFramer, parseRequest, stopBlockOf, type Request } from '../../src/shared/protocol'

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
 * A fake app: records every request line and answers the first with `answer` (raw text, newline included, written
 * after `delayMs`), or never when `answer` is undefined.
 */
function fakeApp(seen: Request[], answer: string | undefined, delayMs = 0): Promise<Server> {
  return new Promise((done) => {
    const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
      const framer = new LineFramer()
      socket.on('error', () => {})
      socket.on('end', () => socket.end())
      socket.on('data', (chunk: Buffer) => {
        for (const line of framer.push(chunk)) {
          seen.push(parseRequest(line))
          if (seen.length === 1 && answer !== undefined) {
            setTimeout(() => {
              if (!socket.destroyed) socket.write(answer)
            }, delayMs)
          }
        }
      })
    })
    closers.push(() => new Promise<void>((r) => server.close(() => r())))
    server.listen(sock, () => done(server))
  })
}

const reply = (result: unknown, id = 1): string => `${JSON.stringify({ id, ok: true, result })}\n`

/** runHook('Stop') with stdout captured; resolves with what it printed. */
async function stopHook(budgetMs = HOOK_BUDGET_MS, write?: (t: string) => void): Promise<string> {
  let printed = ''
  await runHook('Stop', env(), stdinOf('{"stop_hook_active":false}'), budgetMs, write ?? ((t) => (printed += t)))
  return printed
}

/** Lets a line written just before runHook resolved reach the fake app. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50))

describe('ccc hook Stop against a fake app', () => {
  it('asks for a reply, prints the block within the budget and acks it once, with the reply\'s id', async () => {
    const seen: Request[] = []
    await fakeApp(seen, reply({ block: pointerText(2), ackId: ACK }))
    const started = Date.now()
    expect(await stopHook()).toBe(BLOCK_LINE)
    expect(Date.now() - started).toBeLessThan(HOOK_BUDGET_MS)
    await settle()
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ cmd: 'hook', token: TOKEN, args: { event: 'Stop', reply: true } })
    expect(seen[1]).toEqual({ v: 1, id: 2, token: TOKEN, cmd: 'hook.ack', args: { ackId: ACK } })
  })

  it('prints nothing and sends no ack for a plain Stop (result null)', async () => {
    const seen: Request[] = []
    await fakeApp(seen, reply(null))
    expect(await stopHook()).toBe('')
    await settle()
    expect(seen.map((r) => r.cmd)).toEqual(['hook'])
  })

  it('prints nothing when main is not there', async () => {
    expect(await stopHook()).toBe('')
  })

  it('prints nothing when the reply comes after the budget, and resolves at the budget', async () => {
    const seen: Request[] = []
    await fakeApp(seen, reply({ block: pointerText(1), ackId: ACK }), 400)
    const started = Date.now()
    expect(await stopHook(150)).toBe('')
    expect(Date.now() - started).toBeLessThan(400)
    await new Promise((r) => setTimeout(r, 400))
    expect(seen.map((r) => r.cmd)).toEqual(['hook'])
  })

  it('prints nothing when main never answers, and resolves at the budget', async () => {
    const seen: Request[] = []
    await fakeApp(seen, undefined)
    const started = Date.now()
    expect(await stopHook(150)).toBe('')
    expect(Date.now() - started).toBeLessThan(150 + 1500)
  })

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
      await fakeApp(seen, answer)
      expect(await stopHook(200)).toBe('')
      await settle()
      expect(seen.map((r) => r.cmd)).toEqual(['hook'])
    })
  }

  it('sends no ack when printing fails (stdout closed)', async () => {
    const seen: Request[] = []
    await fakeApp(seen, reply({ block: pointerText(1), ackId: ACK }))
    await expect(
      stopHook(HOOK_BUDGET_MS, () => {
        throw new Error('EPIPE')
      })
    ).resolves.toBe('')
    await settle()
    expect(seen.map((r) => r.cmd)).toEqual(['hook'])
  })

  it('reads no reply for any other event (fire-and-forget)', async () => {
    const seen: Request[] = []
    await fakeApp(seen, reply({ block: pointerText(1), ackId: ACK }))
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
      await fakeApp([], reply({ block: pointerText(2), ackId: ACK }))
      const o = io()
      expect(await run(['hook', 'Stop'], env(), stdinOf('{}'), o)).toBe(0)
      expect(o.out).toBe(BLOCK_LINE)
      expect(o.err).toBe('')
    })

    it('garbage', async () => {
      await fakeApp([], 'nonsense\n')
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
  async function app(rooms: {
    stop(tabId: string, payload: unknown): { block: string; ackId: string } | undefined
    ack(tabId: string, ackId: unknown): boolean
  }): Promise<{ applied: [string, string, unknown, string | undefined][] }> {
    const applied: [string, string, unknown, string | undefined][] = []
    const server = new SocketServer({
      path: sock,
      resolveToken: (token) => (token === TOKEN ? { kind: 'session', tabId: 'tab-1', projectId: 'p1' } : undefined),
      resolveProject: (path) => ({ path, projectId: undefined }),
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
          }
        },
        rooms
      )
    )
    server.handle('hook.ack', hookAckHandler(rooms))
    expect(await server.start()).toBe(true)
    closers.push(() => server.stop())
    return { applied }
  }

  it('the block main issues is printed and acked once for the token\'s tab', async () => {
    const acks: [string, unknown][] = []
    const stops: [string, unknown][] = []
    const { applied } = await app({
      stop: (tabId, payload) => {
        stops.push([tabId, payload])
        return { block: pointerText(3), ackId: ACK }
      },
      ack: (tabId, ackId) => {
        acks.push([tabId, ackId])
        return true
      }
    })
    expect(await stopHook()).toBe(`{"decision":"block","reason":"${pointerText(3)}"}\n`)
    await settle()
    expect(stops).toEqual([['tab-1', { stop_hook_active: false }]])
    expect(applied).toEqual([['tab-1', 'Stop', { stop_hook_active: false }, ACK]])
    expect(acks).toEqual([['tab-1', ACK]])
  })

  it('a plain Stop prints nothing and sends no ack', async () => {
    const acks: unknown[] = []
    const { applied } = await app({ stop: () => undefined, ack: (_t, id) => acks.push(id) > 0 })
    expect(await stopHook()).toBe('')
    await settle()
    expect(applied).toEqual([['tab-1', 'Stop', { stop_hook_active: false }, undefined]])
    expect(acks).toEqual([])
  })
})

describe('the hook handlers', () => {
  const session: Caller = { kind: 'session', tabId: 'tab-1', projectId: 'p1' }
  const signal = new AbortController().signal

  it('offer a Stop to the room stop only when the request asks for a reply (an older ccc never prints)', () => {
    const stops: string[] = []
    const blocked: (string | undefined)[] = []
    const handler = hookHandler(
      { applyHook: (_t, _e, _p, b) => blocked.push(b) > 0 },
      { stop: (tabId) => (stops.push(tabId), { block: pointerText(1), ackId: ACK }) }
    )
    expect(handler({ event: 'Stop', payload: {} }, session, signal)).toBeNull()
    expect(handler({ event: 'Stop', payload: {}, reply: 'yes' }, session, signal)).toBeNull()
    expect(stops).toEqual([])
    expect(handler({ event: 'Stop', payload: {}, reply: true }, session, signal)).toEqual({ block: pointerText(1), ackId: ACK })
    expect(stops).toEqual(['tab-1'])
    expect(blocked).toEqual([undefined, undefined, ACK])
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

  /** Runs the fake with a Stop hook that logs its stdin and prints `stdout` every time; then `/stop`. */
  function fake(stdout: string, extraEnv: Record<string, string> = {}): { lines: string[]; payloads: unknown[] } {
    const log = join(root, 'stop.log')
    const out = join(root, 'out.txt')
    writeFileSync(out, stdout)
    writeFileSync(log, '')
    const settings = join(root, 'hooks.json')
    // The command sees the payload on stdin; one line per Stop in the log.
    const command = `cat >> '${log}'; echo >> '${log}'; cat '${out}'`
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

  it.skipIf(!POSIX)('a hook that prints nothing, or another decision, ends the turn at the first Stop', () => {
    expect(fake('')).toEqual({ lines: [], payloads: [false] })
    expect(fake('{"decision":"approve","reason":"x"}\n')).toEqual({ lines: [], payloads: [false] })
    expect(fake('not json\n')).toEqual({ lines: [], payloads: [false] })
  })
})
